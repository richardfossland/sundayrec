import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import ffmpeg from 'fluent-ffmpeg'
import { codecFor } from './recorder-utils'
import * as store from './store'

const MAX_EDIT_MS = 10 * 60 * 1000   // kill ffmpeg after 10 minutes

let ffmpegPath = ffmpegStatic as string
if (app.isPackaged) {
  const normalized = ffmpegPath.replace(/\\/g, '/')
  const asarIdx = normalized.indexOf('app.asar/')
  if (asarIdx !== -1) {
    ffmpegPath = path.join(
      normalized.slice(0, asarIdx).replace(/\//g, path.sep),
      'app.asar.unpacked',
      normalized.slice(asarIdx + 'app.asar/'.length).replace(/\//g, path.sep)
    )
  } else {
    ffmpegPath = ffmpegPath.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
  }
  if (!fs.existsSync(ffmpegPath)) {
    console.error('[ffmpeg] Unpacked binary not found at', ffmpegPath, '— falling back to system PATH')
    ffmpegPath = 'ffmpeg'
  }
}
ffmpeg.setFfmpegPath(ffmpegPath)

// Atomically replace targetPath with tempPath, keeping the original safe until swap completes.
// On POSIX: rename() replaces the target atomically (no gap where file is missing).
// On Windows: rename() fails if target exists; use a backup to minimise the exposure window.
async function safeReplaceFile(tempPath: string, targetPath: string): Promise<void> {
  if (process.platform !== 'win32') {
    await fs.promises.rename(tempPath, targetPath)
    return
  }
  const bakPath = targetPath + '.__editor_bak'
  await fs.promises.rename(targetPath, bakPath)
  try {
    await fs.promises.rename(tempPath, targetPath)
  } catch (err) {
    // Restore original if rename failed
    await fs.promises.rename(bakPath, targetPath).catch(() => {})
    throw err
  }
  fs.promises.unlink(bakPath).catch(() => {})
}

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
    let settled = false
    const finish = (result: EditorSaveResult) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      resolve(result)
    }

    const cmd = ffmpeg(inputPath)

    // Guard against hung ffmpeg — kill after 10 minutes
    const killTimer = setTimeout(() => {
      try { cmd.kill('SIGTERM') } catch {}
      if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
      finish({ ok: false, error: 'timeout' })
    }, MAX_EDIT_MS)

    if (keeps.length === 1) {
      const seg = keeps[0]
      cmd.audioFilters(
        `atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS`
      )
    } else {
      const parts = keeps.map((seg, i) =>
        `[0:a]atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS[seg${i}]`
      )
      const inputs = keeps.map((_, i) => `[seg${i}]`).join('')
      parts.push(`${inputs}concat=n=${keeps.length}:v=0:a=1[out]`)
      cmd.complexFilter(parts.join(';')).addOutputOption('-map', '[out]')
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
            await safeReplaceFile(tempPath, inputPath)
            finish({ ok: true, outputPath: inputPath })
          } catch (err) {
            finish({ ok: false, error: (err as Error).message })
          }
        } else {
          finish({ ok: true, outputPath: outPath })
        }
      })
      .on('error', (err: Error) => {
        if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
        finish({ ok: false, error: err.message })
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
    let settled = false
    const finish = (result: EditorSaveResult) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      resolve(result)
    }

    const cmd = ffmpeg(inputPath)

    const killTimer = setTimeout(() => {
      try { cmd.kill('SIGTERM') } catch {}
      if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
      finish({ ok: false, error: 'timeout' })
    }, MAX_EDIT_MS)

    // Build the edit + processing filter chain
    const procFilters = processing.ffmpegFilters ?? []

    if (keeps.length === 1) {
      const seg = keeps[0]
      const trimFilter = `atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS`
      const allFilters = [trimFilter, ...procFilters].join(',')
      cmd.audioFilters(allFilters)
    } else {
      const parts = keeps.map((seg, i) =>
        `[0:a]atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS[seg${i}]`
      )
      const inputs = keeps.map((_, i) => `[seg${i}]`).join('')
      parts.push(`${inputs}concat=n=${keeps.length}:v=0:a=1[out]`)
      cmd.complexFilter(parts.join(';')).addOutputOption('-map', '[out]')
      if (procFilters.length > 0) cmd.audioFilters(procFilters.join(','))
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
            await safeReplaceFile(tempPath, inputPath)
            finish({ ok: true, outputPath: inputPath })
          } catch (err) {
            finish({ ok: false, error: (err as Error).message })
          }
        } else {
          finish({ ok: true, outputPath: outPath })
        }
      })
      .on('error', (err: Error) => {
        if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
        finish({ ok: false, error: err.message })
      })
      .run()
  })
}
