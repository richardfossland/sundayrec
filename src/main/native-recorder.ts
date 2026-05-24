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

// ── Device enumeration cache ────────────────────────────────────────────────

const DEVICE_CACHE_TTL_MS = 120_000

// On macOS and Windows, audio and video devices come from the same ffmpeg
// enumerate call.  Share the result so we only spawn ffmpeg once per TTL window.
interface AllDevices { audio: FfmpegDevice[]; video: FfmpegVideoDevice[] }
let _allDevicesCache: { result: AllDevices; expiresAt: number } | null = null
let _allDevicesInflight: Promise<AllDevices> | null = null

let _wasapiCache: { result: FfmpegDevice[]; expiresAt: number } | null = null
let _wasapiInflight: Promise<FfmpegDevice[]> | null = null

export function invalidateDeviceCache(): void {
  _allDevicesCache = null
  _allDevicesInflight = null
  _wasapiCache = null
  _wasapiInflight = null
}

async function _enumerateAllDevices(): Promise<AllDevices> {
  const now = Date.now()
  if (_allDevicesCache && now < _allDevicesCache.expiresAt) return _allDevicesCache.result
  if (_allDevicesInflight) return _allDevicesInflight

  const p = new Promise<AllDevices>(resolve => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      resolve({ audio: [], video: [] }); return
    }
    const args: string[] = process.platform === 'win32'
      ? ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy', '-hide_banner']
      : ['-f', 'avfoundation', '-list_devices', 'true', '-i', '', '-hide_banner']
    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    let settled = false
    const done = () => {
      if (settled) return; settled = true
      _allDevicesInflight = null
      const result: AllDevices = process.platform === 'win32' ? {
        audio: parseDshowDeviceList(stderr),
        video: parseVideoDshowDeviceList(stderr),
      } : {
        audio: parseAvfoundationDeviceList(stderr),
        video: parseVideoAvfoundationDeviceList(stderr),
      }
      _allDevicesCache = { result, expiresAt: Date.now() + DEVICE_CACHE_TTL_MS }
      resolve(result)
    }
    proc.on('close', done)
    setTimeout(() => { if (!settled) { try { proc.kill() } catch {}; done() } }, 5000)
  })
  _allDevicesInflight = p
  return p
}

// ── Device enumeration ──────────────────────────────────────────────────────

export interface FfmpegDevice { name: string; index: number }

/**
 * Parse WASAPI device list from ffmpeg stderr.
 *
 * Handles all known ffmpeg WASAPI output formats:
 *   Format 1 (ffmpeg 5+): "[wasapi @ ...] WASAPI input device #0 : 'Name'"
 *   Format 2 (older):     "[wasapi @ ...] Device 0: 'Name'"
 *   Format 3 (double quot): same as above but with "Name"
 *   Format 4 (legacy):    "[wasapi @ ...] "Name""
 *
 * Exported for unit testing — this is a pure string-in / array-out function.
 */
export function parseWasapiDeviceList(stderr: string): FfmpegDevice[] {
  const devices: FfmpegDevice[] = []
  for (const line of stderr.split('\n')) {
    if (line.includes('Alternative name') || line.includes('@device_')) continue
    let name: string | undefined
    // Matches "... device #N : 'Name'" — case-insensitive so "Device", "device",
    // "WASAPI input device" all match. The [#]? handles both "0:" and "#0:".
    const m1 = line.match(/device\s*[#]?\s*\d+\s*:\s*'([^']+)'/i)
    const m2 = !m1 ? line.match(/device\s*[#]?\s*\d+\s*:\s*"([^"]+)"/i) : null
    // Legacy: "[wasapi @ addr] "Name"" with no device-number prefix
    const m3 = !m1 && !m2 ? line.match(/\[wasapi\s*@[^\]]+\]\s*"([^"{}@][^"]*)"/) : null
    if      (m1) name = m1[1].trim()
    else if (m2) name = m2[1].trim()
    else if (m3 && !m3[1].startsWith('{')) name = m3[1].trim()
    if (name && name.length > 1 && !devices.find(d => d.name === name)) {
      devices.push({ name, index: devices.length })
    }
  }
  return devices
}

/**
 * Parse DirectShow device list from ffmpeg stderr.
 * Exported for unit testing.
 */
export function parseDshowDeviceList(stderr: string): FfmpegDevice[] {
  const devices: FfmpegDevice[] = []
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
  return devices
}

/**
 * Parse AVFoundation audio device list from ffmpeg stderr.
 * Only returns devices from the audio section (not video) — both sections
 * use [0], [1], ... indices so mixing them would produce wrong index mappings.
 * Exported for unit testing.
 */
export function parseAvfoundationDeviceList(stderr: string): FfmpegDevice[] {
  const devices: FfmpegDevice[] = []
  let inAudioSection = false
  for (const line of stderr.split('\n')) {
    if (line.includes('AVFoundation audio devices')) { inAudioSection = true; continue }
    if (line.includes('AVFoundation video devices')) { inAudioSection = false; continue }
    if (!inAudioSection) continue
    const m = line.match(/\[(\d+)\]\s+(.+)/)
    if (m) devices.push({ index: parseInt(m[1]), name: m[2].trim() })
  }
  return devices
}

export async function listFfmpegDevices(): Promise<FfmpegDevice[]> {
  return (await _enumerateAllDevices()).audio
}

// ── WASAPI detection (cached for process lifetime) ──────────────────────────

let _wasapiAvailable: boolean | null = null

export async function probeWasapiAvailable(): Promise<boolean> {
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

export async function listWasapiDevices(): Promise<FfmpegDevice[]> {
  if (process.platform !== 'win32') return []
  const now = Date.now()
  if (_wasapiCache && now < _wasapiCache.expiresAt) return _wasapiCache.result
  if (_wasapiInflight) return _wasapiInflight

  const p = new Promise<FfmpegDevice[]>(resolve => {
    const proc = spawn(ffmpegBin, ['-f', 'wasapi', '-list_devices', 'true', '-i', 'dummy', '-hide_banner'], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    let settled = false
    const done = () => {
      if (settled) return; settled = true
      _wasapiInflight = null
      const devices = parseWasapiDeviceList(stderr)
      console.log(`[native-recorder] WASAPI enumeration: found ${devices.length} devices`, devices.map(d => d.name))
      _wasapiCache = { result: devices, expiresAt: Date.now() + DEVICE_CACHE_TTL_MS }
      resolve(devices)
    }
    proc.on('close', done)
    proc.on('error', () => { if (!settled) { settled = true; _wasapiInflight = null; resolve([]) } })
    setTimeout(() => { if (!settled) { try { proc.kill() } catch {}; done() } }, 5000)
  })
  _wasapiInflight = p
  return p
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

/** Exported for testing. All internal callers use this directly. */
export function findBestDeviceMatch(devices: FfmpegDevice[], name: string): FfmpegDevice | undefined {
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

// ASIO was previously listed here but never actually implemented —
// selecting an ASIO driver silently fell back to WASAPI/DirectShow,
// misleading users who expected real ASIO capture. Removed in v4.22.9.
// The IPC stub returns [] so the renderer simply shows no ASIO section.
export async function listAsioDrivers(): Promise<string[]> { return [] }

// ── Device input resolution ─────────────────────────────────────────────────

export async function resolveDeviceInput(
  opts: RecordingOpts
): Promise<{ format: string; device: string; resolvedName: string } | null> {
  const name = (opts.deviceName ?? '').trim()

  if (process.platform === 'win32') {
    const dshowDevices = await listFfmpegDevices()
    console.log(`[native-recorder] stored name: "${name}"`)
    console.log(`[native-recorder] DirectShow devices: [${dshowDevices.map(d => `"${d.name}"`).join(', ')}]`)

    const dshowMatch = dshowDevices.length ? (findBestDeviceMatch(dshowDevices, name) ?? dshowDevices[0]) : null

    if (await probeWasapiAvailable()) {
      const wasapiDevices = await listWasapiDevices()

      if (wasapiDevices.length > 0) {
        const wasapiMatch = findBestDeviceMatch(wasapiDevices, name) ?? wasapiDevices[0]
        console.log(`[native-recorder] using WASAPI device: "${wasapiMatch.name}" (from ${wasapiDevices.length} WASAPI devices)`)
        return { format: 'wasapi', device: wasapiMatch.name, resolvedName: wasapiMatch.name }
      }

      // WASAPI list empty — fall through to DirectShow
      console.warn('[native-recorder] WASAPI list empty — falling through to DirectShow')
    }

    // DirectShow path
    if (!dshowMatch) {
      if (!dshowDevices.length) return null
      console.warn(`[native-recorder] No match for "${name}" — using first DirectShow device: "${dshowDevices[0].name}"`)
      return { format: 'dshow', device: `audio="${dshowDevices[0].name}"`, resolvedName: dshowDevices[0].name }
    }
    return { format: 'dshow', device: `audio="${dshowMatch.name}"`, resolvedName: dshowMatch.name }
  }

  if (process.platform === 'darwin') {
    const devices = await listFfmpegDevices()
    if (!devices.length) return { format: 'avfoundation', device: ':0', resolvedName: 'default' }
    const match = name ? findBestDeviceMatch(devices, name) : devices[0]
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

/**
 * Parse DirectShow VIDEO device list from ffmpeg stderr.
 * Only returns devices from the video section (before "DirectShow audio devices").
 * Exported for unit testing.
 */
export function parseVideoDshowDeviceList(stderr: string): FfmpegVideoDevice[] {
  const devices: FfmpegVideoDevice[] = []
  let inVideoSection = true  // dshow output starts with video devices
  for (const line of stderr.split('\n')) {
    if (line.toLowerCase().includes('directshow audio devices')) { inVideoSection = false; continue }
    if (!inVideoSection || line.includes('Alternative name')) continue
    const m = line.match(/"([^"]+)"/)
    if (m && !m[1].startsWith('@')) {
      const name = m[1]
      if (!devices.find(d => d.name === name)) devices.push({ name, index: devices.length })
    }
  }
  return devices
}

/**
 * Parse AVFoundation VIDEO device list from ffmpeg stderr.
 * Only returns devices from the video section (stops at audio section).
 * Exported for unit testing.
 */
export function parseVideoAvfoundationDeviceList(stderr: string): FfmpegVideoDevice[] {
  const devices: FfmpegVideoDevice[] = []
  let inVideoSection = false
  for (const line of stderr.split('\n')) {
    if (line.includes('AVFoundation video devices')) { inVideoSection = true; continue }
    if (line.includes('AVFoundation audio devices')) { inVideoSection = false; continue }
    if (!inVideoSection) continue
    const m = line.match(/\[(\d+)\]\s+(.+)/)
    if (m) devices.push({ index: parseInt(m[1]), name: m[2].trim() })
  }
  return devices
}

export async function listVideoFfmpegDevices(): Promise<FfmpegVideoDevice[]> {
  return (await _enumerateAllDevices()).video
}

/** Exported for unit testing. */
export function findBestVideoDeviceMatch(devices: FfmpegVideoDevice[], name: string): FfmpegVideoDevice | undefined {
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

async function _resolveVideoInputImpl(
  opts: { videoDeviceName?: string | null; videoDeviceIndex?: number | null }
): Promise<{ format: string; device: string; resolvedName: string } | null> {
  if (process.platform === 'darwin') {
    // Always enumerate current devices — indices can change after camera reconnect.
    // Prefer name-based match; fall back to stored index only if name lookup fails.
    const devices = await listVideoFfmpegDevices()
    if (!devices.length) return null

    const name = (opts.videoDeviceName ?? '').trim()
    const byName = name ? findBestVideoDeviceMatch(devices, name) : null
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
    const match = name ? findBestVideoDeviceMatch(devices, name) : devices[0]
    const resolved = match ?? devices[0]
    return { format: 'dshow', device: `video="${resolved.name}"`, resolvedName: resolved.name }
  }

  return null
}

/**
 * Resolve a video input device with a 5-second timeout.
 * If enumeration hangs (e.g. driver issues), returns null rather than blocking the app.
 */
export async function resolveVideoInput(
  opts: { videoDeviceName?: string | null; videoDeviceIndex?: number | null }
): Promise<{ format: string; device: string; resolvedName: string } | null> {
  return Promise.race([
    _resolveVideoInputImpl(opts),
    new Promise<null>(resolve => setTimeout(() => {
      console.warn('[native-recorder] resolveVideoInput timed out after 5s')
      resolve(null)
    }, 5000))
  ])
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

// Classify ffmpeg stderr into a user-facing error code. Exported for testing.
export function classifyFfmpegError(stderr: string): string {
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

// 'startup_timeout' is a synthetic error code (not from ffmpeg stderr) used when
// ffmpeg starts successfully but produces no audio data within the startup window.
// The retry logic treats it the same as 'device_error' — triggers format fallback.
const STARTUP_TIMEOUT_ERROR = 'startup_timeout'

async function startCaptureWithInput(
  input: { format: string; device: string; resolvedName: string },
  opts: RecordingOpts,
  outputPath: string,
  isRetry = false
): Promise<NativeHandle | { error: string }> {
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
  // WASAPI default device: use ':' syntax (empty string is invalid in WASAPI)
  const deviceArg = input.format === 'wasapi' && input.device === '' ? ':' : input.device
  args.push(
    '-i', deviceArg,
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

  // Startup resolver: called either by the first size= line (success) or by
  // the close event (error) or by the timeout (startup_timeout / null).
  // Set to null once resolved so it is only called once.
  let resolveStartup: ((err: string | null) => void) | null = null

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
      // First size= line proves ffmpeg is actively encoding — resolve startup as success
      if (resolveStartup) {
        const r = resolveStartup; resolveStartup = null
        r(null)
      }
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

  // Maximum wait for first audio data.
  // Increased from 5 s (Windows) / 2 s (macOS) because:
  //   - Slow USB audio interfaces on Windows can take 6–7 s to initialize
  //   - We now resolve *early* on first size= line, so the timeout is only a
  //     safety net — typical fast devices still start in <2 s
  const startupMs = process.platform === 'win32' ? 10000 : 5000

  const startupError = await new Promise<string | null>(resolve => {
    resolveStartup = resolve

    const onClose = () => {
      clearTimeout(timer)
      // Only resolve if not already resolved by a size= line
      if (resolveStartup) {
        resolveStartup = null
        const classified = classifyFfmpegError(stderrBuf)
        resolve(classified || 'device_error')
      }
    }

    const timer = setTimeout(() => {
      proc.removeListener('close', onClose)
      if (resolveStartup) {
        resolveStartup = null
        // Process is still alive but produced no audio data — hung driver / muted input
        if (proc.exitCode !== null || proc.killed) {
          resolve(classifyFfmpegError(stderrBuf) || 'device_error')
        } else {
          console.warn('[native-recorder] startup timeout — ffmpeg alive but no audio data after', startupMs, 'ms')
          resolve(STARTUP_TIMEOUT_ERROR)
        }
      }
    }, startupMs)

    // Use once so the listener is automatically removed after the first close event
    proc.once('close', onClose)
  })

  if (startupError) {
    const sRateErr = stderrBuf.toLowerCase()
    const isSampleRateError = sRateErr.includes('sample rate') ||
      sRateErr.includes('sampling rate') || sRateErr.includes('samplerate') ||
      sRateErr.includes('unsupported sample') || sRateErr.includes('invalid sample')

    // Sample rate fallback: try multiple common rates.
    // Skip for startup_timeout — that is a hang, not a sample rate rejection.
    if (isSampleRateError && startupError !== STARTUP_TIMEOUT_ERROR && !opts._sampleRateRetried) {
      const commonRates = [48000, 44100, 96000, 16000]
      const currentRate = opts.sampleRate ?? 48000
      const nextRate = commonRates.find(r => r !== currentRate)
      if (nextRate) {
        console.warn(`[native-recorder] Sample rate ${currentRate}Hz not supported — retrying with ${nextRate}Hz`)
        return startCaptureWithInput(input, { ...opts, sampleRate: nextRate, _sampleRateRetried: true }, outputPath, true)
      }
    }

    // Multi-format retry on Windows (only on first attempt to avoid infinite loop).
    // startup_timeout means the process is alive but silent — kill it first, then retry.
    if (process.platform === 'win32' && !isRetry) {
      if (startupError === STARTUP_TIMEOUT_ERROR) {
        // Kill the hung process before retrying with the alternate format
        try { proc.kill('SIGTERM') } catch {}
      }
      // If WASAPI fails → retry with DirectShow
      if (input.format === 'wasapi') {
        const dshowDevices = await listFfmpegDevices()
        if (dshowDevices.length > 0) {
          const dshowMatch = findBestDeviceMatch(dshowDevices, opts.deviceName ?? '') ?? dshowDevices[0]
          console.warn(`[native-recorder] WASAPI failed (${startupError}) — retrying with DirectShow: "${dshowMatch.name}"`)
          return startCaptureWithInput(
            { format: 'dshow', device: `audio="${dshowMatch.name}"`, resolvedName: dshowMatch.name },
            opts, outputPath, true
          )
        }
      }
      // If DirectShow fails → retry with WASAPI default device
      if (input.format === 'dshow') {
        if (await probeWasapiAvailable()) {
          console.warn(`[native-recorder] DirectShow failed (${startupError}) — retrying with WASAPI default device`)
          return startCaptureWithInput(
            { format: 'wasapi', device: '', resolvedName: 'default' },
            opts, outputPath, true
          )
        }
      }
    }

    // For startup_timeout on a non-retried non-Windows path, kill the hung process
    if (startupError === STARTUP_TIMEOUT_ERROR && proc.exitCode === null && !proc.killed) {
      try { proc.kill('SIGTERM') } catch {}
    }

    return { error: startupError }
  }

  // Guard: process might have exited cleanly during the startup window (race condition).
  // The close event already fired, handle.onExit was not set yet → zombie session.
  if (proc.exitCode !== null || proc.killed) {
    console.error('[native-recorder] process already exited after startup window, exitCode:', proc.exitCode)
    return { error: classifyFfmpegError(stderrBuf) || 'device_error' }
  }

  // ── Audio progress watchdog (Task 2) ────────────────────────────────────────
  // After successful startup, watch for stalled audio data. A hung USB audio
  // driver can keep ffmpeg alive while silently producing zero bytes — this
  // watchdog kills the process so the existing onExit recovery path can restart.
  let lastWatchdogBytes = handle.bytesWritten
  let stagnantChecks = 0
  const hangWatchdog = setInterval(() => {
    if (proc.exitCode !== null || proc.killed) { clearInterval(hangWatchdog); return }
    if (handle.bytesWritten > lastWatchdogBytes) {
      lastWatchdogBytes = handle.bytesWritten
      stagnantChecks = 0
    } else {
      stagnantChecks++
      if (stagnantChecks >= 2) {
        // No audio progress for ≥ 60 s — driver is hung
        clearInterval(hangWatchdog)
        console.warn('[native-recorder] audio progress stalled 60s — killing hung process')
        try { proc.kill('SIGTERM') } catch {}
      }
    }
  }, 30000)

  proc.on('close', () => clearInterval(hangWatchdog))

  return handle
}

export async function startCapture(
  opts: RecordingOpts,
  outputPath: string
): Promise<NativeHandle | { error: string }> {
  const input = await resolveDeviceInput(opts)
  if (!input) return { error: 'no_device' }
  return startCaptureWithInput(input, opts, outputPath)
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
