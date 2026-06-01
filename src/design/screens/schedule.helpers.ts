/**
 * Pure helpers for wiring ScheduleScreen to live IPC data, kept out of the
 * component so the JSX stays focused on the (unchanged) `sr-*` design markup.
 *
 * Weekday convention matches the backend: 0 = Monday … 6 = Sunday (see
 * `ScheduleSlot.days` and `ScheduleCalendar.jsDayToBackend`).
 */
import type { ScheduleSlot } from "@/lib/bindings/ScheduleSlot";
import type { SpecialRecording } from "@/lib/bindings/SpecialRecording";

/** Short Norwegian weekday names, 0 = Monday … 6 = Sunday (backend order). */
export const WEEKDAY_SHORT = [
  "Man",
  "Tir",
  "Ons",
  "Tor",
  "Fre",
  "Lør",
  "Søn",
] as const;

/** Months (Norwegian), 0-based to match `Date.getMonth()`. */
export const MONTH_NAMES = [
  "Januar",
  "Februar",
  "Mars",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Desember",
] as const;

/** Backend weekday (0=Mon) for a JS `Date` (`getDay()` is 0=Sun). */
export function jsDayToBackend(jsDay: number): number {
  return (jsDay + 6) % 7;
}

/**
 * Human label for a slot's active weekdays, e.g. `Søn` or `Man, Ons`.
 * Pass `labels` (a localized 7-entry weekday array, 0 = Monday … 6 = Sunday) to
 * render translated abbreviations; falls back to Norwegian `WEEKDAY_SHORT`.
 */
export function slotDayLabel(
  slot: ScheduleSlot,
  labels: readonly string[] = WEEKDAY_SHORT,
): string {
  if (!slot.days || slot.days.length === 0) return "—";
  return slot.days
    .slice()
    .sort((a, b) => a - b)
    .map((d) => labels[d] ?? "?")
    .join(", ");
}

/** A slot's time range, e.g. `11:00 – 12:00`. */
export function slotTimeRange(slot: ScheduleSlot): string {
  return `${slot.start} – ${slot.stop}`;
}

/**
 * Find the next upcoming start that belongs to this slot, by matching the
 * scheduler's `upcoming` ISO-ish strings to the slot's weekdays + start time.
 * Returns a short Norwegian "søn 7. kl. 11:00" string, or `null` if none of
 * the upcoming starts map to this slot (e.g. status unavailable in dev).
 */
export function nextOccurrence(
  slot: ScheduleSlot,
  upcoming: string[] | undefined,
): string | null {
  if (!upcoming || upcoming.length === 0) return null;
  for (const iso of upcoming) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) continue;
    const backendDay = jsDayToBackend(d.getDay());
    if (!slot.days.includes(backendDay)) continue;
    const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (hhmm !== slot.start) continue;
    return formatShort(d);
  }
  return null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "søn 7. kl. 11:00" — weekday + day-of-month + time. */
export function formatShort(d: Date): string {
  const wd = d.toLocaleDateString("nb-NO", { weekday: "short" });
  const time = d.toLocaleTimeString("nb-NO", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${wd} ${d.getDate()}. kl. ${time}`;
}

/** Render a scheduler `next` ISO-ish string as "søn 7. kl. 11:00". */
export function formatNextRecording(
  s: string | null | undefined,
): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return formatShort(d);
}

/** A fresh weekly slot (defaults to Sunday 11:00–12:00, no max). */
export function emptySlot(): ScheduleSlot {
  return { days: [6], start: "11:00", stop: "12:00", max: null };
}

/** A fresh dated special recording, optionally pre-filled with a date. */
export function emptySpecial(date = ""): SpecialRecording {
  return {
    id: makeId(),
    date,
    name: "",
    start: "11:00",
    stop: "12:00",
    deviceId: null,
  };
}

/** Best-effort unique id; falls back to a timestamp+random when `crypto` is
 *  unavailable (dev/test). Matches the "UI-generated" contract on
 *  `SpecialRecording.id`. */
export function makeId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `sp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** `YYYY-MM-DD` for a year / 0-based month / day-of-month (local). */
export function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

/** Friendly date for a special recording, e.g. `søn 7. juni`. */
export function formatSpecialDate(date: string): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("nb-NO", {
    weekday: "short",
    day: "numeric",
    month: "long",
  });
}

/* ── Live month grid ───────────────────────────────────────────────────── */

export type EvKind = "uke" | "spes" | "hoy";
export interface DayEvent {
  t: string;
  k: EvKind;
}

/**
 * Derive events per day-of-month for a given 0-based `month`, from the real
 * weekly `slots` and dated `specials`. Returns a map keyed by day-of-month so
 * it slots straight into the existing `CalCell` rendering.
 */
export function buildMonthEvents(
  year: number,
  month: number,
  slots: ScheduleSlot[],
  specials: SpecialRecording[],
): Record<number, DayEvent[]> {
  const out: Record<number, DayEvent[]> = {};
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${year}-${pad2(month + 1)}-${pad2(day)}`;
    const backendDay = jsDayToBackend(new Date(year, month, day).getDay());
    const evs: DayEvent[] = [];

    for (const sp of specials) {
      if (sp.date === iso) evs.push({ t: sp.name || sp.start, k: "spes" });
    }
    for (const slot of slots) {
      if (slot.days.includes(backendDay)) {
        evs.push({ t: "Ukentlig", k: "uke" });
      }
    }
    if (evs.length > 0) out[day] = evs;
  }
  return out;
}

/**
 * Monday-first week rows of day numbers for a 0-based `month`, padding leading
 * and trailing cells with `null` (mirrors the original sample `buildWeeks`).
 */
export function buildWeeksFor(
  year: number,
  month: number,
): (number | null)[][] {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const lead = jsDayToBackend(new Date(year, month, 1).getDay());
  const cells: (number | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
