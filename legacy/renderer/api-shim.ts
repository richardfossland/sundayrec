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

const AUDIO_EXT = ["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus"];
const VIDEO_EXT = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];
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

// Re-exported so the unused `convertFileSrc` import is retained for the file://
// → asset: rewrites that land as pages get wired. (Tree-shaken if truly unused.)
void convertFileSrc;

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
const whisperStatusStub = {
  models: [],
  installed: [],
  active: null,
  // home.ts / editor-transcript.ts read `status.binaryAvailable`.
  binaryAvailable: false,
  available: false,
};

const api: Record<string, unknown> = {
  // ── Settings ────────────────────────────────────────────────────────────
  getSettings: async () => loadSettings(),
  saveSettings: async (s: unknown) => saveSettingsLocal(s),
  exportProfile: async () => loadSettings(),
  importProfile: async () => true,
  resetSettings: async () => {
    localStorage.removeItem(LS_KEY);
    return true;
  },

  // ── Schedule / next recording ───────────────────────────────────────────
  getNextRecording: async () => null,

  // ── History ─────────────────────────────────────────────────────────────
  getHistory: async () => [],
  deleteHistoryEntry: async () => true,
  clearHistory: async () => true,
  pruneHistory: async () => 0,
  updateHistoryNote: async () => true,

  // ── Disk / recording ────────────────────────────────────────────────────
  // get_disk_space returns { freeBytes } (camelCase) — exactly what home.ts reads.
  getDiskSpace: async () =>
    call("get_disk_space", undefined, { freeBytes: null, totalBytes: null }),
  startRecordingNow: async () => ({ ok: false }),
  stopRecordingNow: async () => true,
  runTestRecording: async () => ({ ok: false, level: null, message: "" }),
  runPreflight: async () => ({ ok: true, checks: [] }),

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
  videoPreviewStart: async () => true,
  videoPreviewStop: async () => true,

  // ── Wake from sleep ─────────────────────────────────────────────────────
  scheduleOsWakes: async () => ({ ok: true }),
  scheduleOsWakesAdmin: async () => ({ ok: true }),
  getSleepConfig: async () => ({}),
  fixMacSleep: async () => ({ ok: false }),
  fixWinWakeTimers: async () => ({ ok: false }),
  wakeDetectCapabilities: async () => ({ canWake: false, reasons: [] }),
  wakeVerifyScheduled: async () => ({ ok: false, scheduled: [] }),
  wakeCheckPower: async () => ({}),
  wakeCheckStandby: async () => ({}),
  wakeTest: async () => ({ ok: false }),
  wakeCancelTest: async () => true,
  wakeFailureHistory: async () => [],
  wakeClearFailureHistory: async () => true,

  // ── Editor ──────────────────────────────────────────────────────────────
  editorReadFile: async () => null,
  editorSaveFile: async () => ({ ok: false }),
  editorPickFile: async () => pickPath({ name: "Lyd", extensions: AUDIO_EXT }),
  editorExportFile: async () => ({ ok: false }),
  editorCancelExport: async () => true,
  editorPickOutputFolder: async () => pickPath({ directory: true }),
  editorReadMeta: async () => null,
  editorSaveMeta: async () => true,
  editorReadCutsDraft: async () => null,
  editorSaveCutsDraft: async () => true,
  editorDeleteCutsDraft: async () => true,
  editorDetectSegments: async () => ({ segments: [] }),
  editorSetVideoPath: async () => ({ ok: false }),
  editorExtractAudioPeaks: async () => ({ peaks: [] }),
  editorPickVideoFile: async () =>
    pickPath({ name: "Video", extensions: VIDEO_EXT }),
  editorSaveVideo: async () => ({ ok: false }),
  editorExportVideo: async () => ({ ok: false }),
  editorProbeStreams: async () => ({ streams: [] }),
  editorReadTranscript: async () => null,
  editorWriteTranscript: async () => true,
  editorDeleteTranscript: async () => true,

  // ── Mastering ───────────────────────────────────────────────────────────
  masterPresets: async () => [],
  masterPreview: async () => ({ ok: false }),
  masterMeasure: async () => ({ ok: false }),
  masterApply: async () => ({ ok: false }),
  masterCancel: async () => true,

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
  streamStatus: async () => streamStatusStub,
  streamStart: async () => ({ ok: false }),
  streamStop: async () => true,
  streamPreviewPath: async () => "",
  streamSetKey: async () => true,
  streamDeleteKey: async () => true,
  overlayListScreens: async () => [],
  overlayListNdiSources: async () => ({ available: false, sources: [] }),
  overlayPickImage: async () =>
    pickPath({ name: "Bilde", extensions: IMAGE_EXT }),

  // ── Transcripts / whisper ───────────────────────────────────────────────
  transcriptListAll: async () => [],
  transcriptResolveSource: async () => null,
  whisperStatus: async () => whisperStatusStub,
  whisperDownloadModel: async () => ({ ok: false }),
  whisperCancelDownload: async () => true,
  whisperDeleteModel: async () => true,
  whisperTranscribe: async () => ({ ok: false }),
  whisperCancelTranscribe: async () => true,

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
    void listen(evt, (e) => fn(e.payload)).then((u) => {
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
