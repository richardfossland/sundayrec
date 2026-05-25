import { execFile } from 'child_process'
import { powerSaveBlocker } from 'electron'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const electronMock = require('electron') as typeof import('electron') & {
  powerMonitor: { __emitResume(): void; __resetListeners(): void }
}
import { reschedule, _resetSchedulingCache, testWake, cancelTestWake, isTestWakeActive } from '../src/main/wake'
import * as store from '../src/main/store'

// electron is mocked via moduleNameMapper in jest.config.ts — do NOT use
// jest.mock('electron'), which causes Jest to auto-mock object methods (replacing
// our __emitResume with a no-op jest.fn).
jest.mock('child_process', () => ({ execFile: jest.fn() }))
jest.mock('../src/main/store', () => ({
  get: jest.fn(),
  set: jest.fn(),
  addWakeFailureEntry: jest.fn(),
}))

const mockExecFile = execFile as unknown as jest.Mock
const mockGet = store.get as unknown as jest.Mock

const HOST_PLATFORM = process.platform

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

beforeEach(() => {
  jest.clearAllMocks()
  _resetSchedulingCache()
  electronMock.powerMonitor.__resetListeners()
  // execFile callback-style mock that auto-succeeds (used by promisify)
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1]
    if (typeof cb === 'function') (cb as Function)(null, { stdout: '', stderr: '' })
  })
  // wakeFromSleep enabled by default
  mockGet.mockImplementation((key: string) => key === 'wakeFromSleep' ? true : null)
})

afterEach(() => {
  setPlatform(HOST_PLATFORM)
  // Make sure no test-wake state leaks between tests
  cancelTestWake()
  jest.useRealTimers()
})

// ─── wakeFromSleep setting ────────────────────────────────────────────────────

describe('reschedule — wakeFromSleep setting', () => {
  it('returns disabled when wakeFromSleep is false', async () => {
    mockGet.mockReturnValue(false)
    const result = await reschedule([new Date(Date.now() + 3_600_000)])
    expect(result).toEqual({ ok: false, reason: 'disabled' })
  })

  it('calls store.get with wakeFromSleep key', async () => {
    setPlatform('linux')
    await reschedule([])
    expect(mockGet).toHaveBeenCalledWith('wakeFromSleep')
  })
})

// ─── platform routing ─────────────────────────────────────────────────────────

describe('reschedule — platform routing', () => {
  it('returns unsupported on linux', async () => {
    setPlatform('linux')
    const result = await reschedule([new Date(Date.now() + 3_600_000)])
    expect(result).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('returns count:0 on darwin when no upcoming dates pass', async () => {
    setPlatform('darwin')
    const result = await reschedule([])
    expect(result).toEqual({ ok: true, count: 0, nextWake: null })
  })

  it('returns count:0 on win32 when no upcoming dates pass', async () => {
    setPlatform('win32')
    const result = await reschedule([])
    expect(result).toEqual({ ok: true, count: 0, nextWake: null })
  })
})

// ─── macOS pmset date format (formatPmsetDate) ────────────────────────────────

describe('reschedule — darwin pmset date formatting', () => {
  beforeEach(() => setPlatform('darwin'))

  it('formats the wake date as MM/DD/YY HH:MM:00 for pmset', async () => {
    // wakePoint = 2026-05-17 11:00 local → upcomingDate = wakePoint + LEAD_MINUTES (10 min)
    const wakePoint    = new Date(2026, 4, 17, 11, 0, 0)
    const upcomingDate = new Date(wakePoint.getTime() + 10 * 60 * 1000)

    jest.useFakeTimers()
    jest.setSystemTime(new Date(2026, 4, 17, 10, 0, 0)) // "now" is 10:00, wake is 11:00

    await reschedule([upcomingDate])

    // calls[0] = cancelall, calls[1] = schedule wake
    const scheduleCall = mockExecFile.mock.calls.find(
      (c: unknown[]) => c[0] === 'pmset' && (c[1] as string[])[1] === 'wake'
    )
    expect(scheduleCall).toBeDefined()
    expect((scheduleCall![1] as string[])[2]).toBe('05/17/26 11:00:00')
  })

  it('zero-pads single-digit month and day', async () => {
    // wakePoint = 2026-01-05 09:03 local
    const wakePoint    = new Date(2026, 0, 5, 9, 3, 0)
    const upcomingDate = new Date(wakePoint.getTime() + 10 * 60 * 1000)

    jest.useFakeTimers()
    jest.setSystemTime(new Date(2026, 0, 5, 8, 0, 0))

    await reschedule([upcomingDate])

    const scheduleCall = mockExecFile.mock.calls.find(
      (c: unknown[]) => c[0] === 'pmset' && (c[1] as string[])[1] === 'wake'
    )
    expect((scheduleCall![1] as string[])[2]).toBe('01/05/26 09:03:00')
  })

  it('calls pmset cancelall before scheduling', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(2026, 0, 1, 0, 0, 0))

    const upcomingDate = new Date(2026, 4, 17, 11, 10, 0)
    await reschedule([upcomingDate])

    const cancelCall = mockExecFile.mock.calls.find(
      (c: unknown[]) => c[0] === 'pmset' && (c[1] as string[])[1] === 'cancelall'
    )
    expect(cancelCall).toBeDefined()
  })

  it('returns ok:true with count and nextWake ISO string on success', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(2026, 0, 1, 0, 0, 0))

    const upcomingDate = new Date(2026, 4, 17, 11, 10, 0)
    const result = await reschedule([upcomingDate])

    expect(result.ok).toBe(true)
    expect(result.count).toBe(1)
    expect(typeof result.nextWake).toBe('string')
  })
})

// ─── Windows PowerShell date format (formatWinDateTime) ──────────────────────

describe('reschedule — win32 powershell date formatting', () => {
  beforeEach(() => setPlatform('win32'))

  it('formats the wake date as YYYY-MM-DDTHH:MM:00 for PowerShell', async () => {
    const wakePoint    = new Date(2026, 4, 17, 11, 0, 0)
    const upcomingDate = new Date(wakePoint.getTime() + 10 * 60 * 1000)

    jest.useFakeTimers()
    jest.setSystemTime(new Date(2026, 4, 17, 10, 0, 0))

    await reschedule([upcomingDate])

    // calls[0] = unregister tasks, calls[1] = register elevated
    const registerCall = mockExecFile.mock.calls.find(
      (c: unknown[]) =>
        c[0] === 'powershell' &&
        (c[1] as string[]).some((a: string) => a.includes('Register-ScheduledTask'))
    )
    expect(registerCall).toBeDefined()
    const script = (registerCall![1] as string[]).find((a: string) => a.includes('Register-ScheduledTask'))!
    expect(script).toContain('2026-05-17T11:00:00')
  })

  it('zero-pads month and day in win32 format', async () => {
    const wakePoint    = new Date(2026, 0, 5, 9, 3, 0)
    const upcomingDate = new Date(wakePoint.getTime() + 10 * 60 * 1000)

    jest.useFakeTimers()
    jest.setSystemTime(new Date(2026, 0, 5, 8, 0, 0))

    await reschedule([upcomingDate])

    const registerCall = mockExecFile.mock.calls.find(
      (c: unknown[]) =>
        c[0] === 'powershell' &&
        (c[1] as string[]).some((a: string) => a.includes('Register-ScheduledTask'))
    )
    const script = (registerCall![1] as string[]).find((a: string) => a.includes('Register-ScheduledTask'))!
    expect(script).toContain('2026-01-05T09:03:00')
  })
})

// ─── powerSaveBlocker ─────────────────────────────────────────────────────────

describe('reschedule — powerSaveBlocker', () => {
  it('starts a blocker when a recording is within 30 minutes', async () => {
    setPlatform('linux')
    const soonDate = new Date(Date.now() + 20 * 60 * 1000) // 20 min from now
    await reschedule([soonDate])
    expect(powerSaveBlocker.start as jest.Mock).toHaveBeenCalledWith('prevent-app-suspension')
  })

  it('does not start a blocker when all recordings are more than 30 minutes away', async () => {
    setPlatform('linux')
    const farDate = new Date(Date.now() + 60 * 60 * 1000) // 60 min from now
    await reschedule([farDate])
    expect(powerSaveBlocker.start as jest.Mock).not.toHaveBeenCalled()
  })

  it('does not start a blocker when there are no upcoming dates', async () => {
    setPlatform('linux')
    await reschedule([])
    expect(powerSaveBlocker.start as jest.Mock).not.toHaveBeenCalled()
  })
})

// ─── testWake ────────────────────────────────────────────────────────────────

// Flush pending microtasks. With Jest's modern fake timers, setImmediate is
// also faked, so we use a plain Promise.resolve() chain that runs synchronously
// after the current microtask queue drains. Loops 30× — the wake / reschedule
// chain has many awaited steps (mutex chain, dedup cache, exec promisify).
const flushPromises = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve()
  }
}

describe('testWake', () => {
  it('returns unsupported on linux', async () => {
    setPlatform('linux')
    const r = await testWake(30)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('unsupported')
  })

  it('returns ok=true when resume fires within 30s of scheduled time', async () => {
    setPlatform('darwin')
    jest.useFakeTimers()
    const promise = testWake(30)

    // Let scheduling phase complete (reschedule is async via promisified exec)
    await flushPromises()
    // Let the 3s "sleeping soon" pre-sleep delay fire
    await jest.advanceTimersByTimeAsync(3100)

    // Advance to just before the expected wake time, then fire resume
    await jest.advanceTimersByTimeAsync(28_000)
    electronMock.powerMonitor.__emitResume()
    await flushPromises()

    const r = await promise
    expect(r.ok).toBe(true)
    expect(r.reason).toBeUndefined()
    expect(typeof r.deltaSec).toBe('number')
    expect(r.deltaSec!).toBeLessThanOrEqual(30)
    expect(r.scheduledFor).toBeDefined()
    expect(r.actualAt).toBeDefined()
  })

  it('returns reason=no_resume if no resume event fires before max wait', async () => {
    setPlatform('darwin')
    jest.useFakeTimers()
    const promise = testWake(30)

    await flushPromises()
    await jest.advanceTimersByTimeAsync(3100)
    // Advance well past secondsAhead + 90s slack
    await jest.advanceTimersByTimeAsync(130_000)

    const r = await promise
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no_resume')
    expect(r.scheduledFor).toBeDefined()
  })

  it('returns reason=too_late when resume fires more than 30s after scheduled time', async () => {
    setPlatform('darwin')
    // Need a sec value where (sec + 30) max-wait is large enough that we can
    // fire resume AFTER scheduled+30s but BEFORE max-wait. Use sec=120
    // (max-wait=150s) and fire at scheduled+60s.
    jest.useFakeTimers()
    const promise = testWake(120)
    await flushPromises()
    await jest.advanceTimersByTimeAsync(3100)
    // Advance to scheduled + 60s — well past 30s tolerance, well under 150s max wait
    await jest.advanceTimersByTimeAsync(120_000 + 60_000)
    electronMock.powerMonitor.__emitResume()
    await flushPromises()

    const r = await promise
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('too_late')
    expect(r.deltaSec!).toBeGreaterThan(30)
  })

  it('is cancellable mid-flight', async () => {
    setPlatform('darwin')
    jest.useFakeTimers()
    const promise = testWake(60)
    await flushPromises()

    expect(isTestWakeActive()).toBe(true)
    const cancelled = cancelTestWake()
    expect(cancelled).toBe(true)
    expect(isTestWakeActive()).toBe(false)

    const r = await promise
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('cancelled')
  })

  it('cancelTestWake returns false when nothing is active', () => {
    expect(cancelTestWake()).toBe(false)
  })

  it('clamps very-short secondsAhead to a safe minimum (>= 20s)', async () => {
    setPlatform('darwin')
    jest.useFakeTimers()
    const promise = testWake(5)
    await jest.advanceTimersByTimeAsync(3100)
    // 5 was clamped to 20 → max wait = 20+30 = 50s. At 19s the test is still active.
    await jest.advanceTimersByTimeAsync(15_000)
    expect(isTestWakeActive()).toBe(true)
    cancelTestWake()
    await promise
  })

  it('clamps very-large secondsAhead to a safe maximum (<= 600s)', async () => {
    setPlatform('darwin')
    jest.useFakeTimers()
    const promise = testWake(100_000)
    await jest.advanceTimersByTimeAsync(3100)
    // Even at 600s the test must still be active well before maxWait of 630s
    await jest.advanceTimersByTimeAsync(100_000)
    expect(isTestWakeActive()).toBe(true)
    cancelTestWake()
    await promise
  })

  it('records test_ok to wake-failure history on success', async () => {
    setPlatform('darwin')
    jest.useFakeTimers()
    const promise = testWake(30)
    await jest.advanceTimersByTimeAsync(3100)
    await jest.advanceTimersByTimeAsync(28_000)
    electronMock.powerMonitor.__emitResume()
    await flushPromises()
    await promise

    const addEntry = (store as unknown as { addWakeFailureEntry: jest.Mock }).addWakeFailureEntry
    expect(addEntry).toHaveBeenCalled()
    const entry = addEntry.mock.calls.find(c => c[0].kind === 'test_ok')
    expect(entry).toBeDefined()
  })

  it('records test_fail to wake-failure history when no resume fires', async () => {
    setPlatform('darwin')
    jest.useFakeTimers()
    const promise = testWake(30)
    await flushPromises()
    await jest.advanceTimersByTimeAsync(3100)
    await jest.advanceTimersByTimeAsync(130_000)
    await promise

    const addEntry = (store as unknown as { addWakeFailureEntry: jest.Mock }).addWakeFailureEntry
    expect(addEntry).toHaveBeenCalled()
    const entry = addEntry.mock.calls.find(c => c[0].kind === 'test_fail')
    expect(entry).toBeDefined()
    expect(entry![0].reason).toBe('no_resume')
  })

  it('starting a new test cancels any in-flight test', async () => {
    setPlatform('darwin')
    jest.useFakeTimers()
    const p1 = testWake(60)
    await flushPromises()
    expect(isTestWakeActive()).toBe(true)

    // Starting a new test cancels the first
    const p2 = testWake(60)
    await flushPromises()

    const r1 = await p1
    expect(r1.reason).toBe('cancelled')

    cancelTestWake()
    await p2
  })

  it('isTestWakeActive returns false after a successful run', async () => {
    setPlatform('darwin')
    jest.useFakeTimers()
    const promise = testWake(30)
    await jest.advanceTimersByTimeAsync(3100)
    await jest.advanceTimersByTimeAsync(28_000)
    electronMock.powerMonitor.__emitResume()
    await flushPromises()
    await promise
    expect(isTestWakeActive()).toBe(false)
  })

  it('returns error if reschedule fails', async () => {
    setPlatform('darwin')
    // Make pmset fail every time so reschedule returns permission/error
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1]
      if (typeof cb === 'function') (cb as Function)(new Error('boom'), null)
    })
    const r = await testWake(30)
    expect(r.ok).toBe(false)
    // Either 'error' or 'cancelled' depending on which path triggered
    expect(['error', 'cancelled']).toContain(r.reason)
  })

  it('sends test-wake-progress events to the window', async () => {
    setPlatform('darwin')
    jest.useFakeTimers()
    const send = jest.fn()
    const fakeWin = { webContents: { send } } as unknown as Electron.BrowserWindow
    const promise = testWake(30, fakeWin)

    await jest.advanceTimersByTimeAsync(3100)
    await jest.advanceTimersByTimeAsync(28_000)
    electronMock.powerMonitor.__emitResume()
    await flushPromises()
    await promise

    const channels = send.mock.calls.filter(c => c[0] === 'test-wake-progress')
    expect(channels.length).toBeGreaterThanOrEqual(3)
    const phases = channels.map(c => (c[1] as { phase: string }).phase)
    expect(phases).toEqual(expect.arrayContaining(['scheduling', 'sleeping', 'resumed']))
  })
})
