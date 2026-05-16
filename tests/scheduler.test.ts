import { uiDayToJsDay, slotActiveNow, specialActiveNow } from '../src/main/scheduler'

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
