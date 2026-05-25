/**
 * Tests for cloud/dropbox.ts — upload_session/start/append_v2/finish,
 * getUserInfo, listFolders.
 */

jest.mock('electron')

import {
  uploadFile,
  getUserInfo,
  listFolders,
} from '../src/main/cloud/dropbox'
import { CHUNK_SIZE, dropboxContentHash } from '../src/main/cloud/http-util'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import crypto from 'crypto'

// ─── fetch mocking ────────────────────────────────────────────────────────────

type MockResponseSpec = {
  status: number
  headers?: Record<string, string>
  json?: unknown
  text?: string
}
type FetchCall = { url: string; init: RequestInit }

let fetchCalls: FetchCall[] = []
let fetchQueue: Array<MockResponseSpec | ((call: FetchCall) => MockResponseSpec)> = []

function mockResponse(spec: MockResponseSpec): Response {
  const headers = new Headers(spec.headers ?? {})
  const body = spec.text ?? (spec.json !== undefined ? JSON.stringify(spec.json) : '')
  const res = new Response(body, { status: spec.status, headers })
  if (spec.json !== undefined) {
    Object.defineProperty(res, 'json', { value: async () => spec.json })
  }
  return res
}
function installFetchMock() {
  ;(globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(
    async (url: string, init: RequestInit = {}) => {
      const call = { url: String(url), init }
      fetchCalls.push(call)
      const next = fetchQueue.shift()
      if (!next) throw new Error(`Unexpected fetch: ${url}`)
      const spec = typeof next === 'function' ? next(call) : next
      return mockResponse(spec)
    },
  )
}

let tmpDir = ''
beforeEach(() => {
  fetchCalls = []
  fetchQueue = []
  installFetchMock()
  tmpDir = mkdtempSync(path.join(tmpdir(), 'sr-drop-'))
})
afterEach(() => {
  jest.restoreAllMocks()
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* noop */ }
})

function writeTmpFile(name: string, content: Buffer): string {
  const p = path.join(tmpDir, name)
  writeFileSync(p, content)
  return p
}

function parseArg(call: FetchCall): Record<string, unknown> {
  const h = call.init.headers as Record<string, string>
  return JSON.parse(h['Dropbox-API-Arg'])
}

// ─────────────────────────────────────────────────────────────────────────────
// getUserInfo
// ─────────────────────────────────────────────────────────────────────────────

describe('dropbox.getUserInfo', () => {
  it('returns display name and email on 200', async () => {
    fetchQueue.push({
      status: 200,
      json: { name: { display_name: 'Kari Nordmann' }, email: 'kari@example.no' },
    })
    const info = await getUserInfo('tkn')
    expect(info).toEqual({ name: 'Kari Nordmann', email: 'kari@example.no' })
    expect(fetchCalls[0].url).toBe('https://api.dropboxapi.com/2/users/get_current_account')
    expect(fetchCalls[0].init.method).toBe('POST')
  })

  it('returns empty strings when fields missing', async () => {
    fetchQueue.push({ status: 200, json: {} })
    expect(await getUserInfo('tkn')).toEqual({ name: '', email: '' })
  })

  it('throws on 401', async () => {
    fetchQueue.push({ status: 401, text: 'bad token' })
    await expect(getUserInfo('bad')).rejects.toThrow(/401/)
  })

  it('retries on 500 then succeeds', async () => {
    fetchQueue.push({ status: 500, text: 'down' })
    fetchQueue.push({ status: 200, json: { name: { display_name: 'X' }, email: 'x@x' } })
    const info = await getUserInfo('tkn')
    expect(info.email).toBe('x@x')
  }, 15_000)

  it('does not retry on persistent network error beyond cap', async () => {
    for (let i = 0; i < 5; i++) fetchQueue.push(() => { throw new TypeError('fetch failed') })
    await expect(getUserInfo('tkn')).rejects.toThrow(/fetch failed/)
  }, 60_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// listFolders
// ─────────────────────────────────────────────────────────────────────────────

describe('dropbox.listFolders', () => {
  it('returns only folder-tagged entries', async () => {
    fetchQueue.push({
      status: 200,
      json: {
        entries: [
          { '.tag': 'folder', id: 'id:1', name: 'A', path_lower: '/a' },
          { '.tag': 'file',   id: 'id:2', name: 'B.mp3', path_lower: '/b.mp3' },
          { '.tag': 'folder', id: 'id:3', name: 'C', path_lower: '/c' },
        ],
      },
    })
    const out = await listFolders('tkn')
    expect(out).toEqual([
      { id: 'id:1', name: 'A', path: '/a' },
      { id: 'id:3', name: 'C', path: '/c' },
    ])
  })

  it('sends path: "" for root by default', async () => {
    fetchQueue.push({ status: 200, json: { entries: [] } })
    await listFolders('tkn')
    const body = JSON.parse(fetchCalls[0].init.body as string)
    expect(body.path).toBe('')
    expect(body.recursive).toBe(false)
  })

  it('sends provided folderPath', async () => {
    fetchQueue.push({ status: 200, json: { entries: [] } })
    await listFolders('tkn', '/Innspilling/Søndag')
    const body = JSON.parse(fetchCalls[0].init.body as string)
    expect(body.path).toBe('/Innspilling/Søndag')
  })

  it('returns empty array when entries field missing', async () => {
    fetchQueue.push({ status: 200, json: {} })
    expect(await listFolders('tkn')).toEqual([])
  })

  it('throws on 401', async () => {
    fetchQueue.push({ status: 401, text: 'unauth' })
    await expect(listFolders('bad')).rejects.toThrow(/401/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// uploadFile — small file (single chunk via session start+finish)
// ─────────────────────────────────────────────────────────────────────────────

describe('dropbox.uploadFile — small file', () => {
  it('uses upload_session/start with close:true and upload_session/finish for small file', async () => {
    const data = Buffer.from('small')
    const fp = writeTmpFile('small.mp3', data)
    const expectedHash = await dropboxContentHash(fp)

    // start
    fetchQueue.push({ status: 200, json: { session_id: 'sess-1' } })
    // finish
    fetchQueue.push({
      status: 200,
      json: { path_display: '/small.mp3', content_hash: expectedHash },
    })

    const out = await uploadFile('tkn', fp)
    expect(out).toBe('/small.mp3')
    expect(fetchCalls).toHaveLength(2)

    // Verify session/start
    expect(fetchCalls[0].url).toBe('https://content.dropboxapi.com/2/files/upload_session/start')
    const startArg = parseArg(fetchCalls[0])
    expect(startArg.close).toBe(true)
    expect(Buffer.compare(fetchCalls[0].init.body as Buffer, data)).toBe(0)

    // Verify session/finish
    expect(fetchCalls[1].url).toBe('https://content.dropboxapi.com/2/files/upload_session/finish')
    const finishArg = parseArg(fetchCalls[1])
    expect((finishArg.cursor as { session_id: string }).session_id).toBe('sess-1')
    expect((finishArg.cursor as { offset: number }).offset).toBe(data.length)
    expect((finishArg.commit as { path: string }).path).toBe('/small.mp3')
    expect((finishArg.commit as { mode: string }).mode).toBe('add')
    expect((finishArg.commit as { autorename: boolean }).autorename).toBe(true)
  })

  it('uses destFolder when supplied', async () => {
    const fp = writeTmpFile('a.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 200, json: { session_id: 's' } })
    fetchQueue.push({ status: 200, json: { path_display: '/Sermons/a.mp3' } })
    await uploadFile('tkn', fp, '/Sermons')
    const finishArg = parseArg(fetchCalls[1])
    expect((finishArg.commit as { path: string }).path).toBe('/Sermons/a.mp3')
  })

  it('strips trailing slash from destFolder', async () => {
    const fp = writeTmpFile('a.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 200, json: { session_id: 's' } })
    fetchQueue.push({ status: 200, json: { path_display: '/Sermons/a.mp3' } })
    await uploadFile('tkn', fp, '/Sermons/')
    const finishArg = parseArg(fetchCalls[1])
    expect((finishArg.commit as { path: string }).path).toBe('/Sermons/a.mp3')
  })

  it('falls back to destPath when path_display missing', async () => {
    const fp = writeTmpFile('a.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 200, json: { session_id: 's' } })
    fetchQueue.push({ status: 200, json: {} })
    const out = await uploadFile('tkn', fp)
    expect(out).toBe('/a.mp3')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// uploadFile — chunked
// ─────────────────────────────────────────────────────────────────────────────

describe('dropbox.uploadFile — chunked', () => {
  it('uses append_v2 for intermediate chunk on file > CHUNK_SIZE', async () => {
    const size = Math.floor(CHUNK_SIZE * 1.5)
    const data = crypto.randomBytes(size)
    const fp = writeTmpFile('big.mp3', data)

    // start (close: false because size > firstSize)
    fetchQueue.push({ status: 200, json: { session_id: 'sess-big' } })
    // append_v2 (final chunk)
    fetchQueue.push({ status: 200, text: '' })
    // finish
    fetchQueue.push({ status: 200, json: { path_display: '/big.mp3' } })

    await uploadFile('tkn', fp)
    expect(fetchCalls).toHaveLength(3)

    // start: close=false
    expect(parseArg(fetchCalls[0]).close).toBe(false)
    expect((fetchCalls[0].init.body as Buffer).length).toBe(CHUNK_SIZE)

    // append: cursor.offset = CHUNK_SIZE, close=true
    expect(fetchCalls[1].url).toBe('https://content.dropboxapi.com/2/files/upload_session/append_v2')
    const appendArg = parseArg(fetchCalls[1])
    expect((appendArg.cursor as { offset: number }).offset).toBe(CHUNK_SIZE)
    expect((appendArg.cursor as { session_id: string }).session_id).toBe('sess-big')
    expect(appendArg.close).toBe(true)
    expect((fetchCalls[1].init.body as Buffer).length).toBe(size - CHUNK_SIZE)

    // finish: offset = size
    const finishArg = parseArg(fetchCalls[2])
    expect((finishArg.cursor as { offset: number }).offset).toBe(size)
  }, 30_000)

  it('sends correct chunk content for each chunk', async () => {
    const size = Math.floor(CHUNK_SIZE * 1.5)
    const data = crypto.randomBytes(size)
    const fp = writeTmpFile('contents.mp3', data)
    fetchQueue.push({ status: 200, json: { session_id: 's' } })
    fetchQueue.push({ status: 200, text: '' })
    fetchQueue.push({ status: 200, json: { path_display: '/contents.mp3' } })
    await uploadFile('tkn', fp)

    // chunk 1 bytes 0..CHUNK_SIZE
    expect(Buffer.compare(fetchCalls[0].init.body as Buffer, data.subarray(0, CHUNK_SIZE))).toBe(0)
    // chunk 2 bytes CHUNK_SIZE..size
    expect(Buffer.compare(fetchCalls[1].init.body as Buffer, data.subarray(CHUNK_SIZE))).toBe(0)
  }, 30_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// uploadFile — retries
// ─────────────────────────────────────────────────────────────────────────────

describe('dropbox.uploadFile — transient failures', () => {
  it('retries the start call on 5xx', async () => {
    const fp = writeTmpFile('a.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 503, text: 'down' })
    fetchQueue.push({ status: 200, json: { session_id: 's' } })
    fetchQueue.push({ status: 200, json: { path_display: '/a.mp3' } })
    await uploadFile('tkn', fp)
    expect(fetchCalls).toHaveLength(3)
  }, 15_000)

  it('retries append_v2 on 5xx', async () => {
    const size = Math.floor(CHUNK_SIZE * 1.5)
    const data = crypto.randomBytes(size)
    const fp = writeTmpFile('rt.mp3', data)
    fetchQueue.push({ status: 200, json: { session_id: 's' } })
    fetchQueue.push({ status: 500, text: 'oops' }) // append fails
    fetchQueue.push({ status: 200, text: '' })     // append retry succeeds
    fetchQueue.push({ status: 200, json: { path_display: '/rt.mp3' } })
    await uploadFile('tkn', fp)
    expect(fetchCalls).toHaveLength(4)
    // retry append should resend the same chunk with same cursor
    expect((parseArg(fetchCalls[2]).cursor as { offset: number }).offset).toBe(CHUNK_SIZE)
  }, 30_000)

  it('retries finish on 5xx', async () => {
    const fp = writeTmpFile('f.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 200, json: { session_id: 's' } })
    fetchQueue.push({ status: 500, text: 'down' })
    fetchQueue.push({ status: 200, json: { path_display: '/f.mp3' } })
    await uploadFile('tkn', fp)
    expect(fetchCalls).toHaveLength(3)
  }, 15_000)

  it('respects Retry-After (delta-seconds) on 429', async () => {
    const fp = writeTmpFile('r.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 429, headers: { 'Retry-After': '1' }, text: 'slow' })
    fetchQueue.push({ status: 200, json: { session_id: 's' } })
    fetchQueue.push({ status: 200, json: { path_display: '/r.mp3' } })
    const start = Date.now()
    await uploadFile('tkn', fp)
    expect(Date.now() - start).toBeGreaterThanOrEqual(800)
  }, 15_000)

  it('respects Retry-After (HTTP-date) on 503', async () => {
    const fp = writeTmpFile('d.mp3', Buffer.from('x'))
    const date = new Date(Date.now() + 1100).toUTCString()
    fetchQueue.push({ status: 503, headers: { 'Retry-After': date }, text: 'down' })
    fetchQueue.push({ status: 200, json: { session_id: 's' } })
    fetchQueue.push({ status: 200, json: { path_display: '/d.mp3' } })
    const start = Date.now()
    await uploadFile('tkn', fp)
    expect(Date.now() - start).toBeGreaterThanOrEqual(800)
  }, 15_000)

  it('throws on 401 without retry', async () => {
    const fp = writeTmpFile('a.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 401, text: 'no' })
    await expect(uploadFile('bad', fp)).rejects.toThrow(/Dropbox session start failed.*401/)
    expect(fetchCalls).toHaveLength(1)
  })

  it('throws on 400 (e.g. invalid path)', async () => {
    const fp = writeTmpFile('a.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 200, json: { session_id: 's' } })
    fetchQueue.push({ status: 400, text: 'bad path' })
    await expect(uploadFile('tkn', fp)).rejects.toThrow(/Dropbox finish failed.*400/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// uploadFile — integrity
// ─────────────────────────────────────────────────────────────────────────────

describe('dropbox.uploadFile — content_hash integrity', () => {
  it('throws when server content_hash differs from local', async () => {
    const data = Buffer.from('hash-test')
    const fp = writeTmpFile('h.mp3', data)
    fetchQueue.push({ status: 200, json: { session_id: 's' } })
    fetchQueue.push({ status: 200, json: { path_display: '/h.mp3', content_hash: 'badhash' } })
    await expect(uploadFile('tkn', fp)).rejects.toThrow(/content_hash mismatch/)
  })

  it('does not check when content_hash is absent', async () => {
    const fp = writeTmpFile('nh.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 200, json: { session_id: 's' } })
    fetchQueue.push({ status: 200, json: { path_display: '/nh.mp3' } })
    await expect(uploadFile('tkn', fp)).resolves.toBe('/nh.mp3')
  })

  it('accepts matching content_hash', async () => {
    const data = Buffer.from('ok')
    const fp = writeTmpFile('o.mp3', data)
    const hash = await dropboxContentHash(fp)
    fetchQueue.push({ status: 200, json: { session_id: 's' } })
    fetchQueue.push({ status: 200, json: { path_display: '/o.mp3', content_hash: hash } })
    await expect(uploadFile('tkn', fp)).resolves.toBe('/o.mp3')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// special characters / edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('dropbox.uploadFile — filenames & edge cases', () => {
  it('handles Norwegian characters æøå in filename', async () => {
    const fp = writeTmpFile('søndagsmøte-ærlig.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 200, json: { session_id: 's' } })
    fetchQueue.push({ status: 200, json: { path_display: '/søndagsmøte-ærlig.mp3' } })
    await uploadFile('tkn', fp)
    const finishArg = parseArg(fetchCalls[1])
    expect((finishArg.commit as { path: string }).path).toBe('/søndagsmøte-ærlig.mp3')
  })

  it('handles spaces in filename', async () => {
    const fp = writeTmpFile('my service.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 200, json: { session_id: 's' } })
    fetchQueue.push({ status: 200, json: { path_display: '/my service.mp3' } })
    await uploadFile('tkn', fp)
    expect((parseArg(fetchCalls[1]).commit as { path: string }).path).toBe('/my service.mp3')
  })

  it('handles very long filenames', async () => {
    const longName = 'b'.repeat(180) + '.mp3'
    const fp = writeTmpFile(longName, Buffer.from('x'))
    fetchQueue.push({ status: 200, json: { session_id: 's' } })
    fetchQueue.push({ status: 200, json: { path_display: `/${longName}` } })
    await uploadFile('tkn', fp)
    expect((parseArg(fetchCalls[1]).commit as { path: string }).path).toBe(`/${longName}`)
  })

  // Zero-byte file documents current behavior:
  // firstSize = 0; start sends 0-byte body with close:true; while-loop skipped;
  // finish called with offset=0. Dropbox would accept this in production.
  it('uploads zero-byte file (close=true on start, finish at offset 0)', async () => {
    const fp = writeTmpFile('empty.mp3', Buffer.alloc(0))
    fetchQueue.push({ status: 200, json: { session_id: 's' } })
    fetchQueue.push({ status: 200, json: { path_display: '/empty.mp3' } })
    const out = await uploadFile('tkn', fp)
    expect(out).toBe('/empty.mp3')
    expect(parseArg(fetchCalls[0]).close).toBe(true)
    expect((parseArg(fetchCalls[1]).cursor as { offset: number }).offset).toBe(0)
    expect((fetchCalls[0].init.body as Buffer).length).toBe(0)
  })

  it('handles file exactly equal to CHUNK_SIZE (single start chunk, no append)', async () => {
    const data = crypto.randomBytes(CHUNK_SIZE)
    const fp = writeTmpFile('exact.mp3', data)
    fetchQueue.push({ status: 200, json: { session_id: 's' } })
    fetchQueue.push({ status: 200, json: { path_display: '/exact.mp3' } })
    await uploadFile('tkn', fp)
    // No append call should occur
    expect(fetchCalls).toHaveLength(2)
    expect(parseArg(fetchCalls[0]).close).toBe(true)
    expect((parseArg(fetchCalls[1]).cursor as { offset: number }).offset).toBe(CHUNK_SIZE)
  }, 30_000)
})
