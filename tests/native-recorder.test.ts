/**
 * Tests for pure parsing/matching functions in native-recorder.
 *
 * These are string-in / array-out or string-in / string-out functions with no
 * side effects. No mocking of child_process is needed because we never spawn
 * anything here — the async spawn wrappers are tested by actually running the
 * app on real hardware. What we CAN test here is all the logic that breaks
 * silently when ffmpeg changes its output format.
 */

jest.mock('ffmpeg-static', () => '/usr/bin/ffmpeg')

import {
  parseWasapiDeviceList,
  parseDshowDeviceList,
  parseAvfoundationDeviceList,
  findBestDeviceMatch,
  classifyFfmpegError,
  buildCodecArgs,
} from '../src/main/native-recorder'

// ─── parseWasapiDeviceList ────────────────────────────────────────────────────
//
// Real ffmpeg WASAPI output samples. ffmpeg prints device names to stderr in
// one of three formats depending on version and Windows build. The regex must
// handle all of them or device enumeration silently returns empty and
// audio recording fails without a useful error.

describe('parseWasapiDeviceList', () => {
  // ffmpeg 5.x (bundled via ffmpeg-static 5.3) on modern Windows
  it('parses ffmpeg-5 format: "WASAPI input device #N : \'Name\'"', () => {
    const stderr = [
      "[wasapi @ 000002a1] WASAPI input device #0 : 'Microphone (USB Audio CODEC)'",
      "[wasapi @ 000002a1] WASAPI input device #1 : 'Soundcraft USB Audio'",
      "[wasapi @ 000002a1] WASAPI output device #0 : 'Speakers (Realtek HD Audio)'",
    ].join('\n')
    const devices = parseWasapiDeviceList(stderr)
    // Output devices should also be included (we want all endpoints)
    expect(devices.length).toBe(3)
    expect(devices[0].name).toBe('Microphone (USB Audio CODEC)')
    expect(devices[1].name).toBe('Soundcraft USB Audio')
    expect(devices[2].name).toBe('Speakers (Realtek HD Audio)')
  })

  // Older ffmpeg builds (3.x/4.x) used capital Device without #
  it('parses older format: "Device N: \'Name\'"', () => {
    const stderr = [
      "[wasapi @ 0x2b7e340] Device 0: 'Built-in Microphone'",
      "[wasapi @ 0x2b7e340] Device 1: 'Soundcraft USB Audio'",
    ].join('\n')
    const devices = parseWasapiDeviceList(stderr)
    expect(devices.length).toBe(2)
    expect(devices[0].name).toBe('Built-in Microphone')
    expect(devices[1].name).toBe('Soundcraft USB Audio')
  })

  // Some Windows builds output double quotes instead of single quotes
  it('parses double-quoted variant: Device N: "Name"', () => {
    const stderr = [
      '[wasapi @ 0x000] Device 0: "Microphone Array (Intel Smart Sound)"',
      '[wasapi @ 0x000] Device 1: "Soundcraft USB Audio"',
    ].join('\n')
    const devices = parseWasapiDeviceList(stderr)
    expect(devices.length).toBe(2)
    expect(devices[1].name).toBe('Soundcraft USB Audio')
  })

  // Legacy ffmpeg builds had no device-number prefix at all
  it('parses legacy format: "[wasapi @ addr] \\"Name\\""', () => {
    const stderr = [
      '[wasapi @ 0xabcd1234] "Microphone (Realtek High Definition Audio)"',
      '[wasapi @ 0xabcd1234] "Soundcraft USB Audio"',
    ].join('\n')
    const devices = parseWasapiDeviceList(stderr)
    expect(devices.length).toBe(2)
    expect(devices[1].name).toBe('Soundcraft USB Audio')
  })

  it('parses Soundcraft USB mixer by name in all formats', () => {
    const formats = [
      "[wasapi @ 000002a1] WASAPI input device #0 : 'Soundcraft USB Audio'",
      "[wasapi @ 0x000] Device 0: 'Soundcraft USB Audio'",
      '[wasapi @ 0x000] "Soundcraft USB Audio"',
    ]
    for (const line of formats) {
      const devices = parseWasapiDeviceList(line)
      expect(devices.length).toBe(1)
      expect(devices[0].name).toBe('Soundcraft USB Audio')
    }
  })

  it('excludes @device_ GUID strings', () => {
    const stderr = [
      "[wasapi @ 000002a1] WASAPI input device #0 : 'Microphone'",
      '[wasapi @ 000002a1] @device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{...}',
    ].join('\n')
    const devices = parseWasapiDeviceList(stderr)
    expect(devices.length).toBe(1)
    expect(devices[0].name).toBe('Microphone')
  })

  it('excludes Alternative name lines', () => {
    const stderr = [
      "[wasapi @ 000002a1] WASAPI input device #0 : 'USB Audio CODEC'",
      '[wasapi @ 000002a1] Alternative name "\\\\?\\SWD#MMDEVAPI#..."',
    ].join('\n')
    expect(parseWasapiDeviceList(stderr).length).toBe(1)
  })

  it('deduplicates devices that appear more than once', () => {
    const stderr = [
      "[wasapi @ 000002a1] WASAPI input device #0 : 'USB Audio CODEC'",
      "[wasapi @ 000002a1] WASAPI input device #0 : 'USB Audio CODEC'",
    ].join('\n')
    expect(parseWasapiDeviceList(stderr).length).toBe(1)
  })

  it('returns empty array for empty input', () => {
    expect(parseWasapiDeviceList('')).toEqual([])
  })

  it('assigns sequential index values', () => {
    const stderr = [
      "[wasapi @ 000002a1] WASAPI input device #0 : 'Mic A'",
      "[wasapi @ 000002a1] WASAPI input device #1 : 'Mic B'",
      "[wasapi @ 000002a1] WASAPI input device #2 : 'Mic C'",
    ].join('\n')
    const devices = parseWasapiDeviceList(stderr)
    expect(devices.map(d => d.index)).toEqual([0, 1, 2])
  })
})

// ─── parseDshowDeviceList ─────────────────────────────────────────────────────

describe('parseDshowDeviceList', () => {
  const DSHOW_SAMPLE = [
    '[dshow @ 0x00000001] DirectShow video devices',
    '[dshow @ 0x00000001]  "OBS Virtual Camera"',
    '[dshow @ 0x00000001]     Alternative name "@device_sw_{860BB310-5D01-11D0-BD3B-00A0C911CE86}..."',
    '[dshow @ 0x00000001] DirectShow audio devices',
    '[dshow @ 0x00000001]  "Microphone (USB Audio CODEC)"',
    '[dshow @ 0x00000001]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}..."',
    '[dshow @ 0x00000001]  "Soundcraft USB Audio"',
    '[dshow @ 0x00000001]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}..."',
  ].join('\n')

  it('parses audio device names', () => {
    const devices = parseDshowDeviceList(DSHOW_SAMPLE)
    const names = devices.map(d => d.name)
    expect(names).toContain('Microphone (USB Audio CODEC)')
    expect(names).toContain('Soundcraft USB Audio')
  })

  it('also parses video device names (dshow list is not filtered by type)', () => {
    const devices = parseDshowDeviceList(DSHOW_SAMPLE)
    expect(devices.map(d => d.name)).toContain('OBS Virtual Camera')
  })

  it('skips Alternative name lines', () => {
    const devices = parseDshowDeviceList(DSHOW_SAMPLE)
    expect(devices.every(d => !d.name.startsWith('@'))).toBe(true)
  })

  it('deduplicates identical names', () => {
    const stderr = [
      '[dshow @ 0x1]  "Microphone"',
      '[dshow @ 0x1]  "Microphone"',
    ].join('\n')
    expect(parseDshowDeviceList(stderr).length).toBe(1)
  })

  it('returns empty for empty input', () => {
    expect(parseDshowDeviceList('')).toEqual([])
  })
})

// ─── parseAvfoundationDeviceList ──────────────────────────────────────────────

describe('parseAvfoundationDeviceList', () => {
  const AVF_SAMPLE = [
    '[AVFoundation indev @ 0x600003d08b00] AVFoundation video devices:',
    '[AVFoundation indev @ 0x600003d08b00] [0] FaceTime HD Camera',
    '[AVFoundation indev @ 0x600003d08b00] [1] OBS Virtual Camera',
    '[AVFoundation indev @ 0x600003d08b00] AVFoundation audio devices:',
    '[AVFoundation indev @ 0x600003d08b00] [0] MacBook Pro Microphone',
    '[AVFoundation indev @ 0x600003d08b00] [1] USB Audio CODEC',
    '[AVFoundation indev @ 0x600003d08b00] [2] Soundcraft USB Audio',
  ].join('\n')

  it('returns only audio devices, not video devices', () => {
    const devices = parseAvfoundationDeviceList(AVF_SAMPLE)
    const names = devices.map(d => d.name)
    expect(names).not.toContain('FaceTime HD Camera')
    expect(names).not.toContain('OBS Virtual Camera')
    expect(names).toContain('MacBook Pro Microphone')
    expect(names).toContain('USB Audio CODEC')
    expect(names).toContain('Soundcraft USB Audio')
  })

  it('preserves the index from the AVFoundation output', () => {
    const devices = parseAvfoundationDeviceList(AVF_SAMPLE)
    expect(devices[0].index).toBe(0)
    expect(devices[1].index).toBe(1)
    expect(devices[2].index).toBe(2)
  })

  it('returns empty when no audio section present', () => {
    const stderr = [
      '[AVFoundation indev @ 0x1] AVFoundation video devices:',
      '[AVFoundation indev @ 0x1] [0] FaceTime HD Camera',
    ].join('\n')
    expect(parseAvfoundationDeviceList(stderr)).toEqual([])
  })

  it('returns empty for empty input', () => {
    expect(parseAvfoundationDeviceList('')).toEqual([])
  })
})

// ─── findBestDeviceMatch ──────────────────────────────────────────────────────
//
// This is the core matching algorithm. It uses 5 strategies in priority order:
// exact → substring → reverse-substring → word-overlap → brand-word-extraction.
// Failures here mean the wrong device is used (or no device at all).

describe('findBestDeviceMatch', () => {
  const DEVICES = [
    { name: 'MacBook Pro Microphone', index: 0 },
    { name: 'USB Audio CODEC',        index: 1 },
    { name: 'Soundcraft USB Audio',   index: 2 },
  ]

  it('returns first device when name is empty', () => {
    expect(findBestDeviceMatch(DEVICES, '')).toBe(DEVICES[0])
  })

  it('strategy 1 — exact match (case-insensitive)', () => {
    expect(findBestDeviceMatch(DEVICES, 'soundcraft usb audio')).toBe(DEVICES[2])
    expect(findBestDeviceMatch(DEVICES, 'USB Audio CODEC')).toBe(DEVICES[1])
  })

  it('strategy 2 — stored name is substring of device name', () => {
    // e.g. browser stored "USB Audio" but ffmpeg reports "USB Audio CODEC"
    const result = findBestDeviceMatch(DEVICES, 'USB Audio')
    expect(result).toBe(DEVICES[1])
  })

  it('strategy 3 — device name is substring of stored name', () => {
    // e.g. stored "USB Audio CODEC Device (Extra)", device is "USB Audio CODEC"
    const extended = [{ name: 'USB Audio CODEC', index: 0 }]
    expect(findBestDeviceMatch(extended, 'USB Audio CODEC Device (Extra)')).toBe(extended[0])
  })

  it('strategy 4 — word overlap handles localization', () => {
    // Browser (English) reported "MacBook Pro Microphone", ffmpeg (Norwegian) reports
    // "MacBook Pro-mikrofon". Shared brand words: "macbook" + "pro".
    const norwegian = [
      { name: 'MacBook Pro-mikrofon', index: 0 },
      { name: 'USB-lydenhet',         index: 1 },
    ]
    expect(findBestDeviceMatch(norwegian, 'MacBook Pro Microphone')).toBe(norwegian[0])
  })

  it('strategy 5 — brand word extraction when word-overlap alone fails', () => {
    // Browser stored "Focusrite Scarlett Solo", ffmpeg reports "Focusrite USB Audio".
    // Strategies 1-4 all fail: only "focusrite" is shared (word-overlap needs ≥ 2).
    // Brand extraction strips generic words (usb, audio) and matches on "focusrite".
    const devices = [
      { name: 'USB Audio CODEC',     index: 0 },
      { name: 'Focusrite USB Audio', index: 1 },
    ]
    expect(findBestDeviceMatch(devices, 'Focusrite Scarlett Solo')).toBe(devices[1])
  })

  it('strategy 5 — strips Windows "N- " prefix before brand matching', () => {
    // Windows sometimes prepends "2- " to USB device names in ffmpeg output.
    const devices = [{ name: '2- USB Audio CODEC', index: 0 }]
    // Stored name has no prefix — brand extraction should still match
    expect(findBestDeviceMatch(devices, 'USB Audio CODEC')).toBeTruthy()
  })

  it('returns undefined when no strategy matches', () => {
    expect(findBestDeviceMatch(DEVICES, 'Zoom H6 Recorder')).toBeUndefined()
  })

  it('returns undefined for empty device list', () => {
    expect(findBestDeviceMatch([], 'Soundcraft')).toBeUndefined()
  })

  it('first device is returned for empty list only when name is also empty', () => {
    // findBestDeviceMatch([], '') → devices[0] which is undefined for empty array
    expect(findBestDeviceMatch([], '')).toBeUndefined()
  })
})

// ─── classifyFfmpegError ──────────────────────────────────────────────────────
//
// Determines what user-facing error message to show. Getting this wrong means
// the user sees "unknown error" instead of "device not found" or "permission denied".

describe('classifyFfmpegError', () => {
  it('classifies device-not-found errors', () => {
    const cases = [
      'Device not found: audio=Soundcraft USB Audio',
      'no such audio device',
      'No audio endpoint device could be enumerated',
      'no audio endpoint',
      'AUDCLNT_E_DEVICE_NOT_ACTIVE',
      'Failed to find audio device',
      'The handle is invalid',
      'The system cannot find the file specified',
    ]
    for (const msg of cases) {
      expect(classifyFfmpegError(msg)).toBe('device_not_found')
    }
  })

  it('classifies permission errors', () => {
    const cases = [
      'Access is denied',
      'microphone access denied by privacy settings',
      'AVFoundation: video not enabled',
      'E_ACCESSDENIED opening device',
      'not permitted to access',
    ]
    for (const msg of cases) {
      expect(classifyFfmpegError(msg)).toBe('device_permission_denied')
    }
  })

  it('classifies device-busy errors', () => {
    const cases = [
      'device is already in use by another application',
      'AUDCLNT_E_DEVICE_IN_USE',
      'AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED',
      'resource busy',
    ]
    for (const msg of cases) {
      expect(classifyFfmpegError(msg)).toBe('device_busy')
    }
  })

  it('classifies disk-full errors', () => {
    expect(classifyFfmpegError('No space left on device')).toBe('disk_full')
    expect(classifyFfmpegError('disk full')).toBe('disk_full')
    expect(classifyFfmpegError('ENOSPC')).toBe('disk_full')
  })

  it('classifies device-disconnected errors', () => {
    const cases = [
      'Broken pipe',
      'I/O error writing output',
      'device unplugged',
      'AUDCLNT_E_DEVICE_INVALIDATED',
    ]
    for (const msg of cases) {
      expect(classifyFfmpegError(msg)).toBe('device_disconnected')
    }
  })

  it('falls back to device_error for unrecognised messages', () => {
    expect(classifyFfmpegError('something went completely wrong')).toBe('device_error')
    expect(classifyFfmpegError('')).toBe('device_error')
  })

  it('classification is case-insensitive', () => {
    expect(classifyFfmpegError('DEVICE NOT FOUND')).toBe('device_not_found')
    expect(classifyFfmpegError('access IS DENIED')).toBe('device_permission_denied')
  })
})

// ─── buildCodecArgs ───────────────────────────────────────────────────────────

describe('buildCodecArgs', () => {
  it('mp3 — libmp3lame with bitrate and id3v2', () => {
    const args = buildCodecArgs({ format: 'mp3', bitrate: '192' } as any)
    expect(args).toContain('libmp3lame')
    expect(args).toContain('192k')
    expect(args).toContain('3') // id3v2_version 3
  })

  it('mp3 — strips trailing k from bitrate string', () => {
    const args = buildCodecArgs({ format: 'mp3', bitrate: '320k' } as any)
    expect(args).toContain('320k')
    expect(args).not.toContain('320kk')
  })

  it('flac — no bitrate argument', () => {
    const args = buildCodecArgs({ format: 'flac' } as any)
    expect(args).toContain('flac')
    expect(args).not.toContain('-b:a')
  })

  it('aac — with bitrate', () => {
    const args = buildCodecArgs({ format: 'aac', bitrate: '128' } as any)
    expect(args).toContain('aac')
    expect(args).toContain('128k')
  })

  it('wav — pcm_s16le, no bitrate', () => {
    const args = buildCodecArgs({ format: 'wav' } as any)
    expect(args).toContain('pcm_s16le')
    expect(args).not.toContain('-b:a')
  })

  it('unknown format falls back to mp3', () => {
    const args = buildCodecArgs({ format: 'ogg' as any } as any)
    expect(args).toContain('libmp3lame')
  })
})
