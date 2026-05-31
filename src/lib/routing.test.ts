import { describe, expect, it } from "vitest";

import {
  DEFAULT_VIEW,
  initialNav,
  isViewName,
  nextNav,
  VIEW_NAMES,
  viewLifecycle,
} from "./routing";

describe("routing model", () => {
  it("starts on the default view (home)", () => {
    expect(DEFAULT_VIEW).toBe("home");
    expect(initialNav().current).toBe("home");
  });

  it("lets the initial view be overridden", () => {
    expect(initialNav("settings").current).toBe("settings");
  });

  it("recognises only known view names", () => {
    expect(isViewName("home")).toBe(true);
    expect(isViewName("settings")).toBe(true);
    expect(isViewName("nope")).toBe(false);
    expect(isViewName(42)).toBe(false);
    expect(isViewName(null)).toBe(false);
  });

  it("exposes every registered view as a name", () => {
    for (const v of VIEW_NAMES) expect(isViewName(v)).toBe(true);
  });

  it("runs leave-then-enter effects when changing view", () => {
    // home → editor: leave home (stopVU), enter editor (reactivateEditor).
    const t = nextNav(initialNav("home"), "editor");
    expect(t.changed).toBe(true);
    expect(t.state.current).toBe("editor");
    expect(t.leave).toEqual(["stopVU"]);
    expect(t.enter).toEqual(["reactivateEditor"]);
  });

  it("fires home enter effects (refresh + VU) when navigating to home", () => {
    const t = nextNav(initialNav("settings"), "home");
    expect(t.enter).toEqual(["refreshHome", "startVU"]);
    // settings registers no leave hook.
    expect(t.leave).toEqual([]);
  });

  it("cleans up the editor when leaving it", () => {
    const t = nextNav(initialNav("editor"), "home");
    expect(t.leave).toEqual(["deactivateEditor"]);
    expect(t.enter).toEqual(["refreshHome", "startVU"]);
  });

  it("stops monitoring when leaving the streaming view", () => {
    const t = nextNav(initialNav("streaming"), "settings");
    expect(t.leave).toEqual(["stopMonitoring"]);
  });

  it("is a no-op when navigating to the already-current view", () => {
    const state = initialNav("home");
    const t = nextNav(state, "home");
    expect(t.changed).toBe(false);
    expect(t.state).toBe(state);
    expect(t.leave).toEqual([]);
    expect(t.enter).toEqual([]);
  });

  it("returns empty lifecycle for views with no hooks", () => {
    const lc = viewLifecycle("diagnostics");
    expect(lc.onEnter).toEqual([]);
    expect(lc.onLeave).toEqual([]);
  });

  it("does not mutate the input state", () => {
    const state = initialNav("home");
    nextNav(state, "editor");
    expect(state.current).toBe("home");
  });
});
