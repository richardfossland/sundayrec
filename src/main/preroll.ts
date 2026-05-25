/**
 * preroll — continuous background capture to a temp WAV file.
 *
 * When the user presses record, harvest() stops the pre-roll process and
 * returns the path to the captured audio + how many ms to trim. The recorder
 * then encodes that trimmed segment to the target format and prepends it to
 * the main recording via ffmpeg concat.
 *
 * File capping: ffmpeg runs with -t 90 so each segment is at most 90 s (~16 MB).
 * When ffmpeg exits naturally the module auto-restarts, leaving a ~200 ms gap.
 *
 * Platform note: on macOS only one process can own AVFoundation at a time.
 * harvest() awaits the ffmpeg process exit, then the caller must wait ~300 ms
 * before starting the main recording.
 */

import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import path from 'path'
import os from 'os'
import fs from 'fs'
import crypto from 'crypto'
import { ffmpegBin, resolveDeviceInput } from './native-recorder'
import type { RecordingOpts } from '../types'

interface PrerollHandle {
  proc:      ChildProcess
  filePath:  string
  startTime: number
  format:    string
}

let isActive      = false
let activePreroll: PrerollHandle | null = null

export function isRunning(): boolean {
  return isActive && activePreroll !== null
}

export async function start(opts: RecordingOpts): Promise<void> {
  if (isActive) return
  isActive = true
  startLoop(opts, 0).catch(err => console.error('[preroll] start error:', err))
}

function retryDelay(attempt: number): number {
  // 5s → 10s → 20s → 40s → 60s cap
  return Math.min(5000 * Math.pow(2, attempt), 60000)
}

async function startLoop(opts: RecordingOpts, attempt: number): Promise<void> {
  if (!isActive) return

  let input: Awaited<ReturnType<typeof resolveDeviceInput>>
  try {
    input = await resolveDeviceInput(opts)
  } catch (err) {
    console.error('[preroll] device resolution error:', err)
    if (isActive) {
      const delay = retryDelay(attempt)
      console.log(`[preroll] retrying in ${delay / 1000}s (attempt ${attempt + 1})`)
      setTimeout(() => startLoop(opts, attempt + 1).catch(e => console.error('[preroll] loop error:', e)), delay)
    }
    return
  }
  if (!input) {
    if (isActive) {
      const delay = retryDelay(attempt)
      console.log(`[preroll] no device, retrying in ${delay / 1000}s (attempt ${attempt + 1})`)
      setTimeout(() => startLoop(opts, attempt + 1).catch(e => console.error('[preroll] loop error:', e)), delay)
    }
    return
  }
  if (!isActive) return

  const sessionId = crypto.randomUUID().slice(0, 8)
  const filePath  = path.join(os.tmpdir(), `sundayrec-preroll-${sessionId}.wav`)
  const outCh     = (opts.channels ?? 'stereo') === 'stereo' ? 2 : 1

  const args = [
    '-hide_banner',
    '-f',  input.format,
    '-i',  input.device,
    '-ar', String(opts.sampleRate ?? 48000),
    '-ac', String(outCh),
    '-c:a', 'pcm_s16le',
    '-t',  '90',   // cap each segment at 90 s to limit disk usage
    '-y',  filePath,
  ]

  const proc = spawn(ffmpegBin, args, {
    stdio: ['pipe', 'ignore', 'ignore'],
    detached: false
  })

  activePreroll = { proc, filePath, startTime: Date.now(), format: input.format }
  console.log('[preroll] started →', filePath)

  proc.on('close', () => {
    if (activePreroll?.filePath === filePath) activePreroll = null
    if (isActive) {
      // Auto-restart after natural 90 s cap (or unexpected exit); reset retry counter on success
      setTimeout(() => startLoop(opts, 0).catch(e => console.error('[preroll] loop error:', e)), 200)
    } else {
      // Pre-roll was deactivated mid-segment — the 90 s WAV chunk we just
      // produced will never be harvested, so it's pure disk litter. Remove it.
      fs.promises.unlink(filePath).catch(() => {})
    }
  })
}

/**
 * Stop the pre-roll and return the captured file + how many ms to prepend.
 * Returns null if nothing was captured or the file is too short.
 */
export async function harvest(seconds: number): Promise<{ rawPath: string; trimMs: number } | null> {
  isActive = false
  if (!activePreroll) return null

  const handle = activePreroll
  activePreroll = null

  await stopProc(handle.proc, handle.format)

  if (!fs.existsSync(handle.filePath)) return null
  const stat = fs.statSync(handle.filePath)
  if (stat.size < 4096) {
    fs.promises.unlink(handle.filePath).catch(() => {})
    return null
  }

  const capturedMs = Date.now() - handle.startTime
  // Leave a 300 ms safety margin at the end (device might not have flushed yet)
  const trimMs = Math.min(seconds * 1000, capturedMs - 300)
  if (trimMs <= 0) {
    fs.promises.unlink(handle.filePath).catch(() => {})
    return null
  }

  console.log(`[preroll] harvested ${(trimMs / 1000).toFixed(1)} s from`, handle.filePath)
  return { rawPath: handle.filePath, trimMs }
}

/**
 * Stop the pre-roll without harvesting (called when a scheduled recording starts).
 * Awaiting this ensures the device is released before the caller continues.
 */
export async function stop(): Promise<void> {
  isActive = false
  if (!activePreroll) return
  const handle = activePreroll
  activePreroll = null
  await stopProc(handle.proc, handle.format)
  fs.promises.unlink(handle.filePath).catch(() => {})
}

async function stopProc(proc: ChildProcess, format?: string): Promise<void> {
  if (proc.exitCode !== null) return
  return new Promise(resolve => {
    let killer: ReturnType<typeof setTimeout> | null = null
    proc.once('close', () => {
      if (killer) clearTimeout(killer)
      resolve()
    })
    // WASAPI (Windows) and non-Windows: use graceful 'q' so ffmpeg finalises the WAV header.
    // DirectShow ignores stdin — must use SIGTERM (TerminateProcess).
    const useGraceful = format === 'wasapi' || process.platform !== 'win32'
    if (useGraceful) {
      try { proc.stdin?.write('q'); proc.stdin?.end() } catch {}
      killer = setTimeout(() => { try { proc.kill('SIGTERM') } catch {} }, 5000)
    } else {
      try { proc.kill('SIGTERM') } catch {}
    }
  })
}
