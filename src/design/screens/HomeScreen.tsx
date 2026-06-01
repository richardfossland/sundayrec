/**
 * Home — the opptakssenter ("recording centre"), the screen ~80% of use
 * happens on. Ported from the design handoff (`sr-home.jsx`). A `video` toggle
 * switches between the camera-preview layout and the audio-only big-meter
 * layout; the big record button calls `onRecord` so the shell can enter the
 * focused recording mode. Live data (devices, levels, disk) is wired later.
 */
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Icon } from "../Icon";
import { Badge, DeviceCard, Meter, ReadyChip, Toggle } from "../atoms";
import {
  dbfsToLit,
  formatBytes,
  formatDbfs,
  useCameraPreview,
  useDiskSpace,
  useInputDevices,
  useVideoDevices,
  useVuLevels,
  videoDeviceArg,
} from "../hooks";
import {
  bigMeterLit,
  channelPeak,
  defaultInputName,
  DISK_LOW_BYTES,
  diskUsedPercent,
  formatNextDate,
  inputMeta,
  storageEstimateLabel,
} from "./home.helpers";
import { SETTINGS_QUERY_KEY } from "@/features/settings/queryKey";
import type { ScheduleStatus } from "@/lib/bindings/ScheduleStatus";
import type { Settings } from "@/lib/bindings/Settings";

function TrustBanner() {
  const { t } = useTranslation();
  const { data: status } = useQuery<ScheduleStatus>({
    queryKey: ["scheduler_status"],
    queryFn: () => invoke<ScheduleStatus>("scheduler_status"),
  });
  const nextDate = formatNextDate(status?.next);
  const nextTime = status?.next
    ? (() => {
        const d = new Date(status.next as string);
        return Number.isNaN(d.getTime())
          ? null
          : d.toLocaleTimeString("nb-NO", {
              hour: "2-digit",
              minute: "2-digit",
            });
      })()
    : null;

  return (
    <div className="sr-banner ready" style={{ marginBottom: 16 }}>
      <div className="sr-banner-ico">
        <Icon name="check" size={24} strokeWidth={2.4} />
      </div>
      <div className="sr-grow">
        <div className="sr-label" style={{ color: "var(--sr-green)" }}>
          {t("homeScreen.readyForRecording", "Klar for opptak")}
        </div>
        <div
          style={{
            fontSize: 19,
            fontWeight: 650,
            letterSpacing: "-0.01em",
            marginTop: 2,
          }}
        >
          {t("homeScreen.allReady", "Alt er klart")}
        </div>
      </div>
      <div
        style={{
          textAlign: "right",
          borderLeft: "1px solid var(--sr-line)",
          paddingLeft: 22,
        }}
      >
        <div className="sr-label">
          {t("homeScreen.nextRecording", "Neste opptak")}
        </div>
        <div
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: "var(--sr-gold)",
            marginTop: 2,
          }}
        >
          {nextDate ?? t("homeScreen.allReady", "Alt er klart")}
        </div>
        {nextTime && (
          <div
            style={{ fontSize: 12.5, color: "var(--sr-text-3)", marginTop: 2 }}
          >
            {t("homeScreen.atTime", "kl. {{time}}", { time: nextTime })}
          </div>
        )}
      </div>
    </div>
  );
}

function RecordRow({
  video,
  onRecord,
  onToggleVideo,
}: {
  video: boolean;
  onRecord?: () => void;
  onToggleVideo: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="sr-row"
      style={{ gap: 12, marginBottom: 16, alignItems: "stretch" }}
    >
      <button
        className="sr-record"
        style={{ flex: "1 1 auto" }}
        onClick={onRecord}
      >
        <span className="dot" />
        {t("homeScreen.startRecordingNow", "Start opptak nå")}
      </button>
      <button
        className="sr-card"
        onClick={onToggleVideo}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 18px",
          flex: "0 0 auto",
          cursor: "pointer",
          color: "inherit",
        }}
      >
        <Icon
          name="video"
          size={18}
          style={{ color: video ? "var(--sr-gold)" : "var(--sr-text-3)" }}
        />
        <span
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: video ? "var(--sr-text)" : "var(--sr-text-2)",
          }}
        >
          {video
            ? t("homeScreen.videoOn", "Video på")
            : t("homeScreen.videoOff", "Video av")}
        </span>
        <Toggle on={video} />
      </button>
    </div>
  );
}

/** Navigate the shell to the Innstillinger view (used by the device cards'
 *  "Endre" button so the user can actually change the device). */
function navigateToSettings() {
  window.dispatchEvent(
    new CustomEvent("shell:navigate", { detail: "settings" }),
  );
}

/**
 * The camera <select> header. Isolated so the refresh button can re-enumerate
 * cameras by remounting it (bumping a `key`), which re-runs `useVideoDevices()`
 * — the same pattern SettingsScreen's `CameraSelect` uses. The selected camera
 * + its addressable token are reported up via `onCameras` so the preview pane
 * (rendered by the parent) drives the right device.
 */
function CameraSelectHeader({
  selectedName,
  onChange,
}: {
  selectedName: string | null;
  onChange: (name: string) => void;
}) {
  const { t } = useTranslation();
  const videoDevices = useVideoDevices();
  return (
    <select
      className="sr-select"
      aria-label={t("homeScreen.selectCamera", "Velg kamera")}
      value={selectedName ?? ""}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: 260,
        padding: "7px 32px 7px 11px",
        fontSize: 13,
      }}
    >
      {videoDevices.length === 0 ? (
        <option value="">FaceTime HD-kamera</option>
      ) : (
        <>
          {selectedName == null && (
            <option value="">
              {t("homeScreen.selectCamera", "Velg kamera")}
            </option>
          )}
          {videoDevices.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name}
            </option>
          ))}
        </>
      )}
    </select>
  );
}

// Large live L/R meter row used when video is off.
function BigMeterRow({
  ch,
  on,
  readout = "−55.9",
}: {
  ch: string;
  on: number;
  readout?: string;
}) {
  return (
    <div className="sr-row" style={{ gap: 12 }}>
      <span
        className="sr-mono"
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: "var(--sr-text-3)",
          width: 14,
        }}
      >
        {ch}
      </span>
      <div
        className="sr-grow"
        style={{ display: "flex", gap: 2.5, height: 30, position: "relative" }}
      >
        {Array.from({ length: 40 }).map((_, i) => {
          const c =
            i < on
              ? i > 35
                ? "var(--sr-red)"
                : i > 30
                  ? "var(--sr-gold)"
                  : "var(--sr-green)"
              : "var(--sr-ink-700)";
          return (
            <span key={i} style={{ flex: 1, background: c, borderRadius: 2 }} />
          );
        })}
        <span
          style={{
            position: "absolute",
            left: "40%",
            top: -3,
            bottom: -3,
            width: 2,
            background: "rgba(255,255,255,0.7)",
          }}
        />
      </div>
      <span
        className="sr-mono sr-num"
        style={{
          fontSize: 13,
          color: "var(--sr-text-3)",
          width: 48,
          textAlign: "right",
        }}
      >
        {readout}
      </span>
    </div>
  );
}

export function HomeScreen({
  onRecord,
}: {
  onRecord?: (video: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery<Settings>({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => invoke<Settings>("settings_get"),
  });

  // Persist a settings patch (mirrors features/devices/DevicePicker.tsx).
  const saveSettings = useMutation({
    mutationFn: (next: Settings) =>
      invoke<Settings>("settings_save", { settings: next }),
    onSuccess: (saved) => queryClient.setQueryData(SETTINGS_QUERY_KEY, saved),
  });

  const [video, setVideo] = useState(true);
  const [videoSeeded, setVideoSeeded] = useState(false);
  // Bumping this remounts <CameraSelectHeader>, re-running `useVideoDevices()`
  // so the camera-bar refresh button re-enumerates cameras (same pattern as
  // SettingsScreen). It also re-keys the camera-source DeviceCard so its name
  // reflects a freshly enumerated list.
  const [cameraRefreshKey, setCameraRefreshKey] = useState(0);

  // Initialise the local video toggle from persisted settings (once), then let
  // the user toggle freely.
  useEffect(() => {
    if (!videoSeeded && settings) {
      setVideo(settings.videoEnabled);
      setVideoSeeded(true);
    }
  }, [settings, videoSeeded]);

  // Live audio levels (always running while Home is visible).
  const levels = useVuLevels(true);
  const peakL = channelPeak(levels, 0);
  const peakR = channelPeak(levels, 1);
  const peakMax =
    peakL == null && peakR == null
      ? null
      : Math.max(peakL ?? -Infinity, peakR ?? -Infinity);

  // Camera devices + persisted selection.
  const videoDevices = useVideoDevices();
  const selectedCamera = useMemo(() => {
    const name = settings?.videoDeviceName ?? null;
    return videoDevices.find((d) => d.name === name) ?? null;
  }, [videoDevices, settings?.videoDeviceName]);
  const cameraToken = selectedCamera ? videoDeviceArg(selectedCamera) : null;

  const onCameraChange = (name: string) => {
    if (!settings) return;
    const cam = videoDevices.find((d) => d.name === name) ?? null;
    saveSettings.mutate({
      ...settings,
      videoDeviceName: cam ? cam.name : null,
      videoDeviceIndex: cam && cam.index !== null ? cam.index : null,
    });
  };

  // Live camera preview (only while video is on) — uses the chosen camera.
  const preview = useCameraPreview(video, cameraToken);

  // Device + disk data.
  const devices = useInputDevices();
  const micName = defaultInputName(devices);
  const micMeta = inputMeta(devices);
  const hasInput = (devices?.inputs.length ?? 0) > 0;
  const hasVideoDevice = videoDevices.length > 0;
  const freeBytes = useDiskSpace();
  const diskV =
    freeBytes != null
      ? t("homeScreen.diskFree", "{{size}} ledig", {
          size: formatBytes(freeBytes),
        })
      : null;
  const diskOk = freeBytes != null && freeBytes > DISK_LOW_BYTES;

  // Network readiness (live).
  const [online, setOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // Storage estimate + bar derived from real free space.
  const storageMeta = storageEstimateLabel(freeBytes, video, t);
  const diskPct = diskUsedPercent(freeBytes);
  const cameraName = selectedCamera?.name ?? null;

  return (
    <div className="sr-content wide">
      <TrustBanner />
      <RecordRow
        video={video}
        onRecord={() => onRecord?.(video)}
        onToggleVideo={() => setVideo((v) => !v)}
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 332px",
          gap: 16,
          alignItems: "start",
        }}
      >
        {video ? (
          /* Camera preview */
          <div className="sr-card" style={{ padding: 0, overflow: "hidden" }}>
            <div
              className="sr-row"
              style={{
                gap: 10,
                padding: "11px 13px",
                borderBottom: "1px solid var(--sr-line)",
              }}
            >
              <Icon
                name="camera"
                size={17}
                style={{ color: "var(--sr-text-3)" }}
              />
              <CameraSelectHeader
                key={cameraRefreshKey}
                selectedName={cameraName}
                onChange={onCameraChange}
              />
              <button
                className="sr-btn ghost sm"
                style={{ padding: 7 }}
                onClick={() => setCameraRefreshKey((k) => k + 1)}
                aria-label={t("homeScreen.refreshCameras", "Oppdater kameraer")}
                type="button"
              >
                <Icon name="refresh" size={15} />
              </button>
              <div className="sr-grow" />
              <Badge kind="err" dot>
                {t("homeScreen.liveBadge", "● Live")}
              </Badge>
            </div>
            <div
              className="sr-media"
              style={{ aspectRatio: "16 / 9", borderRadius: 0, border: "none" }}
            >
              {preview.dataUrl ? (
                <img
                  src={preview.dataUrl}
                  alt={t(
                    "homeScreen.cameraPreviewAlt",
                    "kamera-forhåndsvisning",
                  )}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    display: "block",
                  }}
                />
              ) : preview.error ? (
                <span
                  role="alert"
                  style={{
                    color: "var(--sr-red)",
                    fontSize: 13.5,
                    fontWeight: 600,
                    textAlign: "center",
                    padding: "0 24px",
                    lineHeight: 1.4,
                  }}
                >
                  {preview.error}
                </span>
              ) : (
                t(
                  "homeScreen.cameraPreviewPlaceholder",
                  "kamera-forhåndsvisning · 16:9",
                )
              )}
            </div>
            <div
              className="sr-row"
              style={{
                gap: 12,
                padding: "12px 14px",
                borderTop: "1px solid var(--sr-line)",
              }}
            >
              <span className="sr-label" style={{ flex: "0 0 auto" }}>
                {t("homeScreen.audioLevel", "Lydnivå")}
              </span>
              <div className="sr-grow">
                <Meter on={peakL != null ? dbfsToLit(peakL, 14) : 5} />
              </div>
              <span
                className="sr-mono sr-num"
                style={{ fontSize: 12, color: "var(--sr-text-3)" }}
              >
                {peakL != null ? formatDbfs(peakL) : "−35.9"} dBFS
              </span>
            </div>
          </div>
        ) : (
          /* Live level meter (replaces camera preview) */
          <div className="sr-card" style={{ padding: 0, overflow: "hidden" }}>
            <div
              className="sr-row"
              style={{
                gap: 10,
                padding: "13px 16px",
                borderBottom: "1px solid var(--sr-line)",
              }}
            >
              <Icon
                name="wave"
                size={17}
                style={{ color: "var(--sr-text-3)" }}
              />
              <span
                className="sr-grow"
                style={{ fontSize: 14.5, fontWeight: 600 }}
              >
                {t("homeScreen.audioLevelLive", "Lydnivå — live")}
              </span>
              <span
                className="sr-mono sr-num"
                style={{ fontSize: 12.5, color: "var(--sr-text-3)" }}
              >
                {t("homeScreen.maxLabel", "Maks:")}{" "}
                {peakMax != null && Number.isFinite(peakMax)
                  ? formatDbfs(peakMax)
                  : "−38.1"}{" "}
                dBFS
              </span>
            </div>
            <div className="sr-col" style={{ gap: 16, padding: "26px 22px" }}>
              <BigMeterRow
                ch="L"
                on={peakL != null ? bigMeterLit(peakL) : 16}
                readout={peakL != null ? formatDbfs(peakL) : "−55.9"}
              />
              <BigMeterRow
                ch="R"
                on={peakR != null ? bigMeterLit(peakR) : 16}
                readout={peakR != null ? formatDbfs(peakR) : "−55.9"}
              />
              <div
                className="sr-row"
                style={{
                  justifyContent: "space-between",
                  fontSize: 11,
                  color: "var(--sr-text-dim)",
                  fontFamily: "var(--sr-mono)",
                  padding: "0 26px",
                }}
              >
                <span>{t("homeScreen.scaleSilent", "Stille")}</span>
                <span>−24</span>
                <span>−12</span>
                <span>−6</span>
                <span>{t("homeScreen.scaleMax", "Maks")}</span>
              </div>
            </div>
            <div
              className="sr-row"
              style={{
                padding: "13px 16px",
                borderTop: "1px solid var(--sr-line)",
              }}
            >
              <a
                className="sr-grow"
                role="button"
                tabIndex={0}
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("shell:navigate", {
                      detail: "diagnostics",
                    }),
                  )
                }
                style={{
                  fontSize: 13.5,
                  color: "var(--sr-gold)",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {t("homeScreen.testAndCheckSystem", "Test og sjekk system →")}
              </a>
              <span style={{ fontSize: 12.5, color: "var(--sr-text-3)" }}>
                {t("homeScreen.audioOnlyWav", "Opptak blir kun lyd · WAV")}
              </span>
            </div>
          </div>
        )}

        {/* Right rail */}
        <div className="sr-stack-3">
          <div className="sr-card pad" style={{ padding: 16 }}>
            <div className="sr-label" style={{ marginBottom: 11 }}>
              {t("homeScreen.readyToRecord", "Klar til opptak")}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              <ReadyChip
                ok={hasInput}
                label={t("homeScreen.chipAudio", "Lyd")}
              />
              {video && (
                <ReadyChip
                  ok={hasVideoDevice && video}
                  label={t("homeScreen.chipCamera", "Kamera")}
                />
              )}
              <ReadyChip ok={diskOk} label={t("homeScreen.chipDisk", "Disk")} />
              <ReadyChip
                ok={online}
                label={t("homeScreen.chipNetwork", "Nett")}
              />
            </div>
          </div>
          <DeviceCard
            icon="mic"
            k={t("homeScreen.cardAudioSource", "Lydkilde")}
            v={micName ?? "MacBook Pro-mikrofon"}
            meta={micMeta ?? "Innebygd · stereo · 48 kHz"}
            badge={
              <Badge kind="ok" dot>
                {t("homeScreen.connected", "Tilkoblet")}
              </Badge>
            }
            onEdit={navigateToSettings}
          />
          {video ? (
            <>
              <DeviceCard
                icon="camera"
                k={t("homeScreen.chipCamera", "Kamera")}
                v={cameraName ?? "FaceTime HD-kamera"}
                meta={
                  cameraName
                    ? t("homeScreen.sourceConfigured", "Kilde konfigurert")
                    : t("homeScreen.selectCamera", "Velg kamera")
                }
                onEdit={navigateToSettings}
              />
              <DeviceCard
                icon="gear"
                k={t("homeScreen.cardVideoQuality", "Videokvalitet")}
                v="720p · 30 fps"
                meta={t("homeScreen.combinedMp4", "Kombinert MP4")}
                onEdit={navigateToSettings}
              />
              <DeviceCard
                icon="disk"
                k={t("homeScreen.cardStorage", "Lagring")}
                v={diskV ?? "569 GB ledig"}
                meta={storageMeta ?? "~38 timer opptak igjen"}
                progress={diskPct ?? undefined}
                onEdit={navigateToSettings}
              />
            </>
          ) : (
            <>
              <DeviceCard
                icon="file"
                k={t("homeScreen.cardFormat", "Format")}
                v="WAV"
                meta={t(
                  "homeScreen.formatMeta",
                  "Stereo · 48 kHz · høyest kvalitet",
                )}
                onEdit={navigateToSettings}
              />
              <DeviceCard
                icon="disk"
                k={t("homeScreen.cardStorage", "Lagring")}
                v={diskV ?? "569 GB ledig"}
                meta={storageMeta ?? "~95 timer kun-lyd igjen"}
                progress={diskPct ?? undefined}
                onEdit={navigateToSettings}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
