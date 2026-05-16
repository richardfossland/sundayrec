import { t } from '../i18n'

interface Cut { start: number; end: number }

// ── State ─────────────────────────────────────────────────────────────────
let filePath  = ''
let duration  = 0
let peaks: Float32Array | null = null   // 100 peaks/sec
let cuts: Cut[]  = []

// Viewport: which seconds are visible in the main canvas
let vpStart  = 0
let vpEnd    = 0   // set after peaks loaded

// Playback
let audioCtx: AudioContext | null = null
let sourceNode: AudioBufferSourceNode | null = null
let audioBuffer: AudioBuffer | null = null
let playStartCtxTime = 0   // audioCtx.currentTime when playback started
let playStartSec     = 0   // file-time at which playback started
let isPlaying        = false
let isPreview        = false
let rafId            = 0

// Drag state for cut creation
let dragStartSec = -1
let dragEndSec   = -1
let isDragging   = false

// ── DOM refs ──────────────────────────────────────────────────────────────
const $  = (id: string) => document.getElementById(id)
let canvas:    HTMLCanvasElement
let minimap:   HTMLCanvasElement
let minimapVp: HTMLElement

// ── Setup ─────────────────────────────────────────────────────────────────
export function setupEditorPage(): void {
  canvas    = $('editor-canvas')   as HTMLCanvasElement
  minimap   = $('editor-minimap')  as HTMLCanvasElement
  minimapVp = $('editor-minimap-vp')!

  $('btn-editor-open')?.addEventListener('click',   () => pickAndLoad())
  $('btn-editor-change')?.addEventListener('click', () => pickAndLoad())
  $('btn-editor-play')?.addEventListener('click',   () => togglePlay(false))
  $('btn-editor-preview')?.addEventListener('click',() => togglePlay(true))
  $('btn-zoom-in')?.addEventListener('click',  () => zoomBy(0.5))
  $('btn-zoom-out')?.addEventListener('click', () => zoomBy(2))
  $('btn-zoom-fit')?.addEventListener('click', () => fitAll())
  $('btn-editor-undo-all')?.addEventListener('click', () => { cuts = []; renderCutList(); drawWaveform(); drawMinimap() })

  $('btn-editor-save')?.addEventListener('click', () => openSaveModal())
  $('btn-save-new')?.addEventListener('click',     () => confirmSave('new'))
  $('btn-save-replace')?.addEventListener('click', () => confirmSave('replace'))
  $('btn-save-cancel')?.addEventListener('click',  () => closeSaveModal())

  $('btn-editor-prompt-open')?.addEventListener('click', () => {
    const fp = ($('editor-prompt-toast') as HTMLElement).dataset.path ?? ''
    dismissEditorPrompt()
    if (fp) openEditorWithFile(fp)
  })
  $('btn-editor-prompt-dismiss')?.addEventListener('click', dismissEditorPrompt)

  // Canvas mouse events
  canvas?.addEventListener('mousedown',  onCanvasDown)
  canvas?.addEventListener('mousemove',  onCanvasMove)
  canvas?.addEventListener('mouseup',    onCanvasUp)
  canvas?.addEventListener('mouseleave', onCanvasLeave)
  canvas?.addEventListener('wheel',      onCanvasWheel, { passive: false })

  // Resize observer keeps canvas dimensions correct
  if (canvas) {
    new ResizeObserver(() => { syncCanvasSize(); drawWaveform() }).observe(canvas.parentElement!)
  }

  showState('empty')
}

export function openEditorWithFile(fp: string): void {
  window.showPage('editor')
  loadFile(fp)
}

export function deactivateEditor(): void {
  stopPlay()
}

// ── File loading ──────────────────────────────────────────────────────────
async function pickAndLoad(): Promise<void> {
  const fp = await window.api.editorPickFile()
  if (fp) loadFile(fp)
}

async function loadFile(fp: string): Promise<void> {
  stopPlay()
  cuts = []
  filePath = fp
  peaks = null
  audioBuffer = null

  showState('loading')

  const raw = await window.api.editorReadFile(fp)
  if (!raw) { showState('empty'); return }

  // Convert Electron Buffer (arrives as Uint8Array) → ArrayBuffer
  const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
  const ab  = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer

  try {
    audioCtx   = new AudioContext()
    audioBuffer = await audioCtx.decodeAudioData(ab)
    duration   = audioBuffer.duration
    peaks      = computePeaks(audioBuffer)
  } catch {
    showState('empty')
    return
  }

  fitAll()
  const fname = fp.split('/').pop()?.split('\\').pop() ?? fp
  const el    = $('editor-filename')
  if (el) el.textContent = fname

  renderCutList()
  updateTimecode(0)
  updateTotalTime()
  syncCanvasSize()
  drawWaveform()
  drawMinimap()
  updateMinimapViewport()

  showState('workspace')
}

function computePeaks(buf: AudioBuffer): Float32Array {
  const RATE     = 100   // peaks per second
  const total    = Math.ceil(buf.duration * RATE)
  const out      = new Float32Array(total)
  const ch0      = buf.getChannelData(0)
  const ch1      = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0
  const samplesPerPeak = Math.floor(buf.sampleRate / RATE)

  for (let i = 0; i < total; i++) {
    const s = i * samplesPerPeak
    const e = Math.min(s + samplesPerPeak, ch0.length)
    let peak = 0
    for (let j = s; j < e; j++) {
      const v = Math.max(Math.abs(ch0[j]), Math.abs(ch1[j]))
      if (v > peak) peak = v
    }
    out[i] = peak
  }
  return out
}

// ── Drawing ───────────────────────────────────────────────────────────────
function syncCanvasSize(): void {
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const w   = canvas.parentElement!.clientWidth
  const h   = 200
  canvas.style.width  = w + 'px'
  canvas.style.height = h + 'px'
  canvas.width  = w * dpr
  canvas.height = h * dpr
}

function drawWaveform(): void {
  if (!canvas || !peaks) return
  const dpr  = window.devicePixelRatio || 1
  const ctx  = canvas.getContext('2d')!
  const W    = canvas.width / dpr
  const H    = canvas.height / dpr
  ctx.save()
  ctx.scale(dpr, dpr)

  // Background
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#13131c'
  ctx.fillRect(0, 0, W, H)

  const RATE    = 100
  const secPx   = W / (vpEnd - vpStart)   // pixels per second visible

  // Draw time ruler
  drawRuler(ctx, W, H, secPx)

  const midY  = H / 2
  const RULER = 22

  if (!peaks) { ctx.restore(); return }

  // Draw cut regions (red background)
  for (const c of cuts) {
    const x1 = secToX(c.start, W)
    const x2 = secToX(c.end,   W)
    ctx.fillStyle = 'rgba(239,68,68,0.18)'
    ctx.fillRect(x1, RULER, x2 - x1, H - RULER)
  }

  // Draw active drag region (orange)
  if (isDragging && dragStartSec >= 0) {
    const x1 = secToX(Math.min(dragStartSec, dragEndSec), W)
    const x2 = secToX(Math.max(dragStartSec, dragEndSec), W)
    ctx.fillStyle = 'rgba(251,146,60,0.25)'
    ctx.fillRect(x1, RULER, x2 - x1, H - RULER)
    ctx.strokeStyle = '#fb923c'
    ctx.lineWidth = 1
    ctx.strokeRect(x1, RULER, x2 - x1, H - RULER)
  }

  // Draw waveform bars
  const ACCENT = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#7c6dff'
  const RED    = '#ef4444'

  for (let px = 0; px < W; px++) {
    const sec   = vpStart + (px / W) * (vpEnd - vpStart)
    const pi    = Math.floor(sec * RATE)
    if (pi < 0 || pi >= peaks.length) continue

    const p    = peaks[pi]
    const barH = p * (H - RULER - 4) / 2
    const inCut = isInCut(sec) || (isDragging && isInDrag(sec))

    ctx.fillStyle = inCut ? RED : ACCENT
    ctx.globalAlpha = inCut ? 0.6 : 0.85
    ctx.fillRect(px, midY - barH, 1, barH * 2)
  }
  ctx.globalAlpha = 1

  // Cut boundary markers (red lines)
  for (const c of cuts) {
    for (const s of [c.start, c.end]) {
      const x = secToX(s, W)
      ctx.strokeStyle = '#ef4444'
      ctx.lineWidth   = 1.5
      ctx.beginPath()
      ctx.moveTo(x, RULER)
      ctx.lineTo(x, H)
      ctx.stroke()
    }
  }

  // Playhead
  if (isPlaying || playStartSec > 0) {
    const curSec = isPlaying
      ? playStartSec + (audioCtx!.currentTime - playStartCtxTime)
      : playStartSec
    const x = secToX(curSec, W)
    if (x >= 0 && x <= W) {
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth   = 1.5
      ctx.globalAlpha = 0.9
      ctx.beginPath()
      ctx.moveTo(x, RULER)
      ctx.lineTo(x, H)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  }

  ctx.restore()
}

function drawRuler(ctx: CanvasRenderingContext2D, W: number, H: number, secPx: number): void {
  const RULER = 22
  ctx.fillStyle = '#1a1a27'
  ctx.fillRect(0, 0, W, RULER)

  ctx.strokeStyle = '#333'
  ctx.lineWidth   = 1
  ctx.beginPath()
  ctx.moveTo(0, RULER); ctx.lineTo(W, RULER)
  ctx.stroke()

  // Pick a tick interval that gives ~80px between ticks
  const rawInterval   = (vpEnd - vpStart) * 80 / W
  const intervals     = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  const tickInterval  = intervals.find(v => v >= rawInterval) ?? 600

  ctx.fillStyle   = 'rgba(255,255,255,0.4)'
  ctx.font        = '10px system-ui, sans-serif'
  ctx.textBaseline = 'middle'

  const firstTick = Math.ceil(vpStart / tickInterval) * tickInterval
  for (let s = firstTick; s <= vpEnd; s += tickInterval) {
    const x = secToX(s, W)
    ctx.strokeStyle = 'rgba(255,255,255,0.2)'
    ctx.lineWidth   = 1
    ctx.beginPath(); ctx.moveTo(x, RULER - 6); ctx.lineTo(x, RULER); ctx.stroke()
    ctx.fillText(formatTime(s), x + 3, RULER / 2)
  }
}

function drawMinimap(): void {
  if (!minimap || !peaks) return
  const dpr  = window.devicePixelRatio || 1
  const W    = minimap.parentElement!.clientWidth
  const H    = 44
  minimap.style.width  = W + 'px'
  minimap.style.height = H + 'px'
  minimap.width  = W * dpr
  minimap.height = H * dpr

  const ctx  = minimap.getContext('2d')!
  ctx.save()
  ctx.scale(dpr, dpr)

  ctx.fillStyle = '#11111a'
  ctx.fillRect(0, 0, W, H)

  const RATE   = 100
  const ACCENT = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#7c6dff'
  const midY   = H / 2

  for (let px = 0; px < W; px++) {
    const sec  = (px / W) * duration
    const pi   = Math.floor(sec * RATE)
    if (pi < 0 || pi >= peaks.length) continue
    const p    = peaks[pi]
    const barH = p * (H - 4) / 2
    const inCut = isInCut(sec)
    ctx.fillStyle   = inCut ? '#ef4444' : ACCENT
    ctx.globalAlpha = inCut ? 0.5 : 0.6
    ctx.fillRect(px, midY - barH, 1, barH * 2)
  }
  ctx.globalAlpha = 1

  ctx.restore()
  updateMinimapViewport()
}

function updateMinimapViewport(): void {
  if (!minimapVp || !duration) return
  const W   = minimap.parentElement?.clientWidth ?? 0
  const x1  = (vpStart / duration) * W
  const x2  = (vpEnd   / duration) * W
  minimapVp.style.left  = x1 + 'px'
  minimapVp.style.width = (x2 - x1) + 'px'
}

// ── Viewport helpers ───────────────────────────────────────────────────────
function secToX(sec: number, W: number): number {
  return ((sec - vpStart) / (vpEnd - vpStart)) * W
}

function xToSec(x: number, W: number): number {
  return vpStart + (x / W) * (vpEnd - vpStart)
}

function fitAll(): void {
  vpStart = 0
  vpEnd   = duration || 1
}

function zoomBy(factor: number): void {
  const center = (vpStart + vpEnd) / 2
  const half   = ((vpEnd - vpStart) * factor) / 2
  vpStart = Math.max(0, center - half)
  vpEnd   = Math.min(duration, center + half)
  if (vpEnd - vpStart < 0.5) { const mid = (vpStart + vpEnd) / 2; vpStart = mid - 0.25; vpEnd = mid + 0.25 }
  drawWaveform()
  updateMinimapViewport()
}

function panBy(deltaSecs: number): void {
  const span = vpEnd - vpStart
  vpStart = Math.max(0, Math.min(duration - span, vpStart + deltaSecs))
  vpEnd   = vpStart + span
  drawWaveform()
  updateMinimapViewport()
}

function autoScrollToPlayhead(curSec: number): void {
  const span = vpEnd - vpStart
  if (curSec > vpEnd - span * 0.1) {
    vpStart = curSec - span * 0.05
    vpEnd   = vpStart + span
    if (vpEnd > duration) { vpEnd = duration; vpStart = duration - span }
    updateMinimapViewport()
  }
}

// ── Cut helpers ────────────────────────────────────────────────────────────
function isInCut(sec: number): boolean {
  return cuts.some(c => sec >= c.start && sec <= c.end)
}

function isInDrag(sec: number): boolean {
  const s = Math.min(dragStartSec, dragEndSec)
  const e = Math.max(dragStartSec, dragEndSec)
  return sec >= s && sec <= e
}

function addCut(s: number, e: number): void {
  if (e < s) [s, e] = [e, s]
  if (e - s < 0.1) return  // too short — ignore
  cuts.push({ start: s, end: e })
  // Merge overlapping
  cuts.sort((a, b) => a.start - b.start)
  const merged: Cut[] = []
  for (const c of cuts) {
    const prev = merged[merged.length - 1]
    if (prev && c.start <= prev.end) { prev.end = Math.max(prev.end, c.end) }
    else merged.push({ ...c })
  }
  cuts = merged
}

function deleteCut(i: number): void {
  cuts.splice(i, 1)
  renderCutList()
  drawWaveform()
  drawMinimap()
}

function getKeepSegs(): { start: number; end: number }[] {
  const sorted = [...cuts].sort((a, b) => a.start - b.start)
  const keeps: { start: number; end: number }[] = []
  let cursor = 0
  for (const c of sorted) {
    if (c.start > cursor + 0.05) keeps.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < duration - 0.05) keeps.push({ start: cursor, end: duration })
  return keeps
}

function renderCutList(): void {
  const panel = $('editor-cuts-panel')
  const list  = $('editor-cuts-list')
  const undo  = $('btn-editor-undo-all')
  if (!panel || !list || !undo) return

  if (cuts.length === 0) {
    panel.style.display = 'none'
    undo.style.display  = 'none'
    return
  }

  panel.style.display = ''
  undo.style.display  = ''
  list.innerHTML = cuts.map((c, i) => {
    const dur = c.end - c.start
    return `<div class="editor-cut-row">
      <div class="editor-cut-icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 5l10 10M5 15L15 5" stroke-linecap="round"/></svg></div>
      <div class="editor-cut-range">${formatTime(c.start)} – ${formatTime(c.end)}</div>
      <div class="editor-cut-dur">${formatDuration(dur)}</div>
      <button class="editor-cut-del" data-i="${i}" title="${t('editor.deleteCut') || 'Fjern kutt'}">✕</button>
    </div>`
  }).join('')

  list.querySelectorAll('.editor-cut-del').forEach(btn => {
    btn.addEventListener('click', () => deleteCut(parseInt((btn as HTMLElement).dataset.i!)))
  })
}

// ── Canvas mouse events ────────────────────────────────────────────────────
function onCanvasDown(e: MouseEvent): void {
  if (!peaks) return
  const rect = canvas.getBoundingClientRect()
  dragStartSec = xToSec(e.clientX - rect.left, rect.width)
  dragEndSec   = dragStartSec
  isDragging   = true
}

function onCanvasMove(e: MouseEvent): void {
  if (!isDragging || !peaks) return
  const rect   = canvas.getBoundingClientRect()
  dragEndSec   = xToSec(e.clientX - rect.left, rect.width)
  drawWaveform()
}

function onCanvasUp(e: MouseEvent): void {
  if (!isDragging || !peaks) return
  const rect  = canvas.getBoundingClientRect()
  const upSec = xToSec(e.clientX - rect.left, rect.width)
  isDragging  = false

  const dist  = Math.abs(upSec - dragStartSec)
  if (dist > 0.1) {
    // Created a cut region
    addCut(dragStartSec, upSec)
    renderCutList()
  } else {
    // Tap = seek
    stopPlay()
    playStartSec = Math.max(0, Math.min(duration, dragStartSec))
    updateTimecode(playStartSec)
  }

  dragStartSec = -1
  dragEndSec   = -1
  drawWaveform()
  drawMinimap()
}

function onCanvasLeave(): void {
  if (isDragging) {
    isDragging = false
    addCut(dragStartSec, dragEndSec)
    renderCutList()
    dragStartSec = -1; dragEndSec = -1
    drawWaveform(); drawMinimap()
  }
}

function onCanvasWheel(e: WheelEvent): void {
  e.preventDefault()
  if (e.ctrlKey || e.metaKey) {
    zoomBy(e.deltaY > 0 ? 1.2 : 0.8)
  } else {
    const span = vpEnd - vpStart
    panBy(e.deltaY * span / 800)
  }
}

// ── Playback ───────────────────────────────────────────────────────────────
function togglePlay(preview: boolean): void {
  if (isPlaying && isPreview === preview) { stopPlay(); return }
  stopPlay()
  startPlay(preview)
}

function startPlay(preview: boolean): void {
  if (!audioBuffer || !audioCtx) return
  isPreview = preview

  const segments = preview ? getKeepSegs() : [{ start: playStartSec, end: duration }]
  if (segments.length === 0) return

  // Find the segment that contains playStartSec (or the first after it)
  let segIdx = 0
  let segOffset = 0
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].end > playStartSec) {
      segIdx = i
      segOffset = Math.max(0, playStartSec - segments[i].start)
      break
    }
  }

  const segs = segments.slice(segIdx)
  if (segs.length === 0) return

  isPlaying = true
  playStartCtxTime = audioCtx.currentTime
  playStartSec     = segs[0].start + segOffset

  let when = audioCtx.currentTime
  const nodes: AudioBufferSourceNode[] = []

  for (let i = 0; i < segs.length; i++) {
    const seg    = segs[i]
    const offset = i === 0 ? segOffset : 0
    const dur    = seg.end - seg.start - offset
    if (dur <= 0) continue

    const node = audioCtx.createBufferSource()
    node.buffer = audioBuffer
    node.connect(audioCtx.destination)
    node.start(when, seg.start + offset, dur)
    when += dur
    nodes.push(node)
  }

  sourceNode = nodes[0] ?? null

  // Schedule stop
  const lastNode = nodes[nodes.length - 1]
  lastNode?.addEventListener('ended', () => {
    if (isPlaying) { isPlaying = false; cancelAnimationFrame(rafId); updatePlayIcon() }
  })

  updatePlayIcon()
  animate()
}

function stopPlay(): void {
  if (sourceNode) { try { sourceNode.stop() } catch { /* already stopped */ } }
  sourceNode = null
  if (isPlaying) {
    playStartSec = playStartSec + (audioCtx!.currentTime - playStartCtxTime)
    playStartSec = Math.max(0, Math.min(duration, playStartSec))
  }
  isPlaying = false
  cancelAnimationFrame(rafId)
  updatePlayIcon()
}

function animate(): void {
  if (!isPlaying) return
  const curSec = playStartSec + (audioCtx!.currentTime - playStartCtxTime)
  updateTimecode(curSec)
  autoScrollToPlayhead(curSec)
  drawWaveform()
  rafId = requestAnimationFrame(animate)
}

function updatePlayIcon(): void {
  const icon = $('editor-play-icon')
  if (!icon) return
  if (isPlaying && !isPreview) {
    icon.innerHTML = '<path d="M6 4h3v12H6V4zm5 0h3v12h-3V4z"/>'
  } else {
    icon.innerHTML = '<path d="M6.3 4.6a1 1 0 011.4 0l6 5a1 1 0 010 1.6l-6 5A1 1 0 016 15.4V4.6z"/>'
  }
}

// ── Save flow ──────────────────────────────────────────────────────────────
function openSaveModal(): void {
  if (cuts.length === 0 && getKeepSegs().length === 1 && getKeepSegs()[0].start === 0) return
  $('editor-save-modal')!.style.display = 'flex'
}

function closeSaveModal(): void {
  $('editor-save-modal')!.style.display = 'none'
}

async function confirmSave(mode: 'new' | 'replace'): Promise<void> {
  closeSaveModal()
  const btn = $('btn-editor-save') as HTMLButtonElement
  btn.disabled = true
  btn.textContent = t('editor.saving') || 'Lagrer…'

  const result = await window.api.editorSaveFile({
    inputPath:  filePath,
    cutRegions: cuts,
    duration,
    mode
  })

  btn.disabled = false
  btn.textContent = t('editor.save') || 'Lagre redigert fil'

  const row  = $('editor-result-row')!
  const text = $('editor-result-text')!
  row.style.display = ''

  if (result.ok) {
    const fname = (result.outputPath ?? '').split('/').pop()?.split('\\').pop() ?? ''
    text.textContent = (t('editor.saveOk') || '✓ Lagret') + (fname ? ' — ' + fname : '')
    row.style.color  = 'var(--green)'
  } else {
    text.textContent = (t('editor.saveError') || '✕ Feil') + (result.error ? ': ' + result.error : '')
    row.style.color  = 'var(--red)'
  }
}

// ── Editor prompt toast ────────────────────────────────────────────────────
export function showEditorPrompt(fp: string): void {
  const toast = $('editor-prompt-toast')!
  toast.dataset.path = fp
  toast.style.display = 'flex'
}

export function dismissEditorPrompt(): void {
  const toast = $('editor-prompt-toast')
  if (toast) { toast.style.display = 'none'; delete toast.dataset.path }
}

// ── Page state ─────────────────────────────────────────────────────────────
function showState(state: 'empty' | 'loading' | 'workspace'): void {
  $('editor-empty')!.style.display     = state === 'empty'     ? '' : 'none'
  $('editor-loading')!.style.display   = state === 'loading'   ? '' : 'none'
  $('editor-workspace')!.style.display = state === 'workspace' ? '' : 'none'
}

// ── Time formatting ────────────────────────────────────────────────────────
function formatTime(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${m}:${String(sec).padStart(2,'0')}`
}

function formatDuration(s: number): string {
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}

function updateTimecode(sec: number): void {
  const el = $('editor-time-cur')
  if (el) el.textContent = formatTime(sec)
}

function updateTotalTime(): void {
  const el = $('editor-time-tot')
  if (el) el.textContent = formatTime(duration)
}
