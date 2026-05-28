/**
 * Verbatim hand-off.
 *
 * SundayRec records the video; Verbatim is the dedicated captioning tool
 * (per-word confidence, glossary priming, styling, burn-in). This module:
 *   1) builds + launches a `verbatim://import?…` deep link so the user can
 *      send a recording straight into Verbatim, primed with sermon context
 *      and a glossary (e.g. the speaker's name), and
 *   2) imports a subtitle file Verbatim produced (SRT/WebVTT) back into the
 *      recording's `.transcript.json` sidecar, so SundayRec's existing
 *      transcript search/editor consume it with no further work.
 *
 * The deep-link launch is the only Electron dependency; the parsing/convert
 * helpers are pure and unit-tested. Verbatim must register the `verbatim://`
 * scheme (its Phase 8) — see docs/integration/verbatim.md.
 */

import { shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import type { TranscriptData, TranscriptSegment } from '../../types'

export interface VerbatimImportOptions {
  videoPath: string
  language?: string        // ISO 639-1 or 'auto'
  context?: string         // freeform Whisper priming, e.g. "Preken. Taler: Ola Nordmann"
  glossary?: string[]      // bias terms — speaker/place names
}

/** Build the `verbatim://import` deep link. Pure. */
export function buildVerbatimDeepLink(opts: VerbatimImportOptions): string {
  const p = new URLSearchParams()
  p.set('path', opts.videoPath)
  if (opts.language) p.set('language', opts.language)
  if (opts.context)  p.set('context', opts.context)
  if (opts.glossary && opts.glossary.length) p.set('glossary', opts.glossary.join(','))
  p.set('returnTo', 'sundayrec')
  return `verbatim://import?${p.toString()}`
}

/** Launch Verbatim with the video. Resolves false if the OS has no handler
 *  for the `verbatim://` scheme (Verbatim not installed). Never throws. */
export async function launchVerbatim(opts: VerbatimImportOptions): Promise<boolean> {
  try {
    await shell.openExternal(buildVerbatimDeepLink(opts))
    return true
  } catch {
    return false
  }
}

const TS = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/
function parseTimestamp(s: string): number | null {
  const m = TS.exec(s)
  if (!m) return null
  const [, hh, mm, ss, ms] = m
  return (+hh) * 3600 + (+mm) * 60 + (+ss) + (+ms.padEnd(3, '0')) / 1000
}

/** Parse SRT or WebVTT text into transcript segments. Auto-detects format and
 *  tolerates cue numbers, WEBVTT/NOTE headers, BOM, and CRLF. Pure. */
export function parseSubtitles(text: string): TranscriptSegment[] {
  const clean = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const segs: TranscriptSegment[] = []
  for (const block of clean.split(/\n{2,}/)) {
    const lines = block.split('\n').map(l => l.trimEnd())
    const tIdx = lines.findIndex(l => l.includes('-->'))
    if (tIdx < 0) continue                       // WEBVTT header / NOTE / blank
    const [left, right] = lines[tIdx].split('-->')
    const start = parseTimestamp(left ?? '')
    const end   = parseTimestamp(right ?? '')
    if (start == null || end == null) continue
    const segText = lines.slice(tIdx + 1).filter(l => l.length > 0).join(' ').trim()
    if (!segText) continue
    segs.push({ start, end, text: segText })
  }
  return segs
}

/** Convert subtitle text → the `.transcript.json` schema (TranscriptData), so
 *  SundayRec's transcript search/editor consume Verbatim output unchanged. */
export function subtitlesToTranscript(text: string, opts: { language?: string } = {}): TranscriptData {
  const segments = parseSubtitles(text)
  const duration = segments.length ? segments[segments.length - 1].end : 0
  return {
    version: 1,
    model: 'verbatim',
    language: opts.language ?? 'auto',
    duration,
    createdAt: Date.now(),
    segments,
  }
}

/** Read a Verbatim-exported subtitle file and write the recording's
 *  `.transcript.json` sidecar (atomically). Returns the sidecar path.
 *  Throws `no_captions_parsed` if the subtitle file yielded no segments. */
export function importVerbatimCaptions(recordingPath: string, subtitlePath: string, language?: string): string {
  const text = fs.readFileSync(subtitlePath, 'utf8')
  const transcript = subtitlesToTranscript(text, { language })
  if (transcript.segments.length === 0) throw new Error('no_captions_parsed')
  const dir  = path.dirname(recordingPath)
  const base = path.basename(recordingPath, path.extname(recordingPath))
  const out  = path.join(dir, base + '.transcript.json')
  const tmp  = out + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(transcript, null, 2), 'utf8')
  fs.renameSync(tmp, out)
  return out
}
