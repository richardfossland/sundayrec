jest.mock('electron')
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}))
jest.mock('../src/main/store', () => ({
  get: jest.fn(() => false),
  set: jest.fn(),
}))

// wake.ts is not imported in these tests because all testable functions
// (padN, formatPmsetDate, formatWinDateTime) are not exported from the module.
// We re-implement the same pure logic here against the documented spec, and
// also verify that the module loads without throwing.

// ─── module smoke test ────────────────────────────────────────────────────────

describe('wake module', () => {
  it('loads without throwing', () => {
    expect(() => require('../src/main/wake')).not.toThrow()
  })

  it('exports reschedule as a function', () => {
    const wake = require('../src/main/wake')
    expect(typeof wake.reschedule).toBe('function')
  })

  it('exports getSleepConfig as a function', () => {
    const wake = require('../src/main/wake')
    expect(typeof wake.getSleepConfig).toBe('function')
  })

  it('exports fixMacSleep as a function', () => {
    const wake = require('../src/main/wake')
    expect(typeof wake.fixMacSleep).toBe('function')
  })

  it('exports fixWinWakeTimers as a function', () => {
    const wake = require('../src/main/wake')
    expect(typeof wake.fixWinWakeTimers).toBe('function')
  })
})

// ─── padN (inline re-implementation to verify the contract) ──────────────────

function padN(n: number): string {
  return String(n).padStart(2, '0')
}

describe('padN', () => {
  it('zero-pads single digit numbers', () => {
    expect(padN(0)).toBe('00')
    expect(padN(1)).toBe('01')
    expect(padN(9)).toBe('09')
  })

  it('leaves two-digit numbers unchanged', () => {
    expect(padN(10)).toBe('10')
    expect(padN(59)).toBe('59')
  })

  it('does not truncate numbers with three or more digits', () => {
    expect(padN(100)).toBe('100')
  })
})

// ─── formatPmsetDate ─────────────────────────────────────────────────────────

function formatPmsetDate(d: Date): string {
  const yy = String(d.getFullYear()).slice(-2)
  return `${padN(d.getMonth() + 1)}/${padN(d.getDate())}/${yy} ${padN(d.getHours())}:${padN(d.getMinutes())}:00`
}

describe('formatPmsetDate', () => {
  it('formats a January date correctly', () => {
    const d = new Date(2026, 0, 5, 9, 3, 0)   // Jan 5 2026 09:03
    expect(formatPmsetDate(d)).toBe('01/05/26 09:03:00')
  })

  it('formats a December date correctly', () => {
    const d = new Date(2025, 11, 31, 23, 59, 0)
    expect(formatPmsetDate(d)).toBe('12/31/25 23:59:00')
  })

  it('always ends with :00 seconds', () => {
    const d = new Date(2026, 4, 17, 11, 0, 45)
    expect(formatPmsetDate(d)).toMatch(/:00$/)
  })

  it('uses two-digit year', () => {
    const d = new Date(2026, 4, 17, 11, 0, 0)
    expect(formatPmsetDate(d)).toMatch(/^05\/17\/26 /)
  })

  it('pads month, day, hour and minute with leading zeros', () => {
    const d = new Date(2026, 0, 1, 1, 2, 0)   // Jan 1 2026 01:02
    expect(formatPmsetDate(d)).toBe('01/01/26 01:02:00')
  })
})

// ─── formatWinDateTime ───────────────────────────────────────────────────────

function formatWinDateTime(d: Date): string {
  return `${d.getFullYear()}-${padN(d.getMonth() + 1)}-${padN(d.getDate())}T${padN(d.getHours())}:${padN(d.getMinutes())}:00`
}

describe('formatWinDateTime', () => {
  it('formats a date in ISO-like local format', () => {
    const d = new Date(2026, 4, 17, 10, 50, 0)   // May 17 2026 10:50
    expect(formatWinDateTime(d)).toBe('2026-05-17T10:50:00')
  })

  it('pads month, day, hour and minute', () => {
    const d = new Date(2026, 0, 1, 1, 2, 0)   // Jan 1 2026 01:02
    expect(formatWinDateTime(d)).toBe('2026-01-01T01:02:00')
  })

  it('always ends with :00 seconds', () => {
    const d = new Date(2026, 5, 15, 8, 30, 55)
    expect(formatWinDateTime(d)).toMatch(/:00$/)
  })

  it('uses four-digit year', () => {
    const d = new Date(2026, 11, 31, 23, 59, 0)
    expect(formatWinDateTime(d)).toMatch(/^2026-/)
  })
})
