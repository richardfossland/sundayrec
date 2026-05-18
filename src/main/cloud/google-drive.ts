import fs from 'fs'
import path from 'path'
import type { RecordingMetadata } from '../../types'

export async function getUserInfo(token: string): Promise<{ name: string; email: string }> {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`getUserInfo failed: ${res.status}`)
  const j = await res.json() as { name?: string; email?: string }
  return { name: j.name ?? '', email: j.email ?? '' }
}

export async function listFolders(token: string, parentId = 'root'): Promise<{ id: string; name: string }[]> {
  const q   = encodeURIComponent(`'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`)
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&orderBy=name`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`listFolders failed: ${res.status}`)
  const j = await res.json() as { files?: { id: string; name: string }[] }
  return j.files ?? []
}

export async function uploadFile(token: string, filePath: string, folderId?: string, metadata?: RecordingMetadata): Promise<string> {
  const filename = path.basename(filePath)
  const mimeType = audioMime(filename)
  const fileData = await fs.promises.readFile(filePath)

  const description = metadata
    ? [
        metadata.title   ? `Tittel: ${metadata.title}`   : '',
        metadata.speaker ? `Taler: ${metadata.speaker}`   : '',
        metadata.description || '',
      ].filter(Boolean).join('\n')
    : ''

  const meta = JSON.stringify({
    name: filename,
    description,
    ...(folderId ? { parents: [folderId] } : {}),
  })

  const boundary = 'SundayRecBoundary'
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, 'utf8'),
    fileData,
    Buffer.from(`\r\n--${boundary}--`, 'utf8'),
  ])

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  })
  if (!res.ok) throw new Error(`uploadFile failed: ${res.status} ${await res.text()}`)
  const j = await res.json() as { id: string }
  return j.id
}

function audioMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (ext === 'wav')            return 'audio/wav'
  if (ext === 'flac')           return 'audio/flac'
  if (ext === 'aac' || ext === 'm4a') return 'audio/aac'
  return 'audio/mpeg'
}
