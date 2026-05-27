/**
 * Cloud-backup IPC — Drive/Dropbox/OneDrive connect/disconnect/upload +
 * the persistent upload queue (status/retry/remove/flush).
 *
 * Note: `cloud-upload-file` keeps its `isAllowedMediaPath` security check
 * inline (path-traversal guard for user-provided paths). The helper still
 * lives in index.ts; if it moves to a shared utility we can fold this in.
 * For now we require the caller to pass the predicate via the context.
 */

import { ipcMain } from 'electron'
import type { CloudServiceId } from '../../types'
import type { IpcContext } from './types'

export interface CloudIpcContext extends IpcContext {
  /** Guard for user-provided media paths — rejects anything outside the
   *  user's save-folder + known recording history paths. */
  isAllowedMediaPath: (filePath: string) => boolean
}

export function registerCloudIpc(ctx: CloudIpcContext): void {
  ipcMain.handle('cloud-connect', async (_, service: string) => {
    const cloud = await import('../cloud')
    return cloud.connectService(service as CloudServiceId)
  })

  ipcMain.handle('cloud-cancel-connect', async (_, service: string) => {
    const cloud = await import('../cloud')
    return cloud.cancelPending(service as CloudServiceId)
  })

  ipcMain.handle('cloud-disconnect', async (_, service: string) => {
    const cloud = await import('../cloud')
    return cloud.disconnectService(service as CloudServiceId)
  })

  ipcMain.handle('cloud-status', async () => {
    const cloud = await import('../cloud')
    return cloud.getStatus()
  })

  ipcMain.handle('cloud-upload-file', async (_, service: string, filePath: string) => {
    if (typeof filePath !== 'string' || !ctx.isAllowedMediaPath(filePath)) {
      return { ok: false, error: 'invalid_path' }
    }
    try {
      const cloud = await import('../cloud')
      // Manual upload goes via the queue too so it gets retry semantics
      const { enqueueUpload } = await import('../cloud/upload-queue')
      enqueueUpload({ service: service as CloudServiceId, filePath })
      void cloud.flushQueue(ctx.mainWindow)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('cloud-list-folders', async (_, service: string, parentId?: string) => {
    try {
      const cloud = await import('../cloud')
      return cloud.listFolders(service as CloudServiceId, parentId)
    } catch { return [] }
  })

  ipcMain.handle('cloud-set-folder', async (_, service: string, folderId: string, folderName: string, folderPath?: string) => {
    const cloud = await import('../cloud')
    return cloud.setFolder(service as CloudServiceId, folderId, folderName, folderPath)
  })

  ipcMain.handle('cloud-queue-status', async () => {
    const q = await import('../cloud/upload-queue')
    return q.getQueueStatus()
  })

  ipcMain.handle('cloud-queue-retry', async (_, id: string) => {
    if (typeof id !== 'string') return false
    const q = await import('../cloud/upload-queue')
    const ok = q.retryNow(id)
    if (ok) {
      const cloud = await import('../cloud')
      void cloud.flushQueue(ctx.mainWindow)
    }
    return ok
  })

  ipcMain.handle('cloud-queue-remove', async (_, id: string) => {
    if (typeof id !== 'string') return false
    const q = await import('../cloud/upload-queue')
    return q.removeFromQueue(id)
  })

  ipcMain.handle('cloud-queue-flush', async () => {
    const cloud = await import('../cloud')
    void cloud.flushQueue(ctx.mainWindow)
    return true
  })
}
