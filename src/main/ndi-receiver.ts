/**
 * NDI receiver service — wraps the vendored grandiose bindings.
 *
 * Two responsibilities:
 *   1. Discovery — list NDI sources currently advertising on the LAN.
 *   2. Frame piping — receive frames from a chosen source and feed them
 *      into the ffmpeg overlay pipeline as raw video (UYVY or BGRA depending
 *      on whether alpha is requested).
 *
 * Architecture choice (relevant when troubleshooting):
 *   • grandiose is a NATIVE module — it links to libndi at process start.
 *     Loading it in the main process is fine; we just have to make sure
 *     vendor/grandiose is bundled (see asarUnpack + files in package.json)
 *     so the .node + .dylib/.dll ship inside the packaged .app.
 *   • Frames are bridged into the streamer's single ffmpeg process via a
 *     loopback TCP socket — ffmpeg reads `tcp://127.0.0.1:<port>` with
 *     `-f rawvideo`. We pick a free ephemeral port at runtime so multiple
 *     NDI overlays can coexist. Loopback because the data lives only
 *     inside this machine; TCP because it gives us back-pressure semantics
 *     and works identically on macOS and Windows (named pipes differ).
 *
 * The receiver is lazy-loaded — `require('grandiose')` is only invoked when
 * the user actually adds an NDI overlay. This keeps the main process
 * startup snappy on machines that never touch NDI.
 */

import path from 'path'
import { app } from 'electron'
import net from 'net'
import { EventEmitter } from 'events'

// ─── Lazy bindings load ─────────────────────────────────────────────────────

type GrandioseFinder = {
  sources(): Promise<Array<{ name: string; urlAddress: string }>>
  destroy(): void
}

type GrandioseReceiver = {
  video(timeoutMs?: number): Promise<NdiVideoFrame | null>
  audio(timeoutMs?: number): Promise<unknown>
  destroy(): void
}

interface NdiVideoFrame {
  /** Width in pixels. */
  xres: number
  /** Height in pixels. */
  yres: number
  /** FourCC of the pixel format (e.g. UYVY = 0x59565955, BGRA = 0x41524742). */
  fourCC: number
  /** Frame data — raw pixel bytes in row-major order. */
  data: Buffer
  /** Line stride in bytes (may exceed xres * bpp due to alignment). */
  lineStrideBytes?: number
}

interface GrandioseModule {
  version(): string
  initialize?(): boolean
  destroy?(): void
  find(opts?: { showLocalSources?: boolean }): Promise<GrandioseFinder>
  receive(opts: {
    source:          { name: string; urlAddress?: string }
    colorFormat?:    number
    bandwidth?:      number
    allowVideoFields?: boolean
  }): Promise<GrandioseReceiver>
  COLOR_FORMAT_UYVY_BGRA: number   // alpha → BGRA, no-alpha → UYVY
  COLOR_FORMAT_BGRX_BGRA: number   // alpha → BGRA, no-alpha → BGRX
  COLOR_FORMAT_FASTEST:   number
  FOURCC_UYVY:   number
  FOURCC_BGRA:   number
  FOURCC_BGRX:   number
  FOURCC_RGBA:   number
  BANDWIDTH_HIGHEST: number
  BANDWIDTH_LOWEST:  number
}

let _grandiose: GrandioseModule | null = null
let _loadError: string | null = null

function loadGrandiose(): GrandioseModule | null {
  if (_grandiose) return _grandiose
  if (_loadError) return null
  try {
    // The vendored grandiose lives at vendor/grandiose. In dev it's loaded
    // relative to the repo root; in the packaged app electron-builder copies
    // it out of asar via the asarUnpack list, so the runtime path is
    // <Resources>/app.asar.unpacked/vendor/grandiose. We resolve both.
    const appPath = app.getAppPath()
    // Try the repo-relative path first (dev). Then the unpacked path.
    const candidates = [
      path.join(appPath, 'vendor', 'grandiose'),
      path.join(appPath, '..', 'app.asar.unpacked', 'vendor', 'grandiose'),
    ]
    for (const c of candidates) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        _grandiose = require(c) as GrandioseModule
        console.log('[ndi] grandiose loaded from', c, '— SDK', _grandiose.version())
        return _grandiose
      } catch { /* try next */ }
    }
    _loadError = 'grandiose-not-found'
    console.warn('[ndi] grandiose native bindings could not be located')
    return null
  } catch (e: unknown) {
    _loadError = e instanceof Error ? e.message : String(e)
    console.warn('[ndi] failed to load grandiose:', _loadError)
    return null
  }
}

export function isNdiAvailable(): boolean {
  return loadGrandiose() != null
}

export function getNdiLoadError(): string | null {
  return _loadError
}

// ─── Source discovery ───────────────────────────────────────────────────────

export interface NdiSourceInfo {
  /** Full source name as advertised on the network — e.g.
   *  "STUDIO-PC (ProPresenter Output 1)". */
  name:    string
  /** Resolvable IP:port pair. Same machine sources may show LOCAL HOST. */
  address: string
}

/**
 * Run an NDI discovery for `windowMs` milliseconds and return whatever
 * sources were advertising during that window. NDI uses mDNS-like
 * announcements, so a freshly-launched receiver needs ~1–2 s to receive
 * the first round of "I'm here" packets. Defaulting to 2 s strikes a
 * balance between responsiveness and reliable enumeration.
 */
export async function listNdiSources(windowMs = 2000): Promise<NdiSourceInfo[]> {
  const g = loadGrandiose()
  if (!g) return []
  let finder: GrandioseFinder | null = null
  try {
    finder = await g.find({ showLocalSources: true })
    await new Promise<void>(r => setTimeout(r, windowMs))
    const raw = await finder.sources()
    return raw.map(s => ({ name: s.name, address: s.urlAddress }))
  } catch (e) {
    console.warn('[ndi] discovery error:', e instanceof Error ? e.message : String(e))
    return []
  } finally {
    try { finder?.destroy() } catch { /* finder already torn down */ }
  }
}

// ─── Frame receiver ─────────────────────────────────────────────────────────

export interface ReceiverHandle {
  /** TCP port the streamer feeds into ffmpeg as `tcp://127.0.0.1:<port>`. */
  port:        number
  /** Pixel format string ffmpeg expects on the rawvideo input. */
  pixFmt:      'uyvy422' | 'bgra'
  /** Frame size — ffmpeg needs `-s WxH`. Resolved after the first frame. */
  width:       number
  height:      number
  /** Best-effort framerate — defaults to 30 if unknown. */
  framerate:   number
  /** Stop the receiver and free libndi resources. Safe to call multiple times. */
  stop(): Promise<void>
  /** Emitted on fatal errors so the streamer can fail loudly. */
  events:      EventEmitter
}

export interface StartReceiverOpts {
  /** Source name from listNdiSources(). */
  sourceName: string
  /** Whether to request alpha — true uses BGRA, false uses UYVY (smaller). */
  wantAlpha:  boolean
}

/**
 * Start receiving frames from the given NDI source and expose them via a
 * loopback TCP server. Returns once the server is listening AND the first
 * NDI frame has arrived so the caller knows the resolution to pass to
 * ffmpeg. Fails fast (rejects) if the source can't be opened within ~5 s.
 */
export async function startNdiReceiver(opts: StartReceiverOpts): Promise<ReceiverHandle> {
  const g = loadGrandiose()
  if (!g) throw new Error('grandiose-not-available')

  // Find the source object that matches the requested name — receive()
  // wants the full {name, urlAddress} pair, not just the display name.
  const finder = await g.find({ showLocalSources: true })
  try {
    await new Promise(r => setTimeout(r, 1500))
    const sources = await finder.sources()
    const match = sources.find(s => s.name === opts.sourceName)
    if (!match) throw new Error(`ndi-source-not-found: ${opts.sourceName}`)

    const colorFormat = opts.wantAlpha ? g.COLOR_FORMAT_UYVY_BGRA : g.COLOR_FORMAT_FASTEST
    const receiver = await g.receive({
      source:    { name: match.name, urlAddress: match.urlAddress },
      colorFormat,
      bandwidth: g.BANDWIDTH_HIGHEST,
      allowVideoFields: false,
    })

    return await runReceiver(receiver, opts.wantAlpha)
  } finally {
    try { finder.destroy() } catch { /* nothing to do */ }
  }
}

/** Wire a running grandiose receiver to a fresh TCP loopback server and
 *  return the handle to the caller. Internal — startNdiReceiver picks the
 *  receiver, this function bridges it to TCP. */
async function runReceiver(
  receiver:  GrandioseReceiver,
  wantAlpha: boolean,
): Promise<ReceiverHandle> {
  const events = new EventEmitter()
  let stopped = false
  let clientSocket: net.Socket | null = null

  // Pull the first frame BEFORE starting the TCP server — we need the
  // resolution to hand back to the caller anyway, and bailing early on a
  // bad source produces a much friendlier UX than letting ffmpeg fail.
  const firstFrame = await receiver.video(5000)
  if (!firstFrame) throw new Error('ndi-no-frame-within-5s')

  const pixFmt = pickPixFmt(firstFrame.fourCC, wantAlpha)
  const width  = firstFrame.xres
  const height = firstFrame.yres

  const server = net.createServer({ allowHalfOpen: false }, sock => {
    // Only one client (the streamer's ffmpeg). If a second connects (e.g.
    // user restarted stream without us tearing down), close the old one.
    if (clientSocket && !clientSocket.destroyed) {
      try { clientSocket.destroy() } catch {}
    }
    clientSocket = sock
    sock.on('error', err => {
      // EPIPE / ECONNRESET happen when ffmpeg exits — not actionable.
      if ((err as NodeJS.ErrnoException).code === 'EPIPE' ||
          (err as NodeJS.ErrnoException).code === 'ECONNRESET') return
      events.emit('error', err)
    })
    // Push the first frame immediately so the consumer doesn't wait an
    // extra frame-period to see anything.
    try { sock.write(firstFrame.data) } catch { /* socket closed before write */ }
  })

  // Listen on an ephemeral loopback port — let the kernel pick the number.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('ndi-tcp-bind-failed')

  // Pump frames into the socket as they arrive. We deliberately do NOT
  // queue — ffmpeg dictates pace via TCP window. If a frame is "late" we
  // simply drop it (the next one is in flight already).
  ;(async () => {
    while (!stopped) {
      let frame: NdiVideoFrame | null = null
      try {
        frame = await receiver.video(1000)
      } catch (e) {
        events.emit('error', e instanceof Error ? e : new Error(String(e)))
        break
      }
      if (!frame) continue  // timeout — keep polling
      if (clientSocket && !clientSocket.destroyed) {
        try { clientSocket.write(frame.data) } catch { /* connection torn down */ }
      }
    }
  })().catch(err => events.emit('error', err))

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    try { clientSocket?.destroy() } catch {}
    try { server.close() } catch {}
    try { receiver.destroy() } catch {}
  }

  return {
    port:      addr.port,
    pixFmt,
    width,
    height,
    framerate: 30,
    stop,
    events,
  }
}

function pickPixFmt(fourCC: number, wantAlpha: boolean): 'uyvy422' | 'bgra' {
  // grandiose returns the actual fourCC of the delivered frame which lets
  // us pick the ffmpeg pixel format precisely. Fall back to "what we
  // asked for" if the value isn't one we know — better a misaligned
  // colour decode than a thrown error mid-stream.
  const g = _grandiose
  if (g) {
    if (fourCC === g.FOURCC_BGRA || fourCC === g.FOURCC_BGRX) return 'bgra'
    if (fourCC === g.FOURCC_UYVY) return 'uyvy422'
  }
  return wantAlpha ? 'bgra' : 'uyvy422'
}
