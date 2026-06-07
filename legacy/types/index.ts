export type ChannelMode = 'stereo' | 'monoL' | 'monoR' | 'monoMix'
export type FileFormat  = 'mp3' | 'wav' | 'flac' | 'aac'
export type FilenamePattern = 'date' | 'church' | 'plain' | 'datetime'

export type RecordingPhase =
  | 'idle'          // no active session
  | 'starting'      // startSession() called, ffmpeg being spawned
  | 'recording'     // ffmpeg active, audio/video flowing
  | 'reconnecting'  // device disconnect detected, trying to reconnect
  | 'stopping'      // stopSession() called, waiting for ffmpeg to exit
  | 'finalizing'    // ffmpeg exited, writing history entry

export interface DeviceChannels {
  channelL: number
  channelR: number
}

export interface ScheduleSlot {
  days: number[]       // 0=Mon … 6=Sun
  start: string        // HH:MM
  stop: string         // HH:MM
  max?: number         // max minutes
}

export interface SpecialRecording {
  id?: string
  date: string         // YYYY-MM-DD
  name: string
  start: string        // HH:MM
  stop: string         // HH:MM
  deviceId?: string
}

export interface CutRegion {
  start: number  // seconds
  end: number    // seconds
}

export interface RecordingEntry {
  date: string
  startTime: string
  duration: string
  filename: string
  path?: string
  status: 'ok' | 'error' | 'scheduled'
  error?: string
  note?: string
  timestamp?: number
  fileSizeBytes?: number    // actual file size on disk after recording
  durationSec?: number      // recording duration in seconds
  cloudUploaded?: string[]  // cloud service IDs where this file was uploaded: ['google-drive', 'dropbox', 'onedrive']
  cloudUrls?: Record<string, string>  // service ID → public/share URL (used by podcast RSS feed)
}

export interface PodcastSettings {
  enabled:     boolean
  service:     'google-drive' | 'dropbox' | 'onedrive'  // which cloud service hosts the audio + feed
  title:       string
  description: string
  author:      string
  language:    string   // ISO 639-1, default 'no'
  category:    string   // iTunes category, default 'Religion & Spirituality'
  explicit:    boolean
  link?:       string   // church homepage
  imageUrl?:   string   // cover art (1400-3000px square)
  email?:      string   // owner contact email (required by Apple)
  /** Set after the first successful publish — the URL the user submits to Spotify/Apple */
  feedUrl?:    string

  // ── Prep-and-review pipeline (v5.0) ──────────────────────────────────────
  /** When podcast.enabled is true, automatically run prep + queue the episode
   *  for human review after each successful recording. Default true. */
  autoPrepEnabled?:     boolean
  /** Per-church default intro jingle (applies to every prepped episode unless
   *  the user overrides per-episode). Defaults to settings.editorIntroPath. */
  defaultIntroPath?:    string
  /** Per-church default outro jingle (applies to every prepped episode unless
   *  the user overrides per-episode). Defaults to settings.editorOutroPath. */
  defaultOutroPath?:    string
  /** Master preset used by the prep pipeline. Default 'speech-clear'. */
  defaultMasterPreset?: string
}

/**
 * Audio analysis segment (mirror of AnalysisSegment in main/audio-analysis.ts)
 * stored on EpisodePrep for renderer-side display without re-running analysis.
 */
export interface PrepAnalysisSegment {
  startSec:    number
  endSec:      number
  durationSec: number
  type:        'silence' | 'speech' | 'music' | 'mixed' | 'unknown'
  confidence:  number
  avgRmsDb:    number
  label:       string
}

/**
 * Status of an EpisodePrep through its lifecycle.
 *
 *   analyzing       — background analysis running
 *   ready           — prep complete, all defaults applied, no concerns
 *   needs-attention — prep complete, but the suggested sermon segment is
 *                     low-confidence or absent. Human review required.
 *   published       — user clicked "Godkjenn og publiser" and the upload
 *                     pipeline ran to completion.
 *   discarded       — user clicked "Ikke publiser denne uka".
 */
export type EpisodePrepStatus = 'analyzing' | 'ready' | 'needs-attention' | 'published' | 'discarded'

export interface EpisodePrep {
  id:                string                       // uuid
  recordingPath:     string                       // source file
  timestamp:         number                       // when recording finished
  status:            EpisodePrepStatus
  analysisSegments?: PrepAnalysisSegment[]        // raw segments from audio-analysis.ts
  /** Sermon-only range derived from segments — the area between startSec and
   *  endSec is "keep", everything else is intended to be cut. */
  suggestedTrim?:    { startSec: number; endSec: number }
  /** 0..1 — how confident we are that suggestedTrim covers the sermon. */
  sermonConfidence?: number
  masterPreset:      string                       // default 'speech-clear'
  introPath?:        string                       // null = no intro for this episode
  outroPath?:        string                       // null = no outro for this episode
  /** Norwegian — why this needs human review beyond normal QC. */
  attentionReasons?: string[]
  /** Reserved for Phase 2 YouTube auto-publish. Currently unused. */
  publishYoutube?:   boolean
  createdAt:         number
  updatedAt:         number
  /** Set after a successful publish — guards against double-publishing
   *  if the user clicks the button twice. */
  publishedAt?:      number
  /** History timestamp of the source recording entry (used to mark the
   *  recording as published when this prep is published). */
  recordingTimestamp?: number
}

/**
 * A single entry in the human-review queue. Wraps EpisodePrep with bookkeeping
 * (reminder count, age). Stored in electron-store under key `reviewQueue`.
 */
export interface ReviewQueueEntry {
  id:        string
  prep:      EpisodePrep
  addedAt:   number
  /** Reminders sent so far: 0 = none, 1 = 24h sent, 2 = 48h sent, 3 = 7d sent.
   *  At 4, the entry has been auto-discarded (14d) — but at that point the
   *  entry is removed from the queue rather than kept around. */
  reminded:  number
  /** Days since addedAt — computed on read from getQueue(), not persisted. */
  ageInDays: number
}

export interface ActiveRecovery {
  outputPath?:      string    // v4.1+: current audio file being written
  tempPath?:        string    // legacy: pre-v4.1 temp WebM path (kept for backward compat)
  videoOutputPath?: string    // current video file being written (if any)
  segments:         string[]  // all completed audio segment paths (for split recordings)
  startTime:        number
  sessionId:        string
  phase:            RecordingPhase
  updatedAt:        number    // unix ms — for detecting stale recovery
}

export interface Settings {
  // System
  language: string | null
  hasLaunched?: boolean
  onboardingDone?: boolean

  // Audio device
  deviceId: string | null
  deviceName: string | null
  deviceChannels: Record<string, DeviceChannels>

  // Audio processing
  channels: ChannelMode
  /** Sample rate in Hz. Valid: 8000–192000. Default: 48000. Derived from
   *  {@link sampleRateMode} for client-side use (VU monitor + disk estimate). */
  sampleRate: number
  /** Capture sample-rate policy the recorder honours. `auto` (default) records at
   *  the device's native rate (no `-ar`, no resampling → no choppiness on a 44.1
   *  kHz mixer); the explicit modes force that rate. Maps 1:1 to the Rust
   *  `SampleRate` enum. */
  sampleRateMode?: 'auto' | 'r44100' | 'r48000'
  /** Windows ONLY escape hatch: force the legacy ffmpeg DirectShow audio capture
   *  instead of the modern cpal (WASAPI/ASIO) path. Default false. No effect on Mac. */
  classicDirectshow?: boolean
  /** Input gain as percentage. Valid: 0–200. Default: 100 */
  inputVolume: number
  /** Bass EQ gain in dB. Valid: -24–+24. Default: 0 */
  eqBass: number
  /** Mid EQ gain in dB. Valid: -24–+24. Default: 0 */
  eqMid: number
  /** Treble EQ gain in dB. Valid: -24–+24. Default: 0 */
  eqTreble: number
  compEnabled: boolean
  /** Compressor threshold in dBFS. Valid: -60–0 */
  compThreshold: number
  /** Compressor ratio. Valid: 1–100 */
  compRatio: number
  /** Compressor attack in ms. Valid: 0.1–2000 */
  compAttack: number
  /** Compressor release in ms. Valid: 1–9000 */
  compRelease: number
  limiterEnabled: boolean
  /** Limiter ceiling in dBFS. Valid: -10–0. Default: -1 */
  limiterCeiling: number

  // Output format
  format: FileFormat
  bitrate: string
  filenamePattern: FilenamePattern
  saveFolder: string | null
  autoDeleteDays: number

  // Schedule
  slots: ScheduleSlot[]
  specialRecordings: SpecialRecording[]
  stopOnSilence: boolean
  silenceThreshold?: number        // dBFS threshold, default -50
  silenceTimeoutMinutes?: number   // minutes of silence before stop, default 5
  /** Auto-split interval in minutes. Valid: 0–480. 0 = disabled */
  splitMinutes: number     // 0 = off; split every N minutes from recording start
  trimSilence?: boolean    // run ffmpeg silenceremove on output
  /** Reminder notification before scheduled recording, in minutes. Valid: 0–60. 0 = disabled */
  reminderMinutes: number  // 0 = off; system notification N min before scheduled recording
  /** Auto-stop manual recordings after N minutes. Valid: 0–1440 (24h). 0 = disabled */
  manualMaxMinutes: number // 0 = off; auto-stop manual recordings after N minutes
  preRollSeconds: number   // 0 = off; 15 or 30 — capture N seconds before manual record press

  // System behaviour
  launchAtLogin: boolean
  showOnStartup: boolean
  minimizeToTray: boolean
  wakeFromSleep: boolean
  protectRecording: boolean

  // Notifications
  notifyStart: boolean
  notifyStop: boolean
  emailOnError: boolean
  emailAddress: string
  emailSmtp: string
  emailSmtpPort: number
  emailSmtpUser: string
  emailSmtpPass: string       // runtime only — always '' in store; real value in emailSmtpPassEnc
  emailSmtpPassSet?: boolean  // populated by main before sending to renderer
  emailSmtpPassEnc?: string   // internal: base64-encoded safeStorage ciphertext
  /** Slack/Discord/generic webhook URL — POSTed on error-severity backend warnings */
  webhookUrl?: string
  /** Also send the webhook on warnings (in addition to errors). Default false. */
  webhookOnWarn?: boolean

  // Video recording
  videoEnabled?: boolean
  videoDeviceName?: string | null
  videoDeviceIndex?: number | null
  videoResolution?: '2160p' | '1080p' | '720p' | '480p'
  /** Video bitrate in kbps. Valid: 500–50000. 0 = auto based on resolution */
  videoBitrate?: number        // kbps (0 = auto based on resolution)
  /** Video framerate in fps. Valid: 1–120. Default: 30 */
  videoFramerate?: number      // fps, default 30
  /** Recording video container: 'mp4' (default) | 'mov'. */
  videoContainer?: 'mp4' | 'mov'
  /** Recording video codec: 'h264' (default) | 'h265' (HEVC). */
  videoCodec?: 'h264' | 'h265'
  /** Recording encoder backend: 'software' (default) | 'hardware' (VideoToolbox). */
  videoEncoder?: 'software' | 'hardware'
  videoSeparate?: boolean      // true = keep audio + video as separate files; false = mux into combined MP4
  videoKeepAudio?: boolean     // when combined MP4: also keep the separate high-quality audio file (default true)
  videoFlip?: boolean          // mirror the camera horizontally (e.g. front-facing cameras)

  /**
   * Experimental: route audio + video through a single ffmpeg process
   * instead of two parallel processes + post-mux. Eliminates A/V drift at
   * the source by sharing the same clock. Default OFF until we have
   * production-hours-on-it confidence. Toggle via Settings → Video.
   */
  useUnifiedRecorder?: boolean

  // Editor
  askOpenEditor?: boolean
  editorIntroPath?: string
  editorOutroPath?: string

  // Episode thumbnail (cover art) — default applies to every published
  // episode unless overridden by a per-recording sidecar (<name>.thumb.{ext}).
  // Absolute path under app.getPath('userData')/thumbnails/default.{jpg|png|webp}.
  // The image is copied here on pick so the source can be moved/deleted later.
  defaultThumbnailPath?: string | null

  // Cloud backup
  cloudGoogleDrive?: CloudServiceSettings
  cloudDropbox?: CloudServiceSettings
  cloudOneDrive?: CloudServiceSettings

  // Podcast publishing (RSS feed auto-generated from uploaded recordings)
  podcast?: PodcastSettings

  // Prep-and-review queue (v5.0) — persisted via electron-store
  reviewQueue?: ReviewQueueEntry[]

  // Updates
  autoUpdate: boolean

  // Church profile
  churchName: string
  responsiblePerson: string

  // Crash recovery (internal)
  activeRecovery?: ActiveRecovery | null

  // Next expected scheduled recording — used to detect missed recordings on next launch
  nextExpectedRecordingISO?: string | null

  // History (internal — never exported)
  recordingHistory?: RecordingEntry[]

  // Wake reliability — capped log of recent missed wakes and test-wake outcomes (max 20)
  wakeFailureHistory?: WakeFailureEntry[]

  // Live streaming destinations. Stream keys are stored ENCRYPTED via
  // electron-store's safeStorage in the store layer — never persist them
  // in plain settings JSON.
  streamDestinations?: StreamDestinationStored[]
  /** Default stream quality preset. */
  streamResolution?: '480p' | '720p' | '1080p'
  /** Default stream framerate. */
  streamFramerate?: 25 | 30
  /** Optional override of video bitrate in kbps. Empty/null = auto from resolution. */
  streamVideoBitrate?: number | null

  // Live overlays — composited on top of camera during streaming.
  streamOverlays?: OverlayConfig[]

  // Sunday-suite integrations. Entirely opt-in; absent/disabled means
  // SundayRec behaves exactly as a standalone app (no integration code runs).
  integrations?: IntegrationSettings
}

/**
 * Overlay placement preset. 9-grid + fullscreen + free positioning.
 * Coordinates resolve to ffmpeg overlay X:Y expressions based on output WxH.
 */
export type OverlayPosition =
  | 'tl' | 'tc' | 'tr'
  | 'cl' | 'c'  | 'cr'
  | 'bl' | 'bc' | 'br'
  | 'fullscreen'
  | 'custom'

/**
 * What kind of source feeds this overlay:
 *  - image:  static PNG/JPG on disk (logo, lower-third graphic)
 *  - screen: whole monitor capture (avfoundation/gdigrab)
 *  - window: monitor capture with crop region (used to approximate a single
 *            EasyWorship/ProPresenter window when running on the same machine)
 *  - ndi:    NDI network source — implementation lands in a follow-up release;
 *            field is reserved so settings persist across the upgrade.
 */
export type OverlaySourceType = 'image' | 'screen' | 'window' | 'ndi'

export interface OverlayChromaKey {
  /** Hex color e.g. "#00FF00" — typically the solid background EW outputs. */
  color:      string
  /** 0..1 — how close a pixel must be to `color` to be keyed (default 0.10). */
  similarity: number
  /** 0..1 — soft edge blend (default 0.10). */
  blend:      number
}

export interface OverlayCrop {
  /** All values are fractions of the SOURCE input dimensions (0..1). */
  x: number; y: number; w: number; h: number
}

export interface OverlayConfig {
  /** Stable id used to key UI controls and persisted settings. */
  id:      string
  /** User-facing label (e.g. "Logo", "Lyrics fra EasyWorship"). */
  name:    string
  /** Master on/off — when false the overlay is skipped in the filter graph. */
  enabled: boolean

  type: OverlaySourceType
  /** For type=image: absolute path. For type=screen/window: capture id
   *  ('1', 'screen:0:0' on Mac, 'desktop' or display index on Win). For
   *  type=ndi: NDI source name as discovered on the network. */
  source: string

  /** Placement preset. */
  position: OverlayPosition
  /** Only used when position='custom' — fraction of output WxH (0..1). */
  customX?: number
  customY?: number

  /** Overlay width as fraction of output width (0..1). Height auto-scales
   *  preserving aspect. For fullscreen this is forced to 1.0. */
  scale: number
  /** 0..1 — final opacity after chroma key. */
  opacity: number

  /** Chroma key (set null/undefined to disable). */
  chromaKey?: OverlayChromaKey | null

  /** Crop input before scaling. Mostly useful for type=window to grab a
   *  region of a monitor. Values are 0..1 of the source dimensions. */
  crop?: OverlayCrop | null
}

/** Destination record as stored in settings. Stream key is encrypted at rest;
 *  fetched via getStreamKey() in main, never returned to renderer directly. */
export interface StreamDestinationStored {
  id:        string
  name:      string
  rtmpUrl:   string
  enabled:   boolean
  /** Set true once user has saved a key. Renderer uses this to render
   *  "•••••• (saved)" vs the input field. The key itself lives in
   *  encrypted store and is read main-side only when starting a stream. */
  hasKey:    boolean
}

export interface RecordingOpts extends Partial<Settings> {
  deviceId?: string | null
  customName?: string
  overrideName?: string | null
  splitTimestamp?: string
  maxMinutes?: number
  scheduledStopTime?: string
  channelL?: number
  channelR?: number
  /** Internal: prevents infinite sample-rate retry loop */
  _sampleRateRetried?: boolean
}

export interface DiskInfo {
  freeBytes: number | null
}

export interface WakeResult {
  ok: boolean
  count?: number
  nextWake?: string | null   // ISO string of next scheduled wake point
  reason?: 'disabled' | 'cancelled' | 'permission' | 'unsupported' | 'error'
  message?: string
}

/**
 * Stored log of wake-attempt outcomes — produced by checkMissedRecordings (failure)
 * and by testWake (success/failure). Used by the UI to show recent wake history.
 * Capped at 20 entries (oldest dropped).
 */
export interface WakeFailureEntry {
  /** unix ms — when the missed-wake or test-wake outcome was recorded */
  timestamp:   number
  /** ISO string — what time the wake was supposed to fire */
  scheduledAt: string
  /** 'missed' = scheduled recording never ran. 'test_ok' / 'test_fail' = manual test result. */
  kind:        'missed' | 'test_ok' | 'test_fail'
  /** Human-readable label (slot name, "Spesialopptak", "Test-wake") */
  label:       string
  /** Free-form reason (e.g. 'no_resume', 'too_late', 'on_battery', or empty) */
  reason?:     string
  /** Actual delta in seconds between expected and observed (test-wake only) */
  deltaSec?:   number
}

export interface UpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface UpdateInfo {
  version: string
  releaseNotes?: string
}

export interface ChapterMarker {
  time: number   // seconds from start of main content
  title: string
}

export interface RecordingMetadata {
  title: string
  speaker: string
  description: string
  chapters: ChapterMarker[]
}

/** A single transcript segment from whisper.cpp output. `start`/`end` are
 *  seconds into the recording. */
export interface TranscriptSegment {
  start: number
  end:   number
  text:  string
}

/** Sidecar file written alongside the recording at <name>.transcript.json.
 *  Schema-versioned so we can evolve format without breaking older files. */
export interface TranscriptData {
  /** Schema version. Bump when format changes incompatibly. */
  version:   1
  /** Whisper model id used (e.g. "ggml-base", "ggml-medium"). */
  model:     string
  /** BCP-47-ish language code Whisper detected/was told (e.g. "no", "en", "auto"). */
  language:  string
  /** Total media duration in seconds — for sanity-checking and percentage display. */
  duration:  number
  /** Epoch-ms when this transcript was generated. */
  createdAt: number
  /** True if user asked Whisper to translate output to English. */
  translated?: boolean
  segments:  TranscriptSegment[]
}

export type CloudServiceId = 'google-drive' | 'dropbox' | 'onedrive'

export interface CloudServiceSettings {
  enabled: boolean
  autoUpload: boolean
  folderId?: string
  folderName?: string
  folderPath?: string
}

export interface CloudStatus {
  connected: boolean
  accountName?: string
  accountEmail?: string
  folderId?: string
  folderName?: string
  folderPath?: string
  lastUpload?: number
  lastUploadOk?: boolean
  /** True when the saved refresh token has been revoked — user must reconnect. */
  needsReauth?: boolean
}

export interface CloudUploadQueueEntry {
  id:             string         // unique entry id (uuid-ish)
  service:        CloudServiceId
  filePath:       string
  entryTimestamp?: number        // history-entry timestamp to mark as uploaded on success
  attempts:       number         // total attempts so far
  nextAttempt:    number         // unix ms — earliest time the worker may retry
  lastError?:     string         // last error message (for UI)
  enqueuedAt:     number
  status:         'pending' | 'uploading' | 'failed' | 'reauth-required'
}

export interface CloudQueueStatus {
  entries: Array<{
    id: string
    service: CloudServiceId
    filename: string
    attempts: number
    nextAttempt: number
    lastError?: string
    status: CloudUploadQueueEntry['status']
  }>
}

// ── Sunday-suite integrations ───────────────────────────────────────────────
// Opt-in connection to the sister apps (Stage, Plan, Song, Verbatim). Every
// flag defaults off; when `enabled` is false nothing in src/main/integrations/
// runs and the renderer hides the whole "Sunday-suite" section. The recording
// core (recorder.ts / scheduler.ts) never reads these.

/** A song that was used in a service, with the cross-suite identifiers we may
 *  know about. At least one of the IDs (or the title) is always present.
 *  `firstShownSec`/`displayedSec` are offsets into the matched recording. */
export interface SongUsage {
  title: string
  tonoWorkId?: string
  ccliSongId?: string
  sundaysongId?: string
  firstShownSec?: number
  displayedSec?: number
}

/** Links one recording to its external service context. Persisted as a
 *  `<recording>.service.json` sidecar next to the audio/video file — mirrors
 *  the `.transcript.json` sidecar convention. */
export interface ServiceLink {
  source: 'stage' | 'plan' | 'manual'
  serviceId?: string
  churchId?: string
  serviceDate?: string        // YYYY-MM-DD
  wasStreamed?: boolean        // SundayRec is the source of truth for this
  setlist: SongUsage[]
  linkedAt: number             // unix ms
}

export interface IntegrationSettings {
  /** Master opt-in for the entire Sunday-suite area. */
  enabled: boolean
  verbatim?: { enabled: boolean }
  stage?: { enabled: boolean; manifestFolder?: string }
  song?: { enabled: boolean; autoSubmitUsage?: boolean }
  plan?: { enabled: boolean; autoSchedule?: boolean }
  /** Shared cloud connection used by the Song/Plan flows. API keys are NOT
   *  stored here — they live encrypted via safeStorage (like stream keys). */
  connection?: {
    churchId?: string
    songApiUrl?: string
    planApiUrl?: string
  }
}
