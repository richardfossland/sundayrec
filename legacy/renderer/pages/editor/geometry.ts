import { E } from './state'

// Coordinate model
// ----------------
// `vpStart` / `vpEnd` are in MAIN-FILE seconds — the same coordinate system
// that `cuts`, `chapters`, `peaks`, and playback seek use.
//
// When `includeIntroOutro` is enabled and the viewport reaches the file edges
// (vpStart=0 or vpEnd=duration), the canvas is split into three regions:
//
//   ┌──────────┬────────────────────────────────┬──────────┐
//   │  INTRO   │         HOVEDOPPTAK            │   OUTRO  │
//   │ (dim)    │   (main waveform — full color) │  (dim)   │
//   └──────────┴────────────────────────────────┴──────────┘
//
// Pixel widths are proportional to durations so transitions look natural.
// Intro/Outro slots disappear when the user zooms into the middle (vpStart>0
// or vpEnd<duration) — they're only meaningful at the edges of the file.
//
// `secToX(mainFileSec, W)` maps main-file seconds to a pixel x. Cuts/playhead/
// handles all go through this so they stay properly aligned even when the
// pixel-to-second ratio changes due to intro/outro insertion.

export interface LayoutGeom {
  introPx: number   // width of intro region in pixels
  outroPx: number   // width of outro region in pixels
  mainPxStart: number  // x where main waveform begins
  mainPxEnd: number    // x where main waveform ends
  effIntroDur: number  // intro duration in seconds, or 0 if not displayed
  effOutroDur: number  // outro duration in seconds, or 0 if not displayed
}

// One-slot cache for getLayoutGeom(): mousemove handlers call this twice
// per event (xToSec + xToMainSec) and the inputs only change when the user
// zooms, scrolls or toggles intro/outro. Caching turns thousands of pure-
// math executions per drag into single-digit cache hits.
let _layoutGeomCache: { key: string; geom: LayoutGeom } | null = null

export function getLayoutGeom(W: number): LayoutGeom {
  const key = `${W}|${E.vpStart}|${E.vpEnd}|${E.includeIntroOutro?1:0}|${E.introBuffer?1:0}|${E.outroBuffer?1:0}|${E.duration}|${E.introDuration}|${E.outroDuration}`
  if (_layoutGeomCache && _layoutGeomCache.key === key) return _layoutGeomCache.geom

  // Only show intro/outro slots when the corresponding edge of the file is
  // visible. If the user has zoomed past the start, hide the intro slot.
  const showIntro = E.includeIntroOutro && !!E.introBuffer && E.vpStart <= 0.001
  const showOutro = E.includeIntroOutro && !!E.outroBuffer && E.vpEnd >= E.duration - 0.001
  const effIntroDur = showIntro ? E.introDuration : 0
  const effOutroDur = showOutro ? E.outroDuration : 0
  const mainVpDur = Math.max(0.001, E.vpEnd - E.vpStart)
  const total = effIntroDur + mainVpDur + effOutroDur
  const introPx = (effIntroDur / total) * W
  const outroPx = (effOutroDur / total) * W
  const geom: LayoutGeom = {
    introPx,
    outroPx,
    mainPxStart: introPx,
    mainPxEnd: W - outroPx,
    effIntroDur,
    effOutroDur,
  }
  _layoutGeomCache = { key, geom }
  return geom
}

// Extended-timeline helpers: `playStartSec` runs on an extended timeline so the
// playhead can be moved (and audio played) inside intro/outro slots:
//   • sec < 0                 → inside intro, offset into intro = sec + effIntroDur
//   • 0 ≤ sec ≤ duration       → inside main recording
//   • duration < sec ≤ end     → inside outro, offset into outro = sec - duration
// Cuts always stay in main coords ([0, duration]); video.currentTime is
// clamped to main with clampMain().
export function effIntroDur(): number {
  return (E.includeIntroOutro && E.introBuffer) ? E.introDuration : 0
}
export function effOutroDur(): number {
  return (E.includeIntroOutro && E.outroBuffer) ? E.outroDuration : 0
}
export function minPlayableSec(): number {
  return -effIntroDur()
}
export function maxPlayableSec(): number {
  return E.duration + effOutroDur()
}
export function clampPlayable(sec: number): number {
  return Math.max(minPlayableSec(), Math.min(maxPlayableSec(), sec))
}
export function clampMain(sec: number): number {
  return Math.max(0, Math.min(E.duration, sec))
}

export function secToX(sec: number, W: number): number {
  const g = getLayoutGeom(W)
  // Intro slot — negative seconds map into [0, introPx]
  if (sec < 0 && g.introPx > 0 && g.effIntroDur > 0) {
    const frac = (sec + g.effIntroDur) / g.effIntroDur
    return Math.max(0, Math.min(1, frac)) * g.introPx
  }
  // Outro slot — seconds > duration map into [mainPxEnd, W]
  if (sec > E.duration && g.outroPx > 0 && g.effOutroDur > 0) {
    const frac = (sec - E.duration) / g.effOutroDur
    return g.mainPxEnd + Math.max(0, Math.min(1, frac)) * g.outroPx
  }
  const mainW = g.mainPxEnd - g.mainPxStart
  if (mainW <= 0) return g.mainPxStart
  return g.mainPxStart + ((sec - E.vpStart) / (E.vpEnd - E.vpStart)) * mainW
}

export function xToSec(x: number, W: number): number {
  const g = getLayoutGeom(W)
  // Intro slot: returns negative seconds in [-effIntroDur, 0]
  if (g.introPx > 0 && g.effIntroDur > 0 && x < g.mainPxStart) {
    const frac = Math.max(0, Math.min(1, x / g.introPx))
    return -g.effIntroDur + frac * g.effIntroDur
  }
  // Outro slot: returns seconds in (duration, duration + effOutroDur]
  if (g.outroPx > 0 && g.effOutroDur > 0 && x > g.mainPxEnd) {
    const frac = Math.max(0, Math.min(1, (x - g.mainPxEnd) / g.outroPx))
    return E.duration + frac * g.effOutroDur
  }
  const mainW = g.mainPxEnd - g.mainPxStart
  if (mainW <= 0) return E.vpStart
  if (x <= g.mainPxStart) return E.vpStart
  if (x >= g.mainPxEnd)   return E.vpEnd
  return E.vpStart + ((x - g.mainPxStart) / mainW) * (E.vpEnd - E.vpStart)
}

/** Returns x in main-coords only — used by cut handling which must never
 *  read intro/outro coords. */
export function xToMainSec(x: number, W: number): number {
  const g = getLayoutGeom(W)
  const mainW = g.mainPxEnd - g.mainPxStart
  if (mainW <= 0) return E.vpStart
  if (x <= g.mainPxStart) return E.vpStart
  if (x >= g.mainPxEnd)   return E.vpEnd
  return E.vpStart + ((x - g.mainPxStart) / mainW) * (E.vpEnd - E.vpStart)
}

/** Returns 'intro' | 'main' | 'outro' for a given pixel x. Used by drag-and-drop
 *  to route a dropped file to the right intro/outro slot. */
export function getRegionAtX(x: number, W: number): 'intro' | 'main' | 'outro' {
  // The user's UX expectation is: drop on LEFT third = intro, RIGHT third = outro.
  // We honour that geometrically even when the actual intro slot is narrow
  // (or absent), so users can SET an intro by dragging onto the left third
  // even before any intro file is configured.
  if (x < W / 3)    return 'intro'
  if (x > W * 2/3)  return 'outro'
  return 'main'
}
