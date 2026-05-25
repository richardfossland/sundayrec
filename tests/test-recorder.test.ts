/**
 * Tests for src/main/test-recorder.ts.
 *
 * runTestRecording records 30 s to a temp file and reports back a signal level.
 * It runs end-to-end through ffmpeg — we mock spawn so each test can simulate
 * a different ffmpeg exit code and astats stderr output.
 *
 * Strategy:
 *   - Mock child_process.spawn: returns an EventEmitter with `stderr` (also an
 *     EventEmitter) and a `kill` method. Tests push fake stderr data and emit
 *     'close' to drive the flow.
 *   - Mock fs/promises stat, mkdir, unlink, readdir.
 *   - Mock native-recorder so resolveDeviceInput is controllable.
 *   - Mock recorder so isActive() can be toggled.
 */

import { EventEmitter } from 'events'
import os from 'os'

// ── Mocks (declared BEFORE importing the SUT) ───────────────────────────────

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/tmp/sundayrec-test') },
}))

jest.mock('../src/main/logger', () => ({
  log:   jest.fn(),
  debug: jest.fn(),
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
}))

jest.mock('../src/main/recorder', () => ({
  isActive: jest.fn(() => false),
}))

jest.mock('../src/main/native-recorder', () => ({
  ffmpegBin: '/usr/bin/ffmpeg',
  resolveDeviceInput: jest.fn(),
  buildCodecArgs: jest.fn(() => ['-c:a', 'libmp3lame', '-ar', '48000']),
}))

// fs: mock promises.stat, promises.mkdir, promises.unlink, promises.readdir
// and the sync existsSync used by cleanupOldTestRecordings.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs')
  return {
    ...actual,
    existsSync: jest.fn(() => true),
    promises: {
      ...actual.promises,
      stat:    jest.fn(),
      mkdir:   jest.fn(async () => undefined),
      unlink:  jest.fn(async () => undefined),
      readdir: jest.fn(async () => []),
    },
  }
})

// child_process.spawn: each call returns a "fake ffmpeg" the test can drive.
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}))

// ── Import the SUT (after all mocks) ────────────────────────────────────────

import { runTestRecording, cleanupOldTestRecordings } from '../src/main/test-recorder'
import * as nativeRecorder from '../src/main/native-recorder'
import * as recorder from '../src/main/recorder'
import * as fs from 'fs'
import { spawn } from 'child_process'

// ── Helpers ─────────────────────────────────────────────────────────────────

interface FakeProc extends EventEmitter {
  stderr: EventEmitter
  kill: jest.Mock
}

/** Make a fake ffmpeg process. Pass exitCode + stderr to drive the close event. */
function makeFakeFfmpeg(opts: { exitCode?: number; stderr?: string; defer?: boolean } = {}): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.stderr = new EventEmitter()
  proc.kill = jest.fn()

  // Defer the close so that the SUT has time to subscribe to 'close'.
  // Use process.nextTick — NOT faked by jest.useFakeTimers(), so this works
  // even in tests that need to control setTimeout/setImmediate.
  const emitClose = () => {
    if (opts.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr))
    proc.emit('close', opts.exitCode ?? 0)
  }
  if (!opts.defer) process.nextTick(emitClose)
  // Attach the emitClose so deferred tests can fire it manually.
  ;(proc as unknown as { __emitClose: () => void }).__emitClose = emitClose
  return proc
}

const baseSettings = {
  format: 'mp3' as const,
  bitrate: '192',
  deviceName: 'MacBook Pro Microphone',
  saveFolder: '/tmp/sundayrec-test',
  filenamePattern: 'date' as const,
  language: 'no',
}

beforeEach(() => {
  ;(recorder.isActive as jest.Mock).mockReset().mockReturnValue(false)
  ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockReset().mockResolvedValue({
    format: 'avfoundation',
    device: ':0',
    resolvedName: 'MacBook Pro Microphone',
  })
  ;(nativeRecorder.buildCodecArgs as jest.Mock).mockClear()
  ;(fs.promises.stat   as unknown as jest.Mock).mockReset()
  ;(fs.promises.mkdir  as unknown as jest.Mock).mockReset().mockResolvedValue(undefined)
  ;(fs.promises.unlink as unknown as jest.Mock).mockReset().mockResolvedValue(undefined)
  ;(fs.promises.readdir as unknown as jest.Mock).mockReset().mockResolvedValue([])
  ;(fs.existsSync as unknown as jest.Mock).mockReset().mockReturnValue(true)
  ;(spawn as unknown as jest.Mock).mockReset()
})

afterEach(() => {
  jest.useRealTimers()
})

// ════════════════════════════════════════════════════════════════════════════
// 1. Happy path — normal RMS level
// ════════════════════════════════════════════════════════════════════════════

describe('runTestRecording — happy paths', () => {
  it('records, validates file size, and classifies a healthy signal as "normal"', async () => {
    ;(fs.promises.stat as unknown as jest.Mock).mockResolvedValueOnce({ size: 50_000 })

    // First spawn: main ffmpeg capture (exit 0)
    // Second spawn: astats measurement with strong RMS level
    ;(spawn as unknown as jest.Mock)
      .mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))
      .mockImplementationOnce(() => makeFakeFfmpeg({
        exitCode: 0,
        stderr: '[Parsed_astats_0 @ 0x123] RMS level dB: -18.5\n',
      }))

    const result = await runTestRecording(baseSettings)
    expect(result.ok).toBe(true)
    expect(result.signal).toBe('normal')
    expect(result.sizeBytes).toBe(50_000)
    expect(result.filePath).toMatch(/sundayrec-test[\\/]test_/)
  })

  it('classifies a -40 dB RMS level as "low"', async () => {
    ;(fs.promises.stat as unknown as jest.Mock).mockResolvedValueOnce({ size: 20_000 })
    ;(spawn as unknown as jest.Mock)
      .mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))
      .mockImplementationOnce(() => makeFakeFfmpeg({
        exitCode: 0,
        stderr: 'Stream mapping... RMS level dB: -40.0\n',
      }))

    const result = await runTestRecording(baseSettings)
    expect(result.ok).toBe(true)
    expect(result.signal).toBe('low')
  })

  it('classifies a -60 dB RMS level as "silent"', async () => {
    ;(fs.promises.stat as unknown as jest.Mock).mockResolvedValueOnce({ size: 20_000 })
    ;(spawn as unknown as jest.Mock)
      .mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))
      .mockImplementationOnce(() => makeFakeFfmpeg({
        exitCode: 0,
        stderr: 'RMS level dB: -60.0\n',
      }))

    const result = await runTestRecording(baseSettings)
    expect(result.ok).toBe(true)
    expect(result.signal).toBe('silent')
  })

  it('picks the strongest channel RMS when multiple are reported', async () => {
    ;(fs.promises.stat as unknown as jest.Mock).mockResolvedValueOnce({ size: 20_000 })
    ;(spawn as unknown as jest.Mock)
      .mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))
      .mockImplementationOnce(() => makeFakeFfmpeg({
        exitCode: 0,
        // Two channels: -60 (silent) and -20 (normal). Strongest is -20.
        stderr: 'Channel 1 RMS level dB: -60.0\nChannel 2 RMS level dB: -20.0\n',
      }))

    const result = await runTestRecording(baseSettings)
    expect(result.signal).toBe('normal')
  })

  it('falls back to "normal" when astats output cannot be parsed', async () => {
    ;(fs.promises.stat as unknown as jest.Mock).mockResolvedValueOnce({ size: 20_000 })
    ;(spawn as unknown as jest.Mock)
      .mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))
      .mockImplementationOnce(() => makeFakeFfmpeg({
        exitCode: 0,
        stderr: 'garbage output without any rms line\n',
      }))

    const result = await runTestRecording(baseSettings)
    expect(result.ok).toBe(true)
    expect(result.signal).toBe('normal')  // Fallback — better than a false "silent"
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2. Error paths
// ════════════════════════════════════════════════════════════════════════════

describe('runTestRecording — error paths', () => {
  it('returns device_not_found when no audio device resolves', async () => {
    ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValueOnce(null)
    const result = await runTestRecording(baseSettings)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('device_not_found')
    expect(spawn as unknown as jest.Mock).not.toHaveBeenCalled()
  })

  it('returns recording_active when a real session is running', async () => {
    ;(recorder.isActive as jest.Mock).mockReturnValueOnce(true)
    const result = await runTestRecording(baseSettings)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('recording_active')
  })

  it('returns no_audio when ffmpeg succeeds but the file is too small', async () => {
    ;(fs.promises.stat as unknown as jest.Mock).mockResolvedValueOnce({ size: 200 })
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))

    const result = await runTestRecording(baseSettings)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('no_audio')
    expect(result.sizeBytes).toBe(200)
    // Only one spawn — astats never invoked when file is too small
    expect((spawn as unknown as jest.Mock).mock.calls.length).toBe(1)
  })

  it('returns no_audio when stat fails entirely (file missing)', async () => {
    ;(fs.promises.stat as unknown as jest.Mock).mockRejectedValueOnce(new Error('ENOENT'))
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))

    const result = await runTestRecording(baseSettings)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('no_audio')
    expect(result.sizeBytes).toBeUndefined()
  })

  it('returns ffmpeg_error on non-zero exit with generic stderr', async () => {
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({
      exitCode: 1,
      stderr: 'Some unrelated ffmpeg internal error\n',
    }))

    const result = await runTestRecording(baseSettings)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('ffmpeg_error')
    expect(result.detail).toMatch(/unrelated ffmpeg internal error/)
  })

  it('returns device_not_found when stderr mentions "No such device"', async () => {
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({
      exitCode: 1,
      stderr: '[avfoundation @ 0x123] No such input device: 5\n',
    }))

    const result = await runTestRecording(baseSettings)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('device_not_found')
  })

  it('returns device_not_found when stderr mentions "not found"', async () => {
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({
      exitCode: 1,
      stderr: 'Input device not found\n',
    }))

    const result = await runTestRecording(baseSettings)
    expect(result.error).toBe('device_not_found')
  })

  it('returns device_permission_denied when stderr mentions "Permission"', async () => {
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({
      exitCode: 1,
      stderr: 'Permission denied by macOS TCC\n',
    }))

    const result = await runTestRecording(baseSettings)
    expect(result.error).toBe('device_permission_denied')
  })

  it('returns device_permission_denied for Windows "Access is denied"', async () => {
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({
      exitCode: 1,
      stderr: 'Access is denied.\n',
    }))

    const result = await runTestRecording(baseSettings)
    expect(result.error).toBe('device_permission_denied')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3. Concurrency — `inflight` gate
// ════════════════════════════════════════════════════════════════════════════

describe('runTestRecording — concurrency gate', () => {
  it('rejects a second invocation while the first is still running', async () => {
    // First call: deferred so we can fire two calls before close.
    const firstProc = makeFakeFfmpeg({ exitCode: 0, defer: true })
    const astatsProc = makeFakeFfmpeg({
      exitCode: 0,
      stderr: 'RMS level dB: -20.0\n',
    })
    ;(spawn as unknown as jest.Mock)
      .mockImplementationOnce(() => firstProc)
      .mockImplementationOnce(() => astatsProc)
    ;(fs.promises.stat as unknown as jest.Mock).mockResolvedValueOnce({ size: 20_000 })

    const firstPromise = runTestRecording(baseSettings)
    // Give the SUT a tick to set inflight = true
    await Promise.resolve()
    await Promise.resolve()

    // Second call should be rejected immediately with already_running
    const second = await runTestRecording(baseSettings)
    expect(second.ok).toBe(false)
    expect(second.error).toBe('already_running')

    // Now drain the first call
    ;(firstProc as unknown as { __emitClose: () => void }).__emitClose()
    await firstPromise
  })

  it('clears inflight even when the test throws (releases the gate)', async () => {
    ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValueOnce(null)
    await runTestRecording(baseSettings)

    // Second call should NOT be blocked by inflight
    ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValueOnce(null)
    const second = await runTestRecording(baseSettings)
    expect(second.error).toBe('device_not_found')
    expect(second.error).not.toBe('already_running')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4. Auto-cleanup timer (5 min unlink)
// ════════════════════════════════════════════════════════════════════════════

describe('runTestRecording — auto-cleanup timer', () => {
  it('schedules a 5-minute unlink of the test file on success', async () => {
    // doNotFake nextTick so our spawn-mock can still drive ffmpeg 'close' events.
    jest.useFakeTimers({ doNotFake: ['nextTick'] })

    ;(fs.promises.stat as unknown as jest.Mock).mockResolvedValueOnce({ size: 20_000 })
    ;(spawn as unknown as jest.Mock)
      .mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))
      .mockImplementationOnce(() => makeFakeFfmpeg({
        exitCode: 0,
        stderr: 'RMS level dB: -20.0\n',
      }))

    const result = await runTestRecording(baseSettings)
    expect(result.ok).toBe(true)
    const filePath = result.filePath!

    // unlink not yet called — timer hasn't fired
    expect(fs.promises.unlink as unknown as jest.Mock).not.toHaveBeenCalledWith(filePath)

    // Advance 5 minutes
    jest.advanceTimersByTime(5 * 60_000 + 100)
    // Let the .catch() chain settle
    await Promise.resolve()
    await Promise.resolve()

    expect(fs.promises.unlink as unknown as jest.Mock).toHaveBeenCalledWith(filePath)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5. ffmpeg spawn arguments
// ════════════════════════════════════════════════════════════════════════════

describe('runTestRecording — ffmpeg args', () => {
  it('passes -t 30 (30-second duration) and writes to a .mp3 file', async () => {
    ;(fs.promises.stat as unknown as jest.Mock).mockResolvedValueOnce({ size: 20_000 })
    ;(spawn as unknown as jest.Mock)
      .mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))
      .mockImplementationOnce(() => makeFakeFfmpeg({
        exitCode: 0,
        stderr: 'RMS level dB: -20.0\n',
      }))

    await runTestRecording(baseSettings)

    const firstCall = (spawn as unknown as jest.Mock).mock.calls[0]
    expect(firstCall[0]).toBe('/usr/bin/ffmpeg')
    const args = firstCall[1] as string[]
    const tIdx = args.indexOf('-t')
    expect(tIdx).toBeGreaterThanOrEqual(0)
    expect(args[tIdx + 1]).toBe('30')
    // Output is the last argument and ends in .mp3
    expect(args[args.length - 1]).toMatch(/\.mp3$/)
    // -y flag is the second-to-last (overwrite output)
    expect(args[args.length - 2]).toBe('-y')
  })

  it('overrides format to mp3 + bitrate to 128 for the test file', async () => {
    ;(fs.promises.stat as unknown as jest.Mock).mockResolvedValueOnce({ size: 20_000 })
    ;(spawn as unknown as jest.Mock)
      .mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))
      .mockImplementationOnce(() => makeFakeFfmpeg({
        exitCode: 0,
        stderr: 'RMS level dB: -20.0\n',
      }))

    await runTestRecording(baseSettings)

    const buildCodecCalls = (nativeRecorder.buildCodecArgs as jest.Mock).mock.calls
    expect(buildCodecCalls.length).toBeGreaterThan(0)
    const codecOpts = buildCodecCalls[0][0]
    expect(codecOpts.format).toBe('mp3')
    expect(codecOpts.bitrate).toBe('128')
  })

  it('writes the test file under os.tmpdir()/sundayrec-test/', async () => {
    ;(fs.promises.stat as unknown as jest.Mock).mockResolvedValueOnce({ size: 20_000 })
    ;(spawn as unknown as jest.Mock)
      .mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))
      .mockImplementationOnce(() => makeFakeFfmpeg({
        exitCode: 0,
        stderr: 'RMS level dB: -20.0\n',
      }))

    const result = await runTestRecording(baseSettings)
    expect(result.filePath).toContain(os.tmpdir())
    expect(result.filePath).toContain('sundayrec-test')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6. cleanupOldTestRecordings
// ════════════════════════════════════════════════════════════════════════════

describe('cleanupOldTestRecordings', () => {
  it('returns 0 when the tmp dir does not exist', async () => {
    ;(fs.existsSync as unknown as jest.Mock).mockReturnValueOnce(false)
    const removed = await cleanupOldTestRecordings()
    expect(removed).toBe(0)
    expect(fs.promises.readdir as unknown as jest.Mock).not.toHaveBeenCalled()
  })

  it('returns 0 when the tmp dir is empty', async () => {
    ;(fs.existsSync as unknown as jest.Mock).mockReturnValueOnce(true)
    ;(fs.promises.readdir as unknown as jest.Mock).mockResolvedValueOnce([])
    const removed = await cleanupOldTestRecordings()
    expect(removed).toBe(0)
  })

  it('deletes every entry it finds in the tmp dir and counts them', async () => {
    ;(fs.existsSync as unknown as jest.Mock).mockReturnValueOnce(true)
    ;(fs.promises.readdir as unknown as jest.Mock).mockResolvedValueOnce([
      'test_2026-05-25.mp3',
      'test_2026-05-24.mp3',
      'test_2026-05-23.mp3',
    ])
    ;(fs.promises.unlink as unknown as jest.Mock).mockResolvedValue(undefined)

    const removed = await cleanupOldTestRecordings()
    expect(removed).toBe(3)
    expect((fs.promises.unlink as unknown as jest.Mock).mock.calls.length).toBe(3)
  })

  it('continues past individual unlink failures (does not throw)', async () => {
    ;(fs.existsSync as unknown as jest.Mock).mockReturnValueOnce(true)
    ;(fs.promises.readdir as unknown as jest.Mock).mockResolvedValueOnce([
      'test_a.mp3',
      'test_b.mp3',
      'test_c.mp3',
    ])
    // First unlink fails, others succeed
    ;(fs.promises.unlink as unknown as jest.Mock)
      .mockRejectedValueOnce(new Error('EACCES'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)

    const removed = await cleanupOldTestRecordings()
    expect(removed).toBe(2)
  })

  it('returns 0 when readdir itself fails (does not crash)', async () => {
    ;(fs.existsSync as unknown as jest.Mock).mockReturnValueOnce(true)
    ;(fs.promises.readdir as unknown as jest.Mock).mockRejectedValueOnce(new Error('EPERM'))
    const removed = await cleanupOldTestRecordings()
    expect(removed).toBe(0)
  })

  it('only scans the sundayrec-test subdirectory (not all of tmpdir)', async () => {
    ;(fs.existsSync as unknown as jest.Mock).mockReturnValueOnce(true)
    ;(fs.promises.readdir as unknown as jest.Mock).mockResolvedValueOnce([])
    await cleanupOldTestRecordings()
    const readdirCall = (fs.promises.readdir as unknown as jest.Mock).mock.calls[0]
    expect(String(readdirCall[0])).toContain('sundayrec-test')
  })
})
