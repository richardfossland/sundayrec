/**
 * Tests for src/main/integrations/service-link.ts
 *
 * Pure fs + JSON sidecar I/O. We sandbox into os.tmpdir() and use the real
 * `fs` module (same pattern as editor.test.ts / cloud-http-util.test.ts).
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  serviceLinkPath,
  readServiceLink,
  writeServiceLink,
  deleteServiceLink,
} from '../src/main/integrations/service-link'
import type { ServiceLink } from '../src/types'

let sandbox: string

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'service-link-test-'))
})
afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true })
})

const sampleLink: ServiceLink = {
  source: 'stage',
  serviceId: 'svc-1',
  churchId: 'church-1',
  serviceDate: '2026-05-31',
  wasStreamed: true,
  setlist: [
    { title: 'Amazing Grace', tonoWorkId: 'T-123', firstShownSec: 42, displayedSec: 180 },
    { title: 'Be Thou My Vision', ccliSongId: '30639', sundaysongId: 'uuid-abc' },
  ],
  linkedAt: 1_700_000_000_000,
}

describe('serviceLinkPath', () => {
  it('swaps the recording extension for .service.json beside the file', () => {
    expect(serviceLinkPath(path.join(sandbox, '2026-05-31.mp3')))
      .toBe(path.join(sandbox, '2026-05-31.service.json'))
    // Multi-dot filenames: only the final extension is replaced.
    expect(serviceLinkPath(path.join(sandbox, 'gudstjeneste.2026.05.31.mov')))
      .toBe(path.join(sandbox, 'gudstjeneste.2026.05.31.service.json'))
  })
})

describe('write + read round-trip', () => {
  it('writes a sidecar and reads back an identical link', () => {
    const rec = path.join(sandbox, 'rec.wav')
    const out = writeServiceLink(rec, sampleLink)
    expect(out).toBe(path.join(sandbox, 'rec.service.json'))
    expect(fs.existsSync(out)).toBe(true)
    expect(readServiceLink(rec)).toEqual(sampleLink)
  })

  it('leaves no .tmp file behind after an atomic write', () => {
    const rec = path.join(sandbox, 'rec.flac')
    writeServiceLink(rec, sampleLink)
    expect(fs.readdirSync(sandbox).some(n => n.endsWith('.tmp'))).toBe(false)
  })
})

describe('readServiceLink resilience', () => {
  it('returns null when no sidecar exists', () => {
    expect(readServiceLink(path.join(sandbox, 'absent.mp3'))).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    const rec = path.join(sandbox, 'bad.mp3')
    fs.writeFileSync(serviceLinkPath(rec), '{ not json', 'utf8')
    expect(readServiceLink(rec)).toBeNull()
  })

  it('returns null when the shape is wrong (no setlist array)', () => {
    const rec = path.join(sandbox, 'wrong.mp3')
    fs.writeFileSync(serviceLinkPath(rec), JSON.stringify({ source: 'manual' }), 'utf8')
    expect(readServiceLink(rec)).toBeNull()
  })
})

describe('deleteServiceLink', () => {
  it('removes an existing sidecar and is a no-op when absent', () => {
    const rec = path.join(sandbox, 'rec.mp3')
    writeServiceLink(rec, sampleLink)
    deleteServiceLink(rec)
    expect(fs.existsSync(serviceLinkPath(rec))).toBe(false)
    // Second delete must not throw.
    expect(() => deleteServiceLink(rec)).not.toThrow()
  })
})
