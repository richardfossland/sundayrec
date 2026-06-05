# Natt-økt: seam-audit (api-shim ↔ Rust)

Autonom nattejobb. Tema: den bevist feilutsatte sømmen mellom den ordrett-
porterte rendereren (`legacy/renderer/api-shim.ts`) og Rust-backenden. Live-
testing avdekket en klynge «stille fallback»-feil (innstillinger nådde aldri
opptaket, feil event-shape osv.). Denne økta gjorde en **systematisk, statisk**
audit av HELE sømmen mot de autoritative ts-rs-bindingene og recorder-koden.

Metode: for hver wiret `invoke(...)` ble (1) argument-navnene sjekket mot Rust-
signaturen (snake_case→camelCase), og (2) RETURN-shapen sjekket mot
`*/bindings/*.ts` (den genererte wire-formen). For opptaks-innstillinger ble det
kuraterte backend-subsettet (`backendRecordingSettings`) krysssjekket mot HVERT
`Settings`-felt `scheduler::build_opts` faktisk leser.

## Fikset (committet)

| Commit    | Funn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cf1c818` | Auto-lagre «vekk fra dvale»-toggel på tidsplan-siden (siste innstilling som krevde «Lagre»-klikk).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `5f5ec41` | **5 return-shape-mismatcher:** (1) `SleepConfig` har INGEN `platform`-felt → schedule-sidens dvale-diagnostikk viste ALLTID «Ikke støttet på denne plattformen» selv på Mac/Windows der wake virker. Nå injiseres platform webview-en kjenner. (2+3) `wakeDetectCapabilities`/`wakeVerifyScheduled` hadde feil fallback-shape → reliability-kortet kastet + forsvant stille ved kommando-feil. (4) `editorProbeStreams` fallback `{streams:[]}` feil shape → `null`. (5) `scheduleOsWakes` `{ok:true}` malte en stille feil som suksess. + `TestWakeResult.deltaSec` finnes ikke → «forsinkelse undefineds» fjernet. |
| `af721f1` | **L/R-kanalvalg ble stille ignorert av recorderen.** UI lagrer mapping per enhet i `deviceChannels[deviceId]`, men recorderen leser top-level `inputChannelL/R`. En X32-bruker som valgte kanal 16/17 fikk likevel standard 0/1. Curated-subsettet oversetter nå den valgte enhetens mapping. (Standard 0/1 = no-op → ingen regresjon for vanlig stereo.)                                                                                                                                                                                                                                                            |

Tidligere i økta (egne commits, nå på `main`): `dccd7fa` wakeFromSleep til
kuratert subset, `0d9be10` filenamePattern til kuratert subset — samme klasse
(felt recorderen leser som `settings_save` ellers re-defaultet).

## Event-seam (analog audit av EVENT_MAP-payloads)

Samme metode på den andre retningen: hver `EVENT_MAP`-oppføring uten adapter ble
sjekket mot Rust-emit-payloaden.

- **FIKSET — `master-progress`** (`9e139c2`): `EditorMasterProgress` emitter
  snake_case (`job_id/current_sec/total_sec`), men mastering-panelet leser
  `currentSec/totalSec` → `totalSec` undefined → fremdriftsbaren sto frosset på
  **0% hele veien** (så hengt ut, selv om mastreringen virket). La til adapter.
- **OK uten adapter:** alle `recording://*`-events (`RecorderState` serialiseres
  snake_case = consumer-strengene `'stopped'/'failed'/'idle'`; reconnect-events tar
  ingen payload; started-event er tomt + guardet); `whisper-model-progress`
  (`ModelDownloadProgress` er allerede camelCase = consumer).
- **BACKEND-GAP (krever Rust-emit, ikke frontend-fiks):** `whisper-progress`
  (transkripsjon) og `editor-export-progress` emittes ALDRI fra backend → ingen
  live-% under transkribering/eksport. Begge operasjoner FULLFØRER fint; kun den
  visuelle fremdriften mangler. Egen oppfølging hvis ønsket (emit progress i
  whisper-transcribe + editor-export-løkkene).

## Verifisert OK (ingen endring nødvendig)

- **Kamera-gating** (`CameraCapabilities`: maxWidth/Height/Fps/supportedResolutions/
  supportedFramerates) matcher video-page-consumeren eksakt.
- **Preflight** (`PreflightSeverity = "warn"|"error"`, `PreflightCategory`) matcher
  home-helsesjekken eksakt.
- **Wake-plattform-etiketter** (`WakePlatform = "mac-arm"|"mac-intel"|"win"|"linux"|
"other"`) matcher `platformLabel()`-switchen eksakt.
- **Test-opptak** (`TestRecordingSignal = "silent"|"low"|"normal"`) matcher.
- `DeviceInventory` serialiseres snake_case (`video_inputs`) — shim leser riktig.
- Resten av det kuraterte opptaks-subsettet dekker alle felt `build_opts` leser
  (device/video\*/format/bitrate/saveFolder/silence/split/keepSeparateAudio/
  resolution/codec/encoder/slots/special).

## UX-FIKSET (de tidligere åpne punktene — «fiks ux + rydd opp»)

### 1. ✅ Sample-rate: «Automatisk» (native) lagt til + wiret

La til et **«Automatisk»-kort** (nytt ANBEFALT default) ved siden av 44,1/48 kHz.
Radio-verdiene ER nå `SampleRate`-enumen direkte (`auto`/`r44100`/`r48000`),
lagres som nytt `sampleRateMode`-felt og synkes til recorderen i det kuraterte
subsettet (whitelistet). Auto = recorderens trygge native-capture (ingen `-ar`,
ingen hakkete lyd på 44,1 kHz-maskinvare); de eksplisitte modusene tvinger raten
for den som vil. Numerisk `sampleRate` beholdes synket for klient-bruk (VU-monitor
og disk-estimat). _Rigg: bekreft at et eksplisitt valg faktisk endrer opptaks-raten._

### 2. ✅ Mikser: bekreftet skjult by-design + ryddet vekk død kode

Kompressor/EQ/limiter/input-volume er ALLEREDE skjulte inert-inputs (`index.html`
record-raw-filosofi siden v4.31 — dynamikk/EQ hører hjemme i editoren). De er
altså ikke presentert som aktive opptaksvalg = UX er riktig. Ryddet vekk den døde
event-wiringen + sluttet å persistere dem i save (de beholder defaults).

### 3. ✅ Fremdrift: ubestemt stripe for eksport + transkripsjon

Backenden emitter ingen export-/transcribe-progress → baren sto frosset på 0%.
Lagt til en gjenbrukbar `.progress-indeterminate`-stripe som vises under
operasjoner uten sporbar fremdrift og fjernes automatisk så snart en ekte %
kommer (modell-nedlasting beholder ekte bar). Honnør-fiks uten å gjette falsk %.
_Ekte %-bar ville fortsatt kreve backend-emit (egen oppfølging)._

### Rydding

Alle 18 eslint-advarsler i den ordrette porten fjernet → `npm run check` 0
advarsler (ubrukte importer + død write-only/superseded lokal-state + én død
funksjon, hver verifisert genuint ubrukt — ingen skjult wiring-gap).
