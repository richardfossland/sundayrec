import { t } from '../i18n'
import {
  setupProcessingPanel, buildAudioChain, getFFmpegFilters,
  analyzeAndComputeNormGain, analyzeBuffer, hasAnyProcessing,
  getProcessingState, setNormEnabled, getGainReduction
} from './editor-processing'
import { destroyEQCanvas } from './editor-eq-canvas'
import { settings, patchSettings } from '../state'
import type { ChapterMarker, RecordingMetadata } from '../../types'

interface Cut { start: number; end: number }
interface Suggestion { start: number; end: number; duration: number; label: string; type: string }

// ── State ─────────────────────────────────────────────────────────────────
let filePath  = ''
let duration  = 0
let peaks: Float32Array | null = null
let cuts: Cut[] = []
let cutHistory: Cut[][] = []   // undo stack
let suggestions: Suggestion[] = []

// Intro/Outro
let introBuffer: AudioBuffer | null = null
let outroBuffer: AudioBuffer | null = null
let introDuration = 0
let outroDuration = 0
let includeIntroOutro = false

// Metadata + chapters
let meta: RecordingMetadata = { title: '', speaker: '', description: '', chapters: [] }
let metaDirty = false

// Viewport (seconds visible in main canvas)
let vpStart = 0
let vpEnd   = 0

// Playback
let audioCtx: AudioContext | null = null
let sourceNodes: AudioBufferSourceNode[] = []
let audioBuffer: AudioBuffer | null = null
let playStartCtxTime = 0
let playStartSec     = 0
let isPlaying        = false
let isPreview        = false
let rafId            = 0
let loadSeq          = 0

// Interaction state
let dragStartSec     = -1
let dragEndSec       = -1
let isDragging       = false
let hoverSec         = -1        // ghost cursor position
let minimapDragging  = false

// Export state
let exportOutputFolder = ''

// Clipping detection
let clipTimes: number[] = []

// Loop playback
let isLooping    = false
let loopStartSec = 0

// Cut handle dragging
interface HandleDrag { cutIdx: number; side: 'start' | 'end' }
let handleDrag: HandleDrag | null = null

// Playhead dragging (drag the playhead triangle)
let playheadDragging = false

// ── DOM refs ──────────────────────────────────────────────────────────────
const $ = (id: string) => document.getElementById(id)
let canvas:    HTMLCanvasElement
let minimap:   HTMLCanvasElement
let minimapVp: HTMLElement

// ── Colours (read from CSS variables once) ───────────────────────────────
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// ── Setup ─────────────────────────────────────────────────────────────────
export function setupEditorPage(): void {
  canvas    = $('editor-canvas')  as HTMLCanvasElement
  minimap   = $('editor-minimap') as HTMLCanvasElement
  minimapVp = $('editor-minimap-vp')!

  $('btn-editor-open')?.addEventListener('click',    () => pickAndLoad())
  $('btn-editor-change')?.addEventListener('click',  () => pickAndLoad())
  $('btn-editor-play')?.addEventListener('click',    () => togglePlay(false))
  $('btn-editor-preview')?.addEventListener('click', () => togglePlay(true))
  $('btn-zoom-in')?.addEventListener('click',   () => zoomBy(0.5))
  $('btn-zoom-out')?.addEventListener('click',  () => zoomBy(2))
  $('btn-zoom-fit')?.addEventListener('click',  () => fitAll())
  $('btn-editor-undo-all')?.addEventListener('click', () => {
    if (cuts.length === 0) return
    cutHistory.push([...cuts])
    cuts = []
    renderCutList()
    updateRemainingDisplay()
    drawWaveform()
    drawMinimap()
  })

  $('btn-editor-save')?.addEventListener('click',    () => openExportModal())
  $('btn-export-cancel')?.addEventListener('click',  () => closeExportModal())
  $('btn-export-confirm')?.addEventListener('click', () => runExport())

  // Format picker pills
  document.querySelectorAll<HTMLElement>('.export-fmt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.export-fmt-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      updateExportFormatUI(btn.dataset.fmt ?? 'mp3')
    })
  })

  // Destination picker
  document.querySelectorAll<HTMLElement>('.export-dest-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.export-dest-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      if (btn.dataset.dest === 'folder') {
        const folder = await window.api.editorPickOutputFolder()
        if (folder) {
          ($('export-folder-path') as HTMLElement).textContent = folder
          exportOutputFolder = folder
        } else {
          // Revert to same if cancelled
          document.querySelectorAll('.export-dest-btn').forEach(b => b.classList.remove('active'))
          document.querySelector<HTMLElement>('.export-dest-btn[data-dest="same"]')?.classList.add('active')
        }
      }
    })
  })

  // Processing panel toggle
  $('btn-proc-toggle')?.addEventListener('click', () => {
    const panel = $('editor-proc-panel')
    if (!panel) return
    const open = panel.style.display === 'none' || panel.style.display === ''
    panel.style.display = open ? '' : 'none'
    $('btn-proc-toggle')?.classList.toggle('active', open)
  })

  // Normalization analysis request from processing panel
  document.addEventListener('proc-analyze-request', async () => {
    if (!audioBuffer) return
    const gain = analyzeAndComputeNormGain(audioBuffer)
    const normResult = $('proc-norm-result')
    if (normResult) {
      const { peakDb, lufs } = analyzeBuffer(audioBuffer)
      normResult.textContent = `Peak: ${peakDb.toFixed(1)} dBFS · LUFS: ${lufs.toFixed(1)} · Gain: ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB`
    }
    setNormEnabled(true)
    const toggle = $('proc-norm-enable') as HTMLInputElement | null
    if (toggle) toggle.checked = true
  })

  setupProcessingPanel(() => {
    // called when any processing toggle changes — redraw waveform indicator
    const badge = $('proc-active-badge')
    if (badge) badge.style.display = hasAnyProcessing() ? '' : 'none'
  })

  $('btn-editor-prompt-open')?.addEventListener('click', () => {
    const fp = ($('editor-prompt-toast') as HTMLElement).dataset.path ?? ''
    dismissEditorPrompt()
    if (fp) openEditorWithFile(fp)
  })
  $('btn-editor-prompt-dismiss')?.addEventListener('click', dismissEditorPrompt)

  // Intro/Outro controls
  const ioChk = $('editor-include-io') as HTMLInputElement | null
  if (ioChk) {
    ioChk.addEventListener('change', () => {
      includeIntroOutro = ioChk.checked
      drawWaveform()
    })
  }

  $('btn-editor-pick-intro')?.addEventListener('click', async () => {
    const fp = await window.api.pickAudioFile()
    if (!fp) return
    patchSettings({ editorIntroPath: fp })
    await window.api.saveSettings(settings)
    await reloadIntroOutro()
  })
  $('btn-editor-clear-intro')?.addEventListener('click', async () => {
    patchSettings({ editorIntroPath: undefined })
    await window.api.saveSettings(settings)
    await reloadIntroOutro()
  })
  $('btn-editor-pick-outro')?.addEventListener('click', async () => {
    const fp = await window.api.pickAudioFile()
    if (!fp) return
    patchSettings({ editorOutroPath: fp })
    await window.api.saveSettings(settings)
    await reloadIntroOutro()
  })
  $('btn-editor-clear-outro')?.addEventListener('click', async () => {
    patchSettings({ editorOutroPath: undefined })
    await window.api.saveSettings(settings)
    await reloadIntroOutro()
  })

  // Metadata panel toggle
  $('btn-meta-toggle')?.addEventListener('click', () => {
    const body = $('editor-meta-body')
    if (!body) return
    const open = body.style.display === 'none'
    body.style.display = open ? '' : 'none'
    $('editor-meta-chevron')?.classList.toggle('open', open)
  })

  // Metadata autosave on change
  const metaFields: [string, keyof RecordingMetadata][] = [
    ['meta-title', 'title'], ['meta-speaker', 'speaker'], ['meta-description', 'description']
  ]
  for (const [id, field] of metaFields) {
    $(id)?.addEventListener('input', () => {
      const el = $(id) as HTMLInputElement | HTMLTextAreaElement | null
      if (el) (meta as Record<string, unknown>)[field] = el.value
      metaDirty = true
    })
  }

  // Segment detection
  $('btn-detect-segments')?.addEventListener('click', () => runDetection())

  // Add chapter at current playhead
  $('btn-add-chapter')?.addEventListener('click', () => {
    const time = Math.max(0, Math.min(duration, playStartSec))
    const title = `Kapittel ${meta.chapters.length + 1}`
    meta.chapters.push({ time, title })
    meta.chapters.sort((a, b) => a.time - b.time)
    metaDirty = true
    renderChapterList()
    drawWaveform()
  })

  // Meta save button
  $('btn-meta-save')?.addEventListener('click', saveMetadata)

  // Loop toggle
  $('btn-editor-loop')?.addEventListener('click', () => {
    isLooping = !isLooping
    $('btn-editor-loop')?.classList.toggle('active', isLooping)
  })

  // Clip badge — jump to first clip
  $('editor-clip-badge')?.addEventListener('click', () => {
    if (clipTimes.length === 0) return
    playStartSec = Math.max(0, clipTimes[0] - 1)
    updateTimecode(playStartSec)
    const half = (vpEnd - vpStart) / 2
    vpStart = Math.max(0, playStartSec - half * 0.3)
    vpEnd   = Math.min(duration, vpStart + half * 2)
    updateMinimapViewport()
    drawWaveform()
  })

  // Export progress listener
  window.api.on('editor-export-progress', (data: unknown) => {
    const { percent } = data as { percent: number }
    const bar   = $('editor-export-progress-bar')
    const label = $('editor-export-progress-label')
    if (bar)   bar.style.width   = Math.min(99, percent) + '%'
    if (label) label.textContent = `Eksporterer… ${Math.round(percent)}%`
  })

  // Canvas interactions
  canvas?.addEventListener('mousedown',   onCanvasDown)
  canvas?.addEventListener('mousemove',   onCanvasMove)
  canvas?.addEventListener('mouseup',     onCanvasUp)
  canvas?.addEventListener('mouseleave',  onCanvasLeave)
  canvas?.addEventListener('contextmenu', onCanvasContextMenu)
  canvas?.addEventListener('wheel',       onCanvasWheel, { passive: false })

  setupMinimapInteraction()
  setupKeyboardShortcuts()
  setupDragDrop()

  if (canvas) {
    new ResizeObserver(() => { syncCanvasSize(); drawWaveform() }).observe(canvas.parentElement!)
  }

  showState('empty')
  updateEditorIntroOutroDisplay()
}

export function openEditorWithFile(fp: string): void {
  window.showPage('editor')
  loadFile(fp)
}

export function deactivateEditor(): void {
  stopPlay()
  audioCtx?.close().catch(() => {})
  audioCtx = null
  audioBuffer = null
  introBuffer = null
  outroBuffer = null
  destroyEQCanvas()
}

// ── File loading ──────────────────────────────────────────────────────────
async function pickAndLoad(): Promise<void> {
  const fp = await window.api.editorPickFile()
  if (fp) loadFile(fp)
}

async function loadFile(fp: string): Promise<void> {
  const seq = ++loadSeq
  stopPlay()
  const prevCtx = audioCtx
  audioCtx = null
  prevCtx?.close().catch(() => {})

  cuts = []
  cutHistory = []
  suggestions = []
  filePath = fp
  peaks = null
  audioBuffer = null
  playStartSec = 0
  meta = { title: '', speaker: '', description: '', chapters: [] }
  metaDirty = false
  renderSuggestions()

  showState('loading')

  const raw = await window.api.editorReadFile(fp)
  if (!raw) { showState('empty'); return }

  const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
  const ab  = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer

  let localCtx: AudioContext | null = null
  try {
    localCtx = new AudioContext()
    const buf = await localCtx.decodeAudioData(ab)
    if (seq !== loadSeq) { localCtx.close().catch(() => {}); return }
    audioCtx    = localCtx
    audioBuffer = buf
    duration    = audioBuffer.duration
    peaks       = computePeaks(audioBuffer)
  } catch {
    localCtx?.close().catch(() => {})
    showState('empty')
    return
  }

  fitAll()
  const fname = fp.split(/[/\\]/).pop() ?? fp
  const el = $('editor-filename')
  if (el) el.textContent = fname

  // Load intro/outro buffers from settings (non-blocking)
  loadIntroOutroBuffers(seq)

  // Load metadata sidecar
  loadMetadataSidecar(fp, fname)

  renderCutList()
  updateRemainingDisplay()
  updateTimecode(0)
  updateTotalTime()

  // Clipping badge (shown after computePeaks)
  const clipBadge = $('editor-clip-badge')
  if (clipBadge) {
    clipBadge.style.display = clipTimes.length > 0 ? '' : 'none'
    if (clipTimes.length > 0) clipBadge.textContent = `⚠ ${clipTimes.length} klipp`
  }

  syncCanvasSize()
  drawWaveform()
  drawMinimap()
  updateMinimapViewport()
  showState('workspace')
}

async function reloadIntroOutro(): Promise<void> {
  await loadIntroOutroBuffers(loadSeq)
}

async function loadIntroOutroBuffers(seq: number): Promise<void> {
  const introPath = settings.editorIntroPath
  const outroPath = settings.editorOutroPath
  introBuffer = null; introDuration = 0
  outroBuffer = null; outroDuration = 0

  updateEditorIntroOutroDisplay()

  async function decodeAudio(path: string): Promise<AudioBuffer | null> {
    try {
      const raw = await window.api.editorReadFile(path)
      if (!raw) return null
      const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
      const tmpCtx = new AudioContext()
      const buf = await tmpCtx.decodeAudioData(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer)
      tmpCtx.close().catch(() => {})
      return buf
    } catch { return null }
  }

  if (introPath) {
    const buf = await decodeAudio(introPath)
    if (seq === loadSeq && buf) { introBuffer = buf; introDuration = buf.duration }
  }
  if (outroPath) {
    const buf = await decodeAudio(outroPath)
    if (seq === loadSeq && buf) { outroBuffer = buf; outroDuration = buf.duration }
  }
  if (seq === loadSeq) drawWaveform()
}

function updateEditorIntroOutroDisplay(): void {
  const introEl  = $('editor-intro-display')
  const outroEl  = $('editor-outro-display')
  const clrIntro = $('btn-editor-clear-intro') as HTMLElement | null
  const clrOutro = $('btn-editor-clear-outro') as HTMLElement | null
  const introPath = settings.editorIntroPath
  const outroPath = settings.editorOutroPath
  if (introEl) {
    const name = introPath?.split(/[/\\]/).pop() ?? ''
    introEl.textContent = name || 'Ingen fil valgt'
    introEl.style.color = name ? '' : 'var(--text3)'
    if (clrIntro) clrIntro.style.display = name ? '' : 'none'
  }
  if (outroEl) {
    const name = outroPath?.split(/[/\\]/).pop() ?? ''
    outroEl.textContent = name || 'Ingen fil valgt'
    outroEl.style.color = name ? '' : 'var(--text3)'
    if (clrOutro) clrOutro.style.display = name ? '' : 'none'
  }
}

async function loadMetadataSidecar(fp: string, fname: string): Promise<void> {
  const raw = await window.api.editorReadMeta(fp)
  if (raw && typeof raw === 'object') {
    meta = raw as RecordingMetadata
  } else {
    // Auto-fill title from filename (strip extension)
    meta = {
      title: fname.replace(/\.[^.]+$/, '').replace(/_redigert(_\d+)?$/, '').replace(/_/g, ' '),
      speaker: '',
      description: '',
      chapters: [],
    }
  }
  renderMetaPanel()
  renderChapterList()
}

async function saveMetadata(): Promise<void> {
  if (!filePath) return
  await window.api.editorSaveMeta(filePath, meta)
  metaDirty = false
  const btn = $('btn-meta-save')
  if (btn) { btn.textContent = '✓ Lagret'; setTimeout(() => { btn.textContent = 'Lagre metadata' }, 1500) }
}

function renderMetaPanel(): void {
  const titleEl = $('meta-title') as HTMLInputElement | null
  const spkEl   = $('meta-speaker') as HTMLInputElement | null
  const descEl  = $('meta-description') as HTMLTextAreaElement | null
  if (titleEl) titleEl.value = meta.title
  if (spkEl)   spkEl.value   = meta.speaker
  if (descEl)  descEl.value  = meta.description
}

function renderChapterList(): void {
  const list = $('chapter-list')
  if (!list) return
  list.innerHTML = ''
  const countEl = $('editor-chapter-count')
  if (countEl) {
    countEl.textContent = String(meta.chapters.length)
    countEl.style.display = meta.chapters.length ? '' : 'none'
  }
  if (meta.chapters.length === 0) {
    list.innerHTML = '<div class="editor-chapters-empty">Ingen kapitler ennå. Klikk «+ Legg til ved playhead» for å starte.</div>'
    return
  }
  for (let i = 0; i < meta.chapters.length; i++) {
    const ch = meta.chapters[i]
    const row = document.createElement('div')
    row.className = 'editor-chapter-row'

    const timeLbl = document.createElement('span')
    timeLbl.className = 'editor-chapter-time'
    timeLbl.textContent = formatTime(ch.time)
    timeLbl.title = 'Klikk for å søke'
    timeLbl.addEventListener('click', () => { playStartSec = ch.time; updateTimecode(ch.time); drawWaveform() })

    const nameInput = document.createElement('input')
    nameInput.className = 'editor-chapter-name'
    nameInput.value = ch.title
    nameInput.addEventListener('input', () => {
      meta.chapters[i].title = nameInput.value
      metaDirty = true
      drawWaveform()
    })

    const delBtn = document.createElement('button')
    delBtn.className = 'editor-chapter-del'
    delBtn.textContent = '✕'
    delBtn.addEventListener('click', () => {
      meta.chapters.splice(i, 1)
      metaDirty = true
      renderChapterList()
      drawWaveform()
    })

    row.appendChild(timeLbl)
    row.appendChild(nameInput)
    row.appendChild(delBtn)
    list.appendChild(row)
  }
}

// ── Segment detection ─────────────────────────────────────────────────────

async function runDetection(): Promise<void> {
  if (!filePath) return
  const btn       = $('btn-detect-segments') as HTMLButtonElement | null
  const analyzing = $('editor-segments-analyzing')
  if (btn)       { btn.disabled = true; btn.textContent = 'Analyserer…' }
  if (analyzing)   analyzing.style.display = ''

  suggestions = []
  renderSuggestions()

  const raw = await window.api.editorDetectSegments(filePath)
  suggestions = raw as Suggestion[]

  if (btn)       { btn.disabled = false; btn.textContent = 'Finn segmenter' }
  if (analyzing)   analyzing.style.display = 'none'
  renderSuggestions()
  drawWaveform()
}

function renderSuggestions(): void {
  const list = $('editor-segments-list')
  if (!list) return
  list.innerHTML = ''

  if (suggestions.length === 0) {
    list.innerHTML = '<div class="editor-chapters-empty">Ingen segmenter funnet — trykk «Finn segmenter» for å analysere opptaket.</div>'
    return
  }

  for (let i = 0; i < suggestions.length; i++) {
    const seg = suggestions[i]
    const row = document.createElement('div')
    row.className = 'editor-segment-row'

    const isSermon = seg.type === 'sermon'

    const badge = document.createElement('span')
    badge.className = 'editor-segment-badge' + (isSermon ? ' editor-segment-badge--sermon' : '')
    badge.textContent = isSermon ? '★' : '◆'

    const info = document.createElement('div')
    info.className = 'editor-segment-info'

    const timeEl = document.createElement('div')
    timeEl.className = 'editor-segment-time'
    timeEl.textContent = `${formatTime(seg.start)} – ${formatTime(seg.end)}`
    timeEl.title = 'Klikk for å gå til segmentet'
    timeEl.style.cursor = 'pointer'
    timeEl.addEventListener('click', () => {
      playStartSec = seg.start
      updateTimecode(seg.start)
      const half = Math.min((vpEnd - vpStart) / 2, seg.duration / 2)
      vpStart = Math.max(0, seg.start - half * 0.2)
      vpEnd   = Math.min(duration, vpStart + (seg.end - seg.start) * 1.15)
      updateMinimapViewport()
      drawWaveform()
    })

    const nameInput = document.createElement('input')
    nameInput.className = 'editor-segment-name'
    nameInput.value = seg.label
    nameInput.addEventListener('input', () => { suggestions[i].label = nameInput.value })

    info.appendChild(timeEl)
    info.appendChild(nameInput)

    const approveBtn = document.createElement('button')
    approveBtn.className = 'editor-segment-approve'
    approveBtn.title = 'Legg til som kapittelmarkør'
    approveBtn.textContent = '✓ Godkjenn'
    approveBtn.addEventListener('click', () => {
      const label = nameInput.value.trim() || seg.label
      meta.chapters.push({ time: seg.start, title: label })
      meta.chapters.sort((a, b) => a.time - b.time)
      metaDirty = true
      suggestions.splice(i, 1)
      renderSuggestions()
      renderChapterList()
      drawWaveform()
    })

    const dismissBtn = document.createElement('button')
    dismissBtn.className = 'editor-segment-dismiss'
    dismissBtn.title = 'Avvis forslag'
    dismissBtn.textContent = '✕'
    dismissBtn.addEventListener('click', () => {
      suggestions.splice(i, 1)
      renderSuggestions()
      drawWaveform()
    })

    row.appendChild(badge)
    row.appendChild(info)
    row.appendChild(approveBtn)
    row.appendChild(dismissBtn)
    list.appendChild(row)
  }
}

function computePeaks(buf: AudioBuffer): Float32Array {
  const RATE = 100
  const total = Math.ceil(buf.duration * RATE)
  const out   = new Float32Array(total)
  const ch0   = buf.getChannelData(0)
  const ch1   = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0
  const spp   = Math.floor(buf.sampleRate / RATE)
  clipTimes   = []

  for (let i = 0; i < total; i++) {
    const s = i * spp
    const e = Math.min(s + spp, ch0.length)
    let pk = 0
    for (let j = s; j < e; j++) {
      const v = Math.max(Math.abs(ch0[j]), Math.abs(ch1[j]))
      if (v > pk) pk = v
    }
    out[i] = pk
    if (pk >= 0.99) clipTimes.push(i / RATE)
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
  const W    = canvas.width  / dpr
  const H    = canvas.height / dpr
  ctx.save()
  ctx.scale(dpr, dpr)

  // Background
  const surfaceColor = cssVar('--surface') || '#13131c'
  ctx.fillStyle = surfaceColor
  ctx.fillRect(0, 0, W, H)

  const RULER  = 22
  const midY   = RULER + (H - RULER) / 2
  const maxBar = (H - RULER - 10) / 2
  const ACCENT = cssVar('--accent') || '#F0BB47'
  const RED    = '#ef4444'

  drawRuler(ctx, W, H, RULER)

  // Subtle centre line
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(W, midY); ctx.stroke()

  // Current playhead time (used for "past" shading)
  const curSec = isPlaying
    ? playStartSec + (audioCtx!.currentTime - playStartCtxTime)
    : playStartSec

  // ── Suggested segment backgrounds ─────────────────────────────────
  for (const seg of suggestions) {
    const x1 = secToX(seg.start, W), x2 = secToX(seg.end, W)
    if (x2 < 0 || x1 > W) continue
    const clampX1 = Math.max(0, x1), clampX2 = Math.min(x2, W)
    ctx.fillStyle = seg.type === 'sermon' ? 'rgba(34,197,94,0.10)' : 'rgba(34,197,94,0.06)'
    ctx.fillRect(clampX1, RULER, clampX2 - clampX1, H - RULER)
    // Boundary lines
    for (const bx of [x1, x2]) {
      if (bx < -2 || bx > W + 2) continue
      ctx.strokeStyle = '#22c55e'
      ctx.lineWidth   = 1.5
      ctx.globalAlpha = 0.55
      ctx.setLineDash([5, 4])
      ctx.beginPath(); ctx.moveTo(bx, RULER); ctx.lineTo(bx, H); ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }
    // Label inside region
    if (clampX2 - clampX1 > 40) {
      ctx.font = '600 9px system-ui, -apple-system, sans-serif'
      ctx.textBaseline = 'top'
      ctx.fillStyle = '#22c55e'
      ctx.globalAlpha = 0.85
      const lbl = seg.label.length > 18 ? seg.label.slice(0, 17) + '…' : seg.label
      ctx.fillText(lbl, Math.max(clampX1 + 4, 2), RULER + 24)
      ctx.globalAlpha = 1
    }
  }

  // ── Cut region backgrounds ─────────────────────────────────────────
  for (const c of cuts) {
    const x1 = secToX(c.start, W), x2 = secToX(c.end, W)
    if (x2 < 0 || x1 > W) continue
    ctx.fillStyle = 'rgba(239,68,68,0.13)'
    ctx.fillRect(Math.max(0, x1), RULER, Math.min(x2, W) - Math.max(0, x1), H - RULER)
  }

  // ── Active drag region ─────────────────────────────────────────────
  if (isDragging && dragStartSec >= 0) {
    const x1 = secToX(Math.min(dragStartSec, dragEndSec), W)
    const x2 = secToX(Math.max(dragStartSec, dragEndSec), W)
    ctx.fillStyle = 'rgba(251,146,60,0.18)'
    ctx.fillRect(x1, RULER, x2 - x1, H - RULER)
    ctx.strokeStyle = '#fb923c'
    ctx.lineWidth = 1.5
    ctx.strokeRect(x1 + 0.5, RULER + 0.5, x2 - x1 - 1, H - RULER - 1)
  }

  // ── Waveform bars (symmetric, mirrored above + below centre) ──────
  for (let px = 0; px < W; px++) {
    const sec = vpStart + (px / W) * (vpEnd - vpStart)
    const pi  = Math.floor(sec * 100)
    if (pi < 0 || pi >= peaks.length) continue

    const barH  = peaks[pi] * maxBar
    const inCut = isInCut(sec) || (isDragging && isInDrag(sec))
    const isPast = sec < curSec && (isPlaying || playStartSec > 0)

    ctx.fillStyle   = inCut ? RED : ACCENT
    ctx.globalAlpha = inCut ? 0.60 : isPast ? 0.30 : 0.82
    ctx.fillRect(px, midY - barH, 1, barH * 2)
  }
  ctx.globalAlpha = 1

  // ── Vignette — fades bars toward top and bottom of canvas ─────────
  // Extract RGB from surface colour for vignette
  const sRgb = surfaceColor.startsWith('#')
    ? hexToRgb(surfaceColor)
    : '19,19,28'
  const vignette = ctx.createLinearGradient(0, RULER, 0, H)
  vignette.addColorStop(0,    `rgba(${sRgb},0.70)`)
  vignette.addColorStop(0.22, `rgba(${sRgb},0.0)`)
  vignette.addColorStop(0.78, `rgba(${sRgb},0.0)`)
  vignette.addColorStop(1,    `rgba(${sRgb},0.70)`)
  ctx.fillStyle = vignette
  ctx.fillRect(0, RULER, W, H - RULER)

  // ── Cut boundary lines ─────────────────────────────────────────────
  for (const c of cuts) {
    for (const s of [c.start, c.end]) {
      const x = secToX(s, W)
      if (x < -2 || x > W + 2) continue
      ctx.strokeStyle = RED
      ctx.lineWidth   = 1.5
      ctx.globalAlpha = 0.75
      ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x, H); ctx.stroke()
      ctx.globalAlpha = 1
    }
  }

  // ── Cut duration labels inside cut regions ─────────────────────────
  ctx.font = '600 10px system-ui, -apple-system, sans-serif'
  ctx.textBaseline = 'middle'
  for (const c of cuts) {
    const x1 = secToX(c.start, W), x2 = secToX(c.end, W)
    if (x2 - x1 < 28) continue
    const label = formatDuration(c.end - c.start)
    const cx = Math.min(Math.max((x1 + x2) / 2, x1 + 4), x2 - 4)
    // Pill background
    const tw = ctx.measureText(label).width
    ctx.fillStyle = 'rgba(239,68,68,0.22)'
    ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(cx - tw / 2 - 5, midY - 9, tw + 10, 18, 4)
    else ctx.rect(cx - tw / 2 - 5, midY - 9, tw + 10, 18)
    ctx.fill()
    ctx.fillStyle = '#fca5a5'
    ctx.textAlign = 'center'
    ctx.fillText(label, cx, midY)
    ctx.textAlign = 'left'
  }

  // ── Drag time labels ───────────────────────────────────────────────
  if (isDragging && dragStartSec >= 0 && Math.abs(dragEndSec - dragStartSec) > 0.05) {
    const sA = Math.min(dragStartSec, dragEndSec)
    const sB = Math.max(dragStartSec, dragEndSec)
    ctx.font = '600 11px system-ui, -apple-system, sans-serif'
    ctx.textBaseline = 'alphabetic'

    for (const [sec, anchor] of [[sA, 'start'], [sB, 'end']] as [number, string][]) {
      const x = secToX(sec, W)
      const label = formatTime(sec)
      const tw = ctx.measureText(label).width
      const isLeft = anchor === 'start'
      const tx = isLeft
        ? Math.max(x + 4, 4)
        : Math.min(x - tw - 4, W - tw - 4)
      ctx.fillStyle = 'rgba(30,30,46,0.88)'
      if (ctx.roundRect) ctx.roundRect(tx - 3, RULER + 4, tw + 6, 16, 3)
      else ctx.rect(tx - 3, RULER + 4, tw + 6, 16)
      ctx.fill()
      ctx.fillStyle = '#fb923c'
      ctx.fillText(label, tx, RULER + 15)
    }
  }

  // ── Chapter markers ───────────────────────────────────────────────
  const CHAPTER_COLOR = '#06b6d4'
  for (const ch of meta.chapters) {
    const x = secToX(ch.time, W)
    if (x < -2 || x > W + 2) continue
    ctx.strokeStyle = CHAPTER_COLOR
    ctx.lineWidth   = 1.5
    ctx.globalAlpha = 0.85
    ctx.setLineDash([4, 3])
    ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x, H); ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1

    // Small triangle at top
    ctx.fillStyle = CHAPTER_COLOR
    ctx.beginPath()
    ctx.moveTo(x - 4, RULER)
    ctx.lineTo(x + 4, RULER)
    ctx.lineTo(x, RULER + 7)
    ctx.closePath()
    ctx.fill()

    // Label
    ctx.font = '600 9px system-ui, -apple-system, sans-serif'
    ctx.textBaseline = 'top'
    const label = ch.title.length > 14 ? ch.title.slice(0, 13) + '…' : ch.title
    const tw    = ctx.measureText(label).width
    const tx    = Math.min(Math.max(x + 3, 2), W - tw - 4)
    ctx.fillStyle = 'rgba(6,182,212,0.15)'
    if (ctx.roundRect) ctx.roundRect(tx - 2, RULER + 8, tw + 4, 13, 2)
    else ctx.rect(tx - 2, RULER + 8, tw + 4, 13)
    ctx.fill()
    ctx.fillStyle = CHAPTER_COLOR
    ctx.fillText(label, tx, RULER + 9)
    ctx.textBaseline = 'middle'
  }

  // ── Intro/Outro banners ────────────────────────────────────────────
  if (includeIntroOutro && (introDuration > 0 || outroDuration > 0)) {
    ctx.font = '600 10px system-ui, -apple-system, sans-serif'
    ctx.textBaseline = 'middle'
    if (introDuration > 0) {
      ctx.fillStyle = 'rgba(99,102,241,0.18)'
      ctx.fillRect(0, RULER, 70, H - RULER)
      ctx.strokeStyle = 'rgba(99,102,241,0.5)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(70, RULER); ctx.lineTo(70, H); ctx.stroke()
      ctx.fillStyle = '#818cf8'
      ctx.textAlign = 'center'
      ctx.fillText(`◀ INTRO ${formatDuration(introDuration)}`, 35, midY)
      ctx.textAlign = 'left'
    }
    if (outroDuration > 0) {
      ctx.fillStyle = 'rgba(99,102,241,0.18)'
      ctx.fillRect(W - 70, RULER, 70, H - RULER)
      ctx.strokeStyle = 'rgba(99,102,241,0.5)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(W - 70, RULER); ctx.lineTo(W - 70, H); ctx.stroke()
      ctx.fillStyle = '#818cf8'
      ctx.textAlign = 'center'
      ctx.fillText(`OUTRO ${formatDuration(outroDuration)} ▶`, W - 35, midY)
      ctx.textAlign = 'left'
    }
  }

  // ── Ghost cursor ───────────────────────────────────────────────────
  if (hoverSec >= vpStart && hoverSec <= vpEnd && !isDragging && peaks) {
    const x = secToX(hoverSec, W)
    ctx.setLineDash([3, 4])
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x, H); ctx.stroke()
    ctx.setLineDash([])

    // Timestamp tooltip at bottom
    const label = formatTime(hoverSec)
    ctx.font = '600 10px system-ui, -apple-system, sans-serif'
    ctx.textBaseline = 'middle'
    const tw = ctx.measureText(label).width
    const tx = Math.min(Math.max(x - tw / 2 - 5, 2), W - tw - 12)
    ctx.fillStyle = 'rgba(20,20,36,0.9)'
    if (ctx.roundRect) ctx.roundRect(tx, H - 22, tw + 10, 16, 4)
    else ctx.rect(tx, H - 22, tw + 10, 16)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.textAlign = 'center'
    ctx.fillText(label, tx + tw / 2 + 5, H - 14)
    ctx.textAlign = 'left'
  }

  // ── Playhead ───────────────────────────────────────────────────────
  if (curSec >= vpStart - 0.1 && curSec <= vpEnd + 0.1) {
    const x = secToX(curSec, W)
    if (x >= 0 && x <= W) {
      // Glow
      ctx.shadowColor = 'rgba(255,255,255,0.6)'
      ctx.shadowBlur  = 8
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth   = 1.5
      ctx.globalAlpha = 0.95
      ctx.beginPath(); ctx.moveTo(x, RULER + 10); ctx.lineTo(x, H); ctx.stroke()
      ctx.shadowBlur  = 0
      ctx.globalAlpha = 1

      // Triangle pointer at top
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.moveTo(x - 5, RULER)
      ctx.lineTo(x + 5, RULER)
      ctx.lineTo(x,     RULER + 9)
      ctx.closePath()
      ctx.fill()
    }
  }

  // ── Clipping indicators ────────────────────────────────────────
  if (clipTimes.length > 0) {
    ctx.fillStyle = '#ef4444'
    ctx.globalAlpha = 0.8
    for (const t of clipTimes) {
      const x = secToX(t, W)
      if (x < 0 || x > W) continue
      ctx.fillRect(x - 0.5, RULER, 1, 5)
    }
    ctx.globalAlpha = 1
  }

  // ── Cut handle hover highlights ────────────────────────────────
  if (hoverSec >= vpStart && hoverSec <= vpEnd && !isDragging && !handleDrag) {
    const threshold = (vpEnd - vpStart) / W * 10
    for (const c of cuts) {
      for (const side of ['start', 'end'] as const) {
        const t = c[side]
        if (Math.abs(hoverSec - t) < threshold) {
          const x = secToX(t, W)
          ctx.strokeStyle = '#fbbf24'
          ctx.lineWidth = 2
          ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x, H); ctx.stroke()
        }
      }
    }
  }

  ctx.restore()
}

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `${r},${g},${b}`
}

function drawRuler(ctx: CanvasRenderingContext2D, W: number, H: number, RULER: number): void {
  ctx.fillStyle = '#10101a'
  ctx.fillRect(0, 0, W, RULER)
  ctx.strokeStyle = 'rgba(255,255,255,0.07)'
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(0, RULER); ctx.lineTo(W, RULER); ctx.stroke()

  const rawInterval  = (vpEnd - vpStart) * 80 / W
  const intervals    = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  const tickInterval = intervals.find(v => v >= rawInterval) ?? 600
  const firstTick    = Math.ceil(vpStart / tickInterval) * tickInterval

  ctx.font        = '500 9px system-ui, -apple-system, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillStyle   = 'rgba(255,255,255,0.32)'

  for (let s = firstTick; s <= vpEnd; s += tickInterval) {
    const x = secToX(s, W)
    if (x < 0 || x > W) continue
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'
    ctx.lineWidth   = 1
    ctx.beginPath(); ctx.moveTo(x, RULER - 5); ctx.lineTo(x, RULER); ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,0.32)'
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

  ctx.fillStyle = '#0d0d16'
  ctx.fillRect(0, 0, W, H)

  const ACCENT = cssVar('--accent') || '#F0BB47'
  const midY   = H / 2

  for (let px = 0; px < W; px++) {
    const sec  = (px / W) * duration
    const pi   = Math.floor(sec * 100)
    if (pi < 0 || pi >= peaks.length) continue
    const barH = peaks[pi] * (H - 6) / 2
    const inCut = isInCut(sec)
    ctx.fillStyle   = inCut ? '#ef4444' : ACCENT
    ctx.globalAlpha = inCut ? 0.55 : 0.55
    ctx.fillRect(px, midY - barH, 1, barH * 2)
  }
  ctx.globalAlpha = 1

  // Vignette
  const vg = ctx.createLinearGradient(0, 0, 0, H)
  vg.addColorStop(0,   'rgba(13,13,22,0.5)')
  vg.addColorStop(0.3, 'rgba(13,13,22,0)')
  vg.addColorStop(0.7, 'rgba(13,13,22,0)')
  vg.addColorStop(1,   'rgba(13,13,22,0.5)')
  ctx.fillStyle = vg
  ctx.fillRect(0, 0, W, H)

  ctx.restore()
  updateMinimapViewport()
}

function updateMinimapViewport(): void {
  if (!minimapVp || !duration) return
  const W  = minimap.parentElement?.clientWidth ?? 0
  const x1 = (vpStart / duration) * W
  const x2 = (vpEnd   / duration) * W
  minimapVp.style.left  = x1 + 'px'
  minimapVp.style.width = (x2 - x1) + 'px'
}

// ── Minimap click / drag ──────────────────────────────────────────────────
function setupMinimapInteraction(): void {
  minimap?.addEventListener('mousedown', (e: MouseEvent) => {
    minimapDragging = true
    jumpViewportToMouse(e)
  })
  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (minimapDragging) jumpViewportToMouse(e)
  })
  window.addEventListener('mouseup', () => { minimapDragging = false })
}

function jumpViewportToMouse(e: MouseEvent): void {
  if (!duration || !minimap) return
  const rect   = minimap.getBoundingClientRect()
  const frac   = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  const center = frac * duration
  const half   = (vpEnd - vpStart) / 2
  vpStart = Math.max(0, Math.min(duration - half * 2, center - half))
  vpEnd   = vpStart + half * 2
  drawWaveform()
  updateMinimapViewport()
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────
function setupKeyboardShortcuts(): void {
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!document.getElementById('page-editor')?.classList.contains('active')) return
    if (!peaks) return
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLButtonElement) return

    switch (e.code) {
      case 'Space':
        e.preventDefault()
        togglePlay(isPlaying ? isPreview : false)
        break
      case 'ArrowLeft':
        e.preventDefault()
        seekBy(e.shiftKey ? -1 : -5)
        break
      case 'ArrowRight':
        e.preventDefault()
        seekBy(e.shiftKey ? 1 : 5)
        break
      case 'Equal':
      case 'NumpadAdd':
        if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); zoomBy(0.55) }
        break
      case 'Minus':
      case 'NumpadSubtract':
        e.preventDefault()
        zoomBy(1.7)
        break
      case 'KeyZ':
        if (e.metaKey || e.ctrlKey) { e.preventDefault(); undoCut() }
        break
      case 'Escape':
        if (isPlaying) stopPlay()
        break
      case 'KeyF':
        e.preventDefault()
        fitAll()
        drawWaveform()
        updateMinimapViewport()
        break
      case 'KeyL':
        e.preventDefault()
        isLooping = !isLooping
        $('btn-editor-loop')?.classList.toggle('active', isLooping)
        break
    }
  })
}

// ── Drag and drop ─────────────────────────────────────────────────────────
function setupDragDrop(): void {
  const page    = $('page-editor')
  const overlay = $('editor-drop-overlay')
  if (!page) return

  page.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    overlay?.classList.add('active')
  })

  page.addEventListener('dragleave', (e: DragEvent) => {
    if (!page.contains(e.relatedTarget as Node)) {
      overlay?.classList.remove('active')
    }
  })

  page.addEventListener('drop', async (e: DragEvent) => {
    e.preventDefault()
    overlay?.classList.remove('active')
    const file = e.dataTransfer?.files[0]
    if (!file) return
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (!['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'webm'].includes(ext)) return
    const fp = (file as File & { path?: string }).path
    if (fp) loadFile(fp)
  })
}

// ── Viewport helpers ──────────────────────────────────────────────────────
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
  const minSpan = 0.5
  if (vpEnd - vpStart < minSpan) {
    const mid = (vpStart + vpEnd) / 2
    vpStart = Math.max(0, mid - minSpan / 2)
    vpEnd   = Math.min(duration, vpStart + minSpan)
  }
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

function seekBy(secs: number): void {
  stopPlay()
  playStartSec = Math.max(0, Math.min(duration, playStartSec + secs))
  updateTimecode(playStartSec)
  // Pan viewport if playhead is outside
  if (playStartSec < vpStart || playStartSec > vpEnd) {
    const half = (vpEnd - vpStart) / 2
    vpStart = Math.max(0, playStartSec - half)
    vpEnd   = Math.min(duration, vpStart + half * 2)
    updateMinimapViewport()
  }
  drawWaveform()
}

function autoScrollToPlayhead(curSec: number): void {
  const span = vpEnd - vpStart
  if (curSec > vpEnd - span * 0.1) {
    vpStart = curSec - span * 0.05
    vpEnd   = vpStart + span
    if (vpEnd > duration) { vpEnd = duration; vpStart = Math.max(0, duration - span) }
    updateMinimapViewport()
  }
}

// ── Cut helpers ───────────────────────────────────────────────────────────
function isInCut(sec: number): boolean {
  return cuts.some(c => sec >= c.start && sec <= c.end)
}

function isInDrag(sec: number): boolean {
  if (!isDragging) return false
  const s = Math.min(dragStartSec, dragEndSec)
  const e = Math.max(dragStartSec, dragEndSec)
  return sec >= s && sec <= e
}

function addCut(s: number, e: number): void {
  if (e < s) [s, e] = [e, s]
  if (e - s < 0.1) return

  // Save state for undo
  cutHistory.push([...cuts])

  cuts.push({ start: s, end: e })
  cuts.sort((a, b) => a.start - b.start)

  // Merge overlapping
  const merged: Cut[] = []
  for (const c of cuts) {
    const prev = merged[merged.length - 1]
    if (prev && c.start <= prev.end + 0.01) { prev.end = Math.max(prev.end, c.end) }
    else merged.push({ ...c })
  }
  cuts = merged
  updateRemainingDisplay()
}

function deleteCut(i: number): void {
  cutHistory.push([...cuts])
  cuts.splice(i, 1)
  renderCutList()
  updateRemainingDisplay()
  drawWaveform()
  drawMinimap()
}

function undoCut(): void {
  if (cutHistory.length === 0) return
  cuts = cutHistory.pop()!
  renderCutList()
  updateRemainingDisplay()
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

function getRemainingDuration(): number {
  return getKeepSegs().reduce((sum, s) => sum + (s.end - s.start), 0)
}

function updateRemainingDisplay(): void {
  const el  = $('editor-remaining')
  const dur = $('editor-remaining-dur')
  if (!el || !duration) return

  if (cuts.length === 0) {
    el.style.display = 'none'
    return
  }

  const rem = getRemainingDuration()
  const cut = duration - rem
  el.style.display = 'flex'
  el.classList.toggle('has-cuts', cuts.length > 0)
  if (dur) dur.textContent = `${formatDuration(rem)} (fjerner ${formatDuration(cut)})`
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

  list.innerHTML = ''

  cuts.forEach((c, i) => {
    const dur = c.end - c.start
    const row = document.createElement('div')
    row.className = 'editor-cut-row'
    row.style.animationDelay = `${i * 0.05}s`

    // Thumbnail
    const thumb = document.createElement('div')
    thumb.className = 'editor-cut-thumb'
    if (peaks) {
      thumb.innerHTML = makeCutThumbnailSvg(c)
    }

    // Info
    const info = document.createElement('div')
    info.className = 'editor-cut-info'
    info.innerHTML = `<div class="editor-cut-range">${formatTime(c.start)} – ${formatTime(c.end)}</div>
      <div class="editor-cut-dur">${formatDuration(dur)}</div>`

    // Preview button (pre/post-roll)
    const prevBtn = document.createElement('button')
    prevBtn.className = 'editor-cut-prev'
    prevBtn.title = 'Spill 3s rundt kuttet'
    prevBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12"><path d="M6.3 4.6a1 1 0 011.4 0l6 5a1 1 0 010 1.6l-6 5A1 1 0 016 15.4V4.6z"/></svg>'
    prevBtn.addEventListener('click', () => previewCut(c))

    // Delete button
    const delBtn = document.createElement('button')
    delBtn.className = 'editor-cut-del'
    delBtn.title = t('editor.deleteCut') || 'Fjern kutt'
    delBtn.textContent = '✕'
    delBtn.addEventListener('click', () => deleteCut(i))

    row.appendChild(thumb)
    row.appendChild(info)
    row.appendChild(prevBtn)
    row.appendChild(delBtn)
    list.appendChild(row)
  })
}

function makeCutThumbnailSvg(cut: Cut): string {
  if (!peaks) return ''
  const W = 72, H = 24
  const startIdx = Math.floor(cut.start * 100)
  const endIdx   = Math.ceil(cut.end * 100)
  const count    = Math.max(1, endIdx - startIdx)
  const midY     = H / 2
  const rects: string[] = []
  for (let px = 0; px < W; px++) {
    const pi = startIdx + Math.floor(px / W * count)
    if (pi >= peaks.length) break
    const h = peaks[pi] * (midY - 2)
    rects.push(`<rect x="${px}" y="${(midY - h).toFixed(1)}" width="1" height="${(h * 2).toFixed(1)}"/>`)
  }
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block">${rects.join('')}</svg>`
}

function previewCut(cut: Cut): void {
  stopPlay()
  const PRE_ROLL = 3
  playStartSec = Math.max(0, cut.start - PRE_ROLL)
  updateTimecode(playStartSec)
  if (playStartSec < vpStart || playStartSec > vpEnd) {
    const half = (vpEnd - vpStart) / 2
    vpStart = Math.max(0, playStartSec - half * 0.3)
    vpEnd   = Math.min(duration, vpStart + half * 2)
    updateMinimapViewport()
  }
  startPlay(false)
}

// ── Canvas mouse events ───────────────────────────────────────────────────
function onCanvasDown(e: MouseEvent): void {
  if (!peaks || e.button !== 0) return
  const rect = canvas.getBoundingClientRect()
  const sec  = xToSec(e.clientX - rect.left, rect.width)

  // Check if clicking near a cut boundary → start handle drag
  const threshold = (vpEnd - vpStart) / rect.width * 10
  for (let i = 0; i < cuts.length; i++) {
    if (Math.abs(sec - cuts[i].start) < threshold) {
      cutHistory.push([...cuts])
      handleDrag = { cutIdx: i, side: 'start' }
      return
    }
    if (Math.abs(sec - cuts[i].end) < threshold) {
      cutHistory.push([...cuts])
      handleDrag = { cutIdx: i, side: 'end' }
      return
    }
  }

  // Check if clicking near playhead in the ruler area → playhead drag
  const yInCanvas = e.clientY - rect.top
  const playX = secToX(playStartSec, rect.width)
  if (Math.abs(e.clientX - rect.left - playX) < 12 && yInCanvas < 28) {
    playheadDragging = true
    stopPlay()
    return
  }

  // Normal drag to create cut
  dragStartSec = sec
  dragEndSec   = sec
  isDragging   = true
}

function onCanvasMove(e: MouseEvent): void {
  if (!peaks) return
  const rect = canvas.getBoundingClientRect()
  const sec  = xToSec(e.clientX - rect.left, rect.width)

  // Handle drag: resize cut boundary
  if (handleDrag) {
    const c = cuts[handleDrag.cutIdx]
    if (handleDrag.side === 'start') {
      c.start = Math.max(0, Math.min(c.end - 0.1, sec))
    } else {
      c.end   = Math.min(duration, Math.max(c.start + 0.1, sec))
    }
    updateRemainingDisplay()
    drawWaveform()
    return
  }

  // Playhead drag
  if (playheadDragging) {
    playStartSec = Math.max(0, Math.min(duration, sec))
    updateTimecode(playStartSec)
    drawWaveform()
    return
  }

  hoverSec = sec

  // Cursor feedback
  const threshold = (vpEnd - vpStart) / rect.width * 10
  const nearBoundary = cuts.some(c =>
    Math.abs(sec - c.start) < threshold || Math.abs(sec - c.end) < threshold
  )
  const overCut = cuts.some(c => sec >= c.start && sec <= c.end)
  const nearPlayhead = Math.abs(e.clientX - rect.left - secToX(playStartSec, rect.width)) < 12
    && (e.clientY - rect.top) < 28

  canvas.style.cursor = nearBoundary ? 'ew-resize'
    : nearPlayhead    ? 'col-resize'
    : overCut         ? 'pointer'
    : 'crosshair'

  if (isDragging) dragEndSec = sec

  drawWaveform()
}

function onCanvasUp(e: MouseEvent): void {
  if (!peaks) return
  const rect  = canvas.getBoundingClientRect()
  const upSec = xToSec(e.clientX - rect.left, rect.width)

  if (handleDrag) {
    handleDrag = null
    cuts.sort((a, b) => a.start - b.start)
    renderCutList()
    updateRemainingDisplay()
    drawWaveform()
    drawMinimap()
    return
  }

  if (playheadDragging) {
    playheadDragging = false
    drawWaveform()
    return
  }

  if (!isDragging) return
  isDragging = false

  if (Math.abs(upSec - dragStartSec) > 0.1) {
    addCut(dragStartSec, upSec)
    renderCutList()
  } else {
    // Tap to seek
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
  hoverSec = -1

  if (handleDrag) {
    handleDrag = null
    cuts.sort((a, b) => a.start - b.start)
    renderCutList()
    updateRemainingDisplay()
    drawWaveform(); drawMinimap()
    return
  }

  if (playheadDragging) {
    playheadDragging = false
    drawWaveform()
    return
  }

  if (isDragging) {
    isDragging = false
    if (Math.abs(dragEndSec - dragStartSec) > 0.1) {
      addCut(dragStartSec, dragEndSec)
      renderCutList()
    }
    dragStartSec = -1; dragEndSec = -1
    drawWaveform(); drawMinimap()
  } else {
    drawWaveform()
  }
}

function onCanvasContextMenu(e: MouseEvent): void {
  e.preventDefault()
  if (!peaks) return
  const rect = canvas.getBoundingClientRect()
  const sec  = xToSec(e.clientX - rect.left, rect.width)
  const idx  = cuts.findIndex(c => sec >= c.start && sec <= c.end)
  if (idx >= 0) deleteCut(idx)
}

function onCanvasWheel(e: WheelEvent): void {
  e.preventDefault()
  if (e.ctrlKey || e.metaKey) {
    // Zoom centered on mouse position
    const rect = canvas.getBoundingClientRect()
    const mouseSec = xToSec(e.clientX - rect.left, rect.width)
    const factor   = e.deltaY > 0 ? 1.25 : 0.75
    const span     = (vpEnd - vpStart) * factor
    const frac     = (mouseSec - vpStart) / (vpEnd - vpStart)
    vpStart = Math.max(0, mouseSec - frac * span)
    vpEnd   = Math.min(duration, vpStart + span)
    if (vpEnd - vpStart < 0.5) { vpEnd = vpStart + 0.5 }
    drawWaveform()
    updateMinimapViewport()
  } else {
    panBy(e.deltaY * (vpEnd - vpStart) / 800)
  }
}

// ── Playback ──────────────────────────────────────────────────────────────
function togglePlay(preview: boolean): void {
  if (isPlaying && isPreview === preview) { stopPlay(); return }
  stopPlay()
  startPlay(preview)
}

function startPlay(preview: boolean): void {
  if (!audioBuffer || !audioCtx) return
  isPreview = preview
  loopStartSec = playStartSec

  const allSegs  = preview ? getKeepSegs() : [{ start: 0, end: duration }]
  const segments = allSegs.filter(s => s.end > playStartSec)
  if (segments.length === 0) return

  isPlaying        = true
  playStartCtxTime = audioCtx.currentTime

  let when = audioCtx.currentTime
  const nodes: AudioBufferSourceNode[] = []
  let firstSec = -1

  const mixGain = audioCtx.createGain()
  buildAudioChain(audioCtx, mixGain, audioCtx.destination)

  // Schedule intro before main content (only when at start and preview mode)
  if (includeIntroOutro && introBuffer && playStartSec < 0.1) {
    const introNode = audioCtx.createBufferSource()
    introNode.buffer = introBuffer
    introNode.connect(mixGain)
    introNode.start(when)
    when += introDuration
    nodes.push(introNode)
  }

  for (let i = 0; i < segments.length; i++) {
    const seg    = segments[i]
    const offset = i === 0 ? Math.max(0, playStartSec - seg.start) : 0
    const dur    = seg.end - seg.start - offset
    if (dur <= 0.01) continue

    if (firstSec < 0) firstSec = seg.start + offset

    const node = audioCtx.createBufferSource()
    node.buffer = audioBuffer
    node.connect(mixGain)
    node.start(when, seg.start + offset, dur)
    when += dur
    nodes.push(node)
  }

  if (firstSec < 0) { isPlaying = false; return }
  playStartSec = firstSec
  sourceNodes  = nodes

  // Schedule outro after main content
  if (includeIntroOutro && outroBuffer) {
    const outroNode = audioCtx.createBufferSource()
    outroNode.buffer = outroBuffer
    outroNode.connect(mixGain)
    outroNode.start(when)
    nodes.push(outroNode)
  }

  nodes[nodes.length - 1]?.addEventListener('ended', () => {
    if (!isPlaying) return
    if (isLooping) {
      stopPlay()
      playStartSec = loopStartSec
      startPlay(isPreview)
    } else {
      isPlaying = false
      cancelAnimationFrame(rafId)
      updatePlayIcon()
      drawWaveform()
    }
  })

  updatePlayIcon()
  animate()
}

function stopPlay(): void {
  for (const n of sourceNodes) { try { n.stop() } catch { /* already stopped */ } }
  sourceNodes = []
  if (isPlaying) {
    playStartSec = Math.min(duration, playStartSec + (audioCtx!.currentTime - playStartCtxTime))
  }
  isPlaying = false
  cancelAnimationFrame(rafId)
  updatePlayIcon()
  drawWaveform()
}

function animate(): void {
  if (!isPlaying) return
  const curSec = playStartSec + (audioCtx!.currentTime - playStartCtxTime)
  updateTimecode(curSec)
  autoScrollToPlayhead(curSec)
  drawWaveform()
  updateGRMeter()
  rafId = requestAnimationFrame(animate)
}

function updateGRMeter(): void {
  const reduction = getGainReduction()
  const bar = document.getElementById('proc-gr-bar')
  const val = document.getElementById('proc-gr-val')
  const pct = Math.min(100, Math.max(0, -reduction * 100 / 20))
  if (bar) bar.style.width = pct + '%'
  if (val) val.textContent = reduction.toFixed(1) + ' dB'
}

function updatePlayIcon(): void {
  const icon       = $('editor-play-icon')
  const previewBtn = $('btn-editor-preview')
  const canvasWrap = $('editor-canvas-wrap')
  if (!icon) return
  if (isPlaying && !isPreview) {
    icon.innerHTML = '<rect x="5" y="4" width="4" height="12" rx="1"/><rect x="11" y="4" width="4" height="12" rx="1"/>'
    previewBtn?.classList.remove('is-playing')
    canvasWrap?.classList.add('is-playing')
  } else if (isPlaying && isPreview) {
    icon.innerHTML = '<path d="M6.3 4.6a1 1 0 011.4 0l6 5a1 1 0 010 1.6l-6 5A1 1 0 016 15.4V4.6z"/>'
    previewBtn?.classList.add('is-playing')
    canvasWrap?.classList.add('is-playing')
  } else {
    icon.innerHTML = '<path d="M6.3 4.6a1 1 0 011.4 0l6 5a1 1 0 010 1.6l-6 5A1 1 0 016 15.4V4.6z"/>'
    canvasWrap?.classList.remove('is-playing')
    previewBtn?.classList.remove('is-playing')
  }
}

// ── Export flow ────────────────────────────────────────────────────────────
function openExportModal(): void {
  if (!filePath) return
  // Update processing summary
  const summary = $('export-proc-summary')
  if (summary) {
    const active = []
    const ps = getProcessingState()
    if (ps.normalize.enabled)  active.push('Normalisering')
    if (ps.compressor.enabled) active.push('Kompressor')
    if (ps.eq.enabled)         active.push('Grafisk EQ')
    if (ps.limiter.enabled)    active.push('Limiter')
    summary.textContent = active.length ? active.join(' · ') : 'Ingen lydbehandling'
  }
  const ioRow     = $('export-io-row')
  const ioSummary = $('export-io-summary')
  if (ioRow && ioSummary) {
    const parts = []
    if (includeIntroOutro && settings.editorIntroPath) {
      parts.push('Intro: ' + (settings.editorIntroPath.split(/[/\\]/).pop() ?? ''))
    }
    if (includeIntroOutro && settings.editorOutroPath) {
      parts.push('Outro: ' + (settings.editorOutroPath.split(/[/\\]/).pop() ?? ''))
    }
    ioSummary.textContent = parts.length ? parts.join(' · ') : ''
    ioRow.style.display   = parts.length ? '' : 'none'
  }
  $('editor-export-modal')!.style.display = 'flex'
}

function closeExportModal(): void {
  $('editor-export-modal')!.style.display = 'none'
}

async function runExport(): Promise<void> {
  closeExportModal()
  const btn      = $('btn-editor-save') as HTMLButtonElement
  const progRow  = $('editor-export-progress-row')
  const progBar  = $('editor-export-progress-bar')
  const progLbl  = $('editor-export-progress-label')
  const resultRow = $('editor-result-row')!

  if (btn)     { btn.disabled = true; btn.textContent = t('editor.exportExporting') || 'Eksporterer…' }
  if (progRow) progRow.style.display = ''
  if (progBar) progBar.style.width   = '0%'
  if (resultRow) resultRow.style.display = 'none'

  const fmt = (document.querySelector<HTMLElement>('.export-fmt-btn.active')?.dataset.fmt ?? 'mp3') as 'mp3'|'wav'|'flac'|'aac'
  const dest = document.querySelector<HTMLElement>('.export-dest-btn.active')?.dataset.dest ?? 'same'
  const bitrate   = parseInt((($('export-bitrate')    as HTMLSelectElement)?.value  ?? '192'))
  const bitDepth  = parseInt((($('export-bitdepth')   as HTMLSelectElement)?.value  ?? '16')) as 16|24

  const mode: 'new' | 'replace' | 'folder' =
    dest === 'replace' ? 'replace' :
    dest === 'folder'  ? 'folder'  : 'new'

  // Auto-save metadata before export
  if (metaDirty) await saveMetadata()

  const result = await window.api.editorExportFile({
    inputPath:    filePath,
    cutRegions:   cuts,
    duration,
    mode,
    outputFolder: exportOutputFolder || undefined,
    outputFormat: fmt,
    outputBitrate:  bitrate,
    outputBitDepth: bitDepth,
    processing: { ffmpegFilters: getFFmpegFilters() },
    introPath:  (includeIntroOutro && settings.editorIntroPath) ? settings.editorIntroPath : undefined,
    outroPath:  (includeIntroOutro && settings.editorOutroPath) ? settings.editorOutroPath : undefined,
    metadata:   meta,
  })

  if (progRow) progRow.style.display = 'none'
  if (progBar) progBar.style.width   = '0%'
  if (btn) { btn.disabled = false; btn.textContent = t('editor.save') || 'Eksporter' }

  const row  = $('editor-result-row')!
  const text = $('editor-result-text')!
  row.style.display = ''

  if (result.ok) {
    const fname = (result.outputPath ?? '').split(/[/\\]/).pop() ?? ''
    text.textContent = (t('editor.saveOk') || '✓ Eksportert') + (fname ? ' — ' + fname : '')
    row.setAttribute('data-ok', 'true')
  } else {
    text.textContent = (t('editor.saveError') || '✕ Feil') + (result.error ? ': ' + result.error : '')
    row.removeAttribute('data-ok')
  }
}

function updateExportFormatUI(fmt: string): void {
  const mp3  = $('export-mp3-opts')
  const wav  = $('export-wav-opts')
  const aac  = $('export-aac-opts')
  if (mp3) mp3.style.display = fmt === 'mp3' ? '' : 'none'
  if (wav) wav.style.display = fmt === 'wav' ? '' : 'none'
  if (aac) aac.style.display = fmt === 'aac' ? '' : 'none'
}

// ── Editor prompt toast ───────────────────────────────────────────────────
export function showEditorPrompt(fp: string): void {
  const toast = $('editor-prompt-toast')!
  toast.dataset.path    = fp
  toast.style.display   = 'flex'
  // Auto-dismiss after 12s
  setTimeout(() => { if (toast.style.display !== 'none') dismissEditorPrompt() }, 12000)
}

export function dismissEditorPrompt(): void {
  const toast = $('editor-prompt-toast')
  if (!toast) return
  toast.classList.add('toast-dismissing')
  setTimeout(() => {
    toast.style.display = 'none'
    toast.classList.remove('toast-dismissing')
    delete toast.dataset.path
  }, 250)
}

// ── Page state ────────────────────────────────────────────────────────────
function showState(state: 'empty' | 'loading' | 'workspace'): void {
  $('editor-empty')!.style.display     = state === 'empty'     ? '' : 'none'
  $('editor-loading')!.style.display   = state === 'loading'   ? '' : 'none'
  $('editor-workspace')!.style.display = state === 'workspace' ? '' : 'none'
}

// ── Time formatting ───────────────────────────────────────────────────────
function formatTime(s: number): string {
  const h   = Math.floor(s / 3600)
  const m   = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${m}:${String(sec).padStart(2,'0')}`
}

function formatDuration(s: number): string {
  if (s < 1)   return `${(s * 1000).toFixed(0)}ms`
  if (s < 60)  return `${s.toFixed(1)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
  return `${Math.floor(s / 3600)}t ${Math.floor((s % 3600) / 60)}m`
}

function updateTimecode(sec: number): void {
  const el = $('editor-time-cur')
  if (el) el.textContent = formatTime(Math.min(sec, duration))
}

function updateTotalTime(): void {
  const el = $('editor-time-tot')
  if (el) el.textContent = formatTime(duration)
}
