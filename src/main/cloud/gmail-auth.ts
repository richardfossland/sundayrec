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

import { openGoogleAuthWithScope, exchangeCode, refreshAccessToken } from './oauth'
import { isServiceConfigured } from './config'
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
    // `'google-drive'` is the service-id under which Google OAuth credentials
    // live in CLOUD_CONFIG — Gmail reuses the same client_id/secret pair
    // (one Google OAuth app covers all of Drive + Gmail + YouTube scopes).
    const refreshed = await refreshAccessToken('google-drive', t.refreshToken)
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
    // was wiped from server side. oauth.refreshAccessToken sets .code on
    // the error for us — fall back to message-string match for older
    // call sites that might not have the code field.
    const err = e as Error & { code?: string }
    if (err.code === 'invalid_grant' || /invalid_grant/i.test(err.message)) {
      setToken('gmail', { ...t, needsReauth: true })
    }
    return null
  }
}

// Token refresh is delegated to cloud/oauth.ts. Gmail uses the same Google
// OAuth endpoint + client credentials as Drive, so reusing the shared
// helper means invalid_grant detection, timeout handling and (eventually)
// the refresh-mutex all stay in one place. Earlier we had a parallel
// implementation here that drifted from the canonical one — same risk
// YouTube's local helper had until v4.53.

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
