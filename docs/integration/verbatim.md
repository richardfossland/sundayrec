# Integrasjonskontrakt: SundayRec → Verbatim

> Status: SundayRec-siden implementert (fase 1). Verbatim-siden = Verbatim Phase 8 («Sunday-link»), eies av Verbatim-sessionen.

SundayRec tar opp video; Verbatim er pro-tekstingsverktøyet. Brukeren sender et opptak fra SundayRec til Verbatim, får tilbake teksting, og SundayRec legger den inn som opptakets `.transcript.json`.

## Flyt

```
SundayRec  --(verbatim://import?…)-->  Verbatim   (teksting: confidence, glossary, styling)
SundayRec  <--(SRT/VTT-fil)----------  Verbatim
SundayRec: importVerbatimCaptions() -> <recording>.transcript.json
```

## Det SundayRec sender (implementert)

Åpner via OS-deep-link (`shell.openExternal`):

```
verbatim://import?path=<absolutt videosti>
                 &language=<ISO 639-1 | auto>      (valgfri)
                 &context=<fri tekst>               (valgfri, f.eks. "Preken. Taler: Ola Nordmann")
                 &glossary=<komma-separerte termer>  (valgfri, f.eks. talernavn/stedsnavn)
                 &returnTo=sundayrec
```

Bygges i `src/main/integrations/verbatim.ts` → `buildVerbatimDeepLink()`. Hvis OS ikke har handler for `verbatim://` (Verbatim ikke installert) returnerer `verbatimSend` `{ ok:false, error:'verbatim_not_installed' }`, og SundayRec viser nedlastingshint.

## Det Verbatim må implementere (Verbatim Phase 8)

1. **Registrer `verbatim://`-skjemaet** (Tauri deep-link / OS-protocol). Parse `import`-host med query-paramene over.
2. **Opprett prosjekt fra `path`** via eksisterende `project_create_from_video(path)`. Sett `language` og `context_description` fra paramene (context primer Whisper — killer-feature #2). Seed `glossary` med `glossary`-termene.
3. **Retur av teksting.** Velg én (avtales — se åpent spørsmål #4 i hovedplanen):
   - **(a) Sidecar (anbefalt, enklest):** skriv eksporten ved siden av kildevideoen med forutsigbart navn: `<video uten ext>.srt` (eller `.vtt`). SundayRec har en «Importer teksting»-handling som leser den.
   - **(b) Retur-deep-link:** kall `sundayrec://captions?recording=<sti>&subtitle=<sti>&language=<iso>` når eksporten er ferdig. (Krever at SundayRec utvider sin `sundayrec://`-handler — ikke bygget ennå; si fra hvis dere vil ha denne.)

## Det SundayRec gjør med returen (implementert)

`importVerbatimCaptions(recordingPath, subtitlePath, language?)`:
- Parser SRT **og** WebVTT (auto-detektert; tåler cue-nummer, WEBVTT/NOTE-headere, BOM, CRLF).
- Konverterer til `TranscriptData` (`model:'verbatim'`, segmenter `{start,end,text}`).
- Skriver atomisk til `<recording uten ext>.transcript.json` — samme sidecar som whisper, så Verbatim-tekstingen dukker opp i transkripsjons-søk + editor uten videre arbeid.

## Format-referanse

- **Undertekst inn til SundayRec:** SRT (`HH:MM:SS,mmm`) eller WebVTT (`HH:MM:SS.mmm`). Begge støttes.
- **TranscriptData** (SundayRec sin sidecar): `{ version:1, model:string, language:string, duration:number, createdAt:number, segments:{start,end,text}[] }`.

## Åpne punkter

- Retur-mekanisme (a vs b) — se hovedplanens åpne spørsmål #4.
- Per-ord-confidence fra Verbatim går i dag tapt ved SRT/VTT-konvertering (TranscriptData har kun segment-tekst). Hvis vi senere vil bevare ord-confidence i SundayRec, må TranscriptData utvides — egen sak.
