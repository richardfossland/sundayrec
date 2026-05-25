import { execFile } from 'child_process'
import { powerSaveBlocker } from 'electron'
import { reschedule, _resetSchedulingCache } from '../src/main/wake'
import * as store from '../src/main/store'

jest.mock('electron')
jest.mock('child_process', () => ({ execFile: jest.fn() }))
jest.mock('../src/main/store', () => ({ get: jest.fn(), set: jest.fn() }))

const mockExecFile = execFile as unknown as jest.Mock
const mockGet = store.get as unknown as jest.Mock

const HOST_PLATFORM = process.platform

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

beforeEach(() => {
  jest.clearAllMocks()
  _resetSchedulingCache()
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
