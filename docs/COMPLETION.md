# SundayRec (Tauri 2) — Completion summary

This document records the **finished state** of the Electron → Tauri 2 rebuild of
SundayRec and draws the exact boundary between what is **code-complete + gate-green**
and what **needs Richard** (a rig, an account, a key, a signing identity). It is the
companion to `SMOKE-TEST.md` (the hardware-in-the-loop checklist) and
`NEEDS-RICHARD.md` (the per-feature glue list).

## TL;DR

- **Architecture:** all recorder/editor/streaming/transcribe/publish/update/etc.
  _behaviour_ is distilled into the pure, GUI-free, fs/network-free
  `sundayrec-core` crate and exhaustively unit-tested. `src-tauri` is a thin
  command/event/IO shell on top; every impure path that touches a device, the
  network, a key, or a GUI is annotated `// HARDWARE/NETWORK/GUI/INFRA-UNVERIFIED`.
- **Default build stays lean:** every native or risky dependency lives behind a
  **default-off** cargo feature (`email`, `tray`, `publish`, `editor`, `whisper`,
  `streaming`, `ndi`, `bridge`, `updater`). The shipping build and the CI gate
  carry none of them; a feature-disabled command returns a clear `feature_disabled`
  error and the matching panel shows a calm "not built into this build" hint.
- **Gate-green:** `npm run check` (eslint + tsc + vitest + clippy `-D warnings` +
  `cargo test --workspace`) passes — **749 Rust tests** (594 core + 155 src-tauri)
  - **125 vitest**. Each default-off feature also compiles in isolation
    (`cargo build -p sundayrec --features <flag>`), the `whisper` C++ build being the
    single by-inspection exception.

## Feature inventory (what's built)

| Area                         | Core (pure, tested)                                                        | Shell seam              | Feature                | Tier                              |
| ---------------------------- | -------------------------------------------------------------------------- | ----------------------- | ---------------------- | --------------------------------- |
| Recorder core                | `recorder`,`reconnect`,`silence`,`preroll`,`two_process`,`capture`         | `recorder/*`            | (none)                 | P2b — HARDWARE-UNVERIFIED         |
| Devices / VU / preview       | `device_enum`,`device_match`,`audio`,`mjpeg`                               | `audio/*`,`media/*`     | (none)                 | P2b — HARDWARE-UNVERIFIED         |
| Settings                     | `settings` (full Electron parity incl. R7 church/notify/email/intro-outro) | `settings/*`            | (none)                 | P2a + persist                     |
| Schedule / wake              | `schedule`,`wake`                                                          | `scheduler/*`,`wake/*`  | (none)                 | P2b — HARDWARE-UNVERIFIED         |
| History + dialogs            | (sqlx store)                                                               | `db/*`                  | (none)                 | done                              |
| Diagnostics / preflight      | `diagnostics`,`preflight`                                                  | `diagnostics/*`         | (none)                 | done                              |
| Editor                       | `editor`,`mastering`,`audio_analysis`                                      | `editor/*`              | `editor`               | P2b — HARDWARE-UNVERIFIED         |
| Transcription                | `whisper`                                                                  | `whisper/*`             | `whisper`              | P2b — HARDWARE-UNVERIFIED         |
| Review / prep / Stage import | `prep`,`review_queue`,`integrations::stage`                                | `commands/review`       | (none)                 | P2a + persist                     |
| Cloud backup                 | `cloud`                                                                    | `cloud/*`               | (none, OAuth deferred) | P2b — NETWORK-UNVERIFIED          |
| Email alerts                 | `email`                                                                    | `email/*`               | `email`                | P2b — NETWORK-UNVERIFIED          |
| Live streaming (RTMP)        | `streaming`,`overlay`                                                      | `streaming/*`           | `streaming`            | P2b — NETWORK/HARDWARE-UNVERIFIED |
| NDI receiver                 | `ndi`                                                                      | `ndi/*` (STUB)          | `ndi`                  | P2c — SDK not bundled             |
| Podcast RSS publish          | `feed`                                                                     | `publish/*`             | `publish`              | P2b — NETWORK-UNVERIFIED          |
| Live cue bridge              | `integrations::live_bridge`                                                | `bridge_live/*`         | `bridge`               | P2b — INFRA-UNVERIFIED            |
| Suite hand-offs              | `link`                                                                     | `commands/bridge`       | (none)                 | done                              |
| Tray + deep links            | `tray`,`link`                                                              | `tray/*` (installed R7) | `tray`                 | P2b — GUI-UNVERIFIED              |
| Auto-update                  | `update`                                                                   | `update/*`              | `updater`              | P2b — NETWORK/GUI-UNVERIFIED      |

The renderer surfaces every area behind the `<details>` disclosure pattern in
`src/App.tsx` (until the Phase-8 shell/nav lands), each panel following the same
TanStack-Query + `invoke` + `react-i18next` + ts-rs-bindings idiom, with a vitest
suite that mocks `invoke` and asserts render + IPC calls.

## R7 additions (this phase)

- **Settings completeness:** the Electron `store.ts` fields that were deferred —
  `churchName`/`responsiblePerson`, `notifyStart`/`notifyStop`,
  `emailOnError`/`emailAddress`/`emailSmtp`/`emailSmtpPort`/`emailSmtpUser`,
  `editorIntroPath`/`editorOutroPath` — are now in the typed `sundayrec-core::settings`
  model with defaults + validation (port clamped 1..=65535) and a UI in **Generelt**.
  The SMTP **password** stays in the OS keychain, never the settings bag.
- **Auto-update:** `sundayrec-core::update` (status phases, dev-check guard,
  percent math, semver `is_newer`) + the `update` seam behind the default-off
  `updater` feature + the **Oppdateringer** panel ("Se etter oppdateringer / Last
  ned / Start på nytt og installer"). NETWORK/GUI-UNVERIFIED — needs a signed feed.
- **Tray installed:** the `tray` feature now actually installs the menubar icon +
  menu in `setup()`, wires start/stop/show to commands (Stop → `RecorderEngine::stop()`
  directly), and registers the `sundayrec://` deep-link handler.
- **Editor backend parity (P1):** closed the depth gap vs the Electron editor/
  master backend. New `sundayrec-core` decisions (all tested): the three sidecar
  paths (`.meta`/`.cuts-draft`/`.transcript`) with the `..`-escape guard, the
  400 MB inline-vs-stream guard, the `__editor_tmp`/`__editor_bak` cleanup
  predicate + dir de-dup, the POSIX/Windows atomic safe-replace plan, the
  single-pass mastering-preview argv, and a pure `JobRegistry` state machine
  (register/cancel/complete). Nine new commands wire these: sidecar read/write/
  delete + stream probe + inline read-guard + temp-file sweep all compile and
  run in the **default build** (fs, not ffmpeg — gate-tested via tempdir
  round-trips), and the full mastering flow (`master_preview`/`master_apply`
  with `editor-master-progress` events/`master_cancel`) sits behind the
  default-off `editor` feature (HARDWARE-UNVERIFIED). The panel gained
  cuts-draft reopen-ability (restore banner + autosave + delete-on-export) and a
  mastering A/B preview. (Still deferred to a later pass: the destructive
  in-place `saveEdited`/video-save handlers — the non-destructive export already
  covers the audio + mp4 render path.)
- **i18n:** the `update.*` catalog (Electron-ported) gained the two new R7 keys in
  all 7 locales; every other new R-phase string follows the established
  inline-`t(key, "Norsk fallback")` idiom (the panels work without catalog entries).

## The code-complete vs needs-rig boundary

**Code-complete + verified in the gate (no rig needed):**

- Every `sundayrec-core` decision (the entire 594-test core).
- Every command's IPC surface + the panel data-flow (the 125 vitest).
- Every default-off feature _compiles_ (build + clippy `-D warnings`), so the
  feature-gated seams are wired correctly even though their effects are unproven.
- The full settings round-trip, history persistence, diagnostics report, schedule
  decisions, prep/review queue, suite hand-off URL building, RSS XML shaping,
  transcript export rendering, overlay/stream/ndi argv building — all pure + tested.

**Needs Richard (a rig / account / key / signing identity — see NEEDS-RICHARD.md):**

- A real Mac/Windows box with mic + camera to prove the recording, preview,
  schedule-launch, wake-timer, editor, streaming and whisper _effects_
  (HARDWARE-UNVERIFIED). The migration's "validated on a real rig" exit is reached
  here, not in the gate.
- Network + a Google OAuth Desktop client for cloud connect/upload + the
  cloud-Gmail email path (NETWORK-UNVERIFIED).
- SMTP credentials for the SMTP email path; the NDI SDK + a LAN source for NDI; a
  live Supabase project + SundayStage for the live bridge.
- Apple Developer ID + notarization, a Windows signing cert, and an updater keypair
  - `plugins.updater` config for a signed, auto-updating release.

None of the needs-rig items block the default build or the gate; the pipeline is
wired to consume each one the moment it's provided.
