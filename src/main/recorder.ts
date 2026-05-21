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
import { spawn } from 'child_process'
import { app, Notification, powerSaveBlocker, systemPreferences } from 'electron'
import type { BrowserWindow } from 'electron'
import crypto from 'crypto'
import * as store from './store'
import * as tray from './tray'
import * as mailer from './mailer'
import { localDateStr, buildFilename, sanitizeFilename, formatDuration } from './recorder-utils'
import { startCapture, stopCapture, ffmpegBin, buildCodecArgs } from './native-recorder'
import * as preroll from './preroll'
import type { NativeHandle } from './native-recorder'
import type { RecordingOpts, RecordingEntry } from '../types'

// ── Localised notification labels ───────────────────────────────────────────

const ERROR_REASONS: Record<string, Record<string, string>> = {
  no: {
    device_disconnected:      'Lydenheten ble koblet fra under opptak',
    device_not_found:         'Lydenheten ble ikke funnet — sjekk lydkort og tillatelser',
    device_permission_denied: 'Mikrofontilgang nektet — sjekk Personvern & sikkerhet',
    device_busy:              'Lydenheten er opptatt av et annet program',
    device_error:             'Feil med lydenheten — prøv å koble til på nytt',
    empty_output:             'Ingen lyd ble tatt opp — var enheten koblet til?',
    no_device:                'Ingen lydenhet funnet',
    disk_full:                'Disken er full — frigjør plass og prøv igjen',
    ffmpeg_missing:           'Intern feil: opptaksbinær mangler — reinstaller appen',
    stuck_recording:          'Opptaket stoppet — ingen lyd fra enheten i 60 sekunder',
    save_folder_permission:   'Ingen tilgang til lagringsmappen — sjekk at mappen er skrivbar',
    save_folder_error:        'Kan ikke opprette lagringsmappe — sjekk diskplass og tillatelser',
    already_recording:        'Et manuelt opptak er allerede i gang — planlagt opptak startet ikke',
  },
  en: {
    device_disconnected:      'Audio device disconnected during recording',
    device_not_found:         'Audio device not found — check sound settings',
    device_permission_denied: 'Microphone access denied — check Privacy & Security',
    device_busy:              'Audio device is in use by another application',
    device_error:             'Audio device error — try reconnecting',
    empty_output:             'No audio was recorded — was the device connected?',
    no_device:                'No audio device found',
    disk_full:                'Disk is full — free up space and try again',
    ffmpeg_missing:           'Internal error: recording binary missing — reinstall the app',
    stuck_recording:          'Recording stalled — no audio from device for 60 seconds',
    save_folder_permission:   'No write access to save folder — check folder permissions',
    save_folder_error:        'Cannot create save folder — check disk space and permissions',
    already_recording:        'A manual recording is already in progress — scheduled recording did not start',
  },
  de: {
    device_disconnected:      'Audiogerät während der Aufnahme getrennt',
    device_not_found:         'Audiogerät nicht gefunden — Audioeinstellungen prüfen',
    device_permission_denied: 'Mikrofonzugriff verweigert — Datenschutz prüfen',
    device_busy:              'Audiogerät von anderem Programm belegt',
    device_error:             'Fehler am Audiogerät — neu anschließen',
    empty_output:             'Keine Audiodaten — war das Gerät verbunden?',
    no_device:                'Kein Audiogerät gefunden',
    disk_full:                'Datenträger voll — Speicher freigeben',
    ffmpeg_missing:           'Interner Fehler: Aufnahme-Binary fehlt — App neu installieren',
    stuck_recording:          'Aufnahme hängt — kein Audio von Gerät seit 60 Sekunden',
    save_folder_permission:   'Kein Schreibzugriff auf Speicherordner — Berechtigungen prüfen',
    save_folder_error:        'Speicherordner konnte nicht erstellt werden — Speicherplatz prüfen',
  },
  sv: {
    device_disconnected:      'Ljudenheten kopplades från under inspelning',
    device_not_found:         'Ljudenheten hittades inte — kontrollera ljudinställningar',
    device_permission_denied: 'Mikrofonåtkomst nekad — kontrollera Integritet',
    device_busy:              'Ljudenheten används av ett annat program',
    device_error:             'Fel på ljudenheten — försök koppla om',
    empty_output:             'Inget ljud spelades in — var enheten ansluten?',
    no_device:                'Ingen ljudenhet hittad',
    disk_full:                'Disken är full — frigör utrymme och försök igen',
    ffmpeg_missing:           'Internt fel: inspelningsbinär saknas — ominstallera appen',
    stuck_recording:          'Inspelningen fastnade — inget ljud från enhet på 60 sekunder',
    save_folder_permission:   'Ingen skrivbehörighet för lagringsmappen — kontrollera behörigheter',
    save_folder_error:        'Kan inte skapa lagringsmappen — kontrollera diskutrymme',
  },
  da: {
    device_disconnected:      'Lydenheden blev frakoblet under optagelse',
    device_not_found:         'Lydenheden blev ikke fundet — tjek lydindstillinger',
    device_permission_denied: 'Mikrofonadgang nægtet — tjek Privatliv',
    device_busy:              'Lydenheden bruges af et andet program',
    device_error:             'Fejl på lydenheden — prøv at tilslutte igen',
    empty_output:             'Ingen lyd optaget — var enheden tilsluttet?',
    no_device:                'Ingen lydenhed fundet',
    disk_full:                'Disken er fuld — frigør plads og prøv igen',
    ffmpeg_missing:           'Intern fejl: optagelsesbinær mangler — geninstaller appen',
    stuck_recording:          'Optagelsen gik i stå — intet lyd fra enhed i 60 sekunder',
    save_folder_permission:   'Ingen skriveadgang til lagringsmappe — tjek mappetilladelser',
    save_folder_error:        'Kan ikke oprette lagringsmappe — tjek diskplads',
  },
  pl: {
    device_disconnected:      'Urządzenie audio rozłączone podczas nagrywania',
    device_not_found:         'Urządzenie audio nie znalezione — sprawdź ustawienia dźwięku',
    device_permission_denied: 'Odmowa dostępu do mikrofonu — sprawdź Prywatność',
    device_busy:              'Urządzenie audio zajęte przez inny program',
    device_error:             'Błąd urządzenia audio — spróbuj podłączyć ponownie',
    empty_output:             'Nie nagrano dźwięku — czy urządzenie było podłączone?',
    no_device:                'Nie znaleziono urządzenia audio',
    disk_full:                'Dysk jest pełny — zwolnij miejsce i spróbuj ponownie',
    ffmpeg_missing:           'Błąd wewnętrzny: brak pliku nagrywania — zainstaluj ponownie',
    stuck_recording:          'Nagrywanie utknęło — brak dźwięku z urządzenia przez 60 sekund',
    save_folder_permission:   'Brak dostępu do folderu zapisu — sprawdź uprawnienia',
    save_folder_error:        'Nie można utworzyć folderu zapisu — sprawdź miejsce na dysku',
  },
  fr: {
    device_disconnected:      "Périphérique audio déconnecté pendant l'enregistrement",
    device_not_found:         "Périphérique audio introuvable — vérifiez les paramètres audio",
    device_permission_denied: 'Accès microphone refusé — vérifiez Confidentialité',
    device_busy:              'Périphérique audio utilisé par une autre application',
    device_error:             'Erreur périphérique audio — reconnectez-le',
    empty_output:             "Aucun audio enregistré — l'appareil était-il connecté ?",
    no_device:                'Aucun périphérique audio trouvé',
    disk_full:                'Disque plein — libérez de l\'espace et réessayez',
    ffmpeg_missing:           'Erreur interne : binaire manquant — réinstallez l\'application',
    stuck_recording:          'Enregistrement bloqué — aucun audio depuis 60 secondes',
    save_folder_permission:   "Pas d'accès en écriture au dossier — vérifiez les permissions",
    save_folder_error:        "Impossible de créer le dossier d'enregistrement — vérifiez l'espace disque",
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
  settings:         RecordingOpts
  outputPath:       string
  sessionId:        string
  handle:           NativeHandle
  startTime:        number
  sessionStartTime: number   // original start — never updated on reconnect
  win:              BrowserWindow
  maxTimer:         ReturnType<typeof setTimeout> | null
  stuckTimer:       ReturnType<typeof setInterval> | null
  lastProgressAt:   number
  stopping:         boolean
  reconnectCount:   number
  prerollRaw:       string | null
  prerollMs:        number
  segments:         string[]  // all output paths in order (reconnect segments appended)
  splitTimer:       ReturnType<typeof setTimeout> | null
  splitAutoRestart: boolean
}

let activeSession:       Session | null      = null
let recBlocker:          number | null       = null
let displayBlocker:      number | null       = null
let idleCallback:        (() => void) | null = null
let sessionEndCallback:  (() => void) | null = null

export function onceIdle(cb: () => void): void { idleCallback = cb }
export function setSessionEndCallback(cb: () => void): void { sessionEndCallback = cb }

function notifyIdle(): void {
  const cb = idleCallback; idleCallback = null; cb?.()
}

function stopBlockers(): void {
  if (recBlocker !== null && powerSaveBlocker.isStarted(recBlocker)) {
    powerSaveBlocker.stop(recBlocker)
  }
  recBlocker = null
  if (displayBlocker !== null && powerSaveBlocker.isStarted(displayBlocker)) {
    powerSaveBlocker.stop(displayBlocker)
  }
  displayBlocker = null
}

function stopStuckTimer(session: Session): void {
  if (session.stuckTimer) { clearInterval(session.stuckTimer); session.stuckTimer = null }
}

function getLang(): string { return store.get('language') ?? 'no' }
function getNL()  { return NOTIFY_LABELS[getLang()] ?? NOTIFY_LABELS.no }

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show()
}

// Guard against sending IPC to a destroyed BrowserWindow (e.g. after renderer crash)
function safeSend(win: BrowserWindow, channel: string, payload?: unknown): void {
  try {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  } catch (err) {
    console.warn(`[recorder] safeSend(${channel}) failed:`, (err as Error).message)
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function isActive(): boolean {
  return activeSession !== null && !activeSession.stopping
}

// ── Pre-recording safety checks ──────────────────────────────────────────────

async function preflightCheck(settings: RecordingOpts): Promise<{ error: string } | null> {
  // 1. ffmpeg binary must exist
  if (ffmpegBin !== 'ffmpeg' && !fs.existsSync(ffmpegBin)) {
    console.error('[recorder] ffmpeg binary not found at', ffmpegBin)
    return { error: 'ffmpeg_missing' }
  }

  // 2. Save folder must be writable
  const folder = settings.saveFolder ?? defaultFolder()
  try {
    fs.mkdirSync(folder, { recursive: true })
    const probe = path.join(folder, `.srtst_${Date.now()}`)
    fs.writeFileSync(probe, '')
    fs.unlinkSync(probe)
  } catch {
    return { error: 'save_folder_permission' }
  }

  // 3. Disk space: require at least 200 MB free
  try {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execAsync = promisify(execFile)
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const { stdout } = await execAsync('df', ['-Pk', folder], { timeout: 4000 })
      const cols = stdout.trim().split('\n')[1]?.trim().split(/\s+/)
      const freeKb = cols ? parseInt(cols[3]) : NaN
      if (!isNaN(freeKb) && freeKb < 200 * 1024) return { error: 'disk_full' }
    } else if (process.platform === 'win32') {
      let freeBytes = NaN
      const driveLetter = folder.match(/^([A-Za-z]):/)
      if (driveLetter) {
        const { stdout } = await execAsync('powershell', [
          '-NoProfile', '-Command', `(Get-PSDrive -Name '${driveLetter[1]}' -ErrorAction SilentlyContinue).Free`
        ], { timeout: 4000 })
        freeBytes = parseInt(stdout.trim())
      } else {
        // UNC/network path (\\server\share\...) — query free space via COM FileSystemObject
        const norm = folder.replace(/\//g, '\\')
        const unc  = norm.match(/^(\\\\[^\\]+\\[^\\]+)/)
        if (unc) {
          const escaped = unc[1].replace(/'/g, "''")
          const { stdout } = await execAsync('powershell', [
            '-NoProfile', '-Command',
            `try{(New-Object -ComObject Scripting.FileSystemObject).GetDrive('${escaped}').FreeSpace}catch{-1}`
          ], { timeout: 4000 })
          freeBytes = parseInt(stdout.trim())
        }
      }
      if (!isNaN(freeBytes) && freeBytes >= 0 && freeBytes < 200 * 1024 * 1024) return { error: 'disk_full' }
    }
  } catch { /* disk check is best-effort */ }

  // 4. macOS: microphone permission must be granted
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'denied' || status === 'restricted') {
      console.error('[recorder] microphone access', status)
      return { error: 'device_permission_denied' }
    }
  }

  return null
}

export async function startSession(
  settings: RecordingOpts,
  win: BrowserWindow,
  prerollData?: { rawPath: string; trimMs: number } | null
): Promise<{ ok: true } | { error: string }> {
  if (activeSession) return { error: 'already_recording' }

  // Stop any running pre-roll (it competes for the same audio device)
  const prerollWasActive = preroll.isRunning()
  await preroll.stop()
  if (prerollWasActive && process.platform === 'darwin') {
    await new Promise<void>(resolve => setTimeout(resolve, 500))
  }

  const preflightError = await preflightCheck(settings)
  if (preflightError) return preflightError

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
    startTime:        handle.startTime,
    sessionStartTime: handle.startTime,
    win, maxTimer: null, stuckTimer: null,
    lastProgressAt: Date.now(),
    stopping: false, reconnectCount: 0,
    prerollRaw: prerollData?.rawPath ?? null,
    prerollMs:  prerollData?.trimMs  ?? 0,
    segments:   [outputPath],
    splitTimer: null, splitAutoRestart: false,
  }

  // Persist recovery info so a crash restart can salvage the partial file
  store.set('activeRecovery', { outputPath, startTime: handle.startTime, sessionId })

  // Auto-stop after maxMinutes if set
  if (settings.maxMinutes) {
    activeSession.maxTimer = setTimeout(() => stopSession(), settings.maxMinutes * 60000)
  }

  // Silence detection — ffmpeg silencedetect filter fires onSilenceEnd after sustained quiet
  handle.onSilenceEnd = () => {
    console.log('[recorder] Silence timeout reached — stopping session')
    stopSession()
  }

  // Interval split — stop and auto-restart after N minutes (handled entirely in main)
  if (settings.splitMinutes && settings.splitMinutes > 0) {
    const sess = activeSession
    sess.splitTimer = setTimeout(() => {
      sess.splitTimer = null
      sess.splitAutoRestart = true
      stopSession()
    }, settings.splitMinutes * 60000)
  }

  // Prevent system suspension + display sleep during active recording.
  // prevent-display-sleep keeps macOS AVFoundation audio session alive even when screen dims.
  if (recBlocker === null || !powerSaveBlocker.isStarted(recBlocker)) {
    recBlocker = powerSaveBlocker.start('prevent-app-suspension')
  }
  if (displayBlocker === null || !powerSaveBlocker.isStarted(displayBlocker)) {
    displayBlocker = powerSaveBlocker.start('prevent-display-sleep')
  }

  // Progress → update lastProgressAt + send bytes to renderer
  handle.onProgress = bytes => {
    if (activeSession?.sessionId === sessionId) activeSession.lastProgressAt = Date.now()
    safeSend(win, 'recording-progress', { bytes })
  }

  // Stuck detector: if no progress in 60 s while not stopping, trigger watchdog
  activeSession.stuckTimer = setInterval(() => {
    const s = activeSession
    if (!s || s.sessionId !== sessionId || s.stopping) return
    if (Date.now() - s.lastProgressAt > 60000) {
      console.warn('[recorder] No progress for 60 s — treating as device failure')
      stopStuckTimer(s)
      startWatchdog(s)
    }
  }, 15000)

  // Watchdog — handles unexpected ffmpeg exit (USB disconnect, driver crash)
  handle.onExit = code => {
    if (!activeSession || activeSession.sessionId !== sessionId) return
    if (activeSession.stopping) {
      stopStuckTimer(activeSession)
      finishSession(activeSession)
    } else if (code === 0) {
      stopStuckTimer(activeSession)
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
  if (session.maxTimer)   clearTimeout(session.maxTimer)
  if (session.splitTimer) clearTimeout(session.splitTimer)
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
  stopStuckTimer(session)
  stopBlockers()
  store.set('activeRecovery', null)

  // Use the original session start so duration/date are correct even after reconnects
  const durationSec = Math.round((Date.now() - session.sessionStartTime) / 1000)
  const recDate     = new Date(session.sessionStartTime)

  // For single-segment sessions, guard against a completely empty output.
  // Multi-segment sessions: at least one earlier segment has data; let mergeSegments validate.
  if (session.segments.length === 1) {
    const exists = fs.existsSync(session.outputPath)
    const size   = exists ? fs.statSync(session.outputPath).size : 0
    if (!exists || size < 1000) {
      const msg = localizeError('empty_output')
      safeSend(session.win, 'recording-error', { error: 'empty_output', message: msg })
      tray.setRecording(false)
      tray.setError(true)
      notify(getNL().err, msg)
      notifyIdle()
      sessionEndCallback?.()
      return
    }
  }

  tray.setRecording(false)

  finishSessionAsync(session, durationSec, recDate).catch(err =>
    console.error('[recorder] finishSessionAsync error:', err)
  )
}

async function finishSessionAsync(session: Session, durationSec: number, recDate: Date): Promise<void> {
  // Step 1: Pre-roll always prepends to the very first segment (the start of the recording).
  // Previously this targeted session.outputPath which after reconnects pointed to the last
  // segment — applying pre-roll mid-recording was wrong. segments[0] is always the correct target.
  if (session.prerollRaw && session.prerollMs > 0) {
    try {
      await applyPreroll(session.prerollRaw, session.prerollMs, session.segments[0], session.settings)
    } catch (err) {
      console.error('[recorder] pre-roll concat failed — continuing without pre-roll:', err)
      fs.promises.unlink(session.prerollRaw).catch(() => {})
    }
  }

  // Step 2: Merge reconnect segments (if any) into a single file at segments[0].
  if (session.segments.length > 1) {
    const ok = await mergeSegments(session.segments)
    if (ok) {
      session.outputPath = session.segments[0]
    } else {
      // Merge failed — add individual history entries so no data is lost
      console.error('[recorder] segment merge failed — adding individual segments to history')
      for (const segPath of session.segments) {
        try {
          if (!fs.existsSync(segPath) || fs.statSync(segPath).size < 1000) continue
        } catch { continue }
        const segEntry: RecordingEntry = {
          date:      localDateStr(recDate),
          startTime: recDate.toTimeString().slice(0, 5),
          duration:  '—',
          filename:  path.basename(segPath),
          path:      segPath,
          status:    'ok'
        }
        store.addHistory(segEntry)
        safeSend(session.win, 'recording-finished', segEntry)
      }
      if (store.get('notifyStop') !== false) {
        notify('SundayRec', `${getNL().done}: ${path.basename(session.segments[0])}`)
      }
      notifyIdle()
      sessionEndCallback?.()
      return
    }
  }

  // Step 3: Single history entry for the (now possibly merged) recording
  const entry: RecordingEntry = {
    date:      localDateStr(recDate),
    startTime: recDate.toTimeString().slice(0, 5),
    duration:  formatDuration(durationSec),
    filename:  path.basename(session.outputPath),
    path:      session.outputPath,
    status:    'ok'
  }
  store.addHistory(entry)

  // Cloud auto-upload (fire-and-forget)
  import('./cloud').then(c => c.autoUploadAfterRecording(session.outputPath, session.win)).catch(err =>
    console.error('[recorder] cloud upload error:', err)
  )

  // Split auto-restart: start new session in main, send overlay events to renderer
  if (session.splitAutoRestart) {
    const ts       = new Date().toTimeString().slice(0, 5).replace(':', '')
    const nextOpts = { ...session.settings, splitTimestamp: ts }

    if (store.get('notifyStop') !== false) {
      notify('SundayRec', `${getNL().done}: ${path.basename(session.outputPath)}`)
    }

    // Stop renderer monitoring, notify history, then start new session
    safeSend(session.win, 'recording-overlay-stop', {})
    safeSend(session.win, 'recording-finished', { ...entry, splitRestart: true })

    const nextResult = await startSession(nextOpts, session.win)
    if ('ok' in nextResult) {
      safeSend(session.win, 'recording-overlay-start', nextOpts)
    } else {
      const msg = localizeError(nextResult.error)
      safeSend(session.win, 'recording-error', { error: nextResult.error, message: msg })
      notify(getNL().err, msg)
      notifyIdle()
      sessionEndCallback?.()
    }
    return
  }

  safeSend(session.win, 'recording-finished', entry)

  if (store.get('notifyStop') !== false) {
    notify('SundayRec', `${getNL().done}: ${path.basename(session.outputPath)}`)
  }
  notifyIdle()
  sessionEndCallback?.()
}

// ── Pre-roll encode + concat ─────────────────────────────────────────────────

async function applyPreroll(
  rawPath: string,
  trimMs: number,
  mainPath: string,
  opts: RecordingOpts
): Promise<void> {
  const ext          = path.extname(mainPath)
  const dir          = path.dirname(mainPath)
  const base         = path.basename(mainPath, ext)
  const encodedPath  = path.join(dir, `${base}_pr_tmp${ext}`)
  const concatTmp    = path.join(dir, `${base}_concat_tmp${ext}`)
  const concatList   = path.join(dir, `${base}_concat.txt`)

  try {
    // Step 1: Trim last trimMs from raw WAV and encode to target format
    const trimSec   = (trimMs / 1000).toFixed(3)
    const codecArgs = buildCodecArgs(opts)

    await new Promise<void>((resolve, reject) => {
      const args = [
        '-nostdin', '-hide_banner',
        '-sseof', `-${trimSec}`,   // seek trimSec from end of file
        '-i', rawPath,
        ...codecArgs,
        '-y', encodedPath,
      ]
      const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      proc.on('close', code => {
        if (code === 0) resolve()
        else reject(new Error(`pre-roll encode failed (${code}): ${stderr.slice(-500)}`))
      })
    })

    // Step 2: Concat encoded pre-roll + main recording (lossless copy)
    const escPath = (p: string) =>
      (process.platform === 'win32' ? p.replace(/\\/g, '/') : p).replace(/'/g, "'\\''")
    await fs.promises.writeFile(
      concatList,
      `file '${escPath(encodedPath)}'\nfile '${escPath(mainPath)}'\n`,
      'utf8'
    )

    await new Promise<void>((resolve, reject) => {
      const args = [
        '-nostdin', '-hide_banner',
        '-f', 'concat', '-safe', '0',
        '-i', concatList,
        '-c', 'copy',
        '-y', concatTmp,
      ]
      const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      proc.on('close', code => {
        if (code === 0) resolve()
        else reject(new Error(`concat failed (${code}): ${stderr.slice(-500)}`))
      })
    })

    // Step 3: Atomically replace main with concatenated result
    if (process.platform === 'win32') {
      fs.copyFileSync(concatTmp, mainPath)
      fs.unlinkSync(concatTmp)
    } else {
      fs.renameSync(concatTmp, mainPath)
    }

    console.log(`[recorder] pre-roll ${(trimMs / 1000).toFixed(1)} s prepended to`, mainPath)
  } finally {
    for (const f of [encodedPath, concatList, rawPath]) {
      fs.promises.unlink(f).catch(() => {})
    }
    // concatTmp cleanup in case rename failed
    fs.promises.unlink(concatTmp).catch(() => {})
  }
}

// ── Reconnect segment merge ──────────────────────────────────────────────────

// After a session with reconnects we have N separate files (segments[0..n]).
// This function concatenates them losslessly (-c copy) into segments[0] and
// deletes segments[1..n]. Returns true on success, false if ffmpeg failed.
async function mergeSegments(segments: string[]): Promise<boolean> {
  const targetPath = segments[0]
  const ext        = path.extname(targetPath)
  const dir        = path.dirname(targetPath)
  const base       = path.basename(targetPath, ext)
  const concatList = path.join(dir, `${base}_merge.txt`)
  const tempPath   = path.join(dir, `${base}_merge_tmp${ext}`)

  try {
    const escPath = (p: string) =>
      (process.platform === 'win32' ? p.replace(/\\/g, '/') : p).replace(/'/g, "'\\''")
    await fs.promises.writeFile(
      concatList,
      segments.map(s => `file '${escPath(s)}'`).join('\n') + '\n',
      'utf8'
    )

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegBin, [
        '-nostdin', '-hide_banner',
        '-f', 'concat', '-safe', '0',
        '-i', concatList,
        '-c', 'copy', '-y', tempPath,
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      proc.on('close', code => {
        if (code === 0) resolve()
        else reject(new Error(`merge failed (${code}): ${stderr.slice(-500)}`))
      })
    })

    if (process.platform === 'win32') {
      fs.copyFileSync(tempPath, targetPath)
      fs.unlinkSync(tempPath)
    } else {
      fs.renameSync(tempPath, targetPath)
    }

    for (const seg of segments.slice(1)) {
      fs.promises.unlink(seg).catch(() => {})
    }

    console.log(`[recorder] merged ${segments.length} reconnect segments → ${path.basename(targetPath)}`)
    return true
  } catch (err) {
    console.error('[recorder] mergeSegments failed:', err)
    fs.promises.unlink(tempPath).catch(() => {})
    return false
  } finally {
    fs.promises.unlink(concatList).catch(() => {})
  }
}

// ── Watchdog: reconnect after unexpected ffmpeg death ───────────────────────

// 10 attempts with exponential backoff: 2s, 3s, 4s, 5s, 5s… ≈ 50 s total window
const MAX_RECONNECT_ATTEMPTS = 10

function reconnectDelay(attempt: number): number {
  return Math.min(2000 + attempt * 1000, 5000)
}

function startWatchdog(session: Session): void {
  if (session.reconnectCount >= MAX_RECONNECT_ATTEMPTS) {
    failSession(session, 'device_disconnected')
    return
  }

  stopStuckTimer(session)
  safeSend(session.win, 'recording-reconnecting', {})
  console.warn('[recorder] ffmpeg died unexpectedly — starting reconnect watchdog')

  let attempts = 0
  const tryReconnect = async () => {
    if (!activeSession || activeSession.sessionId !== session.sessionId) return
    if (attempts >= MAX_RECONNECT_ATTEMPTS) {
      failSession(session, 'device_disconnected')
      return
    }
    attempts++
    session.reconnectCount++
    console.log(`[recorder] Reconnect attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS}…`)

    // Build a new output path with _r1/_r2 suffix for the reconnected segment
    const ext     = path.extname(session.outputPath)
    const base    = session.outputPath.slice(0, -ext.length).replace(/_r\d+$/, '')
    const newPath = `${base}_r${session.reconnectCount}${ext}`

    const result = await startCapture(session.settings, newPath)
    if ('error' in result) {
      setTimeout(tryReconnect, reconnectDelay(attempts))
      return
    }

    // Reconnect succeeded — update session in place
    console.log('[recorder] Reconnected! New segment:', newPath)
    session.outputPath     = newPath
    session.handle         = result
    session.startTime      = result.startTime
    session.lastProgressAt = Date.now()
    session.segments.push(newPath)
    store.set('activeRecovery', { outputPath: newPath, startTime: result.startTime, sessionId: session.sessionId })

    result.onProgress = bytes => {
      if (activeSession?.sessionId === session.sessionId) session.lastProgressAt = Date.now()
      safeSend(session.win, 'recording-progress', { bytes })
    }
    result.onExit = code => {
      if (!activeSession || activeSession.sessionId !== session.sessionId) return
      if (session.stopping || code === 0) { stopStuckTimer(session); finishSession(session) }
      else startWatchdog(session)
    }

    // Restart stuck detector for new segment
    session.stuckTimer = setInterval(() => {
      const s = activeSession
      if (!s || s.sessionId !== session.sessionId || s.stopping) return
      if (Date.now() - s.lastProgressAt > 60000) {
        console.warn('[recorder] Reconnected segment stuck — triggering watchdog again')
        stopStuckTimer(s)
        startWatchdog(s)
      }
    }, 15000)

    safeSend(session.win, 'recording-reconnected', {})
    notify('SundayRec', getNL().reconnected)
  }

  setTimeout(tryReconnect, reconnectDelay(0))
}

function failSession(session: Session, reason: string): void {
  if (activeSession?.sessionId === session.sessionId) activeSession = null
  stopStuckTimer(session)
  stopBlockers()
  store.set('activeRecovery', null)

  // Clean up any orphaned pre-roll temp file
  if (session.prerollRaw) fs.promises.unlink(session.prerollRaw).catch(() => {})

  const nl = getNL()
  const localizedReason = localizeError(reason)
  safeSend(session.win, 'recording-error', { error: reason, message: localizedReason })
  tray.setRecording(false)
  tray.setError(true)
  notify(nl.err, localizedReason)

  const s = store.getAll()
  if (s.emailOnError) mailer.sendError(s, store.getSmtpPassword(), reason)
  notifyIdle()
  sessionEndCallback?.()
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

  // Estimate duration from file mtime rather than Date.now() so that a
  // recording recovered days after a crash doesn't show a nonsensical duration.
  // Cap at 6 hours as a sanity ceiling.
  const estimatedEndMs = Math.min(stat.mtimeMs, Date.now())
  const rawSec         = Math.round((estimatedEndMs - recovery.startTime) / 1000)
  const durationSec    = Math.max(0, Math.min(rawSec, 6 * 3600))

  const s      = store.getAll()
  const fmt    = s.format ?? 'mp3'
  const folder = s.saveFolder ?? defaultFolder()
  const date   = localDateStr(new Date())
  const base   = `recovered_${date}`
  let   out    = path.join(folder, `${base}.${fmt}`)
  for (let i = 2; fs.existsSync(out) && i < 9999; i++) out = path.join(folder, `${base}_${i}.${fmt}`)
  fs.mkdirSync(path.dirname(out), { recursive: true })

  // Use -c copy to remux without re-encoding — fixes container headers in partial files
  const proc = spawn(ffmpegBin, ['-nostdin', '-hide_banner', '-i', filePath, '-c', 'copy', '-y', out], {
    stdio: ['ignore', 'ignore', 'pipe']
  })
  proc.on('close', code => {
    if (code === 0) {
      unlinkSilent(filePath)
      const recDate = new Date(recovery.startTime)
      store.addHistory({
        date:      localDateStr(recDate),
        startTime: recDate.toTimeString().slice(0, 5),
        duration:  formatDuration(durationSec),
        filename:  path.basename(out),
        path:      out,
        status:    'ok'
      })
      notify('SundayRec', getNL().recovered.replace('{file}', path.basename(out)))
    } else {
      // -c copy failed (very corrupt file); try to keep what we have
      console.error('[recorder] recovery remux failed for', filePath)
      try {
        fs.renameSync(filePath, out)
        notify('SundayRec', getNL().recovered.replace('{file}', path.basename(out)))
      } catch {}
    }
  })
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

