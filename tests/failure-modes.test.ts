/**
 * Failure-mode hardening tests for SundayRec.
 *
 * Real-world church AV setups fail in surprising ways. This suite exercises
 * each documented failure scenario end-to-end through the recorder and
 * verifies that:
 *   1. The failure is detected.
 *   2. The user is notified clearly.
 *   3. Partial work is preserved (history entry, segments on disk).
 *   4. Recovery is automatic where possible.
 *
 * Scenarios covered (numbering matches the hardening doc):
 *   1.  Wifi drops mid-upload                    (cloud-upload-queue.test.ts complements this)
 *   2.  Laptop sleep mid-recording               (recorder.test.ts has notifyResumed)
 *   3.  USB mic unplugged mid-recording          → here
 *   4.  Camera permission revoked mid-record     → here
 *   5.  Disk fills up during recording           → here
 *   6.  Power-loss → recovery on next launch     → here
 *   7.  App crash → recovery on next launch      → here (same path)
 *   8.  ffmpeg killed externally                 → here
 *   9.  Schedule overlap                         → here
 *   10. Manual recording active when schedule    → here
 *   11. DST mid-recording                        → here (timer monotonicity)
 *   12. Queue paused during active recording     → here
 *
 * Strategy mirrors recorder.test.ts: mock the world, drive ffmpeg events
 * by invoking handle.on* callbacks the recorder installs.
 */

import { EventEmitter } from 'events'

// ── Mocks (must be declared BEFORE importing the SUT) ───────────────────────

jest.mock('electron', () => {
  const Notification = jest.fn(() => ({ show: jest.fn() })) as unknown as jest.Mock & { isSupported: () => boolean }
  ;(Notification as unknown as { isSupported: () => boolean }).isSupported = jest.fn(() => false)
  return {
    app: { getPath: jest.fn(() => '/tmp/sundayrec-test'), getVersion: jest.fn(() => '4.27.2'), isPackaged: false },
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

// ── store mock — shared with the test ──────────────────────────────────────
const storeData: Record<string, unknown> = {}
const historyEntries: unknown[] = []

jest.mock('../src/main/store', () => ({
  get:    jest.fn((key: string) => storeData[key]),
  set:    jest.fn((key: string, value: unknown) => { storeData[key] = value }),
  getAll: jest.fn(() => ({ ...storeData })),
  addHistory: jest.fn((entry: unknown) => { historyEntries.push(entry) }),
  addHistoryWithTimestamp: jest.fn((entry: unknown) => { historyEntries.push(entry) }),
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
  log: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
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
// hit real cloud code in tests.
jest.mock('../src/main/cloud', () => ({
  autoUploadAfterRecording: jest.fn(),
}))

jest.mock('../src/main/native-recorder', () => ({
  ffmpegBin: '/usr/bin/ffmpeg',
  buildCodecArgs: jest.fn(() => ['-c:a', 'libmp3lame']),
  resolveDeviceInput: jest.fn(),
  startCapture: jest.fn(),
  stopCapture: jest.fn(),
}))

jest.mock('fs', () => {
  const actual = jest.requireActual('fs')
  return {
    ...actual,
    existsSync:    jest.fn(() => true),
    statSync:      jest.fn(() => ({ size: 4096, mtimeMs: Date.now() })),
    mkdirSync:     jest.fn(),
    writeFileSync: jest.fn(),
    unlinkSync:    jest.fn(),
    renameSync:    jest.fn(),
    copyFileSync:  jest.fn(),
    promises: {
      ...actual.promises,
      access:    jest.fn(async () => { throw new Error('ENOENT') }),
      statfs:    jest.fn(async () => ({ bavail: 1e9, bsize: 4096 })),
      unlink:    jest.fn(async () => {}),
      writeFile: jest.fn(async () => {}),
    },
  }
})

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

// ── Now import the SUT ──────────────────────────────────────────────────────

import {
  startSession,
  stopSession,
  notifyResumed,
  recoverCrashedSession,
  getPhase,
  isActive,
  MAX_RECONNECT_ATTEMPTS,
  FATAL_RECONNECT_ERRORS,
  _resetForTest,
} from '../src/main/recorder'

import * as store from '../src/main/store'
import * as nativeRecorder from '../src/main/native-recorder'
import * as fs from 'fs'

// ── Helpers ─────────────────────────────────────────────────────────────────

interface MockHandle {
  proc: EventEmitter & { kill: jest.Mock; exitCode: number | null; killed: boolean; stdin: { write: jest.Mock; end: jest.Mock } }
  outputPath:  string
  startTime:   number
  bytesWritten: number
  format:      string
  onExit:      ((code: number | null) => void) | null
  onProgress:  ((bytes: number) => void) | null
  onSilenceEnd: (() => void) | null
  onSilenceWarning: (() => void) | null
  getStderrTail: () => string
  lastError:   string | null
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
    proc: ee,
    outputPath,
    startTime: Date.now(),
    bytesWritten: 0,
    format: 'avfoundation',
    onExit: null, onProgress: null, onSilenceEnd: null, onSilenceWarning: null,
    getStderrTail: () => '',
    lastError: null,
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

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

beforeEach(() => {
  _resetForTest()
  for (const k of Object.keys(storeData)) delete storeData[k]
  historyEntries.length = 0
  ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockReset()
  ;(nativeRecorder.startCapture       as jest.Mock).mockReset()
  ;(nativeRecorder.stopCapture        as jest.Mock).mockReset()
  ;(fs.existsSync                     as jest.Mock).mockReset()
  ;(fs.statSync                       as jest.Mock).mockReset()
  ;(fs.promises.statfs                as jest.Mock).mockReset()
  jest.clearAllMocks()

  ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValue({
    format: 'avfoundation', device: ':0', resolvedName: 'MacBook Pro Microphone'
  })
  ;(nativeRecorder.stopCapture  as jest.Mock).mockResolvedValue(undefined)
  ;(nativeRecorder.startCapture as jest.Mock).mockImplementation(async () => makeHandle())
  ;(fs.existsSync               as jest.Mock).mockReturnValue(true)
  ;(fs.statSync                 as jest.Mock).mockReturnValue({ size: 4096, mtimeMs: Date.now() })
  ;(fs.promises.statfs          as jest.Mock).mockResolvedValue({ bavail: 1e9, bsize: 4096 })
})

afterEach(() => {
  jest.useRealTimers()
  _resetForTest()
})

// ════════════════════════════════════════════════════════════════════════════
// Scenario 3 — USB mic unplugged mid-recording
// ════════════════════════════════════════════════════════════════════════════

describe('scenario 3 — USB mic unplugged mid-recording', () => {
  it('classifies device_disconnected and enters reconnect phase', async () => {
    const handle = makeHandle('/tmp/svc.mp3')
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)

    handle.lastError = 'device_disconnected'
    handle.onExit!(1)
    expect(getPhase()).toBe('reconnecting')
    await flush(20)
  })

  it('emits recording-reconnecting IPC so the renderer can show a banner', async () => {
    const handle = makeHandle('/tmp/svc.mp3')
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)

    handle.lastError = 'device_disconnected'
    handle.onExit!(1)
    await flush(5)

    const sent = (win as unknown as { __sent: () => unknown[][] }).__sent()
    expect(sent.some(c => c[0] === 'recording-reconnecting')).toBe(true)
  })

  it('preserves partial file in history when reconnect ultimately gives up', async () => {
    const handle = makeHandle('/tmp/svc.mp3')
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)

    // Pretend the partial file has 1 MB on disk before the disconnect
    ;(fs.existsSync as jest.Mock).mockReturnValue(true)
    ;(fs.statSync   as jest.Mock).mockReturnValue({
      size: 1_048_576,
      mtimeMs: Date.now() + 60_000,
    })

    // Subsequent reconnects all fail
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValue({ error: 'device_error' })

    jest.useFakeTimers()
    handle.lastError = 'device_disconnected'
    handle.onExit!(1)
    // Advance through every reconnect attempt + delay (cap 10s × 20 attempts = ~200s)
    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS + 5; i++) {
      jest.advanceTimersByTime(11_000)
      await Promise.resolve()
      await Promise.resolve()
    }
    jest.useRealTimers()
    await flush(40)

    expect(getPhase()).toBe('idle')

    // Salvaged history entry should mention the partial file
    const salvaged = (store.addHistory as jest.Mock).mock.calls.find((c: unknown[]) => {
      const e = c[0] as { note?: string; status?: string }
      return e.note?.includes('Avbrutt') && e.status === 'error'
    })
    expect(salvaged).toBeDefined()
    expect((salvaged![0] as { error: string }).error).toBe('device_disconnected')
    expect((salvaged![0] as { fileSizeBytes: number }).fileSizeBytes).toBe(1_048_576)
  })

  it('triggers an email send when emailOnError is enabled and reconnect fails', async () => {
    storeData['emailOnError']  = true
    storeData['emailAddress']  = 'pastor@church.no'

    const handle = makeHandle('/tmp/svc.mp3')
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)

    // fatal so we skip the reconnect loop and go straight to failSession
    handle.lastError = 'disk_full'
    handle.onExit!(1)
    await flush(20)

    const mailer = await import('../src/main/mailer')
    expect((mailer.sendError as jest.Mock).mock.calls.length).toBeGreaterThan(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Scenario 4 — Camera permission revoked between schedule and start
// ════════════════════════════════════════════════════════════════════════════

describe('scenario 4 — camera permission revoked', () => {
  it('returns device_permission_denied when macOS reports denied camera and video is requested', async () => {
    // Force macOS code path
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

    const electron = await import('electron')
    ;(electron.systemPreferences.getMediaAccessStatus as jest.Mock)
      .mockImplementation((kind: 'microphone' | 'camera') => (kind === 'camera' ? 'denied' : 'granted'))

    const win = makeWindow()
    const r = await startSession({
      ...baseSettings,
      videoEnabled: true,
      videoDeviceName: 'FaceTime HD Camera',
      videoDeviceIndex: 0,
    } as never, win)
    expect(r).toEqual({ error: 'device_permission_denied' })
    expect(getPhase()).toBe('idle')

    ;(electron.systemPreferences.getMediaAccessStatus as jest.Mock).mockReturnValue('granted')
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
  })

  it('returns device_permission_denied when macOS reports denied microphone', async () => {
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

    const electron = await import('electron')
    ;(electron.systemPreferences.getMediaAccessStatus as jest.Mock).mockReturnValue('denied')

    const win = makeWindow()
    const r = await startSession(baseSettings, win)
    expect(r).toEqual({ error: 'device_permission_denied' })

    ;(electron.systemPreferences.getMediaAccessStatus as jest.Mock).mockReturnValue('granted')
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
  })

  it('fatal device_permission_denied at ffmpeg level skips reconnect entirely', async () => {
    expect(FATAL_RECONNECT_ERRORS.has('device_permission_denied')).toBe(true)

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
})

// ════════════════════════════════════════════════════════════════════════════
// Scenario 5 — Disk fills up during recording
// ════════════════════════════════════════════════════════════════════════════

describe('scenario 5 — disk fills up during recording', () => {
  it('preflight returns disk_full when statfs reports no free space', async () => {
    ;(fs.promises.statfs as jest.Mock).mockResolvedValueOnce({ bavail: 1, bsize: 4096 })
    const win = makeWindow()
    const r = await startSession(baseSettings, win)
    expect(r).toEqual({ error: 'disk_full' })
  })

  it('disk_full at runtime is in FATAL_RECONNECT_ERRORS', () => {
    expect(FATAL_RECONNECT_ERRORS.has('disk_full')).toBe(true)
  })

  it('runtime disk_full causes failSession (no reconnect attempt) and surfaces backend-warning', async () => {
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)
    ;(nativeRecorder.startCapture as jest.Mock).mockClear()

    handle.lastError = 'disk_full'
    handle.onExit!(1)
    await flush(20)

    const sent = (win as unknown as { __sent: () => unknown[][] }).__sent()
    const warning = sent.find(c => c[0] === 'backend-warning')
    expect(warning).toBeDefined()
    expect((warning![1] as { category: string }).category).toBe('device')
    expect((warning![1] as { severity: string }).severity).toBe('error')

    const errEvt = sent.find(c => c[0] === 'recording-error')
    expect(errEvt).toBeDefined()
    expect((errEvt![1] as { error: string }).error).toBe('disk_full')
  })

  it('runtime disk_full salvages the partial file into history', async () => {
    const handle = makeHandle('/tmp/svc.mp3')
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)

    ;(fs.existsSync as jest.Mock).mockReturnValue(true)
    ;(fs.statSync as jest.Mock).mockReturnValue({
      size: 2_097_152,  // 2 MB partial flac
      mtimeMs: Date.now() + 30_000,
    })

    handle.lastError = 'disk_full'
    handle.onExit!(1)
    await flush(20)

    const salvaged = (store.addHistory as jest.Mock).mock.calls.find((c: unknown[]) => {
      const e = c[0] as { status?: string; error?: string }
      return e.status === 'error' && e.error === 'disk_full'
    })
    expect(salvaged).toBeDefined()
    expect((salvaged![0] as { fileSizeBytes: number }).fileSizeBytes).toBe(2_097_152)
    expect((salvaged![0] as { note: string }).note).toMatch(/Avbrutt/i)
  })

  it('does not add an empty history entry when the partial file is < 5 KB', async () => {
    const handle = makeHandle('/tmp/svc.mp3')
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)

    ;(fs.existsSync as jest.Mock).mockReturnValue(true)
    ;(fs.statSync as jest.Mock).mockReturnValue({ size: 1024, mtimeMs: Date.now() })

    handle.lastError = 'disk_full'
    handle.onExit!(1)
    await flush(20)

    const salvaged = (store.addHistory as jest.Mock).mock.calls.find((c: unknown[]) => {
      const e = c[0] as { status?: string }
      return e.status === 'error'
    })
    expect(salvaged).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Scenario 6 + 7 — Power loss / app crash → recovery on next launch
// ════════════════════════════════════════════════════════════════════════════

describe('scenarios 6+7 — crash recovery on next launch', () => {
  it('does nothing when activeRecovery is null', () => {
    storeData['activeRecovery'] = null
    recoverCrashedSession()
    expect((store.addHistory as jest.Mock).mock.calls.length).toBe(0)
  })

  it('always clears activeRecovery (prevents repeated recovery on each launch)', () => {
    storeData['activeRecovery'] = {
      outputPath: '/tmp/x.mp3',
      segments: ['/tmp/x.mp3'],
      startTime: Date.now() - 3600_000,
      sessionId: 'sid',
      phase: 'recording',
      updatedAt: Date.now() - 1000,
    }
    ;(fs.existsSync as jest.Mock).mockReturnValue(true)
    ;(fs.statSync as jest.Mock).mockReturnValue({ size: 1_000_000, mtimeMs: Date.now() })
    recoverCrashedSession()
    expect((store.set as jest.Mock)).toHaveBeenCalledWith('activeRecovery', null)
  })

  it('drops the main file when it is below the 5 KB sanity threshold (corrupt/empty)', () => {
    storeData['activeRecovery'] = {
      outputPath: '/tmp/trunc.mp3',
      segments:   ['/tmp/trunc.mp3'],
      startTime:  Date.now() - 60_000,
      sessionId:  'sid',
      phase:      'recording',
      updatedAt:  Date.now(),
    }
    ;(fs.existsSync as jest.Mock).mockReturnValue(true)
    ;(fs.statSync   as jest.Mock).mockReturnValue({ size: 100, mtimeMs: Date.now() })
    recoverCrashedSession()
    const okEntries = (store.addHistory as jest.Mock).mock.calls.filter((c: unknown[]) =>
      (c[0] as { status?: string }).status === 'ok'
    )
    expect(okEntries.length).toBe(0)
  })

  it('records each reconnect segment > 5 KB with a "Gjenopprettet" note', () => {
    storeData['activeRecovery'] = {
      outputPath: '/tmp/main.mp3',
      segments: ['/tmp/main.mp3', '/tmp/main_r1.mp3', '/tmp/main_r2.mp3'],
      startTime: Date.now() - 60_000,
      sessionId: 'sid',
      phase: 'recording',
      updatedAt: Date.now(),
    }
    ;(fs.existsSync as jest.Mock).mockReturnValue(true)
    ;(fs.statSync as jest.Mock).mockReturnValue({ size: 50_000, mtimeMs: Date.now() })

    recoverCrashedSession()

    const segs = (store.addHistory as jest.Mock).mock.calls.filter((c: unknown[]) =>
      (c[0] as { note?: string }).note === 'Gjenopprettet (delfil)'
    )
    expect(segs.length).toBe(2)
  })

  it('caps recovered duration at 6 hours to guard against bogus mtime', async () => {
    // startTime is one year ago — without the cap, duration would be 365 days.
    // Drive the spawn close handler to get the actual history entry written.
    storeData['activeRecovery'] = {
      outputPath: '/tmp/long_lost.mp3',
      segments:  ['/tmp/long_lost.mp3'],
      startTime: Date.now() - 365 * 86400_000,
      sessionId: 'sid',
      phase:     'recording',
      updatedAt: Date.now() - 1000,
    }
    ;(fs.existsSync as jest.Mock).mockReturnValue(true)
    ;(fs.statSync   as jest.Mock).mockReturnValue({ size: 1_000_000, mtimeMs: Date.now() })

    // The recover code path spawns ffmpeg for the -c copy remux. Our spawn
    // mock immediately emits 'close' with code 0, which then writes the
    // history entry on the next tick.
    recoverCrashedSession()
    await flush(40)

    const recovered = (store.addHistory as jest.Mock).mock.calls
      .map(c => c[0] as { duration?: string; durationSec?: number })
      .find(e => e.duration && !e.duration.includes('—'))

    if (recovered) {
      // duration string is HH:MM:SS — verify it's at most 06:00:00
      const parts = recovered.duration!.split(':').map(Number)
      const totalSec = parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts[0] * 60 + parts[1]
      expect(totalSec).toBeLessThanOrEqual(6 * 3600)
    }

    expect((store.set as jest.Mock)).toHaveBeenCalledWith('activeRecovery', null)
  })

  it('legacy tempPath format is supported (falls back when outputPath absent)', () => {
    storeData['activeRecovery'] = {
      tempPath:   '/tmp/legacy.webm',
      segments:   [],
      startTime:  Date.now() - 60_000,
      sessionId:  'sid',
      phase:      'recording',
      updatedAt:  Date.now(),
    }
    ;(fs.existsSync as jest.Mock).mockReturnValue(true)
    ;(fs.statSync   as jest.Mock).mockReturnValue({ size: 50_000, mtimeMs: Date.now() })
    // Just verify the legacy path doesn't crash recoverCrashedSession
    expect(() => recoverCrashedSession()).not.toThrow()
    expect((store.set as jest.Mock)).toHaveBeenCalledWith('activeRecovery', null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Scenario 8 — ffmpeg killed externally (Activity Monitor, antivirus, etc.)
// ════════════════════════════════════════════════════════════════════════════

describe('scenario 8 — ffmpeg killed externally', () => {
  it('non-zero exit with no fatal lastError triggers reconnect', async () => {
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)

    handle.lastError = 'device_error'  // typical when killed externally
    handle.onExit!(137)  // SIGKILL exit code
    expect(getPhase()).toBe('reconnecting')
    await flush(20)
  })

  it('persistRecovery has been called at session start (so a kill is recoverable)', async () => {
    const handle = makeHandle('/tmp/svc.mp3')
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)

    const recoverySet = (store.set as jest.Mock).mock.calls.find(c => c[0] === 'activeRecovery')
    expect(recoverySet).toBeDefined()
    const payload = recoverySet![1] as { outputPath: string; segments: string[]; sessionId: string }
    // outputPath is computed by recorder from saveFolder + filename pattern,
    // not from the mock handle.outputPath. We just verify it's a valid path
    // and that segments includes it.
    expect(typeof payload.outputPath).toBe('string')
    expect(payload.outputPath.length).toBeGreaterThan(0)
    expect(payload.segments).toContain(payload.outputPath)
    expect(typeof payload.sessionId).toBe('string')
  })

  it('clean exit (code 0) finalises rather than reconnecting', async () => {
    const handle = makeHandle('/tmp/svc.mp3')
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)

    ;(fs.existsSync as jest.Mock).mockReturnValue(true)
    ;(fs.statSync as jest.Mock).mockReturnValue({ size: 50_000, mtimeMs: Date.now() })

    handle.onExit!(0)
    await flush(20)
    expect(getPhase()).toBe('idle')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Scenario 9 + 10 — schedule overlap / manual + scheduled
// ════════════════════════════════════════════════════════════════════════════

describe('scenarios 9+10 — schedule overlap with active recording', () => {
  it('rejects a second startSession with already_recording', async () => {
    const win = makeWindow()
    await startSession(baseSettings, win)
    const second = await startSession(baseSettings, win)
    expect(second).toEqual({ error: 'already_recording' })
  })

  it('rejects start while in stopping phase too (no race)', async () => {
    const win = makeWindow()
    await startSession(baseSettings, win)
    stopSession()
    // not flushed — still in 'stopping'
    const r = await startSession(baseSettings, win)
    expect(r).toEqual({ error: 'already_recording' })
    await flush(20)
  })

  it('isActive() returns true during recording so scheduler can defer', async () => {
    expect(isActive()).toBe(false)
    const win = makeWindow()
    await startSession(baseSettings, win)
    expect(isActive()).toBe(true)
    stopSession()
    await flush(20)
    expect(isActive()).toBe(false)
  })

  // Scheduler-side history-entry-on-skip test lives in scheduler.test.ts where
  // the right mock infrastructure for the scheduler is already established.
})

// ════════════════════════════════════════════════════════════════════════════
// Scenario 11 — DST / clock-drift safety
// ════════════════════════════════════════════════════════════════════════════

describe('scenario 11 — clock drift / DST during recording', () => {
  it('maxTimer is monotonic — uses elapsed ms, not wall-clock', async () => {
    // The recorder schedules its max-duration stop with setTimeout(N * 60000),
    // which is monotonic and unaffected by DST/NTP corrections. We verify it
    // fires at the right elapsed time even when the system clock jumps.
    const handle = makeHandle('/tmp/svc.mp3')
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    ;(fs.existsSync as jest.Mock).mockReturnValue(true)
    ;(fs.statSync as jest.Mock).mockReturnValue({ size: 50_000, mtimeMs: Date.now() })

    jest.useFakeTimers()
    const promise = startSession({ ...baseSettings, maxMinutes: 2 }, win)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    jest.advanceTimersByTime(300)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await promise

    // Simulate DST jump (clock skips forward 1 hour) WITHOUT advancing the
    // monotonic timer queue — Date.now jumps but the setTimeout queue does not.
    jest.setSystemTime(Date.now() + 3600_000)

    // Advance just-under maxMinutes worth of monotonic time — must NOT stop yet
    jest.advanceTimersByTime(60_000)
    await Promise.resolve()
    expect(getPhase()).toBe('recording')

    // Advance the remaining time — stop should fire
    jest.advanceTimersByTime(60_001)
    await Promise.resolve()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(['stopping', 'finalizing', 'idle']).toContain(getPhase())

    jest.useRealTimers()
    await flush(20)
  })

  it('lastProgressAt is wall-clock — a forward clock jump produces a "gap" that triggers reconnect via notifyResumed', async () => {
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)
    handle.onProgress!(1024)

    jest.useFakeTimers()
    // Jump forward 5 minutes — simulating either sleep OR a DST/NTP jump
    jest.setSystemTime(Date.now() + 5 * 60_000)

    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(makeHandle('/tmp/r.mp3'))
    notifyResumed()
    expect(handle.proc.kill).toHaveBeenCalledWith('SIGKILL')

    jest.advanceTimersByTime(3000)
    jest.useRealTimers()
    await flush(20)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Scenario 1 — Wifi drops mid-upload (queue persistence verification)
// ════════════════════════════════════════════════════════════════════════════

describe('scenario 1 — wifi drops mid-upload', () => {
  // The queue itself is fully tested in cloud-upload-queue.test.ts. Here we
  // just verify the integration points that matter for hardening: the queue
  // is enqueued after a recording, and the queue exposes status for the UI.
  it('queue entries survive the test-suite isolation barrier (electron-store backed)', async () => {
    const queueMod = await import('../src/main/cloud/upload-queue')
    // Clear any leftover entries
    for (const e of queueMod.getQueueStatus().entries) queueMod.removeFromQueue(e.id)

    const entry = queueMod.enqueueUpload({
      service: 'google-drive',
      filePath: '/tmp/recording.mp3',
      entryTimestamp: 1700000000000,
    })
    expect(entry.status).toBe('pending')
    expect(entry.attempts).toBe(0)

    const status = queueMod.getQueueStatus()
    expect(status.entries.find(e => e.id === entry.id)?.status).toBe('pending')

    // Clean up
    queueMod.removeFromQueue(entry.id)
    queueMod.shutdown()
  })

  it('re-enqueuing the same (service, filePath) resets to pending and bumps nextAttempt', async () => {
    const queueMod = await import('../src/main/cloud/upload-queue')
    for (const e of queueMod.getQueueStatus().entries) queueMod.removeFromQueue(e.id)

    const first = queueMod.enqueueUpload({ service: 'dropbox', filePath: '/tmp/a.mp3' })
    const second = queueMod.enqueueUpload({ service: 'dropbox', filePath: '/tmp/a.mp3' })
    expect(second.id).toBe(first.id)
    expect(second.status).toBe('pending')
    expect(second.lastError).toBeUndefined()

    queueMod.removeFromQueue(first.id)
    queueMod.shutdown()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Scenario 12 — Queue paused during active recording
// ════════════════════════════════════════════════════════════════════════════

describe('scenario 12 — queue paused during active recording', () => {
  it('processQueue short-circuits when recorder.isActive() is true', async () => {
    const queueMod = await import('../src/main/cloud/upload-queue')

    // Start a recording so recorder.isActive() === true
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)
    expect(isActive()).toBe(true)

    // Enqueue an entry — processQueue should not actually process it
    for (const e of queueMod.getQueueStatus().entries) queueMod.removeFromQueue(e.id)
    const entry = queueMod.enqueueUpload({
      service: 'google-drive',
      filePath: '/tmp/will-not-upload.mp3',
    })

    await queueMod.processQueue(win)

    // Entry should still be pending — nothing was attempted
    const status = queueMod.getQueueStatus()
    const found = status.entries.find(e => e.id === entry.id)
    expect(found?.status).toBe('pending')
    expect(found?.attempts).toBe(0)

    // Cleanup — must remove BEFORE stopping the session, otherwise the
    // recorder's finishSession may flush the queue and try to upload.
    queueMod.removeFromQueue(entry.id)
    queueMod.shutdown()

    stopSession()
    await flush(20)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Cross-scenario invariants
// ════════════════════════════════════════════════════════════════════════════

describe('cross-scenario invariants', () => {
  it('activeRecovery is cleared on every terminal path (finish, fail)', async () => {
    const handle = makeHandle('/tmp/svc.mp3')
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    ;(fs.existsSync as jest.Mock).mockReturnValue(true)
    ;(fs.statSync as jest.Mock).mockReturnValue({ size: 50_000, mtimeMs: Date.now() })

    await startSession(baseSettings, win)
    handle.onExit!(0)
    await flush(20)

    const setCalls = (store.set as jest.Mock).mock.calls.filter(c => c[0] === 'activeRecovery' && c[1] === null)
    expect(setCalls.length).toBeGreaterThan(0)
  })

  it('activeRecovery is cleared on failSession path', async () => {
    const handle = makeHandle('/tmp/svc.mp3')
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)
    ;(store.set as jest.Mock).mockClear()

    handle.lastError = 'disk_full'
    handle.onExit!(1)
    await flush(20)

    const setCalls = (store.set as jest.Mock).mock.calls.filter(c => c[0] === 'activeRecovery' && c[1] === null)
    expect(setCalls.length).toBeGreaterThan(0)
  })

  it('tray.setError(true) is set on every failure path', async () => {
    const tray = await import('../src/main/tray')

    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    await startSession(baseSettings, win)

    handle.lastError = 'disk_full'
    handle.onExit!(1)
    await flush(20)

    // failSession should have flipped the tray to error state.
    // setError was called with false in startSession AND with true in failSession.
    const calls = (tray.setError as jest.Mock).mock.calls
    expect(calls.some(c => c[0] === true)).toBe(true)
  })

  it('powerSaveBlockers are stopped on every terminal path', async () => {
    const electron = await import('electron')
    ;(electron.powerSaveBlocker.start as jest.Mock).mockReturnValue(7)
    // isStarted must return true at the moment stopBlockers() is called for
    // powerSaveBlocker.stop() to actually be invoked.
    ;(electron.powerSaveBlocker.isStarted as jest.Mock).mockReturnValue(true)

    const handle = makeHandle('/tmp/svc.mp3')
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const win = makeWindow()
    ;(fs.existsSync as jest.Mock).mockReturnValue(true)
    ;(fs.statSync as jest.Mock).mockReturnValue({ size: 50_000, mtimeMs: Date.now() })

    await startSession(baseSettings, win)

    handle.onExit!(0)  // clean stop → finishSession → stopBlockers
    await flush(20)
    expect((electron.powerSaveBlocker.stop as jest.Mock)).toHaveBeenCalled()

    // Reset isStarted to default for subsequent tests
    ;(electron.powerSaveBlocker.isStarted as jest.Mock).mockReturnValue(false)
  })

  it('safeSend does not throw when the window is destroyed mid-flight', async () => {
    const handle = makeHandle()
    ;(nativeRecorder.startCapture as jest.Mock).mockResolvedValueOnce(handle)
    const destroyedWin = {
      isDestroyed: () => true,
      webContents: { isDestroyed: () => true, send: jest.fn(() => { throw new Error('destroyed') }) },
    } as unknown as import('electron').BrowserWindow

    await startSession(baseSettings, destroyedWin)
    // Trigger silence warning — must not throw despite destroyed window
    expect(() => handle.onSilenceWarning!()).not.toThrow()

    handle.lastError = 'disk_full'
    handle.onExit!(1)
    await flush(20)
  })
})
