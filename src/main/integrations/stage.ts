/**
 * SundayStage hand-off (auto-chapters + setlist).
 *
 * SundayStage drives the live presentation and persists a cue log of exactly
 * which song/section/scripture was on screen and when. When a recording and a
 * Stage session overlap in time, we can turn that log into:
 *   • chapter markers on the recording (song titles, sermon, scripture), and
 *   • a setlist (songs with cross-suite IDs) — the raw material for the later
 *     SundaySong licensing flow.
 *
 * Stage exports its cue log as a `service-manifest.json` (see
 * docs/integration/stage.md). This module parses that manifest, aligns its
 * absolute timestamps to the recording's start, and produces ChapterMarker[]
 * + SongUsage[]. The parse/align helpers are pure and unit-tested; the apply
 * step writes the recording's `.meta.json` chapters + a `.service.json` link.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { ChapterMarker, RecordingMetadata, ServiceLink, SongUsage } from '../../types'
import { writeServiceLink } from './service-link'

export interface StageManifestSong {
  title?: string
  tonoWorkId?: string
  ccliSongId?: string
  sundaysongId?: string
}
export interface StageManifestItem {
  atMs: number                 // absolute unix ms when first shown
  endMs?: number
  kind: string                 // 'song' | 'scripture' | 'sermon' | 'custom' | …
  label: string                // e.g. "Amazing Grace — Vers 2" or "Preken"
  serviceItemId?: string       // consecutive cues with the same id collapse into one chapter
  song?: StageManifestSong
}
export interface StageManifest {
  source?: string
  serviceId?: string
  churchId?: string
  startedAtMs: number
  endedAtMs?: number
  items: StageManifestItem[]
}

/** Parse + minimally validate a Stage manifest. Returns null on bad input. */
export function parseStageManifest(text: string): StageManifest | null {
  try {
    const m = JSON.parse(text)
    if (!m || typeof m !== 'object') return null
    if (typeof m.startedAtMs !== 'number' || !Array.isArray(m.items)) return null
    return m as StageManifest
  } catch {
    return null
  }
}

/** Best chapter title for an item: a song's clean title beats the cue label
 *  ("Amazing Grace" rather than "Amazing Grace — Vers 2"). */
function chapterTitle(item: StageManifestItem): string {
  if (item.kind === 'song' && item.song?.title) return item.song.title
  return item.label
}

/**
 * Convert a manifest to chapter markers, aligned to the recording.
 * `recordingStartMs` is the recording's start in unix ms; chapter time =
 * (item.atMs - recordingStartMs) / 1000. Items before the recording starts or
 * after it ends (when durationSec is given) are dropped. Consecutive cues from
 * the same service item collapse into a single chapter at the first cue.
 */
export function manifestToChapters(
  manifest: StageManifest,
  recordingStartMs: number,
  durationSec?: number,
): ChapterMarker[] {
  const items = [...manifest.items].sort((a, b) => a.atMs - b.atMs)
  const out: ChapterMarker[] = []
  let lastItemId: string | undefined | null = null
  for (const item of items) {
    const sec = (item.atMs - recordingStartMs) / 1000
    if (sec < 0) continue
    if (durationSec != null && sec > durationSec) continue
    // Collapse consecutive cues of the same service item into one chapter.
    if (item.serviceItemId != null && item.serviceItemId === lastItemId) continue
    lastItemId = item.serviceItemId ?? null
    out.push({ time: Math.max(0, Math.round(sec)), title: chapterTitle(item) })
  }
  return out
}

/** Extract the setlist (songs only) with offsets into the recording. One entry
 *  per distinct song (by serviceItemId, else by first identifier/title). */
export function manifestToSetlist(manifest: StageManifest, recordingStartMs: number): SongUsage[] {
  const items = [...manifest.items].sort((a, b) => a.atMs - b.atMs)
  const byKey = new Map<string, SongUsage>()
  for (const item of items) {
    if (item.kind !== 'song' || !item.song) continue
    const s = item.song
    const key = item.serviceItemId ?? s.sundaysongId ?? s.tonoWorkId ?? s.ccliSongId ?? s.title ?? item.label
    const firstShownSec = Math.max(0, Math.round((item.atMs - recordingStartMs) / 1000))
    const lastEndMs = item.endMs ?? item.atMs
    const existing = byKey.get(key)
    if (existing) {
      // Extend displayed duration to cover the latest cue of this song.
      const endSec = Math.round((lastEndMs - recordingStartMs) / 1000)
      existing.displayedSec = Math.max(existing.displayedSec ?? 0, endSec - (existing.firstShownSec ?? 0))
      continue
    }
    byKey.set(key, {
      title: s.title ?? item.label,
      tonoWorkId: s.tonoWorkId,
      ccliSongId: s.ccliSongId,
      sundaysongId: s.sundaysongId,
      firstShownSec,
      displayedSec: Math.max(0, Math.round((lastEndMs - item.atMs) / 1000)),
    })
  }
  return [...byKey.values()]
}

/** Build the ServiceLink record from a manifest. `wasStreamed` is supplied by
 *  the caller (SundayRec is the source of truth for streaming). */
export function buildServiceLink(
  manifest: StageManifest,
  recordingStartMs: number,
  opts: { wasStreamed?: boolean; serviceDate?: string } = {},
): ServiceLink {
  return {
    source: 'stage',
    serviceId: manifest.serviceId,
    churchId: manifest.churchId,
    serviceDate: opts.serviceDate,
    wasStreamed: opts.wasStreamed,
    setlist: manifestToSetlist(manifest, recordingStartMs),
    linkedAt: Date.now(),
  }
}

function metaSidecarPath(recordingPath: string): string {
  const dir  = path.dirname(recordingPath)
  const base = path.basename(recordingPath, path.extname(recordingPath))
  return path.join(dir, base + '.meta.json')
}

/** Read the recording's existing metadata sidecar, or a blank record. */
function readMeta(recordingPath: string): RecordingMetadata {
  try {
    const raw = JSON.parse(fs.readFileSync(metaSidecarPath(recordingPath), 'utf8'))
    if (raw && typeof raw === 'object') {
      return {
        title: typeof raw.title === 'string' ? raw.title : '',
        speaker: typeof raw.speaker === 'string' ? raw.speaker : '',
        description: typeof raw.description === 'string' ? raw.description : '',
        chapters: Array.isArray(raw.chapters) ? raw.chapters : [],
      }
    }
  } catch { /* no/blank sidecar */ }
  return { title: '', speaker: '', description: '', chapters: [] }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

export interface StageApplyResult {
  chapterCount: number
  songCount: number
  serviceLinkPath: string
  metaPath: string
}

/**
 * Apply a Stage manifest to a recording: write Stage's chapters into the
 * recording's `.meta.json` (preserving title/speaker/description) and write a
 * `.service.json` link with the setlist. Replaces any existing chapters —
 * Stage is authoritative for the service structure. Throws on fs/parse fail.
 */
export function applyStageManifest(
  recordingPath: string,
  manifestPath: string,
  recordingStartMs: number,
  opts: { durationSec?: number; wasStreamed?: boolean; serviceDate?: string } = {},
): StageApplyResult {
  const manifest = parseStageManifest(fs.readFileSync(manifestPath, 'utf8'))
  if (!manifest) throw new Error('invalid_manifest')

  const chapters = manifestToChapters(manifest, recordingStartMs, opts.durationSec)
  const meta = readMeta(recordingPath)
  meta.chapters = chapters
  const metaPath = metaSidecarPath(recordingPath)
  writeJsonAtomic(metaPath, meta)

  const link = buildServiceLink(manifest, recordingStartMs, { wasStreamed: opts.wasStreamed, serviceDate: opts.serviceDate })
  const linkPath = writeServiceLink(recordingPath, link)

  return { chapterCount: chapters.length, songCount: link.setlist.length, serviceLinkPath: linkPath, metaPath }
}
