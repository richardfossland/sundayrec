/**
 * Tests for src/main/integrations/stage.ts
 *
 * Covers the pure helpers (manifest parse, chapter alignment, setlist
 * extraction) and the fs-backed applyStageManifest (sandboxed in tmpdir).
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  parseStageManifest,
  manifestToChapters,
  manifestToSetlist,
  buildServiceLink,
  applyStageManifest,
  type StageManifest,
} from '../src/main/integrations/stage'

const BASE_MS = 1_748_700_000_000 // arbitrary unix ms "recording start"

const sampleManifest: StageManifest = {
  source: 'sundaystage',
  serviceId: 'svc-1',
  churchId: 'church-1',
  startedAtMs: BASE_MS,
  endedAtMs: BASE_MS + 3600_000,
  items: [
    {
      atMs: BASE_MS + 0,
      kind: 'song',
      label: 'Amazing Grace — Vers 1',
      serviceItemId: 'item-1',
      song: { title: 'Amazing Grace', tonoWorkId: 'T-100', ccliSongId: '22025' },
    },
    // Second cue of same song — should collapse into first chapter
    {
      atMs: BASE_MS + 90_000,
      kind: 'song',
      label: 'Amazing Grace — Vers 2',
      serviceItemId: 'item-1',
      song: { title: 'Amazing Grace', tonoWorkId: 'T-100', ccliSongId: '22025', },
      endMs: BASE_MS + 180_000,
    },
    {
      atMs: BASE_MS + 300_000,
      kind: 'sermon',
      label: 'Preken',
      serviceItemId: 'item-2',
    },
    {
      atMs: BASE_MS + 1800_000,
      kind: 'song',
      label: 'Be Thou My Vision',
      serviceItemId: 'item-3',
      song: { title: 'Be Thou My Vision', ccliSongId: '30639' },
    },
    // Item with no serviceItemId — should not collapse with anything
    {
      atMs: BASE_MS + 2100_000,
      kind: 'custom',
      label: 'Avslutning',
    },
  ],
}

describe('parseStageManifest', () => {
  it('round-trips a valid manifest', () => {
    const m = parseStageManifest(JSON.stringify(sampleManifest))
    expect(m?.serviceId).toBe('svc-1')
    expect(m?.items).toHaveLength(5)
  })
  it('returns null for bad JSON', () => {
    expect(parseStageManifest('{ not json')).toBeNull()
  })
  it('returns null when startedAtMs or items are missing', () => {
    expect(parseStageManifest(JSON.stringify({ items: [] }))).toBeNull()
    expect(parseStageManifest(JSON.stringify({ startedAtMs: 0 }))).toBeNull()
  })
})

describe('manifestToChapters', () => {
  it('aligns timestamps to the recording start', () => {
    const chapters = manifestToChapters(sampleManifest, BASE_MS)
    // Amazing Grace at 0s, Preken at 300s, Be Thou My Vision at 1800s, Avslutning at 2100s
    expect(chapters[0]).toEqual({ time: 0, title: 'Amazing Grace' })
    expect(chapters[1]).toEqual({ time: 300, title: 'Preken' })
    expect(chapters[2]).toEqual({ time: 1800, title: 'Be Thou My Vision' })
    expect(chapters[3]).toEqual({ time: 2100, title: 'Avslutning' })
  })

  it('collapses consecutive cues of the same serviceItemId', () => {
    const chapters = manifestToChapters(sampleManifest, BASE_MS)
    expect(chapters).toHaveLength(4) // Amazing Grace (2 cues) → 1 chapter
  })

  it('drops items before the recording starts (negative offset)', () => {
    const chapters = manifestToChapters(sampleManifest, BASE_MS + 400_000)
    // Only items from 400s onwards: Preken (-offset, dropped), Be Thou (1400s), Avslutning (1700s)
    expect(chapters.every(c => c.time >= 0)).toBe(true)
  })

  it('drops items beyond durationSec', () => {
    const chapters = manifestToChapters(sampleManifest, BASE_MS, 500)
    // Only Amazing Grace (0s) and Preken (300s) fit within 500s
    expect(chapters).toHaveLength(2)
    expect(chapters[1].title).toBe('Preken')
  })

  it('sorts by timestamp regardless of manifest order', () => {
    const shuffled: StageManifest = {
      ...sampleManifest,
      items: [...sampleManifest.items].reverse(),
    }
    const chapters = manifestToChapters(shuffled, BASE_MS)
    for (let i = 1; i < chapters.length; i++) {
      expect(chapters[i].time).toBeGreaterThanOrEqual(chapters[i - 1].time)
    }
  })
})

describe('manifestToSetlist', () => {
  it('returns one entry per distinct song', () => {
    const setlist = manifestToSetlist(sampleManifest, BASE_MS)
    expect(setlist).toHaveLength(2)
    const titles = setlist.map(s => s.title)
    expect(titles).toContain('Amazing Grace')
    expect(titles).toContain('Be Thou My Vision')
  })

  it('carries tono/ccli IDs through', () => {
    const setlist = manifestToSetlist(sampleManifest, BASE_MS)
    const ag = setlist.find(s => s.title === 'Amazing Grace')!
    expect(ag.tonoWorkId).toBe('T-100')
    expect(ag.ccliSongId).toBe('22025')
  })

  it('ignores non-song items (sermon, custom)', () => {
    const setlist = manifestToSetlist(sampleManifest, BASE_MS)
    expect(setlist.every(s => s.title !== 'Preken' && s.title !== 'Avslutning')).toBe(true)
  })
})

describe('buildServiceLink', () => {
  it('sets source=stage and includes setlist', () => {
    const link = buildServiceLink(sampleManifest, BASE_MS, { wasStreamed: true, serviceDate: '2026-05-31' })
    expect(link.source).toBe('stage')
    expect(link.wasStreamed).toBe(true)
    expect(link.serviceDate).toBe('2026-05-31')
    expect(link.setlist).toHaveLength(2)
  })
})

describe('applyStageManifest', () => {
  let sandbox: string
  beforeEach(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-test-')) })
  afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }) })

  it('writes chapters to .meta.json and setlist to .service.json', () => {
    const rec = path.join(sandbox, 'rec.mp3')
    const manifestFile = path.join(sandbox, 'service-manifest.json')
    fs.writeFileSync(manifestFile, JSON.stringify(sampleManifest))

    const result = applyStageManifest(rec, manifestFile, BASE_MS)

    expect(result.chapterCount).toBe(4)
    expect(result.songCount).toBe(2)

    const meta = JSON.parse(fs.readFileSync(result.metaPath, 'utf8'))
    expect(meta.chapters[0]).toEqual({ time: 0, title: 'Amazing Grace' })
    expect(meta.chapters[1]).toEqual({ time: 300, title: 'Preken' })

    const link = JSON.parse(fs.readFileSync(result.serviceLinkPath, 'utf8'))
    expect(link.source).toBe('stage')
    expect(link.setlist).toHaveLength(2)
  })

  it('preserves existing title/speaker/description in .meta.json', () => {
    const rec = path.join(sandbox, 'rec.mp3')
    const metaPath = path.join(sandbox, 'rec.meta.json')
    fs.writeFileSync(metaPath, JSON.stringify({ title: 'Gudstjeneste', speaker: 'Ola', description: 'Mai', chapters: [] }))
    const manifestFile = path.join(sandbox, 'service-manifest.json')
    fs.writeFileSync(manifestFile, JSON.stringify(sampleManifest))

    applyStageManifest(rec, manifestFile, BASE_MS)

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    expect(meta.title).toBe('Gudstjeneste')
    expect(meta.speaker).toBe('Ola')
    expect(meta.chapters.length).toBeGreaterThan(0)
  })

  it('throws invalid_manifest for bad manifest JSON', () => {
    const rec = path.join(sandbox, 'rec.mp3')
    const bad = path.join(sandbox, 'bad.json')
    fs.writeFileSync(bad, '{ not json')
    expect(() => applyStageManifest(rec, bad, BASE_MS)).toThrow('invalid_manifest')
  })
})
