/**
 * Map ISO date → list of holiday names. Multiple holidays can fall on the same
 * date — e.g. Kristi himmelfartsdag occasionally lands on 1. mai or 17. mai.
 * Returning a string[] preserves all of them; clients render with .join(' · ').
 */
export interface ChurchHolidays {
  [isoDate: string]: string[]
}

export function computeEaster(year: number): Date {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m2 = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m2 + 114) / 31) - 1
  const day   = ((h + l - 7 * m2 + 114) % 31) + 1
  return new Date(year, month, day)
}

export function adventStart(year: number): Date {
  const christmas = new Date(year, 11, 25)
  const dow = christmas.getDay()
  const daysBack = dow === 0 ? 28 : (dow + 21)
  return new Date(year, 11, 25 - daysBack)
}

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function easterOffset(year: number, days: number): string {
  const e = computeEaster(year)
  e.setDate(e.getDate() + days)
  return isoDate(e)
}

function fixed(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function getChurchHolidays(year: number): ChurchHolidays {
  const adv1 = adventStart(year)
  const out: ChurchHolidays = {}
  const add = (iso: string, name: string) => {
    const cur = out[iso]
    if (cur) cur.push(name)
    else out[iso] = [name]
  }
  add(easterOffset(year, -7),  'Palmesøndag')
  add(easterOffset(year, -3),  'Skjærtorsdag')
  add(easterOffset(year, -2),  'Langfredag')
  add(easterOffset(year,  0),  'Første påskedag')
  add(easterOffset(year,  1),  'Andre påskedag')
  add(easterOffset(year, 39),  'Kristi himmelfartsdag')
  add(easterOffset(year, 49),  'Første pinsedag')
  add(easterOffset(year, 50),  'Andre pinsedag')
  add(fixed(year, 1,  1),      'Nyttårsdag')
  add(fixed(year, 1,  6),      'Helligtrekongers dag')
  add(fixed(year, 5,  1),      'Arbeidernes dag')
  add(fixed(year, 5, 17),      '17. mai')
  // Allehelgensdag — første søndag i november. A widely-observed Norwegian
  // church holiday with a special service that some congregations want to
  // mark on the calendar.
  add(isoDate(firstSundayOfNovember(year)), 'Allehelgensdag')
  add(fixed(year, 12, 24),     'Julaften')
  add(fixed(year, 12, 25),     'Første juledag')
  add(fixed(year, 12, 26),     'Andre juledag')
  add(isoDate(adv1),           '1. søndag i advent')
  return out
}

function firstSundayOfNovember(year: number): Date {
  const d = new Date(year, 10, 1)
  const dow = d.getDay()  // 0 = Sunday
  const daysToAdd = dow === 0 ? 0 : (7 - dow)
  return new Date(year, 10, 1 + daysToAdd)
}

export function churchCalendarName(date: Date): string {
  const m = date.getMonth()
  const d = date.getDate()

  if (m === 11 && d === 24) return 'julaften'
  if (m === 11 && d === 25) return '1-juledag'
  if (m === 11 && d === 26) return '2-juledag'
  if (m === 0  && d === 1)  return 'nyttarsdag'
  if (m === 0  && d === 6)  return 'helligtrekonger'

  const easter = computeEaster(date.getFullYear())
  const diff = Math.round((date.getTime() - easter.getTime()) / 86400000)

  if (diff === -7)  return 'palmesondag'
  if (diff === -3)  return 'skaertorsdag'
  if (diff === -2)  return 'langfredag'
  if (diff === 0)   return '1-paaskedag'
  if (diff === 1)   return '2-paaskedag'
  if (diff === 39)  return 'kristi-himmelfartsdag'
  if (diff === 49)  return '1-pinsedag'
  if (diff === 50)  return '2-pinsedag'

  const adv = adventStart(date.getFullYear())
  const advDiff = Math.round((date.getTime() - adv.getTime()) / 86400000)
  if (advDiff === 0)  return '1-advent'
  if (advDiff === 7)  return '2-advent'
  if (advDiff === 14) return '3-advent'
  if (advDiff === 21) return '4-advent'

  return 'gudstjeneste'
}
