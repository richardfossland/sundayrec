import Store from 'electron-store'
import { safeStorage } from 'electron'
import fs from 'fs'
import type { Settings, RecordingEntry, WakeFailureEntry } from '../types'

const defaults: Settings = {
  language: null,
  hasLaunched: false,

  deviceId: null,
  deviceName: null,
  deviceChannels: {},

  channels: 'stereo',
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

  format: 'mp3',
  bitrate: '192',
  filenamePattern: 'date',
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
  emailAddress: '',
  emailSmtp: '',
  emailSmtpPort: 587,
  emailSmtpUser: '',
  emailSmtpPass: '',

  autoUpdate: true,
  askOpenEditor: true,
  editorIntroPath: undefined,
  editorOutroPath: undefined,

  cloudGoogleDrive: undefined,
  cloudDropbox: undefined,
  cloudOneDrive: undefined,

  churchName: '',
  responsiblePerson: '',

  activeRecovery: null,
  nextExpectedRecordingISO: null,
  recordingHistory: [],
  wakeFailureHistory: []
}

const store = new Store<Settings>({
  name: 'sundayrec-settings',
  defaults
})

// --- safeStorage helpers for SMTP password ---

export function setSmtpPassword(plaintext: string): void {
  if (!plaintext) {
    store.delete('emailSmtpPassEnc' as keyof Settings)
    store.delete('emailSmtpPass' as keyof Settings)
    return
  }
  if (safeStorage.isEncryptionAvailable()) {
    const enc = safeStorage.encryptString(plaintext).toString('base64')
    store.set('emailSmtpPassEnc' as keyof Settings, enc as never)
    store.delete('emailSmtpPass' as keyof Settings)
  } else {
    // Encryption unavailable (e.g. headless CI) — store plaintext as fallback
    store.set('emailSmtpPass', plaintext)
  }
}

export function getSmtpPassword(): string {
  const enc = store.get('emailSmtpPassEnc' as keyof Settings) as string | undefined
  if (enc) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      return ''
    }
  }
  // Legacy plaintext (migrated on next save)
  return (store.get('emailSmtpPass') as string) ?? ''
}

export function hasSmtpPassword(): boolean {
  return !!(store.get('emailSmtpPassEnc' as keyof Settings) || store.get('emailSmtpPass'))
}

// --- end safeStorage helpers ---

export function get<K extends keyof Settings>(key: K): Settings[K] {
  return store.get(key)
}

export function set<K extends keyof Settings>(key: K, value: Settings[K]): void {
  store.set(key, value)
}

export function getAll(): Settings {
  const s = store.store
  return {
    ...s,
    emailSmtpPass: '',
    emailSmtpPassSet: hasSmtpPassword()
  }
}

export function setAll(obj: Partial<Settings>): void {
  const { recordingHistory, activeRecovery, emailSmtpPass, emailSmtpPassEnc, emailSmtpPassSet, ...safe } = obj
  store.store = { ...store.store, ...safe }
  // Encrypt password if provided; empty string = keep existing
  if (emailSmtpPass !== undefined && emailSmtpPass !== '') {
    setSmtpPassword(emailSmtpPass)
  }
}

export function getHistory(): RecordingEntry[] {
  return store.get('recordingHistory') ?? []
}

let _lastHistoryTs = 0
export function addHistory(entry: RecordingEntry): void {
  // createdAt: wall-clock time the entry was created. Monotonic: never older than
  // the previous entry, so history ordering survives clock adjustments (NTP, DST, etc.).
  const now = Date.now()
  const history = getHistory()
  const lastPersisted = history[0]?.timestamp ?? 0
  const lastTs = Math.max(_lastHistoryTs, lastPersisted)
  const safeTs = Math.max(now, lastTs + 1)
  _lastHistoryTs = safeTs
  history.unshift({ ...entry, timestamp: safeTs })
  store.set('recordingHistory', history.slice(0, 200))
}

/**
 * Append a back-dated history entry (e.g. a "missed recording" marker) using
 * the caller-supplied timestamp instead of clobbering it with now(). The entry
 * is inserted in chronological position so the history stays sorted newest-first.
 *
 * Unlike addHistory(), this does NOT bump the monotonic counter — a missed
 * entry from yesterday shouldn't push tomorrow's entry forward.
 */
export function addHistoryWithTimestamp(entry: RecordingEntry & { timestamp: number }): void {
  const history = getHistory()
  // Insert maintaining newest-first order
  let inserted = false
  for (let i = 0; i < history.length; i++) {
    const ts = history[i].timestamp ?? 0
    if (entry.timestamp > ts) {
      history.splice(i, 0, { ...entry })
      inserted = true
      break
    }
  }
  if (!inserted) history.push({ ...entry })
  store.set('recordingHistory', history.slice(0, 200))
}

export function deleteHistoryEntry(timestamp: number): void {
  store.set('recordingHistory', getHistory().filter(e => e.timestamp !== timestamp))
}

export function clearHistory(): void {
  store.set('recordingHistory', [])
}

export function updateHistoryNote(timestamp: number, note: string): void {
  const history = getHistory()
  const entry = history.find(e => e.timestamp === timestamp)
  if (entry) {
    entry.note = note.trim() || undefined
    store.set('recordingHistory', history)
  }
}

/** Returns true if a file exists and is larger than 1 KB (guards against corrupt/empty recordings). */
function isFileValid(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false
  try {
    return fs.statSync(filePath).size > 1000
  } catch {
    return true  // existsSync confirmed it exists; trust that
  }
}

export function pruneHistory(): number {
  const before = getHistory()
  const after  = before.filter(entry => {
    if (entry.status !== 'ok' || !entry.path) return true
    return isFileValid(entry.path)
  })
  if (after.length !== before.length) {
    store.set('recordingHistory', after)
  }
  return before.length - after.length
}

export function exportProfile(): Omit<Settings, 'recordingHistory' | 'activeRecovery'> {
  // Strip cloud configuration too. folderId/folderName are tied to the user's
  // OAuth-authenticated account; they're meaningless on a different machine
  // (where the user has to re-authenticate anyway). Easier to re-pick the
  // backup folder than to debug a stale folderId.
  const {
    recordingHistory, activeRecovery, nextExpectedRecordingISO, hasLaunched, emailSmtpPassEnc,
    cloudGoogleDrive, cloudDropbox, cloudOneDrive,
    ...profile
  } = store.store
  return { ...profile, emailSmtpPass: '' }
}

/** Clamp a numeric value to [min, max]; return def if v is not a finite number. */
function clampNum(v: unknown, min: number, max: number, def: number): number {
  const n = Number(v)
  return isNaN(n) || !isFinite(n) ? def : Math.max(min, Math.min(max, n))
}

export function importProfile(json: string): boolean {
  try {
    const raw = JSON.parse(json)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
    const imported = raw as Record<string, unknown>

    const profile = imported as Partial<Settings>
    if (profile.saveFolder         !== undefined && profile.saveFolder         !== null && typeof profile.saveFolder         !== 'string') return false
    if (profile.emailSmtp          !== undefined && typeof profile.emailSmtp          !== 'string') return false
    if (profile.emailAddress       !== undefined && typeof profile.emailAddress       !== 'string') return false
    if (profile.slots !== undefined) {
      if (!Array.isArray(profile.slots)) return false
      for (const s of profile.slots) {
        if (!s || typeof s !== 'object' || Array.isArray(s)) return false
        const slot = s as unknown as Record<string, unknown>
        if (!Array.isArray(slot.days) || typeof slot.start !== 'string' || typeof slot.stop !== 'string') return false
        if (!(slot.days as unknown[]).every(d => typeof d === 'number' && d >= 0 && d <= 6)) return false
        if (!/^\d{2}:\d{2}$/.test(slot.start as string) || !/^\d{2}:\d{2}$/.test(slot.stop as string)) return false
      }
    }
    if (profile.specialRecordings !== undefined) {
      if (!Array.isArray(profile.specialRecordings)) return false
      for (const s of profile.specialRecordings) {
        if (!s || typeof s !== 'object' || Array.isArray(s)) return false
        const sr = s as unknown as Record<string, unknown>
        if (typeof sr.date !== 'string' || typeof sr.start !== 'string' || typeof sr.stop !== 'string') return false
        if (!/^\d{4}-\d{2}-\d{2}$/.test(sr.date as string)) return false
      }
    }
    if (profile.language           !== undefined && profile.language           !== null && typeof profile.language           !== 'string') return false

    // ── Numeric field clamping ──
    if (typeof profile.sampleRate === 'number') {
      profile.sampleRate = clampNum(profile.sampleRate, 8000, 192000, 48000)
    }
    if (typeof profile.manualMaxMinutes === 'number') {
      profile.manualMaxMinutes = clampNum(profile.manualMaxMinutes, 0, 1440, 0)
    }
    if (typeof profile.splitMinutes === 'number') {
      profile.splitMinutes = clampNum(profile.splitMinutes, 0, 480, 0)
    }
    if (typeof profile.videoBitrate === 'number') {
      profile.videoBitrate = clampNum(profile.videoBitrate, 500, 50000, 4000)
    }
    if (typeof profile.videoFramerate === 'number') {
      profile.videoFramerate = clampNum(profile.videoFramerate, 10, 60, 30)
    }

    // ── EQ field clamping — gain: -24..+24 dB ──
    const eqGainFields = ['eqBass', 'eqMid', 'eqTreble'] as const
    for (const f of eqGainFields) {
      if (typeof profile[f] === 'number') {
        profile[f] = clampNum(profile[f], -24, 24, 0)
      }
    }

    const { recordingHistory, activeRecovery, emailSmtpPassEnc, emailSmtpPassSet, emailSmtpPass, ...safe } = profile
    Object.entries(safe).forEach(([k, v]) => store.set(k as keyof Settings, v as never))
    if (emailSmtpPass) setSmtpPassword(emailSmtpPass)
    return true
  } catch {
    return false
  }
}

/**
 * Migrate legacy `tempPath` → `outputPath` in activeRecovery.
 * Also fills in new fields (segments, videoOutputPath, phase, updatedAt) that
 * older versions did not write, and clears stale recovery entries that are
 * older than 24 hours (the recording clearly ended without cleanup running).
 * Call once at app startup, before recoverCrashedSession().
 */
export function migrateActiveRecovery(): void {
  const recovery = store.get('activeRecovery')
  if (!recovery) return
  const rec = recovery as unknown as Record<string, unknown>

  // ── Stale recovery detection ──────────────────────────────────────────────
  // updatedAt is set every 30 s during recording. If it is more than 24 hours
  // ago (or missing from an old version), the recording finished long ago and
  // the store entry is a ghost — clear it rather than attempting recovery.
  const updatedAt = typeof rec.updatedAt === 'number' ? rec.updatedAt : null
  const STALE_MS  = 24 * 60 * 60 * 1000  // 24 hours
  if (updatedAt !== null && Date.now() - updatedAt > STALE_MS) {
    store.set('activeRecovery', null)
    console.log('[store] cleared stale activeRecovery (updatedAt was', new Date(updatedAt).toISOString(), ')')
    return
  }

  let changed = false

  // ── Legacy tempPath → outputPath migration ────────────────────────────────
  if (rec.tempPath && !rec.outputPath) {
    rec.outputPath = rec.tempPath
    delete rec.tempPath
    changed = true
    console.log('[store] migrated legacy tempPath → outputPath in activeRecovery')
  }

  // ── Fill in fields absent from older recovery formats ─────────────────────
  if (!Array.isArray(rec.segments)) {
    // Best effort: if outputPath exists, treat it as the sole segment
    rec.segments = rec.outputPath ? [rec.outputPath] : []
    changed = true
  }
  if (!('videoOutputPath' in rec)) {
    rec.videoOutputPath = undefined
    changed = true
  }
  if (typeof rec.phase !== 'string') {
    rec.phase = 'recording'  // pre-phase-tracking sessions were always mid-recording
    changed = true
  }
  if (typeof rec.updatedAt !== 'number') {
    // Assign a plausible updatedAt so stale detection works on next launch
    rec.updatedAt = Date.now()
    changed = true
  }

  if (changed) {
    store.set('activeRecovery', rec as never)
  }
}

export function markCloudUploaded(timestamp: number, serviceId: string): void {
  const history = get('recordingHistory') ?? []
  const idx = history.findIndex(e => e.timestamp === timestamp)
  if (idx < 0) return
  const entry = history[idx]
  const existing = entry.cloudUploaded ?? []
  if (!existing.includes(serviceId)) {
    history[idx] = { ...entry, cloudUploaded: [...existing, serviceId] }
    set('recordingHistory', history)
  }
}

/** Save the public/share URL for an uploaded recording. Used by the podcast feed. */
export function setCloudUrl(timestamp: number, serviceId: string, url: string): void {
  const history = get('recordingHistory') ?? []
  const idx = history.findIndex(e => e.timestamp === timestamp)
  if (idx < 0) return
  const entry = history[idx]
  history[idx] = { ...entry, cloudUrls: { ...(entry.cloudUrls ?? {}), [serviceId]: url } }
  set('recordingHistory', history)
}

/**
 * Locate a history entry by file path. Normalizes path separators so a Windows
 * "C:\Users\..\rec.mp3" matches "C:/Users/../rec.mp3" written from a different
 * code path. Used by the upload queue when entryTimestamp wasn't captured.
 */
export function findHistoryByPath(filePath: string): RecordingEntry | undefined {
  const target = filePath.replace(/\\/g, '/').toLowerCase()
  return getHistory().find(e => !!e.path && e.path.replace(/\\/g, '/').toLowerCase() === target)
}

export function reset(): void {
  store.clear()
  _lastHistoryTs = 0
}

// --- Wake failure history ---

const WAKE_FAILURE_MAX = 20

export function getWakeFailureHistory(): WakeFailureEntry[] {
  return (store.get('wakeFailureHistory' as keyof Settings) as WakeFailureEntry[] | undefined) ?? []
}

/** Append a wake-failure or test-wake outcome. Capped at WAKE_FAILURE_MAX entries (newest-first). */
export function addWakeFailureEntry(entry: WakeFailureEntry): void {
  const list = getWakeFailureHistory()
  list.unshift(entry)
  store.set('wakeFailureHistory' as keyof Settings, list.slice(0, WAKE_FAILURE_MAX) as never)
}

export function clearWakeFailureHistory(): void {
  store.set('wakeFailureHistory' as keyof Settings, [] as never)
}
