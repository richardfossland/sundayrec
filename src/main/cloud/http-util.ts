import fs from 'fs'
import crypto from 'crypto'

export const CHUNK_SIZE = 8 * 1024 * 1024  // 8 MB — must be a multiple of 256 KB for Drive/OneDrive

/** Read one chunk of a file into a Buffer. */
export async function readChunk(filePath: string, start: number, size: number): Promise<Buffer> {
  const fd = await fs.promises.open(filePath, 'r')
  try {
    const buf = Buffer.allocUnsafe(size)
    const { bytesRead } = await fd.read(buf, 0, size, start)
    return bytesRead < size ? buf.subarray(0, bytesRead) : buf
  } finally {
    await fd.close()
  }
}

export async function sha1OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1')
    const stream = fs.createReadStream(filePath, { highWaterMark: 1 << 20 })
    stream.on('data', d => h.update(d as Buffer))
    stream.on('end', () => resolve(h.digest('hex')))
    stream.on('error', reject)
  })
}

export async function md5OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5')
    const stream = fs.createReadStream(filePath, { highWaterMark: 1 << 20 })
    stream.on('data', d => h.update(d as Buffer))
    stream.on('end', () => resolve(h.digest('hex')))
    stream.on('error', reject)
  })
}

/**
 * Dropbox-content-hash: SHA-256 over each 4 MB block, then SHA-256 over the
 * concatenation of those hashes. See:
 * https://www.dropbox.com/developers/reference/content-hash
 */
export async function dropboxContentHash(filePath: string): Promise<string> {
  const BLOCK = 4 * 1024 * 1024
  const outer = crypto.createHash('sha256')
  let fd: fs.promises.FileHandle | null = null
  try {
    fd = await fs.promises.open(filePath, 'r')
    const buf = Buffer.allocUnsafe(BLOCK)
    while (true) {
      const { bytesRead } = await fd.read(buf, 0, BLOCK, null)
      if (bytesRead === 0) break
      const block = bytesRead < BLOCK ? buf.subarray(0, bytesRead) : buf
      const inner = crypto.createHash('sha256').update(block).digest()
      outer.update(inner)
      if (bytesRead < BLOCK) break
    }
    return outer.digest('hex')
  } finally {
    if (fd) await fd.close()
  }
}

/** Sleep with cancellation via AbortSignal. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const t = setTimeout(() => resolve(), ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) }, { once: true })
  })
}

export interface RetryOpts {
  maxAttempts?: number    // default 5
  baseDelayMs?: number    // default 1000
  signal?: AbortSignal
  /** Called before each retry attempt — used to refresh tokens, log, etc. */
  beforeRetry?: (attempt: number, err: Error) => Promise<void> | void
}

/**
 * Run an async operation with exponential backoff + jitter. Retries on:
 *  - HTTP 408/429/5xx (the op should throw an Error with .status set)
 *  - Network errors (ENOTFOUND, ECONNRESET, ETIMEDOUT, AbortError-from-fetch)
 * Does NOT retry on 4xx auth/client errors except 408/429.
 *
 * On 429 the Retry-After header (RFC 7231) is respected when present —
 * either as seconds or as an HTTP-date. Capped at 60 s so a misbehaving
 * server can't park us forever.
 */
export async function withRetry<T>(op: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const max = opts.maxAttempts ?? 5
  const base = opts.baseDelayMs ?? 1000
  let lastErr: Error | undefined

  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await op()
    } catch (err) {
      const e = err as Error & { status?: number; code?: string; retryAfterMs?: number }
      lastErr = e

      const isLastAttempt = attempt === max
      const transient = isTransient(e)
      if (isLastAttempt || !transient) throw e

      let delay: number
      if (typeof e.retryAfterMs === 'number' && e.retryAfterMs > 0) {
        // Cap server-suggested wait at 60 s — anything longer means the
        // service is essentially down for us, abandon to the queue.
        delay = Math.min(60_000, e.retryAfterMs) + Math.random() * 500
      } else {
        delay = Math.min(30_000, base * Math.pow(2, attempt - 1)) + Math.random() * 500
      }
      if (opts.beforeRetry) await opts.beforeRetry(attempt, e)
      await sleep(delay, opts.signal)
    }
  }
  throw lastErr ?? new Error('withRetry: no attempts')
}

/**
 * Parse RFC 7231 Retry-After header into milliseconds. Returns 0 when the
 * header is missing / malformed (caller falls back to exponential backoff).
 */
export function parseRetryAfter(headerValue: string | null): number {
  if (!headerValue) return 0
  const trimmed = headerValue.trim()
  // Numeric: delta-seconds
  const num = Number(trimmed)
  if (Number.isFinite(num) && num >= 0) return Math.round(num * 1000)
  // HTTP-date
  const t = Date.parse(trimmed)
  if (Number.isFinite(t)) return Math.max(0, t - Date.now())
  return 0
}

function isTransient(err: Error & { status?: number; code?: string }): boolean {
  if (err.status !== undefined) {
    return err.status === 408 || err.status === 429 || (err.status >= 500 && err.status < 600)
  }
  const code = err.code
  if (code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'ETIMEDOUT'
      || code === 'EAI_AGAIN' || code === 'ECONNREFUSED' || code === 'UND_ERR_SOCKET') return true
  // Undici fetch network errors typically throw TypeError('fetch failed')
  if (err.message?.includes('fetch failed')) return true
  return false
}

/** Read the response body once and attach status info for the retry-classifier. */
export async function httpJson<T = unknown>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    const body = await res.text()
    const err = new Error(`${ctx} failed: ${res.status} ${body}`) as Error & { status: number; body: string; retryAfterMs?: number }
    err.status = res.status
    err.body = body
    if (res.status === 429 || res.status === 503) {
      const ra = parseRetryAfter(res.headers.get('Retry-After'))
      if (ra > 0) err.retryAfterMs = ra
    }
    throw err
  }
  return res.json() as Promise<T>
}

export async function httpOk(res: Response, ctx: string): Promise<void> {
  if (!res.ok) {
    const body = await res.text()
    const err = new Error(`${ctx} failed: ${res.status} ${body}`) as Error & { status: number; body: string; retryAfterMs?: number }
    err.status = res.status
    err.body = body
    if (res.status === 429 || res.status === 503) {
      const ra = parseRetryAfter(res.headers.get('Retry-After'))
      if (ra > 0) err.retryAfterMs = ra
    }
    throw err
  }
}

/**
 * Quick connectivity check — pings a small public endpoint with a short timeout.
 * Used by the upload queue to skip retries when offline.
 */
export async function isOnline(): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch('https://www.google.com/generate_204', { method: 'HEAD', signal: ctrl.signal })
    clearTimeout(t)
    return res.ok || res.status === 204
  } catch {
    return false
  }
}
