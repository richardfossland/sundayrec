// ── editor-eq-canvas.ts ──────────────────────────────────────────────────
// Logic Pro-style parametric EQ with real-time spectrum analyzer.
// 8 bands: HP · LowShelf · PK×4 · HighShelf · LP
// Draggable nodes: horizontal = frequency, vertical = gain, scroll = Q.

// ── Interfaces ────────────────────────────────────────────────────────────
export type BandType = 'highpass' | 'lowshelf' | 'peaking' | 'highshelf' | 'lowpass'

export interface EQBand {
  id:      number
  type:    BandType
  freq:    number     // Hz
  gain:    number     // dB  (peaking / shelf only)
  q:       number     // 0.1 – 18
  enabled: boolean
  color:   string
  label:   string
}

// ── Default band layout ───────────────────────────────────────────────────
export const DEFAULT_BANDS: EQBand[] = [
  { id: 0, type: 'highpass',  freq: 80,    gain: 0,  q: 0.707, enabled: false, color: '#ff9f43', label: 'HP'  },
  { id: 1, type: 'lowshelf',  freq: 200,   gain: 0,  q: 0.707, enabled: false, color: '#feca57', label: 'LS'  },
  { id: 2, type: 'peaking',   freq: 400,   gain: 0,  q: 1.0,   enabled: false, color: '#48dbfb', label: '1'   },
  { id: 3, type: 'peaking',   freq: 1000,  gain: 0,  q: 1.0,   enabled: false, color: '#54a0ff', label: '2'   },
  { id: 4, type: 'peaking',   freq: 3000,  gain: 0,  q: 1.0,   enabled: false, color: '#a29bfe', label: '3'   },
  { id: 5, type: 'peaking',   freq: 8000,  gain: 0,  q: 1.0,   enabled: false, color: '#fd79a8', label: '4'   },
  { id: 6, type: 'highshelf', freq: 12000, gain: 0,  q: 0.707, enabled: false, color: '#e17055', label: 'HS'  },
  { id: 7, type: 'lowpass',   freq: 20000, gain: 0,  q: 0.707, enabled: false, color: '#d63031', label: 'LP'  },
]

// ── Presets ────────────────────────────────────────────────────────────────
type BandPatch = Partial<Pick<EQBand, 'freq'|'gain'|'q'|'enabled'>>[]

export const EQ_PRESETS: Record<string, BandPatch> = {
  flat: DEFAULT_BANDS.map(() => ({ gain: 0, enabled: false })),

  speech: [
    { freq: 100,  enabled: true  },                          // HP: cut rumble
    { freq: 200,  gain: 0,  enabled: false },                // LS: off
    { freq: 350,  gain: -2, q: 1.5, enabled: true  },       // PK1: cut muddy low-mids
    { freq: 1500, gain: +2, q: 1.0, enabled: true  },       // PK2: intelligibility
    { freq: 3000, gain: +4, q: 1.5, enabled: true  },       // PK3: presence
    { freq: 7000, gain: -2, q: 2.0, enabled: true  },       // PK4: tame sibilance
    { freq: 12000, gain: 0, enabled: false },                // HS: off
    { freq: 20000, enabled: false },                         // LP: off
  ],

  male: [
    { freq: 80,   enabled: true  },                          // HP
    { freq: 180,  gain: +2, q: 0.7, enabled: true  },       // LS: body
    { freq: 400,  gain: -1, q: 1.5, enabled: true  },       // PK1: muddiness
    { freq: 1200, gain: -1, q: 1.0, enabled: true  },       // PK2: nasality
    { freq: 3500, gain: +3, q: 1.5, enabled: true  },       // PK3: presence
    { freq: 8000, gain: +1, q: 1.0, enabled: true  },       // PK4: air
    { freq: 12000, gain: 0, enabled: false },
    { freq: 20000, enabled: false },
  ],

  female: [
    { freq: 120,  enabled: true  },                          // HP
    { freq: 200,  gain: -2, q: 0.7, enabled: true  },       // LS: cut excessive body
    { freq: 500,  gain: -2, q: 1.5, enabled: true  },       // PK1: muddiness
    { freq: 1000, gain: +1, q: 1.0, enabled: true  },       // PK2: warmth
    { freq: 4000, gain: +3, q: 1.5, enabled: true  },       // PK3: clarity
    { freq: 9000, gain: -2, q: 2.0, enabled: true  },       // PK4: sibilance
    { freq: 12000, gain: +2, q: 0.7, enabled: true  },      // HS: air
    { freq: 20000, enabled: false },
  ],

  church: [
    { freq: 60,   enabled: true  },                          // HP
    { freq: 120,  gain: +2, q: 0.7, enabled: true  },       // LS: bass body
    { freq: 300,  gain: -1, q: 2.0, enabled: true  },       // PK1: room mud
    { freq: 800,  gain: -1, q: 2.0, enabled: true  },       // PK2: boxy
    { freq: 3000, gain: +2, q: 1.5, enabled: true  },       // PK3: speech clarity
    { freq: 8000, gain: +1, q: 1.0, enabled: true  },       // PK4: brightness
    { freq: 10000, gain: +1, q: 0.7, enabled: true  },      // HS: air
    { freq: 20000, enabled: false },
  ],
}

// ── Canvas geometry ────────────────────────────────────────────────────────
const PAD = { l: 44, r: 14, t: 18, b: 32 }
const DB_RANGE  = 20    // ±20 dB
const FREQ_MIN  = 20
const FREQ_MAX  = 22000
const HIT_R     = 14    // hit-test radius (CSS px)
const NODE_R    = 7     // node circle radius (CSS px)

// ── Module state ──────────────────────────────────────────────────────────
let bands:        EQBand[]   = DEFAULT_BANDS.map(b => ({ ...b }))
let selectedId    = -1
let hoverBandId   = -1
let dragState: { id: number; startX: number; startY: number; startFreq: number; startGain: number } | null = null

let cvs:          HTMLCanvasElement | null = null
let analyserNode: AnalyserNode | null = null
let analyserData: Float32Array | null = null
let rafId         = 0
let onChangeCallback: (() => void) | null = null

// Display-only BiquadFilterNodes (never connected to audio graph)
let displayCtx:   AudioContext | null = null
let displayNodes: BiquadFilterNode[] = []

// ── Public API ─────────────────────────────────────────────────────────────
export function initEQCanvas(canvas: HTMLCanvasElement, onChange: () => void): void {
  cvs = canvas
  onChangeCallback = onChange
  ensureDisplayCtx()

  canvas.addEventListener('mousedown',   onMouseDown)
  canvas.addEventListener('mousemove',   onMouseMove)
  canvas.addEventListener('mouseup',     onMouseUp)
  canvas.addEventListener('mouseleave',  onMouseLeave)
  canvas.addEventListener('wheel',       onWheel, { passive: false })
  canvas.addEventListener('dblclick',    onDblClick)

  new ResizeObserver(() => { syncSize(); scheduleRedraw() }).observe(canvas)
  syncSize()
  scheduleRedraw()
}

export function setEQAnalyserNode(node: AnalyserNode | null): void {
  analyserNode = node
  if (node) {
    analyserData = new Float32Array(node.frequencyBinCount)
    scheduleRedraw()
  } else {
    analyserData = null
  }
}

export function getBands(): EQBand[] { return bands }

export function setBands(b: EQBand[]): void {
  bands = b.map(x => ({ ...x }))
  syncDisplayNodes()
  scheduleRedraw()
  onChangeCallback?.()
}

export function applyEQPreset(name: string): void {
  const patch = EQ_PRESETS[name]
  if (!patch) return
  bands = DEFAULT_BANDS.map((def, i) => ({
    ...def,
    ...(patch[i] ?? {}),
  }))
  syncDisplayNodes()
  scheduleRedraw()
  onChangeCallback?.()
}

export function getSelectedBandId(): number { return selectedId }

export function setSelectedBandId(id: number): void {
  selectedId = id
  scheduleRedraw()
}

/** Build Web Audio BiquadFilterNodes for the current band state */
export function buildEQNodes(ctx: AudioContext): BiquadFilterNode[] {
  return bands.map(b => {
    const n = ctx.createBiquadFilter()
    applyBandToNode(n, b)
    return n
  })
}

/** Get ffmpeg filter strings for all enabled bands */
export function getEQFFmpegFilters(): string[] {
  const filters: string[] = []
  for (const b of bands) {
    if (!b.enabled) continue
    switch (b.type) {
      case 'highpass':
        filters.push(`highpass=f=${b.freq.toFixed(0)}:poles=2`)
        break
      case 'lowpass':
        filters.push(`lowpass=f=${b.freq.toFixed(0)}:poles=2`)
        break
      case 'lowshelf':
        if (Math.abs(b.gain) > 0.05)
          filters.push(`equalizer=f=${b.freq.toFixed(0)}:width_type=s:width=0.5:g=${b.gain.toFixed(2)}`)
        break
      case 'highshelf':
        if (Math.abs(b.gain) > 0.05)
          filters.push(`equalizer=f=${b.freq.toFixed(0)}:width_type=s:width=0.5:g=${b.gain.toFixed(2)}`)
        break
      case 'peaking':
        if (Math.abs(b.gain) > 0.05)
          filters.push(`equalizer=f=${b.freq.toFixed(0)}:width_type=q:width=${b.q.toFixed(2)}:g=${b.gain.toFixed(2)}`)
        break
    }
  }
  return filters
}

export function hasEQActivity(): boolean {
  return bands.some(b => b.enabled)
}

export function destroyEQCanvas(): void {
  cancelAnimationFrame(rafId); rafId = 0
  analyserNode = null; analyserData = null
  displayCtx?.close(); displayCtx = null; displayNodes = []
  cvs = null; onChangeCallback = null
}

// ── Animation ─────────────────────────────────────────────────────────────
function scheduleRedraw(): void {
  cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => {
    draw()
    if (analyserNode) scheduleRedraw()
  })
}

// ── Drawing ────────────────────────────────────────────────────────────────
function draw(): void {
  if (!cvs) return
  const dpr = window.devicePixelRatio || 1
  const W   = cvs.width  / dpr
  const H   = cvs.height / dpr
  if (W === 0 || H === 0) return

  const ctx = cvs.getContext('2d')!
  ctx.save()
  ctx.scale(dpr, dpr)

  drawBackground(ctx, W, H)
  drawGrid(ctx, W, H)
  drawSpectrum(ctx, W, H)
  drawCurve(ctx, W, H)
  drawNodes(ctx, W, H)

  ctx.restore()
}

function drawBackground(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  ctx.fillStyle = '#090912'
  ctx.fillRect(0, 0, W, H)
  // Subtle radial vignette
  const vg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) / 1.5)
  vg.addColorStop(0, 'rgba(18,18,36,0)')
  vg.addColorStop(1, 'rgba(4,4,12,0.5)')
  ctx.fillStyle = vg
  ctx.fillRect(0, 0, W, H)
}

function drawGrid(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const iW = W - PAD.l - PAD.r
  const iH = H - PAD.t - PAD.b

  ctx.font      = '500 9px -apple-system, system-ui, sans-serif'
  ctx.textBaseline = 'middle'

  // dB gridlines
  for (let db = -DB_RANGE; db <= DB_RANGE; db += (DB_RANGE >= 15 ? 6 : 5)) {
    const y = gainToY_inner(db, iH) + PAD.t
    const is0 = db === 0
    ctx.strokeStyle = is0 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.04)'
    ctx.lineWidth   = is0 ? 1 : 0.5
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,0.22)'
    ctx.textAlign = 'right'
    ctx.fillText((db > 0 ? '+' : '') + db, PAD.l - 5, y)
  }

  // Frequency gridlines + labels
  const freqMarkers = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
  for (const f of freqMarkers) {
    const x = freqToX_inner(f, iW) + PAD.l
    ctx.strokeStyle = f === 1000 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)'
    ctx.lineWidth   = 0.5
    ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, H - PAD.b); ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,0.25)'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    const lbl = f >= 1000 ? (f / 1000) + 'k' : String(f)
    ctx.fillText(lbl, x, H - PAD.b + 4)
  }
}

function drawSpectrum(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  if (!analyserNode || !analyserData) return
  analyserNode.getFloatFrequencyData(analyserData)

  const iW   = W - PAD.l - PAD.r
  const iH   = H - PAD.t - PAD.b
  const sr   = analyserNode.context.sampleRate
  const bins = analyserData.length
  const base = H - PAD.b  // 0 dB line

  // Gradient fill
  const grad = ctx.createLinearGradient(0, PAD.t, 0, H - PAD.b)
  grad.addColorStop(0,   'rgba(232,184,75,0.55)')
  grad.addColorStop(0.4, 'rgba(232,184,75,0.2)')
  grad.addColorStop(1,   'rgba(232,184,75,0.0)')

  ctx.beginPath()
  ctx.moveTo(PAD.l, base)

  let firstPoint = true
  for (let i = 0; i < bins; i++) {
    const freq = (i / bins) * (sr / 2)
    if (freq < FREQ_MIN || freq > FREQ_MAX) continue
    const x = freqToX_inner(freq, iW) + PAD.l
    const db  = analyserData[i]
    // Map dB (-100..0) to canvas y (bottom..top within inner area)
    const dbClamped = Math.max(-80, Math.min(0, db))
    const normY = (dbClamped + 80) / 80   // 0..1
    const y = base - normY * iH * 0.85

    if (firstPoint) { ctx.lineTo(x, base); ctx.lineTo(x, y); firstPoint = false }
    else ctx.lineTo(x, y)
  }
  ctx.lineTo(W - PAD.r, base)
  ctx.closePath()
  ctx.fillStyle = grad
  ctx.fill()
}

function drawCurve(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  ensureDisplayCtx()
  if (!displayNodes.length) return

  const iW = W - PAD.l - PAD.r
  const iH = H - PAD.t - PAD.b
  const NUM = iW * 2

  const freqArr  = new Float32Array(NUM)
  const magArr   = new Float32Array(NUM)
  const phaseArr = new Float32Array(NUM)
  const combined = new Float32Array(NUM).fill(1)

  for (let i = 0; i < NUM; i++) {
    freqArr[i] = FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, i / (NUM - 1))
  }

  for (const node of displayNodes) {
    node.getFrequencyResponse(freqArr, magArr, phaseArr)
    for (let i = 0; i < NUM; i++) combined[i] *= magArr[i]
  }

  // Fill below curve
  const fillGrad = ctx.createLinearGradient(0, PAD.t, 0, H - PAD.b)
  fillGrad.addColorStop(0,   'rgba(232,184,75,0.22)')
  fillGrad.addColorStop(0.5, 'rgba(232,184,75,0.06)')
  fillGrad.addColorStop(1,   'rgba(232,184,75,0.0)')

  const zeroY = gainToY_inner(0, iH) + PAD.t

  ctx.beginPath()
  ctx.moveTo(PAD.l, zeroY)

  for (let i = 0; i < NUM; i++) {
    const db = 20 * Math.log10(Math.max(combined[i], 1e-6))
    const y  = gainToY_inner(db, iH) + PAD.t
    const x  = (i / (NUM - 1)) * iW + PAD.l
    if (i === 0) ctx.lineTo(x, y); else ctx.lineTo(x, y)
  }
  ctx.lineTo(W - PAD.r, zeroY)
  ctx.closePath()
  ctx.fillStyle = fillGrad
  ctx.fill()

  // Curve stroke
  ctx.beginPath()
  for (let i = 0; i < NUM; i++) {
    const db = 20 * Math.log10(Math.max(combined[i], 1e-6))
    const y  = gainToY_inner(db, iH) + PAD.t
    const x  = (i / (NUM - 1)) * iW + PAD.l
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  }
  ctx.strokeStyle = 'rgba(242,204,114,0.95)'
  ctx.lineWidth   = 1.8
  ctx.stroke()
}

function drawNodes(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const iW = W - PAD.l - PAD.r
  const iH = H - PAD.t - PAD.b

  for (const b of bands) {
    const x = freqToX_inner(b.freq, iW) + PAD.l
    const y = (b.type === 'highpass' || b.type === 'lowpass')
      ? gainToY_inner(0, iH) + PAD.t
      : gainToY_inner(b.gain, iH) + PAD.t

    const isSelected = b.id === selectedId
    const isHovered  = b.id === hoverBandId
    const alpha = b.enabled ? 1 : 0.3

    ctx.globalAlpha = alpha

    // Glow for selected/hovered
    if (isSelected || isHovered) {
      ctx.shadowColor = b.color
      ctx.shadowBlur  = isSelected ? 18 : 10
    }

    // Node circle
    ctx.beginPath()
    ctx.arc(x, y, isSelected ? NODE_R + 2 : NODE_R, 0, Math.PI * 2)

    if (b.enabled) {
      ctx.fillStyle = b.color
      ctx.fill()
    } else {
      ctx.strokeStyle = b.color
      ctx.lineWidth   = 1.5
      ctx.setLineDash([3, 3])
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Label inside node
    ctx.shadowBlur  = 0
    ctx.fillStyle   = b.enabled ? 'rgba(0,0,0,0.75)' : b.color
    ctx.font        = `700 ${NODE_R - 1}px -apple-system, system-ui, sans-serif`
    ctx.textAlign   = 'center'
    ctx.textBaseline = 'middle'
    if (b.enabled) ctx.fillText(b.label, x, y)

    // Selected band: freq + gain annotation
    if (isSelected) {
      const isFilter = b.type === 'highpass' || b.type === 'lowpass'
      const gainStr  = isFilter ? '' : (b.gain >= 0 ? '+' : '') + b.gain.toFixed(1) + 'dB'
      const freqStr  = b.freq >= 1000 ? (b.freq / 1000).toFixed(1) + 'k' : b.freq.toFixed(0) + 'Hz'
      const label    = isFilter ? freqStr : `${freqStr}  ${gainStr}`

      const bw  = ctx.measureText(label).width + 14
      const bx  = Math.max(PAD.l + 2, Math.min(x - bw / 2, W - PAD.r - bw - 2))
      const by  = y > (H - PAD.b) / 2 ? y - 30 : y + 16

      ctx.fillStyle = 'rgba(12,12,28,0.9)'
      ctx.shadowBlur = 0
      if (ctx.roundRect) ctx.roundRect(bx, by, bw, 18, 4)
      else ctx.rect(bx, by, bw, 18)
      ctx.fill()
      ctx.fillStyle = b.color
      ctx.font      = '600 10px -apple-system, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(label, bx + bw / 2, by + 9)
    }

    ctx.shadowBlur  = 0
    ctx.globalAlpha = 1
  }
}

// ── Mouse interaction ──────────────────────────────────────────────────────
function onMouseDown(e: MouseEvent): void {
  if (!cvs) return
  const [cx, cy] = clientToCanvas(e)
  const hit = hitTest(cx, cy)
  if (hit >= 0) {
    const b = bands[hit]
    selectedId  = b.id
    dragState   = { id: b.id, startX: cx, startY: cy, startFreq: b.freq, startGain: b.gain }
    cvs.style.cursor = 'grabbing'
    updateBandInfoUI()
    scheduleRedraw()
  } else {
    selectedId = -1
    updateBandInfoUI()
    scheduleRedraw()
  }
}

function onMouseMove(e: MouseEvent): void {
  if (!cvs) return
  const [cx, cy] = clientToCanvas(e)

  if (dragState) {
    const iW  = innerWidth()
    const iH  = innerHeight()
    const dx  = cx - dragState.startX
    const dy  = cy - dragState.startY
    const b   = bands.find(x => x.id === dragState!.id)!

    // Frequency: horizontal drag (log scale)
    const newFreq = dragState.startFreq * Math.pow(FREQ_MAX / FREQ_MIN, dx / iW)
    b.freq  = Math.max(FREQ_MIN, Math.min(FREQ_MAX * 0.99, newFreq))

    // Gain: vertical drag (for non-filter types)
    if (b.type !== 'highpass' && b.type !== 'lowpass') {
      const gainPerPx = (2 * DB_RANGE) / iH
      b.gain = Math.max(-DB_RANGE, Math.min(DB_RANGE, dragState.startGain - dy * gainPerPx))
      b.gain = Math.round(b.gain * 4) / 4  // snap to 0.25dB steps
    }

    b.enabled = true
    syncDisplayNodes()
    scheduleRedraw()
    updateBandInfoUI()
    onChangeCallback?.()
    return
  }

  const hit = hitTest(cx, cy)
  if (hit !== hoverBandId) {
    hoverBandId = hit
    cvs.style.cursor = hit >= 0 ? 'grab' : 'crosshair'
    scheduleRedraw()
  }
}

function onMouseUp(_e: MouseEvent): void {
  dragState = null
  if (cvs) cvs.style.cursor = hoverBandId >= 0 ? 'grab' : 'crosshair'
}

function onMouseLeave(_e: MouseEvent): void {
  dragState   = null
  hoverBandId = -1
  scheduleRedraw()
}

function onWheel(e: WheelEvent): void {
  e.preventDefault()
  if (selectedId < 0) return
  const b = bands.find(x => x.id === selectedId)
  if (!b || b.type === 'highpass' || b.type === 'lowpass') return
  const delta = e.deltaY > 0 ? 0.85 : 1 / 0.85
  b.q = Math.max(0.1, Math.min(18, b.q * delta))
  b.q = Math.round(b.q * 100) / 100
  syncDisplayNodes()
  scheduleRedraw()
  updateBandInfoUI()
  onChangeCallback?.()
}

function onDblClick(e: MouseEvent): void {
  const [cx, cy] = clientToCanvas(e)
  const hit = hitTest(cx, cy)
  if (hit >= 0) {
    bands[hit].enabled = !bands[hit].enabled
    syncDisplayNodes()
    scheduleRedraw()
    onChangeCallback?.()
  }
}

// ── Hit test ───────────────────────────────────────────────────────────────
function hitTest(cx: number, cy: number): number {
  if (!cvs) return -1
  const iW = innerWidth()
  const iH = innerHeight()
  let best = -1, bestD = HIT_R * HIT_R + 1

  for (const b of bands) {
    const nx = freqToX_inner(b.freq, iW) + PAD.l
    const ny = (b.type === 'highpass' || b.type === 'lowpass')
      ? gainToY_inner(0, iH) + PAD.t
      : gainToY_inner(b.gain, iH) + PAD.t
    const d = (cx - nx) ** 2 + (cy - ny) ** 2
    if (d < bestD) { bestD = d; best = bands.indexOf(b) }
  }
  return best
}

// ── Coordinate helpers ─────────────────────────────────────────────────────
function freqToX_inner(freq: number, iW: number): number {
  return (Math.log10(Math.max(freq, FREQ_MIN) / FREQ_MIN) / Math.log10(FREQ_MAX / FREQ_MIN)) * iW
}
function gainToY_inner(gain: number, iH: number): number {
  return (1 - (gain + DB_RANGE) / (2 * DB_RANGE)) * iH
}
function clientToCanvas(e: MouseEvent): [number, number] {
  const rect = cvs!.getBoundingClientRect()
  return [e.clientX - rect.left, e.clientY - rect.top]
}
function innerWidth():  number { return (cvs?.offsetWidth  ?? 400) - PAD.l - PAD.r }
function innerHeight(): number { return (cvs?.offsetHeight ?? 260) - PAD.t - PAD.b }

// ── Display nodes ─────────────────────────────────────────────────────────
function ensureDisplayCtx(): void {
  if (displayCtx) return
  displayCtx  = new AudioContext()
  displayNodes = bands.map(b => {
    const n = displayCtx!.createBiquadFilter()
    applyBandToNode(n, b)
    return n
  })
}

function syncDisplayNodes(): void {
  ensureDisplayCtx()
  bands.forEach((b, i) => {
    if (displayNodes[i]) applyBandToNode(displayNodes[i], b)
  })
}

function applyBandToNode(node: BiquadFilterNode, b: EQBand): void {
  node.type             = b.type
  node.frequency.value  = b.freq
  node.Q.value          = b.q
  node.gain.value       = b.enabled ? b.gain : 0
}

// ── Canvas size sync ──────────────────────────────────────────────────────
function syncSize(): void {
  if (!cvs) return
  const dpr = window.devicePixelRatio || 1
  const w   = cvs.offsetWidth
  const h   = cvs.offsetHeight
  if (w === 0 || h === 0) return
  cvs.width  = w * dpr
  cvs.height = h * dpr
}

// ── Band info UI ──────────────────────────────────────────────────────────
function updateBandInfoUI(): void {
  const panel = document.getElementById('eq-band-info')
  if (!panel) return
  if (selectedId < 0) {
    panel.style.display = 'none'
    return
  }
  const b = bands.find(x => x.id === selectedId)
  if (!b) { panel.style.display = 'none'; return }

  const freqStr = b.freq >= 1000 ? (b.freq / 1000).toFixed(1) + ' kHz' : b.freq.toFixed(0) + ' Hz'
  const isFilter = b.type === 'highpass' || b.type === 'lowpass'

  panel.style.display = 'flex'
  const typeMap: Record<BandType, string> = {
    highpass: 'HP', lowshelf: 'LS', peaking: 'PEQ', highshelf: 'HS', lowpass: 'LP'
  }
  const freqEl  = document.getElementById('eq-info-freq')
  const gainEl  = document.getElementById('eq-info-gain')
  const qEl     = document.getElementById('eq-info-q')
  const typeEl  = document.getElementById('eq-info-type')
  const colorEl = document.getElementById('eq-info-dot')

  if (freqEl)  freqEl.textContent  = freqStr
  if (gainEl)  gainEl.textContent  = isFilter ? '—' : (b.gain >= 0 ? '+' : '') + b.gain.toFixed(1) + ' dB'
  if (qEl)     qEl.textContent     = isFilter ? '—' : b.q.toFixed(2)
  if (typeEl)  typeEl.textContent  = typeMap[b.type]
  if (colorEl) (colorEl as HTMLElement).style.background = b.color
}
