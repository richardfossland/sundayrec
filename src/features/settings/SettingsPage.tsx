import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { Settings } from "@/lib/bindings/Settings";
import type { ChannelMode } from "@/lib/bindings/ChannelMode";
import type { FileFormat } from "@/lib/bindings/FileFormat";
import type { FilenamePattern } from "@/lib/bindings/FilenamePattern";
import {
  LANGUAGE_NAMES,
  SUPPORTED_LNGS,
  changeLanguage,
  type SupportedLng,
} from "@/i18n";
import { SETTINGS_QUERY_KEY } from "./queryKey";

/** Debounce (ms) before an edit is auto-saved — matches the Electron feel. */
const SAVE_DEBOUNCE_MS = 500;

/** A labelled section wrapper. */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-zinc-700 p-4">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      {children}
    </fieldset>
  );
}

/** A label + control row. */
function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={htmlFor} className="text-sm opacity-80">
        {label}
      </label>
      {children}
    </div>
  );
}

const inputClass =
  "rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm";

/**
 * The settings page. Loads the persisted `Settings` over IPC, renders a grouped
 * form for the Fase-1 fields, and debounce-auto-saves edits back through
 * `settings_save`. The language selector additionally drives `changeLanguage`
 * so the live UI follows the persisted choice.
 */
export function SettingsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery<Settings>({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => invoke<Settings>("settings_get"),
  });

  // Local working copy so controlled inputs stay snappy; the debounced save
  // flushes it to the backend, which returns the validated (clamped) value.
  const [draft, setDraft] = useState<Settings | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed/refresh the draft whenever the server value changes.
  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (next: Settings) =>
      invoke<Settings>("settings_save", { settings: next }),
    onSuccess: (saved) => {
      // The backend clamps; reflect the canonical value back into the cache.
      queryClient.setQueryData(SETTINGS_QUERY_KEY, saved);
      setDraft(saved);
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => invoke<Settings>("settings_reset"),
    onSuccess: (defaults) => {
      queryClient.setQueryData(SETTINGS_QUERY_KEY, defaults);
      setDraft(defaults);
      if (defaults.language) void changeLanguage(defaults.language);
    },
  });

  // Apply a partial change to the draft and schedule a debounced save.
  const patch = useCallback(
    (partial: Partial<Settings>) => {
      setDraft((prev) => {
        if (!prev) return prev;
        const next = { ...prev, ...partial };
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          saveMutation.mutate(next);
        }, SAVE_DEBOUNCE_MS);
        return next;
      });
    },
    [saveMutation],
  );

  // Flush any pending save when unmounting so a quick edit-then-leave persists.
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // Language is special: change i18n immediately AND persist it.
  const onLanguageChange = useCallback(
    (lng: string) => {
      void changeLanguage(lng);
      patch({ language: lng });
    },
    [patch],
  );

  if (isLoading || !draft) {
    return (
      <p className="opacity-70">{t("home.connecting", "Kobler til backend …")}</p>
    );
  }

  if (isError) {
    return (
      <p className="text-red-400">
        {t("home.backendError", "Backend-feil")}:{" "}
        {(error as Error)?.message ?? t("general.unknownError", "ukjent feil")}
      </p>
    );
  }

  const currentLng: SupportedLng =
    draft.language && (SUPPORTED_LNGS as readonly string[]).includes(draft.language)
      ? (draft.language as SupportedLng)
      : "no";

  return (
    <section
      className="flex w-full max-w-md flex-col gap-4"
      aria-label={t("nav.general", "Generelt")}
    >
      {/* ── Language ─────────────────────────────────────────────────────── */}
      <Section title={t("general.appLanguage", "Språk")}>
        <Field label={t("general.language", "Språk")} htmlFor="settings-language">
          <select
            id="settings-language"
            className={inputClass}
            aria-label={t("general.language", "Språk")}
            value={currentLng}
            onChange={(e) => onLanguageChange(e.target.value)}
          >
            {SUPPORTED_LNGS.map((lng) => (
              <option key={lng} value={lng}>
                {LANGUAGE_NAMES[lng]}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      {/* ── Audio ────────────────────────────────────────────────────────── */}
      <Section title={t("audio.title", "Lydkilde")}>
        <Field label={t("audio.channels", "Kanaler")} htmlFor="settings-channels">
          <select
            id="settings-channels"
            className={inputClass}
            value={draft.channels}
            onChange={(e) => patch({ channels: e.target.value as ChannelMode })}
          >
            <option value="stereo">{t("audio.stereo", "Stereo")}</option>
            <option value="monoL">{t("audio.monoL", "Mono — venstre")}</option>
            <option value="monoR">{t("audio.monoR", "Mono — høyre")}</option>
            <option value="monoMix">{t("audio.monoMix", "Mono — miks")}</option>
          </select>
        </Field>

        <Field
          label={t("audio.sampleRate", "Samplingsrate")}
          htmlFor="settings-sample-rate"
        >
          <select
            id="settings-sample-rate"
            className={inputClass}
            value={draft.sampleRate}
            onChange={(e) => patch({ sampleRate: Number(e.target.value) })}
          >
            <option value={44100}>44 100 Hz</option>
            <option value={48000}>48 000 Hz</option>
            <option value={96000}>96 000 Hz</option>
          </select>
        </Field>

        <Field
          label={t("audio.inputVolume", "Inngangsvolum")}
          htmlFor="settings-input-volume"
        >
          <input
            id="settings-input-volume"
            type="number"
            min={0}
            max={200}
            className={`${inputClass} w-24`}
            value={draft.inputVolume}
            onChange={(e) => patch({ inputVolume: Number(e.target.value) })}
          />
        </Field>
      </Section>

      {/* ── Output ───────────────────────────────────────────────────────── */}
      <Section title={t("files.format", "Format & Kvalitet")}>
        <Field label={t("files.fileFormat", "Filformat")} htmlFor="settings-format">
          <select
            id="settings-format"
            className={inputClass}
            value={draft.format}
            onChange={(e) => patch({ format: e.target.value as FileFormat })}
          >
            <option value="mp3">MP3</option>
            <option value="wav">WAV</option>
            <option value="flac">FLAC</option>
            <option value="aac">AAC</option>
          </select>
        </Field>

        <Field label={t("files.pattern", "Navnmønster")} htmlFor="settings-pattern">
          <select
            id="settings-pattern"
            className={inputClass}
            value={draft.filenamePattern}
            onChange={(e) =>
              patch({ filenamePattern: e.target.value as FilenamePattern })
            }
          >
            <option value="date">{t("files.patternDate", "Dato")}</option>
            <option value="church">
              {t("files.patternChurch", "Kirkelig navn + dato")}
            </option>
            <option value="plain">
              {t("files.patternPlain", "Gudstjeneste + dato")}
            </option>
            <option value="datetime">
              {t("files.patternDatetime", "Dato + klokkeslett")}
            </option>
          </select>
        </Field>

        <Field
          label={t("files.autoDelete", "Slett automatisk etter dager")}
          htmlFor="settings-auto-delete"
        >
          <input
            id="settings-auto-delete"
            type="number"
            min={0}
            max={3650}
            className={`${inputClass} w-24`}
            value={draft.autoDeleteDays}
            onChange={(e) => patch({ autoDeleteDays: Number(e.target.value) })}
          />
        </Field>
      </Section>

      {/* ── Recording behaviour ──────────────────────────────────────────── */}
      <Section title={t("files.behaviourTitle", "Opptaksoppførsel")}>
        <Field
          label={t("schedule.silenceTitle", "Stopp ved stillhet")}
          htmlFor="settings-stop-on-silence"
        >
          <input
            id="settings-stop-on-silence"
            type="checkbox"
            checked={draft.stopOnSilence}
            onChange={(e) => patch({ stopOnSilence: e.target.checked })}
          />
        </Field>

        <Field
          label={t("files.trimSilence", "Trim stillhet")}
          htmlFor="settings-trim-silence"
        >
          <input
            id="settings-trim-silence"
            type="checkbox"
            checked={draft.trimSilence}
            onChange={(e) => patch({ trimSilence: e.target.checked })}
          />
        </Field>

        <Field
          label={t("schedule.splitTitle", "Del opp filer")}
          htmlFor="settings-split-minutes"
        >
          <input
            id="settings-split-minutes"
            type="number"
            min={0}
            max={480}
            className={`${inputClass} w-24`}
            value={draft.splitMinutes}
            onChange={(e) => patch({ splitMinutes: Number(e.target.value) })}
          />
        </Field>
      </Section>

      {/* ── System behaviour ─────────────────────────────────────────────── */}
      <Section title={t("general.system", "System")}>
        <Field
          label={t("general.autoStart", "Start automatisk")}
          htmlFor="settings-launch-at-login"
        >
          <input
            id="settings-launch-at-login"
            type="checkbox"
            checked={draft.launchAtLogin}
            onChange={(e) => patch({ launchAtLogin: e.target.checked })}
          />
        </Field>

        <Field
          label={t("general.showOnStartup", "Vis vindu ved oppstart")}
          htmlFor="settings-show-on-startup"
        >
          <input
            id="settings-show-on-startup"
            type="checkbox"
            checked={draft.showOnStartup}
            onChange={(e) => patch({ showOnStartup: e.target.checked })}
          />
        </Field>

        <Field
          label={t("general.autoUpdate", "Oppdater automatisk")}
          htmlFor="settings-auto-update"
        >
          <input
            id="settings-auto-update"
            type="checkbox"
            checked={draft.autoUpdate}
            onChange={(e) => patch({ autoUpdate: e.target.checked })}
          />
        </Field>

        <Field
          label={t("general.askOpenEditor", "Spør om redigering")}
          htmlFor="settings-ask-open-editor"
        >
          <input
            id="settings-ask-open-editor"
            type="checkbox"
            checked={draft.askOpenEditor}
            onChange={(e) => patch({ askOpenEditor: e.target.checked })}
          />
        </Field>
      </Section>

      <div className="flex items-center justify-between">
        {saveMutation.isPending && (
          <span className="text-xs opacity-50">{t("general.save", "Lagre")}…</span>
        )}
        {saveMutation.isSuccess && !saveMutation.isPending && (
          <span className="text-xs text-emerald-400">
            {t("general.saved", "✓ Lagret")}
          </span>
        )}
        <button
          type="button"
          className="ml-auto rounded border border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-800"
          onClick={() => resetMutation.mutate()}
        >
          {t("general.restore", "Gjenopprett standard")}
        </button>
      </div>
    </section>
  );
}
