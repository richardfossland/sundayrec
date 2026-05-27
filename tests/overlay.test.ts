/**
 * Tests for src/main/overlay.ts — buildOverlayPipeline. Focuses on filter
 * graph construction and input-arg sequencing because we cannot spawn ffmpeg
 * in unit tests (no devices, no display).
 */

jest.mock('electron')

import { buildOverlayPipeline } from '../src/main/overlay'
import type { OverlayConfig } from '../src/types'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

const BASE_OPTS = {
  outputW:   1280,
  outputH:   720,
  baseLabel: '0:v',
  framerate: 30,
} as const

function makeOverlay(p: Partial<OverlayConfig>): OverlayConfig {
  return {
    id:       'ov-1',
    name:     'Test',
    enabled:  true,
    type:     'image',
    source:   '',
    position: 'br',
    scale:    0.25,
    opacity:  1.0,
    chromaKey: null,
    ...p,
  }
}

// Helper: write a real file so the image-existence check passes.
let TMP_DIR = ''
let TMP_IMG = ''
beforeAll(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'overlay-test-'))
  TMP_IMG = path.join(TMP_DIR, 'logo.png')
  writeFileSync(TMP_IMG, Buffer.from('not-a-real-png'))
})

describe('buildOverlayPipeline — no overlays', () => {
  it('returns empty pipeline when overlays is empty', () => {
    const r = buildOverlayPipeline([], BASE_OPTS)
    expect(r.inputArgs).toEqual([])
    expect(r.filterChain).toBe('')
    expect(r.outputLabel).toBe('0:v')
    expect(r.extraInputCount).toBe(0)
  })

  it('ignores disabled overlays', () => {
    const r = buildOverlayPipeline(
      [makeOverlay({ source: TMP_IMG, enabled: false })],
      BASE_OPTS,
    )
    expect(r.extraInputCount).toBe(0)
    expect(r.outputLabel).toBe('0:v')
  })

  it('skips NDI overlays (not implemented in v1)', () => {
    const r = buildOverlayPipeline(
      [makeOverlay({ source: 'CAMERA-1', type: 'ndi', enabled: true })],
      BASE_OPTS,
    )
    expect(r.extraInputCount).toBe(0)
    expect(r.outputLabel).toBe('0:v')
  })
})

describe('buildOverlayPipeline — image overlay', () => {
  it('produces -loop 1 input args for static image', () => {
    const r = buildOverlayPipeline([makeOverlay({ source: TMP_IMG })], BASE_OPTS)
    expect(r.inputArgs.slice(0, 4)).toEqual(['-loop', '1', '-framerate', '30'])
    expect(r.inputArgs.at(-2)).toBe('-i')
    expect(r.inputArgs.at(-1)).toBe(TMP_IMG)
    expect(r.extraInputCount).toBe(1)
  })

  it('produces compose chain that ends with composed label', () => {
    const r = buildOverlayPipeline([makeOverlay({ source: TMP_IMG })], BASE_OPTS)
    expect(r.outputLabel).toBe('vov0')
    expect(r.filterChain).toContain('[0:v]')
    expect(r.filterChain).toContain('[vov0]')
  })

  it('uses bottom-right by default with margin', () => {
    const r = buildOverlayPipeline([makeOverlay({ source: TMP_IMG, position: 'br' })], BASE_OPTS)
    // Margin = round(720 * 0.03) = 22 (or 21 depending on rounding) — we just
    // verify the H-h pattern is used, not the exact number.
    expect(r.filterChain).toMatch(/overlay=W-w-\d+:H-h-\d+/)
  })

  it('fullscreen scales overlay to output dimensions', () => {
    const r = buildOverlayPipeline(
      [makeOverlay({ source: TMP_IMG, position: 'fullscreen' })],
      BASE_OPTS,
    )
    expect(r.filterChain).toContain('scale=1280:720')
    expect(r.filterChain).toMatch(/overlay=0:0/)
  })

  it('custom position resolves to W*x:H*y', () => {
    const r = buildOverlayPipeline(
      [makeOverlay({ source: TMP_IMG, position: 'custom', customX: 0.2, customY: 0.7 })],
      BASE_OPTS,
    )
    expect(r.filterChain).toMatch(/overlay=W\*0\.2:H\*0\.7/)
  })

  it('throws clear error when image source does not exist', () => {
    expect(() =>
      buildOverlayPipeline([makeOverlay({ source: '/tmp/does-not-exist.png' })], BASE_OPTS),
    ).toThrow(/overlay-image-not-found/)
  })
})

describe('buildOverlayPipeline — multiple overlays', () => {
  it('chains overlays so each composes on top of the previous', () => {
    const r = buildOverlayPipeline(
      [
        makeOverlay({ id: 'a', source: TMP_IMG, position: 'tl' }),
        makeOverlay({ id: 'b', source: TMP_IMG, position: 'br' }),
      ],
      BASE_OPTS,
    )
    expect(r.extraInputCount).toBe(2)
    expect(r.outputLabel).toBe('vov1')
    // First overlay: [0:v][ov1]...[vov0], second: [vov0][ov2]...[vov1]
    expect(r.filterChain).toMatch(/\[0:v\]\[ov1\]overlay=[^[]+\[vov0\]/)
    expect(r.filterChain).toMatch(/\[vov0\]\[ov2\]overlay=[^[]+\[vov1\]/)
  })

  it('assigns sequential input indices starting at 1', () => {
    const r = buildOverlayPipeline(
      [
        makeOverlay({ id: 'a', source: TMP_IMG }),
        makeOverlay({ id: 'b', source: TMP_IMG }),
        makeOverlay({ id: 'c', source: TMP_IMG }),
      ],
      BASE_OPTS,
    )
    // 3 inputs × 6 args each (-loop 1 -framerate 30 -i <path>)
    expect(r.inputArgs.length).toBe(3 * 6)
    expect(r.extraInputCount).toBe(3)
  })
})

describe('buildOverlayPipeline — chroma key & opacity', () => {
  it('inserts chromakey filter when configured', () => {
    const r = buildOverlayPipeline(
      [makeOverlay({
        source: TMP_IMG,
        chromaKey: { color: '#00FF00', similarity: 0.12, blend: 0.08 },
      })],
      BASE_OPTS,
    )
    expect(r.filterChain).toContain('chromakey=0x00FF00:0.12:0.08')
  })

  it('normalises non-prefixed hex to 0xRRGGBB', () => {
    const r = buildOverlayPipeline(
      [makeOverlay({
        source: TMP_IMG,
        chromaKey: { color: 'AABBCC', similarity: 0.1, blend: 0.1 },
      })],
      BASE_OPTS,
    )
    expect(r.filterChain).toContain('chromakey=0xAABBCC:0.1:0.1')
  })

  it('falls back to black on malformed colour', () => {
    const r = buildOverlayPipeline(
      [makeOverlay({
        source: TMP_IMG,
        chromaKey: { color: 'not-a-color', similarity: 0.1, blend: 0.1 },
      })],
      BASE_OPTS,
    )
    expect(r.filterChain).toContain('chromakey=0x000000')
  })

  it('applies opacity via colorchannelmixer when < 1', () => {
    const r = buildOverlayPipeline(
      [makeOverlay({ source: TMP_IMG, opacity: 0.5 })],
      BASE_OPTS,
    )
    expect(r.filterChain).toContain('colorchannelmixer=aa=0.5')
  })

  it('omits opacity mixer when fully opaque', () => {
    const r = buildOverlayPipeline(
      [makeOverlay({ source: TMP_IMG, opacity: 1.0 })],
      BASE_OPTS,
    )
    expect(r.filterChain).not.toContain('colorchannelmixer')
  })

  it('clamps opacity > 1 and < 0', () => {
    const high = buildOverlayPipeline(
      [makeOverlay({ source: TMP_IMG, opacity: 99 })],
      BASE_OPTS,
    )
    // 99 → clamped to 1 → no mixer
    expect(high.filterChain).not.toContain('colorchannelmixer')

    const low = buildOverlayPipeline(
      [makeOverlay({ source: TMP_IMG, opacity: -0.5 })],
      BASE_OPTS,
    )
    // -0.5 → clamped to 0 → mixer with aa=0
    expect(low.filterChain).toContain('colorchannelmixer=aa=0')
  })
})

describe('buildOverlayPipeline — crop', () => {
  it('inserts crop filter with iw/ih multipliers', () => {
    const r = buildOverlayPipeline(
      [makeOverlay({
        source: TMP_IMG,
        crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 },
      })],
      BASE_OPTS,
    )
    expect(r.filterChain).toContain('crop=iw*0.5:ih*0.6:iw*0.1:ih*0.2')
  })

  it('skips crop when bounds invalid (negative)', () => {
    const r = buildOverlayPipeline(
      [makeOverlay({
        source: TMP_IMG,
        crop: { x: -0.1, y: 0, w: 0.5, h: 0.6 },
      })],
      BASE_OPTS,
    )
    expect(r.filterChain).not.toContain('crop=')
  })

  it('skips crop when bounds exceed source (x+w>1)', () => {
    const r = buildOverlayPipeline(
      [makeOverlay({
        source: TMP_IMG,
        crop: { x: 0.5, y: 0, w: 0.8, h: 0.5 },
      })],
      BASE_OPTS,
    )
    expect(r.filterChain).not.toContain('crop=')
  })
})

describe('buildOverlayPipeline — screen capture', () => {
  it('mac uses avfoundation with screen index', () => {
    const r = buildOverlayPipeline(
      [makeOverlay({ type: 'screen', source: '1' })],
      { ...BASE_OPTS, platform: 'darwin' },
    )
    expect(r.inputArgs).toContain('-f')
    expect(r.inputArgs).toContain('avfoundation')
    expect(r.inputArgs.at(-1)).toBe('1:none')
  })

  it('windows uses gdigrab desktop', () => {
    const r = buildOverlayPipeline(
      [makeOverlay({ type: 'screen', source: 'desktop' })],
      { ...BASE_OPTS, platform: 'win32' },
    )
    expect(r.inputArgs).toContain('gdigrab')
    expect(r.inputArgs.at(-1)).toBe('desktop')
  })

  it('windows accepts title=<NAME> for window capture', () => {
    const r = buildOverlayPipeline(
      [makeOverlay({ type: 'window', source: 'title=EasyWorship' })],
      { ...BASE_OPTS, platform: 'win32' },
    )
    expect(r.inputArgs.at(-1)).toBe('title=EasyWorship')
  })

  it('throws on bad mac screen id', () => {
    expect(() =>
      buildOverlayPipeline(
        [makeOverlay({ type: 'screen', source: 'not-a-number' })],
        { ...BASE_OPTS, platform: 'darwin' },
      ),
    ).toThrow(/overlay-bad-screen-id/)
  })
})

describe('buildOverlayPipeline — scale', () => {
  it('non-fullscreen uses even-rounded width with auto height', () => {
    const r = buildOverlayPipeline(
      [makeOverlay({ source: TMP_IMG, scale: 0.5 })],
      BASE_OPTS,
    )
    // 1280 * 0.5 = 640
    expect(r.filterChain).toContain('scale=640:-2')
  })

  it('clamps scale to [0, 1]', () => {
    const r = buildOverlayPipeline(
      [makeOverlay({ source: TMP_IMG, scale: 5 })],
      BASE_OPTS,
    )
    expect(r.filterChain).toContain('scale=1280:-2')
  })
})

describe('buildOverlayPipeline — overlay eof_action', () => {
  it('uses eof_action=pass so a finite stream does not truncate camera', () => {
    const r = buildOverlayPipeline([makeOverlay({ source: TMP_IMG })], BASE_OPTS)
    expect(r.filterChain).toContain('eof_action=pass')
    expect(r.filterChain).toContain('repeatlast=1')
  })
})
