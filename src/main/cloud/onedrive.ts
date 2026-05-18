import fs from 'fs'
import path from 'path'

export async function getUserInfo(token: string): Promise<{ name: string; email: string }> {
  const res = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`getUserInfo failed: ${res.status}`)
  const j = await res.json() as { displayName?: string; mail?: string; userPrincipalName?: string }
  return { name: j.displayName ?? '', email: j.mail ?? j.userPrincipalName ?? '' }
}

export async function listFolders(token: string, parentId?: string): Promise<{ id: string; name: string }[]> {
  const url = parentId
    ? `https://graph.microsoft.com/v1.0/me/drive/items/${parentId}/children?$filter=folder ne null&$select=id,name`
    : `https://graph.microsoft.com/v1.0/me/drive/root/children?$filter=folder ne null&$select=id,name`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`listFolders failed: ${res.status}`)
  const j = await res.json() as { value?: { id: string; name: string }[] }
  return j.value ?? []
}

export async function uploadFile(token: string, filePath: string, folderId?: string): Promise<string> {
  const filename = path.basename(filePath)
  const encoded  = encodeURIComponent(filename)
  const url      = folderId
    ? `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}:/${encoded}:/content`
    : `https://graph.microsoft.com/v1.0/me/drive/root:/${encoded}:/content`
  const fileData = await fs.promises.readFile(filePath)

  const res = await fetch(url, {
    method:  'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body:    fileData,
  })
  if (!res.ok) throw new Error(`uploadFile failed: ${res.status} ${await res.text()}`)
  const j = await res.json() as { id: string }
  return j.id
}
