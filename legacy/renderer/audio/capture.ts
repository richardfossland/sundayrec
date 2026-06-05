/**
 * Audio monitoring pipeline (renderer-side).
 *
 * In the v4.1 architecture, recording is handled entirely by ffmpeg in the main
 * process (native-recorder.ts). This module is ONLY responsible for:
 *   • Enumerating audio devices for the settings UI
 *   • Opening a lightweight monitoring stream for the VU meter display
 *
 * A renderer crash no longer affects the recording.
 */

import type { RecordingOpts } from '../../types'

// ── Types ────────────────────────────────────────────────────────────────────

export interface MonitorSession {
  stream:      MediaStream
  audioCtx:    AudioContext
  vuAnalyserL: AnalyserNode
  vuAnalyserR: AnalyserNode
  inputRouter: AudioNode
  src:         MediaStreamAudioSourceNode
  opts:        RecordingOpts
}

// ── Device helpers ───────────────────────────────────────────────────────────

export async function getAudioDevices(): Promise<MediaDeviceInfo[]> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    s.getTracks().forEach(t => t.stop())
    return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput')
  } catch { return [] }
}

export async function detectDeviceChannels(deviceId: string | null | undefined): Promise<number> {
  if (!deviceId || deviceId === 'default' || deviceId === '') return 2
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { ideal: deviceId }, channelCount: { ideal: 32 } },
      video: false
    })
    const ch = s.getAudioTracks()[0]?.getSettings().channelCount ?? 2
    s.getTracks().forEach(t => t.stop())
    return Math.max(2, ch)
  } catch { return 2 }
}

// ── VU meter channel helper ──────────────────────────────────────────────────

/**
 * Which channel-splitter output should drive the RIGHT VU analyser.
 *
 * WKWebView's `getUserMedia` commonly delivers a MONO track — most microphones
 * (and the built-in Mac mic) are mono, and it doesn't reliably honour
 * `channelCount: { ideal: 2 }`. Feeding such a stream into a 2-channel splitter
 * leaves output 1 (R) silent, so the meter shows only L even when "Stereo" is
 * selected (the reported bug). A Stereo recording of a mono source is dual-mono
 * (the backend ffmpeg duplicates L→R via `-ac 2`), so the meter SHOULD show both
 * bars. We therefore mirror channel 0 into R unless the device DEFINITIVELY
 * reports ≥2 channels (a real stereo interface), which keeps independent L/R.
 */
export function rVuChannel(stream: MediaStream): number {
  const ch = stream.getAudioTracks()[0]?.getSettings().channelCount ?? 0
  return ch >= 2 ? 1 : 0
}

// ── Channel routing helper (also used by audio-page.ts) ─────────────────────

export function buildInputRouter(
  ctx: AudioContext,
  src: MediaStreamAudioSourceNode,
  stream: MediaStream,
  chL: number,
  chR: number
): AudioNode {
  const actualCh = stream.getAudioTracks()[0]?.getSettings().channelCount ?? 2
  if (actualCh <= 2 && chL === 0 && chR === 1) return src
  const n        = Math.max(actualCh, Math.max(chL, chR) + 1)
  const splitter = ctx.createChannelSplitter(n)
  const merger   = ctx.createChannelMerger(2)
  src.connect(splitter)
  splitter.connect(merger, Math.min(chL, actualCh - 1), 0)
  splitter.connect(merger, Math.min(chR, actualCh - 1), 1)
  return merger
}

// ── getUserMedia with fallback chain ─────────────────────────────────────────

async function getUserMediaWithFallback(
  deviceId: string | null,
  baseConstraints: MediaTrackConstraints
): Promise<MediaStream> {
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...baseConstraints, deviceId: { exact: deviceId } }, video: false
      })
    } catch {}
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...baseConstraints, deviceId: { ideal: deviceId } }, video: false
      })
    } catch {}
    console.warn('[monitor] Stored deviceId not available, falling back to default device')
  }
  return await navigator.mediaDevices.getUserMedia({ audio: baseConstraints, video: false })
}

// ── Start / stop monitoring ──────────────────────────────────────────────────

export async function startMonitorStream(opts: RecordingOpts): Promise<MonitorSession> {
  const realDeviceId = opts.deviceId && opts.deviceId !== 'default' && opts.deviceId !== ''
    ? opts.deviceId : null

  const chL = opts.channelL ?? 0
  const chR = opts.channelR ?? 1
  const neededCh = Math.max(
    opts.channels === 'stereo' || opts.channels === 'monoL' || opts.channels === 'monoR' ? 2 : 1,
    chL + 1, chR + 1
  )

  const constraints: MediaTrackConstraints = {
    channelCount:     { ideal: neededCh },
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl:  false
  }

  const stream = await getUserMediaWithFallback(realDeviceId, constraints)

  const requestedRate = opts.sampleRate ?? 48000
  const audioCtx = new AudioContext({ latencyHint: 'interactive', sampleRate: requestedRate })
  if (audioCtx.sampleRate !== requestedRate) {
    console.warn(`[monitor] Requested ${requestedRate}Hz but got ${audioCtx.sampleRate}Hz`)
  }

  const src        = audioCtx.createMediaStreamSource(stream)
  const inputRouter = buildInputRouter(audioCtx, src, stream, chL, chR)

  // VU analysers — tapped after input routing
  const vuSplitter  = audioCtx.createChannelSplitter(2)
  const vuAnalyserL = audioCtx.createAnalyser(); vuAnalyserL.fftSize = 1024
  const vuAnalyserR = audioCtx.createAnalyser(); vuAnalyserR.fftSize = 1024
  inputRouter.connect(vuSplitter)
  vuSplitter.connect(vuAnalyserL, 0)
  // Mirror mono → R so the R meter isn't dead on a mono mic (see rVuChannel).
  vuSplitter.connect(vuAnalyserR, rVuChannel(stream))

  return { stream, audioCtx, vuAnalyserL, vuAnalyserR, inputRouter, src, opts }
}

export async function stopMonitorStream(session: MonitorSession): Promise<void> {
  session.stream.getTracks().forEach(t => t.stop())
  await session.audioCtx.close().catch(() => {})
}

export async function reconnectMonitorStream(session: MonitorSession): Promise<boolean> {
  const { opts, audioCtx, inputRouter, src: oldSrc } = session
  const realDeviceId = opts.deviceId && opts.deviceId !== 'default' ? opts.deviceId : null
  const chL = opts.channelL ?? 0
  const chR = opts.channelR ?? 1
  const neededCh = Math.max(
    opts.channels === 'stereo' || opts.channels === 'monoL' || opts.channels === 'monoR' ? 2 : 1,
    chL + 1, chR + 1
  )
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(realDeviceId ? { deviceId: { ideal: realDeviceId } } : {}),
        channelCount: { ideal: neededCh },
        echoCancellation: false, noiseSuppression: false, autoGainControl: false
      },
      video: false
    })
    const newSrc    = audioCtx.createMediaStreamSource(newStream)
    const newRouter = buildInputRouter(audioCtx, newSrc, newStream, chL, chR)
    // Disconnect old graph before replacing; oldSrc.disconnect() covers both the
    // simple case (inputRouter === src) and the splitter/merger path
    try { oldSrc.disconnect() }     catch {}
    try { inputRouter.disconnect() } catch {}
    const vuSplitter = audioCtx.createChannelSplitter(2)
    newRouter.connect(vuSplitter)
    vuSplitter.connect(session.vuAnalyserL, 0)
    vuSplitter.connect(session.vuAnalyserR, rVuChannel(newStream))
    session.stream.getTracks().forEach(t => { t.onended = null; t.stop() })
    session.stream      = newStream
    session.inputRouter = newRouter
    session.src         = newSrc
    return true
  } catch {
    return false
  }
}
