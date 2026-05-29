# Google-oppsett for SundayRec

> Steg-for-steg for å aktivere **alle** Google-funksjonene SundayRec bruker:
> Drive-opplasting, YouTube-opplasting og (valgfritt) Gmail-varsler — pluss
> veien fra «Testing» til «Production» slik at tilkoblinger ikke utløper.
>
> Dette dokumentet er for deg som bygger/distribuerer SundayRec med dine egne
> OAuth-nøkler. Sluttbrukere som installerer ferdig binær trenger det ikke.

---

## TL;DR

- **Én OAuth-klient (type «Desktop app») dekker alt** — Drive, YouTube og Gmail
  bruker samme `GOOGLE_CLIENT_ID`, bare med ulike scopes.
- **Klient-type MÅ være «Desktop app»** — ikke «Web application». SundayRec bruker
  loopback-redirect (`http://127.0.0.1:<tilfeldig-port>`), som kun Desktop-klienter
  tillater. Feil type gir `Error 400: redirect_uri_mismatch`.
- **Live-streaming trenger INGEN Google-oppsett.** Det går via RTMP + en stream-key
  du limer inn fra YouTube Studio. Ingen OAuth, ingen scope, ingen verifisering.
- **7-dagers-utløpet forsvinner når du publiserer samtykkeskjermen til «Production».**
  Det er gratis, og du trenger ikke vente på ferdig verifisering.
- **Ingenting av dette koster penger.** Den dyre tredjeparts-sikkerhetsrevisjonen
  utløses kun av *restricted* scopes — som SundayRec bevisst unngår.

---

## Hva trenger Google — og hva trenger det ikke?

| Funksjon | Krever Google-API? | Scope | Klassifisering |
|---|---|---|---|
| **Drive-backup / publisering** | ✅ Ja | `drive.file` `openid` `email` `profile` | Ikke-sensitiv (drive.file = kun filer appen selv lager) |
| **YouTube-opplasting** | ✅ Ja | `youtube.upload` `openid` `email` `profile` | Sensitiv (ikke restricted) |
| **Gmail-varsler** | ⚪ Valgfritt | `gmail.send` | Sensitiv — *kan droppes til fordel for SMTP* |
| **Live-streaming (RTMP)** | ❌ Nei | — | Stream-key fra YouTube Studio, ingen OAuth |

**Anbefaling for minst mulig verifiseringsflate:** aktiver Drive + YouTube via OAuth,
og bruk **SMTP** for e-postvarsler i stedet for Gmail-scopen. SundayRec velger
automatisk Gmail-API kun hvis et Gmail-token finnes — ellers SMTP (`mailer.ts`).
Da slipper du å ha en Gmail-scope med i samtykkeskjermen.

---

## Del 1 — Google Cloud Console (engangsjobb)

### 1.1 Prosjekt + APIer
1. Gå til [console.cloud.google.com](https://console.cloud.google.com) → opprett (eller velg) et prosjekt.
2. **APIs & Services → Enabled APIs & services → + Enable APIs and services**, og aktiver:
   - **Google Drive API** (alltid)
   - **YouTube Data API v3** (hvis du vil ha YouTube-opplasting)
   - **Gmail API** (kun hvis du *ikke* bruker SMTP for varsler)

### 1.2 OAuth consent screen
1. **APIs & Services → OAuth consent screen** → **User type: External** → Create.
2. Fyll inn:
   - App-navn (vises på samtykkeskjermen — f.eks. «SundayRec»)
   - Support-e-post
   - App-logo (kreves for verifisering)
   - **Application home page** (kreves for verifisering — f.eks. sundayrec.com)
   - **Privacy policy URL** (kreves for verifisering)
   - **Authorized domains** (domenet til hjemmeside + personvern)
3. **Scopes → Add or remove scopes** → legg til nøyaktig de du bruker:
   - `.../auth/drive.file`
   - `.../auth/youtube.upload`  *(kun hvis YouTube)*
   - `.../auth/gmail.send`  *(kun hvis Gmail-varsler i stedet for SMTP)*
   - `openid`, `email`, `profile` *(legges ofte til automatisk)*

   > Konsollet merker hver scope med **Non-sensitive / Sensitive / Restricted**.
   > Bekreft at **ingen er «Restricted»** — restricted utløser en dyr årlig
   > sikkerhetsrevisjon. SundayRecs scopes er Non-sensitive (drive.file) eller
   > Sensitive (youtube.upload, gmail.send), aldri Restricted.
4. **Test users** → legg til din egen e-post (`richard.fossland@gmail.com`) mens
   appen er i Testing.

### 1.3 OAuth-klient (Desktop app)
1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. **Application type: `Desktop app`** ← kritisk. Ikke «Web application».
3. Gi den et navn → Create.
4. Kopier **Client ID** og **Client secret**.

> Hvorfor Desktop app: SundayRec åpner en lokal loopback-server på en tilfeldig
> port og bruker `http://127.0.0.1:<port>` som redirect. Google tillater enhver
> loopback-port for Desktop-klienter uten registrering. Web-klienter krever at
> hver eksakte URI (med port) er forhåndsregistrert — umulig med tilfeldig port.

---

## Del 2 — Legg nøklene i SundayRec og bygg

1. I prosjektroten, rediger `.env` (gitignored):
   ```
   GOOGLE_CLIENT_ID=<din-id>.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=<din-secret>
   ```
   (Samme klient brukes for Drive, YouTube og Gmail — du trenger ikke flere nøkler.)
2. Bygg på nytt så verdiene bakes inn:
   ```bash
   npm run build:mac      # eller build:win
   ```
   Verdiene injiseres ved build via electron-vite `define` (se `electron.vite.config.ts`).
   I `npm run dev` leses de i stedet fra `process.env` ved runtime.

> **Om client_secret i en desktop-app:** det er forventet og trygt. SundayRec
> bruker PKCE (`code_challenge=S256`), så secret-en er ikke en reell hemmelighet
> — den kan ikke holdes skjult i en distribuert app, og Googles Desktop-flyt er
> designet for nettopp dette.

---

## Del 3 — Test tilkoblingen

1. Start appen, gå til **Innstillinger → Publisering / Sky**.
2. Trykk **Koble til Google Drive**. Nettleseren åpnes, du logger inn, godtar.
3. Mens appen er i **Testing**: du ser en «Appen er ikke verifisert»-advarsel
   (klikk «Avansert → Fortsett») — normalt, forsvinner etter verifisering.
4. Etter samtykke skal loopback-redirecten fullføre og tokenet lagres (kryptert
   i Keychain/DPAPI via safeStorage).
5. Gjenta for YouTube hvis aktuelt.

---

## Del 4 — Skaler til alle brukere (drep 7-dagers-utløpet)

I **Testing**-modus utløper refresh-tokens etter **7 dager** — hver tilkoblede
kirke måtte da koble til på nytt ukentlig. Slik fjerner du det:

1. **OAuth consent screen → Publish app → Confirm (Production).**
2. **Fra det øyeblikket slutter tokens å utløpe** — kirker kobler til én gang og
   blir værende. Dette skjer umiddelbart, uavhengig av verifiseringsstatus.

I Production kobles en bruker bare fra hvis de selv tilbakekaller tilgang,
kontoen er helt ubrukt i 6 måneder, eller passordet endres.

---

## Del 5 — Verifisering (fjerner advarselsskjermen)

Publisering til Production fjerner 7-dagers-utløpet, men «ikke verifisert»-skjermen
vises til verifisering er fullført. Den er **gratis**:

1. **OAuth consent screen → Prepare for verification / Submit for verification.**
2. Google sjekker: app-logo, hjemmeside, personvernerklæring, og at du eier
   domenet (bekreftes via [Search Console](https://search.google.com/search-console)).
3. For Sensitive scopes (youtube.upload, gmail.send): vanlig merkevare-verifisering,
   **ingen** tredjeparts sikkerhetsrevisjon. Behandlingstid: dager til uker.

---

## YouTube-kvote (les hvis mange kirker laster opp)

YouTube Data API har en standardkvote på **10 000 enheter/døgn per prosjekt**, og
ett videoopplasting koster ~1 600 enheter → ca. **6 opplastinger/døgn** totalt for
alle brukere til sammen. For pilot er det rikelig. Skal mange kirker laste opp
samtidig, søk om **kvoteøkning** (APIs & Services → YouTube Data API → Quotas).
Større økninger kan kreve en YouTube API-compliance-gjennomgang. Drive har ikke
denne begrensningen for normal bruk.

---

## Feilsøking

| Symptom | Årsak | Fix |
|---|---|---|
| `Error 400: redirect_uri_mismatch` | Klienten er «Web application» | Opprett ny klient av type **Desktop app**, bytt `.env`, bygg |
| `Error 403: access_denied` / «ikke fullført bekreftelse» | Testing-modus og e-posten din er ikke testbruker | Legg e-post under **Test users**, eller publiser til Production |
| `OAuth client not configured for google-drive` | `GOOGLE_CLIENT_ID`/`SECRET` mangler i build | Fyll `.env`, kjør `npm run build` på nytt |
| Kirke logges ut etter ~7 dager | Appen står i Testing | Publish app → Production |
| `invalid_grant` ved oppdatering | Token tilbakekalt / passordbytte | Koble til på nytt (appen viser reauth-banner) |

---

## Hva som IKKE trenger Google

- **Live-streaming:** RTMP + stream-key fra YouTube Studio (`Opprett → Gå live →
  Stream-nøkkel`). Limes inn i SundayRec under stream-destinasjoner, lagres kryptert.
  Ingen API, ingen OAuth.
- **E-postvarsler via SMTP:** sett SMTP-server/bruker/passord i innstillinger —
  da brukes ikke Gmail-scopen i det hele tatt.

---

*Se også `SETUP-CLOUD.md` for Dropbox/OneDrive (ikke-Google) og generell
OAuth-arkitektur. Merk: Google bruker loopback-redirect (`127.0.0.1`), mens
Dropbox/OneDrive bruker `sundayrec://`-skjemaet beskrevet der.*
