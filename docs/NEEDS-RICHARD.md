# Needs Richard — Electron-parity seams (PU-1…PU-4)

The pure decision logic for these features is ported into `sundayrec-core` and
fully unit-tested; the impure seams compile behind **default-off** cargo
features (`email`, `tray`, `publish`) or are already wired (scheduler/wake). The
items below need a real account / desktop session / device that the headless
gate cannot provide. None block the default build or the gate.

## PU-1 — Email alerts (`--features email`)

- **A Gmail OAuth connection or SMTP credentials.** The Gmail path reuses the
  cloud OAuth refresh token (connect Gmail first); the SMTP path needs a host,
  port, user, and app-password. There is no UI to enter SMTP settings yet — the
  Tauri `Settings` struct still defers the `email*` fields to Fase 6, so the
  seam (`src-tauri/src/email/mod.rs`) takes its transport config as explicit
  parameters. Wiring the Settings fields + a `send_test_email` command is the
  remaining glue once the email card lands in the UI.
- **Deliverability check.** Confirm a real "✓ email works" message arrives and
  the throttle suppresses a 2nd identical alert within 10 min (smoke §8).

## PU-2 — Tray + deep links (`--features tray`)

- **A desktop session.** The native menubar/tray item and the `sundayrec://`
  scheme registration (`tauri-plugin-deep-link`) need a real GUI to verify.
- **Tray icon assets.** The Electron app shipped `tray-idle/recording/error`
  PNGs (+ macOS `Template` + Windows dark variants) under `assets/`. The Tauri
  build needs equivalent assets bundled and a `tray.rs` shell that maps
  `sundayrec_core::tray::{build_menu, icon_for, tooltip}` to `tauri::menu` +
  `tauri::tray::TrayIconBuilder` and wires each `TrayAction` to its command/
  event. The model + routing are unit-tested; the menubar shell is the glue.
- **Scheme registration in `tauri.conf.json`** (`plugins.deep-link.desktop.schemes
= ["sundayrec"]`) + the macOS `Info.plist` `CFBundleURLTypes` entry, then the
  `lib.rs` `setup` hook calling `parse_deep_link` on each inbound URL.

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
  - **Cut-region timeline UI.** The R1 panel exports the *whole* file
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
