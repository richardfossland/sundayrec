import { execFile } from 'child_process'
import {
  detectCapabilities,
  parsePmsetSched,
  parsePowercfgWaketimers,
  parsePmsetBatt,
  parseWmicBatteryStatus,
  parsePmsetStandby,
  compareExpectedToObserved,
  verifyScheduledWakes,
  checkPowerSource,
  checkStandbyEnabled,
  WAKE_MATCH_TOLERANCE_MS,
} from '../src/main/wake-verification'

jest.mock('child_process', () => ({ execFile: jest.fn() }))

const mockExecFile = execFile as unknown as jest.Mock

const HOST_PLATFORM = process.platform
const HOST_ARCH     = process.arch

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
function setArch(a: string): void {
  Object.defineProperty(process, 'arch', { value: a, configurable: true })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1]
    if (typeof cb === 'function') (cb as Function)(null, { stdout: '', stderr: '' })
  })
})

afterEach(() => {
  setPlatform(HOST_PLATFORM)
  setArch(HOST_ARCH)
})

// ─── detectCapabilities ──────────────────────────────────────────────────────

describe('detectCapabilities — Apple Silicon Mac', () => {
  beforeEach(() => { setPlatform('darwin'); setArch('arm64') })

  it('reports platform mac-arm', async () => {
    const caps = await detectCapabilities()
    expect(caps.platform).toBe('mac-arm')
  })

  it('reports canWakeFromSleep=true and canWakeFromOff=false (honest — Apple removed pmset poweron)', async () => {
    const caps = await detectCapabilities()
    expect(caps.canWakeFromSleep).toBe(true)
    expect(caps.canWakeFromOff).toBe(false)
  })

  it('mentions Apple Silicon limitation in knownIssues', async () => {
    const caps = await detectCapabilities()
    const all = caps.knownIssues.join(' ')
    expect(all.toLowerCase()).toContain('apple silicon')
  })

  it('recommends keeping the machine in sleep (not off)', async () => {
    const caps = await detectCapabilities()
    expect(caps.recommendations.join(' ')).toMatch(/dvale/i)
  })

  it('reports needsAdmin=true', async () => {
    expect((await detectCapabilities()).needsAdmin).toBe(true)
  })
})

describe('detectCapabilities — Intel Mac', () => {
  beforeEach(() => { setPlatform('darwin'); setArch('x64') })

  it('reports platform mac-intel', async () => {
    expect((await detectCapabilities()).platform).toBe('mac-intel')
  })

  it('reports canWakeFromOff=true (Intel pmset poweron exists)', async () => {
    expect((await detectCapabilities()).canWakeFromOff).toBe(true)
  })

  it('mentions the manual System Settings toggle requirement', async () => {
    const caps = await detectCapabilities()
    expect(caps.knownIssues.join(' ')).toMatch(/manuelt/i)
  })
})

describe('detectCapabilities — Windows', () => {
  beforeEach(() => setPlatform('win32'))

  it('reports platform win', async () => {
    expect((await detectCapabilities()).platform).toBe('win')
  })

  it('reports canWakeFromOff=false (BIOS toggle unreachable from software)', async () => {
    expect((await detectCapabilities()).canWakeFromOff).toBe(false)
  })

  it('mentions BIOS requirement for S5 wake', async () => {
    const caps = await detectCapabilities()
    expect(caps.knownIssues.join(' ')).toMatch(/BIOS/i)
  })

  it('recommends being on AC power', async () => {
    const caps = await detectCapabilities()
    expect(caps.recommendations.join(' ')).toMatch(/strøm|AC|batteri/i)
  })
})

describe('detectCapabilities — Linux', () => {
  beforeEach(() => setPlatform('linux'))

  it('reports platform linux and no wake support', async () => {
    const caps = await detectCapabilities()
    expect(caps.platform).toBe('linux')
    expect(caps.canWakeFromSleep).toBe(false)
    expect(caps.canWakeFromOff).toBe(false)
  })
})

describe('detectCapabilities — unknown', () => {
  beforeEach(() => setPlatform('aix'))

  it('reports platform "other" and no support', async () => {
    const caps = await detectCapabilities()
    expect(caps.platform).toBe('other')
    expect(caps.canWakeFromSleep).toBe(false)
  })
})

// ─── parsePmsetSched ─────────────────────────────────────────────────────────

describe('parsePmsetSched', () => {
  it('parses a single absolute wake event', () => {
    const out = parsePmsetSched(`Scheduled power events:
 [0]  wake at 5/31/2026 10:30:00 by 'SundayRec'`)
    expect(out).toHaveLength(1)
    expect(out[0].ownerLabel).toBe('SundayRec')
    expect(out[0].scheduledAt.getFullYear()).toBe(2026)
    expect(out[0].scheduledAt.getMonth()).toBe(4)   // May
    expect(out[0].scheduledAt.getDate()).toBe(31)
    expect(out[0].scheduledAt.getHours()).toBe(10)
    expect(out[0].scheduledAt.getMinutes()).toBe(30)
  })

  it('parses multiple events', () => {
    const out = parsePmsetSched(`Scheduled power events:
 [0]  wake at 5/31/2026 10:30:00 by 'SundayRec'
 [1]  wake at 6/7/2026 10:30:00 by 'SundayRec'`)
    expect(out).toHaveLength(2)
    expect(out[0].scheduledAt.getMonth()).toBe(4)  // May
    expect(out[1].scheduledAt.getMonth()).toBe(5)  // Jun
  })

  it('returns empty array for empty input', () => {
    expect(parsePmsetSched('')).toEqual([])
  })

  it('returns empty array when only a repeating section is present', () => {
    const out = parsePmsetSched(`Repeating power events:
  wake at 11:30AM every weekday`)
    expect(out).toEqual([])
  })

  it('handles two-digit year', () => {
    const out = parsePmsetSched(`Scheduled power events:
 [0]  wake at 1/5/26 09:03:00 by 'SundayRec'`)
    expect(out).toHaveLength(1)
    expect(out[0].scheduledAt.getFullYear()).toBe(2026)
    expect(out[0].scheduledAt.getMonth()).toBe(0)
    expect(out[0].scheduledAt.getDate()).toBe(5)
  })

  it('handles zero-padded month/day', () => {
    const out = parsePmsetSched(`Scheduled power events:
 [0]  wake at 01/05/2026 09:03:00 by 'SundayRec'`)
    expect(out).toHaveLength(1)
    expect(out[0].scheduledAt.getMonth()).toBe(0)
  })

  it('skips malformed lines', () => {
    const out = parsePmsetSched(`Scheduled power events:
 [0]  wake at garbage by 'X'
 [1]  wake at 5/31/2026 10:30:00 by 'SundayRec'
 not a wake line at all`)
    expect(out).toHaveLength(1)
  })

  it('ignores wakes outside ±5 years when refYear is provided', () => {
    const out = parsePmsetSched(`Scheduled power events:
 [0]  wake at 5/31/2099 10:30:00 by 'SundayRec'
 [1]  wake at 5/31/2026 10:30:00 by 'SundayRec'`, 2026)
    expect(out).toHaveLength(1)
    expect(out[0].scheduledAt.getFullYear()).toBe(2026)
  })

  it('extracts owner label for non-SundayRec entries too', () => {
    const out = parsePmsetSched(`Scheduled power events:
 [0]  wake at 5/31/2026 10:30:00 by 'com.apple.SomeOtherOwner'`)
    expect(out[0].ownerLabel).toBe('com.apple.SomeOtherOwner')
  })
})

// ─── parsePowercfgWaketimers ─────────────────────────────────────────────────

describe('parsePowercfgWaketimers', () => {
  it('parses a single PM timer', () => {
    const out = parsePowercfgWaketimers(
`Timer set by [SYSTEM\\TaskScheduler] expires at 5:30:00 PM on 5/31/2026.
  Reason: Windows will execute 'NT TASK\\SundayRec\\SundayRec-Wake-1' scheduled task`
    )
    expect(out).toHaveLength(1)
    expect(out[0].ownerLabel).toBe('SundayRec-Wake-1')
    expect(out[0].scheduledAt.getHours()).toBe(17)   // 5 PM → 17
    expect(out[0].scheduledAt.getMinutes()).toBe(30)
    expect(out[0].scheduledAt.getDate()).toBe(31)
    expect(out[0].scheduledAt.getFullYear()).toBe(2026)
  })

  it('parses a 24-hour-format timer without AM/PM', () => {
    const out = parsePowercfgWaketimers(
`Timer set by [SYSTEM\\TaskScheduler] expires at 17:30:00 on 5/31/2026.
  Reason: 'NT TASK\\SundayRec\\SundayRec-Wake-1' scheduled task`
    )
    expect(out).toHaveLength(1)
    expect(out[0].scheduledAt.getHours()).toBe(17)
  })

  it('returns empty array when there are no active wake timers', () => {
    const out = parsePowercfgWaketimers('There are no active wake timers in the system.')
    expect(out).toEqual([])
  })

  it('parses multiple timers separated by blank lines', () => {
    const out = parsePowercfgWaketimers(
`Timer set by [SYSTEM\\TaskScheduler] expires at 5:30:00 PM on 5/31/2026.
  Reason: 'NT TASK\\SundayRec\\SundayRec-Wake-1' scheduled task

Timer set by [SYSTEM\\TaskScheduler] expires at 5:30:00 PM on 6/7/2026.
  Reason: 'NT TASK\\SundayRec\\SundayRec-Wake-2' scheduled task`
    )
    expect(out).toHaveLength(2)
    expect(out[0].ownerLabel).toBe('SundayRec-Wake-1')
    expect(out[1].ownerLabel).toBe('SundayRec-Wake-2')
  })

  it('handles 12 AM → midnight conversion', () => {
    const out = parsePowercfgWaketimers(
`Timer set by [SYSTEM\\TaskScheduler] expires at 12:30:00 AM on 5/31/2026.
  Reason: 'NT TASK\\SundayRec\\Test' scheduled task`
    )
    expect(out[0].scheduledAt.getHours()).toBe(0)
    expect(out[0].scheduledAt.getMinutes()).toBe(30)
  })

  it('handles 12 PM → noon', () => {
    const out = parsePowercfgWaketimers(
`Timer set by [SYSTEM\\TaskScheduler] expires at 12:00:00 PM on 5/31/2026.
  Reason: 'NT TASK\\SundayRec\\Test' scheduled task`
    )
    expect(out[0].scheduledAt.getHours()).toBe(12)
  })

  it('returns empty array on malformed input', () => {
    expect(parsePowercfgWaketimers('garbage in garbage out')).toEqual([])
  })

  it('falls back to "unknown" owner if no SundayRec task is in the reason', () => {
    const out = parsePowercfgWaketimers(
`Timer set by [SYSTEM\\TaskScheduler] expires at 5:30:00 PM on 5/31/2026.`
    )
    expect(out).toHaveLength(1)
    expect(out[0].ownerLabel).toBe('unknown')
  })
})

// ─── compareExpectedToObserved ───────────────────────────────────────────────

describe('compareExpectedToObserved', () => {
  it('returns no mismatch when expected list is empty', () => {
    const r = compareExpectedToObserved([], [])
    expect(r.hasMismatch).toBe(false)
    expect(r.missing).toEqual([])
  })

  it('returns mismatch when an expected wake has no observed match', () => {
    const expected = [new Date(2026, 4, 31, 10, 30, 0)]
    const r = compareExpectedToObserved(expected, [])
    expect(r.hasMismatch).toBe(true)
    expect(r.missing).toHaveLength(1)
  })

  it('matches expected wake to observed within tolerance', () => {
    const expected = [new Date(2026, 4, 31, 10, 30, 0)]
    const observed = [{ scheduledAt: new Date(2026, 4, 31, 10, 30, 30), ownerLabel: 'X' }]
    const r = compareExpectedToObserved(expected, observed)
    expect(r.hasMismatch).toBe(false)
  })

  it('fails to match when observed is more than tolerance off', () => {
    const expected = [new Date(2026, 4, 31, 10, 30, 0)]
    const observed = [{ scheduledAt: new Date(2026, 4, 31, 10, 32, 0), ownerLabel: 'X' }]
    const r = compareExpectedToObserved(expected, observed)
    expect(r.hasMismatch).toBe(true)
  })

  it('uses default tolerance of 60 seconds', () => {
    expect(WAKE_MATCH_TOLERANCE_MS).toBe(60_000)
  })

  it('flags only the missing wakes when some match', () => {
    const expected = [
      new Date(2026, 4, 31, 10, 30, 0),
      new Date(2026, 5, 7, 10, 30, 0),
    ]
    const observed = [{ scheduledAt: new Date(2026, 4, 31, 10, 30, 5), ownerLabel: 'X' }]
    const r = compareExpectedToObserved(expected, observed)
    expect(r.hasMismatch).toBe(true)
    expect(r.missing).toHaveLength(1)
    expect(r.missing[0].getMonth()).toBe(5)  // June one is missing
  })
})

// ─── parsePmsetBatt ──────────────────────────────────────────────────────────

describe('parsePmsetBatt', () => {
  it('detects AC Power as not-on-battery', () => {
    expect(parsePmsetBatt("Now drawing from 'AC Power'\n -InternalBattery-0 100%")).toBe(false)
  })

  it('detects Battery Power as on-battery', () => {
    expect(parsePmsetBatt("Now drawing from 'Battery Power'\n -InternalBattery-0 88%")).toBe(true)
  })

  it('treats empty output as desktop (no battery → not on battery)', () => {
    expect(parsePmsetBatt('')).toBe(false)
  })

  it('returns null when only a battery is mentioned but no source label', () => {
    expect(parsePmsetBatt('InternalBattery 80%')).toBeNull()
  })
})

// ─── parseWmicBatteryStatus ──────────────────────────────────────────────────

describe('parseWmicBatteryStatus', () => {
  it('treats status=1 as on-battery (discharging)', () => {
    expect(parseWmicBatteryStatus('BatteryStatus=1')).toBe(true)
  })

  it('treats status=2 as on AC', () => {
    expect(parseWmicBatteryStatus('BatteryStatus=2')).toBe(false)
  })

  it('treats other status codes as on AC', () => {
    expect(parseWmicBatteryStatus('BatteryStatus=4')).toBe(false)
  })

  it('returns false when no battery row is present (desktop)', () => {
    expect(parseWmicBatteryStatus('')).toBe(false)
  })

  it('returns null on malformed numeric', () => {
    expect(parseWmicBatteryStatus('BatteryStatus=abc')).toBeNull()
  })
})

// ─── parsePmsetStandby ───────────────────────────────────────────────────────

describe('parsePmsetStandby', () => {
  it('returns true when standby is 1', () => {
    expect(parsePmsetStandby(' standby              1\n other lines')).toBe(true)
  })

  it('returns false when standby is 0', () => {
    expect(parsePmsetStandby('standby              0')).toBe(false)
  })

  it('returns null when standby line is missing', () => {
    expect(parsePmsetStandby('some other pmset output')).toBeNull()
  })
})

// ─── checkPowerSource (live) ─────────────────────────────────────────────────

describe('checkPowerSource — live exec', () => {
  it('returns null on linux', async () => {
    setPlatform('linux')
    expect(await checkPowerSource()).toBeNull()
  })

  it('parses macOS AC Power as false', async () => {
    setPlatform('darwin')
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1]
      if (typeof cb === 'function') (cb as Function)(null, { stdout: "Now drawing from 'AC Power'\n -InternalBattery-0 100%", stderr: '' })
    })
    expect(await checkPowerSource()).toBe(false)
  })

  it('returns null when pmset errors', async () => {
    setPlatform('darwin')
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1]
      if (typeof cb === 'function') (cb as Function)(new Error('not found'), null)
    })
    expect(await checkPowerSource()).toBeNull()
  })
})

// ─── checkStandbyEnabled (live) ──────────────────────────────────────────────

describe('checkStandbyEnabled — live exec', () => {
  it('returns null on non-darwin platforms', async () => {
    setPlatform('win32')
    expect(await checkStandbyEnabled()).toBeNull()
  })

  it('returns true when pmset reports standby 1', async () => {
    setPlatform('darwin')
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1]
      if (typeof cb === 'function') (cb as Function)(null, { stdout: 'standby              1', stderr: '' })
    })
    expect(await checkStandbyEnabled()).toBe(true)
  })
})

// ─── verifyScheduledWakes (integration) ──────────────────────────────────────

describe('verifyScheduledWakes', () => {
  it('returns capabilities + observed + mismatch flags (mac path)', async () => {
    setPlatform('darwin'); setArch('arm64')
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[]
      const cb = args[args.length - 1] as Function
      // pmset -g sched → return one matching wake
      if (argv.includes('sched')) {
        cb(null, { stdout: `Scheduled power events:\n [0]  wake at 5/31/2026 10:30:00 by 'SundayRec'`, stderr: '' })
      } else if (argv.includes('batt')) {
        cb(null, { stdout: "Now drawing from 'AC Power'", stderr: '' })
      } else {
        // pmset -g (standby check)
        cb(null, { stdout: 'standby              0', stderr: '' })
      }
    })
    const expected = [new Date(2026, 4, 31, 10, 30, 0)]
    const status = await verifyScheduledWakes(expected)
    expect(status.capabilities.platform).toBe('mac-arm')
    expect(status.observedWakes).toHaveLength(1)
    expect(status.hasMismatch).toBe(false)
    expect(status.onBattery).toBe(false)
    expect(status.standbyEnabled).toBe(false)
  })

  it('flags hasMismatch when an expected wake is not observed', async () => {
    setPlatform('darwin')
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as Function
      cb(null, { stdout: '', stderr: '' })
    })
    const expected = [new Date(2026, 4, 31, 10, 30, 0)]
    const status = await verifyScheduledWakes(expected)
    expect(status.hasMismatch).toBe(true)
  })
})
