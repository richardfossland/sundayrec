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

export function setStreamKey(destId: string, key: string): void {
  if (!key) { store.delete(destId); return }
  warnIfPlaintext()
  const enc = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(key).toString('base64')
    : key
  store.set(destId, enc)
}

export function deleteStreamKey(destId: string): void {
  store.delete(destId)
}

export function listStoredKeyIds(): string[] {
  return Object.keys(store.store)
}
