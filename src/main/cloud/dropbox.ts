import fs from 'fs'
import path from 'path'
import { CHUNK_SIZE, readChunk, withRetry, httpJson, dropboxContentHash } from './http-util'

export async function getUserInfo(token: string): Promise<{ name: string; email: string }> {
  return withRetry(async () => {
    const res = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    const j = await httpJson<{ name?: { display_name?: string }; email?: string }>(res, 'getUserInfo')
    return { name: j.name?.display_name ?? '', email: j.email ?? '' }
  })
}

export async function listFolders(token: string, folderPath = ''): Promise<{ id: string; name: string; path: string }[]> {
  return withRetry(async () => {
    const res = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ path: folderPath, recursive: false }),
    })
    const j = await httpJson<{ entries?: { '.tag': string; id: string; name: string; path_lower: string }[] }>(res, 'listFolders')
    return (j.entries ?? [])
      .filter(e => e['.tag'] === 'folder')
      .map(e => ({ id: e.id, name: e.name, path: e.path_lower }))
  })
}

/**
 * Upload to Dropbox using the upload_session protocol (required for files > 150 MB).
 * Always use the session API even for small files — it's a small overhead and
 * one code path is easier to maintain. 8 MB chunks (Dropbox accepts up to 150 MB
 * per append).
 */
export async function uploadFile(token: string, filePath: string, destFolder?: string): Promise<string> {
  const filename = path.basename(filePath)
  const destPath = destFolder ? `${destFolder.replace(/\/$/, '')}/${filename}` : `/${filename}`
  const stat     = await fs.promises.stat(filePath)
  const size     = stat.size

  // Step 1 — upload_session/start with the first chunk
  const firstSize  = Math.min(CHUNK_SIZE, size)
  const firstChunk = await readChunk(filePath, 0, firstSize)

  const startRes = await withRetry(async () => {
    const r = await fetch('https://content.dropboxapi.com/2/files/upload_session/start', {
      method:  'POST',
      headers: {
        Authorization:     `Bearer ${token}`,
        'Content-Type':    'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ close: size <= firstSize }),
      },
      body: firstChunk,
    })
    if (!r.ok) {
      const body = await r.text()
      const e = new Error(`Dropbox session start failed: ${r.status} ${body}`) as Error & { status: number }
      e.status = r.status
      throw e
    }
    return r
  })

  const startJson = await startRes.json() as { session_id: string }
  const sessionId = startJson.session_id
  let offset = firstSize

  // Step 2 — append remaining chunks
  while (offset < size) {
    const remaining = size - offset
    const chunkSize = Math.min(CHUNK_SIZE, remaining)
    const chunk     = await readChunk(filePath, offset, chunkSize)
    const isLast    = offset + chunkSize >= size

    await withRetry(async () => {
      const r = await fetch('https://content.dropboxapi.com/2/files/upload_session/append_v2', {
        method:  'POST',
        headers: {
          Authorization:     `Bearer ${token}`,
          'Content-Type':    'application/octet-stream',
          'Dropbox-API-Arg': JSON.stringify({
            cursor: { session_id: sessionId, offset },
            close:  isLast,
          }),
        },
        body: chunk,
      })
      if (!r.ok) {
        const body = await r.text()
        const e = new Error(`Dropbox append failed: ${r.status} ${body}`) as Error & { status: number }
        e.status = r.status
        throw e
      }
    })

    offset += chunkSize
  }

  // Step 3 — finish, commit to path
  const finishRes = await withRetry(async () => {
    const r = await fetch('https://content.dropboxapi.com/2/files/upload_session/finish', {
      method:  'POST',
      headers: {
        Authorization:     `Bearer ${token}`,
        'Content-Type':    'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          cursor: { session_id: sessionId, offset: size },
          commit: { path: destPath, mode: 'add', autorename: true, mute: true },
        }),
      },
      // Dropbox requires a body even for finish (empty is OK)
      body: Buffer.alloc(0),
    })
    if (!r.ok) {
      const body = await r.text()
      const e = new Error(`Dropbox finish failed: ${r.status} ${body}`) as Error & { status: number }
      e.status = r.status
      throw e
    }
    return r
  })

  const result = await finishRes.json() as { path_display?: string; content_hash?: string }

  // Integrity check — Dropbox returns content_hash; compute the same locally.
  if (result.content_hash) {
    const localHash = await dropboxContentHash(filePath)
    if (localHash !== result.content_hash) {
      throw new Error(`Dropbox content_hash mismatch: ${localHash} ≠ ${result.content_hash}`)
    }
  }

  return result.path_display ?? destPath
}
