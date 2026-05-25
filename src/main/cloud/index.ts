import path from 'path'
import fs from 'fs'
import type { BrowserWindow } from 'electron'
import * as tokenStore from './token-store'
import * as oauth from './oauth'
import * as googleDrive from './google-drive'
import * as dropbox from './dropbox'
import * as oneDrive from './onedrive'
import * as store from '../store'
import * as logger from '../logger'
import { processQueue, enqueueUpload } from './upload-queue'
import type { CloudServiceId, CloudStatus, RecordingMetadata } from '../../types'

export { isServiceConfigured } from './config'
export { cancelPending, hasPending } from './oauth'

const PROACTIVE_REFRESH_MS = 5 * 60 * 1000  // refresh tokens 5 min before expiry

// Per-service refresh-promise to avoid concurrent token-refresh races
const refreshInflight = new Map<CloudServiceId, Promise<string>>()

/**
 * Parse a sundayrec://oauth/<service>?... callback URL and resolve the pending
 * OAuth promise. Returns true if a pending auth was matched.
 */
export function handleAuthUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'sundayrec:') return false
    // host can be 'oauth' and path '/<service>', or host can be the service if no path-rewriting
    const parts = (u.host + u.pathname).split('/').filter(Boolean)
    // Expect ["oauth", "<service>"]
    if (parts[0] !== 'oauth' || !parts[1]) return false
    const service = parts[1] as CloudServiceId
    if (service !== 'google-drive' && service !== 'dropbox' && service !== 'onedrive') return false
    return oauth.handleCallback(service, u.searchParams)
  } catch {
    return false
  }
}

async function refreshOne(service: CloudServiceId, refreshToken: string): Promise<string> {
  try {
    const refreshed = await oauth.refreshAccessToken(service, refreshToken)
    const update: Partial<tokenStore.TokenData> = {
      accessToken: refreshed.accessToken,
      expiresAt:   refreshed.expiresAt,
      needsReauth: false,
    }
    if (refreshed.refreshToken) update.refreshToken = refreshed.refreshToken
    tokenStore.updateTokenFields(service, update)
    logger.debug('cloud', 'token_refreshed', { service })
    return refreshed.accessToken
  } catch (err) {
    const e = err as Error & { code?: string }
    logger.error('cloud', 'token_refresh_failed', { service, error: e.message, code: e.code })
    if (e.code === 'invalid_grant') {
      tokenStore.updateTokenFields(service, { needsReauth: true })
    }
    throw err
  }
}

async function getValidToken(service: CloudServiceId): Promise<string> {
  const tok = tokenStore.getToken(service)
  if (!tok) throw new Error('not_connected')
  if (tok.needsReauth) throw new Error('needs_reauth')

  const expired = tok.expiresAt && Date.now() > tok.expiresAt - PROACTIVE_REFRESH_MS
  if (expired && tok.refreshToken) {
    // Coalesce concurrent refreshes (e.g. two uploads starting at once)
    let inflight = refreshInflight.get(service)
    if (!inflight) {
      inflight = refreshOne(service, tok.refreshToken)
        .finally(() => refreshInflight.delete(service))
      refreshInflight.set(service, inflight)
    }
    return inflight
  }
  return tok.accessToken
}

export async function connectService(service: CloudServiceId): Promise<{ ok: boolean; accountName?: string; error?: string }> {
  try {
    let code: string
    let verifier: string
    let redirectUri: string | undefined

    if (service === 'google-drive') {
      const auth = await oauth.openGoogleAuth()
      code        = await auth.codePromise
      verifier    = auth.verifier
      redirectUri = auth.redirectUri
    } else {
      const auth = oauth.openAuthBrowser(service)
      code     = await auth.promise
      verifier = auth.verifier
    }

    const tokens = await oauth.exchangeCode(service, code, verifier, redirectUri)

    let accountName = '', accountEmail = ''
    if (service === 'google-drive') {
      const info = await googleDrive.getUserInfo(tokens.accessToken)
      accountName = info.name; accountEmail = info.email
    } else if (service === 'dropbox') {
      const info = await dropbox.getUserInfo(tokens.accessToken)
      accountName = info.name; accountEmail = info.email
    } else {
      const info = await oneDrive.getUserInfo(tokens.accessToken)
      accountName = info.name; accountEmail = info.email
    }

    tokenStore.setToken(service, { ...tokens, accountName, accountEmail, needsReauth: false })
    return { ok: true, accountName }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function disconnectService(service: CloudServiceId): void {
  tokenStore.setToken(service, null)
}

export function getStatus(): Record<CloudServiceId, CloudStatus> {
  const ids: CloudServiceId[] = ['google-drive', 'dropbox', 'onedrive']
  const result = {} as Record<CloudServiceId, CloudStatus>
  for (const id of ids) {
    const tok = tokenStore.getToken(id)
    result[id] = tok
      ? {
          connected:     true,
          accountName:   tok.accountName,
          accountEmail:  tok.accountEmail,
          folderId:      tok.folderId,
          folderName:    tok.folderName,
          folderPath:    tok.folderPath,
          lastUpload:    tok.lastUpload,
          lastUploadOk:  tok.lastUploadOk,
          needsReauth:   tok.needsReauth ?? false,
        }
      : { connected: false }
  }
  return result
}

/**
 * Direct upload (used by manual UI actions and by the queue worker).
 * Throws on failure — callers decide whether to retry.
 */
export async function uploadFile(service: CloudServiceId, filePath: string, metadata?: RecordingMetadata, entryTimestamp?: number): Promise<void> {
  if (!fs.existsSync(filePath)) throw new Error('file_not_found')
  const token = await getValidToken(service)
  const tok   = tokenStore.getToken(service)!

  if (service === 'google-drive') {
    await googleDrive.uploadFile(token, filePath, tok.folderId, metadata)
  } else if (service === 'dropbox') {
    await dropbox.uploadFile(token, filePath, tok.folderPath)
  } else {
    await oneDrive.uploadFile(token, filePath, tok.folderId)
  }
  tokenStore.updateTokenFields(service, { lastUpload: Date.now(), lastUploadOk: true })
  if (entryTimestamp !== undefined) {
    store.markCloudUploaded(entryTimestamp, service)
  }
}

export async function listFolders(service: CloudServiceId, parentId?: string): Promise<{ id: string; name: string; path?: string }[]> {
  const token = await getValidToken(service)
  if (service === 'google-drive') return googleDrive.listFolders(token, parentId ?? 'root')
  if (service === 'dropbox')      return dropbox.listFolders(token, parentId ?? '')
  return oneDrive.listFolders(token, parentId)
}

export function setFolder(service: CloudServiceId, folderId: string, folderName: string, folderPath?: string): void {
  tokenStore.updateTokenFields(service, { folderId, folderName, folderPath })
}

/**
 * After a recording finishes, enqueue uploads for every enabled cloud service
 * that has autoUpload turned on. The queue handles retries, backoff, and
 * resuming after network outages.
 */
export function autoUploadAfterRecording(filePath: string, win: BrowserWindow): void {
  const settings = store.getAll()
  const map: { id: CloudServiceId; cfg: typeof settings.cloudGoogleDrive }[] = [
    { id: 'google-drive', cfg: settings.cloudGoogleDrive },
    { id: 'dropbox',      cfg: settings.cloudDropbox },
    { id: 'onedrive',     cfg: settings.cloudOneDrive },
  ]

  // Use path-normalized lookup — Windows can store the same file with either
  // separator depending on which code path wrote the entry.
  const entry = store.findHistoryByPath(filePath)
  const entryTimestamp = entry?.timestamp

  for (const { id, cfg } of map) {
    if (!cfg?.enabled || !cfg.autoUpload) continue
    if (!tokenStore.getToken(id)) continue
    enqueueUpload({ service: id, filePath, entryTimestamp })
    logger.info('cloud', 'auto_upload_queued', { service: id, filename: path.basename(filePath) })
  }

  // Kick the queue worker immediately
  void processQueue(win)
}

/** Run the queue once — used by the wake/resume handler and on app start. */
export function flushQueue(win: BrowserWindow): Promise<void> {
  return processQueue(win)
}
