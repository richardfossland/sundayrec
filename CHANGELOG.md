# Changelog

All notable changes to SundayRec are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [4.53.7] — 2026-05-27

### Refactored — IPC-splitting fase 7 (app-system + files)

**Nye filer:**
- `ipc/app-system.ts` — 6 handlers (get-platform, get-app-version,
  get-settings, get-logs, get-log-file-path, run-diagnostics)
- `ipc/files.ts` — 5 handlers (pick-folder, open-folder, reveal-file,
  pick-audio-file, register-trusted-path)

**Resultat:** index.ts under 1000 linjer!
- index.ts: **1042 → 996 linjer** (kumulativ fra v4.53.0:
  2045 → 996 = **−51 %**, mer enn halvert)
- 115 handlers flyttet ut totalt (av ~127)
- Bare 8 handlers igjen i index.ts: install-update, save-settings,
  export/import/reset-profile, youtube-upload, podcast-regenerate,
  cloud-is-configured. Disse har for tette closure-koblinger til
  modul-state for å flyttes uten å eksponere mange setters.
- 1080 tester fortsatt grønne

### IPC-arkitektur (oversikt)
```
src/main/ipc/
├── types.ts              IpcContext (mainWindow getter + sendBackendWarning)
├── gmail.ts              3 handlers
├── youtube.ts            3 handlers
├── stream.ts             8 handlers
├── cloud.ts              11 handlers
├── thumbnail.ts          6 handlers
├── whisper.ts            6 handlers
├── master.ts             5 handlers
├── video-preview.ts      3 handlers
├── review-queue.ts       7 handlers
├── editor.ts             21 handlers
├── wake.ts               12 handlers
├── history.ts            5 handlers
├── recording.ts          6 handlers
├── audio-devices.ts      3 handlers
├── transcript.ts         2 handlers
├── email-webhook.ts      3 handlers
├── app-system.ts         6 handlers
└── files.ts              5 handlers
                          ─────────
                          115 handlers (av ~127 totalt)
```

---

## [4.53.6] — 2026-05-27

### Refactored — IPC-splitting fase 6 (transcript + email)

**Nye filer:**
- `ipc/transcript.ts` — 2 handlers (transcript-list-all,
  transcript-resolve-source — søkearkivet)
- `ipc/email-webhook.ts` — 3 handlers (test-webhook, test-email,
  clear-smtp-password — varsel-test fra innstillinger)

**Resultat:**
- index.ts: **1148 → 1042 linjer** (kumulativ fra v4.53.0:
  2045 → 1042 = **−49 %**, halvert!)
- 104 handlers flyttet ut totalt (av ~127)
- Bare 19 handlers igjen i index.ts (system/app, files, et par cloud)
- 1080 tester fortsatt grønne

---

## [4.53.5] — 2026-05-27

### Refactored — IPC-splitting fase 5 (recording + audio-devices)

**Nye filer:**
- `ipc/recording.ts` — 6 handlers (start/stop-recording-now,
  run-test-recording, run-preflight, get-next-recording, get-disk-space)
- `ipc/audio-devices.ts` — 3 handlers (list-asio-drivers,
  list-ffmpeg-audio-devices, diagnose-audio)

**Resultat:**
- index.ts: **1246 → 1148 linjer** (kumulativ fra v4.53.0:
  2045 → 1148 = **−44 %**)
- 99 handlers flyttet ut totalt (av ~127)
- 1080 tester fortsatt grønne

---

## [4.53.4] — 2026-05-27

### Refactored — IPC-splitting fase 4 (wake + history)

Flyttet to mindre domener ut av `src/main/index.ts`.

**Nye filer:**
- `ipc/wake.ts` — 12 handlers (schedule-os-wakes + fix-mac-sleep +
  wake-detect-capabilities + wake-test + wake-failure-history mfl.)
- `ipc/history.ts` — 5 handlers (get/delete/clear/prune + update-note)

**Resultat:**
- index.ts: **1294 → 1246 linjer** (kumulativ fra v4.53.0:
  2045 → 1246 = **−39 %**)
- 90 handlers flyttet ut totalt (av ~127)
- 1080 tester fortsatt grønne

---

## [4.53.3] — 2026-05-27

### Refactored — IPC-splitting fase 3 (editor)

Flyttet hele editor-domenet ut av `src/main/index.ts` til
`src/main/ipc/editor.ts`. Ingen funksjonelle endringer.

**21 handlers flyttet** (alle `editor-*`):
- File ops: read-file, save-file, pick-file, export-file, cancel-export,
  pick-output-folder
- Metadata sidecar: read-meta, save-meta
- Cuts-draft sidecar (crash recovery): read/save/delete
- Segments: detect-segments
- Video editor: set-video-path, extract-audio-peaks, probe-streams,
  pick-video-file, save-video, export-video
- Transcript sidecar: read/write/delete-transcript

**EditorIpcContext** utvider basis `IpcContext` med fem helpers fra
index.ts (`isAllowedAudioPath`, `isAllowedMediaPath`, `sidecarPath`,
`trustFolder`, `setEditorVideoPath`). `currentEditorVideoPath` blir
fortsatt i index.ts fordi `editor://`-protokollhandleren leser den
direkte fra modulscope.

**Resultat:**
- index.ts: **1488 → 1294 linjer** (denne fasen: −13 %, kumulativ
  fra v4.53.0: 2045 → 1294 = **−37 %**)
- 73 handlers flyttet ut totalt (av ~127)
- 1080 tester fortsatt grønne

---

## [4.53.2] — 2026-05-27

### Refactored — IPC-splitting fase 2

Fortsatte mekanisk flytting av IPC-handlers ut av `src/main/index.ts`
til domene-spesifikke filer i `src/main/ipc/`. Ingen funksjonelle
endringer for brukeren.

**Nye filer:**
- `ipc/thumbnail.ts` — 6 handlers (set/clear/resolve default + episode)
- `ipc/whisper.ts` — 6 handlers (status, download, transcribe + cancel)
- `ipc/master.ts` — 5 handlers (presets, preview, measure, apply, cancel)
- `ipc/video-preview.ts` — 3 handlers (list-cameras, start, stop)
- `ipc/review-queue.ts` — 7 handlers (list, get, update, discard, publish)

**Resultat:**
- 27 nye handlers flyttet ut (totalt 52 fra fase 1 + 2)
- `index.ts`: **1792 → 1488 linjer** (denne fasen alene: −17 %, kumulativ
  fra v4.53.0: 2045 → 1488 = **−27 %**)
- 1080 tester fortsatt grønne

**Mønster:** hver ipc-fil eksporterer `registerXxxIpc(ctx)`. Domener
som trenger ekstra context (path-guard, tray-helper) utvider
`IpcContext` med flere felt i sin egen `XxxIpcContext`.

### Gjenstår i index.ts
- editor-* (~17 handlers)
- wake-*, schedule-* (~9 handlers)
- recording-related (~5 handlers)
- system/app (~15 handlers) — get-platform, save-settings, history-ops, etc

Kommer i fremtidige sesjoner.

---

## [4.53.1] — 2026-05-27

### Refactored — IPC-handlers begynt å splittes per domene

`src/main/index.ts` var ~2045 linjer med ~127 `ipcMain.handle()`-kall
i én megafunksjon. Mønster etablert for å splitte etter domene:

- **`src/main/ipc/types.ts`** — felles `IpcContext`-interface med
  `mainWindow` (via getter for crash-recovery) + `sendBackendWarning`
- **`src/main/ipc/gmail.ts`** — 3 handlers (connect/disconnect/status)
- **`src/main/ipc/youtube.ts`** — 3 handlers (connect/disconnect/status)
- **`src/main/ipc/stream.ts`** — 8 handlers (stream-* + overlay-*)
- **`src/main/ipc/cloud.ts`** — 11 handlers (cloud-* connect/upload/queue)

Totalt: **25 handlers flyttet ut**, **index.ts redusert fra 2045 til
1792 linjer** (~12 % mindre). Mønsteret er klart for resten av domener
(editor, master, thumbnail, whisper, review-queue, etc) — kommer i
fremtidige sesjoner.

### Internt
- 1080 tester fortsatt grønne — ingen behavior-change
- `youtube-upload` beholdt i index.ts foreløpig pga avhengighet av
  `isAllowedMediaPath`-helperen (sikkerhetsguard); flyttes når den
  helperen blir delt utility
- Pattern: `registerXxxIpc(ctx)` tar context, kaller ipcMain.handle
  direkte — ingen new abstraktion, bare flytting

---

## [4.53.0] — 2026-05-27

### Refactored — konsolidert gjeld fra audit-runden

Trygge konsolideringer av kode som tidligere hadde drifted i ulike
retninger. Ingen funksjonelle endringer for brukeren — alt skal
oppføre seg identisk, men koden er nå mer vedlikeholdbar.

#### 1. Én konsolidert error-klassifiserer
- `recorder-utils.ts` har nå `classifyRecordingError()` som single
  source of truth med alle audio + video patterns.
- `native-recorder.classifyFfmpegError` og `video-recorder.classifyVideoError`
  delegerer nå hit (eksisterende exports beholdt for test-kompatibilitet).
- `unified-recorder` bruker den direkte i stedet for å kombinere to
  klassifiserere selv.
- Fjernet ~80 linjer duplikat-kode på tvers av 3 filer.

#### 2. Sentraliserte timeouts
- `RECORDER_TIMEOUTS` i `recorder-utils.ts` samler:
  `startupMs`, `stuckProgressMs`, `stuckPollMs`,
  `reconnectMaxDelayMs`, `progressThrottleMs`, `ndiStopTimeoutMs`.
- native-recorder, unified-recorder og streamer bruker dem nå —
  tidligere var disse spredt som magic numbers i 5+ filer.

#### 3. Token-refresh konsolidert
- `gmail-auth.refreshGmailToken` slettet — bruker nå den delte
  `refreshAccessToken('google-drive', ...)` fra `cloud/oauth.ts`.
  Samme Google OAuth-endepunkt og samme client_id/secret-par dekker
  Drive + Gmail + YouTube. invalid_grant-detection nå konsekvent
  på tvers av alle tre.
- YouTube brukte allerede den delte (siden v4.50). Gmail var siste
  duplikatet — nå borte.

#### 4. Progress-callback i alle cloud-services
- `uploadFile()` i Google Drive, Dropbox og OneDrive aksepterer nå
  en valgfri `onProgress(uploaded, total)`-callback per chunk.
- YouTube hadde den allerede — nå er API'et konsistent på tvers av
  alle fire cloud-targets.
- UI-kobling (status-bar med faktisk progress per fil) kan kobles inn
  i en oppfølger — infrastrukturen er klar.

### Internt
- 1080 tester fortsatt grønne (ingen behavior-change)
- Recorder/streamer-modulene har nå konsistent import-tilstand fra
  `recorder-utils.ts` (single source of truth)

### Roadmap (fortsatt utsatt)
- IPC-handler-splitting (~95 handlers i index.ts → ipc/<domain>.ts) —
  stort mekanisk arbeid, egen sesjon med fokus
- HTML-modulering (2200 linjer monolitt)
- CSS-modulering (4100 linjer flat fil)
- editor-page.ts state-konsolidering (50+ module-level let)

---

## [4.52.0] — 2026-05-27

### Fixed — Konsoliderte audit-funn (5 parallelle Explore-agenter)

Dyp arkitektur-audit avdekket flere kritiske stabilitets-bugs som ville
ha kommet opp i produksjon. Adressert i denne releasen:

#### 🚨 Opptak-stack
- **Adapter ignorerte `lastError`.** Recorder.ts pakket unified-handle
  som NativeHandle med `lastError: null` hardkodet. Når unified
  klassifiserte en fatal feil (disk_full, device_disconnected),
  watchdog så «ingen feil» og loopet reconnect 20 ganger på det som
  egentlig burde vært fail-stop. Nå brukes en getter som forwarder
  unified.lastError live til adapter — samme i både start-pathen og
  reconnect-pathen.
- **`classifyVideoError` for audio-feil.** Unified-prosessen kan
  rapportere både audio og video stderr på samme stream, men
  klassifisereren matchet kun video-mønstre. Audio-mikrofon-
  disconnect ble feilkategorisert som `device_error` (generisk) i
  stedet for `device_disconnected` (skulle trigge reconnect). Ny
  `classifyUnifiedError` kombinerer begge.

#### 🚨 Streaming/NDI
- **NDI-receiver-stop hadde ingen timeout-guard.** Hvis libndi var
  deadlocked, `stopActiveNdiReceivers()` kunne blokkere stream-stop
  evig. Nå races hver receiver.stop() mot en 2 s timeout — vi
  foretrekker en lekket receiver over en frosset renderer.
- **`alsoRecord` registrerte 1KB-filer som gyldige opptak.** Earlier
  threshold på 1 KB lot ffmpegs MP4-header (moov+mdat-skjelett uten
  faktiske frames) gjennom. Hevet til 100 KB så history bare får
  filer med faktisk video.
- **`alsoRecord` brukte wall-clock for varighet.** Avvek 100-300 ms
  fra faktisk video-lengde pga kamera-warmup. Nå probes MP4-en
  via ffmpeg metadata for nøyaktig varighet, faller tilbake til
  wall-clock hvis det feiler.

#### 🚨 Editor/transcript
- **whisper-cancel kunne henge progress-modal.** Cancel-IPC var
  fire-and-forget uten error-håndtering, så hvis main-prosessen var
  midt i restart eller hadde unngått å re-registere handler,
  feilet IPC og modal stod fast. Nå wrappes begge cancel-call i
  catch + en 1.5 s safety-timer hard-lukker modal'en uansett.

#### 🚨 Renderer
- **Save-settings hadde ingen debounce.** Slider/text-input som
  sendte `save-settings` per keystroke utløste scheduler.reschedule
  + wake.reschedule + login-item-update + preroll-restart per
  keystroke — disk-thrashing og potensielle race conditions. Ny
  `saveSettingsDebounced()` helper i `state.ts` collapser rapid
  endringer til én IPC-roundtrip per ~400 ms. live-overlays.ts
  byttet til den delte helperen (og kan deles til flere pages senere).

### Internt
- 5 parallelle Explore-agenter analyserte opptak, sky, editor,
  streaming og renderer-arkitektur
- Konsolidert rapport med 30+ funn klassifisert som 🚨 KRITISK
  / 🔧 REFAKTOR / 💡 MULIGHET
- v4.52.0 dekker alle 🚨 KRITISK-funn
- 🔧 REFAKTOR-gjeld (3 ulike error-klassifiserere, YouTube duplikat
  PKCE, 50+ module-level let i editor-page, IPC-monolitt) flagget
  for fremtidige iterasjoner

---

## [4.51.0] — 2026-05-27

### Changed — Unified-pipeline er nå default

«Perfekt A/V-synk» (unified-ffmpeg-pathen) er nå **default ON** for alle
brukere. Eksperimentell-merket er fjernet. Etter v4.49–v4.50 har den
hatt reconnect, preroll og split-recording — funksjonelt på samme nivå
som den gamle to-prosess-pathen, og med garantert perfekt A/V-sync fra
første frame.

**Hvem påvirkes:**
- Nye installasjoner får unified ON som default
- Eksisterende brukere som aldri har rørt toggle (vanlig) får unified
  ON automatisk ved oppdatering
- Eksisterende brukere som EKSPLISITT slo den av forblir med den av

**Hvis du vil opt out:** Innstillinger → Video → slå av «Perfekt A/V-synk».
Toggle-en finnes fortsatt for power-users som måtte hit en uventet
edge-case og vil tilbake til legacy-pathen midlertidig.

### Internt
- `recorder.ts`: `s.useUnifiedRecorder !== false` (undefined = ON) i
  stedet for `!!s.useUnifiedRecorder` (undefined = OFF)
- `video-page.ts`: samme tristate-check så toggle viser default-state riktig
- HTML: `checked`-attributt så fresh DOM-load matcher default
- i18n oppdatert i 7 språk — fjernet «eksperimentell»-tekst, omformulert
  beskrivelse til «Anbefales på»-fokus

---

## [4.50.1] — 2026-05-27

### Added — Split-recording i unified-modus
Auto-restart hver N minutter fungerer nå når «Perfekt A/V-synk» er på.
Hvert segment er en ferdig kombinert MP4 — ingen mux-step trengs.

**Hvordan det virker:**
- Når split-timer fyrer: graceful 'q' sendes til unified-ffmpeg via
  stdin (samme stop-path som dagens recorder)
- finishSessionAsync ser session.unified=true → skipper mux-step
- splitAutoRestart kaller startSession på nytt — den nye sesjonen
  bruker også unified siden settings.useUnifiedRecorder bevares
- Hvert segment lagres som egen kombinert MP4 i samme mappe

### Fixed
- **Stop-flyt for unified-ffmpeg gjorde 10 sek venting i split-restart.**
  Tidligere spawnet unified-recorder med `stdio: ['ignore', ...]` + ffmpeg
  `-nostdin`, så stopCapture's graceful 'q' via stdin var no-op og falt
  tilbake til SIGTERM etter 10 sek timeout. Endret til `stdio: ['pipe',
  ...]` uten `-nostdin` så 'q' funker → split-rotasjon er nå nesten
  øyeblikkelig.
- **Cloud-auto-upload for unified+keepAudio=false** lastet opp en
  ikke-eksisterende audio-fil. Sender nå den kombinerte MP4-en i stedet.

---

## [4.50.0] — 2026-05-27

### Added — «Logg inn med Google» for e-postvarsel

E-postvarsler kan nå sendes via Gmail API i stedet for SMTP. Slipp
app-passord, smtp.gmail.com, og portnummer-juggling.

**Slik virker det:**
1. Innstillinger → Varsler → E-postvarsler
2. Slå PÅ «Send e-post ved feil» og fyll inn mottakeradressen
3. Under «SENDEMETODE» — klikk **«Koble til»** ved siden av Google-logoen
4. Logg inn i Google's consent-skjerm i nettleseren
5. Ferdig — kortet viser nå «Sender via din@gmail.com»

SMTP-feltene er flyttet til en **«Avansert»-utfellbar** under Gmail-
kortet, så kirker med egen mail-server fortsatt kan bruke dem. Når
Gmail er tilkoblet, kollapses Avansert-seksjonen automatisk.

### Architecture
- `src/main/cloud/gmail-auth.ts` — connect/disconnect/status + token-refresh
- `mailer.ts` — Gmail API send-path med base64url-kodet RFC 2822 message
- IPC: `gmail-connect`, `gmail-disconnect`, `gmail-status`
- Token lagret i samme krypterte vault som Drive/Dropbox/OneDrive
- Scope: `gmail.send` (sensitive — krever App Review for offentlig
  distribusjon, se `docs/USER-TASKS.md`)

### Internt
- 11 nye i18n-nøkler i 7 språk (no/en/de/sv/da/pl/fr)
- `email-oauth-card` med Google-logo + connect/disconnect-state
- `details/summary` for Avansert SMTP — collapsed by default når Gmail er på

---

## [4.49.1] — 2026-05-27

### Added — Reconnect + preroll i unified-modus

Følger opp v4.49.0 (unified ffmpeg-pipeline) med to hovedfeatures
som tidligere kun fungerte i to-prosess-pathen:

- **Reconnect i unified.** Hvis kameraet eller mikseren mister
  tilkobling mid-opptak, spawnes nå en NY unified-ffmpeg som åpner
  begge enheter på nytt. Reconnect-segmentet legges til
  `session.segments` slik at den eksisterende mergeSegments-koden
  stitcher det inn ved finalize. Samme 20-forsøk-med-exponential-
  backoff som dagens path — opptil ~3 min vindu for å håndtere en
  USB-kabel-knekk.

- **Preroll i unified (med separat audio-fil).** Når brukeren har
  «Behold separat lydfil» PÅ, prepender preroll-WAV som vanlig på
  den separate audio-filen (samme applyPreroll-vei som dagens
  to-prosess-mode). Hvis brukeren har slått av separat audio, logges
  en advarsel og preroll skippes — å embedde preroll inn i den
  kombinerte MP4-en krever sin egen mux-pass og kommer i v4.50.

### Architecture
- `recorder.ts:tryReconnect` har nå en unified-branch som spawn'er
  ny unified, lager handle-adaptere som peker på samme ffmpeg-proc,
  og kobler callbacks til renderer (preview-frame + progress).
- `finishSessionAsync` har nytt fallback: `unified && !keepAudio →
  skip preroll med log-advarsel` (i stedet for å feile).

---

## [4.49.0] — 2026-05-27

### Added — Unified ffmpeg-pipeline (eksperimentell)

**Definitiv A/V-sync-fix.** Innstillinger → Video har en ny toggle
«Perfekt A/V-synk (eksperimentell)». Når aktivert spawnes ÉN ffmpeg-
prosess som åpner kamera + mikser samtidig:

- **macOS**: AVFoundation `videoIdx:audioIdx`-syntaks — én `-i` med
  begge enheter
- **Windows**: dshow med to `-i` (video + audio) i samme prosess
- **Outputs**: kombinert MP4 (H.264 + AAC) + valgfri lossless separat
  audio i samme ffmpeg via multi-output mapping

Fordi begge streams deler samme interne klokke fra første packet,
har det:
- Ingen oppstart-offset (mux-stepets probe-and-correct er overflødig)
- Ingen drift over tid (audio/video bruker samme tidsbase)
- Ingen reconnect-race mellom to separate prosesser

**Default OFF** til vi har timer-på-det confidence. Brukere som har
opplevd sync-drift kan opte inn via Settings → Video.

### Architecture
- `src/main/unified-recorder.ts` (ny) — `startUnifiedCapture` med
  separate Mac/Win input-bygging og delt spawn-helper
- `src/main/recorder.ts` — branch i `startSession`: når
  `useUnifiedRecorder && hasVideo`, spawn unified med to handle-
  adaptere som peker på samme proc, slik at watchdog + stop + finalize
  ser samme livssyklus som dagens to-prosess-path
- Mux-stepet skippes automatisk når sesjonen er unified (filen er
  allerede kombinert i én ffmpeg)
- Stop drepe én prosess som dropper begge streams atomisk

### Internt
- i18n for «Perfekt A/V-synk (eksperimentell)»-toggle i no/en/de/sv/da/pl/fr
- Type `Settings.useUnifiedRecorder` lagt til
- Reconnect, split-recording og preroll støttes IKKE i unified-modus
  enda (slås av automatisk når flagget er på). Roadmap for v4.50.

---

## [4.48.1] — 2026-05-27

### Fixed — A/V-sync i opptak

Brukeren rapporterte at lyd og bilde ikke var helt synket i video-opptak.
Sync-korreksjonen i mux-stepet er nå langt mer robust:

- **Håndterer offset i BEGGE retninger.** Tidligere ble bare «audio
  startet før video» (vanlig fordi kamera er treigere å varme opp)
  korrigert. Hvis en USB-mikser var tregere enn kameraet (motsatt
  retning), ble offsetten ignorert. Nå brukes `-itsoffset` for å
  forsinke audio når video led.
- **Drift over tid korrigeres med `aresample=async=1000`.** Audio-
  klokka og video-klokka kan drifte fra hverandre med en del
  millisekunder per minutt — over en 90-min-gudstjeneste blir det
  hørbart. aresample setter inn / fjerner inntil 1000 samples per
  sekund inkrementelt for å holde tidsbasen stabil. Uhørbart ved
  normale snakke-volum.
- **`-shortest` så audio ikke henger ut.** Tidligere kunne audio-
  ffmpeg fortsette et øyeblikk etter video-ffmpeg var ferdig, og
  outputten viste frosset siste-frame mens lyden fortsatte. Nå
  stopper muxeren i det den korteste streamen slutter.
- **`-fflags +genpts` regenererer PTS uniformt** — beskytter mot
  PTS-hull etter en reconnect midt i opptak.
- **Robustere start-time-deteksjon.** Når container-level
  `start_time` mangler (sjelden men forekommer på enkelte
  AVFoundation-konfigurasjoner), faller vi nå tilbake til
  `first_dts` på stream 0.

Roadmap: full unified-ffmpeg-pipeline (én ffmpeg som åpner BÅDE
kamera og mikser via AVFoundation `videoIdx:audioIdx`) er den
endelige løsningen — den eliminerer alle to-prosess-sync-issuer
ved roten. Egen sesjon med fokus på refaktor av recorder-pipelinen.

---

## [4.48.0] — 2026-05-27

### Added
- **Live kamera-preview FØR du klikker Start** på Direktesending-fanen.
  Tidligere var preview-vinduet svart helt til strømmen kom i gang —
  nå ser du kameraet idle med en gang du går inn på fanen, så du kan
  ramme inn motivet før du går live. Preview stoppes automatisk når
  strømmen starter (avfoundation låser kameraet eksklusivt) og
  restartes når strømmen stopper.
- **«Logg inn med Google» for e-postvarsel** (backend ferdig, UI nesten):
  bytt SMTP-konfigurasjon med å koble inn Google-kontoen din direkte.
  Sender e-poster via Gmail API i stedet for SMTP-server. Ingen
  app-passord eller server-navn. SMTP beholdes som «Avansert» for
  brukere med egen mail-server. Krever `gmail.send`-scope i Google
  OAuth-appen (App Review).

### Changed
- **Info-kort-rekkefølge i video-modus.** Sidekolonne på Hjem stables
  nå som: Lydkilde → Kamera → Videokvalitet → Lagring → Format
  (matcher logisk «hva spilles inn» → «hvor lagres det»-flyt).
- **Disabled Live-knapp er nå dempet rød** i stedet for grå/mørk —
  matcher Hjem-skjermens «Start opptak»-knapp så den røde
  call-to-action-fargen forblir konsistent på tvers av fanene.
- **Opptak-overlay: video fyller hele ramma.** Den sorte letterboxen
  rundt opptaks-preview i recording-overlay er borte. Bytte fra
  `object-fit: contain` til `cover` så kameraet fyller hele
  rammen — bevarer den dynamiske aspect-ratio-en så ingenting
  bli unaturlig strukket.

---

## [4.47.2] — 2026-05-27

### Changed
- **Pen Avbryt-knapp i sky-tilkobling-flyten.** Den hvite, full-bredde
  Avbryt-knappen som dukket opp under «Kobler til…» kontrastert stygt
  mot den mørke layouten. Erstattet med en sentrert, smalere
  transparent-med-border-knapp som matcher resten av designet.

### Docs
- **`docs/USER-TASKS.md`** — ny fil som dokumenterer alt jeg ikke kan
  fikse fra koden, med konkrete steg-for-steg-instruksjoner for å få
  full produksjons-API hos Google, Dropbox og OneDrive. Bekreftet at
  Google og Dropbox blokker innlogging i dag pga Testing/Development
  status — denne fila har både kjapp-fiks og permanent App Review-
  prosess for hver tjeneste.

---

## [4.47.1] — 2026-05-27

### Fixed
- **Native NDI fungerer nå på Intel-Mac.** v4.44.0 bygget grandiose-
  native modulen kun for current arch på CI-runneren (arm64), så
  Intel-Mac-installasjoner fikk arch-mismatch ved første NDI-overlay.
  `scripts/build-grandiose.sh` bygger nå arm64 + x86_64 separat og
  lipo-kombinerer til en universal `.node`. libndi.dylib har vært
  universal hele tiden — bare bindingen manglet x86_64-slicen.

### Internt
- Bekreftet via `lipo -info`: `grandiose.node` rapporterer nå
  `x86_64 arm64` (fat). Loader klare på begge Mac-arkitekturer.

---

## [4.47.0] — 2026-05-27

### Sikkerhet
- **OAuth state-replay-vern.** Hver state-verdi kan nå konsumeres maks
  én gang per app-sesjon. Defensive depth — selv om state-match-sjekken
  i sin tid skulle bli omgått, ville en replay nå bli avvist eksplisitt.
  TTL 10 min, capped på 256 state-verdier i minnet.

### Performance
- **editor-page: `getLayoutGeom`-cache.** Funksjonen ble kalt to ganger
  per mousemove-event (én gang i `xToSec`, én gang i `xToMainSec`) over
  hele drag-paths. One-slot cache med stable key betyr at kun den
  første kallet i et rAF-vindu faktisk regner geometrien — resten er
  rene cache-hits.
- **prep-episode: sermon-only deteksjon i ett pass.** Refaktorerte
  «sermon-only»-saken fra 5 separate iterasjoner (filter + 3 reduce +
  findIndex) til én walk gjennom segmentene. Samme resultat, en
  fjerdedel av jobben.

### Bug-fixes
- **Streamer race-condition i auto-recover.** `streamStartedAt` ble
  brukt i close-handler for å beregne lokal-opptak-varigheten — men
  modul-nivå-variabelen kunne bli overskrevet av en auto-restart før
  close-handleren rakk å kjøre. Nå brukes en closure-fanget kopi per
  ffmpeg-prosess.

### Internt
- **Dokumentert atomic upload-queue-writes.** electron-store 11 → conf 15
  bruker `atomically`-pakken under hetten (tmp-skriving + fsync +
  rename), så hard crash midt i `save()` etterlater aldri queue-fila
  korrupt. Lagt til kommentar slik at framtidige auditer ikke flagger
  det igjen som «mulig korrupsjon ved crash».
- **18 OAuth-tester** (+1 ny for replay-vernet).

---

## [4.46.0] — 2026-05-27

### Added
- **Direktesending lagrer nå lokalt opptak samtidig.** Hovedknappen på
  Direktesending-fanen er nå «🔴 Start direktesending + opptak» — den
  pumper samme ffmpeg-pipeline både til RTMP-destinasjonene OG en
  lokal MP4-fil med høyere bitrate (~60 % over livestream-bitraten).
  Lokal fil havner i Siste opptak når strømmen stopper, klar for
  redigering eller podkast-publisering. Sekundær-knapp «Bare
  direktesending (uten lokal opptak)» for de få tilfellene man
  bare vil streame.

### Cloud / sky-robustifisering
- **OneDrive**: forbedret parsing av `nextExpectedRanges` ved retry.
  Walker nå hele arrayet og velger laveste start-byte (i stedet for
  første). Støtter også åpne ranges (`START-`) per Graph API-spec.
- **YouTube**: hver chunk-PUT går nå gjennom `withRetry` med
  exponential backoff. 5xx-feil og 429 (rate limit, med
  Retry-After) prøves automatisk på nytt opptil 5 ganger uten å
  avbryte hele opplastingen.

### Performance
- **audio-analysis.ts**: bytte unbounded `Buffer.concat` til fast
  pre-allokert pending-buffer med write-offset. Sermon-analyse av
  3-timers gudstjeneste sparer millioner av små Buffer-allokeringer
  og merkbart GC-press.

---

## [4.45.0] — 2026-05-27

### Changed
- **Kamera-velger flyttet til toppen av video-feeden** på hjem-skjermen.
  Pener visuell hierarki: «velg kilde» → preview → Lydnivå.

### Added
- **Tre nye smart-synlige kort på hjem-skjermen** — vises kun når
  innstillingen faktisk er konfigurert, så ferske brukere får ikke en
  vegg av tomme kort:
  - **Sky-backup** — viser hvilke tjenester (Drive/Dropbox/OneDrive)
    som er aktive, og kø-status («Alle synkronisert», «X i kø»,
    «X feilet»). Klikk → Publisering.
  - **Episodebilde** — viser miniatyrbilde av default cover art som
    brennes inn i podcast-MP3. Klikk → Publisering.
  - **Transkripsjon** — viser installert Whisper-modell og kvalitet.
    Klikk → Publisering.

---

## [4.44.0] — 2026-05-27

### Added
- **Native NDI-mottaker — fungerer som i OBS.** Du kan nå velge NDI som
  overlay-kilde og motta video direkte fra EasyWorship 7.3+, ProPresenter
  7 (inkludert Alpha Key for ekte gjennomsiktige overlays!), OBS NDI
  Output, eller Keynote/PowerPoint via NDI Screen Capture HX. Discovery
  oppdager kilder automatisk på det lokale nettverket (~2 sekunder),
  uten ekstra programvare som måtte installeres.
- **Vendoret grandiose** (Node-bindinger til libndi) ligger nå i
  `vendor/grandiose/` med custom build-script som håndterer path-med-
  mellomrom-feilen i grandiose sin binding.gyp. libndi-runtime (~28 MB
  Mac dylib, tilsvarende Windows DLL) følger med installeren.

### Setup-guide (per program)
- **EasyWorship 7.3+:** Edit → Options → Live → Alternate Output →
  «NDI Stream». Krever Private network på Windows.
- **ProPresenter 7:** Screens → Ny NDI-skjerm. For lower-thirds:
  åpne Alpha Key-fanen og enable. SundayRec mottar gjennomsiktig
  output direkte.
- **OBS Studio:** Installér NDI Output-pluginen. Tools → NDI Output
  Settings → Enable Main Output. Resten er automatisk.
- **Keynote/PowerPoint:** Last ned gratis NDI Tools fra ndi.video.
  Kjør «NDI Screen Capture HX» og pek mot Keynote/PowerPoint-vinduet.
- **Chroma key:** Aktiver per-overlay for å bli kvitt grønn/sort
  bakgrunn (tradisjonell green screen) — ProPresenter Alpha Key
  trenger IKKE chroma key fordi den allerede sender ekte transparens.

### Architecture
- NDI-frames piped til ffmpeg via loopback TCP (`tcp://127.0.0.1:<port>`)
  med `-f rawvideo` input. Pixel-format auto-detekteres til UYVY (uten
  alpha) eller BGRA (med alpha). Én receiver per overlay, ryddes opp
  automatisk ved stopp av direktesending.

### Testing
- 1 ny test for NDI input-args bygging (1079 totalt). Smoke-test for
  source discovery i `scripts/test-ndi.js`.

---

## [4.43.1] — 2026-05-27

### Fixed
- **Korrupt kamera-preview etter at et annet program tar over kameraet.**
  Når FaceTime / Photo Booth / Zoom griper kameraet og deretter slipper
  det, returnerte AVFoundation IKKE en frisk videostrøm — vi fikk en
  korrupt frame (duplisert horisontalt, interlaced, rosa tint).
  En ny **frame-stale-watchdog** detekterer nå at frames slutter å komme
  i mer enn 3 sekunder, dreper ffmpeg-prosessen og restarter
  preview-en automatisk når kameraet er ledig igjen. Begrenset til
  4 restarter per 30 sek vindu så vi ikke ender i en restart-loop
  hvis kameraet er ekte borte (USB frakoblet, tillatelser nektet).

### Changed
- **Hjem-skjerm: preview-vindu og Lydnivå nå i ett samlet kort.**
  Designet matcher Direktesending-fanen — preview-vinduet sitter oppå
  og Lydnivå-VU er strippe-stilt i bunnen av samme kort. Gir bedre
  visuell helhet mellom video og lyd. Innstillingskortene står
  fortsatt vertikalt på siden.

---

## [4.43.0] — 2026-05-27

### Added
- **Live overlays — grafikk og presentasjon over direktesendingen.** Du kan
  nå legge over kirkens logo, lyrics/skriftsteder fra EasyWorship (via
  skjerm-capture på samme maskin), lower-third-grafikk eller PIP-vinduer
  oppå kameraet mens du sender direkte. Hver overlay konfigureres på
  Direktesending-fanen med kilde (bilde / skjerm / vindusregion), 9-grid +
  fullskjerm + tilpasset posisjon, størrelse, gjennomsiktighet og valgfri
  chroma key (for grønnskjerm-output fra EW). Overlays påvirker bare
  direktesendingen — selve opptaket lagres rent, så editor + podcast
  fortsatt jobber med uberørt video. *NDI-nettverkskilde kommer i v4.44.*

### Fixed
- **Recorder: kunne sjeldent henge i 'finalizing'-fasen.** Hvis
  finishSessionAsync kastet en feil (f.eks. mid-prepEpisode), ble
  phase-machine stående i 'finalizing' og blokkerte alle neste opptak.
  Nå returneres tilstanden alltid til 'idle' på error-banen.
- **Recorder: hindrer overlappende start-kall.** En andre startSession-kall
  i preflight-vinduet (typisk scheduler.triggerStart som race-r med en
  manuell start) kunne tidligere få AVFoundation-konflikt fordi det første
  kallet ennå ikke hadde låst enheten. La til 'starting' i guard-en.
- **Streamer: overlay-pipeline ble bygget to ganger.** Hvis en overlay-fil
  ble slettet mellom de to kallene (sjelden, men mulig på lokalt nettverk)
  kastet den andre buildOverlayPipeline en feil uten å bli fanget, og
  prosessen krasjet stille. Nå bygges pipelinen én gang og resultatet
  trådes til output-byggingen.
- **Stream-keys nektes lagret i klartekst.** På maskiner uten tilgjengelig
  Mac Keychain / Windows Credential Manager (sjelden, men kan skje på
  delte konti) ble RTMP-nøklene tidligere lagret som klartekst i en
  JSON-fil. Nå avvises lagringen og bruker får en tydelig melding heller
  enn å havne i en lekkasje-bane.
- **Editor: forrige fils peaks-ekstraksjon kanselleres nå.** Hvis bruker
  åpnet en ny opptaksfil før den forrige hadde ekstrahert peaks ferdig,
  fortsatte gammel ffmpeg-prosess å bruke CPU helt til 120 s-timeout
  utløp. Nå dreper editor-extract-audio-peaks alle gamle jobber først.
- **Editor: export-progress IPC-lytter stacket ved re-setup.** Etter en
  renderer-reload (eller dev-HMR) ble lytteren registrert på nytt uten å
  fjerne den gamle, så hver progress-event førte til N DOM-writes.

### Performance
- **VU-meteret allokerer ikke lenger en Float32Array per frame.** Tidligere
  ble en ny buffer (≈4 KB ved fftSize=2048) opprettet 60×/sek × 2 kanaler
  = ~480 KB/sek GC-press. Nå brukes én forhåndsallokert buffer per kanal,
  satt opp én gang når analyseren attaches.

### Testing
- **27 nye tester for overlay-pipeline.** Dekker filter-graf-bygging,
  chroma key, opacity, crop, posisjons-mapping (9-grid + fullskjerm +
  custom), multi-overlay-chaining, platform-spesifikk input (avfoundation
  vs gdigrab), og throw-baner. Totalt: 1078 tester.

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
