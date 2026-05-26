import path from 'path'
import fs from 'fs'
import os from 'os'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { ffmpegBin } from './native-recorder'
import { codecFor } from './recorder-utils'
import * as store from './store'
import { analyzeAudio } from './audio-analysis'
import type { RecordingMetadata } from '../types'

const MAX_EDIT_MS = 10 * 60 * 1000   // kill ffmpeg after 10 minutes

/**
 * Audio formats with no encoder in ffmpeg-static — saving these losslessly
 * means transcoding to WAV. Replace-mode on these formats would silently write
 * WAV bytes to an .ape/.dts/etc. extension, corrupting the file. We refuse
 * replace-mode for these and tell the user to use "save as new".
 */
export const FORCE_WAV_FORMATS = new Set(['ape', 'dts', 'mpc', 'ra', 'ram', 'spx', 'gsm', 'amr', '3ga'])

/** Track active export processes so the UI can cancel them. Keyed by job id. */
const activeExports = new Map<string, ChildProcess>()

export function cancelExport(jobId: string): boolean {
  const proc = activeExports.get(jobId)
  if (!proc) return false
  try { proc.kill('SIGTERM') } catch {}
  activeExports.delete(jobId)
  return true
}

/**
 * Clean up `__editor_tmp` and `__editor_bak` files left behind by a crashed
 * editor save. Called once at app startup. Scans the configured save folder
 * (only — we don't walk arbitrary directories the user might be editing
 * files from).
 */
export async function cleanupEditorTempFiles(saveFolder: string): Promise<number> {
  if (!saveFolder || !fs.existsSync(saveFolder)) return 0
  let removed = 0
  try {
    const entries = await fs.promises.readdir(saveFolder)
    for (const name of entries) {
      if (name.endsWith('.__editor_tmp') || name.endsWith('.__editor_bak')) {
        try {
          await fs.promises.unlink(path.join(saveFolder, name))
          removed++
        } catch {}
      }
    }
  } catch {}
  return removed
}

// ── Stream probe ──────────────────────────────────────────────────────────────

export interface MediaStreamInfo {
  hasVideo: boolean
  hasAudio: boolean
}

export async function probeMediaStreams(filePath: string): Promise<MediaStreamInfo | null> {
  if (!fs.existsSync(filePath)) return null
  return new Promise(resolve => {
    const proc = spawn(ffmpegBin, ['-v', 'info', '-i', filePath], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-8192) })
    const timeout = setTimeout(() => { try { proc.kill() } catch {}; resolve(null) }, 5000)
    proc.on('close', () => {
      clearTimeout(timeout)
      resolve({
        hasVideo: /Stream #\d+:\d+[^:]*: Video:/i.test(stderr),
        hasAudio: /Stream #\d+:\d+[^:]*: Audio:/i.test(stderr),
      })
    })
  })
}

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
  /** Optional client-supplied job id — pass back via cancelExport(jobId) to abort. */
  jobId?:       string
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
      // Cap at 8 KB to prevent unbounded growth during long exports
      stderr = (stderr + d.toString()).slice(-8192)
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
  if (fmt === 'wav')                               return ['-c:a', bitDepth === 24 ? 'pcm_s24le' : 'pcm_s16le']
  if (fmt === 'flac')                              return ['-c:a', 'flac']
  if (['aac', 'm4a', 'm4b', 'm4r', 'caf'].includes(fmt)) return ['-c:a', 'aac', '-b:a', `${bitrate ?? 192}k`]
  if (fmt === 'ogg' || fmt === 'oga')              return ['-c:a', 'libvorbis',  '-b:a', `${bitrate ?? 192}k`]
  if (fmt === 'opus')                              return ['-c:a', 'libopus',    '-b:a', `${bitrate ?? 128}k`]
  if (fmt === 'aiff' || fmt === 'aif')             return ['-c:a', 'pcm_s16be']
  if (fmt === 'au'   || fmt === 'snd')             return ['-c:a', 'pcm_mulaw']
  if (fmt === 'wma')                               return ['-c:a', 'wmav2',      '-b:a', `${bitrate ?? 192}k`]
  if (fmt === 'mp2'  || fmt === 'mp1')             return ['-c:a', 'mp2',        '-b:a', `${bitrate ?? 192}k`]
  if (fmt === 'mka')                               return ['-c:a', 'flac']
  if (fmt === 'ac3')                               return ['-c:a', 'ac3',        '-b:a', `${bitrate ?? 192}k`]
  if (fmt === 'eac3')                              return ['-c:a', 'eac3',       '-b:a', `${bitrate ?? 192}k`]
  if (fmt === 'amr'  || fmt === '3ga')             return ['-c:a', 'amr_nb',    '-ar', '8000', '-ac', '1']
  if (fmt === 'wv')                                return ['-c:a', 'wavpack']
  if (fmt === 'tta')                               return ['-c:a', 'tta']
  // ape/dts/mpc/ra/spx/gsm: no reliable encoder in ffmpeg-static → transcode to wav
  if (['ape', 'dts', 'mpc', 'ra', 'ram', 'spx', 'gsm'].includes(fmt))
                                                   return ['-c:a', 'pcm_s16le']
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
  const AUDIO_SAVE_EXTS = new Set([
    'mp3', 'mp1', 'mp2', 'wav', 'flac', 'aac', 'm4a', 'm4b', 'm4r',
    'ogg', 'oga', 'opus', 'aiff', 'aif', 'wma', 'mka', 'ac3', 'eac3',
    'amr', '3ga', 'caf', 'wv', 'tta', 'au', 'snd',
    'ape', 'dts', 'mpc', 'ra', 'ram', 'spx', 'gsm',
  ])

  // Replace-mode on a FORCE_WAV format would write WAV bytes to a non-WAV
  // extension — many players gracefully fall through, but in the worst case
  // the user's original .ape archive is silently corrupted. Refuse and tell
  // the UI to offer "save as new file" instead.
  if (mode === 'replace' && FORCE_WAV_FORMATS.has(rawExt)) {
    return { ok: false, error: 'force_wav_replace_unsafe' }
  }

  const ext = !AUDIO_SAVE_EXTS.has(rawExt) ? 'mp3' : FORCE_WAV_FORMATS.has(rawExt) ? 'wav' : rawExt

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

  // Defensive: older callers / programmatic batch jobs may omit `processing`
  // entirely. Treat that as "no extra ffmpeg filters" rather than crashing
  // with a TypeError that an IPC client can't recover from.
  const procFilters = processing?.ffmpegFilters ?? []

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
  if (params.jobId) activeExports.set(params.jobId, proc)
  // Timeout scales with file duration: ffmpeg can take ≥ 0.5× realtime for
  // multi-pass processing. For a 4 h recording, 10 min is far too short.
  const dynamicTimeoutMs = Math.max(MAX_EDIT_MS, Math.round(duration * 1000 * 0.6))
  const killTimer = setTimeout(() => {
    try { proc.kill('SIGTERM') } catch {}
    if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
  }, dynamicTimeoutMs)

  try {
    await promise
    clearTimeout(killTimer)
    if (params.jobId) activeExports.delete(params.jobId)
    if (metaFilePath) fs.promises.unlink(metaFilePath).catch(() => {})
    if (mode === 'replace' && tempPath) {
      await safeReplaceFile(tempPath, inputPath)
      return { ok: true, outputPath: inputPath }
    }
    return { ok: true, outputPath: outPath }
  } catch (err) {
    clearTimeout(killTimer)
    if (params.jobId) activeExports.delete(params.jobId)
    if (metaFilePath) fs.promises.unlink(metaFilePath).catch(() => {})
    if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
    const msg = (err as Error).message
    if (msg.includes('timeout')) return { ok: false, error: 'timeout' }
    // SIGTERM cancellations end up here too — the exit-code is non-zero
    if (msg.includes('SIGTERM') || msg.toLowerCase().includes('killed')) return { ok: false, error: 'cancelled' }
    return { ok: false, error: msg }
  }
}

// ── extractAudioForPeaks ──────────────────────────────────────────────────────
// Extracts audio at 8kHz mono to WAV in memory for waveform display in the
// renderer.  Returns the WAV bytes and the authoritative duration parsed from
// ffmpeg's stderr.  Works on both audio and video files.

export interface ExtractAudioResult {
  data:     Buffer
  duration: number
}

export async function extractAudioForPeaks(filePath: string): Promise<ExtractAudioResult | null> {
  if (!fs.existsSync(filePath)) return null

  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let stderr = ''

    const proc = spawn(ffmpegBin, [
      '-nostdin', '-hide_banner',
      '-i',    filePath,
      '-vn',                      // drop video track
      '-ac',   '1',               // mono
      '-ar',   '8000',            // 8 kHz — enough for peaks, tiny in memory
      '-f',    'wav',
      'pipe:1',                   // write WAV to stdout
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    proc.stdout?.on('data', (d: Buffer) => chunks.push(d))
    proc.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-8192) })

    // Safety kill after 2 min. Cleared on close to avoid keeping a timer
    // reference alive for 2 minutes after every successful peaks extraction.
    const killTimer = setTimeout(() => { try { proc.kill('SIGTERM') } catch { /* already dead */ } }, 120_000)

    proc.on('close', code => {
      clearTimeout(killTimer)
      if (code !== 0 || chunks.length === 0) { resolve(null); return }
      const data = Buffer.concat(chunks)

      // Parse duration from ffmpeg stderr  e.g. "Duration: 01:23:45.67,"
      let duration = 0
      const m = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/)
      if (m) {
        duration = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3])
      }

      resolve({ data, duration })
    })
  })
}

// ── Video save / export helpers ───────────────────────────────────────────────

export interface VideoSaveParams {
  inputPath:  string
  cutRegions: CutRegion[]
  duration:   number
  mode:       'new' | 'replace'
  processing: ExportProcessing
  metadata?:  RecordingMetadata
  onProgress?: (percent: number) => void
}

export interface VideoExportParams {
  inputPath:    string
  cutRegions:   CutRegion[]
  duration:     number
  mode:         'new' | 'replace' | 'folder'
  outputFolder?: string
  processing:   ExportProcessing
  introPath?:   string
  outroPath?:   string
  metadata?:    RecordingMetadata
  onProgress?:  (percent: number) => void
}

// Build the keep-segments list from cuts (same logic as audio helpers).
function buildKeeps(cutRegions: CutRegion[], duration: number): { start: number; end: number }[] {
  const sorted = [...cutRegions].sort((a, b) => a.start - b.start)
  const keeps: { start: number; end: number }[] = []
  let cursor = 0
  for (const c of sorted) {
    if (c.start > cursor + 0.05) keeps.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < duration - 0.05) keeps.push({ start: cursor, end: duration })
  return keeps
}

// Output path for video files.  Always .mp4.
function videoOutPath(
  inputPath: string,
  mode: 'new' | 'replace' | 'folder',
  outputFolder?: string,
): { outPath: string; tempPath: string | null } {
  const base = path.basename(inputPath, path.extname(inputPath))
  const dir  = path.dirname(inputPath)

  if (mode === 'replace') {
    const tempPath = inputPath + '.__editor_tmp.mp4'
    return { outPath: tempPath, tempPath }
  }

  const outDir = (mode === 'folder' && outputFolder) ? outputFolder : dir
  let cand = path.join(outDir, `${base}_redigert.mp4`)
  for (let i = 2; fs.existsSync(cand); i++) {
    cand = path.join(outDir, `${base}_redigert_${i}.mp4`)
  }
  return { outPath: cand, tempPath: null }
}

// Core ffmpeg args for cutting + audio-processing a video file.
function buildVideoFilterComplex(
  mainIdx: number,
  keeps: { start: number; end: number }[],
  procFilters: string[],
): { filterComplex: string; vOut: string; aOut: string } {
  const parts: string[] = []

  if (keeps.length === 1) {
    const seg = keeps[0]
    const vTrim = `[${mainIdx}:v]trim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},setpts=PTS-STARTPTS[v_main]`
    const aChain = [
      `[${mainIdx}:a]atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS`,
      ...procFilters,
    ].join(',') + '[a_main]'
    parts.push(vTrim, aChain)
  } else {
    keeps.forEach((seg, i) => {
      parts.push(`[${mainIdx}:v]trim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},setpts=PTS-STARTPTS[vseg${i}]`)
      parts.push(`[${mainIdx}:a]atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS[aseg${i}]`)
    })
    const vIn = keeps.map((_, i) => `[vseg${i}]`).join('')
    const aIn = keeps.map((_, i) => `[aseg${i}]`).join('')
    if (procFilters.length > 0) {
      parts.push(`${vIn}concat=n=${keeps.length}:v=1:a=0[v_main]`)
      parts.push(`${aIn}concat=n=${keeps.length}:v=0:a=1[a_concat]`)
      parts.push(`[a_concat]${procFilters.join(',')}[a_main]`)
    } else {
      parts.push(`${vIn}concat=n=${keeps.length}:v=1:a=0[v_main]`)
      parts.push(`${aIn}concat=n=${keeps.length}:v=0:a=1[a_main]`)
    }
  }

  return { filterComplex: parts.join(';'), vOut: '[v_main]', aOut: '[a_main]' }
}

// Standard MP4 output codec args.
const MP4_CODEC_ARGS = [
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
  '-c:a', 'aac', '-b:a', '192k',
  '-movflags', '+faststart',
]

export async function saveVideoEdited(params: VideoSaveParams): Promise<EditorSaveResult> {
  const { inputPath, cutRegions, duration, mode, processing, metadata } = params

  if (typeof inputPath !== 'string') return { ok: false, error: 'invalid_path' }
  if (!fs.existsSync(inputPath))     return { ok: false, error: 'file_not_found' }
  if (!Array.isArray(cutRegions))    return { ok: false, error: 'invalid_cut_regions' }
  if (typeof duration !== 'number' || duration <= 0) return { ok: false, error: 'invalid_duration' }

  const keeps = buildKeeps(cutRegions, duration)
  if (!keeps.length) return { ok: false, error: 'no_video_remaining' }

  const { outPath, tempPath } = videoOutPath(inputPath, mode)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  // Defensive: handle callers that omit `processing` entirely.
  const procFilters = processing?.ffmpegFilters ?? []
  const { filterComplex, vOut, aOut } = buildVideoFilterComplex(0, keeps, procFilters)

  // Metadata file
  let metaFilePath: string | null = null
  if (metadata?.chapters?.length) {
    metaFilePath = path.join(os.tmpdir(), `sundayrec_vmeta_${Date.now()}.txt`)
    const lines = [';FFMETADATA1']
    if (metadata.title)       lines.push(`title=${metadata.title}`)
    if (metadata.speaker)     lines.push(`artist=${metadata.speaker}`)
    if (metadata.description) lines.push(`comment=${metadata.description}`)
    for (let i = 0; i < metadata.chapters.length; i++) {
      const ch   = metadata.chapters[i]
      const next = metadata.chapters[i + 1]
      const start = Math.round(ch.time * 1000)
      const end   = next ? Math.round(next.time * 1000) - 1 : Math.round(duration * 1000)
      lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${end}`, `title=${ch.title}`)
    }
    fs.writeFileSync(metaFilePath, lines.join('\n'), 'utf8')
  }

  const inputArgs: string[] = ['-i', inputPath]
  if (metaFilePath) inputArgs.push('-i', metaFilePath)
  const metaArgs: string[] = metaFilePath ? ['-map_metadata', '1'] : []

  const args = [
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', vOut, '-map', aOut,
    ...metaArgs,
    ...MP4_CODEC_ARGS,
    '-y', outPath,
  ]

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
    return { ok: false, error: (err as Error).message }
  }
}

export async function exportVideoEdited(params: VideoExportParams): Promise<EditorSaveResult> {
  const { inputPath, cutRegions, duration, mode, outputFolder, processing,
          introPath, outroPath, metadata } = params

  if (typeof inputPath !== 'string') return { ok: false, error: 'invalid_path' }
  if (!fs.existsSync(inputPath))     return { ok: false, error: 'file_not_found' }
  if (!Array.isArray(cutRegions))    return { ok: false, error: 'invalid_cut_regions' }
  if (typeof duration !== 'number' || duration <= 0) return { ok: false, error: 'invalid_duration' }

  const keeps = buildKeeps(cutRegions, duration)
  if (!keeps.length) return { ok: false, error: 'no_video_remaining' }

  const hasIntro = !!(introPath && fs.existsSync(introPath))
  const hasOutro = !!(outroPath && fs.existsSync(outroPath))

  const { outPath, tempPath } = videoOutPath(inputPath, mode, outputFolder)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  // Input index: intro=0 (if present), main=mainIdx, outro=outroIdx (if present)
  const mainIdx   = hasIntro ? 1 : 0
  const outroIdx  = mainIdx + 1

  const inputArgs: string[] = []
  if (hasIntro) inputArgs.push('-i', introPath!)
  inputArgs.push('-i', inputPath)
  if (hasOutro) inputArgs.push('-i', outroPath!)

  // Metadata file
  let metaFilePath: string | null = null
  if (metadata?.chapters?.length) {
    metaFilePath = path.join(os.tmpdir(), `sundayrec_vmeta_${Date.now()}.txt`)
    const lines = [';FFMETADATA1']
    if (metadata.title)       lines.push(`title=${metadata.title}`)
    if (metadata.speaker)     lines.push(`artist=${metadata.speaker}`)
    if (metadata.description) lines.push(`comment=${metadata.description}`)
    for (let i = 0; i < metadata.chapters.length; i++) {
      const ch   = metadata.chapters[i]
      const next = metadata.chapters[i + 1]
      const start = Math.round(ch.time * 1000)
      const end   = next ? Math.round(next.time * 1000) - 1 : Math.round(duration * 1000)
      lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${end}`, `title=${ch.title}`)
    }
    fs.writeFileSync(metaFilePath, lines.join('\n'), 'utf8')
    inputArgs.push('-i', metaFilePath)
  }

  // Defensive: handle callers that omit `processing` entirely.
  const procFilters = processing?.ffmpegFilters ?? []
  const { filterComplex: mainFilter, vOut: vMain, aOut: aMain } =
    buildVideoFilterComplex(mainIdx, keeps, procFilters)

  const allParts: string[] = [mainFilter]
  let finalV: string
  let finalA: string

  if (hasIntro || hasOutro) {
    // Format-align all segments for concat
    const segments: { v: string; a: string }[] = []

    if (hasIntro) {
      allParts.push(`[0:v]setpts=PTS-STARTPTS[v_intro]`)
      allParts.push(`[0:a]aformat=sample_fmts=fltp[a_intro]`)
      segments.push({ v: '[v_intro]', a: '[a_intro]' })
    }
    // main is already trimmed/processed
    allParts.push(`${vMain}setpts=PTS-STARTPTS[v_main2]`)
    allParts.push(`${aMain}aformat=sample_fmts=fltp[a_main2]`)
    segments.push({ v: '[v_main2]', a: '[a_main2]' })

    if (hasOutro) {
      allParts.push(`[${outroIdx}:v]setpts=PTS-STARTPTS[v_outro]`)
      allParts.push(`[${outroIdx}:a]aformat=sample_fmts=fltp[a_outro]`)
      segments.push({ v: '[v_outro]', a: '[a_outro]' })
    }

    const n  = segments.length
    const vI = segments.map(s => s.v).join('')
    const aI = segments.map(s => s.a).join('')
    allParts.push(`${vI}concat=n=${n}:v=1:a=0[v_final]`)
    allParts.push(`${aI}concat=n=${n}:v=0:a=1[a_final]`)
    finalV = '[v_final]'
    finalA = '[a_final]'
  } else {
    finalV = vMain
    finalA = aMain
  }

  const metaArgs: string[] = metaFilePath ? ['-map_metadata', String(inputArgs.length / 2 - 1)] : []

  const args = [
    ...inputArgs,
    '-filter_complex', allParts.join(';'),
    '-map', finalV, '-map', finalA,
    ...metaArgs,
    ...MP4_CODEC_ARGS,
    '-y', outPath,
  ]

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
    return { ok: false, error: (err as Error).message }
  }
}

// ── Segment detection ─────────────────────────────────────────────────────────
//
// Content-aware chapter detection via the audio-analysis module. Classifies
// every 100 ms frame as speech / music / silence / mixed / unknown and groups
// same-type frames into chapters. One speech segment is promoted to
// type='sermon' as the "best guess" of which block is the sermon — the
// renderer highlights it gold + ★ and offers a one-click trim around it.
// Users can override the pick from the UI (the renderer remaps type back).

export interface AudioSegment {
  start:    number
  end:      number
  duration: number
  label:    string
  type:     string
}

/** Pick the most plausible "sermon" segment from analysis output.
 *  Improved heuristic vs. the original 4.31 version:
 *    1. Filter to speech segments ≥ 3 min (anything shorter is announcements,
 *       a reading, or a short prayer — never the sermon).
 *    2. If exactly ONE candidate qualifies → that's the sermon, regardless
 *       of where in the recording it starts. Covers the case where the
 *       recording was started right before the sermon.
 *    3. If multiple candidates → prefer one starting after 5 min mark (the
 *       sermon usually lands mid-service after worship/announcements). If
 *       multiple still tie, pick the longest.
 *    4. Final fallback: longest speech of any length. */
function findSermonSegmentLocal(
  segments: import('./audio-analysis').AnalysisSegment[],
): { startSec: number; endSec: number } | null {
  const speeches = segments.filter(s => s.type === 'speech')
  if (speeches.length === 0) return null

  const MIN_SERMON_SEC = 180  // 3 minutes
  const longCandidates = speeches.filter(s => s.durationSec >= MIN_SERMON_SEC)

  // Case 1: only one long speech block → it's the sermon
  if (longCandidates.length === 1) {
    return { startSec: longCandidates[0].startSec, endSec: longCandidates[0].endSec }
  }

  // Case 2: multiple long candidates — prefer those starting after 5 min
  if (longCandidates.length > 1) {
    const afterFive = longCandidates.filter(s => s.startSec >= 300)
    const pool = afterFive.length > 0 ? afterFive : longCandidates
    const winner = pool.reduce((a, b) => (a.durationSec > b.durationSec ? a : b))
    return { startSec: winner.startSec, endSec: winner.endSec }
  }

  // Case 3: no long candidates — pick longest speech of any length
  const longest = speeches.reduce((a, b) => (a.durationSec > b.durationSec ? a : b))
  return { startSec: longest.startSec, endSec: longest.endSec }
}

export async function detectSegments(filePath: string): Promise<AudioSegment[]> {
  const segments = await analyzeAudio(filePath)
  const sermon   = findSermonSegmentLocal(segments)

  return segments.map(s => {
    const isSermon = sermon != null && s.startSec === sermon.startSec && s.endSec === sermon.endSec && s.type === 'speech'
    return {
      start:    s.startSec,
      end:      s.endSec,
      duration: s.durationSec,
      label:    isSermon ? 'Preken' : s.label,
      type:     isSermon ? 'sermon' : s.type,
    }
  })
}
