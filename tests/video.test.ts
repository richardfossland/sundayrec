/**
 * Tests for pure video-related parsing and argument-building functions.
 *
 * These are string-in / array-out or string-in / string-out functions with
 * no side effects. No subprocess mocking required.
 *
 * The most critical test here is buildVideoFilterComplex: the bug that made
 * video recording silently fail was using two separate -vf filters on a
 * multi-output ffmpeg command instead of -filter_complex with split=2.
 */

jest.mock('ffmpeg-static', () => '/usr/bin/ffmpeg')

import {
  parseVideoDshowDeviceList,
  parseVideoAvfoundationDeviceList,
  findBestVideoDeviceMatch,
} from '../src/main/native-recorder'

import {
  classifyVideoError,
  resolutionToDimensions,
  autoBitrate,
  buildVideoFilterComplex,
} from '../src/main/video-recorder'

// ─── parseVideoDshowDeviceList ────────────────────────────────────────────────
//
// DirectShow ffmpeg output lists VIDEO devices first, then AUDIO devices.
// We only want video devices (cameras, capture cards) — not microphones.

describe('parseVideoDshowDeviceList', () => {
  const DSHOW_SAMPLE = [
    '[dshow @ 0x00000001] DirectShow video devices (some may be both video and audio devices)',
    '[dshow @ 0x00000001]  "OBS Virtual Camera"',
    '[dshow @ 0x00000001]     Alternative name "@device_sw_{860BB310-5D01-11D0-BD3B-00A0C911CE86}..."',
    '[dshow @ 0x00000001]  "Elgato Cam Link 4K"',
    '[dshow @ 0x00000001]     Alternative name "@device_pnp_{...}"',
    '[dshow @ 0x00000001] DirectShow audio devices',
    '[dshow @ 0x00000001]  "Microphone (USB Audio CODEC)"',
    '[dshow @ 0x00000001]  "Soundcraft USB Audio"',
  ].join('\n')

  it('parses video device names', () => {
    const devices = parseVideoDshowDeviceList(DSHOW_SAMPLE)
    const names = devices.map(d => d.name)
    expect(names).toContain('OBS Virtual Camera')
    expect(names).toContain('Elgato Cam Link 4K')
  })

  it('does NOT include audio devices (stops at DirectShow audio devices section)', () => {
    const devices = parseVideoDshowDeviceList(DSHOW_SAMPLE)
    const names = devices.map(d => d.name)
    expect(names).not.toContain('Microphone (USB Audio CODEC)')
    expect(names).not.toContain('Soundcraft USB Audio')
  })

  it('skips Alternative name lines', () => {
    const devices = parseVideoDshowDeviceList(DSHOW_SAMPLE)
    expect(devices.every(d => !d.name.startsWith('@'))).toBe(true)
  })

  it('assigns sequential indices', () => {
    const devices = parseVideoDshowDeviceList(DSHOW_SAMPLE)
    expect(devices.map(d => d.index)).toEqual([0, 1])
  })

  it('deduplicates identical device names', () => {
    const stderr = [
      '[dshow @ 0x1]  "USB Camera"',
      '[dshow @ 0x1]  "USB Camera"',
    ].join('\n')
    expect(parseVideoDshowDeviceList(stderr).length).toBe(1)
  })

  it('returns empty for empty input', () => {
    expect(parseVideoDshowDeviceList('')).toEqual([])
  })
})

// ─── parseVideoAvfoundationDeviceList ─────────────────────────────────────────
//
// AVFoundation ffmpeg output lists VIDEO devices then AUDIO devices.
// Crucially: video and audio both use [0], [1], ... indices independently.
// Mixing them would map wrong indices to devices.

describe('parseVideoAvfoundationDeviceList', () => {
  const AVF_SAMPLE = [
    '[AVFoundation indev @ 0x600003d08b00] AVFoundation video devices:',
    '[AVFoundation indev @ 0x600003d08b00] [0] FaceTime HD Camera',
    '[AVFoundation indev @ 0x600003d08b00] [1] Elgato Cam Link 4K',
    '[AVFoundation indev @ 0x600003d08b00] [2] OBS Virtual Camera',
    '[AVFoundation indev @ 0x600003d08b00] AVFoundation audio devices:',
    '[AVFoundation indev @ 0x600003d08b00] [0] MacBook Pro Microphone',
    '[AVFoundation indev @ 0x600003d08b00] [1] USB Audio CODEC',
  ].join('\n')

  it('returns only video devices', () => {
    const devices = parseVideoAvfoundationDeviceList(AVF_SAMPLE)
    const names = devices.map(d => d.name)
    expect(names).toContain('FaceTime HD Camera')
    expect(names).toContain('Elgato Cam Link 4K')
    expect(names).toContain('OBS Virtual Camera')
  })

  it('does NOT include audio devices', () => {
    const devices = parseVideoAvfoundationDeviceList(AVF_SAMPLE)
    const names = devices.map(d => d.name)
    expect(names).not.toContain('MacBook Pro Microphone')
    expect(names).not.toContain('USB Audio CODEC')
  })

  it('preserves the AVFoundation video index (not audio index)', () => {
    const devices = parseVideoAvfoundationDeviceList(AVF_SAMPLE)
    expect(devices[0]).toEqual({ name: 'FaceTime HD Camera', index: 0 })
    expect(devices[1]).toEqual({ name: 'Elgato Cam Link 4K', index: 1 })
    expect(devices[2]).toEqual({ name: 'OBS Virtual Camera', index: 2 })
  })

  it('returns empty when no video section in output', () => {
    const stderr = [
      '[AVFoundation indev @ 0x1] AVFoundation audio devices:',
      '[AVFoundation indev @ 0x1] [0] Microphone',
    ].join('\n')
    expect(parseVideoAvfoundationDeviceList(stderr)).toEqual([])
  })

  it('returns empty for empty input', () => {
    expect(parseVideoAvfoundationDeviceList('')).toEqual([])
  })
})

// ─── findBestVideoDeviceMatch ─────────────────────────────────────────────────

describe('findBestVideoDeviceMatch', () => {
  const DEVICES = [
    { name: 'FaceTime HD Camera',  index: 0 },
    { name: 'Elgato Cam Link 4K',  index: 1 },
    { name: 'OBS Virtual Camera',  index: 2 },
  ]

  it('returns first device when name is empty', () => {
    expect(findBestVideoDeviceMatch(DEVICES, '')).toBe(DEVICES[0])
  })

  it('exact match (case-insensitive)', () => {
    expect(findBestVideoDeviceMatch(DEVICES, 'elgato cam link 4k')).toBe(DEVICES[1])
    expect(findBestVideoDeviceMatch(DEVICES, 'OBS Virtual Camera')).toBe(DEVICES[2])
  })

  it('substring match — stored name shorter than device name', () => {
    expect(findBestVideoDeviceMatch(DEVICES, 'FaceTime')).toBe(DEVICES[0])
  })

  it('reverse substring — device name is part of stored name', () => {
    const extended = [{ name: 'Cam Link', index: 0 }]
    expect(findBestVideoDeviceMatch(extended, 'Elgato Cam Link 4K')).toBe(extended[0])
  })

  it('word-overlap match — handles name variations', () => {
    // "FaceTime HD Camera (Built-in)" vs "FaceTime HD Camera" shares facetime+camera
    const result = findBestVideoDeviceMatch(DEVICES, 'FaceTime HD Camera (Built-in)')
    expect(result).toBe(DEVICES[0])
  })

  it('returns undefined when no device matches', () => {
    expect(findBestVideoDeviceMatch(DEVICES, 'Sony A7 IV')).toBeUndefined()
  })

  it('returns undefined for empty device list', () => {
    expect(findBestVideoDeviceMatch([], 'FaceTime')).toBeUndefined()
  })
})

// ─── classifyVideoError ───────────────────────────────────────────────────────

describe('classifyVideoError', () => {
  it('classifies device-not-found errors', () => {
    const cases = [
      'Device not found',
      'no such file or directory',
      'no video device',
      'no capture device',
      'failed to find video device',
      'The handle is invalid',
    ]
    for (const msg of cases) {
      expect(classifyVideoError(msg)).toBe('device_not_found')
    }
  })

  it('classifies permission errors', () => {
    const cases = [
      'camera access denied',
      'permission denied',
      'not permitted to access camera',
      'E_ACCESSDENIED',
    ]
    for (const msg of cases) {
      expect(classifyVideoError(msg)).toBe('device_permission_denied')
    }
  })

  it('classifies device-busy errors', () => {
    expect(classifyVideoError('device is already in use by another application')).toBe('device_busy')
    expect(classifyVideoError('resource busy')).toBe('device_busy')
  })

  it('classifies disk-full errors', () => {
    expect(classifyVideoError('No space left on device')).toBe('disk_full')
    expect(classifyVideoError('disk full')).toBe('disk_full')
  })

  it('classifies device-disconnected errors', () => {
    expect(classifyVideoError('Broken pipe')).toBe('device_disconnected')
    expect(classifyVideoError('I/O error')).toBe('device_disconnected')
    expect(classifyVideoError('EOF')).toBe('device_disconnected')
  })

  it('falls back to device_error', () => {
    expect(classifyVideoError('unknown video failure')).toBe('device_error')
    expect(classifyVideoError('')).toBe('device_error')
  })

  it('is case-insensitive', () => {
    expect(classifyVideoError('DEVICE NOT FOUND')).toBe('device_not_found')
    expect(classifyVideoError('CAMERA ACCESS DENIED')).toBe('device_permission_denied')
  })
})

// ─── resolutionToDimensions ───────────────────────────────────────────────────

describe('resolutionToDimensions', () => {
  it('maps 1080p → 1920x1080', () => {
    expect(resolutionToDimensions('1080p')).toBe('1920x1080')
  })

  it('maps 480p → 854x480', () => {
    expect(resolutionToDimensions('480p')).toBe('854x480')
  })

  it('defaults to 720p (1280x720) for unknown/missing value', () => {
    expect(resolutionToDimensions('720p')).toBe('1280x720')
    expect(resolutionToDimensions(undefined)).toBe('1280x720')
    expect(resolutionToDimensions('')).toBe('1280x720')
    expect(resolutionToDimensions('4k')).toBe('1280x720')
  })
})

// ─── autoBitrate ──────────────────────────────────────────────────────────────

describe('autoBitrate', () => {
  it('returns 8000 for 1080p', () => {
    expect(autoBitrate('1080p')).toBe(8000)
  })

  it('returns 1500 for 480p', () => {
    expect(autoBitrate('480p')).toBe(1500)
  })

  it('defaults to 4000 for unknown/missing', () => {
    expect(autoBitrate('720p')).toBe(4000)
    expect(autoBitrate(undefined)).toBe(4000)
  })
})

// ─── buildVideoFilterComplex ──────────────────────────────────────────────────
//
// This is the most critical test. The original bug: two separate -vf filters
// on a multi-output command caused ffmpeg to fail silently.
// The fix: -filter_complex with split=2 to share one input stream to two outputs.
//
// If someone changes this formula back to individual -vf flags, these tests catch it.

describe('buildVideoFilterComplex', () => {
  it('uses split=2 to route one input to two output streams', () => {
    const fc = buildVideoFilterComplex('1280', '720')
    // split=2 is mandatory for multi-output with different filter chains
    expect(fc).toContain('split=2')
  })

  it('names the split outputs [v1] and [v2]', () => {
    const fc = buildVideoFilterComplex('1280', '720')
    expect(fc).toContain('[v1][v2]')
  })

  it('routes [v1] to the recording output [vout] with lanczos scaling', () => {
    const fc = buildVideoFilterComplex('1280', '720')
    expect(fc).toContain('[v1]')
    expect(fc).toContain('[vout]')
    expect(fc).toContain('lanczos')
    expect(fc).toContain('format=yuv420p')
  })

  it('routes [v2] to the preview output [prev] at 5 fps', () => {
    const fc = buildVideoFilterComplex('1280', '720')
    expect(fc).toContain('[v2]')
    expect(fc).toContain('[prev]')
    expect(fc).toContain('fps=5')
  })

  it('preview uses 640:-2 scale (preserves aspect ratio, no black bars)', () => {
    const fc = buildVideoFilterComplex('1280', '720')
    // -2 means "choose value that maintains AR and is divisible by 2"
    expect(fc).toContain('640:-2')
  })

  it('recording output uses the specified dimensions', () => {
    expect(buildVideoFilterComplex('1920', '1080')).toContain('scale=1920:1080')
    expect(buildVideoFilterComplex('854', '480')).toContain('scale=854:480')
    expect(buildVideoFilterComplex('1280', '720')).toContain('scale=1280:720')
  })

  it('produces a single semicolon-separated filter graph (not two -vf flags)', () => {
    const fc = buildVideoFilterComplex('1280', '720')
    // A valid filter_complex value has semicolons between chains
    expect(fc).toContain(';')
    // Must NOT look like two separate -vf values (which would be a regression)
    expect(fc).not.toMatch(/^scale=/)
  })
})
