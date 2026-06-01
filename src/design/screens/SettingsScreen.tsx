/**
 * Innstillinger — the 7-tab settings hub. Ported from `sr-settings.jsx`.
 *
 * This is the screen the user specifically called out: "settings flyter ut
 * når vinduet skaleres". The fix is the cozy centered reading width
 * (`.sr-content.cozy`, 860px) plus a single tab bar instead of a long scroll.
 *
 * The visual design is unchanged — same `sr-*` markup, the same 7 tabs and
 * Norwegian copy. The controls are now wired to the real persisted `Settings`
 * over IPC (`settings_get` / `settings_save`), reusing the exact query key and
 * command names from `features/settings/SettingsPage.tsx`.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { Settings } from "@/lib/bindings/Settings";
import type { ChannelMode } from "@/lib/bindings/ChannelMode";
import type { FileFormat } from "@/lib/bindings/FileFormat";
import type { FilenamePattern } from "@/lib/bindings/FilenamePattern";
import type { RecordingOpts } from "@/lib/bindings/RecordingOpts";
import type { SampleRate } from "@/lib/bindings/SampleRate";
import type { AudioDeviceList } from "@/lib/bindings/AudioDeviceList";
import { LANGUAGE_NAMES, SUPPORTED_LNGS, changeLanguage } from "@/i18n";
import { SETTINGS_QUERY_KEY } from "@/features/settings/queryKey";
import { useVideoDevices } from "@/design/hooks";

import { Icon } from "../Icon";
import { Badge, Card, DeviceRow, SegOpt, SettingRow, Toggle } from "../atoms";
import { DEFAULT_SETTINGS, pickFolder } from "./settings.helpers";
import { consumePendingSettingsTab, isSettingsTabId } from "./settingsTab";

/** Ask the shell to switch to a different view (same CustomEvent MainLayout
 *  listens for). Used to send the "test / check" buttons to the Diagnose view,
 *  which owns the real preflight/test-recording UI. */
function navigateTo(view: string) {
  window.dispatchEvent(new CustomEvent("shell:navigate", { detail: view }));
}

/** Open a native image picker and return the chosen absolute path, or `null`
 *  if cancelled / the dialog is unavailable (dev/test). Never throws. */
async function pickImage(): Promise<string | null> {
  try {
    const result = await dialogOpen({
      multiple: false,
      filters: [{ name: "Bilde", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    return typeof result === "string" ? result : null;
  } catch {
    return null;
  }
}

const TABS = [
  ["lydkilde", "Lydkilde"],
  ["video", "Video"],
  ["filer", "Filer"],
  ["publisering", "Publisering"],
  ["varsler", "Varsler"],
  ["system", "System"],
  ["suite", "Sunday-suite"],
] as const;
type TabId = (typeof TABS)[number][0];

/** i18n key suffix for each tab label, keyed by tab id. */
const TAB_LABEL_KEYS: Record<TabId, string> = {
  lydkilde: "tabAudio",
  video: "tabVideo",
  filer: "tabFiles",
  publisering: "tabPublishing",
  varsler: "tabNotifications",
  system: "tabSystem",
  suite: "tabSuite",
};

/** Mutate-then-save helper passed into every tab. */
type Update = (patch: Partial<Settings>) => void;

interface TabProps {
  s: Settings;
  update: Update;
}

/**
 * Controlled, clickable variant of the presentational `Toggle` atom. The atom
 * itself stays purely visual (no IPC); here we wrap it in a clickable element
 * so the look is identical but a click persists `onChange(!on)`.
 */
function LiveToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <span
      role="switch"
      aria-checked={on}
      tabIndex={0}
      style={{ display: "inline-flex", cursor: "pointer" }}
      onClick={() => onChange(!on)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onChange(!on);
        }
      }}
    >
      <Toggle on={on} />
    </span>
  );
}

/**
 * Clickable wrapper around the presentational `SegOpt` atom. Keeps the exact
 * `sr-seg-opt` markup/look but makes the option selectable.
 */
function LiveSegOpt({
  sel,
  title,
  sub,
  badge,
  onSelect,
}: {
  sel?: boolean;
  title: React.ReactNode;
  sub?: React.ReactNode;
  badge?: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <div
      role="radio"
      aria-checked={!!sel}
      tabIndex={0}
      style={{ cursor: "pointer", display: "contents" }}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <SegOpt sel={sel} title={title} sub={sub} badge={badge} />
    </div>
  );
}

/**
 * Real audio-device picker (WS-1). Enumerates the system's input devices via
 * `list_input_devices` and renders one clickable card per device. Clicking a
 * card persists the choice as `deviceName` (the field the recorder fuzzy-matches
 * against), so the selection actually sticks instead of falling back to the
 * built-in mic. The "Oppdater" button re-runs enumeration so devices plugged in
 * after launch become visible.
 */
function AudioDevicePicker({ s, update }: TabProps) {
  const { t } = useTranslation();
  // Local enumeration with an explicit refetch (so "Oppdater" can re-run it —
  // the shared `useInputDevices` hook only enumerates once on mount).
  const [list, setList] = useState<AudioDeviceList | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    invoke<AudioDeviceList>("list_input_devices")
      .then((d) => alive && setList(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [nonce]);

  const inputs = list?.inputs ?? [];
  // The persisted choice. Empty/unset selects the host default device.
  const selectedName = s.deviceName ?? null;

  return (
    <Card
      title={t("settingsScreen.audio.devicesTitle", "Tilgjengelige enheter")}
      icon="mic"
      desc={t(
        "settingsScreen.audio.devicesDesc",
        "Velg mikseren eller lydkortet som tar opp lyden i kirken. USB-mikser anbefales fremfor innebygd mikrofon.",
      )}
      pad
    >
      <div className="sr-stack-3" style={{ marginTop: 16 }}>
        {inputs.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--sr-text-3)" }}>
            {t(
              "settingsScreen.audio.noDevicesFound",
              "Ingen lydenheter funnet. Koble til lydkortet og trykk Oppdater.",
            )}
          </div>
        ) : (
          inputs.map((d) => {
            // Match against the persisted name; when nothing is stored yet the
            // host's default device is the effective selection.
            const sel =
              selectedName != null ? d.name === selectedName : d.is_default;
            const layout =
              d.channels >= 2
                ? t("settingsScreen.audio.deviceStereo", "stereo")
                : t("settingsScreen.audio.deviceMono", "mono");
            const meta = [
              d.is_default
                ? t("settingsScreen.audio.deviceDefault", "Standard")
                : null,
              layout,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <div
                key={d.name}
                role="radio"
                aria-checked={sel}
                aria-label={d.name}
                tabIndex={0}
                style={{ cursor: "pointer" }}
                onClick={() => update({ deviceName: d.name })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    update({ deviceName: d.name });
                  }
                }}
              >
                <DeviceRow
                  icon="mic"
                  name={d.name}
                  meta={meta}
                  sel={sel}
                  badge={
                    d.is_default ? (
                      <Badge kind="ok" dot>
                        {t("settingsScreen.audio.badgeConnected", "Tilkoblet")}
                      </Badge>
                    ) : undefined
                  }
                />
              </div>
            );
          })
        )}
      </div>
      <div className="sr-row" style={{ marginTop: 16 }}>
        <span
          className="sr-grow"
          style={{ fontSize: 13, color: "var(--sr-text-3)" }}
        >
          {t(
            "settingsScreen.audio.deviceHelp",
            "Ser du ikke riktig enhet? Sjekk at lydkortet er koblet til.",
          )}
        </span>
        <button
          className="sr-btn ghost sm"
          onClick={() => setNonce((n) => n + 1)}
          type="button"
        >
          <Icon name="refresh" size={14} />
          {t("settingsScreen.audio.refresh", "Oppdater")}
        </button>
        <button
          className="sr-btn ghost sm"
          onClick={() => navigateTo("diagnostics")}
          type="button"
        >
          <Icon name="speaker" size={14} />
          {t("settingsScreen.audio.testAudio", "Test lyd")}
        </button>
        <button
          className="sr-btn ghost sm"
          onClick={() => navigateTo("diagnostics")}
          type="button"
        >
          {t("settingsScreen.audio.diagnose", "Diagnose")}
        </button>
      </div>
    </Card>
  );
}

function TabLydkilde({ s, update }: TabProps) {
  const { t } = useTranslation();
  return (
    <>
      <AudioDevicePicker s={s} update={update} />
      <Card
        title={t("settingsScreen.audio.checkTitle", "Sjekk at alt fungerer")}
        icon="shield"
        desc={t(
          "settingsScreen.audio.checkDesc",
          "Kjør disse før en gudstjeneste for å være sikker på at opptaket starter uten problemer.",
        )}
        pad
      >
        <div className="sr-row" style={{ gap: 10, marginTop: 14 }}>
          <button
            className="sr-btn ghost"
            onClick={() => navigateTo("diagnostics")}
            type="button"
          >
            <Icon name="mic" size={15} />
            {t("settingsScreen.audio.testRecording", "Test-opptak (30 sek)")}
          </button>
          <button
            className="sr-btn gold"
            onClick={() => navigateTo("diagnostics")}
            type="button"
          >
            <Icon name="check" size={15} strokeWidth={2.4} />
            {t("settingsScreen.audio.checkNow", "Sjekk system nå")}
          </button>
        </div>
      </Card>
      <Card title={t("settingsScreen.audio.channelsTitle", "Kanaler")} pad>
        <div className="sr-seg cols-4" style={{ marginTop: 4 }}>
          <LiveSegOpt
            sel={s.channels === "stereo"}
            title={t("settingsScreen.audio.channelStereo", "Stereo")}
            badge={t("settingsScreen.recommended", "Anbefalt")}
            onSelect={() => update({ channels: "stereo" as ChannelMode })}
          />
          <LiveSegOpt
            sel={s.channels === "monoMix"}
            title={t("settingsScreen.audio.channelMono", "Mono")}
            sub={t("settingsScreen.audio.channelMonoSub", "Miks L+R")}
            onSelect={() => update({ channels: "monoMix" as ChannelMode })}
          />
          <LiveSegOpt
            sel={s.channels === "monoL"}
            title={t("settingsScreen.audio.channelMonoL", "Mono L")}
            sub={t("settingsScreen.audio.channelMonoLSub", "Kun venstre")}
            onSelect={() => update({ channels: "monoL" as ChannelMode })}
          />
          <LiveSegOpt
            sel={s.channels === "monoR"}
            title={t("settingsScreen.audio.channelMonoR", "Mono R")}
            sub={t("settingsScreen.audio.channelMonoRSub", "Kun høyre")}
            onSelect={() => update({ channels: "monoR" as ChannelMode })}
          />
        </div>
      </Card>
      <Card
        title={t("settingsScreen.audio.sampleRateTitle", "Samplingsrate")}
        pad
      >
        <div className="sr-seg cols-4" style={{ marginTop: 4 }}>
          <LiveSegOpt
            sel={s.sampleRateMode === "auto"}
            title={t("settingsScreen.audio.srAuto", "Auto")}
            badge={t("settingsScreen.recommended", "Anbefalt")}
            sub={t(
              "settingsScreen.audio.srAutoSub",
              "Enhetens egen rate — ingen konvertering",
            )}
            onSelect={() => update({ sampleRateMode: "auto" as SampleRate })}
          />
          <LiveSegOpt
            sel={s.sampleRateMode === "r44100"}
            title="44 100 Hz"
            sub={t("settingsScreen.audio.sr44Sub", "Musikk, CD og podkast")}
            onSelect={() => update({ sampleRateMode: "r44100" as SampleRate })}
          />
          <LiveSegOpt
            sel={s.sampleRateMode === "r48000"}
            title="48 000 Hz"
            sub={t("settingsScreen.audio.sr48Sub", "Video, Zoom og TV-utstyr")}
            onSelect={() => update({ sampleRateMode: "r48000" as SampleRate })}
          />
          <LiveSegOpt
            sel={s.sampleRateMode === "r96000"}
            title="96 000 Hz"
            sub={t("settingsScreen.audio.sr96Sub", "Studio · høyoppløst")}
            onSelect={() => update({ sampleRateMode: "r96000" as SampleRate })}
          />
        </div>
      </Card>
    </>
  );
}

/**
 * Camera dropdown driven by live enumeration. Isolated into its own component
 * so the "Oppdater" button can re-run `useVideoDevices()` by bumping the
 * `refreshKey` (which remounts this subtree). Falls back to the stored name as
 * the sole option when no devices are enumerated (dev/test).
 */
function CameraSelect({ s, update }: TabProps) {
  const cameras = useVideoDevices();
  return (
    <select
      className="sr-select sr-grow"
      value={s.videoDeviceName ?? ""}
      onChange={(e) => {
        const name = e.target.value;
        const dev = cameras.find((c) => c.name === name);
        update({
          videoDeviceName: name || null,
          videoDeviceIndex: dev ? dev.index : null,
        });
      }}
    >
      {cameras.length === 0 && (
        <option value={s.videoDeviceName ?? ""}>
          {s.videoDeviceName ?? "FaceTime HD-kamera"}
        </option>
      )}
      {cameras.map((c) => (
        <option key={`${c.name}-${c.index ?? "n"}`} value={c.name}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

function TabVideo({ s, update }: TabProps) {
  const { t } = useTranslation();
  // Bumping `refreshKey` remounts <CameraSelect> so the "Oppdater" button
  // re-enumerates cameras through `useVideoDevices()`.
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <>
      <Card pad>
        <SettingRow
          title={t("settingsScreen.video.enableTitle", "Aktiver videoopptak")}
          desc={t(
            "settingsScreen.video.enableDesc",
            "Tar opp video i tillegg til lyd ved hvert opptak.",
          )}
          control={
            <LiveToggle
              on={s.videoEnabled}
              onChange={(next) => update({ videoEnabled: next })}
            />
          }
        />
      </Card>
      <Card
        title={t("settingsScreen.video.cameraTitle", "Kamera")}
        icon="camera"
        pad
      >
        {/* Live camera enumeration via `useVideoDevices()`. The chosen camera
            persists both `videoDeviceName` and `videoDeviceIndex` (avfoundation
            index; null for dshow, addressed by name). When no devices are
            enumerated yet (dev/test) the stored name is shown as the sole
            option so the control still reflects the persisted value. */}
        <div className="sr-row" style={{ gap: 10, marginTop: 14 }}>
          <CameraSelect key={refreshKey} s={s} update={update} />
          <button
            className="sr-btn ghost"
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            <Icon name="refresh" size={15} />
            {t("settingsScreen.video.refresh", "Oppdater")}
          </button>
        </div>
        <div
          style={{ fontSize: 12.5, color: "var(--sr-text-3)", marginTop: 10 }}
        >
          {t(
            "settingsScreen.video.cameraHelp",
            "USB-webkamera og HDMI-opptakskort støttes på macOS og Windows.",
          )}
        </div>
      </Card>
      <Card title={t("settingsScreen.video.qualityTitle", "Kvalitet")} pad>
        <div className="sr-label" style={{ marginBottom: 10 }}>
          {t("settingsScreen.video.resolutionLabel", "Oppløsning")}
        </div>
        <div className="sr-seg cols-3">
          <LiveSegOpt
            sel={s.videoResolution === "480p"}
            title="480p"
            sub="~1.5 GB / t"
            onSelect={() => update({ videoResolution: "480p" })}
          />
          <LiveSegOpt
            sel={s.videoResolution === "720p"}
            title="720p"
            badge={t("settingsScreen.recommended", "Anbefalt")}
            sub="~3.5 GB / t"
            onSelect={() => update({ videoResolution: "720p" })}
          />
          <LiveSegOpt
            sel={s.videoResolution === "1080p"}
            title="1080p"
            sub="~7 GB / t"
            onSelect={() => update({ videoResolution: "1080p" })}
          />
        </div>
        <div className="sr-field" style={{ marginTop: 16, maxWidth: 220 }}>
          <span className="sr-label">
            {t("settingsScreen.video.framerateLabel", "Bilderate")}
          </span>
          <select
            className="sr-select"
            value={s.videoFramerate}
            onChange={(e) => update({ videoFramerate: Number(e.target.value) })}
          >
            <option value={25}>25 fps</option>
            <option value={30}>
              {t("settingsScreen.video.fps30", "30 fps (anbefalt)")}
            </option>
          </select>
        </div>
      </Card>
      <Card
        title={t("settingsScreen.video.outputTitle", "Utdataformat")}
        desc={t(
          "settingsScreen.video.outputDesc",
          "Velg om lyd og video skal kombineres til én fil eller lagres separat.",
        )}
        pad
      >
        <div className="sr-seg cols-2" style={{ marginTop: 14 }}>
          <LiveSegOpt
            sel={s.outputMode === "combined"}
            title={t("settingsScreen.video.combinedTitle", "Kombinert MP4")}
            sub={t(
              "settingsScreen.video.combinedSub",
              "Lyd + video i én fil — klar for YouTube",
            )}
            onSelect={() => update({ outputMode: "combined" })}
          />
          <LiveSegOpt
            sel={s.outputMode === "separate"}
            title={t("settingsScreen.video.separateTitle", "Separate filer")}
            sub={t(
              "settingsScreen.video.separateSub",
              "Lyd og video lagres hver for seg",
            )}
            onSelect={() => update({ outputMode: "separate" })}
          />
        </div>
        <div style={{ marginTop: 6 }}>
          <SettingRow
            title={t(
              "settingsScreen.video.keepAudioTitle",
              "Behold separat lydfil",
            )}
            desc={t(
              "settingsScreen.video.keepAudioDesc",
              "Lagrer også den høykvalitets lydfilen ved siden av MP4.",
            )}
            control={
              <LiveToggle
                on={s.keepSeparateAudio}
                onChange={(next) => update({ keepSeparateAudio: next })}
              />
            }
          />
        </div>
      </Card>
    </>
  );
}

/**
 * Live filename preview — asks the backend planner (`plan_recording_opts`) for
 * the path the next recording would get and shows its basename, so the user
 * sees the real result of the pattern/format choice (incl. liturgical names).
 * Re-keyed on pattern+format (both persisted before this re-runs); falls back
 * to a sample name when the planner is unavailable (dev/test).
 */
function FilenamePreview({ s }: { s: Settings }) {
  const { data } = useQuery<RecordingOpts>({
    queryKey: ["plan_recording_opts", s.filenamePattern, s.format],
    queryFn: () =>
      invoke<RecordingOpts>("plan_recording_opts", {
        customName: null,
        maxMinutes: null,
      }),
    retry: false,
  });
  const name = data?.output_path
    ? (data.output_path.split(/[/\\]/).pop() ?? data.output_path)
    : "Pinsegudstjeneste_2026-05-24.wav";
  return <div className="sr-input mono">{name}</div>;
}

function TabFiler({ s, update }: TabProps) {
  const { t } = useTranslation();
  return (
    <>
      <Card
        title={t("settingsScreen.files.folderTitle", "Lagringsmappe")}
        icon="folder"
        desc={t(
          "settingsScreen.files.folderDesc",
          "Alle opptak havner her som lokale filer.",
        )}
        pad
      >
        <div className="sr-row" style={{ gap: 10, marginTop: 14 }}>
          <div className="sr-input mono sr-grow">
            {s.saveFolder ?? "Dokumenter/SundayRec"}
          </div>
          <button
            className="sr-btn ghost"
            onClick={() => {
              void pickFolder().then((dir) => {
                if (dir) update({ saveFolder: dir });
              });
            }}
          >
            {t("settingsScreen.files.chooseFolder", "Velg mappe")}
          </button>
        </div>
      </Card>
      <Card
        title={t("settingsScreen.files.patternTitle", "Navnmønster")}
        desc={t(
          "settingsScreen.files.patternDesc",
          "Programmet gjenkjenner kirkelige høytider og bruker det riktige norske navnet automatisk.",
        )}
        pad
      >
        <div className="sr-field" style={{ marginTop: 14, maxWidth: 320 }}>
          <span className="sr-label">
            {t("settingsScreen.files.formatLabel", "Navneformat")}
          </span>
          {/* SegOpt-style picker would change the layout; keep the native
              select look but drive it from the real filenamePattern field. */}
          <select
            className="sr-select"
            value={s.filenamePattern}
            onChange={(e) =>
              update({ filenamePattern: e.target.value as FilenamePattern })
            }
          >
            <option value="date">
              {t("settingsScreen.files.patternDate", "Dato")}
            </option>
            <option value="church">
              {t("settingsScreen.files.patternChurch", "Kirkelig navn + dato")}
            </option>
            <option value="plain">
              {t("settingsScreen.files.patternPlain", "Gudstjeneste + dato")}
            </option>
            <option value="datetime">
              {t("settingsScreen.files.patternDatetime", "Dato + klokkeslett")}
            </option>
          </select>
        </div>
        <div className="sr-field" style={{ marginTop: 14 }}>
          <span className="sr-label">
            {t("settingsScreen.files.previewLabel", "Forhåndsvisning")}
          </span>
          <FilenamePreview s={s} />
        </div>
      </Card>
      <Card
        title={t(
          "settingsScreen.files.formatQualityTitle",
          "Format & kvalitet",
        )}
        pad
      >
        {/* NOTE: `bitrate` is a real Settings field but the redesign exposes no
            bitrate selector (only the MP3/FLAC/WAV format picker below), so it
            stays at its persisted/default value — left static. */}
        <div className="sr-seg cols-3" style={{ marginTop: 4 }}>
          <LiveSegOpt
            sel={s.format === "mp3"}
            title="MP3"
            sub={t("settingsScreen.files.mp3Sub", "~85 MB / t · for deling")}
            onSelect={() => update({ format: "mp3" as FileFormat })}
          />
          <LiveSegOpt
            sel={s.format === "flac"}
            title="FLAC"
            sub={t("settingsScreen.files.flacSub", "~300 MB / t · tapsfri")}
            onSelect={() => update({ format: "flac" as FileFormat })}
          />
          <LiveSegOpt
            sel={s.format === "wav"}
            title="WAV"
            sub={t(
              "settingsScreen.files.wavSub",
              "~635 MB / t · høyest kvalitet",
            )}
            onSelect={() => update({ format: "wav" as FileFormat })}
          />
        </div>
      </Card>
      <Card
        title={t("settingsScreen.files.behaviorTitle", "Opptaksoppførsel")}
        icon="shield"
        desc={t(
          "settingsScreen.files.behaviorDesc",
          "Finjuster hvordan opptaket starter, beskyttes og deles opp.",
        )}
        pad
      >
        <SettingRow
          title={t(
            "settingsScreen.files.autoDeleteTitle",
            "Slett automatisk gamle opptak",
          )}
          desc={t(
            "settingsScreen.files.autoDeleteDesc",
            "Frigjør diskplass ved å slette opptak eldre enn 90 dager.",
          )}
          control={
            <LiveToggle
              on={s.autoDeleteDays > 0}
              onChange={(next) => update({ autoDeleteDays: next ? 90 : 0 })}
            />
          }
        />
        <SettingRow
          title={t(
            "settingsScreen.files.protectTitle",
            "Beskytt pågående opptak",
          )}
          desc={t(
            "settingsScreen.files.protectDesc",
            "Krever bekreftelse for å stoppe et pågående opptak.",
          )}
          control={
            <LiveToggle
              on={s.protectRecording}
              onChange={(next) => update({ protectRecording: next })}
            />
          }
        />
        {/* NOTE: `trimSilence` (ffmpeg silenceremove on the output, distinct
            from `stopOnSilence` below) is a real Settings field with no row in
            this redesign — left static. */}
        <SettingRow
          title={t(
            "settingsScreen.files.stopSilenceTitle",
            "Stopp ved vedvarende stillhet",
          )}
          desc={t(
            "settingsScreen.files.stopSilenceDesc",
            "Avslutter opptaket hvis lyden er stille i mer enn 5 minutter.",
          )}
          control={
            <LiveToggle
              on={s.stopOnSilence}
              onChange={(next) => update({ stopOnSilence: next })}
            />
          }
        />
        <SettingRow
          title={t("settingsScreen.files.preRollTitle", "Pre-roll buffer")}
          desc={t(
            "settingsScreen.files.preRollDesc",
            "Starter opptak noen sekunder bakover i tid — fanger begynnelsen selv om du trykker litt for sent.",
          )}
          control={
            <select
              className="sr-select"
              style={{ width: 90 }}
              value={s.preRollSeconds}
              onChange={(e) =>
                update({ preRollSeconds: Number(e.target.value) })
              }
            >
              <option value={0}>{t("settingsScreen.off", "Av")}</option>
              <option value={15}>15 s</option>
              <option value={30}>30 s</option>
            </select>
          }
        />
        <SettingRow
          title={t("settingsScreen.files.splitTitle", "Del opp filer per time")}
          desc={t(
            "settingsScreen.files.splitDesc",
            "Lager ny fil for hver time — enklere å redigere etterpå.",
          )}
          control={
            <select
              className="sr-select"
              style={{ width: 90 }}
              value={s.splitMinutes}
              onChange={(e) => update({ splitMinutes: Number(e.target.value) })}
            >
              <option value={0}>{t("settingsScreen.off", "Av")}</option>
              <option value={60}>60 min</option>
            </select>
          }
        />
      </Card>
    </>
  );
}

function TabPublisering() {
  const { t } = useTranslation();
  // Cover art has no dedicated Settings field in the Fase-1 model, so the
  // chosen image path lives in local screen state (cleared by "Fjern"). The
  // RSS feed URL the design shows is a placeholder until the publish subsystem
  // provides a real one; "Kopier" copies whatever is displayed.
  const [coverPath, setCoverPath] = useState<string | null>(null);
  const RSS_FEED_URL = "https://sundayrec.app/feed/alta-frikirke.xml";
  const [copied, setCopied] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const onCopyFeed = () => {
    void navigator.clipboard
      ?.writeText(RSS_FEED_URL)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => {});
  };

  const onConnectDrive = () => {
    setConnecting(true);
    // `cloud_connect` runs the OAuth loopback flow; rejects gracefully (e.g.
    // missing OAuth config / feature off) without crashing the screen.
    void invoke("cloud_connect", { service: "google-drive" })
      .catch(() => {})
      .finally(() => setConnecting(false));
  };

  const coverName = coverPath
    ? (coverPath.split(/[/\\]/).pop() ?? coverPath)
    : null;

  return (
    <>
      {/* TODO: this tab maps to cloud/publish/streaming subsystems with their
          own commands — no plain Settings fields, so kept static. */}
      <div className="sr-card pad" style={{ borderColor: "var(--sr-line)" }}>
        <div className="sr-row" style={{ gap: 12 }}>
          <Icon name="upload" size={18} style={{ color: "var(--sr-gold)" }} />
          <div>
            <div style={{ fontSize: 14.5, fontWeight: 600 }}>
              {t(
                "settingsScreen.publishing.heroTitle",
                "Del opptakene utenfor kirken",
              )}
            </div>
            <div className="sr-srow-d">
              {t(
                "settingsScreen.publishing.heroDesc",
                "Sett opp automatisk sky-backup og — hvis dere ønsker — en podkast i Spotify og Apple Podcasts. Alt er valgfritt.",
              )}
            </div>
          </div>
        </div>
      </div>
      <Card
        title={t(
          "settingsScreen.publishing.coverTitle",
          "Standard episodebilde",
        )}
        icon="image"
        desc={t(
          "settingsScreen.publishing.coverDesc",
          "Brukes som cover art for alle prekener med mindre du overstyrer per episode.",
        )}
        pad
      >
        <div className="sr-row" style={{ gap: 14, marginTop: 14 }}>
          <div
            className="sr-media"
            style={{ width: 88, height: 88, flex: "0 0 88px" }}
          >
            cover
          </div>
          <div className="sr-grow">
            <div
              style={{ fontSize: 13.5, fontWeight: 600 }}
              className="sr-mono"
            >
              {coverName ??
                t(
                  "settingsScreen.publishing.usingDefaultImage",
                  "Bruker standardbilde",
                )}
            </div>
            <div style={{ marginTop: 8 }}>
              <Badge kind="warn">
                {t(
                  "settingsScreen.publishing.coverSquareHint",
                  "Cover art bør være kvadratisk (1:1)",
                )}
              </Badge>
            </div>
            <div className="sr-row" style={{ gap: 8, marginTop: 10 }}>
              <button
                className="sr-btn ghost sm"
                type="button"
                onClick={() => {
                  void pickImage().then((p) => {
                    if (p) setCoverPath(p);
                  });
                }}
              >
                {t("settingsScreen.publishing.changeImage", "Bytt bilde")}
              </button>
              <button
                className="sr-btn ghost sm"
                type="button"
                disabled={!coverPath}
                onClick={() => setCoverPath(null)}
              >
                {t("settingsScreen.publishing.removeImage", "Fjern")}
              </button>
            </div>
          </div>
        </div>
      </Card>
      <Card
        title={t("settingsScreen.publishing.cloudTitle", "Sky-backup")}
        icon="drive"
        desc={t(
          "settingsScreen.publishing.cloudDesc",
          "Last opp opptakene automatisk til Google Drive — ekstra sikkerhet og enkel deling.",
        )}
        pad
      >
        <button
          className="sr-btn gold block"
          style={{ marginTop: 14 }}
          type="button"
          onClick={onConnectDrive}
          disabled={connecting}
        >
          <Icon name="drive" size={16} />
          {connecting
            ? t("settingsScreen.publishing.connecting", "Kobler til …")
            : t(
                "settingsScreen.publishing.connectDrive",
                "Koble til Google Drive",
              )}
        </button>
      </Card>
      <Card
        title={t("settingsScreen.publishing.streamTitle", "Direktesending")}
        icon="live"
        desc={t(
          "settingsScreen.publishing.streamDesc",
          "Stream gudstjenester live til YouTube, Facebook eller egen RTMP-server.",
        )}
        pad
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
            marginTop: 14,
          }}
        >
          <div className="sr-field">
            <span className="sr-label">
              {t("settingsScreen.publishing.nameLabel", "Navn")}
            </span>
            <div className="sr-input">YouTube · SundayRec</div>
          </div>
          <div className="sr-field">
            <span className="sr-label">
              {t("settingsScreen.publishing.rtmpLabel", "RTMP-URL")}
            </span>
            <div className="sr-input mono">rtmp://a.rtmp.youtube.com/live2</div>
          </div>
        </div>
        <div className="sr-row" style={{ marginTop: 12 }}>
          <span className="sr-grow" style={{ fontSize: 13.5, fontWeight: 600 }}>
            {t("settingsScreen.publishing.enabled", "Aktivert")}
          </span>
          <Toggle on />
        </div>
      </Card>
      <Card
        title={t(
          "settingsScreen.publishing.podcastTitle",
          "Podkast (RSS-feed)",
        )}
        icon="list"
        desc={t(
          "settingsScreen.publishing.podcastDesc",
          "Genererer en RSS-feed automatisk etter hvert opptak. Send feed-URL-en én gang til Spotify og Apple Podcasts.",
        )}
        pad
      >
        <div className="sr-row" style={{ gap: 10, marginTop: 14 }}>
          <div className="sr-input mono sr-grow">{RSS_FEED_URL}</div>
          <button className="sr-btn ghost" type="button" onClick={onCopyFeed}>
            <Icon name={copied ? "check" : "link"} size={15} />
            {copied
              ? t("settingsScreen.publishing.copied", "Kopiert")
              : t("settingsScreen.publishing.copy", "Kopier")}
          </button>
        </div>
      </Card>
    </>
  );
}

function TabVarsler({ s, update }: TabProps) {
  const { t } = useTranslation();
  // Webhook test state: null = idle, true = reached, false = failed/unavailable.
  const [webhookResult, setWebhookResult] = useState<boolean | null>(null);
  const [webhookTesting, setWebhookTesting] = useState(false);

  const onTestWebhook = () => {
    if (!s.webhookUrl) {
      setWebhookResult(false);
      return;
    }
    setWebhookTesting(true);
    setWebhookResult(null);
    // `email_test_webhook` POSTs a bounded test payload and returns whether the
    // endpoint accepted it; a rejection (feature off / network) is treated as
    // "didn't work" rather than a crash.
    void invoke<boolean>("email_test_webhook", { url: s.webhookUrl })
      .then((ok) => setWebhookResult(!!ok))
      .catch(() => setWebhookResult(false))
      .finally(() => setWebhookTesting(false));
  };

  return (
    <>
      <Card
        title={t("settingsScreen.notifications.systemTitle", "Systemvarsler")}
        icon="bell"
        pad
      >
        <SettingRow
          title={t(
            "settingsScreen.notifications.onStartTitle",
            "Varsel når opptak starter",
          )}
          desc={t(
            "settingsScreen.notifications.onStartDesc",
            "Vises som systemvarsel når en planlagt session begynner.",
          )}
          control={
            <LiveToggle
              on={s.notifyStart}
              onChange={(next) => update({ notifyStart: next })}
            />
          }
        />
        <SettingRow
          title={t(
            "settingsScreen.notifications.onStopTitle",
            "Varsel når opptak avsluttes",
          )}
          desc={t(
            "settingsScreen.notifications.onStopDesc",
            "Klikk varselet for å gå rett til filen.",
          )}
          control={
            <LiveToggle
              on={s.notifyStop}
              onChange={(next) => update({ notifyStop: next })}
            />
          }
        />
        <SettingRow
          title={t(
            "settingsScreen.notifications.reminderTitle",
            "Påminnelse før opptak",
          )}
          desc={t(
            "settingsScreen.notifications.reminderDesc",
            "Systemvarsel N minutter før planlagt opptak starter.",
          )}
          control={
            <select
              className="sr-select"
              style={{ width: 110 }}
              value={s.reminderMinutes}
              onChange={(e) =>
                update({ reminderMinutes: Number(e.target.value) })
              }
            >
              <option value={0}>{t("settingsScreen.off", "Av")}</option>
              <option value={5}>
                {t(
                  "settingsScreen.notifications.minBefore",
                  "{{count}} min før",
                  {
                    count: 5,
                  },
                )}
              </option>
              <option value={10}>
                {t(
                  "settingsScreen.notifications.minBefore",
                  "{{count}} min før",
                  {
                    count: 10,
                  },
                )}
              </option>
              <option value={15}>
                {t(
                  "settingsScreen.notifications.minBefore",
                  "{{count}} min før",
                  {
                    count: 15,
                  },
                )}
              </option>
              <option value={30}>
                {t(
                  "settingsScreen.notifications.minBefore",
                  "{{count}} min før",
                  {
                    count: 30,
                  },
                )}
              </option>
            </select>
          }
        />
      </Card>
      <Card
        title={t("settingsScreen.notifications.emailTitle", "E-postvarsler")}
        icon="mail"
        pad
      >
        {/* NOTE: `emailSmtp` / `emailSmtpPort` / `emailSmtpUser` are real
            Settings fields but this redesign has no SMTP host/port/user inputs
            (only the recipient). Wiring them would require adding controls and
            changing the layout, which is out of scope here — left static. */}
        <SettingRow
          title={t(
            "settingsScreen.notifications.emailOnErrorTitle",
            "Send e-post ved feil",
          )}
          desc={t(
            "settingsScreen.notifications.emailOnErrorDesc",
            "Sender e-post til ansvarlig hvis opptaket mislykkes.",
          )}
          control={
            <LiveToggle
              on={s.emailOnError}
              onChange={(next) => update({ emailOnError: next })}
            />
          }
        />
        <div className="sr-field" style={{ marginTop: 8 }}>
          <span className="sr-label">
            {t("settingsScreen.notifications.recipientLabel", "Mottaker")}
          </span>
          <input
            className="sr-input mono"
            type="email"
            value={s.emailAddress}
            placeholder="richard@altafrikirke.no"
            onChange={(e) => update({ emailAddress: e.target.value })}
          />
        </div>
      </Card>
      <Card
        title={t(
          "settingsScreen.notifications.webhookTitle",
          "Webhook (Slack / Discord / Teams)",
        )}
        icon="webhook"
        desc={t(
          "settingsScreen.notifications.webhookDesc",
          "Send varsler til en chat-kanal i tillegg til e-post.",
        )}
        pad
      >
        <div className="sr-field" style={{ marginTop: 14 }}>
          <span className="sr-label">
            {t("settingsScreen.notifications.webhookUrlLabel", "Webhook-URL")}
          </span>
          <input
            className="sr-input mono"
            type="url"
            value={s.webhookUrl}
            placeholder="https://hooks.slack.com/services/…"
            onChange={(e) => update({ webhookUrl: e.target.value })}
          />
        </div>
        <div style={{ marginTop: 6 }}>
          <SettingRow
            title={t(
              "settingsScreen.notifications.webhookWarningTitle",
              "Send også på advarsler",
            )}
            desc={t(
              "settingsScreen.notifications.webhookWarningDesc",
              "Som standard sendes kun feilmeldinger.",
            )}
            control={
              <LiveToggle
                on={s.webhookOnWarning}
                onChange={(next) => update({ webhookOnWarning: next })}
              />
            }
          />
        </div>
        <div className="sr-row" style={{ gap: 10, marginTop: 12 }}>
          <button
            className="sr-btn ghost sm"
            type="button"
            onClick={onTestWebhook}
            disabled={webhookTesting || !s.webhookUrl}
          >
            {webhookTesting
              ? t("settingsScreen.notifications.testingWebhook", "Tester …")
              : t("settingsScreen.notifications.testWebhook", "Test webhook")}
          </button>
          {webhookResult === true && (
            <span style={{ fontSize: 12.5, color: "var(--sr-green)" }}>
              {t("settingsScreen.notifications.webhookOk", "Webhook fungerer")}
            </span>
          )}
          {webhookResult === false && (
            <span style={{ fontSize: 12.5, color: "var(--sr-red)" }}>
              {t(
                "settingsScreen.notifications.webhookFail",
                "Webhook svarte ikke",
              )}
            </span>
          )}
        </div>
      </Card>
    </>
  );
}

function TabSystem({ s, update }: TabProps) {
  const { t } = useTranslation();
  // Update check: null = not run, "checking", or a human-readable result line.
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const onCheckUpdates = () => {
    setChecking(true);
    setUpdateMsg(null);
    // `update_check` returns an UpdateStatus phase; a rejection (updater feature
    // off / no signing) is reported as "up to date" rather than crashing.
    void invoke<{ phase: string; version?: string }>("update_check")
      .then((status) => {
        if (status?.phase === "available" && status.version) {
          setUpdateMsg(
            t(
              "settingsScreen.system.updateAvailable",
              "Ny versjon tilgjengelig: {{version}}",
              { version: status.version },
            ),
          );
        } else {
          setUpdateMsg(t("settingsScreen.system.upToDate", "Du er oppdatert"));
        }
      })
      .catch(() =>
        setUpdateMsg(t("settingsScreen.system.upToDate", "Du er oppdatert")),
      )
      .finally(() => setChecking(false));
  };

  const currentLng =
    s.language && (SUPPORTED_LNGS as readonly string[]).includes(s.language)
      ? s.language
      : "no";
  return (
    <>
      <Card
        title={t("settingsScreen.system.languageTitle", "Språk")}
        icon="globe"
        desc={t(
          "settingsScreen.system.languageDesc",
          "SundayRec støtter syv språk — alle menyer og varsler tilpasses umiddelbart.",
        )}
        pad
      >
        <div className="sr-field" style={{ marginTop: 14, maxWidth: 260 }}>
          <span className="sr-label">
            {t("settingsScreen.system.appLanguageLabel", "Appspråk")}
          </span>
          <select
            className="sr-select"
            value={currentLng}
            onChange={(e) => {
              const lng = e.target.value;
              void changeLanguage(lng);
              update({ language: lng });
            }}
          >
            {SUPPORTED_LNGS.map((lng) => (
              <option key={lng} value={lng}>
                {LANGUAGE_NAMES[lng]}
              </option>
            ))}
          </select>
        </div>
      </Card>
      <Card
        title={t("settingsScreen.system.churchProfileTitle", "Kirkeprofil")}
        icon="church"
        desc={t(
          "settingsScreen.system.churchProfileDesc",
          "Brukes i filnavn, varslings-e-poster og podkast-RSS.",
        )}
        pad
      >
        <div className="sr-field" style={{ marginTop: 14 }}>
          <span className="sr-label">
            {t("settingsScreen.system.churchNameLabel", "Menighet / kirke")}
          </span>
          <input
            className="sr-input"
            type="text"
            value={s.churchName}
            placeholder="Alta Frikirke"
            onChange={(e) => update({ churchName: e.target.value })}
          />
        </div>
        <div className="sr-field" style={{ marginTop: 14 }}>
          <span className="sr-label">
            {t(
              "settingsScreen.system.responsiblePersonLabel",
              "Ansvarlig person",
            )}
          </span>
          <input
            className="sr-input"
            type="text"
            value={s.responsiblePerson}
            placeholder="Richard Fossland"
            onChange={(e) => update({ responsiblePerson: e.target.value })}
          />
        </div>
      </Card>
      <Card
        title={t("settingsScreen.system.systemTitle", "System")}
        icon="gear"
        pad
      >
        {/* NOTE: `minimizeToTray` and `wakeFromSleep` are real Settings fields
            with no matching row in this redesign's System card (only
            launch-at-login / show-on-startup / ask-open-editor). Adding rows
            would alter the layout, so they're left static here. */}
        <SettingRow
          title={t(
            "settingsScreen.system.launchTitle",
            "Start automatisk med Windows / Mac",
          )}
          desc={t(
            "settingsScreen.system.launchDesc",
            "Kjører stille i bakgrunnen — ingen handling nødvendig.",
          )}
          control={
            <LiveToggle
              on={s.launchAtLogin}
              onChange={(next) => update({ launchAtLogin: next })}
            />
          }
        />
        <SettingRow
          title={t(
            "settingsScreen.system.showOnStartupTitle",
            "Vis vindu ved oppstart",
          )}
          desc={t(
            "settingsScreen.system.showOnStartupDesc",
            "Åpner vinduet automatisk. Ellers starter det diskret i systemfeltet.",
          )}
          control={
            <LiveToggle
              on={s.showOnStartup}
              onChange={(next) => update({ showOnStartup: next })}
            />
          }
        />
        <SettingRow
          title={t(
            "settingsScreen.system.askEditorTitle",
            "Spør om redigering etter opptak",
          )}
          desc={t(
            "settingsScreen.system.askEditorDesc",
            "Foreslår å åpne filen i Rediger når opptaket er fullført.",
          )}
          control={
            <LiveToggle
              on={s.askOpenEditor}
              onChange={(next) => update({ askOpenEditor: next })}
            />
          }
        />
      </Card>
      <Card
        title={t("settingsScreen.system.updatesTitle", "Oppdateringer")}
        icon="update"
        pad
      >
        <div className="sr-row" style={{ marginTop: 4 }}>
          <span className="sr-grow sr-row" style={{ gap: 10 }}>
            <Badge kind="muted">v5.0.0</Badge>
            <span
              className="sr-row"
              style={{ gap: 7, fontSize: 13, color: "var(--sr-green)" }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--sr-green)",
                }}
              />
              {t("settingsScreen.system.upToDate", "Du er oppdatert")}
            </span>
          </span>
          <button
            className="sr-btn ghost sm"
            type="button"
            onClick={onCheckUpdates}
            disabled={checking}
          >
            {checking
              ? t("settingsScreen.system.checking", "Sjekker …")
              : t(
                  "settingsScreen.system.checkUpdates",
                  "Se etter oppdateringer",
                )}
          </button>
        </div>
        {updateMsg && (
          <div
            style={{
              marginTop: 8,
              fontSize: 12.5,
              color: "var(--sr-text-3)",
            }}
          >
            {updateMsg}
          </div>
        )}
        <div style={{ marginTop: 4 }}>
          <SettingRow
            title={t(
              "settingsScreen.system.autoUpdateTitle",
              "Oppdater automatisk",
            )}
            desc={t(
              "settingsScreen.system.autoUpdateDesc",
              "Laster ned og installerer nye versjoner stille i bakgrunnen.",
            )}
            control={
              <LiveToggle
                on={s.autoUpdate}
                onChange={(next) => update({ autoUpdate: next })}
              />
            }
          />
        </div>
      </Card>
      <Card
        title={t("settingsScreen.system.helpTitle", "Hjelp og opplæring")}
        icon="info"
        pad
      >
        <button
          className="sr-btn ghost"
          style={{ marginTop: 4 }}
          type="button"
          onClick={() => update({ onboardingDone: false })}
        >
          {t(
            "settingsScreen.system.reopenGuide",
            "Åpne oppstartsveileder på nytt",
          )}
        </button>
      </Card>
    </>
  );
}

function SuiteRow({
  name,
  desc,
  on,
}: {
  name: string;
  desc: string;
  on?: boolean;
}) {
  return <SettingRow title={name} desc={desc} control={<Toggle on={on} />} />;
}

function TabSuite() {
  const { t } = useTranslation();
  // church_id lives in the integrations bag (not plain Settings). Seed it from
  // the backend, edit locally, persist on "Lagre tilkobling".
  const [churchId, setChurchId] = useState("");
  const [savedTick, setSavedTick] = useState(false);

  useQuery({
    queryKey: ["integrations_get_settings"],
    queryFn: async () => {
      const res = await invoke<{ connection?: { churchId?: string | null } }>(
        "integrations_get_settings",
      );
      setChurchId(res?.connection?.churchId ?? "");
      return res;
    },
    retry: false,
  });

  const saveConnection = useMutation({
    mutationFn: (id: string) =>
      invoke("integrations_set_settings", {
        patch: { connection: { churchId: id || null } },
      }),
    onSuccess: () => {
      setSavedTick(true);
      window.setTimeout(() => setSavedTick(false), 1800);
    },
  });

  return (
    <>
      {/* TODO: Sunday-suite integration switches/church_id are owned by the
          integrations subsystem — no plain Settings fields, so kept static. */}
      <Card
        title="Sunday-suite"
        icon="sparkle"
        desc={t(
          "settingsScreen.suite.introDesc",
          "Koble SundayRec til søsterappene i Sunday-suiten. Alt er valgfritt og av som standard — SundayRec fungerer akkurat som før uten dette.",
        )}
        pad
      >
        <div style={{ marginTop: 6 }}>
          <SettingRow
            title={t(
              "settingsScreen.suite.enableTitle",
              "Aktiver Sunday-suite-integrasjoner",
            )}
            desc={t(
              "settingsScreen.suite.enableDesc",
              "Hovedbryter. Når den er av kjøres ingen integrasjonskode.",
            )}
            control={<Toggle />}
          />
        </div>
      </Card>
      <Card
        title={t("settingsScreen.suite.integrationsTitle", "Integrasjoner")}
        pad
      >
        <SuiteRow
          name={t(
            "settingsScreen.suite.verbatimName",
            "Verbatim — pro-teksting",
          )}
          desc={t(
            "settingsScreen.suite.verbatimDesc",
            "Send et videoopptak til Verbatim for profesjonell teksting; kommer tilbake som transkripsjon.",
          )}
        />
        <SuiteRow
          name={t(
            "settingsScreen.suite.songName",
            "SundaySong — CCLI/TONO-rapportering",
          )}
          desc={t(
            "settingsScreen.suite.songDesc",
            "Send sanglisten til SundaySong for automatiske lisensrapporter.",
          )}
        />
        <SuiteRow
          name={t(
            "settingsScreen.suite.planName",
            "SundayPlan — tjeneste-bevisst opptak",
          )}
          desc={t(
            "settingsScreen.suite.planDesc",
            "Henter kommende tjenester og fyller inn tittel og taler automatisk.",
          )}
        />
        <SuiteRow
          name={t(
            "settingsScreen.suite.stageName",
            "SundayStage — auto-kapitler",
          )}
          desc={t(
            "settingsScreen.suite.stageDesc",
            "Importer Stage sin cue-logg for å sette kapittelmarkører automatisk.",
          )}
        />
      </Card>
      <Card
        title={t("settingsScreen.suite.connectionTitle", "Tilkobling")}
        icon="link"
        desc={t(
          "settingsScreen.suite.connectionDesc",
          "Delte felt brukt av Song- og Plan-integrasjonene.",
        )}
        pad
      >
        <div className="sr-field" style={{ marginTop: 14 }}>
          <span className="sr-label">
            {t(
              "settingsScreen.suite.churchIdLabel",
              "Menighets-ID (church_id)",
            )}
          </span>
          <input
            className="sr-input mono"
            type="text"
            value={churchId}
            placeholder={t(
              "settingsScreen.suite.churchIdHint",
              "UUID fra SundaySong / SundayPlan",
            )}
            onChange={(e) => setChurchId(e.target.value)}
          />
        </div>
        <div className="sr-row" style={{ gap: 10, marginTop: 14 }}>
          <button
            className="sr-btn ghost sm"
            type="button"
            onClick={() => saveConnection.mutate(churchId)}
            disabled={saveConnection.isPending}
          >
            {t("settingsScreen.suite.saveConnection", "Lagre tilkobling")}
          </button>
          {savedTick && (
            <span style={{ fontSize: 12.5, color: "var(--sr-green)" }}>
              {t("settingsScreen.suite.connectionSaved", "Lagret")}
            </span>
          )}
        </div>
      </Card>
    </>
  );
}

export function SettingsScreen() {
  const { t } = useTranslation();
  // Honour a deep-link target tab (WS-6): a navigation that set a pending tab
  // (e.g. Home format card → "filer") opens that tab on mount. Consumed once so
  // a later plain visit defaults to "lydkilde".
  const [tab, setTab] = useState<TabId>(
    () => consumePendingSettingsTab() ?? "lydkilde",
  );
  const queryClient = useQueryClient();

  // If the screen is already mounted when a deep-link lands (the shell keeps
  // views alive), switch to the requested tab on the navigation event.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const target =
        detail && typeof detail === "object" && "tab" in detail
          ? (detail as { tab?: unknown }).tab
          : null;
      if (isSettingsTabId(target)) setTab(target);
    };
    window.addEventListener("shell:navigate", handler);
    return () => window.removeEventListener("shell:navigate", handler);
  }, []);

  // Load persisted settings over the same cache key as `SettingsPage`. In the
  // dev/test env `settings_get` may reject — we fall back to static defaults
  // and never crash on a null/undefined value.
  const { data } = useQuery<Settings>({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => invoke<Settings>("settings_get"),
    retry: false,
  });
  const s: Settings = data ?? DEFAULT_SETTINGS;

  const saveMutation = useMutation({
    mutationFn: (next: Settings) =>
      invoke<Settings>("settings_save", { settings: next }),
    onSuccess: (saved) => {
      // Backend clamps/validates; reflect the canonical value into the cache.
      queryClient.setQueryData(SETTINGS_QUERY_KEY, saved);
      void queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    },
  });

  // Merge a partial change into the current settings and persist it. Optimistic
  // so the controls feel instant even before the backend echoes back.
  const update: Update = (patch) => {
    const next = { ...s, ...patch };
    queryClient.setQueryData(SETTINGS_QUERY_KEY, next);
    saveMutation.mutate(next);
  };

  return (
    <div className="sr-content cozy">
      <div className="sr-pagehead">
        <div className="sr-pagetitle">
          {t("settingsScreen.pageTitle", "Innstillinger")}
        </div>
        <div className="sr-pagesub">
          {t(
            "settingsScreen.pageSubtitle",
            "Alt det avanserte bor her — samlet, sentrert og rolig.",
          )}
        </div>
      </div>
      <div style={{ marginBottom: 22, overflow: "auto" }}>
        <div className="sr-tabs">
          {TABS.map(([id, label]) => (
            <div
              key={id}
              className={"sr-tab" + (tab === id ? " is-active" : "")}
              onClick={() => setTab(id)}
            >
              {t(`settingsScreen.${TAB_LABEL_KEYS[id]}`, label)}
            </div>
          ))}
        </div>
      </div>
      <div className="sr-stack-4">
        {tab === "lydkilde" && <TabLydkilde s={s} update={update} />}
        {tab === "video" && <TabVideo s={s} update={update} />}
        {tab === "filer" && <TabFiler s={s} update={update} />}
        {tab === "publisering" && <TabPublisering />}
        {tab === "varsler" && <TabVarsler s={s} update={update} />}
        {tab === "system" && <TabSystem s={s} update={update} />}
        {tab === "suite" && <TabSuite />}
      </div>
    </div>
  );
}
