// ── editor-processing.ts ─────────────────────────────────────────────────
// Web Audio API processing chain: EQ → Compressor → Limiter → Normalization
// Mirrors the ffmpeg filter chain used at export time.

import {
  buildEQNodes,
  getBands,
  getEQFFmpegFilters,
  hasEQActivity,
  initEQCanvas,
  setEQAnalyserNode,
  applyEQPreset,
} from './editor-eq-canvas'

// ── Interfaces ────────────────────────────────────────────────────────────
export interface ProcessingSettings {
  normalize:       { enabled: boolean; mode: 'peak' | 'lufs'; target: number; gainDb: number }
  compressor:      { enabled: boolean; preset: string; threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number }
  eq:              { enabled: boolean }
  limiter:         { enabled: boolean; ceiling: number }
  noiseReduction:  { enabled: boolean; level: 0 | 1 | 2 | 3 }
  reverbReduction: { enabled: boolean; level: 0 | 1 | 2 | 3 }
}

// ── Compressor presets ────────────────────────────────────────────────────
export const COMP_PRESETS: Record<string, Partial<ProcessingSettings['compressor']>> = {
  church:    { threshold: -24, ratio: 2.5, attack: 30,  release: 250, knee: 6, makeup: 4 },
  podcast:   { threshold: -18, ratio: 4,   attack: 5,   release: 80,  knee: 3, makeup: 6 },
  music:     { threshold: -12, ratio: 6,   attack: 3,   release: 40,  knee: 2, makeup: 8 },
  broadcast: { threshold: -20, ratio: 3,   attack: 10,  release: 100, knee: 4, makeup: 5 },
  custom:    { threshold: -24, ratio: 4,   attack: 10,  release: 100, knee: 3, makeup: 3 },
}

// Noise reduction: ffmpeg afftdn noise floor values per level
const NOISE_LEVELS = [-999, -50, -38, -25] as const   // level 0=off
// Reverb reduction: agate open/close thresholds per level
const REVERB_GATE: Array<{ open: number; close: number }> = [
  { open: -999, close: -999 },
  { open: -35, close: -45 },
  { open: -28, close: -38 },
  { open: -22, close: -32 },
]

// ── State ─────────────────────────────────────────────────────────────────
let state: ProcessingSettings = buildDefault()

function buildDefault(): ProcessingSettings {
  return {
    normalize:       { enabled: false, mode: 'peak', target: -1.0, gainDb: 0 },
    compressor:      { enabled: false, preset: 'church', ...COMP_PRESETS.church } as ProcessingSettings['compressor'],
    eq:              { enabled: false },
    limiter:         { enabled: false, ceiling: -0.3 },
    noiseReduction:  { enabled: false, level: 1 },
    reverbReduction: { enabled: false, level: 1 },
  }
}

// ── Web Audio nodes ───────────────────────────────────────────────────────
let eqNodes:      BiquadFilterNode[]           = []
let compNode:     DynamicsCompressorNode | null = null
let makeupGain:   GainNode | null              = null
let limiterNode:  DynamicsCompressorNode | null = null
let normGainNode: GainNode | null              = null
let analyserOut:  AnalyserNode | null          = null

// ── Build playback chain ───────────────────────────────────────────────────
export function buildAudioChain(
  ctx: AudioContext,
  source: AudioNode,
  dest: AudioNode
): void {
  // EQ — parametric nodes from canvas module
  eqNodes = buildEQNodes(ctx)
  let lastNode: AudioNode = source

  if (eqNodes.length > 0) {
    // When EQ master is disabled, zero all band gains at node level
    if (!state.eq.enabled) {
      eqNodes.forEach(n => { n.gain.value = 0 })
    }
    source.connect(eqNodes[0])
    for (let i = 0; i < eqNodes.length - 1; i++) eqNodes[i].connect(eqNodes[i + 1])
    lastNode = eqNodes[eqNodes.length - 1]
  }

  // Compressor
  compNode = ctx.createDynamicsCompressor()
  applyCompressorValues()
  lastNode.connect(compNode)

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

  // Analyser — always present, drives EQ spectrum visualizer
  analyserOut = ctx.createAnalyser()
  analyserOut.fftSize               = 2048
  analyserOut.smoothingTimeConstant = 0.8
  normGainNode.connect(analyserOut)
  analyserOut.connect(dest)

  // Feed spectrum to EQ canvas (only when EQ panel active)
  setEQAnalyserNode(analyserOut)
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

// ── FFmpeg filter strings ──────────────────────────────────────────────────
export function getFFmpegFilters(): string[] {
  const f: string[] = []

  // Noise reduction — ffmpeg afftdn (FFT denoiser)
  if (state.noiseReduction.enabled && state.noiseReduction.level > 0) {
    const nf = NOISE_LEVELS[state.noiseReduction.level]
    f.push(`afftdn=nf=${nf}:nt=w`)
  }

  // Reverb / room reduction — agate (downward expander)
  if (state.reverbReduction.enabled && state.reverbReduction.level > 0) {
    const g = REVERB_GATE[state.reverbReduction.level]
    const openLin  = Math.pow(10, g.open  / 20)
    const closeLin = Math.pow(10, g.close / 20)
    f.push(`agate=threshold=${openLin.toFixed(6)}:range=0.25:attack=10:release=200:makeup=1`)
    void closeLin // suppress unused warning
  }

  // EQ — parametric from canvas module
  if (state.eq.enabled && hasEQActivity()) {
    f.push(...getEQFFmpegFilters())
  }

  // Compressor
  if (state.compressor.enabled) {
    const { threshold, ratio, attack, release, knee, makeup } = state.compressor
    const threshLin = Math.pow(10, threshold / 20)
    const makeupLin = Math.pow(10, makeup / 20)
    f.push(`acompressor=threshold=${threshLin.toFixed(6)}:ratio=${ratio}:attack=${attack}:release=${release}:knee=${knee}:makeup=${makeupLin.toFixed(4)}`)
  }

  // Limiter
  if (state.limiter.enabled) {
    const lim = Math.pow(10, state.limiter.ceiling / 20)
    f.push(`alimiter=level_in=1:level_out=1:limit=${lim.toFixed(6)}:attack=5:release=50:asc=true`)
  }

  // Normalization volume
  if (state.normalize.enabled && Math.abs(state.normalize.gainDb) > 0.05) {
    f.push(`volume=${state.normalize.gainDb.toFixed(2)}dB`)
  }

  return f
}

export function getProcessingState(): ProcessingSettings {
  return JSON.parse(JSON.stringify(state)) as ProcessingSettings
}

export function hasAnyProcessing(): boolean {
  return (
    state.normalize.enabled ||
    state.compressor.enabled ||
    (state.eq.enabled && hasEQActivity()) ||
    state.limiter.enabled ||
    state.noiseReduction.enabled ||
    state.reverbReduction.enabled
  )
}

// ── Runtime setters ────────────────────────────────────────────────────────
export function setEQEnabled(enabled: boolean): void {
  state.eq.enabled = enabled
  if (eqNodes.length > 0) {
    if (!enabled) {
      eqNodes.forEach(n => { n.gain.value = 0 })
    } else {
      getBands().forEach((b, i) => {
        if (!eqNodes[i]) return
        eqNodes[i].type            = b.type
        eqNodes[i].frequency.value = b.freq
        eqNodes[i].Q.value         = b.q
        eqNodes[i].gain.value      = b.enabled ? b.gain : 0
      })
    }
  }
  setEQAnalyserNode(enabled ? analyserOut : null)
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

export function setNoiseReductionEnabled(enabled: boolean): void {
  state.noiseReduction.enabled = enabled
}

export function setNoiseReductionLevel(level: 0 | 1 | 2 | 3): void {
  state.noiseReduction.level = level
}

export function setReverbReductionEnabled(enabled: boolean): void {
  state.reverbReduction.enabled = enabled
}

export function setReverbReductionLevel(level: 0 | 1 | 2 | 3): void {
  state.reverbReduction.level = level
}

// ── UI setup ───────────────────────────────────────────────────────────────
const $ = (id: string): HTMLElement | null => document.getElementById(id)

export function setupProcessingPanel(onUpdate: () => void): void {
  // ── Tab switching ──────────────────────────────────────────────────────
  document.querySelectorAll<HTMLElement>('.proc-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.proc-tab').forEach(t => t.classList.remove('active'))
      document.querySelectorAll<HTMLElement>('.proc-body').forEach(b => { b.style.display = 'none' })
      tab.classList.add('active')
      const body = $('proc-body-' + tab.dataset.tab)
      if (body) body.style.display = ''
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
    document.dispatchEvent(new CustomEvent('proc-analyze-request'))
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

  // ── EQ canvas ──────────────────────────────────────────────────────────
  const eqCanvas = $('proc-eq-canvas') as HTMLCanvasElement | null
  if (eqCanvas) {
    initEQCanvas(eqCanvas, onUpdate)
  }

  wireToggle('proc-eq-enable', v => {
    setEQEnabled(v)
    onUpdate()
  })

  // Preset buttons
  document.querySelectorAll<HTMLElement>('.eq-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset
      if (preset) {
        applyEQPreset(preset)
        // Activate EQ master toggle if preset is not flat
        if (preset !== 'flat') {
          const toggle = $('proc-eq-enable') as HTMLInputElement | null
          if (toggle && !toggle.checked) { toggle.checked = true; setEQEnabled(true) }
        }
        onUpdate()
        document.querySelectorAll('.eq-preset-btn').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
      }
    })
  })

  $('btn-proc-eq-reset')?.addEventListener('click', () => {
    applyEQPreset('flat')
    document.querySelectorAll('.eq-preset-btn').forEach(b => {
      b.classList.toggle('active', (b as HTMLElement).dataset.preset === 'flat')
    })
    onUpdate()
  })

  // ── Noise & Reverb reduction ───────────────────────────────────────────
  wireToggle('proc-noise-enable', v => { setNoiseReductionEnabled(v); onUpdate() })
  wireToggle('proc-reverb-enable', v => { setReverbReductionEnabled(v); onUpdate() })

  document.querySelectorAll<HTMLElement>('.noise-level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lvl = parseInt(btn.dataset.level ?? '1', 10) as 0 | 1 | 2 | 3
      setNoiseReductionLevel(lvl)
      document.querySelectorAll('.noise-level-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      onUpdate()
    })
  })

  document.querySelectorAll<HTMLElement>('.reverb-level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lvl = parseInt(btn.dataset.level ?? '1', 10) as 0 | 1 | 2 | 3
      setReverbReductionLevel(lvl)
      document.querySelectorAll('.reverb-level-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      onUpdate()
    })
  })

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
