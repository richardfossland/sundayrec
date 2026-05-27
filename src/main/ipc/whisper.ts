/**
 * Whisper transcription IPC — model download/delete + transcription
 * jobs with cancel + progress events streamed back via the IPC sender.
 */

import { ipcMain } from 'electron'
import type { IpcContext } from './types'

export interface WhisperIpcContext extends IpcContext {
  isAllowedMediaPath: (filePath: string) => boolean
}

export function registerWhisperIpc(ctx: WhisperIpcContext): void {
  // Active model-download tracker — supports cancel from UI.
  // Lives inside the registration closure so each call to registerWhisperIpc
  // creates a fresh map (the previous index.ts had it module-local).
  const modelDownloads = new Map<string, () => void>()

  ipcMain.handle('whisper-status', async () => {
    const { isWhisperAvailable } = await import('../whisper')
    const { MODELS, isModelInstalled } = await import('../whisper-models')
    return {
      binaryAvailable: isWhisperAvailable(),
      models: MODELS.map(m => ({
        id:             m.id,
        label:          m.label,
        description:    m.description,
        sizeBytes:      m.sizeBytes,
        quality:        m.quality,
        realtimeFactor: m.realtimeFactor,
        ...isModelInstalled(m.id),
      })),
    }
  })

  ipcMain.handle('whisper-download-model', async (event, modelId: string) => {
    if (typeof modelId !== 'string') return { ok: false, error: 'invalid_id' }
    const { downloadModel } = await import('../whisper-models')
    if (modelDownloads.has(modelId)) return { ok: false, error: 'already_downloading' }
    try {
      const { promise, abort } = downloadModel(modelId, p => {
        try { event.sender.send('whisper-model-progress', p) } catch {}
      })
      modelDownloads.set(modelId, abort)
      try { await promise } finally { modelDownloads.delete(modelId) }
      return { ok: true }
    } catch (err) {
      modelDownloads.delete(modelId)
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('whisper-cancel-download', async (_, modelId: string) => {
    const abort = modelDownloads.get(modelId)
    if (!abort) return false
    abort()
    return true
  })

  ipcMain.handle('whisper-delete-model', async (_, modelId: string) => {
    const { deleteModel } = await import('../whisper-models')
    return deleteModel(modelId)
  })

  ipcMain.handle('whisper-transcribe', async (event, params: unknown) => {
    if (!params || typeof params !== 'object') return { ok: false, error: 'invalid_params' }
    const p = params as { filePath?: string; modelId?: string; language?: string; translate?: boolean; jobId?: string }
    if (typeof p.filePath !== 'string' || !ctx.isAllowedMediaPath(p.filePath)) return { ok: false, error: 'invalid_path' }
    if (typeof p.modelId !== 'string') return { ok: false, error: 'invalid_model' }
    const jobId = typeof p.jobId === 'string' && p.jobId ? p.jobId : 'whisper-' + Date.now()
    const { transcribeFile } = await import('../whisper')
    return transcribeFile({
      filePath:  p.filePath,
      modelId:   p.modelId,
      language:  typeof p.language === 'string' ? p.language : 'auto',
      translate: !!p.translate,
      jobId,
      onProgress: pct => { try { event.sender.send('whisper-progress', { jobId, percent: pct }) } catch {} },
    })
  })

  ipcMain.handle('whisper-cancel-transcribe', async (_, jobId: string) => {
    const { cancelTranscription } = await import('../whisper')
    return cancelTranscription(jobId)
  })
}
