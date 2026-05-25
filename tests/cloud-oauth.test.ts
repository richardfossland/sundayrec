/**
 * Tests for cloud/oauth.ts
 *
 * Google Drive uses the localhost-redirect flow (openGoogleAuth).
 * Dropbox + OneDrive use the custom sundayrec:// scheme (openAuthBrowser + handleCallback).
 */

jest.mock('electron', () => ({
  shell: { openExternal: jest.fn() },
  app: { getPath: jest.fn(() => '/tmp') },
  safeStorage: { isEncryptionAvailable: () => false },
}))

jest.mock('../src/main/cloud/config', () => ({
  CLOUD_CONFIG: {
    googleDrive: {
      clientId:     'test-google',
      clientSecret: 'test-secret',
      authUrl:      'https://example.com/auth',
      tokenUrl:     'https://example.com/token',
      scope:        'drive',
      redirectUri:  'sundayrec://oauth/google-drive',
    },
    dropbox:  { clientId: 'test-dropbox',  authUrl: 'https://example.com/auth', tokenUrl: 'https://example.com/token', redirectUri: 'sundayrec://oauth/dropbox' },
    oneDrive: { clientId: 'test-onedrive', authUrl: 'https://example.com/auth', tokenUrl: 'https://example.com/token', scope: 'files', redirectUri: 'sundayrec://oauth/onedrive' },
  },
  isServiceConfigured: () => true,
}))

import http from 'http'
import { openAuthBrowser, openGoogleAuth, handleCallback, cancelPending, hasPending } from '../src/main/cloud/oauth'
import { shell } from 'electron'

const mockOpen = (shell as unknown as { openExternal: jest.Mock }).openExternal

// Helper: send an HTTP GET to the localhost callback server
async function sendLocalhostCallback(redirectUri: string, params: Record<string, string>): Promise<void> {
  const { port } = new URL(redirectUri)
  const query = new URLSearchParams(params).toString()
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/?${query}`, (res) => {
      res.resume()
      res.on('end', resolve)
    })
    req.on('error', reject)
  })
}

// ─── Google Drive: localhost flow ─────────────────────────────────────────────

describe('openGoogleAuth (localhost redirect)', () => {
  beforeEach(() => mockOpen.mockClear())

  it('opens browser URL with PKCE and state params', async () => {
    const { codePromise, redirectUri } = await openGoogleAuth()
    codePromise.catch(() => {})
    expect(mockOpen).toHaveBeenCalledTimes(1)
    const url = new URL(mockOpen.mock.calls[0][0] as string)
    expect(url.searchParams.get('state')).toBeTruthy()
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('client_id')).toBe('test-google')
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    // drain the server by sending a valid callback
    const state = url.searchParams.get('state')!
    await sendLocalhostCallback(redirectUri, { code: 'cleanup', state })
    await codePromise.catch(() => {})
  })

  it('resolves codePromise with auth code when state matches', async () => {
    const { codePromise, redirectUri } = await openGoogleAuth()
    const authUrl = new URL(mockOpen.mock.calls[0][0] as string)
    const state   = authUrl.searchParams.get('state')!
    await sendLocalhostCallback(redirectUri, { code: 'google-code-xyz', state })
    await expect(codePromise).resolves.toBe('google-code-xyz')
  })

  it('rejects on state mismatch', async () => {
    const { codePromise, redirectUri } = await openGoogleAuth()
    codePromise.catch(() => {})
    await sendLocalhostCallback(redirectUri, { code: 'x', state: 'wrong-state' })
    await expect(codePromise).rejects.toThrow(/state mismatch/i)
  })

  it('rejects when callback contains error param', async () => {
    const { codePromise, redirectUri } = await openGoogleAuth()
    codePromise.catch(() => {})
    await sendLocalhostCallback(redirectUri, { error: 'access_denied', error_description: 'Bruker avbrøt' })
    await expect(codePromise).rejects.toThrow(/Bruker avbrøt/)
  })

  it('uses a different port on each invocation', async () => {
    const a = await openGoogleAuth()
    const b = await openGoogleAuth()
    a.codePromise.catch(() => {})
    b.codePromise.catch(() => {})
    expect(a.redirectUri).not.toBe(b.redirectUri)
    // drain both servers
    const stateA = new URL(mockOpen.mock.calls[0][0] as string).searchParams.get('state')!
    const stateB = new URL(mockOpen.mock.calls[1][0] as string).searchParams.get('state')!
    await sendLocalhostCallback(a.redirectUri, { code: 'a', state: stateA })
    await sendLocalhostCallback(b.redirectUri, { code: 'b', state: stateB })
    await a.codePromise
    await b.codePromise
  })
})

// ─── Dropbox / OneDrive: custom scheme flow ───────────────────────────────────

describe('openAuthBrowser + handleCallback (dropbox / onedrive)', () => {
  beforeEach(() => {
    mockOpen.mockClear()
    cancelPending('dropbox')
    cancelPending('onedrive')
  })

  afterEach(() => {
    cancelPending('dropbox')
    cancelPending('onedrive')
  })

  it('opens browser URL with PKCE and state params', () => {
    const { promise } = openAuthBrowser('dropbox')
    promise.catch(() => {})
    const url = new URL(mockOpen.mock.calls[0][0] as string)
    expect(url.searchParams.get('state')).toBeTruthy()
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('client_id')).toBe('test-dropbox')
    cancelPending('dropbox')
  })

  it('resolves with code when state matches', async () => {
    const { promise } = openAuthBrowser('dropbox')
    const url   = new URL(mockOpen.mock.calls[0][0] as string)
    const state = url.searchParams.get('state')!
    handleCallback('dropbox', new URLSearchParams({ code: 'dropbox-code', state }))
    await expect(promise).resolves.toBe('dropbox-code')
  })

  it('rejects on state mismatch', async () => {
    const { promise } = openAuthBrowser('dropbox')
    promise.catch(() => {})
    handleCallback('dropbox', new URLSearchParams({ code: 'x', state: 'attacker' }))
    await expect(promise).rejects.toThrow(/state mismatch/i)
  })

  it('rejects when callback contains error=access_denied', async () => {
    const { promise } = openAuthBrowser('dropbox')
    promise.catch(() => {})
    handleCallback('dropbox', new URLSearchParams({ error: 'access_denied', error_description: 'User cancelled' }))
    await expect(promise).rejects.toThrow(/User cancelled/)
  })

  it('rejects when callback is missing code', async () => {
    const { promise } = openAuthBrowser('dropbox')
    promise.catch(() => {})
    const state = new URL(mockOpen.mock.calls[0][0] as string).searchParams.get('state')!
    handleCallback('dropbox', new URLSearchParams({ state }))
    await expect(promise).rejects.toThrow(/missing code/i)
  })

  it('returns false from handleCallback when no pending auth exists', () => {
    expect(handleCallback('dropbox', new URLSearchParams({ code: 'x', state: 'y' }))).toBe(false)
  })

  it('handleCallback returns false for google-drive (uses localhost flow)', () => {
    expect(handleCallback('google-drive', new URLSearchParams({ code: 'x', state: 'y' }))).toBe(false)
  })

  it('supersedes a previous pending auth when called twice', async () => {
    const first  = openAuthBrowser('dropbox')
    first.promise.catch(() => {})
    const second = openAuthBrowser('dropbox')
    second.promise.catch(() => {})
    await expect(first.promise).rejects.toThrow(/superseded/)
    expect(hasPending('dropbox')).toBe(true)
    cancelPending('dropbox')
  })

  it('cancelPending rejects with "cancelled"', async () => {
    const { promise } = openAuthBrowser('dropbox')
    expect(cancelPending('dropbox')).toBe(true)
    await expect(promise).rejects.toThrow(/cancelled/)
  })

  it('cancelPending returns false when nothing is pending', () => {
    expect(cancelPending('onedrive')).toBe(false)
  })

  it('hasPending reflects state correctly', () => {
    expect(hasPending('dropbox')).toBe(false)
    const { promise } = openAuthBrowser('dropbox')
    promise.catch(() => {})
    expect(hasPending('dropbox')).toBe(true)
    cancelPending('dropbox')
    expect(hasPending('dropbox')).toBe(false)
  })

  it('does not cross-contaminate between dropbox and onedrive', async () => {
    const db  = openAuthBrowser('dropbox')
    db.promise.catch(() => {})  // will be cancelled at end of test — suppress unhandled rejection
    const od  = openAuthBrowser('onedrive')

    const odUrl   = new URL(mockOpen.mock.calls[1][0] as string)
    const odState = odUrl.searchParams.get('state')!

    handleCallback('onedrive', new URLSearchParams({ code: 'od-code', state: odState }))
    await expect(od.promise).resolves.toBe('od-code')
    expect(hasPending('dropbox')).toBe(true)
    cancelPending('dropbox')
  })
})
