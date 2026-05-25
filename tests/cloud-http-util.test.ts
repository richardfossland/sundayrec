/**
 * Tests for cloud/http-util.ts — withRetry classification, dropboxContentHash.
 */

jest.mock('electron')

import { withRetry, dropboxContentHash, md5OfFile } from '../src/main/cloud/http-util'
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import crypto from 'crypto'

describe('withRetry', () => {
  it('returns the value on first success without retry', async () => {
    const op = jest.fn().mockResolvedValue('ok')
    const out = await withRetry(op, { maxAttempts: 3, baseDelayMs: 1 })
    expect(out).toBe('ok')
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('retries on HTTP 503 then succeeds', async () => {
    let calls = 0
    const op = jest.fn().mockImplementation(() => {
      calls += 1
      if (calls < 3) {
        const err = new Error('Server error') as Error & { status: number }
        err.status = 503
        throw err
      }
      return Promise.resolve('done')
    })
    const out = await withRetry(op, { maxAttempts: 5, baseDelayMs: 1 })
    expect(out).toBe('done')
    expect(op).toHaveBeenCalledTimes(3)
  })

  it('retries on HTTP 429 (rate limit)', async () => {
    let calls = 0
    const op = jest.fn().mockImplementation(() => {
      calls += 1
      if (calls < 2) {
        const err = new Error('Too many') as Error & { status: number }
        err.status = 429
        throw err
      }
      return Promise.resolve('done')
    })
    await withRetry(op, { maxAttempts: 3, baseDelayMs: 1 })
    expect(op).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry on HTTP 401 (auth failure)', async () => {
    const op = jest.fn().mockImplementation(() => {
      const err = new Error('Unauthorized') as Error & { status: number }
      err.status = 401
      throw err
    })
    await expect(withRetry(op, { maxAttempts: 5, baseDelayMs: 1 })).rejects.toThrow('Unauthorized')
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry on HTTP 400 (bad request)', async () => {
    const op = jest.fn().mockImplementation(() => {
      const err = new Error('Bad request') as Error & { status: number }
      err.status = 400
      throw err
    })
    await expect(withRetry(op, { maxAttempts: 5, baseDelayMs: 1 })).rejects.toThrow()
    expect(op).toHaveBeenCalledTimes(1)
  })

  it('retries on network errors (ECONNRESET)', async () => {
    let calls = 0
    const op = jest.fn().mockImplementation(() => {
      calls += 1
      if (calls < 2) {
        const err = new Error('Connection reset') as Error & { code: string }
        err.code = 'ECONNRESET'
        throw err
      }
      return Promise.resolve('done')
    })
    await withRetry(op, { maxAttempts: 3, baseDelayMs: 1 })
    expect(op).toHaveBeenCalledTimes(2)
  })

  it('retries on "fetch failed" (Undici network error)', async () => {
    let calls = 0
    const op = jest.fn().mockImplementation(() => {
      calls += 1
      if (calls < 2) throw new TypeError('fetch failed')
      return Promise.resolve('done')
    })
    await withRetry(op, { maxAttempts: 3, baseDelayMs: 1 })
    expect(op).toHaveBeenCalledTimes(2)
  })

  it('gives up after maxAttempts and throws last error', async () => {
    const op = jest.fn().mockImplementation(() => {
      const err = new Error('Always fails') as Error & { status: number }
      err.status = 500
      throw err
    })
    await expect(withRetry(op, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow('Always fails')
    expect(op).toHaveBeenCalledTimes(3)
  })

  it('calls beforeRetry between attempts', async () => {
    const beforeRetry = jest.fn()
    let calls = 0
    const op = jest.fn().mockImplementation(() => {
      calls += 1
      if (calls < 3) {
        const err = new Error('5xx') as Error & { status: number }
        err.status = 502
        throw err
      }
      return Promise.resolve('done')
    })
    await withRetry(op, { maxAttempts: 5, baseDelayMs: 1, beforeRetry })
    expect(beforeRetry).toHaveBeenCalledTimes(2)
  })
})

describe('dropboxContentHash', () => {
  let tmp = ''
  let file = ''
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'sr-test-'))
    file = path.join(tmp, 'sample.bin')
  })
  afterEach(() => {
    try { unlinkSync(file) } catch {}
  })

  it('computes the Dropbox content hash spec for a 1-byte file', async () => {
    writeFileSync(file, Buffer.from([0x61]))  // single byte 'a'
    // Expected: sha256( sha256([0x61]) ) hex
    const innerHash = crypto.createHash('sha256').update(Buffer.from([0x61])).digest()
    const expected = crypto.createHash('sha256').update(innerHash).digest('hex')
    const got = await dropboxContentHash(file)
    expect(got).toBe(expected)
  })

  it('computes hash spanning multiple 4 MB blocks', async () => {
    // 9 MB → 3 blocks of [4MB, 4MB, 1MB]
    const block1 = Buffer.alloc(4 * 1024 * 1024, 0x01)
    const block2 = Buffer.alloc(4 * 1024 * 1024, 0x02)
    const tail   = Buffer.alloc(1 * 1024 * 1024, 0x03)
    writeFileSync(file, Buffer.concat([block1, block2, tail]))

    const h1 = crypto.createHash('sha256').update(block1).digest()
    const h2 = crypto.createHash('sha256').update(block2).digest()
    const h3 = crypto.createHash('sha256').update(tail).digest()
    const expected = crypto.createHash('sha256').update(Buffer.concat([h1, h2, h3])).digest('hex')

    const got = await dropboxContentHash(file)
    expect(got).toBe(expected)
  })
})

describe('md5OfFile', () => {
  let tmp = ''
  let file = ''
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'sr-md5-'))
    file = path.join(tmp, 'sample.bin')
  })
  afterEach(() => {
    try { unlinkSync(file) } catch {}
  })

  it('matches the expected md5 of a known buffer', async () => {
    const data = Buffer.from('hello world')
    writeFileSync(file, data)
    const expected = crypto.createHash('md5').update(data).digest('hex')
    const got = await md5OfFile(file)
    expect(got).toBe(expected)
  })
})
