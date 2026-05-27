/**
 * Audio-devices IPC — lists ASIO drivers, ffmpeg/avfoundation/dshow
 * devices, and the WASAPI loopback bridge. diagnose-audio is the
 * combined call settings makes when the user opens the device dropdown
 * — it fans out to all probes so the renderer can render one populated
 * list in one round-trip.
 */

import { ipcMain } from 'electron'
import type { IpcContext } from './types'

export function registerAudioDevicesIpc(_ctx: IpcContext): void {
  ipcMain.handle('list-asio-drivers', async () => {
    const { listAsioDrivers } = await import('../native-recorder')
    return listAsioDrivers()
  })

  ipcMain.handle('list-ffmpeg-audio-devices', async () => {
    const { listFfmpegDevices } = await import('../native-recorder')
    return listFfmpegDevices()
  })

  ipcMain.handle('diagnose-audio', async () => {
    const { listFfmpegDevices, listWasapiDevices, probeWasapiAvailable } = await import('../native-recorder')
    const [dshowDevices, wasapiDevices] = await Promise.all([
      listFfmpegDevices().catch(() => []),
      listWasapiDevices().catch(() => []),
    ])
    return {
      dshow: dshowDevices.map(d => d.name),
      wasapi: wasapiDevices.map(d => d.name),
      wasapiAvailable: await probeWasapiAvailable().catch(() => false),
    }
  })
}
