/**
 * Tests for src/main/integrations/verbatim.ts
 *
 * Covers the pure helpers (deep-link build, SRT/VTT parsing, transcript
 * conversion) and the fs-backed importVerbatimCaptions (sandboxed in tmpdir).
 * launchVerbatim is not tested here — it only wraps electron's shell.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  buildVerbatimDeepLink,
  parseSubtitles,
  subtitlesToTranscript,
  importVerbatimCaptions,
} from '../src/main/integrations/verbatim'

describe('buildVerbatimDeepLink', () => {
  it('encodes path, language, context, glossary and returnTo', () => {
    const url = buildVerbatimDeepLink({
      videoPath: '/rec/2026-05-31.mp4',
      language: 'no',
      context: 'Preken. Taler: Ola Nordmann',
      glossary: ['Ola Nordmann', 'Betlehem'],
    })
    expect(url.startsWith('verbatim://import?')).toBe(true)
    const q = new URLSearchParams(url.split('?')[1])
    expect(q.get('path')).toBe('/rec/2026-05-31.mp4')
    expect(q.get('language')).toBe('no')
    expect(q.get('context')).toBe('Preken. Taler: Ola Nordmann')
    expect(q.get('glossary')).toBe('Ola Nordmann,Betlehem')
    expect(q.get('returnTo')).toBe('sundayrec')
  })

  it('omits optional fields when absent', () => {
    const q = new URLSearchParams(buildVerbatimDeepLink({ videoPath: '/a.mov' }).split('?')[1])
    expect(q.get('path')).toBe('/a.mov')
    expect(q.has('language')).toBe(false)
    expect(q.has('context')).toBe(false)
    expect(q.has('glossary')).toBe(false)
  })
})

describe('parseSubtitles', () => {
  it('parses SRT (comma ms, cue numbers)', () => {
    const srt = '1\n00:00:01,000 --> 00:00:04,000\nHello world\n\n2\n00:01:05,500 --> 00:01:08,250\nSecond\nline\n'
    expect(parseSubtitles(srt)).toEqual([
      { start: 1, end: 4, text: 'Hello world' },
      { start: 65.5, end: 68.25, text: 'Second line' },
    ])
  })

  it('parses WebVTT (dot ms, WEBVTT header, NOTE block)', () => {
    const vtt = 'WEBVTT\n\nNOTE this is a comment\n\n00:00:02.000 --> 00:00:03.500\nHei\n\n00:00:10.000 --> 00:00:12.000\nVerden\n'
    expect(parseSubtitles(vtt)).toEqual([
      { start: 2, end: 3.5, text: 'Hei' },
      { start: 10, end: 12, text: 'Verden' },
    ])
  })

  it('tolerates CRLF and a UTF-8 BOM', () => {
    const srt = '﻿1\r\n00:00:00,000 --> 00:00:01,000\r\nA\r\n'
    expect(parseSubtitles(srt)).toEqual([{ start: 0, end: 1, text: 'A' }])
  })

  it('returns [] for content with no timing lines', () => {
    expect(parseSubtitles('WEBVTT\n\njust some text\n')).toEqual([])
  })
})

describe('subtitlesToTranscript', () => {
  it('builds a v1 TranscriptData with model=verbatim and duration=last end', () => {
    const t = subtitlesToTranscript('00:00:01,000 --> 00:00:04,000\nHi\n', { language: 'en' })
    expect(t.version).toBe(1)
    expect(t.model).toBe('verbatim')
    expect(t.language).toBe('en')
    expect(t.duration).toBe(4)
    expect(t.segments).toHaveLength(1)
    expect(typeof t.createdAt).toBe('number')
  })

  it('defaults language to auto and duration to 0 when empty', () => {
    const t = subtitlesToTranscript('WEBVTT\n')
    expect(t.language).toBe('auto')
    expect(t.duration).toBe(0)
    expect(t.segments).toEqual([])
  })
})

describe('importVerbatimCaptions', () => {
  let sandbox: string
  beforeEach(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-test-')) })
  afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }) })

  it('writes <recording>.transcript.json from an SRT file', () => {
    const rec = path.join(sandbox, 'gudstjeneste.mp4')
    const srt = path.join(sandbox, 'captions.srt')
    fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:03,000\nVelkommen\n')
    const out = importVerbatimCaptions(rec, srt, 'no')
    expect(out).toBe(path.join(sandbox, 'gudstjeneste.transcript.json'))
    const written = JSON.parse(fs.readFileSync(out, 'utf8'))
    expect(written.model).toBe('verbatim')
    expect(written.language).toBe('no')
    expect(written.segments).toEqual([{ start: 1, end: 3, text: 'Velkommen' }])
  })

  it('throws no_captions_parsed when the subtitle file has no cues', () => {
    const rec = path.join(sandbox, 'rec.mp4')
    const empty = path.join(sandbox, 'empty.vtt')
    fs.writeFileSync(empty, 'WEBVTT\n')
    expect(() => importVerbatimCaptions(rec, empty)).toThrow('no_captions_parsed')
  })
})
