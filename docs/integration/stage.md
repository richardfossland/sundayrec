# Integrasjonskontrakt: SundayRec ← SundayStage

> Status: SundayRec-siden implementert (fase 2a+2b). Stage-siden = SundayStage Phase 10, eies av Stage-sessionen.

SundayStage driver live-presentasjonen og logger eksakt hvilken sang/seksjon/skriftsted som var på skjermen og når. SundayRec bruker den loggen til å sette kapittelmarkører + setlist på opptaket automatisk.

## Flyt

```
SundayStage live session
  → live_session.json (eksisterer allerede på disk)
  → Phase 10: eksporter service-manifest.json

SundayRec
  + leser service-manifest.json
  + aligner timestamps til opptakets start
  → <recording>.meta.json  (kapitler lagt inn)
  → <recording>.service.json  (setlist med tono/ccli-IDer)
```

## Hva Stage må implementere (Phase 10)

Eksporter en `service-manifest.json` når en live-session avsluttes. Innholdet baseres på den eksisterende `live_session.json` (som allerede persisteres) + sang-metadata fra Stage-DB.

### Format

```jsonc
{
  "source": "sundaystage",
  "serviceId": "<UUID>",          // Stage service.id
  "churchId": "<UUID>",           // valgfri
  "startedAtMs": 1748700000000,   // unix ms — absolutt starttid for sesjonen
  "endedAtMs":   1748703600000,   // valgfri
  "items": [
    {
      "atMs": 1748700000000,      // absolutt unix ms for når cue ble vist
      "endMs": 1748700180000,     // valgfri — siste ms cue var synlig
      "kind": "song",             // "song" | "scripture" | "sermon" | "custom" | "gap"
      "label": "Amazing Grace — Vers 1",  // fra CueSource.display_label
      "serviceItemId": "item-uuid",        // fra CueSource.service_item_id (brukes for collapse)
      "song": {                            // kun når kind === "song"
        "title": "Amazing Grace",
        "tonoWorkId": "T-100",             // fra Song.tono_work_id
        "ccliSongId": "22025",             // fra Song.ccli_song_id
        "sundaysongId": "uuid-fra-song-api" // valgfri — FK til SundaySong
      }
    }
    // …
  ]
}
```

### Triggertidspunkt — tre alternativer (avklar i Stage Phase 10)

**A (anbefalt):** Auto-skriv til en konfigurerbar `manifestFolder` når sesjonen
avsluttes (`session.stop()`). SundayRec poller/importerer manuelt.

**B:** Tauri-kommando `service_export_manifest(service_id)` → returnerer manifest
som JSON-streng. SundayRec kaller den på forespørsel (krever en Tauri↔Electron
IPC-bro — mer kompleks, men "on-demand"-vennlig).

**C:** Auto-skriv til en **kjent fast sti** (f.eks.
`~/Library/Application Support/SundayStage/last-manifest.json`). SundayRec
leser den etter opptaket. Enklest for prototyp.

SundayRec støtter alle tre — brukeren peker på manifeststien via
«Importer Stage-kapitler»-knappen i editoren.

## Hva SundayRec gjør (implementert)

`applyStageManifest(recordingPath, manifestPath, recordingStartMs, opts)`:

1. Parser manifestet (`parseStageManifest`).
2. Aligner cue-timestamps til opptakets start: `sec = (item.atMs - recordingStartMs) / 1000`.
3. Kollapser konsekutive cues med samme `serviceItemId` til ett kapittel.
4. Kutter items utenfor `[0, durationSec]`.
5. Kapittelnavnet er sangtittel (ren) for sanger, `label` ellers.
6. Skriver `ChapterMarker[]` inn i `<recording>.meta.json` (bevarer title/speaker/description).
7. Skriver `<recording>.service.json` med setlist (tono/ccli/sundaysong-IDer + firstShownSec).

IPC: `integrations-stage-import(recordingPath, manifestPath, wasStreamed?)` → `{ ok, chapterCount, songCount }`.

## Delte identifikatorer

| Felt | Stage | SundayRec | SundaySong |
|---|---|---|---|
| `tonoWorkId` | `song.tono_work_id` | `SongUsage.tonoWorkId` | `Song.tono_work_id` |
| `ccliSongId` | `song.ccli_song_id` | `SongUsage.ccliSongId` | `Song.ccli_song_id` |
| `sundaysongId` | (Phase 10 — resolve via Song API) | `SongUsage.sundaysongId` | `Song.id` |

**Åpent spørsmål:** Bør Stage resolve `sundaysongId` FØR manifestet skrives (mot Song-API), eller aksepterer SundaySong `tonoWorkId`/`ccliSongId` i usage-loggen som alternativ? Påvirker Fase 3. Se åpent spørsmål #1 i `rustling-napping-mountain.md`.
