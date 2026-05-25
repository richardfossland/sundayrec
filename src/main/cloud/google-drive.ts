import fs from 'fs'
import path from 'path'
import { CHUNK_SIZE, readChunk, withRetry, httpJson, httpOk, md5OfFile } from './http-util'
import type { RecordingMetadata } from '../../types'

export async function getUserInfo(token: string): Promise<{ name: string; email: string }> {
  return withRetry(async () => {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const j = await httpJson<{ name?: string; email?: string }>(res, 'getUserInfo')
    return { name: j.name ?? '', email: j.email ?? '' }
  })
}

export async function listFolders(token: string, parentId = 'root'): Promise<{ id: string; name: string }[]> {
  return withRetry(async () => {
    const q   = encodeURIComponent(`'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`)
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&orderBy=name`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const j = await httpJson<{ files?: { id: string; name: string }[] }>(res, 'listFolders')
    return j.files ?? []
  })
}

/**
 * Upload a file to Drive using the resumable-upload protocol. Streams the file
 * 8 MB at a time, supports retry on transient errors, and (eventually)
 * resuming via the Upload-Status query. Integrity-checked via MD5 sum returned
 * by Drive against md5 calculated locally.
 */
export async function uploadFile(token: string, filePath: string, folderId?: string, metadata?: RecordingMetadata): Promise<string> {
  const filename = path.basename(filePath)
  const mimeType = audioMime(filename)
  const stat     = await fs.promises.stat(filePath)
  const size     = stat.size

  const description = metadata
    ? [
        metadata.title   ? `Tittel: ${metadata.title}`   : '',
        metadata.speaker ? `Taler: ${metadata.speaker}`   : '',
        metadata.description || '',
      ].filter(Boolean).join('\n')
    : ''

  // Step 1 — initiate resumable session, get upload URL
  const initBody = JSON.stringify({
    name: filename,
    description,
    ...(folderId ? { parents: [folderId] } : {}),
  })

  const initRes = await withRetry(() =>
    fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
      method: 'POST',
      headers: {
        Authorization:            `Bearer ${token}`,
        'Content-Type':           'application/json; charset=UTF-8',
        'X-Upload-Content-Type':  mimeType,
        'X-Upload-Content-Length': String(size),
      },
      body: initBody,
    }).then(async r => {
      if (!r.ok) {
        const body = await r.text()
        const e = new Error(`Drive init failed: ${r.status} ${body}`) as Error & { status: number }
        e.status = r.status
        throw e
      }
      return r
    })
  )

  const uploadUrl = initRes.headers.get('Location')
  if (!uploadUrl) throw new Error('Drive init: no Location header')

  // Step 2 — upload chunks. Drive requires that chunk sizes are multiples of 256 KB
  // (except the final chunk). 8 MB satisfies that.
  //
  // The chunk read + Content-Range computation MUST happen inside the retry `op`
  // closure. `beforeRetry` can mutate `offset` based on the server's view of
  // what it received, so a retry attempt needs to re-read the file at the new
  // offset rather than re-sending the original (now-wrong) chunk buffer.
  // `attemptChunkSize` / `attemptIsLast` are written by `op` and read after
  // `withRetry` resolves so the outer loop knows how far to advance.
  let offset = 0
  let fileId: string | null = null

  while (offset < size) {
    let attemptChunkSize = 0
    let attemptIsLast    = false

    const res = await withRetry(async () => {
      const remaining = size - offset
      if (remaining <= 0) {
        // beforeRetry advanced offset past EOF — server has all bytes but we
        // never observed the 200/201 final response. Surface as a specific
        // error so the queue can decide whether to re-upload from scratch.
        throw new Error('Drive resume: server reported complete but no final response observed')
      }
      attemptChunkSize = Math.min(CHUNK_SIZE, remaining)
      attemptIsLast    = offset + attemptChunkSize >= size
      const chunk      = await readChunk(filePath, offset, attemptChunkSize)

      const r = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(attemptChunkSize),
          'Content-Range':  `bytes ${offset}-${offset + attemptChunkSize - 1}/${size}`,
        },
        body: chunk,
      })
      // Drive returns 308 (Resume Incomplete) for non-final chunks, 200/201 on final
      if (r.status === 308 || r.status === 200 || r.status === 201) return r
      const body = await r.text()
      const e = new Error(`Drive chunk failed: ${r.status} ${body}`) as Error & { status: number }
      e.status = r.status
      throw e
    }, {
      beforeRetry: async () => {
        // Query upload status to resync offset after a transient failure
        const probe = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Length': '0', 'Content-Range': `bytes */${size}` },
        }).catch(() => null)
        if (probe && (probe.status === 308 || probe.status === 200)) {
          const range = probe.headers.get('Range')
          if (range) {
            // Range: bytes=0-N — N is the last byte server has
            const m = /bytes=0-(\d+)/.exec(range)
            if (m) offset = parseInt(m[1], 10) + 1
          }
        }
      },
    })

    if (attemptIsLast) {
      const j = await res.json() as { id: string; md5Checksum?: string }
      fileId = j.id

      // Integrity check — Drive returns md5Checksum for most uploaded files.
      // (Not for very large files, or some Google-edited formats.)
      if (j.md5Checksum) {
        const localMd5 = await md5OfFile(filePath)
        if (localMd5 !== j.md5Checksum) {
          throw new Error(`Drive checksum mismatch: ${localMd5} ≠ ${j.md5Checksum}`)
        }
      }
    }

    offset += attemptChunkSize
  }

  if (!fileId) throw new Error('Drive upload completed without file id')
  return fileId
}

function audioMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (ext === 'wav')                  return 'audio/wav'
  if (ext === 'flac')                 return 'audio/flac'
  if (ext === 'aac' || ext === 'm4a') return 'audio/aac'
  if (ext === 'ogg' || ext === 'opus' || ext === 'oga') return 'audio/ogg'
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4'
  if (ext === 'mov')                  return 'video/quicktime'
  if (ext === 'mkv')                  return 'video/x-matroska'
  if (ext === 'webm')                 return 'video/webm'
  if (ext === 'avi')                  return 'video/x-msvideo'
  return 'audio/mpeg'
}

/**
 * Make a Drive file readable by anyone with the link, and return a direct-
 * download URL suitable for use in a podcast RSS `<enclosure>`. The user
 * MUST explicitly enable podcast publishing for this to be invoked.
 *
 * Returns null if anything fails so the caller can fall back gracefully.
 */
export async function createPublicShareUrl(token: string, fileId: string): Promise<string | null> {
  try {
    // Grant 'anyone with the link' read permission. Idempotent — Drive
    // ignores duplicates.
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions?supportsAllDrives=true`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    })
    if (!r.ok && r.status !== 409) {
      // 409 = already shared. Anything else is a real failure.
      const body = await r.text()
      throw new Error(`Drive share-link failed: ${r.status} ${body}`)
    }
    // Public direct-download URL. Drive shows a virus-scan interstitial for
    // files >25 MB unless &confirm=t is appended (works on most large files).
    return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}&confirm=t`
  } catch {
    return null
  }
}

// Silence unused-import warning
void httpOk
