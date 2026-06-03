/**
 * Opptaksmodus — the focused "recording in progress" mode. Ported from
 * `sr-recording.jsx`. This deliberately replaces the whole window (sidebar
 * hidden) so attention is on level, time and the single stop button. Rendered
 * by `App` as a full-window overlay while recording.
 *
 * Wiring: on mount it starts the Rust recorder (`start_recording`) and streams
 * the live signals it emits — `recording://started/progress/silence/error/
 * state/levels` — into the timer, file-size, status, disk and L/R-meter
 * readouts. The stop button calls `stop_recording` and returns to the shell via
 * `onStop`.
 *
 * The L/R meters are driven by the backend `recording://levels` event: the
 * recorder's OWN ffmpeg carries an `astats` pass-through filter that emits
 * periodic per-channel peak levels (it never alters the recorded file). That
 * means we do NOT open a second mic stream just to meter — the levels come from
 * the capture already running. Until the first readout arrives we fall back to a
 * neutral sample so the meters aren't blank.
 *
 * Still backend-owned: the output path / real device come from the save-folder
 * + filename pipeline — here we pass best-effort opts and fail soft.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";

import type { RecordingOpts } from "@/lib/bindings/RecordingOpts";
import type { ChannelMode } from "@/lib/bindings/ChannelMode";
import type { RecordingProgress } from "@/lib/bindings/RecordingProgress";
import type { RecordingLevels } from "@/lib/bindings/RecordingLevels";
import type { RecordingEvent } from "@/lib/bindings/RecordingEvent";
import type { RecorderStatePayload } from "@/lib/bindings/RecorderStatePayload";
import type { Settings } from "@/lib/bindings/Settings";
import { SETTINGS_QUERY_KEY } from "@/features/settings/queryKey";

import { Icon } from "../Icon";
import {
  useDiskSpace,
  formatBytes,
  dbfsToLit,
  formatDbfs,
  levelLabel,
} from "../hooks";
import { resolvedSampleRate } from "./settings.helpers";

/**
 * Drive a recording session: start on mount, stop on unmount/stop, and surface
 * the live signals. Returns the values the focused UI renders.
 */
function useRecordingSession(video: boolean) {
  const [started, setStarted] = useState(false);
  const [bytes, setBytes] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<RecordingEvent | null>(null);
  const [state, setState] = useState<RecorderStatePayload | null>(null);
  const [savePath, setSavePath] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [channelMode, setChannelMode] = useState<ChannelMode>("stereo");
  const running = useRef(false);
  const queryClient = useQueryClient();

  // Subscribe to every recorder channel for the overlay's lifetime.
  useEffect(() => {
    const unStarted = listen("recording://started", () => {
      setStarted(true);
      setStartedAt(Date.now());
    });
    const unProgress = listen<RecordingProgress>("recording://progress", (e) =>
      setBytes(e.payload.bytes_written),
    );
    // The recorder still emits `recording://silence`; the focused overlay no
    // longer surfaces it directly (the live signal label now reflects level), so
    // we intentionally don't subscribe to it here.
    const unError = listen<RecordingEvent>("recording://error", (e) =>
      setError(e.payload),
    );
    const unState = listen<RecorderStatePayload>("recording://state", (e) =>
      setState(e.payload),
    );
    return () => {
      void unStarted.then((off) => off());
      void unProgress.then((off) => off());
      void unError.then((off) => off());
      void unState.then((off) => off());
    };
  }, []);

  // Start the recorder on mount; stop it if the overlay unmounts while live.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Prefer the backend planner: the SAME save-folder + liturgical-filename
      // + processing logic the scheduler uses, so a manual recording lands in
      // the right place with a real `output_path`. Fall back to opts built from
      // the persisted-settings cache if the planner is unavailable (dev/test).
      let opts: RecordingOpts;
      try {
        opts = await invoke<RecordingOpts>("plan_recording_opts", {
          customName: null,
          maxMinutes: null,
          // Honour the Home video toggle (not persisted) so a video recording is
          // planned as `.mp4`, not the audio `.wav` format.
          video,
        });
      } catch {
        const s = queryClient.getQueryData<Settings>(SETTINGS_QUERY_KEY);
        opts = {
          audio_device_name: s?.deviceName ?? "",
          video_device_name: video ? (s?.videoDeviceName ?? "") : null,
          output_path: "",
          stop_on_silence: s?.stopOnSilence ?? false,
          silence_threshold_db: s?.silenceThreshold ?? null,
          silence_timeout_minutes: s?.silenceTimeoutMinutes ?? 5,
          framerate: 30,
          channel_mode: s?.channels ?? "stereo",
          // Resolve the sample-rate POLICY (auto → null = native rate, no
          // resample) — the recorder no longer reads the legacy `sampleRate`.
          sample_rate: resolvedSampleRate(s?.sampleRateMode ?? "auto"),
          bitrate_kbps: Math.min(
            Math.max(Number.parseInt(s?.bitrate ?? "192", 10) || 192, 32),
            320,
          ),
          split_minutes: s?.splitMinutes ?? 0,
          manual_max_minutes: s?.manualMaxMinutes ?? 0,
          // The level meter is always on so users can confirm signal.
          live_levels: true,
          keep_separate_audio: s?.keepSeparateAudio ?? false,
          // FileFormat is already the lowercase extension string the recorder
          // wants ("mp3" | "wav" | "flac" | "aac"), so pass it through directly.
          separate_audio_format: s?.separateAudioFormat ?? "wav",
          // The camera-mode probe targets this so 1080p records 1080p.
          video_resolution: s?.videoResolution ?? "720p",
        };
      }
      // Honour the Home video toggle even if it differs from the persisted flag.
      if (!video) opts = { ...opts, video_device_name: null };
      if (cancelled) return;
      setSavePath(opts.output_path || null);
      setDeviceLabel(opts.audio_device_name || null);
      // The chosen channel layout drives the pre-telemetry meter fallback
      // (stereo → two meters, mono → one) before the first `levels` event.
      setChannelMode(opts.channel_mode);
      // Release the Home VU's cpal mic BEFORE the recorder opens avfoundation —
      // macOS lets only one client own the input, and the VU teardown on screen
      // change is fire-and-forget. `stop_vu` is idempotent (no-op when idle) and
      // blocks in Rust until the stream is dropped, so awaiting it here removes
      // the contention window that could stall device enumeration.
      await invoke("stop_vu").catch(() => {});
      try {
        await invoke("start_recording", { opts });
        running.current = true;
      } catch (e) {
        // Surface the failure instead of freezing silently at "Starter …".
        if (!cancelled) {
          setStartError((e as { message?: string })?.message ?? String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
      if (running.current) void invoke("stop_recording").catch(() => {});
    };
  }, [video, queryClient]);

  // Tick the elapsed clock once a second once ffmpeg has confirmed.
  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [startedAt]);

  const stop = useCallback(async () => {
    try {
      await invoke("stop_recording");
    } catch {
      // ignore — the overlay is closing regardless
    } finally {
      running.current = false;
    }
  }, []);

  return {
    started,
    bytes,
    elapsed,
    error,
    state,
    savePath,
    deviceLabel,
    startError,
    channelMode,
    stop,
  };
}

/** Seconds → HH:MM:SS, matching the design's big counter. */
function formatClock(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}`;
}

/** Bytes → a compact MB string ("1.8 MB"). */
function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Live meter with a dB scale beneath (matches the real app). Driven by the
// backend `recording://levels` event — `on` is the lit-segment count from
// `dbfsToLit(peakDb, 44)`. The segmented bar is the level itself (no peak-hold
// tick).
//
// Memoized: a `recording://levels` event re-renders only the metering block, so
// an unchanged `on` (same lit-segment count between frames) skips this entirely
// — keeping the needle snappy without thrashing the rest of the screen.
const RecMeter = memo(function RecMeter({
  ch,
  on,
}: {
  ch: string;
  on: number;
}) {
  return (
    <div className="sr-row" style={{ gap: 14 }}>
      <span
        className="sr-mono"
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: "var(--sr-text-3)",
          width: 14,
        }}
      >
        {ch}
      </span>
      <div
        className="sr-grow"
        style={{ display: "flex", gap: 3, height: 40, position: "relative" }}
      >
        {Array.from({ length: 44 }).map((_, i) => {
          const c =
            i < on
              ? i > 39
                ? "var(--sr-red)"
                : i > 33
                  ? "var(--sr-gold)"
                  : "var(--sr-green)"
              : "var(--sr-ink-750)";
          return (
            <span key={i} style={{ flex: 1, background: c, borderRadius: 2 }} />
          );
        })}
      </div>
    </div>
  );
});

function RecScale() {
  return (
    <div
      className="sr-row"
      style={{
        justifyContent: "space-between",
        paddingLeft: 28,
        marginTop: 7,
        fontSize: 11,
        color: "var(--sr-text-dim)",
        fontFamily: "var(--sr-mono)",
      }}
    >
      {["−60", "−48", "−36", "−24", "−12", "0"].map((t) => (
        <span key={t}>{t}</span>
      ))}
    </div>
  );
}

function RecHeader({
  status,
  device,
}: {
  status: "starting" | "recording" | "reconnecting";
  device: string;
}) {
  const { t } = useTranslation();
  const label =
    status === "reconnecting"
      ? t("recordingScreen.statusReconnecting", "Kobler til på nytt")
      : status === "starting"
        ? t("recordingScreen.statusStarting", "Starter …")
        : t("recordingScreen.statusRecording", "Tar opp nå");
  return (
    <div
      className="sr-row"
      style={{ alignItems: "flex-start", marginBottom: 22 }}
    >
      <div
        className="sr-row sr-grow"
        style={{ gap: 12, alignItems: "flex-start" }}
      >
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            background:
              status === "recording" ? "var(--sr-red)" : "var(--sr-gold)",
            marginTop: 3,
            boxShadow: "0 0 0 4px rgba(229,72,77,0.22)",
          }}
        />
        <div>
          <div
            className="sr-label"
            style={{ color: "var(--sr-red-bright)", letterSpacing: "0.1em" }}
          >
            {label}
          </div>
          <div
            style={{ fontSize: 13.5, color: "var(--sr-text-3)", marginTop: 3 }}
          >
            {device}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The level-driven block: the live signal label (Svak/OK/Bra/Høy), the dBFS
 * readouts, and the level meters. It owns the `recording://levels`
 * subscription itself so the high-frequency level stream re-renders ONLY this
 * subtree — the timer, file-size and header above never re-render per frame
 * (WS-4). Memoized so a parent re-render (e.g. the 1 Hz clock) doesn't churn it.
 *
 * Channel confirmation: a STEREO recording renders two meters (L + R); a MONO
 * recording renders a single meter. The recorder signals this via the levels
 * payload — `peak_db_right` is `null` for mono, a real value for stereo. Before
 * the first level event arrives we fall back to the chosen `channelMode` from
 * settings so the user sees the right channel count immediately.
 */
const MeterSection = memo(function MeterSection({
  video,
  channelMode,
}: {
  video: boolean;
  channelMode: ChannelMode;
}) {
  const { t } = useTranslation();
  const [levels, setLevels] = useState<RecordingLevels | null>(null);
  useEffect(() => {
    const un = listen<RecordingLevels>("recording://levels", (e) =>
      setLevels(e.payload),
    );
    return () => {
      void un.then((off) => off());
    };
  }, []);

  // Before the first readout arrives, fall back to a neutral sample so the
  // meters aren't blank.
  const SAMPLE_DBFS = -40.6;
  const peakDbLeft = levels?.peak_db_left ?? SAMPLE_DBFS;
  const peakDbRight = levels?.peak_db_right ?? peakDbLeft;
  const peakMax = Math.max(peakDbLeft, peakDbRight);

  // STEREO when the recorder reports a real right-channel level. Before the
  // first telemetry event the right peak is null, so fall back to the chosen
  // channel layout (stereo settings → two meters, anything mono → one).
  const stereo =
    levels != null ? levels.peak_db_right != null : channelMode === "stereo";

  // Dynamic signal label from the louder of L/R (WS-4).
  const signalKey = levelLabel(peakMax);
  const signalLabel = {
    weak: t("recordingScreen.signalWeak", "Svak"),
    ok: t("recordingScreen.signalOk", "OK"),
    good: t("recordingScreen.signalGood", "Bra"),
    loud: t("recordingScreen.signalLoud", "Høy"),
  }[signalKey];
  const signalGreen = signalKey === "ok" || signalKey === "good";

  return (
    <>
      <div
        className="sr-row"
        style={{ alignItems: "flex-start", marginBottom: 16, marginTop: -6 }}
      >
        <div className="sr-grow sr-row" style={{ gap: 8 }}>
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: "50%",
              background: signalGreen ? "var(--sr-green)" : "var(--sr-gold)",
            }}
          />
          <span
            style={{
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: "0.04em",
              color: "var(--sr-text-2)",
            }}
          >
            {signalLabel}
          </span>
        </div>
        <div className="sr-row" style={{ gap: 18, alignItems: "baseline" }}>
          <span
            className="sr-mono sr-num"
            style={{ fontSize: 13, color: "var(--sr-text-3)" }}
          >
            {stereo ? "L" : ""}{" "}
            <span
              style={{ fontSize: 24, color: "var(--sr-text)", marginLeft: 4 }}
            >
              {formatDbfs(peakDbLeft)}
            </span>
          </span>
          {stereo && (
            <span
              className="sr-mono sr-num"
              style={{ fontSize: 13, color: "var(--sr-text-3)" }}
            >
              R{" "}
              <span
                style={{ fontSize: 24, color: "var(--sr-text)", marginLeft: 4 }}
              >
                {formatDbfs(peakDbRight)}
              </span>
            </span>
          )}
          <span
            className="sr-mono"
            style={{ fontSize: 12, color: "var(--sr-text-dim)" }}
          >
            {t("recordingScreen.dbfs", "dBFS")}
          </span>
        </div>
      </div>
      <div
        className={video ? "sr-stack-3" : "sr-stack-4"}
        style={{ marginTop: video ? 4 : 8 }}
      >
        <RecMeter ch={stereo ? "L" : ""} on={dbfsToLit(peakDbLeft, 44)} />
        {stereo && <RecMeter ch="R" on={dbfsToLit(peakDbRight, 44)} />}
      </div>
      <RecScale />
    </>
  );
});

function RecFooter({
  time,
  size,
  diskFree,
  savePath,
  onStop,
}: {
  time: string;
  size: string;
  diskFree: string;
  savePath: string | null;
  onStop?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="sr-row" style={{ alignItems: "flex-end", marginTop: 30 }}>
        <div className="sr-grow">
          <div
            className="sr-mono sr-num"
            style={{
              fontSize: 62,
              fontWeight: 300,
              lineHeight: 1,
              letterSpacing: "0.02em",
            }}
          >
            {time}
          </div>
          <div className="sr-row" style={{ gap: 40, marginTop: 16 }}>
            <div>
              <div className="sr-label">
                {t("recordingScreen.fileSize", "Filstørrelse")}
              </div>
              <div
                className="sr-num"
                style={{ fontSize: 17, fontWeight: 600, marginTop: 4 }}
              >
                {size}
              </div>
            </div>
            <div>
              <div className="sr-label">
                {t("recordingScreen.diskFree", "Diskplass igjen")}
              </div>
              <div
                className="sr-num"
                style={{ fontSize: 17, fontWeight: 600, marginTop: 4 }}
              >
                {diskFree}
              </div>
            </div>
          </div>
        </div>
        <button
          className="sr-recstop"
          onClick={onStop}
          aria-label={t(
            "recordingScreen.stopButton",
            "Trykk for å stoppe opptaket",
          )}
        >
          <span
            style={{
              width: 11,
              height: 11,
              borderRadius: 2,
              background: "var(--sr-red-bright)",
            }}
          />
          {t("recordingScreen.stopButton", "Trykk for å stoppe opptaket")}
        </button>
      </div>
      <div
        className="sr-mono"
        style={{
          fontSize: 12,
          color: "var(--sr-text-dim)",
          marginTop: 24,
          padding: "11px 14px",
          borderRadius: "var(--sr-r-sm)",
          background: "var(--sr-line-faint)",
          border: "1px solid var(--sr-line)",
        }}
      >
        {t("recordingScreen.savedAs", "Lagres som:")} {savePath ?? "…"}
      </div>
    </>
  );
}

/**
 * The live camera image shown WHILE recording video. The recording ffmpeg writes
 * a downscaled, low-fps JPEG to a fixed temp file (a deadlock-proof FILE sink —
 * NOT a stdout pipe, which could freeze the capture), and we POLL the backend
 * `recording_preview_frame` command (~4×/s) for the latest base64 frame. A `null`
 * result (no frame yet / a momentary partial write) keeps the last good frame, so
 * the tile never flickers. Falls back to the placeholder until the first frame.
 */
const LiveCameraImage = memo(function LiveCameraImage({
  placeholder,
}: {
  placeholder: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const b64 = await invoke<string | null>("recording_preview_frame");
        if (alive && b64) setSrc(`data:image/jpeg;base64,${b64}`);
      } catch {
        // Keep the last good frame on a transient read failure.
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 250);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div
      className="sr-media"
      style={{
        aspectRatio: "16 / 9",
        borderRadius: 0,
        border: "none",
        overflow: "hidden",
        padding: 0,
      }}
    >
      {src ? (
        <img
          src={src}
          alt=""
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
      ) : (
        placeholder
      )}
    </div>
  );
});

export function RecordingScreen({
  video = false,
  onStop,
}: {
  video?: boolean;
  onStop?: () => void;
}) {
  const { t } = useTranslation();
  const {
    started,
    bytes,
    elapsed,
    error,
    state,
    savePath,
    deviceLabel,
    startError,
    channelMode,
    stop,
  } = useRecordingSession(video);
  const diskFree = useDiskSpace();

  const status: "starting" | "recording" | "reconnecting" =
    state?.state === "reconnecting"
      ? "reconnecting"
      : started
        ? "recording"
        : "starting";

  const handleStop = useCallback(() => {
    void stop().finally(() => onStop?.());
  }, [stop, onStop]);

  return (
    <div className="sr-win">
      {/* Native macOS traffic-lights overlay this dark bar (titleBarStyle:
          Overlay); the strip is a drag region with left room for the lights. */}
      <div
        className="sr-titlebar"
        data-tauri-drag-region
        style={{ paddingLeft: 80 }}
      >
        <div className="sr-wintitle">
          {t("recordingScreen.titlebar", "SundayRec — tar opp")}
        </div>
      </div>
      <div
        style={{
          flex: "1 1 auto",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "40px 40px 48px",
        }}
      >
        <div style={{ width: "100%", maxWidth: 880 }}>
          {status === "reconnecting" && (
            <div
              role="alert"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 16px",
                marginBottom: 18,
                borderRadius: 12,
                background: "var(--sr-red-tint)",
                border: "1px solid var(--sr-red)",
              }}
            >
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  background: "var(--sr-red)",
                  animation: "sr-pulse 1.1s ease-in-out infinite",
                  flex: "0 0 12px",
                }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>
                  {t(
                    "recordingScreen.reconnectTitle",
                    "Lydkilden ble frakoblet",
                  )}
                </div>
                <div className="sr-card-desc">
                  {t(
                    "recordingScreen.reconnectDesc",
                    "Kobler til på nytt automatisk — opptaket fortsetter når enheten er tilbake.",
                  )}
                </div>
              </div>
            </div>
          )}
          {video && (
            <div
              className="sr-card"
              style={{ padding: 0, overflow: "hidden", marginBottom: 22 }}
            >
              <div
                className="sr-row"
                style={{
                  gap: 9,
                  padding: "10px 14px",
                  position: "absolute",
                  zIndex: 2,
                }}
              >
                <Icon
                  name="camera"
                  size={15}
                  style={{ color: "rgba(255,255,255,0.85)" }}
                />
                <span
                  className="sr-label"
                  style={{ color: "rgba(255,255,255,0.85)" }}
                >
                  {t("recordingScreen.camera", "Kamera")}
                </span>
                <span
                  className="sr-mono sr-num"
                  style={{
                    fontSize: 12,
                    color: "var(--sr-red-bright)",
                    fontWeight: 600,
                  }}
                >
                  {formatMb(bytes)}
                </span>
              </div>
              <LiveCameraImage
                placeholder={t(
                  "recordingScreen.cameraRecordingMeta",
                  "kamera tar opp · 720p · 30 fps",
                )}
              />
            </div>
          )}
          <RecHeader
            status={status}
            device={deviceLabel || "Standard lydinngang"}
          />
          {/* Isolated level-driven block: signal label + L/R dB + meters. Owns
              the `recording://levels` subscription so high-frequency level
              updates re-render ONLY this subtree (WS-4). */}
          <MeterSection video={video} channelMode={channelMode} />
          {startError && (
            <div
              className="sr-mono"
              style={{
                fontSize: 12.5,
                color: "var(--sr-red-bright)",
                marginTop: 18,
                padding: "12px 14px",
                borderRadius: "var(--sr-r-sm)",
                background: "var(--sr-red-tint)",
                border: "1px solid var(--sr-red)",
              }}
            >
              {t("recordingScreen.startFailed", "Kunne ikke starte opptaket:")}{" "}
              {startError}
            </div>
          )}
          <RecFooter
            time={formatClock(elapsed)}
            size={formatMb(bytes)}
            diskFree={diskFree != null ? `${formatBytes(diskFree)}` : "569 GB"}
            savePath={savePath}
            onStop={handleStop}
          />
          {error && (
            <div
              className="sr-mono"
              style={{
                fontSize: 12,
                color: "var(--sr-red-bright)",
                marginTop: 12,
                padding: "11px 14px",
                borderRadius: "var(--sr-r-sm)",
                background: "var(--sr-red-tint)",
                border: "1px solid var(--sr-red)",
              }}
            >
              {t("recordingScreen.errorPrefix", "Feil ({{code}})", {
                code: error.code,
              })}
              : {error.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
