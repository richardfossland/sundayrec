import { t } from '../../i18n'
import { E, $ } from './state'

// Peak (waveform) computation + normalization helpers for the editor.

export function computeJinglePeaks(buf: AudioBuffer): Float32Array {
  const RATE = 100
  const total = Math.ceil(buf.duration * RATE)
  const out   = new Float32Array(total)
  const ch0   = buf.getChannelData(0)
  const ch1   = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0
  const spp   = Math.max(1, Math.floor(buf.sampleRate / RATE))
  for (let i = 0; i < total; i++) {
    const s = i * spp
    const e = Math.min(s + spp, ch0.length)
    let pk = 0
    for (let j = s; j < e; j++) {
      const v = Math.max(Math.abs(ch0[j]), Math.abs(ch1[j]))
      if (v > pk) pk = v
    }
    out[i] = pk
  }
  return out
}

export function computePeaks(buf: AudioBuffer): Float32Array {
  // Synchronous peak computation — used for short files where the cost is
  // negligible. Long files come in pre-downsampled via the ffmpeg-extract
  // path (8 kHz mono), so even a 4 h preacher recording is only ~115 M
  // samples here. For typical sermon lengths (1-3 h) this completes in well
  // under a second on a modern CPU. If you hit a file that lags the UI,
  // route it through `computePeaksAsync` instead.
  const RATE = 100
  const total = Math.ceil(buf.duration * RATE)
  const out   = new Float32Array(total)
  const ch0   = buf.getChannelData(0)
  const ch1   = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0
  const spp   = Math.floor(buf.sampleRate / RATE)
  E.clipTimes   = []

  for (let i = 0; i < total; i++) {
    const s = i * spp
    const e = Math.min(s + spp, ch0.length)
    let pk = 0
    for (let j = s; j < e; j++) {
      const v = Math.max(Math.abs(ch0[j]), Math.abs(ch1[j]))
      if (v > pk) pk = v
    }
    out[i] = pk
    if (pk >= 0.99) E.clipTimes.push(i / RATE)
  }
  return out
}

/**
 * Async peak computation. Yields back to the event loop every CHUNK frames
 * so the UI thread stays responsive while crunching a multi-gigabyte
 * AudioBuffer. Currently unused (the sync path is fast enough for the
 * downsampled inputs we feed it), but kept here so the routing can switch
 * over without a code rewrite if profiling shows otherwise.
 */
// Underscore prefix marks this as intentionally unused (TS no-unused convention).
export async function _computePeaksAsync(buf: AudioBuffer): Promise<Float32Array> {
  const RATE = 100
  const total = Math.ceil(buf.duration * RATE)
  const out   = new Float32Array(total)
  const ch0   = buf.getChannelData(0)
  const ch1   = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0
  const spp   = Math.floor(buf.sampleRate / RATE)
  E.clipTimes   = []

  const CHUNK = 2000  // yield every ~20 s of output (at 100 samples/s)
  for (let i = 0; i < total; i++) {
    const s = i * spp
    const e = Math.min(s + spp, ch0.length)
    let pk = 0
    for (let j = s; j < e; j++) {
      const v = Math.max(Math.abs(ch0[j]), Math.abs(ch1[j]))
      if (v > pk) pk = v
    }
    out[i] = pk
    if (pk >= 0.99) E.clipTimes.push(i / RATE)
    if ((i & (CHUNK - 1)) === 0 && i > 0) {
      // Yield: drains the microtask queue and lets paint events run.
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  return out
}

// ── Peak normalization helpers ────────────────────────────────────────────
//
// We work off the in-memory `peaks` array (downsampled at 100 Hz) rather
// than calling ffmpeg's `volumedetect`. The peaks data is downsampled from
// the actual audio samples, so its maximum is a tight upper bound on the
// true peak — accurate enough for a normalize button. The actual export
// uses ffmpeg's `volume={N}dB` filter applied to the original (un-downsampled)
// samples, so the rendered file is sample-accurate regardless.

/**
 * Compute the gain (in dB) needed to bring the maximum absolute peak in
 * `pks` to -1 dBFS (1 dB of safety headroom — prevents clipping after
 * encoding/codec processing). Returns 0 if the input is silent or already
 * at/above the target.
 *
 * Peaks here are floats in 0..1 (normalized magnitudes), produced by
 * `computePeaks()`. We never see uint8 input here, but the helper also
 * handles a normalized > 1 fallback just in case.
 */
export function computePeakGain(pks: Float32Array): number {
  let max = 0
  for (let i = 0; i < pks.length; i++) {
    const v = Math.abs(pks[i])
    if (v > max) max = v
  }
  if (max <= 0) return 0
  // Defensive: if a future caller hands us uint8-style 0..255 data, rescale.
  const normalizedMax = max > 1.001 ? max / 128 : max
  const currentDb = 20 * Math.log10(normalizedMax)
  // Target -1 dBFS. If we're already at or above target, no gain.
  if (currentDb >= -1) return 0
  return -1 - currentDb
}

/** Linear gain factor for the current `audioGainDb` (1.0 = no change). */
export function gainFactor(): number {
  return E.audioGainDb === 0 ? 1 : Math.pow(10, E.audioGainDb / 20)
}

/**
 * Build the audio-filter list passed to the main-process export pipeline.
 * Currently a single `volume={N}dB` filter when normalization has been
 * applied — composed with intro/outro concat and other filters in
 * `src/main/editor.ts` exactly as the previous proc-panel filter list was.
 */
export function getExportFilters(): string[] {
  if (E.audioGainDb === 0) return []
  return [`volume=${E.audioGainDb.toFixed(2)}dB`]
}

/**
 * Update the normalize button + status line to reflect the current gain.
 * `gainDb === 0` and `alreadyAtTarget === true` means we ran the check but
 * the file's peak is already at/above -1 dBFS — show a friendly notice
 * instead of pretending nothing happened.
 */
export function setNormalizeUI(gainDb: number, alreadyAtTarget: boolean): void {
  const btn    = $('btn-normalize-peak') as HTMLButtonElement | null
  const label  = $('btn-normalize-label')
  const status = $('editor-normalize-status')
  const reset  = $('btn-normalize-reset')
  if (!btn || !label || !status) return

  if (gainDb !== 0) {
    btn.classList.add('is-applied')
    status.classList.add('is-applied')
    const sign = gainDb >= 0 ? '+' : ''
    label.textContent = `✓ ${t('editor.normalizeApplied', 'Normalisert')} (${sign}${gainDb.toFixed(1)} dB)`
    status.textContent = t('editor.normalizeResult', 'Toppunkt nå -1 dBFS — trygg for eksport.')
    if (reset) reset.style.display = ''
  } else {
    btn.classList.remove('is-applied')
    status.classList.remove('is-applied')
    label.textContent = t('editor.normalizePeak', 'Normaliser lydnivå')
    if (alreadyAtTarget) {
      status.textContent = t('editor.normalizeAlready', 'Toppunktet er allerede ved -1 dBFS — ingen endring nødvendig.')
    } else {
      status.textContent = t('editor.normalizeHint', 'Justerer toppunktet til -1 dBFS for trygg sluttmiks.')
    }
    if (reset) reset.style.display = 'none'
  }
}
