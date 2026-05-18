import crypto from 'crypto'
import { shell } from 'electron'
import { CLOUD_CONFIG } from './config'
import type { CloudServiceId } from '../../types'

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function generateVerifier(): string {
  return base64url(crypto.randomBytes(32))
}

function generateChallenge(verifier: string): string {
  return base64url(crypto.createHash('sha256').update(verifier).digest())
}

interface Pending {
  verifier: string
  resolve: (code: string) => void
  reject:  (err: Error)   => void
}

const pending = new Map<CloudServiceId, Pending>()

export function openAuthBrowser(service: CloudServiceId): { promise: Promise<string>; verifier: string } {
  const verifier   = generateVerifier()
  const challenge  = generateChallenge(verifier)

  let resolve!: (code: string) => void
  let reject!:  (err: Error) => void
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej })

  pending.set(service, { verifier, resolve, reject })

  const cfg = service === 'google-drive' ? CLOUD_CONFIG.googleDrive
            : service === 'dropbox'      ? CLOUD_CONFIG.dropbox
            :                              CLOUD_CONFIG.oneDrive

  const params = new URLSearchParams({
    client_id:             cfg.clientId,
    redirect_uri:          cfg.redirectUri,
    response_type:         'code',
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  })

  if (service === 'google-drive') {
    params.set('scope', CLOUD_CONFIG.googleDrive.scope)
    params.set('access_type', 'offline')
    params.set('prompt', 'consent')
  } else if (service === 'dropbox') {
    params.set('token_access_type', 'offline')
  } else {
    params.set('scope', CLOUD_CONFIG.oneDrive.scope)
  }

  shell.openExternal(`${cfg.authUrl}?${params.toString()}`)
  return { promise, verifier }
}

export function handleCallback(service: CloudServiceId, code: string): void {
  const p = pending.get(service)
  if (p) { pending.delete(service); p.resolve(code) }
}

export function cancelPending(service: CloudServiceId): void {
  const p = pending.get(service)
  if (p) { pending.delete(service); p.reject(new Error('cancelled')) }
}

export async function exchangeCode(service: CloudServiceId, code: string, verifier: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
  const cfg = service === 'google-drive' ? CLOUD_CONFIG.googleDrive
            : service === 'dropbox'      ? CLOUD_CONFIG.dropbox
            :                              CLOUD_CONFIG.oneDrive

  const body = new URLSearchParams({
    client_id:     cfg.clientId,
    redirect_uri:  cfg.redirectUri,
    grant_type:    'authorization_code',
    code,
    code_verifier: verifier,
  })

  const res  = await fetch(cfg.tokenUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  })
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`)

  const json = await res.json() as Record<string, unknown>
  return {
    accessToken:  json.access_token  as string,
    refreshToken: json.refresh_token as string | undefined,
    expiresAt:    json.expires_in    ? Date.now() + (json.expires_in as number) * 1000 : undefined,
  }
}

export async function refreshAccessToken(service: CloudServiceId, refreshToken: string): Promise<{ accessToken: string; expiresAt?: number }> {
  const cfg = service === 'google-drive' ? CLOUD_CONFIG.googleDrive
            : service === 'dropbox'      ? CLOUD_CONFIG.dropbox
            :                              CLOUD_CONFIG.oneDrive

  const body = new URLSearchParams({
    client_id:     cfg.clientId,
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
  })

  const res = await fetch(cfg.tokenUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  })
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`)

  const json = await res.json() as Record<string, unknown>
  return {
    accessToken: json.access_token as string,
    expiresAt:   json.expires_in ? Date.now() + (json.expires_in as number) * 1000 : undefined,
  }
}
