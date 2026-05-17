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
  const audioCtx = new AudioContext({ latencyHint: 'playback', sampleRate: requestedRate })
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
  vuSplitter.connect(vuAnalyserR, 1)

  return { stream, audioCtx, vuAnalyserL, vuAnalyserR, inputRouter, opts }
}

export async function stopMonitorStream(session: MonitorSession): Promise<void> {
  session.stream.getTracks().forEach(t => t.stop())
  await session.audioCtx.close().catch(() => {})
}

export async function reconnectMonitorStream(session: MonitorSession): Promise<boolean> {
  const { opts, audioCtx, inputRouter } = session
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
    inputRouter.disconnect()
    const vuSplitter = audioCtx.createChannelSplitter(2)
    newRouter.connect(vuSplitter)
    vuSplitter.connect(session.vuAnalyserL, 0)
    vuSplitter.connect(session.vuAnalyserR, 1)
    session.stream.getTracks().forEach(t => { t.onended = null; t.stop() })
    session.stream      = newStream
    session.inputRouter = newRouter
    return true
  } catch {
    return false
  }
}
