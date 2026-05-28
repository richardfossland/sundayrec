/**
 * SundayPlan integration.
 *
 * Two flows:
 *   A) PULL: fetch upcoming services from Plan → create SpecialRecording
 *      entries in SundayRec's scheduler, so recordings start automatically
 *      at the right time with metadata pre-filled (title, speaker).
 *   B) PUSH: after a recording is published, write back to Plan:
 *      - Service.was_streamed_flag = true/false
 *      - Attach the recording/podcast URL to the service
 *
 * The Plan API is Supabase-backed and requires auth (Phase 1.3 of SundayPlan).
 * Until that lands, this module is a well-typed stub: the logic compiles,
 * contracts are documented, and the IPC handler returns { ok:false, error:'plan_not_ready' }
 * unless a real base URL + auth token are configured. Everything is opt-in.
 *
 * See docs/integration/plan.md for the full contract.
 */

export interface PlanService {
  id: string
  name: string
  starts_at_utc: string          // ISO datetime, UTC
  state: string
  was_streamed_flag?: boolean
  items?: PlanServiceItem[]
}

export interface PlanServiceItem {
  id: string
  kind: string                   // 'song' | 'sermon' | 'scripture' | …
  label?: string
  duration_min?: number
  song?: { title?: string; tono_work_id?: string; ccli_song_id?: string; sundaysong_id?: string }
  assignment?: { speaker?: string }
}

/** Derive a recording title + speaker from a Plan service. Pure. */
export function serviceToMetadata(service: PlanService): { title: string; speaker: string } {
  const title = service.name || 'Gudstjeneste'

  // Find the sermon item's assignment for the speaker name.
  const sermon = service.items?.find(i => i.kind === 'sermon')
  const speaker = sermon?.assignment?.speaker ?? ''

  return { title, speaker }
}

/** Build a SpecialRecording-compatible schedule object from a Plan service.
 *  Returns null if the service date/time cannot be parsed. Pure. */
export function serviceToSchedule(service: PlanService): {
  date: string; startTime: string; stopTime: string; note: string
} | null {
  const dt = new Date(service.starts_at_utc)
  if (isNaN(dt.getTime())) return null

  const pad2 = (n: number) => String(n).padStart(2, '0')
  const date      = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`
  const startTime = `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`
  // Default 2-hour recording window; Plan duration_min could refine this later.
  const stopDt = new Date(dt.getTime() + 2 * 60 * 60 * 1000)
  const stopTime  = `${pad2(stopDt.getHours())}:${pad2(stopDt.getMinutes())}`

  return { date, startTime, stopTime, note: service.name }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

export interface PlanClientConfig {
  baseUrl: string
  bearer?: string
}

/** Fetch upcoming Plan services (max 30) from `starts_at_utc >= fromIso`. */
export async function fetchUpcomingServices(
  config: PlanClientConfig,
  churchId: string,
  fromIso: string,
): Promise<PlanService[]> {
  const url = `${config.baseUrl}/rest/v1/service?church_id=eq.${encodeURIComponent(churchId)}&starts_at_utc=gte.${encodeURIComponent(fromIso)}&order=starts_at_utc.asc&limit=30`
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Accept': 'application/json' }
  if (config.bearer) headers['Authorization'] = `Bearer ${config.bearer}`

  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`Plan API ${res.status}: ${await res.text().catch(() => res.statusText)}`)
  return res.json() as Promise<PlanService[]>
}

/** Write back streaming flag + recording URL to a Plan service. */
export async function updateServiceRecording(
  config: PlanClientConfig,
  serviceId: string,
  updates: { wasStreamed?: boolean; recordingUrl?: string },
): Promise<void> {
  const url = `${config.baseUrl}/rest/v1/service?id=eq.${encodeURIComponent(serviceId)}`
  const body: Record<string, unknown> = {}
  if (updates.wasStreamed !== undefined) body['was_streamed_flag'] = updates.wasStreamed
  if (updates.recordingUrl) body['recording_url'] = updates.recordingUrl

  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }
  if (config.bearer) headers['Authorization'] = `Bearer ${config.bearer}`

  const res = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`Plan API ${res.status}: ${await res.text().catch(() => res.statusText)}`)
}
