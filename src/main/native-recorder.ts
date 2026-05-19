/**
 * native-recorder — ffmpeg-based audio capture running entirely in the main process.
 *
 * Why: the old architecture used getUserMedia + MediaRecorder in the renderer (Chromium),
 * which meant any renderer crash (GPU fault, OOM, etc.) silently killed the recording.
 * This module captures directly from the OS audio device using ffmpeg subprocess —
 * completely isolated from the renderer. The renderer is now only used for the VU meter.
 *
 * Platform support:
 *   Windows — DirectShow   (ffmpeg -f dshow -i "audio=Device Name")
 *   macOS   — AVFoundation (ffmpeg -f avfoundation -i ":index")
 */

import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import type { RecordingOpts } from '../types'

// ── Binary resolution ───────────────────────────────────────────────────────

export function resolveFfmpegPath(): string {
  let p = ffmpegStatic as string
  if (app.isPackaged) {
    const norm = p.replace(/\\/g, '/')
    const idx  = norm.indexOf('app.asar/')
    if (idx !== -1) {
      p = path.join(
        norm.slice(0, idx).replace(/\//g, path.sep),
        'app.asar.unpacked',
        norm.slice(idx + 'app.asar/'.length).replace(/\//g, path.sep)
      )
    } else {
      p = p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
    }
    if (!fs.existsSync(p)) {
      console.error('[native-recorder] ffmpeg binary not found at', p, '— falling back to system PATH')
      p = 'ffmpeg'
    }
  }
  return p
}

export const ffmpegBin = resolveFfmpegPath()

// ── Device enumeration ──────────────────────────────────────────────────────

export interface FfmpegDevice { name: string; index: number }

export async function listFfmpegDevices(): Promise<FfmpegDevice[]> {
  return new Promise(resolve => {
    let args: string[]
    if (process.platform === 'win32') {
      args = ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy', '-hide_banner']
    } else if (process.platform === 'darwin') {
      args = ['-f', 'avfoundation', '-list_devices', 'true', '-i', '', '-hide_banner']
    } else {
      return resolve([])
    }

    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    const done = () => {
      const devices: FfmpegDevice[] = []
      if (process.platform === 'win32') {
        // Match lines like:  "Device Name (USB Audio)"
        for (const m of stderr.matchAll(/"([^"]+)"/g)) {
          const name = m[1]
          if (!devices.find(d => d.name === name)) {
            devices.push({ name, index: devices.length })
          }
        }
      } else {
        // Match AVFoundation lines like:  [0] Built-in Microphone
        for (const m of stderr.matchAll(/\[(\d+)\]\s+(.+)/g)) {
          devices.push({ index: parseInt(m[1]), name: m[2].trim() })
        }
      }
      resolve(devices)
    }
    proc.on('close', done)
    setTimeout(() => { try { proc.kill() } catch {} ; done() }, 5000)
  })
}

// ── Device input resolution ─────────────────────────────────────────────────

function bestMatch(devices: FfmpegDevice[], name: string): FfmpegDevice | undefined {
  if (!name) return devices[0]
  const n = name.toLowerCase()
  // 1. Exact match
  const exact = devices.find(d => d.name.toLowerCase() === n)
  if (exact) return exact
  // 2. Stored name is a substring of device name (e.g. "USB Audio" ⊂ "USB Audio Device (2- USB Audio)")
  const sub = devices.find(d => d.name.toLowerCase().includes(n))
  if (sub) return sub
  // 3. Device name is a substring of stored name
  const rev = devices.find(d => n.includes(d.name.toLowerCase()))
  if (rev) return rev
  return undefined
}

export async function resolveDeviceInput(
  opts: RecordingOpts
): Promise<{ format: string; device: string; resolvedName: string } | null> {
  const name = (opts.deviceName ?? '').trim()

  if (process.platform === 'win32') {
    // Always enumerate so we validate the name actually exists in DirectShow
    const devices = await listFfmpegDevices()
    if (!devices.length) return null
    const match = bestMatch(devices, name)
    if (!match) {
      console.warn(`[native-recorder] No DirectShow device matching "${name}" — using first device: "${devices[0].name}"`)
    }
    const resolved = match ?? devices[0]
    return { format: 'dshow', device: `audio="${resolved.name}"`, resolvedName: resolved.name }
  }

  if (process.platform === 'darwin') {
    const devices = await listFfmpegDevices()
    if (!devices.length) return { format: 'avfoundation', device: ':0', resolvedName: 'default' }
    const match = name ? bestMatch(devices, name) : devices[0]
    if (name && !match) {
      console.warn(`[native-recorder] No AVFoundation device matching "${name}" — using :0`)
    }
    const resolved = match ?? devices[0]
    return { format: 'avfoundation', device: `:${resolved.index}`, resolvedName: resolved.name }
  }

  return null
}

// ── Audio filter chain ──────────────────────────────────────────────────────

function buildAudioFilters(opts: RecordingOpts): string {
  const filters: string[] = []

  // Volume
  const vol = (opts.inputVolume ?? 80) / 100
  if (Math.abs(vol - 1) > 0.001) filters.push(`volume=${vol.toFixed(4)}`)

  // Channel routing — handles multi-channel devices and custom channel selection
  const channels = opts.channels ?? 'stereo'
  const chL = Math.max(0, Math.min(31, Math.trunc(opts.channelL ?? 0)))
  const chR = Math.max(0, Math.min(31, Math.trunc(opts.channelR ?? 1)))
  if (channels === 'monoL') {
    filters.push(`pan=mono|c0=c${chL}`)
  } else if (channels === 'monoR') {
    filters.push(`pan=mono|c0=c${chR}`)
  } else if (channels === 'monoMix') {
    filters.push(`pan=mono|c0=0.5*c${chL}+0.5*c${chR}`)
  } else if (channels === 'stereo' && (chL !== 0 || chR !== 1)) {
    filters.push(`pan=stereo|c0=c${chL}|c1=c${chR}`)
  }

  // Compressor
  if (opts.compEnabled) {
    const thr  = Math.max(-60, Math.min(0,   Number(opts.compThreshold ?? -24)))
    const rat  = Math.max(1,   Math.min(100, Number(opts.compRatio     ?? 4)))
    const atk  = Math.max(0.1, Math.min(2000, Number(opts.compAttack  ?? 10))) / 1000
    const rel  = Math.max(1,   Math.min(9000, Number(opts.compRelease ?? 200))) / 1000
    filters.push(`acompressor=threshold=${thr.toFixed(1)}dB:ratio=${rat.toFixed(1)}:attack=${atk.toFixed(4)}:release=${rel.toFixed(4)}:knee=6dB`)
  }

  // Limiter — always on unless explicitly disabled
  if (opts.limiterEnabled !== false) {
    const ceil = Math.max(-10, Math.min(0, Number(opts.limiterCeiling ?? -1)))
    filters.push(`alimiter=level_in=1:level_out=1:limit=${ceil.toFixed(1)}dB:attack=0.001:release=0.1`)
  }

  // Silence trim (post-process style — remove sustained silence at start/end)
  if (opts.trimSilence) {
    filters.push('silenceremove=start_periods=1:start_duration=0.1:start_threshold=-50dB:stop_periods=-1:stop_duration=1:stop_threshold=-50dB')
  }

  return filters.join(',')
}

function buildCodecArgs(opts: RecordingOpts): string[] {
  const fmt     = opts.format ?? 'mp3'
  const bitrate = String(opts.bitrate ?? 192).replace(/k$/i, '')
  switch (fmt) {
    case 'mp3':  return ['-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, '-id3v2_version', '3']
    case 'flac': return ['-c:a', 'flac']
    case 'aac':  return ['-c:a', 'aac', '-b:a', `${bitrate}k`]
    case 'wav':  return ['-c:a', 'pcm_s16le']
    default:     return ['-c:a', 'libmp3lame', '-b:a', `${bitrate}k`]
  }
}

// ── Capture handle ──────────────────────────────────────────────────────────

export interface NativeHandle {
  proc:        ChildProcess
  outputPath:  string
  startTime:   number
  bytesWritten: number
  onExit:      ((code: number | null) => void) | null
  onProgress:  ((bytes: number) => void) | null
}

// ── Start / stop ────────────────────────────────────────────────────────────

// Classify ffmpeg stderr into a user-facing error code
function classifyFfmpegError(stderr: string): string {
  const s = stderr.toLowerCase()
  if (
    s.includes('no such file') || s.includes('device not found') ||
    s.includes('could not find') || s.includes('not found') ||
    s.includes('no devices found') || s.includes('invalid argument') ||
    s.includes('no such audio device') || s.includes('failed to find') ||
    s.includes('cannot find')
  ) {
    return 'device_not_found'
  }
  if (
    s.includes('access is denied') || s.includes('permission') ||
    s.includes('not permitted') || s.includes('avfoundation: video not enabled') ||
    s.includes('authorization') || s.includes('microphone access') ||
    s.includes('privacy') || s.includes('tcm_access')
  ) {
    return 'device_permission_denied'
  }
  if (
    s.includes('already in use') || s.includes('device busy') ||
    s.includes('being used by another') || s.includes('resource busy') ||
    s.includes('device or resource busy')
  ) {
    return 'device_busy'
  }
  if (s.includes('no space left') || s.includes('disk full') || s.includes('enospc')) {
    return 'disk_full'
  }
  if (s.includes('broken pipe') || s.includes('i/o error') || s.includes('input/output')) {
    return 'device_disconnected'
  }
  return 'device_error'
}

export async function startCapture(
  opts: RecordingOpts,
  outputPath: string
): Promise<NativeHandle | { error: string }> {
  const input = await resolveDeviceInput(opts)
  if (!input) return { error: 'no_device' }

  const sampleRate  = opts.sampleRate ?? 48000
  const outChannels = (opts.channels === 'stereo') ? 2 : 1
  const afChain     = buildAudioFilters(opts)

  const args: string[] = [
    '-nostdin', '-hide_banner',
    '-f', input.format,
    '-i', input.device,
    '-ar', String(sampleRate),
    '-ac', String(outChannels),
  ]
  if (afChain) args.push('-af', afChain)
  args.push(...buildCodecArgs(opts), '-y', outputPath)

  console.log('[native-recorder] start:', ffmpegBin, args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' '))

  const proc = spawn(ffmpegBin, args, {
    stdio: ['pipe', 'ignore', 'pipe'],
    detached: false
  })

  const handle: NativeHandle = {
    proc, outputPath,
    startTime: Date.now(),
    bytesWritten: 0,
    onExit: null,
    onProgress: null
  }

  let stderrBuf = ''

  proc.stderr?.on('data', (d: Buffer) => {
    const chunk = d.toString()
    stderrBuf  += chunk
    const m = chunk.match(/size=\s*(\d+)kB/)
    if (m) {
      handle.bytesWritten = parseInt(m[1]) * 1024
      handle.onProgress?.(handle.bytesWritten)
      return
    }
    if (chunk.trim() && !chunk.includes('Press [q]') && !chunk.includes('time=')) {
      console.log('[ffmpeg-capture]', chunk.trimEnd())
    }
  })

  proc.on('close', code => {
    console.log('[native-recorder] ffmpeg exited, code:', code)
    handle.onExit?.(code)
  })

  // Windows DirectShow can take 2-3 s to enumerate and open a device.
  // macOS AVFoundation can also be slow on first access (privacy prompt, driver init).
  const startupMs = process.platform === 'win32' ? 3000 : 2000

  const startupError = await new Promise<string | null>(resolve => {
    const timer = setTimeout(() => resolve(null), startupMs)
    proc.on('close', code => {
      clearTimeout(timer)
      // Any exit during startup window — success (code 0) or failure — is treated as error.
      // A capture process that exits within 2 s wrote nothing useful.
      const classified = classifyFfmpegError(stderrBuf)
      resolve(classified || (code !== 0 ? 'device_error' : 'device_error'))
    })
  })

  if (startupError) return { error: startupError }

  // Guard: process might have exited cleanly during the startup window (race condition).
  // The close event already fired, handle.onExit was not set yet → zombie session.
  if (proc.exitCode !== null || proc.killed) {
    console.error('[native-recorder] process already exited after startup window, exitCode:', proc.exitCode)
    return { error: classifyFfmpegError(stderrBuf) || 'device_error' }
  }

  return handle
}

export async function stopCapture(handle: NativeHandle): Promise<void> {
  if (handle.proc.exitCode !== null) return

  return new Promise(resolve => {
    handle.proc.once('close', resolve)

    if (process.platform === 'win32') {
      // DirectShow on Windows does not reliably flush when ffmpeg receives stdin 'q'.
      // SIGTERM causes Windows to call TerminateProcess which flushes the codec buffer
      // in the same way as CTRL+C — the file is written cleanly.
      try { handle.proc.kill('SIGTERM') } catch {}
    } else {
      // macOS / Linux: send 'q' via stdin for a clean codec flush + container finalization
      try {
        handle.proc.stdin?.write('q')
        handle.proc.stdin?.end()
      } catch {}

      // Force kill if ffmpeg doesn't respond within 10 seconds
      const killer = setTimeout(() => {
        try { handle.proc.kill('SIGTERM') } catch {}
      }, 10000)

      handle.proc.once('close', () => clearTimeout(killer))
    }
  })
}
