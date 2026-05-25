# Changelog

All notable changes to SundayRec are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [4.30.1] — 2026-05-25

### Changed
- Hide OneDrive option from the cloud-backup UI until the Azure app registration
  has completed Microsoft verification. The OneDrive provider remains in the
  codebase (`src/main/cloud/onedrive.ts`) and can be re-enabled by a build flag
  once verification clears.

---

## [4.30.0] — 2026-05-24

### Added
- Full **prep-and-review podcast flow**: after a recording ends, SundayRec
  automatically masters the audio, runs voice-activity analysis, generates
  chapter markers, and enqueues the episode in a persistent **review queue**.
  Volunteers see new episodes on Monday morning instead of having to dig
  through files.
- Tray, email and webhook notifications when a new episode is ready to review.

### Changed
- **Reliable wake**: rewrote the wake-from-sleep scheduler around `pmset`
  (macOS) and Task Scheduler (Windows) with explicit fallback paths, admin-
  elevation handling, and a verification probe.
- **OAuth in CI**: cloud-provider client IDs are now injected at build time
  through `electron-vite`, so forks can ship their own OAuth apps without
  touching the source.

### Fixed
- Several edge cases in DST-boundary slot scheduling.

---

## [4.29.0] — 2026-05-22

### Added
- **Professional mastering** with four EBU R128 presets (speech-natural,
  speech-clear, speech-punchy, music+speech) using a two-pass ffmpeg
  `loudnorm` chain with measured-then-linear normalisation.
- **VAD-based chapter detection** replaces silence-detect; chapters now align
  with sermon and hymn boundaries instead of pauses between sentences.
- **Responsive design** pass across all pages.

---

## [4.28.0] — 2026-05-20

### Added
- Full i18n quality sweep across all seven supported languages.

### Changed
- UX reorganisation: navigation order and page grouping reworked for clarity.

### Fixed
- Numerous failure-mode robustness issues across recorder, scheduler and editor.

---

## [4.27.2] — 2026-05-18
### Changed
- Trigger rebuild of macOS and Windows installers (no code changes).

## [4.27.1] — 2026-05-18

### Added
- 37 new tests covering recorder reliability paths.

### Fixed
- Robustness sweep: four user-reported bugs fixed.

### Changed
- Full TypeScript strictness cleanup; no remaining `any` casts in
  recorder, editor or scheduler.

## [4.27.0] — 2026-05-17

### Added
- **Podcast RSS feed** — generates a fully iTunes-compliant feed at publish
  time. Single URL to submit to Spotify for Podcasters / Apple Podcasts
  Connect; subsequent episodes appear automatically.
- **Watertight camera preview** — preview pipeline rewritten to survive
  disconnects without crashing.

---

## [4.26.1] — 2026-05-15

### Added
- 168 new tests covering cloud upload paths.

### Fixed
- **Critical**: cloud chunk-retry could under rare timing corrupt the
  final assembled file. Fixed and covered by regression tests.
- Scheduler: reject degenerate slots (zero or negative duration) and warn
  on DST gap dates.

## [4.26.0] — 2026-05-14

### Added
- **Cloud backup** (Google Drive, Dropbox) with a resumable chunked
  upload queue.
- **Preflight checks** before each recording: disk space, audio device,
  permissions, sleep configuration.
- 116 new recorder + editor orchestration tests.

### Changed
- Editor: numerous responsiveness and undo/redo improvements.
- Recorder: hardened against device drop-outs and short USB stalls.

---

## [4.25.x] — 2026-05-10

### Added
- Full audio-format support in the editor (30+ ffmpeg-supported formats).
- macOS builds now signed with a Developer ID certificate and notarised by
  Apple — no Gatekeeper warning on first open.

### Changed
- Documentation: README expanded to cover signed/notarised app and supported
  formats.

---

## [4.23.0] — 2026-04-30

### Added
- Post-recording summary screen.
- Cloud upload tracking and status indicator.

### Changed
- General reliability hardening across recorder and editor.

---

## [4.22.x] — 2026-04-20 → 2026-05-05

### Added
- Camera flip control.
- System diagnostics page.
- Separate high-quality audio export alongside combined MP4 video.

### Fixed
- A/V sync drift on long recordings.
- Windows: dropped legacy ASIO path and PowerShell WMI fallback in favour of
  DirectShow.
- macOS: fix AVFoundation timebase regression on certain webcams.

---

## [4.10] — [4.19] — 2026-02 → 2026-04

A long stretch of stability and platform-robustness work, including:

### Added
- Logic-Pro-style parametric EQ with spectrum analyzer
- Built-in editor: cuts, intro/outro, chapter markers, parametric EQ, format export
- Pre-roll buffer for manual recordings
- Onboarding wizard
- Collapsible sidebar + unified settings page
- Wake reliability overhaul with one-click sleep-config fix
- Reminder before recording; manual max-duration; weak-signal check
- Norwegian church-calendar overlay (Easter, Christmas, Allehelgensdag, etc.)
- Initial cloud-backup framework

### Changed
- Move recording out of the renderer into the main process via `native-recorder`
- Replace deprecated `fluent-ffmpeg` with a direct `spawn` integration
- Significant performance and startup improvements

### Fixed
- DST boundary scheduling
- Numerous Windows-specific audio-device matching issues (WASAPI enumeration,
  USB-mixer name handling, Soundcraft, etc.)
- macOS-specific stability improvements (5 fixes in one release)
- Camera and microphone permission handling on macOS
- Several recorder bugs (auto-stop, history timestamps, expired specials)

---

## [4.0.0] — 2026-01-10

### Added
- First production-grade release intended for worldwide church deployment.
- UI/UX restructuring: improved navigation order and page layout.
- Recording moved into the main process for stability.

---

## Earlier versions

Versions before 4.0 were development-phase releases not intended for
deployment outside the author's pilot churches. The full `git` history is
available at <https://github.com/richardfossland/sundayrec/commits/main>.

---

[4.30.1]: https://github.com/richardfossland/sundayrec/releases/tag/v4.30.1
[4.30.0]: https://github.com/richardfossland/sundayrec/releases/tag/v4.30.0
[4.29.0]: https://github.com/richardfossland/sundayrec/releases/tag/v4.29.0
[4.28.0]: https://github.com/richardfossland/sundayrec/releases/tag/v4.28.0
[4.27.2]: https://github.com/richardfossland/sundayrec/releases/tag/v4.27.2
[4.27.1]: https://github.com/richardfossland/sundayrec/releases/tag/v4.27.1
[4.27.0]: https://github.com/richardfossland/sundayrec/releases/tag/v4.27.0
[4.26.1]: https://github.com/richardfossland/sundayrec/releases/tag/v4.26.1
[4.26.0]: https://github.com/richardfossland/sundayrec/releases/tag/v4.26.0
