/**
 * Live-streaming IPC — stream-start/stop/status, stream-key management,
 * and the overlay-source helpers (screen list, NDI source discovery,
 * image-overlay file picker).
 */

import { ipcMain, BrowserWindow, dialog, screen, app } from 'electron'
import path from 'path'
import fs from 'fs'
import * as store from '../store'
import type { IpcContext } from './types'

export function registerStreamIpc(ctx: IpcContext): void {
  ipcMain.handle('stream-status', async () => {
    const s = await import('../streamer')
    return s.getStats()
  })

  ipcMain.handle('stream-start', async (_, params: unknown) => {
    if (!params || typeof params !== 'object') return { ok: false, error: 'invalid_params' }
    const p = params as {
      resolution?: string
      framerate?: number
      videoBitrateKbps?: number
      destinations?: Array<{ id: string; name: string; rtmpUrl: string; enabled: boolean }>
      /** When true, also write a higher-bitrate local MP4 alongside the
       *  RTMP push so the user gets a master file for editing/podcast. */
      alsoRecord?: boolean
    }
    if (!Array.isArray(p.destinations) || p.destinations.length === 0) {
      return { ok: false, error: 'Ingen destinasjoner valgt.' }
    }

    const { getStreamKey } = await import('../stream-keys')
    const settings = store.getAll()
    const fullDests = p.destinations.map(d => ({
      id:        d.id,
      name:      d.name,
      rtmpUrl:   d.rtmpUrl,
      streamKey: getStreamKey(d.id) ?? '',
      enabled:   d.enabled,
    }))

    // Build an optional local-record outputPath when alsoRecord is requested.
    // Mirrors recorder.ts naming (saveFolder + buildFilename) so the file
    // looks at home next to regular recordings in Siste opptak.
    let alsoRecord: { outputPath: string } | undefined
    if (p.alsoRecord) {
      const { buildFilename } = await import('../recorder-utils')
      const baseFolder = settings.saveFolder ?? path.join(app.getPath('music'), 'SundayRec')
      try { fs.mkdirSync(baseFolder, { recursive: true }) } catch {}
      // Force MP4 since the streamer's local-record encoder writes H.264/AAC.
      const baseName = buildFilename(settings as import('../../types').RecordingOpts).replace(/\.[^.]+$/, '')
      const filename = `${baseName}_live.mp4`
      alsoRecord = { outputPath: path.join(baseFolder, filename) }
    }

    const { startStream, setStatsListener } = await import('../streamer')
    setStatsListener(stats => {
      try { ctx.mainWindow?.webContents.send('stream-stats', stats) } catch {}
    })
    return startStream({
      audioDeviceName:  settings.deviceName ?? undefined,
      videoDeviceName:  settings.videoDeviceName ?? undefined,
      resolution:       (p.resolution as '480p' | '720p' | '1080p') ?? settings.streamResolution ?? '720p',
      framerate:        (p.framerate as 25 | 30) ?? settings.streamFramerate ?? 30,
      videoBitrateKbps: p.videoBitrateKbps,
      destinations:     fullDests,
      overlays:         settings.streamOverlays ?? [],
      alsoRecord,
    })
  })

  ipcMain.handle('stream-stop', async () => {
    const s = await import('../streamer')
    return s.stopStream()
  })

  ipcMain.handle('stream-preview-path', async () => {
    const s = await import('../streamer')
    return s.getPreviewPath()
  })

  ipcMain.handle('stream-set-key', async (_, destId: string, key: string) => {
    if (typeof destId !== 'string' || !destId) return { ok: false, error: 'invalid_dest_id' }
    if (typeof key !== 'string') return { ok: false, error: 'invalid_key' }
    const { setStreamKey } = await import('../stream-keys')
    return setStreamKey(destId, key)
  })

  ipcMain.handle('stream-delete-key', async (_, destId: string) => {
    if (typeof destId !== 'string' || !destId) return false
    const { deleteStreamKey } = await import('../stream-keys')
    deleteStreamKey(destId)
    return true
  })

  // ── Overlay sources (live streaming) ──────────────────────────────────

  // List available screens for overlay-source picker. Returned shape gives
  // the UI an id ffmpeg understands + a human label with bounds so the
  // user can tell two identical 27" monitors apart.
  ipcMain.handle('overlay-list-screens', async () => {
    try {
      const displays = screen.getAllDisplays()
      const primary  = screen.getPrimaryDisplay().id
      return displays.map((d, idx) => ({
        id:        String(idx),
        label:     `${d.label || `Skjerm ${idx + 1}`} (${d.size.width}×${d.size.height})${d.id === primary ? ' — primær' : ''}`,
        bounds:    { x: d.bounds.x, y: d.bounds.y, w: d.size.width, h: d.size.height },
        isPrimary: d.id === primary,
      }))
    } catch (e) {
      console.warn('[overlay] list-screens failed', e)
      return []
    }
  })

  // Native NDI source discovery via vendored grandiose. Returns the same
  // shape regardless of NDI availability — renderer decides UI based on
  // the `available` flag.
  ipcMain.handle('overlay-list-ndi-sources', async () => {
    const { isNdiAvailable, getNdiLoadError, listNdiSources } = await import('../ndi-receiver')
    if (!isNdiAvailable()) {
      return {
        available: false,
        reason:    `Native NDI er ikke tilgjengelig (${getNdiLoadError() ?? 'ukjent feil'}). Sjekk at appen ble installert riktig — libndi følger med i .dmg/.exe.`,
        sources:   [] as Array<{ name: string; url: string }>,
      }
    }
    try {
      const sources = await listNdiSources(2000)
      return {
        available: true,
        reason:    sources.length > 0
          ? `Fant ${sources.length} NDI-kilde${sources.length === 1 ? '' : 'r'} på nettverket.`
          : 'Ingen NDI-kilder oppdaget. Sjekk at EasyWorship/ProPresenter/OBS sender NDI og at maskinene er på samme nettverk.',
        sources:   sources.map(s => ({ name: s.name, url: s.address })),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        available: true,
        reason:    `Kunne ikke skanne for NDI-kilder: ${msg}`,
        sources:   [] as Array<{ name: string; url: string }>,
      }
    }
  })

  // File picker for image overlay sources — copies the chosen file into
  // userData/overlays so the stored path stays valid after moves/renames
  // of the original (same pattern as the thumbnail importer).
  ipcMain.handle('overlay-pick-image', async () => {
    const win = ctx.mainWindow ?? BrowserWindow.getFocusedWindow()
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      title:       'Velg overlay-bilde',
      properties:  ['openFile'],
      filters:     [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    })
    if (r.canceled || !r.filePaths[0]) return null
    try {
      const srcPath = r.filePaths[0]
      const overlayDir = path.join(app.getPath('userData'), 'overlays')
      fs.mkdirSync(overlayDir, { recursive: true })
      const ext = path.extname(srcPath).toLowerCase() || '.png'
      const destPath = path.join(overlayDir, `overlay-${Date.now()}${ext}`)
      await fs.promises.copyFile(srcPath, destPath)
      return { path: destPath, name: path.basename(srcPath) }
    } catch (e) {
      console.warn('[overlay] pick-image failed', e)
      return null
    }
  })
}
