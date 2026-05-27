import fs from 'fs'
import path from 'path'
import { CHUNK_SIZE, readChunk, withRetry, httpJson } from './http-util'

export async function getUserInfo(token: string): Promise<{ name: string; email: string }> {
  return withRetry(async () => {
    const res = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const j = await httpJson<{ displayName?: string; mail?: string; userPrincipalName?: string }>(res, 'getUserInfo')
    return { name: j.displayName ?? '', email: j.mail ?? j.userPrincipalName ?? '' }
  })
}

export async function listFolders(token: string, parentId?: string): Promise<{ id: string; name: string }[]> {
  return withRetry(async () => {
    const url = parentId
      ? `https://graph.microsoft.com/v1.0/me/drive/items/${parentId}/children?$filter=folder ne null&$select=id,name`
      : `https://graph.microsoft.com/v1.0/me/drive/root/children?$filter=folder ne null&$select=id,name`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const j = await httpJson<{ value?: { id: string; name: string }[] }>(res, 'listFolders')
    return j.value ?? []
  })
}

/**
 * Upload to OneDrive using an upload session — required for anything over ~4 MB.
 * 8 MB chunks, multiple of 320 KiB (the Graph-recommended chunk granularity).
 * 8 * 1024 * 1024 = 8388608 / 327680 = 25.6 → not a multiple. Use 7864320
 * (24 * 320 KiB) instead. We override CHUNK_SIZE locally.
 */
const ONEDRIVE_CHUNK = 24 * 320 * 1024  // 7.5 MB, multiple of 320 KiB

export type ProgressFn = (uploaded: number, total: number) => void

export async function uploadFile(
  token: string,
  filePath: string,
  folderId?: string,
  onProgress?: ProgressFn,
): Promise<string> {
  const filename = path.basename(filePath)
  const encoded  = encodeURIComponent(filename)
  const stat     = await fs.promises.stat(filePath)
  const size     = stat.size

  // Step 1 — create upload session
  const sessionUrl = folderId
    ? `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}:/${encoded}:/createUploadSession`
    : `https://graph.microsoft.com/v1.0/me/drive/root:/${encoded}:/createUploadSession`

  const sessionRes = await withRetry(async () => {
    const r = await fetch(sessionUrl, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', name: filename } }),
    })
    if (!r.ok) {
      const body = await r.text()
      const e = new Error(`OneDrive session failed: ${r.status} ${body}`) as Error & { status: number }
      e.status = r.status
      throw e
    }
    return r
  })

  const session = await sessionRes.json() as { uploadUrl: string }
  if (!session.uploadUrl) throw new Error('OneDrive: no uploadUrl in session response')

  // Step 2 — upload chunks.
  //
  // The chunk read + Content-Range computation MUST happen inside the retry
  // `op` closure. `beforeRetry` queries the server's nextExpectedRanges and
  // mutates `offset` — a retry attempt needs to re-read the file from the
  // new offset rather than re-sending the original (now-wrong) chunk buffer.
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
        // beforeRetry advanced offset past EOF — server has all bytes but
        // we never saw the 200/201 final response.
        throw new Error('OneDrive resume: server reported complete but no final response observed')
      }
      attemptChunkSize = Math.min(ONEDRIVE_CHUNK, remaining)
      attemptIsLast    = offset + attemptChunkSize >= size
      const chunk      = await readChunk(filePath, offset, attemptChunkSize)

      const r = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(attemptChunkSize),
          'Content-Range':  `bytes ${offset}-${offset + attemptChunkSize - 1}/${size}`,
        },
        body: chunk,
      })
      // 202 = chunk accepted, more to come; 200/201 = upload complete
      if (r.status === 202 || r.status === 200 || r.status === 201) return r
      const body = await r.text()
      const e = new Error(`OneDrive chunk failed: ${r.status} ${body}`) as Error & { status: number }
      e.status = r.status
      throw e
    }, {
      beforeRetry: async () => {
        // GET on uploadUrl returns nextExpectedRanges — resync offset.
        // Range strings come in the form "START-END" per Graph API spec;
        // some upload sessions also accept "START-" (open-ended). Walk
        // the full array (not just the first) and pick the LOWEST
        // start-byte so retries don't skip over a gap the server is
        // waiting for. If parsing fails we keep the local offset and let
        // the next chunk attempt resend.
        const probe = await fetch(session.uploadUrl).catch(() => null)
        if (probe && probe.ok) {
          const j = await probe.json().catch(() => null) as { nextExpectedRanges?: string[] } | null
          const ranges = j?.nextExpectedRanges ?? []
          let bestStart: number | null = null
          for (const r of ranges) {
            // Accept "START-END" and "START-" (open-ended).
            const m = /^(\d+)-(\d*)$/.exec(r.trim())
            if (!m) continue
            const start = parseInt(m[1], 10)
            if (!Number.isFinite(start)) continue
            if (bestStart === null || start < bestStart) bestStart = start
          }
          if (bestStart !== null) offset = bestStart
        }
      },
    })

    if (attemptIsLast) {
      const j = await res.json() as { id: string }
      fileId = j.id
    }

    offset += attemptChunkSize
    onProgress?.(offset, size)
  }

  if (!fileId) throw new Error('OneDrive upload completed without file id')
  // Cancel the upload session on failure paths is automatic — Graph auto-purges
  return fileId
}
