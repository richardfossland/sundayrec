/**
 * YouTube IPC — connect/disconnect/status plus the upload endpoint exposed
 * from the editor's export modal. YouTube is treated as a publish-only
 * target, separate from the cloud-backup queue: it has its own token-store
 * entry so users can wire up Drive without YouTube (or vice versa).
 */

import { ipcMain } from 'electron'
import type { IpcContext } from './types'

// Note: `youtube-upload` remains in main/index.ts for now because it depends
// on the `isAllowedMediaPath` helper (security check on user-provided
// paths) that's still local to index.ts. When that helper moves to a
// shared utility we can fold the upload-handler in here too.

export function registerYouTubeIpc(_ctx: IpcContext): void {
  ipcMain.handle('youtube-connect', async () => {
    const yt = await import('../cloud/youtube')
    return yt.connect()
  })
  ipcMain.handle('youtube-disconnect', async () => {
    const yt = await import('../cloud/youtube')
    yt.disconnect()
    return { ok: true }
  })
  ipcMain.handle('youtube-status', async () => {
    const yt = await import('../cloud/youtube')
    return { connected: yt.isConnected() }
  })
}
