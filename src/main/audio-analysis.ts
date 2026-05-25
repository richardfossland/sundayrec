/**
 * Audio analysis — voice activity detection (VAD) and content classification
 * for SundayRec.
 *
 * Replaces the old silencedetect-based chapter detector. Instead of finding
 * pauses, this module classifies every 100 ms frame of an audio file as
 * speech / music / silence / mixed / unknown using a feature-based
 * heuristic classifier. Frames are smoothed (1-second median filter) and
 * grouped into segments; segments shorter than 5 s are merged into their
 * neighbours so the renderer gets meaningful chapter markers.
 *
 * Why a heuristic classifier? The native build only has ffmpeg, no ONNX
 * runtime or large models. A small JS-only feature extractor gets us
 * surprisingly far for church-service content (sermon vs hymn vs prayer
 * vs applause) which is mostly about distinguishing sustained instrumental
 * tone from modulated voice plus silence.
 *
 * Streaming design: a 3-hour service is ~700 MB of mono-16 kHz PCM. We
 * spawn ffmpeg with `-f f32le pipe:1`, consume stdout in chunks, refill a
 * frame buffer, and emit features incrementally so memory stays bounded.
 */

import { spawn } from 'child_process'
import { ffmpegBin } from './native-recorder'

// ── Public types ─────────────────────────────────────────────────────────────

export type SegmentType = 'silence' | 'speech' | 'music' | 'mixed' | 'unknown'

export interface AnalysisFrame {
  startSec:         number
  rmsDb:            number
  zcrPerSec:        number
  spectralCentroid: number
  spectralFlux:     number
}

export interface AnalysisSegment {
  startSec:    number
  endSec:      number
  durationSec: number
  type:        SegmentType
  confidence:  number
  avgRmsDb:    number
  label:       string
}

// ── Constants — tuned for 16 kHz mono PCM ────────────────────────────────────

/** Sample rate the analyzer asks ffmpeg to produce. */
export const SAMPLE_RATE = 16000

/** Frame length in milliseconds. 100 ms gives 10 frames/sec, a good
 *  compromise between time resolution (catch short pauses) and the FFT
 *  frequency resolution we need to compute spectral centroid. */
export const FRAME_MS = 100

/** Samples per frame at 16 kHz × 100 ms. */
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000

/** FFT size — next power of two ≥ frame size. We zero-pad. 2048 at 16 kHz
 *  gives ~7.8 Hz bin width which is more than enough for centroid. */
export const FFT_SIZE = 2048

/** Silence threshold (dB). Below this we call the frame "silence". -45 dB
 *  catches typical church-room noise floor without classifying whispered
 *  speech as silence. */
export const SILENCE_DB = -45

/** Half-width (in frames) of the median-filter smoother. 5 frames either
 *  side ≈ ±0.5 s = a 1.1 s window total. Removes single-frame outliers
 *  without blurring real transitions. */
export const SMOOTH_HALF_WIN = 5

/** Minimum segment duration in seconds. Anything shorter is merged into
 *  its neighbour. 5 s matches the granularity the editor UI expects
 *  (chapters are sermon/hymn-sized chunks, not phrase-sized). */
export const MIN_SEGMENT_SEC = 5

/** Norwegian labels for each segment type. Hardcoded for now — i18n is
 *  picked up via the type field, the label is just a default. */
export const LABELS: Record<SegmentType, string> = {
  speech:  'Tale',
  music:   'Musikk',
  silence: 'Stillhet',
  mixed:   'Blandet',
  unknown: '—',
}

// ── Pure helpers: FFT ────────────────────────────────────────────────────────

/**
 * Iterative in-place Cooley-Tukey radix-2 FFT. Operates on parallel real
 * and imaginary float64 arrays of length N (must be a power of two).
 *
 * This is a tight loop with bit-reversal permutation followed by
 * butterflies. Pure JS, no deps. About 100 µs per 2048-point transform
 * on a modern laptop which is plenty fast — for a 3-hour file we run
 * ~108 000 transforms in total (≈ 11 s overhead, lost in ffmpeg decode).
 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  if (n !== im.length) throw new Error('fft: re/im length mismatch')
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error('fft: size must be power of 2')

  // ── bit-reversal permutation ──
  let j = 0
  for (let i = 1; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const ti = im[i]; im[i] = im[j]; im[j] = ti
    }
  }

  // ── butterflies ──
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1
    const tableStep = -2 * Math.PI / size
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const angle = tableStep * k
        const wr = Math.cos(angle)
        const wi = Math.sin(angle)
        const aRe = re[i + k]
        const aIm = im[i + k]
        const bRe = re[i + k + half]
        const bIm = im[i + k + half]
        const tRe = wr * bRe - wi * bIm
        const tIm = wr * bIm + wi * bRe
        re[i + k]        = aRe + tRe
        im[i + k]        = aIm + tIm
        re[i + k + half] = aRe - tRe
        im[i + k + half] = aIm - tIm
      }
    }
  }
}

/**
 * Hann window, precomputed once per FFT size. Reduces spectral leakage
 * for non-periodic signals (everything that isn't a perfect sinusoid at
 * a bin frequency). Stored as a module-level cache so we don't rebuild
 * it every frame.
 */
const HANN_CACHE = new Map<number, Float64Array>()
export function hannWindow(size: number): Float64Array {
  const cached = HANN_CACHE.get(size)
  if (cached) return cached
  const w = new Float64Array(size)
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)))
  }
  HANN_CACHE.set(size, w)
  return w
}

// ── Pure helpers: per-frame features ─────────────────────────────────────────

/** RMS energy in dBFS. Returns -Infinity for true silence. */
export function rmsDb(samples: Float32Array): number {
  if (samples.length === 0) return -Infinity
  let sumSq = 0
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i]
  const rms = Math.sqrt(sumSq / samples.length)
  if (rms <= 1e-12) return -Infinity
  return 20 * Math.log10(rms)
}

/** Zero-crossing rate per second. Counts sign flips in the time-domain
 *  signal. Speech sits roughly 1500-5000 ZCR/s (15-50 per 10 ms frame).
 *  Pure tones have ZCR equal to 2× frequency. */
export function zcrPerSecond(samples: Float32Array, sampleRate: number): number {
  if (samples.length < 2) return 0
  let crossings = 0
  let prev = samples[0]
  for (let i = 1; i < samples.length; i++) {
    const cur = samples[i]
    if ((prev >= 0 && cur < 0) || (prev < 0 && cur >= 0)) crossings++
    prev = cur
  }
  const durationSec = samples.length / sampleRate
  return crossings / durationSec
}

/**
 * Compute spectral centroid (Hz) and magnitude spectrum (length N/2+1)
 * from a windowed frame. Caller can keep the magnitude array to compute
 * spectral flux against the previous frame.
 *
 * Spectral centroid is the "centre of mass" of the magnitude spectrum,
 * weighted by frequency. Music has variable centroid; speech sits
 * roughly 500-2500 Hz; pure tones cluster at their fundamental.
 */
export function spectrum(samples: Float32Array, sampleRate: number): {
  centroid:  number
  magnitude: Float64Array
} {
  const n = FFT_SIZE
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const win = hannWindow(samples.length)

  // Copy windowed samples; zero-pad remainder
  const cap = Math.min(samples.length, n)
  for (let i = 0; i < cap; i++) re[i] = samples[i] * win[i]

  fft(re, im)

  const half = n >> 1
  const mag = new Float64Array(half + 1)
  let weightedSum = 0
  let totalMag    = 0
  const binHz = sampleRate / n
  for (let k = 0; k <= half; k++) {
    const m = Math.sqrt(re[k] * re[k] + im[k] * im[k])
    mag[k] = m
    weightedSum += k * binHz * m
    totalMag    += m
  }

  const centroid = totalMag > 1e-12 ? weightedSum / totalMag : 0
  return { centroid, magnitude: mag }
}

/** L2 norm of bin-wise magnitude difference. Speech bounces around in
 *  frequency content (phoneme transitions) so flux is high; sustained
 *  tones have low flux. */
export function spectralFlux(curr: Float64Array, prev: Float64Array | null): number {
  if (!prev) return 0
  const n = Math.min(curr.length, prev.length)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const d = curr[i] - prev[i]
    sum += d * d
  }
  return Math.sqrt(sum)
}

/**
 * Extract features for every 100 ms frame of a PCM buffer. Pure
 * function — caller supplies an already-decoded Float32Array of samples.
 * Used by tests and by the streaming pipeline (which slices its rolling
 * buffer into frames and calls this).
 *
 * `frameMs` is a parameter for testability but in production we always
 * pass FRAME_MS = 100. We don't support hop != frame (no overlap) — the
 * classifier doesn't need it and overlap would double FFT cost.
 */
export function extractFeatures(
  pcm:        Float32Array,
  sampleRate: number,
  frameMs:    number,
): AnalysisFrame[] {
  if (pcm.length === 0 || sampleRate <= 0 || frameMs <= 0) return []
  const samplesPerFrame = Math.floor((sampleRate * frameMs) / 1000)
  if (samplesPerFrame === 0) return []

  const frames: AnalysisFrame[] = []
  let prevMag: Float64Array | null = null

  const total = Math.floor(pcm.length / samplesPerFrame)
  for (let f = 0; f < total; f++) {
    const offset = f * samplesPerFrame
    const slice = pcm.subarray(offset, offset + samplesPerFrame)

    const startSec = (offset / sampleRate)
    const r = rmsDb(slice)
    const z = zcrPerSecond(slice, sampleRate)
    const { centroid, magnitude } = spectrum(slice, sampleRate)
    const flux = spectralFlux(magnitude, prevMag)
    prevMag = magnitude

    frames.push({
      startSec,
      rmsDb:            r,
      zcrPerSec:        z,
      spectralCentroid: centroid,
      spectralFlux:     flux,
    })
  }
  return frames
}

// ── Classifier ───────────────────────────────────────────────────────────────

/**
 * Classify a single frame using thresholds tuned on church-service test
 * material. Returns the type plus a confidence in 0..1 indicating how
 * "clean" the classification was (distance from the borderline).
 *
 * The thresholds:
 *   - Silence: RMS < SILENCE_DB. Hard cut.
 *   - Speech:  RMS in [-45, -5] dB
 *              AND ZCR in [600, 6000] /sec  (≈ 6-60 per 10ms)
 *              AND spectral centroid in [300, 3500] Hz
 *              AND high spectral flux (> 0.5 of running max)
 *   - Music:   RMS in [-40, 0] dB
 *              AND ZCR < 1200 /sec or very stable
 *              AND centroid stable
 *              AND lower flux (< 0.5 of running max)
 *   - Mixed:   features close to a boundary
 *   - Unknown: anything else (transient noise, clicks)
 *
 * We don't take the running-max approach here in the per-frame call (it
 * would require global state). Instead we use absolute flux thresholds
 * calibrated against a Hann-windowed FFT_SIZE spectrum.
 */
export function classifyFrame(frame: AnalysisFrame): {
  type:       SegmentType
  confidence: number
} {
  const { rmsDb: r, zcrPerSec: z, spectralCentroid: c, spectralFlux: fx } = frame

  // ── silence: hard energy threshold ──
  if (r < SILENCE_DB) {
    const margin = Math.min(1, (SILENCE_DB - r) / 10)
    return { type: 'silence', confidence: 0.6 + 0.4 * margin }
  }

  // ── speech signature ──
  // Voiced speech: high spectral flux, ZCR mid-range, centroid in vocal band.
  // Unvoiced consonants push ZCR up to ~6 k/s — we still allow these.
  const speechZcr      = z >= 400 && z <= 6000
  const speechCentroid = c >= 300 && c <= 3500
  const speechFlux     = fx > 8                 // empirical
  const speechEnergy   = r >= -45 && r <= -5

  // ── music signature ──
  // Sustained tones / chords: lower ZCR, lower flux, often higher energy.
  // We allow centroid range to extend higher (cymbals, bright instruments).
  const musicZcr      = z < 1500
  const musicFlux     = fx < 6
  const musicEnergy   = r >= -40

  let speechScore = 0
  if (speechEnergy)   speechScore++
  if (speechZcr)      speechScore++
  if (speechCentroid) speechScore++
  if (speechFlux)     speechScore++

  let musicScore = 0
  if (musicEnergy) musicScore++
  if (musicZcr)    musicScore++
  if (musicFlux)   musicScore++

  // High-confidence speech: all four features fit.
  if (speechScore === 4 && musicScore < 3) {
    return { type: 'speech', confidence: 0.9 }
  }
  // High-confidence music: all three features fit, speech doesn't.
  if (musicScore === 3 && speechScore <= 2) {
    return { type: 'music', confidence: 0.85 }
  }
  // Solid speech (3 of 4 features).
  if (speechScore >= 3 && speechScore > musicScore) {
    return { type: 'speech', confidence: 0.7 }
  }
  // Solid music (≥2 of 3 features and speech doesn't dominate).
  if (musicScore >= 2 && musicScore >= speechScore) {
    return { type: 'music', confidence: 0.65 }
  }
  // Borderline — both partially fit.
  if (speechScore >= 2 && musicScore >= 2) {
    return { type: 'mixed', confidence: 0.5 }
  }

  return { type: 'unknown', confidence: 0.3 }
}

/**
 * Median filter over an array of SegmentType values. For each index,
 * looks at ±halfWin neighbours and returns the most-frequent type in
 * that window. Removes single-frame outliers (e.g. a single 'mixed'
 * frame inside a long speech run) without blurring genuine transitions
 * since transitions span many frames.
 */
export function medianSmooth(types: SegmentType[], halfWin: number): SegmentType[] {
  const out: SegmentType[] = new Array(types.length)
  for (let i = 0; i < types.length; i++) {
    const lo = Math.max(0, i - halfWin)
    const hi = Math.min(types.length - 1, i + halfWin)
    const counts: Partial<Record<SegmentType, number>> = {}
    let bestType: SegmentType = types[i]
    let bestCount = 0
    for (let j = lo; j <= hi; j++) {
      const t = types[j]
      const c = (counts[t] ?? 0) + 1
      counts[t] = c
      if (c > bestCount) { bestCount = c; bestType = t }
    }
    out[i] = bestType
  }
  return out
}

/**
 * Walk classified frames, group consecutive same-type frames into
 * segments. Computes confidence as the mean confidence of constituent
 * frames; avgRmsDb is the mean RMS (skipping -Infinity silences which
 * would poison the mean).
 */
function groupSegments(
  frames:      AnalysisFrame[],
  types:       SegmentType[],
  confidences: number[],
): AnalysisSegment[] {
  if (frames.length === 0) return []
  const segments: AnalysisSegment[] = []
  let segStart = 0
  let segType  = types[0]

  const closeSegment = (endFrameExclusive: number) => {
    const startFrame = segStart
    const endFrame   = endFrameExclusive
    const startSec   = frames[startFrame].startSec
    // End time = start of the frame after the last one we included, or
    // start of last frame + frame duration if we're at the very end.
    const endSec = endFrame < frames.length
      ? frames[endFrame].startSec
      : frames[endFrame - 1].startSec + FRAME_MS / 1000

    let rmsSum = 0
    let rmsCount = 0
    let confSum = 0
    for (let i = startFrame; i < endFrame; i++) {
      const r = frames[i].rmsDb
      if (Number.isFinite(r)) { rmsSum += r; rmsCount++ }
      confSum += confidences[i]
    }
    const avgRmsDb = rmsCount > 0 ? rmsSum / rmsCount : -Infinity
    const confidence = confSum / (endFrame - startFrame)

    segments.push({
      startSec,
      endSec,
      durationSec: endSec - startSec,
      type:        segType,
      confidence,
      avgRmsDb,
      label:       LABELS[segType],
    })
  }

  for (let i = 1; i < frames.length; i++) {
    if (types[i] !== segType) {
      closeSegment(i)
      segStart = i
      segType  = types[i]
    }
  }
  closeSegment(frames.length)
  return segments
}

/**
 * Merge segments shorter than MIN_SEGMENT_SEC into a neighbour. We pick
 * the longer adjacent segment as the merge target (so a tiny "mixed"
 * island in the middle of a sermon becomes part of the sermon, not its
 * own chapter). If both neighbours are also short we keep walking.
 *
 * Edge cases:
 *   - Short segment at the very start → merge into next
 *   - Short segment at the very end → merge into previous
 *   - Whole file is one short segment → keep it (caller still gets data)
 */
export function mergeShortSegments(segments: AnalysisSegment[]): AnalysisSegment[] {
  if (segments.length <= 1) return [...segments]

  // Repeat until stable — merging can create new short segments only if
  // we merge into a segment of the wrong type, which we don't; but the
  // outer loop is cheap and ensures convergence.
  let work = [...segments]
  let changed = true
  let iterations = 0
  while (changed && iterations < 10) {
    changed = false
    iterations++
    const next: AnalysisSegment[] = []
    for (let i = 0; i < work.length; i++) {
      const seg = work[i]
      if (seg.durationSec >= MIN_SEGMENT_SEC || work.length === 1) {
        next.push(seg)
        continue
      }
      // Short segment — decide neighbour. Prefer longer one.
      const prev = next[next.length - 1] ?? null
      const nxt  = work[i + 1] ?? null
      if (!prev && !nxt) { next.push(seg); continue }
      if (!prev)        { /* merge into next */
        work[i + 1] = extendInto(nxt!, seg, 'left')
        changed = true
        continue
      }
      if (!nxt) {        /* merge into prev */
        next[next.length - 1] = extendInto(prev, seg, 'right')
        changed = true
        continue
      }
      // Both exist — pick longer.
      if (prev.durationSec >= nxt.durationSec) {
        next[next.length - 1] = extendInto(prev, seg, 'right')
      } else {
        work[i + 1] = extendInto(nxt, seg, 'left')
      }
      changed = true
    }
    work = next
  }

  // After merging, consecutive same-type segments can be adjacent if
  // we absorbed a short segment between two of the same type. Collapse.
  return collapseAdjacent(work)
}

/** Extend `target` to swallow `victim`. Direction tells us whether the
 *  victim is on target's left or right (affects start/end times). */
function extendInto(
  target:    AnalysisSegment,
  victim:    AnalysisSegment,
  direction: 'left' | 'right',
): AnalysisSegment {
  if (direction === 'right') {
    return {
      ...target,
      endSec:      victim.endSec,
      durationSec: victim.endSec - target.startSec,
    }
  }
  return {
    ...target,
    startSec:    victim.startSec,
    durationSec: target.endSec - victim.startSec,
  }
}

/** Merge consecutive segments of the same type (post-merge cleanup). */
function collapseAdjacent(segments: AnalysisSegment[]): AnalysisSegment[] {
  if (segments.length <= 1) return [...segments]
  const out: AnalysisSegment[] = [segments[0]]
  for (let i = 1; i < segments.length; i++) {
    const last = out[out.length - 1]
    const cur  = segments[i]
    if (cur.type === last.type) {
      out[out.length - 1] = {
        ...last,
        endSec:      cur.endSec,
        durationSec: cur.endSec - last.startSec,
        // Weighted mean — pretend both have equal frame counts. Good
        // enough for a UI hint.
        confidence:  (last.confidence + cur.confidence) / 2,
        avgRmsDb:    isFinite(last.avgRmsDb) && isFinite(cur.avgRmsDb)
                       ? (last.avgRmsDb + cur.avgRmsDb) / 2
                       : (isFinite(last.avgRmsDb) ? last.avgRmsDb : cur.avgRmsDb),
      }
    } else {
      out.push(cur)
    }
  }
  return out
}

/**
 * Take per-frame features, classify each, smooth the type sequence,
 * group into segments, and apply minimum-duration filtering.
 *
 * Returns segments ordered by start time, covering the whole input
 * range with no gaps.
 */
export function classifyAndGroup(frames: AnalysisFrame[]): AnalysisSegment[] {
  if (frames.length === 0) return []

  const rawTypes: SegmentType[] = new Array(frames.length)
  const confidences: number[]   = new Array(frames.length)
  for (let i = 0; i < frames.length; i++) {
    const { type, confidence } = classifyFrame(frames[i])
    rawTypes[i]    = type
    confidences[i] = confidence
  }

  const smoothed = medianSmooth(rawTypes, SMOOTH_HALF_WIN)
  const grouped  = groupSegments(frames, smoothed, confidences)
  return mergeShortSegments(grouped)
}

// ── Streaming PCM pipeline ───────────────────────────────────────────────────

/**
 * Run ffmpeg, decode to mono 16 kHz float32 PCM, accumulate features
 * frame-by-frame, then classify and group. Streams stdout to keep
 * memory bounded — 100 ms frames are processed and discarded as they
 * arrive.
 *
 * Progress reporting: we approximate by relying on ffmpeg's stderr
 * "time=hh:mm:ss" lines vs the duration parsed from the same stderr.
 * Since we kick off the decode without knowing the total duration in
 * advance, the first ~1s of progress jumps when the duration is
 * discovered.
 */
export async function analyzeAudio(
  inputPath:  string,
  onProgress?: (pct: number) => void,
): Promise<AnalysisSegment[]> {
  return new Promise((resolve) => {
    let done = false
    const finish = (result: AnalysisSegment[]) => {
      if (done) return
      done = true
      if (onProgress) { try { onProgress(100) } catch { /* swallow */ } }
      resolve(result)
    }

    const args = [
      '-hide_banner',
      '-nostdin',
      '-i', inputPath,
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-f', 'f32le',
      'pipe:1',
    ]

    let proc
    try {
      proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      finish([])
      return
    }

    // ── PCM buffering ──
    // Float32 = 4 bytes/sample. We accumulate raw bytes and slice off
    // whole frames; the tail (partial frame) stays buffered for next chunk.
    const BYTES_PER_FRAME = FRAME_SAMPLES * 4
    let pending: Buffer = Buffer.alloc(0)
    const frames: AnalysisFrame[] = []
    let prevMag: Float64Array | null = null
    let frameIndex = 0

    const processFrame = (buf: Buffer) => {
      // Reinterpret bytes as float32. Buffer offsets must be 4-aligned —
      // we slice on frame boundaries so this is always true.
      const samples = new Float32Array(
        buf.buffer, buf.byteOffset, FRAME_SAMPLES,
      )
      const startSec = (frameIndex * FRAME_SAMPLES) / SAMPLE_RATE
      const r = rmsDb(samples)
      const z = zcrPerSecond(samples, SAMPLE_RATE)
      const { centroid, magnitude } = spectrum(samples, SAMPLE_RATE)
      const flux = spectralFlux(magnitude, prevMag)
      prevMag = magnitude
      frames.push({
        startSec,
        rmsDb:            r,
        zcrPerSec:        z,
        spectralCentroid: centroid,
        spectralFlux:     flux,
      })
      frameIndex++
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      while (pending.length >= BYTES_PER_FRAME) {
        const frameBytes = pending.subarray(0, BYTES_PER_FRAME)
        // Copy into a fresh Buffer so the Float32Array view is stable
        // (subarray shares the underlying buffer which we're about to
        // realloc on the next concat).
        const stable = Buffer.from(frameBytes)
        processFrame(stable)
        pending = pending.subarray(BYTES_PER_FRAME)
      }
    })

    // ── progress + duration tracking ──
    let totalDurSec = 0
    proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString()
      if (totalDurSec === 0) {
        const m = text.match(/Duration:\s*(\d+):(\d+):([\d.]+)/)
        if (m) {
          totalDurSec = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3])
        }
      }
      if (onProgress && totalDurSec > 0) {
        const tm = text.match(/time=(\d+):(\d+):([\d.]+)/)
        if (tm) {
          const t = parseInt(tm[1]) * 3600 + parseInt(tm[2]) * 60 + parseFloat(tm[3])
          const pct = Math.max(0, Math.min(99, Math.floor((t / totalDurSec) * 100)))
          try { onProgress(pct) } catch { /* swallow */ }
        }
      }
    })

    // Safety: kill ffmpeg if it runs longer than expected. We don't know
    // input duration up front, so use a generous 10-minute wall-clock cap.
    const killTimer = setTimeout(() => { try { proc.kill() } catch { /* dead */ } }, 10 * 60 * 1000)

    proc.on('error', () => { clearTimeout(killTimer); finish([]) })
    proc.on('close', () => {
      clearTimeout(killTimer)
      // Tail bytes (less than a full frame) are dropped — at 100 ms /
      // frame the loss is at most 99 ms of audio.
      const segments = classifyAndGroup(frames)
      finish(segments)
    })
  })
}
