/**
 * VU meter — shared logic for both the home page and the recording overlay.
 */

export interface VuState {
  animFrame:   number | null
  stream:      MediaStream | null
  ctx:         AudioContext | null
  analyserL:   AnalyserNode | null
  analyserR:   AnalyserNode | null
  pkL: number; pkR: number
  pkTL: number; pkTR: number
  smL: number; smR: number
  peakL: number; peakR: number
  /** Pre-allocated read buffers — sized to fftSize once when analyser is set,
   *  reused every frame so the 60 Hz tick produces zero GC pressure. */
  bufL: Float32Array | null
  bufR: Float32Array | null
}

const SMOOTH    = 0.55
const PEAK_HOLD = 1500   // ms
const PEAK_FALL = 25     // dB/sec

export function makeVuState(): VuState {
  return { animFrame: null, stream: null, ctx: null, analyserL: null, analyserR: null,
    pkL: -60, pkR: -60, pkTL: 0, pkTR: 0, smL: -60, smR: -60, peakL: -60, peakR: -60,
    bufL: null, bufR: null }
}

/**
 * Computes dBFS from an analyser using a caller-provided buffer. The buffer
 * MUST be at least `analyser.fftSize` long. Reusing the same buffer per
 * frame avoids ~4 KB allocation at 60 fps × 2 channels = ~480 KB/sec of GC
 * pressure that previously surfaced as occasional jank.
 */
export function getDbFS(analyser: AnalyserNode, buf?: Float32Array): number {
  const sampleBuf = buf && buf.length >= analyser.fftSize ? buf : new Float32Array(analyser.fftSize)
  analyser.getFloatTimeDomainData(sampleBuf)
  const len = analyser.fftSize
  let sum = 0
  for (let i = 0; i < len; i++) sum += sampleBuf[i] * sampleBuf[i]
  const rms = Math.sqrt(sum / len)
  return rms > 0 ? Math.max(-60, 20 * Math.log10(rms)) : -60
}

function dbToHeight(db: number): number {
  return ((Math.max(-60, Math.min(0, db)) + 60) / 60) * 100
}

function computePeak(db: number, peak: number, pt: number, now: number): { p: number; t: number } {
  if (db >= peak) return { p: db, t: now }
  const age = now - pt
  if (age > PEAK_HOLD) return { p: Math.max(-60, peak - (age - PEAK_HOLD) / 1000 * PEAK_FALL), t: pt }
  return { p: peak, t: pt }
}

export function setVUBar(
  fillEl: HTMLElement | null,
  peakEl: HTMLElement | null,
  dbEl:   HTMLElement | null,
  db: number, peakDb: number
): void {
  // Horizontal-mode encoding: .vu-bar-fill is a *mask* that covers the right
  // side of the gradient track. Width X% = "X% of the gradient is hidden",
  // leaving (100 - X)% of audio visible from the left.
  //
  // Vertical-mode encoding (used when parent has .vu-section-vertical): the
  // mask covers the top X% of the gradient instead. Same X% — the CSS for
  // each mode picks the property it cares about and ignores the other.
  const audioPct = dbToHeight(db)           // 0..100, 100 = loudest
  const maskPct  = 100 - audioPct           // 0..100, 0 = fully unmasked
  const peakPct  = dbToHeight(peakDb)       // 0..100
  if (fillEl) {
    fillEl.style.width = maskPct + '%'
    fillEl.style.setProperty('--vu-mask', maskPct + '%')
  }
  if (peakEl) {
    peakEl.style.left    = peakPct + '%'
    peakEl.style.setProperty('--vu-peak-pos', peakPct + '%')
    peakEl.style.opacity = peakDb > -59 ? '1' : '0'
  }
  if (dbEl) dbEl.textContent = db > -59 ? db.toFixed(1) : '—'
}

export function tickVU(
  state: VuState,
  fillL: HTMLElement | null, peakL: HTMLElement | null, dbL: HTMLElement | null,
  fillR: HTMLElement | null, peakR: HTMLElement | null, dbR: HTMLElement | null,
  onSignal?: (dbL: number, dbR: number, state: VuState) => void
): void {
  if (!state.analyserL || !state.analyserR) return
  // Lazily size the reusable sample buffers to match the analyser fftSize.
  // analyser.fftSize is constant for the lifetime of the analyser, so this
  // allocates exactly once per (re)attach.
  if (!state.bufL || state.bufL.length !== state.analyserL.fftSize) {
    state.bufL = new Float32Array(state.analyserL.fftSize)
  }
  if (!state.bufR || state.bufR.length !== state.analyserR.fftSize) {
    state.bufR = new Float32Array(state.analyserR.fftSize)
  }
  const now  = Date.now()
  const rawL = getDbFS(state.analyserL, state.bufL), rawR = getDbFS(state.analyserR, state.bufR)
  state.smL = rawL > state.smL ? rawL : state.smL * SMOOTH + rawL * (1 - SMOOTH)
  state.smR = rawR > state.smR ? rawR : state.smR * SMOOTH + rawR * (1 - SMOOTH)
  const pL = computePeak(state.smL, state.pkL, state.pkTL, now)
  const pR = computePeak(state.smR, state.pkR, state.pkTR, now)
  state.pkL = pL.p; state.pkTL = pL.t; state.pkR = pR.p; state.pkTR = pR.t
  if (state.smL > state.peakL) state.peakL = state.smL
  if (state.smR > state.peakR) state.peakR = state.smR
  setVUBar(fillL, peakL, dbL, state.smL, state.pkL)
  setVUBar(fillR, peakR, dbR, state.smR, state.pkR)
  onSignal?.(state.smL, state.smR, state)
  state.animFrame = requestAnimationFrame(() =>
    tickVU(state, fillL, peakL, dbL, fillR, peakR, dbR, onSignal))
}

export function stopVuState(state: VuState): void {
  if (state.animFrame)  { cancelAnimationFrame(state.animFrame); state.animFrame = null }
  if (state.stream)     { state.stream.getTracks().forEach(t => t.stop()); state.stream = null }
  if (state.ctx)        { state.ctx.close(); state.ctx = null }
  state.analyserL = null; state.analyserR = null
  state.bufL = null; state.bufR = null
  state.pkL = -60; state.pkR = -60; state.pkTL = 0; state.pkTR = 0
  state.smL = -60; state.smR = -60; state.peakL = -60; state.peakR = -60
}
