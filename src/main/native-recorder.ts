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

export async function resolveDeviceInput(opts: RecordingOpts): Promise<{ format: string; device: string } | null> {
  const name = (opts.deviceName ?? '').trim()

  if (process.platform === 'win32') {
    if (!name) {
      const devices = await listFfmpegDevices()
      if (!devices.length) return null
      return { format: 'dshow', device: `audio="${devices[0].name}"` }
    }
    return { format: 'dshow', device: `audio="${name}"` }
  }

  if (process.platform === 'darwin') {
    if (!name) return { format: 'avfoundation', device: ':0' }
    const devices = await listFfmpegDevices()
    const match = devices.find(d =>
      d.name.toLowerCase() === name.toLowerCase() ||
      d.name.toLowerCase().includes(name.toLowerCase()) ||
      name.toLowerCase().includes(d.name.toLowerCase())
    )
    return { format: 'avfoundation', device: `:${match?.index ?? 0}` }
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
  const chL = opts.channelL ?? 0
  const chR = opts.channelR ?? 1
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
    const thr  = opts.compThreshold ?? -24
    const rat  = opts.compRatio     ?? 4
    const atk  = ((opts.compAttack  ?? 10)  / 1000).toFixed(4)
    const rel  = ((opts.compRelease ?? 200) / 1000).toFixed(4)
    filters.push(`acompressor=threshold=${thr}dB:ratio=${rat}:attack=${atk}:release=${rel}:knee=6dB`)
  }

  // Limiter — always on unless explicitly disabled
  if (opts.limiterEnabled !== false) {
    const ceil = opts.limiterCeiling ?? -1
    filters.push(`alimiter=level_in=1:level_out=1:limit=${ceil}dB:attack=0.001:release=0.1`)
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

  proc.stderr?.on('data', (d: Buffer) => {
    const line = d.toString()
    const m = line.match(/size=\s*(\d+)kB/)
    if (m) {
      handle.bytesWritten = parseInt(m[1]) * 1024
      handle.onProgress?.(handle.bytesWritten)
      return
    }
    if (line.trim() && !line.includes('Press [q]') && !line.includes('time=')) {
      console.log('[ffmpeg-capture]', line.trimEnd())
    }
  })

  proc.on('close', code => {
    console.log('[native-recorder] ffmpeg exited, code:', code)
    handle.onExit?.(code)
  })

  // Wait up to 1s to detect immediate startup failures (wrong device name, permission denied)
  const startupError = await new Promise<string | null>(resolve => {
    const timer = setTimeout(() => resolve(null), 1000)
    proc.on('close', code => {
      clearTimeout(timer)
      // Exit code 0 at startup = unlikely but not an error
      resolve(code !== null && code !== 0 ? `ffmpeg_exit_${code}` : null)
    })
  })

  if (startupError) {
    return { error: startupError }
  }

  return handle
}

export async function stopCapture(handle: NativeHandle): Promise<void> {
  if (handle.proc.exitCode !== null) return

  return new Promise(resolve => {
    handle.proc.once('close', resolve)

    // 'q' is the standard ffmpeg graceful-stop signal via stdin
    try {
      handle.proc.stdin?.write('q')
      handle.proc.stdin?.end()
    } catch {}

    // Force kill if ffmpeg doesn't exit within 10 seconds
    const killer = setTimeout(() => {
      try { handle.proc.kill('SIGTERM') } catch {}
    }, 10000)

    handle.proc.once('close', () => clearTimeout(killer))
  })
}
