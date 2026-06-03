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
  saveSettings: async (s: unknown) => saveSettingsLocal(s),
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
  updateHistoryNote: async () => true, // TODO Phase 3: no recordings_update_note command yet

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
  videoPreviewStart: async () => true,
  videoPreviewStop: async () => true,

  // ── Wake from sleep (wake_* commands) ───────────────────────────────────
  scheduleOsWakes: async () => call("wake_reschedule", undefined, { ok: true }),
  scheduleOsWakesAdmin: async () => call("wake_reschedule", undefined, { ok: true }),
  getSleepConfig: async () => call("wake_get_sleep_config", undefined, {}),
  fixMacSleep: async () => call("wake_fix_sleep", undefined, { ok: false }),
  fixWinWakeTimers: async () => call("wake_fix_sleep", undefined, { ok: false }),
  wakeDetectCapabilities: async () =>
    call("wake_capabilities", undefined, { canWake: false, reasons: [] }),
  wakeVerifyScheduled: async () =>
    call("wake_verify", undefined, { ok: false, scheduled: [] }),
  wakeCheckPower: async () => ({}), // TODO Phase 3: no wake_check_power command
  wakeCheckStandby: async () => ({}), // TODO Phase 3: no wake_check_standby command
  wakeTest: async (secondsAhead?: number) =>
    call("wake_test", { secondsAhead: secondsAhead ?? null }, { ok: false }),
  wakeCancelTest: async () => call("wake_cancel_test", undefined, true).then(() => true),
  wakeFailureHistory: async () => call("wake_failure_history", undefined, []),
  wakeClearFailureHistory: async () =>
    call("wake_clear_failure_history", undefined, true).then(() => true),

  // ── Editor ──────────────────────────────────────────────────────────────
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
    return call(
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
        },
      },
      { ok: false },
    );
  },
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
  editorDetectSegments: async (fp: string) => ({
    segments: await call("editor_segments", { inputPath: fp }, []),
  }),
  // Topic chapters from the transcript (Bible refs + enumeration points). Pure
  // offline detection in Rust; returns [{ time, title }] on the original
  // recording timeline. Empty array on any failure (no transcript = no chapters).
  editorDetectChapters: async (lines: unknown) =>
    call("editor_detect_chapters", { lines: lines ?? [] }, []),
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
  editorExportVideo: async (params: unknown) =>
    call("editor_export", { request: params }, { ok: false }),
  editorProbeStreams: async (fp: string) =>
    call("editor_probe_streams", { inputPath: fp }, { streams: [] }),
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
  masterPresets: async () => [], // TODO Phase 3: presets are client-side; no command
  // editor_master_preview/apply take a single `request` struct; cancel takes jobId.
  masterPreview: async (
    inputPath: string,
    presetId: string,
    startSec: number,
    durationSec: number,
  ) =>
    call(
      "editor_master_preview",
      { request: { inputPath, presetId, startSec, durationSec } },
      { ok: false },
    ),
  masterMeasure: async (inputPath: string, presetId: string) =>
    call("editor_mastering_analyze", { inputPath, presetId }, { ok: false }),
  masterApply: async (params: unknown) =>
    call("editor_master_apply", { request: params }, { ok: false }),
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
