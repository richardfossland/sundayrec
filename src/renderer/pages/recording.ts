/**
 * Recording session — overlay, MediaRecorder lifecycle, silence detection,
 * hourly split, scheduled stop countdown.
 */
import { t } from '../i18n'
import { settings } from '../state'
import { startCapture, stopCapture, getAudioDevices, reconnectStream } from '../audio/capture'
import type { CaptureSession } from '../audio/capture'
import { makeVuState, tickVU, stopVuState } from '../audio/vu'
import { fmtCountdown, flashMsg, isoDate } from '../helpers'
import { stopVU as stopHomeVU } from './home-vu'
import { stopMonitoring } from './audio-page'
import { loadRecentHistory } from './home'
import type { RecordingOpts } from '../../types'

let activeSession: CaptureSession | null = null
let silenceInterval: ReturnType<typeof setInterval> | null = null
let splitTimer:      ReturnType<typeof setTimeout>  | null = null
let recTimerIval:    ReturnType<typeof setInterval> | null = null
let autoRestartOpts: RecordingOpts | null = null
export let isRecording = false

let scheduledStop:   Date | null = null
let stopOverridden   = false
let schedStopTimer:  ReturnType<typeof setTimeout>  | null = null
let schedCntTimer:   ReturnType<typeof setInterval> | null = null

const recVu = makeVuState()

export function setupRecording(): void {
  document.getElementById('btn-start-recording')?.addEventListener('click', () => {
    if (isRecording) {
      const protect = settings.protectRecording !== false
      if (protect) {
        const m = document.getElementById('modal-confirm-stop'); if (m) m.style.display = 'flex'
      } else {
        doStopRecording()
      }
    } else {
      openManualModal()
    }
  })

  document.getElementById('btn-stop-overlay')?.addEventListener('click', () => {
    if (settings.protectRecording !== false) {
      const m = document.getElementById('modal-confirm-stop'); if (m) m.style.display = 'flex'
    } else {
      doStopRecording()
    }
  })

  document.getElementById('btn-confirm-stop')?.addEventListener('click', () => {
    const m = document.getElementById('modal-confirm-stop'); if (m) m.style.display = 'none'
    doStopRecording()
  })

  document.getElementById('btn-confirm-cancel')?.addEventListener('click', () => {
    const m = document.getElementById('modal-confirm-stop'); if (m) m.style.display = 'none'
  })

  document.getElementById('btn-manual-cancel')?.addEventListener('click', () => {
    const m = document.getElementById('modal-manual'); if (m) m.style.display = 'none'
  })

  document.getElementById('btn-manual-start')?.addEventListener('click', handleManualStart)

  document.getElementById('btn-extend-30')?.addEventListener('click', () => {
    stopOverridden = true
    scheduledStop  = new Date(Date.now() + 30 * 60000)
    if (schedStopTimer) clearTimeout(schedStopTimer)
    schedStopTimer = setTimeout(() => { if (isRecording) doStopRecording() }, 30 * 60000)
    updateScheduledStopCountdown()
  })

  document.getElementById('btn-cancel-autostop')?.addEventListener('click', () => {
    stopOverridden = true; scheduledStop = null
    if (schedStopTimer)  { clearTimeout(schedStopTimer);  schedStopTimer  = null }
    if (schedCntTimer)   { clearInterval(schedCntTimer);  schedCntTimer   = null }
    const s = document.getElementById('rec-autostop')
    if (s) s.style.display = 'none'
  })

  // IPC from main / scheduler — store cleanup fns so listeners don't stack on hot reload
  const ipcCleanups = [
    window.api.on('schedule-start-recording', (opts) => startRecordingWithOpts(opts as RecordingOpts)),
    window.api.on('schedule-stop-recording',  () => { if (!stopOverridden) doStopRecording() }),
    window.api.on('stop-media-recorder',      async () => { await stopMediaRecorder(); hideOverlay() }),
    window.api.on('recording-finished', () => {
      hideOverlay()
      loadRecentHistory()
      if (autoRestartOpts) {
        const opts = autoRestartOpts; autoRestartOpts = null
        setTimeout(() => startRecordingWithOpts(opts), 1000)
      }
    }),
    window.api.on('recording-error', () => {
      hideOverlay()
      loadRecentHistory()
    }),
    window.api.on('tray-start-recording', () => openManualModal()),
    window.api.on('tray-stop-recording',  () => doStopRecording()),
  ]
  window.addEventListener('beforeunload', () => ipcCleanups.forEach(fn => fn?.()))
}

async function openManualModal(): Promise<void> {
  const modal = document.getElementById('modal-manual')
  if (!modal) return
  modal.style.display = 'flex'
  const nameEl  = document.getElementById('manual-filename') as HTMLInputElement | null
  if (nameEl) nameEl.value = ''
  const devSel  = document.getElementById('manual-device') as HTMLSelectElement | null
  const devices = await getAudioDevices()
  if (devSel) {
    devSel.replaceChildren(...devices.map(d => {
      const opt = document.createElement('option')
      opt.value = d.deviceId
      opt.textContent = d.label || d.deviceId
      return opt
    }))
    if (settings.deviceId) {
      devSel.value = settings.deviceId
      if (!devSel.value && devices.length) devSel.selectedIndex = 0
    }
  }
}

async function handleManualStart(): Promise<void> {
  const btn = document.getElementById('btn-manual-start') as HTMLButtonElement | null
  if (btn) btn.disabled = true

  const devSel  = document.getElementById('manual-device')  as HTMLSelectElement | null
  const nameEl  = document.getElementById('manual-filename') as HTMLInputElement  | null
  const deviceId = devSel?.value ?? settings.deviceId ?? null

  // Look up per-device channel settings
  const devChannels = deviceId ? (settings.deviceChannels?.[deviceId] ?? null) : null

  const opts: RecordingOpts = {
    ...settings,
    deviceId,
    customName:    nameEl?.value.trim() ?? '',
    channelL:      devChannels?.channelL ?? 0,
    channelR:      devChannels?.channelR ?? 1
  }
  const mm = document.getElementById('modal-manual'); if (mm) mm.style.display = 'none'

  const res = await window.api.startRecordingNow(opts)
  if (res?.ok) {
    showOverlay(opts)
    try { await startMediaRecorder(opts) }
    catch (err) {
      await stopMediaRecorder()
      window.api.notifyError({ error: (err as Error).message })
      await window.api.stopRecordingNow()
      hideOverlay()
    }
  } else {
    flashMsg(
      document.getElementById('btn-manual-start'),
      '✕ ' + (res?.error ?? t('general.unknownError', 'ukjent feil')),
      false
    )
  }
  if (btn) btn.disabled = false
}

export async function startRecordingWithOpts(opts: RecordingOpts): Promise<void> {
  const res = await window.api.startRecordingNow(opts)
  if (!res?.ok) return
  showOverlay(opts)
  try { await startMediaRecorder(opts) }
  catch (err) {
    autoRestartOpts = null
    await stopMediaRecorder()
    window.api.notifyError({ error: (err as Error).message })
    await window.api.stopRecordingNow()
    hideOverlay()
  }
}

async function startMediaRecorder(opts: RecordingOpts): Promise<void> {
  stopHomeVU()
  stopMonitoring()

  // Resolve per-device channels if not already set in opts
  const deviceId  = opts.deviceId ?? settings.deviceId ?? null
  const devChannels = deviceId ? (settings.deviceChannels?.[deviceId] ?? null) : null
  const resolvedOpts: RecordingOpts = {
    ...opts,
    channelL: opts.channelL ?? devChannels?.channelL ?? 0,
    channelR: opts.channelR ?? devChannels?.channelR ?? 1
  }

  activeSession = await startCapture(resolvedOpts)

  // Detect USB disconnect mid-recording — retry for 10 seconds before giving up
  attachDisconnectHandler(activeSession, opts)

  // Connect recording VU
  const vuL   = document.getElementById('rec-vu-l')
  const vuPkL = document.getElementById('rec-vu-peak-l')
  const vuDbL = document.getElementById('rec-vu-db-l')
  const vuR   = document.getElementById('rec-vu-r')
  const vuPkR = document.getElementById('rec-vu-peak-r')
  const vuDbR = document.getElementById('rec-vu-db-r')
  const cL    = document.getElementById('rec-vu-clip-l')
  const cR    = document.getElementById('rec-vu-clip-r')

  Object.assign(recVu, {
    analyserL: activeSession.vuAnalyserL,
    analyserR: activeSession.vuAnalyserR
  })

  tickVU(recVu, vuL, vuPkL, vuDbL, vuR, vuPkR, vuDbR, (dbL, dbR) => {
    updateRecSignalStatus(dbL, dbR)
    if (cL && recVu.smL > -0.5) cL.classList.add('clip')
    if (cR && recVu.smR > -0.5) cR.classList.add('clip')
  })

  // Silence detection
  if (opts.stopOnSilence && activeSession.audioCtx) {
    const silenceAn = activeSession.audioCtx.createAnalyser()
    silenceAn.fftSize = 256
    activeSession.vuAnalyserL.connect(silenceAn)
    let silenceStart: number | null = null
    silenceInterval = setInterval(() => {
      if (!isRecording) { clearInterval(silenceInterval!); silenceInterval = null; return }
      const buf = new Uint8Array(silenceAn.frequencyBinCount)
      silenceAn.getByteFrequencyData(buf)
      if (!buf.some(v => v > 8)) {
        if (!silenceStart) silenceStart = Date.now()
        else if (Date.now() - silenceStart > 5 * 60000) {
          clearInterval(silenceInterval!); silenceInterval = null
          doStopRecording()
        }
      } else { silenceStart = null }
    }, 5000)
  }

  // Interval split — triggers every N minutes from recording start
  if (opts.splitMinutes && opts.splitMinutes > 0) {
    splitTimer = setTimeout(() => {
      const ts = new Date().toTimeString().slice(0, 5).replace(':', '')
      autoRestartOpts = { ...opts, splitTimestamp: ts }
      splitTimer = null
      doStopRecording()
    }, opts.splitMinutes * 60000)
  }

  window.api.notifyStarted({ name: opts.customName ?? opts.overrideName ?? t('recording.defaultName', 'Opptak') })
  window.api.confirmStart({ name: opts.customName ?? t('recording.defaultName', 'Opptak'), startTime: activeSession.recStartTime })

  // Timer display
  recTimerIval = setInterval(() => {
    if (!activeSession) return
    const elapsed = Math.floor((Date.now() - activeSession.recStartTime) / 1000)
    const h = Math.floor(elapsed / 3600)
    const m = Math.floor((elapsed % 3600) / 60)
    const s = elapsed % 60
    const timerEl = document.getElementById('rec-timer')
    if (timerEl) timerEl.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    const sizeEl = document.getElementById('rec-size')
    if (sizeEl && activeSession) sizeEl.textContent = (activeSession.recBytes / 1e6).toFixed(1) + ' MB'
  }, 1000)
}

async function stopMediaRecorder(): Promise<void> {
  try {
    stopVuState(recVu)
  } finally {
    if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null }
    if (splitTimer)      { clearTimeout(splitTimer);       splitTimer      = null }
    if (recTimerIval)    { clearInterval(recTimerIval);    recTimerIval    = null }
  }

  if (!activeSession) return
  const session = activeSession
  activeSession = null
  window.api.chunksDone()
  window.api.notifyStopped({})
  await stopCapture(session)
}

async function doStopRecording(): Promise<void> {
  await stopMediaRecorder()
  hideOverlay()
}

function attachDisconnectHandler(session: CaptureSession, opts: RecordingOpts): void {
  if (!session.stream) return
  session.stream.getAudioTracks().forEach(track => {
    track.onended = () => { if (isRecording) handleDisconnect(session, opts) }
  })
}

async function handleDisconnect(session: CaptureSession, opts: RecordingOpts): Promise<void> {
  if (!isRecording) return
  showReconnectBanner()
  let reconnected = false
  for (let remaining = 10; remaining > 0 && isRecording; remaining--) {
    updateReconnectBanner(remaining)
    if (await reconnectStream(session)) {
      reconnected = true
      attachDisconnectHandler(session, opts)
      break
    }
    await new Promise<void>(r => setTimeout(r, 1000))
  }
  hideReconnectBanner()
  if (!reconnected && isRecording) {
    window.api.notifyError({ error: t('recording.disconnected', 'Lydkilden ble koblet fra under opptak') })
    doStopRecording()
  }
}

function showReconnectBanner(): void {
  const el = document.getElementById('rec-reconnect')
  if (el) el.style.display = 'flex'
}

function hideReconnectBanner(): void {
  const el = document.getElementById('rec-reconnect')
  if (el) el.style.display = 'none'
}

function updateReconnectBanner(secsLeft: number): void {
  const el = document.getElementById('rec-reconnect-countdown')
  if (el) el.textContent = String(secsLeft)
}

function showOverlay(opts: RecordingOpts): void {
  isRecording = true
  const overlay = document.getElementById('recording-overlay')
  if (overlay) overlay.style.display = 'flex'
  const dot = document.getElementById('status-dot')
  const lbl = document.getElementById('status-label')
  if (dot) dot.className = 'status-dot recording'
  if (lbl) lbl.textContent = t('status.recording', 'Tar opp')
  document.getElementById('btn-start-recording')?.classList.add('recording')

  scheduledStop    = opts.scheduledStopTime ? new Date(opts.scheduledStopTime) : null
  stopOverridden   = false
  updateScheduledStopUI()

  // Save path hint
  const pathEl = document.getElementById('rec-savepath')
  if (pathEl && opts) {
    const folder = opts.saveFolder ?? settings.saveFolder ?? ''
    const date   = isoDate(new Date())
    const ext    = opts.format ?? 'mp3'
    let name     = date
    if (opts.customName?.trim()) {
      name = opts.customName.trim().replace(/[/\\:*?"<>|]/g, '_') + '_' + date
    } else if (opts.filenamePattern === 'plain') {
      name = 'gudstjeneste_' + date
    } else if (opts.filenamePattern === 'datetime') {
      name = date + '_' + new Date().toTimeString().slice(0, 5).replace(':', '')
    } else if (opts.overrideName) {
      name = opts.overrideName.replace(/[/\\:*?"<>|]/g, '_') + '_' + date
    }
    pathEl.textContent = `${t('recording.savingAs', 'Lagres som:')} ${folder}/${name}.${ext}`
  }
}

function hideOverlay(): void {
  isRecording = false
  const overlay = document.getElementById('recording-overlay')
  if (overlay) overlay.style.display = 'none'
  scheduledStop    = null
  stopOverridden   = false
  if (schedStopTimer) { clearTimeout(schedStopTimer);  schedStopTimer = null }
  if (schedCntTimer)  { clearInterval(schedCntTimer);  schedCntTimer  = null }
  const autostopEl = document.getElementById('rec-autostop')
  if (autostopEl) autostopEl.style.display = 'none'
  document.getElementById('btn-start-recording')?.classList.remove('recording')

  const dot = document.getElementById('status-dot')
  const lbl = document.getElementById('status-label')
  if (dot) dot.className = 'status-dot'
  if (lbl) lbl.textContent = t('status.ready', 'Alt er klart')
}

function updateScheduledStopUI(): void {
  const section = document.getElementById('rec-autostop')
  if (!section) return
  if (!scheduledStop) { section.style.display = 'none'; return }
  section.style.display = 'flex'
  updateScheduledStopCountdown()
  if (schedCntTimer) clearInterval(schedCntTimer)
  schedCntTimer = setInterval(updateScheduledStopCountdown, 1000)

  if (schedStopTimer) clearTimeout(schedStopTimer)
  const ms = scheduledStop.getTime() - Date.now()
  if (ms > 0) schedStopTimer = setTimeout(() => { if (isRecording) doStopRecording() }, ms)
}

function updateScheduledStopCountdown(): void {
  const el = document.getElementById('rec-autostop-countdown')
  if (!el || !scheduledStop) return
  const diff = scheduledStop.getTime() - Date.now()
  el.textContent = diff > 0 ? fmtCountdown(diff) : '—'
}

function updateRecSignalStatus(dbL: number, dbR: number): void {
  const db  = Math.max(dbL, dbR)
  const dot = document.getElementById('rec-sig-dot')
  const lbl = document.getElementById('rec-sig-label')
  if (!dot || !lbl) return
  let cls = '', text = '—'
  if      (db >= -3)  { cls = 'klipping'; text = t('recording.sigClipping', 'KLIPPING') }
  else if (db >= -12) { cls = 'hoyt';     text = t('recording.sigHigh',     'HØYT')     }
  else if (db >= -40) { cls = 'god';      text = t('recording.sigGood',     'GOD')      }
  else if (db > -55)  { cls = 'svak';     text = t('recording.sigWeak',     'SVAK')     }
  dot.className  = 'rec-sig-dot'   + (cls ? ' ' + cls : '')
  lbl.className  = 'rec-sig-label' + (cls ? ' ' + cls : '')
  lbl.textContent = text
}
