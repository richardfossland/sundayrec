# START HER — Claude Code på Windows-riggen (SundayRec ASIO/WASAPI)

> Lim hele denne fila inn i Claude Code på Windows-maskinen, eller bare si:
> «Les `docs/WINDOWS-RIGG-START.md` og følg den.»

Du er Claude Code som kjører på en **Windows-PC** (kirkemaskinen / en testrigg).
Oppgaven din: **bygge og teste den nye Windows-lydveien i SundayRec, og fikse de få
ASIO-spesifikke kompileringsfeilene som ikke kunne verifiseres på macOS.** Alt
arbeidet er allerede gjort og pushet — du skal få det til å bygge + virke på ekte
Windows + lydutstyr, ikke skrive det på nytt.

---

> **Kjører du i Claude-desktop-appen (ikke terminal-CLI)?** Det går helt fint — du
> har samme verktøy. Åpne en tom mappe som workspace, så kan du bare si:
> «Klon `https://github.com/richardfossland/sundayrec-tauri.git`, sjekk ut grenen
> `feat/windows-asio`, les så `docs/WINDOWS-RIGG-START.md` og følg den.»
> PowerShell-kommandoene under kjøres likt uansett.

## 0. Hent koden

```powershell
git clone https://github.com/richardfossland/sundayrec-tauri.git
cd sundayrec-tauri
git checkout feat/windows-asio
```

Alt ligger på grenen `feat/windows-asio` (HEAD `85d6a9f` da denne ble skrevet).
Det finnes INGEN andre filer du må få overført — repoet er komplett.

## 1. Les disse først (full kontekst — du har ikke samtalehistorikken)

- `docs/NATT-AUDIT-2026-06-07.md` — oversikt over ALT som ble gjort (diagnose-verktøy,
  bugfikser, cloud, effektivitet) + hva som gjenstår.
- `docs/BUILD_ASIO.md` — NØYAKTIG byggeoppsett for ASIO (SDK, env-variabler).
- `docs/ASIO-TEST-MATRIX.md` — testmatrise for WASAPI/ASIO/fallback.
- `docs/WINDOWS-PROCESS-HYGIENE.md` — single-instance + Job Object + testplan.
- `docs/PRO-AUDIO-WINDOWS.md` — brukervendt forklaring av lyd-motoren.

## 2. Hva som ALLEREDE er verifisert (ikke gjør om igjen)

- Hele kodebasen er **mac-gate-grønn** (clippy + tsc + eslint + prettier + ~1200 tester).
- Den ikke-ASIO Windows-koden er **kryss-kompilert fra mac til `x86_64-pc-windows-gnu`
  og bygger rent**: `recorder/cpal_capture::imp` (WASAPI-opptak), `platform/mod.rs`
  (Job Object via `windows-sys`), engine-rutingen, single-instance, diagnose, cloud.
- **IKKE verifisert (din jobb):** selve `--features asio`-armen — `cpal::HostId::Asio`
  i `recorder/cpal_capture.rs` (`open_host`), ASIO-enumereringen i `audio/asio.rs`
  (`#[cfg(all(target_os="windows", feature="asio"))] mod imp`), og
  `examples/asio_spike.rs`. Disse krever Steinberg-SDK-en for å i det hele tatt
  kompilere `asio-sys`, så de er aldri bygget. De bruker SAMME cpal 0.17-API som den
  verifiserte WASAPI-veien, så forvent få/ingen feil — men dette er det du bekrefter.

## 3. Arkitektur (kort, så du vet hva du ser på)

På Windows tar SundayRec opp lyd via **cpal** (ikke ffmpeg/dshow): WASAPI for vanlige
enheter, ASIO for proff lydutstyr. cpal fanger PCM → pipes inn i ffmpeg-sidecaren
(`-f f32le -i pipe:0`) som enkoder/mux-er (+ kamera via dshow). dshow beholdes kun som
auto-fallback hvis cpal ikke starter, og kan tvinges via «Klassisk lyd-motor»-bryteren.
macOS er urørt. Nøkkelfiler: `src-tauri/src/recorder/cpal_capture.rs`,
`src-tauri/src/recorder/engine.rs` (`start()`), `crates/sundayrec-core/src/capture.rs`
(`build_cpal_pipe_*`), `src-tauri/src/audio/asio.rs`.

## 4. Forutsetninger å installere

- **Rust** (rustup, default `x86_64-pc-windows-msvc`) + **Node 22**
- **Visual Studio Build Tools** («Desktop development with C++»)
- For ASIO i tillegg: **LLVM/Clang** (sett `LIBCLANG_PATH`, typisk `C:\Program Files\LLVM\bin`)
  og **Steinberg ASIO SDK** (sett `CPAL_ASIO_DIR` til SDK-roten) — se `docs/BUILD_ASIO.md`.
- For å TESTE ASIO: **ASIO4ALL** (gratis generisk ASIO-driver) eller Soundcraft-driveren.
- ffmpeg-sidecaren hentes automatisk av `npm run ffmpeg` (kjøres av build) — ikke noe
  manuelt.

```powershell
npm ci          # frontend-avhengigheter + henter ffmpeg/ffprobe-sidecar
```

## 5. STEG 1 — bygg UTEN ASIO (enklest, bare Rust+MSVC)

Dette gir WASAPI-opptak + diagnose + single-instance/Job Object — alt unntatt ASIO.

```powershell
npm run tauri build -- --no-default-features --features editor,tray
```

Røyktest (se `WINDOWS-PROCESS-HYGIENE.md` for full liste):

- Vanlig USB-mic → ta opp → ren fil; loggen viser `cpal capture starting host=WASAPI`.
- Klikk app-ikonet 5× raskt → KUN én `SundayRec.exe` i Oppgavebehandling.
- Start opptak → drep `SundayRec.exe` via Oppgavebehandling → INGEN `ffmpeg.exe` igjen.
- Innstillinger → Lyd → **Diagnose** → fargekodede funn + «Kopier full rapport».

## 6. STEG 2 — bygg MED ASIO (krever SDK-oppsettet over)

```powershell
# Først: bekreft at ASIO-armen bygger + lister enheter (ASIO4ALL holder).
cargo run --example asio_spike --features asio
```

**Hvis dette gir kompileringsfeil:** det er den forventede «blinde» biten. Feilene vil
være i `cpal::HostId::Asio`-bruken eller cpal 0.17-API i `audio/asio.rs` /
`cpal_capture.rs`. Fiks dem (de bruker samme API som den verifiserte WASAPI-veien;
sammenlign med `open_host`-WASAPI-armen og VU-koden i `audio/vu.rs`). Når spiken lister
minst én ASIO-enhet, bygg appen:

```powershell
npm run tauri build -- --no-default-features --features editor,tray,asio
```

Så kjør hele `docs/ASIO-TEST-MATRIX.md`: ASIO-kort vist som én enhet m/ alle kanaler,
multikanal-opptak, video+lyd lepp-synk, USB-uttrekk håndteres pent, cpal→dshow auto-
fallback, «Klassisk lyd-motor»-bryteren, og 60+ min uten Windows Audio-krasj.

## 7. Verifiser + commit

```powershell
npm run check        # format + lint + tsc + clippy + alle rust-tester (skal være grønn)
```

Commit fiksene på `feat/windows-asio` (ikke lag ny gren med mindre du vil).
Avslutt hver commit-melding med:

```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

Push til `origin/feat/windows-asio` når det bygger + tester grønt.

## 8. Hvis noe er rart

- Kjør **Diagnose**-knappen i appen (Innstillinger → Lyd) — den lager en full rapport
  med feilkoder (`SR-*`). «Kopier full rapport» og lim inn til meg.
- Den skriver også `<app-data>/last-error.json` ved opptaksfeil + en
  `SundayRec-diagnose.md` du kan dele.
- ASIO faller automatisk tilbake til WASAPI/DirectShow hvis driveren svikter — sjekk
  «Lyd-motor»-seksjonen i diagnose-rapporten for hva som faktisk ble brukt.
