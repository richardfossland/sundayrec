import fs from 'fs'
import path from 'path'

export async function getUserInfo(token: string): Promise<{ name: string; email: string }> {
  const res = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`getUserInfo failed: ${res.status}`)
  const j = await res.json() as { name?: { display_name?: string }; email?: string }
  return { name: j.name?.display_name ?? '', email: j.email ?? '' }
}

export async function listFolders(token: string, folderPath = ''): Promise<{ id: string; name: string; path: string }[]> {
  const res = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ path: folderPath, recursive: false }),
  })
  if (!res.ok) throw new Error(`listFolders failed: ${res.status}`)
  const j = await res.json() as { entries?: { '.tag': string; id: string; name: string; path_lower: string }[] }
  return (j.entries ?? [])
    .filter(e => e['.tag'] === 'folder')
    .map(e => ({ id: e.id, name: e.name, path: e.path_lower }))
}

export async function uploadFile(token: string, filePath: string, destFolder?: string): Promise<string> {
  const filename = path.basename(filePath)
  const destPath = destFolder ? `${destFolder}/${filename}` : `/${filename}`
  const fileData = await fs.promises.readFile(filePath)

  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method:  'POST',
    headers: {
      Authorization:     `Bearer ${token}`,
      'Content-Type':    'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path: destPath, mode: 'add', autorename: true }),
    },
    body: fileData,
  })
  if (!res.ok) throw new Error(`uploadFile failed: ${res.status} ${await res.text()}`)
  const j = await res.json() as { path_display?: string }
  return j.path_display ?? destPath
}
