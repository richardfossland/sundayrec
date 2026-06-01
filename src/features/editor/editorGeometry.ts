/**
 * Pure editor-canvas geometry + cut lifecycle.
 *
 * This is the Tauri mirror of the Electron editor's interaction maths
 * (`src/renderer/pages/editor/{geometry,viewport,canvas-input,cuts}.ts`),
 * re-expressed as pure, stateless functions so the whole interaction model is
 * unit-testable headless. The React `EditorCanvas` owns the mutable state and
 * the SVG paint; everything load-bearing — sec<->px, viewport zoom/pan, snap,
 * hit-detection, and the cut history machine — lives here and is fully tested.
 *
 * // mirrors sunday-contracts: cut regions are `{ start, end }` seconds in
 * main-file coordinates, identical to the Electron `CutRegion` and the
 * `EditorCutRegion` ts-rs binding the export seam consumes.
 */

/** A cut/trim region in main-file seconds. Matches `EditorCutRegion`. */
export interface Cut {
  start: number;
  end: number;
}

/** A detected content segment, used for snap-to-boundary. */
export interface Segment {
  start: number;
  end: number;
  /** `silence|speech|music|mixed|unknown|sermon` (matches EditorSegment.kind). */
  kind: string;
}

/** The visible window of the timeline, in main-file seconds. */
export interface Viewport {
  start: number;
  end: number;
}

/** What a pointer-down landed on. `handle` carries which cut edge to resize. */
export type HitTarget =
  | { kind: "handle"; cutIdx: number; side: "start" | "end" }
  | { kind: "playhead" }
  | { kind: "blank" };

/** Minimum cut span (seconds) — sub-0.1 s drags are treated as taps, never cuts. */
export const MIN_CUT_SEC = 0.1;
/** Smallest viewport span we ever zoom to (seconds). */
export const MIN_VIEWPORT_SEC = 0.5;
/** Undo history cap — mirrors the Electron 50-snapshot ring. */
export const MAX_HISTORY = 50;

// ── sec <-> px ──────────────────────────────────────────────────────────────
// Linear map between the visible viewport [vp.start, vp.end] and pixel [0, W].
// (The Electron build additionally inserts intro/outro slots at the file edges;
// the canvas keeps that as a separate display concern — the core cut maths
// only ever runs in main coords, exactly as Electron's `xToMainSec` does.)

/** Main-file seconds → pixel x within a canvas of width `w`. */
export function secToX(sec: number, vp: Viewport, w: number): number {
  const span = vp.end - vp.start;
  if (span <= 0) return 0;
  return ((sec - vp.start) / span) * w;
}

/** Pixel x → main-file seconds, clamped to the visible viewport. */
export function xToSec(x: number, vp: Viewport, w: number): number {
  if (w <= 0) return vp.start;
  if (x <= 0) return vp.start;
  if (x >= w) return vp.end;
  return vp.start + (x / w) * (vp.end - vp.start);
}

/** Clamp a second to the recording's main range [0, duration]. */
export function clampMain(sec: number, duration: number): number {
  return Math.max(0, Math.min(duration, sec));
}

// ── Viewport (zoom / pan / fit) ───────────────────────────────────────────────

/** The whole file visible. */
export function fitAll(duration: number): Viewport {
  return { start: 0, end: duration || 1 };
}

/**
 * Zoom by `factor` (<1 zooms in, >1 zooms out) around an anchor second. When no
 * anchor is given, zoom around the viewport centre — the keyboard/button path.
 * Mirrors Electron `zoomBy` + the wheel-zoom-around-mouse in `onCanvasWheel`.
 */
export function zoomBy(
  vp: Viewport,
  factor: number,
  duration: number,
  anchorSec?: number,
): Viewport {
  const span = vp.end - vp.start;
  const anchor = anchorSec ?? (vp.start + vp.end) / 2;
  // Keep the anchor's fractional position fixed across the zoom.
  const frac = span > 0 ? (anchor - vp.start) / span : 0.5;
  let newSpan = span * factor;
  if (newSpan < MIN_VIEWPORT_SEC) newSpan = MIN_VIEWPORT_SEC;
  if (duration > 0 && newSpan > duration) newSpan = duration;
  let start = anchor - frac * newSpan;
  start = Math.max(0, Math.min(Math.max(0, duration - newSpan), start));
  const end = Math.min(duration || start + newSpan, start + newSpan);
  return { start, end };
}

/** Pan the viewport by `deltaSec`, clamped so it never leaves [0, duration]. */
export function panBy(
  vp: Viewport,
  deltaSec: number,
  duration: number,
): Viewport {
  const span = vp.end - vp.start;
  const start = Math.max(
    0,
    Math.min(Math.max(0, duration - span), vp.start + deltaSec),
  );
  return { start, end: start + span };
}

/**
 * Ease a raw wheel `deltaY` into a multiplicative zoom factor for smooth,
 * pressure-proportional wheel-zoom. A small notch nudges gently; a hard flick
 * zooms faster — but always clamped to a sane band so one big trackpad swipe
 * can't teleport the zoom. `deltaY < 0` (scroll up / pinch out) zooms IN
 * (factor < 1); `deltaY > 0` zooms OUT (factor > 1). Pure.
 *
 * The factor is `exp(deltaY * sensitivity)` clamped to `[1/maxStep, maxStep]`,
 * so successive frames compose into smooth exponential zoom toward the cursor.
 */
export function wheelZoomFactor(
  deltaY: number,
  sensitivity = 0.0015,
  maxStep = 1.25,
): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  const raw = Math.exp(deltaY * sensitivity);
  return Math.max(1 / maxStep, Math.min(maxStep, raw));
}

// ── Marker-crossing detection (for scrub haptics) ────────────────────────────

/**
 * Whether moving the playhead from `prevSec` to `nextSec` crossed at least one
 * of the given `markers` (segment/chapter boundaries). Direction-agnostic — a
 * forward scrub past a marker and a backward scrub past it both count. Used to
 * fire a subtle, throttled haptic tick exactly once per boundary the playhead
 * sweeps over while scrubbing. Pure; no DOM, no timers.
 *
 * A marker exactly equal to `nextSec` counts as crossed (you've landed on it);
 * one exactly equal to `prevSec` does not (you started there, already ticked).
 */
export function crossedMarker(
  prevSec: number,
  nextSec: number,
  markers: number[],
): boolean {
  if (prevSec === nextSec || markers.length === 0) return false;
  const lo = Math.min(prevSec, nextSec);
  const hi = Math.max(prevSec, nextSec);
  for (const m of markers) {
    // Half-open on the start so re-ticking the marker you're parked on is avoided.
    if (m > lo && m <= hi) return true;
  }
  return false;
}

// ── Snap-to-segment ───────────────────────────────────────────────────────────

/** Per-kind visibility — sermon always snaps; the rest honour the toggles.
 *  Mirrors Electron `shouldShowSegment`. */
export interface SegmentToggles {
  speech: boolean;
  music: boolean;
  silence: boolean;
}

export function shouldSnapSegment(
  kind: string,
  toggles: SegmentToggles,
): boolean {
  if (kind === "sermon") return true;
  if (kind === "speech") return toggles.speech;
  if (kind === "music") return toggles.music;
  if (kind === "silence") return toggles.silence;
  // mixed / unknown → follow the speech toggle (closest match), as in Electron.
  return toggles.speech;
}

/**
 * Snap a second to the nearest visible segment boundary within a zoom-scaled
 * threshold (~8 px, floor 0.15 s). Returns the input unchanged when nothing is
 * close enough. Mirrors Electron `snapToSegmentBoundary`.
 */
export function snapToSegmentBoundary(
  sec: number,
  segments: Segment[],
  vp: Viewport,
  w: number,
  toggles: SegmentToggles,
): number {
  if (segments.length === 0) return sec;
  const threshold = Math.max(0.15, ((vp.end - vp.start) / Math.max(1, w)) * 8);
  let closest = sec;
  let minDist = threshold;
  for (const seg of segments) {
    if (!shouldSnapSegment(seg.kind, toggles)) continue;
    for (const t of [seg.start, seg.end]) {
      const d = Math.abs(sec - t);
      if (d < minDist) {
        minDist = d;
        closest = t;
      }
    }
  }
  return closest;
}

/**
 * Like {@link snapToSegmentBoundary} but also reports whether a snap happened —
 * so the caller can fire an `alignment` haptic exactly when a trim handle clicks
 * onto a boundary (and stay quiet on the frames it's dragging free). `snapped`
 * is true only when the result moved to a real boundary different from the input.
 * Pure.
 */
export function snapWithFeedback(
  sec: number,
  segments: Segment[],
  vp: Viewport,
  w: number,
  toggles: SegmentToggles,
): { sec: number; snapped: boolean } {
  const snappedSec = snapToSegmentBoundary(sec, segments, vp, w, toggles);
  return { sec: snappedSec, snapped: snappedSec !== sec };
}

/**
 * If `sec` falls inside a cut, return the cut's end (the next keep-region
 * start), clamped to `maxSec`. Cuts are skip-zones — the playhead resting inside
 * one is meaningless. Mirrors Electron `snapOutOfCut`.
 */
export function snapOutOfCut(sec: number, cuts: Cut[], maxSec: number): number {
  for (const c of cuts) {
    if (sec >= c.start && sec < c.end) return Math.min(maxSec, c.end);
  }
  return sec;
}

// ── Hit detection ─────────────────────────────────────────────────────────────

/**
 * Decide what a pointer-down at pixel (`x`, `y`) hits: a cut-boundary handle,
 * the playhead (only in the top ruler band), or blank canvas. Pixel thresholds
 * mirror Electron `onCanvasDown` (handle ~10 px scaled to seconds, playhead
 * 12 px within the top 28 px ruler). Handles take priority over the playhead.
 */
export function hitTest(
  x: number,
  y: number,
  opts: {
    vp: Viewport;
    w: number;
    cuts: Cut[];
    playheadSec: number;
    rulerHeight?: number;
  },
): HitTarget {
  const { vp, w, cuts, playheadSec } = opts;
  const rulerHeight = opts.rulerHeight ?? 28;
  const sec = xToSec(x, vp, w);
  // Handle threshold: ~10 px expressed in seconds at the current zoom.
  const threshold = w > 0 ? ((vp.end - vp.start) / w) * 10 : Infinity;
  for (let i = 0; i < cuts.length; i++) {
    if (Math.abs(sec - cuts[i]!.start) < threshold)
      return { kind: "handle", cutIdx: i, side: "start" };
    if (Math.abs(sec - cuts[i]!.end) < threshold)
      return { kind: "handle", cutIdx: i, side: "end" };
  }
  const playX = secToX(playheadSec, vp, w);
  if (Math.abs(x - playX) < 12 && y < rulerHeight) return { kind: "playhead" };
  return { kind: "blank" };
}

// ── Cut lifecycle (add / resize / delete / undo-all) + history ───────────────
//
// History is a snapshot ring with a pointer (`idx`). `idx === -1` is the
// initial empty state. Every mutation returns a fresh `{ cuts, history, idx }`
// so React state updates stay immutable. Mirrors Electron `cuts.ts` semantics
// (sort, merge-overlap, undo-to-empty, 50-snapshot cap) without the DOM/IPC.

export interface CutState {
  cuts: Cut[];
  history: Cut[][];
  idx: number;
}

/** Fresh, empty cut state. */
export function emptyCutState(): CutState {
  return { cuts: [], history: [], idx: -1 };
}

/** Deep-clone a cut list (snapshots must not alias live state). */
function cloneCuts(cuts: Cut[]): Cut[] {
  return cuts.map((c) => ({ start: c.start, end: c.end }));
}

/** Push the current cuts onto history, discarding any redo branch + capping. */
function pushHistory(state: CutState): CutState {
  const trimmed = state.history.slice(0, state.idx + 1);
  trimmed.push(cloneCuts(state.cuts));
  let idx = trimmed.length - 1;
  if (trimmed.length > MAX_HISTORY) {
    trimmed.shift();
    idx = trimmed.length - 1;
  }
  return { cuts: state.cuts, history: trimmed, idx };
}

/** Sort by start, then merge regions that touch/overlap (gap ≤ 0.01 s). */
function normalizeCuts(cuts: Cut[]): Cut[] {
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const merged: Cut[] = [];
  for (const c of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && c.start <= prev.end + 0.01) {
      prev.end = Math.max(prev.end, c.end);
    } else {
      merged.push({ start: c.start, end: c.end });
    }
  }
  return merged;
}

/**
 * Add a cut spanning `[s, e]` (order-agnostic), clamped to main coords and
 * merged with overlapping cuts. Drags shorter than `MIN_CUT_SEC` are dropped
 * (treated as taps). Records history. Mirrors Electron `addCut`.
 */
export function addCut(
  state: CutState,
  s: number,
  e: number,
  duration: number,
): CutState {
  let lo = Math.min(s, e);
  let hi = Math.max(s, e);
  lo = clampMain(lo, duration);
  hi = clampMain(hi, duration);
  if (hi - lo < MIN_CUT_SEC) return state;
  const cuts = normalizeCuts([...state.cuts, { start: lo, end: hi }]);
  return pushHistory({ ...state, cuts });
}

/**
 * Resize one cut's boundary to `sec`, keeping a ≥0.1 s span and staying inside
 * [0, duration]. Used live during a handle drag; does NOT record history (the
 * caller commits once on pointer-up via `commitResize`). Mirrors the live edit
 * in Electron `onCanvasMove` (handle branch).
 */
export function resizeCut(
  state: CutState,
  cutIdx: number,
  side: "start" | "end",
  sec: number,
  duration: number,
): CutState {
  const cuts = state.cuts.map((c, i) => {
    if (i !== cutIdx) return c;
    if (side === "start") {
      return { ...c, start: Math.max(0, Math.min(c.end - 0.1, sec)) };
    }
    return { ...c, end: Math.min(duration, Math.max(c.start + 0.1, sec)) };
  });
  return { ...state, cuts };
}

/** Commit a finished resize: re-sort + record history. Mirrors `onCanvasUp`
 *  (handle branch: sort, pushCutHistory). */
export function commitResize(state: CutState): CutState {
  const cuts = [...state.cuts].sort((a, b) => a.start - b.start);
  return pushHistory({ ...state, cuts });
}

/** Delete the cut at `idx` and record history. Mirrors Electron `deleteCut`. */
export function deleteCut(state: CutState, idx: number): CutState {
  if (idx < 0 || idx >= state.cuts.length) return state;
  const cuts = state.cuts.filter((_, i) => i !== idx);
  return pushHistory({ ...state, cuts });
}

/**
 * Undo one step. At `idx === 0` with live cuts, undo to the empty state
 * (`idx === -1`), exactly like Electron `undoCut`. A no-op when there's nothing
 * to undo.
 */
export function undo(state: CutState): CutState {
  if (state.idx <= 0) {
    if (state.idx === 0 && state.cuts.length > 0) {
      return { ...state, cuts: [], idx: -1 };
    }
    return state;
  }
  const idx = state.idx - 1;
  return { ...state, idx, cuts: cloneCuts(state.history[idx]!) };
}

/** Redo one step. No-op at the head of history. Mirrors Electron `redoCut`. */
export function redo(state: CutState): CutState {
  if (state.idx >= state.history.length - 1) return state;
  const idx = state.idx + 1;
  return { ...state, idx, cuts: cloneCuts(state.history[idx]!) };
}

/** Clear every cut ("undo all"). Records history so it itself is undoable. */
export function clearAll(state: CutState): CutState {
  if (state.cuts.length === 0) return state;
  return pushHistory({ ...state, cuts: [] });
}

/** Replace the cuts wholesale (e.g. restoring a draft) and record history. */
export function replaceCuts(state: CutState, cuts: Cut[]): CutState {
  return pushHistory({ ...state, cuts: normalizeCuts(cuts) });
}

// ── Keep-segment maths (the export-facing remainder) ─────────────────────────

/** The keep-segments: the complement of the cuts within [0, duration].
 *  Mirrors Electron `getKeepSegs`. */
export function getKeepSegments(cuts: Cut[], duration: number): Cut[] {
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const keeps: Cut[] = [];
  let cursor = 0;
  for (const c of sorted) {
    if (c.start > cursor + 0.05) keeps.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < duration - 0.05) keeps.push({ start: cursor, end: duration });
  return keeps;
}

/** Total kept duration after the cuts. Mirrors Electron `getRemainingDuration`. */
export function getRemainingDuration(cuts: Cut[], duration: number): number {
  return getKeepSegments(cuts, duration).reduce(
    (sum, s) => sum + (s.end - s.start),
    0,
  );
}
