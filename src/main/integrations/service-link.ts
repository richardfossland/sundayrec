/**
 * Service-link sidecar I/O.
 *
 * A "service link" records the external (Sunday-suite) context of one
 * recording: which planned service it belongs to, the setlist of songs that
 * were used, and whether it was streamed. It is persisted as a
 * `<recording>.service.json` sidecar next to the audio/video file — the same
 * convention as `.transcript.json`. This keeps the link self-contained with
 * the recording (survives folder moves, backups, etc.) and means the core
 * recording store never has to know about integrations.
 *
 * Pure fs + JSON; no Electron imports, so it's unit-testable in isolation.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { ServiceLink } from '../../types'

const SIDECAR_SUFFIX = '.service.json'

/** Maps a recording file path to its service-link sidecar path. The sidecar
 *  sits beside the recording with the extension swapped, e.g.
 *  `/rec/2026-05-31.mp3` → `/rec/2026-05-31.service.json`. */
export function serviceLinkPath(recordingPath: string): string {
  const dir  = path.dirname(recordingPath)
  const base = path.basename(recordingPath).replace(/\.[^.]+$/, '')
  return path.join(dir, base + SIDECAR_SUFFIX)
}

/** Reads the service link for a recording, or null if none exists / is
 *  malformed. Never throws — a missing or corrupt sidecar is just "no link". */
export function readServiceLink(recordingPath: string): ServiceLink | null {
  try {
    const raw = fs.readFileSync(serviceLinkPath(recordingPath), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    if (!Array.isArray((parsed as ServiceLink).setlist)) return null
    return parsed as ServiceLink
  } catch {
    return null
  }
}

/** Writes (atomically) the service link sidecar for a recording. Returns the
 *  sidecar path on success. Throws only on a genuine fs failure. */
export function writeServiceLink(recordingPath: string, link: ServiceLink): string {
  const out = serviceLinkPath(recordingPath)
  const tmp = out + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(link, null, 2), 'utf8')
  fs.renameSync(tmp, out)
  return out
}

/** Removes the service-link sidecar if present. Best-effort; never throws. */
export function deleteServiceLink(recordingPath: string): void {
  try { fs.rmSync(serviceLinkPath(recordingPath)) } catch { /* nothing to delete */ }
}
