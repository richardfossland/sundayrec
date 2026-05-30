import { useTranslation } from "react-i18next";

import {
  LANGUAGE_NAMES,
  SUPPORTED_LNGS,
  changeLanguage,
  type SupportedLng,
} from "@/i18n";

/**
 * Language picker. Lists every supported language by its endonym and switches
 * the whole UI via `changeLanguage` (which also persists the choice).
 */
export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const current = (
    SUPPORTED_LNGS as readonly string[]
  ).includes(i18n.language)
    ? (i18n.language as SupportedLng)
    : "no";

  return (
    <select
      className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
      aria-label={t("general.language", "Språk")}
      value={current}
      onChange={(e) => void changeLanguage(e.target.value)}
    >
      {SUPPORTED_LNGS.map((lng) => (
        <option key={lng} value={lng}>
          {LANGUAGE_NAMES[lng]}
        </option>
      ))}
    </select>
  );
}
