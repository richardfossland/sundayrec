/**
 * Tests for video-preview.ts pure helpers + integration behavior of startPreview.
 *
 * Background: a regression in v4.26.x left the camera preview blank for users
 * with a built-in webcam, because the device's "native" mode produced a 1:1
 * square crop and the retry-with-explicit-size path raced AVFoundation's
 * device-release timing, hanging device enumeration forever. The fixes are:
 *
 *   • Device-aware initial config (capture-card vs webcam)
 *   • SIGTERM + waitForClose handshake before respawning ffmpeg
 *   • Renderer-side CSP smoke test (separately tested in main.ts)
 *
 * These tests lock in those behaviors so a future cleanup doesn't reintroduce
 * the same bugs.
 */

import {
  MAC_CONFIGS,
  buildMacInputArgs,
  classifyVideoDevice,
  pickMacConfigOrder,
  type MacConfig,
} from '../src/main/video-preview'

// ─── classifyVideoDevice ─────────────────────────────────────────────────────

describe('classifyVideoDevice', () => {
  it.each([
    // Capture cards / HDMI inputs
    ['Blackmagic ATEM Mini Pro',          'capture-card'],
    ['Blackmagic Design DeckLink Quad',   'capture-card'],
    ['Elgato Cam Link 4K',                'capture-card'],
    ['Elgato HD60 X',                     'capture-card'],
    ['Magewell USB Capture HDMI Plus',    'capture-card'],
    ['AVerMedia Live Gamer 4K',           'capture-card'],
    ['Inogeni 4K2USB3',                   'capture-card'],
    ['AJA U-TAP HDMI',                    'capture-card'],

    // Built-in webcams
    ['FaceTime HD-kamera',                'builtin-webcam'],
    ['FaceTime HD Camera (Built-in)',     'builtin-webcam'],
    ['iSight',                            'builtin-webcam'],
    ['Studio Display Camera',             'builtin-webcam'],
    ['MacBook Pro Camera',                'builtin-webcam'],

    // Continuity Camera
    ['Richards iPhone Camera',            'continuity-camera'],
    ['iPad-kamera',                       'continuity-camera'],

    // USB webcams
    ['Logitech BRIO',                     'usb-webcam'],
    ['Logitech HD Pro Webcam C920',       'usb-webcam'],
    ['Razer Kiyo Pro',                    'usb-webcam'],
    ['Logitech StreamCam',                'usb-webcam'],
    ['USB Video Device',                  'usb-webcam'],
    ['OBSBOT Tiny 4K',                    'usb-webcam'],

    // Unknown / unmatched
    ['Random Generic Camera',             'unknown'],
    ['',                                  'unknown'],
  ])('classifies "%s" as "%s"', (name, expected) => {
    expect(classifyVideoDevice(name)).toBe(expected)
  })

  it('is case-insensitive', () => {
    expect(classifyVideoDevice('BLACKMAGIC ATEM')).toBe('capture-card')
    expect(classifyVideoDevice('facetime hd')).toBe('builtin-webcam')
  })

  it('handles undefined/null gracefully', () => {
    expect(classifyVideoDevice(undefined as unknown as string)).toBe('unknown')
    expect(classifyVideoDevice(null as unknown as string)).toBe('unknown')
  })
})

// ─── pickMacConfigOrder ──────────────────────────────────────────────────────

describe('pickMacConfigOrder', () => {
  it('puts native config first for capture cards', () => {
    const order = pickMacConfigOrder('Blackmagic ATEM Mini')
    expect(order[0]).toBe(0)  // MAC_CONFIGS[0] is native@30fps
    expect(MAC_CONFIGS[order[0]].size).toBeNull()
  })

  it('puts explicit 720p first for built-in webcams', () => {
    const order = pickMacConfigOrder('FaceTime HD-kamera')
    expect(order[0]).toBe(1)  // MAC_CONFIGS[1] is 720p@30fps
    expect(MAC_CONFIGS[order[0]].size).toBe('1280x720')
  })

  it('puts explicit 720p first for USB webcams', () => {
    const order = pickMacConfigOrder('Logitech BRIO')
    expect(order[0]).toBe(1)
  })

  it('puts explicit 720p first for Continuity Camera', () => {
    const order = pickMacConfigOrder('iPhone-kamera')
    expect(order[0]).toBe(1)
  })

  it('puts explicit 720p first for unknown devices (safe default)', () => {
    const order = pickMacConfigOrder('Some Random Device')
    expect(order[0]).toBe(1)
  })

  it('covers all 6 configs in every order (no missing fallbacks)', () => {
    for (const device of ['Blackmagic ATEM', 'FaceTime HD', 'Logitech', 'Unknown thing']) {
      const order = pickMacConfigOrder(device)
      expect(order.length).toBe(MAC_CONFIGS.length)
      const sorted = [...order].sort((a, b) => a - b)
      expect(sorted).toEqual([0, 1, 2, 3, 4, 5])  // every index covered
    }
  })

  it('never returns duplicates', () => {
    for (const device of ['Blackmagic', 'FaceTime', 'Logitech', '']) {
      const order = pickMacConfigOrder(device)
      expect(new Set(order).size).toBe(order.length)
    }
  })

  it('webcams have native as a late fallback (not removed)', () => {
    // If our heuristic is wrong about a device being a webcam, it should still
    // be able to fall back to native mode (e.g. a capture card mis-named).
    const order = pickMacConfigOrder('FaceTime HD')
    expect(order).toContain(0)  // native@30fps must be in the list
    expect(order.indexOf(0)).toBeGreaterThan(0)  // but NOT first
  })

  it('capture cards have explicit 720p as a late fallback', () => {
    // Same idea — if a capture card doesn't actually support native, we want
    // to be able to try 720p.
    const order = pickMacConfigOrder('Blackmagic ATEM')
    expect(order).toContain(1)
    expect(order.indexOf(1)).toBeGreaterThan(0)
  })
})

// ─── MAC_CONFIGS structure (regression guard) ───────────────────────────────

describe('MAC_CONFIGS', () => {
  it('has the canonical 6 entries in the documented order', () => {
    expect(MAC_CONFIGS.length).toBe(6)
    expect(MAC_CONFIGS[0]).toEqual<MacConfig>({ fps: 30, size: null,        label: 'native@30fps'  })
    expect(MAC_CONFIGS[1]).toEqual<MacConfig>({ fps: 30, size: '1280x720',  label: '720p@30fps'    })
    expect(MAC_CONFIGS[2]).toEqual<MacConfig>({ fps: 30, size: '1920x1080', label: '1080p@30fps'   })
    expect(MAC_CONFIGS[3]).toEqual<MacConfig>({ fps: 25, size: null,        label: 'native@25fps'  })
    expect(MAC_CONFIGS[4]).toEqual<MacConfig>({ fps: 25, size: '1920x1080', label: '1080p@25fps'   })
    expect(MAC_CONFIGS[5]).toEqual<MacConfig>({ fps: 25, size: '1280x720',  label: '720p@25fps'    })
  })

  it('every config has a non-empty label', () => {
    for (const c of MAC_CONFIGS) {
      expect(c.label.length).toBeGreaterThan(0)
    }
  })
})

// ─── buildMacInputArgs ──────────────────────────────────────────────────────

describe('buildMacInputArgs', () => {
  it('omits -video_size for native config', () => {
    const args = buildMacInputArgs('avfoundation', '0', MAC_CONFIGS[0])
    expect(args).toEqual(['-f', 'avfoundation', '-framerate', '30', '-i', '0'])
    expect(args).not.toContain('-video_size')
  })

  it('includes -video_size for sized config', () => {
    const args = buildMacInputArgs('avfoundation', '0', MAC_CONFIGS[1])
    expect(args).toEqual(['-f', 'avfoundation', '-framerate', '30', '-video_size', '1280x720', '-i', '0'])
  })

  it('passes the device string through unchanged (supports DirectShow-style)', () => {
    const args = buildMacInputArgs('dshow', 'video="Logitech BRIO"', MAC_CONFIGS[1])
    expect(args[args.length - 1]).toBe('video="Logitech BRIO"')
    expect(args[args.length - 2]).toBe('-i')
  })

  it('encodes 25-fps PAL configs', () => {
    const args = buildMacInputArgs('avfoundation', '0', MAC_CONFIGS[3])
    expect(args).toContain('25')
    const fpsIdx = args.indexOf('-framerate')
    expect(args[fpsIdx + 1]).toBe('25')
  })
})

// ─── frame-data normalization (renderer-side helper) ────────────────────────

import { normalizeFrameData } from '../src/shared/normalize-frame-data'

describe('normalizeFrameData', () => {
  it('returns the input as-is when already Uint8Array', () => {
    const arr = new Uint8Array([1, 2, 3, 4])
    const result = normalizeFrameData(arr)
    expect(result).toBe(arr)
  })

  it('wraps ArrayBuffer in Uint8Array', () => {
    const ab = new ArrayBuffer(4)
    new Uint8Array(ab).set([5, 6, 7, 8])
    const result = normalizeFrameData(ab)
    expect(result).toBeInstanceOf(Uint8Array)
    expect(Array.from(result!)).toEqual([5, 6, 7, 8])
  })

  it('handles other TypedArray views (e.g. Uint16Array)', () => {
    const u16 = new Uint16Array([0x0201, 0x0403])
    const result = normalizeFrameData(u16)
    expect(result).toBeInstanceOf(Uint8Array)
    // Endianness: 0x0201 little-endian = [01, 02]
    expect(result!.length).toBe(4)
  })

  it('handles Buffer-like objects with numeric indices', () => {
    const fake = { 0: 0xff, 1: 0xd8, 2: 0xff, 3: 0xd9 }
    const result = normalizeFrameData(fake)
    expect(result).not.toBeNull()
    expect(Array.from(result!)).toEqual([0xff, 0xd8, 0xff, 0xd9])
  })

  it('returns null for null/undefined', () => {
    expect(normalizeFrameData(null)).toBeNull()
    expect(normalizeFrameData(undefined)).toBeNull()
  })

  it('returns null for non-buffer-like values', () => {
    expect(normalizeFrameData('hello')).toBeNull()
    expect(normalizeFrameData(42)).toBeNull()
    expect(normalizeFrameData({})).toBeNull()
  })

  it('does not produce an empty Uint8Array for a real JPEG buffer', () => {
    // Smallest valid JPEG signature (SOI + EOI)
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
    const result = normalizeFrameData(jpeg)
    expect(result!.length).toBe(4)
  })
})

// ─── End-to-end startPreview retry logic ────────────────────────────────────
//
// We mock child_process.spawn so we can drive ffmpeg's lifecycle deterministically.
// This locks in the most important defenses: device-aware initial config,
// retry-on-square, and waiting for process death before respawning.

jest.mock('child_process')
jest.mock('../src/main/native-recorder', () => ({
  ffmpegBin: '/mock/ffmpeg',
  resolveVideoInput: jest.fn(),
}))

import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import { resolveVideoInput } from '../src/main/native-recorder'
import { startPreview, stopPreview, getWorkingMacConfigIdx } from '../src/main/video-preview'

const mockSpawn  = spawn as unknown as jest.Mock
const mockResolve = resolveVideoInput as unknown as jest.Mock

interface MockProc extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill:    jest.Mock
  exitCode: number | null
}

function makeMockProc(): MockProc {
  const proc = new EventEmitter() as MockProc
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.exitCode = null
  proc.kill = jest.fn().mockImplementation(() => {
    // Simulate ffmpeg exiting asynchronously after SIGTERM/SIGKILL
    setImmediate(() => {
      proc.exitCode = 0
      proc.emit('close', 0)
      proc.emit('exit', 0)
    })
    return true
  })
  return proc
}

/** Build a minimal JPEG buffer with the requested dimensions in the SOF0 marker. */
function makeJpegWithDims(width: number, height: number): Buffer {
  // SOI + minimal SOF0 (with width/height) + EOI. Not a valid JPEG image but
  // dimensions parser only looks at the SOF marker.
  return Buffer.from([
    0xff, 0xd8,                                              // SOI
    0xff, 0xc0, 0x00, 0x11, 0x08,                            // SOF0 marker + segment length + precision
    (height >> 8) & 0xff, height & 0xff,                     // height (big-endian)
    (width  >> 8) & 0xff, width  & 0xff,                     // width  (big-endian)
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,                                              // EOI
  ])
}

const mockWin = {
  webContents: { send: jest.fn() },
  isDestroyed: jest.fn(() => false),
} as unknown as Electron.BrowserWindow

describe('startPreview — device-aware first attempt', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(async () => {
    await stopPreview()
  })

  it('uses native (no -video_size) for capture cards on first attempt', async () => {
    mockResolve.mockResolvedValue({ format: 'avfoundation', device: '0', resolvedName: 'Blackmagic ATEM Mini' })
    const proc = makeMockProc()
    mockSpawn.mockReturnValue(proc)

    await startPreview({ videoDeviceName: 'Blackmagic ATEM Mini' }, mockWin)

    const args = mockSpawn.mock.calls[0][1] as string[]
    expect(args).not.toContain('-video_size')
    expect(args).toContain('-framerate')
    expect(args[args.indexOf('-framerate') + 1]).toBe('30')
  })

  it('uses -video_size 1280x720 for built-in webcams on first attempt', async () => {
    mockResolve.mockResolvedValue({ format: 'avfoundation', device: '0', resolvedName: 'FaceTime HD-kamera' })
    const proc = makeMockProc()
    mockSpawn.mockReturnValue(proc)

    await startPreview({ videoDeviceName: 'FaceTime HD-kamera' }, mockWin)

    const args = mockSpawn.mock.calls[0][1] as string[]
    expect(args).toContain('-video_size')
    expect(args[args.indexOf('-video_size') + 1]).toBe('1280x720')
  })

  it('uses -video_size 1280x720 for unknown devices (safe default)', async () => {
    mockResolve.mockResolvedValue({ format: 'avfoundation', device: '0', resolvedName: 'Generic Camera' })
    const proc = makeMockProc()
    mockSpawn.mockReturnValue(proc)

    await startPreview({ videoDeviceName: 'Generic Camera' }, mockWin)

    const args = mockSpawn.mock.calls[0][1] as string[]
    expect(args).toContain('-video_size')
    expect(args[args.indexOf('-video_size') + 1]).toBe('1280x720')
  })

  it('records the working config index on first successful frame', async () => {
    mockResolve.mockResolvedValue({ format: 'avfoundation', device: '0', resolvedName: 'FaceTime HD' })
    const proc = makeMockProc()
    mockSpawn.mockReturnValue(proc)

    await startPreview({ videoDeviceName: 'FaceTime HD' }, mockWin)

    // Deliver a 1280×720 frame (correct landscape from explicit-size config)
    proc.stdout.emit('data', makeJpegWithDims(1280, 720))

    expect(getWorkingMacConfigIdx()).toBe(1)  // MAC_CONFIGS[1] = 720p@30fps
  })
})

describe('startPreview — retry-on-square', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(async () => {
    await stopPreview()
  })

  it('does NOT retry when explicit-size config produces a square frame (trust the user)', async () => {
    mockResolve.mockResolvedValue({ format: 'avfoundation', device: '0', resolvedName: 'Generic' })
    const proc = makeMockProc()
    mockSpawn.mockReturnValue(proc)

    await startPreview({ videoDeviceName: 'Generic' }, mockWin)
    proc.stdout.emit('data', makeJpegWithDims(720, 720))

    // Only one spawn — explicit 720p was respected even though it returned square.
    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })

  it('retries when native config produces a square frame (capture-card mis-classified)', async () => {
    mockResolve.mockResolvedValue({ format: 'avfoundation', device: '0', resolvedName: 'Blackmagic ATEM' })
    const proc1 = makeMockProc()
    const proc2 = makeMockProc()
    mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2)

    await startPreview({ videoDeviceName: 'Blackmagic ATEM' }, mockWin)

    // First config is native (size=null). Deliver a 1552×1552 frame → triggers retry.
    proc1.stdout.emit('data', makeJpegWithDims(1552, 1552))

    // Wait for the retry's kill+wait cycle (200ms grace after close)
    await new Promise(r => setTimeout(r, 350))

    expect(mockSpawn).toHaveBeenCalledTimes(2)
    expect(proc1.kill).toHaveBeenCalledWith('SIGTERM')

    // Second spawn should use a different config (next in capture-card order).
    const secondArgs = mockSpawn.mock.calls[1][1] as string[]
    expect(secondArgs).not.toEqual(mockSpawn.mock.calls[0][1])
  })

  it('does NOT respawn until previous ffmpeg fully exits (avoids AVFoundation lock-up)', async () => {
    mockResolve.mockResolvedValue({ format: 'avfoundation', device: '0', resolvedName: 'Blackmagic ATEM' })

    const proc1 = makeMockProc()
    // Override kill so close is NOT emitted immediately — simulates slow process death.
    proc1.kill = jest.fn().mockImplementation(() => {
      // Delay close event by 100ms
      setTimeout(() => {
        proc1.exitCode = 0
        proc1.emit('close', 0)
        proc1.emit('exit', 0)
      }, 100)
      return true
    })

    const proc2 = makeMockProc()
    mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2)

    await startPreview({ videoDeviceName: 'Blackmagic ATEM' }, mockWin)
    proc1.stdout.emit('data', makeJpegWithDims(1500, 1500))

    // 50ms in — first kill called, but second spawn NOT yet
    await new Promise(r => setTimeout(r, 50))
    expect(proc1.kill).toHaveBeenCalled()
    expect(mockSpawn).toHaveBeenCalledTimes(1)  // no respawn yet

    // After close (100ms) + grace period (200ms) — respawn should fire
    await new Promise(r => setTimeout(r, 400))
    expect(mockSpawn).toHaveBeenCalledTimes(2)
  })
})

describe('startPreview — exhaustion', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(async () => {
    await stopPreview()
  })

  it('retries through multiple configs when each fails with a format error', async () => {
    mockResolve.mockResolvedValue({ format: 'avfoundation', device: '0', resolvedName: 'FaceTime HD' })

    // Every spawn returns a process that exits immediately with a format error
    mockSpawn.mockImplementation(() => {
      const p = makeMockProc()
      setImmediate(() => {
        p.stderr.emit('data', Buffer.from('Selected videosize is not supported'))
        p.exitCode = 1
        p.emit('close', 1)
      })
      return p
    })

    await startPreview({ videoDeviceName: 'FaceTime HD' }, mockWin)
    // 6 configs × (close + 200ms grace) — give it 2s to chew through them.
    await new Promise(r => setTimeout(r, 2000))

    // Should have tried multiple times (every config in the order)
    expect(mockSpawn.mock.calls.length).toBeGreaterThan(1)
    await stopPreview()
  })

  it('returns false when resolveVideoInput returns null', async () => {
    mockResolve.mockResolvedValue(null)
    const ok = await startPreview({ videoDeviceName: 'X' }, mockWin)
    expect(ok).toBe(false)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('stopPreview cancels an in-flight retry — no zombie ffmpeg respawns', async () => {
    mockResolve.mockResolvedValue({ format: 'avfoundation', device: '0', resolvedName: 'Blackmagic ATEM' })

    const proc1 = makeMockProc()
    // Slow kill so we get a window to call stopPreview during the retry await
    proc1.kill = jest.fn().mockImplementation(() => {
      setTimeout(() => {
        proc1.exitCode = 0
        proc1.emit('close', 0)
      }, 100)
      return true
    })
    const proc2 = makeMockProc()
    mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2)

    await startPreview({ videoDeviceName: 'Blackmagic ATEM' }, mockWin)
    // Trigger the square-retry path
    proc1.stdout.emit('data', makeJpegWithDims(1500, 1500))

    // 50ms in — kill issued, close pending. Now stop.
    await new Promise(r => setTimeout(r, 50))
    await stopPreview()

    // Wait long enough that the second spawn WOULD have fired without the bail
    await new Promise(r => setTimeout(r, 500))

    expect(mockSpawn).toHaveBeenCalledTimes(1)  // no respawn after stopPreview
  })
})
