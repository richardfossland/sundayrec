# Windows-lyd i SundayRec: moderne lyd-motor (WASAPI + ASIO)

På Windows tar SundayRec opp lyd via en **moderne lyd-motor** i stedet for det
gamle DirectShow-API-et som ga ustabile opptak («virker av og til»). Du trenger
ikke gjøre noe — det skjer automatisk:

- **Vanlige enheter (USB-mikrofon, lydkort): WASAPI.** Windows' moderne lyd-API.
  Mer stabilt enn den gamle DirectShow-veien.
- **Proff lydutstyr (Soundcraft MADI-USB, Behringer X32, RME, Focusrite): ASIO.**
  Når en ASIO-driver er installert, vises hele kortet som **én enhet** med **alle
  kanaler** (DirectShow delte dem i «stereopar», så du f.eks. ikke fikk tak i kanal
  9/10). ASIO gir også lavest latens og mest stabil pro-lyd.

macOS er upåvirket — der brukes Core Audio (via ffmpeg), som allerede fungerer bra.

## Slik gjør du

1. **Installer produsentens ASIO-driver.** SundayRec lager ikke driveren — den
   bruker den. Last ned og installer ASIO-driveren for lydkortet ditt fra
   produsenten. (Har du ikke en dedikert driver, fungerer **ASIO4ALL** som en
   generisk ASIO-driver oppå Windows-lyden.)
2. **Velg lydkortet i SundayRec.** Gå til **Innstillinger → Lyd**. ASIO-enheter
   vises øverst med et **«ASIO»-merke**. Velg kortet ditt.
3. **Velg kanaler.** Har kortet mer enn 2 kanaler, dukker det opp en
   **kanalvelger** (Venstre / Høyre). Velg hvilke inn-kanaler opptaket skal bruke.
4. **Ta opp som vanlig.** Lyd-only og lyd + video fungerer begge.

## Robusthet og fallback

Skulle den moderne motoren ikke klare å starte (driveren opptatt, kortet
frakoblet i det opptaket begynner), faller SundayRec **automatisk tilbake til den
gamle DirectShow-veien** og gir en melding om det, slik at opptaket ikke ryker.
Trekkes lydkortet ut midt i et opptak, avsluttes opptaket pent (filen blir lagret)
med en tydelig melding.

## Hvis noe oppfører seg rart: «Klassisk lyd-motor»

Under **Innstillinger → Lyd → Lyd-motor (avansert)** finnes en bryter **«Klassisk
lyd-motor (DirectShow)»** (kun synlig på Windows, av som standard). Slå den på for
å tvinge den gamle DirectShow-veien hvis den moderne motoren oppfører seg dårlig på
en bestemt maskin. De fleste skal la den stå av.

## macOS

På macOS trengs ingenting av dette: Core Audio viser allerede et samle-lydkort som
én enhet med alle kanaler, og SundayRec bruker ffmpeg/avfoundation som før —
uendret.

---

## For utviklere / lisens

Lydfangst på Windows går gjennom `cpal` (`recorder::cpal_capture`): **WASAPI** er
standard og krever ingen feature; **ASIO** er en valgfri Cargo-feature (`asio`)
fordi den lenker mot Steinberg ASIO SDK. Begge piper rå PCM inn i ffmpeg-sidecaren.
Bygg-oppsett for ASIO: se [`BUILD_ASIO.md`](./BUILD_ASIO.md).

### Tredjeparts-komponenter brukt av Windows-lyd-veien

| Komponent    | Bruk                                   | Lisens                                            |
| ------------ | -------------------------------------- | ------------------------------------------------- |
| **ASIO SDK** | ASIO-driver-grensesnittet (via `cpal`) | Steinberg proprietær (gratis, krever attribusjon) |
| **cpal**     | Lyd-I/O på tvers av plattform          | Apache-2.0 / MIT                                  |
| **ringbuf**  | Lock-free buffer (callback → ffmpeg)   | MIT / Apache-2.0                                  |

**Steinberg-attribusjon** (vises i Windows-bygget under Innstillinger → Generelt →
«Lyd-teknologi», og gjengitt her som lisenskrav):

> ASIO Driver Interface Technology by Steinberg Media Technologies GmbH. ASIO is a
> trademark and software of Steinberg Media Technologies GmbH.

ASIO-logo og videre bruk følger Steinbergs «ASIO SDK Usage Guidelines» dersom
markedsføringsmateriell distribueres (ikke nødvendig inne i selve appen).
