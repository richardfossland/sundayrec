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
import {
  Badge,
  Btn,
  Card,
  DeviceCard,
  EmptyState,
  Meter,
  ReadyChip,
  SegOpt,
  Toggle,
} from "../atoms";
import {
  dbfsToLit,
  formatBytes,
  formatDbfs,
  levelLabel,
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
  metersForChannelMode,
  storageEstimateLabel,
} from "./home.helpers";
import { sampleRateKhzLabel } from "./settings.helpers";
import { SETTINGS_QUERY_KEY } from "@/features/settings/queryKey";
import { navigateTo, navigateToSettings } from "@/lib/navigation";
import type { ScheduleStatus } from "@/lib/bindings/ScheduleStatus";
import type { Settings } from "@/lib/bindings/Settings";
import type { FileFormat } from "@/lib/bindings/FileFormat";
import type { RecordingRow } from "@/lib/bindings/RecordingRow";
import type { PruneSummary } from "@/lib/bindings/PruneSummary";
import type { CloudConnectionStatus } from "@/lib/bindings/CloudConnectionStatus";
import type { CloudService } from "@/lib/bindings/CloudService";

/** Friendly name for a connected cloud service. */
function cloudServiceLabel(s: CloudService): string {
  return s === "google-drive"
    ? "Google Drive"
    : s === "youtube"
      ? "YouTube"
      : "Gmail";
}

function TrustBanner() {
  const { t } = useTranslation();
  const { data: status } = useQuery<ScheduleStatus>({
    queryKey: ["scheduler_status"],
    queryFn: () => invoke<ScheduleStatus>("scheduler_status"),
  });
  const { data: settings } = useQuery<Settings>({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => invoke<Settings>("settings_get"),
  });
  // Tick every 30 s so the countdown to the next recording stays live.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const nextDate = formatNextDate(status?.next);
  const nextMs = status?.next ? new Date(status.next as string).getTime() : NaN;
  const nextTime =
    Number.isFinite(nextMs) && status?.next
      ? new Date(status.next as string).toLocaleTimeString("nb-NO", {
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;

  // Live "om 2t 15m" countdown to the next recording.
  let countdown: string | null = null;
  const remMs = Number.isFinite(nextMs) ? nextMs - nowMs : NaN;
  if (Number.isFinite(remMs) && remMs > 0) {
    const min = Math.round(remMs / 60_000);
    if (min < 1) countdown = t("homeScreen.cdSoon", "snart");
    else if (min < 60)
      countdown = t("homeScreen.cdMin", "om {{m}} min", { m: min });
    else if (min < 24 * 60) {
      const h = Math.floor(min / 60);
      const m = min % 60;
      countdown = m
        ? t("homeScreen.cdHm", "om {{h}}t {{m}}m", { h, m })
        : t("homeScreen.cdH", "om {{h}}t", { h });
    } else {
      countdown = t("homeScreen.cdDays", "om {{d}} dager", {
        d: Math.round(min / (24 * 60)),
      });
    }
  }
  const showWakeBadge = !!settings?.wakeFromSleep && !!nextTime;

  // Mixer-disconnected warning: the configured audio source is gone, or there
  // are no inputs at all. Mirrors the Electron home's `#hero-warn` state.
  const devices = useInputDevices();
  const inputs = devices?.inputs ?? [];
  const configured = settings?.deviceName ?? null;
  const deviceMissing =
    devices != null &&
    (inputs.length === 0 ||
      (!!configured && !inputs.some((d) => d.name === configured)));

  if (deviceMissing) {
    return (
      <div className="sr-banner warn" style={{ marginBottom: 16 }}>
        <div className="sr-banner-ico">
          <Icon name="warn" size={24} strokeWidth={2.4} />
        </div>
        <div className="sr-grow">
          <div className="sr-label" style={{ color: "var(--sr-red)" }}>
            {t("homeScreen.mixerOfflineLabel", "Lydkilde mangler")}
          </div>
          <div
            style={{
              fontSize: 19,
              fontWeight: 650,
              letterSpacing: "-0.01em",
              marginTop: 2,
            }}
          >
            {inputs.length === 0
              ? t("homeScreen.mixerOfflineNone", "Ingen lydmikser tilkoblet")
              : t(
                  "homeScreen.mixerOfflineGone",
                  "Den valgte lydkilden er frakoblet",
                )}
          </div>
        </div>
        <button
          className="sr-btn gold"
          onClick={() => navigateToSettings("lydkilde", "device")}
        >
          {t("homeScreen.mixerOfflineFix", "Velg lydkilde")}
        </button>
      </div>
    );
  }

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
            {countdown && <> · {countdown}</>}
          </div>
        )}
        {showWakeBadge && (
          <div
            style={{
              marginTop: 6,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11,
              color: "var(--sr-text-3)",
            }}
          >
            <Icon name="power" size={13} />
            {t("homeScreen.wakeAuto", "Maskinen vekkes automatisk")}
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
        aria-label={t("homeScreen.startRecordingNow", "Start opptak nå")}
      >
        <span className="dot" />
        {t("homeScreen.startRecordingNow", "Start opptak nå")}
      </button>
      <button
        className="sr-card sr-videotoggle"
        onClick={onToggleVideo}
        aria-pressed={video}
        aria-label={
          video
            ? t("homeScreen.videoOn", "Video på")
            : t("homeScreen.videoOff", "Video av")
        }
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 18px",
          flex: "0 0 auto",
          cursor: "pointer",
          color: "inherit",
          transition: "border-color 0.12s, background 0.12s",
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
  readout = "—",
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

/**
 * Video-mode "Separat lydfil" card. When recording video the user can opt to
 * ALSO write a standalone audio file (in a chosen format) next to the video.
 * Wired to the now-real `keepSeparateAudio` / `separateAudioFormat` settings —
 * a click persists the patch through the passed `onUpdate` so it sticks.
 */
function SeparateAudioCard({
  on,
  format,
  onUpdate,
}: {
  on: boolean;
  format: FileFormat;
  onUpdate: (patch: Partial<Settings>) => void;
}) {
  const { t } = useTranslation();
  const FORMATS: FileFormat[] = ["mp3", "wav", "flac", "aac"];
  return (
    <div className="sr-card pad" style={{ padding: 16 }}>
      <div className="sr-row" style={{ gap: 12, alignItems: "flex-start" }}>
        <Icon name="mic" size={17} style={{ color: "var(--sr-text-3)" }} />
        <div className="sr-grow">
          <div style={{ fontSize: 13.5, fontWeight: 650 }}>
            {t("homeScreen.separateAudioTitle", "Ta opp separat lydfil")}
          </div>
          <div
            style={{ fontSize: 12, color: "var(--sr-text-3)", marginTop: 3 }}
          >
            {t(
              "homeScreen.separateAudioSub",
              "I tillegg til videofilen lagres en egen lydfil i valgt format.",
            )}
          </div>
        </div>
        <span
          role="switch"
          aria-checked={on}
          aria-label={t(
            "homeScreen.separateAudioTitle",
            "Ta opp separat lydfil",
          )}
          tabIndex={0}
          style={{
            display: "inline-flex",
            cursor: "pointer",
            flex: "0 0 auto",
          }}
          onClick={() => onUpdate({ keepSeparateAudio: !on })}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onUpdate({ keepSeparateAudio: !on });
            }
          }}
        >
          <Toggle on={on} />
        </span>
      </div>
      {on && (
        <div
          className="sr-seg cols-4"
          style={{ marginTop: 14 }}
          role="radiogroup"
          aria-label={t("homeScreen.separateAudioFormat", "Lydformat")}
        >
          {FORMATS.map((f) => (
            // A real box (NOT display:contents) so the gold focus ring has
            // something to draw on; `sr-r-sm` matches SegOpt's corner radius.
            <div
              key={f}
              role="radio"
              aria-checked={format === f}
              aria-label={f.toUpperCase()}
              tabIndex={0}
              style={{ cursor: "pointer", borderRadius: "var(--sr-r-sm)" }}
              onClick={() => onUpdate({ separateAudioFormat: f })}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onUpdate({ separateAudioFormat: f });
                }
              }}
            >
              <SegOpt sel={format === f} title={f.toUpperCase()} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Whole seconds → `h:mm:ss` / `m:ss` for the history duration column. */
function fmtClock(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

/** A unix-seconds (or ms) timestamp → short Norwegian-ish date+time. */
function fmtWhen(ts: number): string {
  const ms = ts > 1e12 ? ts : ts * 1000;
  try {
    return new Date(ms).toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/**
 * "Siste opptak" — the recording history that lived at the bottom of the
 * Electron home page. Search + stats + per-row delete + maintenance (clear /
 * prune missing files), reusing the same `recordings_*` commands the full
 * HistoryPanel uses. "Se alle" deep-links to the dedicated history view.
 */
function HomeHistory() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [showMenu, setShowMenu] = useState(false);

  const { data, isLoading } = useQuery<RecordingRow[]>({
    queryKey: ["recordings", "list"],
    queryFn: () => invoke<RecordingRow[]>("recordings_list"),
  });
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["recordings", "list"] });
  const del = useMutation({
    mutationFn: (id: string) => invoke<void>("recordings_delete", { id }),
    onSuccess: invalidate,
  });
  const clear = useMutation({
    mutationFn: () => invoke<void>("recordings_clear"),
    onSuccess: invalidate,
  });
  const prune = useMutation({
    mutationFn: () => invoke<PruneSummary>("recordings_prune"),
    onSuccess: invalidate,
  });

  const all = data ?? [];
  const q = query.trim().toLowerCase();
  const rows = q
    ? all.filter((r) => r.file_path.toLowerCase().includes(q))
    : all.slice(0, 12);
  const totalSec = all.reduce((s, r) => s + (r.duration_ms ?? 0) / 1000, 0);

  return (
    <Card
      title={t("editScreen.recentRecordings", "Siste opptak")}
      icon="clock"
      desc={
        all.length > 0
          ? `${all.length} ${t("history.totalCount", "opptak")} · ${fmtClock(totalSec)} ${t("history.totalDuration", "totalt")}`
          : undefined
      }
      action={
        all.length > 0 ? (
          <div
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              position: "relative",
            }}
          >
            <input
              className="sr-input sm"
              value={query}
              placeholder={t("history.searchPlaceholder", "Søk i historikk…")}
              onChange={(e) => setQuery(e.target.value)}
              style={{ maxWidth: 180 }}
            />
            <Btn
              variant="ghost"
              sm
              icon="list"
              ariaLabel="Mer"
              onClick={() => setShowMenu((v) => !v)}
            />
            <Btn variant="ghost" sm onClick={() => navigateTo("history")}>
              {t("homeScreen.viewAll", "Se alle")}
            </Btn>
            {showMenu && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  right: 0,
                  marginTop: 6,
                  zIndex: 10,
                  background: "var(--sr-ink-850)",
                  border: "1px solid var(--sr-line)",
                  borderRadius: 8,
                  padding: 6,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  minWidth: 200,
                  boxShadow: "var(--sr-shadow-md)",
                }}
              >
                <button
                  className="sr-btn ghost sm"
                  style={{ justifyContent: "flex-start" }}
                  onClick={() => {
                    setShowMenu(false);
                    prune.mutate();
                  }}
                >
                  {t("history.pruneBtn", "Rydd opp")}
                </button>
                <button
                  className="sr-btn ghost sm"
                  style={{
                    justifyContent: "flex-start",
                    color: "var(--sr-red)",
                  }}
                  onClick={() => {
                    setShowMenu(false);
                    if (
                      confirm(
                        t("history.confirmClear", "Slett hele historikken?"),
                      )
                    )
                      clear.mutate();
                  }}
                >
                  {t("history.clearBtn", "Slett alle")}
                </button>
              </div>
            )}
          </div>
        ) : undefined
      }
    >
      {isLoading ? (
        <div className="sr-card-desc">…</div>
      ) : all.length === 0 ? (
        <EmptyState
          icon="clock"
          title={t("history.empty", "Ingen opptak ennå")}
          desc={t(
            "history.emptyDesc",
            "Når du har tatt opp din første gudstjeneste dukker den opp her.",
          )}
        />
      ) : rows.length === 0 ? (
        <div className="sr-card-desc">
          {t("history.noMatchDesc", "Ingen opptak passer søket «{{query}}».", {
            query,
          })}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {rows.map((r) => (
            <div
              key={r.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 10px",
                borderRadius: 8,
                background: "var(--sr-ink-850)",
              }}
            >
              <Icon name="file" size={15} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.file_path.split(/[/\\]/).pop()}
                </div>
                <div className="sr-card-desc">
                  {fmtWhen(r.started_at || r.created_at)}
                  {r.duration_ms != null && (
                    <> · {fmtClock(r.duration_ms / 1000)}</>
                  )}
                  {r.byte_size != null && <> · {formatBytes(r.byte_size)}</>}
                </div>
              </div>
              <Btn
                variant="ghost"
                sm
                icon="x"
                ariaLabel={t("history.deleteEntry", "Slett oppføring")}
                onClick={() => {
                  if (
                    confirm(
                      t(
                        "history.confirmDelete",
                        "Slett dette opptaket fra historikken?",
                      ),
                    )
                  )
                    del.mutate(r.id);
                }}
              />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * Publish-status strip — the Electron home showed at-a-glance cloud / cover /
 * transcription cards. Here: a real cloud-backup connection status (the one
 * with clean status data) + a transcription quick-link, both deep-linking to
 * their panels. Cover lives in Settings → Publisering.
 */
function PublishStrip() {
  const { t } = useTranslation();
  const { data: cloud } = useQuery<CloudConnectionStatus[]>({
    queryKey: ["cloud_connection_status"],
    queryFn: () => invoke<CloudConnectionStatus[]>("cloud_connection_status"),
  });
  const connected = (cloud ?? []).filter((c) => c.connected);
  const cloudV =
    connected.length > 0
      ? t("homeScreen.cloudConnected", "Tilkoblet")
      : t("homeScreen.cloudOff", "Ikke tilkoblet");
  const cloudMeta =
    connected.length > 0
      ? connected.map((c) => cloudServiceLabel(c.service)).join(", ")
      : t("homeScreen.cloudOffHint", "Sikkerhetskopier opptak automatisk");

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        gap: 16,
        marginTop: 16,
      }}
    >
      <DeviceCard
        icon="drive"
        k={t("homeScreen.cloudBackup", "Sky-backup")}
        v={cloudV}
        meta={cloudMeta}
        badge={
          connected.length > 0 ? (
            <Badge kind="ok">{t("homeScreen.cloudOn", "På")}</Badge>
          ) : undefined
        }
        onEdit={() => navigateTo("cloud")}
        editLabel={t("homeScreen.manage", "Endre")}
      />
      <DeviceCard
        icon="sparkle"
        k={t("homeScreen.transcription", "Transkripsjon")}
        v={t("homeScreen.transcriptionWhisper", "Whisper (på enheten)")}
        meta={t("homeScreen.transcriptionHint", "Automatisk tekst til søk")}
        onEdit={() => navigateTo("transcribe")}
        editLabel={t("homeScreen.manage", "Endre")}
      />
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

  // Merge a partial change into the current settings and persist it
  // optimistically (mirrors SettingsScreen's `update`). No-op when settings
  // haven't loaded yet.
  const updateSettings = (patch: Partial<Settings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    queryClient.setQueryData(SETTINGS_QUERY_KEY, next);
    saveSettings.mutate(next);
  };

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
  const channelMode = settings?.channels ?? "stereo";
  const micMeta = inputMeta(devices, channelMode);
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

  // Live video-quality card values, read straight from the settings query so a
  // change in Settings (settings_save → same cache) re-renders the Home card.
  const videoResolution = settings?.videoResolution ?? "720p";
  const videoFramerate = settings?.videoFramerate ?? 30;
  const videoQualityV = `${videoResolution} · ${videoFramerate} fps`;
  const isSeparateOutput = settings?.outputMode === "separate";
  const videoQualityMeta = isSeparateOutput
    ? t("settingsScreen.video.separateTitle", "Separate filer")
    : t("settingsScreen.video.combinedTitle", "Kombinert MP4");

  // Audio source card: the chosen device name (falls back to the enumerated
  // default) so Settings' Lydkilde choice is reflected on Home.
  const audioSourceV = settings?.deviceName ?? micName;

  // Format-card meta reflects the real sample-rate policy: "Auto" (native rate,
  // no conversion) or the chosen kHz — instead of a hardcoded "48 kHz" (WS-2).
  const rateLabel = sampleRateKhzLabel(
    settings?.sampleRateMode ?? "auto",
    t("homeScreen.rateAuto", "Auto"),
  );
  const formatMeta = t(
    "homeScreen.formatMetaDynamic",
    "Stereo · {{rate}} · høyest kvalitet",
    { rate: rateLabel },
  );

  // Dynamic signal-strength label (Svak / OK / Bra / Høy) driven by the live
  // peak, updating as levels stream in (WS-4).
  const signalKey = levelLabel(peakMax);
  const signalLabel = {
    weak: t("recordingScreen.signalWeak", "Svak"),
    ok: t("recordingScreen.signalOk", "OK"),
    good: t("recordingScreen.signalGood", "Bra"),
    loud: t("recordingScreen.signalLoud", "Høy"),
  }[signalKey];
  const signalGreen = signalKey === "ok" || signalKey === "good";

  // Translated label for every device card's edit button (was a hardcoded
  // "Endre"); reuses the shared `home.changeSettings` string already shipped in
  // all seven catalogs.
  const changeLabel = t("home.changeSettings", "Endre");

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
              <button
                className={
                  "sr-btn ghost sm" + (settings?.videoFlip ? " gold" : "")
                }
                style={{ padding: "7px 9px", fontSize: 15, lineHeight: 1 }}
                onClick={() =>
                  updateSettings({ videoFlip: !settings?.videoFlip })
                }
                aria-label={t("homeScreen.flipCamera", "Speilvend kamera")}
                aria-pressed={!!settings?.videoFlip}
                type="button"
              >
                ⇄
              </button>
              <div className="sr-grow" />
              {/* "Preview" — NOT "Live" — so this is never mistaken for a
                  livestream/broadcast. A muted badge (no red recording dot) when
                  frames flow; a clear "no image" otherwise. */}
              {preview.dataUrl ? (
                <Badge kind="muted">
                  {t("homeScreen.previewBadge", "Preview")}
                </Badge>
              ) : (
                <Badge kind="muted">
                  {t("homeScreen.cameraNoSignal", "Ingen bilde")}
                </Badge>
              )}
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
                    transform: settings?.videoFlip ? "scaleX(-1)" : undefined,
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
              {/* Confirm the chosen channel count: STEREO selection shows two
                  bars, mono one. The cpal VU engine reports a single peak, so
                  when only one level is available both bars reflect it; if the
                  engine ever carries a real R channel (peakR) we use it. */}
              <div
                className="sr-grow sr-col"
                style={{ gap: metersForChannelMode(channelMode) === 2 ? 5 : 0 }}
              >
                <Meter on={peakL != null ? dbfsToLit(peakL, 14) : 0} />
                {metersForChannelMode(channelMode) === 2 && (
                  <Meter
                    on={
                      (peakR ?? peakL) != null
                        ? dbfsToLit(peakR ?? peakL, 14)
                        : 0
                    }
                  />
                )}
              </div>
              <span
                className="sr-mono sr-num"
                style={{ fontSize: 12, color: "var(--sr-text-3)" }}
              >
                {peakL != null ? `${formatDbfs(peakL)} dBFS` : "—"}
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
                  ? `${formatDbfs(peakMax)} dBFS`
                  : "—"}
              </span>
            </div>
            <div className="sr-col" style={{ gap: 16, padding: "26px 22px" }}>
              <BigMeterRow
                ch="L"
                on={peakL != null ? bigMeterLit(peakL) : 0}
                readout={peakL != null ? formatDbfs(peakL) : "—"}
              />
              <BigMeterRow
                ch="R"
                on={peakR != null ? bigMeterLit(peakR) : 0}
                readout={peakR != null ? formatDbfs(peakR) : "—"}
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
              <button
                type="button"
                className="sr-grow"
                onClick={() => navigateTo("diagnostics")}
                style={{
                  fontFamily: "inherit",
                  fontSize: 13.5,
                  color: "var(--sr-gold)",
                  fontWeight: 600,
                  cursor: "pointer",
                  background: "none",
                  border: "none",
                  padding: 0,
                  textAlign: "left",
                }}
              >
                {t("homeScreen.testAndCheckSystem", "Test og sjekk system →")}
              </button>
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
            {/* Live signal-strength chip — updates as levels stream in (WS-4).
                `aria-live` announces the categorical change (svak/ok/bra/høy);
                it's not the fast dBFS numbers, so it won't spam a screen reader. */}
            <div
              className="sr-row"
              aria-label={t("homeScreen.signalLevel", "Signalnivå")}
              aria-live="polite"
              aria-atomic="true"
              style={{ gap: 7, marginTop: 11 }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: signalGreen
                    ? "var(--sr-green)"
                    : "var(--sr-gold)",
                }}
              />
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: "var(--sr-text-2)",
                }}
              >
                {t("homeScreen.signalLabel", "Signal:")} {signalLabel}
              </span>
            </div>
          </div>
          <DeviceCard
            icon="mic"
            k={t("homeScreen.cardAudioSource", "Lydkilde")}
            v={audioSourceV ?? "—"}
            meta={micMeta ?? undefined}
            badge={
              hasInput ? (
                <Badge kind="ok" dot>
                  {t("homeScreen.connected", "Tilkoblet")}
                </Badge>
              ) : undefined
            }
            onEdit={() => navigateToSettings("lydkilde", "device")}
            editLabel={changeLabel}
          />
          {video ? (
            <>
              <DeviceCard
                icon="camera"
                k={t("homeScreen.chipCamera", "Kamera")}
                v={cameraName ?? "—"}
                meta={
                  cameraName
                    ? t("homeScreen.sourceConfigured", "Kilde konfigurert")
                    : t("homeScreen.selectCamera", "Velg kamera")
                }
                onEdit={() => navigateToSettings("video", "camera")}
                editLabel={changeLabel}
              />
              <DeviceCard
                icon="gear"
                k={t("homeScreen.cardVideoQuality", "Videokvalitet")}
                v={videoQualityV}
                meta={videoQualityMeta}
                onEdit={() => navigateToSettings("video", "quality")}
                editLabel={changeLabel}
              />
              <SeparateAudioCard
                on={settings?.keepSeparateAudio ?? false}
                format={settings?.separateAudioFormat ?? "wav"}
                onUpdate={updateSettings}
              />
              <DeviceCard
                icon="disk"
                k={t("homeScreen.cardStorage", "Lagring")}
                v={diskV ?? "—"}
                meta={storageMeta ?? undefined}
                progress={diskPct ?? undefined}
                onEdit={() => navigateToSettings("filer", "folder")}
                editLabel={changeLabel}
              />
            </>
          ) : (
            <>
              <DeviceCard
                icon="file"
                k={t("homeScreen.cardFormat", "Format")}
                v={(settings?.format ?? "wav").toUpperCase()}
                meta={formatMeta}
                onEdit={() => navigateToSettings("filer", "format")}
                editLabel={changeLabel}
              />
              <DeviceCard
                icon="disk"
                k={t("homeScreen.cardStorage", "Lagring")}
                v={diskV ?? "—"}
                meta={storageMeta ?? undefined}
                progress={diskPct ?? undefined}
                onEdit={() => navigateToSettings("filer", "folder")}
                editLabel={changeLabel}
              />
            </>
          )}
        </div>
      </div>

      <PublishStrip />
      <HomeHistory />
    </div>
  );
}
