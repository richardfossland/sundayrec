/**
 * Audio-devices IPC — lists ASIO drivers, ffmpeg/avfoundation/dshow
 * devices, and the WASAPI loopback bridge. diagnose-audio is the
 * combined call settings makes when the user opens the device dropdown
 * — it fans out to all probes so the renderer can render one populated
 * list in one round-trip.
 */

import { ipcMain } from 'electron'
import type { IpcContext } from './types'
// Static import: native-recorder is already in the main bundle (recorder.ts
// et al. import it statically), so the dynamic import here gave no code-split
// — just a Vite warning. Device enumeration stays behind the functions.
import {
  listAsioDrivers,
  listFfmpegDevices,
  listWasapiDevices,
  probeWasapiAvailable,
} from '../native-recorder'

export function registerAudioDevicesIpc(_ctx: IpcContext): void {
  ipcMain.handle('list-asio-drivers', async () => {
    return listAsioDrivers()
  })

  ipcMain.handle('list-ffmpeg-audio-devices', async () => {
    return listFfmpegDevices()
  })

  ipcMain.handle('diagnose-audio', async () => {
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
