import {
  computeEaster,
  adventStart,
  getChurchHolidays,
  churchCalendarName,
  isoDate,
} from '../src/shared/church-calendar'

describe('computeEaster', () => {
  const cases: [number, string][] = [
    [2000, '2000-04-23'],
    [2008, '2008-03-23'],
    [2019, '2019-04-21'],
    [2020, '2020-04-12'],
    [2021, '2021-04-04'],
    [2022, '2022-04-17'],
    [2023, '2023-04-09'],
    [2024, '2024-03-31'],
    [2025, '2025-04-20'],
    [2026, '2026-04-05'],
    [2027, '2027-03-28'],
    [2038, '2038-04-25'],
  ]
  test.each(cases)('year %i → %s', (year, expected) => {
    expect(isoDate(computeEaster(year))).toBe(expected)
  })

  test('easter is always in March or April', () => {
    for (let y = 1990; y <= 2050; y++) {
      const m = computeEaster(y).getMonth()
      expect(m === 2 || m === 3).toBe(true)
    }
  })
})

describe('adventStart', () => {
  test('2023 → 2023-12-03', () => expect(isoDate(adventStart(2023))).toBe('2023-12-03'))
  test('2024 → 2024-12-01', () => expect(isoDate(adventStart(2024))).toBe('2024-12-01'))
  test('2025 → 2025-11-30', () => expect(isoDate(adventStart(2025))).toBe('2025-11-30'))
  test('2026 → 2026-11-29', () => expect(isoDate(adventStart(2026))).toBe('2026-11-29'))

  test('always falls on a Sunday', () => {
    for (let y = 2020; y <= 2035; y++) {
      expect(adventStart(y).getDay()).toBe(0)
    }
  })

  test('always in November or December', () => {
    for (let y = 2020; y <= 2035; y++) {
      const m = adventStart(y).getMonth()
      expect(m === 10 || m === 11).toBe(true)
    }
  })
})

describe('getChurchHolidays', () => {
  const h2025 = getChurchHolidays(2025)

  test('Easter week 2025', () => {
    expect(h2025['2025-04-13']).toBe('Palmesøndag')
    expect(h2025['2025-04-17']).toBe('Skjærtorsdag')
    expect(h2025['2025-04-18']).toBe('Langfredag')
    expect(h2025['2025-04-20']).toBe('Første påskedag')
    expect(h2025['2025-04-21']).toBe('Andre påskedag')
  })

  test('Ascension and Pentecost 2025', () => {
    expect(h2025['2025-05-29']).toBe('Kristi himmelfartsdag')
    expect(h2025['2025-06-08']).toBe('Første pinsedag')
    expect(h2025['2025-06-09']).toBe('Andre pinsedag')
  })

  test('fixed Norwegian holidays 2025', () => {
    expect(h2025['2025-01-01']).toBe('Nyttårsdag')
    expect(h2025['2025-01-06']).toBe('Helligtrekongers dag')
    expect(h2025['2025-05-01']).toBe('Arbeidernes dag')
    expect(h2025['2025-05-17']).toBe('17. mai')
    expect(h2025['2025-12-24']).toBe('Julaften')
    expect(h2025['2025-12-25']).toBe('Første juledag')
    expect(h2025['2025-12-26']).toBe('Andre juledag')
  })

  test('1. advent 2025', () => {
    expect(h2025['2025-11-30']).toBe('1. søndag i advent')
  })
})

describe('churchCalendarName', () => {
  test('fixed holidays', () => {
    expect(churchCalendarName(new Date(2025, 11, 24))).toBe('julaften')
    expect(churchCalendarName(new Date(2025, 11, 25))).toBe('1-juledag')
    expect(churchCalendarName(new Date(2025, 11, 26))).toBe('2-juledag')
    expect(churchCalendarName(new Date(2025,  0,  1))).toBe('nyttarsdag')
    expect(churchCalendarName(new Date(2025,  0,  6))).toBe('helligtrekonger')
  })

  test('easter-relative days 2025', () => {
    expect(churchCalendarName(new Date(2025, 3, 13))).toBe('palmesondag')
    expect(churchCalendarName(new Date(2025, 3, 17))).toBe('skaertorsdag')
    expect(churchCalendarName(new Date(2025, 3, 18))).toBe('langfredag')
    expect(churchCalendarName(new Date(2025, 3, 20))).toBe('1-paaskedag')
    expect(churchCalendarName(new Date(2025, 3, 21))).toBe('2-paaskedag')
    expect(churchCalendarName(new Date(2025, 4, 29))).toBe('kristi-himmelfartsdag')
    expect(churchCalendarName(new Date(2025, 5,  8))).toBe('1-pinsedag')
    expect(churchCalendarName(new Date(2025, 5,  9))).toBe('2-pinsedag')
  })

  test('easter-relative days 2026', () => {
    // Easter 2026 = April 5
    expect(churchCalendarName(new Date(2026, 2, 29))).toBe('palmesondag')
    expect(churchCalendarName(new Date(2026, 3,  5))).toBe('1-paaskedag')
    expect(churchCalendarName(new Date(2026, 3,  6))).toBe('2-paaskedag')
  })

  test('advent Sundays 2025', () => {
    expect(churchCalendarName(new Date(2025, 10, 30))).toBe('1-advent')
    expect(churchCalendarName(new Date(2025, 11,  7))).toBe('2-advent')
    expect(churchCalendarName(new Date(2025, 11, 14))).toBe('3-advent')
    expect(churchCalendarName(new Date(2025, 11, 21))).toBe('4-advent')
  })

  test('ordinary Sundays return gudstjeneste', () => {
    expect(churchCalendarName(new Date(2025, 1,  9))).toBe('gudstjeneste')
    expect(churchCalendarName(new Date(2025, 7,  3))).toBe('gudstjeneste')
    expect(churchCalendarName(new Date(2025, 8, 14))).toBe('gudstjeneste')
  })
})
