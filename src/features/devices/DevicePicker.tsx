import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { AudioDeviceList } from "@/lib/bindings/AudioDeviceList";
import type { DeviceInventory } from "@/lib/bindings/DeviceInventory";
import type { FfmpegDevice } from "@/lib/bindings/FfmpegDevice";
import type { Settings } from "@/lib/bindings/Settings";
import type { VuLevels } from "@/lib/bindings/VuLevels";
import type { PreviewFrame } from "@/lib/bindings/PreviewFrame";
import { SETTINGS_QUERY_KEY } from "@/features/settings/queryKey";

/**
 * F2.1 device picker — the single place a user chooses the microphone (which
 * drives the live VU) and the camera (which drives the MJPEG preview), and the
 * choices persist to `Settings`.
 *
 * Two enumerations back this, by design (see `audio::device_enum` docs):
 *   - `list_input_devices` (cpal) populates the MIC dropdown and drives `start_vu`
 *     — cpal owns the input stream the VU meter reads.
 *   - `list_devices` (ffmpeg `-list_devices`) populates the CAMERA dropdown; the
 *     camera is addressed for `start_preview` by its avfoundation index (macOS)
 *     or dshow name (Windows), exactly as the recorder will address it.
 *
 * Selections persist via `settings_save`: `device_name` for the mic;
 * `video_enabled` + `video_device_name` + `video_device_index` for the camera.
 */

/** dBFS at the bottom of the VU bar — anything quieter reads as empty. */
const FLOOR_DBFS = -60;

function dbfsToFraction(db: number | null): number {
  if (db === null || !Number.isFinite(db) || db <= FLOOR_DBFS) return 0;
  if (db >= 0) return 1;
  return (db - FLOOR_DBFS) / -FLOOR_DBFS;
}

function barColor(db: number | null): string {
  if (db === null || db <= FLOOR_DBFS) return "bg-emerald-500";
  if (db >= -3) return "bg-red-500";
  if (db >= -12) return "bg-amber-400";
  return "bg-emerald-500";
}

function ChannelBar({ db, label }: { db: number | null; label: string }) {
  const fraction = dbfsToFraction(db);
  const pct = Math.round(fraction * 100);
  const dbLabel =
    db === null || !Number.isFinite(db) ? "-∞" : `${db.toFixed(1)} dB`;
  return (
    <div className="flex items-center gap-2">
      <span className="w-6 text-right text-xs tabular-nums opacity-70">
        {label}
      </span>
      <div
        className="h-3 flex-1 overflow-hidden rounded bg-zinc-800"
        role="meter"
        aria-label={`Kanal ${label} nivå`}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full ${barColor(db)} transition-[width] duration-75`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-16 text-right text-xs tabular-nums opacity-70">
        {dbLabel}
      </span>
    </div>
  );
}

/** The addressable token for a video device: avfoundation index (macOS) when
 *  known, else the dshow name (Windows). Mirrors the recorder's `device_token`. */
function videoDeviceArg(d: FfmpegDevice): string {
  return d.index !== null ? String(d.index) : d.name;
}

export function DevicePicker() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // ── Enumerations ──────────────────────────────────────────────────────────
  const { data: cpalInputs } = useQuery<AudioDeviceList>({
    queryKey: ["list_input_devices"],
    queryFn: () => invoke<AudioDeviceList>("list_input_devices"),
  });
  const { data: inventory } = useQuery<DeviceInventory>({
    queryKey: ["list_devices"],
    queryFn: () => invoke<DeviceInventory>("list_devices"),
  });
  const { data: settings } = useQuery<Settings>({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => invoke<Settings>("settings_get"),
  });

  const saveMutation = useMutation({
    mutationFn: (next: Settings) =>
      invoke<Settings>("settings_save", { settings: next }),
    onSuccess: (saved) => queryClient.setQueryData(SETTINGS_QUERY_KEY, saved),
  });

  // ── Selection (seeded from persisted settings) ────────────────────────────
  const micName = settings?.deviceName ?? "";
  const videoEnabled = settings?.videoEnabled ?? false;
  const videoName = settings?.videoDeviceName ?? "";

  const videoDevices = useMemo(
    () => inventory?.video_inputs ?? [],
    [inventory],
  );
  const selectedCamera = useMemo(
    () => videoDevices.find((d) => d.name === videoName) ?? null,
    [videoDevices, videoName],
  );

  // Persist a settings patch (immediate — the user explicitly picked a device).
  const patch = useCallback(
    (partial: Partial<Settings>) => {
      if (!settings) return;
      saveMutation.mutate({ ...settings, ...partial });
    },
    [settings, saveMutation],
  );

  // ── VU engine (mic) ───────────────────────────────────────────────────────
  const [vuRunning, setVuRunning] = useState(false);
  const [levels, setLevels] = useState<VuLevels | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = listen<VuLevels>("vu://levels", (event) => {
      setLevels(event.payload);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  const startVu = useCallback(async () => {
    setError(null);
    try {
      await invoke("start_vu", { deviceName: micName === "" ? null : micName });
      setVuRunning(true);
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    }
  }, [micName]);

  const stopVu = useCallback(async () => {
    try {
      await invoke("stop_vu");
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    } finally {
      setVuRunning(false);
      setLevels(null);
    }
  }, []);

  // ── Preview engine (camera) ───────────────────────────────────────────────
  const [previewRunning, setPreviewRunning] = useState(false);
  const [frame, setFrame] = useState<PreviewFrame | null>(null);

  useEffect(() => {
    const unlisten = listen<PreviewFrame>("preview://frame", (event) => {
      setFrame(event.payload);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  const startPreview = useCallback(async () => {
    setError(null);
    try {
      await invoke("start_preview", {
        device: selectedCamera ? videoDeviceArg(selectedCamera) : null,
        fps: null,
      });
      setPreviewRunning(true);
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    }
  }, [selectedCamera]);

  const stopPreview = useCallback(async () => {
    try {
      await invoke("stop_preview");
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    } finally {
      setPreviewRunning(false);
      setFrame(null);
    }
  }, []);

  // Stop both engines if the picker unmounts while running.
  useEffect(() => {
    return () => {
      if (vuRunning) void invoke("stop_vu").catch(() => {});
      if (previewRunning) void invoke("stop_preview").catch(() => {});
    };
  }, [vuRunning, previewRunning]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const onMicChange = useCallback(
    (name: string) => patch({ deviceName: name === "" ? null : name }),
    [patch],
  );

  const onCameraChange = useCallback(
    (name: string) => {
      const cam = videoDevices.find((d) => d.name === name) ?? null;
      patch({
        videoDeviceName: cam ? cam.name : null,
        videoDeviceIndex: cam && cam.index !== null ? cam.index : null,
      });
    },
    [patch, videoDevices],
  );

  const onVideoToggle = useCallback(
    (enabled: boolean) => {
      patch({ videoEnabled: enabled });
      if (!enabled && previewRunning) void stopPreview();
    },
    [patch, previewRunning, stopPreview],
  );

  const peaks = levels?.peak_dbfs ?? [];
  const channelCount = peaks.length || 1;
  const dims =
    frame?.width && frame?.height ? `${frame.width}×${frame.height}` : null;

  return (
    <section
      className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-zinc-700 p-4"
      aria-label={t("audio.title", "Lydkilde")}
    >
      {/* ── Microphone ──────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">
            {t("audio.title", "Lydkilde")}
          </h2>
          <span className="text-xs opacity-50">{cpalInputs?.host ?? "…"}</span>
        </div>

        <div className="flex items-center gap-2">
          <select
            className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
            aria-label={t("audio.available", "Tilgjengelige enheter")}
            value={micName}
            disabled={vuRunning}
            onChange={(e) => onMicChange(e.target.value)}
          >
            <option value="">{t("audio.builtIn", "Standard inngang")}</option>
            {cpalInputs?.inputs.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
                {d.is_default ? ` (${t("audio.connected", "standard")})` : ""}
              </option>
            ))}
          </select>

          {vuRunning ? (
            <button
              type="button"
              className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-500"
              onClick={() => void stopVu()}
            >
              {t("audio.monitorStop", "Stopp")}
            </button>
          ) : (
            <button
              type="button"
              className="rounded bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-500"
              onClick={() => void startVu()}
            >
              {t("audio.testBtn", "Start VU")}
            </button>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          {Array.from({ length: channelCount }).map((_, ch) => (
            <ChannelBar
              key={ch}
              label={channelCount > 1 ? `${ch + 1}` : "M"}
              db={vuRunning ? (peaks[ch] ?? null) : null}
            />
          ))}
        </div>
      </div>

      {/* ── Camera ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2 border-t border-zinc-800 pt-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">
            {t("video.cameraTitle", "Kamera")}
          </h2>
          <label className="flex items-center gap-2 text-xs opacity-80">
            <input
              type="checkbox"
              aria-label={t("home.videoOn", "Video på")}
              checked={videoEnabled}
              onChange={(e) => onVideoToggle(e.target.checked)}
            />
            {videoEnabled
              ? t("home.videoOn", "Video på")
              : t("home.videoOff", "Video av")}
          </label>
        </div>

        {videoEnabled && (
          <>
            <div className="flex items-center gap-2">
              <select
                className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
                aria-label={t("video.pickCamera", "Velg kamera")}
                value={videoName}
                disabled={previewRunning}
                onChange={(e) => onCameraChange(e.target.value)}
              >
                <option value="">{t("video.pickCamera", "Velg kamera")}</option>
                {videoDevices.map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </select>

              {previewRunning ? (
                <button
                  type="button"
                  className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-500"
                  onClick={() => void stopPreview()}
                >
                  {t("audio.monitorStop", "Stopp")}
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-500"
                  onClick={() => void startPreview()}
                >
                  {t("home.refresh", "Start preview")}
                </button>
              )}
            </div>

            <div className="relative aspect-video overflow-hidden rounded bg-zinc-900">
              {frame ? (
                <img
                  className="h-full w-full object-contain"
                  src={`data:image/jpeg;base64,${frame.data}`}
                  alt={t("video.cameraTitle", "Kamera")}
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-xs opacity-50">
                  {previewRunning
                    ? t("home.checking", "Venter på første bilde …")
                    : t("home.videoPreviewPrompt", "Velg kamera og start")}
                </div>
              )}
              {dims && (
                <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums opacity-80">
                  {dims}
                </span>
              )}
            </div>
          </>
        )}

        {videoEnabled && videoDevices.length === 0 && (
          <p className="text-xs opacity-50">
            {t("home.cameraNoResponse", "Ingen kamera funnet")}
          </p>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
    </section>
  );
}
