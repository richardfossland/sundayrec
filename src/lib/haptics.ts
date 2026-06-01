/**
 * Trackpad haptics — a best-effort wrapper over the native `haptic_perform`
 * Tauri command (macOS Force Touch; a no-op on every other platform and when no
 * Force-Touch performer exists).
 *
 * The editor fires SUBTLE, THROTTLED taps at meaningful moments — a trim handle
 * snapping to a segment boundary (`alignment`), hitting a trim min/max limit
 * (`levelChange`), and the playhead crossing a chapter/segment marker while
 * scrubbing (`generic`). The whole point is restraint: a haptic on every pointer
 * event would be spam, so each call site throttles itself (see
 * `makeHapticThrottle`).
 *
 * `haptic()` NEVER throws and never rejects — a missing Tauri host (dev/test) or
 * a non-haptic machine just resolves to `false`. Interaction code can call it
 * freely without guarding.
 */
import { invoke } from "@tauri-apps/api/core";

/** The logical haptic patterns the native command understands. */
export type HapticPattern = "alignment" | "levelChange" | "generic";

/**
 * Fire a single trackpad haptic tap, best-effort. Resolves to `true` when a tap
 * was dispatched to the OS performer, `false` otherwise (non-macOS, no host, no
 * Force-Touch). Swallows every error — callers must be able to fire-and-forget.
 */
export async function haptic(pattern: HapticPattern): Promise<boolean> {
  try {
    return await invoke<boolean>("haptic_perform", { pattern });
  } catch {
    // No Tauri host (dev/test), command absent, or no haptic engine → silent.
    return false;
  }
}

/**
 * Build a throttle for a single haptic call site: it fires `haptic(pattern)` at
 * most once per `minGapMs`, dropping taps that arrive too soon after the last
 * one. This is what keeps scrubbing across many markers from buzzing the pad on
 * every frame — the *first* crossing taps, the rest within the window are quiet.
 *
 * Pure timing logic over an injectable `now` clock so it's unit-testable; the
 * default clock is `performance.now()`. The returned function is fire-and-forget
 * (returns `true` when it actually fired a tap, `false` when throttled).
 */
export function makeHapticThrottle(
  minGapMs: number,
  fire: (pattern: HapticPattern) => void = (p) => void haptic(p),
  now: () => number = () =>
    typeof performance !== "undefined" ? performance.now() : Date.now(),
): (pattern: HapticPattern) => boolean {
  let last = -Infinity;
  return (pattern: HapticPattern): boolean => {
    const t = now();
    if (t - last < minGapMs) return false;
    last = t;
    fire(pattern);
    return true;
  };
}
