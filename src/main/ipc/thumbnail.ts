/**
 * Thumbnail IPC — podcast cover art management.
 *
 * Default thumbnail is used for every episode unless overridden by a
 * per-recording sidecar. The thumbnail module owns the actual storage
 * (under userData) + format detection + dataUrl rendering; this file
 * is just the IPC wiring.
 */

import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'fs'
import type { IpcContext } from './types'

export interface ThumbnailIpcContext extends IpcContext {
  /** Path guard shared with the cloud-upload handler. */
  isAllowedMediaPath: (filePath: string) => boolean
}

export function registerThumbnailIpc(ctx: ThumbnailIpcContext): void {
  // Pick an image via the OS file picker. Returns the source path the
  // renderer then hands to thumbnail:set-default / thumbnail:set-episode.
  async function pickThumbnailFile(event: Electron.IpcMainInvokeEvent): Promise<string | null> {
    const win = BrowserWindow.fromWebContents(event.sender) ?? ctx.mainWindow
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters:    [{ name: 'Bilde', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    })
    return r.canceled ? null : r.filePaths[0]
  }

  ipcMain.handle('thumbnail:set-default', async (event, sourcePath?: string) => {
    let chosen = typeof sourcePath === 'string' && sourcePath ? sourcePath : null
    if (!chosen) chosen = await pickThumbnailFile(event)
    if (!chosen) return null
    if (!fs.existsSync(chosen)) return { error: 'file_not_found' }
    const { setDefaultThumbnail, readThumbnailAsDataUrl } = await import('../thumbnail')
    const result = await setDefaultThumbnail(chosen)
    if ('error' in result) return result
    return { ...result, dataUrl: await readThumbnailAsDataUrl(result.path, result.info.format) }
  })

  ipcMain.handle('thumbnail:clear-default', async () => {
    const { clearDefaultThumbnail } = await import('../thumbnail')
    await clearDefaultThumbnail()
    return true
  })

  ipcMain.handle('thumbnail:set-episode', async (event, recordingPath: string, sourcePath?: string) => {
    if (typeof recordingPath !== 'string' || !ctx.isAllowedMediaPath(recordingPath)) return { error: 'invalid_path' }
    let chosen = typeof sourcePath === 'string' && sourcePath ? sourcePath : null
    if (!chosen) chosen = await pickThumbnailFile(event)
    if (!chosen) return null
    if (!fs.existsSync(chosen)) return { error: 'file_not_found' }
    const { setEpisodeThumbnail, readThumbnailAsDataUrl } = await import('../thumbnail')
    const result = await setEpisodeThumbnail(recordingPath, chosen)
    if ('error' in result) return result
    return { ...result, dataUrl: await readThumbnailAsDataUrl(result.path, result.info.format) }
  })

  ipcMain.handle('thumbnail:clear-episode', async (_, recordingPath: string) => {
    if (typeof recordingPath !== 'string' || !ctx.isAllowedMediaPath(recordingPath)) return false
    const { clearEpisodeThumbnail } = await import('../thumbnail')
    await clearEpisodeThumbnail(recordingPath)
    return true
  })

  ipcMain.handle('thumbnail:resolve', async (_, recordingPath: string) => {
    if (typeof recordingPath !== 'string' || !ctx.isAllowedMediaPath(recordingPath)) return null
    const { resolveThumbnail, readThumbnailAsDataUrl } = await import('../thumbnail')
    const r = await resolveThumbnail(recordingPath)
    if (!r) return null
    return { ...r, dataUrl: await readThumbnailAsDataUrl(r.path, r.info.format) }
  })

  ipcMain.handle('thumbnail:get-default-info', async () => {
    const { getDefaultThumbnailInfo, readThumbnailAsDataUrl } = await import('../thumbnail')
    const r = await getDefaultThumbnailInfo()
    if (!r) return null
    return { ...r, dataUrl: await readThumbnailAsDataUrl(r.path, r.info.format) }
  })
}
