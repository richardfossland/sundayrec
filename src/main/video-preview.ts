/**
 * video-preview — low-framerate MJPEG preview stream from the video device.
 *
 * Architecture: ffmpeg captures from the camera and outputs raw MJPEG to stdout.
 * The main process parses individual JPEG frames (SOI/EOI markers) and pushes
 * each frame as a Buffer to the renderer via IPC ('video-preview-frame').
 *
 * Preview is always stopped before a recording starts so the device is free.
 * It auto-restarts after the session ends (if still enabled).
 *
 * Device compatibility — macOS AVFoundation:
 *   Different capture devices have different requirements for -framerate and
 *   -video_size. We try a series of configurations in order:
 *     1. No -video_size, 30fps  → capture cards (Blackmagic ATEM, Elgato, etc.)
 *     2. 1280×720, 30fps        → FaceTime HD, built-in MacBook cameras
 *     3. 1920×1080, 30fps       → higher-res webcams (Logitech BRIO, etc.)
 *     4. No -video_size, 25fps  → PAL capture cards with 25fps HDMI signal
 *     5. 1920×1080, 25fps       → PAL 1080p capture (Blackmagic in EU regions)
 *     6. 1280×720, 25fps        → PAL 720p cameras
 *   If a config causes ffmpeg to exit in < 3 s with a format/framerate error,
 *   we automatically retry with the next config — no user action required.
 */

import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import type { BrowserWindow } from 'electron'
import { ffmpegBin, resolveVideoInput } from './native-recorder'

interface PreviewHandle {
  proc:    ChildProcess
  stopped: boolean
}

let active: PreviewHandle | null = null

// ── macOS AVFoundation config candidates ────────────────────────────────────

interface MacConfig {
  fps:  number
  size: string | null   // null = let device choose its native resolution
  label: string
}

const MAC_CONFIGS: MacConfig[] = [
  // Capture cards (Blackmagic ATEM Mini/Pro, Elgato Cam Link, Magewell, etc.)
  // output a fixed HDMI signal — let AVFoundation use whatever the card reports.
  { fps: 30, size: null,        label: 'native@30fps'  },
  // FaceTime HD and most built-in MacBook cameras require an explicit size.
  { fps: 30, size: '1280x720',  label: '720p@30fps'    },
  // Higher-res webcams (Logitech BRIO 4K, Razer Kiyo Pro, etc.)
  { fps: 30, size: '1920x1080', label: '1080p@30fps'   },
  // Capture cards with a PAL (25 fps) HDMI signal from cameras in EU regions.
  { fps: 25, size: null,        label: 'native@25fps'  },
  { fps: 25, size: '1920x1080', label: '1080p@25fps'   },
  { fps: 25, size: '1280x720',  label: '720p@25fps'    },
]

function buildMacInputArgs(format: string, device: string, cfg: MacConfig): string[] {
  const a: string[] = ['-f', format, '-framerate', String(cfg.fps)]
  if (cfg.size) a.push('-video_size', cfg.size)
  a.push('-i', device)
  return a
}

/**
 * Returns true when ffmpeg stderr indicates the device doesn't support the
 * requested resolution or framerate — i.e. we should retry with a different config.
 */
function isDeviceFormatError(stderr: string): boolean {
  const s = stderr.toLowerCase()
  return (
    s.includes('video_size must be') ||
    s.includes('selected videosize') ||
    s.includes('supported modes:') ||
    (s.includes('selected framerate') && s.includes('not supported'))
  )
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function startPreview(
  opts: { videoDeviceName?: string | null; videoDeviceIndex?: number | null; videoFramerate?: number },
  win: BrowserWindow,
  _macConfigIdx = 0   // internal retry index — callers pass only opts + win
): Promise<boolean> {
  stopPreview()

  const input = await resolveVideoInput({
    videoDeviceName:  opts.videoDeviceName  ?? null,
    videoDeviceIndex: opts.videoDeviceIndex ?? null,
  })
  if (!input) return false

  // Output at 10 fps — sufficient for live monitoring, keeps IPC + CPU load low.
  const previewFps = 10

  let inputArgs: string[]
  if (process.platform === 'darwin') {
    const cfg = MAC_CONFIGS[_macConfigIdx] ?? MAC_CONFIGS[MAC_CONFIGS.length - 1]
    inputArgs = buildMacInputArgs(input.format, input.device, cfg)
    console.log(`[video-preview] config ${_macConfigIdx} (${cfg.label})`)
  } else {
    // Windows DirectShow: rtbufsize prevents frame drops on slow USB buses.
    // No -video_size here — DirectShow negotiates with the driver automatically.
    inputArgs = ['-f', input.format, '-rtbufsize', '50M', '-i', input.device]
  }

  const args: string[] = [
    '-hide_banner',
    ...inputArgs,
    '-vf', `fps=${previewFps},scale=640:360:flags=fast_bilinear,format=yuvj420p`,
    '-c:v', 'mjpeg',
    '-q:v', '5',
    '-f', 'mjpeg',
    'pipe:1',
  ]

  console.log('[video-preview] start:', ffmpegBin, args.map(a => a.includes(' ') ? `"${a}"` : a).join(' '))

  const proc = spawn(ffmpegBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  })

  let stderrBuf = ''
  proc.stderr?.on('data', (d: Buffer) => {
    stderrBuf += d.toString()
    const lines = d.toString().split('\n')
    for (const line of lines) {
      if (line.includes('Error') || line.includes('error') || line.includes('No such') || line.includes('Invalid')) {
        console.warn('[video-preview] ffmpeg:', line.trim())
      }
    }
  })

  const handle: PreviewHandle = { proc, stopped: false }
  active = handle
  const startMs = Date.now()

  // Parse MJPEG stream: each frame is a complete JPEG (SOI=FFD8…EOI=FFD9)
  let buf = Buffer.alloc(0)
  const SOI = Buffer.from([0xff, 0xd8])
  const EOI = Buffer.from([0xff, 0xd9])

  proc.stdout?.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    if (buf.length > 4 * 1024 * 1024) buf = buf.slice(-2 * 1024 * 1024)

    while (true) {
      const soi = buf.indexOf(SOI)
      if (soi < 0) { buf = Buffer.alloc(0); break }
      if (soi > 0) buf = buf.slice(soi)

      const eoi = buf.indexOf(EOI, 2)
      if (eoi < 0) break

      const frame = buf.slice(0, eoi + 2)
      buf = buf.slice(eoi + 2)

      if (!handle.stopped && !win.isDestroyed()) {
        try { win.webContents.send('video-preview-frame', frame) } catch {}
      }
    }
  })

  proc.on('close', (code) => {
    if (active === handle) active = null

    const elapsed = Date.now() - startMs

    // Quick exit with a device format/framerate error → try the next config.
    if (
      !handle.stopped &&
      code !== 0 &&
      elapsed < 3000 &&
      process.platform === 'darwin' &&
      isDeviceFormatError(stderrBuf) &&
      _macConfigIdx + 1 < MAC_CONFIGS.length
    ) {
      const nextCfg = MAC_CONFIGS[_macConfigIdx + 1]
      console.log(`[video-preview] config ${_macConfigIdx} rejected — trying ${nextCfg.label}`)
      startPreview(opts, win, _macConfigIdx + 1)
      return
    }

    if (code !== 0 && stderrBuf) {
      console.warn('[video-preview] ffmpeg exited', code, '— last stderr:', stderrBuf.slice(-300))
    }
    if (!handle.stopped && !win.isDestroyed()) {
      try { win.webContents.send('video-preview-stopped') } catch {}
    }
  })

  return true
}

export function stopPreview(): void {
  if (!active) return
  const handle = active
  handle.stopped = true
  active = null
  try { handle.proc.kill('SIGTERM') } catch {}
}

export function isPreviewRunning(): boolean {
  return active !== null
}
