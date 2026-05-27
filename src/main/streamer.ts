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
import { buildOverlayPipeline } from './overlay'
import type { NdiOverlayRuntime } from './overlay'
import type { ReceiverHandle, StartReceiverOpts } from './ndi-receiver'
import type { OverlayConfig } from '../types'

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
  /** Optional overlays composited on top of the camera before encoding.
   *  Disabled overlays are skipped. Empty/undefined = clean stream. */
  overlays?: OverlayConfig[]
  /** When set, the same ffmpeg pipeline also writes a higher-bitrate copy
   *  to a local MP4 — solves "Stream + opptak"-bruksmønsteret uten å spawn
   *  en parallell recorder-prosess (avfoundation låser kameraet). The
   *  output file is registered in recording history after the stream
   *  stops so the user can find it in Siste opptak. */
  alsoRecord?: {
    outputPath: string
    /** Optional override of recorder bitrate. Default = videoBitrate × 1.6
     *  for a noticeably higher-quality local file than the livestream. */
    bitrateKbps?: number
  }
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

/**
 * Build the camera (and on Mac, mic) input arguments. Audio map on Mac stays
 * at `0:a?` because avfoundation bundles video+audio in a single input.
 *
 * On Windows the audio is a SEPARATE input — we return it from a sibling
 * `buildAudioOnlyInputArgs` so overlay inputs can slot between video and
 * audio (overlay indices start at 1, audio index = 1 + overlayCount).
 */
async function buildVideoInputArgs(opts: StreamOptions): Promise<string[] | null> {
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
    return [
      '-f', 'dshow',
      '-framerate', String(opts.framerate),
      '-video_size', `${res.w}x${res.h}`,
      '-i', `video=${stripQuotes(opts.videoDeviceName ?? '')}`,
    ]
  }
  return null
}

/** Windows-only: separate dshow audio input. Mac bundles audio in the
 *  camera input. Returns empty array when no separate audio input needed. */
function buildAudioOnlyInputArgs(opts: StreamOptions): string[] {
  if (process.platform === 'win32' && opts.audioDeviceName) {
    return ['-f', 'dshow', '-i', `audio=${stripQuotes(opts.audioDeviceName)}`]
  }
  return []
}

function stripQuotes(s: string): string { return s.replace(/^"|"$/g, '') }

// ─── NDI receiver lifecycle ──────────────────────────────────────────────────
//
// Each NDI overlay needs an out-of-band receiver running while the stream is
// alive — the receiver reads frames from libndi and serves them on a
// loopback TCP socket that ffmpeg connects to. We track active receivers
// here so stopStream() can tear them all down, even when the user disables
// an NDI overlay mid-stream.

let activeNdiReceivers: ReceiverHandle[] = []

/**
 * For every enabled NDI overlay, spin up a receiver and return a map from
 * overlay.id → runtime metadata (port, pixFmt, width, height). Caller
 * threads the map into buildOverlayPipeline via opts.ndiRuntime.
 *
 * If any receiver fails to start we tear down ALL of them and propagate the
 * error so the streamer can surface a single friendly message.
 */
async function startNdiReceiversForOverlays(
  overlays: OverlayConfig[],
): Promise<Record<string, NdiOverlayRuntime>> {
  const enabled = overlays.filter(o => o.enabled && o.type === 'ndi')
  if (enabled.length === 0) return {}

  const { startNdiReceiver, isNdiAvailable, getNdiLoadError } = await import('./ndi-receiver')
  if (!isNdiAvailable()) {
    throw new Error(`NDI er ikke tilgjengelig: ${getNdiLoadError() ?? 'ukjent feil'}`)
  }

  const runtime: Record<string, NdiOverlayRuntime> = {}
  for (const ov of enabled) {
    if (!ov.source) throw new Error(`NDI-overlay «${ov.name}» mangler kilde`)
    // Alpha is requested when the user has set up chroma key — ProPresenter's
    // alpha-key NDI output ships true transparency we can composite directly.
    const wantAlpha = !!ov.chromaKey
    const opts: StartReceiverOpts = { sourceName: ov.source, wantAlpha }
    const handle = await startNdiReceiver(opts)
    activeNdiReceivers.push(handle)
    runtime[ov.id] = {
      port:      handle.port,
      pixFmt:    handle.pixFmt,
      width:     handle.width,
      height:    handle.height,
      framerate: handle.framerate,
    }
    // Forward fatal errors to the streamer's logger — the receiver will
    // already have closed the socket; ffmpeg will detect EOF and exit,
    // triggering our standard restart logic.
    handle.events.on('error', err => {
      console.warn('[streamer] NDI receiver error for', ov.name, '—', err)
    })
  }
  return runtime
}

/** Tear down every NDI receiver started for the current stream. Safe to
 *  call from error paths even if startNdiReceivers... never ran. */
async function stopActiveNdiReceivers(): Promise<void> {
  const handles = activeNdiReceivers
  activeNdiReceivers = []
  await Promise.allSettled(handles.map(h => h.stop()))
}

/**
 * After "Start direktesending + opptak" finishes, append the resulting MP4
 * to the recording history so it shows up in Siste opptak just like a
 * regular recorder.ts file. Best-effort — a missing/zero-byte file (very
 * early ffmpeg crash) is silently skipped instead of polluting history
 * with a broken row.
 */
async function registerAlsoRecordInHistory(filePath: string, startedAt: number): Promise<void> {
  try {
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile() || stat.size < 1024) {
      console.warn('[streamer] alsoRecord file missing or too small — skipping history', filePath)
      return
    }
    const durationMs = Math.max(0, Date.now() - startedAt)
    const durationSec = Math.round(durationMs / 1000)
    const startDate = new Date(startedAt)
    const date      = startDate.toLocaleDateString('nb-NO')
    const startTime = startDate.toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' })
    const duration  = formatDurationHms(durationSec)

    const store = await import('./store')
    store.addHistory({
      date,
      startTime,
      duration,
      filename:      path.basename(filePath),
      path:          filePath,
      status:        'ok',
      fileSizeBytes: stat.size,
      durationSec,
    })
    console.log(`[streamer] registered alsoRecord file in history: ${path.basename(filePath)} (${(stat.size/1024/1024).toFixed(1)} MB, ${durationSec}s)`)
  } catch (e) {
    console.warn('[streamer] failed to register alsoRecord in history:', e instanceof Error ? e.message : String(e))
  }
}

function formatDurationHms(totalSec: number): string {
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Compose the full filter_complex string. When overlays are active, the
 * camera's video stream first runs through the overlay pipeline producing a
 * composed label, which is then split into the main encode + the preview
 * snapshot branch. The audio map adjusts depending on overlay-input count
 * (Windows) — Mac always uses `0:a?` because avfoundation bundles audio.
 */
function buildOutputArgs(
  opts:           StreamOptions,
  snapshotPath:   string,
  overlayCount:   number,
  overlayLabel:   string,
  overlayChain:   string,
): string[] {
  const res = RES_MAP[opts.resolution]
  const vBitrate = opts.videoBitrateKbps ?? res.auto_kbps
  const aBitrate = opts.audioBitrateKbps ?? 128

  // Stream branch starts from either the camera (no overlays) or the composed
  // overlay output (already computed once in launchFfmpeg — no second call so
  // a transient file-delete between the two calls can't crash this path).
  // When `alsoRecord` is requested we split into 3 branches instead of 2 so a
  // separate higher-bitrate encoder can write a local MP4 alongside the live
  // stream — same ffmpeg, no extra device handle.
  const filterParts: string[] = []
  if (overlayChain) filterParts.push(overlayChain)
  if (opts.alsoRecord) {
    filterParts.push(`[${overlayLabel}]split=3[v_stream][v_rec][v_pre]`)
  } else {
    filterParts.push(`[${overlayLabel}]split=2[v_stream][v_pre]`)
  }
  filterParts.push(`[v_pre]fps=1/2,scale=320:-1[v_thumb]`)

  const args: string[] = [
    '-filter_complex', filterParts.join(';'),
  ]

  // Audio input index — see buildVideoInputArgs / buildAudioOnlyInputArgs.
  // Mac: audio rides on input 0. Windows: audio is the input AFTER all
  // overlays. Linux is a no-op (no audio input today).
  const audioMap = process.platform === 'darwin'
    ? '0:a?'
    : `${1 + overlayCount}:a?`

  // Main encoded stream output
  args.push(
    '-map', '[v_stream]',
    '-map', audioMap,
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

  // Optional local recording output — higher bitrate than the livestream so
  // post-production (podcast, editor) has more headroom. Uses the same audio
  // source as the stream branch. faststart writes the moov atom at the
  // beginning of the file so partial files remain playable if the stream
  // gets killed before clean shutdown.
  if (opts.alsoRecord) {
    const recBitrate = opts.alsoRecord.bitrateKbps ?? Math.round(vBitrate * 1.6)
    args.push(
      '-map', '[v_rec]',
      '-map', audioMap,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-b:v', `${recBitrate}k`,
      '-maxrate', `${recBitrate}k`,
      '-bufsize', `${recBitrate * 2}k`,
      '-g', String(opts.framerate * 2),
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '48000',
      '-ac', '2',
      '-movflags', '+faststart',
      '-y', opts.alsoRecord.outputPath,
    )
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

  const videoInput = await buildVideoInputArgs(opts)
  if (!videoInput) return { ok: false, error: 'Kunne ikke finne kamera/lydenhet. Sjekk innstillinger.' }

  // Build overlay inputs up-front so we know the count for audio mapping.
  // Errors here (missing image, bad screen id) are surfaced to the caller
  // before we spawn ffmpeg, which would otherwise fail with a cryptic
  // "Invalid argument" deep in the avfoundation/dshow layer.
  // Build overlay pipeline ONCE. If a source file is deleted between two
  // calls, only this single throw-site needs to be caught — the result is
  // threaded through to buildOutputArgs so it doesn't rebuild and risk a
  // second, uncaught throw.
  const res = RES_MAP[opts.resolution]

  // Start any NDI receivers BEFORE building the ffmpeg pipeline — we need
  // each receiver's TCP port and resolved frame dimensions to wire the
  // input args correctly. Any failure here is surfaced as a friendly
  // error and any receivers that DID start are torn down so we don't
  // leak grandiose handles.
  let ndiRuntime: Record<string, NdiOverlayRuntime> = {}
  try {
    ndiRuntime = await startNdiReceiversForOverlays(opts.overlays ?? [])
  } catch (e: unknown) {
    await stopActiveNdiReceivers()
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `NDI-feil: ${msg}` }
  }

  let overlay: ReturnType<typeof buildOverlayPipeline>
  try {
    overlay = buildOverlayPipeline(opts.overlays ?? [], {
      outputW:   res.w,
      outputH:   res.h,
      baseLabel: '0:v',
      framerate: opts.framerate,
      ndiRuntime,
    })
  } catch (e: unknown) {
    await stopActiveNdiReceivers()
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `Overlay-feil: ${msg}` }
  }

  const audioInput = buildAudioOnlyInputArgs(opts)

  // Preview snapshot lives in userData so renderer can read via file://
  const previewDir = path.join(app.getPath('userData'), 'live-preview')
  try { fs.mkdirSync(previewDir, { recursive: true }) } catch {}
  previewFile = path.join(previewDir, 'preview.jpg')

  const args = [
    '-hide_banner',
    '-loglevel', 'info',
    '-nostdin',
    ...videoInput,
    ...overlay.inputArgs,
    ...audioInput,
    ...buildOutputArgs(opts, previewFile, overlay.extraInputCount, overlay.outputLabel, overlay.filterChain),
  ]

  console.log('[streamer] starting ffmpeg:', args.join(' '))

  const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })

  streamProc = proc
  // Capture per-process startedAt so the close-handler isn't racing the
  // module-level streamStartedAt that auto-recover bumps on restart.
  const procStartedAt = Date.now()
  streamStartedAt = procStartedAt
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
    const finalAlsoRecord = activeOpts?.alsoRecord ?? null
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
    // Register the local "Start direktesending + opptak" file in history so
    // the user can find it under Siste opptak. Fire-and-forget — stat/IO
    // failures are logged but don't block the close path. We use the
    // closure-captured `procStartedAt` rather than the module-level
    // `streamStartedAt` so a rapid restart can't overwrite the timestamp
    // before this handler runs.
    if (finalAlsoRecord && wasActive) {
      void registerAlsoRecordInHistory(finalAlsoRecord.outputPath, procStartedAt)
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
  // Tear down any NDI receivers — fire-and-forget so the IPC handler can
  // return synchronously; ffmpeg shutdown drives the perceived latency
  // anyway, the libndi handles can close in the background.
  void stopActiveNdiReceivers()
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
