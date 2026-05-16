import { t, currentLang } from './i18n'

export function escHtml(str: unknown): string {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m] ?? m)
  )
}

export function setVal(id: string, val: unknown): void {
  const el = document.getElementById(id) as HTMLInputElement | null
  if (el && val !== undefined && val !== null) el.value = String(val)
}

export function setRadio(name: string, value: string): void {
  const r = document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)
  if (r) r.checked = true
}

export function updateSliderLabel(sliderId: string, labelId: string, suffix = ''): void {
  const el  = document.getElementById(sliderId) as HTMLInputElement | null
  const lbl = document.getElementById(labelId)
  if (el && lbl) lbl.textContent = el.value + suffix
}

export function flashSaved(btn: HTMLElement | null): void {
  if (!btn) return
  const orig   = btn.textContent ?? ''
  const origBg = (btn as HTMLElement).style.background
  btn.textContent = t('general.saved', '✓ Lagret')
  btn.style.background = 'var(--green)'
  setTimeout(() => { btn.textContent = orig; btn.style.background = origBg }, 1800)
}

export function flashMsg(btn: HTMLElement | null, msg: string, ok = true): void {
  if (!btn) return
  const orig   = btn.textContent ?? ''
  const origBg = (btn as HTMLElement).style.background
  btn.textContent = msg
  btn.style.background = ok ? 'var(--green)' : 'var(--red)'
  setTimeout(() => { btn.textContent = orig; btn.style.background = origBg }, 2500)
}

export function fmtDate(iso: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(currentLang === 'no' ? 'nb-NO' : currentLang, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric'
  })
}

export function fmtCountdown(ms: number): string {
  if (ms <= 0) return ''
  const totalSec = Math.floor(ms / 1000)
  const d  = Math.floor(totalSec / 86400)
  const h  = Math.floor((totalSec % 86400) / 3600)
  const m  = Math.floor((totalSec % 3600) / 60)
  const s  = totalSec % 60
  const ss = String(s).padStart(2, '0')
  const mm = String(m).padStart(2, '0')

  const uYr = t('time.yr', 'år')
  const uMo = t('time.mo', 'mnd.')
  const uWk = t('time.wk', 'u')
  const uD  = t('time.d',  'd')
  const uH  = t('time.h',  't')
  const uM  = t('time.m',  'm')
  const uS  = t('time.s',  's')

  if (d >= 365) {
    const yr  = Math.floor(d / 365)
    const mth = Math.round((d % 365) / 30)
    return mth > 0 ? `${yr} ${uYr} ${mth} ${uMo}` : `${yr} ${uYr}`
  }
  if (d >= 30) {
    const mth = Math.floor(d / 30); const rem = d % 30
    return rem > 0 ? `${mth} ${uMo} ${rem} ${uD}` : `${mth} ${uMo}`
  }
  if (d >= 7)  { const wk = Math.floor(d / 7); const rem = d % 7; return rem > 0 ? `${wk} ${uWk} ${rem} ${uD}` : `${wk} ${uWk}` }
  if (d >= 1)  { return h > 0 ? `${d} ${uD} ${h}${uH}` : `${d} ${uD}` }
  if (h > 0)   return `${h}${uH} ${mm}${uM} ${ss}${uS}`
  if (m > 0)   return `${m}${uM} ${ss}${uS}`
  return `${ss}${uS}`
}

export function fmtStorageHours(hours: number): string {
  const uH = t('time.h', 't')
  if (hours >= 8760) {
    const yr = hours / 8760
    return yr >= 10
      ? `${Math.round(yr)} ${t('time.years', 'år')}`
      : `${yr.toFixed(1)} ${t('time.years', 'år')}`
  }
  if (hours >= 720) return `${Math.round(hours / 720)} ${t('time.months', 'måneder')}`
  if (hours >= 168) return `${Math.round(hours / 168)} ${t('time.weeks', 'uker')}`
  if (hours >= 24)  return `${Math.round(hours / 24)} ${t('time.days', 'dager')}`
  return `${hours}${uH}`
}

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
