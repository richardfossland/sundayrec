import { E, $ } from './state'
import { clampMain, clampPlayable, effIntroDur, effOutroDur } from './geometry'
import { gainFactor } from './peaks'
import { formatTime } from './format'
import { getKeepSegs } from './cuts'
import { drawWaveform, updateMinimapViewport } from './waveform'
import { setCurrentTranscriptTime } from '../editor-transcript'
import { snapOutOfCut } from '../editor-page'

// ── Playback engine, seek/scroll + timecode display ─────────────────────────

/** Move playhead to an absolute extended-timeline second, stopping any active
 *  playback. Centralises the seek-and-redraw logic used by keyboard shortcuts.
 *  Snaps out of cuts so keyboard navigation always lands on playable audio. */
export function seekTo(sec: number): void {
  stopPlay()
  E.playStartSec = snapOutOfCut(clampPlayable(sec))
  updateTimecode(E.playStartSec)
  if (E.isVideoFile && E.videoEl) E.videoEl.currentTime = clampMain(E.playStartSec)
  const mainPlayhead = clampMain(E.playStartSec)
  if (mainPlayhead < E.vpStart || mainPlayhead > E.vpEnd) {
    const span = E.vpEnd - E.vpStart
    E.vpStart = Math.max(0, mainPlayhead - span * 0.3)
    E.vpEnd   = Math.min(E.duration, E.vpStart + span)
    updateMinimapViewport()
  }
  drawWaveform()
}

/** Jump playhead to the next/previous cut boundary. Direction = +1 forward,
 *  -1 backward. Considers both cut start and end so each cut counts as two
 *  navigation stops. */
export function jumpToCutBoundary(dir: 1 | -1): void {
  if (E.cuts.length === 0) return
  const ph = clampMain(E.playStartSec)
  const points: number[] = []
  for (const c of E.cuts) { points.push(c.start, c.end) }
  points.sort((a, b) => a - b)
  let target: number | null = null
  if (dir > 0) {
    target = points.find(p => p > ph + 0.05) ?? null
  } else {
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i] < ph - 0.05) { target = points[i]; break }
    }
  }
  if (target == null) return
  seekTo(target)
}

export function seekBy(secs: number): void {
  stopPlay()
  E.playStartSec = clampPlayable(E.playStartSec + secs)
  updateTimecode(E.playStartSec)
  if (E.isVideoFile && E.videoEl) E.videoEl.currentTime = clampMain(E.playStartSec)
  // Pan viewport when playhead drops out of view. Viewport itself stays in
  // main coords — intro/outro live in their own slots and always remain
  // visible when at the recording edge.
  const mainPlayhead = clampMain(E.playStartSec)
  if (mainPlayhead < E.vpStart || mainPlayhead > E.vpEnd) {
    const half = (E.vpEnd - E.vpStart) / 2
    E.vpStart = Math.max(0, mainPlayhead - half)
    E.vpEnd   = Math.min(E.duration, E.vpStart + half * 2)
    updateMinimapViewport()
  }
  drawWaveform()
}

export function autoScrollToPlayhead(curSec: number): void {
  // Auto-scroll only operates inside the main recording. Intro/outro slots
  // are fixed and always visible at their respective edges.
  if (curSec < 0 || curSec > E.duration) return
  const span = E.vpEnd - E.vpStart
  if (curSec > E.vpEnd - span * 0.1) {
    E.vpStart = curSec - span * 0.05
    E.vpEnd   = E.vpStart + span
    if (E.vpEnd > E.duration) { E.vpEnd = E.duration; E.vpStart = Math.max(0, E.duration - span) }
    updateMinimapViewport()
  }
}

export function togglePlay(preview: boolean): void {
  if (E.isPlaying && E.isPreview === preview) { stopPlay(); return }
  stopPlay()
  startPlay(preview)
}

// Track the current onEnded listener so we can remove it on manual stopPlay.
// Without removal, repeated start/stop accumulates dead listeners on videoEl
// (the once:true flag fires-and-removes, but only when the event actually
// fires — manual stop never fires it).
let videoEndedHandler: (() => void) | null = null

export function attachVideoEndedHandler(onEnded: () => void): void {
  if (!E.videoEl) return
  if (videoEndedHandler) E.videoEl.removeEventListener('ended', videoEndedHandler)
  videoEndedHandler = onEnded
  E.videoEl.addEventListener('ended', onEnded, { once: true })
}

export function detachVideoEndedHandler(): void {
  if (E.videoEl && videoEndedHandler) {
    E.videoEl.removeEventListener('ended', videoEndedHandler)
    videoEndedHandler = null
  }
}

export function startPlay(preview: boolean): void {
  // Video-only mode: no audio buffer, but video element can still play
  if (E.isVideoFile && E.videoEl && !E.audioBuffer) {
    E.isPreview    = preview
    E.loopStartSec = E.playStartSec
    E.isPlaying    = true
    E.videoEl.currentTime = clampMain(E.playStartSec)
    E.videoEl.play().catch(() => {})
    attachVideoEndedHandler(() => {
      videoEndedHandler = null
      if (!E.isPlaying) return
      if (E.isLooping) { stopPlay(); E.playStartSec = E.loopStartSec; startPlay(E.isPreview) }
      else { E.isPlaying = false; cancelAnimationFrame(E.rafId); updatePlayIcon(); drawWaveform() }
    })
    updatePlayIcon()
    animate()
    return
  }

  if (!E.audioBuffer || !E.audioCtx) return

  // Video playback: drive the video element, use Web Audio only for gain meter
  if (E.isVideoFile && E.videoEl) {
    E.isPreview    = preview
    E.loopStartSec = E.playStartSec
    E.isPlaying    = true
    E.videoEl.currentTime = clampMain(E.playStartSec)
    E.videoEl.play().catch(() => {})

    // On natural end, handle loop / stop
    attachVideoEndedHandler(() => {
      videoEndedHandler = null
      if (!E.isPlaying) return
      if (E.isLooping) {
        stopPlay()
        E.playStartSec = E.loopStartSec
        startPlay(E.isPreview)
      } else {
        E.isPlaying = false
        cancelAnimationFrame(E.rafId)
        updatePlayIcon()
        drawWaveform()
      }
    })

    updatePlayIcon()
    animate()
    return
  }

  // If the playhead has somehow ended up inside a cut (e.g. arrow-key seek
  // landed there), snap it to the cut's end before scheduling so audio and
  // playhead stay in sync from the very first frame.
  E.playStartSec = snapOutOfCut(E.playStartSec)

  E.isPreview = preview
  E.loopStartSec = E.playStartSec

  // Extended-timeline playback: playStartSec can be inside intro (< 0),
  // main ([0, duration]), or outro (> duration). We schedule each region's
  // buffer at the right offset so audio always matches the playhead.
  const introOn = E.includeIntroOutro && !!E.introBuffer
  const outroOn = E.includeIntroOutro && !!E.outroBuffer
  const inIntro = E.playStartSec < 0 && introOn
  const inOutro = E.playStartSec > E.duration && outroOn
  const mainStartSec = inIntro ? 0 : (inOutro ? E.duration : Math.max(0, E.playStartSec))

  E.isPlaying        = true
  E.playStartCtxTime = E.audioCtx.currentTime

  let when = E.audioCtx.currentTime
  const nodes: AudioBufferSourceNode[] = []

  const mixGain = E.audioCtx.createGain()
  // Apply the user-set peak-normalization gain to playback. This mirrors
  // the ffmpeg `volume={gainDb}dB` filter we add at export time so what
  // they hear during preview matches what they'll get in the exported file.
  mixGain.gain.value = gainFactor()
  mixGain.connect(E.audioCtx.destination)

  // Schedule intro from the right offset whenever playhead is at-or-before
  // main start. When playhead is inside intro (negative sec) we start the
  // intro from `effIntroDur + playStartSec` so audio matches the playhead.
  if (introOn && E.playStartSec < E.duration) {
    const iDur = E.introBuffer!.duration
    const introOffset = inIntro ? Math.max(0, effIntroDur() + E.playStartSec) : 0
    const playDur = iDur - introOffset
    if (playDur > 0.01) {
      const introNode = E.audioCtx.createBufferSource()
      introNode.buffer = E.introBuffer
      introNode.connect(mixGain)
      introNode.start(when, introOffset, playDur)
      when += playDur
      nodes.push(introNode)
    }
  }

  if (!inOutro) {
    const allSegs  = preview ? getKeepSegs() : [{ start: 0, end: E.duration }]
    const segments = allSegs.filter(s => s.end > mainStartSec)

    let firstMainSec = -1
    for (let i = 0; i < segments.length; i++) {
      const seg    = segments[i]
      const offset = i === 0 ? Math.max(0, mainStartSec - seg.start) : 0
      const dur    = seg.end - seg.start - offset
      if (dur <= 0.01) continue

      if (firstMainSec < 0) firstMainSec = seg.start + offset

      const node = E.audioCtx.createBufferSource()
      node.buffer = E.audioBuffer
      node.connect(mixGain)
      node.start(when, seg.start + offset, dur)
      when += dur
      nodes.push(node)
    }
    // Preview-skip: if playback skipped over a cut and started later, advance
    // playStartSec so the playhead matches where audio actually starts. Only
    // applies when not playing through intro (we keep negative playStartSec
    // while inside intro so the timecode shows "Intro …").
    if (!inIntro && firstMainSec >= 0 && firstMainSec > mainStartSec + 0.01) {
      E.playStartSec = firstMainSec
    }
  }

  E.sourceNodes = nodes

  // Schedule outro after main content (or partway through if playhead is
  // already inside outro).
  if (outroOn) {
    const outroOffset = inOutro ? Math.max(0, E.playStartSec - E.duration) : 0
    const oDur = E.outroBuffer!.duration - outroOffset
    if (oDur > 0.01) {
      const outroNode = E.audioCtx.createBufferSource()
      outroNode.buffer = E.outroBuffer
      outroNode.connect(mixGain)
      outroNode.start(when, outroOffset, oDur)
      nodes.push(outroNode)
    }
  }

  if (nodes.length === 0) { E.isPlaying = false; return }

  nodes[nodes.length - 1]?.addEventListener('ended', () => {
    if (!E.isPlaying) return
    if (E.isLooping) {
      stopPlay()
      E.playStartSec = E.loopStartSec
      startPlay(E.isPreview)
    } else {
      E.isPlaying = false
      cancelAnimationFrame(E.rafId)
      updatePlayIcon()
      drawWaveform()
    }
  })

  updatePlayIcon()
  animate()
}

export function stopPlay(): void {
  detachVideoEndedHandler()
  if (E.isVideoFile && E.videoEl) {
    if (E.isPlaying) {
      E.playStartSec = E.videoEl.currentTime
    }
    E.videoEl.pause()
    E.isPlaying = false
    cancelAnimationFrame(E.rafId)
    updatePlayIcon()
    drawWaveform()
    return
  }

  for (const n of E.sourceNodes) { try { n.stop() } catch { /* already stopped */ } }
  E.sourceNodes = []
  if (E.isPlaying && E.audioCtx) {
    E.playStartSec = clampPlayable(E.playStartSec + (E.audioCtx.currentTime - E.playStartCtxTime))
  }
  E.isPlaying = false
  cancelAnimationFrame(E.rafId)
  updatePlayIcon()
  drawWaveform()
}

export function animate(): void {
  if (!E.isPlaying) return

  if (E.isVideoFile && E.videoEl) {
    const curSec = E.videoEl.currentTime

    // Preview mode: skip over cut regions
    if (E.isPreview) {
      const nextCut = E.cuts.find(c => curSec >= c.start && curSec < c.end)
      if (nextCut) {
        E.videoEl.currentTime = nextCut.end
        E.playStartSec = nextCut.end
      }
    }

    updateTimecode(curSec)
    autoScrollToPlayhead(curSec)
    setCurrentTranscriptTime(curSec)
    drawWaveform()
    E.rafId = requestAnimationFrame(animate)
    return
  }

  if (!E.audioCtx) return
  const curSec = E.playStartSec + (E.audioCtx.currentTime - E.playStartCtxTime)
  updateTimecode(curSec)
  autoScrollToPlayhead(curSec)
  setCurrentTranscriptTime(curSec)
  drawWaveform()
  E.rafId = requestAnimationFrame(animate)
}

export function updatePlayIcon(): void {
  const icon       = $('editor-play-icon')
  const previewBtn = $('btn-editor-preview')
  const canvasWrap = $('editor-canvas-wrap')
  if (!icon) return
  if (E.isPlaying && !E.isPreview) {
    icon.innerHTML = '<rect x="5" y="4" width="4" height="12" rx="1"/><rect x="11" y="4" width="4" height="12" rx="1"/>'
    previewBtn?.classList.remove('is-playing')
    canvasWrap?.classList.add('is-playing')
  } else if (E.isPlaying && E.isPreview) {
    icon.innerHTML = '<path d="M6.3 4.6a1 1 0 011.4 0l6 5a1 1 0 010 1.6l-6 5A1 1 0 016 15.4V4.6z"/>'
    previewBtn?.classList.add('is-playing')
    canvasWrap?.classList.add('is-playing')
  } else {
    icon.innerHTML = '<path d="M6.3 4.6a1 1 0 011.4 0l6 5a1 1 0 010 1.6l-6 5A1 1 0 016 15.4V4.6z"/>'
    canvasWrap?.classList.remove('is-playing')
    previewBtn?.classList.remove('is-playing')
  }
}

export function updateTimecode(sec: number): void {
  const el = $('editor-time-cur')
  if (!el) return
  // Show "Intro 0:12" / "Outro 0:05" prefix when playhead is in those slots
  // so the user can see at a glance where they are on the extended timeline.
  if (sec < 0 && effIntroDur() > 0) {
    el.textContent = `Intro ${formatTime(sec + effIntroDur())}`
  } else if (sec > E.duration && effOutroDur() > 0) {
    el.textContent = `Outro ${formatTime(sec - E.duration)}`
  } else {
    el.textContent = formatTime(Math.max(0, Math.min(sec, E.duration)))
  }
}

export function updateTotalTime(): void {
  const el = $('editor-time-tot')
  if (el) el.textContent = formatTime(E.duration)
}
