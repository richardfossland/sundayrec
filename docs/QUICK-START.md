# Hurtigstart-guide for SundayRec

Velkommen! Denne guiden tar deg gjennom alt du trenger å vite for å sette opp SundayRec i menigheten din. Du trenger **ikke** å være tekniker — guiden er skrevet for vanlige frivillige som har tatt på seg ansvaret for lyd og opptak på søndager.

Regn med å bruke ca. **10 minutter** på første gangs oppsett.

---

## Hva er SundayRec, og hva trenger jeg?

SundayRec er et program som kjører på en Mac eller en Windows-PC i kirken og tar opp gudstjenestene automatisk. Du setter det opp én gang, og så går det av seg selv hver søndag.

### Hva du trenger

- **En Mac eller PC** som kan stå på i kirken hele uken (helst koblet til strøm)
  - Mac: macOS 12 Monterey eller nyere
  - Windows: Windows 10 eller 11
- **En lydkilde**, vanligvis én av disse:
  - En **USB-mikser** (anbefalt) — Behringer, Yamaha, Soundcraft o.l. Disse plugger du rett i USB-porten på maskinen, og lyden fra mikrofonene i kirken kommer rett inn på datamaskinen.
  - Eller den innebygde mikrofonen i maskinen, hvis dere ikke har mikser. Lydkvaliteten blir mye dårligere, men det fungerer.
- (Valgfritt) **Et webkamera**, hvis dere vil ta opp video i tillegg til lyd
- (Valgfritt) **Internett**, hvis dere vil ha sky-backup eller publisere som podcast

Du trenger **ikke**:
- Noen tekniker til å holde et øye med opptaket under gudstjenesten
- En egen lyd-PC bare for opptak — du kan godt bruke en eksisterende laptop, så lenge den får stå urørt
- Spesielle abonnementer eller skytjenester

---

## Steg 1: Last ned og installer

1. Gå til [siste versjon på GitHub](https://github.com/richardfossland/sundayrec/releases/latest)
2. Last ned filen som passer maskinen din:
   - **Mac med Apple-prosessor (M1, M2, M3, M4):** `SundayRec-x.y.z-arm64.dmg`
   - **Mac med Intel-prosessor:** `SundayRec-x.y.z.dmg`
   - **Windows:** `SundayRec-Setup-x.y.z.exe`
3. Installer som vanlig — på Mac drar du SundayRec-ikonet til Programmer-mappen; på Windows følger du installasjonsveiviseren

Appen er signert av Apple/Microsoft, så du skal ikke få noen advarsler om "ukjent utvikler".

![Installer SundayRec](img/quickstart-1.png)

---

## Steg 2: Åpne appen og kjør veiviseren

Første gang du åpner SundayRec vises en kort veiviser som hjelper deg gjennom de tre viktigste innstillingene:

![Velkomstskjerm](img/quickstart-2.png)

Følg trinnene — du kan endre alt senere under **Innstillinger**.

---

## Steg 3: Velg lydkilde og sett opp tidsplan

### 3a) Lydkilde

Under **Lyd** velger du hvilken enhet SundayRec skal ta opp fra. Hvis du har koblet til USB-mikseren, skal den dukke opp i lista — vanligvis under navnet på produsenten (f.eks. "Soundcraft Notepad-8FX", "Behringer UMC404HD", "Yamaha MG10XU").

> 💡 **Tips:** Snakk inn i mikrofonen mens du ser på VU-måleren i appen. Du skal se grønne stolper hoppe. Hvis det er helt stille, har du valgt feil enhet — eller mikseren er ikke skrudd på.

![Lyd-innstillinger](img/quickstart-3.png)

### 3b) Tidsplan

Under **Tidsplan** legger du inn når dere har gudstjeneste. Et typisk eksempel:

| Dag    | Starttid | Varighet  |
|--------|----------|-----------|
| Søndag | 11:00    | 1 time 30 min |

Klikk **Legg til ukentlig opptak**, velg dag og klokkeslett, og lagre. SundayRec begynner opptaket noen sekunder før klokkeslettet og avslutter automatisk når tiden er ute.

Du kan legge til **engangsopptak** for spesielle gudstjenester som julaften, langfredag, konfirmasjon osv. Disse legges inn med dato + klokkeslett.

> 💡 **Tips:** SundayRec viser norske kirkelige høytider i kalenderen — Julaften, Langfredag, 1. juledag, Allehelgensdag osv. — slik at du ikke glemmer å legge inn ekstra opptak.

![Tidsplan](img/quickstart-4.png)

---

## Steg 4: La maskinen stå klar

Dette er det viktigste trinnet, og det er enkelt:

1. **La maskinen stå koblet til strøm** i kirken
2. **La den gå i hvilemodus** mellom gudstjenestene — det er helt greit
3. **Ikke skru den helt av** — da kan ikke SundayRec våkne og ta opp

SundayRec setter opp en sove-til-å-våkne-plan i operativsystemet (`pmset` på Mac, Task Scheduler på Windows) slik at maskinen våkner ca. 10 minutter før hvert opptak. Du behøver ikke å tenke på det — det skjer automatisk når du legger til et opptak i tidsplanen.

> ⚠️ **Viktig:** På Mac må du tillate SundayRec å sette wake-tider første gang (krever administrator-passordet). På Windows kan du måtte gå til *Kontrollpanel → Strømalternativer* og slå på "Tillat vekketider".

---

## Steg 5 (valgfritt): Koble til Google Drive eller Dropbox

Hvis dere vil ha en automatisk sikkerhetskopi av hvert opptak i skyen — uten å måtte tenke på det — kan SundayRec laste filene opp til kirkens Google Drive- eller Dropbox-konto.

1. Gå til **Sky og publisering → Sky-backup**
2. Velg **Google Drive** eller **Dropbox** og klikk **Logg inn**
3. En nettleser åpnes der dere logger inn med kirkens konto
4. Godkjenn at SundayRec får laste opp filer til mappen den oppretter

Filene lastes opp etter hvert opptak. Opptakene er fortsatt lagret lokalt — skyen er bare en sikkerhetskopi.

![Skyoppsett](img/quickstart-5.png)

---

## Steg 6 (valgfritt): Aktiver podcast

Vil dere at gudstjenestene skal komme i Spotify og Apple Podcasts?

1. Gå til **Sky og publisering → Podcast**
2. Fyll inn navn på podcasten, beskrivelse, og last opp et podcast-cover (helst 3000×3000 px)
3. SundayRec genererer en **RSS-feed-URL** etter første opptak
4. Send denne URL-en til:
   - [Spotify for Podcasters](https://podcasters.spotify.com)
   - [Apple Podcasts Connect](https://podcastsconnect.apple.com)
5. Nye gudstjenester legges automatisk inn i podcasten — dere trenger aldri å laste opp filer manuelt

> 💡 **Husk å avklare med taleren** før dere publiserer prekenen som podcast — noen vil ikke ha det.

---

## "Hva skjer hvis ..."

### ... maskinen var avslått da gudstjenesten begynte?

Da blir det ingen opptak. SundayRec kan ikke våkne en maskin som er skrudd helt av — bare en som står i hvilemodus. Sørg for at maskinen er på, og at "lukk lokket = sleep" (ikke shutdown).

### ... det var strømbrudd i kirken?

Hvis maskinen mistet strøm midt i et opptak, vil SundayRec automatisk gjenoppta opptaket når strømmen kommer tilbake — så lenge gudstjenesten ennå pågår. Du finner en delvis fil i opptaksmappen med suffikset `-resumed`.

### ... USB-mikseren plutselig forsvant?

SundayRec oppdager dette og prøver å koble til på nytt automatisk. Hvis det ikke lykkes, får dere et e-postvarsel (hvis konfigurert) og en feilmelding i statusfeltet på maskinen.

### ... wifi-et er dårlig?

Spiller ingen rolle for selve opptaket — det skjer lokalt. Sky-backup tar igjen så snart nettet kommer tilbake; den prøver på nytt i opptil tolv timer.

### ... noen åpnet en annen app under opptaket?

Helt greit. Opptaket går i bakgrunnen og avbrytes ikke av andre programmer.

### ... ingen så på opptaket før neste søndag?

Også helt greit. Opptakene ligger på maskinen helt til **dere** sletter dem. SundayRec sletter aldri filer automatisk.

---

## Feilsøking — vanlige problemer

| Problem | Sannsynlig årsak | Løsning |
|---|---|---|
| Ingen lyd i VU-måleren | Feil enhet valgt, eller mikser er av | Sjekk innstillingene, slå på mikseren, dra opp Gain |
| Maskinen våknet ikke til gudstjenesten | "Allow wake timers" er av i Windows, eller maskinen var avslått | Sjekk strømalternativer; la maskinen stå i sleep, ikke shutdown |
| Opptakene høres svake ut | Mikrofongain for lavt på mikseren | Skru opp gain; bruk **Mastering: Tale — kraftig** for å kompensere |
| Sky-backup feiler | Du er logget ut av Google/Dropbox | Logg inn på nytt under **Sky og publisering** |
| Tidsplan står "0 opptak planlagt" | Du har ikke trykt **Lagre** | Tilbake til tidsplanen, kontroller at slottet er aktivt |

Hjelper det ikke? Send en e-post til [hello@sundayrec.com](mailto:hello@sundayrec.com) eller åpne en sak på [GitHub](https://github.com/richardfossland/sundayrec/issues/new/choose). Beskriv hva som skjedde og legg ved en loggfil — du finner den under **Innstillinger → Avansert → Eksporter logg**.

---

## Mer informasjon

- [Personvern og datahåndtering](../PRIVACY.md) — hva som lagres hvor
- [Sky og podcast-oppsett (avansert)](SETUP-CLOUD.md) — for tekniske brukere som vil bygge med sine egne OAuth-nøkler
- [GitHub-prosjektsiden](https://github.com/richardfossland/sundayrec)

Lykke til! 🎙️
