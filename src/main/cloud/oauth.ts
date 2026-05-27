import crypto from 'crypto'
import http from 'http'
import net from 'net'
import { shell } from 'electron'
import { CLOUD_CONFIG, isServiceConfigured } from './config'
import type { CloudServiceId } from '../../types'

const PENDING_TIMEOUT_MS = 5 * 60 * 1000  // 5 min — long enough for slow consent screens

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function generateVerifier(): string {
  return base64url(crypto.randomBytes(32))
}

function generateChallenge(verifier: string): string {
  return base64url(crypto.createHash('sha256').update(verifier).digest())
}

function generateState(): string {
  return base64url(crypto.randomBytes(16))
}

// ─── Replay protection for OAuth state values ──────────────────────────────
//
// Each state is generated for one OAuth flow and lives only as long as that
// flow is pending. If an attacker manages to capture a state value (e.g. via
// log scraping) and tries to feed it back through a manipulated callback,
// we reject it here even if the flow is still nominally pending.
//
// The set is bounded — entries auto-expire after STATE_TTL_MS and the size
// is capped so a flood of OAuth attempts can't grow the map unboundedly.

const STATE_TTL_MS = 10 * 60_000   // 10 min — matches PENDING_TIMEOUT_MS
const MAX_USED_STATES = 256
const usedStates = new Map<string, number>()   // state → expiresAt ms

function markStateUsed(state: string): void {
  // Light-weight GC: drop expired entries on every insert. Cheap because
  // OAuth flows are rare (a few per session at most).
  const now = Date.now()
  for (const [s, exp] of usedStates) {
    if (exp < now) usedStates.delete(s)
  }
  // Cap the map size — drop oldest if we somehow exceed it (defensive).
  if (usedStates.size >= MAX_USED_STATES) {
    const first = usedStates.keys().next().value
    if (first) usedStates.delete(first)
  }
  usedStates.set(state, now + STATE_TTL_MS)
}

function isStateReplayed(state: string): boolean {
  const exp = usedStates.get(state)
  if (exp === undefined) return false
  if (exp < Date.now()) {
    usedStates.delete(state)
    return false
  }
  return true
}

/** Fetch with hard timeout — aborts the request after `timeoutMs` so a
 *  hanging OAuth endpoint can't block the upload queue indefinitely. */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController()
  const tid = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctl.signal })
  } finally {
    clearTimeout(tid)
  }
}

interface Pending {
  verifier: string
  state:    string
  resolve:  (code: string) => void
  reject:   (err: Error)   => void
  timer:    NodeJS.Timeout
}

// Used for Dropbox + OneDrive (custom sundayrec:// scheme)
const pending = new Map<CloudServiceId, Pending>()

function clearPending(service: CloudServiceId, reason: string): void {
  const p = pending.get(service)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(service)
  p.reject(new Error(reason))
}

// ─── Google Drive: localhost redirect server ──────────────────────────────────
//
// Google Desktop app OAuth clients don't allow registering custom URI schemes
// as redirect URIs. The accepted approach is http://127.0.0.1:<random-port>.
// Google allows any loopback port for Desktop apps without registration.

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

/**
 * Run the Google OAuth flow for the default Drive scope. `openGoogleAuthWithScope`
 * underneath does the actual work — call that directly if you want a different
 * scope (Gmail send for email notifications, YouTube upload, etc.).
 */
export async function openGoogleAuth(): Promise<{ codePromise: Promise<string>; verifier: string; redirectUri: string }> {
  return openGoogleAuthWithScope(CLOUD_CONFIG.googleDrive.scope)
}

/**
 * Same OAuth flow as openGoogleAuth() but takes a custom scope string. Used
 * for Gmail (mail notification path) so the user gets ONE consent screen
 * granting only what's needed for that feature.
 */
export async function openGoogleAuthWithScope(scope: string): Promise<{ codePromise: Promise<string>; verifier: string; redirectUri: string }> {
  if (!isServiceConfigured('google-drive')) {
    return {
      codePromise: Promise.reject(new Error('OAuth client not configured for google-drive. Set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in .env and rebuild.')),
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
        <h2>Autentisering fullført</h2>
        <p>Du kan lukke dette vinduet og gå tilbake til SundayRec.</p>
        <script>window.close()</script>
      </body></html>`)
      // Destroy socket so the connection closes immediately (prevents open-handle leaks in tests)
      res.socket?.destroy()
      clearTimeout(timer)
      server.close()
      settled = true

      const error = url.searchParams.get('error')
      if (error) { reject(new Error(`OAuth nektet: ${url.searchParams.get('error_description') ?? error}`)); return }
      const returnedState = url.searchParams.get('state') ?? ''
      if (returnedState !== state) { reject(new Error('OAuth state mismatch — mulig CSRF-forsøk')); return }
      // Replay protection: even if state matches what we issued, refuse if
      // we've already seen this exact state come through. Defense in depth
      // against very-quick double-callbacks (e.g. browser pre-fetch).
      if (isStateReplayed(returnedState)) {
        reject(new Error('OAuth state gjenbrukt — avvist'))
        return
      }
      markStateUsed(returnedState)
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
    }, PENDING_TIMEOUT_MS)
    // unref so the timer doesn't keep the process alive if nothing else is running (e.g. in tests)
    timer.unref()
  })

  const params = new URLSearchParams({
    client_id:             CLOUD_CONFIG.googleDrive.clientId,
    redirect_uri:          redirectUri,
    response_type:         'code',
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    scope,
    access_type:           'offline',
    prompt:                'consent',
  })

  shell.openExternal(`${CLOUD_CONFIG.googleDrive.authUrl}?${params.toString()}`)
  return { codePromise, verifier, redirectUri }
}

// ─── Dropbox + OneDrive: custom sundayrec:// scheme ──────────────────────────

export function openAuthBrowser(service: Exclude<CloudServiceId, 'google-drive'>): { promise: Promise<string>; verifier: string } {
  if (!isServiceConfigured(service)) {
    return {
      promise:  Promise.reject(new Error(`OAuth client not configured for ${service}. Set the env var in .env and rebuild.`)),
      verifier: '',
    }
  }

  clearPending(service, 'superseded')

  const verifier  = generateVerifier()
  const challenge = generateChallenge(verifier)
  const state     = generateState()

  let resolve!: (code: string) => void
  let reject!:  (err: Error) => void
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej })

  const timer = setTimeout(() => {
    clearPending(service, 'timeout')
  }, PENDING_TIMEOUT_MS)

  pending.set(service, { verifier, state, resolve, reject, timer })

  const cfg = service === 'dropbox' ? CLOUD_CONFIG.dropbox : CLOUD_CONFIG.oneDrive

  const params = new URLSearchParams({
    client_id:             cfg.clientId,
    redirect_uri:          cfg.redirectUri,
    response_type:         'code',
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  })

  if (service === 'dropbox') {
    params.set('token_access_type', 'offline')
  } else {
    params.set('scope', CLOUD_CONFIG.oneDrive.scope)
  }

  shell.openExternal(`${cfg.authUrl}?${params.toString()}`)
  return { promise, verifier }
}

/**
 * Called by the protocol-URL handler in main/index.ts when sundayrec:// fires.
 * Only used for Dropbox and OneDrive — Google Drive uses localhost redirect.
 */
export function handleCallback(service: CloudServiceId, params: URLSearchParams): boolean {
  if (service === 'google-drive') return false  // Google uses localhost, not protocol handler

  const p = pending.get(service)
  if (!p) return false

  const error = params.get('error')
  if (error) {
    clearTimeout(p.timer)
    pending.delete(service)
    const desc = params.get('error_description') ?? error
    p.reject(new Error(`OAuth denied: ${desc}`))
    return true
  }

  const returnedState = params.get('state')
  if (returnedState !== p.state) {
    clearTimeout(p.timer)
    pending.delete(service)
    p.reject(new Error('OAuth state mismatch — possible CSRF attempt'))
    return true
  }
  // Replay protection — see comment on the localhost-callback path. Same
  // semantics: matching state is necessary but not sufficient; we also
  // require that the state hasn't already been consumed in this session.
  if (isStateReplayed(returnedState)) {
    clearTimeout(p.timer)
    pending.delete(service)
    p.reject(new Error('OAuth state replay — rejected'))
    return true
  }
  markStateUsed(returnedState)

  const code = params.get('code')
  if (!code) {
    clearTimeout(p.timer)
    pending.delete(service)
    p.reject(new Error('OAuth callback missing code'))
    return true
  }

  clearTimeout(p.timer)
  pending.delete(service)
  p.resolve(code)
  return true
}

export function cancelPending(service: CloudServiceId): boolean {
  if (!pending.has(service)) return false
  clearPending(service, 'cancelled')
  return true
}

export function hasPending(service: CloudServiceId): boolean {
  return pending.has(service)
}

export async function exchangeCode(
  service: CloudServiceId,
  code: string,
  verifier: string,
  redirectUriOverride?: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
  const cfg = service === 'google-drive' ? CLOUD_CONFIG.googleDrive
            : service === 'dropbox'      ? CLOUD_CONFIG.dropbox
            :                              CLOUD_CONFIG.oneDrive

  const body = new URLSearchParams({
    client_id:     cfg.clientId,
    redirect_uri:  redirectUriOverride ?? cfg.redirectUri,
    grant_type:    'authorization_code',
    code,
    code_verifier: verifier,
  })
  if (service === 'google-drive' && CLOUD_CONFIG.googleDrive.clientSecret) {
    body.set('client_secret', CLOUD_CONFIG.googleDrive.clientSecret)
  }

  // 30 s timeout — a hanging token endpoint must not block the upload queue
  // forever. Without this, a network blackhole leaves processQueue stuck.
  const res = await fetchWithTimeout(cfg.tokenUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  }, 30_000)
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`)

  const json = await res.json() as Record<string, unknown>
  return {
    accessToken:  json.access_token  as string,
    refreshToken: json.refresh_token as string | undefined,
    expiresAt:    json.expires_in    ? Date.now() + (json.expires_in as number) * 1000 : undefined,
  }
}

/**
 * Refresh an access token. Throws with .code === 'invalid_grant' when the
 * refresh token is dead — caller must mark the connection as needing reauth.
 */
export async function refreshAccessToken(
  service: CloudServiceId,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
  const cfg = service === 'google-drive' ? CLOUD_CONFIG.googleDrive
            : service === 'dropbox'      ? CLOUD_CONFIG.dropbox
            :                              CLOUD_CONFIG.oneDrive

  const body = new URLSearchParams({
    client_id:     cfg.clientId,
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
  })
  if (service === 'google-drive' && CLOUD_CONFIG.googleDrive.clientSecret) {
    body.set('client_secret', CLOUD_CONFIG.googleDrive.clientSecret)
  }

  const res = await fetchWithTimeout(cfg.tokenUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  }, 30_000)
  if (!res.ok) {
    const bodyText = await res.text()
    let code: string | undefined
    try { code = (JSON.parse(bodyText) as { error?: string }).error } catch {}
    const err = new Error(`Token refresh failed: ${res.status} ${bodyText}`) as Error & { code?: string }
    if (code === 'invalid_grant') err.code = 'invalid_grant'
    throw err
  }

  const json = await res.json() as Record<string, unknown>
  return {
    accessToken:  json.access_token  as string,
    refreshToken: json.refresh_token as string | undefined,
    expiresAt:    json.expires_in    ? Date.now() + (json.expires_in as number) * 1000 : undefined,
  }
}
