/**
 * Whisper.cpp wrapper — transcribe audio files via the bundled whisper-cli.
 *
 * Pipeline:
 *   1. Resolve the platform-specific whisper-cli binary from app resources.
 *   2. Convert input audio (any ffmpeg-readable format) to 16 kHz mono WAV
 *      in a temp file — whisper.cpp only accepts that format.
 *   3. Spawn whisper-cli with the converted WAV + chosen model + language.
 *   4. Parse progress from stderr ("whisper_print_progress_callback: progress = N%").
 *   5. Read the JSON sidecar whisper-cli writes, normalize segments to our
 *      schema, return.
 *
 * Cancel: SIGTERM is safe per upstream — partial outputs are not written
 * until completion, so a cancelled job leaves no garbage in the JSON path.
 */

import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { spawn, type ChildProcess } from 'child_process'
import { ffmpegBin } from './native-recorder'
import { modelPath, isModelInstalled } from './whisper-models'
import type { TranscriptData, TranscriptSegment } from '../types'

// ─── Binary resolution ───────────────────────────────────────────────────────

/** Resolve the bundled whisper-cli for the current platform/arch. Returns
 *  null if no binary is shipped for the current target — caller should show
 *  a "not available on this platform" message. */
export function resolveWhisperBin(): string | null {
  const platformDir = `${process.platform}-${process.arch}`
  // Map to the resources/whisper/<platformDir>/ path. electron-builder puts
  // resources/ into the .app bundle at .app/Contents/Resources/ on macOS
  // and resources/ on Windows. process.resourcesPath points to it.
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'whisper', platformDir)
    : path.join(__dirname, '..', '..', 'resources', 'whisper', platformDir)
  const binName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
  const full    = path.join(base, binName)
  return fs.existsSync(full) ? full : null
}

export function isWhisperAvailable(): boolean {
  return resolveWhisperBin() != null
}

// ─── Job tracking ───────────────────────────────────────────────────────────

interface ActiveJob {
  proc:      ChildProcess
  ffmpegProc?: ChildProcess
  tempWav?:  string
  outPrefix: string
}

const activeJobs = new Map<string, ActiveJob>()

export function cancelTranscription(jobId: string): boolean {
  const job = activeJobs.get(jobId)
  if (!job) return false
  try { job.ffmpegProc?.kill('SIGTERM') } catch {}
  try { job.proc.kill('SIGTERM') } catch {}
  // Cleanup temp files happens in the proc.close handler via finally
  return true
}

// ─── Transcribe ─────────────────────────────────────────────────────────────

export interface TranscribeOptions {
  filePath:  string
  modelId:   string
  /** ISO-639-1 code or 'auto'. Default 'auto'. */
  language?: string
  /** Translate output to English. Default false. */
  translate?: boolean
  /** Subtitle-style segmenting (-ml 100 -sow) — short readable lines.
   *  Default true for sermons; set false to keep whisper's long default segments. */
  subtitleStyle?: boolean
  /** Job id — caller-supplied so cancellation can target it. */
  jobId:     string
  onProgress?: (percent: number) => void
}

export interface TranscribeResult {
  ok:         boolean
  transcript?: TranscriptData
  error?:     string
}

export async function transcribeFile(opts: TranscribeOptions): Promise<TranscribeResult> {
  const binPath = resolveWhisperBin()
  if (!binPath) return { ok: false, error: 'Whisper-binær ikke tilgjengelig på denne plattformen.' }

  const modelStatus = isModelInstalled(opts.modelId)
  if (!modelStatus.installed || !modelStatus.sizeOk) {
    return { ok: false, error: `Modell ${opts.modelId} er ikke lastet ned. Last ned først.` }
  }

  // Validate input
  if (!fs.existsSync(opts.filePath)) {
    return { ok: false, error: 'Kildefilen finnes ikke.' }
  }

  // 1. Convert to 16 kHz mono WAV in a temp file
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sundayrec-whisper-'))
  const tempWav = path.join(tempDir, 'input.wav')
  const outPrefix = path.join(tempDir, 'output')  // whisper-cli appends .json

  const job: ActiveJob = {
    proc:      null as unknown as ChildProcess,  // set below
    tempWav,
    outPrefix,
  }
  activeJobs.set(opts.jobId, job)

  try {
    // Step 1: ffmpeg convert
    const ffmpegOk = await convertToWhisperWav(opts.filePath, tempWav, job)
    if (!ffmpegOk) {
      return { ok: false, error: 'Kunne ikke konvertere lyd til whisper-format. Sjekk at filen ikke er korrupt.' }
    }

    // Step 2: whisper-cli
    const args = buildWhisperArgs(modelPath(opts.modelId), tempWav, outPrefix, opts)
    const whisperResult = await runWhisper(binPath, args, opts, job)
    if (!whisperResult.ok) return whisperResult

    // Step 3: read & normalize JSON
    const jsonPath = outPrefix + '.json'
    if (!fs.existsSync(jsonPath)) {
      return { ok: false, error: 'Whisper produserte ingen utskrift — kanskje filen er for kort eller stille?' }
    }
    const rawJson = JSON.parse(await fs.promises.readFile(jsonPath, 'utf8')) as WhisperRawOutput
    const transcript = normalizeWhisperOutput(rawJson, opts)
    return { ok: true, transcript }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  } finally {
    activeJobs.delete(opts.jobId)
    // Best-effort cleanup of the temp dir
    try { await fs.promises.rm(tempDir, { recursive: true, force: true }) } catch {}
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildWhisperArgs(modelFile: string, wavPath: string, outPrefix: string, opts: TranscribeOptions): string[] {
  // Use roughly half the CPU cores — leave room for UI + ffmpeg pre-conversion
  // and the OS. Caps at 8 because whisper.cpp scales sub-linearly beyond that.
  const cpuCount = os.cpus().length
  const threads  = Math.max(2, Math.min(8, Math.floor(cpuCount * 0.6)))

  const args = [
    '-m', modelFile,
    '-f', wavPath,
    '-l', opts.language ?? 'auto',
    '-oj',                         // JSON output
    '-of', outPrefix,              // output prefix (no extension)
    '-t', String(threads),
    '-pp',                         // print progress to stderr (parseable)
    '-np',                         // no print (suppresses banners; keeps progress)
  ]
  if (opts.translate) args.push('-tr')
  // Subtitle-style: shorter readable segments. Default ON for sermons.
  if (opts.subtitleStyle !== false) {
    args.push('-ml', '100', '-sow')
  }
  return args
}

function convertToWhisperWav(input: string, output: string, job: ActiveJob): Promise<boolean> {
  return new Promise(resolve => {
    const proc = spawn(ffmpegBin, [
      '-nostdin', '-hide_banner', '-y',
      '-i', input,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      output,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    job.ffmpegProc = proc

    // 10 min hard limit — converting even a 3 h file to 16 kHz mono is fast
    const killer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 10 * 60_000)

    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4096) })

    proc.on('close', code => {
      clearTimeout(killer)
      if (code === 0 && fs.existsSync(output)) resolve(true)
      else {
        console.warn('[whisper] ffmpeg conversion failed', code, stderr.slice(-300))
        resolve(false)
      }
    })
    proc.on('error', err => {
      clearTimeout(killer)
      console.warn('[whisper] ffmpeg spawn error', err)
      resolve(false)
    })
  })
}

interface WhisperRunOk { ok: true }
interface WhisperRunErr { ok: false; error: string }

async function runWhisper(
  binPath: string,
  args: string[],
  opts: TranscribeOptions,
  job: ActiveJob,
): Promise<WhisperRunOk | WhisperRunErr> {
  return new Promise(resolve => {
    const proc = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    job.proc = proc

    let stderrTail = ''
    let lastPercent = -1

    proc.stderr?.on('data', (d: Buffer) => {
      const chunk = d.toString()
      stderrTail = (stderrTail + chunk).slice(-8192)
      // Parse progress lines: "whisper_print_progress_callback: progress = 33%"
      const matches = chunk.matchAll(/progress\s*=\s*(\d+)%/g)
      for (const m of matches) {
        const pct = parseInt(m[1], 10)
        if (!isNaN(pct) && pct !== lastPercent) {
          lastPercent = pct
          opts.onProgress?.(pct)
        }
      }
    })

    // stdout contains the human-readable transcript with timestamps; we
    // don't need it (we read the JSON sidecar). Discard.
    proc.stdout?.on('data', () => {})

    proc.on('close', code => {
      if (code === 0) {
        opts.onProgress?.(100)
        resolve({ ok: true })
      } else {
        // SIGTERM exit codes vary across platforms; -15 on POSIX, 0xC000013A on Win
        const cancelled = code === null || code === 130 || code === 143 || code === -15
        if (cancelled) resolve({ ok: false, error: 'cancelled' })
        else resolve({ ok: false, error: `Whisper feilet (kode ${code}): ${stderrTail.slice(-300)}` })
      }
    })

    proc.on('error', err => {
      resolve({ ok: false, error: `Kunne ikke starte whisper-cli: ${err.message}` })
    })
  })
}

interface WhisperRawSegment {
  timestamps?: { from: string; to: string }
  offsets:     { from: number; to: number }    // milliseconds
  text:        string
}

interface WhisperRawOutput {
  result?:        { language?: string }
  transcription?: WhisperRawSegment[]
}

function normalizeWhisperOutput(raw: WhisperRawOutput, opts: TranscribeOptions): TranscriptData {
  const segments: TranscriptSegment[] = (raw.transcription ?? []).map(s => ({
    start: s.offsets.from / 1000,
    end:   s.offsets.to   / 1000,
    text:  (s.text ?? '').trim(),
  })).filter(s => s.text.length > 0)

  // Total duration = last segment end (approx). Slightly conservative —
  // whisper trims trailing silence so this can be 1-2 s short of file length,
  // but that's fine for the sidecar.
  const duration = segments.length > 0 ? segments[segments.length - 1].end : 0

  return {
    version:    1,
    model:      opts.modelId,
    language:   raw.result?.language ?? opts.language ?? 'auto',
    duration,
    createdAt:  Date.now(),
    translated: opts.translate || undefined,
    segments,
  }
}
