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
  let offset = 0
  let fileId: string | null = null

  while (offset < size) {
    const remaining = size - offset
    const chunkSize = Math.min(CHUNK_SIZE, remaining)
    const chunk     = await readChunk(filePath, offset, chunkSize)
    const isLast    = offset + chunkSize >= size

    const res = await withRetry(async () => {
      const r = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(chunkSize),
          'Content-Range':  `bytes ${offset}-${offset + chunkSize - 1}/${size}`,
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

    if (isLast) {
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

    offset += chunkSize
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

// Silence unused-import warning
void httpOk
