import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import ffmpeg from 'fluent-ffmpeg'
import { codecFor } from './recorder-utils'
import * as store from './store'

let ffmpegPath = ffmpegStatic as string
if (app.isPackaged) {
  ffmpegPath = ffmpegPath.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
}
ffmpeg.setFfmpegPath(ffmpegPath)

export interface CutRegion { start: number; end: number }

export interface EditorSaveParams {
  inputPath:  string
  cutRegions: CutRegion[]
  duration:   number
  mode:       'new' | 'replace'
}

export interface EditorSaveResult {
  ok:          boolean
  outputPath?: string
  error?:      string
}

export interface ExportProcessing {
  ffmpegFilters: string[]
}

export interface EditorExportParams {
  inputPath:    string
  cutRegions:   CutRegion[]
  duration:     number
  mode:         'new' | 'replace' | 'folder'
  outputFolder?: string
  outputFilename?: string
  outputFormat: 'mp3' | 'wav' | 'flac' | 'aac'
  outputBitrate?: number
  outputBitDepth?: 16 | 24
  processing:   ExportProcessing
}

export async function saveEdited(params: EditorSaveParams): Promise<EditorSaveResult> {
  const { inputPath, cutRegions, duration, mode } = params

  if (typeof inputPath !== 'string') return { ok: false, error: 'invalid_path' }
  if (!fs.existsSync(inputPath))     return { ok: false, error: 'file_not_found' }
  if (!Array.isArray(cutRegions))    return { ok: false, error: 'invalid_cut_regions' }
  if (typeof duration !== 'number' || duration <= 0) return { ok: false, error: 'invalid_duration' }

  const rawExt = path.extname(inputPath).slice(1).toLowerCase()
  const ext    = ['mp3', 'wav', 'flac', 'aac'].includes(rawExt) ? rawExt : 'mp3'

  // Compute keep segments (inverse of cut regions)
  const sorted = [...cutRegions].sort((a, b) => a.start - b.start)
  const keeps: { start: number; end: number }[] = []
  let cursor = 0
  for (const c of sorted) {
    if (c.start > cursor + 0.05) keeps.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < duration - 0.05) keeps.push({ start: cursor, end: duration })

  if (!keeps.length) return { ok: false, error: 'no_audio_remaining' }

  // Output path
  let outPath: string
  let tempPath: string | null = null

  if (mode === 'replace') {
    tempPath = inputPath + '.__editor_tmp'
    outPath  = tempPath
  } else {
    const dir  = path.dirname(inputPath)
    const base = path.basename(inputPath, path.extname(inputPath))
    let cand   = path.join(dir, `${base}_redigert.${ext}`)
    for (let i = 2; fs.existsSync(cand); i++) {
      cand = path.join(dir, `${base}_redigert_${i}.${ext}`)
    }
    outPath = cand
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  const s = store.getAll()

  return new Promise(resolve => {
    let cmd = ffmpeg(inputPath)

    if (keeps.length === 1) {
      const seg = keeps[0]
      cmd = cmd.audioFilters(
        `atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS`
      )
    } else {
      const parts = keeps.map((seg, i) =>
        `[0:a]atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS[seg${i}]`
      )
      const inputs = keeps.map((_, i) => `[seg${i}]`).join('')
      parts.push(`${inputs}concat=n=${keeps.length}:v=0:a=1[out]`)
      cmd = cmd
        .complexFilter(parts.join(';'))
        .addOutputOption('-map', '[out]')
    }

    cmd.audioCodec(codecFor(ext))
    if (ext === 'mp3' || ext === 'aac') {
      cmd.audioBitrate(String(s.bitrate ?? '192') + 'k')
    }

    cmd
      .output(outPath)
      .on('end', async () => {
        if (mode === 'replace' && tempPath) {
          try {
            await fs.promises.unlink(inputPath)
            await fs.promises.rename(tempPath, inputPath)
            resolve({ ok: true, outputPath: inputPath })
          } catch (err) {
            resolve({ ok: false, error: (err as Error).message })
          }
        } else {
          resolve({ ok: true, outputPath: outPath })
        }
      })
      .on('error', (err: Error) => {
        if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
        resolve({ ok: false, error: err.message })
      })
      .run()
  })
}

// ── Full export with format + processing ──────────────────────────────────
export async function exportEdited(params: EditorExportParams): Promise<EditorSaveResult> {
  const { inputPath, cutRegions, duration, mode, outputFolder, outputFilename, outputFormat, outputBitrate, outputBitDepth, processing } = params

  if (typeof inputPath !== 'string') return { ok: false, error: 'invalid_path' }
  if (!fs.existsSync(inputPath))     return { ok: false, error: 'file_not_found' }
  if (!Array.isArray(cutRegions))    return { ok: false, error: 'invalid_cut_regions' }
  if (typeof duration !== 'number' || duration <= 0) return { ok: false, error: 'invalid_duration' }

  const fmt = (['mp3', 'wav', 'flac', 'aac'] as const).includes(outputFormat as 'mp3') ? outputFormat : 'mp3'

  // Build keep segments
  const sorted = [...cutRegions].sort((a, b) => a.start - b.start)
  const keeps: { start: number; end: number }[] = []
  let cursor = 0
  for (const c of sorted) {
    if (c.start > cursor + 0.05) keeps.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < duration - 0.05) keeps.push({ start: cursor, end: duration })
  if (!keeps.length) return { ok: false, error: 'no_audio_remaining' }

  // Compute output path
  let outPath: string
  let tempPath: string | null = null

  if (mode === 'replace') {
    tempPath = inputPath + '.__editor_tmp'
    outPath  = tempPath
  } else if (mode === 'folder' && outputFolder) {
    const base = outputFilename
      ? outputFilename.replace(/\.[^.]+$/, '')
      : path.basename(inputPath, path.extname(inputPath)) + '_redigert'
    let cand = path.join(outputFolder, `${base}.${fmt}`)
    for (let i = 2; fs.existsSync(cand); i++) cand = path.join(outputFolder, `${base}_${i}.${fmt}`)
    outPath = cand
  } else {
    const dir  = path.dirname(inputPath)
    const base = outputFilename
      ? outputFilename.replace(/\.[^.]+$/, '')
      : path.basename(inputPath, path.extname(inputPath)) + '_redigert'
    let cand = path.join(dir, `${base}.${fmt}`)
    for (let i = 2; fs.existsSync(cand); i++) cand = path.join(dir, `${base}_${i}.${fmt}`)
    outPath = cand
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  return new Promise(resolve => {
    let cmd = ffmpeg(inputPath)

    // Build the edit + processing filter chain
    const procFilters = processing.ffmpegFilters ?? []

    if (keeps.length === 1) {
      const seg = keeps[0]
      const trimFilter = `atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS`
      const allFilters = [trimFilter, ...procFilters].join(',')
      cmd = cmd.audioFilters(allFilters)
    } else {
      // Multi-segment: use filter_complex for concat, then apply processing as audioFilters
      const parts = keeps.map((seg, i) =>
        `[0:a]atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS[seg${i}]`
      )
      const inputs = keeps.map((_, i) => `[seg${i}]`).join('')
      parts.push(`${inputs}concat=n=${keeps.length}:v=0:a=1[out]`)
      cmd = cmd.complexFilter(parts.join(';')).addOutputOption('-map', '[out]')
      if (procFilters.length > 0) {
        cmd = cmd.audioFilters(procFilters.join(','))
      }
    }

    // Codec + quality
    if (fmt === 'wav') {
      cmd.audioCodec(outputBitDepth === 24 ? 'pcm_s24le' : 'pcm_s16le')
    } else if (fmt === 'flac') {
      cmd.audioCodec('flac')
    } else if (fmt === 'aac') {
      cmd.audioCodec('aac')
      cmd.audioBitrate(String(outputBitrate ?? 192) + 'k')
    } else {
      cmd.audioCodec('libmp3lame')
      cmd.audioBitrate(String(outputBitrate ?? 192) + 'k')
    }

    cmd
      .output(outPath)
      .on('end', async () => {
        if (mode === 'replace' && tempPath) {
          try {
            await fs.promises.unlink(inputPath)
            await fs.promises.rename(tempPath, inputPath)
            resolve({ ok: true, outputPath: inputPath })
          } catch (err) {
            resolve({ ok: false, error: (err as Error).message })
          }
        } else {
          resolve({ ok: true, outputPath: outPath })
        }
      })
      .on('error', (err: Error) => {
        if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
        resolve({ ok: false, error: err.message })
      })
      .run()
  })
}
