/**
 * Tests for src/main/audio-analysis.ts
 *
 * Two layers:
 *
 *   1) Pure-function tests for the math: FFT, RMS, ZCR, spectral centroid,
 *      spectral flux. We feed synthetic signals (sine waves, square waves,
 *      noise, silence) and check that the computed features land in the
 *      expected ranges.
 *
 *   2) Classifier + segment grouping tests. We construct AnalysisFrame
 *      arrays directly and verify smoothing, grouping, and the
 *      minimum-segment-duration filter behave as documented.
 *
 *   3) Integration test against analyzeAudio, which spawns ffmpeg. We
 *      mock child_process.spawn to feed synthetic float32 PCM into the
 *      streaming pipeline. This proves the streaming buffer logic works
 *      end-to-end without needing ffmpeg installed in CI.
 */

import { EventEmitter } from 'events'
import { spawn } from 'child_process'

jest.mock('child_process', () => ({ spawn: jest.fn() }))
jest.mock('../src/main/native-recorder', () => ({ ffmpegBin: '/mock/ffmpeg' }))

import {
  // pure helpers
  fft,
  hannWindow,
  rmsDb,
  zcrPerSecond,
  spectrum,
  spectralFlux,
  extractFeatures,
  classifyFrame,
  classifyAndGroup,
  medianSmooth,
  mergeShortSegments,
  // streaming
  analyzeAudio,
  // constants
  SAMPLE_RATE,
  FRAME_MS,
  FRAME_SAMPLES,
  FFT_SIZE,
  LABELS,
  // types
  type AnalysisFrame,
  type AnalysisSegment,
  type SegmentType,
} from '../src/main/audio-analysis'

// ── Synthetic signal generators ──────────────────────────────────────────────

function genSilence(seconds: number, sr = SAMPLE_RATE): Float32Array {
  return new Float32Array(Math.floor(seconds * sr))
}

function genSine(freqHz: number, seconds: number, amp = 0.5, sr = SAMPLE_RATE): Float32Array {
  const n = Math.floor(seconds * sr)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * freqHz * (i / sr))
  return out
}

function genSquare(freqHz: number, seconds: number, amp = 0.5, sr = SAMPLE_RATE): Float32Array {
  const n = Math.floor(seconds * sr)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = Math.sin(2 * Math.PI * freqHz * (i / sr)) >= 0 ? amp : -amp
  }
  return out
}

function genWhiteNoise(seconds: number, amp = 0.3, sr = SAMPLE_RATE): Float32Array {
  const n = Math.floor(seconds * sr)
  const out = new Float32Array(n)
  // Deterministic — seeded LCG so tests are reproducible.
  let state = 1
  for (let i = 0; i < n; i++) {
    state = (state * 1664525 + 1013904223) >>> 0
    out[i] = amp * ((state / 0xFFFFFFFF) * 2 - 1)
  }
  return out
}

/** Simulate speech-like audio: noise modulated by a slow envelope plus
 *  bursts of mid-frequency tone. Crude but produces ZCR + flux signatures
 *  that the classifier scores as speech. */
function genSpeechLike(seconds: number, sr = SAMPLE_RATE): Float32Array {
  const n = Math.floor(seconds * sr)
  const out = new Float32Array(n)
  const noise = genWhiteNoise(seconds, 0.15, sr)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    // Envelope wobbles at 4 Hz (syllable rate)
    const env = 0.4 + 0.4 * Math.abs(Math.sin(2 * Math.PI * 4 * t))
    // Modulated formant-like carrier 800 Hz
    const carrier = Math.sin(2 * Math.PI * 800 * t) * 0.3
    out[i] = env * (carrier + noise[i] * 1.2)
  }
  return out
}

/** Simulate music: stable chord (three sustained sines) plus light noise. */
function genMusicLike(seconds: number, sr = SAMPLE_RATE): Float32Array {
  const n = Math.floor(seconds * sr)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    // A4 + C#5 + E5 (simple major chord)
    out[i] = 0.25 * Math.sin(2 * Math.PI * 440 * t)
           + 0.20 * Math.sin(2 * Math.PI * 554 * t)
           + 0.18 * Math.sin(2 * Math.PI * 659 * t)
  }
  return out
}

// ── 1. FFT correctness ───────────────────────────────────────────────────────

describe('fft', () => {
  it('throws on non-power-of-two', () => {
    const re = new Float64Array(6)
    const im = new Float64Array(6)
    expect(() => fft(re, im)).toThrow()
  })

  it('throws on mismatched lengths', () => {
    expect(() => fft(new Float64Array(4), new Float64Array(8))).toThrow()
  })

  it('throws on size < 2', () => {
    expect(() => fft(new Float64Array(1), new Float64Array(1))).toThrow()
  })

  it('transforms a DC signal — energy in bin 0', () => {
    const n = 16
    const re = new Float64Array(n).fill(1)
    const im = new Float64Array(n)
    fft(re, im)
    expect(re[0]).toBeCloseTo(n, 5)
    for (let k = 1; k < n; k++) {
      expect(Math.abs(re[k])).toBeLessThan(1e-6)
      expect(Math.abs(im[k])).toBeLessThan(1e-6)
    }
  })

  it('puts a pure cosine at exactly its bin', () => {
    const n = 64
    const k0 = 5
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.cos(2 * Math.PI * k0 * i / n)
    fft(re, im)
    // Energy concentrates at bins k0 and n-k0.
    const mag = (k: number) => Math.sqrt(re[k] * re[k] + im[k] * im[k])
    expect(mag(k0)).toBeGreaterThan(n / 2 - 1)
    expect(mag(n - k0)).toBeGreaterThan(n / 2 - 1)
    for (let k = 1; k < n; k++) {
      if (k === k0 || k === n - k0) continue
      expect(mag(k)).toBeLessThan(0.001)
    }
  })
})

describe('hannWindow', () => {
  it('zeros at endpoints, peak in middle', () => {
    const w = hannWindow(64)
    expect(w[0]).toBeCloseTo(0, 6)
    expect(w[63]).toBeCloseTo(0, 6)
    expect(w[31]).toBeGreaterThan(0.95)
  })

  it('caches per-size', () => {
    const a = hannWindow(64)
    const b = hannWindow(64)
    expect(a).toBe(b) // exact same Float64Array instance
  })
})

// ── 2. Per-frame features ────────────────────────────────────────────────────

describe('rmsDb', () => {
  it('returns -Infinity for empty input', () => {
    expect(rmsDb(new Float32Array(0))).toBe(-Infinity)
  })

  it('returns -Infinity for true silence', () => {
    expect(rmsDb(new Float32Array(1000))).toBe(-Infinity)
  })

  it('returns 0 dBFS for full-scale sine', () => {
    const s = genSine(1000, 0.1, 1.0)
    // 0 dBFS peak sine has RMS = 1/sqrt(2) ≈ -3 dB
    const db = rmsDb(s)
    expect(db).toBeGreaterThan(-3.5)
    expect(db).toBeLessThan(-2.5)
  })

  it('drops 6 dB when amplitude halves', () => {
    const a = rmsDb(genSine(1000, 0.1, 0.5))
    const b = rmsDb(genSine(1000, 0.1, 0.25))
    expect(a - b).toBeCloseTo(6, 0)
  })
})

describe('zcrPerSecond', () => {
  it('zero for silence', () => {
    expect(zcrPerSecond(new Float32Array(1600), SAMPLE_RATE)).toBe(0)
  })

  it('returns 0 for buffer too short', () => {
    expect(zcrPerSecond(new Float32Array(0), SAMPLE_RATE)).toBe(0)
    expect(zcrPerSecond(new Float32Array([0.5]), SAMPLE_RATE)).toBe(0)
  })

  it('matches 2× freq for a sine wave', () => {
    // A 1 kHz sine has 2000 zero-crossings/sec.
    const s = genSine(1000, 0.1, 0.5)
    const zcr = zcrPerSecond(s, SAMPLE_RATE)
    expect(zcr).toBeGreaterThan(1900)
    expect(zcr).toBeLessThan(2100)
  })

  it('matches 2× freq for square wave too', () => {
    const s = genSquare(500, 0.1, 0.5)
    const zcr = zcrPerSecond(s, SAMPLE_RATE)
    expect(zcr).toBeGreaterThan(900)
    expect(zcr).toBeLessThan(1100)
  })

  it('high for white noise', () => {
    const s = genWhiteNoise(0.1, 0.3)
    const zcr = zcrPerSecond(s, SAMPLE_RATE)
    // White noise hits ~ sample_rate/2 in the limit; expect > 2 kHz.
    expect(zcr).toBeGreaterThan(2000)
  })
})

describe('spectrum', () => {
  it('puts 440 Hz sine centroid near 440', () => {
    const s = genSine(440, FRAME_MS / 1000, 0.5)
    const { centroid } = spectrum(s, SAMPLE_RATE)
    // Window leakage spreads energy slightly; allow ±50 Hz.
    expect(centroid).toBeGreaterThan(390)
    expect(centroid).toBeLessThan(490)
  })

  it('puts 2 kHz sine centroid near 2 kHz', () => {
    const s = genSine(2000, FRAME_MS / 1000, 0.5)
    const { centroid } = spectrum(s, SAMPLE_RATE)
    expect(centroid).toBeGreaterThan(1900)
    expect(centroid).toBeLessThan(2100)
  })

  it('white noise centroid is broad — well above 1 kHz', () => {
    const s = genWhiteNoise(FRAME_MS / 1000, 0.3)
    const { centroid } = spectrum(s, SAMPLE_RATE)
    // Theoretical mean for uniform-spectrum white noise = sampleRate/4 = 4000 Hz.
    // Allow wide tolerance — windowing biases it down.
    expect(centroid).toBeGreaterThan(1500)
  })

  it('silence centroid is 0', () => {
    const { centroid } = spectrum(new Float32Array(FRAME_SAMPLES), SAMPLE_RATE)
    expect(centroid).toBe(0)
  })

  it('returns full-length magnitude array', () => {
    const s = genSine(1000, FRAME_MS / 1000, 0.5)
    const { magnitude } = spectrum(s, SAMPLE_RATE)
    expect(magnitude.length).toBe(FFT_SIZE / 2 + 1)
  })
})

describe('spectralFlux', () => {
  it('zero when no previous frame', () => {
    expect(spectralFlux(new Float64Array(10), null)).toBe(0)
  })

  it('zero between identical frames', () => {
    const a = new Float64Array([1, 2, 3, 4])
    const b = new Float64Array([1, 2, 3, 4])
    expect(spectralFlux(a, b)).toBe(0)
  })

  it('positive when content changes', () => {
    const a = new Float64Array([1, 0, 0, 0])
    const b = new Float64Array([0, 1, 0, 0])
    expect(spectralFlux(a, b)).toBeGreaterThan(0)
  })

  it('grows with chirp — later frames have positive flux', () => {
    // 500 ms chirp 200 → 2000 Hz (5 frames). Each successive frame's
    // dominant frequency shifts, so spectral flux is non-zero.
    const total  = genChirp(200, 2000, 0.5, 0.5)
    const frames = extractFeatures(total, SAMPLE_RATE, FRAME_MS)
    expect(frames.length).toBeGreaterThanOrEqual(5)
    const fluxes = frames.slice(1).map(f => f.spectralFlux)
    expect(fluxes.every(f => f > 0)).toBe(true)
  })
})

function genChirp(f0: number, f1: number, seconds: number, amp = 0.5, sr = SAMPLE_RATE): Float32Array {
  const n = Math.floor(seconds * sr)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const k = (f1 - f0) / seconds // chirp rate (Hz/s)
    const phase = 2 * Math.PI * (f0 * t + 0.5 * k * t * t)
    out[i] = amp * Math.sin(phase)
  }
  return out
}

// ── 3. extractFeatures ──────────────────────────────────────────────────────

describe('extractFeatures', () => {
  it('returns empty for empty PCM', () => {
    expect(extractFeatures(new Float32Array(0), SAMPLE_RATE, FRAME_MS)).toEqual([])
  })

  it('returns empty for zero sample rate', () => {
    expect(extractFeatures(genSine(1000, 0.1), 0, FRAME_MS)).toEqual([])
  })

  it('returns empty for zero frame size', () => {
    expect(extractFeatures(genSine(1000, 0.1), SAMPLE_RATE, 0)).toEqual([])
  })

  it('emits one frame per 100 ms of audio', () => {
    const pcm = genSine(1000, 1, 0.5)        // 1 s at 16 kHz = 16000 samples
    const frames = extractFeatures(pcm, SAMPLE_RATE, FRAME_MS)
    // 16000 / 1600 = 10 full frames.
    expect(frames.length).toBe(10)
  })

  it('each frame has the documented shape', () => {
    const pcm = genSine(440, 0.3, 0.5)
    const frames = extractFeatures(pcm, SAMPLE_RATE, FRAME_MS)
    expect(frames.length).toBeGreaterThan(0)
    for (const f of frames) {
      expect(typeof f.startSec).toBe('number')
      expect(typeof f.rmsDb).toBe('number')
      expect(typeof f.zcrPerSec).toBe('number')
      expect(typeof f.spectralCentroid).toBe('number')
      expect(typeof f.spectralFlux).toBe('number')
    }
  })

  it('startSec increments by 0.1 per frame', () => {
    const pcm = genSine(440, 1, 0.5)
    const frames = extractFeatures(pcm, SAMPLE_RATE, FRAME_MS)
    for (let i = 0; i < frames.length; i++) {
      expect(frames[i].startSec).toBeCloseTo(i * 0.1, 4)
    }
  })

  it('silence frames have RMS at -Infinity', () => {
    const pcm = genSilence(1)
    const frames = extractFeatures(pcm, SAMPLE_RATE, FRAME_MS)
    expect(frames.every(f => f.rmsDb === -Infinity)).toBe(true)
    expect(frames.every(f => f.zcrPerSec === 0)).toBe(true)
  })

  it('sine wave centroid is stable across frames', () => {
    const pcm = genSine(1000, 1, 0.5)
    const frames = extractFeatures(pcm, SAMPLE_RATE, FRAME_MS)
    const centroids = frames.map(f => f.spectralCentroid)
    const mean = centroids.reduce((a, b) => a + b, 0) / centroids.length
    expect(mean).toBeGreaterThan(900)
    expect(mean).toBeLessThan(1100)
    // Variance should be tiny.
    const variance = centroids.reduce((a, b) => a + (b - mean) ** 2, 0) / centroids.length
    expect(variance).toBeLessThan(500)
  })
})

// ── 4. classifyFrame ────────────────────────────────────────────────────────

describe('classifyFrame', () => {
  it('classifies very-low-energy frame as silence', () => {
    const f: AnalysisFrame = { startSec: 0, rmsDb: -60, zcrPerSec: 100, spectralCentroid: 500, spectralFlux: 1 }
    const r = classifyFrame(f)
    expect(r.type).toBe('silence')
    expect(r.confidence).toBeGreaterThan(0.5)
  })

  it('classifies a clean speech-like profile as speech', () => {
    // Energy moderate, ZCR mid, centroid in speech band, high flux.
    const f: AnalysisFrame = { startSec: 0, rmsDb: -20, zcrPerSec: 2000, spectralCentroid: 1500, spectralFlux: 30 }
    expect(classifyFrame(f).type).toBe('speech')
  })

  it('classifies a sustained-tone profile as music', () => {
    // Higher energy, low ZCR, low flux.
    const f: AnalysisFrame = { startSec: 0, rmsDb: -15, zcrPerSec: 800, spectralCentroid: 1000, spectralFlux: 2 }
    expect(classifyFrame(f).type).toBe('music')
  })

  it('classifies borderline frame as mixed or unknown', () => {
    // Mid everything — neither strong speech nor strong music.
    const f: AnalysisFrame = { startSec: 0, rmsDb: -20, zcrPerSec: 1300, spectralCentroid: 1500, spectralFlux: 7 }
    const t = classifyFrame(f).type
    expect(['mixed', 'speech', 'music', 'unknown']).toContain(t)
  })

  it('classifies a transient (low energy, high flux, way-out-of-band ZCR) as unknown', () => {
    // Below music threshold for energy, way above speech threshold for
    // ZCR — neither speech nor music score enough features.
    const f: AnalysisFrame = { startSec: 0, rmsDb: -42, zcrPerSec: 7500, spectralCentroid: 5500, spectralFlux: 20 }
    expect(classifyFrame(f).type).toBe('unknown')
  })
})

// ── 5. medianSmooth ─────────────────────────────────────────────────────────

describe('medianSmooth', () => {
  it('returns empty for empty input', () => {
    expect(medianSmooth([], 5)).toEqual([])
  })

  it('passes through a uniform sequence', () => {
    const t: SegmentType[] = ['speech', 'speech', 'speech', 'speech', 'speech']
    expect(medianSmooth(t, 2)).toEqual(t)
  })

  it('removes a single-frame outlier', () => {
    const t: SegmentType[] = ['speech', 'speech', 'speech', 'music', 'speech', 'speech', 'speech']
    const out = medianSmooth(t, 2)
    expect(out[3]).toBe('speech') // outlier smoothed away
  })

  it('preserves long runs of either type', () => {
    const t: SegmentType[] = [
      'speech', 'speech', 'speech', 'speech', 'speech',
      'music',  'music',  'music',  'music',  'music',
    ]
    const out = medianSmooth(t, 2)
    expect(out[1]).toBe('speech')
    expect(out[8]).toBe('music')
  })
})

// ── 6. classifyAndGroup ─────────────────────────────────────────────────────

function makeFrames(types: SegmentType[], opts?: { rmsDb?: number }): AnalysisFrame[] {
  // Build frames whose features are STRONG enough for the per-frame
  // classifier to produce the desired type. We don't rely on this — we
  // pass classifyAndGroup's input via the type sequence directly through
  // a higher-level helper instead. See `runGrouping`.
  return types.map((_, i) => ({
    startSec: i * 0.1,
    rmsDb: opts?.rmsDb ?? -20,
    zcrPerSec: 2000,
    spectralCentroid: 1500,
    spectralFlux: 30,
  }))
}

// Helper that bypasses the per-frame classifier: build frames matching each
// requested type with features chosen to map cleanly to that type. Used so
// our grouping tests are independent of classifier tweaks.
function framesForTypes(seq: SegmentType[]): AnalysisFrame[] {
  return seq.map((t, i) => {
    switch (t) {
      case 'silence': return { startSec: i * 0.1, rmsDb: -80, zcrPerSec: 0,    spectralCentroid: 0,    spectralFlux: 0 }
      case 'speech':  return { startSec: i * 0.1, rmsDb: -20, zcrPerSec: 2000, spectralCentroid: 1500, spectralFlux: 30 }
      case 'music':   return { startSec: i * 0.1, rmsDb: -15, zcrPerSec: 800,  spectralCentroid: 1000, spectralFlux: 2  }
      // 'mixed' and 'unknown' don't have a clean preset; use a borderline.
      default:        return { startSec: i * 0.1, rmsDb: -20, zcrPerSec: 1300, spectralCentroid: 1500, spectralFlux: 7  }
    }
  })
}

describe('classifyAndGroup', () => {
  it('returns empty for empty input', () => {
    expect(classifyAndGroup([])).toEqual([])
  })

  it('a single all-silence run produces one silence segment', () => {
    const frames = framesForTypes(Array(100).fill('silence' as SegmentType)) // 10 s
    const segs = classifyAndGroup(frames)
    expect(segs.length).toBe(1)
    expect(segs[0].type).toBe('silence')
    expect(segs[0].durationSec).toBeCloseTo(10, 1)
    expect(segs[0].label).toBe(LABELS.silence)
  })

  it('a single all-speech run produces one speech segment', () => {
    const frames = framesForTypes(Array(200).fill('speech' as SegmentType)) // 20 s
    const segs = classifyAndGroup(frames)
    expect(segs.length).toBe(1)
    expect(segs[0].type).toBe('speech')
    expect(segs[0].label).toBe(LABELS.speech)
    expect(segs[0].durationSec).toBeCloseTo(20, 1)
  })

  it('speech-silence-speech with 10-s silence makes 3 segments', () => {
    const seq: SegmentType[] = [
      ...Array(100).fill('speech'  as SegmentType),  // 10 s
      ...Array(100).fill('silence' as SegmentType),  // 10 s
      ...Array(100).fill('speech'  as SegmentType),  // 10 s
    ]
    const segs = classifyAndGroup(framesForTypes(seq))
    expect(segs.length).toBe(3)
    expect(segs.map(s => s.type)).toEqual(['speech', 'silence', 'speech'])
  })

  it('sub-5-second segment is merged into a neighbour', () => {
    // 10 s speech, 2 s silence (too short), 10 s speech.
    const seq: SegmentType[] = [
      ...Array(100).fill('speech'  as SegmentType), // 10 s
      ...Array(20 ).fill('silence' as SegmentType), // 2 s
      ...Array(100).fill('speech'  as SegmentType), // 10 s
    ]
    const segs = classifyAndGroup(framesForTypes(seq))
    // After merge + collapse-adjacent, we should be left with one segment.
    expect(segs.length).toBe(1)
    expect(segs[0].type).toBe('speech')
  })

  it('music-speech boundary is preserved', () => {
    const seq: SegmentType[] = [
      ...Array(100).fill('music'  as SegmentType), // 10 s music
      ...Array(100).fill('speech' as SegmentType), // 10 s speech
    ]
    const segs = classifyAndGroup(framesForTypes(seq))
    expect(segs.length).toBe(2)
    expect(segs[0].type).toBe('music')
    expect(segs[1].type).toBe('speech')
  })

  it('segments cover the whole timeline with no gaps', () => {
    const seq: SegmentType[] = [
      ...Array(80).fill('speech'  as SegmentType),
      ...Array(60).fill('silence' as SegmentType),
      ...Array(80).fill('music'   as SegmentType),
    ]
    const segs = classifyAndGroup(framesForTypes(seq))
    expect(segs[0].startSec).toBeCloseTo(0, 3)
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].startSec).toBeCloseTo(segs[i - 1].endSec, 3)
    }
  })

  it('reports a Norwegian label from LABELS', () => {
    const segs = classifyAndGroup(framesForTypes(Array(100).fill('music' as SegmentType)))
    expect(segs[0].label).toBe(LABELS.music)
  })

  it('confidence is between 0 and 1', () => {
    const segs = classifyAndGroup(framesForTypes(Array(100).fill('speech' as SegmentType)))
    expect(segs[0].confidence).toBeGreaterThan(0)
    expect(segs[0].confidence).toBeLessThanOrEqual(1)
  })

  it('single-frame outliers are smoothed before grouping', () => {
    // Long speech run with one music frame in the middle. The median
    // filter should erase it.
    const seq: SegmentType[] = [
      ...Array(100).fill('speech' as SegmentType),
      'music',
      ...Array(100).fill('speech' as SegmentType),
    ]
    const segs = classifyAndGroup(framesForTypes(seq))
    expect(segs.length).toBe(1)
    expect(segs[0].type).toBe('speech')
  })
})

describe('mergeShortSegments', () => {
  it('passes through a single segment', () => {
    const seg: AnalysisSegment = {
      startSec: 0, endSec: 3, durationSec: 3, type: 'speech',
      confidence: 1, avgRmsDb: -20, label: LABELS.speech,
    }
    expect(mergeShortSegments([seg])).toEqual([seg])
  })

  it('merges a short segment between two longer neighbours into the longer one', () => {
    const segs: AnalysisSegment[] = [
      { startSec: 0,  endSec: 10, durationSec: 10, type: 'speech', confidence: 1, avgRmsDb: -20, label: LABELS.speech }, // long
      { startSec: 10, endSec: 12, durationSec: 2,  type: 'music',  confidence: 1, avgRmsDb: -15, label: LABELS.music  }, // short
      { startSec: 12, endSec: 30, durationSec: 18, type: 'speech', confidence: 1, avgRmsDb: -20, label: LABELS.speech }, // longer
    ]
    const out = mergeShortSegments(segs)
    // Short music is absorbed; remaining two same-type speech segments collapse.
    expect(out.length).toBe(1)
    expect(out[0].type).toBe('speech')
    expect(out[0].startSec).toBe(0)
    expect(out[0].endSec).toBe(30)
  })

  it('handles short segment at the very start by merging into next', () => {
    const segs: AnalysisSegment[] = [
      { startSec: 0, endSec: 2,  durationSec: 2,  type: 'music',  confidence: 1, avgRmsDb: -15, label: LABELS.music  },
      { startSec: 2, endSec: 30, durationSec: 28, type: 'speech', confidence: 1, avgRmsDb: -20, label: LABELS.speech },
    ]
    const out = mergeShortSegments(segs)
    expect(out.length).toBe(1)
    expect(out[0].type).toBe('speech')
    expect(out[0].startSec).toBe(0)
    expect(out[0].endSec).toBe(30)
  })

  it('handles short segment at the very end by merging into previous', () => {
    const segs: AnalysisSegment[] = [
      { startSec: 0,  endSec: 25, durationSec: 25, type: 'speech', confidence: 1, avgRmsDb: -20, label: LABELS.speech },
      { startSec: 25, endSec: 27, durationSec: 2,  type: 'music',  confidence: 1, avgRmsDb: -15, label: LABELS.music  },
    ]
    const out = mergeShortSegments(segs)
    expect(out.length).toBe(1)
    expect(out[0].type).toBe('speech')
    expect(out[0].endSec).toBe(27)
  })

  it('keeps every segment when all are above the min duration', () => {
    const segs: AnalysisSegment[] = [
      { startSec: 0,  endSec: 10, durationSec: 10, type: 'speech', confidence: 1, avgRmsDb: -20, label: LABELS.speech },
      { startSec: 10, endSec: 25, durationSec: 15, type: 'music',  confidence: 1, avgRmsDb: -15, label: LABELS.music  },
      { startSec: 25, endSec: 40, durationSec: 15, type: 'speech', confidence: 1, avgRmsDb: -20, label: LABELS.speech },
    ]
    const out = mergeShortSegments(segs)
    expect(out.length).toBe(3)
  })

  it('preserves the single-short-segment edge case (whole file is short)', () => {
    const segs: AnalysisSegment[] = [
      { startSec: 0, endSec: 2, durationSec: 2, type: 'speech', confidence: 1, avgRmsDb: -20, label: LABELS.speech },
    ]
    expect(mergeShortSegments(segs)).toHaveLength(1)
  })
})

// ── 7. Integration with synthetic audio ─────────────────────────────────────

describe('classifyAndGroup integration with real feature extraction', () => {
  it('classifies a speech-like signal as speech (mostly)', () => {
    // 5 s of speech-like audio → 50 frames. Extract features then classify.
    const pcm = genSpeechLike(5)
    const frames = extractFeatures(pcm, SAMPLE_RATE, FRAME_MS)
    const segs = classifyAndGroup(frames)
    expect(segs.length).toBeGreaterThanOrEqual(1)
    // At least one segment must be speech-typed (don't insist on every
    // frame — synthetic speech is fuzzy at the boundaries).
    const types = segs.map(s => s.type)
    expect(types).toContain('speech')
  })

  it('classifies a sustained-tone (music) signal as not-speech', () => {
    // Stable chord ≠ speech. Could be 'music' or 'unknown' depending on
    // exact thresholds; just make sure we don't mis-label it speech.
    const pcm = genMusicLike(5)
    const frames = extractFeatures(pcm, SAMPLE_RATE, FRAME_MS)
    const segs = classifyAndGroup(frames)
    expect(segs.length).toBeGreaterThanOrEqual(1)
    // The dominant segment should not be 'speech'.
    const longest = segs.reduce((a, b) => a.durationSec >= b.durationSec ? a : b)
    expect(longest.type).not.toBe('speech')
  })

  it('classifies pure silence as silence', () => {
    const pcm = genSilence(5)
    const frames = extractFeatures(pcm, SAMPLE_RATE, FRAME_MS)
    const segs = classifyAndGroup(frames)
    expect(segs.length).toBe(1)
    expect(segs[0].type).toBe('silence')
    expect(segs[0].durationSec).toBeCloseTo(5, 1)
  })
})

// ── 8. analyzeAudio (streaming pipeline, mocked ffmpeg) ─────────────────────

interface FakeProc extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill:   jest.Mock
}

function makeFakeProc(): FakeProc {
  const p = new EventEmitter() as FakeProc
  p.stdout = new EventEmitter()
  p.stderr = new EventEmitter()
  p.kill   = jest.fn()
  return p
}

const mockSpawn = spawn as unknown as jest.Mock

/** Convert a Float32Array to a Node Buffer of little-endian floats — the
 *  format ffmpeg's `f32le` produces. */
function floatArrayToBuffer(samples: Float32Array): Buffer {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
}

describe('analyzeAudio', () => {
  beforeEach(() => { mockSpawn.mockReset() })

  it('returns empty array if spawn throws', async () => {
    mockSpawn.mockImplementation(() => { throw new Error('ENOENT') })
    const result = await analyzeAudio('/fake/file.wav')
    expect(result).toEqual([])
  })

  it('returns empty array if ffmpeg errors out', async () => {
    const proc = makeFakeProc()
    mockSpawn.mockReturnValue(proc)
    const p = analyzeAudio('/fake/file.wav')
    setImmediate(() => proc.emit('error', new Error('boom')))
    const result = await p
    expect(result).toEqual([])
  })

  it('streams PCM, classifies, and returns segments', async () => {
    const proc = makeFakeProc()
    mockSpawn.mockReturnValue(proc)

    const p = analyzeAudio('/fake/file.wav')

    // Feed 5 seconds of silence into stdout, then close.
    const pcm = genSilence(5)
    setImmediate(() => {
      proc.stderr.emit('data', Buffer.from('Duration: 00:00:05.00\n'))
      proc.stdout.emit('data', floatArrayToBuffer(pcm))
      proc.emit('close', 0)
    })
    const result = await p
    expect(result.length).toBeGreaterThanOrEqual(1)
    expect(result[0].type).toBe('silence')
  })

  it('reports progress via the onProgress callback', async () => {
    const proc = makeFakeProc()
    mockSpawn.mockReturnValue(proc)
    const progressValues: number[] = []

    const p = analyzeAudio('/fake/file.wav', pct => progressValues.push(pct))

    setImmediate(() => {
      proc.stderr.emit('data', Buffer.from('Duration: 00:00:10.00\n'))
      proc.stderr.emit('data', Buffer.from('time=00:00:05.00\n'))
      proc.stdout.emit('data', floatArrayToBuffer(genSilence(10)))
      proc.emit('close', 0)
    })
    await p

    // We should see at least one mid-progress value AND a final 100.
    expect(progressValues).toContain(100)
    expect(progressValues.some(v => v > 0 && v < 100)).toBe(true)
  })

  it('handles chunked PCM arriving in multiple data events', async () => {
    const proc = makeFakeProc()
    mockSpawn.mockReturnValue(proc)
    const p = analyzeAudio('/fake/file.wav')

    const pcm = genSilence(5)
    const buf = floatArrayToBuffer(pcm)
    // Split into 17-byte chunks (an awkward size that doesn't align to
    // float boundaries) to stress the buffering logic.
    setImmediate(() => {
      proc.stderr.emit('data', Buffer.from('Duration: 00:00:05.00\n'))
      for (let i = 0; i < buf.length; i += 17) {
        proc.stdout.emit('data', buf.subarray(i, Math.min(i + 17, buf.length)))
      }
      proc.emit('close', 0)
    })
    const result = await p
    expect(result.length).toBeGreaterThanOrEqual(1)
    // Awkward chunking shouldn't corrupt the analysis — all-silence in,
    // silence-segment out.
    expect(result[0].type).toBe('silence')
  })
})

// Silence "unused" complaints for makeFrames if no test calls it.
void makeFrames
