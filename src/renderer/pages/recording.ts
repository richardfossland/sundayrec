/**
 * Recording session UI — overlay, VU meter, silence detection, split timer.
 *
 * In the v4.1 architecture, recording is handled by ffmpeg in the main process.
 * This module manages ONLY the UI state and the monitoring stream for VU display.
 * Audio chunks are no longer sent via IPC.
 *
 * Start flow:
 *   1. window.api.startRecordingNow(opts) → main spawns ffmpeg
 *   2. showOverlay() → recording UI becomes visible
 *   3. startMonitoring(opts) → opens a separate getUserMedia stream for VU only
 *
 * Stop flow:
 *   1. window.api.stopRecordingNow() → main sends 'q' to ffmpeg
 *   2. stopMonitoring() → closes monitoring stream
 *   3. Main sends 'recording-finished' → renderer hides overlay, shows history
 */
import { t } from '../i18n'
import { settings } from '../state'
import { startMonitorStream, stopMonitorStream, reconnectMonitorStream, getAudioDevices } from '../audio/capture'
import type { MonitorSession } from '../audio/capture'
import { makeVuState, tickVU, stopVuState } from '../audio/vu'
import { fmtCountdown, flashMsg, isoDate } from '../helpers'
import { stopVU as stopHomeVU } from './home-vu'
import { stopMonitoring as stopAudioPageMonitoring } from './audio-page'
import { loadRecentHistory } from './home'
import { showEditorPrompt } from './editor-page'
import type { RecordingOpts } from '../../types'

let monitorSession:    MonitorSession | null = null
let silenceInterval:   ReturnType<typeof setInterval> | null = null
let splitTimer:        ReturnType<typeof setTimeout>  | null = null
let recTimerIval:      ReturnType<typeof setInterval> | null = null
let signalCheckTimer:  ReturnType<typeof setTimeout>  | null = null
let autoRestartOpts:   RecordingOpts | null = null
export let isRecording = false

let recStartTime = 0
let recBytes     = 0

let scheduledStop:  Date | null = null
let stopOverridden  = false
let schedStopTimer: ReturnType<typeof setTimeout>  | null = null
let schedCntTimer:  ReturnType<typeof setInterval> | null = null

const recVu = makeVuState()

// ── Setup ────────────────────────────────────────────────────────────────────

export function setupRecording(): void {
  document.getElementById('btn-start-recording')?.addEventListener('click', () => {
    if (isRecording) {
      if (settings.protectRecording !== false) {
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
    if (schedStopTimer) { clearTimeout(schedStopTimer); schedStopTimer = null }
    if (schedCntTimer)  { clearInterval(schedCntTimer);  schedCntTimer = null }
    const s = document.getElementById('rec-autostop'); if (s) s.style.display = 'none'
  })

  const ipcCleanups = [
    window.api.on('recording-overlay-start', (opts) => {
      // Recording already started in main; just show UI and open monitoring stream
      const o = opts as RecordingOpts
      showOverlay(o)
      startMonitoring(o).catch(err => {
        console.error('[recording] monitoring start error:', err)
        try { stopMonitoring() } catch {}
      })
    }),
    window.api.on('recording-overlay-stop', () => {
      // Main already called stopSession(); just close monitoring stream and hide UI
      if (stopOverridden) return
      stopMonitoring().catch(err => console.error('[recording] monitoring stop error:', err)).finally(() => hideOverlay())
    }),
    window.api.on('recording-finished', (entry) => {
      hideOverlay()
      loadRecentHistory()
      const rec = entry as { path?: string } | undefined
      if (rec?.path && settings.askOpenEditor !== false) showEditorPrompt(rec.path)
      if (autoRestartOpts) {
        const opts = autoRestartOpts; autoRestartOpts = null
        setTimeout(() => startRecordingWithOpts(opts), 1000)
      }
    }),
    window.api.on('recording-error', (data) => {
      const d = data as { error?: string; message?: string } | undefined
      hideOverlay()
      loadRecentHistory()
      const msg = d?.message ?? (d?.error ? translateNativeError(d.error) : null)
      if (msg) showGlobalError(msg)
    }),
    window.api.on('recording-progress', (data) => {
      const d = data as { bytes?: number } | undefined
      if (d?.bytes !== undefined) recBytes = d.bytes
    }),
    window.api.on('recording-reconnecting', () => showReconnectBanner()),
    window.api.on('recording-reconnected',  () => hideReconnectBanner()),
    window.api.on('tray-start-recording',   () => openManualModal()),
    window.api.on('tray-stop-recording',    () => doStopRecording()),
  ]
  window.addEventListener('beforeunload', () => ipcCleanups.forEach(fn => fn?.()))
}

// ── Manual recording modal ───────────────────────────────────────────────────

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
  const btn    = document.getElementById('btn-manual-start') as HTMLButtonElement | null
  if (btn) btn.disabled = true

  const devSel   = document.getElementById('manual-device')  as HTMLSelectElement | null
  const nameEl   = document.getElementById('manual-filename') as HTMLInputElement  | null
  const deviceId = devSel?.value ?? settings.deviceId ?? null
  const devChannels = deviceId ? (settings.deviceChannels?.[deviceId] ?? null) : null

  // Look up deviceName from the select's selected option text
  const deviceName = devSel?.options[devSel.selectedIndex]?.textContent ?? settings.deviceName ?? null

  const opts: RecordingOpts = {
    ...settings,
    deviceId,
    deviceName: deviceName ?? undefined,
    customName:  nameEl?.value.trim() ?? '',
    channelL:    devChannels?.channelL ?? 0,
    channelR:    devChannels?.channelR ?? 1,
    maxMinutes:  settings.manualMaxMinutes || undefined
  }
  const mm = document.getElementById('modal-manual'); if (mm) mm.style.display = 'none'

  const res = await window.api.startRecordingNow(opts)
  if (res?.ok) {
    showOverlay(opts)
    try { await startMonitoring(opts) }
    catch (err) {
      try { await stopMonitoring() } catch {}
      window.api.notifyError({ error: translateAudioError(err as Error) })
      await window.api.stopRecordingNow()
      hideOverlay()
    }
  } else {
    const errMsg = res?.error ? translateNativeError(res.error) : t('general.unknownError', 'ukjent feil')
    flashMsg(document.getElementById('btn-manual-start'), '✕ ' + errMsg, false)
  }
  if (btn) btn.disabled = false
}

export async function startRecordingWithOpts(opts: RecordingOpts): Promise<void> {
  const res = await window.api.startRecordingNow(opts)
  if (!res?.ok) {
    if (res?.error) window.api.notifyError({ error: translateNativeError(res.error) })
    return
  }
  showOverlay(opts)
  try { await startMonitoring(opts) }
  catch (err) {
    autoRestartOpts = null
    try { await stopMonitoring() } catch {}
    window.api.notifyError({ error: translateAudioError(err as Error) })
    await window.api.stopRecordingNow()
    hideOverlay()
  }
}

// ── Audio error translation ──────────────────────────────────────────────────

function translateAudioError(err: Error): string {
  switch (err.name) {
    case 'NotAllowedError':      return t('recording.errorPermission',    'Mikrofontilgang nektet — sjekk systeminnstillingene')
    case 'NotFoundError':        return t('recording.errorDeviceNotFound', 'Lydenheten ble ikke funnet — sjekk USB-tilkoblingen')
    case 'OverconstrainedError': return t('recording.errorOverconstrained','Lydenheten støtter ikke valgte innstillinger')
    case 'NotReadableError':     return t('recording.errorNotReadable',    'Lydenheten er i bruk av et annet program')
    default:                     return err.message
  }
}

// Maps error codes from native-recorder (main process) to user-facing strings
export function translateNativeError(code: string): string {
  switch (code) {
    case 'no_device':
    case 'device_not_found':     return t('recording.errorDeviceNotFound', 'Lydenheten ble ikke funnet — sjekk USB-tilkoblingen')
    case 'device_permission_denied': return t('recording.errorPermission', 'Tilgang til lydenheten ble nektet — sjekk systeminnstillingene')
    case 'device_busy':          return t('recording.errorNotReadable',    'Lydenheten er i bruk av et annet program — lukk DAW eller lydprogram')
    case 'device_error':         return t('recording.errorDeviceError',    'Feil ved åpning av lydenhet — prøv å koble til på nytt')
    case 'already_recording':      return t('recording.errorAlreadyRecording',  'Et opptak er allerede i gang')
    case 'empty_output':           return t('recording.errorEmpty',              'Opptaket er tomt — ingen lyd ble mottatt fra enheten')
    case 'save_folder_permission': return t('recording.errorFolderPermission',   'Ingen tilgang til lagringsmappen — sjekk at mappen er skrivbar')
    case 'save_folder_error':      return t('recording.errorFolderError',        'Kan ikke opprette lagringsmappe — sjekk diskplass og tillatelser')
    case 'device_disconnected':    return t('recording.errorDeviceDisconnected', 'Lydenheten ble koblet fra under opptak — sjekk tilkoblingen')
    case 'disk_full':              return t('recording.errorDiskFull',           'Disken er full — frigjør plass og prøv igjen')
    case 'ffmpeg_missing':         return t('recording.errorFfmpegMissing',      'Intern feil: opptaksbinær mangler — reinstaller appen')
    case 'stuck_recording':        return t('recording.errorStuck',              'Opptaket stoppet — ingen lyd fra enheten i 60 sekunder')
    default:                       return code
  }
}

export function showGlobalError(msg: string): void {
  const banner  = document.getElementById('global-error-banner')
  const msgEl   = document.getElementById('global-error-msg')
  const closeEl = document.getElementById('global-error-close')
  if (!banner || !msgEl) return
  msgEl.textContent = msg
  banner.style.display = 'flex'
  if (closeEl && !closeEl.dataset.bound) {
    closeEl.dataset.bound = '1'
    closeEl.addEventListener('click', () => { banner.style.display = 'none' })
  }
  // Navigate to home so user sees the banner
  if (typeof window.showPage === 'function') window.showPage('home')
}

// ── Monitoring stream (VU only) ──────────────────────────────────────────────

async function startMonitoring(opts: RecordingOpts): Promise<void> {
  stopHomeVU()
  stopAudioPageMonitoring()

  const deviceId    = opts.deviceId ?? settings.deviceId ?? null
  const devChannels = deviceId ? (settings.deviceChannels?.[deviceId] ?? null) : null
  const resolvedOpts: RecordingOpts = {
    ...opts,
    channelL: opts.channelL ?? devChannels?.channelL ?? 0,
    channelR: opts.channelR ?? devChannels?.channelR ?? 1
  }

  monitorSession = await startMonitorStream(resolvedOpts)
  recStartTime   = Date.now()
  recBytes       = 0

  // Attach disconnect handler — for monitoring stream reconnect (VU display)
  attachMonitorDisconnectHandler(monitorSession, resolvedOpts)

  // VU meter
  const vuL   = document.getElementById('rec-vu-l')
  const vuPkL = document.getElementById('rec-vu-peak-l')
  const vuDbL = document.getElementById('rec-vu-db-l')
  const vuR   = document.getElementById('rec-vu-r')
  const vuPkR = document.getElementById('rec-vu-peak-r')
  const vuDbR = document.getElementById('rec-vu-db-r')
  const cL    = document.getElementById('rec-vu-clip-l')
  const cR    = document.getElementById('rec-vu-clip-r')

  Object.assign(recVu, {
    analyserL: monitorSession.vuAnalyserL,
    analyserR: monitorSession.vuAnalyserR
  })

  tickVU(recVu, vuL, vuPkL, vuDbL, vuR, vuPkR, vuDbR, (dbL, dbR) => {
    updateRecSignalStatus(dbL, dbR)
    if (cL && recVu.smL > -0.5) cL.classList.add('clip')
    if (cR && recVu.smR > -0.5) cR.classList.add('clip')
  })

  // Silence detection — operates on monitoring stream
  if (opts.stopOnSilence) {
    const silenceAn   = monitorSession.audioCtx.createAnalyser(); silenceAn.fftSize = 2048
    monitorSession.vuAnalyserL.connect(silenceAn)
    const threshDb    = opts.silenceThreshold ?? -50
    const timeoutMs   = (opts.silenceTimeoutMinutes ?? 5) * 60000
    let   silenceStart: number | null = null
    silenceInterval = setInterval(() => {
      if (!isRecording) { clearInterval(silenceInterval!); silenceInterval = null; return }
      const buf = new Float32Array(silenceAn.fftSize)
      silenceAn.getFloatTimeDomainData(buf)
      const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length)
      const db  = rms > 0 ? 20 * Math.log10(rms) : -Infinity
      if (db < threshDb) {
        if (!silenceStart) silenceStart = Date.now()
        else if (Date.now() - silenceStart > timeoutMs) {
          clearInterval(silenceInterval!); silenceInterval = null
          doStopRecording()
        }
      } else { silenceStart = null }
    }, 5000)
  }

  // Interval split — stop and auto-restart after N minutes
  if (opts.splitMinutes && opts.splitMinutes > 0) {
    splitTimer = setTimeout(() => {
      const ts = new Date().toTimeString().slice(0, 5).replace(':', '')
      autoRestartOpts = { ...opts, splitTimestamp: ts }
      splitTimer = null
      doStopRecording()
    }, opts.splitMinutes * 60000)
  }

  // Signal check — warn if input is near-silent 15 s into recording
  const analyserRef = monitorSession.vuAnalyserL
  signalCheckTimer = setTimeout(() => {
    signalCheckTimer = null
    if (!isRecording || !analyserRef) return
    const buf = new Uint8Array(analyserRef.frequencyBinCount)
    analyserRef.getByteFrequencyData(buf)
    const avg = buf.reduce((a, b) => a + b, 0) / buf.length
    if (avg < 3) window.api.notifyWeakSignal()
  }, 15000)

  // Elapsed timer + size display
  recTimerIval = setInterval(() => {
    if (!isRecording) return
    const elapsed = Math.floor((Date.now() - recStartTime) / 1000)
    const h = Math.floor(elapsed / 3600)
    const m = Math.floor((elapsed % 3600) / 60)
    const s = elapsed % 60
    const timerEl = document.getElementById('rec-timer')
    if (timerEl) timerEl.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    const sizeEl = document.getElementById('rec-size')
    if (sizeEl) sizeEl.textContent = (recBytes / 1e6).toFixed(1) + ' MB'
  }, 1000)
}

async function stopMonitoring(): Promise<void> {
  stopVuState(recVu)
  if (silenceInterval)  { clearInterval(silenceInterval);  silenceInterval  = null }
  if (splitTimer)       { clearTimeout(splitTimer);        splitTimer       = null }
  if (recTimerIval)     { clearInterval(recTimerIval);     recTimerIval     = null }
  if (signalCheckTimer) { clearTimeout(signalCheckTimer);  signalCheckTimer = null }

  if (!monitorSession) return
  const s = monitorSession; monitorSession = null
  await Promise.race([
    stopMonitorStream(s),
    new Promise<void>(resolve => setTimeout(resolve, 5000))
  ])
}

async function doStopRecording(): Promise<void> {
  window.api.stopRecordingNow()
  try { await stopMonitoring() } catch (err) { console.error('[recording] stopMonitoring error:', err) }
  hideOverlay()
}

// ── Monitoring stream reconnect (for VU continuity) ─────────────────────────

function attachMonitorDisconnectHandler(session: MonitorSession, opts: RecordingOpts): void {
  session.stream.getAudioTracks().forEach(track => {
    track.onended = () => {
      if (!isRecording || !monitorSession || monitorSession !== session) return
      tryReconnectMonitor(session, opts)
    }
  })
}

async function tryReconnectMonitor(session: MonitorSession, opts: RecordingOpts): Promise<void> {
  // Try for 30 s to reconnect the monitoring stream (main handles actual recording reconnect)
  for (let i = 0; i < 30 && isRecording; i++) {
    await new Promise<void>(r => setTimeout(r, 1000))
    if (await reconnectMonitorStream(session)) {
      attachMonitorDisconnectHandler(session, opts)
      return
    }
  }
}

// ── Overlay / UI state ───────────────────────────────────────────────────────

function showOverlay(opts: RecordingOpts): void {
  isRecording = true
  window.__isRecording = true
  const overlay = document.getElementById('recording-overlay')
  if (overlay) overlay.style.display = 'flex'
  const dot = document.getElementById('status-dot')
  const lbl = document.getElementById('status-label')
  if (dot) dot.className = 'status-dot recording'
  if (lbl) lbl.textContent = t('status.recording', 'Tar opp')
  document.getElementById('btn-start-recording')?.classList.add('recording')

  scheduledStop  = opts.scheduledStopTime ? new Date(opts.scheduledStopTime) : null
  stopOverridden = false
  updateScheduledStopUI()

  // Device name display
  const deviceEl = document.getElementById('rec-device-name')
  if (deviceEl) {
    deviceEl.textContent = opts.deviceName ?? ''
    getAudioDevices().then(devices => {
      const dev = devices.find(d => d.deviceId === (opts.deviceId ?? settings.deviceId))
      if (deviceEl && dev?.label) deviceEl.textContent = dev.label
    }).catch(() => {})
  }

  // Save path hint
  const pathEl = document.getElementById('rec-savepath')
  if (pathEl) {
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
  window.__isRecording = false
  const overlay = document.getElementById('recording-overlay')
  if (overlay) overlay.style.display = 'none'
  scheduledStop  = null
  stopOverridden = false
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

function showReconnectBanner(): void {
  const el = document.getElementById('rec-reconnect')
  if (el) el.style.display = 'flex'
}

function hideReconnectBanner(): void {
  const el = document.getElementById('rec-reconnect')
  if (el) el.style.display = 'none'
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
