// ── editor-processing.ts ─────────────────────────────────────────────────
// Web Audio API processing chain: EQ → Compressor → Limiter → Normalization
// Mirrors the ffmpeg filter chain used at export time.

// ── EQ config ────────────────────────────────────────────────────────────
export const EQ_BANDS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
const EQ_Q = 1.41

// ── Interfaces ────────────────────────────────────────────────────────────
export interface ProcessingSettings {
  normalize:  { enabled: boolean; mode: 'peak' | 'lufs'; target: number; gainDb: number }
  compressor: { enabled: boolean; preset: string; threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number }
  eq:         { enabled: boolean; gains: number[] }
  limiter:    { enabled: boolean; ceiling: number }
}

// ── Compressor presets ────────────────────────────────────────────────────
export const COMP_PRESETS: Record<string, Partial<ProcessingSettings['compressor']>> = {
  church:    { threshold: -24, ratio: 2.5, attack: 30,  release: 250, knee: 6, makeup: 4 },
  podcast:   { threshold: -18, ratio: 4,   attack: 5,   release: 80,  knee: 3, makeup: 6 },
  music:     { threshold: -12, ratio: 6,   attack: 3,   release: 40,  knee: 2, makeup: 8 },
  broadcast: { threshold: -20, ratio: 3,   attack: 10,  release: 100, knee: 4, makeup: 5 },
  custom:    { threshold: -24, ratio: 4,   attack: 10,  release: 100, knee: 3, makeup: 3 },
}

// ── State ─────────────────────────────────────────────────────────────────
let state: ProcessingSettings = buildDefault()

function buildDefault(): ProcessingSettings {
  return {
    normalize:  { enabled: false, mode: 'peak', target: -1.0, gainDb: 0 },
    compressor: { enabled: false, preset: 'church', ...COMP_PRESETS.church },
    eq:         { enabled: false, gains: new Array(10).fill(0) },
    limiter:    { enabled: false, ceiling: -0.3 },
  }
}

// ── Web Audio nodes ───────────────────────────────────────────────────────
let eqNodes:      BiquadFilterNode[]        = []
let compNode:     DynamicsCompressorNode | null = null
let makeupGain:   GainNode | null           = null
let limiterNode:  DynamicsCompressorNode | null = null
let normGainNode: GainNode | null           = null

// Separate display nodes for frequency response (always available)
let displayCtx:  AudioContext | null = null
let displayEq:   BiquadFilterNode[]  = []

function ensureDisplayCtx(): void {
  if (displayCtx) return
  displayCtx = new AudioContext()
  displayEq  = EQ_BANDS.map((freq, i) => {
    const n = displayCtx!.createBiquadFilter()
    n.type = 'peaking'
    n.frequency.value = freq
    n.Q.value = EQ_Q
    n.gain.value = state.eq.gains[i]
    return n
  })
}

// ── Build playback chain ───────────────────────────────────────────────────
export function buildAudioChain(
  ctx: AudioContext,
  source: AudioNode,
  dest: AudioNode
): void {
  // EQ nodes
  eqNodes = EQ_BANDS.map((freq, i) => {
    const n = ctx.createBiquadFilter()
    n.type = 'peaking'
    n.frequency.value = freq
    n.Q.value = EQ_Q
    n.gain.value = state.eq.enabled ? state.eq.gains[i] : 0
    return n
  })

  source.connect(eqNodes[0])
  for (let i = 0; i < eqNodes.length - 1; i++) eqNodes[i].connect(eqNodes[i + 1])

  // Compressor
  compNode = ctx.createDynamicsCompressor()
  applyCompressorValues()
  eqNodes[eqNodes.length - 1].connect(compNode)

  // Makeup gain
  makeupGain = ctx.createGain()
  makeupGain.gain.value = state.compressor.enabled ? dbToLin(state.compressor.makeup) : 1
  compNode.connect(makeupGain)

  // Limiter
  limiterNode = ctx.createDynamicsCompressor()
  applyLimiterValues()
  makeupGain.connect(limiterNode)

  // Normalization gain
  normGainNode = ctx.createGain()
  normGainNode.gain.value = state.normalize.enabled ? dbToLin(state.normalize.gainDb) : 1
  limiterNode.connect(normGainNode)
  normGainNode.connect(dest)
}

function applyCompressorValues(): void {
  if (!compNode) return
  if (state.compressor.enabled) {
    compNode.threshold.value = state.compressor.threshold
    compNode.ratio.value     = state.compressor.ratio
    compNode.attack.value    = state.compressor.attack / 1000
    compNode.release.value   = state.compressor.release / 1000
    compNode.knee.value      = state.compressor.knee
  } else {
    compNode.threshold.value = 0
    compNode.ratio.value     = 1
    compNode.attack.value    = 0.02
    compNode.release.value   = 0.25
    compNode.knee.value      = 0
  }
}

function applyLimiterValues(): void {
  if (!limiterNode) return
  if (state.limiter.enabled) {
    limiterNode.threshold.value = state.limiter.ceiling
    limiterNode.ratio.value     = 20
    limiterNode.attack.value    = 0.001
    limiterNode.release.value   = 0.05
    limiterNode.knee.value      = 0
  } else {
    limiterNode.threshold.value = 0
    limiterNode.ratio.value     = 1
    limiterNode.attack.value    = 0.02
    limiterNode.release.value   = 0.25
    limiterNode.knee.value      = 0
  }
}

export function getGainReduction(): number {
  return compNode ? compNode.reduction : 0
}

// ── Normalization analysis ────────────────────────────────────────────────
export function analyzeAndComputeNormGain(buffer: AudioBuffer): number {
  const { peakDb, lufs } = analyzeBuffer(buffer)
  const source = state.normalize.mode === 'peak' ? peakDb : lufs
  const gain   = isFinite(source) ? Math.min(state.normalize.target - source, 24) : 0
  state.normalize.gainDb = gain
  if (normGainNode) normGainNode.gain.value = state.normalize.enabled ? dbToLin(gain) : 1
  return gain
}

export function analyzeBuffer(buffer: AudioBuffer): { peakDb: number; lufs: number } {
  let peak = 0
  let sumSq = 0
  let count = 0
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i])
      if (v > peak) peak = v
      sumSq += data[i] * data[i]
      count++
    }
  }
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity
  const rms    = Math.sqrt(sumSq / Math.max(1, count))
  const lufs   = rms > 0 ? 20 * Math.log10(rms) - 0.691 : -70
  return { peakDb, lufs }
}

// ── EQ frequency response canvas ──────────────────────────────────────────
export function drawEQCurve(canvas: HTMLCanvasElement): void {
  ensureDisplayCtx()
  const dpr = window.devicePixelRatio || 1
  const W   = canvas.offsetWidth  || canvas.clientWidth  || 400
  const H   = canvas.offsetHeight || canvas.clientHeight || 80
  if (W === 0 || H === 0) return
  canvas.width  = W * dpr
  canvas.height = H * dpr
  const ctx = canvas.getContext('2d')!
  ctx.save()
  ctx.scale(dpr, dpr)

  ctx.fillStyle = '#0c0c18'
  ctx.fillRect(0, 0, W, H)

  const DB_RANGE = 12

  // Grid lines
  for (const db of [-12, -6, 0, 6, 12]) {
    const y = H / 2 - (db / DB_RANGE) * (H / 2 - 6)
    ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.05)'
    ctx.lineWidth   = db === 0 ? 1 : 0.5
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
    if (db !== 0) {
      ctx.font      = '500 9px system-ui'
      ctx.fillStyle = 'rgba(255,255,255,0.18)'
      ctx.textBaseline = 'middle'
      ctx.fillText((db > 0 ? '+' : '') + db, 2, y)
    }
  }

  // Frequency gridlines
  for (const f of [100, 1000, 10000]) {
    const x = freqToX(f, W)
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth   = 0.5
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
  }

  if (!state.eq.enabled) {
    // Dashed flat line
    const y = H / 2
    ctx.strokeStyle = 'rgba(124,109,255,0.35)'
    ctx.lineWidth   = 1.5
    ctx.setLineDash([4, 5])
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()
    return
  }

  // Compute frequency response using display nodes
  const NUM = Math.max(W, 256)
  const freqArr  = new Float32Array(NUM)
  const magArr   = new Float32Array(NUM)
  const phaseArr = new Float32Array(NUM)
  const combined = new Float32Array(NUM).fill(1)

  for (let i = 0; i < NUM; i++) {
    freqArr[i] = 20 * Math.pow(1000, i / (NUM - 1))  // 20Hz → 20kHz log
  }
  for (const node of displayEq) {
    node.getFrequencyResponse(freqArr, magArr, phaseArr)
    for (let i = 0; i < NUM; i++) combined[i] *= magArr[i]
  }

  // Filled gradient area
  const grad = ctx.createLinearGradient(0, 0, 0, H)
  grad.addColorStop(0,   'rgba(124,109,255,0.28)')
  grad.addColorStop(0.5, 'rgba(124,109,255,0.08)')
  grad.addColorStop(1,   'rgba(124,109,255,0.01)')

  ctx.beginPath()
  for (let i = 0; i < NUM; i++) {
    const db = 20 * Math.log10(Math.max(combined[i], 1e-6))
    const y  = H / 2 - (db / DB_RANGE) * (H / 2 - 6)
    const x  = (i / (NUM - 1)) * W
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  }
  ctx.lineTo(W, H / 2); ctx.lineTo(0, H / 2); ctx.closePath()
  ctx.fillStyle = grad
  ctx.fill()

  // Curve line
  ctx.beginPath()
  for (let i = 0; i < NUM; i++) {
    const db = 20 * Math.log10(Math.max(combined[i], 1e-6))
    const y  = H / 2 - (db / DB_RANGE) * (H / 2 - 6)
    const x  = (i / (NUM - 1)) * W
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  }
  ctx.strokeStyle = 'rgba(167,157,255,0.9)'
  ctx.lineWidth   = 1.5
  ctx.stroke()

  // Band dots
  for (let b = 0; b < EQ_BANDS.length; b++) {
    if (Math.abs(state.eq.gains[b]) < 0.1) continue
    const x  = freqToX(EQ_BANDS[b], W)
    const db = state.eq.gains[b]
    const y  = H / 2 - (db / DB_RANGE) * (H / 2 - 6)
    ctx.fillStyle = 'rgba(167,157,255,0.7)'
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill()
  }

  ctx.restore()
}

function freqToX(f: number, W: number): number {
  return (Math.log10(f / 20) / Math.log10(1000)) * W
}

// ── FFmpeg filter strings ──────────────────────────────────────────────────
export function getFFmpegFilters(): string[] {
  const f: string[] = []

  if (state.eq.enabled) {
    for (let i = 0; i < EQ_BANDS.length; i++) {
      const g = state.eq.gains[i]
      if (Math.abs(g) < 0.05) continue
      f.push(`equalizer=f=${EQ_BANDS[i]}:width_type=o:width=2:g=${g.toFixed(2)}`)
    }
  }

  if (state.compressor.enabled) {
    const { threshold, ratio, attack, release, knee, makeup } = state.compressor
    const threshLin  = Math.pow(10, threshold / 20)
    const makeupLin  = Math.pow(10, makeup / 20)
    f.push(`acompressor=threshold=${threshLin.toFixed(6)}:ratio=${ratio}:attack=${attack}:release=${release}:knee=${knee}:makeup=${makeupLin.toFixed(4)}`)
  }

  if (state.limiter.enabled) {
    const lim = Math.pow(10, state.limiter.ceiling / 20)
    f.push(`alimiter=level_in=1:level_out=1:limit=${lim.toFixed(6)}:attack=5:release=50:asc=true`)
  }

  if (state.normalize.enabled && Math.abs(state.normalize.gainDb) > 0.05) {
    f.push(`volume=${state.normalize.gainDb.toFixed(2)}dB`)
  }

  return f
}

export function getProcessingState(): ProcessingSettings {
  return JSON.parse(JSON.stringify(state)) as ProcessingSettings
}

export function hasAnyProcessing(): boolean {
  return state.normalize.enabled || state.compressor.enabled || state.eq.enabled || state.limiter.enabled
}

// ── Runtime setters (update live nodes) ──────────────────────────────────
export function setEQEnabled(enabled: boolean): void {
  state.eq.enabled = enabled
  eqNodes.forEach((n, i) => { n.gain.value = enabled ? state.eq.gains[i] : 0 })
  displayEq.forEach((n, i) => { n.gain.value = enabled ? state.eq.gains[i] : 0 })
}

export function setEQGain(bandIdx: number, gainDb: number): void {
  state.eq.gains[bandIdx] = gainDb
  if (eqNodes[bandIdx])    eqNodes[bandIdx].gain.value    = state.eq.enabled ? gainDb : 0
  if (displayEq[bandIdx])  displayEq[bandIdx].gain.value  = state.eq.enabled ? gainDb : 0
}

export function setCompEnabled(enabled: boolean): void {
  state.compressor.enabled = enabled
  applyCompressorValues()
  if (makeupGain) makeupGain.gain.value = enabled ? dbToLin(state.compressor.makeup) : 1
}

export function setCompParam(key: keyof ProcessingSettings['compressor'], value: number): void {
  ;(state.compressor as Record<string, unknown>)[key] = value
  applyCompressorValues()
  if (key === 'makeup' && makeupGain) makeupGain.gain.value = state.compressor.enabled ? dbToLin(value) : 1
}

export function applyCompPreset(name: string): void {
  const preset = COMP_PRESETS[name]
  if (!preset) return
  state.compressor = { ...state.compressor, preset: name, ...preset }
  applyCompressorValues()
  if (makeupGain) makeupGain.gain.value = state.compressor.enabled ? dbToLin(state.compressor.makeup) : 1
}

export function setLimiterEnabled(enabled: boolean): void {
  state.limiter.enabled = enabled
  applyLimiterValues()
}

export function setLimiterCeiling(db: number): void {
  state.limiter.ceiling = db
  applyLimiterValues()
}

export function setNormEnabled(enabled: boolean): void {
  state.normalize.enabled = enabled
  if (normGainNode) normGainNode.gain.value = enabled ? dbToLin(state.normalize.gainDb) : 1
}

// ── UI setup ───────────────────────────────────────────────────────────────
const $ = (id: string): HTMLElement | null => document.getElementById(id)

export function setupProcessingPanel(onUpdate: () => void): void {
  ensureDisplayCtx()

  // ── Tab switching ──────────────────────────────────────────────────────
  document.querySelectorAll<HTMLElement>('.proc-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.proc-tab').forEach(t => t.classList.remove('active'))
      document.querySelectorAll<HTMLElement>('.proc-body').forEach(b => { b.style.display = 'none' })
      tab.classList.add('active')
      const body = $('proc-body-' + tab.dataset.tab)
      if (body) body.style.display = ''
      // Redraw EQ canvas when tab becomes visible
      if (tab.dataset.tab === 'eq') {
        const c = $('proc-eq-canvas') as HTMLCanvasElement | null
        if (c) setTimeout(() => drawEQCurve(c), 10)
      }
    })
  })

  // ── Normalization ──────────────────────────────────────────────────────
  wireToggle('proc-norm-enable', v => { setNormEnabled(v); onUpdate() })

  wireRadio('proc-norm-peak', () => { state.normalize.mode = 'peak' })
  wireRadio('proc-norm-lufs', () => { state.normalize.mode = 'lufs' })

  wireSlider('proc-norm-target', v => {
    state.normalize.target = v
    if (normGainNode && state.normalize.enabled) normGainNode.gain.value = dbToLin(state.normalize.gainDb)
  }, v => v.toFixed(1) + ' dBFS')

  $('btn-proc-norm-analyze')?.addEventListener('click', () => {
    const ev = new CustomEvent('proc-analyze-request')
    document.dispatchEvent(ev)
  })

  // ── Compressor ─────────────────────────────────────────────────────────
  wireToggle('proc-comp-enable', v => { setCompEnabled(v); onUpdate() })

  const presetSel = $('proc-comp-preset') as HTMLSelectElement | null
  presetSel?.addEventListener('change', () => {
    applyCompPreset(presetSel.value)
    syncCompSliders()
    onUpdate()
  })

  wireSlider('proc-comp-threshold', v => { setCompParam('threshold', v); markCustomPreset() }, v => v.toFixed(0) + ' dBFS')
  wireSlider('proc-comp-ratio',     v => { setCompParam('ratio', v);     markCustomPreset() }, v => v.toFixed(1) + ':1')
  wireSlider('proc-comp-attack',    v => { setCompParam('attack', v);    markCustomPreset() }, v => v.toFixed(0) + ' ms')
  wireSlider('proc-comp-release',   v => { setCompParam('release', v);   markCustomPreset() }, v => v.toFixed(0) + ' ms')
  wireSlider('proc-comp-makeup',    v => { setCompParam('makeup', v);    markCustomPreset() }, v => v.toFixed(1) + ' dB')

  // ── EQ ─────────────────────────────────────────────────────────────────
  wireToggle('proc-eq-enable', v => {
    setEQEnabled(v)
    const c = $('proc-eq-canvas') as HTMLCanvasElement | null
    if (c) drawEQCurve(c)
    onUpdate()
  })

  for (let i = 0; i < EQ_BANDS.length; i++) {
    const slider = $(`proc-eq-${i}`) as HTMLInputElement | null
    const valEl  = $(`proc-eq-val-${i}`)
    if (!slider) continue
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value)
      setEQGain(i, v)
      if (valEl) valEl.textContent = (v >= 0 ? '+' : '') + v.toFixed(1)
      const c = $('proc-eq-canvas') as HTMLCanvasElement | null
      if (c) drawEQCurve(c)
    })
  }

  $('btn-proc-eq-reset')?.addEventListener('click', () => {
    for (let i = 0; i < EQ_BANDS.length; i++) {
      setEQGain(i, 0)
      const sl = $(`proc-eq-${i}`) as HTMLInputElement | null
      const vl = $(`proc-eq-val-${i}`)
      if (sl) sl.value = '0'
      if (vl) vl.textContent = '0.0'
    }
    const c = $('proc-eq-canvas') as HTMLCanvasElement | null
    if (c) drawEQCurve(c)
  })

  // ResizeObserver for EQ canvas
  const eqCanvas = $('proc-eq-canvas') as HTMLCanvasElement | null
  if (eqCanvas) {
    new ResizeObserver(() => drawEQCurve(eqCanvas)).observe(eqCanvas)
  }

  // ── Limiter ────────────────────────────────────────────────────────────
  wireToggle('proc-limiter-enable', v => { setLimiterEnabled(v); onUpdate() })
  wireSlider('proc-limiter-ceiling', v => {
    setLimiterCeiling(v)
  }, v => v.toFixed(1) + ' dBFS')
}

// ── Sync UI helpers ─────────────────────────────────────────────────────────
export function syncCompSliders(): void {
  const set = (id: string, val: number, fmt: (v: number) => string) => {
    const sl = $(id) as HTMLInputElement | null
    const vl = $(`${id}-val`)
    if (sl) sl.value = String(val)
    if (vl) vl.textContent = fmt(val)
  }
  set('proc-comp-threshold', state.compressor.threshold, v => v.toFixed(0) + ' dBFS')
  set('proc-comp-ratio',     state.compressor.ratio,     v => v.toFixed(1) + ':1')
  set('proc-comp-attack',    state.compressor.attack,    v => v.toFixed(0) + ' ms')
  set('proc-comp-release',   state.compressor.release,   v => v.toFixed(0) + ' ms')
  set('proc-comp-makeup',    state.compressor.makeup,    v => v.toFixed(1) + ' dB')
}

function markCustomPreset(): void {
  state.compressor.preset = 'custom'
  const sel = $('proc-comp-preset') as HTMLSelectElement | null
  if (sel) sel.value = 'custom'
}

// ── Wire-up helpers ────────────────────────────────────────────────────────
function wireToggle(id: string, cb: (v: boolean) => void): void {
  const el = $(id) as HTMLInputElement | null
  if (!el) return
  el.addEventListener('change', () => cb(el.checked))
}

function wireRadio(id: string, cb: () => void): void {
  const el = $(id) as HTMLInputElement | null
  if (!el) return
  el.addEventListener('change', cb)
}

function wireSlider(id: string, cb: (v: number) => void, fmt: (v: number) => string): void {
  const sl = $(id) as HTMLInputElement | null
  const vl = $(`${id}-val`)
  if (!sl) return
  sl.addEventListener('input', () => {
    const v = parseFloat(sl.value)
    cb(v)
    if (vl) vl.textContent = fmt(v)
  })
}

// ── Util ────────────────────────────────────────────────────────────────────
function dbToLin(db: number): number { return Math.pow(10, db / 20) }
