/**
 * Tests for cloud/onedrive.ts — createUploadSession + chunked PUTs,
 * getUserInfo, listFolders.
 */

jest.mock('electron')

import {
  uploadFile,
  getUserInfo,
  listFolders,
} from '../src/main/cloud/onedrive'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import crypto from 'crypto'

// OneDrive chunk size as encoded in the source (24 * 320 KiB = 7.5 MB)
const ONEDRIVE_CHUNK = 24 * 320 * 1024

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
      const call = { url: String(url), init: init || {} }
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
  tmpDir = mkdtempSync(path.join(tmpdir(), 'sr-od-'))
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

// ─────────────────────────────────────────────────────────────────────────────
// getUserInfo
// ─────────────────────────────────────────────────────────────────────────────

describe('onedrive.getUserInfo', () => {
  it('returns displayName and mail on 200', async () => {
    fetchQueue.push({
      status: 200,
      json: { displayName: 'Per Nordmann', mail: 'per@example.no' },
    })
    const info = await getUserInfo('tkn')
    expect(info).toEqual({ name: 'Per Nordmann', email: 'per@example.no' })
    expect(fetchCalls[0].url).toBe('https://graph.microsoft.com/v1.0/me')
  })

  it('falls back to userPrincipalName when mail missing', async () => {
    fetchQueue.push({
      status: 200,
      json: { displayName: 'X', userPrincipalName: 'x@school.edu' },
    })
    const info = await getUserInfo('tkn')
    expect(info.email).toBe('x@school.edu')
  })

  it('returns empty strings when nothing available', async () => {
    fetchQueue.push({ status: 200, json: {} })
    expect(await getUserInfo('tkn')).toEqual({ name: '', email: '' })
  })

  it('throws on 401', async () => {
    fetchQueue.push({ status: 401, text: 'no' })
    await expect(getUserInfo('bad')).rejects.toThrow(/401/)
  })

  it('retries on 500 then succeeds', async () => {
    fetchQueue.push({ status: 500, text: 'down' })
    fetchQueue.push({ status: 200, json: { displayName: 'OK', mail: 'ok@x' } })
    const info = await getUserInfo('tkn')
    expect(info.name).toBe('OK')
  }, 15_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// listFolders
// ─────────────────────────────────────────────────────────────────────────────

describe('onedrive.listFolders', () => {
  it('returns folders from /root/children when no parentId', async () => {
    fetchQueue.push({
      status: 200,
      json: { value: [{ id: 'a', name: 'Foo' }, { id: 'b', name: 'Bar' }] },
    })
    const out = await listFolders('tkn')
    expect(out).toEqual([{ id: 'a', name: 'Foo' }, { id: 'b', name: 'Bar' }])
    expect(fetchCalls[0].url).toContain('/me/drive/root/children')
    expect(fetchCalls[0].url).toContain('filter=folder')
  })

  it('queries by parentId when provided', async () => {
    fetchQueue.push({ status: 200, json: { value: [] } })
    await listFolders('tkn', 'item-123')
    expect(fetchCalls[0].url).toContain('/me/drive/items/item-123/children')
  })

  it('returns empty when value missing', async () => {
    fetchQueue.push({ status: 200, json: {} })
    expect(await listFolders('tkn')).toEqual([])
  })

  it('throws on 401', async () => {
    fetchQueue.push({ status: 401, text: 'no' })
    await expect(listFolders('bad')).rejects.toThrow(/401/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// uploadFile — happy path, small file
// ─────────────────────────────────────────────────────────────────────────────

describe('onedrive.uploadFile — single chunk', () => {
  it('creates session and PUTs single chunk for small file', async () => {
    const data = Buffer.from('hello')
    const fp = writeTmpFile('hi.mp3', data)

    // 1) createUploadSession
    fetchQueue.push({ status: 200, json: { uploadUrl: 'https://up.live.net/sess/123' } })
    // 2) final chunk (status 200/201)
    fetchQueue.push({ status: 201, json: { id: 'item-1' } })

    const id = await uploadFile('tkn', fp)
    expect(id).toBe('item-1')
    expect(fetchCalls).toHaveLength(2)

    // session URL targets root
    expect(fetchCalls[0].url).toBe('https://graph.microsoft.com/v1.0/me/drive/root:/hi.mp3:/createUploadSession')
    const initHeaders = fetchCalls[0].init.headers as Record<string, string>
    expect(initHeaders.Authorization).toBe('Bearer tkn')
    const initBody = JSON.parse(fetchCalls[0].init.body as string)
    expect(initBody.item['@microsoft.graph.conflictBehavior']).toBe('rename')
    expect(initBody.item.name).toBe('hi.mp3')

    // chunk PUT
    const chunk = fetchCalls[1]
    expect(chunk.url).toBe('https://up.live.net/sess/123')
    expect(chunk.init.method).toBe('PUT')
    const ch = chunk.init.headers as Record<string, string>
    expect(ch['Content-Range']).toBe(`bytes 0-${data.length - 1}/${data.length}`)
    expect(ch['Content-Length']).toBe(String(data.length))
    expect(Buffer.compare(chunk.init.body as Buffer, data)).toBe(0)
  })

  it('uses folderId when provided', async () => {
    const fp = writeTmpFile('a.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 200, json: { uploadUrl: 'https://up/sess' } })
    fetchQueue.push({ status: 201, json: { id: 'f' } })
    await uploadFile('tkn', fp, 'parent-folder-id')
    expect(fetchCalls[0].url).toBe('https://graph.microsoft.com/v1.0/me/drive/items/parent-folder-id:/a.mp3:/createUploadSession')
  })

  it('URL-encodes filename in session URL', async () => {
    const fp = writeTmpFile('a b.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 200, json: { uploadUrl: 'https://up/sess' } })
    fetchQueue.push({ status: 201, json: { id: 'f' } })
    await uploadFile('tkn', fp)
    expect(fetchCalls[0].url).toContain('a%20b.mp3')
  })

  it('throws when session response lacks uploadUrl', async () => {
    const fp = writeTmpFile('a.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 200, json: {} })
    await expect(uploadFile('tkn', fp)).rejects.toThrow(/no uploadUrl/)
  })

  it('throws on session creation 401', async () => {
    const fp = writeTmpFile('a.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 401, text: 'no' })
    await expect(uploadFile('bad', fp)).rejects.toThrow(/OneDrive session failed.*401/)
  })

  it('accepts 200 status as completion (in addition to 201)', async () => {
    const fp = writeTmpFile('a.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 200, json: { uploadUrl: 'https://up/s' } })
    fetchQueue.push({ status: 200, json: { id: 'two-hundred' } })
    expect(await uploadFile('tkn', fp)).toBe('two-hundred')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// uploadFile — chunked
// ─────────────────────────────────────────────────────────────────────────────

describe('onedrive.uploadFile — chunked', () => {
  it('sends multiple 7.5 MB chunks with correct Content-Range headers', async () => {
    const size = Math.floor(ONEDRIVE_CHUNK * 1.5)
    const data = crypto.randomBytes(size)
    const fp = writeTmpFile('big.mp3', data)

    // session
    fetchQueue.push({ status: 200, json: { uploadUrl: 'https://up/X' } })
    // chunk 1 (202 accepted)
    fetchQueue.push({
      status: 202,
      json: { nextExpectedRanges: [`${ONEDRIVE_CHUNK}-`] },
    })
    // chunk 2 (final 201)
    fetchQueue.push({ status: 201, json: { id: 'big-id' } })

    const id = await uploadFile('tkn', fp)
    expect(id).toBe('big-id')
    expect(fetchCalls).toHaveLength(3)

    const c1 = fetchCalls[1].init.headers as Record<string, string>
    const c2 = fetchCalls[2].init.headers as Record<string, string>
    expect(c1['Content-Range']).toBe(`bytes 0-${ONEDRIVE_CHUNK - 1}/${size}`)
    expect(c2['Content-Range']).toBe(`bytes ${ONEDRIVE_CHUNK}-${size - 1}/${size}`)
    expect(c1['Content-Length']).toBe(String(ONEDRIVE_CHUNK))
    expect(c2['Content-Length']).toBe(String(size - ONEDRIVE_CHUNK))
  }, 30_000)

  it('chunk size is a multiple of 320 KiB', () => {
    expect(ONEDRIVE_CHUNK % (320 * 1024)).toBe(0)
    expect(ONEDRIVE_CHUNK).toBe(7864320)
  })

  it('sends chunk content matching file region for each chunk', async () => {
    const size = Math.floor(ONEDRIVE_CHUNK * 1.5)
    const data = crypto.randomBytes(size)
    const fp = writeTmpFile('chunks.mp3', data)
    fetchQueue.push({ status: 200, json: { uploadUrl: 'https://up/X' } })
    fetchQueue.push({ status: 202, json: { nextExpectedRanges: [`${ONEDRIVE_CHUNK}-`] } })
    fetchQueue.push({ status: 201, json: { id: 'c' } })
    await uploadFile('tkn', fp)
    expect(Buffer.compare(fetchCalls[1].init.body as Buffer, data.subarray(0, ONEDRIVE_CHUNK))).toBe(0)
    expect(Buffer.compare(fetchCalls[2].init.body as Buffer, data.subarray(ONEDRIVE_CHUNK))).toBe(0)
  }, 30_000)

  it('handles file exactly equal to chunk size (one chunk total)', async () => {
    const data = crypto.randomBytes(ONEDRIVE_CHUNK)
    const fp = writeTmpFile('exact.mp3', data)
    fetchQueue.push({ status: 200, json: { uploadUrl: 'https://up/X' } })
    fetchQueue.push({ status: 201, json: { id: 'ex' } })
    expect(await uploadFile('tkn', fp)).toBe('ex')
    const ch = fetchCalls[1].init.headers as Record<string, string>
    expect(ch['Content-Range']).toBe(`bytes 0-${ONEDRIVE_CHUNK - 1}/${ONEDRIVE_CHUNK}`)
  }, 30_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// uploadFile — retries / resync
// ─────────────────────────────────────────────────────────────────────────────

describe('onedrive.uploadFile — transient failures', () => {
  it('retries chunk on 5xx', async () => {
    const fp = writeTmpFile('r.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 200, json: { uploadUrl: 'https://up/s' } })
    fetchQueue.push({ status: 503, text: 'down' })
    // beforeRetry GET on uploadUrl — no nextExpectedRanges, offset stays put
    fetchQueue.push({ status: 200, json: {} })
    fetchQueue.push({ status: 201, json: { id: 'r-id' } })
    const id = await uploadFile('tkn', fp)
    expect(id).toBe('r-id')
  }, 15_000)

  it('respects Retry-After (delta-seconds) on 429', async () => {
    const fp = writeTmpFile('r.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 200, json: { uploadUrl: 'https://up/s' } })
    fetchQueue.push({ status: 429, headers: { 'Retry-After': '1' }, text: 'slow' })
    fetchQueue.push({ status: 200, json: {} }) // beforeRetry probe
    fetchQueue.push({ status: 201, json: { id: 'rt-id' } })
    const start = Date.now()
    await uploadFile('tkn', fp)
    expect(Date.now() - start).toBeGreaterThanOrEqual(800)
  }, 15_000)

  it('respects Retry-After (HTTP-date)', async () => {
    const fp = writeTmpFile('rd.mp3', Buffer.from('x'))
    const date = new Date(Date.now() + 1100).toUTCString()
    fetchQueue.push({ status: 200, json: { uploadUrl: 'https://up/s' } })
    fetchQueue.push({ status: 503, headers: { 'Retry-After': date }, text: 'down' })
    fetchQueue.push({ status: 200, json: {} })
    fetchQueue.push({ status: 201, json: { id: 'd-id' } })
    const start = Date.now()
    await uploadFile('tkn', fp)
    expect(Date.now() - start).toBeGreaterThanOrEqual(800)
  }, 15_000)

  it('fails (no retry) on 400 from chunk PUT', async () => {
    const fp = writeTmpFile('bad.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 200, json: { uploadUrl: 'https://up/s' } })
    fetchQueue.push({ status: 400, text: 'bad chunk' })
    await expect(uploadFile('tkn', fp)).rejects.toThrow(/OneDrive chunk failed.*400/)
  })

  it('beforeRetry issues GET on uploadUrl to fetch nextExpectedRanges', async () => {
    const fp = writeTmpFile('probe.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 200, json: { uploadUrl: 'https://up/s' } })
    fetchQueue.push({ status: 503, text: 'down' })
    // probe GET — track that this was actually issued
    fetchQueue.push({ status: 200, json: { nextExpectedRanges: ['0-'] } })
    fetchQueue.push({ status: 201, json: { id: 'pr-id' } })
    await uploadFile('tkn', fp)
    // Find the GET (no method or default GET)
    const probeIdx = fetchCalls.findIndex(c =>
      c.url === 'https://up/s' && (!c.init.method || c.init.method === 'GET'))
    expect(probeIdx).toBeGreaterThan(-1)
  }, 15_000)

  // Regression test for the data-corruption bug that was previously in
  // onedrive.ts:92-103: `beforeRetry` mutated `offset` to match the server's
  // nextExpectedRanges, but the chunk Buffer was captured before the retry,
  // so retries sent stale bytes with a new range header.
  // Fix: chunk read + Content-Range moved INSIDE the retry op.
  it('re-reads chunk from new offset after server reports advanced position', async () => {
    const size = ONEDRIVE_CHUNK * 2
    const data = crypto.randomBytes(size)
    const fp = writeTmpFile('resync-bug.mp3', data)
    fetchQueue.push({ status: 200, json: { uploadUrl: 'https://up/s' } })
    // chunk 1 attempt 1 → 503
    fetchQueue.push({ status: 503, text: 'down' })
    // probe: server already received chunk 1, expects chunk 2 next
    fetchQueue.push({ status: 200, json: { nextExpectedRanges: [`${ONEDRIVE_CHUNK}-`] } })
    // retry — provider SHOULD send chunk 2 data with Content-Range starting at ONEDRIVE_CHUNK
    fetchQueue.push({ status: 201, json: { id: 'fix-id' } })
    const id = await uploadFile('tkn', fp)
    expect(id).toBe('fix-id')
    // The retry's body should be chunk 2 (data.subarray(ONEDRIVE_CHUNK))
    const retry = fetchCalls[fetchCalls.length - 1]
    expect(Buffer.compare(retry.init.body as Buffer, data.subarray(ONEDRIVE_CHUNK))).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// special filenames / edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('onedrive.uploadFile — filenames & edge cases', () => {
  it('handles Norwegian characters æøå in filename', async () => {
    const fp = writeTmpFile('søndagsmøte-ærlig.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 200, json: { uploadUrl: 'https://up/s' } })
    fetchQueue.push({ status: 201, json: { id: 'n' } })
    await uploadFile('tkn', fp)
    // URL is encoded; original filename is in the JSON body
    expect(fetchCalls[0].url).toContain(encodeURIComponent('søndagsmøte-ærlig.mp3'))
    const body = JSON.parse(fetchCalls[0].init.body as string)
    expect(body.item.name).toBe('søndagsmøte-ærlig.mp3')
  })

  it('handles spaces in filename', async () => {
    const fp = writeTmpFile('my recording.mp3', Buffer.from('x'))
    fetchQueue.push({ status: 200, json: { uploadUrl: 'https://up/s' } })
    fetchQueue.push({ status: 201, json: { id: 's' } })
    await uploadFile('tkn', fp)
    expect(fetchCalls[0].url).toContain('my%20recording.mp3')
  })

  it('handles very long filenames', async () => {
    const longName = 'c'.repeat(180) + '.mp3'
    const fp = writeTmpFile(longName, Buffer.from('x'))
    fetchQueue.push({ status: 200, json: { uploadUrl: 'https://up/s' } })
    fetchQueue.push({ status: 201, json: { id: 'l' } })
    await uploadFile('tkn', fp)
    expect(fetchCalls[0].url).toContain(encodeURIComponent(longName))
  })

  // Zero-byte file behavior: while loop never runs, fileId stays null, throws.
  it('throws on zero-byte file (current behavior — possible bug)', async () => {
    const fp = writeTmpFile('empty.mp3', Buffer.alloc(0))
    fetchQueue.push({ status: 200, json: { uploadUrl: 'https://up/s' } })
    await expect(uploadFile('tkn', fp)).rejects.toThrow(/completed without file id/)
  })
})
