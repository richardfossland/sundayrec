# Ting Richard må gjøre etter v4.47-runden

Denne fila er en konkret arbeidsliste for det jeg (Claude) IKKE kan fikse
fra koden — det krever konfigurasjon hos eksterne tjenester eller manuell
verifisering.

---

## 🔴 KRITISK — OAuth-apper må produksjonssettes

Ingen av cloud-tjenestene er produksjonsklare i dag. SundayRec-koden er
ferdig — det som mangler er at hver OAuth-app må flyttes fra
«Development/Testing»-mode til «Production» på leverandørens dashboard.

**Brukeren har bekreftet at både Google og Dropbox blokker innlogging
nå** (Google: «Tilgangen er blokkert — Feil 403», Dropbox: «This app has
reached its user limit»).

For en fullverdig, skalerbar API som funker for alle kirker uten manuelt
arbeid per bruker, må du gjennom Production Review hos hver tjeneste.
Under: kjapp midlertidig fiks + permanent produksjons-prosessen for hver.

---

### 1. Google OAuth (Drive + YouTube)

**Symptom:** «Tilgangen er blokkert: SundayRec har ikke fullført Googles
bekreftelsesprosess. Feil 403: access_denied»

**Hvorfor:** OAuth-prosjektet står i «Testing»-mode. Maks 100 test-brukere,
hver må manuelt legges til, og status-skjermbildet skremmer av seg
ikke-tekniske brukere.

#### Kjapp fiks (5 min — gir deg + utvalgte pilot-kirker tilgang)

1. Gå til [Google Cloud Console — OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)
2. Velg SundayRec-prosjektet i topp-menyen
3. Under «Test users», klikk «+ ADD USERS»
4. Legg til `richard.fossland@gmail.com` og e-postene til pilot-kirker
5. Lagre. Bruker logger inn på nytt — får nå komme gjennom.

#### Permanent fiks — Google App Review (skalerbar, ~4–8 uker)

På samme consent screen, klikk «PUBLISH APP» og start verification-flyten:

1. **Fyll inn Branding-fanen komplett:**
   - App-navn, support-e-post, app-logo (120×120 PNG)
   - Application home page: `https://sundayrec.com`
   - Privacy policy link: `https://sundayrec.com/privacy` (må eksistere!)
   - Terms of service link: `https://sundayrec.com/terms` (må eksistere!)
2. **Verifisering av domene-eierskap:**
   - Add `sundayrec.com` under «Authorized domains»
   - Google ber deg om å legge til en TXT-record eller HTML-fil for å
     bevise eierskap (oftest via Google Search Console)
3. **Scope-justering — minimere sensitiv-scopes:**
   - Drive: bruk `https://www.googleapis.com/auth/drive.file` (kun
     filer appen lager) ikke `drive` (alt på disken). Ikke-sensitive
     scope, krever ikke security assessment.
   - YouTube: `youtube.upload` ER sensitive. Krever en demo-video som
     viser bruken (Google review-team ser den).
4. **YouTube krever ekstra:** demo-video, beskrivelse av hver scope,
   eventuell CASA security assessment ($500–$15 000 hvis Google
   forlanger det for større publikum).

**Tidsestimat:** Drive alene = 2–4 uker review-tid. Drive+YouTube = 4–8
uker pga YouTube-scope.

**Anbefaling:** Hvis kirker bare trenger Drive (backup), bruk `drive.file`
og dropp YouTube initielt. Det går mye raskere gjennom review. YouTube
kan publiseres som egen scope-utvidelse senere.

---

### 2. Dropbox (Production Status)

**Symptom:** «This app has reached its user limit. Contact the app
developer and ask them to use the Dropbox API App Console to increase
their app's user limit.»

**Hvorfor:** SundayRec-appen står i «Development»-status med 500-brukers
cap. Når 500 unike Dropbox-konti har koblet til (selv om mange har
disconnected siden), nås taket og nye brukere blokkeres.

#### Kjapp fiks (5 min — gir 50 ekstra slots, midlertidig)

1. Gå til [Dropbox App Console](https://www.dropbox.com/developers/apps)
2. Velg SundayRec-appen
3. Under «Status» → «Apply for production» — men IKKE klikk enda.
4. Først, scroll til «Permissions» og verifiser at scopes er minimerte:
   - `files.content.write`, `files.content.read`, `files.metadata.read`
     er typisk det du trenger for å laste opp opptak.
   - Hver scope krever begrunnelse i søknaden.

#### Permanent fiks — Dropbox Production Approval (~1–2 uker)

Søknaden er enklere enn Google, men krever fortsatt at du dokumenterer
appen:

1. **Klikk «Apply for production status»** under app-detaljene
2. **Fyll inn:**
   - **App description:** «SundayRec is a desktop application for
     churches to automatically record and back up Sunday services to
     their own Dropbox. Recordings are stored locally on the user's
     machine and uploaded to their personal/church Dropbox account as
     redundant backup.»
   - **Scope justifications:**
     - `files.content.write`: «Required to upload service recordings
       to the user's chosen Dropbox folder»
     - `files.content.read`: «Required to verify uploads completed and
       resume interrupted transfers»
     - `files.metadata.read`: «Required to list user's folders so they
       can pick where to save recordings»
   - **Privacy policy URL:** `https://sundayrec.com/privacy`
   - **Estimated users:** Sett et realistisk tall (500–5000 for piloten)
3. **Vent på godkjenning:** typisk 5–10 virkedager. Dropbox-team
   responderer per e-post; ofte ber de om mer info eller mindre scopes.

**Når godkjent:** Cap øker til ~uendelig (offisielt 10 000+ brukere før
de eventuelt ber om enterprise-tier). Nye brukere kan koble til umiddelbart.

---

### 3. OneDrive / Microsoft Graph

**Status:** Ikke testet ennå, men sannsynligvis i samme situasjon. Mest
typiske feilen: appen er «Single-tenant» (bare din Microsoft-konto), eller
i «Multi-tenant» men uten admin-consent for organisasjoner.

#### Sjekk + fiks (10 min)

1. Gå til [Azure Portal → App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. Velg SundayRec-appen
3. **Authentication-fanen:**
   - «Supported account types» MÅ være: **«Accounts in any
     organizational directory (Any Microsoft Entra ID tenant —
     Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)»**
   - Hvis Single-tenant: bytt nå (kan kreve å re-registrere app — sjekk
     før du klikker)
   - Redirect URIs: `sundayrec://oauth/onedrive` MÅ stå listet under
     «Mobile and desktop applications»
4. **API permissions:** verifiser at delegerte scopes er minimerte:
   - `Files.ReadWrite.AppFolder` (best — kun app's egen mappe)
     ELLER `Files.ReadWrite` (full files-tilgang, mer scary i consent)
   - `User.Read` (for å vise konto-navn i UI)
   - Sjekk at «Grant admin consent for [organization]» er IKKE
     nødvendig — det krever IT-admin på kirkens Microsoft 365.

#### Microsoft Publisher Verification (anbefalt for full produktion)

For å fjerne «Unverified publisher»-advarselen i consent-skjermen, må du
gjennom Publisher Verification:

1. Tilknytt en Microsoft Partner Network-konto (gratis — `aka.ms/PublisherVerification`)
2. Verifiser organisasjons-eierskap (via domene-eierskap typisk)
3. Tildel MPN ID til appen i Azure Portal

Tar 1–2 uker. Ikke kritisk for funksjonalitet, men fjerner den røde
advarselen som skremmer kirke-brukere.

---

## ✅ Sjekkliste for full produksjons-klar API

- [ ] Google OAuth: lagt til pilot-kirker som test-brukere (kjapp fiks)
- [ ] Google OAuth: startet App Review for Drive (`drive.file` scope)
- [ ] Google OAuth: startet App Review for YouTube (separat hvis ønsket)
- [ ] Dropbox: søkt «Production status» i App Console
- [ ] OneDrive: verifisert «Multi-tenant» + personal accounts i Azure
- [ ] OneDrive: fjernet «Unverified publisher»-flagget via MPN
- [ ] sundayrec.com/privacy publisert (kreves av alle tre tjenester)
- [ ] sundayrec.com/terms publisert (kreves av Google + Microsoft)

**Anbefalt rekkefølge:**
1. Kjapp fiks Google (test-brukere) — så du kan teste resten i dag
2. Sjekk OneDrive Multi-tenant i Azure
3. Publiser privacy-policy + ToS på sundayrec.com (lett, kan kopiere
   maler fra GitHub: f.eks. PrivacyPolicies.com eller iubenda)
4. Søk Dropbox Production (5–10 dager review-tid)
5. Søk Google Drive App Review (uten YouTube først — raskest)
6. Etter at Drive er klar: legg på YouTube App Review

---

## 🧪 Real-world testing du må gjøre

Koden loader og passerer 1080 unit-tester, men ingen av disse har vært
testet med ekte kirke-hardware.

- [ ] **Stream + opptak samtidig** mot en ekte YouTube Live-stream-key.
  Sjekk: blir lokal MP4 spillbar? Riktig bitrate-forhold? Lyd-sync OK?
- [ ] **NDI med ekte kilde** — start ProPresenter eller EasyWorship på
  en maskin, se om SundayRec automatisk oppdager kilden. Min smoke-test
  fant 0 kilder fordi ingenting sendte NDI på nettverket.
- [ ] **Intel-Mac** — Universal binary er bygget og verifisert med
  `lipo -info`, men ikke kjørt på ekte Intel-Mac. Hvis du har en gammel
  iMac, installer v4.47.1 og prøv en NDI-overlay.
- [ ] **Camera-fix på FaceTime-bug'en** — start preview → motta
  FaceTime-samtale → avslutt → sjekk om SundayRec automatisk restarter
  preview etter ~3-5 sek.
- [ ] **Windows-runtime** — alt er Mac-testet lokalt. CI bygger
  Windows-binary, men NDI på Win og dshow stream-pipeline må verifiseres
  manuelt på en Windows-maskin.

---

## ⚖️ Lisens / juridisk

- [ ] **NDI® attribution i About-skjerm.** NDI SDK-lisensen krever at
  «NDI® is a registered trademark of NewTek, Inc.» er synlig kreditert
  i appen. Vi har grandiose's `LICENSE`-fil i `vendor/grandiose/`, men
  ingen tekst i en About-modal. Hvis du vil at jeg legger til, si fra.

---

## 🌐 Utenfor dette repoet

- [ ] **sundayrec.com** (separat repo) trenger oppdatering med nye
  features for v4.43–v4.47:
  - 🎬 Live overlays (bilde, skjerm, vindu, chroma key)
  - 📡 Native NDI som OBS
  - 🎬 Stream + opptak samtidig
  - 🏠 Smart hjem-kort
  - 🛠 Camera-stale-watchdog
  - 🍎 Universal Mac (Intel + Apple Silicon)

---

## 🤔 Strategiske valg å ta neste

Disse er ikke akutte men venter på din retning:

- **NDI sending?** I dag er SundayRec kun NDI-receiver. Kirker som
  bruker vMix/OBS som main switcher kan ville ha SundayRec som NDI-kilde
  også. Egen sesjon hvis aktuelt.
- **NDI audio?** Vi mottar bare video. Noen profesjonelle oppsett bruker
  NDI for både lyd og bilde (i stedet for separat mikser).
- **Editor-perf-refaktor** (O(n) bar rendering per frame) — utsatt med
  vilje fra audit-runden. Stort scope, egen sesjon.
- **App Review for Google/Dropbox/Microsoft** — når du er klar for
  offentlig distribusjon (utenfor pilot-kirker).

---

*Sist oppdatert: 2026-05-27, etter v4.47.1*
