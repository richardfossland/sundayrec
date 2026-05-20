import path from 'path'
import fs from 'fs'
import os from 'os'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { ffmpegBin } from './native-recorder'
import { codecFor } from './recorder-utils'
import * as store from './store'
import type { RecordingMetadata } from '../types'

const MAX_EDIT_MS = 10 * 60 * 1000   // kill ffmpeg after 10 minutes

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
  introPath?:   string
  outroPath?:   string
  metadata?:    RecordingMetadata
  onProgress?:  (percent: number) => void
}

// ── ffmpeg spawn helper ───────────────────────────────────────────────────────

interface FfmpegHandle {
  proc:    ChildProcess
  promise: Promise<void>
}

function spawnFfmpeg(
  args: string[],
  durationSec: number,
  onProgress?: (pct: number) => void
): FfmpegHandle {
  const proc = spawn(ffmpegBin, ['-nostdin', '-hide_banner', ...args], {
    stdio: ['ignore', 'ignore', 'pipe']
  })
  const promise = new Promise<void>((resolve, reject) => {
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (onProgress && durationSec > 0) {
        const m = stderr.slice(-300).match(/time=(\d+):(\d+):([\d.]+)/)
        if (m) {
          const t = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3])
          onProgress(Math.min(98, Math.round((t / durationSec) * 100)))
        }
      }
    })
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(stderr.slice(-500)))
    })
  })
  return { proc, promise }
}

function codecArgs(fmt: string, bitrate?: number, bitDepth?: 16 | 24): string[] {
  if (fmt === 'wav')  return ['-c:a', bitDepth === 24 ? 'pcm_s24le' : 'pcm_s16le']
  if (fmt === 'flac') return ['-c:a', 'flac']
  if (fmt === 'aac')  return ['-c:a', 'aac', '-b:a', `${bitrate ?? 192}k`]
  return ['-c:a', 'libmp3lame', '-b:a', `${bitrate ?? 192}k`]
}

// ── saveEdited ────────────────────────────────────────────────────────────────

export async function saveEdited(params: EditorSaveParams): Promise<EditorSaveResult> {
  const { inputPath, cutRegions, duration, mode } = params

  if (typeof inputPath !== 'string') return { ok: false, error: 'invalid_path' }
  if (!fs.existsSync(inputPath))     return { ok: false, error: 'file_not_found' }
  if (!Array.isArray(cutRegions))    return { ok: false, error: 'invalid_cut_regions' }
  if (typeof duration !== 'number' || duration <= 0) return { ok: false, error: 'invalid_duration' }

  const rawExt = path.extname(inputPath).slice(1).toLowerCase()
  const ext    = ['mp3', 'wav', 'flac', 'aac'].includes(rawExt) ? rawExt : 'mp3'

  const sorted = [...cutRegions].sort((a, b) => a.start - b.start)
  const keeps: { start: number; end: number }[] = []
  let cursor = 0
  for (const c of sorted) {
    if (c.start > cursor + 0.05) keeps.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < duration - 0.05) keeps.push({ start: cursor, end: duration })
  if (!keeps.length) return { ok: false, error: 'no_audio_remaining' }

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

  let args: string[]
  if (keeps.length === 1) {
    const seg = keeps[0]
    args = [
      '-i', inputPath,
      '-af', `atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS`,
      ...codecArgs(ext, +(s.bitrate ?? 192)),
      '-y', outPath,
    ]
  } else {
    const parts = keeps.map((seg, i) =>
      `[0:a]atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS[seg${i}]`
    )
    const inputs = keeps.map((_, i) => `[seg${i}]`).join('')
    parts.push(`${inputs}concat=n=${keeps.length}:v=0:a=1[out]`)
    args = [
      '-i', inputPath,
      '-filter_complex', parts.join(';'),
      '-map', '[out]',
      ...codecArgs(ext, +(s.bitrate ?? 192)),
      '-y', outPath,
    ]
  }

  const { proc, promise } = spawnFfmpeg(args, duration)
  const killTimer = setTimeout(() => {
    try { proc.kill('SIGTERM') } catch {}
    if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
  }, MAX_EDIT_MS)

  try {
    await promise
    clearTimeout(killTimer)
    if (mode === 'replace' && tempPath) {
      await safeReplaceFile(tempPath, inputPath)
      return { ok: true, outputPath: inputPath }
    }
    return { ok: true, outputPath: outPath }
  } catch (err) {
    clearTimeout(killTimer)
    if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
    const msg = (err as Error).message
    if (msg.includes('timeout')) return { ok: false, error: 'timeout' }
    return { ok: false, error: msg }
  }
}

// ── exportEdited ──────────────────────────────────────────────────────────────

export async function exportEdited(params: EditorExportParams): Promise<EditorSaveResult> {
  const { inputPath, cutRegions, duration, mode, outputFolder, outputFilename,
          outputFormat, outputBitrate, outputBitDepth, processing,
          introPath, outroPath, metadata } = params

  if (typeof inputPath !== 'string') return { ok: false, error: 'invalid_path' }
  if (!fs.existsSync(inputPath))     return { ok: false, error: 'file_not_found' }
  if (!Array.isArray(cutRegions))    return { ok: false, error: 'invalid_cut_regions' }
  if (typeof duration !== 'number' || duration <= 0) return { ok: false, error: 'invalid_duration' }

  const fmt = (['mp3', 'wav', 'flac', 'aac'] as const).includes(outputFormat as 'mp3') ? outputFormat : 'mp3'

  const sorted = [...cutRegions].sort((a, b) => a.start - b.start)
  const keeps: { start: number; end: number }[] = []
  let cursor = 0
  for (const c of sorted) {
    if (c.start > cursor + 0.05) keeps.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < duration - 0.05) keeps.push({ start: cursor, end: duration })
  if (!keeps.length) return { ok: false, error: 'no_audio_remaining' }

  const hasIntro = !!(introPath && fs.existsSync(introPath))
  const hasOutro = !!(outroPath && fs.existsSync(outroPath))

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

  // ffmpeg metadata file for chapters
  let metaFilePath: string | null = null
  if (metadata?.chapters?.length) {
    metaFilePath = path.join(os.tmpdir(), `sundayrec_meta_${Date.now()}.txt`)
    const lines = [';FFMETADATA1']
    if (metadata.title)       lines.push(`title=${metadata.title}`)
    if (metadata.speaker)     lines.push(`artist=${metadata.speaker}`)
    if (metadata.description) lines.push(`comment=${metadata.description}`)
    for (let i = 0; i < metadata.chapters.length; i++) {
      const ch    = metadata.chapters[i]
      const next  = metadata.chapters[i + 1]
      const start = Math.round(ch.time * 1000)
      const end   = next ? Math.round(next.time * 1000) - 1 : Math.round(duration * 1000)
      lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${end}`, `title=${ch.title}`)
    }
    fs.writeFileSync(metaFilePath, lines.join('\n'), 'utf8')
  }

  const procFilters = processing.ffmpegFilters ?? []

  // Input index tracking
  const mainInputIdx = hasIntro ? 1 : 0
  const outroInputIdx = mainInputIdx + 1
  const metaInputIdx  = outroInputIdx + (hasOutro ? 1 : 0)

  // Build -i flags
  const inputArgs: string[] = []
  if (hasIntro)   inputArgs.push('-i', introPath!)
  inputArgs.push('-i', inputPath)
  if (hasOutro)   inputArgs.push('-i', outroPath!)
  if (metaFilePath) inputArgs.push('-i', metaFilePath)

  // Metadata output options
  const metaArgs: string[] = []
  if (metaFilePath) metaArgs.push('-map_metadata', String(metaInputIdx))
  if (metadata?.title)       metaArgs.push('-metadata', `title=${metadata.title}`)
  if (metadata?.speaker)     metaArgs.push('-metadata', `artist=${metadata.speaker}`)
  if (metadata?.description) metaArgs.push('-metadata', `comment=${metadata.description}`)

  let args: string[]

  if (keeps.length === 1 && procFilters.length === 0 && !hasIntro && !hasOutro) {
    // Simple case: single segment, no processing, no intro/outro
    const seg = keeps[0]
    args = [
      ...inputArgs,
      '-af', `atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS`,
      ...metaArgs,
      ...codecArgs(fmt, outputBitrate, outputBitDepth),
      '-y', outPath,
    ]
  } else {
    // Complex case: multi-segment, processing, or intro/outro
    const mainRef  = `[${mainInputIdx}:a]`
    const filterParts: string[] = []

    if (keeps.length === 1) {
      const seg = keeps[0]
      const chainFilters = [
        `${mainRef}atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS`,
        ...procFilters,
      ]
      filterParts.push(chainFilters.join(',') + '[main_out]')
    } else {
      keeps.forEach((seg, i) => {
        filterParts.push(`${mainRef}atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS[seg${i}]`)
      })
      const segInputs = keeps.map((_, i) => `[seg${i}]`).join('')
      if (procFilters.length > 0) {
        filterParts.push(`${segInputs}concat=n=${keeps.length}:v=0:a=1[concat_out]`)
        filterParts.push(`[concat_out]${procFilters.join(',')}[main_out]`)
      } else {
        filterParts.push(`${segInputs}concat=n=${keeps.length}:v=0:a=1[main_out]`)
      }
    }

    const concatParts: string[] = []
    if (hasIntro) concatParts.push('[0:a]aformat=sample_fmts=fltp[intro_fmt]')
    concatParts.push(...filterParts)
    if (hasOutro) concatParts.push(`[${outroInputIdx}:a]aformat=sample_fmts=fltp[outro_fmt]`)

    let mapArg: string
    if (hasIntro || hasOutro) {
      const concatInputs = [
        ...(hasIntro ? ['[intro_fmt]'] : []),
        '[main_out]',
        ...(hasOutro ? ['[outro_fmt]'] : []),
      ].join('')
      const n = (hasIntro ? 1 : 0) + 1 + (hasOutro ? 1 : 0)
      concatParts.push(`${concatInputs}concat=n=${n}:v=0:a=1[final_out]`)
      mapArg = '[final_out]'
    } else {
      mapArg = '[main_out]'
    }

    args = [
      ...inputArgs,
      '-filter_complex', concatParts.join(';'),
      '-map', mapArg,
      ...metaArgs,
      ...codecArgs(fmt, outputBitrate, outputBitDepth),
      '-y', outPath,
    ]
  }

  const { proc, promise } = spawnFfmpeg(args, duration, params.onProgress)
  const killTimer = setTimeout(() => {
    try { proc.kill('SIGTERM') } catch {}
    if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
  }, MAX_EDIT_MS)

  try {
    await promise
    clearTimeout(killTimer)
    if (metaFilePath) fs.promises.unlink(metaFilePath).catch(() => {})
    if (mode === 'replace' && tempPath) {
      await safeReplaceFile(tempPath, inputPath)
      return { ok: true, outputPath: inputPath }
    }
    return { ok: true, outputPath: outPath }
  } catch (err) {
    clearTimeout(killTimer)
    if (metaFilePath) fs.promises.unlink(metaFilePath).catch(() => {})
    if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
    const msg = (err as Error).message
    if (msg.includes('timeout')) return { ok: false, error: 'timeout' }
    return { ok: false, error: msg }
  }
}

// ── Segment detection ─────────────────────────────────────────────────────────

export interface AudioSegment {
  start:    number
  end:      number
  duration: number
  label:    string
  type:     'sermon' | 'section'
}

export async function detectSegments(filePath: string): Promise<AudioSegment[]> {
  return new Promise(resolve => {
    let done = false
    const finish = (result: AudioSegment[]) => {
      if (done) return; done = true; resolve(result)
    }

    const proc = spawn(ffmpegBin, [
      '-hide_banner', '-i', filePath,
      '-af', 'silencedetect=noise=-35dB:duration=2',
      '-f', 'null', '-'
    ], { stdio: ['ignore', 'ignore', 'pipe'] })

    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', () => {
      const silences: { start: number; end: number }[] = []
      let pendingStart: number | null = null

      for (const line of stderr.split('\n')) {
        const sm = line.match(/silence_start:\s*([\d.]+)/)
        const em = line.match(/silence_end:\s*([\d.]+)/)
        if (sm) pendingStart = parseFloat(sm[1])
        if (em && pendingStart !== null) {
          silences.push({ start: pendingStart, end: parseFloat(em[1]) })
          pendingStart = null
        }
      }

      const durM = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/)
      const totalDur = durM
        ? parseInt(durM[1]) * 3600 + parseInt(durM[2]) * 60 + parseFloat(durM[3])
        : 0
      if (totalDur === 0) { finish([]); return }

      const segments: AudioSegment[] = []
      let cursor = 0
      for (const sil of silences) {
        const dur = sil.start - cursor
        if (dur >= 30) segments.push({ start: cursor, end: sil.start, duration: dur, label: '', type: 'section' })
        cursor = sil.end
      }
      const lastDur = totalDur - cursor
      if (lastDur >= 30) segments.push({ start: cursor, end: totalDur, duration: lastDur, label: '', type: 'section' })

      const candidates = segments.filter(s => s.start >= 300)
      const sermonSeg  = (candidates.length > 0 ? candidates : segments)
        .reduce<AudioSegment | null>((best, s) => (!best || s.duration > best.duration) ? s : best, null)

      let sectionCount = 0
      for (const s of segments) {
        if (s === sermonSeg) {
          s.type  = 'sermon'
          s.label = 'Preken'
        } else {
          s.label = `Del ${++sectionCount}`
        }
      }

      finish(segments)
    })

    setTimeout(() => { try { proc.kill() } catch {}; finish([]) }, 30000)
  })
}
