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
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Settings } from "@/lib/bindings/Settings";
import type { ChannelMode } from "@/lib/bindings/ChannelMode";
import type { FileFormat } from "@/lib/bindings/FileFormat";
import type { FilenamePattern } from "@/lib/bindings/FilenamePattern";
import type { RecordingOpts } from "@/lib/bindings/RecordingOpts";
import { LANGUAGE_NAMES, SUPPORTED_LNGS, changeLanguage } from "@/i18n";
import { SETTINGS_QUERY_KEY } from "@/features/settings/queryKey";
import { useVideoDevices } from "@/design/hooks";

import { Icon } from "../Icon";
import { Badge, Card, DeviceRow, SegOpt, SettingRow, Toggle } from "../atoms";
import { DEFAULT_SETTINGS, pickFolder } from "./settings.helpers";

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

function TabLydkilde({ s, update }: TabProps) {
  return (
    <>
      <Card
        title="Tilgjengelige enheter"
        icon="mic"
        desc="Velg mikseren eller lydkortet som tar opp lyden i kirken. USB-mikser anbefales fremfor innebygd mikrofon."
        pad
      >
        {/* TODO: device list — no single Settings field; real device picker
            lives in features/devices/DevicePicker. Static rows kept as-is. */}
        <div className="sr-stack-3" style={{ marginTop: 16 }}>
          <DeviceRow
            icon="mic"
            name="USB-mikser — Behringer"
            meta="USB / ekstern · stereo"
            sel
            badge={
              <Badge kind="ok" dot>
                Tilkoblet
              </Badge>
            }
          />
          <DeviceRow
            icon="mic"
            name="MacBook Pro-mikrofon (innebygd)"
            meta="Intern · mono"
            badge={<Badge kind="warn">Ikke anbefalt</Badge>}
          />
          <DeviceRow
            icon="mic"
            name="Mikrofonen på iPhone"
            meta="USB / ekstern"
            badge={
              <Badge kind="ok" dot>
                Tilkoblet
              </Badge>
            }
          />
        </div>
        <div className="sr-row" style={{ marginTop: 16 }}>
          <span
            className="sr-grow"
            style={{ fontSize: 13, color: "var(--sr-text-3)" }}
          >
            Ser du ikke riktig enhet? Sjekk at lydkortet er koblet til.
          </span>
          <button className="sr-btn ghost sm">
            <Icon name="speaker" size={14} />
            Test lyd
          </button>
          <button className="sr-btn ghost sm">Diagnose</button>
        </div>
      </Card>
      <Card
        title="Sjekk at alt fungerer"
        icon="shield"
        desc="Kjør disse før en gudstjeneste for å være sikker på at opptaket starter uten problemer."
        pad
      >
        <div className="sr-row" style={{ gap: 10, marginTop: 14 }}>
          <button className="sr-btn ghost">
            <Icon name="mic" size={15} />
            Test-opptak (30 sek)
          </button>
          <button className="sr-btn gold">
            <Icon name="check" size={15} strokeWidth={2.4} />
            Sjekk system nå
          </button>
        </div>
      </Card>
      <Card title="Kanaler" pad>
        <div className="sr-seg cols-4" style={{ marginTop: 4 }}>
          <LiveSegOpt
            sel={s.channels === "stereo"}
            title="Stereo"
            badge="Anbefalt"
            onSelect={() => update({ channels: "stereo" as ChannelMode })}
          />
          <LiveSegOpt
            sel={s.channels === "monoMix"}
            title="Mono"
            sub="Miks L+R"
            onSelect={() => update({ channels: "monoMix" as ChannelMode })}
          />
          <LiveSegOpt
            sel={s.channels === "monoL"}
            title="Mono L"
            sub="Kun venstre"
            onSelect={() => update({ channels: "monoL" as ChannelMode })}
          />
          <LiveSegOpt
            sel={s.channels === "monoR"}
            title="Mono R"
            sub="Kun høyre"
            onSelect={() => update({ channels: "monoR" as ChannelMode })}
          />
        </div>
      </Card>
      <Card title="Samplingsrate" pad>
        <div className="sr-seg cols-2" style={{ marginTop: 4 }}>
          <LiveSegOpt
            sel={s.sampleRate === 44100}
            title="44 100 Hz"
            sub="Musikk, CD og podkast"
            onSelect={() => update({ sampleRate: 44100 })}
          />
          <LiveSegOpt
            sel={s.sampleRate === 48000}
            title="48 000 Hz"
            badge="Anbefalt"
            sub="Video, Zoom og TV-utstyr"
            onSelect={() => update({ sampleRate: 48000 })}
          />
        </div>
      </Card>
      <Card
        title="Lyd-prosessering"
        icon="eq"
        desc="Valgfritt. Standard er av — rått opptak gir mest fleksibilitet i etterkant."
        pad
      >
        {/* NOTE: `inputVolume` (input gain %) is a real Settings field but the
            redesign has no gain slider on this tab, so it stays at its
            persisted/default value — left static. */}
        <SettingRow
          title="Equalizer (bass / mid / diskant)"
          desc="Lett tonejustering på vei inn."
          control={
            <LiveToggle
              on={s.eqEnabled}
              onChange={(next) => update({ eqEnabled: next })}
            />
          }
        />
        <SettingRow
          title="Kompressor"
          desc="Jevner ut svingninger i stemmestyrke."
          control={
            <LiveToggle
              on={s.compEnabled}
              onChange={(next) => update({ compEnabled: next })}
            />
          }
        />
        <SettingRow
          title="Limiter (klippe-vern)"
          desc="Hindrer at plutselig høy lyd overstyrer."
          control={
            <LiveToggle
              on={s.limiterEnabled}
              onChange={(next) => update({ limiterEnabled: next })}
            />
          }
        />
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
  // Bumping `refreshKey` remounts <CameraSelect> so the "Oppdater" button
  // re-enumerates cameras through `useVideoDevices()`.
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <>
      <Card pad>
        <SettingRow
          title="Aktiver videoopptak"
          desc="Tar opp video i tillegg til lyd ved hvert opptak."
          control={
            <LiveToggle
              on={s.videoEnabled}
              onChange={(next) => update({ videoEnabled: next })}
            />
          }
        />
      </Card>
      <Card title="Kamera" icon="camera" pad>
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
            Oppdater
          </button>
        </div>
        <div
          style={{ fontSize: 12.5, color: "var(--sr-text-3)", marginTop: 10 }}
        >
          USB-webkamera og HDMI-opptakskort støttes på macOS og Windows.
        </div>
      </Card>
      <Card title="Kvalitet" pad>
        <div className="sr-label" style={{ marginBottom: 10 }}>
          Oppløsning
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
            badge="Anbefalt"
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
          <span className="sr-label">Bilderate</span>
          <select
            className="sr-select"
            value={s.videoFramerate}
            onChange={(e) => update({ videoFramerate: Number(e.target.value) })}
          >
            <option value={25}>25 fps</option>
            <option value={30}>30 fps (anbefalt)</option>
          </select>
        </div>
      </Card>
      <Card
        title="Utdataformat"
        desc="Velg om lyd og video skal kombineres til én fil eller lagres separat."
        pad
      >
        <div className="sr-seg cols-2" style={{ marginTop: 14 }}>
          <LiveSegOpt
            sel={s.outputMode === "combined"}
            title="Kombinert MP4"
            sub="Lyd + video i én fil — klar for YouTube"
            onSelect={() => update({ outputMode: "combined" })}
          />
          <LiveSegOpt
            sel={s.outputMode === "separate"}
            title="Separate filer"
            sub="Lyd og video lagres hver for seg"
            onSelect={() => update({ outputMode: "separate" })}
          />
        </div>
        <div style={{ marginTop: 6 }}>
          <SettingRow
            title="Behold separat lydfil"
            desc="Lagrer også den høykvalitets lydfilen ved siden av MP4."
            control={
              <LiveToggle
                on={s.keepSeparateAudio}
                onChange={(next) => update({ keepSeparateAudio: next })}
              />
            }
          />
          <SettingRow
            title="Perfekt A/V-synk"
            desc="Bruker én ffmpeg-prosess for både lyd og bilde — eliminerer sync-drift."
            control={
              <LiveToggle
                on={s.avSync}
                onChange={(next) => update({ avSync: next })}
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
  return (
    <>
      <Card
        title="Lagringsmappe"
        icon="folder"
        desc="Alle opptak havner her som lokale filer."
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
            Velg mappe
          </button>
        </div>
      </Card>
      <Card
        title="Navnmønster"
        desc="Programmet gjenkjenner kirkelige høytider og bruker det riktige norske navnet automatisk."
        pad
      >
        <div className="sr-field" style={{ marginTop: 14, maxWidth: 320 }}>
          <span className="sr-label">Navneformat</span>
          {/* SegOpt-style picker would change the layout; keep the native
              select look but drive it from the real filenamePattern field. */}
          <select
            className="sr-select"
            value={s.filenamePattern}
            onChange={(e) =>
              update({ filenamePattern: e.target.value as FilenamePattern })
            }
          >
            <option value="date">Dato</option>
            <option value="church">Kirkelig navn + dato</option>
            <option value="plain">Gudstjeneste + dato</option>
            <option value="datetime">Dato + klokkeslett</option>
          </select>
        </div>
        <div className="sr-field" style={{ marginTop: 14 }}>
          <span className="sr-label">Forhåndsvisning</span>
          <FilenamePreview s={s} />
        </div>
      </Card>
      <Card title="Format & kvalitet" pad>
        {/* NOTE: `bitrate` is a real Settings field but the redesign exposes no
            bitrate selector (only the MP3/FLAC/WAV format picker below), so it
            stays at its persisted/default value — left static. */}
        <div className="sr-seg cols-3" style={{ marginTop: 4 }}>
          <LiveSegOpt
            sel={s.format === "mp3"}
            title="MP3"
            sub="~85 MB / t · for deling"
            onSelect={() => update({ format: "mp3" as FileFormat })}
          />
          <LiveSegOpt
            sel={s.format === "flac"}
            title="FLAC"
            sub="~300 MB / t · tapsfri"
            onSelect={() => update({ format: "flac" as FileFormat })}
          />
          <LiveSegOpt
            sel={s.format === "wav"}
            title="WAV"
            sub="~635 MB / t · høyest kvalitet"
            onSelect={() => update({ format: "wav" as FileFormat })}
          />
        </div>
      </Card>
      <Card
        title="Opptaksoppførsel"
        icon="shield"
        desc="Finjuster hvordan opptaket starter, beskyttes og deles opp."
        pad
      >
        <SettingRow
          title="Slett automatisk gamle opptak"
          desc="Frigjør diskplass ved å slette opptak eldre enn 90 dager."
          control={
            <LiveToggle
              on={s.autoDeleteDays > 0}
              onChange={(next) => update({ autoDeleteDays: next ? 90 : 0 })}
            />
          }
        />
        <SettingRow
          title="Beskytt pågående opptak"
          desc="Krever bekreftelse for å stoppe et pågående opptak."
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
          title="Stopp ved vedvarende stillhet"
          desc="Avslutter opptaket hvis lyden er stille i mer enn 5 minutter."
          control={
            <LiveToggle
              on={s.stopOnSilence}
              onChange={(next) => update({ stopOnSilence: next })}
            />
          }
        />
        <SettingRow
          title="Pre-roll buffer"
          desc="Starter opptak noen sekunder bakover i tid — fanger begynnelsen selv om du trykker litt for sent."
          control={
            <select
              className="sr-select"
              style={{ width: 90 }}
              value={s.preRollSeconds}
              onChange={(e) =>
                update({ preRollSeconds: Number(e.target.value) })
              }
            >
              <option value={0}>Av</option>
              <option value={15}>15 s</option>
              <option value={30}>30 s</option>
            </select>
          }
        />
        <SettingRow
          title="Del opp filer per time"
          desc="Lager ny fil for hver time — enklere å redigere etterpå."
          control={
            <select
              className="sr-select"
              style={{ width: 90 }}
              value={s.splitMinutes}
              onChange={(e) => update({ splitMinutes: Number(e.target.value) })}
            >
              <option value={0}>Av</option>
              <option value={60}>60 min</option>
            </select>
          }
        />
      </Card>
    </>
  );
}

function TabPublisering() {
  return (
    <>
      {/* TODO: this tab maps to cloud/publish/streaming subsystems with their
          own commands — no plain Settings fields, so kept static. */}
      <div className="sr-card pad" style={{ borderColor: "var(--sr-line)" }}>
        <div className="sr-row" style={{ gap: 12 }}>
          <Icon name="upload" size={18} style={{ color: "var(--sr-gold)" }} />
          <div>
            <div style={{ fontSize: 14.5, fontWeight: 600 }}>
              Del opptakene utenfor kirken
            </div>
            <div className="sr-srow-d">
              Sett opp automatisk sky-backup og — hvis dere ønsker — en podkast
              i Spotify og Apple Podcasts. Alt er valgfritt.
            </div>
          </div>
        </div>
      </div>
      <Card
        title="Standard episodebilde"
        icon="image"
        desc="Brukes som cover art for alle prekener med mindre du overstyrer per episode."
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
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>
              Bruker standardbilde
            </div>
            <div style={{ marginTop: 8 }}>
              <Badge kind="warn">Cover art bør være kvadratisk (1:1)</Badge>
            </div>
            <div className="sr-row" style={{ gap: 8, marginTop: 10 }}>
              <button className="sr-btn ghost sm">Bytt bilde</button>
              <button className="sr-btn ghost sm">Fjern</button>
            </div>
          </div>
        </div>
      </Card>
      <Card
        title="Sky-backup"
        icon="drive"
        desc="Last opp opptakene automatisk til Google Drive — ekstra sikkerhet og enkel deling."
        pad
      >
        <button className="sr-btn gold block" style={{ marginTop: 14 }}>
          <Icon name="drive" size={16} />
          Koble til Google Drive
        </button>
      </Card>
      <Card
        title="Direktesending"
        icon="live"
        desc="Stream gudstjenester live til YouTube, Facebook eller egen RTMP-server."
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
            <span className="sr-label">Navn</span>
            <div className="sr-input">YouTube · SundayRec</div>
          </div>
          <div className="sr-field">
            <span className="sr-label">RTMP-URL</span>
            <div className="sr-input mono">rtmp://a.rtmp.youtube.com/live2</div>
          </div>
        </div>
        <div className="sr-row" style={{ marginTop: 12 }}>
          <span className="sr-grow" style={{ fontSize: 13.5, fontWeight: 600 }}>
            Aktivert
          </span>
          <Toggle on />
        </div>
      </Card>
      <Card
        title="Podkast (RSS-feed)"
        icon="list"
        desc="Genererer en RSS-feed automatisk etter hvert opptak. Send feed-URL-en én gang til Spotify og Apple Podcasts."
        pad
      >
        <div className="sr-row" style={{ gap: 10, marginTop: 14 }}>
          <div className="sr-input mono sr-grow">
            https://sundayrec.app/feed/alta-frikirke.xml
          </div>
          <button className="sr-btn ghost">
            <Icon name="link" size={15} />
            Kopier
          </button>
        </div>
      </Card>
    </>
  );
}

function TabVarsler({ s, update }: TabProps) {
  return (
    <>
      <Card title="Systemvarsler" icon="bell" pad>
        <SettingRow
          title="Varsel når opptak starter"
          desc="Vises som systemvarsel når en planlagt session begynner."
          control={
            <LiveToggle
              on={s.notifyStart}
              onChange={(next) => update({ notifyStart: next })}
            />
          }
        />
        <SettingRow
          title="Varsel når opptak avsluttes"
          desc="Klikk varselet for å gå rett til filen."
          control={
            <LiveToggle
              on={s.notifyStop}
              onChange={(next) => update({ notifyStop: next })}
            />
          }
        />
        <SettingRow
          title="Påminnelse før opptak"
          desc="Systemvarsel N minutter før planlagt opptak starter."
          control={
            <select
              className="sr-select"
              style={{ width: 110 }}
              value={s.reminderMinutes}
              onChange={(e) =>
                update({ reminderMinutes: Number(e.target.value) })
              }
            >
              <option value={0}>Av</option>
              <option value={5}>5 min før</option>
              <option value={10}>10 min før</option>
              <option value={15}>15 min før</option>
              <option value={30}>30 min før</option>
            </select>
          }
        />
      </Card>
      <Card title="E-postvarsler" icon="mail" pad>
        {/* NOTE: `emailSmtp` / `emailSmtpPort` / `emailSmtpUser` are real
            Settings fields but this redesign has no SMTP host/port/user inputs
            (only the recipient). Wiring them would require adding controls and
            changing the layout, which is out of scope here — left static. */}
        <SettingRow
          title="Send e-post ved feil"
          desc="Sender e-post til ansvarlig hvis opptaket mislykkes."
          control={
            <LiveToggle
              on={s.emailOnError}
              onChange={(next) => update({ emailOnError: next })}
            />
          }
        />
        <div className="sr-field" style={{ marginTop: 8 }}>
          <span className="sr-label">Mottaker</span>
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
        title="Webhook (Slack / Discord / Teams)"
        icon="webhook"
        desc="Send varsler til en chat-kanal i tillegg til e-post."
        pad
      >
        <div className="sr-field" style={{ marginTop: 14 }}>
          <span className="sr-label">Webhook-URL</span>
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
            title="Send også på advarsler"
            desc="Som standard sendes kun feilmeldinger."
            control={
              <LiveToggle
                on={s.webhookOnWarning}
                onChange={(next) => update({ webhookOnWarning: next })}
              />
            }
          />
        </div>
        <button className="sr-btn ghost sm" style={{ marginTop: 12 }}>
          Test webhook
        </button>
      </Card>
    </>
  );
}

function TabSystem({ s, update }: TabProps) {
  const currentLng =
    s.language && (SUPPORTED_LNGS as readonly string[]).includes(s.language)
      ? s.language
      : "no";
  return (
    <>
      <Card
        title="Språk"
        icon="globe"
        desc="SundayRec støtter syv språk — alle menyer og varsler tilpasses umiddelbart."
        pad
      >
        <div className="sr-field" style={{ marginTop: 14, maxWidth: 260 }}>
          <span className="sr-label">Appspråk</span>
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
        title="Kirkeprofil"
        icon="church"
        desc="Brukes i filnavn, varslings-e-poster og podkast-RSS."
        pad
      >
        <div className="sr-field" style={{ marginTop: 14 }}>
          <span className="sr-label">Menighet / kirke</span>
          <input
            className="sr-input"
            type="text"
            value={s.churchName}
            placeholder="Alta Frikirke"
            onChange={(e) => update({ churchName: e.target.value })}
          />
        </div>
        <div className="sr-field" style={{ marginTop: 14 }}>
          <span className="sr-label">Ansvarlig person</span>
          <input
            className="sr-input"
            type="text"
            value={s.responsiblePerson}
            placeholder="Richard Fossland"
            onChange={(e) => update({ responsiblePerson: e.target.value })}
          />
        </div>
      </Card>
      <Card title="System" icon="gear" pad>
        {/* NOTE: `minimizeToTray` and `wakeFromSleep` are real Settings fields
            with no matching row in this redesign's System card (only
            launch-at-login / show-on-startup / ask-open-editor). Adding rows
            would alter the layout, so they're left static here. */}
        <SettingRow
          title="Start automatisk med Windows / Mac"
          desc="Kjører stille i bakgrunnen — ingen handling nødvendig."
          control={
            <LiveToggle
              on={s.launchAtLogin}
              onChange={(next) => update({ launchAtLogin: next })}
            />
          }
        />
        <SettingRow
          title="Vis vindu ved oppstart"
          desc="Åpner vinduet automatisk. Ellers starter det diskret i systemfeltet."
          control={
            <LiveToggle
              on={s.showOnStartup}
              onChange={(next) => update({ showOnStartup: next })}
            />
          }
        />
        <SettingRow
          title="Spør om redigering etter opptak"
          desc="Foreslår å åpne filen i Rediger når opptaket er fullført."
          control={
            <LiveToggle
              on={s.askOpenEditor}
              onChange={(next) => update({ askOpenEditor: next })}
            />
          }
        />
      </Card>
      <Card title="Oppdateringer" icon="update" pad>
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
              Du er oppdatert
            </span>
          </span>
          <button className="sr-btn ghost sm">Se etter oppdateringer</button>
        </div>
        <div style={{ marginTop: 4 }}>
          <SettingRow
            title="Oppdater automatisk"
            desc="Laster ned og installerer nye versjoner stille i bakgrunnen."
            control={
              <LiveToggle
                on={s.autoUpdate}
                onChange={(next) => update({ autoUpdate: next })}
              />
            }
          />
        </div>
      </Card>
      <Card title="Hjelp og opplæring" icon="info" pad>
        <button className="sr-btn ghost" style={{ marginTop: 4 }}>
          Åpne oppstartsveileder på nytt
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
  return (
    <>
      {/* TODO: Sunday-suite integration switches/church_id are owned by the
          integrations subsystem — no plain Settings fields, so kept static. */}
      <Card
        title="Sunday-suite"
        icon="sparkle"
        desc="Koble SundayRec til søsterappene i Sunday-suiten. Alt er valgfritt og av som standard — SundayRec fungerer akkurat som før uten dette."
        pad
      >
        <div style={{ marginTop: 6 }}>
          <SettingRow
            title="Aktiver Sunday-suite-integrasjoner"
            desc="Hovedbryter. Når den er av kjøres ingen integrasjonskode."
            control={<Toggle />}
          />
        </div>
      </Card>
      <Card title="Integrasjoner" pad>
        <SuiteRow
          name="Verbatim — pro-teksting"
          desc="Send et videoopptak til Verbatim for profesjonell teksting; kommer tilbake som transkripsjon."
        />
        <SuiteRow
          name="SundaySong — CCLI/TONO-rapportering"
          desc="Send sanglisten til SundaySong for automatiske lisensrapporter."
        />
        <SuiteRow
          name="SundayPlan — tjeneste-bevisst opptak"
          desc="Henter kommende tjenester og fyller inn tittel og taler automatisk."
        />
        <SuiteRow
          name="SundayStage — auto-kapitler"
          desc="Importer Stage sin cue-logg for å sette kapittelmarkører automatisk."
        />
      </Card>
      <Card
        title="Tilkobling"
        icon="link"
        desc="Delte felt brukt av Song- og Plan-integrasjonene."
        pad
      >
        <div className="sr-field" style={{ marginTop: 14 }}>
          <span className="sr-label">Menighets-ID (church_id)</span>
          <div
            className="sr-input mono"
            style={{ color: "var(--sr-text-dim)" }}
          >
            UUID fra SundaySong / SundayPlan
          </div>
        </div>
        <button className="sr-btn ghost sm" style={{ marginTop: 14 }}>
          Lagre tilkobling
        </button>
      </Card>
    </>
  );
}

export function SettingsScreen() {
  const [tab, setTab] = useState<TabId>("lydkilde");
  const queryClient = useQueryClient();

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
        <div className="sr-pagetitle">Innstillinger</div>
        <div className="sr-pagesub">
          Alt det avanserte bor her — samlet, sentrert og rolig.
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
              {label}
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
