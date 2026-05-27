import Store from 'electron-store'
import { safeStorage } from 'electron'
import type { CloudServiceId } from '../../types'

/** Services that can hold an OAuth token. `CloudServiceId` covers backup
 *  services (Drive/Dropbox/OneDrive); 'youtube' is a publish-only target
 *  with its own token; 'gmail' powers the OAuth-based email-notification
 *  path (so users can skip SMTP-config + app-passwords entirely). All
 *  share the same encrypted vault. */
export type TokenServiceId = CloudServiceId | 'youtube' | 'gmail'

export interface TokenData {
  accessToken:   string
  refreshToken?: string
  expiresAt?:    number
  accountName?:  string
  accountEmail?: string
  folderId?:     string
  folderName?:   string
  folderPath?:   string
  lastUpload?:   number
  lastUploadOk?: boolean
  /** True when refresh_token was revoked (OAuth invalid_grant) — UI shows reauth banner. */
  needsReauth?:  boolean
}

interface RawStore {
  'google-drive'?: string
  'dropbox'?: string
  'onedrive'?: string
  'youtube'?: string
  'gmail'?: string
}

const store = new Store<RawStore>({ name: 'sundayrec-cloud' })

let warnedNoEncryption = false
function warnIfPlaintext(): void {
  if (warnedNoEncryption) return
  if (!safeStorage.isEncryptionAvailable()) {
    warnedNoEncryption = true
    console.warn('[cloud] safeStorage encryption unavailable — cloud tokens stored as plaintext (sundayrec-cloud.json)')
  }
}

export function getToken(service: TokenServiceId): TokenData | null {
  const enc = store.get(service as keyof RawStore)
  if (!enc) return null
  try {
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(enc, 'base64'))
      : enc
    return JSON.parse(json)
  } catch { return null }
}

export function setToken(service: TokenServiceId, data: TokenData | null): void {
  if (!data) { store.delete(service as keyof RawStore); return }
  warnIfPlaintext()
  const json = JSON.stringify(data)
  const enc  = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json).toString('base64')
    : json
  store.set(service as keyof RawStore, enc)
}

export function updateTokenFields(service: TokenServiceId, fields: Partial<TokenData>): void {
  const cur = getToken(service) ?? {} as TokenData
  setToken(service, { ...cur, ...fields })
}
