// Advanced vocal-chain mixer — exposes every stage of the Rust `EditorProcessing`
// DTO as a control. The mixer is the power-user counterpart to the one-click
// presets: toggle/tune each stage, and on export the whole object is sent as the
// `processing` override (which wins over `vocalChainPreset` server-side).
//
// The control config + the JS preset objects mirror `processing.rs` exactly so
// "load preset into mixer" reproduces the Rust defaults.

import { E } from './state'

// The processing object mirrors `EditorProcessing` (camelCase bindings).
export interface Processing {
  highpassEnabled: boolean
  highpassHz: number
  denoiseEnabled: boolean
  denoiseDb: number
  denoiseFloorDb: number
  dereverbEnabled: boolean
  dereverbStrength: number
  gateEnabled: boolean
  gateThresholdDb: number
  gateRatio: number
  eq: Array<{ freqHz: number; gainDb: number; q: number }>
  compEnabled: boolean
  compThresholdDb: number
  compRatio: number
  compAttackMs: number
  compReleaseMs: number
  compMakeupDb: number
  deesserEnabled: boolean
  deesserIntensity: number
  limiterEnabled: boolean
  limiterDb: number
  gainDb: number
}

// Mirror of `VocalChain::default()` — light polish (HPF + compressor on).
export function defaultProcessing(): Processing {
  return {
    highpassEnabled: true,
    highpassHz: 80,
    denoiseEnabled: false,
    denoiseDb: 12,
    denoiseFloorDb: -25,
    dereverbEnabled: false,
    dereverbStrength: 0.4,
    gateEnabled: false,
    gateThresholdDb: -40,
    gateRatio: 2,
    eq: [],
    compEnabled: true,
    compThresholdDb: -18,
    compRatio: 3,
    compAttackMs: 5,
    compReleaseMs: 80,
    compMakeupDb: 2,
    deesserEnabled: false,
    deesserIntensity: 0.4,
    limiterEnabled: false,
    limiterDb: -1,
    gainDb: 0,
  }
}

// The three UI EQ bands the mixer offers (mud / presence / air). The sent `eq`
// array includes only bands with a non-zero gain.
const EQ_BANDS = [
  { freqHz: 250, q: 1.0, label: '250 Hz (demp mudder)' },
  { freqHz: 3500, q: 1.0, label: '3.5 kHz (nærvær)' },
  { freqHz: 10000, q: 1.5, label: '10 kHz (luft)' },
]

// JS mirrors of the Rust `vocal_chain_presets()` so a preset populates the mixer.
export const VOCAL_PRESETS: Record<string, Processing> = {
  'voice-light': defaultProcessing(),
  'voice-podcast': {
    ...defaultProcessing(),
    highpassHz: 85,
    denoiseEnabled: true,
    denoiseDb: 10,
    eq: [
      { freqHz: 250, gainDb: -2, q: 1 },
      { freqHz: 3500, gainDb: 2.5, q: 1 },
      { freqHz: 10000, gainDb: 1.5, q: 1.5 },
    ],
    compThresholdDb: -20,
    compMakeupDb: 3,
    deesserEnabled: true,
    deesserIntensity: 0.4,
    limiterEnabled: true,
    limiterDb: -1,
  },
  'voice-noisy-room': {
    ...defaultProcessing(),
    highpassHz: 100,
    denoiseEnabled: true,
    denoiseDb: 20,
    denoiseFloorDb: -20,
    dereverbEnabled: true,
    dereverbStrength: 0.5,
    gateEnabled: true,
    gateThresholdDb: -38,
    gateRatio: 2.5,
    eq: [
      { freqHz: 250, gainDb: 0, q: 1 },
      { freqHz: 300, gainDb: -3, q: 1 },
      { freqHz: 3000, gainDb: 3, q: 1 },
    ],
    compThresholdDb: -22,
    compRatio: 4,
    compAttackMs: 4,
    compReleaseMs: 70,
    compMakeupDb: 3,
    deesserEnabled: true,
    deesserIntensity: 0.5,
    limiterEnabled: true,
    limiterDb: -1,
  },
}

// A slider control bound to a numeric key of Processing.
interface SliderSpec {
  key: keyof Processing
  label: string
  min: number
  max: number
  step: number
  unit?: string
}

// Each stage = an enable toggle + a set of sliders.
interface StageSpec {
  title: string
  enableKey: keyof Processing
  sliders: SliderSpec[]
}

const STAGES: StageSpec[] = [
  {
    title: 'Lavkutt (HPF)',
    enableKey: 'highpassEnabled',
    sliders: [{ key: 'highpassHz', label: 'Frekvens', min: 40, max: 200, step: 5, unit: 'Hz' }],
  },
  {
    title: 'Støyreduksjon',
    enableKey: 'denoiseEnabled',
    sliders: [
      { key: 'denoiseDb', label: 'Reduksjon', min: 0, max: 40, step: 1, unit: 'dB' },
      { key: 'denoiseFloorDb', label: 'Støygulv', min: -60, max: -10, step: 1, unit: 'dB' },
    ],
  },
  {
    title: 'Romdemping (tilnærmet)',
    enableKey: 'dereverbEnabled',
    sliders: [{ key: 'dereverbStrength', label: 'Styrke', min: 0, max: 1, step: 0.05 }],
  },
  {
    title: 'Gate',
    enableKey: 'gateEnabled',
    sliders: [
      { key: 'gateThresholdDb', label: 'Terskel', min: -70, max: -10, step: 1, unit: 'dB' },
      { key: 'gateRatio', label: 'Ratio', min: 1, max: 10, step: 0.5 },
    ],
  },
  {
    title: 'Kompressor',
    enableKey: 'compEnabled',
    sliders: [
      { key: 'compThresholdDb', label: 'Terskel', min: -40, max: 0, step: 1, unit: 'dB' },
      { key: 'compRatio', label: 'Ratio', min: 1, max: 12, step: 0.5 },
      { key: 'compAttackMs', label: 'Attack', min: 1, max: 100, step: 1, unit: 'ms' },
      { key: 'compReleaseMs', label: 'Release', min: 10, max: 500, step: 10, unit: 'ms' },
      { key: 'compMakeupDb', label: 'Makeup', min: 0, max: 12, step: 0.5, unit: 'dB' },
    ],
  },
  {
    title: 'De-esser',
    enableKey: 'deesserEnabled',
    sliders: [{ key: 'deesserIntensity', label: 'Intensitet', min: 0, max: 1, step: 0.05 }],
  },
  {
    title: 'Limiter',
    enableKey: 'limiterEnabled',
    sliders: [{ key: 'limiterDb', label: 'Tak', min: -6, max: 0, step: 0.5, unit: 'dB' }],
  },
]

/** Build the export-ready `processing` object from the mixer state, dropping
 *  zero-gain EQ bands (a 0 dB equalizer is a wasted filter). */
export function mixerProcessing(): Processing {
  const p = { ...E.mixer }
  p.eq = p.eq.filter((b) => Math.abs(b.gainDb) > 0.01)
  return p
}

/** Render the mixer controls into `container`, two-way bound to E.mixer. */
export function renderMixer(container: HTMLElement): void {
  const p = E.mixer
  container.innerHTML = ''

  for (const stage of STAGES) {
    const card = document.createElement('div')
    card.className = 'mixer-stage'

    const head = document.createElement('label')
    head.className = 'mixer-stage-head'
    const toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.checked = p[stage.enableKey] as boolean
    toggle.addEventListener('change', () => {
      ;(p as Record<string, unknown>)[stage.enableKey] = toggle.checked
    })
    const title = document.createElement('span')
    title.textContent = stage.title
    head.append(toggle, title)
    card.appendChild(head)

    for (const s of stage.sliders) {
      const row = document.createElement('div')
      row.className = 'mixer-slider-row'
      const lbl = document.createElement('span')
      lbl.className = 'mixer-slider-label'
      const valSpan = document.createElement('span')
      valSpan.className = 'mixer-slider-val'
      const fmt = (v: number) => `${v}${s.unit ? ' ' + s.unit : ''}`
      lbl.textContent = s.label
      valSpan.textContent = fmt(p[s.key] as number)
      const range = document.createElement('input')
      range.type = 'range'
      range.min = String(s.min)
      range.max = String(s.max)
      range.step = String(s.step)
      range.value = String(p[s.key] as number)
      range.addEventListener('input', () => {
        const v = parseFloat(range.value)
        ;(p as Record<string, unknown>)[s.key] = v
        valSpan.textContent = fmt(v)
      })
      row.append(lbl, range, valSpan)
      card.appendChild(row)
    }
    container.appendChild(card)
  }

  // EQ bands (gain sliders, −12..+12 dB).
  const eqCard = document.createElement('div')
  eqCard.className = 'mixer-stage'
  const eqHead = document.createElement('div')
  eqHead.className = 'mixer-stage-head'
  eqHead.textContent = 'EQ'
  eqCard.appendChild(eqHead)
  for (const band of EQ_BANDS) {
    const existing = p.eq.find((b) => b.freqHz === band.freqHz)
    const gain = existing?.gainDb ?? 0
    const row = document.createElement('div')
    row.className = 'mixer-slider-row'
    const lbl = document.createElement('span')
    lbl.className = 'mixer-slider-label'
    lbl.textContent = band.label
    const valSpan = document.createElement('span')
    valSpan.className = 'mixer-slider-val'
    valSpan.textContent = `${gain} dB`
    const range = document.createElement('input')
    range.type = 'range'
    range.min = '-12'
    range.max = '12'
    range.step = '0.5'
    range.value = String(gain)
    range.addEventListener('input', () => {
      const v = parseFloat(range.value)
      valSpan.textContent = `${v} dB`
      const idx = p.eq.findIndex((b) => b.freqHz === band.freqHz)
      if (idx >= 0) p.eq[idx].gainDb = v
      else p.eq.push({ freqHz: band.freqHz, gainDb: v, q: band.q })
    })
    row.append(lbl, range, valSpan)
    eqCard.appendChild(row)
  }
  container.appendChild(eqCard)

  // Makeup gain (final).
  const gainCard = document.createElement('div')
  gainCard.className = 'mixer-stage'
  const gRow = document.createElement('div')
  gRow.className = 'mixer-slider-row'
  const gLbl = document.createElement('span')
  gLbl.className = 'mixer-slider-label'
  gLbl.textContent = 'Sluttgain'
  const gVal = document.createElement('span')
  gVal.className = 'mixer-slider-val'
  gVal.textContent = `${p.gainDb} dB`
  const gRange = document.createElement('input')
  gRange.type = 'range'
  gRange.min = '-12'
  gRange.max = '12'
  gRange.step = '0.5'
  gRange.value = String(p.gainDb)
  gRange.addEventListener('input', () => {
    const v = parseFloat(gRange.value)
    p.gainDb = v
    gVal.textContent = `${v} dB`
  })
  gRow.append(gLbl, gRange, gVal)
  gainCard.appendChild(gRow)
  container.appendChild(gainCard)
}

/** Load a preset's settings into the mixer state + re-render. */
export function loadPresetIntoMixer(presetId: string, container: HTMLElement): void {
  const preset = VOCAL_PRESETS[presetId]
  if (!preset) return
  E.mixer = { ...preset, eq: preset.eq.map((b) => ({ ...b })) }
  renderMixer(container)
}
