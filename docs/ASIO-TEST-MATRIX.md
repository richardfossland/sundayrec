# Windows-lyd (cpal: WASAPI + ASIO) — test- og utgivelsessjekkliste

På Windows tar SundayRec opp lyd via **cpal** (WASAPI som standard, ASIO for pro)
i stedet for ffmpeg/DirectShow. Hele cpal-capture-stien er **HARDWARE-UVERIFISERT**
til den kjøres på en ekte Windows-maskin. Alt pure (arg-bygging, kanal-ruting,
generisk sample-konvertering, enhets-merge) er enhetstestet og grønt i CI + på mac;
capture-stien (cpal-stream → ffmpeg-pipe) kan KUN verifiseres på rigg.
Bygg-oppsett: [`BUILD_ASIO.md`](./BUILD_ASIO.md).

## Bygg (forutsetning)

- [ ] `cargo run --example asio_spike --features asio` lister minst én ASIO-enhet
      MED sample-format (ASIO4ALL holder) — beviser at `cpal/asio` bygger + linker,
      OG at **24-bit-enheter nå enumereres** (på cpal 0.15 ga 24-bit «no configs»).
- [ ] `npm run tauri build -- --no-default-features --features editor,tray,asio`
      produserer en Windows-installer uten feil.

## Windows — WASAPI (standard, vanlige enheter)

- [ ] **Vanlig USB-mikrofon / lydkort:** velg i Innstillinger → Lyd → ta opp →
      ren fil, ingen «dropped»-advarsel, ingen hakking. Loggen viser
      `cpal capture starting host=WASAPI`.
- [ ] **Stabilitet vs gammel dshow:** samme rigg som tidligere ga ustabile opptak
      → bekreft at WASAPI-veien er stabil.
- [ ] **Lyd + video (WASAPI-lyd + dshow-kamera):** sjekk lepp-synk over et lengre
      opptak (dual-klokke — `build_cpal_pipe_video_args`).
- [ ] **24-bit enhet:** en enhet som rapporterer 24-bit tas opp uten feil (bevis at
      cpal 0.17 + generisk `from_sample` virker).

## Windows — ASIO (pro-lydkort, f.eks. Soundcraft MADI-USB)

- [ ] **Enumerering:** Innstillinger → Lyd viser kortet som ÉN enhet med
      «ASIO»-merke, øverst i lista (ikke oppdelt i stereopar).
- [ ] **Kanalvalg:** kanalvelger (V/H) viser alle kortets inn-kanaler; velg f.eks.
      9 og 10.
- [ ] **Lyd-opptak:** 1-kanals (mono) taleopptak → ren fil, riktig kanal, ingen
      «dropped»-advarsel i loggen, ingen hakking.
- [ ] **Stereo med custom kanaler:** ta opp valgt V/H-par → begge kanaler korrekt.
- [ ] **Lyd + video:** opptak med kamera + ASIO-lyd → sjekk **lepp-synk** over et
      lengre opptak (dual-klokke er den høyeste risikoen — se
      `build_cpal_pipe_video_args`).
- [ ] **USB-uttrekk midt i opptak:** trekk ut kortet → appen finaliserer pent med
      «device_disconnected»-melding, henger IKKE.
- [ ] **Auto-stopp (manual-max):** sett en kort grense → opptaket stopper selv.

## Fallback + sikkerhetsbryter

- [ ] **cpal feiler ved start** (åpne kortet i et annet program først) →
      SundayRec faller tilbake til DirectShow + viser «cpal_fallback»-melding,
      opptaket fungerer.
- [ ] **«Klassisk lyd-motor (DirectShow)»-bryter** (Innstillinger → Lyd → Lyd-motor
      (avansert)): slå på → opptak bruker dshow-veien; slå av → cpal igjen.
- [ ] **ASIO4ALL** fungerer som generisk ASIO-driver.

## macOS — regresjon (skal være uendret)

- [ ] Lydkort via Core Audio (ffmpeg avfoundation): enumerering + opptak som før.
- [ ] Ingen ASIO/WASAPI-merke eller «klassisk lyd-motor»-bryter vises (Windows-only).
- [ ] `asio_spike`-eksempelet skriver «no-op»-meldingen og avslutter 0.

## Utgivelse

- [ ] Bump versjon (package.json + `src-tauri/tauri.conf.json` + `Cargo.toml`).
- [ ] Changelog:
      _«Windows: moderne lyd-motor (WASAPI som standard, ASIO for pro-lydkort med
      flerkanals + lav latens) erstatter DirectShow. Faller automatisk tilbake til
      DirectShow, og kan tvinges via «Klassisk lyd-motor».»_
- [ ] Bekreft Steinberg-attribusjonen vises i Windows-bygget (Innstillinger →
      Generelt → «Lyd-teknologi»).
- [ ] Lyd-motoren forblir en **gratis kjernefunksjon** (ikke bak Pro-tier).

## Kjent utsatt (faller tilbake til dshow på cpal-stien)

- Split, reconnect, preroll, live VU-metere og stopp-på-stillhet er IKKE wiret på
  cpal-stien (se `recorder::cpal_capture`-modul-doc). Bruk «Klassisk lyd-motor» /
  dshow-veien for disse hvis nødvendig.
- Ekte driver-leverte ASIO-kanalnavn (v1 viser «Input N») krever ASIO SDK
  `ASIOGetChannelInfo` under cpal — TODO.
- Kosmetisk «WASAPI»-merke på vanlige enhetskort i UI er ikke lagt til (ASIO-kort
  har «ASIO»-merke); loggen bekrefter host-valget under rigg-test.
