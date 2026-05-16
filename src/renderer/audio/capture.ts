/**
 * Audio capture pipeline.
 *
 * PCM fix: for lossless formats (WAV/FLAC) we request audio/webm;codecs=pcm
 * from MediaRecorder to avoid Opus→WAV transcoding artifacts. Falls back to
 * audio/webm;codecs=opus for lossy formats.
 */

import type { RecordingOpts } from '../../types'

export interface CaptureSession {
  stream:        MediaStream
  audioCtx:      AudioContext
  mediaRecorder: MediaRecorder
  recStartTime:  number
  recBytes:      number
  vuAnalyserL:   AnalyserNode
  vuAnalyserR:   AnalyserNode
  inputRouter:   AudioNode   // exposed for USB hot-swap
  gain:          GainNode    // exposed for USB hot-swap
  opts:          RecordingOpts
}

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

export async function detectDeviceChannels(deviceId: string | null | undefined): Promise<number> {
  if (!deviceId || deviceId === 'default' || deviceId === '') return 2
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId }, channelCount: { ideal: 32 } },
      video: false
    })
    const ch = s.getAudioTracks()[0]?.getSettings().channelCount ?? 2
    s.getTracks().forEach(t => t.stop())
    return Math.max(2, ch)
  } catch { return 2 }
}

export async function getAudioDevices(): Promise<MediaDeviceInfo[]> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    s.getTracks().forEach(t => t.stop())
    return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput')
  } catch { return [] }
}

function chooseMime(format: string): string {
  const isLossless = format === 'wav' || format === 'flac'
  if (isLossless && MediaRecorder.isTypeSupported('audio/webm;codecs=pcm')) {
    return 'audio/webm;codecs=pcm'
  }
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus'
  return 'audio/webm'
}

export async function startCapture(opts: RecordingOpts): Promise<CaptureSession> {
  const realDeviceId = opts.deviceId && opts.deviceId !== 'default' && opts.deviceId !== ''
    ? opts.deviceId : null

  const chL  = opts.channelL ?? 0
  const chR  = opts.channelR ?? 1
  const isMonoChannel = opts.channels === 'monoL' || opts.channels === 'monoR'
  const neededCh = Math.max(
    opts.channels === 'stereo' || isMonoChannel ? 2 : 1,
    chL + 1, chR + 1
  )

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(realDeviceId ? { deviceId: { exact: realDeviceId } } : {}),
      channelCount:     { ideal: neededCh },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl:  false
    },
    video: false
  })

  const audioCtx = new AudioContext()
  const src      = audioCtx.createMediaStreamSource(stream)
  const inputNode = buildInputRouter(audioCtx, src, stream, chL, chR)

  // Input gain
  const gain = audioCtx.createGain()
  gain.gain.value = (opts.inputVolume ?? 80) / 100

  // 3-band EQ
  const bassEQ = audioCtx.createBiquadFilter()
  bassEQ.type = 'lowshelf'; bassEQ.frequency.value = 100
  bassEQ.gain.value = opts.eqBass ?? 0

  const midEQ = audioCtx.createBiquadFilter()
  midEQ.type = 'peaking'; midEQ.frequency.value = 1000; midEQ.Q.value = 1
  midEQ.gain.value = opts.eqMid ?? 0

  const trebleEQ = audioCtx.createBiquadFilter()
  trebleEQ.type = 'highshelf'; trebleEQ.frequency.value = 8000
  trebleEQ.gain.value = opts.eqTreble ?? 0

  // Compressor (bypass when disabled)
  const comp = audioCtx.createDynamicsCompressor()
  if (opts.compEnabled) {
    comp.threshold.value = opts.compThreshold ?? -24
    comp.ratio.value     = opts.compRatio     ?? 4
    comp.knee.value      = 6
    comp.attack.value    = (opts.compAttack  ?? 10)  / 1000
    comp.release.value   = (opts.compRelease ?? 200) / 1000
  } else {
    comp.threshold.value = 0; comp.ratio.value = 1
  }

  // Limiter (always present — protects recordings from clipping)
  const limiter = audioCtx.createDynamicsCompressor()
  if (opts.limiterEnabled !== false) {
    limiter.threshold.value = opts.limiterCeiling ?? -1
    limiter.ratio.value     = 20
    limiter.knee.value      = 0
    limiter.attack.value    = 0.001
    limiter.release.value   = 0.1
  } else {
    limiter.threshold.value = 0; limiter.ratio.value = 1
  }

  const dest = audioCtx.createMediaStreamDestination()
  inputNode.connect(gain).connect(bassEQ).connect(midEQ).connect(trebleEQ).connect(comp).connect(limiter)

  if (isMonoChannel) {
    const splitter = audioCtx.createChannelSplitter(2)
    limiter.connect(splitter)
    splitter.connect(dest, opts.channels === 'monoL' ? 0 : 1, 0)
  } else {
    limiter.connect(dest)
  }

  // VU tap after limiter — always 2ch
  const vuSplitter = audioCtx.createChannelSplitter(2)
  const vuAnalyserL = audioCtx.createAnalyser(); vuAnalyserL.fftSize = 1024
  const vuAnalyserR = audioCtx.createAnalyser(); vuAnalyserR.fftSize = 1024
  limiter.connect(vuSplitter)
  vuSplitter.connect(vuAnalyserL, 0)
  vuSplitter.connect(vuAnalyserR, 1)

  const mime         = chooseMime(opts.format ?? 'mp3')
  const mediaRecorder = new MediaRecorder(dest.stream, { mimeType: mime })
  const recStartTime  = Date.now()
  let   recBytes      = 0

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      recBytes += e.data.size
      e.data.arrayBuffer()
        .then(buf => window.api.sendAudioChunk(buf))
        .catch(err => console.error('audio chunk dropped:', err))
    }
  }

  mediaRecorder.start(1000)

  return { stream, audioCtx, mediaRecorder, recStartTime, recBytes, vuAnalyserL, vuAnalyserR, inputRouter: inputNode, gain, opts }
}

export async function reconnectStream(session: CaptureSession): Promise<boolean> {
  const { opts, audioCtx, inputRouter, gain } = session
  const realDeviceId = opts.deviceId && opts.deviceId !== 'default' && opts.deviceId !== ''
    ? opts.deviceId : null
  const chL = opts.channelL ?? 0
  const chR = opts.channelR ?? 1
  const isMonoChannel = opts.channels === 'monoL' || opts.channels === 'monoR'
  const neededCh = Math.max(
    opts.channels === 'stereo' || isMonoChannel ? 2 : 1,
    chL + 1, chR + 1
  )
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(realDeviceId ? { deviceId: { exact: realDeviceId } } : {}),
        channelCount: { ideal: neededCh },
        echoCancellation: false, noiseSuppression: false, autoGainControl: false
      },
      video: false
    })
    const newSrc    = audioCtx.createMediaStreamSource(newStream)
    const newRouter = buildInputRouter(audioCtx, newSrc, newStream, chL, chR)
    inputRouter.disconnect()
    newRouter.connect(gain)
    session.stream.getTracks().forEach(t => { t.onended = null; t.stop() })
    session.stream      = newStream
    session.inputRouter = newRouter
    return true
  } catch {
    return false
  }
}

export async function stopCapture(session: CaptureSession): Promise<void> {
  if (session.mediaRecorder.state !== 'inactive') {
    await new Promise<void>(resolve => {
      const prev = session.mediaRecorder.onstop
      session.mediaRecorder.onstop = (e) => { (prev as ((e: Event) => void) | null)?.(e); resolve() }
      session.mediaRecorder.stop()
    })
  }
  session.stream.getTracks().forEach(t => t.stop())
  await session.audioCtx.close()
}
