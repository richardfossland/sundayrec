/**
 * SundaySong licensing / usage integration.
 *
 * After a service recording is published, SundayRec sends one UsageLogPayload
 * per song to SundaySong's POST /v1/usage/log endpoint. This lets SundaySong
 * generate CCLI and TONO reports for the church.
 *
 * SundayRec is the source of truth for `was_streamed` (it knows whether the
 * service was live-streamed). Songs and their IDs come from a ServiceLink
 * sidecar (written by the Stage integration in fase 2, or set manually).
 *
 * The HTTP call is intentionally thin — no SDK dependency here so SundayRec
 * doesn't couple to an unversioned workspace package. If SundaySong ships an
 * npm package later, swap the fetch call.
 *
 * See docs/integration/song.md for the full contract.
 */

import type { ServiceLink, SongUsage, IntegrationSettings } from '../../types'

export interface UsageLogPayload {
  church_id: string
  song_id?: string           // SundaySong UUID (if known)
  tono_work_id?: string      // fallback identifier
  ccli_song_id?: string      // fallback identifier
  title?: string             // fallback for manual matching
  service_date: string       // YYYY-MM-DD
  duration_displayed_sec?: number
  was_streamed: boolean
  idempotency_key: string    // "<churchId>|<serviceDate>|<songId or tonoId or title>"
}

/** Build usage payloads from a ServiceLink. Returns empty array if no church_id
 *  is configured or the setlist is empty. Pure — no I/O. */
export function buildUsagePayloads(
  link: ServiceLink,
  settings: Pick<IntegrationSettings, 'connection'>,
): UsageLogPayload[] {
  const churchId = settings.connection?.churchId
  if (!churchId || !link.setlist.length || !link.serviceDate) return []

  return link.setlist.map((song: SongUsage): UsageLogPayload => {
    const key = [
      churchId,
      link.serviceDate,
      song.sundaysongId ?? song.tonoWorkId ?? song.ccliSongId ?? song.title ?? 'unknown',
    ].join('|')

    return {
      church_id:             churchId,
      song_id:               song.sundaysongId,
      tono_work_id:          song.tonoWorkId,
      ccli_song_id:          song.ccliSongId,
      title:                 song.title,
      service_date:          link.serviceDate!,
      duration_displayed_sec: song.displayedSec,
      was_streamed:          link.wasStreamed ?? false,
      idempotency_key:       key,
    }
  })
}

export interface SubmitUsageResult {
  submitted: number
  skipped:   number
  errors:    Array<{ key: string; error: string }>
}

/** POST each payload to SundaySong's /v1/usage/log. Best-effort: errors are
 *  collected but don't stop the remaining entries. Returns a summary. */
export async function submitUsageLog(
  payloads: UsageLogPayload[],
  baseUrl: string,
  apiKey?: string,
): Promise<SubmitUsageResult> {
  const result: SubmitUsageResult = { submitted: 0, skipped: 0, errors: [] }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  for (const payload of payloads) {
    try {
      const res = await fetch(`${baseUrl}/v1/usage/log`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      })
      if (res.ok || res.status === 409) {
        // 409 = duplicate idempotency key → already submitted, count as ok.
        result.submitted++
      } else {
        const text = await res.text().catch(() => res.statusText)
        result.errors.push({ key: payload.idempotency_key, error: `HTTP ${res.status}: ${text}` })
      }
    } catch (err) {
      result.errors.push({ key: payload.idempotency_key, error: (err as Error).message })
    }
  }
  result.skipped = payloads.length - result.submitted - result.errors.length
  return result
}
