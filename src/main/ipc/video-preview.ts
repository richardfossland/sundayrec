/**
 * Video-preview IPC — list cameras + start/stop the MJPEG preview stream
 * that drives the home page video preview and (since v4.48) the
 * Direktesending idle-preview.
 *
 * macOS gates camera access via systemPreferences.askForMediaAccess —
 * the first start triggers the OS-level permission dialog. Subsequent
 * starts skip the prompt because the answer is cached.
 */

import { ipcMain, systemPreferences } from 'electron'
import type { IpcContext } from './types'

export function registerVideoPreviewIpc(ctx: IpcContext): void {
  ipcMain.handle('list-video-devices', async () => {
    const { listVideoFfmpegDevices } = await import('../native-recorder')
    return listVideoFfmpegDevices()
  })

  ipcMain.handle('video-preview-start', async (_, opts: { videoDeviceName?: string | null; videoDeviceIndex?: number | null; videoFramerate?: number }) => {
    // macOS: request camera permission before opening device
    if (process.platform === 'darwin') {
      const granted = await systemPreferences.askForMediaAccess('camera')
      if (!granted) {
        console.warn('[video-preview] Camera permission denied by macOS')
        return false
      }
    }
    if (!ctx.mainWindow) return false
    const preview = await import('../video-preview')
    return preview.startPreview(opts, ctx.mainWindow)
  })

  ipcMain.handle('video-preview-stop', async () => {
    const preview = await import('../video-preview')
    await preview.stopPreview()
  })
}
