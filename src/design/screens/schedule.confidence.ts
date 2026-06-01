/**
 * Pure helpers for the "Vil maskinen ta opp?" confidence panel at the top of
 * the Tidsplan screen. Kept framework-free so they're unit-testable without
 * React/IPC: the component feeds in the live `scheduler_status.next`, the
 * `settings.wakeFromSleep` flag and the host's `wake_capabilities`, and these
 * functions decide what the volunteer should see.
 *
 * No new backend is added — everything is derived from data the renderer
 * already has. The wake lead time mirrors the backend constant
 * `sundayrec_core::wake::WAKE_LEAD_MINUTES` (there's no ts-rs binding for it).
 */

/** Minutes the machine wakes BEFORE a recording start. Mirrors the Rust
 *  `WAKE_LEAD_MINUTES` constant so the copy ("våkner 10 min før") is honest. */
export const WAKE_LEAD_MINUTES = 10;

/**
 * Confidence level for "will the Mac record the next service?".
 *  - `ready`   — wake-from-sleep is enabled AND the host can wake from sleep:
 *                the machine will turn itself on and record. (green)
 *  - `needsOn` — there IS a next recording but wake can't be guaranteed (the
 *                feature is off, or the host can't wake): the volunteer must
 *                leave the machine on/awake. (amber)
 *  - `none`    — nothing is scheduled. (muted)
 */
export type ConfidenceLevel = "ready" | "needsOn" | "none";

/**
 * Decide the confidence level from the three facts the renderer already holds.
 * `nextIso` is the scheduler's next-start string (null when nothing planned);
 * `wakeEnabled` is `settings.wakeFromSleep`; `canWake` is
 * `wake_capabilities.canWakeFromSleep`.
 */
export function confidenceLevel(args: {
  nextIso: string | null | undefined;
  wakeEnabled: boolean;
  canWake: boolean;
}): ConfidenceLevel {
  if (!args.nextIso) return "none";
  if (args.wakeEnabled && args.canWake) return "ready";
  return "needsOn";
}

/** Structured "time until" — so copy can be localised without string parsing. */
export interface TimeUntil {
  /** `past` once the target is at/behind `now`. */
  unit: "days" | "hours" | "minutes" | "now" | "past";
  /** Whole-unit count for `days`/`hours`/`minutes`; 0 for `now`/`past`. */
  value: number;
}

/**
 * How far `targetIso` is from `now`, bucketed to the largest sensible unit:
 * ≥1 day → days, ≥1 hour → hours, ≥1 min → minutes, ~0 → now, behind → past.
 * Returns `null` when `targetIso` is missing or unparseable, so the caller can
 * fall back to showing the raw next-start string.
 */
export function timeUntil(
  targetIso: string | null | undefined,
  now: Date = new Date(),
): TimeUntil | null {
  if (!targetIso) return null;
  const target = new Date(targetIso);
  if (Number.isNaN(target.getTime())) return null;
  const ms = target.getTime() - now.getTime();
  if (ms < -60_000) return { unit: "past", value: 0 };
  const minutes = Math.round(ms / 60_000);
  if (minutes <= 0) return { unit: "now", value: 0 };
  if (minutes < 60) return { unit: "minutes", value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", value: hours };
  return { unit: "days", value: Math.floor(hours / 24) };
}

/**
 * `HH:MM` of the moment the machine should wake — `lead` minutes before the
 * recording start. Returns null for a missing/unparseable start.
 */
export function wakeTime(
  startIso: string | null | undefined,
  lead = WAKE_LEAD_MINUTES,
): string | null {
  if (!startIso) return null;
  const d = new Date(startIso);
  if (Number.isNaN(d.getTime())) return null;
  d.setMinutes(d.getMinutes() - lead);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** `HH:MM` of a recording start (the recording-begins time). */
export function startTime(startIso: string | null | undefined): string | null {
  if (!startIso) return null;
  const d = new Date(startIso);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
