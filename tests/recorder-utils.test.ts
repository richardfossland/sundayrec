import { localDateStr, buildFilename, codecFor, formatDuration } from '../src/main/recorder-utils'

// Fixed local timestamp: 2026-05-16 11:00:00 local time
const START_MS = new Date(2026, 4, 16, 11, 0, 0).getTime()

// ─── localDateStr ────────────────────────────────────────────────────────────

describe('localDateStr', () => {
  it('formats with leading zeros on month and day', () => {
    expect(localDateStr(new Date(2026, 0, 5))).toBe('2026-01-05')   // Jan  5
    expect(localDateStr(new Date(2026, 8, 3))).toBe('2026-09-03')   // Sep  3
  })

  it('formats December 31', () => {
    expect(localDateStr(new Date(2026, 11, 31))).toBe('2026-12-31')
  })

  it('uses LOCAL date fields (getFullYear / getMonth / getDate)', () => {
    // Construct May 16 in local time — toISOString() might show May 15 in UTC+X
    expect(localDateStr(new Date(2026, 4, 16))).toBe('2026-05-16')
  })
})

// ─── buildFilename ───────────────────────────────────────────────────────────

describe('buildFilename — date pattern (default)', () => {
  it('returns YYYY-MM-DD.ext using startMs', () => {
    expect(buildFilename({ format: 'mp3', filenamePattern: 'date' }, START_MS))
      .toBe('2026-05-16.mp3')
  })

  it('falls back to current date when startMs is omitted', () => {
    const f = buildFilename({ format: 'mp3', filenamePattern: 'date' })
    expect(f).toMatch(/^\d{4}-\d{2}-\d{2}\.mp3$/)
  })

  it('uses startMs date, not conversion time', () => {
    const earlyMs = new Date(2026, 0, 1, 11, 0, 0).getTime()
    expect(buildFilename({ format: 'mp3' }, earlyMs)).toBe('2026-01-01.mp3')
  })
})

describe('buildFilename — plain pattern', () => {
  it('prefixes gudstjeneste_', () => {
    expect(buildFilename({ format: 'mp3', filenamePattern: 'plain' }, START_MS))
      .toBe('gudstjeneste_2026-05-16.mp3')
  })
})

describe('buildFilename — datetime pattern', () => {
  it('appends HHMM after the date', () => {
    const f = buildFilename({ format: 'mp3', filenamePattern: 'datetime' }, START_MS)
    expect(f).toMatch(/^2026-05-16_\d{4}\.mp3$/)
  })
})

describe('buildFilename — church pattern', () => {
  it('uses Palm Sunday name for April 13 2025', () => {
    const palmMs = new Date(2025, 3, 13).getTime()
    expect(buildFilename({ format: 'mp3', filenamePattern: 'church' }, palmMs))
      .toBe('palmesondag_2025-04-13.mp3')
  })

  it('uses gudstjeneste for a normal Sunday', () => {
    const normalMs = new Date(2025, 5, 15).getTime()  // Jun 15 2025
    expect(buildFilename({ format: 'mp3', filenamePattern: 'church' }, normalMs))
      .toBe('gudstjeneste_2025-06-15.mp3')
  })
})

describe('buildFilename — customName', () => {
  it('overrides pattern and sanitises the name', () => {
    expect(buildFilename({ format: 'mp3', customName: 'Min Kirke' }, START_MS))
      .toBe('Min Kirke_2026-05-16.mp3')
  })

  it('replaces forbidden filesystem chars with underscore', () => {
    expect(buildFilename({ format: 'mp3', customName: 'A/B:C*D?"<>|\\E' }, START_MS))
      .toBe('A_B_C_D______E_2026-05-16.mp3')
  })

  it('trims whitespace before sanitising', () => {
    expect(buildFilename({ format: 'mp3', customName: '  Kirke  ' }, START_MS))
      .toBe('Kirke_2026-05-16.mp3')
  })
})

describe('buildFilename — splitTimestamp', () => {
  it('inserts timestamp before the date', () => {
    expect(buildFilename({ format: 'mp3', filenamePattern: 'plain', splitTimestamp: '1100' }, START_MS))
      .toBe('gudstjeneste_1100_2026-05-16.mp3')
  })

  it('works with customName and timestamp', () => {
    expect(buildFilename({ format: 'mp3', customName: 'Kirke', splitTimestamp: '1030' }, START_MS))
      .toBe('Kirke_1030_2026-05-16.mp3')
  })
})

describe('buildFilename — format extension', () => {
  it.each([
    ['mp3',  'mp3'],
    ['flac', 'flac'],
    ['aac',  'aac'],
    ['wav',  'wav'],
  ])('format %s → .%s extension', (fmt, ext) => {
    const f = buildFilename({ format: fmt as any, filenamePattern: 'date' }, START_MS)
    expect(f).toMatch(new RegExp(`\\.${ext}$`))
  })

  it('defaults to mp3 when format is missing', () => {
    expect(buildFilename({ filenamePattern: 'date' }, START_MS)).toMatch(/\.mp3$/)
  })
})

// ─── codecFor ────────────────────────────────────────────────────────────────

describe('codecFor', () => {
  it.each([
    ['mp3',  'libmp3lame'],
    ['flac', 'flac'],
    ['aac',  'aac'],
    ['wav',  'pcm_s16le'],
  ])('%s → %s', (fmt, codec) => {
    expect(codecFor(fmt)).toBe(codec)
  })

  it('falls back to libmp3lame for unknown format', () => {
    expect(codecFor('ogg')).toBe('libmp3lame')
    expect(codecFor('')).toBe('libmp3lame')
  })
})

// ─── formatDuration ──────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('shows only minutes when under one hour', () => {
    expect(formatDuration(0)).toBe('0m')
    expect(formatDuration(30)).toBe('0m')
    expect(formatDuration(60)).toBe('1m')
    expect(formatDuration(90)).toBe('1m')
    expect(formatDuration(3599)).toBe('59m')
  })

  it('shows hours and minutes at one hour and beyond', () => {
    expect(formatDuration(3600)).toBe('1t 0m')
    expect(formatDuration(3660)).toBe('1t 1m')
    expect(formatDuration(5400)).toBe('1t 30m')
    expect(formatDuration(7200)).toBe('2t 0m')
    expect(formatDuration(7261)).toBe('2t 1m')
  })
})
