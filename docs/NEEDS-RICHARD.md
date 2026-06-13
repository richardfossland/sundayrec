# Needs Richard — Electron-parity seams (PU-1…R7)

The pure decision logic for these features is ported into `sundayrec-core` and
fully unit-tested; the impure seams compile behind **default-off** cargo
features (`email`, `tray`, `publish`, `editor`, `whisper`, `streaming`, `ndi`,
`bridge`, `updater`) or are already wired (scheduler/wake). The items below need
a real account / desktop session / device / signing identity that the headless
gate cannot provide. None block the default build or the gate. The consolidated
"what only Richard can provide" checklist is at the bottom of this file.

## ⭐ Release blockers — current checklist (only Richard can do these)

A precise, up-to-date list of the account/key/identity work standing between the
code-complete state and a **signed, auto-updating, public release**. See
`docs/RELEASE-AUDIT.md` for the pipeline audit and `docs/DISTRIBUTION.md` /
`docs/GOOGLE-OAUTH-SETUP.md` for the step-by-step. Status is from the project
notes (2026-06-01); confirm before acting.

1. **GitHub Actions billing block** — CI (`ci.yml`) and the release build
   (`release.yml`) **cannot run** while the account's Actions billing/spending
   limit is blocked. This gates every other release step (the build itself runs
   on Actions). Fix payment / raise the spending limit, then re-run the release
   workflow on a tag. _(Local `tauri build` is the fallback while blocked — see
   RELEASE-AUDIT.md.)_

2. **Apple Developer ID signing — re-export the `.p12`.** Per the project notes
   the Desktop `.p12` on the Desktop has the **wrong password**; re-export the
   "Developer ID Application" cert from **Keychain Access** with a known password,
   then set the secrets: `APPLE_CERTIFICATE` (base64 of the `.p12`),
   `APPLE_CERTIFICATE_PASSWORD` (the new password), `APPLE_SIGNING_IDENTITY`
   (`Developer ID Application: … (784GN847G4)` — Team ID 784GN847G4 is on file).
   Plugs into `release.yml` env (lines 80–82). Without it the build is unsigned
   (Gatekeeper-blocked on download). See DISTRIBUTION.md "macOS code signing".

3. **Notarization credentials.** `notarytool` needs `APPLE_ID` (account email),
   `APPLE_PASSWORD`, and `APPLE_TEAM_ID` (`784GN847G4`). ⚠️ The
   **app-specific password was leaked in chat** — **revoke it** at
   appleid.apple.com → Sign-In and Security → App-Specific Passwords, **generate a
   new one**, and store it only as the `APPLE_PASSWORD` GitHub secret. Plugs into
   `release.yml` env (lines 83–85).

4. **Tauri updater — now wired in config; only the secrets remain.** _(updated:
   the `plugins.updater` block (pubkey + endpoints) is in `tauri.conf.json`,
   `includeUpdaterJson: true` is set in `release.yml`, and the keypair exists —
   key-id `4f08a2f48edd9a17`, backup `~/.tauri/sundayrec_updater.key`.)_ The only
   outstanding step is adding the `TAURI_SIGNING_PRIVATE_KEY` (+ `…_PASSWORD`)
   secrets (env already wired in `release.yml`). See `docs/RELEASE-CHECKLIST.md`.

5. **Google OAuth console client (Desktop app type).** Cloud connect/upload +
   the cloud-Gmail email path need a Google OAuth client of type **Desktop app**
   (a binary `client_id` is NOT the `.env` one — confirm the console client type
   and the redirect). Provide `SUNDAYREC_GOOGLE_CLIENT_ID` (+ optional secret) per
   `docs/GOOGLE-OAUTH-SETUP.md`. Not a build blocker, but blocks the cloud/email
   features at runtime.

The per-feature seam detail follows below; this checklist is the release-gating
subset.

## PU-1 — Email alerts (`--features email`)

- **A Gmail OAuth connection or SMTP credentials.** The Gmail path reuses the
  cloud OAuth refresh token (connect Gmail first); the SMTP path needs a host,
  port, user, and app-password. **(R7 update)** the `email*` Settings fields
  (`emailOnError`/`emailAddress`/`emailSmtp`/`emailSmtpPort`/`emailSmtpUser`) now
  exist in the typed model + the **Generelt → E-postvarsler** UI, and the
  `email_send_test` command takes the transport config. The SMTP **password** is
  intentionally NOT in the settings bag — it lives in the OS keychain via the
  `email` seam (mirrors the Electron `setSmtpPassword`); a keychain-write command
  for the SMTP password from the UI is the small remaining glue.
- **Deliverability check.** Confirm a real "✓ email works" message arrives and
  the throttle suppresses a 2nd identical alert within 10 min (smoke §8).

## PU-2 — Tray + deep links (`--features tray`)

- **A desktop session.** The native menubar/tray item and the `sundayrec://`
  scheme registration (`tauri-plugin-deep-link`) need a real GUI to verify.
  **(R7 update)** the tray is now actually **installed** in `setup()` under
  `--features tray`: `tray::install` builds the `TrayIcon` from the unit-tested
  core menu model, wires `on_menu_event` → `handle_menu_event` (Stop calls
  `RecorderEngine::stop()` directly; start/preflight/diagnostics/review emit
  `tray://action`; show/quit are in-process), and registers the deep-link plugin
  routing inbound URLs through `dispatch_deep_link`. Build proven with
  `cargo build -p sundayrec --features tray` + clippy `-D warnings`.
- **Tray icon assets.** The Electron app shipped `tray-idle/recording/error`
  PNGs (+ macOS `Template` + Windows dark variants) under `assets/`. **(R7)** the
  shell currently reuses the app's **default window icon** for the tray; the
  per-state idle/recording/error assets still need bundling + a swap on
  `TrayState` change (`sundayrec_core::tray::icon_for` already picks the base).
- **Scheme registration in `tauri.conf.json`** (`plugins.deep-link.desktop.schemes
= ["sundayrec"]`) + the macOS `Info.plist` `CFBundleURLTypes` entry are still
  needed for the OS to _deliver_ `sundayrec://` URLs to the running app (the
  `on_open_url` listener is wired; the scheme must be registered with the OS).

## R7 — Auto-update (`--features updater`)

- **A SIGNED release + an updater keypair.** The `updater` feature compiles the
  seam (`src-tauri/src/update/mod.rs`) + registers `tauri-plugin-updater`; the
  status model + dev-check guard + percent math + semver "is newer" decision are
  the unit-tested `sundayrec-core::update`. A **real** update needs:
  1. `npm run tauri signer generate -- -w ~/.tauri/sundayrec_updater.key`
     (do this ONCE; back the key up — losing it means users can't auto-update
     and need a manual reinstall with a new key).
  2. The **public** key in `tauri.conf.json` under `plugins.updater.pubkey`, and
     an `endpoints` array pointing at the `latest.json` the release CI publishes.
  3. The release CI secrets `TAURI_SIGNING_PRIVATE_KEY` (+ `…_PASSWORD`) and
     `includeUpdaterJson: true` — see docs/DISTRIBUTION.md "Auto-update signing".
- The feed fetch, signature verify, download and relaunch are NETWORK/GUI-
  UNVERIFIED — they only run in a release build against the signed feed
  (smoke §R7). A dev build short-circuits the check (no signed release exists).
- The `tauri.conf.json` does NOT yet carry the `plugins.updater` block (no
  pubkey/endpoints) — add it alongside the keypair so the release build resolves
  the feed. Until then the `updater` feature compiles + the panel works, but a
  real check has nowhere to point.

## PU-3 — Podcast RSS publish (`--features publish`)

- **A connected Drive + a public-share capable account.** The orchestration
  (write `podcast.xml`, upload via the existing resumable worker, create a
  public share URL, cache the feed URL) needs a real Drive connection and
  network. Only the XML builder (`sundayrec_core::feed`) is tested.
- A `publish` seam module + the share-URL helper on the Drive worker are the
  remaining glue (the Electron `createPublicShareUrl` / `uploadFile` path).

## PU-4 — OS wake-timers + scheduled launch (no feature flag)

- **A real Mac/Windows box.** The scheduler supervisor's wall-clock timing, the
  `pmset`/`osascript`/`powershell`/`powercfg` shell-outs, the admin/UAC prompts,
  and whether the machine _truly_ wakes from sleep are all HARDWARE-UNVERIFIED.
  The next-fire / catch-up / missed / wake-point decisions are unit-tested in
  `sundayrec_core::{schedule, wake}`; this is the "validated on a real rig" exit
  the migration tracks (smoke §11).
- **Missed-recording persistence** still waits on a `status`/`error` column on
  the `recording` table (see the `scheduler/mod.rs` honest-gaps note).

## PU-5 — Whisper transcription (`--features whisper`)

- **A C/C++ toolchain + CMake.** The `whisper` feature pulls `whisper-rs`, which
  compiles libwhisper from source. The default build + the CI gate carry no
  whisper dep; `whisper_transcribe` returns `feature_disabled` there. Only the
  `sundayrec-core::whisper` decisions (model registry, argv/thread heuristic,
  convert argv, progress/exit parse, JSON-sidecar normalise, chunk/merge,
  language map) are unit-tested.
- **A downloaded model + a real recording.** The model download (the registry
  has the URLs + SHAs; the download/SHA-verify itself is not yet wired — the
  Electron `downloadModel` redirect-follow + hash check is the remaining glue),
  the ffmpeg 16 kHz-mono conversion, and the inference are HARDWARE-UNVERIFIED
  (smoke §10b). A whisper-cli sidecar path (instead of the `whisper-rs`
  in-process binding) could be offered as an alternative — the argv builder
  already matches the Electron `whisper-cli` invocation.

## PU-6 — Episode prep + review queue + Stage import (no feature flag)

- **The audio-analysis stack.** `prep_build_episode` assembles an `EpisodePrep`
  from analysis segments it is GIVEN — the ffmpeg/FFT `audio-analysis.ts` that
  produces those segments is NOT ported yet, so the caller (or a later analysis
  seam) must supply them. The sermon-detection + attention-reason + status
  decisions ARE the unit-tested core.
- **Reminder dispatch.** `review_process_reminders` returns the actions the
  scheduler should fire (notify/email/webhook/auto-discard) as a decision; the
  actual notification dispatch + the auto-discard history note should be wired to
  the existing PU-1 email seam + the scheduler's native notifications. The queue
  is persisted as a JSON blob under the `reviewQueue` settings key (mirrors the
  Electron `electron-store` shape) so no schema migration is needed.
- **Sidecar writes.** `stage_import_manifest` returns the mapped chapters +
  `ServiceLink`; writing them into the recording's `.meta.json` + `.service.json`
  sidecars (the Electron `applyStageManifest` fs step) is the remaining glue.

## R1 — Non-destructive editor (`--features editor`)

- **A real recording + a smoke run.** The cut/keep planning, the audio/video
  filter graphs, the codec/output-path/chapter decisions, the EBU R128
  loudnorm measure/apply chains + JSON parse, and the VAD/sermon classifier are
  all unit-tested in `sundayrec-core::{editor, mastering, audio_analysis}`. The
  I/O seam (`src-tauri/src/editor`) spawns the ffmpeg/ffprobe sidecar with that
  argv (load / peaks / segments / mastering-analyze / export). NO new native dep
  (ffmpeg is a sidecar; WAV/PCM parsed by hand). All five runs are
  HARDWARE-UNVERIFIED — they need real media (smoke §12). Build proven to
  compile with `cargo build -p sundayrec --features editor`.
- **Deferred to a later editor phase (parity gaps, not bugs):**
  - **Cut-region timeline UI.** The R1 panel exports the _whole_ file
    (`cutRegions: []`) — it proves the full IPC surface end-to-end. The
    drag-to-mark cut UI + waveform-overlaid timeline (the Electron
    `renderer/pages/editor/*`) is the renderer work for the next phase; the
    backend already accepts `cutRegions` and the core plans the keeps.
  - **Intro/outro + chapter metadata on export.** The core builds the
    intro/outro concat graph + the `;FFMETADATA1` chapter sidecar
    (`audio_export_filter_complex(has_intro, has_outro)`, `ffmetadata`,
    `metadata_args`), but the R1 `EditorExportRequest` doesn't yet carry those
    fields — wire them through when the editor UI surfaces intro/outro pickers +
    a chapter editor.
  - **Replace-mode + atomic swap.** R1 exports a new `*_redigert.<fmt>` file
    only. The Electron `saveEdited`/`safeReplaceFile` in-place replace (with the
    `.__editor_tmp`/`.__editor_bak` crash-recovery sweep) + the FORCE_WAV
    replace refusal (`resolve_save_ext` is already tested in core) is the next
    increment.
  - **Export progress events + cancel.** The Electron flow streamed `time=`
    progress + a `cancelExport(jobId)`. The seam currently `wait_with_output()`s;
    streaming progress to a Tauri event + a cancel handle is glue once the UI
    shows a progress bar (`export_timeout_ms` is already the tested kill-timer).

## Bridge Integration #2 — Live cue bridge (`--features bridge`)

- **A live Supabase project + SundayStage publishing.** The Rec side SUBSCRIBES
  to `church:{churchId}:service:{serviceId}` and folds inbound `LiveEvent`s into
  chapter markers + live/ended state. The channel-name + the `LiveEvent` union +
  the `apply_event` fold (with monotonic-`seq` gap/replay handling) are
  unit-tested in `sundayrec-core::integrations::live_bridge`, and the renderer
  can drive the mapping with `live_bridge_map_event` (no feature). The native
  WebSocket subscribe (`bridge_live::subscribe`, behind `--features bridge`) is
  INFRA-UNVERIFIED — the Phoenix handshake/`phx_join`/broadcast decode need a
  live backend (smoke §10c).
- **Emit + persist glue.** The subscribe loop currently logs each folded
  `BridgeEffect`; wiring `ChapterAdded` into the running recording's metadata +
  emitting a Tauri event for the UI is the remaining glue. The Supabase URL +
  anon key also need to flow from settings (the integration `connection` config).

## R3 — Live streaming (`--features streaming`)

- **A real camera + a real RTMP endpoint + a stream key.** The `streaming`
  feature compiles the ffmpeg spawn seam (`src-tauri/src/streaming/mod.rs`)
  in/out — NO new native dep (ffmpeg is a sidecar). The default build + the CI
  gate carry no streaming path; `stream_start`/`stream_stop` return
  `feature_disabled` there. Only the `sundayrec-core::{streaming,overlay}`
  decisions (the multi-destination `tee` muxer argv with `onfail=ignore`, the
  libx264/aac encode + keyframe-every-2s GOP + bitrate/bufsize math, the
  platform audio-map, the optional local-MP4 branch, the 0.5fps preview, the
  lower-third image/drawtext `filter_complex`, the key/URL validation, the
  key-redacted loggable copy) are unit-tested.
- **Auto-recovery + live stats are NOT yet ported.** The Electron `streamer.ts`
  restarted ffmpeg up to 3× on an unexpected crash (USB drop / brief RTMP
  disconnect over a 90-min sermon) and parsed `frame=…fps=…bitrate=…` from
  stderr at ~1 Hz to drive the UI stats + per-destination `connecting/live/
failed` state. The R3 seam spawns + kills cleanly and reports `active`; wiring
  the stderr-parse → `StreamStatus` updates (emit a `streaming://stats` event)
  and the crash auto-restart loop is the remaining glue once the panel shows a
  live stats row. The watchdog/restart _decisions_ should be lifted into the
  core first (mirrors the recorder's reconnect policy), then wired here.
- **`alsoRecord` history row.** The "Start direktesending + opptak" local MP4 is
  built into the argv (the 3-way split branch), but registering the finished
  file in recording history (the Electron `registerAlsoRecordInHistory` + the
  MP4-duration probe + the 100 KB skeleton guard) is not yet wired.
- **The stream-keys live in the OS keychain** (per-destination, namespaced
  `stream.key.<id>` via `crate::secrets`), never a plaintext file — confirm the
  keychain round-trips on the target machine (the tolerant test skips when no
  keychain is reachable).

## R3 NDI — receiver (`--features ndi`) — **SDK NOT BUNDLED**

- **The NDI SDK runtime + a native FFI binding + an NDI source on the LAN.** The
  `ndi` feature compiles a **STUB** seam (`src-tauri/src/ndi/mod.rs`):
  `list_sources` returns empty and `start_receiver` returns
  `ndi_not_bundled: NDI SDK not bundled — see docs/NEEDS-RICHARD.md`. The
  default build returns `feature_disabled`. NO native NDI dep is added (none is
  present in this environment).
- **What's already done (pure + tested).** `sundayrec-core::ndi` has the
  discovered-source model, the delivered-FourCC → ffmpeg-pixfmt selection
  (`UYVY`/`BGRA`/`BGRX` → `uyvy422`/`bgra`, falling back to the alpha request),
  the `-f rawvideo -pix_fmt … -s WxH -framerate … -i tcp://127.0.0.1:<port>`
  input-arg builder, and the saved-source-name matcher. The `streaming` seam
  already knows how to splice an NDI overlay's input args + frame size into the
  pipeline once a receiver hands back an `NdiReceiverInfo`.
- **The real implementation (needs Richard + a rig + the SDK):** vendor the NDI
  SDK (the runtime `.dylib`/`.dll` + headers) and add an FFI crate (the Electron
  app used the `grandiose` Node binding; the Rust equivalent is a thin FFI over
  `NDIlib_find_*` + `NDIlib_recv_*`). Then implement, per the Electron
  `ndi-receiver.ts` architecture: an mDNS-style `find` discovery window
  (~2 s), a receiver that pulls the first frame to resolve `WxH`+FourCC, an
  ephemeral **loopback TCP server** (`127.0.0.1:0`) that serves the raw frame
  bytes (one client = the streamer's ffmpeg, back-pressured by the TCP window,
  late frames dropped), and a clean `stop()` racing a 2 s timeout
  (`RecorderTimeouts::NDI_STOP_TIMEOUT_MS`) so a libndi deadlock can't block
  stream-stop. Bundle the SDK in `tauri.conf.json` (`externalBin`/resources) the
  way the Electron app `asarUnpack`-ed `vendor/grandiose`.

## P6 — Transcript search backend wiring (no feature flag)

The transcript search **logic** is pure + gate-tested
(`src/features/search/searchIndex.ts`: build-index / substring-scan / context /
group / stats, 13 tests). What remains is the thin glue Richard's rig will need
to make it live:

- **A `transcript_list_all` command** (mirrors the Electron
  `window.api.transcriptListAll`): enumerate every `<name>.transcript.json`
  sidecar in the known recording folders and return `{ filePath, transcript }`
  tuples for `buildIndex` to consume. The sidecar read/parse path already exists
  in the editor seam; this is an aggregation over the save folder.
- **A search panel + a `search` view** in the shell: the panel feeds the IPC
  result to `searchTranscripts`, renders the grouped hits, and on click hands the
  file + seek-time to the editor (the Electron `openEditorWithFile(fp, atSec)`
  contract). Pure search is done; only the IPC list command + the render/route
  are outstanding (GUI-deferred; smoke §6b).

No new account, key, or device is required for this — it is in-repo glue, listed
here so the search feature is not assumed fully wired end-to-end.

---

## Summary — what only Richard can provide

The code is feature-complete and gate-green; everything below needs an account,
a key, a signing identity, or a physical rig that the headless gate cannot have.
None of it blocks the default build or the gate.

### A real recording/streaming rig (HARDWARE-UNVERIFIED)

- **Record** (smoke §3–§6): a Mac/Windows box with a real mic + camera; prove
  the 30 s capture → history row → reveal-in-folder path, and the OS mic/camera
  permission prompts. Reconnect/split/preroll/two-process-fallback paths are
  wired but unproven on a device.
- **Stream** (`--features streaming`, smoke §R3): a real camera + a real RTMP
  endpoint + a stream key; auto-recovery + live stats are still glue.
- **Whisper** (`--features whisper`, smoke §10b): a C/C++ toolchain + CMake, a
  downloaded model (download/SHA-verify glue still pending), and a real recording.
- **Cloud upload** (smoke §7): a connected Google Drive + network — the resumable
  worker (PUTs, keychain token read, chunk math) is NETWORK-UNVERIFIED.
- **OS wake-timers** (smoke §11): a real box for the `pmset`/`schtasks`/`powercfg`
  shell-outs + admin/UAC prompts + a true sleep/wake cycle.
- **NDI** (`--features ndi`): the NDI SDK runtime + an FFI binding + a LAN NDI
  source — the seam is a deliberate STUB until the SDK is vendored (see above).

### Keys & secrets

- **Google OAuth client** (Drive/YouTube/Gmail + cloud-Gmail email path):
  `SUNDAYREC_GOOGLE_CLIENT_ID` (+ optional secret) — see
  docs/GOOGLE-OAUTH-SETUP.md. A binary `client_id` is NOT the same as the `.env`
  one; confirm the console client is a **Desktop app** type.
- **SMTP credentials** (`--features email`, SMTP path): host/port/user +
  app-password. The password is stored in the OS keychain, never the settings
  bag; the host/port/user now have a UI (R7).
- **Anthropic API key** (`ANTHROPIC_API_KEY`): NOT currently consumed by
  SundayRec — there is no LLM seam in this app (the AI rerank/translate work
  lives in SundaySong). Listed here only so it isn't assumed to be wired; if a
  future SundayRec feature wants Claude, follow the `getEmbedder()`/`getLlmClient()`
  fetch-seam pattern from the suite (free tier works without a key).

### Signing, notarization & auto-update

- **Apple Developer ID + notarization** (macOS release): the Developer ID
  Application cert (`APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` /
  `APPLE_SIGNING_IDENTITY`) + an App-Store-Connect API key or
  `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` for `notarytool`. Without these the
  release CI builds an unsigned `.app`/`.dmg` (Gatekeeper-blocked on download).
- **Windows code-signing cert** (Windows release): for a non-SmartScreen-warned
  installer.
- **Updater keypair** (`--features updater`, R7): `~/.tauri/sundayrec_updater.key`
  (private, backed up) + the public key in `tauri.conf.json` `plugins.updater`
  - the `TAURI_SIGNING_PRIVATE_KEY` CI secret + `includeUpdaterJson: true`. See
    the R7 section above and docs/DISTRIBUTION.md "Auto-update signing".
- All of these are **account/secret/identity** work, NOT code — the release
  pipeline (`release.yml`, updater plugin, signing hooks) is wired to consume
  them the moment they're provided.

## Settings-sync + IPC-seam audit (natt 2026-06-05)

Etter wake-from-sleep-funnet (merget i PR #2) gjorde jeg en systematisk audit av
(a) hvilke `Settings`-felt backend-konsumentene faktisk leser vs. hva
`syncBackendRecordingSettings` (api-shim → `settings_save`) sender, og (b) hele
`call()`/`invoke()`-seamen i `legacy/renderer/api-shim.ts` mot Rust-signaturene.
Bakgrunn: backend-sqlite får KUN det kuraterte opptaks-subsettet; alt utenfor det
re-defaultes av `#[serde(default)]` ved HVER lagring.

**FIKSET (gren `feat/night-settings-sync`, upushet — vent på review):**

- **`filenamePattern` nådde aldri recorderen.** `scheduler::build_opts` bruker
  `settings.filename_pattern` til opptaks-filnavnet, men feltet manglet i det
  kuraterte subsettet → re-defaultet til `date` ved hver `saveSettings`. En
  bruker som valgte `church`/`plain`/`datetime` fikk hvert opptak navngitt med
  `date`-mønster. Lagt til (whitelistet, så en korrupt localStorage-verdi ikke
  feiler HELE `settings_save`). **Rigg-sjekk:** velg et ikke-`date`-mønster, ta
  opp → filnavnet skal følge valget.

**ÅPNE SPØRSMÅL (krever din intensjon — bevisst IKKE rørt):**

- **Sample-rate-valget i UI er frakoblet faktisk oppførsel.** UI-en lar deg velge
  44.1/48/96 kHz og lagrer `sampleRate: number`, men (1) hoved-recorderen bruker
  `sample_rate_mode`-enumet (`resolved_sample_rate`) som UI-en aldri setter →
  alltid `Auto`/native, og (2) pre-roll bruker det gamle `sample_rate`-feltet som
  ikke synkes → alltid 48000. Native/Auto er bevisst valgt for å unngå
  resample-hakking, så å tvinge valget kan forringe lyd. **Spørsmål:** skal
  UI-valget faktisk styre rate (map `sampleRate` → `sample_rate_mode` i synken),
  eller skal vi fjerne velgeren og alltid kjøre native? Jeg gjør ingen av delene
  uten svar.

- **`stream_start` kan aldri lykkes slik den er wiret** (kun relevant i et
  `--features streaming`-bygg; default-bygget returnerer `feature_disabled`).
  Frontend sender `{resolution, framerate, videoBitrateKbps, destinations,
alsoRecord}`, men Rust-kommandoen krever i tillegg `videoToken: String`,
  `snapshotPath: String`, `overlays: Vec<OverlayConfig>` (alle påkrevd) og venter
  `alsoRecordPath`, ikke `alsoRecord`. Disse er capture-kilde-tokens (samme
  enhets-oppløsnings-maskineri som opptakeren) + overlay-config — kan ikke wires
  riktig «blindt» uten en RTMP-rigg å verifisere mot. **Streaming er fortsatt et
  rigg-only / ufullført domene** (som dokumentert ellers i denne fila); jeg lot
  det stå framfor å sende uverifiserbar kode. Resten av seamen (~60 kommandoer)
  ble verifisert KORREKT.

**IKKE en bug (avklart):** e-post/webhook/cloud/integrasjoner leser ikke-kuraterte
felt på backend, men frontend-metodene deres er bevisste no-op-stubs i
`api-shim.ts` → backend drives aldri av dem. Kurert-subset-tilnærmingen er
konsistent med at disse domenene er stubbet.
