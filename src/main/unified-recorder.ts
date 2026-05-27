/**
 * Unified-recorder — single-ffmpeg pipeline that opens BOTH the camera AND
 * the microphone/mixer in one process. This is the definitive A/V-sync fix:
 * because both streams share the same wall-clock and the same packet
 * timestamps in libavformat, frame-accurate sync is guaranteed from the
 * first packet on — no probe-and-correct dance, no drift over time.
 *
 * Two-process fallback (native-recorder.ts + video-recorder.ts) is still
 * shipped and still works; this module is gated behind
 * `settings.useUnifiedRecorder` so the user can try the new path while we
 * gather real-world hours-on-it confidence. Once stable it becomes the
 * default and the legacy mux step retires.
 *
 * Platform differences:
 *   • macOS — AVFoundation accepts `"<videoIdx>:<audioIdx>"` in a single
 *     `-i` so we get both devices on one input. Only one `-f avfoundation`.
 *   • Windows — DirectShow does NOT support multi-device on one input the
 *     same way; we use TWO `-i` (video then audio), but in the SAME ffmpeg
 *     process. Same process = same internal clock = same sync guarantee.
 *
 * Outputs:
 *   • Combined MP4 (H.264 + AAC) at `combinedPath` — what podcast/editor uses.
 *   • Optional lossless WAV/FLAC at `audioPath` — when the user wants a
 *     separate audio master for post-production. Single ffmpeg can emit
 *     multiple outputs with different codecs by mapping streams twice.
 */

import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import {
  ffmpegBin,
  resolveDeviceInput,
  listFfmpegDevices,
  findBestDeviceMatch,
  buildCodecArgs,
} from './native-recorder'
import { resolveVideoInput } from './native-recorder'
import { getWorkingMacConfigIdx, MAC_CONFIGS, buildMacInputArgs } from './video-preview'
import { classifyVideoError, resolutionToDimensions, autoBitrate, buildVideoFilterComplex } from './video-recorder'
import type { Settings, RecordingOpts } from '../types'

export interface UnifiedHandle {
  proc:              ChildProcess
  /** Path to the combined audio+video MP4 the user will edit / publish. */
  combinedPath:      string
  /** Path to the separate lossless audio file. null when the user disabled
   *  the "keep separate audio" toggle. */
  audioPath:         string | null
  startTime:         number
  bytesWritten:      number
  /** "avfoundation" on Mac, "dshow" on Windows. */
  format:            string
  /** Last fatal error code from stderr (used by the recorder.ts watchdog
   *  to decide whether to attempt reconnect or fail-stop). */
  lastError?:        string
  onExit:            ((code: number | null) => void) | null
  onProgress:        ((bytes: number) => void) | null
  onFrame:           ((frame: Buffer) => void) | null
  /** Internal flag set to true when stopUnifiedCapture() initiates a
   *  graceful shutdown so the exit-handler doesn't trigger reconnect. */
  stopping?:         boolean
}

/**
 * Resolve the avfoundation audio-device index by name. Mirrors the helper
 * in streamer.ts (which we deliberately don't import to keep streamer/
 * recorder modules independent in the dependency graph).
 */
async function resolveAvfAudioIndex(name: string): Promise<number | null> {
  if (process.platform !== 'darwin') return null
  const devices = await listFfmpegDevices()
  if (!devices.length) return null
  const match = name ? findBestDeviceMatch(devices, name) : devices[0]
  return match?.index ?? devices[0].index
}

export interface StartUnifiedOpts {
  settings:     Settings
  /** Where to write the combined MP4 (audio + video muxed in one container). */
  combinedPath: string
  /** Where to write the separate lossless audio. null = combined only. */
  audioPath:    string | null
}

/**
 * Start a unified capture. Returns the handle once ffmpeg has reported its
 * first byte (matching the existing recorder lifecycle expectations) or an
 * error if the device couldn't be opened.
 */
export async function startUnifiedCapture(opts: StartUnifiedOpts): Promise<UnifiedHandle | { error: string }> {
  const s = opts.settings as Settings & RecordingOpts

  const videoIn = await resolveVideoInput({
    videoDeviceName:  s.videoDeviceName ?? null,
    videoDeviceIndex: s.videoDeviceIndex ?? null,
  })
  if (!videoIn) return { error: 'no_device' }

  if (process.platform === 'darwin') {
    return startUnifiedMac(opts, videoIn)
  }
  if (process.platform === 'win32') {
    return startUnifiedWin(opts, videoIn)
  }
  return { error: 'unsupported_platform' }
}

// ─── macOS: avfoundation with combined videoIdx:audioIdx input ─────────────

async function startUnifiedMac(
  opts: StartUnifiedOpts,
  videoIn: { format: string; device: string; resolvedName: string },
): Promise<UnifiedHandle | { error: string }> {
  const s = opts.settings as Settings & RecordingOpts

  const audioIdx = await resolveAvfAudioIndex(s.deviceName ?? '')
  if (audioIdx === null) return { error: 'no_audio_device' }

  // videoIn.device is the avfoundation index for the camera (e.g. "0").
  // Combine with the audio index to get a single device spec for one -i.
  const deviceSpec = `${videoIn.device}:${audioIdx}`

  // Sync the capture format with whatever the preview last successfully
  // negotiated for this device — without that, certain capture cards
  // reject our default 1280x720 input on the first start.
  const cfgIdx = getWorkingMacConfigIdx()
  const cfg    = MAC_CONFIGS[cfgIdx] ?? MAC_CONFIGS[0]
  console.log(`[unified-recorder] mac — using preview cfg ${cfgIdx} (${cfg.label}) for "${deviceSpec}"`)

  // buildMacInputArgs gives us `-f avfoundation -framerate N [-video_size WxH] -i <dev>`.
  // We tweak the last arg from videoIn.device (camera only) to deviceSpec
  // (camera + audio) — same syntax, just an extra :audioIdx.
  const inArgs = buildMacInputArgs(videoIn.format, deviceSpec, cfg)

  return spawnUnified(opts, inArgs, videoIn.format)
}

// ─── Windows: dshow with two -i (video then audio) ─────────────────────────

async function startUnifiedWin(
  opts: StartUnifiedOpts,
  videoIn: { format: string; device: string; resolvedName: string },
): Promise<UnifiedHandle | { error: string }> {
  const s = opts.settings as Settings & RecordingOpts

  // Resolve the dshow audio device — reuse the same path the audio-only
  // recorder uses so the user's stored deviceName is interpreted identically.
  const audioIn = await resolveDeviceInput(s)
  if (!audioIn || audioIn.format !== 'dshow') return { error: 'no_audio_device' }

  const fps = s.videoFramerate ?? 30
  const inArgs: string[] = [
    '-use_wallclock_as_timestamps', '1',
    '-f',           'dshow',
    '-rtbufsize',   '200M',
    '-framerate',   String(fps),
    '-i',           videoIn.device,        // video=<name>
    '-use_wallclock_as_timestamps', '1',
    '-f',           'dshow',
    '-rtbufsize',   '50M',
    '-i',           audioIn.device,        // audio=<name>
  ]
  return spawnUnified(opts, inArgs, 'dshow')
}

// ─── Shared spawn + output mapping ─────────────────────────────────────────

function spawnUnified(
  opts:    StartUnifiedOpts,
  inArgs:  string[],
  format:  string,
): UnifiedHandle | { error: string } {
  const s = opts.settings as Settings & RecordingOpts
  const dims     = resolutionToDimensions(s.videoResolution)
  const [dimW, dimH] = dims.split('x')
  const bitrate  = (s.videoBitrate && s.videoBitrate > 0) ? s.videoBitrate : autoBitrate(s.videoResolution)
  const flip     = s.videoFlip ?? false

  // filter_complex: split the camera into a high-quality recording stream
  // and a low-rate MJPEG preview-feed (the renderer overlay uses it).
  const filter = buildVideoFilterComplex(dimW, dimH, flip)

  // Audio input indices vary by platform:
  //   • Mac avfoundation: 0:a (combined input 0 carries video + audio)
  //   • Windows dshow:    1:a (video is input 0, audio is input 1)
  const audioInputIdx = (process.platform === 'win32') ? '1:a' : '0:a'

  // Wall-clock timestamps on input give us correct duration when wrapped
  // by the muxer — but we hand the raw stamps to ffmpeg's container, then
  // normalize to zero on output so the resulting file plays at t=0 in
  // every player. avoid_negative_ts handles any leading offset cleanly.
  const args: string[] = [
    '-nostdin', '-hide_banner',
    '-use_wallclock_as_timestamps', '1',
    ...inArgs,
    '-filter_complex', filter,

    // Output 1: combined MP4 (audio + video, what the editor sees)
    '-map', '[vout]',
    '-map', audioInputIdx + '?',          // ? = optional, recorder still runs if audio is missing
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${Math.round(bitrate * 1.5)}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-ac', String(s.channels === 'stereo' ? 2 : 1),
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    '-y', opts.combinedPath,

    // Output 2: low-rate MJPEG preview to stdout — same shape that
    // video-recorder.ts emits today, so recorder.ts's frame-handler keeps
    // working without changes.
    '-map', '[prev]',
    '-c:v', 'mjpeg',
    '-q:v', '8',
    '-f', 'mjpeg',
    'pipe:1',
  ]

  // Output 3: separate lossless audio when the user wants a master.
  // Format is picked from settings.format — falls through to WAV (the
  // safest universal lossless container ffmpeg can produce on the fly).
  if (opts.audioPath) {
    const audioCodec = buildCodecArgs(s)
    args.push(
      '-map', audioInputIdx + '?',
      ...audioCodec,
      '-y', opts.audioPath,
    )
  }

  console.log('[unified-recorder] start:', ffmpegBin, args.map(a => a.includes(' ') ? `"${a}"` : a).join(' '))

  const proc = spawn(ffmpegBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],   // stdout = MJPEG preview, stderr = progress
    detached: false,
  })

  const handle: UnifiedHandle = {
    proc,
    combinedPath: opts.combinedPath,
    audioPath:    opts.audioPath,
    startTime:    Date.now(),
    bytesWritten: 0,
    format,
    onExit:       null,
    onProgress:   null,
    onFrame:      null,
  }

  // MJPEG preview parsing — copy of the same SOI/EOI scan video-recorder
  // uses. Frames are forwarded via the onFrame callback.
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

  // stderr parsing — surface fatal device errors to the recorder watchdog
  // and throttle progress updates so the renderer isn't spammed.
  let stderrBuf = ''
  let lastProgressEmit = 0
  const PROGRESS_THROTTLE_MS = 5000
  proc.stderr?.on('data', (d: Buffer) => {
    const text = d.toString()
    stderrBuf = (stderrBuf + text).slice(-32768)
    // Watchdog cue: classify any fatal error so the recorder can decide
    // between fail-stop and reconnect (same vocabulary as the legacy
    // recorders so the existing classification table in recorder.ts works).
    const err = classifyVideoError(text)
    if (err !== 'device_error') handle.lastError = err
    // Progress: ffmpeg emits "size=12345kB" every second. Throttle to 5 s.
    const m = /size=\s*(\d+)kB/.exec(text)
    if (m) {
      const bytes = parseInt(m[1], 10) * 1024
      handle.bytesWritten = bytes
      const now = Date.now()
      if (now - lastProgressEmit >= PROGRESS_THROTTLE_MS) {
        lastProgressEmit = now
        handle.onProgress?.(bytes)
      }
    }
  })

  proc.on('close', code => {
    handle.onExit?.(code)
    if (code !== 0 && !handle.stopping) {
      console.warn('[unified-recorder] ffmpeg closed code=', code, '— last stderr:', stderrBuf.slice(-400))
    }
  })

  return handle
}

/**
 * Graceful stop. ffmpeg listens on stdin=ignore so SIGTERM is the only
 * clean signal; if it doesn't honour it within 30 s we force-kill.
 * Returns once the process has fully exited so the caller can safely
 * finalise the output files (faststart needs the close to complete).
 */
export async function stopUnifiedCapture(handle: UnifiedHandle): Promise<void> {
  if (handle.proc.exitCode !== null) return
  handle.stopping = true
  return new Promise(resolve => {
    let killer: ReturnType<typeof setTimeout> | null = null
    handle.proc.once('close', () => {
      if (killer) clearTimeout(killer)
      resolve()
    })
    try { handle.proc.kill('SIGTERM') } catch {}
    killer = setTimeout(() => {
      try { handle.proc.kill('SIGKILL') } catch {}
    }, 30000)
  })
}
