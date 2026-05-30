import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import no from "@/locales/no.json";
import en from "@/locales/en.json";
import de from "@/locales/de.json";
import sv from "@/locales/sv.json";
import da from "@/locales/da.json";
import fr from "@/locales/fr.json";
import pl from "@/locales/pl.json";

/** Every language SundayRec ships UI for. `no` is the source of truth. */
export const SUPPORTED_LNGS = [
  "no",
  "en",
  "de",
  "sv",
  "da",
  "fr",
  "pl",
] as const;
export type SupportedLng = (typeof SUPPORTED_LNGS)[number];

/** Human-readable endonyms for the language switcher. */
export const LANGUAGE_NAMES: Record<SupportedLng, string> = {
  no: "Norsk",
  en: "English",
  de: "Deutsch",
  sv: "Svenska",
  da: "Dansk",
  fr: "Français",
  pl: "Polski",
};

/** localStorage key the chosen language is persisted under. */
export const LANG_STORAGE_KEY = "sundayrec-lang";

const resources = {
  no: { translation: no },
  en: { translation: en },
  de: { translation: de },
  sv: { translation: sv },
  da: { translation: da },
  fr: { translation: fr },
  pl: { translation: pl },
} as const;

function isSupported(lng: string | null | undefined): lng is SupportedLng {
  return !!lng && (SUPPORTED_LNGS as readonly string[]).includes(lng);
}

/**
 * Resolve the initial language: an explicit choice in localStorage wins, then
 * the browser/OS language prefix if we support it, otherwise Norwegian.
 *
 * NOTE: In F1.2 this will be reconciled with `Settings.language` (the
 * persisted Rust-side setting). We deliberately do NOT call any Tauri command
 * here — i18n must initialise synchronously before the first render, and the
 * settings layer hydrates afterwards (it will call `changeLanguage` once it
 * knows the stored value).
 */
function resolveInitialLng(): SupportedLng {
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY);
    if (isSupported(stored)) return stored;
  } catch {
    // localStorage may be unavailable (e.g. private mode / SSR); fall through.
  }

  const nav =
    typeof navigator !== "undefined" ? navigator.language : undefined;
  const prefix = nav?.split("-")[0]?.toLowerCase();
  if (isSupported(prefix)) return prefix;

  return "no";
}

void i18n.use(initReactI18next).init({
  resources,
  lng: resolveInitialLng(),
  fallbackLng: "no",
  supportedLngs: [...SUPPORTED_LNGS],
  interpolation: { escapeValue: false },
  returnNull: false,
});

// Keep <html lang> in sync with the language we booted with.
if (typeof document !== "undefined") {
  document.documentElement.lang = i18n.language;
}

/**
 * Switch the active UI language: updates i18next, persists the choice, and
 * reflects it on `<html lang>`. Ignores unsupported codes.
 */
export async function changeLanguage(lng: string): Promise<void> {
  if (!isSupported(lng)) return;
  await i18n.changeLanguage(lng);
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lng);
  } catch {
    // Ignore persistence failures — the in-memory switch still took effect.
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = lng;
  }
}

export default i18n;
