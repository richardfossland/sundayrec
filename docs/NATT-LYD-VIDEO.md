# Natt-økt: lydbehandling, kapitler og bredt formatstøtte

Dette dokumentet oppsummerer arbeidet gjort i natt-økten (2026-06-03), de
designvalgene jeg tok selvstendig (siden du sov), og **spørsmålene jeg ville
stilt deg** — så du kan overstyre der du er uenig. Alt er committet lokalt på
gren `feat/legacy-frontend-port`, **ikke pushet**. Alle gater grønne
(clippy -D warnings, fmt, tsc, eslint, format:check); ffmpeg/maskinvare-stiene
er **HARDWARE-UVERIFISERT** (kompilerer + wiret, ikke kjørt mot ekte
opptak/kamera).

## Hva som ble bygd (7 commits)

1. **Tema-kapitteldeteksjon** (`chapters.rs`) — genererer kapitler fra prekenens
   TEKST (bibelreferanser «Johannes 3:16», oppregningspunkter «for det første»),
   bygges inn i eksportert fil som ID3 CHAP/CTOC. Knapp i transkripsjon-panelet.
2. **Lydbehandling-kjerne** (`processing.rs`) — kanalreparasjon (swap, dupliser
   god kanal→stereo for dårlig kabel, per-kanal gain) + diagnose + full vokal-
   kjede (HPF, støyreduksjon, romdemping, gate, EQ, kompressor, de-esser,
   limiter, makeup-gain) med 3 presets.
3. **Lydforbedring-UI** — eksport-modal får ✨ ETT-KLIKKS «Automatisk
   lydforbedring», vokal-kjede-velger, kanalreparasjon + «Diagnostiser».
4. **Bredt (VLC-aktig) eksportformat** — eksport-validering åpnet fra
   mp3/aac/wav/flac/mp4 til alt ffmpeg har kodek for; MOV/MKV + H.265-eksport.
5. **4K + MOV + H.265 opptak** — 2160p-oppløsning, mov-container, h265-kodek i
   opptaks-innstillingene.
6. **Kamera-kapabilitet-gating** — UI deaktiverer oppløsning/fps kameraet ikke
   støtter.

## Designvalg jeg tok (overstyr gjerne)

- **Kapitler er deterministiske + lokale + tette** (ditt eksplisitte valg). Kun
  norske bibelbøker + oppregningspunkter; ingen LLM/sky. Hvert vers/punkt blir
  et kapittel, men identiske refs innen 45 s dedupes og markører nærmere enn
  3 s tynnes.
- **Vokal-kjede-rekkefølge** (produsent-standard): kanalreparasjon → HPF →
  støyreduksjon → romdemping → gate → EQ → kompressor → de-esser → limiter →
  makeup-gain → (mastering-loudnorm sist). Mastering/loudnorm beholdt som siste
  ledd; vokal-kjeden former tone/dynamikk, mastering setter leveranse-loudness.
- **Romdemping (de-reverb) er en TILNÆRMING**, ikke ekte spektral de-reverb —
  ffmpeg har ingen native de-reverb. Jeg bruker en nedover-ekspander (agate) som
  demper romhalen mellom ord. Ærlig dokumentert som «demping», ikke «fjerning».
- **Ett-klikks auto** = diagnostiser kanaler + «Podkast-stemme»-kjede +
  «Tale — tydelig» mastering. Enkelt og trygt; kan gjøres smartere (se under).
- **Webm-eksport bevisst utelatt** (krever VP9/Opus-sti, ikke H.264/AAC).
- **4K H.265 bruker software libx265** (matcher editor) — kan være CPU-tungt
  live (se åpent spørsmål).
- **Kamera-gating**: deaktiver det kameraet ikke støtter (UVC-deskriptor er
  fast). Ved feilet probe → la alt være aktivt (blokker ikke på probe-miss).

## Oppfølging etter dine svar (samme økt)

Du svarte på 3 av spørsmålene, og jeg implementerte dem med en gang:

7. **VideoToolbox hardware-enkoder** (du: «ja») — `VideoEncoder{Software,
Hardware}` + `videotoolbox_codec_args` (h264/hevc_videotoolbox, `-b:v`
   oppløsnings-utledet bitrate, `-realtime 1`). Opptak bruker det KUN på macOS
   (faller tilbake til software ellers). Nytt `video_encoder`-innstilling +
   «ENKODER»-velger i UI. Gjør live 4K H.265 realistisk.
8. **Full vokal-mikser-UI** (du: «ja, full mixer») — `mixer.ts` eksponerer hvert
   trinn (lavkutt/støy/rom/gate/EQ×3/kompressor/de-esser/limiter/sluttgain) som
   skyvere i eksport-modalen. «🎛 Avansert lydmikser»-checkbox; sender hele
   `processing`-objektet (overstyrer presets). Presets fyller mikseren.
9. **Auto-balanse «løft svak»** (du: beholdt) — ingen endring.

## Oppfølging 2 — «ja, implementer det»

- **Fler-språklig kapitteldeteksjon** (norsk + engelsk) — `Language`-enum, 66
  engelske bibelbøker, engelske punkt-fraser («firstly», «point 2»). Velges fra
  transkripsjonens språk. (commit `eb81300`)
- **Støy-bevisst ett-klikks** — måler støygulvet (astats) i samme pass som
  kanaldiagnosen og velger «Støyete rom»-kjeden når det er støyete, ellers
  «Podkast-stemme». (commit `31ddc2d`)
- _Gjenstår kun preferanse:_ de-esser/de-reverb-default i podcast-preset — nå
  fritt justerbart i den avanserte mikseren uansett.

## Åpne spørsmål til deg

1. **Auto-balanse av kanaler — løft svak eller demp sterk?** Jeg løfter den
   svakeste kanalen mot den sterkeste (capped 12 dB), så jeg ikke demper signal.
   Alternativ: demp den sterke ned. Hvilken foretrekker du?
2. **De-esser/romdemping default AV** i «Podkast-stemme»? Jeg har de-esser PÅ,
   romdemping AV i podkast-preset (PÅ i «Støyete rom»). Riktig balanse?
3. **4K H.265 live**: vil du at jeg legger til **hardware-encoder**
   (`hevc_videotoolbox`/`h264_videotoolbox` på Mac) for at 4K skal holde
   sann-tid? Software libx265 @ veryfast kan droppe rammer på 4K. Anbefalt, men
   ikke gjort ennå (krever probing av encoder-tilgjengelighet).
4. **Ett-klikks smartere?** Skal auto-velge «Støyete rom»-kjede når
   støyreduksjon trengs? Det krever en støygulv-måling (ekstra ffmpeg-pass).
   Verdt det, eller hold det enkelt?
5. **Per-knapp vokal-kjede-UI**: backend støtter full per-trinn-justering
   (EditorProcessing-DTO), men UI eksponerer foreløpig bare presets +
   kanalreparasjon. Vil du ha full «mixer»-UI med alle skyvere?
6. **Kapittel-tittel-språk**: bibelnavn er norske. Skal jeg legge til engelske/
   andre språk-tabeller for fler-språklige menigheter?

## Maskinvare-røyktest (NEEDS-RICHARD)

Kjør `npm run tauri dev --features editor,...` og verifiser mot ekte rigg:

- [ ] **Kapitler**: transkriber en preken → «Generer kapitler fra tema» →
      sjekk at bibelrefs/punkter blir kapitler → eksporter → bekreft CHAP i
      fila (f.eks. `ffprobe -show_chapters out.mp3`).
- [ ] **Ett-klikks auto**: kjør på et opptak med skjev kanal → bekreft at
      diagnosen + reparasjon stemmer, og at eksporten høres balansert ut.
- [ ] **Kanalreparasjon**: test «dupliser god kanal» på et opptak med én død
      kanal (dårlig kabel-scenario).
- [ ] **Vokal-kjede**: eksporter med «Podkast-stemme» → bekreft at
      støyreduksjon/EQ/kompressor/de-esser/limiter høres bra ut, ingen artefakter.
- [ ] **MOV/H.265-eksport**: eksporter en video til MOV + H.265 → spill av i
      QuickTime (hvc1-tag skal gjøre den spillbar).
- [ ] **4K-opptak**: ta opp 4K på et kamera som støtter det → sjekk fps-lås og
      filstørrelse; test H.265 hvis CPU holder.
- [ ] **Kamera-gating**: velg et 720p-webkamera → bekreft at 1080p/4K/60fps
      blir deaktivert i UI.

## Filer (kjerne)

- `crates/sundayrec-core/src/chapters.rs` — kapitteldeteksjon
- `crates/sundayrec-core/src/processing.rs` — kanalreparasjon + vokal-kjede
- `crates/sundayrec-core/src/capture.rs` — 4K/h265-args + kamera-kapabilitet
- `crates/sundayrec-core/src/editor.rs` — formatbredde + video-kodek-args
- `src-tauri/src/editor/mod.rs` — eksport-seam + diagnose/auto-kommandoer
- `legacy/renderer/pages/editor/export.ts` + `editor-transcript.ts` + `video-page.ts` — UI
