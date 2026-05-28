/**
 * Tests for src/main/integrations/song.ts — pure helpers only.
 * submitUsageLog makes real HTTP calls; not tested here (would need mock server).
 */

import {
  buildUsagePayloads,
  type UsageLogPayload,
} from '../src/main/integrations/song'
import type { ServiceLink, IntegrationSettings } from '../src/types'

const churchId = 'church-uuid-123'

const link: ServiceLink = {
  source: 'stage',
  serviceId: 'svc-1',
  churchId,
  serviceDate: '2026-06-01',
  wasStreamed: true,
  setlist: [
    {
      title: 'Amazing Grace',
      tonoWorkId: 'T-100',
      ccliSongId: '22025',
      sundaysongId: 'sg-uuid-1',
      firstShownSec: 60,
      displayedSec: 180,
    },
    {
      title: 'Be Thou My Vision',
      ccliSongId: '30639',
      firstShownSec: 900,
      displayedSec: 210,
    },
  ],
  linkedAt: Date.now(),
}

const settings: Pick<IntegrationSettings, 'connection'> = {
  connection: { churchId, songApiUrl: 'https://api.sundaysong.com' },
}

describe('buildUsagePayloads', () => {
  it('returns one payload per song', () => {
    const payloads = buildUsagePayloads(link, settings)
    expect(payloads).toHaveLength(2)
  })

  it('sets was_streamed from the ServiceLink', () => {
    const payloads = buildUsagePayloads(link, settings)
    expect(payloads.every((p: UsageLogPayload) => p.was_streamed === true)).toBe(true)
  })

  it('carries tono/ccli/sundaysong IDs', () => {
    const payloads = buildUsagePayloads(link, settings)
    const ag = payloads.find((p: UsageLogPayload) => p.title === 'Amazing Grace')!
    expect(ag.tono_work_id).toBe('T-100')
    expect(ag.ccli_song_id).toBe('22025')
    expect(ag.song_id).toBe('sg-uuid-1')
    expect(ag.duration_displayed_sec).toBe(180)
  })

  it('builds deterministic idempotency key including churchId, date, and song id', () => {
    const payloads = buildUsagePayloads(link, settings)
    const ag = payloads.find((p: UsageLogPayload) => p.title === 'Amazing Grace')!
    expect(ag.idempotency_key).toBe(`${churchId}|2026-06-01|sg-uuid-1`)
  })

  it('falls back to tonoWorkId then ccliSongId then title in idempotency key', () => {
    const payloads = buildUsagePayloads(link, settings)
    const bv = payloads.find((p: UsageLogPayload) => p.title === 'Be Thou My Vision')!
    expect(bv.idempotency_key).toBe(`${churchId}|2026-06-01|30639`)
  })

  it('returns empty array when churchId is missing', () => {
    const noChurch: Pick<IntegrationSettings, 'connection'> = { connection: {} }
    expect(buildUsagePayloads(link, noChurch)).toEqual([])
  })

  it('returns empty array when serviceDate is missing', () => {
    const noDate: ServiceLink = { ...link, serviceDate: undefined }
    expect(buildUsagePayloads(noDate, settings)).toEqual([])
  })

  it('returns empty array when setlist is empty', () => {
    const noSongs: ServiceLink = { ...link, setlist: [] }
    expect(buildUsagePayloads(noSongs, settings)).toEqual([])
  })
})
