import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { Settings } from "@/lib/bindings/Settings";
import type { ChannelMode } from "@/lib/bindings/ChannelMode";
import type { FileFormat } from "@/lib/bindings/FileFormat";
import type { FilenamePattern } from "@/lib/bindings/FilenamePattern";
import type { DeviceInventory } from "@/lib/bindings/DeviceInventory";
import {
  LANGUAGE_NAMES,
  SUPPORTED_LNGS,
  changeLanguage,
  type SupportedLng,
} from "@/i18n";
import { SETTINGS_QUERY_KEY } from "./queryKey";
// Panels embedded into the relevant tabs so Settings is the single hub that
// absorbs everything the old Electron app kept under its settings tabs.
import { DevicePicker } from "@/features/devices/DevicePicker";
import { DiagnosticsPanel } from "@/features/diagnostics/DiagnosticsPanel";
import { FfmpegHealth } from "@/features/diagnostics/FfmpegHealth";
import { PublishPanel } from "@/features/publish/PublishPanel";
import { CloudBackupPanel } from "@/features/cloud/CloudBackupPanel";
import { EmailSettingsPanel } from "@/features/email/EmailSettingsPanel";
import { UpdatePanel } from "@/features/update/UpdatePanel";
import { IntegrationsPanel } from "@/features/integrations/IntegrationsPanel";
import { SuiteHandoffPanel } from "@/features/integrations/SuiteHandoffPanel";

/** Debounce (ms) before an edit is auto-saved — matches the Electron feel. */
const SAVE_DEBOUNCE_MS = 500;

const TABS = [
  "Lydkilde",
  "Video",
  "Filer",
  "Publisering",
  "Varsler",
  "System",
  "Sunday-suite",
] as const;
type Tab = (typeof TABS)[number];

/** A labelled section wrapper. */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <legend className="px-1 text-sm font-medium text-text">{title}</legend>
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
      <label htmlFor={htmlFor} className="text-sm text-text2">
        {label}
      </label>
      {children}
    </div>
  );
}

const inputClass =
  "rounded border border-border bg-surface2 px-2 py-1 text-sm text-text";

/**
 * The settings page. Loads the persisted `Settings` over IPC, renders a grouped
 * form organised into tabs matching the old Electron app, and debounce-auto-saves
 * edits back through `settings_save`. The language selector additionally drives
 * `changeLanguage` so the live UI follows the persisted choice.
 */
export function SettingsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<Tab>("Lydkilde");

  const { data, isLoading, isError, error } = useQuery<Settings>({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => invoke<Settings>("settings_get"),
  });

  // Fetch camera/audio device list for the Video tab.
  const { data: deviceInventory } = useQuery<DeviceInventory>({
    queryKey: ["list_devices"],
    queryFn: () => invoke<DeviceInventory>("list_devices"),
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

  // Native folder picker → persist save_folder immediately (no debounce; the
  // user explicitly chose a folder). The backend echoes the stored Settings.
  const pickFolder = useCallback(async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      saveMutation.mutate({ ...(draft as Settings), saveFolder: picked });
    }
  }, [draft, saveMutation]);

  // Native file picker for path fields (intro/outro).
  const pickFile = useCallback(
    async (field: "editorIntroPath" | "editorOutroPath") => {
      const picked = await open({
        multiple: false,
        filters: [{ name: "Media", extensions: ["mp3", "wav", "flac", "aac", "mp4", "mov", "mkv"] }],
      });
      if (typeof picked === "string") {
        patch({ [field]: picked });
      }
    },
    [patch],
  );

  // Export settings to a JSON file the user picks via the native save dialog.
  const exportToFile = useCallback(async () => {
    const path = await save({
      defaultPath: "sundayrec-settings.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (path) {
      await invoke("settings_export_to_file", { path });
    }
  }, []);

  // Import settings from a JSON file picked via the native open dialog, then
  // refresh the cache (and live language) from the stored value.
  const importFromFile = useCallback(async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (typeof path === "string") {
      const imported = await invoke<Settings>("settings_import_from_file", {
        path,
      });
      queryClient.setQueryData(SETTINGS_QUERY_KEY, imported);
      setDraft(imported);
      if (imported.language) void changeLanguage(imported.language);
    }
  }, [queryClient]);

  if (isLoading || !draft) {
    return (
      <p className="text-text2">
        {t("home.connecting", "Kobler til backend …")}
      </p>
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
    draft.language &&
    (SUPPORTED_LNGS as readonly string[]).includes(draft.language)
      ? (draft.language as SupportedLng)
      : "no";

  /** Save-status indicator, shared at the bottom of every tab. */
  const SaveStatus = (
    <div className="flex items-center justify-between pt-2">
      {saveMutation.isPending && (
        <span className="text-xs text-text3">
          {t("general.save", "Lagre")}…
        </span>
      )}
      {saveMutation.isSuccess && !saveMutation.isPending && (
        <span className="text-xs text-emerald-400">
          {t("general.saved", "✓ Lagret")}
        </span>
      )}
      {!saveMutation.isPending && !saveMutation.isSuccess && (
        <span />
      )}
    </div>
  );

  return (
    <section
      className="flex w-full max-w-xl flex-col gap-0"
      aria-label={t("nav.general", "Generelt")}
    >
      {/* ── Tab bar ──────────────────────────────────────────────────────── */}
      <div className="flex border-b border-border mb-6 gap-0">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={
              activeTab === tab
                ? "border-b-2 border-accent text-accent font-medium px-3 py-2 text-sm -mb-px"
                : "text-text2 hover:text-text px-3 py-2 text-sm"
            }
          >
            {tab}
          </button>
        ))}
      </div>

      {/* ── Tab: Lydkilde ────────────────────────────────────────────────── */}
      {activeTab === "Lydkilde" && (
        <div className="flex flex-col gap-4">
          <Section title={t("general.appLanguage", "Språk")}>
            <Field
              label={t("general.language", "Språk")}
              htmlFor="settings-language"
            >
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

          <Section title={t("audio.title", "Lydkilde")}>
            <Field
              label={t("audio.channels", "Kanaler")}
              htmlFor="settings-channels"
            >
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

          <Section title={t("audio.eqTitle", "Equalizer")}>
            <Field
              label={t("audio.eqBass", "Bass (dB)")}
              htmlFor="settings-eq-bass"
            >
              <input
                id="settings-eq-bass"
                type="number"
                min={-24}
                max={24}
                className={`${inputClass} w-24`}
                value={draft.eqBass}
                onChange={(e) => patch({ eqBass: Number(e.target.value) })}
              />
            </Field>

            <Field
              label={t("audio.eqMid", "Mid (dB)")}
              htmlFor="settings-eq-mid"
            >
              <input
                id="settings-eq-mid"
                type="number"
                min={-24}
                max={24}
                className={`${inputClass} w-24`}
                value={draft.eqMid}
                onChange={(e) => patch({ eqMid: Number(e.target.value) })}
              />
            </Field>

            <Field
              label={t("audio.eqTreble", "Diskant (dB)")}
              htmlFor="settings-eq-treble"
            >
              <input
                id="settings-eq-treble"
                type="number"
                min={-24}
                max={24}
                className={`${inputClass} w-24`}
                value={draft.eqTreble}
                onChange={(e) => patch({ eqTreble: Number(e.target.value) })}
              />
            </Field>
          </Section>

          <Section title={t("audio.compTitle", "Kompressor")}>
            <Field
              label={t("audio.compEnabled", "Aktiver kompressor")}
              htmlFor="settings-comp-enabled"
            >
              <input
                id="settings-comp-enabled"
                type="checkbox"
                checked={draft.compEnabled}
                onChange={(e) => patch({ compEnabled: e.target.checked })}
              />
            </Field>

            <Field
              label={t("audio.compThreshold", "Terskel (dBFS)")}
              htmlFor="settings-comp-threshold"
            >
              <input
                id="settings-comp-threshold"
                type="number"
                min={-60}
                max={0}
                className={`${inputClass} w-24`}
                value={draft.compThreshold}
                onChange={(e) => patch({ compThreshold: Number(e.target.value) })}
              />
            </Field>

            <Field
              label={t("audio.compRatio", "Ratio")}
              htmlFor="settings-comp-ratio"
            >
              <input
                id="settings-comp-ratio"
                type="number"
                min={1}
                max={100}
                className={`${inputClass} w-24`}
                value={draft.compRatio}
                onChange={(e) => patch({ compRatio: Number(e.target.value) })}
              />
            </Field>

            <Field
              label={t("audio.compAttack", "Attack (ms)")}
              htmlFor="settings-comp-attack"
            >
              <input
                id="settings-comp-attack"
                type="number"
                min={0.1}
                max={2000}
                step={0.1}
                className={`${inputClass} w-24`}
                value={draft.compAttack}
                onChange={(e) => patch({ compAttack: Number(e.target.value) })}
              />
            </Field>

            <Field
              label={t("audio.compRelease", "Release (ms)")}
              htmlFor="settings-comp-release"
            >
              <input
                id="settings-comp-release"
                type="number"
                min={1}
                max={9000}
                className={`${inputClass} w-24`}
                value={draft.compRelease}
                onChange={(e) => patch({ compRelease: Number(e.target.value) })}
              />
            </Field>
          </Section>

          <Section title={t("audio.limiterTitle", "Limiter")}>
            <Field
              label={t("audio.limiterEnabled", "Aktiver limiter")}
              htmlFor="settings-limiter-enabled"
            >
              <input
                id="settings-limiter-enabled"
                type="checkbox"
                checked={draft.limiterEnabled}
                onChange={(e) => patch({ limiterEnabled: e.target.checked })}
              />
            </Field>

            <Field
              label={t("audio.limiterCeiling", "Tak (dBFS)")}
              htmlFor="settings-limiter-ceiling"
            >
              <input
                id="settings-limiter-ceiling"
                type="number"
                min={-10}
                max={0}
                step={0.1}
                className={`${inputClass} w-24`}
                value={draft.limiterCeiling}
                onChange={(e) => patch({ limiterCeiling: Number(e.target.value) })}
              />
            </Field>
          </Section>

          {SaveStatus}
        </div>
      )}

      {/* ── Tab: Video ───────────────────────────────────────────────────── */}
      {activeTab === "Video" && (
        <div className="flex flex-col gap-4">
          <Section title={t("video.title", "Videooppsett")}>
            <Field
              label={t("video.enabled", "Aktiver video")}
              htmlFor="settings-video-enabled"
            >
              <input
                id="settings-video-enabled"
                type="checkbox"
                checked={draft.videoEnabled}
                onChange={(e) => patch({ videoEnabled: e.target.checked })}
              />
            </Field>

            <Field
              label={t("video.deviceName", "Kamera")}
              htmlFor="settings-video-device"
            >
              <select
                id="settings-video-device"
                className={inputClass}
                value={draft.videoDeviceName ?? ""}
                onChange={(e) =>
                  patch({
                    videoDeviceName: e.target.value === "" ? null : e.target.value,
                  })
                }
                disabled={!draft.videoEnabled}
              >
                <option value="">{t("video.noDevice", "— ingen kamera —")}</option>
                {(deviceInventory?.video_inputs ?? []).map((dev) => (
                  <option key={`${dev.format}-${dev.index ?? dev.name}`} value={dev.name}>
                    {dev.name}
                  </option>
                ))}
              </select>
            </Field>
          </Section>

          {SaveStatus}
        </div>
      )}

      {/* ── Tab: Alt ─────────────────────────────────────────────────────── */}
      {activeTab === "Filer" && (
        <div className="flex flex-col gap-4">
          <Section title={t("files.saveFolder", "Lagringsmappe")}>
            <div className="flex items-center justify-between gap-3">
              <span
                className="min-w-0 flex-1 truncate text-sm text-text2"
                title={draft.saveFolder ?? undefined}
              >
                {draft.saveFolder ??
                  t("home.defaultFolder", "Dokumenter/SundayRec")}
              </span>
              <button
                type="button"
                className="shrink-0 rounded-lg border border-border bg-surface2 px-3 py-1 text-sm text-text2 hover:bg-surface3"
                onClick={() => void pickFolder()}
              >
                {t("files.browse", "Velg mappe")}
              </button>
            </div>
          </Section>

          <Section title={t("files.format", "Format & Kvalitet")}>
            <Field
              label={t("files.fileFormat", "Filformat")}
              htmlFor="settings-format"
            >
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

            <Field
              label={t("files.bitrate", "Bitrate (kbps)")}
              htmlFor="settings-bitrate"
            >
              <select
                id="settings-bitrate"
                className={inputClass}
                value={draft.bitrate}
                onChange={(e) => patch({ bitrate: e.target.value })}
              >
                <option value="96">96</option>
                <option value="128">128</option>
                <option value="192">192</option>
                <option value="256">256</option>
                <option value="320">320</option>
              </select>
            </Field>

            <Field
              label={t("files.pattern", "Navnmønster")}
              htmlFor="settings-pattern"
            >
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

          <Section title={t("files.behaviourTitle", "Opptaksoppførsel")}>
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
              label={t("files.silenceThreshold", "Stillhetstersksel (dBFS)")}
              htmlFor="settings-silence-threshold"
            >
              <input
                id="settings-silence-threshold"
                type="number"
                min={-90}
                max={0}
                className={`${inputClass} w-24`}
                value={draft.silenceThreshold}
                onChange={(e) => patch({ silenceThreshold: Number(e.target.value) })}
              />
            </Field>

            <Field
              label={t("files.silenceTimeout", "Stillhet i (min) før stopp")}
              htmlFor="settings-silence-timeout"
            >
              <input
                id="settings-silence-timeout"
                type="number"
                min={1}
                max={120}
                className={`${inputClass} w-24`}
                value={draft.silenceTimeoutMinutes}
                onChange={(e) =>
                  patch({ silenceTimeoutMinutes: Number(e.target.value) })
                }
              />
            </Field>

            <Field
              label={t("schedule.splitTitle", "Del opp filer (min, 0=av)")}
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

            <Field
              label={t("files.manualMax", "Maks opptakstid (min, 0=av)")}
              htmlFor="settings-manual-max"
            >
              <input
                id="settings-manual-max"
                type="number"
                min={0}
                max={1440}
                className={`${inputClass} w-24`}
                value={draft.manualMaxMinutes}
                onChange={(e) => patch({ manualMaxMinutes: Number(e.target.value) })}
              />
            </Field>

            <Field
              label={t("files.preRoll", "Forhåndsopptak (sek)")}
              htmlFor="settings-pre-roll-seconds"
            >
              <select
                id="settings-pre-roll-seconds"
                className={inputClass}
                value={draft.preRollSeconds}
                onChange={(e) => patch({ preRollSeconds: Number(e.target.value) })}
              >
                <option value={0}>{t("files.preRollOff", "Av")}</option>
                <option value={15}>15</option>
                <option value={30}>30</option>
              </select>
            </Field>

            <Field
              label={t("files.protectRecording", "Bekreft stopp")}
              htmlFor="settings-protect-recording"
            >
              <input
                id="settings-protect-recording"
                type="checkbox"
                checked={draft.protectRecording}
                onChange={(e) => patch({ protectRecording: e.target.checked })}
              />
            </Field>

            <Field
              label={t("files.reminderMinutes", "Påminnelse (min før, 0=av)")}
              htmlFor="settings-reminder-minutes"
            >
              <input
                id="settings-reminder-minutes"
                type="number"
                min={0}
                max={60}
                className={`${inputClass} w-24`}
                value={draft.reminderMinutes}
                onChange={(e) => patch({ reminderMinutes: Number(e.target.value) })}
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

          {SaveStatus}
        </div>
      )}

      {/* ── Tab: Publisering ─────────────────────────────────────────────── */}
      {activeTab === "Publisering" && (
        <div className="flex flex-col gap-4">
          <Section title={t("publish.editorTitle", "Editor-klipp")}>
            <div className="flex flex-col gap-2">
              <label className="text-sm text-text2">
                {t("publish.introPath", "Intro-klipp")}
              </label>
              <div className="flex items-center gap-2">
                <span
                  className="min-w-0 flex-1 truncate rounded border border-border bg-surface2 px-2 py-1 text-sm text-text2"
                  title={draft.editorIntroPath ?? undefined}
                >
                  {draft.editorIntroPath ?? t("publish.noFile", "— ingen fil valgt —")}
                </span>
                <button
                  type="button"
                  className="shrink-0 rounded-lg border border-border bg-surface2 px-3 py-1 text-sm text-text2 hover:bg-surface3"
                  onClick={() => void pickFile("editorIntroPath")}
                >
                  {t("files.browse", "Velg fil")}
                </button>
                {draft.editorIntroPath && (
                  <button
                    type="button"
                    className="shrink-0 rounded-lg border border-border bg-surface2 px-2 py-1 text-sm text-text2 hover:bg-surface3"
                    onClick={() => patch({ editorIntroPath: null })}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm text-text2">
                {t("publish.outroPath", "Outro-klipp")}
              </label>
              <div className="flex items-center gap-2">
                <span
                  className="min-w-0 flex-1 truncate rounded border border-border bg-surface2 px-2 py-1 text-sm text-text2"
                  title={draft.editorOutroPath ?? undefined}
                >
                  {draft.editorOutroPath ?? t("publish.noFile", "— ingen fil valgt —")}
                </span>
                <button
                  type="button"
                  className="shrink-0 rounded-lg border border-border bg-surface2 px-3 py-1 text-sm text-text2 hover:bg-surface3"
                  onClick={() => void pickFile("editorOutroPath")}
                >
                  {t("files.browse", "Velg fil")}
                </button>
                {draft.editorOutroPath && (
                  <button
                    type="button"
                    className="shrink-0 rounded-lg border border-border bg-surface2 px-2 py-1 text-sm text-text2 hover:bg-surface3"
                    onClick={() => patch({ editorOutroPath: null })}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          </Section>

          <Section title={t("schedule.wakeTitle", "Vekk fra dvale")}>
            <Field
              label={t("schedule.wakeEnabled", "Vekk maskinen for opptak")}
              htmlFor="settings-wake-from-sleep"
            >
              <input
                id="settings-wake-from-sleep"
                type="checkbox"
                checked={draft.wakeFromSleep}
                onChange={(e) => patch({ wakeFromSleep: e.target.checked })}
              />
            </Field>
          </Section>

          {SaveStatus}
        </div>
      )}

      {/* ── Tab: Notater ─────────────────────────────────────────────────── */}
      {activeTab === "Varsler" && (
        <div className="flex flex-col gap-4">
          <Section title={t("notify.title", "Varsler")}>
            <Field
              label={t("notify.onStart", "Varsle ved opptaksstart")}
              htmlFor="settings-notify-start"
            >
              <input
                id="settings-notify-start"
                type="checkbox"
                checked={draft.notifyStart}
                onChange={(e) => patch({ notifyStart: e.target.checked })}
              />
            </Field>

            <Field
              label={t("notify.onStop", "Varsle ved opptaksstopp")}
              htmlFor="settings-notify-stop"
            >
              <input
                id="settings-notify-stop"
                type="checkbox"
                checked={draft.notifyStop}
                onChange={(e) => patch({ notifyStop: e.target.checked })}
              />
            </Field>
          </Section>

          <Section title={t("email.alertsTitle", "E-postvarsler")}>
            <Field
              label={t("email.onError", "Send e-post ved feil")}
              htmlFor="settings-email-on-error"
            >
              <input
                id="settings-email-on-error"
                type="checkbox"
                checked={draft.emailOnError}
                onChange={(e) => patch({ emailOnError: e.target.checked })}
              />
            </Field>

            <Field
              label={t("email.address", "Mottakeradresse")}
              htmlFor="settings-email-address"
            >
              <input
                id="settings-email-address"
                type="email"
                className={`${inputClass} w-48`}
                value={draft.emailAddress}
                onChange={(e) => patch({ emailAddress: e.target.value })}
              />
            </Field>

            <Field
              label={t("email.smtpHost", "SMTP-vert")}
              htmlFor="settings-email-smtp"
            >
              <input
                id="settings-email-smtp"
                type="text"
                className={`${inputClass} w-48`}
                value={draft.emailSmtp}
                onChange={(e) => patch({ emailSmtp: e.target.value })}
              />
            </Field>

            <Field
              label={t("email.smtpPort", "SMTP-port")}
              htmlFor="settings-email-smtp-port"
            >
              <input
                id="settings-email-smtp-port"
                type="number"
                min={1}
                max={65535}
                className={`${inputClass} w-24`}
                value={draft.emailSmtpPort}
                onChange={(e) => patch({ emailSmtpPort: Number(e.target.value) })}
              />
            </Field>

            <Field
              label={t("email.smtpUser", "SMTP-bruker")}
              htmlFor="settings-email-smtp-user"
            >
              <input
                id="settings-email-smtp-user"
                type="text"
                className={`${inputClass} w-48`}
                value={draft.emailSmtpUser}
                onChange={(e) => patch({ emailSmtpUser: e.target.value })}
              />
            </Field>
          </Section>

          {SaveStatus}
        </div>
      )}

      {/* ── Tab: System ──────────────────────────────────────────────────── */}
      {activeTab === "System" && (
        <div className="flex flex-col gap-4">
          <Section title={t("general.churchProfile", "Menighet")}>
            <Field
              label={t("general.churchName", "Menighetsnavn")}
              htmlFor="settings-church-name"
            >
              <input
                id="settings-church-name"
                type="text"
                className={`${inputClass} w-48`}
                value={draft.churchName}
                onChange={(e) => patch({ churchName: e.target.value })}
              />
            </Field>

            <Field
              label={t("general.responsiblePerson", "Ansvarlig person")}
              htmlFor="settings-responsible-person"
            >
              <input
                id="settings-responsible-person"
                type="text"
                className={`${inputClass} w-48`}
                value={draft.responsiblePerson}
                onChange={(e) => patch({ responsiblePerson: e.target.value })}
              />
            </Field>
          </Section>

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
              label={t("general.minimizeToTray", "Minimer til systembrett")}
              htmlFor="settings-minimize-to-tray"
            >
              <input
                id="settings-minimize-to-tray"
                type="checkbox"
                checked={draft.minimizeToTray}
                onChange={(e) => patch({ minimizeToTray: e.target.checked })}
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
          </Section>

          <Section title={t("general.export", "Eksporter innstillinger")}>
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                className="rounded-lg border border-border bg-surface2 px-3 py-1 text-sm text-text2 hover:bg-surface3"
                onClick={() => void exportToFile()}
              >
                {t("general.export", "Eksporter innstillinger")}
              </button>
              <button
                type="button"
                className="rounded-lg border border-border bg-surface2 px-3 py-1 text-sm text-text2 hover:bg-surface3"
                onClick={() => void importFromFile()}
              >
                {t("general.import", "Importer fra fil")}
              </button>
              <button
                type="button"
                className="rounded-lg border border-border bg-surface2 px-3 py-1 text-sm text-text2 hover:bg-surface3"
                onClick={() => resetMutation.mutate()}
              >
                {t("general.restore", "Gjenopprett standard")}
              </button>
            </div>
          </Section>

          {SaveStatus}
        </div>
      )}

      {/* ── Embedded panels (Electron-parity: settings is the hub) ───────────
          Each block is gated by the active tab so only the visible tab's
          panels mount and run their queries. */}
      {activeTab === "Lydkilde" && (
        <div className="mt-6 flex flex-col gap-6">
          <DevicePicker />
          <DiagnosticsPanel />
          <FfmpegHealth />
        </div>
      )}
      {activeTab === "Publisering" && (
        <div className="mt-6 flex flex-col gap-6">
          <PublishPanel />
          <CloudBackupPanel />
        </div>
      )}
      {activeTab === "Varsler" && (
        <div className="mt-6 flex flex-col gap-6">
          <EmailSettingsPanel />
        </div>
      )}
      {activeTab === "System" && (
        <div className="mt-6 flex flex-col gap-6">
          <UpdatePanel />
        </div>
      )}
      {activeTab === "Sunday-suite" && (
        <div className="flex flex-col gap-6">
          <IntegrationsPanel />
          <SuiteHandoffPanel />
        </div>
      )}
    </section>
  );
}
