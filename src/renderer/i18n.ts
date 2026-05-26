import noLocale from '../locales/no.json'
import enLocale from '../locales/en.json'
import frLocale from '../locales/fr.json'
import deLocale from '../locales/de.json'
import svLocale from '../locales/sv.json'
import daLocale from '../locales/da.json'
import plLocale from '../locales/pl.json'

type LocaleData = Record<string, unknown>

const LOCALE_MAP: Record<string, LocaleData> = {
  no: noLocale as LocaleData,
  en: enLocale as LocaleData,
  fr: frLocale as LocaleData,
  de: deLocale as LocaleData,
  sv: svLocale as LocaleData,
  da: daLocale as LocaleData,
  pl: plLocale as LocaleData,
}

export let T: LocaleData = LOCALE_MAP['no']
export let currentLang = 'no'

export function loadLocale(lang: string): void {
  T = LOCALE_MAP[lang] ?? LOCALE_MAP['no']
  currentLang = LOCALE_MAP[lang] ? lang : 'no'
  applyTranslations()
}

export function t(key: string, fallback = ''): string {
  const val = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], T)
  return (val as string) ?? fallback
}

export function tArr(key: string, fallback: string[]): string[] {
  const val = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], T)
  return Array.isArray(val) ? val as string[] : fallback
}

let _applyTranslations = (): void => {}

export function setApplyHook(fn: () => void): void {
  _applyTranslations = fn
}

function applyTranslations(): void {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = (el as HTMLElement).dataset.i18n!
    const v = t(key); if (v) el.textContent = v
  })
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = (el as HTMLInputElement).dataset.i18nPlaceholder!
    const v = t(key); if (v) (el as HTMLInputElement).placeholder = v
  })
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = (el as HTMLElement).dataset.i18nTitle!
    const v = t(key); if (v) el.setAttribute('title', v)
  })
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    const key = (el as HTMLElement).dataset.i18nAriaLabel!
    const v = t(key); if (v) el.setAttribute('aria-label', v)
  })
  _applyTranslations()
}
