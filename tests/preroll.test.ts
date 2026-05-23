/**
 * preroll.test.ts
 *
 * Fake timers are enabled for the whole file so that the 30-second retry
 * setTimeout that startLoop schedules when the device is unavailable can be
 * cleared by jest.clearAllTimers() in afterEach — preventing the worker from
 * staying alive after the suite finishes.
 *
 * Async ordering note: after `await start(opts)`, startLoop has already
 * executed its synchronous body (including spawn + activePreroll assignment)
 * because the resolveDeviceInput microtask (M1) is queued before the
 * `await start()` test-continuation microtask (M2).
 */

import { spawn } from 'child_process'
import { isRunning, harvest, stop, start } from '../src/main/preroll'
import type { RecordingOpts } from '../src/types'

jest.mock('electron')
jest.mock('child_process', () => ({ spawn: jest.fn() }))
jest.mock('fs', () => ({
  existsSync:  jest.fn(() => false),
  statSync:    jest.fn(() => ({ size: 0 })),
  promises:    { unlink: jest.fn().mockResolvedValue(undefined) },
}))
jest.mock('../src/main/native-recorder', () => ({
  ffmpegBin:          '/mock/ffmpeg',
  resolveDeviceInput: jest.fn().mockResolvedValue(null), // default: device unavailable
}))

const mockSpawn = spawn as unknown as jest.Mock

const OPTS: RecordingOpts = {
  format:     'mp3',
  sampleRate: 48000,
  channels:   'stereo',
}

// Mock ChildProcess with exitCode=0 so stopProc() returns immediately
const mockProc: any = {
  exitCode: 0,
  stdin:    { write: jest.fn(), end: jest.fn() },
  kill:     jest.fn(),
  on:       jest.fn(),
  once:     jest.fn(),
}

beforeAll(() => {
  // Install fake timers once for the whole file.  This ensures setTimeout
  // calls inside startLoop (retry delays) are fake and can be cleared.
  jest.useFakeTimers()
})

afterAll(() => {
  jest.useRealTimers()
})

beforeEach(() => {
  jest.clearAllMocks()
})

// ─── initial state ────────────────────────────────────────────────────────────

describe('initial state', () => {
  it('isRunning returns false before any call', () => {
    expect(isRunning()).toBe(false)
  })
})

// ─── harvest — no active preroll ─────────────────────────────────────────────

describe('harvest — no active preroll', () => {
  it('returns null when no buffer is running', async () => {
    expect(await harvest(5)).toBeNull()
  })

  it('returns null for any positive seconds value', async () => {
    expect(await harvest(0)).toBeNull()
    expect(await harvest(30)).toBeNull()
    expect(await harvest(90)).toBeNull()
  })
})

// ─── stop — no active preroll ─────────────────────────────────────────────────

describe('stop — no active preroll', () => {
  it('resolves without error', async () => {
    await expect(stop()).resolves.toBeUndefined()
  })

  it('isRunning is false after stop()', async () => {
    await stop()
    expect(isRunning()).toBe(false)
  })

  it('harvest returns null after stop()', async () => {
    await stop()
    expect(await harvest(10)).toBeNull()
  })
})

// ─── start / stop — device unavailable ───────────────────────────────────────

describe('start / stop — device unavailable', () => {
  afterEach(async () => {
    jest.clearAllTimers() // discard the 30-second retry timer
    await stop()
  })

  it('start() resolves without throwing', async () => {
    await expect(start(OPTS)).resolves.toBeUndefined()
  })

  it('isRunning is false when device is unavailable', async () => {
    await start(OPTS)
    // resolveDeviceInput → null → spawn never called → activePreroll never set
    expect(isRunning()).toBe(false)
  })

  it('stop() after start() makes isRunning false', async () => {
    await start(OPTS)
    await stop()
    expect(isRunning()).toBe(false)
  })

  it('harvest returns null after start() + stop() with no device', async () => {
    await start(OPTS)
    await stop()
    expect(await harvest(10)).toBeNull()
  })
})

// ─── start — device available ─────────────────────────────────────────────────

describe('start — device available', () => {
  const nativeRecorder = jest.requireMock('../src/main/native-recorder') as {
    resolveDeviceInput: jest.Mock
  }

  beforeEach(() => {
    mockSpawn.mockReturnValue(mockProc)
    nativeRecorder.resolveDeviceInput.mockResolvedValue({ format: 'avfoundation', device: ':0' })
  })

  afterEach(async () => {
    jest.clearAllTimers()
    nativeRecorder.resolveDeviceInput.mockResolvedValue(null)
    await stop()
  })

  it('spawn is called with ffmpegBin after start()', async () => {
    await start(OPTS)
    expect(mockSpawn).toHaveBeenCalledWith('/mock/ffmpeg', expect.any(Array), expect.any(Object))
  })

  it('isRunning is true after start() when device is available', async () => {
    await start(OPTS)
    expect(isRunning()).toBe(true)
  })

  it('isRunning is false after stop() when previously running', async () => {
    await start(OPTS)
    expect(isRunning()).toBe(true)
    await stop()
    expect(isRunning()).toBe(false)
  })

  it('harvest returns null when captured file does not exist', async () => {
    const fsMock = jest.requireMock('fs') as { existsSync: jest.Mock }
    fsMock.existsSync.mockReturnValue(false)
    await start(OPTS)
    expect(await harvest(5)).toBeNull()
  })

  it('harvest returns null when captured file is too small (< 4096 bytes)', async () => {
    const fsMock = jest.requireMock('fs') as { existsSync: jest.Mock; statSync: jest.Mock }
    fsMock.existsSync.mockReturnValue(true)
    fsMock.statSync.mockReturnValue({ size: 100 })
    await start(OPTS)
    expect(await harvest(5)).toBeNull()
  })

  it('harvest returns rawPath and trimMs when file is large enough', async () => {
    const fsMock = jest.requireMock('fs') as { existsSync: jest.Mock; statSync: jest.Mock }
    fsMock.existsSync.mockReturnValue(true)
    fsMock.statSync.mockReturnValue({ size: 500_000 })

    // Pin system time so startTime is deterministic
    jest.setSystemTime(1_000_000)
    await start(OPTS)
    // activePreroll.startTime === 1_000_000 (set during M1 before test continuation)

    jest.setSystemTime(1_003_000) // simulate 3 s of capture
    const result = await harvest(5)

    // capturedMs = 3000, trimMs = min(5000, 3000-300) = 2700
    expect(result).not.toBeNull()
    expect(result!.trimMs).toBe(2700)
    expect(result!.rawPath).toMatch(/sundayrec-preroll-.+\.wav$/)
  })

  it('spawn receives the correct sample-rate and mono channel flags', async () => {
    await start({ ...OPTS, sampleRate: 44100, channels: 'monoL' })
    const spawnArgs: string[] = mockSpawn.mock.calls[0][1]
    expect(spawnArgs).toContain('44100')
    expect(spawnArgs).toContain('1') // monoL → outCh = 1
  })
})
