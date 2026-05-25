// IMPORTANT: TZ must be set before any Date is created so that tests of
// DST behavior reflect Europe/Oslo (the primary market). Some CI runners
// default to UTC which would mask spring-forward / fall-back edge cases.
process.env.TZ = 'Europe/Oslo'

// Mocks for reschedule()/checkMissedRecordings() integration tests below.
// jest.mock is hoisted above imports, so the scheduler module sees the mocks
// even though we import it on the very next line. The mocks default to safe
// no-op values; individual tests override store.get/getHistory/addHistory.
jest.mock('electron')
jest.mock('../src/main/recorder', () => ({
  isActive: jest.fn(() => false),
  startSession: jest.fn(async () => ({ ok: true })),
  stopSession: jest.fn(),
  localizeError: jest.fn((s: string) => s),
  NOTIFY_LABELS: { no: { done: '', err: '', recovered: '', reconnected: '' } },
}))
jest.mock('../src/main/store', () => ({
  get:        jest.fn(),
  set:        jest.fn(),
  getAll:     jest.fn(() => ({})),
  getHistory: jest.fn(() => []),
  addHistory: jest.fn(),
}))
jest.mock('../src/main/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}))

import schedule from 'node-schedule'
import {
  uiDayToJsDay,
  slotActiveNow,
  specialActiveNow,
  init,
  reschedule,
  checkMissedRecordings,
  getUpcomingDates,
  getNextRecording,
} from '../src/main/scheduler'
import * as store from '../src/main/store'
import * as logger from '../src/main/logger'

const mockStoreGet        = store.get        as unknown as jest.Mock
const mockStoreGetHistory = store.getHistory as unknown as jest.Mock
const mockStoreAddHistory = store.addHistory as unknown as jest.Mock
const mockLogger = {
  warn:  logger.warn  as unknown as jest.Mock,
  info:  logger.info  as unknown as jest.Mock,
  error: logger.error as unknown as jest.Mock,
  debug: logger.debug as unknown as jest.Mock,
}

// Minimal stand-in for BrowserWindow; only properties scheduler.ts touches.
const mockWin = {
  webContents: { send: jest.fn() },
  isDestroyed: jest.fn(() => false),
} as unknown as Electron.BrowserWindow

/**
 * Build the same RecurrenceRule that scheduler.ts would build for a weekly
 * slot. Lets DST tests assert exact UTC trigger times without having to
 * spelunk node-schedule's internal job list.
 */
function ruleFor(jsDay: number, hour: number, minute: number): schedule.RecurrenceRule {
  const r = new schedule.RecurrenceRule()
  r.dayOfWeek = jsDay
  r.hour      = hour
  r.minute    = minute
  r.tz        = 'Europe/Oslo'
  return r
}

/**
 * Cancel every job that scheduler.ts has registered with node-schedule.
 * scheduler.ts keeps an internal jobs map, but it also registers each job
 * globally on node-schedule. Cancelling here AFTER calling reschedule()
 * with empty slots is the cleanest reset, but for paranoia we also walk
 * node-schedule's global registry.
 */
function cancelAllSchedulerJobs(): void {
  reschedule()  // cancels jobs the scheduler owns
  for (const name of Object.keys(schedule.scheduledJobs)) {
    schedule.scheduledJobs[name]?.cancel()
  }
}

// ─── timezone sanity check ───────────────────────────────────────────────────
// If this fails, every DST/midnight assertion below is meaningless — fail
// loudly rather than silently producing green tests on the wrong timezone.

describe('test environment', () => {
  it('runs in Europe/Oslo timezone', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Europe/Oslo')
  })

  it('produces +02:00 offset for a May date (CEST)', () => {
    // 2026-05-17 12:00 local in Oslo = 10:00 UTC during summer time
    const d = new Date(2026, 4, 17, 12, 0, 0)
    expect(d.toISOString()).toBe('2026-05-17T10:00:00.000Z')
  })

  it('produces +01:00 offset for a January date (CET)', () => {
    // 2026-01-15 12:00 local in Oslo = 11:00 UTC during winter time
    const d = new Date(2026, 0, 15, 12, 0, 0)
    expect(d.toISOString()).toBe('2026-01-15T11:00:00.000Z')
  })
})

// ─── uiDayToJsDay ────────────────────────────────────────────────────────────

describe('uiDayToJsDay', () => {
  it.each([
    [0, 1],  // Mon → 1
    [1, 2],  // Tue → 2
    [2, 3],  // Wed → 3
    [3, 4],  // Thu → 4
    [4, 5],  // Fri → 5
    [5, 6],  // Sat → 6
    [6, 0],  // Sun → 0
  ])('UI day %i → JS day %i', (uiDay, jsDay) => {
    expect(uiDayToJsDay(uiDay)).toBe(jsDay)
  })
})

// ─── slotActiveNow ───────────────────────────────────────────────────────────

describe('slotActiveNow', () => {
  // Sunday 2026-05-17 11:00:00 local (JS day 0, UI day 6)
  const sunday11 = new Date(2026, 4, 17, 11, 0, 0)

  it('returns true at exact start time on matching day', () => {
    expect(slotActiveNow('11:00', '12:00', [6], sunday11)).toBe(true)
  })

  it('returns true within 5-minute window after start', () => {
    const fourMinLate = new Date(2026, 4, 17, 11, 4, 0)
    expect(slotActiveNow('11:00', '12:00', [6], fourMinLate)).toBe(true)
  })

  it('returns false more than 5 minutes after start', () => {
    const sixMinLate = new Date(2026, 4, 17, 11, 6, 0)
    expect(slotActiveNow('11:00', '12:00', [6], sixMinLate)).toBe(false)
  })

  it('returns false before start time', () => {
    const before = new Date(2026, 4, 17, 10, 59, 0)
    expect(slotActiveNow('11:00', '12:00', [6], before)).toBe(false)
  })

  it('returns false after stop time', () => {
    const afterStop = new Date(2026, 4, 17, 12, 1, 0)
    expect(slotActiveNow('11:00', '12:00', [6], afterStop)).toBe(false)
  })

  it('returns false on wrong day', () => {
    // Same time but Saturday (UI day 5, JS day 6)
    const saturday11 = new Date(2026, 4, 16, 11, 0, 0)
    expect(slotActiveNow('11:00', '12:00', [6], saturday11)).toBe(false)
  })

  it('returns false when days array is empty', () => {
    expect(slotActiveNow('11:00', '12:00', [], sunday11)).toBe(false)
  })

  it('matches when Sunday is in a multi-day slot', () => {
    // slot active Mon+Wed+Sun
    expect(slotActiveNow('11:00', '12:00', [0, 2, 6], sunday11)).toBe(true)
  })

  it('respects custom windowMs', () => {
    const twoMinLate = new Date(2026, 4, 17, 11, 2, 0)
    expect(slotActiveNow('11:00', '12:00', [6], twoMinLate, 60000)).toBe(false)   // 1-min window
    expect(slotActiveNow('11:00', '12:00', [6], twoMinLate, 180000)).toBe(true)   // 3-min window
  })

  it('falls back to 11:00/12:00 when start/stop are empty strings', () => {
    expect(slotActiveNow('', '', [6], sunday11)).toBe(true)
  })
})

// ─── specialActiveNow ────────────────────────────────────────────────────────

describe('specialActiveNow', () => {
  // Special recording date: 2026-05-17, start 11:00, stop 12:00
  const atStart  = new Date(2026, 4, 17, 11, 0, 0)
  const within   = new Date(2026, 4, 17, 11, 3, 0)
  const tooLate  = new Date(2026, 4, 17, 11, 6, 0)
  const afterEnd = new Date(2026, 4, 17, 12, 1, 0)
  const before   = new Date(2026, 4, 17, 10, 59, 0)
  const wrongDay = new Date(2026, 4, 18, 11, 0, 0)   // 2026-05-18

  it('returns true at exact start time', () => {
    expect(specialActiveNow('2026-05-17', '11:00', '12:00', atStart)).toBe(true)
  })

  it('returns true within the 5-minute window', () => {
    expect(specialActiveNow('2026-05-17', '11:00', '12:00', within)).toBe(true)
  })

  it('returns false more than 5 minutes late', () => {
    expect(specialActiveNow('2026-05-17', '11:00', '12:00', tooLate)).toBe(false)
  })

  it('returns false before start time', () => {
    expect(specialActiveNow('2026-05-17', '11:00', '12:00', before)).toBe(false)
  })

  it('returns false after stop time', () => {
    expect(specialActiveNow('2026-05-17', '11:00', '12:00', afterEnd)).toBe(false)
  })

  it('returns false on a different date', () => {
    expect(specialActiveNow('2026-05-17', '11:00', '12:00', wrongDay)).toBe(false)
  })

  it('respects custom windowMs', () => {
    expect(specialActiveNow('2026-05-17', '11:00', '12:00', within, 60000)).toBe(false)   // 1-min window
    expect(specialActiveNow('2026-05-17', '11:00', '12:00', within, 600000)).toBe(true)   // 10-min window
  })

  it('falls back to 11:00/12:00 when start/stop are empty', () => {
    expect(specialActiveNow('2026-05-17', '', '', atStart)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// DST (Daylight Saving Time) transitions
// ═══════════════════════════════════════════════════════════════════════════
//
// Europe/Oslo 2026:
//   Spring forward — 2026-03-29 02:00 local → 03:00 local
//                    UTC offset jumps +01:00 → +02:00
//                    Local times 02:00..02:59 do not exist on this day
//   Fall back      — 2026-10-25 03:00 local → 02:00 local
//                    UTC offset jumps +02:00 → +01:00
//                    Local times 02:00..02:59 exist twice
//
// These tests document what the scheduler / node-schedule actually do, so a
// regression that silently shifts a Sunday-morning recording is caught.

describe('DST — spring forward (2026-03-29)', () => {
  // RecurrenceRule.nextInvocationDate(base) computes the next scheduled wall-
  // clock occurrence given a hypothetical "now". We use a base of Sat Mar 28
  // 12:00 (well before the DST event) so each test starts from the same point.
  const base = new Date(2026, 2, 28, 12, 0, 0)  // 2026-03-28 12:00 Oslo

  it('Sunday 11:00 fires at the correct UTC instant on DST day', () => {
    // 11:00 Sun Mar 29 in Oslo = 09:00 UTC (already on summer time)
    const next = ruleFor(0, 11, 0).nextInvocationDate(base) as Date
    expect(next.toISOString()).toBe('2026-03-29T09:00:00.000Z')
  })

  it('Sunday 03:30 (just after the gap) fires on DST day', () => {
    const next = ruleFor(0, 3, 30).nextInvocationDate(base) as Date
    expect(next.toISOString()).toBe('2026-03-29T01:30:00.000Z')
    // 03:30 Oslo summer time = 01:30 UTC. Sanity check the wall-clock view.
    expect(next.getHours()).toBe(3)
    expect(next.getMinutes()).toBe(30)
  })

  // KNOWN BEHAVIOR (potential bug for users):
  // node-schedule's nextInvocationDate skips the non-existent local hour
  // entirely. A recording scheduled for Sun 02:30 will be silently delayed
  // by a full week. We document this so a future maintainer who sees a
  // missed Sunday recording knows where to look. If/when node-schedule
  // changes behavior, this test will fail and prompt review.
  it('TODO bug: Sunday 02:30 (inside the gap) skips to next Sunday', () => {
    const next = ruleFor(0, 2, 30).nextInvocationDate(base) as Date
    // Skipped Mar 29; next occurrence is Apr 5
    expect(next.toISOString()).toBe('2026-04-05T00:30:00.000Z')
  })

  it('Monday 10:00 (day after DST) fires at the correct UTC instant', () => {
    // After DST, 10:00 Oslo = 08:00 UTC (+02:00 offset is now active)
    const next = ruleFor(1, 10, 0).nextInvocationDate(base) as Date
    expect(next.toISOString()).toBe('2026-03-30T08:00:00.000Z')
    expect(next.getHours()).toBe(10)
  })

  it('special recording on DST day at 10:00 maps to 08:00 UTC', () => {
    // scheduler.ts builds `new Date('2026-03-29T10:00')` for specials.
    const startDate = new Date('2026-03-29T10:00')
    expect(startDate.toISOString()).toBe('2026-03-29T08:00:00.000Z')
    expect(startDate.getHours()).toBe(10)
  })

  it('slot spanning DST (Sat 23:00 → Sun 01:30) keeps both before-gap', () => {
    // Both endpoints land BEFORE the 02:00→03:00 jump, so the recording is
    // a normal 2.5 h of wall-clock time before the clock skips.
    const startInv = ruleFor(6, 23, 0).nextInvocationDate(base) as Date
    const stopInv  = ruleFor(0, 1, 30).nextInvocationDate(base) as Date
    expect(startInv.toISOString()).toBe('2026-03-28T22:00:00.000Z')
    expect(stopInv.toISOString()).toBe('2026-03-29T00:30:00.000Z')
    const durHours = (stopInv.getTime() - startInv.getTime()) / 3_600_000
    expect(durHours).toBeCloseTo(2.5, 5)
  })

  it('slot crossing DST (Sat 23:00 → Sun 03:30) has 1 h less elapsed time', () => {
    // Sat 23:00 → Sun 03:30 looks like 4.5 h wall-clock, but the spring-forward
    // jump eats one hour, so actual elapsed time is 3.5 h.
    const startInv = ruleFor(6, 23, 0).nextInvocationDate(base) as Date
    const stopInv  = ruleFor(0, 3, 30).nextInvocationDate(base) as Date
    expect(startInv.toISOString()).toBe('2026-03-28T22:00:00.000Z')
    expect(stopInv.toISOString()).toBe('2026-03-29T01:30:00.000Z')
    const durHours = (stopInv.getTime() - startInv.getTime()) / 3_600_000
    expect(durHours).toBeCloseTo(3.5, 5)
  })
})

describe('DST — fall back (2026-10-25)', () => {
  const base = new Date(2026, 9, 24, 12, 0, 0)  // 2026-10-24 12:00 Oslo

  // KNOWN BEHAVIOR: 02:30 local exists twice on fall-back day. node-schedule
  // fires on the FIRST occurrence only (the +02:00 one); the second (+01:00)
  // is silently skipped. For SundayRec this is largely safe — a Sunday service
  // at 02:30 is pathological — but documented here so we notice if upstream
  // changes the rule.
  it('Sunday 02:30 on fall-back day fires at the first occurrence (+02 offset)', () => {
    const next = ruleFor(0, 2, 30).nextInvocationDate(base) as Date
    // 02:30 +02 = 00:30 UTC. The other occurrence (+01) would be 01:30 UTC.
    expect(next.toISOString()).toBe('2026-10-25T00:30:00.000Z')
    expect(next.getHours()).toBe(2)
  })

  it('Sunday 11:00 on fall-back day fires at the correct UTC instant', () => {
    // After fall-back at 03:00, offset is +01:00. So 11:00 Oslo = 10:00 UTC.
    const next = ruleFor(0, 11, 0).nextInvocationDate(base) as Date
    expect(next.toISOString()).toBe('2026-10-25T10:00:00.000Z')
    expect(next.getHours()).toBe(11)
  })

  it('Monday 10:00 (day after fall-back) uses winter offset', () => {
    const next = ruleFor(1, 10, 0).nextInvocationDate(base) as Date
    expect(next.toISOString()).toBe('2026-10-26T09:00:00.000Z')
    expect(next.getHours()).toBe(10)
  })
})

describe('DST — reschedule() with mocked store', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    // Pin "now" to Sat 2026-03-28 12:00 Oslo so the next-invocation lookups
    // below all return the upcoming Sun Mar 29 occurrence.
    jest.setSystemTime(new Date(2026, 2, 28, 12, 0, 0))
  })
  afterEach(() => {
    cancelAllSchedulerJobs()
    jest.useRealTimers()
  })

  it('a Sunday-11:00 weekly slot registers a job that fires on DST Sunday', () => {
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return [{ days: [6], start: '11:00', stop: '12:00' }]
      if (key === 'specialRecordings') return []
      if (key === 'reminderMinutes') return 0
      return null
    })
    init(mockWin)
    const upcoming = getUpcomingDates(7)
    // First upcoming -start invocation should be Sun Mar 29 11:00 Oslo = 09:00 UTC
    expect(upcoming.length).toBeGreaterThanOrEqual(1)
    expect(upcoming[0].toISOString()).toBe('2026-03-29T09:00:00.000Z')
  })

  it('getNextRecording returns the DST-day occurrence with correct UTC time', () => {
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return [{ days: [6], start: '11:00', stop: '12:00' }]
      if (key === 'specialRecordings') return []
      if (key === 'reminderMinutes') return 0
      return null
    })
    init(mockWin)
    const next = getNextRecording()
    expect(next).not.toBeNull()
    expect(next!.date.toISOString()).toBe('2026-03-29T09:00:00.000Z')
  })

  it('warns when a slot falls in the DST spring-forward gap (Sun 02:30)', () => {
    // 02:30 on Sun 2026-03-29 does not exist (clocks jump 02:00 → 03:00).
    // node-schedule silently delays to the following Sunday — without a
    // warning the user would only notice that a recording was missed.
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return [{ days: [6], start: '02:30', stop: '03:30' }]
      if (key === 'specialRecordings') return []
      if (key === 'reminderMinutes') return 0
      return null
    })
    init(mockWin)

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'scheduler',
      'dst_gap_skip',
      expect.objectContaining({ start: '02:30' }),
    )
  })

  it('does NOT warn for a Sunday 11:00 slot (well outside the DST gap)', () => {
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return [{ days: [6], start: '11:00', stop: '12:00' }]
      if (key === 'specialRecordings') return []
      if (key === 'reminderMinutes') return 0
      return null
    })
    init(mockWin)

    const dstWarnings = mockLogger.warn.mock.calls.filter(c => c[1] === 'dst_gap_skip')
    expect(dstWarnings).toHaveLength(0)
  })

  it('upcoming dates around DST use absolute UTC ms (key cache stays stable)', async () => {
    // wake.ts dedup cache keys on Date.getTime() (UTC ms), which is unaffected
    // by DST. Verify that scheduling the same DST-crossing slot twice in a row
    // produces identical UTC-ms keys, so the second call would hit the cache.
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return [{ days: [6], start: '11:00', stop: '12:00' }]
      if (key === 'specialRecordings') return []
      if (key === 'reminderMinutes') return 0
      return null
    })
    init(mockWin)
    const first = getUpcomingDates(14).map(d => d.getTime())
    init(mockWin)
    const second = getUpcomingDates(14).map(d => d.getTime())
    expect(second).toEqual(first)
    // And: the DST-day occurrence's UTC ms equals the value computed from ISO.
    expect(first[0]).toBe(new Date('2026-03-29T09:00:00.000Z').getTime())
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// logMissedRecordings — via checkMissedRecordings public entry
// ═══════════════════════════════════════════════════════════════════════════
//
// MISSED_WINDOW_MS = 60 min (the late-start window: a slot < 60 min old is
//   still triggered live, not logged as missed)
// MISSED_LOG_WINDOW_MS = 24 h (lookback for logging missed recordings)
// historyCovers ±30 min: any history entry whose timestamp is within ±30 min
//   of the expected start time counts as covering it.

describe('checkMissedRecordings — logging behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    // Pin "now" to Sunday 2026-05-17 14:00 Oslo (3 h after a hypothetical 11:00 slot)
    jest.setSystemTime(new Date(2026, 4, 17, 14, 0, 0))
    // Default: no history, no specials.
    mockStoreGetHistory.mockReturnValue([])
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return []
      if (key === 'specialRecordings') return []
      if (key === 'reminderMinutes') return 0
      return null
    })
    // mainWindow must be set; init() does that but also calls reschedule().
    init(mockWin)
  })
  afterEach(() => {
    cancelAllSchedulerJobs()
    jest.useRealTimers()
  })

  it('logs a missed entry for a past slot with no history coverage', () => {
    // Sunday 11:00 slot, now is Sun 14:00 → 3 h old, outside MISSED_WINDOW (60 min)
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return [{ days: [6], start: '11:00', stop: '12:00' }]
      if (key === 'specialRecordings') return []
      if (key === 'reminderMinutes') return 0
      return null
    })
    checkMissedRecordings()
    expect(mockStoreAddHistory).toHaveBeenCalledTimes(1)
    const entry = mockStoreAddHistory.mock.calls[0][0]
    expect(entry.status).toBe('error')
    expect(entry.error).toBe('missed_recording')
    expect(entry.date).toBe('2026-05-17')
    expect(entry.startTime).toBe('11:00')
  })

  it('does not log when a history entry exists within ±30 min of the slot', () => {
    // Slot at 11:00; history has an OK entry at 11:05 (within window)
    const slotTime = new Date(2026, 4, 17, 11, 5, 0).getTime()
    mockStoreGetHistory.mockReturnValue([
      { date: '2026-05-17', startTime: '11:05', duration: '00:55', filename: 'rec.mp3', status: 'ok', timestamp: slotTime },
    ])
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return [{ days: [6], start: '11:00', stop: '12:00' }]
      if (key === 'specialRecordings') return []
      if (key === 'reminderMinutes') return 0
      return null
    })
    checkMissedRecordings()
    expect(mockStoreAddHistory).not.toHaveBeenCalled()
  })

  it('still logs when the only history entry is far outside the ±30 min window', () => {
    // Slot at 11:00; history entry is at 12:00 — 60 min away, > 30 min window
    const histTime = new Date(2026, 4, 17, 12, 0, 0).getTime()
    mockStoreGetHistory.mockReturnValue([
      { date: '2026-05-17', startTime: '12:00', duration: '00:30', filename: 'rec.mp3', status: 'ok', timestamp: histTime },
    ])
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return [{ days: [6], start: '11:00', stop: '12:00' }]
      if (key === 'specialRecordings') return []
      if (key === 'reminderMinutes') return 0
      return null
    })
    checkMissedRecordings()
    expect(mockStoreAddHistory).toHaveBeenCalledTimes(1)
  })

  it('does not log when a special-recording slot has matching history', () => {
    // Special on 2026-05-17 11:00; history at 11:00
    const specialTime = new Date(2026, 4, 17, 11, 0, 0).getTime()
    mockStoreGetHistory.mockReturnValue([
      { date: '2026-05-17', startTime: '11:00', duration: '01:00', filename: 'special.mp3', status: 'ok', timestamp: specialTime },
    ])
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return []
      if (key === 'specialRecordings') return [{ date: '2026-05-17', start: '11:00', stop: '12:00', name: 'Konfirmasjon' }]
      if (key === 'reminderMinutes') return 0
      return null
    })
    checkMissedRecordings()
    expect(mockStoreAddHistory).not.toHaveBeenCalled()
  })

  it('logs a missed special-recording with the special name as filename', () => {
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return []
      if (key === 'specialRecordings') return [{ date: '2026-05-17', start: '11:00', stop: '12:00', name: 'Konfirmasjon' }]
      if (key === 'reminderMinutes') return 0
      return null
    })
    checkMissedRecordings()
    expect(mockStoreAddHistory).toHaveBeenCalledTimes(1)
    const entry = mockStoreAddHistory.mock.calls[0][0]
    expect(entry.filename).toBe('Konfirmasjon')
    expect(entry.status).toBe('error')
    expect(entry.error).toBe('missed_recording')
  })

  it('logs multiple missed slots in a single check', () => {
    // Two distinct slot times: 09:00 and 11:00 on Sunday, both > 60 min old at 14:00
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return [
        { days: [6], start: '09:00', stop: '10:00' },
        { days: [6], start: '11:00', stop: '12:00' },
      ]
      if (key === 'specialRecordings') return []
      if (key === 'reminderMinutes') return 0
      return null
    })
    checkMissedRecordings()
    expect(mockStoreAddHistory).toHaveBeenCalledTimes(2)
  })

  it('does not log a slot whose start time is older than 24 h', () => {
    // Set now to Saturday — last Sunday's 11:00 is more than 24 h ago.
    // The slot's mostRecentOccurrence is the PREVIOUS Sunday (7 d ago), outside log window.
    jest.setSystemTime(new Date(2026, 4, 23, 14, 0, 0))  // Sat May 23 14:00
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return [{ days: [6], start: '11:00', stop: '12:00' }]
      if (key === 'specialRecordings') return []
      if (key === 'reminderMinutes') return 0
      return null
    })
    checkMissedRecordings()
    expect(mockStoreAddHistory).not.toHaveBeenCalled()
  })

  it('does not double-log a slot that already has a missed-status entry', () => {
    // Slot at 11:00 missed; history already has the 'missed' marker at 11:00.
    // historyCovers checks any entry within ±30 min — so the prior missed
    // entry counts as coverage. (Same logic as success entries.)
    const slotTime = new Date(2026, 4, 17, 11, 0, 0).getTime()
    mockStoreGetHistory.mockReturnValue([
      { date: '2026-05-17', startTime: '11:00', duration: '—', filename: 'Ukentlig opptak (11:00–12:00)', status: 'error', error: 'missed_recording', timestamp: slotTime },
    ])
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return [{ days: [6], start: '11:00', stop: '12:00' }]
      if (key === 'specialRecordings') return []
      if (key === 'reminderMinutes') return 0
      return null
    })
    checkMissedRecordings()
    expect(mockStoreAddHistory).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Midnight-crossing slots
// ═══════════════════════════════════════════════════════════════════════════
//
// scheduler.ts computes:
//   crossesMidnight = (eh < sh) || (eh === sh && em <= sm)
// When true, the stop job is registered on (jsDay + 1) % 7 instead of jsDay.
// Without this fix, the stop fires on the SAME weekday as start — i.e.
// immediately, before the recording has started — leaving the previous
// recording running for a full week.

describe('midnight-crossing slots — scheduler.reschedule()', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    // Pin to Fri 2026-05-15 12:00 so "next Sat 23:00" and "next Sun 03:00"
    // are both in the upcoming week.
    jest.setSystemTime(new Date(2026, 4, 15, 12, 0, 0))
    mockStoreGet.mockImplementation(() => null)
    mockStoreGetHistory.mockReturnValue([])
  })
  afterEach(() => {
    cancelAllSchedulerJobs()
    jest.useRealTimers()
  })

  /**
   * Inspect the scheduler's job map indirectly: every job is also registered
   * on node-schedule.scheduledJobs with a generated name. Walk that map and
   * return jobs whose nextInvocation looks like a wall-clock match for the
   * given hour/minute on the given UI day-of-week.
   */
  function nextInvocationsByName(): Record<string, Date> {
    const out: Record<string, Date> = {}
    for (const name of Object.keys(schedule.scheduledJobs)) {
      const inv = schedule.scheduledJobs[name]?.nextInvocation?.()
      if (inv) out[name] = inv as Date
    }
    return out
  }

  it('Sat 23:00 → Sun 01:30 schedules stop on Sunday (day+1), not Saturday', () => {
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return [{ days: [5], start: '23:00', stop: '01:30' }]  // uiDay 5 = Sat
      if (key === 'specialRecordings') return []
      if (key === 'reminderMinutes') return 0
      return null
    })
    init(mockWin)

    // Expected: start = Sat 2026-05-16 23:00 Oslo = 21:00 UTC
    //           stop  = Sun 2026-05-17 01:30 Oslo = 23:30 UTC (Sat)
    // If crossesMidnight handling were missing, stop would be on
    // Sat 01:30 which is BEFORE 23:00 → would fire on the NEXT Sat,
    // producing duration of ~6.5 d. Assert against the correct value.
    const all = nextInvocationsByName()
    const invs = Object.values(all).map(d => d.toISOString()).sort()

    expect(invs).toContain('2026-05-16T21:00:00.000Z')  // Sat 23:00 start
    expect(invs).toContain('2026-05-16T23:30:00.000Z')  // Sun 01:30 stop (UTC = Sat 23:30)

    // And duration is 2.5 h, not 6.5 d.
    const start = new Date('2026-05-16T21:00:00.000Z').getTime()
    const stop  = new Date('2026-05-16T23:30:00.000Z').getTime()
    expect((stop - start) / 3_600_000).toBeCloseTo(2.5, 5)
  })

  it('Sun 23:00 → Mon 03:00 schedules stop on Monday', () => {
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return [{ days: [6], start: '23:00', stop: '03:00' }]  // uiDay 6 = Sun
      if (key === 'specialRecordings') return []
      if (key === 'reminderMinutes') return 0
      return null
    })
    init(mockWin)

    // Sun 2026-05-17 23:00 Oslo = 21:00 UTC
    // Mon 2026-05-18 03:00 Oslo = 01:00 UTC
    const invs = Object.values(nextInvocationsByName()).map(d => d.toISOString())
    expect(invs).toContain('2026-05-17T21:00:00.000Z')
    expect(invs).toContain('2026-05-18T01:00:00.000Z')
  })

  it('Wed 22:00 → Wed 22:30 (same day, NOT crossing midnight) schedules both on Wed', () => {
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return [{ days: [2], start: '22:00', stop: '22:30' }]  // uiDay 2 = Wed
      if (key === 'specialRecordings') return []
      if (key === 'reminderMinutes') return 0
      return null
    })
    init(mockWin)

    // Wed 2026-05-20 22:00 Oslo = 20:00 UTC
    // Wed 2026-05-20 22:30 Oslo = 20:30 UTC
    const invs = Object.values(nextInvocationsByName()).map(d => d.toISOString())
    expect(invs).toContain('2026-05-20T20:00:00.000Z')
    expect(invs).toContain('2026-05-20T20:30:00.000Z')
  })

  it('Sat 23:59 → Sun 00:01 schedules stop one minute after start on the next day', () => {
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return [{ days: [5], start: '23:59', stop: '00:01' }]
      if (key === 'specialRecordings') return []
      if (key === 'reminderMinutes') return 0
      return null
    })
    init(mockWin)

    // Sat 2026-05-16 23:59 Oslo = 21:59 UTC
    // Sun 2026-05-17 00:01 Oslo = 22:01 UTC (Sat)
    const invs = Object.values(nextInvocationsByName()).map(d => d.toISOString())
    expect(invs).toContain('2026-05-16T21:59:00.000Z')
    expect(invs).toContain('2026-05-16T22:01:00.000Z')

    const start = new Date('2026-05-16T21:59:00.000Z').getTime()
    const stop  = new Date('2026-05-16T22:01:00.000Z').getTime()
    expect((stop - start) / 60_000).toBeCloseTo(2, 5)
  })

  it('Degenerate slot 00:00 → 00:00 is rejected and logged', () => {
    // Defensive: UI prevents this, but settings-file edits or imported
    // profiles can sneak it through. scheduler.ts must skip the slot
    // entirely rather than turning it into a 24-hour recording.
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return [{ days: [5], start: '00:00', stop: '00:00' }]
      if (key === 'specialRecordings') return []
      if (key === 'reminderMinutes') return 0
      return null
    })
    init(mockWin)

    // No slot jobs should have been registered.
    const slotJobs = Object.keys(schedule.scheduledJobs).filter(n => n.startsWith('slot-'))
    expect(slotJobs).toHaveLength(0)

    // A warning should be logged so the user knows.
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'scheduler',
      'degenerate_slot_skipped',
      expect.objectContaining({ start: '00:00', stop: '00:00' }),
    )
  })

  it('DST + midnight crossing: Sat 2026-03-28 23:00 → Sun 2026-03-29 01:30 elapses 2.5 h', () => {
    // Pin to Friday Mar 27 so the NEXT Sat is 2026-03-28 (DST weekend).
    jest.setSystemTime(new Date(2026, 2, 27, 12, 0, 0))
    mockStoreGet.mockImplementation((key: string) => {
      if (key === 'slots') return [{ days: [5], start: '23:00', stop: '01:30' }]
      if (key === 'specialRecordings') return []
      if (key === 'reminderMinutes') return 0
      return null
    })
    init(mockWin)

    // Sat 2026-03-28 23:00 Oslo (still winter time +01:00) = 22:00 UTC
    // Sun 2026-03-29 01:30 Oslo (still BEFORE the DST jump at 02:00) = 00:30 UTC
    const invs = Object.values(nextInvocationsByName()).map(d => d.toISOString())
    expect(invs).toContain('2026-03-28T22:00:00.000Z')
    expect(invs).toContain('2026-03-29T00:30:00.000Z')

    const start = new Date('2026-03-28T22:00:00.000Z').getTime()
    const stop  = new Date('2026-03-29T00:30:00.000Z').getTime()
    expect((stop - start) / 3_600_000).toBeCloseTo(2.5, 5)
  })
})
