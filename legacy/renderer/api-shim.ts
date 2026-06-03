// window.api shim — maps the OLD Electron preload surface onto safe stubs so the
// ported vanilla-TS renderer runs inside Tauri with NO backend wired yet.
//
// Every method resolves to a benign default and NEVER throws, so every screen
// renders exactly like the old app (with empty/placeholder data). Settings are
// persisted to localStorage so the settings UI feels real across reloads. Real
// Tauri `invoke()` wiring per channel is a later phase — see the plan + the
// command map in src-tauri + reference hooks.
//
// Loaded as a module script BEFORE ./main.ts in index.html, so `window.api`
// exists before the renderer boots.

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
  bitrate: 0,
  fps: 0,
  droppedFrames: 0,
  destinations: [],
};
const whisperStatusStub = {
  models: [],
  installed: [],
  active: null,
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
  getDiskSpace: async () => ({ freeBytes: null, totalBytes: null }),
  startRecordingNow: async () => ({ ok: false }),
  stopRecordingNow: async () => true,
  runTestRecording: async () => ({ ok: false, level: null, message: "" }),
  runPreflight: async () => ({ ok: true, checks: [] }),

  // ── File dialogs / shell ────────────────────────────────────────────────
  pickFolder: async () => null,
  openFolder: async () => true,
  revealFile: async () => true,
  pickAudioFile: async () => null,

  // ── Email / webhook ─────────────────────────────────────────────────────
  testWebhook: async () => ({ ok: false }),
  testEmail: async () => ({ ok: false }),
  clearSmtpPassword: async () => true,

  // ── App / updates ───────────────────────────────────────────────────────
  getAppVersion: async () => "0.2.0",
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
  listFfmpegAudioDevices: async () => ({ inputs: [], dshow: [], wasapi: [] }),
  diagnoseAudio: async () => ({ dshow: [], wasapi: [], wasapiAvailable: false }),
  listVideoDevices: async () => [],
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
  editorPickFile: async () => null,
  editorExportFile: async () => ({ ok: false }),
  editorCancelExport: async () => true,
  editorPickOutputFolder: async () => null,
  editorReadMeta: async () => null,
  editorSaveMeta: async () => true,
  editorReadCutsDraft: async () => null,
  editorSaveCutsDraft: async () => true,
  editorDeleteCutsDraft: async () => true,
  editorDetectSegments: async () => ({ segments: [] }),
  editorSetVideoPath: async () => ({ ok: false }),
  editorExtractAudioPeaks: async () => ({ peaks: [] }),
  editorPickVideoFile: async () => null,
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
  overlayPickImage: async () => null,

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
  // No backend events fire yet, so every subscription is a harmless no-op that
  // returns an unsubscribe function. Real Tauri `listen()` mapping is a later
  // phase (recording-* -> recording://*, video-preview-frame -> preview://frame,
  // master-progress -> editor-master-progress, etc.).
  on: (_channel: string, _fn: (...args: unknown[]) => void) => off,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).api = api;

// Verification navigation (only with `?goto=<page>`): poll until main.ts has
// installed window.showPage, then navigate. Inert without the query param.
if (VERIFY_GOTO) {
  const tryGoto = (): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    if (typeof w.showPage === "function") {
      w.showPage(VERIFY_GOTO);
    } else {
      setTimeout(tryGoto, 50);
    }
  };
  setTimeout(tryGoto, 150);
}
