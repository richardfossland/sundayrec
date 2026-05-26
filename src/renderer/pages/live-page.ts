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
import type { StreamDestinationStored } from '../../types'

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
  document.getElementById('btn-live-start')?.addEventListener('click', onStartStopClick)

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
}

// ── Activation lifecycle ─────────────────────────────────────────────────

export function reactivateLivePage(): void {
  // Sync UI from settings every time we land on the page (the user may have
  // added/removed destinations on the settings tab while we were away).
  syncQualityFromSettings()
  renderDestinations()
  refreshPreviewPath()
  // Pick up current stream state from main in case a stream is already alive.
  refreshStatus()
  startPreviewInterval()
  startUptimeInterval()
  subscribeStats()
  startVuMeter()
}

export function deactivateLivePage(): void {
  if (previewInterval) { clearInterval(previewInterval); previewInterval = null }
  if (uptimeInterval)  { clearInterval(uptimeInterval);  uptimeInterval  = null }
  if (unsubStats) { unsubStats(); unsubStats = undefined }
  stopVuMeter()
}

// ── VU meter (audio pre-stream confidence check) ─────────────────────────
//
// The agent left the VU bars as static placeholders. We hook a lightweight
// MediaStream + AnalyserNode chain so the user can SEE that the configured
// microphone is producing signal before they click Start. Stops cleanly on
// page leave to release the device.

interface VuState {
  ctx:    AudioContext | null
  stream: MediaStream  | null
  raf:    number
}
const liveVu: VuState = { ctx: null, stream: null, raf: 0 }

function startVuMeter(): void {
  if (liveVu.stream) return  // already running
  const fillL = document.querySelector<HTMLElement>('#live-vu-bar-l .live-vu-fill')
  const fillR = document.querySelector<HTMLElement>('#live-vu-bar-r .live-vu-fill')
  if (!fillL || !fillR) return

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
    const aL    = liveVu.ctx.createAnalyser()
    const aR    = liveVu.ctx.createAnalyser()
    aL.fftSize = 512
    aR.fftSize = 512
    src.connect(split)
    split.connect(aL, 0)
    split.connect(aR, 1)
    const bufL = new Uint8Array(aL.fftSize)
    const bufR = new Uint8Array(aR.fftSize)

    const tick = (): void => {
      if (!liveVu.stream) return
      // @ts-expect-error: getByteTimeDomainData accepts Uint8Array
      aL.getByteTimeDomainData(bufL)
      // @ts-expect-error: getByteTimeDomainData accepts Uint8Array
      aR.getByteTimeDomainData(bufR)
      const lvlL = peakLevel(bufL)
      const lvlR = peakLevel(bufR)
      fillL.style.width = `${Math.min(100, lvlL * 100)}%`
      fillR.style.width = `${Math.min(100, lvlR * 100)}%`
      liveVu.raf = requestAnimationFrame(tick)
    }
    tick()
  }).catch(err => {
    console.warn('[live-page] VU mic access failed', err)
  })
}

function stopVuMeter(): void {
  if (liveVu.raf) { cancelAnimationFrame(liveVu.raf); liveVu.raf = 0 }
  if (liveVu.stream) {
    for (const t of liveVu.stream.getTracks()) t.stop()
    liveVu.stream = null
  }
  if (liveVu.ctx) { void liveVu.ctx.close(); liveVu.ctx = null }
  const fillL = document.querySelector<HTMLElement>('#live-vu-bar-l .live-vu-fill')
  const fillR = document.querySelector<HTMLElement>('#live-vu-bar-r .live-vu-fill')
  if (fillL) fillL.style.width = '0%'
  if (fillR) fillR.style.width = '0%'
}

function peakLevel(buf: Uint8Array): number {
  let max = 0
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i] - 128) / 128
    if (v > max) max = v
  }
  return max
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

async function onStartStopClick(): Promise<void> {
  const btn = document.getElementById('btn-live-start') as HTMLButtonElement | null
  if (!btn) return
  hideError()
  if (lastStats.active) {
    btn.disabled = true
    try { await window.api.streamStop() }
    finally { btn.disabled = false }
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
  try {
    const result = await window.api.streamStart({
      resolution,
      framerate,
      videoBitrateKbps: settings.streamVideoBitrate ?? undefined,
      destinations: dests.map(d => ({ id: d.id, name: d.name, rtmpUrl: d.rtmpUrl, enabled: true })),
    })
    if (!result.ok) {
      showError(result.error ?? t('live.connectionFailed', 'Tilkobling feilet'))
      setStatusPill('is-idle', t('live.statusReady', 'Klar'))
      return
    }
    // The 'stream-stats' event will flip the pill to live; refresh preview path
    // now in case it just became available.
    refreshPreviewPath()
  } catch (err) {
    showError((err as Error).message)
    setStatusPill('is-idle', t('live.statusReady', 'Klar'))
  } finally {
    btn.disabled = false
  }
}

function updateStartButton(active: boolean): void {
  const btn = document.getElementById('btn-live-start') as HTMLButtonElement | null
  if (!btn) return
  const span = btn.querySelector('span')
  if (active) {
    btn.classList.add('is-active')
    if (span) span.textContent = t('live.stopBtn', '■ Stopp')
  } else {
    btn.classList.remove('is-active')
    if (span) span.textContent = t('live.startBtn', '▶ Start direktesending')
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
