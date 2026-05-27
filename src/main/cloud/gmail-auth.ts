/**
 * Gmail OAuth — powers the e-mail-notification path that lets users skip
 * SMTP-configuration entirely.
 *
 * Architectural fit:
 *   • Same Google OAuth Desktop loopback flow as Drive/YouTube — we
 *     reuse `openGoogleAuthWithScope` from cloud/oauth.ts and request the
 *     single `gmail.send` scope. One consent screen, one button, no
 *     SMTP server name to look up.
 *   • Token stored in the same encrypted vault as the cloud tokens
 *     (token-store.ts, service id `'gmail'`).
 *   • Send path lives in main/mailer.ts — it picks between SMTP and the
 *     Gmail API based on whether a `'gmail'` token exists.
 *
 * The `gmail.send` scope is documented as "sensitive" by Google, so for
 * unrestricted public release the OAuth app must go through Google's App
 * Review process. Until then, the OAuth flow works fine for app owner and
 * explicitly-allowed test users.
 */

import { openGoogleAuthWithScope, exchangeCode } from './oauth'
import { CLOUD_CONFIG, isServiceConfigured } from './config'
import { getToken, setToken } from './token-store'

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send'

export interface GmailAuthResult {
  ok: boolean
  /** E-mail address the user picked in the Google consent screen. */
  email?: string
  error?: string
}

/**
 * Run the consent flow and persist the resulting token under the `gmail`
 * service id. The user-facing button is "Logg inn med Google" on the
 * e-postvarsler-card.
 */
export async function connectGmail(): Promise<GmailAuthResult> {
  if (!isServiceConfigured('google-drive')) {
    return { ok: false, error: 'OAuth client not configured (missing GOOGLE_CLIENT_ID/SECRET in build)' }
  }
  try {
    const { codePromise, verifier, redirectUri } = await openGoogleAuthWithScope(GMAIL_SCOPE)
    const code = await codePromise
    // Reuse the cloud-side `exchangeCode` helper — google-drive shares the
    // same token endpoint + client_id with the Gmail scope.
    const tok = await exchangeCode('google-drive', code, verifier, redirectUri)

    // Resolve the account e-mail so we can show it in the UI ("Sender via
    // <name@gmail.com>") and use it as the From-address. Userinfo endpoint
    // doesn't need an additional scope when the access token came from
    // a Google OAuth flow.
    const email = await fetchGmailAccountEmail(tok.accessToken).catch(() => undefined)

    setToken('gmail', {
      accessToken:  tok.accessToken,
      refreshToken: tok.refreshToken,
      expiresAt:    tok.expiresAt,
      accountEmail: email,
      accountName:  email,
    })
    return { ok: true, email }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

/** Wipe the stored Gmail token. UI hides the "Logg inn med Google"-knapp
 *  with a "Frakoblet"-state after this returns. */
export function disconnectGmail(): void {
  setToken('gmail', null)
}

/** Status snapshot for the UI: whether a token is on file and which
 *  account it belongs to. We never expose the access token itself to
 *  the renderer — only the e-mail address. */
export function getGmailStatus(): { connected: boolean; email?: string; needsReauth?: boolean } {
  const t = getToken('gmail')
  if (!t || !t.refreshToken) return { connected: false }
  return {
    connected:    true,
    email:        t.accountEmail,
    needsReauth:  t.needsReauth,
  }
}

/**
 * Resolve a fresh access token for the Gmail API, refreshing on-demand
 * when the current one is within 60 s of expiry. The refresh path is the
 * same Google endpoint used by Drive — we just store the rotated token
 * back under the `'gmail'` service id.
 */
export async function getFreshGmailAccessToken(): Promise<string | null> {
  const t = getToken('gmail')
  if (!t) return null
  const now = Date.now()
  if (t.accessToken && (!t.expiresAt || t.expiresAt > now + 60_000)) {
    return t.accessToken
  }
  if (!t.refreshToken) return null
  try {
    const refreshed = await refreshGmailToken(t.refreshToken)
    setToken('gmail', {
      ...t,
      accessToken: refreshed.accessToken,
      expiresAt:   refreshed.expiresAt,
      // Google rotates refresh_tokens occasionally — keep the rotated
      // value when supplied, otherwise the existing one stays valid.
      refreshToken: refreshed.refreshToken ?? t.refreshToken,
      needsReauth:  false,
    })
    return refreshed.accessToken
  } catch (e) {
    // invalid_grant from Google = user revoked access or refresh-token
    // was wiped from server side. Surface that to the UI via needsReauth
    // so the next render can show the "log in again"-banner.
    if (e instanceof Error && /invalid_grant/i.test(e.message)) {
      setToken('gmail', { ...t, needsReauth: true })
    }
    return null
  }
}

interface RefreshedToken {
  accessToken:  string
  refreshToken?: string
  expiresAt:    number
}

async function refreshGmailToken(refreshToken: string): Promise<RefreshedToken> {
  const body = new URLSearchParams({
    client_id:     CLOUD_CONFIG.googleDrive.clientId,
    client_secret: CLOUD_CONFIG.googleDrive.clientSecret,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
  })
  const r = await fetch(CLOUD_CONFIG.googleDrive.tokenUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`Gmail token refresh failed: ${r.status} ${text.slice(0, 200)}`)
  }
  const j = await r.json() as { access_token: string; expires_in: number; refresh_token?: string }
  return {
    accessToken:  j.access_token,
    refreshToken: j.refresh_token,
    expiresAt:    Date.now() + (j.expires_in * 1000),
  }
}

async function fetchGmailAccountEmail(accessToken: string): Promise<string | undefined> {
  // userinfo endpoint returns { email, name, picture, ... } — we only
  // care about the e-mail. No extra scope needed beyond what gmail.send
  // already grants (openid+email come implicitly via Google ID-token).
  const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!r.ok) return undefined
  const j = await r.json() as { email?: string }
  return j.email
}
