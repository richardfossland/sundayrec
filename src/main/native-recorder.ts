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
    let settled = false
    const done = () => {
      if (settled) return; settled = true
      const devices: FfmpegDevice[] = []
      if (process.platform === 'win32') {
        // Only match actual device name lines; skip "Alternative name" entries
        // and @device_... GUID strings that ffmpeg also quotes.
        for (const line of stderr.split('\n')) {
          if (line.includes('Alternative name')) continue
          const m = line.match(/"([^"]+)"/)
          if (m && !m[1].startsWith('@')) {
            const name = m[1]
            if (!devices.find(d => d.name === name)) {
              devices.push({ name, index: devices.length })
            }
          }
        }
      } else {
        // AVFoundation: only parse the audio devices section.
        // The output lists video devices first, then audio — both use [0], [1], … indices,
        // so mixing them would map video index 0 → audio input 0 incorrectly.
        let inAudioSection = false
        for (const line of stderr.split('\n')) {
          if (line.includes('AVFoundation audio devices')) { inAudioSection = true; continue }
          if (line.includes('AVFoundation video devices')) { inAudioSection = false; continue }
          if (!inAudioSection) continue
          const m = line.match(/\[(\d+)\]\s+(.+)/)
          if (m) devices.push({ index: parseInt(m[1]), name: m[2].trim() })
        }
      }
      resolve(devices)
    }
    proc.on('close', done)
    setTimeout(() => { if (!settled) { try { proc.kill() } catch {}; done() } }, 5000)
  })
}

// ── WASAPI detection (cached for process lifetime) ──────────────────────────

let _wasapiAvailable: boolean | null = null

async function probeWasapiAvailable(): Promise<boolean> {
  if (_wasapiAvailable !== null) return _wasapiAvailable
  return new Promise(resolve => {
    const proc = spawn(ffmpegBin, ['-devices', '-hide_banner'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    proc.stdout?.on('data', (d: Buffer) => { output += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { output += d.toString() })
    let settled = false
    const done = (result: boolean) => {
      if (settled) return
      settled = true
      _wasapiAvailable = result
      resolve(result)
    }
    proc.on('close', () => done(output.toLowerCase().includes('wasapi')))
    setTimeout(() => { try { proc.kill() } catch {}; done(false) }, 3000)
  })
}

// ── WASAPI device enumeration ───────────────────────────────────────────────

async function listWasapiDevices(): Promise<FfmpegDevice[]> {
  if (process.platform !== 'win32') return []
  return new Promise(resolve => {
    const proc = spawn(ffmpegBin, ['-f', 'wasapi', '-list_devices', 'true', '-i', 'dummy', '-hide_banner'], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    let settled = false
    const done = () => {
      if (settled) return; settled = true
      const devices: FfmpegDevice[] = []
      // WASAPI output format: [wasapi @ ...] "Device Name" (uuid)
      for (const line of stderr.split('\n')) {
        const m = line.match(/"([^"]+)"/)
        if (m && !m[1].startsWith('{')) {
          const name = m[1].trim()
          if (name && !devices.find(d => d.name === name)) {
            devices.push({ name, index: devices.length })
          }
        }
      }
      resolve(devices)
    }
    proc.on('close', done)
    proc.on('error', () => { if (!settled) { settled = true; resolve([]) } })
    setTimeout(() => { if (!settled) { try { proc.kill() } catch {}; done() } }, 5000)
  })
}

// ── Device input resolution ─────────────────────────────────────────────────

// Generic USB audio words that are too common to distinguish devices
const GENERIC_AUDIO_WORDS = new Set(['usb', 'audio', 'codec', 'device', 'input', 'output',
  'microphone', 'speaker', 'headset', 'headphone', 'sound', 'card', 'interface',
  'capture', 'playback', 'recording', 'stereo', 'mono', 'digital', 'analog'])

function extractBrandWords(s: string): string[] {
  // Strip leading "N- " Windows prefix pattern (e.g. "2- USB Audio CODEC")
  const cleaned = s.replace(/^\d+[-–]\s*/, '')
  return cleaned.toLowerCase().split(/[\s\-()+,/\\]+/)
    .filter(w => w.length > 2 && !GENERIC_AUDIO_WORDS.has(w))
}

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
  // 4. Word-overlap — handles localization (browser reports English names, ffmpeg reports OS language).
  //    E.g. "MacBook Pro Microphone (Built-in)" vs Norwegian "MacBook Pro-mikrofon": shares "macbook"+"pro".
  const storedWords = n.split(/[\s\-()+]+/).filter(w => w.length > 2)
  const wordMatch = devices.find(d => {
    const devWords = d.name.toLowerCase().split(/[\s\-()+]+/).filter(w => w.length > 2)
    const overlaps = storedWords.filter(sw => devWords.some(dw => dw.startsWith(sw) || sw.startsWith(dw)))
    return overlaps.length >= 2
  })
  if (wordMatch) return wordMatch
  // 5. Brand/model extraction: strip generic USB audio words and compare remaining brand words.
  //    Handles: "Soundcraft USB Audio (USB Audio)" vs "USB Audio CODEC"
  //    Also handles: "2- USB Audio CODEC" Windows prefix pattern
  const storedBrand = extractBrandWords(n)
  const brandMatch = storedBrand.length > 0 ? devices.find(d => {
    const devBrand = extractBrandWords(d.name)
    return storedBrand.some(sw => devBrand.some(dw => dw === sw || dw.startsWith(sw) || sw.startsWith(dw)))
  }) : undefined
  if (brandMatch) return brandMatch
  return undefined
}

// ── ASIO driver enumeration (Windows registry) ─────────────────────────────

export async function listAsioDrivers(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  return new Promise(resolve => {
    const proc = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-ChildItem "HKLM:\\SOFTWARE\\ASIO" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty PSChildName'
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    let settled = false
    const done = (result?: string[]) => {
      if (settled) return; settled = true
      if (result) { resolve(result); return }
      const drivers = stdout.trim().split('\n')
        .map(s => s.trim()).filter(s => s.length > 0)
      resolve(drivers)
    }
    proc.on('close', () => done())
    proc.on('error', () => done([]))
    setTimeout(() => { if (!settled) { try { proc.kill() } catch {}; done([]) } }, 5000)
  })
}

// ── Device input resolution ─────────────────────────────────────────────────

export async function resolveDeviceInput(
  opts: RecordingOpts
): Promise<{ format: string; device: string; resolvedName: string } | null> {
  const name = (opts.deviceName ?? '').trim()

  if (process.platform === 'win32') {
    // ASIO device selected — currently recorded via WASAPI/DirectShow fallback.
    // Full ASIO capture (naudiodon) can be dropped in here later without UI changes.
    if ((opts.deviceId ?? '').startsWith('asio::')) {
      const driverName = (opts.deviceId as string).slice(6)
      const devices    = await listFfmpegDevices()
      const match      = devices.length ? (bestMatch(devices, driverName) ?? devices[0]) : null
      if (!match) return null
      const api = await probeWasapiAvailable() ? 'WASAPI' : 'DirectShow'
      console.warn(`[native-recorder] ASIO driver "${driverName}" selected — using ${api}: "${match.name}"`)
      if (api === 'WASAPI') {
        return { format: 'wasapi', device: match.name, resolvedName: match.name }
      }
      return { format: 'dshow', device: `audio="${match.name}"`, resolvedName: match.name }
    }

    const devices = await listFfmpegDevices()
    if (!devices.length) return null
    console.log(`[native-recorder] stored device name: "${name}"`)
    console.log(`[native-recorder] DirectShow devices: [${devices.map(d => `"${d.name}"`).join(', ')}]`)
    const match = bestMatch(devices, name)
    if (!match) {
      console.warn(`[native-recorder] No DirectShow device matching "${name}" — available: ${devices.map(d => `"${d.name}"`).join(', ')} — using first: "${devices[0].name}"`)
    }
    const resolved = match ?? devices[0]
    // WASAPI is the modern Windows audio API: lower latency, more stable than DirectShow.
    // Enumerate WASAPI devices separately — they may have different names than DirectShow.
    if (await probeWasapiAvailable()) {
      const wasapiDevices = await listWasapiDevices()
      if (wasapiDevices.length) {
        const wasapiMatch = bestMatch(wasapiDevices, name)
        const wasapiResolved = wasapiMatch ?? wasapiDevices[0]
        console.log(`[native-recorder] WASAPI devices: ${wasapiDevices.map(d => d.name).join(', ')}`)
        console.log(`[native-recorder] using WASAPI device: "${wasapiResolved.name}"`)
        return { format: 'wasapi', device: wasapiResolved.name, resolvedName: wasapiResolved.name }
      }
      // Fallback to DirectShow name with WASAPI format
      console.log('[native-recorder] WASAPI enumeration empty — falling back to DirectShow name')
      return { format: 'wasapi', device: resolved.name, resolvedName: resolved.name }
    }
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

// ── Video device enumeration ────────────────────────────────────────────────

export interface FfmpegVideoDevice { name: string; index: number }

export async function listVideoFfmpegDevices(): Promise<FfmpegVideoDevice[]> {
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
    let settled = false
    const done = () => {
      if (settled) return; settled = true
      const devices: FfmpegVideoDevice[] = []
      if (process.platform === 'win32') {
        // Only parse the video devices section (before "DirectShow audio devices")
        let inVideoSection = true
        for (const line of stderr.split('\n')) {
          if (line.toLowerCase().includes('directshow audio devices')) { inVideoSection = false; continue }
          if (!inVideoSection || line.includes('Alternative name')) continue
          const m = line.match(/"([^"]+)"/)
          if (m && !m[1].startsWith('@')) {
            const name = m[1]
            if (!devices.find(d => d.name === name)) devices.push({ name, index: devices.length })
          }
        }
      } else {
        // AVFoundation: parse the video devices section (before audio section)
        let inVideoSection = false
        for (const line of stderr.split('\n')) {
          if (line.includes('AVFoundation video devices')) { inVideoSection = true; continue }
          if (line.includes('AVFoundation audio devices')) { inVideoSection = false; continue }
          if (!inVideoSection) continue
          const m = line.match(/\[(\d+)\]\s+(.+)/)
          if (m) devices.push({ index: parseInt(m[1]), name: m[2].trim() })
        }
      }
      resolve(devices)
    }
    proc.on('close', done)
    setTimeout(() => { if (!settled) { try { proc.kill() } catch {}; done() } }, 5000)
  })
}

function bestVideoMatch(devices: FfmpegVideoDevice[], name: string): FfmpegVideoDevice | undefined {
  if (!name) return devices[0]
  const n = name.toLowerCase()
  const exact = devices.find(d => d.name.toLowerCase() === n)
  if (exact) return exact
  const sub = devices.find(d => d.name.toLowerCase().includes(n))
  if (sub) return sub
  const rev = devices.find(d => n.includes(d.name.toLowerCase()))
  if (rev) return rev
  const storedWords = n.split(/[\s\-()+]+/).filter(w => w.length > 2)
  return devices.find(d => {
    const devWords = d.name.toLowerCase().split(/[\s\-()+]+/).filter(w => w.length > 2)
    const overlaps = storedWords.filter(sw => devWords.some(dw => dw.startsWith(sw) || sw.startsWith(dw)))
    return overlaps.length >= 2
  })
}

export async function resolveVideoInput(
  opts: { videoDeviceName?: string | null; videoDeviceIndex?: number | null }
): Promise<{ format: string; device: string; resolvedName: string } | null> {
  if (process.platform === 'darwin') {
    // Always enumerate current devices — indices can change after camera reconnect.
    // Prefer name-based match; fall back to stored index only if name lookup fails.
    const devices = await listVideoFfmpegDevices()
    if (!devices.length) return null

    const name = (opts.videoDeviceName ?? '').trim()
    const byName = name ? bestVideoMatch(devices, name) : null
    if (byName) {
      if (byName.index !== opts.videoDeviceIndex) {
        console.log(`[native-recorder] video device "${byName.name}" index changed: ${opts.videoDeviceIndex} → ${byName.index}`)
      }
      return { format: 'avfoundation', device: String(byName.index), resolvedName: byName.name }
    }

    // Name lookup failed — fall back to stored index if it still exists in the list.
    if (opts.videoDeviceIndex !== null && opts.videoDeviceIndex !== undefined) {
      const byIndex = devices.find(d => d.index === opts.videoDeviceIndex)
      if (byIndex) {
        console.warn(`[native-recorder] video device name "${name}" not found — using index ${opts.videoDeviceIndex} (${byIndex.name})`)
        return { format: 'avfoundation', device: String(byIndex.index), resolvedName: byIndex.name }
      }
    }

    // Last resort: first available device
    console.warn(`[native-recorder] video device "${name}" not found — falling back to first device: "${devices[0].name}"`)
    return { format: 'avfoundation', device: String(devices[0].index), resolvedName: devices[0].name }
  }

  if (process.platform === 'win32') {
    const devices = await listVideoFfmpegDevices()
    if (!devices.length) return null
    const name = (opts.videoDeviceName ?? '').trim()
    const match = name ? bestVideoMatch(devices, name) : devices[0]
    const resolved = match ?? devices[0]
    return { format: 'dshow', device: `video="${resolved.name}"`, resolvedName: resolved.name }
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
    filters.push(`alimiter=level_in=1:level_out=1:limit=${ceil.toFixed(1)}dB:attack=1:release=50`)
  }

  // EQ — bass / mid / treble (dB), skip when all at 0 (default)
  const bass = Number(opts.eqBass ?? 0)
  if (Math.abs(bass) > 0.01) {
    const g = Math.max(-12, Math.min(12, bass))
    filters.push(`bass=g=${g.toFixed(1)}`)
  }
  const mid = Number(opts.eqMid ?? 0)
  if (Math.abs(mid) > 0.01) {
    const g = Math.max(-12, Math.min(12, mid))
    filters.push(`equalizer=f=1000:width_type=o:width=2:g=${g.toFixed(1)}`)
  }
  const treble = Number(opts.eqTreble ?? 0)
  if (Math.abs(treble) > 0.01) {
    const g = Math.max(-12, Math.min(12, treble))
    filters.push(`treble=g=${g.toFixed(1)}`)
  }

  // Silence trim (post-process style — remove sustained silence at start/end)
  if (opts.trimSilence) {
    filters.push('silenceremove=start_periods=1:start_duration=0.1:start_threshold=-50dB:stop_periods=-1:stop_duration=1:stop_threshold=-50dB')
  }

  // Silence-end detection — emits silence_start/end events to stderr, parsed in startCapture
  if (opts.stopOnSilence) {
    const noiseDb = Math.max(-70, Math.min(-10, Number(opts.silenceThreshold ?? -50)))
    filters.push(`silencedetect=noise=${noiseDb}dB:duration=1`)
  }

  return filters.join(',')
}

export function buildCodecArgs(opts: RecordingOpts): string[] {
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
  format:      string
  onExit:      ((code: number | null) => void) | null
  onProgress:  ((bytes: number) => void) | null
  onSilenceEnd: (() => void) | null
}

// ── Start / stop ────────────────────────────────────────────────────────────

// Classify ffmpeg stderr into a user-facing error code
function classifyFfmpegError(stderr: string): string {
  const s = stderr.toLowerCase()
  if (
    s.includes('device not found') ||
    s.includes('no such audio device') || s.includes('no such audio input') ||
    s.includes('no devices found') ||
    s.includes('no audio endpoint') ||
    s.includes('could not find audio') || s.includes('cannot find audio') ||
    s.includes('failed to find audio') ||
    s.includes('the handle is invalid') ||
    s.includes('no audio device') || s.includes('audio device not found') ||
    s.includes('avfoundation: device') || s.includes('no such file or directory') ||
    s.includes('audclnt_e_device_not_active') ||
    s.includes('no audio endpoint device') ||
    s.includes('mmdevapi') ||
    s.includes('failed to create audio client') ||
    s.includes('the system cannot find the file specified')
  ) {
    return 'device_not_found'
  }
  if (
    s.includes('access is denied') || s.includes('permission') ||
    s.includes('not permitted') || s.includes('avfoundation: video not enabled') ||
    s.includes('authorization') || s.includes('microphone access') ||
    s.includes('privacy') || s.includes('tcm_access') ||
    s.includes('e_accessdenied')
  ) {
    return 'device_permission_denied'
  }
  if (
    s.includes('already in use') || s.includes('device busy') ||
    s.includes('being used by another') || s.includes('resource busy') ||
    s.includes('device or resource busy') || s.includes('audclnt_e_device_in_use') ||
    s.includes('audclnt_e_exclusive_mode_not_allowed') ||
    s.includes('audclnt_e_already_initialized') ||
    s.includes('audclnt_e_wrong_endpoint_type')
  ) {
    return 'device_busy'
  }
  if (s.includes('no space left') || s.includes('disk full') || s.includes('enospc')) {
    return 'disk_full'
  }
  if (
    s.includes('broken pipe') || s.includes('i/o error') || s.includes('input/output') ||
    s.includes('unplugged') || s.includes('audclnt_e_device_invalidated')
  ) {
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

  // WASAPI and non-Windows use stdin for a clean 'q' stop; DirectShow ignores stdin
  const useStdin = input.format === 'wasapi' || process.platform !== 'win32'

  const args: string[] = [
    ...(useStdin ? [] : ['-nostdin']), '-hide_banner',
    // Wall-clock timestamps allow the muxer to align audio and video by their
    // actual capture start time when the two streams are merged into one MP4.
    '-use_wallclock_as_timestamps', '1',
    '-f', input.format,
  ]
  // WASAPI: increase real-time buffer to prevent frame drops under high CPU load or USB latency
  if (input.format === 'wasapi') {
    args.push('-rtbufsize', '50M')
  }
  args.push(
    '-i', input.device,
    '-ar', String(sampleRate),
    '-ac', String(outChannels),
  )
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
    format: input.format,
    onExit: null,
    onProgress: null,
    onSilenceEnd: null,
  }

  let stderrBuf = ''
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  const silenceTimeoutMs = (opts.silenceTimeoutMinutes ?? 5) * 60 * 1000

  proc.stderr?.on('data', (d: Buffer) => {
    const chunk = d.toString()
    // Cap at 64 KB — enough for error classification, prevents growth during long recordings
    stderrBuf = (stderrBuf + chunk).slice(-65536)

    if (opts.stopOnSilence) {
      if (chunk.includes('silence_start')) {
        if (!silenceTimer) {
          silenceTimer = setTimeout(() => {
            silenceTimer = null
            handle.onSilenceEnd?.()
          }, silenceTimeoutMs)
        }
      } else if (chunk.includes('silence_end')) {
        if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null }
      }
    }

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
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null }
    console.log('[native-recorder] ffmpeg exited, code:', code)
    handle.onExit?.(code)
  })

  // Windows DirectShow/WASAPI can take up to 5 s to open USB audio devices,
  // especially on first access or after another app has released the device.
  // macOS AVFoundation can also be slow on first access (privacy prompt, driver init).
  const startupMs = process.platform === 'win32' ? 5000 : 2000

  const startupError = await new Promise<string | null>(resolve => {
    const onClose = () => {
      clearTimeout(timer)
      const classified = classifyFfmpegError(stderrBuf)
      resolve(classified || 'device_error')
    }
    const timer = setTimeout(() => {
      proc.removeListener('close', onClose)
      resolve(null)
    }, startupMs)
    // Use once so the listener is automatically removed after the first close event
    proc.once('close', onClose)
  })

  if (startupError) {
    const sRateErr = stderrBuf.toLowerCase()
    const isSampleRateError = sRateErr.includes('sample rate') ||
      sRateErr.includes('sampling rate') || sRateErr.includes('samplerate') ||
      sRateErr.includes('unsupported sample') || sRateErr.includes('invalid sample')

    // Retry with 48000 Hz if sample rate was different and error suggests rate mismatch
    if (isSampleRateError && (opts.sampleRate ?? 48000) !== 48000) {
      console.warn('[native-recorder] Sample rate error — retrying with 48000 Hz')
      return startCapture({ ...opts, sampleRate: 48000 }, outputPath)
    }

    return { error: startupError }
  }

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

    // WASAPI (Windows) and non-Windows use graceful 'q' via stdin — ffmpeg flushes codec
    // and finalises container before exiting. DirectShow ignores stdin 'q', so SIGTERM is
    // the only reliable stop (Windows TerminateProcess flushes the codec buffer cleanly).
    const useGraceful = handle.format === 'wasapi' || process.platform !== 'win32'

    if (useGraceful) {
      try {
        handle.proc.stdin?.write('q')
        handle.proc.stdin?.end()
      } catch {}

      const killer = setTimeout(() => {
        try { handle.proc.kill('SIGTERM') } catch {}
      }, 10000)

      handle.proc.once('close', () => clearTimeout(killer))
    } else {
      try { handle.proc.kill('SIGTERM') } catch {}
    }
  })
}
