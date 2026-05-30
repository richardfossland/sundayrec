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
// Static imports: both modules are already in the main bundle (recorder.ts et
// al. import them statically), so the dynamic imports here gave no code-split
// — just a Vite warning. Device/camera work stays behind the functions.
import { listVideoFfmpegDevices } from '../native-recorder'
import { startPreview, stopPreview } from '../video-preview'

export function registerVideoPreviewIpc(ctx: IpcContext): void {
  ipcMain.handle('list-video-devices', async () => {
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
    return startPreview(opts, ctx.mainWindow)
  })

  ipcMain.handle('video-preview-stop', async () => {
    await stopPreview()
  })
}
