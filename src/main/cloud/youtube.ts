/**
 * YouTube upload integration.
 *
 * YouTube is treated as a publish-only target (separate from cloud backup):
 * exposed in the editor's export modal for video files, not in the auto-
 * upload-queue. Reuses Google's OAuth Desktop loopback flow (same client_id
 * as Drive) but stores a separate token under the 'youtube' key so users
 * can opt-in independently.
 *
 * Upload uses Google's resumable-upload protocol — required by YouTube and
 * essential for large files (typical 1–2 GB videos benefit from chunked
 * retry-on-network-blip behaviour).
 *
 *   1. Initiate session  → POST /upload/youtube/v3/videos?uploadType=resumable
 *      Body: { snippet: { title, description, categoryId, tags }, status: { privacyStatus } }
 *      Response 200, Location: https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=…
 *
 *   2. Upload chunks     → PUT {location}
 *      Content-Range: bytes {start}-{end}/{total}
 *      Response 308 (continue) | 200|201 (done with JSON body containing videoId).
 *
 *   3. Verify (optional) → GET /youtube/v3/videos?part=processingDetails,status&id={videoId}
 *      (we skip the polling step — UI returns immediately with the URL and lets
 *       the user check YouTube Studio for processing-complete status.)
 */

import { app, shell } from 'electron'
import crypto from 'crypto'
import http from 'http'
import net from 'net'
import fs from 'fs'
import { CLOUD_CONFIG, isServiceConfigured } from './config'
import { getToken, setToken, updateTokenFields, type TokenData } from './token-store'
import { refreshAccessToken } from './oauth'

// ─── PKCE helpers (duplicated from oauth.ts since they're not exported) ───────

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}
function generateVerifier(): string  { return base64url(crypto.randomBytes(32)) }
function generateChallenge(v: string): string {
  return base64url(crypto.createHash('sha256').update(v).digest())
}
function generateState(): string     { return base64url(crypto.randomBytes(16)) }

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo
      srv.close(() => resolve(addr.port))
    })
    srv.on('error', reject)
  })
}

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000  // 5 min — generous for slow consent screens

// ─── OAuth ───────────────────────────────────────────────────────────────────

/** Open the YouTube OAuth flow in the user's default browser. Resolves with
 *  the authorization code once Google redirects back to our loopback server.
 *  Caller is responsible for exchanging the code for a token via
 *  `exchangeYouTubeCode()`. */
async function openYouTubeAuth(): Promise<{ codePromise: Promise<string>; verifier: string; redirectUri: string }> {
  if (!isServiceConfigured('youtube')) {
    return {
      codePromise: Promise.reject(new Error('OAuth client not configured for YouTube. Set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in .env and rebuild.')),
      verifier:    '',
      redirectUri: '',
    }
  }

  const port        = await getFreePort()
  const redirectUri = `http://127.0.0.1:${port}`
  const verifier    = generateVerifier()
  const challenge   = generateChallenge(verifier)
  const state       = generateState()

  const codePromise = new Promise<string>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout

    const server = http.createServer((req, res) => {
      if (settled) { res.end(); return }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;max-width:480px;margin:auto">
        <h2>YouTube tilkoblet ✓</h2>
        <p>Du kan lukke dette vinduet og gå tilbake til SundayRec.</p>
        <script>window.close()</script>
      </body></html>`)
      res.socket?.destroy()
      clearTimeout(timer)
      server.close()
      settled = true

      const error = url.searchParams.get('error')
      if (error) { reject(new Error(`OAuth nektet: ${url.searchParams.get('error_description') ?? error}`)); return }
      if (url.searchParams.get('state') !== state) { reject(new Error('OAuth state mismatch — mulig CSRF-forsøk')); return }
      const code = url.searchParams.get('code')
      if (!code) { reject(new Error('OAuth callback manglet code-parameter')); return }
      resolve(code)
    })

    server.listen(port, '127.0.0.1')

    timer = setTimeout(() => {
      if (settled) return
      settled = true
      server.close()
      reject(new Error('timeout'))
    }, OAUTH_TIMEOUT_MS)
    timer.unref()
  })

  const params = new URLSearchParams({
    client_id:             CLOUD_CONFIG.youtube.clientId,
    redirect_uri:          redirectUri,
    response_type:         'code',
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    scope:                 CLOUD_CONFIG.youtube.scope,
    access_type:           'offline',
    prompt:                'consent',
  })

  shell.openExternal(`${CLOUD_CONFIG.youtube.authUrl}?${params.toString()}`)
  return { codePromise, verifier, redirectUri }
}

async function exchangeYouTubeCode(code: string, verifier: string, redirectUri: string): Promise<TokenData> {
  const body = new URLSearchParams({
    client_id:     CLOUD_CONFIG.youtube.clientId,
    client_secret: CLOUD_CONFIG.youtube.clientSecret,
    redirect_uri:  redirectUri,
    grant_type:    'authorization_code',
    code,
    code_verifier: verifier,
  })

  const ctl = new AbortController()
  const tid = setTimeout(() => ctl.abort(), 30_000)
  let res: Response
  try {
    res = await fetch(CLOUD_CONFIG.youtube.tokenUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
      signal:  ctl.signal,
    })
  } finally { clearTimeout(tid) }

  if (!res.ok) throw new Error(`YouTube token exchange failed: ${res.status} ${await res.text()}`)
  const json = await res.json() as Record<string, unknown>
  return {
    accessToken:  json.access_token  as string,
    refreshToken: json.refresh_token as string | undefined,
    expiresAt:    json.expires_in    ? Date.now() + (json.expires_in as number) * 1000 : undefined,
  }
}

/** Returns a valid access token, refreshing if needed. Throws if no token
 *  is stored or the refresh fails. */
async function getValidAccessToken(): Promise<string> {
  const tok = getToken('youtube')
  if (!tok) throw new Error('Ikke koblet til YouTube')
  // Refresh 60 s ahead of expiry to avoid mid-upload token expiry races.
  if (!tok.expiresAt || tok.expiresAt - Date.now() > 60_000) return tok.accessToken
  if (!tok.refreshToken) throw new Error('YouTube-token utløpt og mangler refresh-token. Koble til på nytt.')
  try {
    // Reuse Drive's refresh logic — same Google token endpoint, same client.
    // We pass 'google-drive' as the service-id so refreshAccessToken picks up
    // the right clientId/clientSecret. The returned access_token has the same
    // scopes as the original consent, so it remains YouTube-capable.
    const refreshed = await refreshAccessToken('google-drive', tok.refreshToken)
    updateTokenFields('youtube', {
      accessToken: refreshed.accessToken,
      expiresAt:   refreshed.expiresAt,
      refreshToken: refreshed.refreshToken ?? tok.refreshToken,
      needsReauth: false,
    })
    return refreshed.accessToken
  } catch (err) {
    const code = (err as Error & { code?: string }).code
    if (code === 'invalid_grant') updateTokenFields('youtube', { needsReauth: true })
    throw err
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Full connect flow: open browser, wait for OAuth callback, store token. */
export async function connect(): Promise<{ ok: boolean; error?: string }> {
  try {
    const { codePromise, verifier, redirectUri } = await openYouTubeAuth()
    const code  = await codePromise
    const token = await exchangeYouTubeCode(code, verifier, redirectUri)
    setToken('youtube', token)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function disconnect(): void {
  setToken('youtube', null)
}

export function isConnected(): boolean {
  const t = getToken('youtube')
  return !!t && !!t.accessToken
}

export interface YouTubeUploadMetadata {
  title:         string
  description?:  string
  tags?:         string[]
  /** YouTube category id — 22 = "People & Blogs", 29 = "Nonprofits & Activism" (good fit for church services). */
  categoryId?:   string
  /** 'private' is the safest default — uploads aren't public until user explicitly changes it. */
  privacyStatus?: 'private' | 'unlisted' | 'public'
}

/** Progress callback. `uploadedBytes` is cumulative across chunks. */
export type UploadProgressFn = (uploadedBytes: number, totalBytes: number) => void

/** Resumable upload. Returns the new videoId + watch URL on success. */
export async function uploadVideo(
  filePath: string,
  metadata: YouTubeUploadMetadata,
  onProgress?: UploadProgressFn,
): Promise<{ ok: boolean; videoId?: string; url?: string; error?: string }> {
  try {
    const accessToken = await getValidAccessToken()
    const stat        = await fs.promises.stat(filePath)
    const totalBytes  = stat.size

    // 1. Initiate resumable upload session
    const initBody = {
      snippet: {
        title:       metadata.title.slice(0, 100),  // YouTube hard-limits title to 100 chars
        description: (metadata.description ?? '').slice(0, 5000),
        tags:        metadata.tags?.slice(0, 25),
        categoryId:  metadata.categoryId ?? '29',
      },
      status: {
        privacyStatus:           metadata.privacyStatus ?? 'private',
        selfDeclaredMadeForKids: false,
      },
    }
    const initRes = await fetchWithTimeout(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        headers: {
          Authorization:           `Bearer ${accessToken}`,
          'Content-Type':          'application/json; charset=UTF-8',
          'X-Upload-Content-Type': contentTypeFromExt(filePath),
          'X-Upload-Content-Length': String(totalBytes),
        },
        body: JSON.stringify(initBody),
      },
      30_000,
    )
    if (!initRes.ok) {
      const errBody = await initRes.text()
      return { ok: false, error: `YouTube init failed: ${initRes.status} ${errBody.slice(0, 200)}` }
    }
    const location = initRes.headers.get('location')
    if (!location) return { ok: false, error: 'YouTube init missing Location header' }

    // 2. Stream the file in 8 MB chunks. Resumable PUTs return 308 mid-upload
    //    and 200/201 on completion with the final video resource as JSON.
    const CHUNK = 8 * 1024 * 1024
    let uploaded = 0
    while (uploaded < totalBytes) {
      const chunkEnd  = Math.min(uploaded + CHUNK, totalBytes) - 1
      const chunkLen  = chunkEnd - uploaded + 1
      const chunk     = await readChunk(filePath, uploaded, chunkLen)

      const res = await fetchWithTimeout(location, {
        method: 'PUT',
        headers: {
          'Content-Length': String(chunkLen),
          'Content-Range':  `bytes ${uploaded}-${chunkEnd}/${totalBytes}`,
        },
        body: chunk,
      }, 5 * 60_000)  // 5 min per chunk — generous for slow uplinks

      if (res.status === 308) {
        // Continue. The Range header tells us how many bytes the server got.
        const range = res.headers.get('range')
        if (range) {
          const m = /bytes=0-(\d+)/.exec(range)
          if (m) uploaded = parseInt(m[1], 10) + 1
          else   uploaded = chunkEnd + 1
        } else {
          uploaded = chunkEnd + 1
        }
        onProgress?.(uploaded, totalBytes)
        continue
      }

      if (res.status === 200 || res.status === 201) {
        const result = await res.json() as { id?: string }
        if (!result.id) return { ok: false, error: 'YouTube upload succeeded but response missing video id' }
        onProgress?.(totalBytes, totalBytes)
        return {
          ok:      true,
          videoId: result.id,
          url:     `https://www.youtube.com/watch?v=${result.id}`,
        }
      }

      // Non-resumable error
      const errText = await res.text()
      return { ok: false, error: `YouTube upload failed at ${uploaded}/${totalBytes}: ${res.status} ${errText.slice(0, 200)}` }
    }

    return { ok: false, error: 'Upload loop exited without completion' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController()
  const tid = setTimeout(() => ctl.abort(), timeoutMs)
  try { return await fetch(url, { ...init, signal: ctl.signal }) }
  finally { clearTimeout(tid) }
}

function contentTypeFromExt(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop() ?? ''
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4'
  if (ext === 'mov') return 'video/quicktime'
  if (ext === 'mkv') return 'video/x-matroska'
  if (ext === 'webm') return 'video/webm'
  if (ext === 'avi')  return 'video/x-msvideo'
  return 'video/*'
}

async function readChunk(filePath: string, offset: number, length: number): Promise<Buffer> {
  const fd = await fs.promises.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fd.read(buf, 0, length, offset)
    return bytesRead === length ? buf : buf.subarray(0, bytesRead)
  } finally {
    await fd.close()
  }
}

// Silence unused-import warning in case `app` is needed later (e.g. for
// app.getPath('userData') based session storage).
void app
