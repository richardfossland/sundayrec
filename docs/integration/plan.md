# Integrasjonskontrakt: SundayRec ↔ SundayPlan

> Status: SundayRec-siden implementert (fase 4). SundayPlan-siden blokkert på Supabase-backend (Docker/Phase 1.3). IPC returnerer `plan_not_ready` inntil reell base URL er konfigurert.

SundayPlan er SaaS-en for tjeneste­planlegging. SundayRec integrerer i to retninger:

## A) PULL: hent kommende tjenester → auto-planlegg opptak

```
SundayPlan: GET /rest/v1/service?church_id=…&starts_at_utc=gte.…
→ SundayRec: opprett SpecialRecording på starts_at_utc + fyll meta (tittel, taler)
```

IPC: `integrations-plan-fetch-services(fromIso?)` → `{ services[{ id, name, starts_at_utc, _meta:{title,speaker}, _schedule:{date,startTime,stopTime} }] }`

Renderer bruker `_schedule` til å opprette `SpecialRecording` (allerede modellert i `Settings`), og `_meta` til å sette `RecordingMetadata.title`/`.speaker` på filen etter opptak.

## B) PUSH: skriv tilbake streaming-status + opptaks-URL

```
Etter publisering:
  SundayRec → PATCH /rest/v1/service?id=eq.<id>
             { was_streamed_flag: true/false, recording_url: "…" }
```

IPC: `integrations-plan-update-service(serviceId, wasStreamed?, recordingUrl?)`

## Plan-endepunkter (Supabase PostgREST)

| Metode | Sti | Formål |
|---|---|---|
| GET | `/rest/v1/service?church_id=eq.{id}&starts_at_utc=gte.{iso}&order=starts_at_utc.asc&limit=30` | Kommende tjenester |
| PATCH | `/rest/v1/service?id=eq.{id}` | Oppdater streaming-flag + URL |

Krever `Authorization: Bearer <token>` (Supabase JWT med `is_planner_of(church_id)` scope, Phase 1.3).

## Konfigurasjon i SundayRec

- **Plan API URL**: Supabase-prosjektets URL (`https://xxx.supabase.co`), settes i **Tilkobling**-feltet.
- **API-nøkkel** (bearer): deler `sundaySongApiKey`-feltet midlertidig; Plan-sessionen kan legge til eget felt.
- **church_id**: UUID fra SundayPlan, settes i Tilkobling.

## Åpne punkter

- Plan Phase 1.3 (auth) og Phase 1.2 (migrasjoner, Docker) blokkert lokalt.
- Auto-schedule: skal SundayRec automatisk opprette SpecialRecording fra fetch-resultater, eller bare vise dem og la brukeren bekrefte? Plan-UI (fase 4b) avgjør.
- Plan-bearer-token: separat felt vs. felles Sunday-nøkkel?
