/**
 * Encrypted storage for live-stream destination keys.
 *
 * Keys are sensitive — leaking a YouTube/Facebook stream key lets anyone
 * push video to the user's channel. We mirror the cloud-token-store pattern
 * (safeStorage with system keychain on macOS/Windows, plaintext fallback
 * with a warning on Linux).
 */

import Store from 'electron-store'
import { safeStorage } from 'electron'

interface RawStore {
  /** Keyed by destination id → encrypted key blob. */
  [destId: string]: string | undefined
}

const store = new Store<RawStore>({ name: 'sundayrec-stream-keys' })

let warnedNoEncryption = false
function warnIfPlaintext(): void {
  if (warnedNoEncryption) return
  if (!safeStorage.isEncryptionAvailable()) {
    warnedNoEncryption = true
    console.warn('[stream-keys] safeStorage unavailable — keys stored as plaintext (sundayrec-stream-keys.json)')
  }
}

export function getStreamKey(destId: string): string | null {
  const enc = store.get(destId)
  if (!enc) return null
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(enc, 'base64'))
      : enc
  } catch { return null }
}

/**
 * Returns true when storing a key right now would be encrypted at rest.
 * Callers (the IPC handler for `stream-set-key`) can short-circuit and
 * surface a UI warning rather than silently writing plaintext to disk.
 */
export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export function setStreamKey(destId: string, key: string): { ok: boolean; error?: string } {
  if (!key) { store.delete(destId); return { ok: true } }
  // Refuse to store unencrypted. A shared-account machine could expose the
  // key via the JSON file on disk to anyone with filesystem access. The
  // user-facing flow asks the caller to show a "kan ikke lagre — krypteringe
  // er ikke tilgjengelig på denne maskinen" message rather than save in clear.
  if (!safeStorage.isEncryptionAvailable()) {
    warnIfPlaintext()
    return { ok: false, error: 'safeStorage_unavailable' }
  }
  const enc = safeStorage.encryptString(key).toString('base64')
  store.set(destId, enc)
  return { ok: true }
}

export function deleteStreamKey(destId: string): void {
  store.delete(destId)
}

export function listStoredKeyIds(): string[] {
  return Object.keys(store.store)
}
