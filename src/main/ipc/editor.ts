/**
 * Editor IPC — audio and video editor handlers, file-pick dialogs,
 * sidecar (.meta / .cuts-draft / .transcript) read/write, and the
 * segment-detect / peaks-extract helpers used by the editor page.
 *
 * The editor reads media files up to 400 MB inline; anything larger is
 * returned as { tooLarge } so the renderer can switch to the
 * ffmpeg-extract path that streams only what it needs for the waveform.
 */

import { ipcMain, dialog, BrowserWindow } from 'electron'
import * as fs from 'fs'
import type { IpcContext } from './types'

// 400 MB — covers a 4-hour service in lossless WAV
const EDITOR_INLINE_LIMIT = 400 * 1024 * 1024

const AUDIO_EXTS = [
  'mp3', 'mp1', 'mp2', 'wav', 'flac', 'aac', 'm4a', 'm4b', 'm4r',
  'ogg', 'oga', 'opus', 'webm', 'aiff', 'aif', 'wma', 'mka',
  'ac3', 'eac3', 'dts', 'amr', '3ga', 'caf', 'ape', 'wv', 'tta',
  'mpc', 'au', 'snd', 'ra', 'ram', 'spx', 'gsm',
]
const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'm4v', 'avi', 'wmv', 'ts', 'mts', 'm2ts', 'flv', '3gp', 'asf', 'f4v']

export interface EditorIpcContext extends IpcContext {
  isAllowedAudioPath: (filePath: string) => boolean
  isAllowedMediaPath: (filePath: string) => boolean
  sidecarPath: (mediaPath: string, suffix: string) => string | null
  trustFolder: (filePath: string) => void
  /** Set the file path that the editor:// protocol handler should serve.
   *  Lives in index.ts because the protocol handler is registered there. */
  setEditorVideoPath: (filePath: string) => void
}

export function registerEditorIpc(ctx: EditorIpcContext): void {
  ipcMain.handle('editor-read-file', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !ctx.isAllowedAudioPath(filePath)) return null
    try {
      const stat = await fs.promises.stat(filePath)
      if (stat.size > EDITOR_INLINE_LIMIT) {
        return { tooLarge: true, size: stat.size }
      }
      return await fs.promises.readFile(filePath)
    } catch { return null }
  })

  ipcMain.handle('editor-save-file', async (_, params) => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'invalid_params' }
    const { saveEdited } = await import('../editor')
    return saveEdited(params)
  })

  ipcMain.handle('editor-pick-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? ctx.mainWindow
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [
        { name: 'Lyd og video', extensions: [...AUDIO_EXTS, ...VIDEO_EXTS] },
        { name: 'Lydfiler', extensions: AUDIO_EXTS },
        { name: 'Videofiler', extensions: VIDEO_EXTS },
      ],
    })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('editor-export-file', async (event, params) => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'invalid_params' }
    const { exportEdited } = await import('../editor')
    const onProgress = (percent: number) => {
      try { event.sender.send('editor-export-progress', { percent }) } catch {}
    }
    return exportEdited({ ...params, onProgress })
  })

  ipcMain.handle('editor-cancel-export', async (_, jobId: string) => {
    if (typeof jobId !== 'string') return false
    const { cancelExport } = await import('../editor')
    return cancelExport(jobId)
  })

  ipcMain.handle('editor-pick-output-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? ctx.mainWindow
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  // ── Metadata sidecar ─────────────────────────────────────────────────────
  ipcMain.handle('editor-read-meta', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !ctx.isAllowedMediaPath(filePath)) return null
    const metaPath = ctx.sidecarPath(filePath, '.meta.json')
    if (!metaPath) return null
    try {
      const raw = await fs.promises.readFile(metaPath, 'utf8')
      return JSON.parse(raw)
    } catch { return null }
  })

  ipcMain.handle('editor-save-meta', async (_, filePath: string, metadata: unknown) => {
    if (typeof filePath !== 'string' || !ctx.isAllowedMediaPath(filePath)) return false
    const metaPath = ctx.sidecarPath(filePath, '.meta.json')
    if (!metaPath) return false
    try {
      await fs.promises.writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf8')
      return true
    } catch { return false }
  })

  // ── Cut autosave (recovery after crash mid-edit) ─────────────────────────
  ipcMain.handle('editor-read-cuts-draft', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !ctx.isAllowedMediaPath(filePath)) return null
    const draftPath = ctx.sidecarPath(filePath, '.cuts-draft.json')
    if (!draftPath) return null
    try {
      const raw = await fs.promises.readFile(draftPath, 'utf8')
      return JSON.parse(raw)
    } catch { return null }
  })

  ipcMain.handle('editor-save-cuts-draft', async (_, filePath: string, cuts: unknown) => {
    if (typeof filePath !== 'string' || !ctx.isAllowedMediaPath(filePath)) return false
    const draftPath = ctx.sidecarPath(filePath, '.cuts-draft.json')
    if (!draftPath) return false
    try {
      await fs.promises.writeFile(draftPath, JSON.stringify({ cuts, ts: Date.now() }), 'utf8')
      return true
    } catch { return false }
  })

  ipcMain.handle('editor-delete-cuts-draft', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !ctx.isAllowedMediaPath(filePath)) return false
    const draftPath = ctx.sidecarPath(filePath, '.cuts-draft.json')
    if (!draftPath) return false
    try { await fs.promises.unlink(draftPath); return true } catch { return false }
  })

  ipcMain.handle('editor-detect-segments', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !ctx.isAllowedMediaPath(filePath)) return []
    const { detectSegments } = await import('../editor')
    return detectSegments(filePath)
  })

  // ── Video editor ─────────────────────────────────────────────────────────
  ipcMain.handle('editor-set-video-path', (_, filePath: string) => {
    if (typeof filePath !== 'string' || !ctx.isAllowedMediaPath(filePath)) return false
    ctx.setEditorVideoPath(filePath)
    return true
  })

  ipcMain.handle('editor-extract-audio-peaks', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !ctx.isAllowedMediaPath(filePath)) return null
    const { extractAudioForPeaks, cancelActivePeakJobs } = await import('../editor')
    // Opening a new file kills peaks-extraction for the previous one so its
    // ffmpeg doesn't keep burning CPU until the 120 s timeout.
    cancelActivePeakJobs(filePath)
    return extractAudioForPeaks(filePath)
  })

  ipcMain.handle('editor-probe-streams', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !ctx.isAllowedMediaPath(filePath)) return null
    const { probeMediaStreams } = await import('../editor')
    return probeMediaStreams(filePath)
  })

  ipcMain.handle('editor-pick-video-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? ctx.mainWindow
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: VIDEO_EXTS }],
    })
    if (r.canceled) return null
    ctx.trustFolder(r.filePaths[0])
    return r.filePaths[0]
  })

  ipcMain.handle('editor-save-video', async (_, params) => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'invalid_params' }
    const { saveVideoEdited } = await import('../editor')
    return saveVideoEdited(params)
  })

  ipcMain.handle('editor-export-video', async (event, params) => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'invalid_params' }
    const { exportVideoEdited } = await import('../editor')
    const onProgress = (percent: number) => {
      try { event.sender.send('editor-export-progress', { percent }) } catch {}
    }
    return exportVideoEdited({ ...params, onProgress })
  })

  // ── Transcript sidecar (per-file .transcript.json) ───────────────────────
  ipcMain.handle('editor-read-transcript', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !ctx.isAllowedMediaPath(filePath)) return null
    const sidecar = ctx.sidecarPath(filePath, '.transcript.json')
    if (!sidecar) return null
    try {
      const raw = await fs.promises.readFile(sidecar, 'utf8')
      return JSON.parse(raw)
    } catch { return null }
  })

  ipcMain.handle('editor-write-transcript', async (_, filePath: string, transcript: unknown) => {
    if (typeof filePath !== 'string' || !ctx.isAllowedMediaPath(filePath)) return false
    const sidecar = ctx.sidecarPath(filePath, '.transcript.json')
    if (!sidecar) return false
    try {
      await fs.promises.writeFile(sidecar, JSON.stringify(transcript, null, 2), 'utf8')
      return true
    } catch { return false }
  })

  ipcMain.handle('editor-delete-transcript', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !ctx.isAllowedMediaPath(filePath)) return false
    const sidecar = ctx.sidecarPath(filePath, '.transcript.json')
    if (!sidecar) return false
    try {
      await fs.promises.unlink(sidecar)
      return true
    } catch { return false }
  })
}
