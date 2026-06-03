import { E } from './state'
import { xToSec, xToMainSec, secToX, clampMain, clampPlayable, maxPlayableSec } from './geometry'
import { addCut, deleteCut, pushCutHistory, renderCutList, updateRemainingDisplay } from './cuts'
import { drawWaveform, scheduleDrawWaveform, drawMinimap, updateMinimapViewport } from './waveform'
import { stopPlay, updateTimecode } from './playback'
import { shouldShowSegment } from './detection'
import { panBy } from './viewport'

// ── Canvas mouse/wheel input + minimap drag ─────────────────────────────────

export function onCanvasDown(e: MouseEvent): void {
  if (!E.peaks || e.button !== 0) return
  const rect = E.canvas.getBoundingClientRect()
  const extSec  = xToSec(e.clientX - rect.left, rect.width)
  const mainSec = xToMainSec(e.clientX - rect.left, rect.width)

  // Check if clicking near a cut boundary → start handle drag. Cut handles
  // only live in main coords, so this uses mainSec.
  const threshold = (E.vpEnd - E.vpStart) / rect.width * 10
  for (let i = 0; i < E.cuts.length; i++) {
    if (Math.abs(mainSec - E.cuts[i].start) < threshold) {
      E.handleDrag = { cutIdx: i, side: 'start' }
      return
    }
    if (Math.abs(mainSec - E.cuts[i].end) < threshold) {
      E.handleDrag = { cutIdx: i, side: 'end' }
      return
    }
  }

  // Check if clicking near playhead in the ruler area → playhead drag
  const yInCanvas = e.clientY - rect.top
  const playX = secToX(E.playStartSec, rect.width)
  if (Math.abs(e.clientX - rect.left - playX) < 12 && yInCanvas < 28) {
    E.playheadDragging = true
    stopPlay()
    return
  }

  // Normal drag to create cut — drag coords are clamped to main, since cuts
  // can only exist inside the recording.
  E.dragStartSec = clampMain(extSec)
  E.dragEndSec   = E.dragStartSec
  E.isDragging   = true
}

export function onCanvasMove(e: MouseEvent): void {
  if (!E.peaks) return
  const rect = E.canvas.getBoundingClientRect()
  const extSec  = xToSec(e.clientX - rect.left, rect.width)
  const mainSec = xToMainSec(e.clientX - rect.left, rect.width)

  // Handle drag: resize cut boundary. Snap to nearby segment boundaries when
  // shift is NOT held — gives precise lock-in to detected speech/music edges.
  // Repaints are rAF-coalesced so 60+ mousemoves/sec only redraw ~60 times.
  if (E.handleDrag) {
    const c = E.cuts[E.handleDrag.cutIdx]
    const snapped = e.shiftKey ? mainSec : snapToSegmentBoundary(mainSec, rect.width)
    if (E.handleDrag.side === 'start') {
      c.start = Math.max(0, Math.min(c.end - 0.1, snapped))
    } else {
      c.end   = Math.min(E.duration, Math.max(c.start + 0.1, snapped))
    }
    updateRemainingDisplay()
    scheduleDrawWaveform()
    return
  }

  // Playhead drag — covers full extended timeline (intro/main/outro)
  if (E.playheadDragging) {
    E.playStartSec = clampPlayable(extSec)
    updateTimecode(E.playStartSec)
    if (E.isVideoFile && E.videoEl) E.videoEl.currentTime = clampMain(E.playStartSec)
    scheduleDrawWaveform()
    return
  }

  E.hoverSec = extSec

  // Cursor feedback
  const threshold = (E.vpEnd - E.vpStart) / rect.width * 10
  const nearBoundary = E.cuts.some(c =>
    Math.abs(mainSec - c.start) < threshold || Math.abs(mainSec - c.end) < threshold
  )
  const overCut = E.cuts.some(c => mainSec >= c.start && mainSec <= c.end)
  const nearPlayhead = Math.abs(e.clientX - rect.left - secToX(E.playStartSec, rect.width)) < 12
    && (e.clientY - rect.top) < 28

  E.canvas.style.cursor = nearBoundary ? 'ew-resize'
    : nearPlayhead    ? 'col-resize'
    : overCut         ? 'pointer'
    : 'crosshair'

  if (E.isDragging) E.dragEndSec = clampMain(extSec)

  scheduleDrawWaveform()
}

export function onCanvasUp(e: MouseEvent): void {
  if (!E.peaks) return
  const rect  = E.canvas.getBoundingClientRect()
  const extSec = xToSec(e.clientX - rect.left, rect.width)
  const upMainSec = xToMainSec(e.clientX - rect.left, rect.width)

  if (E.handleDrag) {
    E.handleDrag = null
    E.cuts.sort((a, b) => a.start - b.start)
    pushCutHistory()
    renderCutList()
    updateRemainingDisplay()
    drawWaveform()
    drawMinimap()
    return
  }

  if (E.playheadDragging) {
    E.playheadDragging = false
    // Snap playhead out of any cut region the user dragged into — cuts are
    // "skip me" zones, so resting the playhead inside one is meaningless.
    E.playStartSec = snapOutOfCut(E.playStartSec)
    updateTimecode(E.playStartSec)
    if (E.isVideoFile && E.videoEl) E.videoEl.currentTime = clampMain(E.playStartSec)
    drawWaveform()
    return
  }

  if (!E.isDragging) return
  E.isDragging = false

  // Cut-creation drag: hold shift to disable snap, otherwise snap both edges
  // to nearby detected segment boundaries.
  if (Math.abs(upMainSec - E.dragStartSec) > 0.1) {
    const s = e.shiftKey ? E.dragStartSec : snapToSegmentBoundary(E.dragStartSec, rect.width)
    const eSec = e.shiftKey ? upMainSec : snapToSegmentBoundary(upMainSec, rect.width)
    addCut(s, eSec)
    renderCutList()
  } else {
    // Tap to seek — covers full extended timeline so users can click into
    // intro/outro slots. If the click lands inside a cut, snap to the cut's
    // end (the nearest keep-region start) so playback always begins at a
    // position that will actually produce audio.
    stopPlay()
    E.playStartSec = snapOutOfCut(clampPlayable(extSec))
    updateTimecode(E.playStartSec)
    if (E.isVideoFile && E.videoEl) E.videoEl.currentTime = clampMain(E.playStartSec)
  }

  E.dragStartSec = -1
  E.dragEndSec   = -1
  drawWaveform()
  drawMinimap()
}

export function onCanvasLeave(): void {
  E.hoverSec = -99999

  if (E.handleDrag) {
    E.handleDrag = null
    E.cuts.sort((a, b) => a.start - b.start)
    pushCutHistory()
    renderCutList()
    updateRemainingDisplay()
    drawWaveform(); drawMinimap()
    return
  }

  if (E.playheadDragging) {
    E.playheadDragging = false
    drawWaveform()
    return
  }

  if (E.isDragging) {
    E.isDragging = false
    if (Math.abs(E.dragEndSec - E.dragStartSec) > 0.1) {
      addCut(E.dragStartSec, E.dragEndSec)
      renderCutList()
    }
    E.dragStartSec = -1; E.dragEndSec = -1
    drawWaveform(); drawMinimap()
  } else {
    drawWaveform()
  }
}

export function onCanvasContextMenu(e: MouseEvent): void {
  e.preventDefault()
  if (!E.peaks) return
  const rect = E.canvas.getBoundingClientRect()
  const mainSec = xToMainSec(e.clientX - rect.left, rect.width)
  const idx  = E.cuts.findIndex(c => mainSec >= c.start && mainSec <= c.end)
  if (idx >= 0) deleteCut(idx)
}

export function onCanvasWheel(e: WheelEvent): void {
  e.preventDefault()
  if (e.ctrlKey || e.metaKey) {
    // Zoom centered on mouse position (main coords only — intro/outro slots
    // have their own fixed scale).
    const rect = E.canvas.getBoundingClientRect()
    const mouseSec = xToMainSec(e.clientX - rect.left, rect.width)
    const factor   = e.deltaY > 0 ? 1.25 : 0.75
    const span     = (E.vpEnd - E.vpStart) * factor
    const frac     = (mouseSec - E.vpStart) / (E.vpEnd - E.vpStart)
    E.vpStart = Math.max(0, mouseSec - frac * span)
    E.vpEnd   = Math.min(E.duration, E.vpStart + span)
    if (E.vpEnd - E.vpStart < 0.5) { E.vpEnd = E.vpStart + 0.5 }
    drawWaveform()
    updateMinimapViewport()
  } else {
    panBy(e.deltaY * (E.vpEnd - E.vpStart) / 800)
  }
}

/** If `sec` falls inside a cut region, return the cut's end (the nearest
 *  keep-region start). Cuts are skip-zones — the playhead resting inside
 *  one is meaningless because no audio plays there. Out-of-range or
 *  already-outside-cut input is returned unchanged. */
export function snapOutOfCut(sec: number): number {
  for (const c of E.cuts) {
    if (sec >= c.start && sec < c.end) {
      // Snap to the cut's end, clamped to the playable range so we never
      // overshoot duration when a trailing cut runs to the file end.
      return Math.min(maxPlayableSec(), c.end)
    }
  }
  return sec
}

/** Snaps a main-coords second to the nearest detected segment boundary within
 *  threshold (default ~0.4 sec). Falls through to input unchanged when no
 *  suggestions are loaded or no boundary is close enough. */
export function snapToSegmentBoundary(sec: number, W: number): number {
  if (!E.suggestions.length) return sec
  // Threshold scales with zoom level (~8 px) — tight at high zoom, lenient
  // when zoomed out so coarse drags still find the boundary.
  const threshold = Math.max(0.15, ((E.vpEnd - E.vpStart) / Math.max(1, W)) * 8)
  let closest = sec
  let minDist = threshold
  for (const seg of E.suggestions) {
    if (!shouldShowSegment(seg.type)) continue
    for (const t of [seg.start, seg.end]) {
      const d = Math.abs(sec - t)
      if (d < minDist) { minDist = d; closest = t }
    }
  }
  return closest
}

// Module-scoped listener refs so repeated setupEditorPage() calls (renderer
// reload, page-switch) don't keep adding new window-level listeners. Each
// re-invocation removes the previous pair before attaching new ones.
let minimapWindowMoveHandler: ((e: MouseEvent) => void) | null = null
let minimapWindowUpHandler:   (() => void) | null = null

export function setupMinimapInteraction(): void {
  E.minimap?.addEventListener('mousedown', (e: MouseEvent) => {
    E.minimapDragging = true
    jumpViewportToMouse(e)
  })
  if (minimapWindowMoveHandler) window.removeEventListener('mousemove', minimapWindowMoveHandler)
  if (minimapWindowUpHandler)   window.removeEventListener('mouseup',   minimapWindowUpHandler)
  minimapWindowMoveHandler = (e: MouseEvent) => {
    if (E.minimapDragging) jumpViewportToMouse(e)
  }
  minimapWindowUpHandler = () => { E.minimapDragging = false }
  window.addEventListener('mousemove', minimapWindowMoveHandler)
  window.addEventListener('mouseup',   minimapWindowUpHandler)
}

export function jumpViewportToMouse(e: MouseEvent): void {
  if (!E.duration || !E.minimap) return
  const rect   = E.minimap.getBoundingClientRect()
  const frac   = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  const center = frac * E.duration
  const half   = (E.vpEnd - E.vpStart) / 2
  E.vpStart = Math.max(0, Math.min(E.duration - half * 2, center - half))
  E.vpEnd   = E.vpStart + half * 2
  drawWaveform()
  updateMinimapViewport()
}
