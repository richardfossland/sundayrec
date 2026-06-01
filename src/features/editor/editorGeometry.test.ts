import { describe, expect, it } from "vitest";

import {
  addCut,
  clampMain,
  clearAll,
  commitResize,
  crossedMarker,
  deleteCut,
  emptyCutState,
  fitAll,
  getKeepSegments,
  getRemainingDuration,
  hitTest,
  panBy,
  redo,
  replaceCuts,
  resizeCut,
  secToX,
  shouldSnapSegment,
  snapOutOfCut,
  snapToSegmentBoundary,
  snapWithFeedback,
  undo,
  wheelZoomFactor,
  xToSec,
  zoomBy,
  MAX_HISTORY,
  type Cut,
  type Segment,
  type Viewport,
} from "./editorGeometry";

const VP: Viewport = { start: 0, end: 100 };

describe("sec <-> px", () => {
  it("maps seconds across the viewport to [0, w]", () => {
    expect(secToX(0, VP, 1000)).toBe(0);
    expect(secToX(50, VP, 1000)).toBe(500);
    expect(secToX(100, VP, 1000)).toBe(1000);
  });

  it("respects a non-zero viewport start", () => {
    const vp: Viewport = { start: 20, end: 70 }; // 50 s span over 1000 px
    expect(secToX(20, vp, 1000)).toBe(0);
    expect(secToX(45, vp, 1000)).toBe(500);
  });

  it("inverts back to seconds, clamped to the viewport edges", () => {
    expect(xToSec(0, VP, 1000)).toBe(0);
    expect(xToSec(500, VP, 1000)).toBe(50);
    expect(xToSec(1000, VP, 1000)).toBe(100);
    // Out-of-range pixels clamp to the viewport ends.
    expect(xToSec(-40, VP, 1000)).toBe(0);
    expect(xToSec(1400, VP, 1000)).toBe(100);
  });

  it("round-trips sec -> px -> sec", () => {
    const vp: Viewport = { start: 12.5, end: 88.25 };
    for (const sec of [12.5, 30, 55.5, 88.25]) {
      expect(xToSec(secToX(sec, vp, 800), vp, 800)).toBeCloseTo(sec, 6);
    }
  });

  it("clampMain bounds to [0, duration]", () => {
    expect(clampMain(-5, 100)).toBe(0);
    expect(clampMain(150, 100)).toBe(100);
    expect(clampMain(42, 100)).toBe(42);
  });
});

describe("viewport zoom / pan / fit", () => {
  it("fitAll spans the whole file (>=1 when duration is 0)", () => {
    expect(fitAll(360)).toEqual({ start: 0, end: 360 });
    expect(fitAll(0)).toEqual({ start: 0, end: 1 });
  });

  it("zooms in around the centre by default", () => {
    const z = zoomBy({ start: 0, end: 100 }, 0.5, 100);
    // Centre 50 stays put, span halves to 50 → [25, 75].
    expect(z.start).toBeCloseTo(25, 6);
    expect(z.end).toBeCloseTo(75, 6);
  });

  it("zooms around a mouse anchor, keeping the anchor fraction fixed", () => {
    // Anchor at 80 (frac 0.8), zoom in to half span (50). 80 should stay at
    // frac 0.8 → start = 80 - 0.8*50 = 40, end = 90.
    const z = zoomBy({ start: 0, end: 100 }, 0.5, 100, 80);
    expect(z.start).toBeCloseTo(40, 6);
    expect(z.end).toBeCloseTo(90, 6);
  });

  it("clamps the zoomed viewport inside [0, duration]", () => {
    // Zoom out beyond the file → clamped to the whole file.
    const z = zoomBy({ start: 40, end: 60 }, 10, 100);
    expect(z.start).toBe(0);
    expect(z.end).toBe(100);
  });

  it("never zooms tighter than the minimum span", () => {
    const z = zoomBy({ start: 49, end: 51 }, 0.01, 100);
    expect(z.end - z.start).toBeCloseTo(0.5, 6);
  });

  it("pans within bounds and clamps at the file edges", () => {
    const vp: Viewport = { start: 20, end: 40 };
    expect(panBy(vp, 10, 100)).toEqual({ start: 30, end: 50 });
    // Pan past the end clamps so end never exceeds duration.
    expect(panBy(vp, 1000, 100)).toEqual({ start: 80, end: 100 });
    // Pan past the start clamps to 0.
    expect(panBy(vp, -1000, 100)).toEqual({ start: 0, end: 20 });
  });
});

describe("snap", () => {
  const toggles = { speech: true, music: true, silence: false };
  const segs: Segment[] = [
    { start: 0, end: 30, kind: "music" },
    { start: 30, end: 200, kind: "sermon" },
    { start: 200, end: 210, kind: "silence" },
  ];

  it("shouldSnapSegment honours toggles and always allows sermon", () => {
    expect(shouldSnapSegment("sermon", toggles)).toBe(true);
    expect(shouldSnapSegment("speech", toggles)).toBe(true);
    expect(shouldSnapSegment("music", toggles)).toBe(true);
    expect(shouldSnapSegment("silence", toggles)).toBe(false);
    // mixed/unknown follow the speech toggle.
    expect(shouldSnapSegment("mixed", toggles)).toBe(true);
    expect(shouldSnapSegment("mixed", { ...toggles, speech: false })).toBe(
      false,
    );
  });

  it("snaps a near-miss to a visible boundary", () => {
    // Zoomed in: 100 s over 1000 px → threshold = 100/1000*8 = 0.8 s.
    const vp: Viewport = { start: 0, end: 100 };
    expect(snapToSegmentBoundary(30.4, segs, vp, 1000, toggles)).toBe(30);
  });

  it("leaves a far-off second unchanged", () => {
    const vp: Viewport = { start: 0, end: 100 };
    expect(snapToSegmentBoundary(55, segs, vp, 1000, toggles)).toBe(55);
  });

  it("ignores boundaries of hidden (silence) segments", () => {
    const vp: Viewport = { start: 0, end: 100 };
    // 200.2 is near the silence boundary at 200/210 — but silence is off, and
    // the sermon also ends at 200, so it should snap to 200 (sermon edge).
    expect(snapToSegmentBoundary(200.2, segs, vp, 1000, toggles)).toBe(200);
    // 209.9 is only near the (hidden) silence end → no snap.
    expect(snapToSegmentBoundary(209.9, segs, vp, 1000, toggles)).toBe(209.9);
  });

  it("returns input unchanged with no segments", () => {
    const vp: Viewport = { start: 0, end: 100 };
    expect(snapToSegmentBoundary(42, [], vp, 1000, toggles)).toBe(42);
  });

  it("snapOutOfCut jumps the playhead to the cut end", () => {
    const cuts: Cut[] = [{ start: 10, end: 25 }];
    expect(snapOutOfCut(15, cuts, 100)).toBe(25);
    // Outside any cut → unchanged.
    expect(snapOutOfCut(40, cuts, 100)).toBe(40);
    // Clamped to maxSec when the cut runs to the file end.
    expect(snapOutOfCut(95, [{ start: 90, end: 100 }], 98)).toBe(98);
  });
});

describe("hit detection", () => {
  const cuts: Cut[] = [{ start: 20, end: 40 }];
  const vp: Viewport = { start: 0, end: 100 };

  it("hits a start handle near a cut boundary", () => {
    // 20 s → x=200 in a 1000 px canvas. Threshold = 100/1000*10 = 1 s = 10 px.
    const hit = hitTest(201, 50, { vp, w: 1000, cuts, playheadSec: 0 });
    expect(hit).toEqual({ kind: "handle", cutIdx: 0, side: "start" });
  });

  it("hits an end handle near the cut end", () => {
    const hit = hitTest(399, 50, { vp, w: 1000, cuts, playheadSec: 0 });
    expect(hit).toEqual({ kind: "handle", cutIdx: 0, side: "end" });
  });

  it("hits the playhead only inside the ruler band", () => {
    // Playhead at 50 s → x=500. In ruler (y<28) → playhead.
    expect(hitTest(503, 10, { vp, w: 1000, cuts, playheadSec: 50 })).toEqual({
      kind: "playhead",
    });
    // Same x but below the ruler → blank (not a playhead grab).
    expect(hitTest(503, 60, { vp, w: 1000, cuts, playheadSec: 50 })).toEqual({
      kind: "blank",
    });
  });

  it("returns blank on empty canvas", () => {
    expect(hitTest(700, 50, { vp, w: 1000, cuts, playheadSec: 50 })).toEqual({
      kind: "blank",
    });
  });

  it("prefers a handle over a coincident playhead", () => {
    // Playhead sits exactly on the cut start → handle wins.
    const hit = hitTest(200, 10, { vp, w: 1000, cuts, playheadSec: 20 });
    expect(hit).toEqual({ kind: "handle", cutIdx: 0, side: "start" });
  });
});

describe("cut lifecycle + history", () => {
  it("adds a cut, clamping + ordering the span", () => {
    const s = addCut(emptyCutState(), 40, 10, 100);
    expect(s.cuts).toEqual([{ start: 10, end: 40 }]);
    expect(s.idx).toBe(0);
  });

  it("drops a sub-threshold (tap) drag", () => {
    const s = addCut(emptyCutState(), 10, 10.05, 100);
    expect(s.cuts).toEqual([]);
    expect(s.idx).toBe(-1);
  });

  it("clamps cuts to the recording range", () => {
    const s = addCut(emptyCutState(), -20, 150, 100);
    expect(s.cuts).toEqual([{ start: 0, end: 100 }]);
  });

  it("merges overlapping/touching cuts", () => {
    let s = addCut(emptyCutState(), 10, 30, 100);
    s = addCut(s, 25, 50, 100); // overlaps → merge to 10..50
    expect(s.cuts).toEqual([{ start: 10, end: 50 }]);
    s = addCut(s, 60, 80, 100); // disjoint → separate
    expect(s.cuts).toEqual([
      { start: 10, end: 50 },
      { start: 60, end: 80 },
    ]);
  });

  it("resizes a handle live without recording history, then commits", () => {
    const base = addCut(emptyCutState(), 20, 40, 100);
    const live = resizeCut(base, 0, "end", 55, 100);
    expect(live.cuts).toEqual([{ start: 20, end: 55 }]);
    // Live resize keeps the same history pointer (uncommitted).
    expect(live.idx).toBe(base.idx);
    const committed = commitResize(live);
    expect(committed.idx).toBe(base.idx + 1);
  });

  it("resize keeps a minimum span and stays in bounds", () => {
    const base = addCut(emptyCutState(), 20, 40, 100);
    // Drag start past end → clamped to end-0.1.
    expect(resizeCut(base, 0, "start", 99, 100).cuts[0]!.start).toBeCloseTo(
      39.9,
      6,
    );
    // Drag end below start → clamped to start+0.1.
    expect(resizeCut(base, 0, "end", 0, 100).cuts[0]!.end).toBeCloseTo(20.1, 6);
    // Drag end past duration → clamped to duration.
    expect(resizeCut(base, 0, "end", 999, 100).cuts[0]!.end).toBe(100);
  });

  it("deletes a cut by index and records history", () => {
    let s = addCut(emptyCutState(), 10, 20, 100);
    s = addCut(s, 30, 40, 100);
    s = deleteCut(s, 0);
    expect(s.cuts).toEqual([{ start: 30, end: 40 }]);
  });

  it("undo steps back, and undo-to-empty from the first cut", () => {
    let s = addCut(emptyCutState(), 10, 20, 100);
    s = addCut(s, 30, 40, 100);
    s = undo(s); // back to one cut
    expect(s.cuts).toEqual([{ start: 10, end: 20 }]);
    s = undo(s); // back to empty
    expect(s.cuts).toEqual([]);
    expect(s.idx).toBe(-1);
    // Further undo is a no-op.
    expect(undo(s).cuts).toEqual([]);
  });

  it("redo replays an undone cut", () => {
    let s = addCut(emptyCutState(), 10, 20, 100);
    s = addCut(s, 30, 40, 100);
    s = undo(s);
    s = redo(s);
    expect(s.cuts).toEqual([
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ]);
    // Redo at the head is a no-op.
    expect(redo(s).cuts).toEqual(s.cuts);
  });

  it("a new edit after undo discards the redo branch", () => {
    let s = addCut(emptyCutState(), 10, 20, 100);
    s = addCut(s, 30, 40, 100);
    s = undo(s); // drop the second cut, idx now 0
    s = addCut(s, 50, 60, 100); // new branch
    // The old "30..40" redo state is gone.
    expect(redo(s).cuts).toEqual([
      { start: 10, end: 20 },
      { start: 50, end: 60 },
    ]);
  });

  it("clearAll wipes cuts but stays undoable", () => {
    let s = addCut(emptyCutState(), 10, 20, 100);
    s = clearAll(s);
    expect(s.cuts).toEqual([]);
    // Undo brings the cleared cut back.
    s = undo(s);
    expect(s.cuts).toEqual([{ start: 10, end: 20 }]);
  });

  it("clearAll on an empty state is a no-op", () => {
    const s = clearAll(emptyCutState());
    expect(s.idx).toBe(-1);
  });

  it("replaceCuts (draft restore) normalizes and records history", () => {
    const s = replaceCuts(emptyCutState(), [
      { start: 30, end: 44 },
      { start: 5, end: 12 },
    ]);
    expect(s.cuts).toEqual([
      { start: 5, end: 12 },
      { start: 30, end: 44 },
    ]);
    expect(s.idx).toBe(0);
  });

  it("caps history at MAX_HISTORY snapshots", () => {
    let s = emptyCutState();
    for (let i = 0; i < MAX_HISTORY + 20; i++) {
      s = addCut(s, i * 2, i * 2 + 1, 1000);
    }
    expect(s.history.length).toBe(MAX_HISTORY);
    expect(s.idx).toBe(MAX_HISTORY - 1);
  });
});

describe("keep-segment maths", () => {
  it("computes the complement of cuts", () => {
    const cuts: Cut[] = [
      { start: 10, end: 20 },
      { start: 50, end: 60 },
    ];
    expect(getKeepSegments(cuts, 100)).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 50 },
      { start: 60, end: 100 },
    ]);
  });

  it("with no cuts the whole file is kept", () => {
    expect(getKeepSegments([], 100)).toEqual([{ start: 0, end: 100 }]);
    expect(getRemainingDuration([], 100)).toBe(100);
  });

  it("remaining duration subtracts the cuts", () => {
    const cuts: Cut[] = [{ start: 10, end: 30 }];
    expect(getRemainingDuration(cuts, 100)).toBe(80);
  });
});

describe("wheelZoomFactor (eased wheel-zoom)", () => {
  it("returns 1 (no-op) for a zero / non-finite delta", () => {
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(Number.NaN)).toBe(1);
    expect(wheelZoomFactor(Infinity)).toBe(1);
  });

  it("zooms IN (factor < 1) on a negative delta, OUT (>1) on positive", () => {
    expect(wheelZoomFactor(-100)).toBeLessThan(1);
    expect(wheelZoomFactor(100)).toBeGreaterThan(1);
  });

  it("is symmetric: opposite deltas are reciprocal factors", () => {
    const inF = wheelZoomFactor(-80);
    const outF = wheelZoomFactor(80);
    expect(inF * outF).toBeCloseTo(1, 10);
  });

  it("scales with pressure — a bigger flick zooms more, up to the clamp", () => {
    expect(wheelZoomFactor(50)).toBeLessThan(wheelZoomFactor(150));
    // A huge flick is clamped so one swipe can't teleport the zoom.
    expect(wheelZoomFactor(100000)).toBe(1.25);
    expect(wheelZoomFactor(-100000)).toBeCloseTo(1 / 1.25, 10);
  });

  it("respects custom sensitivity + clamp", () => {
    expect(wheelZoomFactor(1000, 0.01, 2)).toBe(2);
    expect(wheelZoomFactor(-1000, 0.01, 2)).toBe(0.5);
  });
});

describe("crossedMarker (scrub-haptic boundary detection)", () => {
  const markers = [10, 20, 30];

  it("no markers / no movement → never crossed", () => {
    expect(crossedMarker(5, 25, [])).toBe(false);
    expect(crossedMarker(15, 15, markers)).toBe(false);
  });

  it("detects a forward sweep across a marker", () => {
    expect(crossedMarker(8, 12, markers)).toBe(true); // crossed 10
    expect(crossedMarker(11, 14, markers)).toBe(false); // between 10 and 20
  });

  it("detects a backward sweep across a marker (direction-agnostic)", () => {
    expect(crossedMarker(22, 18, markers)).toBe(true); // crossed 20
  });

  it("landing exactly on a marker counts; starting on it does not", () => {
    expect(crossedMarker(15, 20, markers)).toBe(true); // land on 20
    expect(crossedMarker(20, 25, markers)).toBe(false); // start on 20 only
  });

  it("a sweep spanning several markers still reports a single crossing", () => {
    expect(crossedMarker(5, 35, markers)).toBe(true);
  });
});

describe("snapWithFeedback", () => {
  const segs: Segment[] = [{ start: 10, end: 20, kind: "speech" }];
  const all = { speech: true, music: true, silence: true };

  it("reports snapped=true when it clicks onto a boundary", () => {
    // ~8 px threshold over a 100 s viewport @ 1000 px ≈ 0.8 s window.
    const r = snapWithFeedback(10.3, segs, VP, 1000, all);
    expect(r.sec).toBe(10);
    expect(r.snapped).toBe(true);
  });

  it("reports snapped=false when nothing is close enough", () => {
    const r = snapWithFeedback(50, segs, VP, 1000, all);
    expect(r.sec).toBe(50);
    expect(r.snapped).toBe(false);
  });
});
