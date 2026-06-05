/**
 * Live streaming page — RTMP broadcast UI.
 *
 * Pulls destinations from settings, renders an enable-toggle for each, shows a
 * 16:9 preview that reloads from disk every 2 s while streaming, and surfaces
 * live stats (bitrate / fps / dropped frames / uptime) from the `stream-stats`
 * IPC event.
 *
 * Lifecycle mirrors editor-page: setupLivePage() wires DOM once at boot,
 * reactivateLivePage()/deactivateLivePage() handle entering/leaving the tab
 * (start/stop the preview-refresh interval, subscribe/unsubscribe to stats).
 */

import { t } from '../i18n'
import { settings } from '../state'
import { escHtml } from '../helpers'
import { makeVuState, tickVU, stopVuState } from '../audio/vu'
import type { VuState } from '../audio/vu'
import { rVuChannel } from '../audio/capture'
import type { StreamDestinationStored } from '../../types'
import { setupLiveOverlays, reactivateLiveOverlays } from './live-overlays'
import { normalizeFrameData } from '../../shared/normalize-frame-data'

// ── State ────────────────────────────────────────────────────────────────
interface StreamStats {
  active:      boolean
  startedAt:   number | null
  bitrateKbps: number
  fps:         number
  dropped:     number
  lastLine:    string
  destinations: Array<{ id: string; state: string }>
}

let previewInterval: ReturnType<typeof setInterval> | null = null
let uptimeInterval:  ReturnType<typeof setInterval> | null = null
let unsubStats: (() => void) | undefined
let previewPathCached = ''
let lastStats: StreamStats = emptyStats()
/** Per-destination enabled state — keyed by destination id. Mirrors settings
 *  but lets the user toggle a destination off for one session without
 *  persisting. We persist only when the user changes it from Innstillinger. */
const sessionEnabled = new Map<string, boolean>()

function emptyStats(): StreamStats {
  return {
    active:      false,
    startedAt:   null,
    bitrateKbps: 0,
    fps:         0,
    dropped:     0,
    lastLine:    '',
    destinations: [],
  }
}

// ── Setup ────────────────────────────────────────────────────────────────

export function setupLivePage(): void {
  document.getElementById('btn-live-start')?.addEventListener('click', () => onStartStopClick(true))
  document.getElementById('btn-live-start-stream-only')?.addEventListener('click', () => onStartStopClick(false))

  document.getElementById('live-config-link')?.addEventListener('click', e => {
    e.preventDefault()
    window.showPage('settings')
    // Open the Publisering tab
    const btn = document.querySelector<HTMLElement>('#settings-tabs .inner-tab[data-tab="settings-publish"]')
    btn?.click()
  })

  // Quality + framerate changes affect the params we pass to streamStart; no
  // need to persist unless the user clicks save on the publish settings.
  document.querySelectorAll<HTMLInputElement>('input[name="live-resolution"]').forEach(r => {
    r.addEventListener('change', () => updateStartButtonState())
  })
  document.getElementById('live-framerate')?.addEventListener('change', () => updateStartButtonState())

  // Overlay configuration UI — separate module so this file doesn't balloon.
  setupLiveOverlays()
}

// ── Activation lifecycle ─────────────────────────────────────────────────

export function reactivateLivePage(): void {
  // Sync UI from settings every time we land on the page (the user may have
  // added/removed destinations on the settings tab while we were away).
  syncQualityFromSettings()
  renderDestinations()
  reactivateLiveOverlays()
  refreshPreviewPath()
  // Pick up current stream state from main in case a stream is already alive.
  refreshStatus()
  startPreviewInterval()
  startUptimeInterval()
  subscribeStats()
  startVuMeter()
  // Idle camera-preview so the user sees the camera BEFORE clicking Start.
  // Skipped when a stream is already running (avfoundation locks the device,
  // and the live stream's snapshot-JPG path covers the active state).
  if (!lastStats.active) startIdleCameraPreview()
}

export function deactivateLivePage(): void {
  if (previewInterval) { clearInterval(previewInterval); previewInterval = null }
  if (uptimeInterval)  { clearInterval(uptimeInterval);  uptimeInterval  = null }
  if (unsubStats) { unsubStats(); unsubStats = undefined }
  stopVuMeter()
  stopIdleCameraPreview()
}

// ── Idle camera preview (before stream starts) ─────────────────────────────
//
// Same MJPEG-frame mechanism the Home page uses for its preview. We only run
// this while idle — when the user starts the stream, ffmpeg takes the camera
// over and the active-stream branch in startPreviewInterval() takes the
// snapshot JPG path instead. avfoundation locks the device exclusively, so
// trying to keep preview running alongside the stream would compete with
// streamer.ts for the camera handle.

let idlePreviewFrameUnsub: (() => void) | undefined
let idlePreviewLastFrameTs = 0
let idlePreviewActive = false

function startIdleCameraPreview(): void {
  if (idlePreviewActive) return
  // Skip when there's no camera configured — user is doing audio-only,
  // the preview will stay on the "waiting for stream" placeholder.
  if (!settings.videoDeviceName && settings.videoDeviceIndex == null) return
  idlePreviewActive = true

  const img         = document.getElementById('live-preview-img') as HTMLImageElement | null
  const placeholder = document.getElementById('live-preview-placeholder') as HTMLElement | null

  window.api.videoPreviewStart?.({
    videoDeviceName:  settings.videoDeviceName,
    videoDeviceIndex: settings.videoDeviceIndex,
    videoFramerate:   settings.videoFramerate,
  })?.catch(() => { /* main-side handles the error path */ })

  const frameIntervalMs = Math.floor(1000 / (settings.videoFramerate ?? 30)) - 2
  idlePreviewFrameUnsub = window.api.on('video-preview-frame', (data: unknown) => {
    if (!idlePreviewActive || lastStats.active) return
    const now = Date.now()
    if (now - idlePreviewLastFrameTs < frameIntervalMs) return
    idlePreviewLastFrameTs = now
    const arr = normalizeFrameData(data)
    if (!img || !arr || arr.length < 4) return
    const url = URL.createObjectURL(new Blob([arr as BlobPart], { type: 'image/jpeg' }))
    const prev = img.src
    img.src = url
    img.style.display = ''
    if (placeholder) placeholder.style.display = 'none'
    if (prev.startsWith('blob:')) URL.revokeObjectURL(prev)
  }) ?? undefined
}

function stopIdleCameraPreview(): void {
  if (!idlePreviewActive) return
  idlePreviewActive = false
  if (idlePreviewFrameUnsub) { idlePreviewFrameUnsub(); idlePreviewFrameUnsub = undefined }
  window.api.videoPreviewStop?.().catch(() => {})
  // Restore placeholder so the next visit doesn't show a stale frame.
  const img         = document.getElementById('live-preview-img') as HTMLImageElement | null
  const placeholder = document.getElementById('live-preview-placeholder') as HTMLElement | null
  if (img) {
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src)
    img.removeAttribute('src')
    img.style.display = 'none'
  }
  if (placeholder) placeholder.style.display = ''
}

// ── VU meter (pre-stream audio confidence check) ─────────────────────────
//
// Re-uses the same RMS dB / peak-hold engine that powers the home-page VU,
// so the meter on the live tab is visually + numerically identical to the
// one on Hjem (and the recording overlay). Stops cleanly on page leave to
// release the microphone.

const liveVu = makeVuState()

function startVuMeter(): void {
  if (liveVu.stream) return  // already running
  if (!document.getElementById('live-vu-l')) return

  const devId = settings.deviceId && settings.deviceId !== 'default' ? settings.deviceId : null
  navigator.mediaDevices.getUserMedia({
    audio: {
      ...(devId ? { deviceId: { ideal: devId } } : {}),
      channelCount:     { ideal: 2 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl:  false,
    },
    video: false,
  }).then(stream => {
    liveVu.stream = stream
    liveVu.ctx    = new AudioContext()
    const src   = liveVu.ctx.createMediaStreamSource(stream)
    const split = liveVu.ctx.createChannelSplitter(2)
    liveVu.analyserL = liveVu.ctx.createAnalyser(); liveVu.analyserL.fftSize = 1024
    liveVu.analyserR = liveVu.ctx.createAnalyser(); liveVu.analyserR.fftSize = 1024
    src.connect(split)
    split.connect(liveVu.analyserL, 0)
    // Mirror mono → R so the R meter isn't dead on a mono mic (see rVuChannel).
    split.connect(liveVu.analyserR, rVuChannel(stream))

    const fillL = document.getElementById('live-vu-l')
    const pkL   = document.getElementById('live-vu-peak-l')
    const dbL   = document.getElementById('live-vu-db-l')
    const fillR = document.getElementById('live-vu-r')
    const pkR   = document.getElementById('live-vu-peak-r')
    const dbR   = document.getElementById('live-vu-db-r')
    const clipL = document.getElementById('live-vu-clip-l')
    const clipR = document.getElementById('live-vu-clip-r')

    tickVU(liveVu, fillL, pkL, dbL, fillR, pkR, dbR, (dL, dR, state) => {
      updateLiveSignalStatus(dL, dR, state)
      if (clipL && state.smL > -0.5) clipL.classList.add('clip')
      if (clipR && state.smR > -0.5) clipR.classList.add('clip')
    })
  }).catch(err => {
    console.warn('[live-page] VU mic access failed', err)
  })
}

function stopVuMeter(): void {
  stopVuState(liveVu)
  const fills = ['live-vu-l', 'live-vu-r'].map(id => document.getElementById(id))
  const peaks = ['live-vu-peak-l', 'live-vu-peak-r'].map(id => document.getElementById(id))
  const dbs   = ['live-vu-db-l', 'live-vu-db-r'].map(id => document.getElementById(id))
  fills.forEach(el => { if (el) el.style.width = '100%' })
  peaks.forEach(el => { if (el) el.style.opacity = '0' })
  dbs.forEach(el   => { if (el) el.textContent = '—' })
  resetLiveSignalStatus()
}

function resetLiveSignalStatus(): void {
  const dot  = document.getElementById('live-signal-dot')
  const text = document.getElementById('live-signal-text')
  const peak = document.getElementById('live-signal-peak')
  if (dot)  dot.className = 'signal-dot'
  if (text) { text.className = 'signal-text'; text.textContent = '—' }
  if (peak) peak.textContent = ''
}

function updateLiveSignalStatus(dbL: number, dbR: number, state: VuState): void {
  const db   = Math.max(dbL, dbR)
  const dot  = document.getElementById('live-signal-dot')
  const text = document.getElementById('live-signal-text')
  const peak = document.getElementById('live-signal-peak')
  if (!dot || !text) return
  let cls = '', label = '—'
  if      (db >= -3)  { cls = 'klipping'; label = t('home.signalClipping', 'Klipper!') }
  else if (db >= -12) { cls = 'hoyt';     label = t('home.signalLoud',     'Høyt')     }
  else if (db >= -40) { cls = 'god';      label = t('home.signalGood',     'Bra')      }
  else if (db > -55)  { cls = 'svak';     label = t('home.signalWeak',     'Svakt')    }
  dot.className  = 'signal-dot'  + (cls ? ' ' + cls : '')
  text.className = 'signal-text' + (cls ? ' ' + cls : '')
  text.textContent = label
  const pkMax = Math.max(state.peakL, state.peakR)
  if (peak) peak.textContent = pkMax > -59 ? `Maks: ${pkMax.toFixed(1)} dBFS` : ''
}

// ── Stats subscription ───────────────────────────────────────────────────

function subscribeStats(): void {
  if (unsubStats) return
  unsubStats = window.api.on('stream-stats', (data: unknown) => {
    const s = data as StreamStats
    lastStats = s
    renderStats(s)
    renderDestinationStates(s.destinations)
    if (s.active) {
      setStatusPill('is-live', t('live.statusLive', '🔴 Live'))
    } else if (lastStats.lastLine) {
      // Not active but we have a last line — likely stopped or failed.
      setStatusPill('is-idle', t('live.statusReady', 'Klar'))
    }
    updateStartButton(s.active)
    if (!s.active) {
      // Hide the live overlay when ffmpeg has exited.
      const tag = document.getElementById('live-preview-overlay-tag')
      if (tag) tag.style.display = 'none'
    } else {
      const tag = document.getElementById('live-preview-overlay-tag')
      if (tag) tag.style.display = ''
    }
  }) ?? undefined
}

async function refreshStatus(): Promise<void> {
  try {
    const s = await window.api.streamStatus()
    lastStats = s as StreamStats
    renderStats(lastStats)
    renderDestinationStates(lastStats.destinations)
    if (lastStats.active) {
      setStatusPill('is-live', t('live.statusLive', '🔴 Live'))
      const tag = document.getElementById('live-preview-overlay-tag')
      if (tag) tag.style.display = ''
    } else {
      setStatusPill('is-idle', t('live.statusReady', 'Klar'))
    }
    updateStartButton(lastStats.active)
  } catch (err) {
    console.warn('[live-page] refreshStatus failed', err)
  }
}

// ── Preview refresh ──────────────────────────────────────────────────────

async function refreshPreviewPath(): Promise<void> {
  try {
    const p = await window.api.streamPreviewPath()
    previewPathCached = typeof p === 'string' ? p : ''
  } catch { previewPathCached = '' }
}

function startPreviewInterval(): void {
  if (previewInterval) return
  // Reload the preview <img> every 2 s — a cache-busting query string forces
  // the browser to refetch the JPEG even though the path stays the same.
  previewInterval = setInterval(() => {
    if (!previewPathCached) return
    const img         = document.getElementById('live-preview-img') as HTMLImageElement | null
    const placeholder = document.getElementById('live-preview-placeholder')
    if (!img) return
    // Only show the preview while a stream is live (or recently was). When
    // idle, the snapshot file may not exist — fall back to placeholder.
    if (!lastStats.active) {
      img.style.display = 'none'
      if (placeholder) placeholder.style.display = ''
      return
    }
    img.style.display = ''
    if (placeholder) placeholder.style.display = 'none'
    img.src = `file://${previewPathCached}?t=${Date.now()}`
  }, 2000)
}

function startUptimeInterval(): void {
  if (uptimeInterval) return
  uptimeInterval = setInterval(() => {
    const el = document.getElementById('live-stat-uptime')
    if (!el) return
    if (!lastStats.active || !lastStats.startedAt) { el.textContent = '00:00'; return }
    const sec = Math.floor((Date.now() - lastStats.startedAt) / 1000)
    const mm  = String(Math.floor(sec / 60)).padStart(2, '0')
    const ss  = String(sec % 60).padStart(2, '0')
    el.textContent = `${mm}:${ss}`
  }, 1000)
}

// ── Destinations rendering ───────────────────────────────────────────────

function renderDestinations(): void {
  const list  = document.getElementById('live-destinations-list')
  const empty = document.getElementById('live-destinations-empty')
  if (!list) return
  const dests = settings.streamDestinations ?? []
  list.innerHTML = ''

  if (dests.length === 0) {
    if (empty) empty.style.display = ''
    updateStartButtonState()
    return
  }
  if (empty) empty.style.display = 'none'

  for (const d of dests) {
    if (!sessionEnabled.has(d.id)) sessionEnabled.set(d.id, d.enabled)
    const row = document.createElement('div')
    row.className = 'live-destination-row'
    row.dataset.destId = d.id
    row.innerHTML = `
      <span class="live-dest-dot" data-state="${d.enabled ? 'idle' : 'disabled'}"></span>
      <div class="live-dest-info">
        <div class="live-dest-name">${escHtml(d.name || d.rtmpUrl || '—')}</div>
        <div class="live-dest-state" data-i18n-fallback>${
          d.hasKey ? '' : '<span class="live-dest-warn">⚠ Mangler stream-key</span>'
        }</div>
      </div>
      <label class="toggle live-dest-toggle">
        <input type="checkbox" ${sessionEnabled.get(d.id) ? 'checked' : ''} />
        <span class="toggle-track"></span>
      </label>
    `
    const chk = row.querySelector<HTMLInputElement>('input[type="checkbox"]')
    chk?.addEventListener('change', () => {
      sessionEnabled.set(d.id, !!chk.checked)
      const dot = row.querySelector<HTMLElement>('.live-dest-dot')
      if (dot) dot.dataset.state = chk.checked ? 'idle' : 'disabled'
      updateStartButtonState()
    })
    list.appendChild(row)
  }
  updateStartButtonState()
}

function renderDestinationStates(arr: Array<{ id: string; state: string }>): void {
  for (const s of arr) {
    const row = document.querySelector<HTMLElement>(`.live-destination-row[data-dest-id="${CSS.escape(s.id)}"]`)
    const dot = row?.querySelector<HTMLElement>('.live-dest-dot')
    if (dot) dot.dataset.state = s.state
  }
}

// ── Stats rendering ──────────────────────────────────────────────────────

function renderStats(s: StreamStats): void {
  const setText = (id: string, v: string): void => { const el = document.getElementById(id); if (el) el.textContent = v }
  setText('live-stat-bitrate', `${s.bitrateKbps} kbps`)
  setText('live-stat-fps',     String(s.fps))
  setText('live-stat-dropped', String(s.dropped))
}

// ── Start / stop ─────────────────────────────────────────────────────────

async function onStartStopClick(alsoRecord: boolean): Promise<void> {
  const btn          = document.getElementById('btn-live-start') as HTMLButtonElement | null
  const streamOnlyBtn = document.getElementById('btn-live-start-stream-only') as HTMLButtonElement | null
  if (!btn) return
  hideError()
  if (lastStats.active) {
    btn.disabled = true
    if (streamOnlyBtn) streamOnlyBtn.disabled = true
    try { await window.api.streamStop() }
    finally {
      btn.disabled = false
      if (streamOnlyBtn) streamOnlyBtn.disabled = false
    }
    return
  }

  const dests = (settings.streamDestinations ?? []).filter(d => sessionEnabled.get(d.id) && d.hasKey)
  if (dests.length === 0) {
    showError(t('live.errNoActive', 'Ingen aktive destinasjoner med lagret stream-key.'))
    return
  }

  const resolution = (document.querySelector('input[name="live-resolution"]:checked') as HTMLInputElement | null)?.value
                  ?? settings.streamResolution ?? '720p'
  const framerate  = parseInt((document.getElementById('live-framerate') as HTMLSelectElement | null)?.value
                  ?? String(settings.streamFramerate ?? 30), 10) as 25 | 30

  setStatusPill('is-preparing', t('live.statusPreparing', 'Forbereder…'))
  btn.disabled = true
  if (streamOnlyBtn) streamOnlyBtn.disabled = true

  // Stop idle camera preview BEFORE asking main to spawn the stream
  // ffmpeg — avfoundation holds an exclusive lock on the camera, and
  // failing to release it first deadlocks the stream startup. We restart
  // the idle preview again in updateStartButton() when active=false.
  stopIdleCameraPreview()

  try {
    const result = await window.api.streamStart({
      resolution,
      framerate,
      videoBitrateKbps: settings.streamVideoBitrate ?? undefined,
      destinations: dests.map(d => ({ id: d.id, name: d.name, rtmpUrl: d.rtmpUrl, enabled: true })),
      alsoRecord,
    })
    if (!result.ok) {
      showError(result.error ?? t('live.connectionFailed', 'Tilkobling feilet'))
      setStatusPill('is-idle', t('live.statusReady', 'Klar'))
      // Stream-start failed — restart idle preview so the user isn't
      // staring at a black box wondering what's going on.
      startIdleCameraPreview()
      return
    }
    // The 'stream-stats' event will flip the pill to live; refresh preview path
    // now in case it just became available.
    refreshPreviewPath()
  } catch (err) {
    showError((err as Error).message)
    setStatusPill('is-idle', t('live.statusReady', 'Klar'))
    startIdleCameraPreview()
  } finally {
    btn.disabled = false
    if (streamOnlyBtn) streamOnlyBtn.disabled = false
  }
}

function updateStartButton(active: boolean): void {
  const btn          = document.getElementById('btn-live-start') as HTMLButtonElement | null
  const streamOnly   = document.getElementById('btn-live-start-stream-only') as HTMLButtonElement | null
  if (!btn) return
  const span = btn.querySelector('span')
  const wasActive = btn.classList.contains('is-active')
  if (active) {
    btn.classList.add('is-active')
    if (span) span.textContent = t('live.stopBtn', '■ Stopp')
    // While streaming, hide the secondary "stream-only" CTA — it would be
    // confusing to show a "start" button alongside an active stream.
    if (streamOnly) streamOnly.style.display = 'none'
  } else {
    btn.classList.remove('is-active')
    if (span) span.textContent = t('live.startBtn', '🔴 Start direktesending + opptak')
    if (streamOnly) streamOnly.style.display = ''
    // Stream just transitioned active → idle: restart idle camera-preview
    // so the user sees the camera again instead of a frozen last-snapshot.
    if (wasActive) startIdleCameraPreview()
  }
  updateStartButtonState()
}

function updateStartButtonState(): void {
  const btn = document.getElementById('btn-live-start') as HTMLButtonElement | null
  if (!btn) return
  if (lastStats.active) { btn.disabled = false; return }
  const hasActive = (settings.streamDestinations ?? []).some(d => sessionEnabled.get(d.id) && d.hasKey)
  btn.disabled = !hasActive
}

// ── Status pill helpers ──────────────────────────────────────────────────

function setStatusPill(stateClass: 'is-idle' | 'is-preparing' | 'is-live' | 'is-error', label: string): void {
  const pill = document.getElementById('live-status-pill')
  const text = document.getElementById('live-status-pill-text')
  if (!pill) return
  pill.classList.remove('is-idle', 'is-preparing', 'is-live', 'is-error')
  pill.classList.add(stateClass)
  if (text) text.textContent = label
}

function showError(msg: string): void {
  const el = document.getElementById('live-error')
  if (!el) return
  el.textContent = msg
  el.style.display = ''
}

function hideError(): void {
  const el = document.getElementById('live-error')
  if (el) el.style.display = 'none'
}

// ── Quality sync ─────────────────────────────────────────────────────────

function syncQualityFromSettings(): void {
  const res = settings.streamResolution ?? '720p'
  const r = document.querySelector<HTMLInputElement>(`input[name="live-resolution"][value="${res}"]`)
  if (r) r.checked = true
  const fr = settings.streamFramerate ?? 30
  const sel = document.getElementById('live-framerate') as HTMLSelectElement | null
  if (sel) sel.value = String(fr)
}

// ── Cross-tab refresh hook ───────────────────────────────────────────────

/** Called from publish-page when the user saves a new destinations list, so
 *  the Direkte-tab picks it up without needing a page navigation. Safe to
 *  call even if the page is not currently visible. */
export function notifyLivePageDestinationsChanged(): void {
  // Clear session toggles so the new destinations adopt their stored enabled
  // value next time the page activates.
  sessionEnabled.clear()
  const livePage = document.getElementById('page-live')
  if (livePage?.classList.contains('active')) {
    renderDestinations()
  }
}

// Tag unused declarations as referenced for stricter tsconfig settings.
export type { StreamDestinationStored }
