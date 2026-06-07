# Windows prosess-hygiene — hindre at lyd-tjenesten krasjer

## Bakgrunn (diagnose fra kirkemaskinen)

En diagnose av en faktisk kirke-PC (Windows 11) viste at **Windows Audio-tjenesten
(`Audiosrv`) krasjet gjentatte ganger** — og når den faller forsvinner ALLE
lydenheter samtidig (symptomet brukerne melder som «enheten dukker ikke opp»).
Samtidig kjørte **6 `SundayRec.exe`-prosesser** (Soundcraft-driveren selv var frisk).

Rot-årsak: appen tillot ubegrenset antall instanser, og force-quit/hengte instanser
etterlot ffmpeg-sidecars som fortsatt holdt lydenheten. Flere instanser + orphans
som samtidig holder lyd-ressurser presset Windows Audio-tjenesten til den krasjet.

## Det som er implementert

| Fiks                           | Hva                                                                                                                                                                                                                         | Fil                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **Single-instance**            | En ny oppstart fokuserer det eksisterende vinduet i stedet for å starte en ny prosess. Registrert som FØRSTE plugin (Tauri-krav).                                                                                           | `lib.rs` (`tauri-plugin-single-instance`) |
| **Job Object (kill-on-close)** | Prosessen legges ved oppstart i et Windows Job Object med `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Når SundayRec dør av HVILKEN SOM HELST grunn (inkl. hard kill via Oppgavebehandling) dreper OS alle ffmpeg-barn automatisk. | `platform/mod.rs` (`windows-sys`)         |
| **Exit-opprydding**            | Ved app-avslutning stoppes recorder/preview/VU-sidecars eksplisitt (graceful komplement til Job Object).                                                                                                                    | `lib.rs` `RunEvent::ExitRequested`        |
| **`kill_on_drop`** (fra før)   | Ren nedstenging dreper ffmpeg når `Child` droppes.                                                                                                                                                                          | `media/ffmpeg.rs`                         |
| **dshow → WASAPI/ASIO**        | Lyd fanges nå via cpal (WASAPI standard / ASIO pro), ikke dshow — se [`PRO-AUDIO-WINDOWS.md`](./PRO-AUDIO-WINDOWS.md). Lydenheten holdes in-process og slippes ved stopp.                                                   | `recorder/cpal_capture.rs`                |

## Bevisst utsatt

- **Oppstarts-opprydding av gamle orphans (FIKS 4):** ikke implementert. Single-
  instance hindrer nye oppstablede instanser, og Job Object hindrer nye orphans, så
  dette gjelder kun orphans fra GAMLE versjoner før denne oppdateringen — der holder
  én omstart av maskinen. Å enumerere + drepe ffmpeg-prosesser ved navn er risikabelt
  (kan treffe andre apper) og droppes derfor med vilje.

## Testplan (Windows — må bestås før release)

- [ ] **Single-instance:** dobbeltklikk ikonet 5× raskt → KUN én `SundayRec.exe` i
      Oppgavebehandling; det eksisterende vinduet fokuseres. Logg: «a second SundayRec
      launch was blocked».
- [ ] **Ren lukking:** lukk appen normalt → ingen `SundayRec.exe` eller `ffmpeg.exe`
      blir liggende.
- [ ] **Hard kill midt i opptak:** start opptak → drep `SundayRec.exe` via
      Oppgavebehandling → INGEN `ffmpeg.exe` blir liggende (Job Object gjør jobben).
      Logg ved oppstart: «process placed in kill-on-close Job Object».
- [ ] **Start → stopp → start:** to påfølgende opptak → lydenheten er ledig mellom,
      ingen lås.
- [ ] **60+ min (gudstjeneste-lengde):** kjør et langt opptak → Event Viewer
      (System-logg) skal ha NULL nye «Windows Audio ble uventet avbrutt».
- [ ] **Diagnose på nytt:** kun ÉN SundayRec-prosess, ingen Audio-tjeneste-krasj.

## Changelog-tekst

> Rettet en feil der flere SundayRec-instanser eller etterlatte opptaksprosesser
> kunne overbelaste Windows' lydtjeneste og føre til at lydkortet «forsvant».
> SundayRec kjører nå som én enkelt instans og rydder alltid opp opptaksprosesser
> ved avslutning.
