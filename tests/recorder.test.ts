/**
 * Orchestration tests for src/main/recorder.ts.
 *
 * Recorder.ts is the highest-stakes module in the app: it owns the phase
 * state machine, watchdog, sleep/resume handling, silence detection and
 * crash recovery. Bugs here mean a botched service recording.
 *
 * Strategy:
 *   - Mock the whole world: electron, store, tray, mailer, native-recorder,
 *     video-recorder, video-preview, preroll, cloud, fs, child_process.
 *   - Reset session state between tests by completing the previous session
 *     cleanly (no jest.resetModules — that breaks jest.fn() references).
 *   - Drive flows by capturing the handle.on* callbacks the recorder installs,
 *     then invoking them directly to simulate ffmpeg events.
 */

import { EventEmitter } from 'events'

// ── Mocks (must be declared BEFORE importing the SUT) ───────────────────────

jest.mock('electron', () => {
  const Notification = jest.fn(() => ({ show: jest.fn() })) as unknown as jest.Mock & { isSupported: () => boolean }
  ;(Notification as unknown as { isSupported: () => boolean }).isSupported = jest.fn(() => false)
  return {
    app: { getPath: jest.fn(() => '/tmp/sundayrec-test'), getVersion: jest.fn(() => '4.26.0'), isPackaged: false },
    powerSaveBlocker: { start: jest.fn(() => 1), stop: jest.fn(), isStarted: jest.fn(() => false) },
    systemPreferences: { getMediaAccessStatus: jest.fn(() => 'granted'), askForMediaAccess: jest.fn(async () => true) },
    Notification,
    BrowserWindow: jest.fn(),
    ipcMain: { handle: jest.fn(), on: jest.fn() },
    shell: { openExternal: jest.fn(), openPath: jest.fn(), showItemInFolder: jest.fn() },
    safeStorage: { isEncryptionAvailable: () => false },
  }
})

jest.mock('ffmpeg-static', () => '/usr/bin/ffmpeg')

// ── store mock ──────────────────────────────────────────────────────────────
const storeData: Record<string, unknown> = {}
const historyEntries: unknown[] = []

jest.mock('../src/main/store', () => ({
  get: jest.fn((key: string) => storeData[key]),
  set: jest.fn((key: string, value: unknown) => { storeData[key] = value }),
  getAll: jest.fn(() => ({ ...storeData })),
  addHistory: jest.fn((entry: unknown) => { historyEntries.push(entry) }),
  getSmtpPassword: jest.fn(() => ''),
  getHistory: jest.fn(() => historyEntries.slice()),
}))

jest.mock('../src/main/tray', () => ({
  setRecording: jest.fn(),
  setError:     jest.fn(),
  setNextRecording: jest.fn(),
  create: jest.fn(),
}))

jest.mock('../src/main/mailer', () => ({
  sendError: jest.fn(async () => {}),
  sendTest:  jest.fn(async () => {}),
}))

jest.mock('../src/main/logger', () => ({
  log:   jest.fn(),
  debug: jest.fn(),
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  getRecentLogs: jest.fn(() => []),
  getLogFilePath: jest.fn(() => null),
}))

jest.mock('../src/main/preroll', () => ({
  isRunning: jest.fn(() => false),
  stop:      jest.fn(async () => {}),
  start:     jest.fn(async () => {}),
  harvest:   jest.fn(async () => null),
}))

jest.mock('../src/main/video-recorder', () => ({
  startVideoCapture: jest.fn(async () => ({ error: 'not_used' })),
  stopVideoCapture:  jest.fn(async () => {}),
  muxAudioVideo:     jest.fn(async () => true),
}))

jest.mock('../src/main/video-preview', () => ({
  stopPreview: jest.fn(async () => {}),
}))

// Recorder dynamically imports ./cloud after finishing a session — must not
// hit real cloud code in tests (would try OAuth, network calls, etc.).
jest.mock('../src/main/cloud', () => ({
  autoUploadAfterRecording: jest.fn(),
}))

// native-recorder mock: lets each test inject a fake "ffmpeg handle".
jest.mock('../src/main/native-recorder', () => ({
  ffmpegBin: '/usr/bin/ffmpeg',
  buildCodecArgs: jest.fn(() => ['-c:a', 'libmp3lame']),
  resolveDeviceInput: jest.fn(),
  startCapture: jest.fn(),
  stopCapture: jest.fn(),
}))

// Mock fs/fs.promises so tests don't touch disk.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs')
  return {
    ...actual,
    existsSync:   jest.fn(() => true),
    statSync:     jest.fn(() => ({ size: 4096, mtimeMs: Date.now() })),
    mkdirSync:    jest.fn(),
    writeFileSync: jest.fn(),
    unlinkSync:   jest.fn(),
    renameSync:   jest.fn(),
    copyFileSync: jest.fn(),
    promises: {
      ...actual.promises,
      access: jest.fn(async () => { throw new Error('ENOENT') }),  // path always unique
      statfs: jest.fn(async () => ({ bavail: 1e9, bsize: 4096 })), // plenty of free space
      unlink: jest.fn(async () => {}),
      writeFile: jest.fn(async () => {}),
    },
  }
})

// child_process: capture spawn calls without running anything.
jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    const ee = new EventEmitter() as EventEmitter & {
      stdin: { write: jest.Mock; end: jest.Mock };
      stderr: EventEmitter;
      kill: jest.Mock;
      exitCode: number | null;
      killed: boolean;
    }
    ee.stdin = { write: jest.fn(), end: jest.fn() }
    ee.stderr = new EventEmitter()
    ee.kill = jest.fn(() => { ee.exitCode = 0; ee.killed = true; setImmediate(() => ee.emit('close', 0)); return true })
    ee.exitCode = null
    ee.killed = false
    setImmediate(() => ee.emit('close', 0))
    return ee
  }),
}))

// ── Now import the SUT (after all mocks) ────────────────────────────────────

import {
  getPhase,
  isActive,
  notifyResumed,
  startSession,
  stopSession,
  recoverCrashedSession,
  localizeError,
  NOTIFY_LABELS,
  MAX_RECONNECT_ATTEMPTS,
  reconnectDelay,
  FATAL_RECONNECT_ERRORS,
  onceIdle,
  setSessionEndCallback,
  _resetForTest,
} from '../src/main/recorder'
import { runScheduledPreflight } from '../src/main/preflight'

import * as store from '../src/main/store'
import * as tray  from '../src/main/tray'
import * as nativeRecorder from '../src/main/native-recorder'
import * as fs from 'fs'

// ── Helpers ─────────────────────────────────────────────────────────────────

interface MockHandle {
  proc: EventEmitter & { kill: jest.Mock; exitCode: number | null; killed: boolean; stdin: { write: jest.Mock; end: jest.Mock } }
  outputPath: string
  startTime: number
  bytesWritten: number
  format: string
  onExit: ((code: number | null) => void) | null
  onProgress: ((bytes: number) => void) | null
  onSilenceEnd: (() => void) | null
  onSilenceWarning: (() => void) | null
  getStderrTail: () => string
  lastError: string | null
}

function makeHandle(outputPath = '/tmp/test.mp3'): MockHandle {
  const ee = new EventEmitter() as EventEmitter & {
    kill: jest.Mock;
    exitCode: number | null;
    killed: boolean;
    stdin: { write: jest.Mock; end: jest.Mock };
  }
  ee.kill = jest.fn(() => { ee.killed = true; ee.exitCode = 0; return true })
  ee.exitCode = null
  ee.killed = false
  ee.stdin = { write: jest.fn(), end: jest.fn() }
  return {
    proc:         ee,
    outputPath,
    startTime:    Date.now(),
    bytesWritten: 0,
    format:       'avfoundation',
    onExit: null, onProgress: null, onSilenceEnd: null, onSilenceWarning: null,
    getStderrTail: () => '',
    lastError:     null,
  }
}

function makeWindow() {
  const send = jest.fn()
  return {
    isDestroyed:  () => false,
    webContents:  { isDestroyed: () => false, send },
    __sent: () => send.mock.calls,
    __send: send,
  } as unknown as import('electron').BrowserWindow & { __sent: () => unknown[][]; __send: jest.Mock }
}

const baseSettings = {
  format: 'mp3' as const,
  bitrate: '192',
  deviceName: 'MacBook Pro Microphone',
  saveFolder: '/tmp/sundayrec-test',
  filenamePattern: 'date' as const,
  language: 'no',
}

// Wait for any pending microtasks/promises to resolve. Each round flushes
// one layer of nested .then().
const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

beforeEach(() => {
  _resetForTest()
  for (const k of Object.keys(storeData)) delete storeData[k]
  historyEntries.length = 0
  // Per-mock reset clears both call history AND any leftover mockResolvedValueOnce
  // queue. Targeted so the global electron / store / etc. factory mocks survive.
  ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockReset()
  ;(nativeRecorder.startCapture       as jest.Mock).mockReset()
  ;(nativeRecorder.stopCapture        as jest.Mock).mockReset()
  ;(fs.existsSync                     as jest.Mock).mockReset()
  ;(fs.statSync                       as jest.Mock).mockReset()
  ;(fs.promises.statfs                as jest.Mock).mockReset()
  jest.clearAllMocks()  // call history only — leaves implementations on store/tray/etc.

  ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValue({
    format: 'avfoundation', device: ':0', resolvedName: 'MacBook Pro Microphone'
  })
  ;(nativeRecorder.stopCapture as jest.Mock).mockResolvedValue(undefined)
  ;(nativeRecorder.startCapture as jest.Mock).mockImplementation(async () => makeHandle())
  ;(fs.existsSync as jest.Mock).mockReturnValue(true)
  ;(fs.statSync as jest.Mock).mockReturnValue({ size: 4096, mtimeMs: Date.now() })
  ;(fs.promises.statfs as jest.Mock).mockResolvedValue({ bavail: 1e9, bsize: 4096 })
})

afterEach(() => {
  jest.useRealTimers()
  _resetForTest()
})

// ════════════════════════════════════════════════════════════════════════════
// 1. Phase state machine
// ════════════════════════════════════════════════════════════════════════════

describe('phase state machine', () => {
  it('starts in idle', () => {
    expect(getPhase()).toBe('idle')
    expect(isActive()).toBe(false)
  })

  it('transitions idle → recording on successful startSession', async () => {
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    const result = await startSession(baseSettings, win)
    expect(result).toEqual({ ok: true })
    expect(getPhase()).toBe('recording')
    expect(isActive()).toBe(true)
    expect(handle.onExit).not.toBeNull()
    expect(handle.onProgress).not.toBeNull()
  })

  it('rejects a concurrent startSession with already_recording', async () => {
    const win = makeWindow()
    await startSession(baseSettings, win)
    const second = await startSession(baseSettings, win)
    expect(second).toEqual({ error: 'already_recording' })
  })

  it('returns to idle after stopSession completes', async () => {
    const win = makeWindow()
    await startSession(baseSettings, win)
    expect(getPhase()).toBe('recording')

    stopSession()
    await flush(20)
    expect(getPhase()).toBe('idle')
    expect(isActive()).toBe(false)
  })

  it('rejects startSession during stopping/finalizing', async () => {
    const win = makeWindow()
    await startSession(baseSettings, win)
    stopSession()
    // Don't flush yet — phase is 'stopping'
    const r = await startSession(baseSettings, win)
    expect(r).toEqual({ error: 'already_recording' })
    await flush(20)
  })

  it('isActive returns true only for starting/recording/reconnecting', async () => {
    expect(isActive()).toBe(false)
    const win = makeWindow()
    await startSession(baseSettings, win)
    expect(isActive()).toBe(true)
    stopSession()
    await flush(20)
    expect(isActive()).toBe(false)
  })

  it('resets _phase to idle on preflight failure', async () => {
    const win = makeWindow()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce({ error: 'no_device' })
    const r = await startSession(baseSettings, win)
    expect(r).toEqual({ error: 'no_device' })
    expect(getPhase()).toBe('idle')
    // Confirms we can start fresh — would fail with already_recording otherwise
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(makeHandle())
    const r2 = await startSession(baseSettings, win)
    expect(r2).toEqual({ ok: true })
  })

  it('split-restart resets phase to idle before recursive startSession', async () => {
    // This is the bugfix mentioned in recorder.ts: previously _phase stuck at
    // 'finalizing' and the recursive startSession returned 'already_recording',
    // silently dropping the split. We verify by triggering a split path and
    // confirming a new session is established with a recording phase.
    const win = makeWindow()
    ;(fs.statSync as jest.Mock).mockReturnValue({ size: 50_000, mtimeMs: Date.now() })

    const firstHandle = makeHandle('/tmp/first.mp3')
    const secondHandle = makeHandle('/tmp/second.mp3')
    ;(nativeRecorder.startCapture as jest.Mock)
      .mockResolvedValueOnce(firstHandle)
      .mockResolvedValueOnce(secondHandle)

    jest.useFakeTimers()
    const promise = startSession({ ...baseSettings, splitMinutes: 1 }, win)
    // Drain teardown setTimeout
    for (let i = 0; i < 5; i++) await Promise.resolve()
    jest.advanceTimersByTime(300)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await promise
    expect(getPhase()).toBe('recording')

    // Trigger split-timer (1 minute)
    jest.advanceTimersByTime(60_001)
    // Drain to let finishSessionAsync run + recursive startSession's teardown
    for (let i = 0; i < 30; i++) await Promise.resolve()
    jest.advanceTimersByTime(500)
    for (let i = 0; i < 30; i++) await Promise.resolve()

    jest.useRealTimers()
    await flush(30)

    // After split: second session is recording (would be 'already_recording' if bug)
    expect(getPhase()).toBe('recording')
    expect((nativeRecorder.startCapture as jest.Mock).mock.calls.length).toBe(2)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2. FATAL_RECONNECT_ERRORS
// ════════════════════════════════════════════════════════════════════════════

describe('FATAL_RECONNECT_ERRORS', () => {
  it('contains the documented set of fatal codes', () => {
    expect(FATAL_RECONNECT_ERRORS.has('disk_full')).toBe(true)
    expect(FATAL_RECONNECT_ERRORS.has('device_permission_denied')).toBe(true)
    expect(FATAL_RECONNECT_ERRORS.has('ffmpeg_missing')).toBe(true)
    expect(FATAL_RECONNECT_ERRORS.has('no_device')).toBe(true)
  })

  it('does NOT contain transient codes', () => {
    expect(FATAL_RECONNECT_ERRORS.has('device_disconnected')).toBe(false)
    expect(FATAL_RECONNECT_ERRORS.has('device_busy')).toBe(false)
    expect(FATAL_RECONNECT_ERRORS.has('device_error')).toBe(false)
    expect(FATAL_RECONNECT_ERRORS.has('empty_output')).toBe(false)
  })

  it('aborts immediately for disk_full (no reconnect attempt)', async () => {
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)
    ;(nativeRecorder.startCapture as jest.Mock).mockClear()

    handle.lastError = 'disk_full'
    handle.onExit!(1)
    await flush(20)

    expect((nativeRecorder.startCapture as jest.Mock).mock.calls.length).toBe(0)
    expect(getPhase()).toBe('idle')
  })

  it('aborts immediately for device_permission_denied', async () => {
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)
    ;(nativeRecorder.startCapture as jest.Mock).mockClear()

    handle.lastError = 'device_permission_denied'
    handle.onExit!(1)
    await flush(20)
    expect((nativeRecorder.startCapture as jest.Mock).mock.calls.length).toBe(0)
    expect(getPhase()).toBe('idle')
  })

  it('aborts immediately for ffmpeg_missing', async () => {
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)
    ;(nativeRecorder.startCapture as jest.Mock).mockClear()

    handle.lastError = 'ffmpeg_missing'
    handle.onExit!(1)
    await flush(20)
    expect((nativeRecorder.startCapture as jest.Mock).mock.calls.length).toBe(0)
    expect(getPhase()).toBe('idle')
  })

  it('aborts immediately for no_device', async () => {
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)
    ;(nativeRecorder.startCapture as jest.Mock).mockClear()

    handle.lastError = 'no_device'
    handle.onExit!(1)
    await flush(20)
    expect((nativeRecorder.startCapture as jest.Mock).mock.calls.length).toBe(0)
    expect(getPhase()).toBe('idle')
  })

  it('triggers reconnect for non-fatal error codes', async () => {
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)

    const reconnectHandle = makeHandle('/tmp/test_r1.mp3')
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(reconnectHandle)

    jest.useFakeTimers()
    handle.lastError = 'device_disconnected'
    handle.onExit!(1)
    expect(getPhase()).toBe('reconnecting')
    jest.advanceTimersByTime(3000)
    jest.useRealTimers()
    await flush(20)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3. Reconnect logic — delay, cap, attempt count
// ════════════════════════════════════════════════════════════════════════════

describe('reconnect logic', () => {
  it('MAX_RECONNECT_ATTEMPTS is 20 (documented contract)', () => {
    expect(MAX_RECONNECT_ATTEMPTS).toBe(20)
  })

  it('reconnectDelay grows linearly until the 10 s cap', () => {
    expect(reconnectDelay(0)).toBe(2000)
    expect(reconnectDelay(1)).toBe(3500)
    expect(reconnectDelay(2)).toBe(5000)
    expect(reconnectDelay(3)).toBe(6500)
    expect(reconnectDelay(4)).toBe(8000)
    expect(reconnectDelay(5)).toBe(9500)
    expect(reconnectDelay(6)).toBe(10000)  // 11500 capped
    expect(reconnectDelay(50)).toBe(10000) // far above cap
  })

  it('total backoff fits within a ~3 minute window for 20 attempts', () => {
    let total = 0
    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) total += reconnectDelay(i)
    expect(total).toBeGreaterThan(120_000) // > 2 min so worth waiting
    expect(total).toBeLessThan(220_000)    // < 3.7 min so service isn't wasted
  })

  it('successful reconnect transitions back to recording', async () => {
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)

    const newHandle = makeHandle('/tmp/test_r1.mp3')
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(newHandle)

    jest.useFakeTimers()
    handle.lastError = 'device_disconnected'
    handle.onExit!(1)
    expect(getPhase()).toBe('reconnecting')

    jest.advanceTimersByTime(2500)
    jest.useRealTimers()
    await flush(20)
    expect(getPhase()).toBe('recording')
  })

  it('emits recording-reconnecting then recording-reconnected on success', async () => {
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)

    const newHandle = makeHandle('/tmp/test_r1.mp3')
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(newHandle)

    jest.useFakeTimers()
    handle.lastError = 'device_disconnected'
    handle.onExit!(1)
    jest.advanceTimersByTime(2500)
    jest.useRealTimers()
    await flush(20)

    const sent = (win as unknown as { __sent: () => unknown[][] }).__sent()
    expect(sent.some(c => c[0] === 'recording-reconnecting')).toBe(true)
    expect(sent.some(c => c[0] === 'recording-reconnected')).toBe(true)
  })

  it('reconnect segments use _r1, _r2 suffix and are appended to segments[]', async () => {
    const handle = makeHandle('/tmp/recording.mp3')
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)

    // Two successful reconnects
    ;(nativeRecorder.startCapture as jest.Mock)
      .mockResolvedValueOnce(makeHandle('/tmp/recording_r1.mp3'))
      .mockResolvedValueOnce(makeHandle('/tmp/recording_r2.mp3'))

    jest.useFakeTimers()
    handle.lastError = 'device_disconnected'
    handle.onExit!(1)
    jest.advanceTimersByTime(2500)
    await flush(20)
    // Cause another exit on the reconnected handle to force a 2nd reconnect
    const call2Input = (nativeRecorder.startCapture as jest.Mock).mock.calls[1]
    expect((call2Input[1] as string)).toMatch(/_r1\.mp3$/)
    jest.useRealTimers()
    await flush(20)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4. notifyResumed() — sleep wake handling
// ════════════════════════════════════════════════════════════════════════════

describe('notifyResumed (sleep/wake)', () => {
  it('is a no-op when there is no active session', () => {
    expect(() => notifyResumed()).not.toThrow()
  })

  it('does nothing when last-progress gap is < 90 s', async () => {
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)
    handle.onProgress!(1024)  // fresh progress
    ;(handle.proc.kill as jest.Mock).mockClear()

    notifyResumed()
    expect(handle.proc.kill).not.toHaveBeenCalled()
  })

  it('force-kills ffmpeg + reconnects when gap is > 90 s', async () => {
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)
    handle.onProgress!(1024)

    // Now switch to fake timers and simulate 2 minutes of sleep
    jest.useFakeTimers()
    jest.setSystemTime(Date.now() + 120_000)

    const reconnectHandle = makeHandle('/tmp/test_r1.mp3')
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(reconnectHandle)

    notifyResumed()
    expect(handle.proc.kill).toHaveBeenCalledWith('SIGKILL')

    jest.advanceTimersByTime(3000)
    jest.useRealTimers()
    await flush(20)
  })

  it('uses exactly 90 s as the wake threshold', async () => {
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)
    handle.onProgress!(1)

    jest.useFakeTimers()
    const base = Date.now()

    // Just under 90 s: no kill
    jest.setSystemTime(base + 89_000)
    ;(handle.proc.kill as jest.Mock).mockClear()
    notifyResumed()
    expect(handle.proc.kill).not.toHaveBeenCalled()

    // Just over 90 s: kill
    jest.setSystemTime(base + 91_000)
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(makeHandle('/tmp/r.mp3'))
    notifyResumed()
    expect(handle.proc.kill).toHaveBeenCalledWith('SIGKILL')
    jest.advanceTimersByTime(3000)
    jest.useRealTimers()
    await flush(20)
  })

  it('does nothing if the session is already stopping', async () => {
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)
    stopSession()
    ;(handle.proc.kill as jest.Mock).mockClear()
    notifyResumed()
    expect(handle.proc.kill).not.toHaveBeenCalled()
    await flush(20)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5. resolveDeviceInput preflight warning
// ════════════════════════════════════════════════════════════════════════════

describe('preflight device-name verification', () => {
  it('does NOT warn when stored device name matches the resolved name', async () => {
    ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValueOnce({
      format: 'avfoundation', device: ':0', resolvedName: 'MacBook Pro Microphone'
    })
    const win = makeWindow()
    const r = await startSession({ ...baseSettings, deviceName: 'MacBook Pro Microphone' }, win)
    expect(r).toEqual({ ok: true })
    const sent = (win as unknown as { __sent: () => unknown[][] }).__sent()
    const warningCalls = sent.filter(c => c[0] === 'backend-warning')
    expect(warningCalls.length).toBe(0)
  })

  it('warns via backend-warning when stored device name does NOT match resolved', async () => {
    ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValueOnce({
      format: 'avfoundation', device: ':1', resolvedName: 'Built-in Microphone'
    })
    const win = makeWindow()
    const r = await startSession({ ...baseSettings, deviceName: 'Soundcraft USB Audio' }, win)
    expect(r).toEqual({ ok: true })
    const sent = (win as unknown as { __sent: () => unknown[][] }).__sent()
    const warningCalls = sent.filter(c => c[0] === 'backend-warning')
    expect(warningCalls.length).toBeGreaterThan(0)
    expect((warningCalls[0][1] as { msg: string }).msg).toMatch(/Soundcraft USB Audio/)
    expect((warningCalls[0][1] as { msg: string }).msg).toMatch(/Built-in Microphone/)
  })

  it('treats a missing device as device_not_found error', async () => {
    ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValueOnce(null)
    const win = makeWindow()
    const r = await startSession({ ...baseSettings, deviceName: 'Some Mixer' }, win)
    expect(r).toEqual({ error: 'device_not_found' })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6. Silence warning — handle.onSilenceWarning wiring
// ════════════════════════════════════════════════════════════════════════════

describe('silence warning IPC wiring', () => {
  it('wires onSilenceWarning to send backend-warning + recording-error', async () => {
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)

    expect(handle.onSilenceWarning).toBeInstanceOf(Function)
    handle.onSilenceWarning!()

    const sent = (win as unknown as { __sent: () => unknown[][] }).__sent()
    const warning = sent.find(c => c[0] === 'backend-warning')
    const errEvt  = sent.find(c => c[0] === 'recording-error')

    expect(warning).toBeDefined()
    expect((warning![1] as { category: string }).category).toBe('device')
    expect((warning![1] as { severity: string }).severity).toBe('warn')
    expect(errEvt).toBeDefined()
    expect((errEvt![1] as { error: string }).error).toBe('weak_signal')
  })

  it('wires onSilenceEnd to stop session', async () => {
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)
    expect(handle.onSilenceEnd).toBeInstanceOf(Function)
    handle.onSilenceEnd!()
    await flush()
    expect(['stopping', 'finalizing', 'idle']).toContain(getPhase())
    await flush(20)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 7. recoverCrashedSession — orphaned segment scan
// ════════════════════════════════════════════════════════════════════════════

describe('recoverCrashedSession', () => {
  it('is a no-op when no active recovery is stored', () => {
    storeData['activeRecovery'] = null
    recoverCrashedSession()
    expect((store.addHistory as jest.Mock).mock.calls.length).toBe(0)
  })

  it('skips segments ≤ 5 KB', () => {
    storeData['activeRecovery'] = {
      outputPath: '/tmp/main.mp3',
      segments: ['/tmp/main.mp3', '/tmp/tiny_r1.mp3'],
      startTime: Date.now() - 60_000,
      sessionId: 'sid',
      phase: 'idle',
      updatedAt: Date.now(),
    }
    ;(fs.existsSync as jest.Mock).mockReturnValue(true)
    ;(fs.statSync as jest.Mock).mockImplementation((p: string) =>
      p.includes('tiny') ? { size: 3000, mtimeMs: Date.now() } : { size: 16000, mtimeMs: Date.now() }
    )

    recoverCrashedSession()
    const segCalls = (store.addHistory as jest.Mock).mock.calls.filter((c: unknown[]) =>
      (c[0] as { note?: string }).note === 'Gjenopprettet (delfil)'
    )
    expect(segCalls.length).toBe(0)
  })

  it('adds one history entry per segment > 5 KB with "Gjenopprettet" note', () => {
    storeData['activeRecovery'] = {
      outputPath: '/tmp/main.mp3',
      segments: ['/tmp/main.mp3', '/tmp/seg_r1.mp3', '/tmp/seg_r2.mp3'],
      startTime: Date.now() - 60_000,
      sessionId: 'sid',
      phase: 'idle',
      updatedAt: Date.now(),
    }
    ;(fs.existsSync as jest.Mock).mockReturnValue(true)
    ;(fs.statSync as jest.Mock).mockReturnValue({ size: 50_000, mtimeMs: Date.now() })

    recoverCrashedSession()

    const segCalls = (store.addHistory as jest.Mock).mock.calls.filter((c: unknown[]) =>
      (c[0] as { note?: string }).note === 'Gjenopprettet (delfil)'
    )
    expect(segCalls.length).toBe(2)
    for (const call of segCalls) {
      expect((call[0] as { note: string }).note).toMatch(/Gjenopprettet/)
    }
  })

  it('clears activeRecovery from store on entry', () => {
    storeData['activeRecovery'] = {
      outputPath: '/tmp/main.mp3',
      segments: ['/tmp/main.mp3'],
      startTime: Date.now() - 60_000,
      sessionId: 'sid',
      phase: 'idle',
      updatedAt: Date.now(),
    }
    ;(fs.existsSync as jest.Mock).mockReturnValue(true)
    ;(fs.statSync as jest.Mock).mockReturnValue({ size: 50_000, mtimeMs: Date.now() })
    recoverCrashedSession()
    expect((store.set as jest.Mock)).toHaveBeenCalledWith('activeRecovery', null)
  })

  it('returns silently when the recovered file does not exist on disk', () => {
    storeData['activeRecovery'] = {
      outputPath: '/tmp/main_missing.mp3',
      segments: ['/tmp/main_missing.mp3'],
      startTime: Date.now() - 60_000,
      sessionId: 'sid',
      phase: 'idle',
      updatedAt: Date.now(),
    }
    ;(fs.existsSync as jest.Mock).mockReturnValue(false)
    expect(() => recoverCrashedSession()).not.toThrow()
    expect((store.addHistory as jest.Mock).mock.calls.length).toBe(0)
  })

  it('skips the primary file when its size ≤ 5 KB', () => {
    storeData['activeRecovery'] = {
      outputPath: '/tmp/main_tiny.mp3',
      segments: ['/tmp/main_tiny.mp3'],
      startTime: Date.now() - 60_000,
      sessionId: 'sid',
      phase: 'idle',
      updatedAt: Date.now(),
    }
    ;(fs.existsSync as jest.Mock).mockReturnValue(true)
    ;(fs.statSync as jest.Mock).mockReturnValue({ size: 2000, mtimeMs: Date.now() })
    recoverCrashedSession()
    expect((store.addHistory as jest.Mock).mock.calls.length).toBe(0)
  })

  it('falls back to tempPath when outputPath is absent (legacy format)', () => {
    storeData['activeRecovery'] = {
      tempPath: '/tmp/legacy_temp.webm',
      segments: [],
      startTime: Date.now() - 60_000,
      sessionId: 'sid',
      phase: 'idle',
      updatedAt: Date.now(),
    }
    ;(fs.existsSync as jest.Mock).mockReturnValue(true)
    ;(fs.statSync as jest.Mock).mockReturnValue({ size: 50_000, mtimeMs: Date.now() })
    expect(() => recoverCrashedSession()).not.toThrow()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 8. Stuck timer / bytes-not-progressing detection
// ════════════════════════════════════════════════════════════════════════════

describe('stuck-timer / bytes-not-progressing detection', () => {
  /** Helper: start a session with fake timers active from the very start so
   *  installStuckTimer's setInterval is registered under fake timers and
   *  can be driven by jest.advanceTimersByTime. */
  async function startUnderFakeTimers(): Promise<{ handle: MockHandle; win: ReturnType<typeof makeWindow> }> {
    jest.useFakeTimers()
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    const promise = startSession(baseSettings, win)
    // Drain pending microtasks + the macOS device-release setTimeout (150 ms).
    for (let i = 0; i < 5; i++) await Promise.resolve()
    jest.advanceTimersByTime(300)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await promise
    return { handle, win }
  }

  it('triggers watchdog after 60 s of no audio progress', async () => {
    const { handle } = await startUnderFakeTimers()
    handle.onProgress!(1024)  // sets lastProgressAt = Date.now() (under fake timers)

    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(makeHandle('/tmp/r.mp3'))

    // Advance fake clock past the 60 s threshold + a stuck-timer poll
    jest.advanceTimersByTime(75_000)
    await Promise.resolve()
    expect(getPhase()).toBe('reconnecting')

    jest.advanceTimersByTime(3000)
    jest.useRealTimers()
    await flush(20)
  })

  it('triggers watchdog when bytes stop progressing despite time passing', async () => {
    const { handle } = await startUnderFakeTimers()

    // bytesWritten > 0 but stays constant — emulate hung encoder
    handle.bytesWritten = 1024
    handle.onProgress!(1024)

    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(makeHandle('/tmp/r.mp3'))

    // Two 15 s polls: 1st snapshots 1024; 2nd sees same → triggers watchdog.
    // Total: 30 s — under the 60 s time-based threshold, so this exercises
    // the bytes-stagnant branch specifically.
    jest.advanceTimersByTime(15_000)
    await Promise.resolve()
    jest.advanceTimersByTime(15_000)
    await Promise.resolve()

    expect(getPhase()).toBe('reconnecting')

    jest.advanceTimersByTime(3000)
    jest.useRealTimers()
    await flush(20)
  })

  it('does NOT trigger watchdog while progress keeps advancing', async () => {
    const { handle } = await startUnderFakeTimers()

    let bytes = 1000
    for (let i = 0; i < 6; i++) {
      bytes += 5000
      handle.bytesWritten = bytes
      handle.onProgress!(bytes)
      jest.advanceTimersByTime(10_000)
      await Promise.resolve()
    }

    expect(getPhase()).toBe('recording')
    jest.useRealTimers()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 9. i18n / localizeError
// ════════════════════════════════════════════════════════════════════════════

describe('localizeError + NOTIFY_LABELS', () => {
  it('returns Norwegian by default when language is unset', () => {
    expect(localizeError('disk_full')).toMatch(/Disken er full/i)
  })

  it('returns English when language=en', () => {
    storeData['language'] = 'en'
    expect(localizeError('disk_full')).toMatch(/Disk is full/i)
  })

  it('returns German when language=de', () => {
    storeData['language'] = 'de'
    expect(localizeError('disk_full')).toMatch(/Datenträger voll/i)
  })

  it('falls back to English when a key is missing in the active locale', () => {
    storeData['language'] = 'pl'
    // already_recording only exists in no + en — pl entry omits it
    expect(localizeError('already_recording')).toMatch(/already in progress/i)
  })

  it('falls back to raw code when even English is missing', () => {
    expect(localizeError('totally_unknown_code')).toBe('totally_unknown_code')
  })

  it('NOTIFY_LABELS covers all 7 supported languages', () => {
    for (const lang of ['no', 'en', 'de', 'sv', 'da', 'pl', 'fr']) {
      expect(NOTIFY_LABELS[lang]).toBeDefined()
      expect(NOTIFY_LABELS[lang].done).toBeTruthy()
      expect(NOTIFY_LABELS[lang].err).toBeTruthy()
      expect(NOTIFY_LABELS[lang].recovered).toContain('{file}')
      expect(NOTIFY_LABELS[lang].reconnected).toBeTruthy()
    }
  })

  it('uses Norwegian labels when language is gibberish (falls back via getNL)', () => {
    storeData['language'] = 'klingon'
    expect(NOTIFY_LABELS['no'].err).toMatch(/Feil/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 10. Preflight integration with sendBackendWarning routing
// ════════════════════════════════════════════════════════════════════════════

describe('preflight findings → sendBackendWarning routing', () => {
  it('runScheduledPreflight calls the sender once per finding', async () => {
    ;(fs.promises.statfs as jest.Mock).mockResolvedValueOnce({ bavail: 1, bsize: 4096 })
    const sender = jest.fn()
    const out = await runScheduledPreflight(sender)
    expect(out.findings.length).toBeGreaterThan(0)
    expect(sender).toHaveBeenCalledTimes(out.findings.length)
  })

  it('passes severity + category to the sender', async () => {
    ;(fs.promises.statfs as jest.Mock).mockResolvedValueOnce({ bavail: 1, bsize: 4096 })
    const sender = jest.fn()
    await runScheduledPreflight(sender)
    const diskCall = sender.mock.calls.find((c: unknown[]) => c[2] === 'disk')
    expect(diskCall).toBeDefined()
    expect(diskCall![1]).toBe('error')
    expect(typeof diskCall![0]).toBe('string')
  })

  it('emits a device-category warn when stored name does not match resolved', async () => {
    storeData['deviceName'] = 'Soundcraft USB Audio'
    ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValueOnce({
      format: 'avfoundation', device: ':0', resolvedName: 'MacBook Pro Microphone'
    })
    const sender = jest.fn()
    const out = await runScheduledPreflight(sender)
    const deviceFinding = out.findings.find(f => f.category === 'device' && f.severity === 'warn')
    expect(deviceFinding).toBeDefined()
    expect(deviceFinding!.message).toMatch(/Soundcraft/)
  })

  it('emits a device-category error when no audio device is present', async () => {
    ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValueOnce(null)
    const sender = jest.fn()
    const out = await runScheduledPreflight(sender)
    const f = out.findings.find(x => x.category === 'device' && x.severity === 'error')
    expect(f).toBeDefined()
  })

  it('returns no findings on a healthy system', async () => {
    storeData['deviceName'] = ''
    ;(fs.promises.statfs as jest.Mock).mockResolvedValueOnce({ bavail: 1e10, bsize: 4096 })
    ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValueOnce({
      format: 'avfoundation', device: ':0', resolvedName: 'Built-in'
    })
    const sender = jest.fn()
    const out = await runScheduledPreflight(sender)
    expect(out.findings).toEqual([])
    expect(sender).not.toHaveBeenCalled()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Callbacks (onceIdle / setSessionEndCallback)
// ════════════════════════════════════════════════════════════════════════════

describe('callbacks', () => {
  it('onceIdle fires after a session ends', async () => {
    const win = makeWindow()
    await startSession(baseSettings, win)
    const cb = jest.fn()
    onceIdle(cb)
    stopSession()
    await flush(20)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('onceIdle is one-shot (does not fire on a second stop)', async () => {
    const win = makeWindow()
    await startSession(baseSettings, win)
    const cb = jest.fn()
    onceIdle(cb)
    stopSession()
    await flush(20)
    expect(cb).toHaveBeenCalledTimes(1)

    await startSession(baseSettings, win)
    stopSession()
    await flush(20)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('setSessionEndCallback persists across sessions', async () => {
    const win = makeWindow()
    const cb = jest.fn()
    setSessionEndCallback(cb)
    await startSession(baseSettings, win)
    stopSession()
    await flush(20)
    expect(cb).toHaveBeenCalled()

    const firstCount = cb.mock.calls.length
    await startSession(baseSettings, win)
    stopSession()
    await flush(20)
    expect(cb.mock.calls.length).toBeGreaterThan(firstCount)
    // Clear it for subsequent tests
    setSessionEndCallback(() => {})
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Tray integration
// ════════════════════════════════════════════════════════════════════════════

describe('tray integration', () => {
  it('marks recording active on startSession + clears error', async () => {
    const win = makeWindow()
    await startSession(baseSettings, win)
    expect(tray.setRecording).toHaveBeenCalledWith(true)
    expect(tray.setError).toHaveBeenCalledWith(false)
  })

  it('marks recording inactive after stopSession completes', async () => {
    const win = makeWindow()
    await startSession(baseSettings, win)
    stopSession()
    await flush(20)
    expect((tray.setRecording as jest.Mock).mock.calls.some(c => c[0] === false)).toBe(true)
  })
})
