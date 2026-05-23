import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { ffmpegBin, resolveVideoInput } from './native-recorder'
import { getWorkingMacConfigIdx, MAC_CONFIGS, buildMacInputArgs } from './video-preview'
import type { Settings } from '../types'

export interface VideoHandle {
  proc:         ChildProcess
  outputPath:   string
  startTime:    number
  bytesWritten: number
  format:       string
  onExit:       ((code: number | null) => void) | null
  onProgress:   ((bytes: number) => void) | null
  onFrame:      ((frame: Buffer) => void) | null
}

/** Exported for unit testing. */
export function classifyVideoError(stderr: string): string {
  const s = stderr.toLowerCase()
  if (
    s.includes('device not found') || s.includes('no such') || s.includes('no video') ||
    s.includes('no capture device') || s.includes('avfoundation: device') ||
    s.includes('could not find video') || s.includes('video device not found') ||
    s.includes('no such file or directory') || s.includes('the handle is invalid') ||
    s.includes('no video device') || s.includes('failed to find video')
  ) return 'device_not_found'
  if (
    s.includes('permission') || s.includes('access denied') || s.includes('not permitted') ||
    s.includes('authorization') || s.includes('camera access') || s.includes('privacy') ||
    s.includes('e_accessdenied') || s.includes('tcm_access')
  ) return 'device_permission_denied'
  if (
    s.includes('already in use') || s.includes('device busy') || s.includes('resource busy') ||
    s.includes('device or resource busy') || s.includes('audclnt_e_device_in_use') ||
    s.includes('audclnt_e_exclusive_mode_not_allowed')
  ) return 'device_busy'
  if (s.includes('no space left') || s.includes('disk full') || s.includes('enospc')) return 'disk_full'
  if (
    s.includes('broken pipe') || s.includes('i/o error') || s.includes('input/output') ||
    s.includes('unplugged') || s.includes('audclnt_e_device_invalidated') ||
    s.includes('connection reset') || s.includes('eof')
  ) return 'device_disconnected'
  return 'device_error'
}

/** Exported for unit testing. */
export function resolutionToDimensions(res?: string): string {
  switch (res) {
    case '1080p': return '1920x1080'
    case '480p':  return '854x480'
    default:      return '1280x720'
  }
}

/** Exported for unit testing. */
export function autoBitrate(res?: string): number {
  switch (res) {
    case '1080p': return 8000
    case '480p':  return 1500
    default:      return 4000
  }
}

/**
 * Build the ffmpeg -filter_complex value that splits one input video stream
 * into two outputs: a high-quality H.264 recording stream and a low-rate
 * MJPEG preview stream.
 *
 * The split=2 is critical: without it, ffmpeg rejects multi-output commands
 * that use different -vf filters per output. This function is exported so
 * the formula can be verified in tests — this was the bug that broke video
 * recording in earlier versions.
 *
 * Exported for unit testing.
 */
export function buildVideoFilterComplex(dimW: string, dimH: string): string {
  return `[0:v]split=2[v1][v2];[v1]scale=${dimW}:${dimH}:flags=lanczos,format=yuv420p[vout];[v2]fps=5,scale=640:-2:flags=fast_bilinear[prev]`
}

export async function startVideoCapture(
  settings: Settings,
  outputPath: string
): Promise<VideoHandle | { error: string }> {
  const input = await resolveVideoInput({
    videoDeviceName:  settings.videoDeviceName  ?? null,
    videoDeviceIndex: settings.videoDeviceIndex ?? null,
  })
  if (!input) return { error: 'no_device' }

  const fps     = settings.videoFramerate ?? 30
  const dims    = resolutionToDimensions(settings.videoResolution)
  const bitrate = (settings.videoBitrate && settings.videoBitrate > 0)
    ? settings.videoBitrate
    : autoBitrate(settings.videoResolution)

  // Capture at the device's native resolution and scale in the filter chain.
  // This is more compatible than specifying -video_size in the input:
  //   • Capture cards (Blackmagic ATEM Mini/Pro, Elgato Cam Link, Magewell) output
  //     a fixed HDMI signal format — forcing a different size causes an immediate error.
  //   • WebCams and built-in cameras generally report a default resolution; AVFoundation
  //     and DirectShow both select it automatically when no size is requested.
  // The libx264 output then scales from native → target via lanczos (quality-preserving).
  //
  // macOS AVFoundation: -framerate must precede -i.
  // Windows DirectShow: -rtbufsize prevents frame drops on slow USB buses.
  // Wall-clock timestamps on both audio and video processes allow the muxer
  // to align the two streams by their actual capture start times.
  //
  // On macOS, sync the capture config (framerate + video_size) with the working
  // preview config so we don't retry from scratch on a device that only accepts
  // a specific resolution or framerate.
  let inputArgs: string[]
  if (process.platform === 'darwin') {
    const cfgIdx = getWorkingMacConfigIdx()
    const cfg = MAC_CONFIGS[cfgIdx] ?? MAC_CONFIGS[0]
    console.log(`[video-recorder] using preview config ${cfgIdx} (${cfg.label}) for capture`)
    inputArgs = ['-use_wallclock_as_timestamps', '1', ...buildMacInputArgs(input.format, input.device, cfg)]
  } else {
    inputArgs = ['-use_wallclock_as_timestamps', '1', '-f', input.format, '-rtbufsize', '200M', '-framerate', String(fps), '-i', input.device]
  }

  const [dimW, dimH] = dims.split('x')
  const args: string[] = [
    '-nostdin', '-hide_banner',
    ...inputArgs,
    '-filter_complex', buildVideoFilterComplex(dimW, dimH),
    // Primary output: H.264 recording file
    '-map', '[vout]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${Math.round(bitrate * 1.5)}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-an',
    '-y', outputPath,
    // Secondary output: low-rate MJPEG to stdout for in-recording preview
    '-map', '[prev]',
    '-c:v', 'mjpeg',
    '-q:v', '8',
    '-f', 'mjpeg',
    'pipe:1',
  ]

  console.log('[video-recorder] start:', ffmpegBin, args.map(a => a.includes(' ') ? `"${a}"` : a).join(' '))

  const proc = spawn(ffmpegBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],  // stdout → MJPEG preview frames
    detached: false
  })

  const handle: VideoHandle = {
    proc, outputPath,
    startTime: Date.now(),
    bytesWritten: 0,
    format: input.format,
    onExit: null,
    onProgress: null,
    onFrame: null,
  }

  // Parse MJPEG preview frames from stdout (SOI=FFD8 … EOI=FFD9)
  let previewBuf = Buffer.alloc(0)
  const SOI = Buffer.from([0xff, 0xd8])
  const EOI = Buffer.from([0xff, 0xd9])
  proc.stdout?.on('data', (chunk: Buffer) => {
    previewBuf = Buffer.concat([previewBuf, chunk])
    if (previewBuf.length > 4 * 1024 * 1024) previewBuf = previewBuf.slice(-2 * 1024 * 1024)
    while (true) {
      const soi = previewBuf.indexOf(SOI)
      if (soi < 0) { previewBuf = Buffer.alloc(0); break }
      if (soi > 0) previewBuf = previewBuf.slice(soi)
      const eoi = previewBuf.indexOf(EOI, 2)
      if (eoi < 0) break
      const frame = previewBuf.slice(0, eoi + 2)
      previewBuf = previewBuf.slice(eoi + 2)
      handle.onFrame?.(frame)
    }
  })

  let stderrBuf = ''
  // Watchdog: if no size= progress in stderr within 20 s, the camera opened but
  // is not delivering frames (capture card with no HDMI signal, slow USB camera,
  // or driver hang). Kill the process — recorder.ts onExit handler will recover.
  let firstVideoProgress = false
  const videoHangWatchdog = setTimeout(() => {
    if (!firstVideoProgress && proc.exitCode === null) {
      console.warn('[video-recorder] no video frames in 20 s — camera stuck, killing')
      try { proc.kill('SIGKILL') } catch {}
    }
  }, 20000)

  proc.stderr?.on('data', (d: Buffer) => {
    const chunk = d.toString()
    stderrBuf = (stderrBuf + chunk).slice(-65536)
    const m = chunk.match(/size=\s*(\d+)kB/)
    if (m) {
      if (!firstVideoProgress) {
        firstVideoProgress = true
        clearTimeout(videoHangWatchdog)
      }
      handle.bytesWritten = parseInt(m[1]) * 1024
      handle.onProgress?.(handle.bytesWritten)
    } else if (chunk.trim() && !chunk.includes('Press [q]') && !chunk.includes('time=')) {
      console.log('[video-ffmpeg]', chunk.trimEnd())
    }
  })

  proc.on('close', code => {
    clearTimeout(videoHangWatchdog)
    console.log('[video-recorder] ffmpeg exited, code:', code)
    handle.onExit?.(code)
  })

  // DirectShow takes longer to open devices; AVFoundation also can be slow on first access
  const startupMs = process.platform === 'win32' ? 4000 : 3000
  const startupError = await new Promise<string | null>(resolve => {
    const onClose = () => {
      clearTimeout(timer)
      const classified = classifyVideoError(stderrBuf)
      resolve(classified || 'device_error')
    }
    const timer = setTimeout(() => {
      proc.removeListener('close', onClose)
      resolve(null)
    }, startupMs)
    proc.once('close', onClose)
  })

  if (startupError) return { error: startupError }
  if (proc.exitCode !== null || proc.killed) {
    return { error: classifyVideoError(stderrBuf) || 'device_error' }
  }

  return handle
}

export async function stopVideoCapture(handle: VideoHandle): Promise<void> {
  if (handle.proc.exitCode !== null) return
  return new Promise(resolve => {
    let killer: ReturnType<typeof setTimeout> | null = null
    handle.proc.once('close', () => {
      if (killer) clearTimeout(killer)
      resolve()
    })
    // stdin is 'ignore', so SIGTERM is the only clean stop signal
    try { handle.proc.kill('SIGTERM') } catch {}
    killer = setTimeout(() => {
      try { handle.proc.kill('SIGKILL') } catch {}
    }, 30000)
  })
}

/**
 * Mux a separate audio file + video file into a combined MP4.
 * Video stream is copied losslessly; audio is transcoded to AAC for broad compatibility.
 */
export async function muxAudioVideo(
  audioPath: string,
  videoPath: string,
  outputPath: string
): Promise<boolean> {
  return new Promise(resolve => {
    const proc = spawn(ffmpegBin, [
      '-nostdin', '-hide_banner',
      '-i', audioPath,
      '-i', videoPath,
      '-map', '0:a',
      '-map', '1:v',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k',
      // Preserve wall-clock timestamps from both streams so their relative
      // offset is maintained, then normalize the earliest start to zero.
      '-copyts',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      '-y', outputPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-65536) })
    const timeout = setTimeout(() => {
      try { proc.kill('SIGTERM') } catch {}
      resolve(false)
    }, 30 * 60 * 1000)
    proc.on('close', code => {
      clearTimeout(timeout)
      if (code !== 0) console.error('[video-recorder] mux failed:', stderr.slice(-500))
      resolve(code === 0)
    })
  })
}
