/**
 * Pure navigation model for the app shell.
 *
 * Mirrors the Electron `showPage(id)` contract in
 * `src/renderer/main.ts`: switching to a view deactivates whatever
 * view-specific lifecycle the *previous* view registered (the Electron code
 * calls `stopVU()`/`deactivateHome()`/`deactivateEditor()`/… for any id that
 * is no longer current), then activates the new one. We model that here as a
 * tiny, side-effect-free reducer so the React shell can stay a thin renderer
 * and the lifecycle wiring is independently unit-testable.
 *
 * This module is deliberately UI-free: no React, no Tauri. The shell layer
 * (`MainLayout`) maps a {@link ViewName} to a component and feeds user clicks
 * through {@link nextNav}; effectful work (start/stop VU, refresh queries) is
 * driven from {@link viewLifecycle} but executed by the caller.
 */

/** Every top-level view reachable from the sidebar/tab navigation. */
export const VIEW_NAMES = [
  "home",
  "schedule",
  "history",
  "review",
  "editor",
  "transcribe",
  "publish",
  "streaming",
  "cloud",
  "email",
  "integrations",
  "diagnostics",
  "wake",
  "settings",
  "update",
] as const;

export type ViewName = (typeof VIEW_NAMES)[number];

/** The view shown on first paint (matches the Electron default page). */
export const DEFAULT_VIEW: ViewName = "home";

/** Narrowing guard — accepts only a known {@link ViewName}. */
export function isViewName(value: unknown): value is ViewName {
  return (
    typeof value === "string" && (VIEW_NAMES as readonly string[]).includes(value)
  );
}

/**
 * Per-view lifecycle hooks. `onEnter` runs when a view becomes current;
 * `onLeave` runs when it stops being current (mirrors the Electron
 * `deactivate*`/`stop*` calls). Both are optional and named so callers can
 * map them to real effects (e.g. `home.onEnter` → refresh queue + start VU).
 */
export interface ViewLifecycle {
  /** Effects to run as a view is mounted/shown. */
  onEnter: readonly string[];
  /** Effects to run as a view is hidden (cleanup). */
  onLeave: readonly string[];
}

/**
 * The lifecycle table — mirrors `showPage()` in the Electron renderer:
 *   - leaving `home`     → `stopVU`, `deactivateHome`
 *   - leaving `editor`   → `deactivateEditor`
 *   - leaving `streaming`→ `stopMonitoring` (the "live" page)
 *   - entering `home`    → `refreshHome` (+ `startVU`)
 *   - entering `schedule`→ `renderCalendar`
 *   - entering `editor`  → `reactivateEditor`
 *
 * Effects are plain string tags; the shell decides what each means. Keeping
 * them as data (not closures) is what makes the model unit-testable.
 */
const LIFECYCLE: Partial<Record<ViewName, ViewLifecycle>> = {
  home: { onEnter: ["refreshHome", "startVU"], onLeave: ["stopVU"] },
  schedule: { onEnter: ["refreshSchedule"], onLeave: [] },
  review: { onEnter: ["refreshReview"], onLeave: [] },
  editor: { onEnter: ["reactivateEditor"], onLeave: ["deactivateEditor"] },
  streaming: { onEnter: [], onLeave: ["stopMonitoring"] },
};

const EMPTY_LIFECYCLE: ViewLifecycle = { onEnter: [], onLeave: [] };

/** The lifecycle hooks for a view (empty when the view registers none). */
export function viewLifecycle(view: ViewName): ViewLifecycle {
  return LIFECYCLE[view] ?? EMPTY_LIFECYCLE;
}

/** The immutable shell navigation state. */
export interface NavState {
  /** The view currently shown. */
  readonly current: ViewName;
}

/** The initial navigation state (home, matching the Electron default). */
export function initialNav(view: ViewName = DEFAULT_VIEW): NavState {
  return { current: view };
}

/**
 * The result of a navigation: the next state plus the ordered effects to run.
 * Effects are `leave` first (clean up the old view) then `enter` (set up the
 * new view) — the same order the Electron `showPage` body uses. Navigating to
 * the already-current view is a no-op (no effects, same state) so re-clicking
 * the active tab does not thrash VU/preview engines.
 */
export interface NavTransition {
  readonly state: NavState;
  readonly leave: readonly string[];
  readonly enter: readonly string[];
  /** True when the target differs from the current view. */
  readonly changed: boolean;
}

/**
 * Compute the transition for showing `target`. Pure: it returns the effects
 * to run rather than running them, so the shell can fire them as React
 * effects/IPC and tests can assert on them directly.
 */
export function nextNav(state: NavState, target: ViewName): NavTransition {
  if (target === state.current) {
    return { state, leave: [], enter: [], changed: false };
  }
  return {
    state: { current: target },
    leave: viewLifecycle(state.current).onLeave,
    enter: viewLifecycle(target).onEnter,
    changed: true,
  };
}
