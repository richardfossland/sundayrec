import Store from 'electron-store'
import { safeStorage } from 'electron'
import fs from 'fs'
import type { Settings, RecordingEntry } from '../types'

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
  recordingHistory: []
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

export function addHistory(entry: RecordingEntry): void {
  const history = getHistory()
  history.unshift({ ...entry, timestamp: Date.now() })
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

export function pruneHistory(): number {
  const before = getHistory()
  const after  = before.filter(entry => {
    if (entry.status !== 'ok' || !entry.path) return true
    return fs.existsSync(entry.path)
  })
  if (after.length !== before.length) {
    store.set('recordingHistory', after)
  }
  return before.length - after.length
}

export function exportProfile(): Omit<Settings, 'recordingHistory' | 'activeRecovery'> {
  const { recordingHistory, activeRecovery, hasLaunched, emailSmtpPassEnc, ...profile } = store.store
  return { ...profile, emailSmtpPass: '' }
}

export function importProfile(json: string): boolean {
  try {
    const raw = JSON.parse(json)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
    const profile = raw as Partial<Settings>
    if (profile.saveFolder         !== undefined && profile.saveFolder         !== null && typeof profile.saveFolder         !== 'string') return false
    if (profile.emailSmtp          !== undefined && typeof profile.emailSmtp          !== 'string') return false
    if (profile.emailAddress       !== undefined && typeof profile.emailAddress       !== 'string') return false
    if (profile.slots              !== undefined && !Array.isArray(profile.slots))                  return false
    if (profile.specialRecordings  !== undefined && !Array.isArray(profile.specialRecordings))      return false
    if (profile.language           !== undefined && profile.language           !== null && typeof profile.language           !== 'string') return false
    const { recordingHistory, activeRecovery, emailSmtpPassEnc, emailSmtpPassSet, emailSmtpPass, ...safe } = profile
    Object.entries(safe).forEach(([k, v]) => store.set(k as keyof Settings, v as never))
    if (emailSmtpPass) setSmtpPassword(emailSmtpPass)
    return true
  } catch {
    return false
  }
}

export function reset(): void {
  store.clear()
}
