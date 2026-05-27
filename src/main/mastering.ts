/**
 * mastering — professional speech mastering for sermons and podcasts.
 *
 * Two-pass EBU R128 loudness normalization plus a per-preset ffmpeg filter
 * chain (HPF / EQ / compression). Designed for publishing to streaming
 * platforms (Apple Podcasts -16 LUFS, Spotify -14 to -16 LUFS) and broadcast.
 *
 * Pipeline (per preset):
 *   pass 1: highpass + EQ + compressor + loudnorm(target,print_format=json) → /dev/null
 *           parse measured I / LRA / TP / threshold from stderr JSON block
 *   pass 2: highpass + EQ + compressor + loudnorm(target, measured_*, linear=true)
 *           → encoded output file (mp3/wav/flac/aac per user settings)
 *
 * Preview is single-pass (target loudnorm only) — for listening, not publishing.
 */

import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import { ffmpegBin } from './native-recorder'
import * as store from './store'

// ── Presets ────────────────────────────────────────────────────────────────

export interface MasterPreset {
  id:          string
  label:       string                // Norwegian — user-facing
  description: string                // Norwegian — short explanation
  targetLufs:  number                // integrated LUFS target
  targetLra:   number                // loudness range
  truePeakDb:  number                // max true peak in dBTP
  filters:     string                // ffmpeg filter chain WITHOUT loudnorm
}

export const MASTER_PRESETS: MasterPreset[] = [
  {
    id: 'speech-natural',
    label: 'Tale — naturlig',
    description: 'Lett polering. Bra for opptak som allerede er gode.',
    targetLufs: -19, targetLra: 7, truePeakDb: -1,
    filters: 'highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=5:release=50:makeup=2',
  },
  {
    id: 'speech-clear',
    label: 'Tale — tydelig (anbefalt)',
    description: 'Standard mastering for taler og prekener. Tydeligere stemme, jevnere lyd.',
    targetLufs: -16, targetLra: 8, truePeakDb: -1,
    filters: 'highpass=f=80,equalizer=f=200:t=q:w=2:g=-1.5,equalizer=f=3000:t=q:w=1:g=2,equalizer=f=7000:t=q:w=1.5:g=-2,acompressor=threshold=-20dB:ratio=3:attack=5:release=80:makeup=2',
  },
  {
    id: 'speech-punchy',
    label: 'Tale — kraftig',
    description: 'For svake stemmer eller støyete opptak. Sterkere prosessering.',
    targetLufs: -14, targetLra: 6, truePeakDb: -1,
    filters: 'highpass=f=100,equalizer=f=200:t=q:w=2:g=-2,equalizer=f=2500:t=q:w=1:g=3,equalizer=f=7000:t=q:w=1.5:g=-3,acompressor=threshold=-24dB:ratio=4:attack=3:release=50:makeup=3,acompressor=threshold=-12dB:ratio=2:attack=50:release=300:makeup=1',
  },
  {
    id: 'music-speech',
    label: 'Musikk + tale',
    description: 'For gudstjenester med salmer eller annen musikk. Bevarer dynamikk.',
    targetLufs: -16, targetLra: 11, truePeakDb: -1,
    filters: 'highpass=f=50,acompressor=threshold=-22dB:ratio=2:attack=10:release=100:makeup=1',
  },
]

// ── Types ──────────────────────────────────────────────────────────────────

export interface LoudnessMeasurement {
  inputI:      number   // measured integrated LUFS
  inputLra:    number   // measured LRA
  inputTp:     number   // measured true peak (dBTP)
  inputThresh: number   // measurement threshold
  targetOffset:number   // suggested gain offset
}

// ── Internal: job tracking ─────────────────────────────────────────────────

const activeJobs = new Map<string, ChildProcess>()

export function cancelMastering(jobId: string): boolean {
  const proc = activeJobs.get(jobId)
  if (!proc) return false
  try { proc.kill('SIGTERM') } catch {}
  activeJobs.delete(jobId)
  return true
}

// ── Internal: preset lookup + validation ───────────────────────────────────

export function getPresetById(presetId: string): MasterPreset | null {
  return MASTER_PRESETS.find(p => p.id === presetId) ?? null
}

function assertReadable(inputPath: string): void {
  if (typeof inputPath !== 'string' || !inputPath) throw new Error('invalid_path')
  if (!fs.existsSync(inputPath))                   throw new Error('file_not_found')
  try { fs.accessSync(inputPath, fs.constants.R_OK) } catch { throw new Error('file_not_readable') }
}

// ── JSON parsing of loudnorm pass-1 output ─────────────────────────────────

/**
 * Extract the loudnorm JSON block that ffmpeg prints to stderr at the end of
 * a pass-1 run. The block is a standalone JSON object; we locate it by the
 * required keys "input_i" and "input_tp" (loudnorm is the only ffmpeg filter
 * that prints both).
 *
 * Real ffmpeg output looks like:
 *   ...
 *   [Parsed_loudnorm_0 @ 0x600003a8c000]
 *   {
 *           "input_i" : "-23.45",
 *           "input_tp" : "-3.12",
 *           "input_lra" : "9.40",
 *           "input_thresh" : "-33.51",
 *           "output_i" : "-16.00",
 *           ...
 *           "target_offset" : "7.45"
 *   }
 *
 * Numeric fields arrive as strings — parseFloat them. Returns null when the
 * block is missing or unparseable (so the caller can fall back to a single-
 * pass run with the target value alone, instead of throwing).
 */
export function parseLoudnormJson(stderr: string): LoudnessMeasurement | null {
  if (!stderr) return null

  // Find the {} block containing "input_i". Use a non-greedy match starting
  // from a "{" through the next "}" — loudnorm's block is single-level (no
  // nested braces), so this is safe.
  const blocks: string[] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < stderr.length; i++) {
    const c = stderr[i]
    if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        blocks.push(stderr.slice(start, i + 1))
        start = -1
      }
    }
  }

  for (const block of blocks.reverse()) {            // try last block first
    if (!block.includes('input_i') || !block.includes('input_tp')) continue
    try {
      const obj = JSON.parse(block) as Record<string, string>
      const inputI      = parseFloat(obj.input_i)
      const inputLra    = parseFloat(obj.input_lra)
      const inputTp     = parseFloat(obj.input_tp)
      const inputThresh = parseFloat(obj.input_thresh)
      const targetOffset = parseFloat(obj.target_offset ?? obj.normalization_type ?? '0')
      if (Number.isFinite(inputI) && Number.isFinite(inputTp)) {
        return {
          inputI,
          inputLra: Number.isFinite(inputLra) ? inputLra : 0,
          inputTp,
          inputThresh: Number.isFinite(inputThresh) ? inputThresh : -70,
          targetOffset: Number.isFinite(targetOffset) ? targetOffset : 0,
        }
      }
    } catch { /* try next block */ }
  }
  return null
}

// ── Filter chain construction ──────────────────────────────────────────────

/**
 * Build the pass-1 (measurement) filter string. Adds a loudnorm with
 * print_format=json to the preset's chain.
 */
export function buildMeasurePassFilters(preset: MasterPreset): string {
  return `${preset.filters},loudnorm=I=${preset.targetLufs}:LRA=${preset.targetLra}:TP=${preset.truePeakDb}:print_format=json`
}

/**
 * Build the pass-2 (apply) filter string using measured values from pass 1
 * so loudnorm runs in linear mode (no further analysis) and produces a clean,
 * deterministic output matching the target precisely.
 */
export function buildApplyPassFilters(preset: MasterPreset, m: LoudnessMeasurement): string {
  const loudnorm =
    `loudnorm=I=${preset.targetLufs}` +
    `:LRA=${preset.targetLra}` +
    `:TP=${preset.truePeakDb}` +
    `:measured_I=${m.inputI.toFixed(2)}` +
    `:measured_LRA=${m.inputLra.toFixed(2)}` +
    `:measured_TP=${m.inputTp.toFixed(2)}` +
    `:measured_thresh=${m.inputThresh.toFixed(2)}` +
    `:offset=${m.targetOffset.toFixed(2)}` +
    `:linear=true:print_format=summary`
  return `${preset.filters},${loudnorm}`
}

/** Single-pass loudnorm — preview only, lower CPU. */
export function buildPreviewPassFilters(preset: MasterPreset): string {
  return `${preset.filters},loudnorm=I=${preset.targetLufs}:LRA=${preset.targetLra}:TP=${preset.truePeakDb}`
}

// ── Output codec args (mirrors editor.codecArgs but with a sensible default) ─

function masterCodecArgs(ext: string, bitrate?: number, bitDepth?: 16 | 24): string[] {
  if (ext === 'wav')                                     return ['-c:a', bitDepth === 24 ? 'pcm_s24le' : 'pcm_s16le']
  if (ext === 'flac')                                    return ['-c:a', 'flac']
  if (['aac', 'm4a', 'm4b', 'm4r', 'caf'].includes(ext)) return ['-c:a', 'aac',       '-b:a', `${bitrate ?? 192}k`]
  if (ext === 'ogg' || ext === 'oga')                    return ['-c:a', 'libvorbis', '-b:a', `${bitrate ?? 192}k`]
  if (ext === 'opus')                                    return ['-c:a', 'libopus',   '-b:a', `${bitrate ?? 128}k`]
  return ['-c:a', 'libmp3lame', '-b:a', `${bitrate ?? 192}k`]
}

// ── Pass 1: measure ────────────────────────────────────────────────────────

const MEASURE_TIMEOUT_MS = 30 * 60 * 1000   // 30 min absolute cap — long sermons

export async function measureLoudness(inputPath: string, preset: MasterPreset): Promise<LoudnessMeasurement> {
  assertReadable(inputPath)
  if (!getPresetById(preset.id)) throw new Error('invalid_preset')

  const filters = buildMeasurePassFilters(preset)
  const args = [
    '-nostdin', '-hide_banner',
    '-i', inputPath,
    '-af', filters,
    '-f', 'null', '-',
  ]

  return new Promise<LoudnessMeasurement>((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const killTimer = setTimeout(() => { try { proc.kill('SIGTERM') } catch {} }, MEASURE_TIMEOUT_MS)

    proc.stderr?.on('data', (d: Buffer) => {
      // Keep up to 64 KB — loudnorm's JSON block is ~500 bytes but ffmpeg
      // emits a lot of preamble before it. Cap to avoid unbounded growth.
      stderr = (stderr + d.toString()).slice(-65536)
    })
    proc.on('error', err => { clearTimeout(killTimer); reject(err) })
    proc.on('close', code => {
      clearTimeout(killTimer)
      if (code !== 0) {
        reject(new Error(`measure_failed: ${stderr.slice(-500)}`))
        return
      }
      const m = parseLoudnormJson(stderr)
      if (!m) { reject(new Error('measure_parse_failed')); return }
      resolve(m)
    })
  })
}

// ── Pass 2: apply ──────────────────────────────────────────────────────────

const APPLY_TIMEOUT_MS = 60 * 60 * 1000     // 1 h absolute cap

function parseProgressTime(line: string): number | null {
  // From `-progress pipe:1`: lines look like `out_time_ms=12345678` or
  // `out_time=00:00:12.345678`. Either works.
  const ms = line.match(/^out_time_ms=(\d+)/m)
  if (ms) return parseInt(ms[1], 10) / 1_000_000
  const t = line.match(/^out_time=(\d+):(\d+):([\d.]+)/m)
  if (t) return parseInt(t[1]) * 3600 + parseInt(t[2]) * 60 + parseFloat(t[3])
  return null
}

export async function applyMastering(
  inputPath:    string,
  outputPath:   string,
  preset:       MasterPreset,
  measurement:  LoudnessMeasurement,
  onProgress?:  (currentSec: number, totalSec: number) => void,
  jobId?:       string,
): Promise<void> {
  assertReadable(inputPath)
  if (!getPresetById(preset.id)) throw new Error('invalid_preset')
  if (typeof outputPath !== 'string' || !outputPath) throw new Error('invalid_output_path')

  // Make sure the output directory exists. Don't proactively delete an
  // existing file at outputPath — ffmpeg -y handles overwrite.
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  const ext = path.extname(outputPath).slice(1).toLowerCase() || 'mp3'

  // Honour the user's saved bitrate (settings.bitrate) if numeric, otherwise default.
  const s = store.getAll() as unknown as Record<string, unknown>
  const userBitrate = typeof s.bitrate === 'string' || typeof s.bitrate === 'number'
    ? parseInt(String(s.bitrate), 10) : NaN
  const bitrate = Number.isFinite(userBitrate) && userBitrate > 0 ? userBitrate : 192

  const filters = buildApplyPassFilters(preset, measurement)

  const args = [
    '-nostdin', '-hide_banner',
    '-i', inputPath,
    '-af', filters,
    ...masterCodecArgs(ext, bitrate),
    '-progress', 'pipe:1',           // structured progress to stdout
    '-y', outputPath,
  ]

  // Resolve total duration from a quick ffmpeg stderr probe (we already
  // do this implicitly: ffmpeg prints "Duration:" early in stderr). Cheaper
  // than a separate ffprobe call.

  return new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    if (jobId) activeJobs.set(jobId, proc)

    let stderr  = ''
    let stdoutBuf = ''
    let totalSec = 0
    let cancelled = false

    const killTimer = setTimeout(() => {
      try { proc.kill('SIGTERM') } catch {}
    }, APPLY_TIMEOUT_MS)

    proc.stderr?.on('data', (d: Buffer) => {
      const chunk = d.toString()
      stderr = (stderr + chunk).slice(-16384)
      // First Duration line — capture once
      if (totalSec === 0) {
        const m = chunk.match(/Duration:\s*(\d+):(\d+):([\d.]+)/)
        if (m) totalSec = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3])
      }
    })

    proc.stdout?.on('data', (d: Buffer) => {
      stdoutBuf = (stdoutBuf + d.toString()).slice(-4096)
      const cur = parseProgressTime(stdoutBuf)
      if (cur != null && onProgress) onProgress(cur, totalSec)
    })

    proc.on('error', err => {
      clearTimeout(killTimer)
      if (jobId) activeJobs.delete(jobId)
      reject(err)
    })

    proc.on('close', code => {
      clearTimeout(killTimer)
      if (jobId) activeJobs.delete(jobId)
      if (cancelled || code === null) {
        reject(new Error('cancelled'))
        return
      }
      if (code === 0) {
        // Final progress nudge so UI hits 100% even if last out_time line
        // arrived before the close event.
        if (onProgress && totalSec > 0) onProgress(totalSec, totalSec)
        // Best-effort cover-art embed + sidecar. Never fails the export.
        embedAndSidecarThumbnail(inputPath, outputPath).catch(err =>
          console.warn('[mastering] thumbnail embed failed:', (err as Error).message)
        ).finally(() => resolve())
      } else {
        const tail = stderr.slice(-500)
        if (/sigterm|killed|terminat/i.test(tail)) reject(new Error('cancelled'))
        else reject(new Error(`apply_failed: ${tail}`))
      }
    })

    // If the caller cancels via cancelMastering, the SIGTERM-induced close
    // arrives with code !== 0 — the regex above maps that to 'cancelled'.
    proc.once('exit', (_code, signal) => { if (signal === 'SIGTERM') cancelled = true })
  })
}

// ── Thumbnail embed + sidecar (post-mastering) ─────────────────────────────

const EMBED_TIMEOUT_MS = 60_000

/**
 * After mastering produces `outputPath`, look up a thumbnail for the source
 * recording. If one exists:
 *   1. Always copy it next to the output as `<base>.{jpg|png|webp}` — RSS-feed
 *      hosts need the image as a separate URL even when it's also embedded.
 *   2. For MP3 outputs, run an in-place ffmpeg pass that embeds the image as
 *      ID3v2 attached_pic. WAV / FLAC / AAC are skipped (poor player support).
 *
 * Failures are logged and swallowed — the user's export already succeeded;
 * we don't want a cover-art problem to surface as "mastering failed".
 */
export async function embedAndSidecarThumbnail(recordingPath: string, outputPath: string): Promise<void> {
  const { resolveThumbnail } = await import('./thumbnail')
  const thumb = await resolveThumbnail(recordingPath)
  if (!thumb) return  // nothing configured — silently skip

  const outExt = path.extname(outputPath).slice(1).toLowerCase()
  const sourceExt = thumb.path.split('.').pop()?.toLowerCase() ?? 'jpg'

  // Sidecar copy — runs even when embed is skipped (WAV/FLAC/AAC) so RSS
  // hosts can grab the image from the output folder.
  try {
    const outBase = outputPath.replace(/\.[^.]+$/, '')
    const sidecarOut = `${outBase}.${sourceExt}`
    if (path.resolve(thumb.path) !== path.resolve(sidecarOut)) {
      await fs.promises.copyFile(thumb.path, sidecarOut)
    }
  } catch (err) {
    console.warn('[mastering] thumbnail sidecar copy failed:', (err as Error).message)
  }

  if (outExt !== 'mp3') {
    console.log(`[mastering] thumbnail embed skipped for .${outExt} (only MP3 is widely supported)`)
    return
  }

  // Embed pass — copy streams, attach image as second stream, mark as cover.
  // Write to a sibling temp file then atomically replace the output.
  const tmpPath = outputPath + '.embed.tmp.mp3'
  const args = [
    '-nostdin', '-hide_banner',
    '-i', outputPath,
    '-i', thumb.path,
    '-map', '0:a',
    '-map', '1:v',
    '-c:a', 'copy',
    '-c:v', 'copy',
    '-id3v2_version', '3',
    '-metadata:s:v', 'title=Album cover',
    '-metadata:s:v', 'comment=Cover (front)',
    '-disposition:v:1', 'attached_pic',
    '-y', tmpPath,
  ]

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const killTimer = setTimeout(() => { try { proc.kill('SIGTERM') } catch {} }, EMBED_TIMEOUT_MS)
    proc.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2048) })
    proc.on('error', err => { clearTimeout(killTimer); reject(err) })
    proc.on('close', code => {
      clearTimeout(killTimer)
      if (code === 0) resolve()
      else reject(new Error(`embed_failed: ${stderr.slice(-300)}`))
    })
  }).then(async () => {
    // Replace the original with the embedded copy. On Windows, rename across
    // the same file can race — unlink-then-rename is the portable pattern.
    try {
      await fs.promises.unlink(outputPath)
    } catch { /* may not exist yet on weird filesystems */ }
    await fs.promises.rename(tmpPath, outputPath)
  }).catch(async err => {
    // Clean up temp file on failure
    try { await fs.promises.unlink(tmpPath) } catch {}
    throw err
  })
}

// ── Preview (single-pass, short snippet) ───────────────────────────────────

const PREVIEW_TIMEOUT_MS = 60_000

export async function buildPreview(
  inputPath:   string,
  preset:      MasterPreset,
  startSec:    number,
  durationSec: number,
): Promise<string> {
  assertReadable(inputPath)
  if (!getPresetById(preset.id)) throw new Error('invalid_preset')
  const start = Math.max(0, Number.isFinite(startSec) ? startSec : 0)
  const dur   = Math.max(1, Math.min(60, Number.isFinite(durationSec) ? durationSec : 15))

  const id = crypto.randomBytes(8).toString('hex')
  const outPath = path.join(os.tmpdir(), `sundayrec-master-preview-${id}.mp3`)

  const filters = buildPreviewPassFilters(preset)

  // -ss BEFORE -i: accurate seek using container index. -t to limit duration.
  const args = [
    '-nostdin', '-hide_banner',
    '-ss', start.toFixed(3),
    '-t',  dur.toFixed(3),
    '-i',  inputPath,
    '-af', filters,
    '-c:a', 'libmp3lame', '-b:a', '192k',
    '-y',  outPath,
  ]

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const killTimer = setTimeout(() => { try { proc.kill('SIGTERM') } catch {} }, PREVIEW_TIMEOUT_MS)
    proc.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-8192) })
    proc.on('error', err => { clearTimeout(killTimer); reject(err) })
    proc.on('close', code => {
      clearTimeout(killTimer)
      if (code === 0 && fs.existsSync(outPath)) resolve(outPath)
      else reject(new Error(`preview_failed: ${stderr.slice(-400)}`))
    })
  })
}

// ── Cleanup ────────────────────────────────────────────────────────────────

/**
 * Remove any sundayrec-master-preview-*.mp3 files left behind in os.tmpdir()
 * from a previous app run. Called once on startup.
 */
export function cleanupOldPreviews(): void {
  try {
    const dir = os.tmpdir()
    const entries = fs.readdirSync(dir)
    for (const name of entries) {
      if (name.startsWith('sundayrec-master-preview-') && name.endsWith('.mp3')) {
        try { fs.unlinkSync(path.join(dir, name)) } catch {}
      }
    }
  } catch {}
}
