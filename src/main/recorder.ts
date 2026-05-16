/**
 * Recorder — main process side.
 *
 * The actual MediaRecorder lives in the renderer (Chromium) so it has
 * access to getUserMedia. Main orchestrates start/stop, receives audio
 * chunks via IPC, writes a temp file, then runs ffmpeg for conversion.
 *
 * Crash recovery: on startSession we persist the temp file path to the
 * store. If the app crashes and restarts, main can find the partial
 * file and attempt to salvage it via ffmpeg.
 */

import path from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import { ipcMain, app, Notification, powerSaveBlocker } from 'electron'
import type { BrowserWindow } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import ffmpeg from 'fluent-ffmpeg'
import * as store from './store'
import * as tray from './tray'
import * as mailer from './mailer'
import { localDateStr, buildFilename, codecFor, formatDuration } from './recorder-utils'
import type { RecordingOpts, RecordingEntry, Settings } from '../types'

export const NOTIFY_LABELS: Record<string, { done: string; err: string; recovered: string }> = {
  no: { done: 'Fullført',      err: 'SundayRec — Feil',    recovered: 'Opptak gjenopprettet: {file}' },
  en: { done: 'Completed',     err: 'SundayRec — Error',   recovered: 'Recording recovered: {file}'  },
  de: { done: 'Abgeschlossen', err: 'SundayRec — Fehler',  recovered: 'Aufnahme wiederhergestellt: {file}' },
  sv: { done: 'Klar',          err: 'SundayRec — Fel',     recovered: 'Inspelning återställd: {file}' },
  da: { done: 'Fuldført',      err: 'SundayRec — Fejl',    recovered: 'Optagelse gendannet: {file}'  },
  pl: { done: 'Ukończono',     err: 'SundayRec — Błąd',    recovered: 'Nagranie odzyskane: {file}'   },
  fr: { done: 'Terminé',       err: 'SundayRec — Erreur',  recovered: 'Enregistrement récupéré : {file}' },
}

let ffmpegPath = ffmpegStatic as string
if (app.isPackaged) {
  ffmpegPath = ffmpegPath.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
}
ffmpeg.setFfmpegPath(ffmpegPath)

interface Session {
  settings: RecordingOpts
  tempPath: string
  sessionId: string
  writeStream: fs.WriteStream
  startTime: number | null
  confirmed: boolean
  win: BrowserWindow
  maxTimer: ReturnType<typeof setTimeout> | null
}

let activeSession: Session | null = null
let recBlocker: number | null = null
let idleCallback: (() => void) | null = null

export function onceIdle(cb: () => void): void {
  idleCallback = cb
}

function notifyIdle(): void {
  const cb = idleCallback
  idleCallback = null
  cb?.()
}

export function init(): void {
  ipcMain.on('audio-chunk', (_, chunk: ArrayBuffer) => {
    activeSession?.writeStream.write(Buffer.from(chunk))
  })

  ipcMain.on('recording-confirmed-start', (_, data: { startTime: number }) => {
    if (!activeSession) return
    activeSession.confirmed = true
    activeSession.startTime = data.startTime || Date.now()
  })

  ipcMain.on('recording-chunks-done', () => {
    if (activeSession) finishSession()
  })
}

export function startSession(settings: RecordingOpts, win: BrowserWindow): { ok: true } | { error: string } {
  if (activeSession) return { error: 'already_recording' }

  const sessionId = crypto.randomUUID()
  const tempPath  = path.join(os.tmpdir(), `sundayrec-${sessionId}.webm`)
  const writeStream = fs.createWriteStream(tempPath)

  activeSession = { settings, tempPath, sessionId, writeStream, startTime: null, confirmed: false, win, maxTimer: null }

  // Persist recovery info so a crash restart can find the partial file
  store.set('activeRecovery', { tempPath, startTime: Date.now(), sessionId })

  if (settings.maxMinutes) {
    activeSession.maxTimer = setTimeout(() => stopSession(), settings.maxMinutes * 60000)
  }

  if (recBlocker === null || !powerSaveBlocker.isStarted(recBlocker)) {
    recBlocker = powerSaveBlocker.start('prevent-app-suspension')
  }

  return { ok: true }
}

export function stopSession(): void {
  if (!activeSession) return
  const { win, confirmed } = activeSession

  if (!confirmed) {
    const session = activeSession
    activeSession = null
    if (session.maxTimer) clearTimeout(session.maxTimer)
    session.writeStream.end()
    setTimeout(() => unlinkTemp(session.tempPath), 100)
    store.set('activeRecovery', null)
    stopRecBlocker()
    notifyIdle()
    return
  }

  win.webContents.send('stop-media-recorder')
}

function stopRecBlocker(): void {
  if (recBlocker !== null && powerSaveBlocker.isStarted(recBlocker)) {
    powerSaveBlocker.stop(recBlocker)
  }
  recBlocker = null
}

function finishSession(): void {
  if (!activeSession) return
  const session = activeSession
  activeSession = null
  if (session.maxTimer) clearTimeout(session.maxTimer)
  stopRecBlocker()
  store.set('activeRecovery', null)
  session.writeStream.end(() => convertAndSave(session))
}

async function uniquePath(p: string): Promise<string> {
  try { await fs.promises.access(p) } catch { return p }
  const ext  = path.extname(p)
  const base = p.slice(0, -ext.length)
  for (let i = 2; i < 10000; i++) {
    const candidate = `${base}_${i}${ext}`
    try { await fs.promises.access(candidate) } catch { return candidate }
  }
  return `${base}_${Date.now()}${ext}`
}

async function convertAndSave(session: Session): Promise<void> {
  const { settings, tempPath, startTime } = session
  const durationSec = startTime ? Math.round((Date.now() - startTime) / 1000) : 0
  const filename    = buildFilename(settings, startTime ?? undefined)
  const outputPath  = await uniquePath(path.join(settings.saveFolder || defaultFolder(), filename))

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  const cmd = ffmpeg(tempPath)
    .audioCodec(codecFor(settings.format ?? 'mp3'))
    .audioChannels(settings.channels === 'stereo' ? 2 : 1)
    .audioFrequency(settings.sampleRate ?? 48000)

  const bitrateStr = String(settings.bitrate ?? '192').replace(/k$/i, '')
  if (settings.format === 'mp3') cmd.audioBitrate(bitrateStr + 'k')
  if (settings.format === 'aac') cmd.audioBitrate(bitrateStr + 'k')

  cmd
    .output(outputPath)
    .on('end', () => {
      unlinkTemp(tempPath)
      const recDate = new Date(session.startTime ?? Date.now())
      const entry: RecordingEntry = {
        date:      localDateStr(recDate),
        startTime: recDate.toTimeString().slice(0, 5),
        duration:  formatDuration(durationSec),
        filename:  path.basename(outputPath),
        path:      outputPath,
        status:    'ok'
      }
      store.addHistory(entry)
      session.win.webContents.send('recording-finished', entry)
      const allSettings = store.getAll()
      if (allSettings.notifyStop !== false) {
        const nl = NOTIFY_LABELS[allSettings.language ?? 'no'] ?? NOTIFY_LABELS.no
        notify('SundayRec', `${nl.done}: ${filename}`)
      }
      notifyIdle()
    })
    .on('error', (err) => {
      unlinkTemp(tempPath)
      const entry: RecordingEntry = {
        date:      localDateStr(new Date()),
        startTime: new Date(session.startTime ?? Date.now()).toTimeString().slice(0, 5),
        duration:  '—',
        filename:  '—',
        status:    'error',
        error:     err.message
      }
      store.addHistory(entry)
      session.win.webContents.send('recording-error', { error: err.message })
      tray.setRecording(false)
      tray.setError(true)
      const allSettings = store.getAll()
      const nl = NOTIFY_LABELS[allSettings.language ?? 'no'] ?? NOTIFY_LABELS.no
      notify(nl.err, err.message)
      if (allSettings.emailOnError) mailer.sendError(allSettings, store.getSmtpPassword(), err.message)
      notifyIdle()
    })
    .run()
}

export function recoverCrashedSession(): void {
  const recovery = store.get('activeRecovery')
  if (!recovery) return

  store.set('activeRecovery', null)

  if (!fs.existsSync(recovery.tempPath)) return

  const stat = fs.statSync(recovery.tempPath)
  if (stat.size < 10000) {
    unlinkTemp(recovery.tempPath)
    return
  }

  const s = store.getAll()
  const fmt = s.format ?? 'mp3'
  const folder = s.saveFolder ?? defaultFolder()
  const dateStr = localDateStr(new Date())
  let outputPath = path.join(folder, `recovered_${dateStr}.${fmt}`)
  for (let suffix = 2; fs.existsSync(outputPath) && suffix < 10000; suffix++) {
    outputPath = path.join(folder, `recovered_${dateStr}_${suffix}.${fmt}`)
  }
  if (fs.existsSync(outputPath)) {
    outputPath = path.join(folder, `recovered_${dateStr}_${Date.now()}.${fmt}`)
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  const cmd = ffmpeg(recovery.tempPath)
    .audioCodec(codecFor(fmt))
    .audioChannels(s.channels === 'stereo' ? 2 : 1)
    .audioFrequency(s.sampleRate ?? 48000)

  if (fmt === 'mp3' || fmt === 'aac') {
    const br = String(s.bitrate ?? '192').replace(/k$/i, '')
    cmd.audioBitrate(br + 'k')
  }

  cmd
    .output(outputPath)
    .on('end', () => {
      unlinkTemp(recovery.tempPath)
      const durationSec = Math.round((Date.now() - recovery.startTime) / 1000)
      const recDate = new Date(recovery.startTime)
      store.addHistory({
        date:      localDateStr(recDate),
        startTime: recDate.toTimeString().slice(0, 5),
        duration:  formatDuration(durationSec),
        filename:  path.basename(outputPath),
        path:      outputPath,
        status:    'ok'
      })
      const lang = store.getAll().language ?? 'no'
      const nl = NOTIFY_LABELS[lang] ?? NOTIFY_LABELS.no
      notify('SundayRec', nl.recovered.replace('{file}', path.basename(outputPath)))
    })
    .on('error', () => unlinkTemp(recovery.tempPath))
    .run()
}

function unlinkTemp(p: string): void {
  fs.promises.unlink(p).catch(err => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Failed to delete temp file:', err)
  })
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show()
}

function defaultFolder(): string {
  return path.join(app.getPath('documents'), 'SundayRec')
}

export function isActive(): boolean {
  return activeSession !== null && activeSession.confirmed
}
