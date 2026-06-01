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
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";

import type { RecordingOpts } from "@/lib/bindings/RecordingOpts";
import type { RecordingProgress } from "@/lib/bindings/RecordingProgress";
import type { RecordingLevels } from "@/lib/bindings/RecordingLevels";
import type { RecordingEvent } from "@/lib/bindings/RecordingEvent";
import type { RecorderStatePayload } from "@/lib/bindings/RecorderStatePayload";
import type { Settings } from "@/lib/bindings/Settings";
import { SETTINGS_QUERY_KEY } from "@/features/settings/queryKey";

import { Icon } from "../Icon";
import { useDiskSpace, formatBytes, dbfsToLit, formatDbfs } from "../hooks";

/**
 * Drive a recording session: start on mount, stop on unmount/stop, and surface
 * the live signals. Returns the values the focused UI renders.
 */
function useRecordingSession(video: boolean) {
  const [started, setStarted] = useState(false);
  const [bytes, setBytes] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [silence, setSilence] = useState<RecordingEvent | null>(null);
  const [levels, setLevels] = useState<RecordingLevels | null>(null);
  const [error, setError] = useState<RecordingEvent | null>(null);
  const [state, setState] = useState<RecorderStatePayload | null>(null);
  const [savePath, setSavePath] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
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
    const unSilence = listen<RecordingEvent>("recording://silence", (e) =>
      setSilence(e.payload),
    );
    const unLevels = listen<RecordingLevels>("recording://levels", (e) =>
      setLevels(e.payload),
    );
    const unError = listen<RecordingEvent>("recording://error", (e) =>
      setError(e.payload),
    );
    const unState = listen<RecorderStatePayload>("recording://state", (e) =>
      setState(e.payload),
    );
    return () => {
      void unStarted.then((off) => off());
      void unProgress.then((off) => off());
      void unSilence.then((off) => off());
      void unLevels.then((off) => off());
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
          stereo: (s?.channels ?? "stereo") === "stereo",
          split_minutes: s?.splitMinutes ?? 0,
          manual_max_minutes: s?.manualMaxMinutes ?? 0,
        };
      }
      // Honour the Home video toggle even if it differs from the persisted flag.
      if (!video) opts = { ...opts, video_device_name: null };
      if (cancelled) return;
      setSavePath(opts.output_path || null);
      setDeviceLabel(opts.audio_device_name || null);
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
    silence,
    levels,
    error,
    state,
    savePath,
    deviceLabel,
    startError,
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

/**
 * Peak-hold for a segmented meter: snaps UP to `value` instantly (fast attack)
 * and falls back SLOWLY (slow release) so the marker lingers on the loudest
 * recent level — the classic VU peak tick. `value` and the result are in
 * lit-segment units; it decays ~`decayPerSec` segments/second.
 */
function usePeakHold(value: number, decayPerSec = 26): number {
  const [held, setHeld] = useState(value);
  const heldRef = useRef(value);
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const v = valueRef.current;
      const prev = heldRef.current;
      // Instant attack toward a louder reading; slow linear release otherwise.
      const next = v >= prev ? v : Math.max(v, prev - decayPerSec * dt);
      if (next !== prev) {
        heldRef.current = next;
        setHeld(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [decayPerSec]);
  return held;
}

// Live meter with a dB scale beneath (matches the real app). Driven by the
// backend `recording://levels` event — `on` is the lit-segment count from
// `dbfsToLit(peakDb, 44)`. The white tick is a peak-hold marker that tracks the
// loudest recent level and decays slowly back down.
function RecMeter({ ch, on }: { ch: string; on: number }) {
  const peak = usePeakHold(on);
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
        {peak > 0.5 && (
          <span
            style={{
              position: "absolute",
              left: `${Math.min((peak / 44) * 100, 100)}%`,
              top: -4,
              bottom: -4,
              width: 2,
              background: "rgba(255,255,255,0.85)",
              // Smooth the per-frame release without lagging the instant attack.
              transition: "left 50ms linear",
            }}
          />
        )}
      </div>
    </div>
  );
}

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
  weak,
  dbLeft,
  dbRight,
  device,
}: {
  status: "starting" | "recording" | "reconnecting";
  weak: boolean;
  dbLeft: number;
  dbRight: number;
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
      <div className="sr-row" style={{ gap: 8, marginTop: 1 }}>
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: weak ? "var(--sr-gold)" : "var(--sr-green)",
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
          {weak
            ? t("recordingScreen.signalWeak", "SVAK")
            : t("recordingScreen.signalOk", "OK")}
        </span>
      </div>
      <div
        className="sr-row"
        style={{ gap: 18, marginLeft: 28, alignItems: "baseline" }}
      >
        <span
          className="sr-mono sr-num"
          style={{ fontSize: 13, color: "var(--sr-text-3)" }}
        >
          L{" "}
          <span
            style={{ fontSize: 24, color: "var(--sr-text)", marginLeft: 4 }}
          >
            {formatDbfs(dbLeft)}
          </span>
        </span>
        <span
          className="sr-mono sr-num"
          style={{ fontSize: 13, color: "var(--sr-text-3)" }}
        >
          R{" "}
          <span
            style={{ fontSize: 24, color: "var(--sr-text)", marginLeft: 4 }}
          >
            {formatDbfs(dbRight)}
          </span>
        </span>
        <span
          className="sr-mono"
          style={{ fontSize: 12, color: "var(--sr-text-dim)" }}
        >
          {t("recordingScreen.dbfs", "dBFS")}
        </span>
      </div>
    </div>
  );
}

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
          className="sr-btn danger"
          onClick={onStop}
          style={{
            background: "transparent",
            color: "var(--sr-red-bright)",
            border: "1.5px solid var(--sr-red)",
            padding: "15px 26px",
            fontSize: 15,
            borderRadius: "var(--sr-r-md)",
          }}
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
    silence,
    levels,
    error,
    state,
    savePath,
    deviceLabel,
    startError,
    stop,
  } = useRecordingSession(video);
  const diskFree = useDiskSpace();

  const status: "starting" | "recording" | "reconnecting" =
    state?.state === "reconnecting"
      ? "reconnecting"
      : started
        ? "recording"
        : "starting";

  // Per-channel peak dBFS from the recorder's astats telemetry. Before the first
  // readout arrives, fall back to a neutral sample so the meters aren't blank.
  const SAMPLE_DBFS = -40.6;
  const peakDbLeft = levels?.peak_db_left ?? SAMPLE_DBFS;
  const peakDbRight = levels?.peak_db_right ?? peakDbLeft;

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
              <div
                className="sr-media"
                style={{
                  aspectRatio: "16 / 9",
                  borderRadius: 0,
                  border: "none",
                }}
              >
                {t(
                  "recordingScreen.cameraRecordingMeta",
                  "kamera tar opp · 720p · 30 fps",
                )}
              </div>
            </div>
          )}
          <RecHeader
            status={status}
            weak={silence !== null}
            dbLeft={peakDbLeft}
            dbRight={peakDbRight}
            device={deviceLabel || "Standard lydinngang"}
          />
          <div
            className={video ? "sr-stack-3" : "sr-stack-4"}
            style={{ marginTop: video ? 4 : 8 }}
          >
            <RecMeter ch="L" on={dbfsToLit(peakDbLeft, 44)} />
            <RecMeter ch="R" on={dbfsToLit(peakDbRight, 44)} />
          </div>
          <RecScale />
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
