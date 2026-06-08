# SundayRec — Smoke Test Runbook

A hands-on, hardware-in-the-loop checklist for proving that the Tauri rebuild
actually records. Everything below the line **cannot** be exercised in the
headless CI gate — it needs a real display, microphone, and camera. This doc is
the bridge from "compiles + unit-tests pass" to "validated on a real rig".

> Legend: **[HW]** = HARDWARE-UNVERIFIED in code — never run against a device in
> the gate, only here. **[NET]** = needs network + a Google OAuth client.

---

## 0. Prerequisites

| Tool      | Version            | Check             |
| --------- | ------------------ | ----------------- |
| Node.js   | 20 LTS or newer    | `node --version`  |
| Rust      | stable (1.77+)     | `rustc --version` |
| Xcode CLT | (macOS, for build) | `xcode-select -p` |

ffmpeg/ffprobe are **not** installed system-wide — they are fetched as bundled
sidecars by `scripts/fetch-ffmpeg.mjs` (the `predev`/`pretauri` npm hooks run it
automatically). To fetch them manually:

```bash
npm install            # pulls ffmpeg-static + @ffprobe-installer/ffprobe
npm run ffmpeg         # copies them to src-tauri/binaries/<name>-<host-triple>
ls src-tauri/binaries  # expect ffmpeg-… and ffprobe-… for your host triple
```

The binaries are git-ignored (`.gitignore` → `src-tauri/binaries`) and re-fetched
per machine/platform; the recorder + MJPEG preview resolve them by host triple at
runtime (`SUNDAYREC_TARGET_TRIPLE`).

### macOS privacy permissions (REQUIRED — first-capture blocker)

`src-tauri/Info.plist` ships `NSMicrophoneUsageDescription` +
`NSCameraUsageDescription`. Tauri 2 merges this into the dev app, so the first
mic/camera access triggers the normal macOS consent prompt. **Click Allow.** If
you ever denied it, re-enable under _System Settings → Privacy & Security →
Microphone / Camera → SundayRec_ and relaunch. Without these strings macOS kills
the app at capture time with no error — that is the symptom to watch for.

---

## 1. Pre-gate (headless, do this first)

```bash
npm run check          # lint + typecheck + vitest + clippy + cargo test
cargo build            # debug build of the Tauri binary
npm run build          # tsc + vite frontend build
```

All four must be green before a smoke test is meaningful. As of this runbook the
gate is green: **918 Rust tests** (687 core + 231 src-tauri) + **296 vitest** +
clippy `-D warnings`. Every default-off feature also compiles in isolation —
`cargo build -p sundayrec --features <flag>` for `email`/`tray`/`publish`/
`editor`/`streaming`/`ndi`/`bridge`/`updater` (the `whisper` C++ build is the one
exception, verified by inspection).

---

## 2. Launch [HW]

```bash
npm run tauri dev
```

`predev` fetches ffmpeg if needed; vite serves on the fixed port **1420**
(`strictPort`); Tauri opens the window titled "SundayRec". The header should read
"backend OK" with the version/platform — that proves the Rust ↔ React bridge and
that `setup()` opened the database without panicking.

**Where logs go:** the backend uses `tracing` to **stderr** of the terminal
running `tauri dev`. Bump verbosity with the env filter:

```bash
RUST_LOG=debug npm run tauri dev          # everything
RUST_LOG=sundayrec=debug npm run tauri dev # just our crates
```

Expect at boot: `SundayRec backend ready (db at …/sundayrec.sqlite)` and (with no
Google client configured) `cloud upload worker idle: Google OAuth client not
configured`. The cloud worker idling cleanly with no config is itself a thing to
verify here — there should be **no** repeated cloud log spam.

---

## 3. Pick an input device → VU meter moves [HW]

1. Open the device picker.
2. Choose a microphone from the audio input list (enumerated via ffmpeg
   `avfoundation` on macOS).
   - **Expected:** the list is non-empty and names match your real inputs.
3. Speak / tap the mic.
   - **Expected:** the VU meter (cpal-driven, per channel) moves in real time. A
     dead-flat meter while you speak = the OS denied mic access (see §0) or the
     wrong device is selected.

---

## 4. Camera preview [HW]

1. Select a camera/video device.
   - **Expected:** the MJPEG preview (ffmpeg avfoundation → base64 frames over the
     Tauri event channel) shows live video within a second or two.
2. No preview + the app still alive = check camera permission (§0). App vanishes
   = permission string missing/denied and the OS killed it.

---

## 5. Record 30 s → stop → history row [HW]

1. Start a recording with mic (+ camera if testing A/V).
   - **Expected:** status flips to recording; with `RUST_LOG=debug` you see ffmpeg
     `size=` progress lines being parsed.
2. Let it run ~30 seconds, talking so the silence-watcher does **not** fire.
3. Stop the recording.
   - **Expected:** a graceful stop (a `q` is sent to ffmpeg's stdin, not a kill),
     and a **new history row** appears with a plausible **duration (~30 s)** and
     **file size (> 0)**.
4. Confirm the file exists on disk at the path shown.

> [HW] Reconnect/split/preroll fusion paths are wired but unproven on a device.
> A basic single-segment 30 s capture is the smoke-test target here.

---

## 6. Add a note → reveal in folder [HW]

1. On the new history row, add a note and save.
   - **Expected:** the note persists (it round-trips through `recording_update_note`
     into SQLite; relaunching the app shows it again).
2. Use "reveal in folder" / open.
   - **Expected:** the OS file manager opens at the recording (via the `opener`
     plugin — capability `opener:allow-open-path` is granted).

---

## 6b. History search + transcript search [HW]

The filter/grouping/stats math and the substring search are pure and
gate-tested (`historyFilter` / `searchIndex`); what a rig confirms is that the
search box wiring and the IPC sidecar-load behave on real data.

1. Record two or three sessions (repeat §5) so History has several rows.
2. In **History**, type into the search box.
   - **Expected:** the list filters live by filename, date, or note text
     (case-insensitive); the stats line ("N opptak · Xt Ym totalt · sist …")
     stays computed over the **full** history, not the filtered subset (Electron
     `home.ts` parity). A query that matches nothing shows a no-hits message
     (`search.noHits`), distinct from the genuinely-empty state.
3. If you also ran §10b (Whisper), open the transcript search surface and search
   for a word you spoke.
   - **Expected:** hits group by recording, newest-first, each with a ~60-char
     before/match/after context window; clicking a hit seeks the editor to that
     segment's start time. (The index build + sidecar load is the only
     GUI-deferred part — `searchIndex` itself is gate-tested.)

---

## 7. (Optional) Cloud connect + upload [HW][NET]

Requires a Google Desktop OAuth client — see
[`docs/GOOGLE-OAUTH-SETUP.md`](GOOGLE-OAUTH-SETUP.md) to create one and set
`SUNDAYREC_GOOGLE_CLIENT_ID` (+ optional `SUNDAYREC_GOOGLE_CLIENT_SECRET`) before
launching:

```bash
export SUNDAYREC_GOOGLE_CLIENT_ID="…apps.googleusercontent.com"
export SUNDAYREC_GOOGLE_CLIENT_SECRET="…"   # optional for Desktop clients
npm run tauri dev
```

1. Trigger **cloud connect** (Drive).
   - **Expected:** the system browser opens Google's consent screen; after you
     approve, the loopback redirect (`http://127.0.0.1:<ephemeral-port>`)
     completes and the service shows as connected. A "client not configured"
     error here means the env var didn't reach the process.
2. **Enqueue a backup** of the recording from §5, then watch the upload.
   - **Expected:** the queue entry transitions through uploading → done; the file
     appears in Google Drive (`drive.file` scope = only files this app created).
   - With `RUST_LOG=sundayrec=debug` the worker logs each resumable chunk.

> [NET] The whole cloud worker (`reqwest` PUTs, keychain token read, chunk reads)
> is NETWORK-UNVERIFIED — only the decision logic (queue ordering, chunk math,
> token/error classification) is unit-tested. This step is the first real
> exercise of the wire path.

---

## 8. (Optional) Email alerts [NET] — `--features email`

The error/test mailer is behind the **default-off `email`** cargo feature, so
the shipping build + the CI gate carry no SMTP/Gmail dep. The localized
templates (7 langs), the throttle/dedup gate, and the RFC 2822/base64url message
assembly are unit-tested in `sundayrec-core::email`; the **send** is
NETWORK-UNVERIFIED. Build with the feature to exercise it:

```bash
cargo build -p sundayrec --features email
npm run tauri dev -- --features email   # drive the "E-postvarsler" disclosure
# Gmail path reuses the cloud OAuth token (connect Gmail first, §7-style);
# SMTP path needs a host/port/credentials.
```

The **E-postvarsler** panel (R5) drives this. It reads `email_status` up-front
(works in every build) to show whether this binary has the `email` feature and
whether Gmail is already connected, picks the transport (Gmail no-config / SMTP
host·port·user·pass·from), and fires `email_send_test` with the chosen language.
In the **default build** (no `--features email`) `email_send_test` returns
`feature_disabled` and the panel shows a calm "ikke bygd inn" hint (GUI-UNVERIFIED;
the SMTP password is never persisted — it travels with the request and is dropped).

1. **Test message** via the Gmail path (Gmail OAuth connected). Pick "Gmail",
   enter a recipient, **Send testvarsel**.
   - **Expected:** a "✓ SundayRec — email works" message arrives; the raw
     message was base64url-encoded and POSTed to `gmail.googleapis.com`.
2. **Error alert throttle.** Trigger two identical recording errors within
   10 minutes.
   - **Expected:** only the first mails; the second is suppressed by the core
     `AlertGate` (10-min window per `(recipient, message)`).
3. **SMTP fallback.** Configure an SMTP host (587 STARTTLS or 465 implicit TLS)
   and send a test.
   - **Expected:** `lettre` connects + delivers; HTML + plaintext parts both
     present in the received mail.

> [NET] The Gmail POST + the SMTP handshake are NETWORK-UNVERIFIED — wired and
> compiling under `--features email`, never run against a real account/server in
> the gate.

---

## 9. (Optional) Menubar tray + deep links [GUI] — `--features tray`

The tray menu-model (localized items, actions, tooltip, icon precedence) and the
inbound `sundayrec://` deep-link parser are unit-tested in
`sundayrec-core::{tray, link}`; the native menubar item + scheme registration
are **GUI-UNVERIFIED** behind the default-off `tray` feature.

As of **R7** the tray is actually **installed** in `setup()` under
`--features tray` (`tray::install` builds the `TrayIcon` from the core menu
model, wires `on_menu_event` → `handle_menu_event`, and registers the
`tauri-plugin-deep-link` scheme handler that routes inbound URLs through
`tray::dispatch_deep_link`). The menu **start/stop/show** actions are wired to
the backend: **Stop** calls `RecorderEngine::stop()` directly; **start** /
preflight / diagnostics / review-queue emit `tray://action` for the renderer to
turn into the matching `invoke(...)`; **show**/**quit** are handled in-process.

```bash
cargo build -p sundayrec --features tray
npm run tauri dev -- --features tray
```

1. Launch; confirm a SundayRec item appears in the macOS menubar / Windows tray.
   - **Expected:** the menu shows status → open → start/stop → folder → check
     system → diagnostics → quit, in the UI language. A review-queue callout
     appears only when episodes await review.
2. Click **Stopp opptak** while recording.
   - **Expected:** the recording stops (the `RecorderEngine::stop()` path) and a
     new history row appears, even with the window unfocused.
3. While recording, the menu swaps "Start" → "Stop" and the icon turns red.
4. Open a `sundayrec://import?path=…` URL from the OS.
   - **Expected:** the running instance receives it (`on_open_url`) and
     `dispatch_deep_link` brings the window forward + emits `deeplink://import`.

> [GUI] The `tauri::tray` item install, the menu paint, and the
> `tauri-plugin-deep-link` scheme delivery are GUI-UNVERIFIED — they need a real
> desktop session. The dedicated tray icon assets aren't bundled yet (the app's
> default window icon is reused) — see docs/NEEDS-RICHARD.md PU-2.

---

## 10. (Optional) Podcast RSS publish [NET] — `--features publish`

The RSS 2.0 + iTunes XML builder is unit-tested in `sundayrec-core::feed`; the
write-to-disk + upload-to-Drive + share orchestration is NETWORK-UNVERIFIED
behind the default-off `publish` feature.

```bash
cargo build -p sundayrec --features publish
```

1. After a cloud upload (§7), enable podcast publishing.
   - **Expected:** a `podcast.xml` is written next to the save folder, uploaded
     to Drive, made public, and the feed URL is cached for the UI to show
     ("submit this URL to Spotify/Apple").

The **Publisering** panel (R6) drives this: `publish_feed_status` (every build)
reports the candidate episode count + whether `--features publish` is compiled
in; **Forhåndsvis feed** renders the feed XML in memory from the recording
history + the channel metadata from settings (`publish_feed_preview`, pure
shaping — every build); **Generer feed nå** (`publish_generate_feed`) writes
`<saveFolder>/podcast.xml` behind the feature (NETWORK-UNVERIFIED; the Drive
upload + share-URL glue is still deferred — see docs/NEEDS-RICHARD.md PU-3).

```bash
npm run tauri dev -- --features publish   # drive the Publisering disclosure
```

2. (default build) Open **Publisering**, click **Generer feed nå**.
   - **Expected:** a calm "ikke bygd inn i denne versjonen" hint (GUI-UNVERIFIED).
     **Forhåndsvis feed** still renders the XML.
3. (`--features publish`, with a save folder set) **Generer feed nå**.
   - **Expected:** `podcast.xml` appears in the save folder and its path is shown.
     Without a save folder a `no_config` hint is shown.

> [NET] File/HTTP publish is NETWORK-UNVERIFIED — only the XML shaping is tested;
> the per-recording share URLs aren't persisted yet so the preview uses the local
> file path as a placeholder `audio_url` (see `commands::publish` + NEEDS-RICHARD).

---

## 10b. (Optional) Whisper transcription [HW] — `--features whisper`

The model registry (id/url/size/SHA/quality), the whisper-cli/whisper-rs argv +
thread heuristic, the ffmpeg 16 kHz-mono convert argv, the progress/exit parse,
the JSON-sidecar → `TranscriptData` normalise, and the long-recording
chunk-plan + segment-merge are all unit-tested in `sundayrec-core::whisper`. The
model download (SHA-verified), the ffmpeg conversion, and the actual inference
are **HARDWARE-UNVERIFIED** behind the default-off `whisper` feature (pulls
`whisper-rs`, which compiles libwhisper from C/C++ source — needs CMake + a
C/C++ toolchain).

```bash
cargo build -p sundayrec --features whisper   # CMake builds libwhisper
```

1. `whisper_list_models` / `whisper_model_status` / `whisper_delete_model` /
   `whisper_cancel_download` work in **any** build (the registry, on-disk size
   check, fs delete, and the cancel signal are pure/fs). Download a model into
   the app-data `whisper-models/` dir with `whisper_download_model`.
   - **Expected:** `whisper://model-progress` events stream `{ id,
bytesDownloaded, bytesTotal, fraction }` (the shaping is the unit-tested
     `download_progress`); a second download for the same id while one is in
     flight returns `already_downloading`; `whisper_cancel_download` aborts the
     stream and removes the `.partial`; on completion the SHA-256 is verified
     against the registry (`verify_model_hash`) before the `.bin` is promoted.
     `feature_disabled` means the build lacks `--features whisper`.
     // NETWORK-UNVERIFIED (the HTTPS stream + write are wired but unproven).
2. With the feature ON, run `whisper_transcribe` on a short recording.
   - **Expected:** ffmpeg converts to 16 kHz mono, whisper-rs runs, and a
     `TranscriptData` (seconds-based segments) comes back. A `feature_disabled`
     validation error means the build doesn't have `--features whisper`.

The **Transkribering** panel (R5) drives this: pick a recording (from history) +
a model + a language, **Transkriber**, then the segments render and **SRT** /
**VTT** / **TXT** buttons save the transcript via `whisper_export_transcript`
(native save dialog). The model registry + the export render work in **every**
build; only `whisper_transcribe` needs the feature. In the default build the
panel shows a calm "ikke bygd inn" hint after a transcribe attempt (GUI-UNVERIFIED).

```bash
npm run tauri dev -- --features whisper   # drive the Transkribering disclosure
```

3. (any build) **Export.** After a transcript exists, click SRT/VTT/TXT.
   - **Expected:** a file appears at the chosen path. SRT uses `HH:MM:SS,mmm`
     numbered cues; VTT has a `WEBVTT` header + `.` ms separator; TXT is one
     segment per line. The rendering is the pure
     `sundayrec-core::whisper::export_transcript` (unit-tested).

> [HW] The C/C++ build, the model download, and inference are unproven in the
> gate — only the `sundayrec-core::whisper` decisions are unit-tested. The
> export render + the file write are pure/GUI-UNVERIFIED (no feature needed).

---

## 10c. (Optional) Live cue bridge [INFRA] — `--features bridge`

Bridge Integration #2: SundayRec SUBSCRIBES to SundayStage's Supabase Realtime
cue channel `church:{churchId}:service:{serviceId}` and folds each inbound
`LiveEvent` (cue.advanced / now_playing / service.live / service.ended) into
chapter markers + live/ended state. The channel-name derivation, the `LiveEvent`
shape, the monotonic-`seq` gap/replay handling, and the event→chapter fold are
unit-tested in `sundayrec-core::integrations::live_bridge`. The renderer can
exercise the mapping with **no feature** via `live_bridge_map_event` (folds one
raw `LiveEvent` JSON → a chapter). The native WebSocket subscribe is
**INFRA-UNVERIFIED** behind the default-off `bridge` feature.

```bash
cargo build -p sundayrec --features bridge
```

1. `live_bridge_channel("ch1","svc1")` → `church:ch1:service:svc1`;
   `live_bridge_map_event` returns `chapter_added`/`went_live`/`ended`/`cue_only`
   for the matching event types — works in any build.
2. With the feature ON + SundayStage publishing on a live Supabase project, the
   native `bridge_live::subscribe` connects (Phoenix `phx_join`) and folds
   broadcasts; chapters accrue on the running recording.
   - **Expected:** with `RUST_LOG=sundayrec=debug`, each folded event logs its
     effect + seq; a `feature_disabled` error means the build lacks `--features
bridge`.

The **Integrasjoner** panel (R6) drives this: it lists the Sunday-suite peer
apps, persists the shared connection (churchId / serviceId / Song + Plan API
URLs) to the `integrations` settings key, and resolves the Realtime channel name
via `live_bridge_channel` (pure — every build). `live_bridge_status` reports
whether the native subscribe is compiled in; in the default build the panel
shows a calm "den innebygde live-broen er ikke bygd inn" hint (GUI-UNVERIFIED).

```bash
npm run tauri dev -- --features bridge   # drive the Integrasjoner disclosure
```

3. (any build) Open **Integrasjoner**, fill churchId + serviceId, **Vis
   kanalnavn**.
   - **Expected:** `church:<id>:service:<id>` is shown; blank ids show a hint.
     The amber "native bridge off" banner is present only in the default build.

> [INFRA] The Realtime handshake + broadcast decode need a live Supabase project
>
> - the Stage app publishing — never run in the gate. Only the core fold is tested.

---

## 11. OS wake-timers + scheduled launch [HW] (already wired, no feature)

The scheduler→recorder launch and the `pmset`/`schtasks`/`powercfg` shell-outs
are wired in `src-tauri/src/{scheduler,wake}` (no feature flag — they were part
of Fase 5). The next-fire / catch-up / skip _decisions_ are unit-tested in
`sundayrec-core::{schedule, wake}`; the live clock-tick, the admin/UAC prompts,
and whether the machine truly wakes are HARDWARE-UNVERIFIED.

1. Add a slot a couple of minutes ahead; leave the app running.
   - **Expected:** at the slot time the recorder starts unattended; the tray /
     UI "next recording" updates; a reminder notification fires `reminder_minutes`
     before.
2. Enable wake-from-sleep, reschedule (accept the admin prompt), sleep the Mac
   just before a slot.
   - **Expected:** `pmset -g sched` lists a SundayRec wake; the machine wakes and
     records. (Sleeping + measuring the resume is not automated — see the
     `wake/mod.rs` "honestly deferred" note.)

> [HW] Wall-clock timing + the real OS wake can only be confirmed on a Mac/Windows
> box with the power tools available.

---

## 12. Non-destructive editor [HW] — `--features editor`

The editor I/O seam (`src-tauri/src/editor`) drives the bundled ffmpeg/ffprobe
sidecar over the unit-tested `sundayrec-core::{editor, mastering,
audio_analysis}` decisions: load (ffprobe duration/channels/format/streams),
peaks (8 kHz mono WAV decode → core down-sample), segments (16 kHz s16le decode →
VAD/sermon classifier), mastering analyze (pass-1 loudnorm measure), and export
(core cut-plan + mastering gain → mp3/aac/wav/flac/mp4). NO new native dep —
ffmpeg is a sidecar and the WAV/PCM is parsed by hand. All ffmpeg runs are
**HARDWARE-UNVERIFIED** (need real media), so the commands are behind the
**default-off `editor`** feature; the shipping build returns `feature_disabled`
and the panel shows a calm "not built into this build" hint.

```bash
cargo build -p sundayrec --features editor    # must compile (gate verifies this)
npm run tauri dev -- --features editor          # drive the Redigering disclosure
```

1. Record (or import) a short service so it shows in History, open the
   **Redigering** disclosure, and pick the recording (or use **Åpne lydfil…**
   to pick any audio/video file via the native dialog).
   - **Expected:** the duration + stream info paint (ffprobe load); the waveform
     `<svg>` band auto-renders from the peaks (// GUI-UNVERIFIED paint — the
     peaks→geometry mapping `waveform.ts::waveformPath` is unit-tested) and a
     peak count appears; no `feature_disabled` hint.
2. Click **Finn segmenter** and **Mål lydstyrke**.
   - **Expected:** segments list with one **Preken** (sermon) block highlighted
     gold; a loudness reading like `-23.4 LUFS → -16`.
3. Click **Legg til kutt** one or more times, nudge the start/end (seconds)
   inputs, and remove one with **✕**.
   - **Expected:** red cut bands overlay the waveform at the marked spots
     (// GUI-UNVERIFIED); region rows show `m:ss–m:ss`; removed rows disappear.
4. Choose a format + a mastering target (**Ingen / Podkast −16 / Strømming −14
   / Naturlig / Musikk + tale**) and click **Eksporter**.
   - **Expected:** a `*_redigert.<fmt>` file lands next to the source; on
     playback the marked regions are removed and (with a target) the loudness is
     normalised. No target + no cuts takes the fast `-af`/copy path.
5. **P1 reopen-ability (cuts-draft sidecar):** with cuts marked, close the
   editor (or reselect another recording) then reselect the same recording.
   - **Expected:** a **"Fant lagrede kutt fra forrige økt (N)"** banner appears
     (read from `<base>.cuts-draft.json` written next to the recording by the
     autosave); **Gjenopprett** brings the cut rows back. After a successful
     **Eksporter** the draft is deleted, so a later reopen offers nothing.
6. **P1 mastering A/B preview:** with a mastering target chosen, click
   **Forhåndsvis mastering (15 s)**.
   - **Expected:** an `<audio>` control appears playing a temp
     `sundayrec-master-preview-*.mp3` of the first 15 s through the preset chain
     — A/B it against the original before committing to the full export.
7. **P1 mastering apply + cancel:** (when wired to the full-file `editor_master_apply`
   flow) start a master, watch the `editor-master-progress` ticks, and abort
   mid-render via `editor_master_cancel(jobId)`.
   - **Expected:** progress advances, and a cancel kills the ffmpeg child and
     returns `true` only while the job is live (`false` afterwards — the pure
     `JobRegistry` bookkeeping). A duplicate job id is rejected up front.

> The sidecar read/write/delete + the 400 MB inline-vs-stream guard + the
> `__editor_tmp`/`__editor_bak` startup sweep are **fs, not ffmpeg** — they
> compile and run in the default build and ARE exercised in the gate (real
> tempdir round-trips). Only the ffmpeg-driven probe/preview/apply are
> HARDWARE-UNVERIFIED behind `--features editor`.

> [HW] The ffprobe/decode/measure/render runs only execute under `--features
editor` against real media — never in the gate. Only the core argv-building,
> filter-graph, loudnorm parse, and VAD/sermon decisions, plus the renderer's
> peaks→SVG mapping and the load→peaks→regions→export data flow (vitest, invoke
> mocked), are unit-tested. The waveform/cut-band paint is // GUI-UNVERIFIED.
> The default build deliberately returns `feature_disabled` for every editor
> command, and the panel shows a calm hint.

---

## §R3 — Live streaming (RTMP + lower-thirds) — `--features streaming`

```bash
cargo build -p sundayrec --features streaming   # must compile (gate verifies this)
npm run tauri dev -- --features streaming         # drive the Direktesending disclosure
```

> [NET][HW] NETWORK + HARDWARE-UNVERIFIED. The camera open, the libx264 encode,
> the RTMP push, the lower-third compositing, and the live-stats parse only run
> under `--features streaming` against a real camera + a real RTMP endpoint +
> a real key — never in the gate. Only the core decisions (the tee/encode/
> overlay argv, the keyframe/bitrate math, the audio-map, the key/URL validation,
> the key-redacted log copy) and the panel's IPC data-flow (vitest, invoke
> mocked) are unit-tested.

1. Open the **Direktesending** disclosure. In the default build (no
   `--features streaming`) **Start** returns `feature_disabled` and the panel
   shows a calm "not built into this build" hint — the key vault still works.
2. Add a destination (name + `rtmp://…` URL), paste a stream key, click
   **Lagre nøkkel**.
   - **Expected:** the key is validated (a key with a space/too short is
     rejected with a clear message) and stored in the OS keychain; the row shows
     a "•••• (lagret)" badge. **Slett nøkkel** removes it.
3. (streaming build) With at least one enabled destination that has a saved key,
   pick a resolution + framerate, optionally tick **Vis tekstplakat** and choose
   a lower-third **Type** (Tekst = title ± subtitle, or Bilde = a logo image
   path); with the toggle off no overlay is sent. Click **Start**.
   - **Expected:** one ffmpeg opens the camera/mic, composites the overlay, and
     pushes to every enabled destination; **Status** shows `active` + a live
     bitrate/fps. A second **Start** is refused (`stream_already_active`).
     // NETWORK/HARDWARE-UNVERIFIED.
4. Click **Stopp**.
   - **Expected:** the stream goes idle; the broadcast ends on the platform.

> The argv is logged KEY-REDACTED (`rtmp://…/***`) — confirm no stream key
> appears in the `tauri dev` stderr.

## §R3b — NDI (STUB) — `--features ndi`

```bash
cargo build -p sundayrec --features ndi          # must compile (gate verifies this)
```

> [NEEDS-RICHARD] The NDI SDK is NOT bundled in this repo. Even WITH
> `--features ndi` the seam is a STUB: `ndi_list_sources` returns empty and
> `ndi_start_receiver` returns `ndi_not_bundled: NDI SDK not bundled — see
docs/NEEDS-RICHARD.md`. The default build returns `feature_disabled`. The pure
> source-discovery / FourCC→pixfmt / rawvideo input-arg logic
> (`sundayrec_core::ndi`) IS unit-tested. Wiring the real libndi FFI + the
> loopback-TCP frame pump needs the SDK runtime + an NDI source on the LAN — see
> the NEEDS-RICHARD doc.

---

## §PU-6 — Episode prep + human-review queue (no feature)

The prep/review decisions (which recordings need attention + why, the
sermon-detection summary, the reminder sweep cadence) are unit-tested in
`sundayrec-core::{prep, review_queue}`; the queue is persisted in SQLite. No
feature flag — this was part of PU-6. The **Gjennomgang** panel (R6) drives it.

1. After a recording (§5) is queued for review, open the **Gjennomgang**
   disclosure.
   - **Expected:** the recording appears with its detected sermon block + the
     "attention" reasons (e.g. short duration, silence flagged).
2. Click **Godkjenn** (approve) or **Forkast** (discard) on a row.
   - **Expected:** the row leaves the queue (`review_mark_published` /
     `review_mark_discarded`); relaunching the app keeps the change.
3. Run the reminder sweep (`review_process_reminders`).
   - **Expected:** entries past their reminder window surface a notification.

> The data flow + IPC (vitest, invoke mocked) and the core decisions are tested;
> the on-screen render is // GUI-UNVERIFIED.

---

## §R7 — Auto-update (`--features updater`) + settings completeness

### Auto-update

The status model (the localized `idle`/`checking`/`upToDate`/`available`/
`downloading`/`readyToInstall`/`error` phases), the dev-check guard, the
download-percent math, and the semver "is newer" decision are unit-tested in
`sundayrec-core::update`. The feed fetch + signature verify + install + relaunch
are **NETWORK/GUI-UNVERIFIED** behind the default-off `updater` feature, and a
**real** update additionally needs a SIGNED release + the updater public key in
`tauri.conf.json` — see docs/NEEDS-RICHARD.md.

```bash
cargo build -p sundayrec --features updater   # must compile (gate verifies this)
npm run tauri dev -- --features updater          # drive the Oppdateringer disclosure
```

1. Open the **Oppdateringer** disclosure. In the **default build** (no
   `--features updater`) click **Se etter oppdateringer nå**.
   - **Expected:** a calm "Automatisk oppdatering er ikke bygget inn i denne
     versjonen." hint (the command returns `feature_disabled`). // GUI-UNVERIFIED.
2. (`--features updater`, dev build) **Se etter oppdateringer nå**.
   - **Expected:** the status reports **Du er oppdatert** — a dev build
     short-circuits the check (the `should_check` guard), so no error from a
     missing feed. // NETWORK-UNVERIFIED.
3. (`--features updater`, **release** build pointed at a real signed feed) check
   → **Last ned** → **↺ Start på nytt og installer**.
   - **Expected:** the panel walks `available` → `downloading {pct}` →
     `readyToInstall`; the relaunch applies the staged update. Needs the signed
     release + pubkey (NEEDS-RICHARD). // NETWORK/GUI-UNVERIFIED.

### Settings completeness (no feature)

R7 closed the gap between the Electron `store.ts` `Settings` and the Tauri model:
church profile (`churchName`/`responsiblePerson`), notification toggles
(`notifyStart`/`notifyStop`), and email config (`emailOnError`/`emailAddress`/
`emailSmtp`/`emailSmtpPort`/`emailSmtpUser` — the SMTP **password** stays in the
OS keychain via the `email` seam, never in the settings bag) plus the editor
intro/outro paths. All carry defaults + validation (`email_smtp_port` clamped
1..=65535) in `sundayrec-core::settings`.

1. Open **Generelt**, scroll to the **Menighet** / **Varsler** / **E-postvarsler**
   sections.
   - **Expected:** every field round-trips through `settings_save` (debounced)
     into SQLite and survives a relaunch; the port clamps to 1..=65535.

---

## §P2b — Remaining Electron→Tauri IPC parity

These close the last handlers the Electron `src/main/ipc/*` exposed that the
earlier phases hadn't reached. Pure decisions live in `sundayrec-core` (unit-
tested); the I/O seams are annotated and, where they touch new hardware/network,
gated behind a default-off feature.

### Sunday-suite integrations (no feature) — 11 handlers

Mirrors `src/main/ipc/integrations.ts`. Typed opt-in settings + the Song/Plan/
SundayEdit hand-offs. The mappers (settings shallow-merge, usage-payload shaping +
idempotency key, plan metadata/schedule, sundayedit deep link + SRT/VTT parse,
sidecar paths) are unit-tested in `sundayrec-core::integrations`; the HTTP
submissions + the `sundayedit://` launch reuse the always-present `reqwest`/opener
(no new dep, no feature) and are **NETWORK-UNVERIFIED**.

1. `integrations_get_settings` / `integrations_set_settings` round-trip the
   opt-in blob under the `integrations` kv key.
   - **Expected:** a partial patch (e.g. `{ enabled: true }`) merges shallowly —
     it never clobbers a stored `connection` it didn't send (`merge_patch_json`).
2. `integrations_song_set_apikey` / `integrations_song_has_apikey` use the
   keychain (`integrations.song_api_key` slot), never the settings blob.
3. With `song.enabled` + a `.service.json` sidecar present,
   `integrations_song_submit_usage` POSTs one payload per song to
   `<songApiUrl>/v1/usage/log` (409 = duplicate counts as submitted).
   - **Expected:** `disabled` when the song flow is off; `no_service_link` /
     `no_songs` with a hint when the sidecar/setlist is missing. // NETWORK-UNVERIFIED.
4. `integrations_plan_fetch_services` reads `<planApiUrl>/rest/v1/service`,
   enriching each with `meta` (title/speaker) + `schedule` (local 2-h window);
   `integrations_plan_update_service` PATCHes `was_streamed_flag`/`recording_url`.
   - **Expected:** `plan_not_ready` until `plan.enabled` + a `planApiUrl` are set;
     `no_church_id` without one. // NETWORK-UNVERIFIED.
5. `integrations_sundayedit_send` opens `sundayedit://import?…`; `..._import` parses a
   SundayEdit SRT/VTT into the recording's `.transcript.json`.
   - **Expected:** `sundayedit_not_installed` when no scheme handler;
     `no_captions_parsed` when the subtitle file yields no segments. // NETWORK-UNVERIFIED.

(SundayStage manifest import is `stage_import_manifest`, covered by §PU-6.)

### Audio diagnostics (no feature) — `list_video_devices` + `diagnose_audio`

Mirrors `src/main/ipc/audio-devices.ts`. Both reuse the existing
`ffmpeg -list_devices` enumeration; the diagnostics shaping
(`build_audio_diagnostics`) is pure + tested.

1. Open **Generelt** → the camera dropdown / device probe.
   - **Expected:** `list_video_devices` returns the connected cameras and
     `diagnose_audio` returns the audio-input names (WASAPI loopback is not
     ported → `wasapi` empty, `wasapiAvailable` false). A missing ffmpeg / no
     devices yields empty lists, not an error. // HARDWARE-UNVERIFIED.

## What "passed" means

A green smoke test = §2–§6 all behave as the **Expected** lines say on a real
Mac with a real mic/camera, with no panic in the `tauri dev` stderr. §7 is a
bonus that needs a Google client. Record any deviation (which step, the stderr
log, the OS permission state) when reporting back.
