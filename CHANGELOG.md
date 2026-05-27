# Changelog

All notable changes to SundayRec are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [4.42.0] — 2026-05-27

### Changed
- **Hjem-side i video-modus: UV-meteret er nå horisontalt under preview.**
  Det vertikale UV-meteret fra v4.41.0 ble litt urolig fordi peak-teksten
  ("Maks: -15.9 dBFS") endret bredde på hver frame i en flex-wrap-container,
  og fikk hele kolonnen til å skjelve. Den horisontale UV-en under preview
  er pixel-stabil og bruker eksakt samme markup/CSS som lyd-modus — vi får
  én konsistent visuell identitet på tvers av begge moduser. Innstillingskort
  stables fortsatt vertikalt til høyre for previewet, og previewet har
  fortsatt 16:9 aspect-ratio uten svarte sidefelter.
- **Direktesending-fanen har fått samme UV-design** som resten av appen —
  full 5-segment-gradient (grønn → gul → orange → rød), tick marks ved
  -24/-12/-6 dBFS, peak-hold, klipp-LED, dBFS-utlesning og «Stille / Maks»-
  skala. Erstatter den tynne lineære peak-stripa som var der før. Samme
  RMS+peak-engine som driver hjem-VU-en, så meterene er numerisk identiske
  på tvers av sidene.

---

## [4.41.0] — 2026-05-27

### Changed
- **Hjem-siden i video-modus** er bygget om fra grunnen av:
  - **UV-meter er nå vertikalt** på siden av video-preview, med eksakt samme
    visuelle design som det horisontale UV-meteret i lyd-modus — samme
    fargegradient (grønn → gul → orange → rød), samme tick marks ved
    -24/-12/-6 dBFS, samme peak-indikatorer, samme "Stille"/"Maks"-etiketter,
    samme status-pille ("• Bra | Maks: -15.9 dBFS"). Bare orientert vertikalt.
  - **Ingen svarte sidefelter rundt video-preview** lenger. Containeren bruker
    nå `aspect-ratio: 16/9` og `object-fit: contain`, så previewet fyller
    plassen naturlig — kameraet styrer aspect-ratio, ikke en fast bredde.
  - **Innstillingskort omorganisert** rundt previewet: KAMERA, VIDEOKVALITET,
    LYDKILDE, FORMAT og LAGRING stables nå i en kolonne til høyre for
    previewet, ikke i to flate striper under.
  - **3-kolonne grid** (vertikal UV | preview | info-kolonne) som kollapser
    pent på smale vinduer (<1100 px): info-kortene flyter da i en rad under
    previewet, mens UV holder seg vertikal på venstre side.
- **Lyd-modus uendret** — pixel-for-pixel som i v4.40.0.

Alle 1051 tester passerer.

---

## [4.40.0] — 2026-05-27

### Added
- **Episode-bilde (cover art) for podkast-publisering.** To-nivå modell:
  - **Standard episodebilde** settes én gang i `Innstillinger → Publisering`
    og brukes som cover art for alle prekener. Bildet kopieres inn til
    `userData/thumbnails/` slik at det overlever om kildefilen senere flyttes.
  - **Egendefinert per episode** kan settes i editoren — en drag/drop-panel
    mellom mastering- og lagre-seksjonen — og overstyrer standardbildet bare
    for det opptaket. Lagres som `[opptaksnavn].thumb.{ext}` ved siden av
    lydfilen.
- **Auto-embed under mastering.** Når en MP3 eksporteres, kjører en ekstra
  ffmpeg-pass som legger bildet inn som ID3v2 `attached_pic` (det
  Apple Podcasts, Spotify og de fleste podcast-spillere leser). For WAV/FLAC/
  AAC hopper vi over embed (filformatene støtter ikke det skikkelig) men
  skriver fortsatt bildet som en sidecar-fil.
- **Sidecar-fil ved siden av output.** Uansett format kopieres bildet som
  `[opptak].jpg` (eller .png/.webp) ved siden av den ferdige filen — slik at
  du har en separat URL å peke RSS-feeden din til.
- **Visning i listene.** 48 px-ikon i review-køen på startsiden, 64 px-ikon
  i søkesiden — slik at du gjenkjenner serien visuelt.
- **Innebygd format-validering.** JPG / PNG / WebP detekteres via magiske
  bytes (ikke filendelse), dimensjoner leses direkte fra header'en uten
  noen ny npm-avhengighet, og vi advarer ved < 1400×1400 eller ikke-kvadratisk
  bilde (men resizer ikke automatisk — du bestemmer selv).
- 17 nye i18n-nøkler i alle 7 språk. **821 nøkler per språk** (opp fra 804).

---

## [4.39.1] — 2026-05-27

### Fixed
- Search → Editor seek-to was racy: the previous CustomEvent fired 350 ms
  after `openEditorWithFile`, but `loadFile` zeroes `playStartSec` mid-flight
  and audio decode can take longer than 350 ms, so the jump-to-time often
  landed at 0 instead of the intended segment. `openEditorWithFile` now takes
  an optional `seekToSec` parameter and the editor applies it as the final
  step of `loadFile()` — deterministic, no setTimeout race.

---

## [4.39.0] — 2026-05-27

### Added
- **Search page (`Søk` in sidebar).** Full-text search across every
  `.transcript.json` sidecar in known recording folders. Click a hit to
  open the recording in the editor at that timestamp. Default browse view
  shows the 20 most recently transcribed sermons. Linear-scan implementation
  (5 ms for 10k segments) — no extra dependency for fancy indexing.
- **VTT subtitle export** alongside SRT — same panel, separate button.
  WebVTT is preferred by HTML5 `<track>`, YouTube native captions, Vimeo,
  and iOS/macOS players. SRT remains for legacy tooling.
- **Silent preflight banner on Home.** Once per app launch we run the same
  preflight check the user could trigger from Settings, and surface any
  findings as a clickable banner above the hero. Surfaces "disk almost full",
  "mic permission denied", "saved device not found" proactively — the user
  no longer has to remember to click "Sjekk system".
- 21 new i18n keys for the search page and home banner, in all 7 languages.
  **804 keys per language** (up from 782).

### Changed
- Editor seek-to listener added (`document` event `editor-seek-to`) so other
  pages can hand off a "open this recording at timestamp" intent without
  needing a second IPC channel.

---

## [4.38.2] — 2026-05-26

### Added
- **Stream auto-recovery.** If ffmpeg crashes mid-stream (USB drop, libx264
  OOM, RTMP brief disconnect), the streamer now auto-restarts up to 3 times
  with 5 s delay between attempts. UI shows "Recovering…" instead of going
  dark — critical for unattended 90-min Sunday broadcasts.
- README: new "Reliability" section documenting recoverPartial, USB-drop
  watchdog, disk-space pre-flight, wake-test recommendation.

### Changed
- LICENSE: clarified non-commercial use boundary with concrete examples.
  Megachurches and large dioceses are explicitly PERMITTED. Christian
  radio stations with paid sponsorships, media companies producing as a
  paid service, and conference organisers charging admission are
  explicitly NOT permitted without a commercial agreement.
- `importProfile` now strips `hasKey: true` from imported `streamDestinations`
  so the UI prompts the user to re-paste stream keys on the new machine
  (keys can't be migrated — they're encrypted with the old machine's keychain).
- README + PRIVACY.md updated for v4.38 — Live streaming, AI transcription,
  YouTube upload, sermon detection all documented. PRIVACY.md adds
  `sundayrec-stream-keys.json`, `whisper-models/`, `live-preview/preview.jpg`
  to the file inventory.

---

## [4.38.1] — 2026-05-26

### Fixed
- Critical: `ggml-base.bin` model SHA-256 was truncated in v4.37/4.38, causing
  every Base-model download to fail with "integrity check failed" after 147 MB.
  Verified against Hugging Face LFS pointers and corrected.
- Live streaming watchdog added — if ffmpeg produces no progress for 90 s
  (encoder hang, RTMP stall, USB drop), the process is force-killed and surfaced
  to the UI instead of showing frozen stats forever.

### Added
- Live page: real audio VU meter via `getUserMedia` + AnalyserNode, so volunteers
  can verify the microphone is working *before* clicking Start.
- Transcribe button probes binary availability at app start; disabled with a
  clear "Not available in this build" message if the platform binary is missing.

### Changed
- Translations completed in all 7 languages for `live.*`, `transcript.*` and
  `publish.stream*` — no more Norwegian fallback strings for non-Norwegian users.
  **782 keys per language** (up from 722).

---

## [4.38.0] — 2026-05-26

### Added
- **Direkte (Live RTMP streaming).** New sidebar tab between Tidsplan and
  Rediger. One ffmpeg process opens camera + mic, encodes once with H.264 + AAC,
  and tees output to multiple destinations (YouTube, Facebook, custom RTMP)
  simultaneously via `-f tee`. `onfail=ignore` means one dead destination
  doesn't kill the others.
- Live preview thumbnail (JPG snapshot every 2 s) rendered in the page so the
  user can confirm video is correct without competing for the camera with a
  separate preview process.
- Stream-destination editor in Innstillinger → Publisering. Stream keys
  encrypted via `safeStorage` (system keychain on macOS, DPAPI on Windows).
- Stats panel with bitrate, FPS, dropped frames, uptime parsed from ffmpeg.
- Quality selector: 480p / 720p (recommended) / 1080p × 25 or 30 fps.

---

## [4.37.0] — 2026-05-26

### Added
- **Local AI transcription via `whisper.cpp`.** Transcribe sermons to
  searchable text entirely on-device — no data leaves your machine. Four
  curated models:
  - Base (147 MB, ~14× real-time)
  - Small (487 MB, ~5× real-time, balanced)
  - Large Turbo Q5 (547 MB, ~6× real-time — recommended)
  - Medium (1.5 GB, ~2× real-time, classic)
- Lazy-download from Hugging Face with SHA-256 verification.
- 9 input languages + auto-detect; optional translate-to-English.
- Clickable segment panel below the timeline — click a phrase, playhead jumps.
- Auto-highlight of currently-playing segment during playback.
- SRT export for YouTube subtitles.

### Distribution
- macOS: whisper-cli built from source in CI for both arm64 and x86_64,
  statically linked (3 MB each), signed and notarised with the app.
- Windows: upstream `whisper-bin-x64.zip` downloaded in CI, bundled with DLLs.

---

## [4.36.0] – [4.36.2] — 2026-05-26

### Added
- **Sermon-only recording detection.** If ≥80% of the file is speech and <5%
  is music, the entire file is treated as sermon; trim only the silent edges.
  Covers churches that record just the sermon, not the full service.
- Trusted-paths for files chosen via system dialog or drag-drop — path-defense
  no longer silently refuses legitimate picks from external drives.
- YouTube actionable error messages (API not enabled, quota exceeded,
  insufficient scope — each maps to a specific actionable user-facing string).

### Fixed
- Waveform disappeared when leaving and returning to the editor tab.
  Root cause: `deactivateEditor()` cleared peaks/audioBuffer as if the file
  was closed. Now only stops playback; full cleanup moved to explicit close.

---

## [4.35.0] – [4.35.4] — 2026-05-26

### Added
- ffmpeg watchdogs on 4 post-recording processes (pre-roll encode, concat,
  reconnect-merge, recovery remux). Hard limits 3–15 min depending on stage.
- Path-traversal defense for sidecar files.
- Drive virus-scan workaround: switched podcast feed download URLs from
  `drive.google.com/uc?export=download` to `drive.usercontent.google.com/download`
  which serves binaries directly for files > 25 MB.
- AbortSignal with 30 s timeout on OAuth token-exchange and refresh.

### Changed
- `extractAudioForPeaks` streams WAV to disk instead of accumulating in RAM.
  Peak memory for 3-hour recordings halved: 340 MB → 170 MB.
- rAF-coalesced waveform draw under mouse drag (60+ paints/sec → 1 per frame).
- Sticky header removed.
- Playhead snaps out of cut regions on click/drag-release.
- 8 unbounded stderr buffers capped.

### i18n
- Complete translations for Video, Varsler, Publisering tabs in all 7 languages.
- Tooltips and aria-labels follow language switching.
- 722 keys per language (up from 564).

---

## [4.34.0] — 2026-05-26

### Added
- **YouTube upload.** Publish video recordings directly to YouTube from the
  editor's export modal. Resumable upload protocol with 8 MB chunks, live
  progress. Defaults to `private` privacy.
- Reuses the existing Google OAuth client with a separate token under the
  `youtube` key so Drive and YouTube can be connected independently.

---

## [4.33.0] — 2026-05-26

### Added
- **Auto-analyse on file load** with suggestion banner: "Forslag klart —
  fjern X min før talen, Y min etter". One-click apply.
- **"Er ikke dette prekenen?"** dropdown lets the user override the auto-pick.
- Improved sermon detection: if only ONE long speech block exists, use it
  regardless of start time.
- Snap-to-segment when adjusting cut boundaries (Shift to disable).

---

## [4.32.0] — 2026-05-26

### Added
- **Playhead extends through intro/outro.** Click anywhere in the intro or
  outro slot to position the playhead there; audio playback starts from that
  exact offset.
- Keyboard shortcuts: Tab/Shift+Tab to jump cut boundaries, Home/End for
  absolute start/end including intro/outro, P to jump to detected sermon start.
- Timecode display shows "Intro 0:12" / "Outro 0:05" prefix.

---

## [4.31.0] — 2026-05-25

### Added
- **Editor UX overhaul.** Intro/outro now appear as dimmed waveforms on the
  same timeline as the main recording. Drag-and-drop intro/outro onto the
  left/right thirds of the timeline.
- "Analyser opptak" and chapter markers merged with speech/music/silence
  segment highlighting.
- Sticky editor header with filename + dirty indicator + close-file button.
- Empty-state with recent-files list (last 5 from history).
- Cmd/Ctrl+O / W / S / E + Delete keyboard shortcuts.
- "Eksporter og publiser" with cloud/podcast checkboxes.

### Changed
- Volume slider and audio-enhancements removed — record raw, post-process in
  editor with mastering presets + one-click "Normaliser lydnivå".
- "Avanserte valg" renamed to "Vekk maskin fra dvale" with honest sub-cards
  about platform-specific wake capabilities.
- Recording behaviour settings moved from Tidsplan to Filer.

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

[4.38.2]: https://github.com/richardfossland/sundayrec/releases/tag/v4.38.2
[4.38.1]: https://github.com/richardfossland/sundayrec/releases/tag/v4.38.1
[4.38.0]: https://github.com/richardfossland/sundayrec/releases/tag/v4.38.0
[4.37.0]: https://github.com/richardfossland/sundayrec/releases/tag/v4.37.0
[4.36.2]: https://github.com/richardfossland/sundayrec/releases/tag/v4.36.2
[4.36.1]: https://github.com/richardfossland/sundayrec/releases/tag/v4.36.1
[4.36.0]: https://github.com/richardfossland/sundayrec/releases/tag/v4.36.0
[4.35.4]: https://github.com/richardfossland/sundayrec/releases/tag/v4.35.4
[4.35.3]: https://github.com/richardfossland/sundayrec/releases/tag/v4.35.3
[4.35.2]: https://github.com/richardfossland/sundayrec/releases/tag/v4.35.2
[4.35.0]: https://github.com/richardfossland/sundayrec/releases/tag/v4.35.0
[4.34.0]: https://github.com/richardfossland/sundayrec/releases/tag/v4.34.0
[4.33.0]: https://github.com/richardfossland/sundayrec/releases/tag/v4.33.0
[4.32.0]: https://github.com/richardfossland/sundayrec/releases/tag/v4.32.0
[4.31.0]: https://github.com/richardfossland/sundayrec/releases/tag/v4.31.0
[4.30.1]: https://github.com/richardfossland/sundayrec/releases/tag/v4.30.1
[4.30.0]: https://github.com/richardfossland/sundayrec/releases/tag/v4.30.0
[4.29.0]: https://github.com/richardfossland/sundayrec/releases/tag/v4.29.0
[4.28.0]: https://github.com/richardfossland/sundayrec/releases/tag/v4.28.0
[4.27.2]: https://github.com/richardfossland/sundayrec/releases/tag/v4.27.2
[4.27.1]: https://github.com/richardfossland/sundayrec/releases/tag/v4.27.1
[4.27.0]: https://github.com/richardfossland/sundayrec/releases/tag/v4.27.0
[4.26.1]: https://github.com/richardfossland/sundayrec/releases/tag/v4.26.1
[4.26.0]: https://github.com/richardfossland/sundayrec/releases/tag/v4.26.0
