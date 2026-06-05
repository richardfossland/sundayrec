// window.api shim — maps the OLD Electron preload surface onto the Tauri backend.
//
// Loaded as a module script BEFORE ./main.ts in index.html, so `window.api`
// exists before the renderer boots.
//
// PHASE 3 (in progress): methods are being wired to real Tauri `invoke()`
// commands (134 exist in src-tauri/src/lib.rs; the contract is documented in
// reference/hooks.ts + reference/bindings). Each wired method calls the backend
// through `call()` and falls back to a safe default on any error, so a missing/
// mismatched command degrades to the old empty-state instead of throwing. Methods
// not yet wired keep their safe stub (marked `// TODO Phase 3: <command>`).
//
// NOTE: VU metering + audio/video device enumeration are CLIENT-SIDE in the
// ported renderer (Web Audio getUserMedia / enumerateDevices), so they already
// work in the Tauri WKWebView with no backend wiring (just a mic/camera grant).

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

// Broad, VLC-like accept lists — the bundled ffmpeg demuxes all of these, and
// the loader falls back to an ffmpeg → 8 kHz WAV decode for anything the browser
// can't decode directly. Keep these in sync with the drag-drop sets in
// editor-page.ts / editor/state.ts.
const AUDIO_EXT = [
  "mp3", "mp1", "mp2", "wav", "flac", "aac", "m4a", "m4b", "m4r", "ogg", "oga",
  "opus", "aiff", "aif", "wma", "mka", "ac3", "eac3", "amr", "3ga", "caf", "wv",
  "tta", "au", "snd", "ape", "dts", "mpc", "ra", "ram", "spx", "gsm",
];
const VIDEO_EXT = [
  "mp4", "mov", "mkv", "m4v", "webm", "avi", "wmv", "ts", "mts", "m2ts", "flv",
  "3gp", "asf", "f4v",
];
const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif"];

/** A native file/folder picker that returns the chosen path (or null), never
 *  throwing — a denied permission or cancel just yields null. */
async function pickPath(opts: {
  directory?: boolean;
  name?: string;
  extensions?: string[];
}): Promise<string | null> {
  try {
    const res = await openDialog({
      directory: !!opts.directory,
      multiple: false,
      filters:
        opts.extensions && opts.name
          ? [{ name: opts.name, extensions: opts.extensions }]
          : undefined,
    });
    return typeof res === "string" ? res : null;
  } catch (e) {
    console.warn("[api-shim] file dialog failed", e);
    return null;
  }
}

/** Convert a local filesystem path to an `asset://` URL WKWebView can load in an
 *  <audio>/<video>/<img> `src`. The OLD Electron renderer used `file://` (and a
 *  custom `media://` protocol), which WKWebView blocks — every editor preview /
 *  mastering playback that set `file://…` was silently dead. The asset protocol
 *  is enabled with scope `**` in tauri.conf, so this is the supported path. */
function toAssetUrl(path: string): string {
  return path ? convertFileSrc(path) : "";
}

/** Invoke a Tauri command, falling back to `fallback` on any error so the UI
 *  never throws while the backend is partially wired. */
async function call<T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  fallback: T,
): Promise<T> {
  try {
    return (await invoke<T>(cmd, args)) as T;
  } catch (e) {
    console.warn(`[api-shim] ${cmd} failed → fallback`, e);
    return fallback;
  }
}

/** Editor/mastering commands return BARE Rust result structs (e.g. `{outputPath}`),
 *  but the ported Electron consumers expect the old `{ ok, …, error }` envelope —
 *  they all branch on `result.ok`. Wrap a success with `ok: true`; a failure (the
 *  invoke threw → the `{ ok: false }` fallback) stays `ok: false`. Without this,
 *  every editor export / mastering step reads `ok === undefined` (falsy) and shows
 *  "failed" even when the file was written. (Found by the IPC-seam audit.) */
async function editorCall<T extends object>(
  cmd: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = await call<T | { ok: false }>(cmd, args, { ok: false } as { ok: false });
  if (r && typeof r === "object" && (r as { ok?: unknown }).ok === false) {
    return { ok: false };
  }
  return { ok: true, ...(r as object) };
}

// Old Electron `on(channel)` → Tauri event name. Channels with no Rust emitter
// (tray-*, update-*, cloud-upload-*, …) fall through to a no-op subscription.
const EVENT_MAP: Record<string, string> = {
  "recording-overlay-start": "recording://started",
  "recording-overlay-stop": "recording://state",
  "recording-finished": "recording://finished",
  "recording-error": "recording://error",
  "recording-progress": "recording://progress",
  "recording-reconnecting": "recording://reconnecting",
  "recording-reconnected": "recording://reconnected",
  "video-preview-frame": "preview://frame",
  "video-preview-stopped": "preview://stopped",
  "video-preview-meta": "preview://meta",
  "master-progress": "editor-master-progress",
  "whisper-progress": "whisper://progress",
  "whisper-model-progress": "whisper://model-progress",
  "stream-stats": "streaming://stats",
  "editor-export-progress": "editor://export-progress",
};

// Per-event payload ADAPTERS: the Tauri backend emits typed Rust structs whose
// field names (snake_case) / shapes differ from the old Electron IPC payloads
// the ported handlers expect. Each adapter reshapes the payload to what the
// legacy handler reads. (Found by the IPC-seam audit.)
const EVENT_ADAPTERS: Record<string, (p: unknown) => unknown> = {
  // RecordingProgress { bytes_written } → handler reads `bytes`.
  "recording-progress": (p) => {
    const d = (p ?? {}) as { bytes_written?: number };
    return { ...d, bytes: d.bytes_written };
  },
  // RecordingFinished { file_path, has_video } → handler reads `path`. There's no
  // split-restart signal in the Tauri event, so a finished recording always
  // hides the overlay + offers "open in editor" (splitRestart: false).
  "recording-finished": (p) => {
    const d = (p ?? {}) as { file_path?: string };
    return { ...d, path: d.file_path, splitRestart: false };
  },
  // RecordingEvent { code, message } → handler also reads `error` for the
  // localized native-error mapping.
  "recording-error": (p) => {
    const d = (p ?? {}) as { code?: string; message?: string };
    return { ...d, error: d.code };
  },
  // PreviewFrame { data: <base64>, … } → the legacy frame handlers expect raw
  // JPEG bytes (normalizeFrameData). Decode base64 → Uint8Array.
  "video-preview-frame": (p) => {
    const d = p as { data?: string } | undefined;
    if (d && typeof d.data === "string") {
      const bin = atob(d.data);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr;
    }
    return p;
  },
  // EditorMasterProgress { job_id, current_sec, total_sec } (snake_case) → the
  // mastering panel reads currentSec/totalSec. Without this, `totalSec` was
  // undefined so the progress bar stayed frozen at 0% for the WHOLE mastering
  // apply (looked hung even though it was working). (Found by the event-seam audit.)
  "master-progress": (p) => {
    const d = (p ?? {}) as {
      job_id?: string;
      current_sec?: number;
      total_sec?: number;
    };
    return {
      ...d,
      jobId: d.job_id,
      currentSec: d.current_sec,
      totalSec: d.total_sec,
    };
  },
};

// ── Default settings (mirrors OLD src/main/store.ts `defaults`) ───────────────
const DEFAULT_SETTINGS: Record<string, unknown> = {
  language: null,
  hasLaunched: false,
  deviceId: null,
  deviceName: null,
  deviceChannels: {},
  channels: "stereo",
  sampleRate: 48000,
  inputVolume: 100,
  eqBass: 0,
  eqMid: 0,
  eqTreble: 0,
  compEnabled: false,
  compThreshold: -24,
  compRatio: 4,
  compAttack: 10,
  compRelease: 200,
  limiterEnabled: true,
  limiterCeiling: -1,
  format: "mp3",
  bitrate: "192",
  filenamePattern: "date",
  saveFolder: null,
  autoDeleteDays: 0,
  slots: [],
  specialRecordings: [],
  stopOnSilence: false,
  splitMinutes: 0,
  reminderMinutes: 0,
  manualMaxMinutes: 0,
  preRollSeconds: 0,
  launchAtLogin: false,
  showOnStartup: false,
  minimizeToTray: true,
  wakeFromSleep: true,
  protectRecording: true,
  notifyStart: true,
  notifyStop: true,
  emailOnError: false,
  emailAddress: "",
  emailSmtp: "",
  emailSmtpPort: 587,
  emailSmtpUser: "",
  emailSmtpPass: "",
  autoUpdate: true,
  askOpenEditor: true,
  editorIntroPath: undefined,
  editorOutroPath: undefined,
  cloudGoogleDrive: undefined,
  cloudDropbox: undefined,
  cloudOneDrive: undefined,
  churchName: "",
  responsiblePerson: "",
  integrations: { enabled: false },
  activeRecovery: null,
  nextExpectedRecordingISO: null,
  recordingHistory: [],
  wakeFailureHistory: [],
};

const LS_KEY = "sundayrec.settings";

// Dev/verification hook (inert in normal use): `?goto=<page>` skips first-run
// onboarding and navigates to the named page after boot, so each screen can be
// screenshotted headlessly. Without the query param this is completely inactive.
const VERIFY_GOTO = new URLSearchParams(location.search).get("goto");

function loadSettings(): Record<string, unknown> {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    const merged = { ...DEFAULT_SETTINGS, ...saved };
    if (VERIFY_GOTO) {
      merged.hasLaunched = true; // skip onboarding during verify screenshots
      merged.onboardingDone = true;
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettingsLocal(s: unknown): boolean {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

// The UI's full settings live in localStorage (83 fields, superset of the Rust
// Settings). But the RECORDER reads the backend (sqlite) settings via
// `plan_recording_opts` → `settings::load(db)`, which the UI never wrote to — so
// the user's resolution/format/camera/codec choices NEVER reached an actual
// recording (it used backend DEFAULTS). This pushes the recording-critical subset
// to the backend so manual + scheduled recordings honour the UI. Only a curated
// set of fields with KNOWN-COMPATIBLE types is sent (the Rust enums for
// format/channels are ported 1:1, so the string values match); everything else
// defaults backend-side. Best-effort — a deserialize error leaves the backend
// unchanged (no regression). `settings_save` deserializes with serde(default).
function backendRecordingSettings(s: Record<string, unknown>): Record<string, unknown> {
  // Channel L/R: the recorder reads TOP-LEVEL inputChannelL/R (custom_channel_map_filter
  // records ANY two device channels into a stereo file — e.g. an X32 mixer on ch 16/17),
  // but the audio-page stores the mapping PER DEVICE in deviceChannels[deviceId]. So the
  // recorder never saw it → channel selection was silently ignored (always default 0/1).
  // Translate the SELECTED device's mapping to the top-level fields; clamp 0..31 mirrors
  // the Rust validate(). Default (0,1) is a no-op in custom_channel_map_filter, so this
  // only changes behaviour when the user actually picked non-default channels.
  const deviceChannels = (s.deviceChannels ?? {}) as Record<
    string,
    { channelL?: unknown; channelR?: unknown }
  >;
  const selDeviceId = (s.deviceId as string | null) ?? null;
  const chMap = (selDeviceId && deviceChannels[selDeviceId]) || {};
  const clampCh = (v: unknown): number | null =>
    typeof v === "number" && Number.isInteger(v) ? Math.min(31, Math.max(0, v)) : null;
  return {
    deviceId: s.deviceId ?? null,
    deviceName: s.deviceName ?? null,
    videoEnabled: s.videoEnabled ?? false,
    videoDeviceName: s.videoDeviceName ?? null,
    videoDeviceIndex: s.videoDeviceIndex ?? null,
    videoResolution: s.videoResolution ?? "720p",
    videoFramerate: s.videoFramerate ?? 30,
    videoContainer: s.videoContainer ?? "mp4",
    videoCodec: s.videoCodec ?? "h264",
    videoEncoder: s.videoEncoder ?? "software",
    videoFlip: s.videoFlip ?? false,
    outputMode: s.videoSeparate ? "separate" : "combined",
    keepSeparateAudio: s.videoKeepAudio !== false,
    separateAudioFormat: s.format ?? "wav",
    channels: s.channels ?? "stereo",
    inputChannelL: clampCh(chMap.channelL),
    inputChannelR: clampCh(chMap.channelR),
    format: s.format ?? "mp3",
    bitrate: String(s.bitrate ?? "192"),
    saveFolder: s.saveFolder ?? null,
    // The filename pattern drives the recorder's output filename (build_opts →
    // build_filename). Omitting it let Rust's #[serde(default)] re-default it to
    // `date` on every settings_save, so a user who picked church/plain/datetime
    // had every recording silently named with the `date` pattern. Whitelisted
    // because a stale/corrupt localStorage value would otherwise fail the WHOLE
    // settings_save (serde rejects an unknown enum), dropping ALL recorder sync.
    filenamePattern: (["date", "church", "plain", "datetime"] as const).includes(
      s.filenamePattern as "date" | "church" | "plain" | "datetime",
    )
      ? (s.filenamePattern as string)
      : "date",
    stopOnSilence: s.stopOnSilence ?? false,
    silenceThreshold: s.silenceThreshold ?? -50,
    silenceTimeoutMinutes: s.silenceTimeoutMinutes ?? 5,
    splitMinutes: s.splitMinutes ?? 0,
    manualMaxMinutes: s.manualMaxMinutes ?? 0,
    preRollSeconds: s.preRollSeconds ?? 0,
    // Wake-from-sleep drives the BACKEND scheduler's OS-wake arming
    // (scheduler/mod.rs reads settings.wake_from_sleep). Must be synced or the
    // Rust `#[serde(default = "default_true")]` re-defaults it to `true` on every
    // settings_save → a user who turns wake OFF could never make it stick and the
    // machine would keep waking for scheduled recordings.
    wakeFromSleep: s.wakeFromSleep ?? true,
    // The weekly schedule + one-off recordings drive the BACKEND scheduler
    // (which couldn't see them while settings lived only in localStorage → no
    // scheduled recording ever fired). SANITISED so a single malformed entry
    // can't fail the whole settings_save (which would also drop the recording
    // settings). Shapes match the Rust ScheduleSlot / SpecialRecording.
    slots: sanitizeSlots(s.slots),
    specialRecordings: sanitizeSpecials(s.specialRecordings),
  };
}

function sanitizeSlots(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return [];
  return v
    .filter((sl) => sl && Array.isArray((sl as { days?: unknown }).days))
    .map((sl) => {
      const o = sl as Record<string, unknown>;
      return {
        days: (o.days as unknown[]).filter((d) => Number.isInteger(d)),
        start: typeof o.start === "string" ? o.start : "10:00",
        stop: typeof o.stop === "string" ? o.stop : "12:00",
        max: typeof o.max === "number" ? o.max : null,
      };
    });
}

function sanitizeSpecials(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return [];
  return v
    .filter((r) => r && typeof (r as { date?: unknown }).date === "string")
    .map((r) => {
      const o = r as Record<string, unknown>;
      return {
        id: typeof o.id === "string" ? o.id : null,
        date: o.date as string,
        name: typeof o.name === "string" ? o.name : "",
        start: typeof o.start === "string" ? o.start : "10:00",
        stop: typeof o.stop === "string" ? o.stop : "12:00",
      };
    });
}

let lastSyncedJson = "";
async function syncBackendRecordingSettings(s: unknown): Promise<void> {
  try {
    const curated = backendRecordingSettings((s ?? {}) as Record<string, unknown>);
    const json = JSON.stringify(curated);
    if (json === lastSyncedJson) return; // nothing changed
    lastSyncedJson = json;
    await invoke("settings_save", { settings: curated });
    // Wake the scheduler supervisor so it picks up new/changed slots immediately
    // (settings_save alone doesn't recompute the schedule).
    try {
      await invoke("scheduler_reschedule");
    } catch {
      /* scheduler reschedule is best-effort */
    }
  } catch (e) {
    console.warn("[api-shim] backend settings sync failed (recording will use defaults)", e);
  }
}

const noop = (): void => {};
const off = () => {}; // unsubscribe stub

// Platform from the webview UA (the renderer's init() also checks this).
const platform = navigator.userAgent.toLowerCase().includes("mac")
  ? "darwin"
  : navigator.userAgent.toLowerCase().includes("win")
    ? "win32"
    : "linux";

// Common stub shapes so renderers that read fields/iterate don't throw.
const okFalse = { connected: false, configured: false };
const cloudStatusStub = {
  googleDrive: { connected: false },
  dropbox: { connected: false },
  oneDrive: { connected: false },
};
const streamStatusStub = {
  active: false,
  uptime: 0,
  // Field names match what live-page.ts reads (s.bitrateKbps / s.dropped / s.fps),
  // so idle stats show "0 kbps" / "0" like the old app — not "undefined".
  bitrateKbps: 0,
  fps: 0,
  dropped: 0,
  destinations: [],
};

// ── History adapter: Rust RecordingRow → the old renderer's RecordingEntry ───
type RecordingRow = {
  id: string;
  file_path: string;
  device_name: string | null;
  started_at: number;
  duration_ms: number | null;
  byte_size: number | null;
  created_at: number;
  note: string | null;
};

// Maps the old renderer's `timestamp` key (created_at) back to the Rust row id,
// so deleteHistoryEntry(timestamp) can call recordings_delete(id).
const historyIdByTs = new Map<number, string>();

const basename = (p: string): string => p.split(/[\\/]/).pop() || p;

/** Seconds → the old "Xt Ym" / "Ym" duration string the history table parses. */
function fmtDurXtYm(sec: number): string {
  const totalMin = Math.round(sec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}t ${m}m` : `${m}m`;
}

function rowToEntry(r: RecordingRow): Record<string, unknown> {
  const path = r.file_path ?? "";
  const filename = basename(path);
  const durationSec = r.duration_ms != null ? Math.round(r.duration_ms / 1000) : 0;
  const ts = r.created_at ?? r.started_at ?? 0;
  if (r.id) historyIdByTs.set(ts, r.id);
  return {
    timestamp: ts,
    date: new Date(ts).toISOString(),
    startTime: "",
    path,
    filename,
    name: filename,
    status: "ok", // recordings_list only holds completed recordings
    durationSec,
    duration: fmtDurXtYm(durationSec),
    sizeBytes: r.byte_size ?? null,
    fileSizeBytes: r.byte_size ?? null,
    note: r.note ?? undefined,
    cloudUploaded: [],
    cloudUrls: {},
  };
}

const api: Record<string, unknown> = {
  // ── Settings ────────────────────────────────────────────────────────────
  getSettings: async () => loadSettings(),
  saveSettings: async (s: unknown) => {
    const ok = saveSettingsLocal(s);
    void syncBackendRecordingSettings(s); // push recording-critical subset to sqlite
    return ok;
  },
  exportProfile: async () => loadSettings(),
  importProfile: async () => true,
  resetSettings: async () => {
    localStorage.removeItem(LS_KEY);
    return true;
  },

  // ── Schedule / next recording ───────────────────────────────────────────
  // scheduler_status → { next: ISO string | null }; old getNextRecording returns
  // { date } | null.
  getNextRecording: async () => {
    const s = await call<{ next: string | null }>("scheduler_status", undefined, {
      next: null,
    });
    return s.next ? { date: s.next } : null;
  },

  // ── History (recordings_list → RecordingEntry[]) ─────────────────────────
  getHistory: async () => {
    historyIdByTs.clear();
    const rows = await call<RecordingRow[]>("recordings_list", undefined, []);
    return rows.map(rowToEntry);
  },
  deleteHistoryEntry: async (ts: number) => {
    const id = historyIdByTs.get(ts);
    if (!id) return false;
    return call("recordings_delete", { id }, false).then(() => true);
  },
  clearHistory: async () => call("recordings_clear", undefined, false).then(() => true),
  pruneHistory: async () => call("recordings_prune", undefined, 0),
  // recording_update_note(id, note) — map the renderer's timestamp key back to the
  // Rust row id (same map deleteHistoryEntry uses).
  updateHistoryNote: async (ts: number, note: string) => {
    const id = historyIdByTs.get(ts);
    if (!id) return false;
    return call("recording_update_note", { id, note: note || null }, false).then(() => true);
  },

  // ── Disk / recording ────────────────────────────────────────────────────
  // get_disk_space returns { freeBytes } (camelCase) — exactly what home.ts reads.
  getDiskSpace: async () =>
    call("get_disk_space", undefined, { freeBytes: null, totalBytes: null }),
  // Recording: the old renderer builds a full (old-shape) RecordingOpts, but the
  // Rust recorder wants its own RecordingOpts. plan_recording_opts builds the
  // correct one from the backend settings; we only forward customName/maxMinutes/
  // video from the old opts. (Device/format come from the Rust DB settings, not
  // the client-side localStorage settings — a known limit of the split.)
  startRecordingNow: async (opts: unknown) => {
    const o = (opts ?? {}) as {
      customName?: string;
      maxMinutes?: number;
      videoEnabled?: boolean;
    };
    try {
      const planned = await invoke("plan_recording_opts", {
        customName: o.customName || null,
        maxMinutes: o.maxMinutes ?? null,
        video: !!o.videoEnabled,
      });
      await invoke("start_recording", { opts: planned });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
  stopRecordingNow: async () => call("stop_recording", undefined, true).then(() => true),
  runTestRecording: async () =>
    call("run_test_recording", undefined, { ok: false, level: null, message: "" }),
  // run_preflight returns Vec<PreflightFinding> directly; old code reads { findings }.
  runPreflight: async () => ({
    findings: await call<unknown[]>("run_preflight", undefined, []),
  }),

  // ── File dialogs / shell (Tauri dialog + opener plugins) ────────────────
  pickFolder: async () => pickPath({ directory: true }),
  openFolder: async (p: string) => {
    try {
      await openPath(p);
      return true;
    } catch {
      return false;
    }
  },
  revealFile: async (p: string) => {
    try {
      await revealItemInDir(p);
      return true;
    } catch {
      return false;
    }
  },
  pickAudioFile: async () =>
    pickPath({ name: "Lyd", extensions: AUDIO_EXT }),

  // ── Email / webhook ─────────────────────────────────────────────────────
  testWebhook: async () => ({ ok: false }),
  testEmail: async () => ({ ok: false }),
  clearSmtpPassword: async () => true,

  // ── App / updates ───────────────────────────────────────────────────────
  getAppVersion: async () =>
    (await call<{ version?: string }>("app_info", undefined, {})).version ?? "—",
  getPlatform: async () => platform,
  checkForUpdates: async () => ({ available: false }),
  installUpdate: async () => true,
  getLogs: async () => [],
  getLogFilePath: async () => null,
  runDiagnostics: async () => ({
    markdown: "",
    savedTo: null,
    clipboardOk: false,
    captureOk: false,
    videoOk: null,
  }),

  // ── Audio / video devices ───────────────────────────────────────────────
  listAsioDrivers: async () => [],
  // audio-page.ts calls `.some(...)` on the result → must be an array.
  listFfmpegAudioDevices: async () => [],
  diagnoseAudio: async () => ({ dshow: [], wasapi: [], wasapiAvailable: false }),
  // list_devices → { video_inputs: FfmpegDevice[] }; old renderer wants
  // { name, index }[]. FfmpegDevice already carries both fields.
  listVideoDevices: async () => {
    const inv = await call<{ video_inputs?: { name: string; index: number }[] }>(
      "list_devices",
      undefined,
      {},
    );
    return (inv.video_inputs ?? []).map((d) => ({ name: d.name, index: d.index }));
  },
  // The SETUP-phase camera preview is now client-side getUserMedia (home.ts) —
  // no backend needed — so these are no-ops.
  videoPreviewStart: async () => true,
  videoPreviewStop: async () => true,
  // DURING recording the backend owns the camera and writes a preview JPEG to a
  // file; the renderer polls this (~base64 JPEG, or null when no fresh frame).
  recordingPreviewFrame: async () =>
    call<string | null>("recording_preview_frame", undefined, null),
  // Probe what the selected camera can actually capture, to gate the
  // resolution/fps UI. `token` is the device index (avfoundation) or name.
  // Returns null on failure → caller offers everything.
  getCameraCapabilities: async (token: string) =>
    call("get_camera_capabilities", { deviceToken: token }, null),

  // ── Wake from sleep (wake_* commands) ───────────────────────────────────
  // wake_reschedule returns WakeResult { ok, … }. A FAILED reschedule must report
  // ok:false — the old { ok:true } fallback painted a silent failure as success.
  scheduleOsWakes: async () =>
    call("wake_reschedule", undefined, { ok: false, reason: "error" }),
  scheduleOsWakesAdmin: async () =>
    call("wake_reschedule", undefined, { ok: false, reason: "error" }),
  // SleepConfig (wake_get_sleep_config) carries NO `platform` field — but the
  // schedule-page diagnostic branches on cfg.platform === 'darwin'/'win32' to pick
  // the right warnings, so without it every machine fell through to "unsupported
  // platform" (telling a Mac/Windows user wake won't work when it can). Inject the
  // platform the webview already knows; a real backend field (if ever added) wins.
  getSleepConfig: async () => ({
    platform,
    ...(await call<Record<string, unknown>>("wake_get_sleep_config", undefined, {})),
  }),
  fixMacSleep: async () => call("wake_fix_sleep", undefined, { ok: false }),
  fixWinWakeTimers: async () => call("wake_fix_sleep", undefined, { ok: false }),
  // Fallbacks must match the real WakeCapabilities / WakeStatus shapes — the
  // schedule-page reads caps.knownIssues.length / status.expectedWakes.length, so a
  // wrong-shape fallback ({canWake}/{scheduled}) made the reliability card throw and
  // silently disappear whenever the command errored.
  wakeDetectCapabilities: async () =>
    call("wake_capabilities", undefined, {
      platform: "other",
      canWakeFromSleep: false,
      canWakeFromOff: false,
      needsAdmin: false,
      knownIssues: [],
      recommendations: [],
    }),
  wakeVerifyScheduled: async () =>
    call("wake_verify", undefined, {
      expectedWakes: [],
      observedWakes: [],
      hasMismatch: false,
      onBattery: null,
      standbyEnabled: null,
    }),
  wakeCheckPower: async () => ({}), // TODO Phase 3: no wake_check_power command
  wakeCheckStandby: async () => ({}), // TODO Phase 3: no wake_check_standby command
  wakeTest: async (secondsAhead?: number) =>
    call("wake_test", { secondsAhead: secondsAhead ?? null }, { ok: false }),
  wakeCancelTest: async () => call("wake_cancel_test", undefined, true).then(() => true),
  wakeFailureHistory: async () => call("wake_failure_history", undefined, []),
  wakeClearFailureHistory: async () =>
    call("wake_clear_failure_history", undefined, true).then(() => true),

  // ── Editor ──────────────────────────────────────────────────────────────
  // Local path → asset:// URL for <audio>/<video> playback (WKWebView blocks
  // file://). Sync — convertFileSrc returns a string.
  toAssetUrl: (path: string) => toAssetUrl(path),
  // editor_read_file → { tooLarge, size, bytes }. The old loader expects EITHER
  // a raw byte array (→ Web Audio decode, the client-side waveform path) OR a
  // { tooLarge } marker (→ ffmpeg-extract fallback). Adapt to that.
  editorReadFile: async (fp: string) => {
    const r = await call<{ tooLarge?: boolean; bytes?: number[] | null }>(
      "editor_read_file",
      { mediaPath: fp },
      null as unknown as { tooLarge?: boolean; bytes?: number[] | null },
    );
    if (!r) return null;
    if (r.tooLarge) return { tooLarge: true };
    return new Uint8Array(r.bytes ?? []);
  },
  editorSaveFile: async () => ({ ok: false }),
  editorPickFile: async () => pickPath({ name: "Lyd", extensions: AUDIO_EXT }),
  // Map the old export params to EditorExportRequest (outputFormat→format,
  // outputBitrate→bitrate, …; drops mode/processing/metadata). NEEDS LIVE VERIFY.
  editorExportFile: async (params: unknown) => {
    const o = (params ?? {}) as Record<string, unknown>;
    const fmt = (o.outputFormat ?? o.format ?? "mp3") as string;
    const m = (o.metadata ?? {}) as Record<string, unknown>;
    // Topic chapters (+title/speaker/description) ride along so they get
    // embedded as ID3 CHAP/CTOC. Chapters are { time, title } in seconds —
    // exactly EditorChapter; pass through, dropping any malformed entry.
    const chapters = Array.isArray(m.chapters)
      ? (m.chapters as Array<Record<string, unknown>>)
          .filter((c) => c && typeof c.time === "number" && typeof c.title === "string")
          .map((c) => ({ time: c.time as number, title: c.title as string }))
      : [];
    return editorCall(
      "editor_export",
      {
        request: {
          inputPath: o.inputPath,
          cutRegions: o.cutRegions ?? [],
          duration: o.duration ?? 0,
          container: fmt,
          format: fmt,
          outputFolder: o.outputFolder ?? "",
          bitrate: o.outputBitrate ?? null,
          bitDepth: o.outputBitDepth ?? null,
          masterPreset: o.masterPreset ?? null,
          introPath: o.introPath ?? null,
          outroPath: o.outroPath ?? null,
          gainDb: o.gainDb ?? null,
          chapters,
          title: (m.title as string) || null,
          speaker: (m.speaker as string) || null,
          description: (m.description as string) || null,
          vocalChainPreset: (o.vocalChainPreset as string) || null,
          processing: (o.processing as Record<string, unknown>) ?? null,
          channelRepair: (o.channelRepair as Record<string, unknown>) ?? null,
        },
      },
    );
  },
  // Analyse stereo channel balance → { code, imbalanceDb, peakLeftDb,
  // peakRightDb, recommended }. Throws-free: empty diagnosis on failure.
  editorDiagnoseChannels: async (fp: string) =>
    call("editor_diagnose_channels", { inputPath: fp }, null),
  // One-click "best result": diagnose + recommended preset bundle.
  editorAutoProcess: async (fp: string) =>
    call("editor_auto_process", { inputPath: fp }, null),
  editorCancelExport: async () => true,
  editorPickOutputFolder: async () => pickPath({ directory: true }),
  // Sidecars (meta / cutsDraft / transcript) are clean JSON key-value via
  // editor_read/write/delete_sidecar — no media decode needed.
  editorReadMeta: async (fp: string) =>
    call("editor_read_sidecar", { mediaPath: fp, sidecar: "meta" }, null),
  editorSaveMeta: async (fp: string, meta: unknown) =>
    call("editor_write_sidecar", { mediaPath: fp, sidecar: "meta", value: meta }, false).then(
      () => true,
    ),
  editorReadCutsDraft: async (fp: string) =>
    call("editor_read_sidecar", { mediaPath: fp, sidecar: "cutsDraft" }, null),
  // The old main wrapped the cut array as { cuts, ts }; preserve that so the
  // loader's `draft.cuts` / age check still work.
  editorSaveCutsDraft: async (fp: string, cuts: unknown) =>
    call(
      "editor_write_sidecar",
      { mediaPath: fp, sidecar: "cutsDraft", value: { cuts, ts: Date.now() } },
      false,
    ).then(() => true),
  editorDeleteCutsDraft: async (fp: string) =>
    call("editor_delete_sidecar", { mediaPath: fp, sidecar: "cutsDraft" }, false).then(
      () => true,
    ),
  // editor_segments → EditorSegment[]. The consumer (editor/detection.ts) casts
  // the result directly to Suggestion[] and assigns E.suggestions, so return the
  // ARRAY, not a { segments } wrapper (which would make E.suggestions an object).
  editorDetectSegments: async (fp: string) =>
    call("editor_segments", { inputPath: fp }, []),
  // Topic chapters from the transcript (Bible refs + enumeration points). Pure
  // offline detection in Rust; returns [{ time, title }] on the original
  // recording timeline. Empty array on any failure (no transcript = no chapters).
  editorDetectChapters: async (lines: unknown, lang?: string) =>
    call("editor_detect_chapters", { lines: lines ?? [], lang: lang ?? null }, []),
  editorSetVideoPath: async (fp: string) =>
    call("editor_load_recording", { inputPath: fp }, { ok: false }),
  // editor_peaks → { peaks, sampleRate }; old too-large path wants { data,
  // duration }. The normal path uses editorReadFile (Web Audio) instead, so this
  // fallback is best-effort for very large files only.
  editorExtractAudioPeaks: async (fp: string) =>
    call("editor_peaks", { inputPath: fp }, null),
  editorPickVideoFile: async () =>
    pickPath({ name: "Video", extensions: VIDEO_EXT }),
  editorSaveVideo: async () => ({ ok: false }),
  // Video export → editor_export with a video container (mp4/mov/mkv) + codec
  // (h264/h265). Maps the renderer params to EditorExportRequest just like
  // editorExportFile (the old raw-passthrough shape didn't match the request).
  editorExportVideo: async (params: unknown) => {
    const o = (params ?? {}) as Record<string, unknown>;
    const m = (o.metadata ?? {}) as Record<string, unknown>;
    const fmt = (o.videoFormat as string) || "mp4";
    const chapters = Array.isArray(m.chapters)
      ? (m.chapters as Array<Record<string, unknown>>)
          .filter((c) => c && typeof c.time === "number" && typeof c.title === "string")
          .map((c) => ({ time: c.time as number, title: c.title as string }))
      : [];
    return editorCall("editor_export", {
      request: {
        inputPath: o.inputPath,
        cutRegions: o.cutRegions ?? [],
        duration: o.duration ?? 0,
        format: fmt,
        outputFolder: o.outputFolder ?? "",
        bitrate: null,
        bitDepth: null,
        masterPreset: (o.masterPreset as string) || null,
        introPath: o.introPath ?? null,
        outroPath: o.outroPath ?? null,
        gainDb: null,
        chapters,
        title: (m.title as string) || null,
        speaker: (m.speaker as string) || null,
        description: (m.description as string) || null,
        vocalChainPreset: (o.vocalChainPreset as string) || null,
        processing: (o.processing as Record<string, unknown>) ?? null,
        channelRepair: (o.channelRepair as Record<string, unknown>) ?? null,
        videoCodec: (o.videoCodec as string) || null,
      },
    });
  },
  // editor_probe_streams → EditorStreamInfo { hasVideo, hasAudio } | (on failure)
  // null. The old { streams: [] } fallback was the wrong shape: the consumer does
  // `!streams || streams.hasVideo`, so a truthy {streams:[]} made it read
  // .hasVideo (undefined) instead of taking the null branch. Return null.
  editorProbeStreams: async (fp: string) =>
    call("editor_probe_streams", { inputPath: fp }, null),
  editorReadTranscript: async (fp: string) =>
    call("editor_read_sidecar", { mediaPath: fp, sidecar: "transcript" }, null),
  editorWriteTranscript: async (fp: string, t: unknown) =>
    call(
      "editor_write_sidecar",
      { mediaPath: fp, sidecar: "transcript", value: t },
      false,
    ).then(() => true),
  editorDeleteTranscript: async (fp: string) =>
    call("editor_delete_sidecar", { mediaPath: fp, sidecar: "transcript" }, false).then(
      () => true,
    ),

  // ── Mastering (editor_master_* / editor_mastering_analyze) ──────────────
  // The 4 built-in mastering presets from the core (id/label/description +
  // targets/filters). Without this the preset dropdown was empty → the whole
  // mastering panel was unusable.
  masterPresets: async () => call("editor_master_presets", undefined, []),
  // editor_master_preview/apply take a single `request` struct; cancel takes jobId.
  // Mastering commands return bare structs; the consumer expects { ok, … }.
  masterPreview: async (
    inputPath: string,
    presetId: string,
    startSec: number,
    durationSec: number,
  ) =>
    editorCall("editor_master_preview", {
      request: { inputPath, presetId, startSec, durationSec },
    }),
  // The consumer reads `measureRes.ok` + `measureRes.measurement.inputI`, but the
  // Rust returns a FLAT EditorLoudness — wrap it under `measurement`.
  masterMeasure: async (inputPath: string, presetId: string) => {
    const r = await call<Record<string, unknown> | { ok: false }>(
      "editor_mastering_analyze",
      { inputPath, presetId },
      { ok: false },
    );
    if (r && typeof r === "object" && (r as { ok?: unknown }).ok === false) {
      return { ok: false };
    }
    return { ok: true, measurement: r };
  },
  masterApply: async (params: unknown) =>
    editorCall("editor_master_apply", { request: params }),
  masterCancel: async (jobId: string) =>
    call("editor_master_cancel", { jobId }, true).then(() => true),

  // ── Thumbnail ───────────────────────────────────────────────────────────
  thumbnailSetDefault: async () => ({ ok: false }),
  thumbnailClearDefault: async () => true,
  thumbnailSetEpisode: async () => ({ ok: false }),
  thumbnailClearEpisode: async () => true,
  thumbnailResolve: async () => null,
  thumbnailGetDefaultInfo: async () => null,

  // ── Cloud ───────────────────────────────────────────────────────────────
  cloudConnect: async () => okFalse,
  cloudCancelConnect: async () => true,
  cloudDisconnect: async () => true,
  cloudStatus: async () => cloudStatusStub,
  cloudUploadFile: async () => ({ ok: false }),
  cloudListFolders: async () => [],
  cloudSetFolder: async () => true,
  cloudIsConfigured: async () => false,
  cloudQueueStatus: async () => ({ entries: [] }),
  cloudQueueRetry: async () => true,
  cloudQueueRemove: async () => true,
  cloudQueueFlush: async () => true,
  podcastRegenerate: async () => ({ ok: false }),
  registerTrustedPath: async () => true,

  // ── Gmail / YouTube ─────────────────────────────────────────────────────
  gmailConnect: async () => okFalse,
  gmailDisconnect: async () => true,
  gmailStatus: async () => ({ connected: false }),
  youtubeConnect: async () => okFalse,
  youtubeDisconnect: async () => true,
  youtubeStatus: async () => ({ connected: false }),
  youtubeUpload: async () => ({ ok: false }),

  // ── Streaming / overlays ────────────────────────────────────────────────
  // streamStatus shape (idle) matches old fields; live telemetry arrives via the
  // streaming://stats event. The action commands are wired:
  streamStatus: async () => call("stream_status", undefined, streamStatusStub),
  streamStart: async (params: unknown) =>
    call("stream_start", params as Record<string, unknown>, { ok: false }),
  streamStop: async () => call("stream_stop", undefined, true).then(() => true),
  streamPreviewPath: async () => "", // TODO Phase 3: no stream_preview_path command
  streamSetKey: async (destId: string, key: string) =>
    call("stream_set_key", { destId, key }, true).then(() => true),
  streamDeleteKey: async (destId: string) =>
    call("stream_delete_key", { destId }, true).then(() => true),
  overlayListScreens: async () => [],
  overlayListNdiSources: async () => ({ available: false, sources: [] }),
  overlayPickImage: async () =>
    pickPath({ name: "Bilde", extensions: IMAGE_EXT }),

  // ── Transcripts / whisper ───────────────────────────────────────────────
  transcriptListAll: async () => [],
  transcriptResolveSource: async () => null,
  // whisper_list_models gives the catalogue; the build ships the whisper feature
  // so the binary is available. (Per-model installed flags come from the list.)
  whisperStatus: async () => ({
    models: await call("whisper_list_models", undefined, []),
    installed: [],
    active: null,
    binaryAvailable: true,
    available: true,
  }),
  // whisper_* commands take `id`, not `model_id`.
  whisperDownloadModel: async (modelId: string) =>
    call("whisper_download_model", { id: modelId }, { ok: false }),
  whisperCancelDownload: async (modelId: string) =>
    call("whisper_cancel_download", { id: modelId }, true).then(() => true),
  whisperDeleteModel: async (modelId: string) =>
    call("whisper_delete_model", { id: modelId }, true).then(() => true),
  // old { filePath, modelId, language, translate, jobId } → whisper_transcribe
  // (input_path, model_id, language, translate, subtitle_style). NEEDS LIVE VERIFY.
  whisperTranscribe: async (params: unknown) => {
    const o = (params ?? {}) as Record<string, unknown>;
    return call(
      "whisper_transcribe",
      {
        inputPath: o.filePath,
        modelId: o.modelId,
        language: o.language ?? null,
        translate: o.translate ?? null,
        subtitleStyle: null,
      },
      { ok: false },
    );
  },
  whisperCancelTranscribe: async () => true, // TODO Phase 3: no cancel command

  // ── Review queue ────────────────────────────────────────────────────────
  reviewQueueList: async () => [],
  reviewQueueGet: async () => null,
  reviewQueuePublish: async () => ({ ok: false }),
  reviewQueueDiscard: async () => ({ ok: false }),
  reviewQueueUpdateTrim: async () => true,
  reviewQueueUpdateMasterPreset: async () => true,
  reviewQueueUpdateJingles: async () => true,

  // ── Integrations (Sunday-suite) ─────────────────────────────────────────
  getIntegrationSettings: async () => ({ enabled: false }),
  setIntegrationSettings: async () => ({ enabled: false }),
  getServiceLink: async () => null,
  verbatimSend: async () => ({ ok: false }),
  verbatimImport: async () => ({ ok: false }),
  stageImport: async () => ({ ok: false }),
  songSetApiKey: async () => true,
  songHasApiKey: async () => false,
  songSubmitUsage: async () => ({ ok: false }),
  planFetchServices: async () => [],
  planUpdateService: async () => ({ ok: false }),

  // ── Fire-and-forget (Electron ipcRenderer.send) ─────────────────────────
  notifyError: noop,
  notifyWeakSignal: noop,

  // ── Event subscriptions ─────────────────────────────────────────────────
  // Map the old Electron channel to its Tauri event and forward the payload.
  // Unknown channels (no Rust emitter yet) return a harmless no-op unsubscribe.
  on: (channel: string, fn: (...args: unknown[]) => void) => {
    const evt = EVENT_MAP[channel];
    if (!evt) return off;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    const adapt = EVENT_ADAPTERS[channel];
    void listen(evt, (e) => fn(adapt ? adapt(e.payload) : e.payload)).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  },
};

(window as any).api = api;

// Seed the backend (sqlite) recording settings from localStorage ON BOOT, so a
// fresh launch where the user records without re-saving still uses their saved
// resolution/format/camera choices (not backend defaults). Best-effort.
void syncBackendRecordingSettings(loadSettings());

// Mark this file as a module (loaded via <script type="module">) so its
// top-level helpers (loadSettings, api, …) stay module-scoped and don't collide
// with the renderer's global declarations. Phase 3 adds real imports here.
export {};

// Verification navigation (only with `?goto=<page>`): poll until main.ts has
// installed window.showPage, then navigate. Inert without the query param.
if (VERIFY_GOTO) {
  const tryGoto = (): void => {
    const w = window as any;
    if (typeof w.showPage === "function") {
      w.showPage(VERIFY_GOTO);
    } else {
      setTimeout(tryGoto, 50);
    }
  };
  setTimeout(tryGoto, 150);
}
