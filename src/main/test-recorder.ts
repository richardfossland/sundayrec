/**
 * Stand-alone "test recording" — records 30 s to a temp file and reports back
 * whether the whole pipeline (device, encoder, filesystem) works end-to-end.
 *
 * Decoupled from the main recorder so:
 *   - It never appears in history
 *   - It can't collide with a real session (a real session in progress causes refusal)
 *   - Crashes don't leave activeRecovery state behind
 */

import os from 'os'
import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'
import { ffmpegBin, resolveDeviceInput, buildCodecArgs } from './native-recorder'
import * as logger from './logger'
import * as recorder from './recorder'
import type { RecordingOpts } from '../types'

const TEST_DURATION_SEC = 30
const TEST_CLEANUP_MS   = 5 * 60_000  // delete the test file after 5 min

export interface TestRecordingResult {
  ok:        boolean
  /** Path to the test file — caller may show it / open it. Cleaned up after 5 min. */
  filePath?: string
  /** Size of the recorded file in bytes. */
  sizeBytes?: number
  /** Best-effort estimate of signal level: 'silent', 'low', or 'normal'. */
  signal?:   'silent' | 'low' | 'normal'
  /** When ok=false, a short error code (device_not_found, no_audio, ffmpeg_error). */
  error?:    string
  /** Human-readable detail line. */
  detail?:   string
}

let inflight = false

export async function runTestRecording(settings: RecordingOpts): Promise<TestRecordingResult> {
  if (inflight) return { ok: false, error: 'already_running', detail: 'Et test-opptak pågår allerede.' }
  if (recorder.isActive()) {
    return { ok: false, error: 'recording_active', detail: 'Et vanlig opptak pågår. Stopp det først.' }
  }
  inflight = true
  try {
    const input = await resolveDeviceInput(settings)
    if (!input) {
      return { ok: false, error: 'device_not_found', detail: 'Ingen lydenhet funnet.' }
    }

    const tmpDir  = path.join(os.tmpdir(), 'sundayrec-test')
    await fs.promises.mkdir(tmpDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const filePath = path.join(tmpDir, `test_${ts}.mp3`)

    const args: string[] = [
      '-nostdin', '-hide_banner',
      '-f', input.format,
      ...(input.format === 'wasapi' ? ['-rtbufsize', '50M'] : []),
      '-i', (input.format === 'wasapi' && input.device === '') ? ':' : input.device,
      '-t', String(TEST_DURATION_SEC),
      // Use the user's selected sample rate + an mp3 mono encode for a quick file
      ...buildCodecArgs({ ...settings, format: 'mp3', bitrate: '128' }),
      '-y', filePath,
    ]

    logger.info('test-recorder', 'start', { device: input.resolvedName, filePath })

    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', d => { stderr = (stderr + d.toString()).slice(-8192) })

    const exitCode = await new Promise<number | null>(resolve => {
      // Hard timeout — TEST_DURATION_SEC plus a generous 10 s startup grace
      const timer = setTimeout(() => {
        try { proc.kill('SIGTERM') } catch {}
      }, (TEST_DURATION_SEC + 10) * 1000)
      proc.on('close', code => { clearTimeout(timer); resolve(code) })
    })

    if (exitCode !== 0) {
      const lower = stderr.toLowerCase()
      let error = 'ffmpeg_error'
      if (lower.includes('no such') || lower.includes('not found')) error = 'device_not_found'
      else if (lower.includes('permission') || lower.includes('access is denied')) error = 'device_permission_denied'
      logger.warn('test-recorder', 'failed', { error, stderr: stderr.slice(-500) })
      return { ok: false, error, detail: stderr.slice(-300) }
    }

    // Validate the resulting file
    const stat = await fs.promises.stat(filePath).catch(() => null)
    if (!stat || stat.size < 5_000) {
      return { ok: false, filePath, sizeBytes: stat?.size, error: 'no_audio', detail: 'Filen er for liten — ingen lyd ble registrert.' }
    }

    // Measure RMS level directly with ffmpeg astats — way more reliable than
    // guessing from compressed file size. Quiet (-60 dB) ⇒ silent; below
    // around -30 dB suggests a misconfigured gain.
    const signal = await measureRms(filePath)

    // Schedule cleanup so we don't leave files behind. Best-effort.
    setTimeout(() => {
      fs.promises.unlink(filePath).catch(() => {})
    }, TEST_CLEANUP_MS).unref()

    logger.info('test-recorder', 'ok', { sizeBytes: stat.size, signal })
    return { ok: true, filePath, sizeBytes: stat.size, signal }
  } finally {
    inflight = false
  }
}

/**
 * Run the file through ffmpeg's `astats` filter and read the overall RMS
 * level from stderr. Falls back to `'normal'` on parse failure so a working
 * test isn't flagged as silent just because the analyzer hiccupped.
 */
async function measureRms(filePath: string): Promise<'silent' | 'low' | 'normal'> {
  return new Promise(resolve => {
    const proc = spawn(ffmpegBin, [
      '-nostdin', '-hide_banner', '-i', filePath,
      '-af', 'astats=metadata=1:reset=0',
      '-f', 'null', '-',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })

    let stderr = ''
    proc.stderr?.on('data', d => { stderr = (stderr + d.toString()).slice(-16384) })

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM') } catch {}
    }, 10_000)

    proc.on('close', () => {
      clearTimeout(timer)
      // astats prints "RMS level dB: -23.4" per channel; pick the strongest.
      let strongest = -Infinity
      const re = /RMS level dB:\s*(-?[\d.]+)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(stderr)) !== null) {
        const v = parseFloat(m[1])
        if (Number.isFinite(v) && v > strongest) strongest = v
      }
      if (!Number.isFinite(strongest)) {
        logger.warn('test-recorder', 'rms_parse_failed')
        return resolve('normal')
      }
      // Heuristic thresholds for an unprocessed mono mic recording:
      //   < -55 dB ⇒ effectively silent (mute or unplugged)
      //   < -30 dB ⇒ weak signal (gain way down, mic far away)
      //   otherwise ⇒ normal speech level
      const signal: 'silent' | 'low' | 'normal' =
        strongest < -55 ? 'silent' :
        strongest < -30 ? 'low'    :
                          'normal'
      logger.info('test-recorder', 'rms_measured', { rmsDb: strongest.toFixed(1), signal })
      resolve(signal)
    })
  })
}

/**
 * Sweep any leftover test-recordings on app start. The 5-min auto-cleanup
 * only fires while the app is still running — a crash mid-test or a quit
 * before the timer leaves files lying around.
 */
export async function cleanupOldTestRecordings(): Promise<number> {
  const tmpDir = path.join(os.tmpdir(), 'sundayrec-test')
  if (!fs.existsSync(tmpDir)) return 0
  let removed = 0
  try {
    const entries = await fs.promises.readdir(tmpDir)
    for (const name of entries) {
      try {
        await fs.promises.unlink(path.join(tmpDir, name))
        removed++
      } catch {}
    }
  } catch {}
  return removed
}
