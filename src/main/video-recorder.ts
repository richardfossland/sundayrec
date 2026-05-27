import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { ffmpegBin, resolveVideoInput } from './native-recorder'
import { getWorkingMacConfigIdx, MAC_CONFIGS, buildMacInputArgs } from './video-preview'
import { classifyRecordingError } from './recorder-utils'
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

/** Exported for unit testing and external use. Delegates to the shared
 *  recorder-utils classifier — see comments there. */
export function classifyVideoError(stderr: string): string {
  return classifyRecordingError(stderr)
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
export function buildVideoFilterComplex(dimW: string, dimH: string, flip = false): string {
  const flipPart = flip ? 'hflip,' : ''
  return `[0:v]${flipPart}split=2[v1][v2];[v1]scale=${dimW}:${dimH}:flags=lanczos,format=yuv420p[vout];[v2]scale=640:-2:flags=fast_bilinear[prev]`
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
    inputArgs = ['-use_wallclock_as_timestamps', '1', '-f', input.format, '-rtbufsize', '200M', '-i', input.device]
  }

  const [dimW, dimH] = dims.split('x')
  const args: string[] = [
    '-nostdin', '-hide_banner',
    ...inputArgs,
    '-filter_complex', buildVideoFilterComplex(dimW, dimH, settings.videoFlip ?? false),
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
  // Startup resolver: set to null once resolved so it is called only once.
  // Resolved early by the first size= line (success) or by close event (error).
  let resolveStartup: ((err: string | null) => void) | null = null

  // Watchdog: if no size= progress in stderr within 20 s, the camera opened but
  // is not delivering frames (capture card with no HDMI signal, slow USB camera,
  // or driver hang). Kill the process — recorder.ts onExit handler will recover.
  // This watchdog is independent of startup detection and fires regardless.
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
        // First size= line proves ffmpeg is actively encoding — resolve startup as success
        if (resolveStartup) {
          const r = resolveStartup; resolveStartup = null
          r(null)
        }
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

  // Maximum wait for first video data.
  // We resolve early on the first size= line, so this is only the safety net
  // for devices that open slowly but eventually produce frames.
  // The 20-second hang watchdog (above) handles the case where startup "succeeds"
  // (process alive) but no frames ever arrive.
  const startupMs = process.platform === 'win32' ? 10000 : 6000

  const startupError = await new Promise<string | null>(resolve => {
    resolveStartup = resolve

    const onClose = () => {
      clearTimeout(timer)
      // Only resolve if not already resolved by a size= line
      if (resolveStartup) {
        resolveStartup = null
        const classified = classifyVideoError(stderrBuf)
        resolve(classified || 'device_error')
      }
    }

    const timer = setTimeout(() => {
      proc.removeListener('close', onClose)
      if (resolveStartup) {
        resolveStartup = null
        // Process is still alive but no frames yet — treat as success and let the
        // 20-second hang watchdog handle it if frames never arrive
        if (proc.exitCode !== null || proc.killed) {
          resolve(classifyVideoError(stderrBuf) || 'device_error')
        } else {
          console.warn('[video-recorder] startup timeout — ffmpeg alive but no video data after', startupMs, 'ms; deferring to hang watchdog')
          resolve(null)
        }
      }
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
 * Read the container start_time of a media file using ffmpeg -i (no ffprobe needed).
 * Returns seconds as a float, or null if unavailable.
 *
 * Both audio and video captures use -use_wallclock_as_timestamps 1, so their
 * start_time is a Unix timestamp (> 1_000_000_000). Values below that threshold
 * indicate a file without wall-clock timestamps — we skip alignment in that case.
 */
async function probeStartTimeSec(filePath: string): Promise<number | null> {
  return new Promise(resolve => {
    // ffmpeg -i without an output prints container info then exits with code 1.
    // That's expected — we only need the stderr header dump. `-v verbose`
    // ensures per-stream metadata (including first_dts on each stream) lands
    // in the output so we can fall back when the container-level start_time
    // is missing or wrong.
    const proc = spawn(ffmpegBin, ['-v', 'verbose', '-i', filePath], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-8192) })
    const timeout = setTimeout(() => { try { proc.kill() } catch {}; resolve(null) }, 5000)
    proc.on('close', () => {
      clearTimeout(timeout)
      // Primary: container-level "start:" in the Duration line.
      const m = stderr.match(/Duration:.*?start:\s*([\d.]+)/)
      if (m) {
        const t = parseFloat(m[1])
        if (!isNaN(t) && t > 1_000_000_000) { resolve(t); return }
      }
      // Fallback: first_dts on stream 0 (some containers don't propagate
      // start_time to the metadata header but do tag the first packet).
      const m2 = stderr.match(/first_dts\s*[:=]\s*([\d.]+)/)
      if (m2) {
        const t = parseFloat(m2[1])
        if (!isNaN(t) && t > 1_000_000_000) { resolve(t); return }
      }
      resolve(null)
    })
  })
}

/**
 * Mux a separate audio file + video file into a combined MP4.
 * Video stream is copied losslessly; audio is transcoded to AAC for broad compatibility.
 *
 * A/V sync: both captures use -use_wallclock_as_timestamps 1, so camera warm-up
 * (typically 0.5–3 s) shows up as an offset between the two files' start_time values.
 * We probe both files, compute the difference, and trim the audio to start exactly
 * when the first video frame arrived — giving frame-accurate sync from the first frame.
 */
export async function muxAudioVideo(
  audioPath: string,
  videoPath: string,
  outputPath: string
): Promise<boolean> {
  // ── A/V sync strategy (in order of effectiveness) ──────────────────────
  //
  // 1. Detect start-offset between the two files via container start_time
  //    (both captures use -use_wallclock_as_timestamps, so start_time is a
  //    Unix epoch in seconds). Handle BOTH directions:
  //       videoStart > audioStart → audio led, trim audio's head
  //       audioStart > videoStart → video led, offset audio with -itsoffset
  //    Earlier code only handled the first direction; if a slow audio device
  //    (USB mixer warmup) opened after the camera, the offset was ignored.
  //
  // 2. `aresample=async=1000` on the audio filter: any residual drift over
  //    the recording (audio clock vs video clock differing by parts per
  //    million) is corrected by inserting / dropping samples up to 1000
  //    per second. Inaudible at normal-speech volumes but eliminates the
  //    "lips slowly drift out of sync over 90 minutes" failure mode.
  //
  // 3. `-shortest`: stops the muxer when the shorter input ends, so a
  //    longer audio tail doesn't leave video frozen on the last frame for
  //    seconds after the camera stopped (typical when the audio ffmpeg
  //    closes a few seconds after the video ffmpeg).
  //
  // 4. `-fflags +genpts`: regenerate presentation timestamps uniformly so
  //    any container-level PTS gap (rare but possible after reconnects)
  //    doesn't propagate into the muxed file.
  //
  // Full unified-ffmpeg-pipeline (single ffmpeg opening BOTH camera and
  // mixer via AVFoundation `videoIdx:audioIdx`) is the ideal long-term
  // fix — see docs/USER-TASKS.md for the roadmap. The above gets us
  // close in the meantime.
  const [audioStart, videoStart] = await Promise.all([
    probeStartTimeSec(audioPath),
    probeStartTimeSec(videoPath),
  ])

  let audioTrimSec = 0       // audio started earlier → strip the head
  let audioOffsetSec = 0     // video started earlier → push audio later

  if (audioStart !== null && videoStart !== null) {
    const raw = videoStart - audioStart  // positive ⇒ video lagged audio
    if (raw > 0.05 && raw < 60) {
      audioTrimSec = raw
      console.log(`[video-recorder] A/V offset detected (audio led ${raw.toFixed(3)} s) — trimming audio head`)
    } else if (raw < -0.05 && raw > -60) {
      audioOffsetSec = -raw
      console.log(`[video-recorder] A/V offset detected (video led ${(-raw).toFixed(3)} s) — offsetting audio start`)
    }
  } else {
    console.log('[video-recorder] could not probe start_time on one/both inputs — skipping head-alignment, relying on aresample for drift')
  }

  return new Promise(resolve => {
    const args = ['-nostdin', '-hide_banner', '-fflags', '+genpts']

    // Audio input — optionally trimmed (audio-led case) or offset (video-led case)
    if (audioTrimSec > 0) args.push('-ss', audioTrimSec.toFixed(3))
    if (audioOffsetSec > 0) args.push('-itsoffset', audioOffsetSec.toFixed(3))
    args.push('-i', audioPath)

    args.push('-i', videoPath,
      '-map', '0:a',
      '-map', '1:v',
      '-c:v', 'copy',
      // aresample=async=1000 corrects sample-rate drift incrementally so
      // long recordings stay in sync from start to finish, not just the
      // first frame.
      '-af', 'aresample=async=1000:first_pts=0',
      '-c:a', 'aac', '-b:a', '192k',
      // Earliest PTS normalised to zero after trim/offset.
      '-avoid_negative_ts', 'make_zero',
      // Stop the muxer the instant the shorter input ends — no trailing
      // audio over a frozen last frame.
      '-shortest',
      '-movflags', '+faststart',
      '-y', outputPath,
    )

    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
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
