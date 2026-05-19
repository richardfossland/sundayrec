/**
 * Recorder — main process orchestration.
 *
 * Architecture (v4.1+): recording is handled entirely in the main process by an
 * ffmpeg subprocess (native-recorder.ts). The renderer is only used for the VU
 * meter and UI — it has NO role in the audio capture pipeline. A renderer crash
 * no longer affects an active recording.
 *
 * Flow:
 *   startSession()  → resolves device, spawns ffmpeg, persists recovery info
 *   stopSession()   → sends 'q' to ffmpeg stdin; ffmpeg flushes & exits cleanly
 *   finishSession() → called when ffmpeg exits 0; adds history entry, notifies UI
 *
 * Watchdog:
 *   If ffmpeg dies unexpectedly (USB disconnect, driver crash), the watchdog
 *   attempts to restart capture for up to 30 seconds. Each reconnect segment
 *   gets a _r1/_r2 suffix and its own history entry.
 *
 * Crash recovery:
 *   On startSession the output path is written to activeRecovery in the store.
 *   On next launch, recoverCrashedSession() re-muxes the partial file with
 *   ffmpeg -c copy to repair the container, then adds it to history.
 */

import path from 'path'
import fs from 'fs'
import { app, Notification, powerSaveBlocker } from 'electron'
import type { BrowserWindow } from 'electron'
import crypto from 'crypto'
import ffmpegLegacy from 'fluent-ffmpeg'
import * as store from './store'
import * as tray from './tray'
import * as mailer from './mailer'
import { localDateStr, buildFilename, sanitizeFilename, formatDuration } from './recorder-utils'
import { startCapture, stopCapture, ffmpegBin } from './native-recorder'
import type { NativeHandle } from './native-recorder'
import type { RecordingOpts, RecordingEntry } from '../types'

// ── Localised notification labels ───────────────────────────────────────────

const ERROR_REASONS: Record<string, Record<string, string>> = {
  no: {
    device_disconnected:      'Lydenheten ble koblet fra under opptak',
    device_not_found:         'Lydenheten ble ikke funnet — sjekk USB',
    device_permission_denied: 'Mikrofontilgang nektet — sjekk Personvern & sikkerhet',
    device_busy:              'Lydenheten er opptatt av et annet program',
    device_error:             'Feil med lydenheten — prøv å koble til på nytt',
    empty_output:             'Ingen lyd ble tatt opp — var enheten koblet til?',
    no_device:                'Ingen lydenhet funnet',
  },
  en: {
    device_disconnected:      'Audio device disconnected during recording',
    device_not_found:         'Audio device not found — check USB connection',
    device_permission_denied: 'Microphone access denied — check Privacy & Security',
    device_busy:              'Audio device is in use by another application',
    device_error:             'Audio device error — try reconnecting',
    empty_output:             'No audio was recorded — was the device connected?',
    no_device:                'No audio device found',
  },
  de: {
    device_disconnected:      'Audiogerät während der Aufnahme getrennt',
    device_not_found:         'Audiogerät nicht gefunden — USB prüfen',
    device_permission_denied: 'Mikrofonzugriff verweigert — Datenschutz prüfen',
    device_busy:              'Audiogerät von anderem Programm belegt',
    device_error:             'Fehler am Audiogerät — neu anschließen',
    empty_output:             'Keine Audiodaten — war das Gerät verbunden?',
    no_device:                'Kein Audiogerät gefunden',
  },
  sv: {
    device_disconnected:      'Ljudenheten kopplades från under inspelning',
    device_not_found:         'Ljudenheten hittades inte — kontrollera USB',
    device_permission_denied: 'Mikrofonåtkomst nekad — kontrollera Integritet',
    device_busy:              'Ljudenheten används av ett annat program',
    device_error:             'Fel på ljudenheten — försök koppla om',
    empty_output:             'Inget ljud spelades in — var enheten ansluten?',
    no_device:                'Ingen ljudenhet hittad',
  },
  da: {
    device_disconnected:      'Lydenheden blev frakoblet under optagelse',
    device_not_found:         'Lydenheden blev ikke fundet — tjek USB',
    device_permission_denied: 'Mikrofonadgang nægtet — tjek Privatliv',
    device_busy:              'Lydenheden bruges af et andet program',
    device_error:             'Fejl på lydenheden — prøv at tilslutte igen',
    empty_output:             'Ingen lyd optaget — var enheden tilsluttet?',
    no_device:                'Ingen lydenhed fundet',
  },
  pl: {
    device_disconnected:      'Urządzenie audio rozłączone podczas nagrywania',
    device_not_found:         'Urządzenie audio nie znalezione — sprawdź USB',
    device_permission_denied: 'Odmowa dostępu do mikrofonu — sprawdź Prywatność',
    device_busy:              'Urządzenie audio zajęte przez inny program',
    device_error:             'Błąd urządzenia audio — spróbuj podłączyć ponownie',
    empty_output:             'Nie nagrano dźwięku — czy urządzenie było podłączone?',
    no_device:                'Nie znaleziono urządzenia audio',
  },
  fr: {
    device_disconnected:      "Périphérique audio déconnecté pendant l'enregistrement",
    device_not_found:         'Périphérique audio introuvable — vérifiez USB',
    device_permission_denied: 'Accès microphone refusé — vérifiez Confidentialité',
    device_busy:              'Périphérique audio utilisé par une autre application',
    device_error:             'Erreur périphérique audio — reconnectez-le',
    empty_output:             "Aucun audio enregistré — l'appareil était-il connecté ?",
    no_device:                'Aucun périphérique audio trouvé',
  },
}

export function localizeError(code: string): string {
  const lang = getLang()
  return ERROR_REASONS[lang]?.[code] ?? ERROR_REASONS.en?.[code] ?? code
}

export const NOTIFY_LABELS: Record<string, { done: string; err: string; recovered: string; reconnected: string }> = {
  no: { done: 'Fullført',      err: 'SundayRec — Feil',    recovered: 'Opptak gjenopprettet: {file}', reconnected: 'Tilkobling gjenopprettet — fortsetter opptak' },
  en: { done: 'Completed',     err: 'SundayRec — Error',   recovered: 'Recording recovered: {file}',  reconnected: 'Connection restored — continuing recording'  },
  de: { done: 'Abgeschlossen', err: 'SundayRec — Fehler',  recovered: 'Aufnahme wiederhergestellt: {file}', reconnected: 'Verbindung wiederhergestellt' },
  sv: { done: 'Klar',          err: 'SundayRec — Fel',     recovered: 'Inspelning återställd: {file}', reconnected: 'Anslutning återställd — fortsätter inspelning' },
  da: { done: 'Fuldført',      err: 'SundayRec — Fejl',    recovered: 'Optagelse gendannet: {file}',   reconnected: 'Forbindelse genoprettet — fortsætter optagelse' },
  pl: { done: 'Ukończono',     err: 'SundayRec — Błąd',    recovered: 'Nagranie odzyskane: {file}',    reconnected: 'Połączenie przywrócone — kontynuowanie nagrywania' },
  fr: { done: 'Terminé',       err: 'SundayRec — Erreur',  recovered: 'Enregistrement récupéré : {file}', reconnected: 'Connexion rétablie — enregistrement en cours' },
}

// ── Session state ────────────────────────────────────────────────────────────

interface Session {
  settings:      RecordingOpts
  outputPath:    string
  sessionId:     string
  handle:        NativeHandle
  startTime:     number
  win:           BrowserWindow
  maxTimer:      ReturnType<typeof setTimeout> | null
  stopping:      boolean       // true once stopSession() has been called
  reconnectCount: number
}

let activeSession: Session | null = null
let recBlocker:    number | null  = null
let idleCallback:  (() => void) | null = null

export function onceIdle(cb: () => void): void { idleCallback = cb }

function notifyIdle(): void {
  const cb = idleCallback; idleCallback = null; cb?.()
}

function stopRecBlocker(): void {
  if (recBlocker !== null && powerSaveBlocker.isStarted(recBlocker)) {
    powerSaveBlocker.stop(recBlocker)
  }
  recBlocker = null
}

function getLang(): string { return store.get('language') ?? 'no' }
function getNL()  { return NOTIFY_LABELS[getLang()] ?? NOTIFY_LABELS.no }

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show()
}

// ── Public API ───────────────────────────────────────────────────────────────

export function isActive(): boolean {
  return activeSession !== null && !activeSession.stopping
}

export async function startSession(
  settings: RecordingOpts,
  win: BrowserWindow
): Promise<{ ok: true } | { error: string }> {
  if (activeSession) return { error: 'already_recording' }

  const sessionId  = crypto.randomUUID()
  const filename   = buildFilename(settings)
  const folder     = settings.saveFolder ?? defaultFolder()
  const outputPath = await uniquePath(path.join(folder, filename))
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') {
      return { error: 'save_folder_permission' }
    }
    return { error: 'save_folder_error' }
  }

  const result = await startCapture(settings, outputPath)
  if ('error' in result) return { error: result.error }

  const handle = result

  activeSession = {
    settings, outputPath, sessionId, handle,
    startTime: handle.startTime,
    win, maxTimer: null, stopping: false, reconnectCount: 0
  }

  // Persist recovery info so a crash restart can salvage the partial file
  store.set('activeRecovery', { outputPath, startTime: handle.startTime, sessionId })

  // Auto-stop after maxMinutes if set
  if (settings.maxMinutes) {
    activeSession.maxTimer = setTimeout(() => stopSession(), settings.maxMinutes * 60000)
  }

  // Keep system awake during recording
  if (recBlocker === null || !powerSaveBlocker.isStarted(recBlocker)) {
    recBlocker = powerSaveBlocker.start('prevent-app-suspension')
  }

  // Progress → send bytes to renderer for size display
  handle.onProgress = bytes => {
    win.webContents.send('recording-progress', { bytes })
  }

  // Watchdog — handles unexpected ffmpeg exit (USB disconnect, driver crash)
  handle.onExit = code => {
    if (!activeSession || activeSession.sessionId !== sessionId) return
    if (activeSession.stopping) {
      finishSession(activeSession)
    } else if (code === 0) {
      finishSession(activeSession)
    } else {
      startWatchdog(activeSession)
    }
  }

  // Update tray & send start notification
  tray.setRecording(true)
  tray.setError(false)
  if (store.get('notifyStart') !== false) {
    const name = settings.customName || settings.overrideName || 'SundayRec'
    notify('SundayRec', name)
  }

  return { ok: true }
}

export function stopSession(): void {
  if (!activeSession || activeSession.stopping) return
  const session = activeSession
  session.stopping = true
  if (session.maxTimer) clearTimeout(session.maxTimer)
  stopCapture(session.handle).then(() => {
    // finishSession will be called via handle.onExit
  }).catch(err => {
    console.error('[recorder] stopCapture error:', err)
    try { finishSession(session) } catch (e) { console.error('[recorder] finishSession error:', e) }
  })
}

// ── Internal: finish a session after ffmpeg exits ───────────────────────────

function finishSession(session: Session): void {
  if (activeSession?.sessionId === session.sessionId) activeSession = null
  stopRecBlocker()
  store.set('activeRecovery', null)

  const durationSec = Math.round((Date.now() - session.startTime) / 1000)
  const recDate     = new Date(session.startTime)
  const exists      = fs.existsSync(session.outputPath)
  const size        = exists ? fs.statSync(session.outputPath).size : 0

  if (!exists || size < 1000) {
    // Nothing was written — don't add to history
    session.win.webContents.send('recording-error', { error: 'empty_output' })
    tray.setRecording(false)
    notifyIdle()
    return
  }

  const entry: RecordingEntry = {
    date:      localDateStr(recDate),
    startTime: recDate.toTimeString().slice(0, 5),
    duration:  formatDuration(durationSec),
    filename:  path.basename(session.outputPath),
    path:      session.outputPath,
    status:    'ok'
  }
  store.addHistory(entry)
  session.win.webContents.send('recording-finished', entry)

  tray.setRecording(false)
  if (store.get('notifyStop') !== false) {
    notify('SundayRec', `${getNL().done}: ${path.basename(session.outputPath)}`)
  }
  notifyIdle()
}

// ── Watchdog: reconnect after unexpected ffmpeg death ───────────────────────

const MAX_RECONNECT_ATTEMPTS = 5   // ~30 s total (5 × ~6 s per attempt including startup wait)

function startWatchdog(session: Session): void {
  // Guard: only one watchdog per session
  if (session.reconnectCount >= MAX_RECONNECT_ATTEMPTS) {
    failSession(session, 'device_disconnected')
    return
  }

  session.win.webContents.send('recording-reconnecting', {})
  console.warn('[recorder] ffmpeg died unexpectedly — starting reconnect watchdog')

  let attempts = 0
  const tryReconnect = async () => {
    if (!activeSession || activeSession.sessionId !== session.sessionId) return
    if (attempts >= MAX_RECONNECT_ATTEMPTS) {
      failSession(session, 'device_disconnected')
      return
    }
    attempts++
    console.log(`[recorder] Reconnect attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS}…`)

    // Build a new output path with _r1/_r2 suffix for the reconnected segment
    session.reconnectCount++
    const ext      = path.extname(session.outputPath)
    const base     = session.outputPath.slice(0, -ext.length).replace(/_r\d+$/, '')
    const newPath  = `${base}_r${session.reconnectCount}${ext}`

    const result = await startCapture(session.settings, newPath)
    if ('error' in result) {
      setTimeout(tryReconnect, 1000)
      return
    }

    // Reconnect succeeded
    console.log('[recorder] Reconnected! New segment:', newPath)
    session.outputPath = newPath
    session.handle     = result
    session.startTime  = result.startTime
    store.set('activeRecovery', { outputPath: newPath, startTime: result.startTime, sessionId: session.sessionId })

    result.onProgress = bytes => {
      session.win.webContents.send('recording-progress', { bytes })
    }
    result.onExit = code => {
      if (!activeSession || activeSession.sessionId !== session.sessionId) return
      if (session.stopping || code === 0) finishSession(session)
      else startWatchdog(session)
    }

    session.win.webContents.send('recording-reconnected', {})
    const nl = getNL()
    notify('SundayRec', nl.reconnected)
  }

  setTimeout(tryReconnect, 1000)
}

function failSession(session: Session, reason: string): void {
  if (activeSession?.sessionId === session.sessionId) activeSession = null
  stopRecBlocker()
  store.set('activeRecovery', null)

  const nl = getNL()
  const localizedReason = localizeError(reason)
  session.win.webContents.send('recording-error', { error: reason, message: localizedReason })
  tray.setRecording(false)
  tray.setError(true)
  notify(nl.err, localizedReason)

  const s = store.getAll()
  if (s.emailOnError) mailer.sendError(s, store.getSmtpPassword(), reason)
  notifyIdle()
}

// ── Crash recovery ───────────────────────────────────────────────────────────

export function recoverCrashedSession(): void {
  const recovery = store.get('activeRecovery')
  if (!recovery) return
  store.set('activeRecovery', null)

  // Support both old (tempPath) and new (outputPath) recovery formats
  const filePath = (recovery as { outputPath?: string; tempPath?: string }).outputPath
                ?? (recovery as { tempPath?: string }).tempPath
  if (!filePath || !fs.existsSync(filePath)) return

  const stat = fs.statSync(filePath)
  if (stat.size < 5000) { unlinkSilent(filePath); return }

  const s      = store.getAll()
  const fmt    = s.format ?? 'mp3'
  const folder = s.saveFolder ?? defaultFolder()
  const date   = localDateStr(new Date())
  const base   = `recovered_${date}`
  let   out    = path.join(folder, `${base}.${fmt}`)
  for (let i = 2; fs.existsSync(out) && i < 9999; i++) out = path.join(folder, `${base}_${i}.${fmt}`)
  fs.mkdirSync(path.dirname(out), { recursive: true })

  // Use -c copy to remux without re-encoding — fixes container headers in partial files
  ffmpegLegacy.setFfmpegPath(ffmpegBin)
  ffmpegLegacy(filePath)
    .outputOptions(['-c', 'copy', '-y'])
    .output(out)
    .on('end', () => {
      unlinkSilent(filePath)
      const durationSec = Math.round((Date.now() - recovery.startTime) / 1000)
      const recDate     = new Date(recovery.startTime)
      store.addHistory({
        date:      localDateStr(recDate),
        startTime: recDate.toTimeString().slice(0, 5),
        duration:  formatDuration(durationSec),
        filename:  path.basename(out),
        path:      out,
        status:    'ok'
      })
      notify('SundayRec', getNL().recovered.replace('{file}', path.basename(out)))
    })
    .on('error', () => {
      // -c copy failed (very corrupt file); try to keep what we have
      console.error('[recorder] recovery remux failed for', filePath)
      try {
        fs.renameSync(filePath, out)
        notify('SundayRec', getNL().recovered.replace('{file}', path.basename(out)))
      } catch {}
    })
    .run()
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function uniquePath(p: string): Promise<string> {
  try { await fs.promises.access(p) } catch { return p }
  const ext  = path.extname(p)
  const base = p.slice(0, -ext.length)
  for (let i = 2; i < 10000; i++) {
    const c = `${base}_${i}${ext}`
    try { await fs.promises.access(c) } catch { return c }
  }
  return `${base}_${Date.now()}${ext}`
}

function unlinkSilent(p: string): void {
  fs.promises.unlink(p).catch(err => {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
      setTimeout(() => fs.promises.unlink(p).catch(() => {}), 5000)
      return
    }
    console.error('[recorder] unlink failed:', err)
  })
}

function defaultFolder(): string {
  return path.join(app.getPath('documents'), 'SundayRec')
}

