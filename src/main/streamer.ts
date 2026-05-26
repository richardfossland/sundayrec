/**
 * Live streaming — RTMP via ffmpeg.
 *
 * One ffmpeg process opens the camera + microphone, encodes once, and tees
 * the output to multiple RTMP destinations (YouTube, Facebook, custom). The
 * same process also writes a low-rate snapshot JPG (1 frame every 2 s) that
 * the renderer reads from disk to show a live preview without needing a
 * second ffmpeg that competes for the camera (avfoundation locks devices
 * on macOS so two processes can't read the same one).
 *
 * Multi-destination uses the `tee:` muxer with `onfail=ignore` so a single
 * dead destination (e.g. YouTube broadcast not started yet) doesn't kill
 * the entire stream — the others keep going.
 *
 * Stats are parsed from ffmpeg's stderr progress lines and pushed to the
 * renderer at ~1 Hz so the UI shows live bitrate/fps/dropped-frames without
 * a costly per-line render.
 */

import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import { ffmpegBin, resolveVideoInput, listFfmpegDevices, findBestDeviceMatch } from './native-recorder'

/** Find AVFoundation audio device index by name. Returns null when no
 *  match. Caller uses ":none" or "none" in the input string. */
async function resolveAvfAudioIndex(name: string): Promise<number | null> {
  if (process.platform !== 'darwin') return null
  const devices = await listFfmpegDevices()
  if (!devices.length) return null
  const match = name ? findBestDeviceMatch(devices, name) : devices[0]
  return match?.index ?? devices[0].index
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StreamDestination {
  /** Stable id for UI tracking. */
  id:        string
  /** User-facing name (e.g. "YouTube", "Facebook", "Kirkens server"). */
  name:      string
  /** RTMP base URL (no stream key). Example: rtmp://a.rtmp.youtube.com/live2 */
  rtmpUrl:   string
  /** Stream key — sensitive, stored encrypted by caller. */
  streamKey: string
  /** Skip this destination on next start without deleting it. */
  enabled:   boolean
}

export interface StreamOptions {
  /** Audio input device name (matches store.deviceName). */
  audioDeviceName?: string
  /** Video input device name. */
  videoDeviceName?: string
  /** Resolution preset. */
  resolution: '720p' | '1080p' | '480p'
  /** Frames per second. */
  framerate:  25 | 30
  /** Video bitrate in kbps. Caller may set "auto" via resolution table. */
  videoBitrateKbps?: number
  /** Audio bitrate in kbps. */
  audioBitrateKbps?: number
  /** Destinations to push to. Disabled ones are skipped. */
  destinations: StreamDestination[]
}

export interface StreamStats {
  /** True while ffmpeg is alive. */
  active:     boolean
  /** Epoch-ms when start() was called. */
  startedAt:  number | null
  /** Most recent bitrate in kbps (sum of audio+video). */
  bitrateKbps: number
  /** Most recent FPS as reported by ffmpeg. */
  fps:        number
  /** Frames dropped by encoder so far. */
  dropped:    number
  /** Last stderr line — useful for surfacing connection errors. */
  lastLine:   string
  /** Per-destination connection state — best-effort, derived from ffmpeg stderr. */
  destinations: Array<{ id: string; state: 'connecting' | 'live' | 'failed' | 'disabled' }>
}

// ─── State ───────────────────────────────────────────────────────────────────

let streamProc: ChildProcess | null = null
let streamStartedAt = 0
let lastStats: StreamStats = emptyStats()
let statsListener: ((s: StreamStats) => void) | null = null
let previewFile: string = ''

/** Auto-recovery state: when ffmpeg crashes mid-stream we restart it with
 *  the same options, up to N times. Critical for a 90-min sermon — if the
 *  encoder crashes 20 min in (USB drop, RTMP brief disconnect, libx264 OOM),
 *  the user notices when half the congregation already left. */
let activeOpts: StreamOptions | null = null
let restartAttempts = 0
const MAX_RESTART_ATTEMPTS = 3
const RESTART_DELAY_MS = 5_000  // Brief pause before relaunch (let RTMP server reset)
let userInitiatedStop = false   // Flag set by stopStream() to disable auto-restart

function emptyStats(): StreamStats {
  return {
    active:      false,
    startedAt:   null,
    bitrateKbps: 0,
    fps:         0,
    dropped:     0,
    lastLine:    '',
    destinations: [],
  }
}

export function setStatsListener(fn: ((s: StreamStats) => void) | null): void {
  statsListener = fn
}

export function getStats(): StreamStats { return { ...lastStats } }

export function isStreaming(): boolean { return streamProc != null }

export function getPreviewPath(): string { return previewFile }

// ─── Build ffmpeg args ──────────────────────────────────────────────────────

const RES_MAP: Record<StreamOptions['resolution'], { w: number; h: number; auto_kbps: number }> = {
  '480p':  { w: 854,  h: 480,  auto_kbps: 1500 },
  '720p':  { w: 1280, h: 720,  auto_kbps: 4500 },
  '1080p': { w: 1920, h: 1080, auto_kbps: 6000 },
}

async function buildInputArgs(opts: StreamOptions): Promise<string[] | null> {
  const res = RES_MAP[opts.resolution]
  if (process.platform === 'darwin') {
    const video = await resolveVideoInput({ videoDeviceName: opts.videoDeviceName })
    if (!video) return null
    const audioIndex = await resolveAvfAudioIndex(opts.audioDeviceName ?? '')
    const deviceStr = audioIndex !== null ? `${video.device}:${audioIndex}` : `${video.device}:none`
    return [
      '-f', 'avfoundation',
      '-framerate', String(opts.framerate),
      '-video_size', `${res.w}x${res.h}`,
      '-i', deviceStr,
    ]
  }
  if (process.platform === 'win32') {
    const video = await resolveVideoInput({ videoDeviceName: opts.videoDeviceName })
    if (!video) return null
    // dshow with two -i is fine on Windows
    const args = [
      '-f', 'dshow',
      '-framerate', String(opts.framerate),
      '-video_size', `${res.w}x${res.h}`,
      '-i', `video=${stripQuotes(opts.videoDeviceName ?? '')}`,
    ]
    if (opts.audioDeviceName) {
      args.push('-f', 'dshow', '-i', `audio=${stripQuotes(opts.audioDeviceName)}`)
    }
    return args
  }
  return null
}

function stripQuotes(s: string): string { return s.replace(/^"|"$/g, '') }

function buildOutputArgs(opts: StreamOptions, snapshotPath: string): string[] {
  const res = RES_MAP[opts.resolution]
  const vBitrate = opts.videoBitrateKbps ?? res.auto_kbps
  const aBitrate = opts.audioBitrateKbps ?? 128

  // Filter graph: split video into [stream] and [thumb] @ 0.5 fps, scaled to 320x180
  const filter = '[0:v]split=2[v_stream][v_pre];[v_pre]fps=1/2,scale=320:-1[v_thumb]'

  const args: string[] = [
    '-filter_complex', filter,
  ]

  // Main encoded stream output
  args.push(
    '-map', '[v_stream]',
    '-map', process.platform === 'darwin' ? '0:a?' : '1:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-b:v', `${vBitrate}k`,
    '-maxrate', `${vBitrate}k`,
    '-bufsize', `${vBitrate * 2}k`,
    '-g', String(opts.framerate * 2),  // keyframe every 2 sec — required by YouTube/Facebook
    '-keyint_min', String(opts.framerate * 2),
    '-c:a', 'aac',
    '-b:a', `${aBitrate}k`,
    '-ar', '44100',
    '-ac', '2',
  )

  // Build tee output for multiple destinations. Format: [f=flv:onfail=ignore]url1|[f=flv:onfail=ignore]url2
  const enabledDests = opts.destinations.filter(d => d.enabled && d.rtmpUrl && d.streamKey)
  if (enabledDests.length === 0) {
    // Caller validates upstream — defensive only
    throw new Error('No enabled destinations')
  }
  const teeArg = enabledDests.map(d => {
    const fullUrl = joinRtmpUrl(d.rtmpUrl, d.streamKey)
    // onfail=ignore: a dead destination won't kill the others
    return `[f=flv:onfail=ignore]${fullUrl}`
  }).join('|')

  if (enabledDests.length === 1) {
    // Single destination — skip tee muxer overhead
    args.push('-f', 'flv', joinRtmpUrl(enabledDests[0].rtmpUrl, enabledDests[0].streamKey))
  } else {
    args.push('-f', 'tee', teeArg)
  }

  // Preview snapshot output (overwrites same file every 2 sec)
  args.push(
    '-map', '[v_thumb]',
    '-f', 'image2',
    '-update', '1',
    '-y',
    snapshotPath,
  )

  return args
}

function joinRtmpUrl(base: string, key: string): string {
  const b = base.replace(/\/+$/, '')
  return `${b}/${encodeURIComponent(key)}`
}

// ─── Start / stop ───────────────────────────────────────────────────────────

export async function startStream(opts: StreamOptions): Promise<{ ok: boolean; error?: string }> {
  if (streamProc) return { ok: false, error: 'Stream allerede aktiv' }
  if (opts.destinations.filter(d => d.enabled && d.rtmpUrl && d.streamKey).length === 0) {
    return { ok: false, error: 'Ingen aktive destinasjoner. Legg til minst én RTMP-URL + stream-key.' }
  }
  // Fresh start (not a recovery retry) — reset state
  activeOpts = opts
  userInitiatedStop = false
  restartAttempts = 0
  return launchFfmpeg(opts)
}

/** Internal: spawn ffmpeg with given opts. Called by startStream() initially
 *  and by the auto-recovery handler after a crash. */
async function launchFfmpeg(opts: StreamOptions): Promise<{ ok: boolean; error?: string }> {

  const input = await buildInputArgs(opts)
  if (!input) return { ok: false, error: 'Kunne ikke finne kamera/lydenhet. Sjekk innstillinger.' }

  // Preview snapshot lives in userData so renderer can read via file://
  const previewDir = path.join(app.getPath('userData'), 'live-preview')
  try { fs.mkdirSync(previewDir, { recursive: true }) } catch {}
  previewFile = path.join(previewDir, 'preview.jpg')

  const args = [
    '-hide_banner',
    '-loglevel', 'info',
    '-nostdin',
    ...input,
    ...buildOutputArgs(opts, previewFile),
  ]

  console.log('[streamer] starting ffmpeg:', args.join(' '))

  const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })

  streamProc = proc
  streamStartedAt = Date.now()
  lastStats = {
    active:      true,
    startedAt:   streamStartedAt,
    bitrateKbps: 0,
    fps:         0,
    dropped:     0,
    lastLine:    '',
    destinations: opts.destinations.map(d => ({
      id:    d.id,
      state: d.enabled && d.rtmpUrl && d.streamKey ? 'connecting' : 'disabled',
    })),
  }
  emitStats()

  let stderrBuf = ''
  let lastProgressAt = Date.now()

  // Watchdog: if ffmpeg produces no progress for 90 s, the encode pipeline
  // is hung (RTMP server stalled, encoder deadlock, USB drop). Kill and
  // surface to UI rather than letting the user stare at frozen stats.
  const watchdog = setInterval(() => {
    if (streamProc !== proc) { clearInterval(watchdog); return }
    const stalled = Date.now() - lastProgressAt > 90_000
    if (stalled) {
      console.warn('[streamer] no progress for 90s — killing hung ffmpeg')
      try { proc.kill('SIGKILL') } catch {}
      clearInterval(watchdog)
    }
  }, 15_000)

  proc.stderr?.on('data', (d: Buffer) => {
    const chunk = d.toString()
    stderrBuf = (stderrBuf + chunk).slice(-8192)
    if (chunk.includes('frame=')) lastProgressAt = Date.now()
    for (const line of chunk.split(/\r?\n/)) parseStderrLine(line, opts.destinations)
  })

  proc.stdout?.on('data', () => {})  // discard

  proc.on('close', (code, signal) => {
    clearInterval(watchdog)
    const wasActive = streamProc != null
    streamProc = null

    // Decide: auto-recover or finalise?
    const crashedUnexpectedly =
      !userInitiatedStop &&
      wasActive &&
      code !== 0 &&
      signal !== 'SIGTERM' &&
      activeOpts != null &&
      restartAttempts < MAX_RESTART_ATTEMPTS
    // Note: SIGKILL is the watchdog killing a hang — treat as crash worth retry.

    if (crashedUnexpectedly) {
      restartAttempts++
      console.warn(`[streamer] ffmpeg crashed (code=${code} signal=${signal}) — auto-restart ${restartAttempts}/${MAX_RESTART_ATTEMPTS} in ${RESTART_DELAY_MS}ms`)
      lastStats = {
        ...lastStats,
        active:   true,  // keep "active" so UI shows "reconnecting" not "stopped"
        lastLine: `Recovering… (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})`,
      }
      emitStats()
      setTimeout(() => {
        if (userInitiatedStop || !activeOpts) return
        void launchFfmpeg(activeOpts)
      }, RESTART_DELAY_MS)
      return
    }

    // Final teardown — either user stopped, or we exhausted retries
    activeOpts = null
    lastStats = {
      ...lastStats,
      active: false,
    }
    emitStats()
    if (wasActive) {
      console.log(`[streamer] ffmpeg closed code=${code} signal=${signal}`)
      if (code !== 0 && code !== null && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
        console.warn('[streamer] last stderr:', stderrBuf.slice(-500))
      }
    }
  })

  proc.on('error', err => {
    streamProc = null
    lastStats = {
      ...emptyStats(),
      lastLine: `Kunne ikke starte: ${err.message}`,
    }
    emitStats()
  })

  return { ok: true }
}

export function stopStream(): boolean {
  // Mark user-initiated stop FIRST so the close-handler doesn't auto-restart.
  userInitiatedStop = true
  activeOpts = null
  if (!streamProc) return false
  try { streamProc.kill('SIGTERM') } catch {}
  // Force-kill after 5s if it doesn't honour SIGTERM (some ffmpeg builds
  // hang during RTMP teardown).
  setTimeout(() => {
    if (streamProc) { try { streamProc.kill('SIGKILL') } catch {} }
  }, 5000)
  return true
}

// ─── Parsing ffmpeg stderr ──────────────────────────────────────────────────

let lastEmitTime = 0
const STATS_EMIT_INTERVAL_MS = 800  // throttle UI updates to ~1 Hz

function parseStderrLine(line: string, destinations: StreamDestination[]): void {
  if (!line) return
  lastStats.lastLine = line.slice(-200)

  // ffmpeg progress lines look like:
  //   frame=  120 fps= 30 q=23.0 size=    1024kB time=00:00:04.00 bitrate=2048.5kbits/s speed=1.01x
  const m = /frame=\s*(\d+).*?fps=\s*([\d.]+).*?bitrate=\s*([\d.]+)kbits\/s/.exec(line)
  if (m) {
    lastStats.fps         = Math.round(parseFloat(m[2]))
    lastStats.bitrateKbps = Math.round(parseFloat(m[3]))
    // dup= and drop= appear in -copytb mode; capture them if present
    const drop = /drop=\s*(\d+)/.exec(line)
    if (drop) lastStats.dropped = parseInt(drop[1], 10)
    emitStatsThrottled()
  }

  // Connection state — best-effort:
  // "Opening 'rtmp://...' for writing" → connecting
  // After we see at least one frame after Opening, mark live.
  if (line.includes('Opening')) {
    // Match destinations by URL prefix
    for (let i = 0; i < destinations.length; i++) {
      const d = destinations[i]
      if (line.includes(d.rtmpUrl.split('/').slice(0, 3).join('/'))) {
        const entry = lastStats.destinations.find(s => s.id === d.id)
        if (entry) entry.state = 'connecting'
      }
    }
  }
  if (line.includes('Stream mapping')) {
    // First successful frame is queued — mark all connecting as live
    for (const s of lastStats.destinations) {
      if (s.state === 'connecting') s.state = 'live'
    }
    emitStatsThrottled()
  }
  if (/Connection refused|Connection timed out|Unable to open|No route to host|Server returned/i.test(line)) {
    for (const s of lastStats.destinations) {
      if (s.state === 'connecting') s.state = 'failed'
    }
    emitStatsThrottled()
  }
}

function emitStats(): void {
  lastEmitTime = Date.now()
  statsListener?.({ ...lastStats })
}

function emitStatsThrottled(): void {
  const now = Date.now()
  if (now - lastEmitTime < STATS_EMIT_INTERVAL_MS) return
  emitStats()
}
