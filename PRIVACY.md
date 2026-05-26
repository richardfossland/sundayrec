# Personvern og datahåndtering

> SundayRec er laget for kirker og menigheter. Vi har bygget appen ut fra ett enkelt prinsipp: **opptakene og menighetsdataene deres skal ikke forlate maskinen deres uten at dere selv har bestemt hvor de skal.**

Denne siden forklarer i klartekst — uten juridisk språk — hva SundayRec lagrer, hvor det lagres, og hva som eventuelt sendes ut av huset.

Sist oppdatert: 26. mai 2026 · Versjon 4.38.1.

---

## Kort oppsummert

- **Vi har ingen server.** SundayRec er et program som kjører på din egen Mac eller PC. Det finnes ingen "SundayRec-sky" der opptakene deres ligger.
- **Opptakene ligger lokalt** på maskinen, der dere selv velger. Filene tilhører menigheten — fullstendig.
- **Hvis dere kobler til Google Drive eller Dropbox**, går opptakene til *deres egen* konto. Vi ser dem aldri.
- **Vi samler ikke inn statistikk, analyser eller telemetri.** Appen prøver ikke å "ringe hjem" når dere bruker den. Den eneste utgående trafikken er sjekk for nye versjoner.
- **Passord, innloggingstokens og stream-keys** krypteres med operativsystemets egen sikker-lagring (Keychain på Mac, DPAPI på Windows) før de skrives til disk.
- **AI-transkripsjon kjører lokalt.** Whisper-modellen lastes ned én gang fra Hugging Face og kjører deretter helt på din maskin. Innhold fra prekene-opptak forlater aldri datamaskinen.
- **Live-streaming kjører lokalt.** SundayRec encoder direkte med ffmpeg til RTMP-URL-en du oppgir (typisk YouTube eller Facebook). Vi ser ikke video- eller lyd-data; vi har ikke noe mellomledd.

---

## Hva lagres lokalt på maskinen

SundayRec lagrer all sin egen data i programdatamappen:

| Plattform | Mappe |
|---|---|
| macOS | `~/Library/Application Support/sundayrec/` |
| Windows | `%APPDATA%\sundayrec\` |

I denne mappen finner du:

- **`config.json`** — innstillingene dine: lydkilde, tidsplan, lagringsmappe, språk, mastering-preset osv.
- **`sundayrec-cloud.json`** — kryptert lagring av OAuth-tokens for Google Drive, Dropbox og YouTube. Tokenene er kryptert med operativsystemets egen sikker-lagring og kan ikke leses uten din egen brukerkonto.
- **`sundayrec-stream-keys.json`** — kryptert lagring av RTMP stream-keys for live-sending (YouTube/Facebook/egen server). Krypteres med samme system-mekanisme som OAuth-tokens.
- **`whisper-models/`** — AI-modeller for lokal transkripsjon (147 MB - 1.5 GB per modell). Lastes ned én gang fra Hugging Face når brukeren velger å aktivere transkripsjon. Modellene er filer du kan slette uten å miste data — kun nedlasten må gjøres på nytt.
- **`live-preview/preview.jpg`** — én still-frame fra pågående direktesending, oppdatert hvert 2. sek. Slettes når streamen stopper.
- **`logs/`** — vanlige programlogger (hvilke opptak som er startet, feilmeldinger osv.). Logger sendes **aldri** til oss eller noen tredjepart.
- **`review-queue.json`** — hvilke opptak som venter på å bli gjennomgått.
- **`<recording>.transcript.json`** (sidecar ved siden av lydfilen) — transkripsjon av en gitt fil, hvis brukeren har transkribert den. Ligger der lydfilen ligger; følger fila ved kopi/backup.

Opptaksfilene selv lagres der **dere** har valgt under "Lagringsmappe" i innstillingene — typisk `Music`-mappen eller en USB-disk. Filene tilhører menigheten; SundayRec verken kopierer eller endrer dem uten at dere ber om det.

---

## Hvordan passord og innloggingstokens lagres

SMTP-passordet (for e-postvarsler) og OAuth-tokens for skytjenester kan ikke ligge i klartekst på disken. SundayRec bruker Electrons innebygde [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage) for å kryptere disse før de skrives:

- **macOS:** kryptert med din egen Keychain-nøkkel
- **Windows:** kryptert med DPAPI (knyttet til Windows-brukerkontoen)
- **Linux:** krypteres med `kwallet` eller `gnome-libsecret` hvis tilgjengelig — ellers advarer SundayRec om at tokens lagres i klartekst

Hvis du sletter brukerkontoen din eller flytter `sundayrec-cloud.json` til en annen maskin, vil den ikke lenger kunne dekrypteres. Det er med vilje.

---

## Hva forlater maskinen

Det er tre tilfeller der SundayRec sender data ut av maskinen din. Alle tre er valgfrie eller velkjente:

### 1. Sjekk etter ny versjon

Appen spør `api.github.com` og `objects.githubusercontent.com` om det finnes en nyere versjon enn den du kjører. Dette er standardoppførselen til [`electron-updater`](https://www.electron.build/auto-update). Forespørselen inneholder kun:

- Hvilken versjon av SundayRec du kjører
- Operativsystem (`darwin` eller `win32`)
- Arkitektur (`x64` eller `arm64`)

Det sendes **ingen** brukerinformasjon, e-postadresse, IP-tracking eller telemetri. Vi har ikke noen Google Analytics, ingen Sentry, ingen Mixpanel.

Hvis du vil slå av automatisk oppdateringssjekk: bytt nettverkstilkobling eller blokker `objects.githubusercontent.com` i brannmuren din.

### 2. Sky-backup (kun hvis du selv har koblet det til)

Hvis du har koblet til Google Drive eller Dropbox, lastes opptakene opp til **din egen** konto i den tjenesten. Filene går direkte fra maskinen til Google eller Dropbox — de passerer ikke noen SundayRec-server.

Du kan koble fra skytjenesten når som helst under **Sky og publisering → Sky-backup → Logg ut**.

### 3. Podcast-publisering (kun hvis du selv har slått på det)

Hvis du har aktivert podcast-RSS, lager appen en RSS-fil og MP3-filer som lastes opp til skykontoen din (samme som over). Selve podcast-tjenester som Spotify og Apple Podcasts henter feeden derfra — vi er ikke involvert.

---

## Hva vi **ikke** samler inn

Vi vil være tydelige på dette. SundayRec sender **ikke**:

- Bruksstatistikk (hvilke menyer du klikker på)
- Krasjrapporter (eventuelle krasjlogger ligger lokalt på maskinen din)
- Innholdet av opptakene
- E-postadressen din
- Lokasjon eller IP-adresse
- Lyd, video, eller noe i nærheten av det

Hvis du finner ut at noe slikt skjer likevel, regn det som en feil — kontakt oss og vi fikser det umiddelbart.

---

## E-post og varsler

Hvis du har konfigurert e-postvarsler (under **Innstillinger → Varsler**) bruker SundayRec din egen SMTP-server (Gmail, Outlook, kirkens egen mailserver osv.). E-postene sendes fra din maskin gjennom din server — vi har ingen e-postinfrastruktur involvert. SMTP-passordet ditt er kryptert som beskrevet over.

Webhooks (hvis aktivert) sender et lite JSON-objekt til den URL-en du selv har angitt — typisk en intern Slack/Teams-kanal eller egen tjener. Innholdet er kun "en gudstjeneste er klar for gjennomgang" + tittel og dato.

---

## GDPR — hvem er behandlingsansvarlig

Menigheten din er **behandlingsansvarlig** for de opptakene SundayRec lager. SundayRec (programvaren) er bare et verktøy som hjelper dere med jobben. Vi er **ikke** databehandler i GDPR-forstand fordi vi aldri mottar dataene.

Konkret betyr det at:

- Det er dere som må vurdere om en preken kan publiseres som podcast, og innhente eventuelt samtykke fra dem som taler
- Det er dere som må svare på innsynsforespørsler ("kan du slette opptaket fra 12. mars?")
- Vi kan ikke slette noe i deres opptaksbibliotek — vi har ingen tilgang

Hvis du vil vite mer om hvordan en menighet bør håndtere opptak juridisk, anbefaler vi Den norske kirkes egne retningslinjer for publisering av gudstjenester, eller [Datatilsynet](https://www.datatilsynet.no/).

---

## Sletting av data

For å slette **alt** SundayRec har lagret:

1. Avinstaller appen
2. Slett programdatamappen (`~/Library/Application Support/sundayrec/` på Mac eller `%APPDATA%\sundayrec\` på Windows)
3. Slett selve opptaksmappen dersom du ikke vil beholde filene

Det finnes ikke noen "skyversjon" å slette — alt ligger på maskinen.

---

## Spørsmål

Har du spørsmål om datahåndtering, eller mistanke om at noe ikke stemmer?

- **E-post:** [hello@sundayrec.com](mailto:hello@sundayrec.com)
- **Issues:** <https://github.com/richardfossland/sundayrec/issues>

Vi svarer som regel innen et par dager.
