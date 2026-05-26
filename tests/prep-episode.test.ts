/**
 * prep-episode tests — verify the sermon-detection + attention-reason
 * logic without running ffmpeg. We inject a mock `analyzeFn` that returns
 * a predetermined segment list and assert on the resulting EpisodePrep.
 */

import * as prep from '../src/main/prep-episode'
import * as store from '../src/main/store'
import type { AnalysisSegment } from '../src/main/audio-analysis'
import type { PrepAnalysisSegment } from '../src/types'

function seg(
  type: AnalysisSegment['type'],
  startSec: number,
  durationSec: number,
  confidence = 0.8,
): AnalysisSegment {
  return {
    startSec,
    endSec:      startSec + durationSec,
    durationSec,
    type,
    confidence,
    avgRmsDb:    -20,
    label:       type,
  }
}

function prepSeg(
  type: PrepAnalysisSegment['type'],
  startSec: number,
  durationSec: number,
  confidence = 0.8,
): PrepAnalysisSegment {
  return {
    startSec,
    endSec:      startSec + durationSec,
    durationSec,
    type,
    confidence,
    avgRmsDb:    -20,
    label:       type,
  }
}

beforeEach(() => store.reset())

// ── findSermonSegment ─────────────────────────────────────────────────────

describe('findSermonSegment', () => {
  it('picks the longest speech segment after the 5-min mark', () => {
    const segs: PrepAnalysisSegment[] = [
      prepSeg('music',  0,    300),  // 0–5min worship
      prepSeg('speech', 300,  120),  // 5–7min announcements (too short)
      prepSeg('music',  420,  60),
      prepSeg('speech', 480,  1500), // 8–33min sermon — this is the winner
      prepSeg('music',  1980, 120),  // closing
    ]
    const result = prep.findSermonSegment(segs, 2100)
    expect(result).not.toBeNull()
    expect(result!.startSec).toBe(480)
    expect(result!.endSec).toBe(1980)
  })

  it('returns null when no qualifying segment exists', () => {
    const segs: PrepAnalysisSegment[] = [
      prepSeg('music',  0,   300),
      prepSeg('speech', 300, 60),  // too short
    ]
    const result = prep.findSermonSegment(segs, 360)
    expect(result).toBeNull()
  })

  it('rejects a long speech segment that starts before 5 min', () => {
    const segs: PrepAnalysisSegment[] = [
      prepSeg('speech', 0,    1200), // long but starts at 0
      prepSeg('music',  1200, 300),
    ]
    const result = prep.findSermonSegment(segs, 1500)
    expect(result).toBeNull()
  })

  it('uses confidence as tiebreaker for equal-length segments', () => {
    const segs: PrepAnalysisSegment[] = [
      prepSeg('music',  0,   300),
      prepSeg('speech', 300, 600, 0.7),
      prepSeg('music',  900, 60),
      prepSeg('speech', 960, 600, 0.9),
    ]
    const result = prep.findSermonSegment(segs, 1560)
    expect(result).not.toBeNull()
    expect(result!.startSec).toBe(960)   // higher confidence wins
    expect(result!.confidence).toBe(0.9)
  })

  it('clamps endSec to file duration if segment overshoots', () => {
    const segs: PrepAnalysisSegment[] = [
      prepSeg('music',  0,   300),
      prepSeg('speech', 300, 2000),
    ]
    const result = prep.findSermonSegment(segs, 1500)
    expect(result!.endSec).toBe(1500)
  })

  it('returns null for an empty segment array', () => {
    expect(prep.findSermonSegment([], 0)).toBeNull()
  })

  // ── Sermon-only recording (Case 0) ───────────────────────────────────────
  // Some churches record only the sermon, not the full service. The full file
  // is then ≥80% speech with little/no music. Should return bounds covering
  // ALL speech, not just the longest segment.

  it('sermon-only: 25-min recording with continuous speech returns full span', () => {
    // 25 min = 1500s of speech, broken into 3 chunks by short pauses
    const segs: PrepAnalysisSegment[] = [
      prepSeg('speech',  0,    480, 0.85),   // 0-8 min
      prepSeg('silence', 480,  20),           // 20s pause (mic break)
      prepSeg('speech',  500,  600, 0.85),   // 8m20s-18m20s
      prepSeg('silence', 1100, 15),
      prepSeg('speech',  1115, 385, 0.85),   // 18m35s-25m
    ]
    const result = prep.findSermonSegment(segs, 1500)
    expect(result).not.toBeNull()
    expect(result!.startSec).toBe(0)
    expect(result!.endSec).toBe(1500)
  })

  it('sermon-only: trims silent edges (mic-on/mic-off captured pauses)', () => {
    const segs: PrepAnalysisSegment[] = [
      prepSeg('silence', 0,   12),           // 12s mic-on silence
      prepSeg('speech',  12,  1400, 0.85),   // ~23 min sermon
      prepSeg('silence', 1412, 8),           // 8s mic-off silence
    ]
    const result = prep.findSermonSegment(segs, 1420)
    expect(result).not.toBeNull()
    expect(result!.startSec).toBe(12)
    expect(result!.endSec).toBe(1412)
  })

  it('sermon-only is NOT triggered for full service with music', () => {
    // 90-min service with worship music, sermon, closing songs.
    // speech-ratio is below 80% threshold.
    const segs: PrepAnalysisSegment[] = [
      prepSeg('music',  0,    900),    // 15 min worship
      prepSeg('speech', 900,  240, 0.7), // 4 min announcements
      prepSeg('music',  1140, 240),    // 4 min hymn
      prepSeg('speech', 1380, 1800, 0.85), // 30 min sermon
      prepSeg('music',  3180, 600),    // 10 min closing music
      prepSeg('speech', 3780, 120, 0.7), // closing remarks
    ]
    const result = prep.findSermonSegment(segs, 3900)
    expect(result).not.toBeNull()
    // Should find the 30-min sermon block, NOT span the entire file
    expect(result!.startSec).toBe(1380)
    expect(result!.endSec).toBe(3180)
  })

  it('sermon-only is skipped for very short clips (under 60s total)', () => {
    const segs: PrepAnalysisSegment[] = [
      prepSeg('speech', 0, 50, 0.85),
    ]
    // Short clip — should fall through to normal logic, which rejects
    // the 50s segment as too short for sermon (<3 min minimum).
    const result = prep.findSermonSegment(segs, 50)
    expect(result).toBeNull()
  })
})

// ── deriveAttentionReasons ────────────────────────────────────────────────

describe('deriveAttentionReasons', () => {
  it('returns empty array for a normal-looking service', () => {
    const segs: PrepAnalysisSegment[] = [
      prepSeg('music',  0,   300),
      prepSeg('speech', 300, 1500, 0.85),  // 25-min sermon, high confidence
      prepSeg('music',  1800, 120),
    ]
    const sermon = prep.findSermonSegment(segs, 1920)
    const reasons = prep.deriveAttentionReasons(segs, sermon, 1920)
    expect(reasons).toEqual([])
  })

  it('flags "no sermon block" when nothing > 3 min after 5 min mark', () => {
    const segs: PrepAnalysisSegment[] = [
      prepSeg('music',  0,   300),
      prepSeg('speech', 300, 60),  // tiny speech
      prepSeg('music',  360, 240),
    ]
    const sermon = prep.findSermonSegment(segs, 600)
    const reasons = prep.deriveAttentionReasons(segs, sermon, 600)
    expect(reasons).toContain(prep.ATTENTION_REASONS.noSermonBlock)
  })

  it('flags "speech at start" when the long speech is before 5 min', () => {
    const segs: PrepAnalysisSegment[] = [
      prepSeg('speech', 0,   1000),
      prepSeg('music',  1000, 120),
    ]
    const sermon = prep.findSermonSegment(segs, 1120)
    const reasons = prep.deriveAttentionReasons(segs, sermon, 1120)
    expect(reasons).toContain(prep.ATTENTION_REASONS.speechAtStart)
  })

  it('flags "low confidence" when the detected sermon has poor confidence', () => {
    const segs: PrepAnalysisSegment[] = [
      prepSeg('music',  0,   300),
      prepSeg('speech', 300, 600, 0.4),  // long but poor confidence
    ]
    const sermon = prep.findSermonSegment(segs, 900)
    const reasons = prep.deriveAttentionReasons(segs, sermon, 900)
    expect(reasons).toContain(prep.ATTENTION_REASONS.lowConfidence)
  })

  it('flags "mid-silence" when long silence runs through the middle', () => {
    const segs: PrepAnalysisSegment[] = [
      prepSeg('music',   0,   180),
      prepSeg('speech',  180, 200, 0.9),
      prepSeg('silence', 380, 180), // 3 min of silence in the middle
      prepSeg('speech',  560, 600, 0.9),
      prepSeg('music',   1160, 60),
    ]
    const sermon = prep.findSermonSegment(segs, 1220)
    const reasons = prep.deriveAttentionReasons(segs, sermon, 1220)
    expect(reasons).toContain(prep.ATTENTION_REASONS.midSilence)
  })

  it('flags "mostly music" when music dominates the recording', () => {
    const segs: PrepAnalysisSegment[] = [
      prepSeg('music',  0,   1500),
      prepSeg('speech', 1500, 200),
      prepSeg('music',  1700, 1000),
    ]
    const sermon = prep.findSermonSegment(segs, 2700)
    const reasons = prep.deriveAttentionReasons(segs, sermon, 2700)
    expect(reasons).toContain(prep.ATTENTION_REASONS.mostlyMusic)
  })

  it('flags "very short" when total duration is under 8 min', () => {
    const segs: PrepAnalysisSegment[] = [
      prepSeg('speech', 0,   400),
    ]
    const sermon = prep.findSermonSegment(segs, 400)
    const reasons = prep.deriveAttentionReasons(segs, sermon, 400)
    expect(reasons).toContain(prep.ATTENTION_REASONS.veryShort)
  })
})

// ── buildEpisodePrep ──────────────────────────────────────────────────────

describe('buildEpisodePrep', () => {
  it('produces status "ready" for a clean recording', async () => {
    const mock = async (_: string): Promise<AnalysisSegment[]> => [
      seg('music',  0,    300),
      seg('speech', 300,  1500, 0.85),
      seg('music',  1800, 120),
    ]
    const result = await prep.buildEpisodePrep('/tmp/foo.mp3', mock)
    expect(result.status).toBe('ready')
    expect(result.attentionReasons).toBeUndefined()
    expect(result.suggestedTrim).toEqual({ startSec: 300, endSec: 1800 })
    expect(result.masterPreset).toBe('speech-clear')
  })

  it('produces status "needs-attention" when sermon detection fails', async () => {
    const mock = async (_: string): Promise<AnalysisSegment[]> => [
      seg('music', 0, 300),
      seg('speech', 300, 60),
    ]
    const result = await prep.buildEpisodePrep('/tmp/foo.mp3', mock)
    expect(result.status).toBe('needs-attention')
    expect(result.attentionReasons).toBeDefined()
    expect(result.attentionReasons!.length).toBeGreaterThan(0)
  })

  it('still returns a prep when analyze fails', async () => {
    const mock = async (_: string): Promise<AnalysisSegment[]> => {
      throw new Error('ffmpeg not found')
    }
    const result = await prep.buildEpisodePrep('/tmp/foo.mp3', mock)
    expect(result.id).toBeDefined()
    expect(result.recordingPath).toBe('/tmp/foo.mp3')
    expect(result.status).toBe('needs-attention') // empty analysis = no sermon = attention
  })

  it('respects settings.podcast.defaultMasterPreset', async () => {
    store.set('podcast', {
      enabled: true,
      service: 'google-drive',
      title: 't',
      author: 'a',
      description: 'd',
      language: 'no',
      category: 'r',
      explicit: false,
      defaultMasterPreset: 'speech-punchy',
    } as never)
    const mock = async (_: string): Promise<AnalysisSegment[]> => [
      seg('music',  0,    300),
      seg('speech', 300,  1500, 0.9),
    ]
    const result = await prep.buildEpisodePrep('/tmp/foo.mp3', mock)
    expect(result.masterPreset).toBe('speech-punchy')
  })

  it('uses default jingles from settings.podcast when set', async () => {
    store.set('podcast', {
      enabled: true,
      service: 'google-drive',
      title: 't', author: 'a', description: 'd', language: 'no',
      category: 'r', explicit: false,
      defaultIntroPath: '/sounds/intro.mp3',
      defaultOutroPath: '/sounds/outro.mp3',
    } as never)
    const mock = async (_: string): Promise<AnalysisSegment[]> => [
      seg('music',  0,    300),
      seg('speech', 300,  1500, 0.9),
    ]
    const result = await prep.buildEpisodePrep('/tmp/foo.mp3', mock)
    expect(result.introPath).toBe('/sounds/intro.mp3')
    expect(result.outroPath).toBe('/sounds/outro.mp3')
  })

  it('falls back to editorIntroPath/editorOutroPath when no per-church default', async () => {
    store.set('editorIntroPath', '/editor/intro.mp3' as never)
    store.set('editorOutroPath', '/editor/outro.mp3' as never)
    const mock = async (_: string): Promise<AnalysisSegment[]> => [
      seg('music',  0,    300),
      seg('speech', 300,  1500, 0.9),
    ]
    const result = await prep.buildEpisodePrep('/tmp/foo.mp3', mock)
    expect(result.introPath).toBe('/editor/intro.mp3')
    expect(result.outroPath).toBe('/editor/outro.mp3')
  })

  it('stamps a unique id, createdAt, updatedAt, timestamp', async () => {
    const mock = async (_: string): Promise<AnalysisSegment[]> => []
    const r1 = await prep.buildEpisodePrep('/tmp/a.mp3', mock)
    const r2 = await prep.buildEpisodePrep('/tmp/b.mp3', mock)
    expect(r1.id).not.toBe(r2.id)
    expect(typeof r1.createdAt).toBe('number')
    expect(typeof r1.updatedAt).toBe('number')
    expect(typeof r1.timestamp).toBe('number')
  })

  it('handles empty segment array gracefully', async () => {
    const mock = async (_: string): Promise<AnalysisSegment[]> => []
    const result = await prep.buildEpisodePrep('/tmp/foo.mp3', mock)
    expect(result.suggestedTrim).toBeUndefined()
    expect(result.sermonConfidence).toBeUndefined()
  })

  it('handles all-silence recording', async () => {
    const mock = async (_: string): Promise<AnalysisSegment[]> => [
      seg('silence', 0, 600),
    ]
    const result = await prep.buildEpisodePrep('/tmp/foo.mp3', mock)
    expect(result.status).toBe('needs-attention')
    expect(result.suggestedTrim).toBeUndefined()
  })

  it('handles all-music recording (concert detection)', async () => {
    const mock = async (_: string): Promise<AnalysisSegment[]> => [
      seg('music', 0, 3000),
    ]
    const result = await prep.buildEpisodePrep('/tmp/foo.mp3', mock)
    expect(result.status).toBe('needs-attention')
    expect(result.attentionReasons).toContain(prep.ATTENTION_REASONS.mostlyMusic)
  })

  it('carries sermon confidence through to the EpisodePrep', async () => {
    const mock = async (_: string): Promise<AnalysisSegment[]> => [
      seg('music',  0,    300),
      seg('speech', 300,  1500, 0.75),
    ]
    const result = await prep.buildEpisodePrep('/tmp/foo.mp3', mock)
    expect(result.sermonConfidence).toBe(0.75)
  })
})

// ── Constants exposed for the editor UI ──────────────────────────────────

describe('constants', () => {
  it('exposes ATTENTION_CONFIDENCE_THRESHOLD', () => {
    expect(prep.ATTENTION_CONFIDENCE_THRESHOLD).toBeGreaterThan(0)
    expect(prep.ATTENTION_CONFIDENCE_THRESHOLD).toBeLessThanOrEqual(1)
  })

  it('exposes Norwegian ATTENTION_REASONS for UI use', () => {
    expect(typeof prep.ATTENTION_REASONS.noSermonBlock).toBe('string')
    expect(prep.ATTENTION_REASONS.noSermonBlock).toContain('preken')
  })
})
