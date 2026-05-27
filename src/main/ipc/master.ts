/**
 * Mastering IPC — EBU R128 loudness measurement + preset apply for
 * publish-ready audio. Used by the editor's mastering panel.
 */

import { ipcMain } from 'electron'
import type { IpcContext } from './types'

export interface MasterIpcContext extends IpcContext {
  isAllowedMediaPath: (filePath: string) => boolean
}

export function registerMasterIpc(ctx: MasterIpcContext): void {
  ipcMain.handle('master-presets', async () => {
    const { MASTER_PRESETS } = await import('../mastering')
    return MASTER_PRESETS
  })

  ipcMain.handle('master-preview', async (_, inputPath: string, presetId: string, startSec: number, durationSec: number) => {
    if (typeof inputPath !== 'string' || !ctx.isAllowedMediaPath(inputPath)) return { ok: false, error: 'invalid_path' }
    const { buildPreview, getPresetById } = await import('../mastering')
    const preset = getPresetById(presetId)
    if (!preset) return { ok: false, error: 'invalid_preset' }
    try {
      const previewPath = await buildPreview(inputPath, preset, Number(startSec) || 0, Number(durationSec) || 15)
      return { ok: true, previewPath }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('master-measure', async (_, inputPath: string, presetId: string) => {
    if (typeof inputPath !== 'string' || !ctx.isAllowedMediaPath(inputPath)) return { ok: false, error: 'invalid_path' }
    const { measureLoudness, getPresetById } = await import('../mastering')
    const preset = getPresetById(presetId)
    if (!preset) return { ok: false, error: 'invalid_preset' }
    try {
      const measurement = await measureLoudness(inputPath, preset)
      return { ok: true, measurement, targetLufs: preset.targetLufs }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('master-apply', async (event, params) => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'invalid_params' }
    const p = params as {
      inputPath?:   string
      outputPath?:  string
      presetId?:    string
      measurement?: import('../mastering').LoudnessMeasurement
      jobId?:       string
    }
    if (typeof p.inputPath !== 'string' || !ctx.isAllowedMediaPath(p.inputPath)) return { ok: false, error: 'invalid_path' }
    if (typeof p.outputPath !== 'string' || !p.outputPath) return { ok: false, error: 'invalid_output_path' }
    if (typeof p.presetId !== 'string' || !p.presetId)     return { ok: false, error: 'invalid_preset' }
    if (!p.measurement || typeof p.measurement !== 'object') return { ok: false, error: 'invalid_measurement' }
    const { applyMastering, getPresetById } = await import('../mastering')
    const preset = getPresetById(p.presetId)
    if (!preset) return { ok: false, error: 'invalid_preset' }
    const onProgress = (currentSec: number, totalSec: number) => {
      try { event.sender.send('master-progress', { currentSec, totalSec }) } catch {}
    }
    try {
      await applyMastering(p.inputPath, p.outputPath, preset, p.measurement, onProgress, p.jobId)
      return { ok: true, outputPath: p.outputPath }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('master-cancel', async (_, jobId: string) => {
    if (typeof jobId !== 'string') return false
    const { cancelMastering } = await import('../mastering')
    return cancelMastering(jobId)
  })
}
