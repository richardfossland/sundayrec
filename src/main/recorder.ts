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
import * as logger from './logger'
import { localDateStr, buildFilename, sanitizeFilename, formatDuration } from './recorder-utils'
import { startCapture, stopCapture, ffmpegBin, buildCodecArgs, resolveDeviceInput } from './native-recorder'
import * as preroll from './preroll'
import type { NativeHandle } from './native-recorder'
import { startVideoCapture, stopVideoCapture, muxAudioVideo } from './video-recorder'
import type { VideoHandle } from './video-recorder'
import { stopPreview } from './video-preview'
import type { RecordingOpts, RecordingEntry, Settings, RecordingPhase } from '../types'

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
  videoHandle:      VideoHandle | null
  videoOutputPath:  string | null    // path to the in-progress video file
}

let activeSession:       Session | null      = null
let recBlocker:          number | null       = null
let displayBlocker:      number | null       = null
let idleCallback:        (() => void) | null = null
let sessionEndCallback:  (() => void) | null = null

// ── Phase state machine ──────────────────────────────────────────────────────

let _phase: RecordingPhase = 'idle'

export function getPhase(): RecordingPhase { return _phase }

/**
 * Test-only escape hatch: forcefully tears down any in-flight session and
 * resets the phase machine to 'idle'. Used by the orchestration test suite
 * to recover between tests that intentionally leave the watchdog ticking.
 *
 * Do NOT call this from production code — it does not flush ffmpeg's audio
 * buffer or finalize the output file, so it WILL lose data if a real
 * recording is active.
 */
export function _resetForTest(): void {
  if (activeSession) {
    try {
      const proc = activeSession.handle.proc
      if (proc && proc.exitCode === null && !proc.killed) proc.kill('SIGKILL')
    } catch {}
    if (activeSession.maxTimer)   clearTimeout(activeSession.maxTimer)
    if (activeSession.splitTimer) clearTimeout(activeSession.splitTimer)
    if (activeSession.stuckTimer) clearInterval(activeSession.stuckTimer)
  }
  activeSession = null
  stopBlockers()
  clearRecoveryInterval()
  idleCallback       = null
  sessionEndCallback = null
  _phase             = 'idle'
}

// ── Periodic recovery persistence ───────────────────────────────────────────

let _recoveryInterval: ReturnType<typeof setInterval> | null = null

function persistRecovery(session: Session): void {
  store.set('activeRecovery', {
    outputPath:      session.outputPath,
    videoOutputPath: session.videoOutputPath ?? undefined,
    segments:        session.segments,
    startTime:       session.startTime,
    sessionId:       session.sessionId,
    phase:           _phase,
    updatedAt:       Date.now(),
  })
}

function startRecoveryInterval(session: Session): void {
  clearRecoveryInterval()
  _recoveryInterval = setInterval(() => {
    if (activeSession?.sessionId === session.sessionId) {
      persistRecovery(session)
    }
  }, 30000)
}

function clearRecoveryInterval(): void {
  if (_recoveryInterval !== null) {
    clearInterval(_recoveryInterval)
    _recoveryInterval = null
  }
}

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
    logger.warn('recorder', `safeSend(${channel}) failed`, { msg: (err as Error).message })
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function isActive(): boolean {
  // Active means the session is doing useful work: starting, recording, or reconnecting.
  // stopping/finalizing are transient — they should not accept new startSession() calls.
  return _phase === 'starting' || _phase === 'recording' || _phase === 'reconnecting'
}

export function getActiveSessionOpts(): RecordingOpts | null {
  return activeSession?.settings ?? null
}

/**
 * Called by main/index.ts when the OS reports a power-resume. If a recording
 * was active during sleep, ffmpeg may be dead, hung, or healthy — we can't
 * tell from process state alone. Compute the wall-clock gap since the last
 * audio-progress event: > 90 s strongly implies the device was suspended,
 * so kick the reconnect watchdog with extra patience.
 *
 * This is the missing half of the watchdog story: stuckTimer triggers based
 * on its own setInterval clock, which doesn't advance during sleep. Without
 * this resume hook a recording-after-sleep would silently produce no audio
 * until the user noticed manually.
 */
export function notifyResumed(): void {
  const session = activeSession
  if (!session || session.stopping) return
  const gapMs = Date.now() - session.lastProgressAt
  // 90 s threshold — long enough to avoid false positives from brief CPU stalls,
  // short enough to catch real sleep periods quickly. OS sleep is typically
  // measured in minutes; CPU stalls are usually < 30 s.
  if (gapMs < 90_000) {
    logger.info('recorder', 'resume: progress was recent, no recovery needed', { gapMs })
    return
  }
  logger.warn('recorder', 'resume: long progress gap — assuming sleep, triggering reconnect', { gapMs })
  // Force-kill the (likely dead) ffmpeg process so handle.onExit fires and
  // doesn't compete with our manual watchdog trigger.
  try {
    const proc = session.handle.proc
    if (proc.exitCode === null && !proc.killed) {
      proc.kill('SIGKILL')
    }
  } catch (err) {
    logger.warn('recorder', 'resume: kill ffmpeg failed', { msg: (err as Error).message })
  }
  stopStuckTimer(session)
  // Give the watchdog a clean reconnect-counter window after sleep — pretend
  // we haven't burned attempts on whatever happened before the system slept.
  // Cap at 5 attempts so we don't loop forever on a bad device.
  session.reconnectCount = Math.max(0, session.reconnectCount - 5)
  startWatchdog(session)
}

// ── Pre-recording safety checks ──────────────────────────────────────────────

async function preflightCheck(settings: RecordingOpts, onWarn?: (msg: string) => void): Promise<{ error: string } | null> {
  // 1. ffmpeg binary must exist
  if (ffmpegBin !== 'ffmpeg' && !fs.existsSync(ffmpegBin)) {
    logger.error('recorder', 'ffmpeg binary not found', { path: ffmpegBin })
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

  // 3. Disk space: require at least 200 MB free for audio-only, 1 GB for video recordings.
  // fs.promises.statfs is a fast kernel syscall (no subprocess) supported on macOS, Windows,
  // and Linux. Replaces the old df/PowerShell approach which took 100–500 ms.
  try {
    const _s = settings as Settings
    const videoActive = _s.videoEnabled && (_s.videoDeviceName || _s.videoDeviceIndex != null)
    const stats = await fs.promises.statfs(folder)
    const freeBytes = stats.bavail * stats.bsize
    const minBytes = videoActive ? 1024 * 1024 * 1024 : 200 * 1024 * 1024
    if (freeBytes < minBytes) return { error: 'disk_full' }
  } catch (diskErr) {
    logger.warn('recorder', 'disk space check failed', { msg: (diskErr as Error).message })
    onWarn?.(`Disk space check failed: ${(diskErr as Error).message}`)
  }

  // 4. macOS: microphone (and camera if video is enabled) permission must be granted
  if (process.platform === 'darwin') {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone')
    if (micStatus === 'denied' || micStatus === 'restricted') {
      logger.error('recorder', 'microphone access denied', { status: micStatus })
      return { error: 'device_permission_denied' }
    }
    const _sc = settings as Settings
    if (_sc.videoEnabled && (_sc.videoDeviceName || _sc.videoDeviceIndex != null)) {
      const camStatus = systemPreferences.getMediaAccessStatus('camera')
      if (camStatus === 'denied' || camStatus === 'restricted') {
        logger.error('recorder', 'camera access denied', { status: camStatus })
        return { error: 'device_permission_denied' }
      }
    }
  }

  // 5. Verify the configured audio device is still attached. If the user has
  // explicitly selected a device (e.g. their USB mixer) but it is not present,
  // the resolver silently falls back to the first available device — which on
  // a laptop is the built-in mic. That would silently record the room ambience
  // instead of the mixer feed. Warn the user so they can investigate.
  const expectedName = (settings.deviceName ?? '').trim()
  if (expectedName) {
    try {
      const input = await resolveDeviceInput(settings)
      if (!input) {
        return { error: 'device_not_found' }
      }
      if (!isSameDevice(expectedName, input.resolvedName)) {
        const msg = `Lagret enhet "${expectedName}" ble ikke funnet. Tar opp fra "${input.resolvedName}" i stedet.`
        logger.warn('recorder', 'configured device missing, using fallback', { expected: expectedName, resolved: input.resolvedName })
        onWarn?.(msg)
      }
    } catch (err) {
      logger.warn('recorder', 'device probe failed (continuing)', { msg: (err as Error).message })
    }
  }

  return null
}

/** Case-insensitive, whitespace-collapsed device name comparison. */
function isSameDevice(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const na = norm(a)
  const nb = norm(b)
  if (na === nb) return true
  // Allow partial matches in either direction — ffmpeg device names sometimes
  // get suffixed/prefixed by the OS (e.g. "Microphone (USB Audio Device)").
  return na.includes(nb) || nb.includes(na)
}

export async function startSession(
  settings: RecordingOpts,
  win: BrowserWindow,
  prerollData?: { rawPath: string; trimMs: number } | null
): Promise<{ ok: true } | { error: string }> {
  if (activeSession || _phase === 'stopping' || _phase === 'finalizing') return { error: 'already_recording' }
  _phase = 'starting'

  const s = settings as Settings
  const hasVideo = !!(s.videoEnabled && (s.videoDeviceName || s.videoDeviceIndex != null))
  const prerollWasActive = preroll.isRunning()

  // Run preflight concurrently with device teardown: disk check and permission
  // checks don't require the device to be free, so we can overlap them.
  // On macOS we must still wait for AVFoundation to release device handles after
  // the process exits — without this gap the next spawn fails with "already in use".
  const teardown = Promise.all([
    preroll.stop(),
    hasVideo ? stopPreview() : Promise.resolve()
  ]).then(() => {
    if (process.platform !== 'darwin') return
    const releaseMs = prerollWasActive ? 250 : 150
    return new Promise<void>(resolve => setTimeout(resolve, releaseMs))
  })

  const [, preflightError] = await Promise.all([
    teardown,
    preflightCheck(settings, (msg) => {
      safeSend(win, 'backend-warning', { msg, severity: 'warn', category: 'disk' })
    }),
  ])
  if (preflightError) { _phase = 'idle'; return preflightError }

  const sessionId  = crypto.randomUUID()
  const filename   = buildFilename(settings)
  const folder     = settings.saveFolder ?? defaultFolder()
  const outputPath = await uniquePath(path.join(folder, filename))
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') {
      _phase = 'idle'; return { error: 'save_folder_permission' }
    }
    _phase = 'idle'; return { error: 'save_folder_error' }
  }

  // Determine video output path before starting captures
  let videoOutputPath: string | null = null
  if (hasVideo) {
    const audioExt  = path.extname(outputPath)
    const audioBase = outputPath.slice(0, -audioExt.length)
    // When split recording is active, force separate files (can't correctly
    // mux partial audio segments with a continuous video stream).
    const hasSplit    = !!(settings.splitMinutes && settings.splitMinutes > 0)
    const useSeparate = !!s.videoSeparate || hasSplit
    videoOutputPath   = useSeparate ? `${audioBase}_video.mp4` : `${audioBase}_vtmp.mp4`
  }

  // Start audio and video captures concurrently — both ffmpeg processes are
  // spawned within milliseconds of each other, aligning their wall-clock
  // timestamps and eliminating A/V sync drift in the combined MP4.
  const [audioResult, rawVideoResult] = await Promise.all([
    startCapture(settings, outputPath),
    hasVideo && videoOutputPath
      ? startVideoCapture(s, videoOutputPath)
      : Promise.resolve(null as null)
  ])

  if ('error' in audioResult) {
    if (rawVideoResult && !('error' in rawVideoResult)) {
      stopVideoCapture(rawVideoResult as VideoHandle).catch(() => {})
    }
    _phase = 'idle'; return { error: audioResult.error }
  }

  const handle = audioResult

  // ── Video capture (optional) ─────────────────────────────────────────────
  let videoHandle: VideoHandle | null = null

  if (rawVideoResult) {
    if ('error' in rawVideoResult) {
      logger.error('recorder', 'video capture failed to start', { error: rawVideoResult.error })
      safeSend(win, 'video-capture-error', { error: rawVideoResult.error })
      videoOutputPath = null
    } else {
      videoHandle = rawVideoResult
      videoHandle.onProgress = bytes => {
        if (activeSession?.sessionId === sessionId) {
          safeSend(win, 'video-progress', { bytes })
        }
      }
      videoHandle.onFrame = (frame: Buffer) => {
        if (activeSession?.sessionId === sessionId) {
          safeSend(win, 'video-preview-frame', frame)
        }
      }
      videoHandle.onExit = code => {
        if (code !== 0 && !activeSession?.stopping) {
          logger.warn('recorder', 'video ffmpeg died unexpectedly', { code })
          safeSend(win, 'video-capture-error', { error: 'died', code })
        }
      }
    }
  }

  _phase = 'recording'

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
    videoHandle, videoOutputPath,
  }

  // Persist recovery info so a crash restart can salvage the partial file
  persistRecovery(activeSession)
  // Refresh recovery every 30 s so stale-recovery detection stays current
  startRecoveryInterval(activeSession)

  // Auto-stop after maxMinutes if set
  if (settings.maxMinutes) {
    activeSession.maxTimer = setTimeout(() => stopSession(), settings.maxMinutes * 60000)
  }

  // Silence detection — ffmpeg silencedetect filter fires onSilenceEnd after sustained quiet
  handle.onSilenceEnd = () => {
    logger.info('recorder', 'silence timeout reached — stopping session')
    stopSession()
  }

  // Background silence warning — fires when no audio detected for ≥60 s, even
  // when stopOnSilence is off. Catches the "mixer was muted" case where the
  // recording would otherwise complete as a giant silent file with no warning.
  handle.onSilenceWarning = () => {
    logger.warn('recorder', 'prolonged silence detected — possible mute/disconnected mixer')
    safeSend(win, 'backend-warning', {
      msg:       'Ingen lyd registrert på over ett minutt. Sjekk at mikseren er på og at riktig kanal er valgt.',
      severity:  'warn',
      category:  'device',
    })
    // Notify renderer to surface the weak-signal toast (renderer may already be hidden)
    safeSend(win, 'recording-error', { error: 'weak_signal', message: 'Lavt signal — sjekk mikser/mikrofon.' })
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

  // Stuck detector: if no progress in 60 s while not stopping, trigger watchdog.
  // Also check byte progression — bytes not increasing despite time passing means
  // the encoder is hung (e.g. USB device stalled without closing the handle).
  installStuckTimer(activeSession, sessionId)

  // Watchdog — handles unexpected ffmpeg exit (USB disconnect, driver crash)
  handle.onExit = code => {
    if (!activeSession || activeSession.sessionId !== sessionId) return
    if (activeSession.stopping) {
      // finishSession is triggered by stopSession() via Promise.all — skip here
      stopStuckTimer(activeSession)
      return
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
  _phase = 'stopping'
  const session = activeSession
  session.stopping = true
  if (session.maxTimer)   clearTimeout(session.maxTimer)
  if (session.splitTimer) clearTimeout(session.splitTimer)
  stopStuckTimer(session)
  clearRecoveryInterval()

  const audioStop = stopCapture(session.handle)
  const videoStop = session.videoHandle
    ? stopVideoCapture(session.videoHandle)
    : Promise.resolve()

  Promise.all([audioStop, videoStop]).then(() => {
    finishSession(session)
  }).catch(err => {
    logger.error('recorder', 'stop error', { msg: String(err) })
    try { finishSession(session) } catch (e) { logger.error('recorder', 'finishSession error', { msg: String(e) }) }
  })
}

// ── Internal: finish a session after ffmpeg exits ───────────────────────────

function finishSession(session: Session): void {
  _phase = 'finalizing'
  if (activeSession?.sessionId === session.sessionId) activeSession = null
  stopStuckTimer(session)
  clearRecoveryInterval()
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
    logger.error('recorder', 'finishSessionAsync error', { msg: String(err) })
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
      logger.error('recorder', 'pre-roll concat failed — continuing without pre-roll', { msg: String(err) })
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
      logger.error('recorder', 'segment merge failed — adding individual segments to history', { count: session.segments.length })
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
      _phase = 'idle'
      notifyIdle()
      sessionEndCallback?.()
      return
    }
  }

  // Step 3: Video post-processing (mux or validate separate file)
  let videoFinalPath = session.videoOutputPath

  if (videoFinalPath) {
    const videoOk = fs.existsSync(videoFinalPath) && fs.statSync(videoFinalPath).size > 1_000_000
    if (!videoOk) {
      logger.warn('recorder', 'video file missing or too small — skipping video', { path: videoFinalPath })
      if (videoFinalPath && fs.existsSync(videoFinalPath)) fs.promises.unlink(videoFinalPath).catch(() => {})
      videoFinalPath = null
    }
  }

  if (videoFinalPath && !(session.settings as Settings).videoSeparate && !session.splitAutoRestart) {
    // Combined mode: mux audio + video → one MP4
    const audioExt  = path.extname(session.outputPath)
    const audioBase = session.outputPath.slice(0, -audioExt.length)
    // Use uniquePath to avoid overwriting an existing .mp4 if one already exists with the same base name
    const combinedPath = await uniquePath(`${audioBase}.mp4`)
    logger.info('recorder', 'muxing audio + video', { output: path.basename(combinedPath) })
    const muxOk = await muxAudioVideo(session.outputPath, videoFinalPath, combinedPath)
    if (muxOk) {
      fs.promises.unlink(videoFinalPath).catch(() => {})  // delete temp raw video
      videoFinalPath = combinedPath
      // When the user explicitly opts out of a separate audio file, delete it now
      // that the audio is embedded in the combined MP4. Default is to keep it.
      if ((session.settings as Settings).videoKeepAudio === false) {
        fs.promises.unlink(session.outputPath).catch(() => {})
      }
    } else {
      logger.error('recorder', 'mux failed — keeping separate files')
      // videoFinalPath stays as-is (the raw video), treated as separate file
    }
  } else if (videoFinalPath && session.splitAutoRestart && videoFinalPath.endsWith('_vtmp.mp4')) {
    // Split auto-restart: mux was skipped — rename vtmp to a proper segment name for history
    const segmentVideoPath = videoFinalPath.replace('_vtmp.mp4', `_video_${Date.now()}.mp4`)
    try {
      fs.renameSync(videoFinalPath, segmentVideoPath)
      videoFinalPath = segmentVideoPath
      logger.info('recorder', 'vtmp renamed to segment video', { name: path.basename(segmentVideoPath) })
    } catch (err) {
      logger.warn('recorder', 'vtmp rename failed', { msg: String(err) })
    }
  }

  // Step 4: Audio history entry (skip if audio file was deleted after mux)
  const audioFileKept = (session.settings as Settings).videoKeepAudio !== false
    || !(videoFinalPath)  // always keep entry when no video was recorded
    || !!(session.settings as Settings).videoSeparate  // always keep in separate-files mode

  // Get actual file size from disk
  let audioFileSizeBytes: number | undefined
  try { audioFileSizeBytes = fs.statSync(session.outputPath).size } catch {}

  const entry: RecordingEntry = {
    date:          localDateStr(recDate),
    startTime:     recDate.toTimeString().slice(0, 5),
    duration:      formatDuration(durationSec),
    filename:      path.basename(session.outputPath),
    path:          session.outputPath,
    status:        'ok',
    durationSec,
    fileSizeBytes: audioFileSizeBytes,
  }
  if (audioFileKept) store.addHistory(entry)

  // Step 5: Video history entry (if any)
  if (videoFinalPath && fs.existsSync(videoFinalPath)) {
    let videoFileSizeBytes: number | undefined
    try { videoFileSizeBytes = fs.statSync(videoFinalPath).size } catch {}
    const videoEntry: RecordingEntry = {
      date:          localDateStr(recDate),
      startTime:     recDate.toTimeString().slice(0, 5),
      duration:      formatDuration(durationSec),
      filename:      path.basename(videoFinalPath),
      path:          videoFinalPath,
      status:        'ok',
      note:          'Video',
      durationSec,
      fileSizeBytes: videoFileSizeBytes,
    }
    store.addHistory(videoEntry)
    safeSend(session.win, 'recording-finished', videoEntry)
  }

  // Cloud auto-upload — enqueues per configured service; the queue handles
  // retries, backoff, and pausing during the next recording.
  import('./cloud').then(c => c.autoUploadAfterRecording(session.outputPath, session.win)).catch(err =>
    logger.error('recorder', 'cloud upload error', { msg: String(err) })
  )

  // Split auto-restart: start new session in main, send overlay events to renderer
  if (session.splitAutoRestart) {
    const ts       = new Date().toTimeString().slice(0, 5).replace(':', '')
    const nextOpts = { ...session.settings, splitTimestamp: ts }

    if (store.get('notifyStop') !== false) {
      notify('SundayRec', `${getNL().done}: ${path.basename(session.outputPath)}`)
    }

    // Stop renderer monitoring, notify history, then start new session.
    // Reset phase BEFORE calling startSession — otherwise the guard at the top
    // of startSession sees _phase === 'finalizing' and rejects with
    // 'already_recording', silently skipping the split-restart.
    safeSend(session.win, 'recording-overlay-stop', {})
    safeSend(session.win, 'recording-finished', { ...entry, splitRestart: true })
    _phase = 'idle'

    const nextResult = await startSession(nextOpts, session.win)
    if ('ok' in nextResult) {
      safeSend(session.win, 'recording-overlay-start', nextOpts)
      // _phase is now 'recording' — set by the new startSession call
    } else {
      const msg = localizeError(nextResult.error)
      safeSend(session.win, 'recording-error', { error: nextResult.error, message: msg })
      notify(getNL().err, msg)
      _phase = 'idle'
      notifyIdle()
      sessionEndCallback?.()
    }
    return
  }

  if (audioFileKept) safeSend(session.win, 'recording-finished', entry)

  const doneFile = audioFileKept ? session.outputPath : (videoFinalPath ?? session.outputPath)
  if (store.get('notifyStop') !== false) {
    notify('SundayRec', `${getNL().done}: ${path.basename(doneFile)}`)
  }

  // Prep-and-review pipeline (v5.0). Kicks off in the background — never
  // blocks the recorder. Triggers only when the user has podcast publishing
  // enabled AND has not explicitly disabled autoPrepEnabled.
  const settingsForPrep = store.getAll() as Settings & {
    podcast?: { enabled?: boolean; autoPrepEnabled?: boolean }
  }
  const podcastOn = settingsForPrep.podcast?.enabled === true
  const autoPrepOn = settingsForPrep.podcast?.autoPrepEnabled !== false   // default true when podcast on
  if (audioFileKept && podcastOn && autoPrepOn && session.outputPath) {
    void import('./prep-episode').then(p =>
      p.prepEpisodeAsync(session.outputPath, session.win),
    ).catch(err =>
      logger.warn('recorder', 'prepEpisode_failed', { error: (err as Error).message }),
    )
  }

  _phase = 'idle'
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
      proc.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-8192) })
      proc.on('close', code => {
        if (code === 0) resolve()
        else reject(new Error(`pre-roll encode failed (${code}): ${stderr.slice(-500)}`))
      })
    })

    // Step 2: Concat encoded pre-roll + main recording (lossless copy)
    const escPath = (p: string) => {
      const normalized = process.platform === 'win32' ? p.replace(/\\/g, '/') : p
      // ffmpeg concat format uses backslash-escaping inside single-quoted paths (not the POSIX shell trick)
      return normalized.replace(/'/g, "\\'")
    }
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
      proc.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-8192) })
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

    logger.info('recorder', 'pre-roll prepended', { trimSec: (trimMs / 1000).toFixed(1), to: path.basename(mainPath) })
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
    const escPath = (p: string) => {
      const normalized = process.platform === 'win32' ? p.replace(/\\/g, '/') : p
      return normalized.replace(/'/g, "\\'")
    }
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
      proc.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-8192) })
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

    logger.info('recorder', 'merged reconnect segments', { count: segments.length, output: path.basename(targetPath) })
    return true
  } catch (err) {
    logger.error('recorder', 'mergeSegments failed', { msg: String(err) })
    fs.promises.unlink(tempPath).catch(() => {})
    return false
  } finally {
    fs.promises.unlink(concatList).catch(() => {})
  }
}

// ── Watchdog: reconnect after unexpected ffmpeg death ───────────────────────

/** Install a 15-s polling stuck-timer on the session. Shared between the initial
 *  spawn and the reconnect path so both branches detect hung encoders identically. */
function installStuckTimer(session: Session, sessionId: string): void {
  let lastBytesSnapshot = 0
  session.stuckTimer = setInterval(() => {
    const s = activeSession
    if (!s || s.sessionId !== sessionId || s.stopping) return
    const currentBytes = s.handle.bytesWritten ?? 0
    if (Date.now() - s.lastProgressAt > 60000) {
      logger.warn('recorder', 'no audio progress for 60 s — treating as device failure')
      stopStuckTimer(s)
      startWatchdog(s)
    } else if (currentBytes > 0 && currentBytes === lastBytesSnapshot) {
      logger.warn('recorder', 'bytes not progressing — possible encoder hang', { bytes: currentBytes })
      stopStuckTimer(s)
      startWatchdog(s)
    } else {
      lastBytesSnapshot = currentBytes
    }
  }, 15000)
}

// 20 attempts with exponential backoff capped at 10 s: gives ~3 min total
// window. Sized for the "pastor snubled in USB cable" scenario — long enough
// to find and reconnect the cable, short enough to give up on a truly-dead
// device before the whole service is wasted. The cap stops the watchdog from
// snowballing into multi-minute delays between attempts.
// Exported for tests so the invariant (20 attempts, 10s cap) can be verified.
export const MAX_RECONNECT_ATTEMPTS = 20

// Exported for tests. Pure function — output depends only on `attempt`.
export function reconnectDelay(attempt: number): number {
  return Math.min(2000 + attempt * 1500, 10000)
}

// Errors that won't be fixed by retrying — bail out immediately rather than
// burn 10 reconnect attempts. The user needs to see the real reason now.
// Exported for tests so the fatal-error allowlist can be asserted directly.
export const FATAL_RECONNECT_ERRORS = new Set([
  'disk_full',
  'device_permission_denied',
  'ffmpeg_missing',
  'no_device',
])

function startWatchdog(session: Session): void {
  // If the last ffmpeg exit was classified as a fatal condition, retrying is
  // pointless — disk will still be full, permission still denied, etc.
  const lastErr = session.handle.lastError
  if (lastErr && FATAL_RECONNECT_ERRORS.has(lastErr)) {
    logger.warn('recorder', 'fatal error — skipping reconnect', { error: lastErr })
    failSession(session, lastErr)
    return
  }

  if (session.reconnectCount >= MAX_RECONNECT_ATTEMPTS) {
    failSession(session, lastErr ?? 'device_disconnected')
    return
  }

  _phase = 'reconnecting'
  stopStuckTimer(session)
  safeSend(session.win, 'recording-reconnecting', {})
  logger.warn('recorder', 'ffmpeg died unexpectedly — starting reconnect watchdog', { lastError: lastErr ?? 'unknown' })

  let attempts = 0
  const tryReconnect = async () => {
    if (!activeSession || activeSession.sessionId !== session.sessionId) return
    if (attempts >= MAX_RECONNECT_ATTEMPTS) {
      failSession(session, 'device_disconnected')
      return
    }
    attempts++
    session.reconnectCount++
    logger.info('recorder', `reconnect attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS}`)

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
    _phase = 'recording'
    logger.info('recorder', 'reconnected', { segment: path.basename(newPath) })
    session.outputPath     = newPath
    session.handle         = result
    session.startTime      = result.startTime
    session.lastProgressAt = Date.now()
    session.segments.push(newPath)
    persistRecovery(session)
    startRecoveryInterval(session)

    // Restart video capture if it was active (stop old handle first, then start new one)
    if (session.videoHandle) {
      try { await stopVideoCapture(session.videoHandle) } catch {}
      session.videoHandle = null

      const audioExt = path.extname(newPath)
      const audioBase = newPath.slice(0, -audioExt.length)
      const newVideoPath = `${audioBase}_video_${Date.now()}.mp4`

      const videoResult = await startVideoCapture(session.settings as Settings, newVideoPath)
      if ('error' in videoResult) {
        logger.warn('recorder', 'video restart after reconnect failed', { error: videoResult.error })
        session.videoOutputPath = null
      } else {
        session.videoHandle     = videoResult
        session.videoOutputPath = newVideoPath
        videoResult.onFrame = (frame: Buffer) => {
          if (activeSession?.sessionId === session.sessionId) {
            safeSend(session.win, 'video-preview-frame', frame)
          }
        }
        videoResult.onProgress = (bytes: number) => {
          if (activeSession?.sessionId === session.sessionId) {
            safeSend(session.win, 'video-progress', { bytes })
          }
        }
        videoResult.onExit = (code) => {
          if (code !== 0 && !activeSession?.stopping) {
            logger.warn('recorder', 'video ffmpeg died after reconnect', { code })
            safeSend(session.win, 'video-capture-error', { error: 'died', code })
          }
        }
        logger.info('recorder', 'video restarted after audio reconnect', { path: path.basename(newVideoPath) })
      }
    }

    result.onProgress = bytes => {
      if (activeSession?.sessionId === session.sessionId) session.lastProgressAt = Date.now()
      safeSend(session.win, 'recording-progress', { bytes })
    }
    result.onExit = code => {
      if (!activeSession || activeSession.sessionId !== session.sessionId) return
      if (session.stopping || code === 0) { stopStuckTimer(session); finishSession(session) }
      else startWatchdog(session)
    }

    // Restart stuck detector for new segment — use the shared helper so the
    // reconnected path detects bytes-not-progressing the same way the initial
    // path does (previously only the time-based check ran on reconnect).
    installStuckTimer(session, session.sessionId)

    safeSend(session.win, 'recording-reconnected', {})
    notify('SundayRec', getNL().reconnected)
  }

  setTimeout(tryReconnect, reconnectDelay(0))
}

function failSession(session: Session, reason: string): void {
  _phase = 'idle'
  if (activeSession?.sessionId === session.sessionId) activeSession = null
  stopStuckTimer(session)
  clearRecoveryInterval()
  stopBlockers()

  // Preserve any partial segments that hit disk before the failure. Without
  // this, a 90-minute recording cut short by a permanent USB-disconnect ends
  // up entirely absent from history — even though most of it is intact on the
  // file system. Walk segments[] and add history entries for any file > 5 KB
  // so the user can find the partial recording in the editor.
  const recDate = new Date(session.sessionStartTime)
  let salvaged = 0
  for (const segPath of session.segments) {
    try {
      if (!fs.existsSync(segPath)) continue
      const stat = fs.statSync(segPath)
      if (stat.size < 5000) continue
      const segDurSec = Math.max(0, Math.round((stat.mtimeMs - session.sessionStartTime) / 1000))
      store.addHistory({
        date:          localDateStr(recDate),
        startTime:     recDate.toTimeString().slice(0, 5),
        duration:      formatDuration(segDurSec),
        filename:      path.basename(segPath),
        path:          segPath,
        status:        'error',
        error:         reason,
        note:          'Avbrutt opptak — delfil bevart',
        durationSec:   segDurSec,
        fileSizeBytes: stat.size,
      })
      salvaged++
    } catch (err) {
      logger.warn('recorder', 'failSession segment scan failed', {
        path: segPath, msg: (err as Error).message,
      })
    }
  }
  if (salvaged > 0) {
    logger.info('recorder', 'failSession salvaged partial segments', { count: salvaged, reason })
  }

  // Clear recovery AFTER segments are added so a crash during failSession's
  // history writes can still be recovered next launch.
  store.set('activeRecovery', null)

  // Clean up any orphaned pre-roll temp file
  if (session.prerollRaw) fs.promises.unlink(session.prerollRaw).catch(() => {})

  const nl = getNL()
  const localizedReason = localizeError(reason)
  safeSend(session.win, 'recording-error', { error: reason, message: localizedReason })
  // Also surface as backend-warning with device category (reconnect gave up)
  safeSend(session.win, 'backend-warning', { msg: localizedReason, severity: 'error', category: 'device' })
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

  // If the crashed session had reconnect-segments, restore each that still
  // exists as its own history entry before remuxing the primary file. Merging
  // them with ffmpeg after a crash would require all segments to be intact
  // AND identically-encoded; partial-on-disk segments are too risky to concat
  // automatically. Surfacing each segment in history lets the user open and
  // merge them manually in the editor.
  const segments = Array.isArray((recovery as { segments?: string[] }).segments)
    ? (recovery as { segments: string[] }).segments
    : []
  const extraSegments = segments.filter(p => p && p !== filePath && fs.existsSync(p))
  for (const seg of extraSegments) {
    try {
      const segStat = fs.statSync(seg)
      if (segStat.size < 5000) { unlinkSilent(seg); continue }
      const segDate = new Date(recovery.startTime)
      store.addHistory({
        date:      localDateStr(segDate),
        startTime: segDate.toTimeString().slice(0, 5),
        duration:  '—',
        filename:  path.basename(seg),
        path:      seg,
        status:    'ok',
        note:      'Gjenopprettet (delfil)',
      })
    } catch (err) {
      logger.warn('recorder', 'recovery segment scan failed', { msg: (err as Error).message })
    }
  }

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
      logger.error('recorder', 'recovery remux failed', { file: path.basename(filePath) })
      try {
        fs.renameSync(filePath, out)
        notify('SundayRec', getNL().recovered.replace('{file}', path.basename(out)))
      } catch (err) {
        // Both remux AND rename failed — partial file is unrecoverable. Surface
        // this so the user at least sees something in the logs to investigate.
        logger.error('recorder', 'recovery rename also failed — partial file abandoned', {
          file: path.basename(filePath),
          msg: (err as Error).message
        })
      }
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
    logger.error('recorder', 'unlink failed', { msg: String(err) })
  })
}

function defaultFolder(): string {
  return path.join(app.getPath('documents'), 'SundayRec')
}

