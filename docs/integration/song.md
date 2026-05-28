# Integrasjonskontrakt: SundayRec → SundaySong

> Status: SundayRec-siden implementert (fase 3). SundaySong-siden = Phase 7.2 (usage/log endpoint), eies av Song-sessionen.

SundayRec sender sanglisten (bygget av Stage-importen) til SundaySong etter at tjenesten er publisert. SundaySong aggregerer til CCLI/TONO-rapporter for menigheten.

## Forutsetning

`<recording>.service.json` sidecar med setlist (skrives av Stage-integrasjonen i fase 2). Feltet `wasStreamed` i sidecarens ServiceLink settes av SundayRec sin streaming-modul — SundayRec er kilde til sannhet her.

## Flyt

```
Etter publisering:
  SundayRec leser <recording>.service.json
  → for hver sang i setlist: POST /v1/usage/log
  → SundaySong aggregerer til CCLI/TONO-rapport
```

## Payload (én per sang)

```typescript
{
  church_id:             "uuid-fra-sundaysong",    // fra Integration settings
  song_id?:              "sundaysong-uuid",         // prioritert
  tono_work_id?:         "T-100",                  // fallback (viktig for Norge)
  ccli_song_id?:         "22025",                  // fallback (global)
  title?:                "Amazing Grace",           // fallback for manuell matching
  service_date:          "2026-06-01",
  duration_displayed_sec?: 180,
  was_streamed:          true,                      // fra ServiceLink.wasStreamed
  idempotency_key:       "churchId|date|songId"     // deduplisering
}
```

## Endepunkt SundaySong må implementere (Phase 7.2)

```
POST /v1/usage/log
Authorization: Bearer <api-key>
Content-Type: application/json

→ 200: { ok: true, idempotency_key }
→ 409: allerede sendt (ignoreres, telles som ok)
→ 4xx/5xx: feil (logges, stopper ikke andre sanger)
```

**Sang-oppslag:** SundaySong bør akseptere `tono_work_id` og `ccli_song_id` som alternative nøkler for å slå opp intern `song_id`, da Stage ofte bare har tono/ccli-IDer (ikke `sundaysong_id`). Se åpent spørsmål #1 i `rustling-napping-mountain.md`.

## Autentisering

API-nøkkel lagres kryptert via `safeStorage` (samme mekanisme som SMTP-passord + stream-nøkler). Innstilles i **Innstillinger → Sunday-suite → SundaySong API-nøkkel**.

## Church-ID

`church_id` er menighets-UUID fra SundaySong (settes i **Tilkobling**-feltet i innstillingene). Uten dette kan ingen rapporter genereres.
