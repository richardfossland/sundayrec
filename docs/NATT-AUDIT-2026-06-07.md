# Natt-audit + diagnose-verktøy — 2026-06-07

Stor-scope gjennomgang av SundayRec: svakheter, bugs og effektivitet, pluss et
samlet diagnose-verktøy med feilkode-system. Alt under er committet på
`feat/windows-asio` og gate-grønt på mac (`npm run check` exit 0). Windows-only
kode (cpal-capture, Job Object) er ikke mac-kompilert — rigg-test gjenstår.

---

## 1. Samlet diagnose-verktøy + feilkode-system (hovedleveranse)

Det var flere forvirrende feilsøkings-funksjoner (preflight, diagnose, diagnose_audio,
ffmpeg_health, test-opptak). Nå:

- **Én «Diagnose»-knapp** (Innstillinger → Lyd) kaller `run_diagnostics`, som henter
  ALT: system, ffmpeg, lyd-/video-/ASIO-enheter, **sist brukt lyd-motor + evt.
  fallback-grunn**, ledig disk + mappe-skrivbarhet, mikrofon-/kamera-tilgang, **siste
  opptaksfeil** (leser `last-error.json`), og orphan-guard-status.
- **Feilkode-system (`SR-*`):** stabile koder med severity/tittel/detalj/hint —
  `SR-FFMPEG-01`, `SR-AUDIO-01/02/10`, `SR-VIDEO-01`, `SR-DISK-01/02`,
  `SR-PERM-01/02`, `SR-ENGINE-01`, `SR-OK`. Brukeren leser opp koden → support vet
  nøyaktig hva som er galt. Logikken (`detect_issues`) er ren + enhetstestet.
- UI: fargekodede funn + «📋 Kopier full rapport» (markdown) + lagret-sti.

Beholdt som egne hurtigsjekker: Home «Kjør sjekk» (preflight go/no-go) og
«Test-opptak» (10 s capture). Diagnose er den uttømmende støtte-rapporten.

**Kodefiler:** `crates/sundayrec-core/src/diagnostics.rs`,
`src-tauri/src/diagnostics/mod.rs`, `commands/diagnostics.rs`, `legacy/renderer`
(api-shim + audio-page + styles).

---

## 2. Bugs funnet + fikset

| #   | Alvor  | Funn                                                                                                                                                                                   | Fiks                                                                          |
| --- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| B1  | Høy    | Informative `cpal_fallback`/`feature_unsupported_asio` ble emittet som fatal `recording://error` → frontend rev ned opptaks-UI (hideOverlay+stopMonitoring) MIDT i et pågående opptak. | Sluttet å emitte dem som feil; logges + havner i lyd-motor-status (diagnose). |
| B2  | Høy    | Data-tap: Windows concat `atomic_replace` brukte copy+unlink — krasj midt i kopiering ga korrupt leveranse.                                                                            | `rename` (atomisk på samme volum) med copy-fallback kun hvis rename feiler.   |
| B3  | Medium | Planlegger restartet supervisor i det uendelige ved vedvarende panic, kun med en loggrad.                                                                                              | Teller raske restarter → systemvarsel etter 3 + backoff til 30 s.             |

**Verifisert IKKE et problem (ingen endring):** `chunks_exact` i cpal-callbacken
(input leverer alltid hele frames); to-prosess-orphans (dekkes nå av Job Object);
`stop()`-«deadlock» (grace-timer + abort→Drop→kill_on_drop dreper ffmpeg; Job
Object backer det). Disse var overdrevne funn fra auditen.

---

## 3. Effektivitet

- **Fikset:** device-enumerering for UI-velgeren caches 1,5 s (`enumerate_ffmpeg_
devices_cached`) — folder velgerens lyd+video-kall til én `ffmpeg -list_devices`
  (treg på Windows dshow). Record/diagnose forblir ucachet (ingen staleness der
  det betyr noe).
- **Dokumentert, ikke endret** (staleness/race-risiko jeg ikke vil innføre uten
  rigg-test):
  - Forhåndsvisnings-JPEG leses i sin helhet ved hver poll (forventet — bildet
    vises; men kunne lese bare header for dimensjoner). `commands/recorder.rs`.
  - Planleggeren laster `settings::load` hver supervisor-runde — kunne caches med
    revisjon + reschedule-signal. `scheduler/mod.rs`.
  - Live-side: 1 s uptime-timer + 2 s preview-reload — kosmetisk churn, kunne
    drives av `stream-stats`-eventet. `live-page.ts`.
  - VU sampler 30 fps alltid-på når aktiv — kunne lazy-startes/bakgrunns-droppes.

---

## 4. ASIO + WASAPI-fallback (verifisert)

Rutingen i `engine.start()` er korrekt: cpal for ASIO + enkle opptak, dshow
`run_session` for vanlig enhet som trenger preroll/split/stillhet, ASIO+slik →
varsel. cpal-start-feil → automatisk dshow-fallback. Hvilken motor som faktisk ble
brukt + fallback-grunn registreres nå og vises i Diagnose (`SR-AUDIO-10`). cpal-WASAPI
er shared-mode (full multikanal krever ASIO — forventet).

---

## 5. Frontend-paritet (verifisert + fikset)

- `list_audio_devices`/`list_audio_input_channels` wiret + brukt ✅
- `classicDirectshow`-bryter: round-trip OK ✅
- ASIO-badge + kanalvelger ✅
- B1 (over) rettet feilbehandlingen av informative events ✅
- `runDiagnostics` wiret til ekte backend (var stub) ✅

---

## 6. Gjenstår (rigg / senere)

- **Windows rigg-test** av all cpal/ASIO + Job Object + diagnose (se
  `ASIO-TEST-MATRIX.md`, `WINDOWS-PROCESS-HYGIENE.md`).
- Valgfrie effektivitets-opts i §3 (krever rigg-test).
- Krasj-recovery på cpal-stien (dokumentert begrensning).
- `recording://levels` fra backend brukes ikke av overlay-meteret (klient-side
  Web Audio dekker WASAPI; ASIO-opptak mangler in-recording-meter — H1 emitteres
  men ikke konsumert; lavt prioritert).
