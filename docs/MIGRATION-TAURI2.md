# Migreringsplan: SundayRec → Tauri 2 + Rust (bygg det riktig fra bunnen)

> **Beslutning (Richard, 2026-05-30):** Hele SundayRec bygges om til samme
> grunnmur som resten av Sunday-serien — **Tauri 2 + Rust + React 19 + Tailwind
> v4 + SQLite/sqlx + keyring + ts-rs**. Bedre i lengden å ha alle på samme base.
>
> **Risikoprofil (oppdatert):** SundayRec er fortsatt i **testfase — ingen reelle
> brukere.** Vi tar derfor **høy risiko** og prioriterer å bygge det **riktig og
> mest mulig solid fra start**, framfor å beskytte en eksisterende installasjon.
> Ingen parallell Electron-drift, ingen «recorder sist bak feature-flagg», ingen
> lang paritets-beta. Vi **re-arkitekterer** — porter ikke spaghetti.
>
> **Dagens Electron-kode er adferds-spesifikasjon, ikke mal.** Vi gjenbruker
> _kunnskapen_ (herdede ffmpeg-argumenter, device-parsere, feilklassifisering,
> silence/watchdog-logikk) men _strukturen_ bygges ren i Rust.
>
> **Når godkjent:** denne planen flyttes inn i den nye appen som
> `docs/MIGRATION-TAURI2.md` og følges/krysses av fase for fase.

---

## 1. Mål & prinsipper

1. **Soliditet over hastighet til paritet.** Mål er en bedre app enn Electron-
   versjonen, ikke en 1:1-kopi. Vi fikser arkitektur-gjeld underveis.
2. **Native der det gir best kontroll.** Flytt ting til Rust når det gir mer
   robusthet enn webview/Node gjorde — ikke bare fordi vi må.
3. **Recorder-kjernen er en førsteklasses Rust-komponent fra tidlig**, ikke
   påklistret til slutt. Den er appens eksistensgrunn; den fortjener god design.
4. **Ren arkitektur:** domenelogikk (testbar, ren Rust) skilles fra Tauri-
   kommandolaget. Tynt kommandolag, tykk testbar kjerne.
5. **Typesikker kontrakt:** alle delte typer genereres med **ts-rs** (som søstrene).
6. **Test fra dag én:** Rust unit/integrasjon + frontend (vitest/RTL) + CI som
   signerer/bygger Mac+Win fra start. Maskinvare-tester manuelt for recorder/wake/stream.
7. **Maks gjenbruk av suite-presedens:** SundayEdit (ffmpeg-sidecar, signering,
   updater, whisper-rs, keyring), SundayStudio (cpal/hound/ebur128 Rust-audio).

---

## 2. Målarkitektur

| Lag                            | Electron i dag                                       | Tauri 2 mål                                                                        |
| ------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Skall                          | Electron + Chromium                                  | Tauri 2 (WKWebView/WebView2)                                                       |
| Backend                        | Node main (~75 filer, ad hoc)                        | **Rust**, ren domenekjerne + tynt kommandolag, tokio                               |
| Frontend                       | vanilla TS ~13k linjer                               | **React 19 + Tailwind v4** + TanStack Query + Zustand                              |
| Kontrakt                       | ipcMain (142) + `window.api` (116 invoke + 40 event) | `#[tauri::command]` + `emit`/`listen`, typer via **ts-rs**                         |
| ffmpeg                         | `ffmpeg-static` + child_process (31 spawn)           | **sidecar** `externalBin` + `tokio::process` (SundayEdit-mønster)                  |
| **Lyd-metering/VU**            | webview `getUserMedia` + Web Audio                   | **Rust `cpal`** → nivåer via event (som SundayStudio; fjerner webview-avhengighet) |
| Lagring                        | `electron-store` JSON                                | **SQLite via sqlx**                                                                |
| Hemmeligheter                  | `safeStorage`                                        | **`keyring`** (apple/windows native)                                               |
| Oppdatering                    | `electron-updater`                                   | **`tauri-plugin-updater`** (`latest.json`)                                         |
| Dialog/shell/clipboard/varsler | Electron-kjerne                                      | tauri-plugin-{dialog,opener,notification,clipboard}                                |
| Deep-link `sundayrec://`       | `setAsDefaultProtocolClient`                         | `tauri-plugin-deep-link`                                                           |
| Tray/meny                      | Electron `Tray`/`Menu`                               | Tauri tray + meny-API                                                              |
| `media://`                     | `protocol.handle`                                    | Tauri custom protocol (Rust Range)                                                 |
| Whisper                        | whisper-cli subprocess                               | **`whisper-rs`** (feature-gated)                                                   |
| NDI                            | `grandiose` `.node`                                  | **libndi via Rust FFI**                                                            |
| Wake/power                     | pmset/PowerShell + powerSaveBlocker/powerMonitor     | `std::process::Command` + IOKit/WinAPI FFI                                         |
| SMTP                           | nodemailer                                           | **`lettre`**                                                                       |

**Sentrale arkitektur-valg (bygg det riktig):**

- **VU/metering i Rust (cpal), ikke webview.** Mer robust, plattform-uavhengig,
  matcher SundayStudio. Webviewen slipper `getUserMedia`-avhengighet helt.
- **Video-preview = MJPEG-frames fra ffmpeg via event** (rene JPEG-bilder, uavhengig
  av webview-codec). Editor-avspilling av vilkårlige format: `media://` + ffmpeg-
  dekoding som fallback der WKWebView/WebView2 mangler codec (avklares i Fase 5-spike).
- **Domenekjerne som eget Rust-crate** (`sundayrec-core`) uten Tauri-avhengighet,
  så den er enhets-testbar og potensielt delbar i suiten senere.

**Repo:** Ny app i `sunday-suite/sundayrec` (samme layout som søstrene: `src/`
frontend, `src-tauri/` Rust). Electron-repoet beholdes som referanse til v1.0,
arkiveres så. Lokalt arbeid, ingen push før Richard sier ifra.

---

## 3. Faser (fundament → kjerne → bredde → release)

Hver fase: **Mål · Kilde å speile (adferd) · Rust/Tauri-mapping · Exit-kriterier · Risiko.**

### Fase 0 — Arkitektur-spikes + skall + fundament · ~3–4 uker

**Mål:** Etabler grunnmuren og avklar de to tekniske ukjente som STYRER design
(ikke som go/no-go, men for å velge riktig arkitektur).

- **Spike A — capture/metering:** bevis Rust-`cpal`-metering → React-VU via event,
  og ffmpeg→MJPEG-preview via event. Avgjør at vi IKKE trenger webview-getUserMedia.
- **Spike B — recorder-plumbing:** liten Rust-prototype av unified ffmpeg-capture
  (mac avfoundation `vid:aud` / win dshow 2×`-i` + aresample), stderr-parsing,
  stdin `'q'`, watchdog. Speil `unified-recorder.ts`, `recorder-utils.ts`.
- **Skall:** scaffold Tauri 2 + React 19 + Tailwind v4; `sundayrec-core` Rust-crate;
  ffmpeg-sidecar (kopier SundayEdits `fetch-ffmpeg.mjs` + `externalBin`); sqlx-schema;
  keyring; ts-rs-søm; logger; feilmodell; CI som signerer Mac + bygger Win + `latest.json`.
- **Exit:** tom app installerer + auto-oppdaterer signert; VU + kamera-preview vises
  drevet av Rust; én recorder-prototype tar opp 30 s synket klipp.

### Fase 1 — Domenefundament + enkle vertikale skiver · ~3–4 uker

**Mål:** Hele kjeden Rust-kommando → ts-rs → React-UI på lavrisiko-domener; ren
domene/kommando-separasjon etablert som mønster.

- Innstillinger (get/save/reset/export/import), historikk, filer/dialoger, i18n
  (port 7 språk til React-i18n). Speil `ipc/{settings,profile,history,files}.ts`,
  `store.ts`, `i18n.ts`.
- **Exit:** endre innstillinger + se historikk i Tauri-appen; mønsteret er bevist.

### Fase 2 — Enheter, preflight, diagnostikk, live preview/VU · ~3–4 uker

**Mål:** Alt som mater opptak.

- Device-enum + fuzzy-match (Rust, port parsere + `findBestDeviceMatch` fra
  `native-recorder.ts`), preflight, diagnostikk, cpal-VU + ffmpeg-MJPEG-preview i UI.
  Speil `diagnostics.ts`, `preflight.ts`, `video-preview.ts`, `audio/{vu,capture}.ts`.
- **Exit:** brukeren ser enheter, VU og kamera-preview; diagnose kjører grønt.

### Fase 3 — RECORDER-KJERNEN (bygg den solid) · ~8–12 uker

**Mål:** Beste mulige opptaks-kjerne i Rust — ikke en port, en bedre versjon.

- Unified capture (mac/win + aresample-drift), to-prosess-fallback, **watchdog +
  reconnect**, **preroll-buffer**, silence-watcher, MJPEG-preview, graceful stop
  (`'q'`), split-recording. Ren tilstandsmaskin i `sundayrec-core`.
- Speil adferd: `recorder.ts`, `native-recorder.ts`, `unified-recorder.ts`,
  `video-recorder.ts`, `preroll.ts`, `recorder-utils.ts`.
- **Test:** omfattende Rust unit-tester (port logikken i dagens 40 jest-filer der
  relevant) + **maskinvare-tester** (60–90 min, USB-frakobling, sleep/wake) på Mac+Win.
- **Exit:** stabil, synket opptaks-kjerne validert på ekte rigg.
- **Risiko:** høyest i prosjektet; vi tar den tidlig og bygger den ordentlig.

### Fase 4 — Editor-backend + UI · ~6–8 uker

probe/peaks/cuts/save/export/metadata/thumbnail/mastering/audio-analysis. Speil
`editor.ts`, `mastering.ts`, `audio-analysis.ts`, `thumbnail.ts`; React-port av
`editor-page.ts` + 17 `editor/`-undermoduler (canvas/Web Audio gjenbrukes).
Spike: webview-codec for editor-avspilling → ffmpeg-dekoding-fallback om nødvendig.
**Exit:** klippe, mastre, eksportere ende-til-ende.

### Fase 5 — Scheduler, wake/power, tray, livssyklus, varsler · ~4–5 uker

Cron i Rust (erstatt node-schedule), wake-scheduling (pmset/osascript/PowerShell/
schtasks/powercfg), power (IOKit/WinAPI), tray + meny, single-instance, deep-link
OAuth-callback, notifikasjoner. Speil `scheduler.ts`, `wake.ts`, `wake-verification.ts`,
`tray.ts`, `index.ts`. **Exit:** planlagt opptak vekker maskinen og starter på Mac+Win.

### Fase 6 — Cloud, OAuth, integrasjoner, whisper, mailer · ~5–7 uker

OAuth (Drive/YouTube/Gmail via deep-link/loopback), opplastingskøer, prep-episode,
review-queue, SundayEdit/Stage/Song/Plan-integrasjoner, **whisper-rs**, SMTP (**lettre**),
webhook. Speil `cloud/*`, `publish/*`, `prep-episode.ts`, `review-queue.ts`,
`integrations/*`, `whisper*.ts`, `mailer.ts`, `webhook.ts`.
**Exit:** koble Google, laste opp, transkribere, sende varsel.

### Fase 7 — Streaming + NDI + overlays · ~4–6 uker

RTMP-streamer, stream-keys (keyring), overlays (filter_complex-bygger), **NDI via
libndi FFI**. Speil `streamer.ts`, `stream-keys.ts`, `overlay.ts`, `ndi-receiver.ts`.
**Exit:** live-stream til YouTube med overlay; NDI-kilde fungerer.
**Risiko:** NDI FFI er vanskeligst — egen tidlig spike i denne fasen.

### Fase 8 — Full UI-paritet, polish, i18n, design-system · ~4–6 uker

Alle 20 sider + onboarding/kalender/søk i React, full i18n (7 språk),
tilgjengelighet, delte Tailwind-tokens med suiten. Hev kvalitet over Electron-UI.

### Fase 9 — Pakking + release v1.0 · ~2–3 uker

Signering/notarisering Mac + Win, updater, CI hardening, full Mac+Win-røyktest,
valgfri import av eksisterende test-innstillinger. Release v1.0 → arkiver Electron-repo.

---

## 4. Tverrgående standarder

- **Arkitektur:** `sundayrec-core` (ren domenekjerne, ingen Tauri) + `src-tauri`
  (tynt kommando/event-lag). Alt forretningskritisk er enhets-testbart uten GUI.
- **Typer:** ts-rs genererer delte typer; CI feiler hvis genererte typer er utdaterte.
- **Test:** Rust unit/integrasjon (høy dekning på recorder/scheduler/device/feil),
  frontend vitest/RTL, manuelle maskinvare-tester for recorder/wake/stream.
- **Observability:** strukturert logging fra start (tracing), diagnostikk-eksport.
- **Estimat:** total grov størrelsesorden **~9–13 måneder** fokusert 1-utvikler-
  arbeid (med AI), dominert av Fase 3 (recorder), 4/6/8 (editor/cloud/UI).

## 5. Risikoregister (topp)

| Risiko                             | Fase | Tiltak                                                                                                 |
| ---------------------------------- | ---- | ------------------------------------------------------------------------------------------------------ |
| Webview media (getUserMedia/codec) | 0/4  | **Designet bort:** VU i Rust (cpal), preview via MJPEG; editor-avspilling med ffmpeg-dekoding-fallback |
| Recorder-robusthet i Rust          | 0/3  | Tidlig spike + bygg solid + maskinvare-test på ekte rigg                                               |
| NDI libndi FFI                     | 7    | Tidlig spike i fasen; isoler bak trait så den kan stubbes                                              |
| OAuth redirect-schemes             | 6    | Gjenbruk dagens loopback-mønster; test per provider                                                    |
| Signering/notarisering             | 0    | Kopier SundayEdit/SundayStage release.yml + secrets                                                    |
| Scope (stor app)                   | alle | Vertikale skiver, ren kjerne, CI fra dag én                                                            |

## 6. Recorder-spike scope (Fase 0 Spike B → bygges ut i Fase 3)

Rust-prototype (tokio + `tokio::process::Command`) som beviser/etablerer:
unified ffmpeg-capture (mac `vid:aud` / win 2×`-i` + `aresample=async=1000:first_pts=0`),
sanntids stderr-parsing (`size=`-progress, `silence_start/_end`, feilklassifisering),
MJPEG-stdout SOI/EOI-parsing, graceful stop via stdin `'q'`, watchdog + reconnect,
device-enum + fuzzy-match. Adferds-kilde: `unified-recorder.ts`, `recorder-utils.ts`
(`classifyRecordingError`, `createSilenceWatcher`, `buildSilenceDetectFilter`),
`recorder.ts` (watchdog/reconnect), `native-recorder.ts` (device-parsere).
Maskinvare-matrise: Mac (Apple Silicon) + Win × {smoke 30 s, langt 60–90 min,
USB-frakobling, sleep→wake, graceful stop, device-enum}.

## 7. Definisjon av ferdig (v1.0)

- Alle funksjonsområder i paritet-sjekklista grønne på Mac+Win, kvalitet ≥ Electron.
- Recorder/wake/stream maskinvare-validert.
- Signert + notarisert + auto-oppdaterende på begge plattformer.
- Ren domenekjerne med god testdekning; ts-rs-kontrakt i CI.
- Electron-repo arkivert etter v1.0.
