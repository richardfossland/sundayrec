import path from 'path'
import fs from 'fs'
import os from 'os'
import { spawn } from 'child_process'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import ffmpeg from 'fluent-ffmpeg'
import { codecFor } from './recorder-utils'
import * as store from './store'
import type { RecordingMetadata } from '../types'

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
  introPath?:   string
  outroPath?:   string
  metadata?:    RecordingMetadata
  onProgress?:  (percent: number) => void
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

// ── Full export with format + processing + intro/outro + metadata ─────────
export async function exportEdited(params: EditorExportParams): Promise<EditorSaveResult> {
  const { inputPath, cutRegions, duration, mode, outputFolder, outputFilename,
          outputFormat, outputBitrate, outputBitDepth, processing,
          introPath, outroPath, metadata } = params

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

  // Validate intro/outro paths
  const hasIntro = !!(introPath && fs.existsSync(introPath))
  const hasOutro = !!(outroPath && fs.existsSync(outroPath))

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

  // Build ffmpeg metadata file for chapters (if any)
  let metaFilePath: string | null = null
  if (metadata?.chapters?.length) {
    metaFilePath = path.join(os.tmpdir(), `sundayrec_meta_${Date.now()}.txt`)
    const lines = [';FFMETADATA1']
    if (metadata.title)   lines.push(`title=${metadata.title}`)
    if (metadata.speaker) lines.push(`artist=${metadata.speaker}`)
    if (metadata.description) lines.push(`comment=${metadata.description}`)

    // Chapters (timebase 1/1000 = milliseconds)
    for (let i = 0; i < metadata.chapters.length; i++) {
      const ch    = metadata.chapters[i]
      const next  = metadata.chapters[i + 1]
      const start = Math.round((ch.time + (hasIntro && introPath ? 0 : 0)) * 1000)
      const end   = next ? Math.round(next.time * 1000) - 1 : Math.round(duration * 1000)
      lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${end}`, `title=${ch.title}`)
    }
    fs.writeFileSync(metaFilePath, lines.join('\n'), 'utf8')
  }

  return new Promise(resolve => {
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | null = null

    const finish = (result: EditorSaveResult) => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      if (metaFilePath) fs.promises.unlink(metaFilePath!).catch(() => {})
      resolve(result)
    }

    const procFilters = processing.ffmpegFilters ?? []

    // ── Simple case: single segment, no processing, no intro/outro ──
    if (keeps.length === 1 && procFilters.length === 0 && !hasIntro && !hasOutro) {
      const seg = keeps[0]
      const mainCmd = ffmpeg(inputPath)
      killTimer = setTimeout(() => {
        try { mainCmd.kill('SIGTERM') } catch {}
        if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
        finish({ ok: false, error: 'timeout' })
      }, MAX_EDIT_MS)
      mainCmd.audioFilters(`atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS`)
      mainCmd.on('progress', p => { params.onProgress?.(Math.min(98, p.percent ?? 0)) })
      applyCodec(mainCmd, fmt, outputBitrate, outputBitDepth)
      if (metaFilePath) mainCmd.input(metaFilePath).addOutputOption('-map_metadata', '1')
      if (metadata?.title)   mainCmd.outputOptions('-metadata', `title=${metadata.title}`)
      if (metadata?.speaker) mainCmd.outputOptions('-metadata', `artist=${metadata.speaker}`)
      mainCmd.output(outPath)
        .on('end', async () => {
          if (mode === 'replace' && tempPath) {
            try { await safeReplaceFile(tempPath, inputPath); finish({ ok: true, outputPath: inputPath }) }
            catch (err) { finish({ ok: false, error: (err as Error).message }) }
          } else { finish({ ok: true, outputPath: outPath }) }
        })
        .on('error', (err: Error) => {
          if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
          finish({ ok: false, error: err.message })
        })
        .run()
      return
    }

    // ── Complex case: multiple segments, processing, or intro/outro ──
    const cmd = ffmpeg()
    killTimer = setTimeout(() => {
      try { cmd.kill('SIGTERM') } catch {}
      if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
      finish({ ok: false, error: 'timeout' })
    }, MAX_EDIT_MS)

    let mainInputIdx = 0
    if (hasIntro) { cmd.input(introPath!); mainInputIdx = 1 }
    cmd.input(inputPath)
    const mainRef = `[${mainInputIdx}:a]`
    if (hasOutro) { cmd.input(outroPath!); }

    // Build main content filter (cuts + processing)
    const filterParts: string[] = []

    if (keeps.length === 1) {
      const seg = keeps[0]
      const chainFilters = [
        `${mainRef}atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS`,
        ...procFilters
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

    // Build concat list: intro + main + outro
    const concatParts: string[] = []
    if (hasIntro) concatParts.push('[0:a]aformat=sample_fmts=fltp[intro_fmt]')
    concatParts.push(...filterParts)
    if (hasOutro) {
      const outroIdx = hasIntro ? 2 : 1
      concatParts.push(`[${outroIdx}:a]aformat=sample_fmts=fltp[outro_fmt]`)
    }

    if (hasIntro || hasOutro) {
      const concatInputs = [
        ...(hasIntro ? ['[intro_fmt]'] : []),
        '[main_out]',
        ...(hasOutro ? ['[outro_fmt]'] : []),
      ].join('')
      const n = (hasIntro ? 1 : 0) + 1 + (hasOutro ? 1 : 0)
      concatParts.push(`${concatInputs}concat=n=${n}:v=0:a=1[final_out]`)
      cmd.complexFilter(concatParts.join(';')).addOutputOption('-map', '[final_out]')
    } else {
      cmd.complexFilter(filterParts.join(';')).addOutputOption('-map', '[main_out]')
    }

    // Metadata tags
    if (metadata?.title)       cmd.outputOptions('-metadata', `title=${metadata.title}`)
    if (metadata?.speaker)     cmd.outputOptions('-metadata', `artist=${metadata.speaker}`)
    if (metadata?.description) cmd.outputOptions('-metadata', `comment=${metadata.description}`)
    if (metaFilePath)          { cmd.input(metaFilePath); cmd.addOutputOption('-map_metadata', String(hasIntro ? 3 : hasOutro ? 2 : 1)) }

    applyCodec(cmd, fmt, outputBitrate, outputBitDepth)
    cmd.on('progress', p => { params.onProgress?.(Math.min(98, p.percent ?? 0)) })

    cmd
      .output(outPath)
      .on('end', async () => {
        if (mode === 'replace' && tempPath) {
          try { await safeReplaceFile(tempPath, inputPath); finish({ ok: true, outputPath: inputPath }) }
          catch (err) { finish({ ok: false, error: (err as Error).message }) }
        } else { finish({ ok: true, outputPath: outPath }) }
      })
      .on('error', (err: Error) => {
        if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
        finish({ ok: false, error: err.message })
      })
      .run()
  })
}

// ── Segment detection ─────────────────────────────────────────────────────

export interface AudioSegment {
  start:    number   // seconds
  end:      number
  duration: number
  label:    string   // suggested chapter name
  type:     'sermon' | 'section'
}

export async function detectSegments(filePath: string): Promise<AudioSegment[]> {
  return new Promise(resolve => {
    let done = false
    const finish = (result: AudioSegment[]) => {
      if (done) return; done = true; resolve(result)
    }

    const args = [
      '-hide_banner',
      '-i', filePath,
      '-af', 'silencedetect=noise=-35dB:duration=2',
      '-f', 'null', '-'
    ]
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
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

      // Build content segments (periods between silences), min 30 s
      const segments: AudioSegment[] = []
      let cursor = 0
      for (const sil of silences) {
        const dur = sil.start - cursor
        if (dur >= 30) segments.push({ start: cursor, end: sil.start, duration: dur, label: '', type: 'section' })
        cursor = sil.end
      }
      const lastDur = totalDur - cursor
      if (lastDur >= 30) segments.push({ start: cursor, end: totalDur, duration: lastDur, label: '', type: 'section' })

      // Longest segment starting after 5 min = likely sermon
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

    setTimeout(() => { try { proc.kill() } catch {} ; finish([]) }, 30000)
  })
}

function applyCodec(cmd: ReturnType<typeof ffmpeg>, fmt: string, bitrate?: number, bitDepth?: 16 | 24): void {
  if (fmt === 'wav') {
    cmd.audioCodec(bitDepth === 24 ? 'pcm_s24le' : 'pcm_s16le')
  } else if (fmt === 'flac') {
    cmd.audioCodec('flac')
  } else if (fmt === 'aac') {
    cmd.audioCodec('aac').audioBitrate(String(bitrate ?? 192) + 'k')
  } else {
    cmd.audioCodec('libmp3lame').audioBitrate(String(bitrate ?? 192) + 'k')
  }
}
