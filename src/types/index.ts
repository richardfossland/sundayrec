export type ChannelMode = 'stereo' | 'monoL' | 'monoR' | 'monoMix'
export type FileFormat  = 'mp3' | 'wav' | 'flac' | 'aac'
export type FilenamePattern = 'date' | 'church' | 'plain' | 'datetime'

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
}

export interface ActiveRecovery {
  outputPath?: string   // v4.1+: path to the in-progress output file
  tempPath?:   string   // legacy: pre-v4.1 temp WebM path (kept for backward compat)
  startTime:   number
  sessionId:   string
}

export interface Settings {
  // System
  language: string | null
  hasLaunched?: boolean

  // Audio device
  deviceId: string | null
  deviceName: string | null
  deviceChannels: Record<string, DeviceChannels>

  // Audio processing
  channels: ChannelMode
  sampleRate: number
  inputVolume: number
  eqBass: number
  eqMid: number
  eqTreble: number
  compEnabled: boolean
  compThreshold: number
  compRatio: number
  compAttack: number
  compRelease: number
  limiterEnabled: boolean
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
  splitMinutes: number     // 0 = off; split every N minutes from recording start
  trimSilence?: boolean    // run ffmpeg silenceremove on output
  reminderMinutes: number  // 0 = off; system notification N min before scheduled recording
  manualMaxMinutes: number // 0 = off; auto-stop manual recordings after N minutes

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

  // Editor
  askOpenEditor?: boolean

  // Updates
  autoUpdate: boolean

  // Church profile
  churchName: string
  responsiblePerson: string

  // Crash recovery (internal)
  activeRecovery?: ActiveRecovery | null

  // History (internal — never exported)
  recordingHistory?: RecordingEntry[]
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
