import path from 'path'
import type { BrowserWindow } from 'electron'
import * as tokenStore from './token-store'
import * as oauth from './oauth'
import * as googleDrive from './google-drive'
import * as dropbox from './dropbox'
import * as oneDrive from './onedrive'
import * as store from '../store'
import * as logger from '../logger'
import type { CloudServiceId, CloudStatus, RecordingMetadata } from '../../types'

// Re-export handleCallback so main/index.ts can call it from the URL handler
export { handleCallback, cancelPending } from './oauth'

async function getValidToken(service: CloudServiceId): Promise<string> {
  const tok = tokenStore.getToken(service)
  if (!tok) throw new Error('not_connected')
  if (tok.expiresAt && Date.now() > tok.expiresAt - 60_000 && tok.refreshToken) {
    try {
      const refreshed = await oauth.refreshAccessToken(service, tok.refreshToken)
      tokenStore.updateTokenFields(service, { accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt })
      logger.debug('cloud', 'token_refreshed', { service })
      return refreshed.accessToken
    } catch (err) {
      logger.error('cloud', 'token_refresh_failed', { service, error: (err as Error).message })
      throw err
    }
  }
  return tok.accessToken
}

export async function connectService(service: CloudServiceId): Promise<{ ok: boolean; accountName?: string; error?: string }> {
  try {
    const { promise, verifier } = oauth.openAuthBrowser(service)
    const code   = await promise
    const tokens = await oauth.exchangeCode(service, code, verifier)

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

    tokenStore.setToken(service, { ...tokens, accountName, accountEmail })
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
      ? { connected: true, accountName: tok.accountName, accountEmail: tok.accountEmail, folderId: tok.folderId, folderName: tok.folderName, folderPath: tok.folderPath, lastUpload: tok.lastUpload, lastUploadOk: tok.lastUploadOk }
      : { connected: false }
  }
  return result
}

export async function uploadFile(service: CloudServiceId, filePath: string, metadata?: RecordingMetadata, entryTimestamp?: number): Promise<void> {
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

export async function autoUploadAfterRecording(
  filePath: string,
  win: BrowserWindow,
  sendWarning?: (msg: string, severity: 'warn' | 'error', category: 'cloud') => void
): Promise<void> {
  const settings = store.getAll()
  const map: { id: CloudServiceId; cfg: typeof settings.cloudGoogleDrive }[] = [
    { id: 'google-drive', cfg: settings.cloudGoogleDrive },
    { id: 'dropbox',      cfg: settings.cloudDropbox },
    { id: 'onedrive',     cfg: settings.cloudOneDrive },
  ]

  // Find the history entry timestamp for this file so we can mark it uploaded
  const history = store.getHistory()
  const entryTimestamp = history.find(e => e.path === filePath)?.timestamp

  for (const { id, cfg } of map) {
    if (!cfg?.enabled || !cfg.autoUpload) continue
    if (!tokenStore.getToken(id)) continue
    const filename = path.basename(filePath)
    const uploadStart = Date.now()
    logger.info('cloud', 'auto_upload_start', { service: id, filename })
    try {
      win.webContents.send('cloud-upload-progress', { service: id, filename })
      await uploadFile(id, filePath, undefined, entryTimestamp)
      win.webContents.send('cloud-upload-done', { service: id, ok: true })
      logger.info('cloud', 'auto_upload_ok', { service: id, filename, durationMs: Date.now() - uploadStart })
    } catch (err) {
      tokenStore.updateTokenFields(id, { lastUpload: Date.now(), lastUploadOk: false })
      win.webContents.send('cloud-upload-done', { service: id, ok: false, error: (err as Error).message })
      const errMsg = `Cloud upload failed (${id}): ${(err as Error).message}`
      logger.error('cloud', 'auto_upload_failed', { service: id, error: (err as Error).message })
      console.error('[cloud]', errMsg)
      sendWarning?.(errMsg, 'error', 'cloud')
    }
  }
}
