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
 * ─── Device-aware config selection ────────────────────────────────────────
 *
 * Different capture devices have different requirements for `-framerate` and
 * `-video_size`:
 *
 *   • Capture cards (Blackmagic ATEM, Elgato Cam Link, Magewell …) output a
 *     fixed HDMI signal at native resolution and reject explicit `-video_size`.
 *     → start with NATIVE mode (no -video_size).
 *
 *   • Built-in webcams (MacBook FaceTime HD, Studio Display, iSight) and most
 *     USB webcams without explicit `-video_size` on macOS produce a 1:1
 *     SQUARE crop of the sensor (e.g. 1552×1552). This is almost never what
 *     the user wants.
 *     → start with EXPLICIT 1280×720.
 *
 *   • Continuity Camera (iPhone-as-webcam on macOS Sonoma+) behaves like a
 *     webcam — needs explicit size.
 *     → start with EXPLICIT 1280×720.
 *
 *   • Unknown devices: default to 1280×720 first (works for ~99% of cameras
 *     out there), fall back to native as a safety net.
 *
 * If the first config doesn't deliver a frame within 10s, or delivers a
 * square/portrait frame on a non-capture-card device, we retry with the next
 * config in the device-specific order. Retries WAIT for the previous ffmpeg
 * to fully exit (SIGTERM → close event → 200ms grace period) so AVFoundation
 * releases the device handle. Without this wait, the next `resolveVideoInput`
 * hangs for 5s trying to re-enumerate a still-held device.
 *
 * ─── Why the old "single linear config list" broke ────────────────────────
 *
 * Earlier versions used a single MAC_CONFIGS list with `native@30fps` first
 * for ALL devices. That worked for capture cards but broke built-in cameras
 * (silent square output). A retry-on-square existed but used SIGKILL+immediate-
 * respawn, which left AVFoundation holding the device → next resolveVideoInput
 * hung → user saw a black preview area forever. Worse: a CSP issue in the
 * renderer was masking the symptoms (blob: URLs were blocked, so even if a
 * good frame arrived, it didn't render). Both bugs are now fixed:
 *   1. Device-aware config order (this file)
 *   2. SIGTERM + waitForClose handshake (this file)
 *   3. CSP allows blob: (renderer/index.html)
 *   4. Renderer-side normalization handles Uint8Array / ArrayBuffer / Buffer
 *      shapes from structured-clone (renderer/pages/home.ts)
 *   5. CSP smoke test on startup catches future regressions (renderer/main.ts)
 */

import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import type { BrowserWindow } from 'electron'
import { ffmpegBin, resolveVideoInput } from './native-recorder'

interface PreviewHandle {
  proc:    ChildProcess
  stopped: boolean
}

interface ResolvedInput {
  format:       string
  device:       string
  resolvedName: string
}

let active: PreviewHandle | null = null
let _workingMacConfigIdx = 0

/**
 * Auto-restart bookkeeping for the "another app stole the camera" recovery
 * path (FaceTime call, Photo Booth, Zoom etc.). Cap restarts within a short
 * window so we don't burn cycles in a restart loop when the camera is
 * genuinely gone (unplugged USB, denied permission).
 */
const RESTART_WINDOW_MS = 30_000
const MAX_RESTARTS_PER_WINDOW = 4
let restartTimestamps: number[] = []
function noteRestartAttempt(): boolean {
  const now = Date.now()
  restartTimestamps = restartTimestamps.filter(t => now - t < RESTART_WINDOW_MS)
  if (restartTimestamps.length >= MAX_RESTARTS_PER_WINDOW) return false
  restartTimestamps.push(now)
  return true
}
function resetRestartCounter(): void { restartTimestamps = [] }

/**
 * Monotonically-incrementing generation token. Each startPreview() call captures
 * the current value; if stopPreview() bumps it during an in-flight retry
 * sequence, the retry observes the mismatch and bails out instead of spawning
 * a fresh ffmpeg the caller didn't ask for. Without this, calling stopPreview()
 * during a retry window leaves a zombie ffmpeg holding the camera.
 */
let _generation = 0

/** Returns the MAC_CONFIGS index at which the last successful preview received its first frame. */
export function getWorkingMacConfigIdx(): number {
  return _workingMacConfigIdx
}

/**
 * Decode width and height from a JPEG buffer by scanning for SOF0 (0xFF 0xC0)
 * or SOF2 (0xFF 0xC2) markers. Returns null if no SOF marker is found.
 */
function readJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  let i = 0
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) { i++; continue }
    const marker = buf[i + 1]
    if (marker === 0xc0 || marker === 0xc2) {
      // SOF structure: FF Cx LL LL PP HH HH WW WW
      // height is at offset +5 (2 bytes), width at offset +7 (2 bytes)
      if (i + 8 < buf.length) {
        const height = (buf[i + 5] << 8) | buf[i + 6]
        const width  = (buf[i + 7] << 8) | buf[i + 8]
        if (width > 0 && height > 0) return { width, height }
      }
    }
    // Skip over this segment: length field is at offset +2 (big-endian uint16)
    if (i + 3 < buf.length && marker !== 0xd8 && marker !== 0xd9 && marker !== 0x01) {
      const segLen = (buf[i + 2] << 8) | buf[i + 3]
      if (segLen >= 2) { i += 2 + segLen; continue }
    }
    i++
  }
  return null
}

// ── macOS AVFoundation config candidates ────────────────────────────────────

export interface MacConfig {
  fps:  number
  size: string | null   // null = let device choose its native resolution
  label: string
}

/**
 * Master list of every config we know how to try. Order here is for backward
 * compatibility only — actual try order is chosen per-device by
 * `pickMacConfigOrder`. Indices in this array are stable; don't reorder.
 */
export const MAC_CONFIGS: MacConfig[] = [
  /* 0 */ { fps: 30, size: null,        label: 'native@30fps'  },   // capture cards
  /* 1 */ { fps: 30, size: '1280x720',  label: '720p@30fps'    },   // webcams (default)
  /* 2 */ { fps: 30, size: '1920x1080', label: '1080p@30fps'   },   // higher-res webcams
  /* 3 */ { fps: 25, size: null,        label: 'native@25fps'  },   // PAL capture cards
  /* 4 */ { fps: 25, size: '1920x1080', label: '1080p@25fps'   },   // PAL 1080p
  /* 5 */ { fps: 25, size: '1280x720',  label: '720p@25fps'    },   // PAL 720p
]

export type DeviceKind = 'capture-card' | 'builtin-webcam' | 'continuity-camera' | 'usb-webcam' | 'unknown'

/**
 * Classify a video device by its display name. Pure function — exported for
 * testability. Don't rely on regex order; each branch covers a distinct
 * vendor/product family.
 */
export function classifyVideoDevice(name: string): DeviceKind {
  const n = (name || '').toLowerCase()
  // Capture cards / HDMI inputs — need native resolution
  if (/blackmagic|atem|decklink|elgato|cam.?link|magewell|avermedia|av\.?capture|live.?gamer|hdmi|webcaster|epiphan|aja|inogeni/.test(n)) {
    return 'capture-card'
  }
  // Built-in Apple cameras
  if (/facetime|isight|studio.?display|macbook|imac/.test(n)) {
    return 'builtin-webcam'
  }
  // Continuity Camera (iPhone / iPad as webcam on macOS Sonoma+)
  if (/iphone|ipad/.test(n)) {
    return 'continuity-camera'
  }
  // Known USB webcam families
  if (/logitech|brio|c\d{2,4}|kiyo|streamcam|insta360|obs.?bot|opal|usb.?video|webcam/.test(n)) {
    return 'usb-webcam'
  }
  return 'unknown'
}

/**
 * Returns the order in which to try MAC_CONFIGS indices for a given device.
 * Capture cards: native first. Everything else: explicit 720p first.
 *
 * Pure function — exported for testability.
 */
export function pickMacConfigOrder(deviceName: string): number[] {
  const kind = classifyVideoDevice(deviceName)
  switch (kind) {
    case 'capture-card':
      // HDMI sources: native first, then 25fps for PAL, then explicit sizes as fallback.
      return [0, 3, 4, 5, 2, 1]
    case 'builtin-webcam':
    case 'continuity-camera':
    case 'usb-webcam':
    case 'unknown':
    default:
      // Webcams: explicit 720p first (universally supported), then 1080p, then native as last resort.
      return [1, 2, 5, 0, 3, 4]
  }
}

export function buildMacInputArgs(format: string, device: string, cfg: MacConfig): string[] {
  const a: string[] = ['-f', format, '-framerate', String(cfg.fps)]
  if (cfg.size) a.push('-video_size', cfg.size)
  a.push('-i', device)
  return a
}

/**
 * Returns true when ffmpeg stderr indicates the device doesn't support the
 * requested resolution or framerate — i.e. we should retry with a different config.
 * Covers AVFoundation-specific errors that vary across macOS versions and device types.
 */
function isDeviceFormatError(stderr: string): boolean {
  const s = stderr.toLowerCase()
  return (
    s.includes('video_size must be') ||
    s.includes('selected videosize') ||
    s.includes('supported modes:') ||
    (s.includes('selected framerate') && s.includes('not supported')) ||
    s.includes('framerate not supported') ||
    s.includes('set capture framerate failed') ||
    s.includes('capture framerate') ||
    s.includes('invalid framerate') ||
    s.includes('unsupported resolution') ||
    s.includes('format is not supported') ||
    s.includes('could not set format') ||
    s.includes('failed to set format') ||
    // AVFoundation error codes for format/framerate mismatch
    s.includes('-11800') ||   // AVErrorUnknown (often format negotiation failure)
    s.includes('-11810') ||   // AVErrorDeviceIsNotAvailableInBackground
    s.includes('-11823')      // AVErrorOperationNotSupportedForAssetType
  )
}

/**
 * Kill an ffmpeg process and wait for it to actually exit. Critical before
 * respawning ffmpeg on the same device — without this wait, AVFoundation
 * still holds the device handle for ~500 ms after the process dies, causing
 * the next `resolveVideoInput` to hang for 5 s on device enumeration.
 *
 * Strategy: SIGTERM first (clean shutdown), SIGKILL after `timeoutMs` if it
 * doesn't exit, resolve on `close` event or after a max wait. Always resolves
 * — never rejects — so callers can `await` without try/catch.
 */
async function killAndWaitForExit(proc: ChildProcess, timeoutMs = 1500): Promise<void> {
  if (proc.exitCode !== null) return
  return new Promise<void>(resolve => {
    let resolved = false
    const finish = () => { if (!resolved) { resolved = true; resolve() } }
    proc.once('close', finish)
    proc.once('exit', finish)
    try { proc.kill('SIGTERM') } catch { /* already dead */ }
    setTimeout(() => {
      if (resolved) return
      try { proc.kill('SIGKILL') } catch { /* already dead */ }
      // SIGKILL is near-instant; give a short grace for the close event to fire,
      // then resolve no matter what so we don't block forever.
      setTimeout(finish, 250)
    }, timeoutMs)
  })
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the preview stream.
 *
 * Internal params (`_attemptIdx`, `_order`, `_cachedInput`) carry state across
 * retries so the device is enumerated only ONCE per startPreview call chain.
 * Callers should pass only `opts` + `win`.
 */
export async function startPreview(
  opts:         { videoDeviceName?: string | null; videoDeviceIndex?: number | null; videoFramerate?: number },
  win:          BrowserWindow,
  _attemptIdx = 0,
  _order?:      number[],
  _cachedInput?: ResolvedInput,
): Promise<boolean> {
  await stopPreview()
  // Capture the generation at the START of this attempt chain. If stopPreview()
  // is called while a retry is awaiting kill/close, the generation will bump
  // and the retry will see the mismatch + abort.
  const myGeneration = _generation

  const input: ResolvedInput | null = _cachedInput ?? await resolveVideoInput({
    videoDeviceName:  opts.videoDeviceName  ?? null,
    videoDeviceIndex: opts.videoDeviceIndex ?? null,
  })
  if (!input) return false

  // Compute the device-specific config order ONCE on the first attempt and
  // pass it through every subsequent retry. This avoids any chance of the
  // order changing mid-flight (e.g. if device name resolves differently
  // after the previous ffmpeg released the handle).
  const order = _order ?? (process.platform === 'darwin' ? pickMacConfigOrder(input.resolvedName) : [0])

  // Match the configured recording framerate so the preview faithfully represents the final recording.
  const previewFps = opts.videoFramerate ?? 30

  let inputArgs: string[]
  let cfgIdx = 0
  if (process.platform === 'darwin') {
    if (_attemptIdx >= order.length) {
      console.warn('[video-preview] exhausted all configs for', input.resolvedName)
      if (!win.isDestroyed()) {
        try { win.webContents.send('video-preview-stopped') } catch { /* window gone */ }
      }
      return false
    }
    cfgIdx = order[_attemptIdx]
    const cfg = MAC_CONFIGS[cfgIdx] ?? MAC_CONFIGS[1]
    inputArgs = buildMacInputArgs(input.format, input.device, cfg)
    console.log(`[video-preview] attempt ${_attemptIdx + 1}/${order.length} → config ${cfgIdx} (${cfg.label}) for "${input.resolvedName}"`)
  } else {
    // Windows DirectShow: rtbufsize prevents frame drops on slow USB buses.
    // No -video_size here — DirectShow negotiates with the driver automatically.
    inputArgs = ['-f', input.format, '-rtbufsize', '50M', '-i', input.device]
  }

  const args: string[] = [
    '-hide_banner',
    ...inputArgs,
    '-vf', `fps=${previewFps},scale=640:-2:flags=fast_bilinear,format=yuvj420p`,
    '-c:v', 'mjpeg',
    '-q:v', '5',
    '-f', 'mjpeg',
    'pipe:1',
  ]

  console.log('[video-preview] start:', ffmpegBin, args.map(a => a.includes(' ') ? `"${a}"` : a).join(' '))

  const proc = spawn(ffmpegBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
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

  // Parse MJPEG stream: each frame is a complete JPEG (SOI=FFD8 … EOI=FFD9)
  let buf = Buffer.alloc(0)
  const SOI = Buffer.from([0xff, 0xd8])
  const EOI = Buffer.from([0xff, 0xd9])
  let firstFrameReceived = false

  /**
   * Retry helper: kill the current ffmpeg, wait for it to fully exit, then
   * try the next config in `order`. CRITICAL — without the wait, AVFoundation
   * still holds the device → the next attempt's resolveVideoInput hangs.
   */
  const retryWithNext = async (reason: string): Promise<void> => {
    const nextIdx = _attemptIdx + 1
    if (nextIdx >= order.length) {
      console.warn('[video-preview] all configs exhausted —', reason)
      if (!win.isDestroyed()) {
        try { win.webContents.send('video-preview-stopped') } catch { /* window gone */ }
      }
      return
    }
    console.warn(`[video-preview] config ${cfgIdx} (${MAC_CONFIGS[cfgIdx]?.label}) — ${reason}; will try config ${order[nextIdx]} (${MAC_CONFIGS[order[nextIdx]]?.label})`)
    handle.stopped = true
    active = null
    await killAndWaitForExit(proc, 1500)
    // Extra grace for AVFoundation to fully release the device handle.
    await new Promise<void>(r => setTimeout(r, 200))
    // Bail if stopPreview() ran while we were waiting — caller no longer wants
    // this chain to continue.
    if (myGeneration !== _generation) return
    startPreview(opts, win, nextIdx, order, input).catch(err => {
      console.warn('[video-preview] retry failed:', err)
    })
  }

  // If no frame arrives within 10 s, the device is stuck (e.g. AVFoundation opened the
  // device but never delivered frames). Retry with the next config.
  const firstFrameTimer = setTimeout(() => {
    if (firstFrameReceived || handle.stopped) return
    void retryWithNext('no frame in 10 s')
  }, 10000)

  // Stale-frame watchdog: once frames have started flowing, if the stream goes
  // quiet for >3 s the camera was almost certainly stolen by another app
  // (FaceTime, Photo Booth, Zoom). When that other app releases the device,
  // AVFoundation does NOT automatically resume our stream — and any partial
  // frames already in our parse buffer corrupt the next decode (we've seen
  // the renderer paint a duplicated/interlaced rosy frame in this state).
  // Killing + relaunching ffmpeg is the only reliable recovery.
  let lastFrameAt = 0
  const STALE_FRAME_MS = 3000
  const staleWatchdog = setInterval(() => {
    if (handle.stopped) { clearInterval(staleWatchdog); return }
    if (!firstFrameReceived) return  // first-frame-timer covers this
    const stale = Date.now() - lastFrameAt
    if (stale < STALE_FRAME_MS) return
    if (!noteRestartAttempt()) {
      console.warn('[video-preview] stale-frame watchdog: too many restarts — giving up. Camera may be unavailable.')
      handle.stopped = true
      clearInterval(staleWatchdog)
      try { proc.kill('SIGTERM') } catch {}
      if (!win.isDestroyed()) {
        try { win.webContents.send('video-preview-stopped') } catch {}
      }
      return
    }
    console.warn(`[video-preview] stale-frame watchdog: ${stale} ms since last frame — restarting (likely camera was stolen by another app)`)
    handle.stopped = true
    clearInterval(staleWatchdog)
    active = null
    // Capture closure refs we need post-kill before they go stale.
    const restartOpts  = opts
    const restartWin   = win
    const restartIdx   = cfgIdx
    const restartOrder = order
    const restartInput = input
    void killAndWaitForExit(proc, 1500).then(async () => {
      // Brief grace for AVFoundation to fully release the device handle.
      await new Promise<void>(r => setTimeout(r, 250))
      if (myGeneration !== _generation) return
      if (restartWin.isDestroyed()) return
      startPreview(restartOpts, restartWin, restartIdx, restartOrder, restartInput).catch(err => {
        console.warn('[video-preview] watchdog restart failed:', err)
      })
    })
  }, 1000)

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
      lastFrameAt = Date.now()

      if (!firstFrameReceived) {
        firstFrameReceived = true
        clearTimeout(firstFrameTimer)

        const dims = readJpegDimensions(frame)
        const currentCfg = MAC_CONFIGS[cfgIdx]
        if (process.platform === 'darwin' && dims) {
          console.log(`[video-preview] first frame ${dims.width}×${dims.height} on ${currentCfg?.label}`)
        }

        // Safety net: if the device picked a square/portrait native mode (this
        // can happen on misclassified capture cards too — some HDMI sources
        // briefly output 1:1 before negotiating), retry with the next config.
        // This must NOT fire for explicitly-sized configs (size is non-null),
        // since then the user got exactly what they asked for.
        if (
          process.platform === 'darwin' &&
          dims !== null && dims.height >= dims.width &&
          currentCfg?.size === null
        ) {
          void retryWithNext(`first frame ${dims.width}×${dims.height} is square/portrait`)
          continue
        }

        _workingMacConfigIdx = cfgIdx
        if (dims && !win.isDestroyed()) {
          try { win.webContents.send('video-preview-meta', dims) } catch { /* window gone */ }
        }
      }

      if (!handle.stopped && !win.isDestroyed()) {
        try { win.webContents.send('video-preview-frame', frame) } catch { /* window gone */ }
      }
    }
  })

  proc.on('close', code => {
    clearTimeout(firstFrameTimer)
    clearInterval(staleWatchdog)
    if (active === handle) active = null

    const elapsed = Date.now() - startMs

    // Quick exit with a device format/framerate error → try the next config.
    if (
      !handle.stopped &&
      code !== 0 &&
      elapsed < 3000 &&
      process.platform === 'darwin' &&
      isDeviceFormatError(stderrBuf)
    ) {
      void retryWithNext(`ffmpeg exited ${code} with format error`)
      return
    }

    if (handle.stopped) {
      // Normal stop or intentional retry — no message needed
      return
    }
    if (process.platform === 'darwin' && !firstFrameReceived && _attemptIdx + 1 >= order.length) {
      console.warn('[video-preview] exhausted all configs — giving up')
    } else if (code !== 0 && stderrBuf) {
      const s = stderrBuf.toLowerCase()
      if (s.includes('already in use') || s.includes('device busy') || s.includes('resource busy')) {
        console.warn('[video-preview] camera is in use by another app — cannot open device')
      } else if (s.includes('permission') || s.includes('not permitted') || s.includes('authorization')) {
        console.warn('[video-preview] camera permission denied — check System Settings → Privacy → Camera')
      } else if (s.includes('device not found') || s.includes('no such') || s.includes('no video')) {
        console.warn('[video-preview] camera device not found — may have been unplugged')
      } else {
        console.warn('[video-preview] ffmpeg exited', code, '— stderr:', stderrBuf.slice(-300))
      }
    }
    if (!win.isDestroyed()) {
      try { win.webContents.send('video-preview-stopped') } catch { /* window gone */ }
    }
  })

  return true
}

export async function stopPreview(): Promise<void> {
  // Bump the generation FIRST — any in-flight retries that are currently
  // awaiting kill/close will see the mismatch and bail out.
  _generation++
  // Reset the watchdog restart counter so a fresh user-initiated start gets
  // its full quota — otherwise rapid stop/start cycles during testing or
  // device swaps would consume the per-window budget set aside for the real
  // "camera was stolen" recovery case.
  resetRestartCounter()
  if (!active) return
  const handle = active
  handle.stopped = true
  active = null
  await killAndWaitForExit(handle.proc, 1500)
}

export function isPreviewRunning(): boolean {
  return active !== null
}
