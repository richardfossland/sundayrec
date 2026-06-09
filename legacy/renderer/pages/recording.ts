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
import { RecordingWaveform } from '../audio/waveform'
import { fmtCountdown, flashMsg, isoDate } from '../helpers'
import { stopVU as stopHomeVU } from './home-vu'
import { stopMonitoring as stopAudioPageMonitoring } from './audio-page'
import { renderRecentRecordings, stopVideoPreview, startVideoPreview } from './home'
import { showEditorPrompt } from './editor-page'
import type { RecordingOpts } from '../../types'

let monitorSession:    MonitorSession | null = null
let recTimerIval:      ReturnType<typeof setInterval> | null = null
let signalCheckTimer:  ReturnType<typeof setTimeout>  | null = null
export let isRecording = false

let recStartTime = 0
let recBytes     = 0
let previewRestartTimer: ReturnType<typeof setTimeout> | null = null
let recPreviewUnsub:      (() => void) | undefined
let recCaptureErrUnsub:   (() => void) | undefined
let recVideoDimsSet   = false
let recFrameBlobUrl:  string | null = null

function readJpegDims(arr: Uint8Array): { w: number; h: number } | null {
  let i = 0
  while (i < arr.length - 8) {
    if (arr[i] !== 0xff) { i++; continue }
    const m = arr[i + 1]
    if (m === 0xc0 || m === 0xc2) {
      const h = (arr[i + 5] << 8) | arr[i + 6]
      const w = (arr[i + 7] << 8) | arr[i + 8]
      if (w > 0 && h > 0) return { w, h }
    }
    if (m !== 0xd8 && m !== 0xd9 && m !== 0x01 && i + 3 < arr.length) {
      const seg = (arr[i + 2] << 8) | arr[i + 3]
      if (seg >= 2) { i += 2 + seg; continue }
    }
    i++
  }
  return null
}

let scheduledStop:  Date | null = null
let stopOverridden  = false
let schedStopTimer: ReturnType<typeof setTimeout>  | null = null
let schedCntTimer:  ReturnType<typeof setInterval> | null = null

const recVu = makeVuState()

// Premium scrolling waveform for the recording overlay (driven by the same VU
// pipeline, tapped once — see startMonitoring's tickVU onSignal callback).
let recWaveform: RecordingWaveform | null = null

/** dBFS (−60..0) → 0..1 envelope height (matches the VU bar mapping). */
function dbToEnvHeight(db: number): number {
  return (Math.max(-60, Math.min(0, db)) + 60) / 60
}

/** Instantaneous linear peak (max |sample|) from a reused VU time-domain buffer. */
function bufferPeak(buf: Float32Array | null): number {
  if (!buf) return 0
  let m = 0
  for (let i = 0; i < buf.length; i++) {
    const a = buf[i] < 0 ? -buf[i] : buf[i]
    if (a > m) m = a
  }
  return m
}

// ── Setup ────────────────────────────────────────────────────────────────────

export function setupRecording(): void {
  // Opening the stop-confirm modal also focuses the SAFE cancel button so
  // an accidental Enter keeps the recording going.
  function openStopConfirm(): void {
    const m = document.getElementById('modal-confirm-stop')
    if (!m) return
    m.style.display = 'flex'
    // Defer focus to next tick so the browser has rendered the modal
    setTimeout(() => {
      (document.getElementById('btn-confirm-cancel') as HTMLButtonElement | null)?.focus()
    }, 0)
  }

  document.getElementById('btn-start-recording')?.addEventListener('click', () => {
    if (isRecording) {
      if (settings.protectRecording !== false) openStopConfirm()
      else doStopRecording()
    } else {
      openManualModal()
    }
  })

  document.getElementById('btn-stop-overlay')?.addEventListener('click', () => {
    if (settings.protectRecording !== false) openStopConfirm()
    else doStopRecording()
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
      // Tauri's `recording://started` carries NO opts (the manual start path
      // already showed the overlay locally with the real opts). Guard so we don't
      // re-render the overlay with `undefined` and throw.
      const o = opts as RecordingOpts | undefined
      if (!o || typeof o !== 'object') return
      showOverlay(o)
      startMonitoring(o).catch(err => {
        console.error('[recording] monitoring start error:', err)
        try { stopMonitoring() } catch {}
      })
    }),
    window.api.on('recording-overlay-stop', (data) => {
      // This is mapped to `recording://state`, which fires on EVERY transition
      // (preparing/recording/reconnecting/…), not just on stop. Only tear the
      // overlay down on a TERMINAL state, or a preparing→recording mid-session
      // event would hide the live overlay.
      const st = (data as { state?: string } | undefined)?.state
      if (st !== 'stopped' && st !== 'failed' && st !== 'idle') return
      if (stopOverridden) return
      stopMonitoring().catch(err => console.error('[recording] monitoring stop error:', err)).finally(() => hideOverlay())
    }),
    window.api.on('recording-finished', (entry) => {
      const rec = entry as { path?: string; splitRestart?: boolean } | undefined
      if (!rec?.splitRestart) hideOverlay()
      renderRecentRecordings()
      if (rec?.path && !rec.splitRestart && settings.askOpenEditor !== false) showEditorPrompt(rec.path)
    }),
    window.api.on('recording-error', (data) => {
      const d = data as { error?: string; message?: string } | undefined
      // Stop monitoring (VU timer + mic stream) before hiding overlay — same as normal stop
      stopMonitoring().catch(err => console.error('[recording] stopMonitoring on error:', err))
      hideOverlay()
      renderRecentRecordings()
      const msg = d?.message ?? (d?.error ? translateNativeError(d.error) : null)
      if (msg) showGlobalError(msg)
    }),
    window.api.on('recording-progress', (data) => {
      const d = data as { bytes?: number } | undefined
      if (d?.bytes !== undefined) recBytes = d.bytes
    }),
    // NB: there's no separate 'video-progress' event from the Tauri backend — the
    // combined file's bytes_written (recording-progress, above) is the only size
    // signal. The KAMERA badge is updated from recBytes in the 1 s timer instead,
    // so it no longer stays stuck at "0 MB".
    window.api.on('recording-reconnecting', () => showReconnectBanner()),
    window.api.on('recording-reconnected',  () => hideReconnectBanner()),
    window.api.on('tray-start-recording',   () => openManualModal()),
    window.api.on('tray-stop-recording',    () => doStopRecording()),
    window.api.on('cloud-upload-done', (data) => {
      const d = data as { service?: string; ok?: boolean; error?: string } | undefined
      if (!d?.ok) {
        const names: Record<string, string> = { 'google-drive': 'Google Drive', 'dropbox': 'Dropbox', 'onedrive': 'OneDrive' }
        const svc = names[d?.service ?? ''] ?? d?.service ?? 'Sky'
        showGlobalError(`${svc}: ${d?.error ?? t('general.unknownError', 'ukjent feil')}`)
      }
    }),
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

  // Audio devices
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

  // Video devices — show section only when video mode is on
  const videoSection = document.getElementById('manual-video-section')
  const videoSel     = document.getElementById('manual-video-device') as HTMLSelectElement | null
  const videoHint    = document.getElementById('manual-video-hint')

  if (!settings.videoEnabled) {
    if (videoSection) videoSection.style.display = 'none'
    return
  }
  if (videoSection) videoSection.style.display = ''

  if (videoSel) {
    videoSel.innerHTML = '<option value="">Laster enheter…</option>'
    videoSel.disabled  = true
  }
  if (videoHint) videoHint.style.display = 'none'

  try {
    const videoDevices = await window.api.listVideoDevices()
    if (!videoSel) return

    videoSel.innerHTML = ''

    // "No video for this recording" option
    const noVideoOpt = document.createElement('option')
    noVideoOpt.value = '__none__'
    noVideoOpt.textContent = 'Ingen video (bare lyd)'
    videoSel.appendChild(noVideoOpt)

    videoDevices.forEach(d => {
      const opt = document.createElement('option')
      opt.value = String(d.index)
      opt.dataset.name = d.name
      opt.textContent = d.name
      videoSel.appendChild(opt)
    })

    // Pre-select the saved device
    if (settings.videoDeviceName) {
      const match = videoDevices.find(d => d.name === settings.videoDeviceName)
      videoSel.value = match ? String(match.index) : '__none__'
    } else {
      videoSel.value = '__none__'
    }

    videoSel.disabled = false

    if (!videoDevices.length) {
      if (videoHint) {
        videoHint.textContent = 'Ingen kameraer funnet — sjekk tilkobling'
        videoHint.style.display = ''
      }
    }
  } catch {
    if (videoSel) {
      videoSel.innerHTML = '<option value="__none__">Feil ved lasting av kameraer</option>'
      videoSel.disabled  = false
    }
  }
}

async function handleManualStart(): Promise<void> {
  const btn = document.getElementById('btn-manual-start') as HTMLButtonElement | null
  const mm  = document.getElementById('modal-manual')
  if (btn) btn.disabled = true

  const devSel      = document.getElementById('manual-device')    as HTMLSelectElement | null
  const videoSel    = document.getElementById('manual-video-device') as HTMLSelectElement | null
  const nameEl      = document.getElementById('manual-filename')  as HTMLInputElement  | null
  const deviceId    = devSel?.value || settings.deviceId || null
  const devChannels = deviceId ? (settings.deviceChannels?.[deviceId] ?? null) : null
  const deviceName  = devSel?.options[devSel?.selectedIndex ?? 0]?.textContent ?? settings.deviceName ?? null

  // Resolve video source from the modal selection
  const videoVal  = videoSel?.value ?? '__none__'
  const noVideo   = !settings.videoEnabled || videoVal === '__none__'
  const videoOpt  = videoSel?.options[videoSel.selectedIndex ?? 0]
  const videoName = (videoOpt?.dataset.name ?? videoOpt?.textContent ?? '').trim() || null
  const videoIdx  = (videoVal && videoVal !== '__none__') ? parseInt(videoVal) : null

  const opts: RecordingOpts = {
    ...settings,
    deviceId,
    deviceName:       deviceName ?? undefined,
    customName:       nameEl?.value.trim() ?? '',
    channelL:         devChannels?.channelL ?? 0,
    channelR:         devChannels?.channelR ?? 1,
    maxMinutes:       settings.manualMaxMinutes || undefined,
    videoEnabled:     !noVideo,
    videoDeviceName:  noVideo ? null : videoName,
    videoDeviceIndex: noVideo ? null : videoIdx,
  }

  // Do NOT close the modal before we know if the recording started —
  // closing first makes error messages invisible to the user.
  let res: { ok?: boolean; error?: string } | null = null
  try {
    res = await window.api.startRecordingNow(opts)
  } catch (err) {
    if (mm) mm.style.display = 'none'
    showGlobalError(err instanceof Error ? err.message : String(err))
    if (btn) btn.disabled = false
    return
  }

  if (res?.ok) {
    if (mm) mm.style.display = 'none'
    showOverlay(opts)
    try { await startMonitoring(opts) }
    catch (err) {
      // Monitoring is only for VU display — keep recording alive, just log
      console.warn('[recording] VU monitor failed (non-fatal):', err)
      try { stopMonitoring() } catch {}
    }
  } else {
    // Keep modal open so the error is visible on the button
    const errMsg = res?.error ? translateNativeError(res.error) : t('general.unknownError', 'ukjent feil')
    flashMsg(btn, '✕ ' + errMsg, false)
  }
  if (btn) btn.disabled = false
}

export async function startRecordingWithOpts(opts: RecordingOpts): Promise<void> {
  let res: { ok?: boolean; error?: string } | null = null
  try { res = await window.api.startRecordingNow(opts) } catch { return }
  if (!res?.ok) {
    const errMsg = res?.error ? translateNativeError(res.error) : t('general.unknownError', 'ukjent feil')
    showGlobalError(errMsg)
    return
  }
  showOverlay(opts)
  try { await startMonitoring(opts) }
  catch (err) {
    console.warn('[recording] VU monitor failed (non-fatal):', err)
    try { stopMonitoring() } catch {}
  }
}

// ── Audio error translation ──────────────────────────────────────────────────

// Maps error codes from native-recorder (main process) to user-facing strings
export function translateNativeError(code: string): string {
  switch (code) {
    case 'no_device':
    case 'device_not_found':     return t('recording.errorDeviceNotFound', 'Lydenheten ble ikke funnet — sjekk lydkort og tillatelser')
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
    case 'invalid_opts':           return t('recording.errorInvalidOpts',        'Ugyldige opptaksinnstillinger — start på nytt og prøv igjen')
    case 'no_save_folder':         return t('recording.errorNoSaveFolder',       'Lagringsmappen er ikke valgt — gå til Innstillinger → Lagring')
    default:
      // Unknown error code — show a generic message instead of raw machine code.
      // The technical detail is still logged for diagnostics.
      console.warn('[recording] unknown native error code:', code)
      return t('recording.errorUnknown', 'Noe gikk galt under opptak — sjekk at lydenhet og lagringsmappe er klare')
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

  // Premium scrolling waveform — same source as the VU meter, tapped once.
  const wfCanvas = document.getElementById('rec-waveform') as HTMLCanvasElement | null
  if (wfCanvas) {
    recWaveform = new RecordingWaveform(wfCanvas)
    recWaveform.start()
  }

  tickVU(recVu, vuL, vuPkL, vuDbL, vuR, vuPkR, vuDbR, (dbL, dbR) => {
    updateRecSignalStatus(dbL, dbR)
    if (cL && recVu.smL > -0.5) cL.classList.add('clip')
    if (cR && recVu.smR > -0.5) cR.classList.add('clip')
    if (recWaveform) {
      // PEAK halo = instantaneous transient (from raw PCM); RMS core = the
      // smoothed body. Both as 0..1 perceptual heights; combine L/R (louder).
      const pk = Math.max(bufferPeak(recVu.bufL), bufferPeak(recVu.bufR))
      const peakH = dbToEnvHeight(pk > 0 ? 20 * Math.log10(pk) : -60)
      const rmsH = Math.max(dbToEnvHeight(dbL), dbToEnvHeight(dbR))
      recWaveform.push(peakH, rmsH)
    }
  })

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
    const mb = (recBytes / 1e6).toFixed(1) + ' MB'
    const sizeEl = document.getElementById('rec-size')
    if (sizeEl) sizeEl.textContent = mb
    // The KAMERA badge gets the same growing file size (no separate video-byte
    // event exists) — was stuck at "0 MB" before.
    const camBytesEl = document.getElementById('rec-video-bytes')
    if (camBytesEl) camBytesEl.textContent = mb
  }, 1000)
}

async function stopMonitoring(): Promise<void> {
  stopVuState(recVu)
  if (recWaveform) { recWaveform.destroy(); recWaveform = null }
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
  // Cancel any pending preview restart and stop home preview (device now used by recorder)
  if (previewRestartTimer) { clearTimeout(previewRestartTimer); previewRestartTimer = null }
  stopVideoPreview()

  // Show overlay video preview if video is configured
  if (opts.videoEnabled && opts.videoDeviceName) {
    const recVideoSection = document.getElementById('rec-video-section')
    const recImg          = document.getElementById('rec-video-preview-img') as HTMLImageElement | null
    const recPh           = document.getElementById('rec-video-placeholder')
    if (recVideoSection) recVideoSection.style.display = ''
    if (recImg)  { recImg.src = ''; recImg.style.display = 'none' }
    if (recPh)   { recPh.textContent = 'Starter kamera…'; recPh.style.display = '' }

    recPreviewUnsub?.()
    recCaptureErrUnsub?.()
    recVideoDimsSet = false
    // DURING recording the backend recorder owns the camera and writes a low-fps
    // preview JPEG to a file; we POLL it (base64) here. (The old Electron app got
    // IPC frames; the Tauri recorder writes a file instead — a poll is the match.)
    // Poll roughly at the backend preview rate (12 fps → ~83 ms). The cap was
    // 150 ms (~6.7 fps), which threw away half the preview frames and made the
    // image feel laggy even when the backend produced more.
    const recPollMs = Math.max(80, Math.floor(1000 / (opts.videoFramerate ?? settings.videoFramerate ?? 15)))
    const recPollTimer = setInterval(async () => {
      let b64: string | null = null
      try { b64 = await window.api.recordingPreviewFrame?.() ?? null } catch { b64 = null }
      if (!b64 || !recImg) return
      if (!recVideoDimsSet) {
        const bytes = Uint8Array.from(atob(b64.slice(0, 1400)), c => c.charCodeAt(0))
        const dims = readJpegDims(bytes)
        if (dims) {
          recVideoDimsSet = true
          const wrap = document.querySelector<HTMLElement>('.rec-video-wrap')
          if (wrap) wrap.style.setProperty('--rec-video-ar', `${dims.w} / ${dims.h}`)
        }
      }
      recImg.src = `data:image/jpeg;base64,${b64}`
      recImg.style.display = ''
      if (recPh) recPh.style.display = 'none'
    }, recPollMs)
    recPreviewUnsub = () => clearInterval(recPollTimer)
    recCaptureErrUnsub = window.api.on('video-capture-error', () => {
      if (recPh) { recPh.textContent = 'Kamera feilet — opptar kun lyd'; recPh.style.display = '' }
      if (recImg) recImg.style.display = 'none'
    })
  }
  const overlay = document.getElementById('recording-overlay')
  if (overlay) {
    overlay.style.display = 'flex'
    if (opts.videoEnabled && opts.videoDeviceName) {
      overlay.classList.add('video-active')
    }
  }
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

  // Clean up overlay video preview
  recPreviewUnsub?.(); recPreviewUnsub = undefined
  recCaptureErrUnsub?.(); recCaptureErrUnsub = undefined
  if (recFrameBlobUrl) { URL.revokeObjectURL(recFrameBlobUrl); recFrameBlobUrl = null }
  recVideoDimsSet = false
  const recVideoSection = document.getElementById('rec-video-section')
  if (recVideoSection) recVideoSection.style.display = 'none'
  const recVideoWrap = document.querySelector<HTMLElement>('.rec-video-wrap')
  if (recVideoWrap) recVideoWrap.style.removeProperty('--rec-video-ar')

  // Restart preview after a short delay — gives time for split auto-restart to cancel it
  if (previewRestartTimer) clearTimeout(previewRestartTimer)
  previewRestartTimer = setTimeout(() => {
    previewRestartTimer = null
    if (!isRecording) {
      // Reset video progress display
      const progressRow = document.getElementById('video-progress-row')
      if (progressRow) progressRow.style.display = 'none'
      startVideoPreview()
    }
  }, 3000)
  const overlay = document.getElementById('recording-overlay')
  if (overlay) {
    overlay.style.display = 'none'
    overlay.classList.remove('video-active')
  }
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
