//! The scheduler decision core (Fase 5.1) — pure, clock-free recurrence logic.
//!
//! Ported from the Electron main process `src/main/scheduler.ts`. That file is
//! the behavioural specification; this module rebuilds the *decisions* it makes
//! as deterministic Rust so they can be exercised entirely under `cargo test`,
//! with `now` passed in rather than read from the wall clock (the Electron
//! helpers already take `now: Date` for exactly this reason).
//!
//! What lives here (pure):
//!   - the [`ScheduleSlot`] / [`SpecialRecording`] types (serde-compatible with
//!     the Electron `types/index.ts` interfaces, so stored/exported profiles
//!     keep their meaning),
//!   - `HH:MM` / `YYYY-MM-DD` parsing with the Electron fallback defaults,
//!   - "is this slot/special active right now?" (the late-start window),
//!   - midnight-crossing and degenerate-slot detection,
//!   - the reminder / preflight *lead-time offset* math (with previous-day
//!     wrap-around),
//!   - "next occurrence" / "most-recent occurrence" of a weekly (weekday, time),
//!   - the upcoming-dates / next-recording selection used to drive wake
//!     scheduling and the tray tooltip,
//!   - special-recording pruning,
//!   - the missed-recording look-back decision (what to late-start, what to log).
//!
//! What stays in the `src-tauri` shell (impure): reading `Local::now()`, the
//! tokio timers that actually fire start/stop, sending notifications, and
//! persisting/triggering recordings. The shell converts real wall-clock time
//! (and stored history epoch-ms) into the `NaiveDateTime` local-wall frame this
//! module works in, so every comparison here is tz-free and reproducible.
//!
//! ## Weekday convention
//!
//! `ScheduleSlot.days` uses the UI convention **0 = Monday … 6 = Sunday**. That
//! happens to be exactly chrono's [`Weekday::num_days_from_monday`], so this
//! module operates directly in that space — there is no node-schedule
//! `0 = Sunday` conversion to mirror (node-schedule is the Electron timer engine,
//! not part of the decision logic).

use std::collections::HashSet;

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Default slot start time when the stored string is empty/malformed — mirrors
/// the Electron `(slot.start || '11:00')`.
pub const DEFAULT_START: &str = "11:00";
/// Default slot stop time — mirrors the Electron `(slot.stop || '12:00')`.
pub const DEFAULT_STOP: &str = "12:00";

/// Late-start grace window (ms): a slot whose start time passed at most this
/// long ago is still considered "active now". 5 min — the Electron
/// `slotActiveNow` default `windowMs`.
pub const DEFAULT_WINDOW_MS: i64 = 5 * 60_000;

/// Window for late-starting an in-progress slot on a missed-check pass (ms).
/// 60 min — a congregation that began 45 min late still gets the rest captured.
/// (`scheduler.ts` `MISSED_WINDOW_MS`.)
pub const MISSED_WINDOW_MS: i64 = 60 * 60_000;

/// How far back a missed-check looks for slots/specials that never ran (ms).
/// 24 h — older than that is too stale to surface. (`MISSED_LOG_WINDOW_MS`.)
pub const MISSED_LOG_WINDOW_MS: i64 = 24 * 60 * 60_000;

/// A history entry within ±this of an expected start "covers" it, so we don't
/// double-log a missed recording (ms). 30 min — the Electron `historyCovers`.
pub const HISTORY_COVER_MS: i64 = 30 * 60_000;

/// Background preflight runs this many minutes before a scheduled start, so the
/// user gets an alert in time to act. (`scheduler.ts` `PREFLIGHT_LEAD_MIN`.)
pub const PREFLIGHT_LEAD_MIN: i32 = 30;

// ─────────────────────────────────────────────────────────────────────────────
//   Types — serde-compatible with the Electron `types/index.ts` interfaces
// ─────────────────────────────────────────────────────────────────────────────

/// A weekly recurring recording window. Mirrors the Electron `ScheduleSlot`
/// (`types/index.ts:18`): `{ days: number[]; start: string; stop: string; max?: number }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/ScheduleSlot.ts")]
#[serde(rename_all = "camelCase")]
pub struct ScheduleSlot {
    /// Active weekdays, 0 = Monday … 6 = Sunday.
    #[serde(default)]
    pub days: Vec<u32>,
    /// Start time `HH:MM` (local wall clock).
    #[serde(default = "default_start")]
    pub start: String,
    /// Stop time `HH:MM` (local wall clock). May be < start (crosses midnight).
    #[serde(default = "default_stop")]
    pub stop: String,
    /// Optional hard cap in minutes for this slot's recording length.
    #[serde(default)]
    pub max: Option<i32>,
}

/// A one-off dated recording. Mirrors the Electron `SpecialRecording`
/// (`types/index.ts:25`): `{ id?; date; name; start; stop; deviceId? }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/SpecialRecording.ts")]
#[serde(rename_all = "camelCase")]
pub struct SpecialRecording {
    /// Stable id (UI-generated), optional for older stored entries.
    #[serde(default)]
    pub id: Option<String>,
    /// Calendar date `YYYY-MM-DD`.
    #[serde(default)]
    pub date: String,
    /// Human-readable label shown in history / notifications.
    #[serde(default)]
    pub name: String,
    /// Start time `HH:MM`.
    #[serde(default = "default_start")]
    pub start: String,
    /// Stop time `HH:MM`.
    #[serde(default = "default_stop")]
    pub stop: String,
    /// Optional capture-device override for this recording.
    #[serde(default)]
    pub device_id: Option<String>,
}

fn default_start() -> String {
    DEFAULT_START.to_string()
}
fn default_stop() -> String {
    DEFAULT_STOP.to_string()
}

// ─────────────────────────────────────────────────────────────────────────────
//   Parsing
// ─────────────────────────────────────────────────────────────────────────────

/// Parse `"HH:MM"` → `(hour, minute)`, falling back to `fallback` when the
/// string is empty or either component is missing/non-numeric.
///
/// The Electron code does `(slot.start || '11:00').split(':').map(Number)` and
/// passes the result to `Date.setHours`. We are stricter about garbage (a
/// half-formed `"9"` becomes the fallback rather than an `Invalid Date`), but
/// agree on every well-formed `HH:MM` and on the empty-string default.
pub fn parse_hm(s: &str, fallback: (u32, u32)) -> (u32, u32) {
    if s.trim().is_empty() {
        return fallback;
    }
    let mut parts = s.split(':');
    let h = parts.next().and_then(|p| p.trim().parse::<u32>().ok());
    let m = parts.next().and_then(|p| p.trim().parse::<u32>().ok());
    match (h, m) {
        (Some(h), Some(m)) if h < 24 && m < 60 => (h, m),
        _ => fallback,
    }
}

fn parse_date(date: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()
}

/// Combine a `YYYY-MM-DD` date and `HH:MM` time into a wall-clock datetime,
/// using the Electron `new Date(`${date}T${time || '11:00'}`)` fallback.
pub fn parse_date_time(date: &str, time: &str, fallback: (u32, u32)) -> Option<NaiveDateTime> {
    let d = parse_date(date)?;
    let (h, m) = parse_hm(time, fallback);
    d.and_hms_opt(h, m, 0)
}

/// Weekday of `dt` in the UI convention (0 = Monday … 6 = Sunday).
pub fn weekday_mon0(dt: NaiveDateTime) -> u32 {
    dt.weekday().num_days_from_monday()
}

fn at_time(dt: NaiveDateTime, h: u32, m: u32) -> Option<NaiveDateTime> {
    dt.date().and_hms_opt(h, m, 0)
}

// ─────────────────────────────────────────────────────────────────────────────
//   Active-now (late-start) detection
// ─────────────────────────────────────────────────────────────────────────────

/// True if `now` falls within `[start, start + window]` on one of `days` and is
/// still before `stop`. Direct port of `scheduler.ts` `slotActiveNow`.
pub fn slot_active_now(
    start: &str,
    stop: &str,
    days: &[u32],
    now: NaiveDateTime,
    window_ms: i64,
) -> bool {
    let (sh, sm) = parse_hm(start, (11, 0));
    let (eh, em) = parse_hm(stop, (12, 0));
    let today = weekday_mon0(now);
    for &d in days {
        if today != d {
            continue;
        }
        let (Some(start_t), Some(stop_t)) = (at_time(now, sh, sm), at_time(now, eh, em)) else {
            continue;
        };
        let late = (now - start_t).num_milliseconds();
        if late >= 0 && late <= window_ms && now < stop_t {
            return true;
        }
    }
    false
}

/// True if `now` falls within `[start, start + window]` for a dated special and
/// is still before `stop`. Direct port of `scheduler.ts` `specialActiveNow`.
pub fn special_active_now(
    date: &str,
    start: &str,
    stop: &str,
    now: NaiveDateTime,
    window_ms: i64,
) -> bool {
    let (Some(start_dt), Some(stop_dt)) = (
        parse_date_time(date, start, (11, 0)),
        parse_date_time(date, stop, (12, 0)),
    ) else {
        return false;
    };
    let late = (now - start_dt).num_milliseconds();
    late >= 0 && late <= window_ms && now < stop_dt
}

// ─────────────────────────────────────────────────────────────────────────────
//   Slot shape helpers
// ─────────────────────────────────────────────────────────────────────────────

/// True if the stop time is earlier in the day than the start time, i.e. the
/// recording runs past midnight into the next day. (`scheduler.ts:87`.)
pub fn crosses_midnight(start: &str, stop: &str) -> bool {
    let (sh, sm) = parse_hm(start, (11, 0));
    let (eh, em) = parse_hm(stop, (12, 0));
    eh < sh || (eh == sh && em < sm)
}

/// True if start == stop. Such a slot is rejected by the scheduler because the
/// crosses-midnight branch would otherwise turn it into a 24-h recording
/// (`scheduler.ts:73`). The UI blocks it; this guards direct/imported edits.
pub fn is_degenerate(start: &str, stop: &str) -> bool {
    let (sh, sm) = parse_hm(start, (11, 0));
    let (eh, em) = parse_hm(stop, (12, 0));
    sh == eh && sm == em
}

// ─────────────────────────────────────────────────────────────────────────────
//   Lead-time offset (reminder + background preflight)
// ─────────────────────────────────────────────────────────────────────────────

/// A weekday/time computed by subtracting a lead from a start time, wrapping to
/// the previous day when the lead crosses midnight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LeadEvent {
    /// Weekday 0 = Monday … 6 = Sunday.
    pub weekday: u32,
    pub hour: u32,
    pub minute: u32,
}

/// Given a start at `(sh, sm)` on `weekday`, return the (weekday, hour, minute)
/// of the event `lead_min` minutes earlier. If the subtraction pushes before
/// 00:00 the weekday shifts back one day. Direct port of the reminder/preflight
/// offset math at `scheduler.ts:127` and `:142`.
pub fn lead_event(weekday: u32, sh: u32, sm: u32, lead_min: i32) -> LeadEvent {
    let total = sh as i32 * 60 + sm as i32 - lead_min;
    let norm = total.rem_euclid(1440);
    let h = (norm / 60) as u32;
    let m = (norm % 60) as u32;
    let wd = if total < 0 {
        (weekday + 6) % 7
    } else {
        weekday
    };
    LeadEvent {
        weekday: wd,
        hour: h,
        minute: m,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//   Occurrence math
// ─────────────────────────────────────────────────────────────────────────────

/// The earliest datetime > `now` that lands on `weekday` (0 = Mon … 6 = Sun) at
/// `h:m`. If today is the weekday but the time has already passed, returns the
/// occurrence one week out. Mirrors what node-schedule's `nextInvocation` would
/// report for a weekly rule.
pub fn next_occurrence(weekday: u32, h: u32, m: u32, now: NaiveDateTime) -> Option<NaiveDateTime> {
    let today = weekday_mon0(now);
    let mut days_ahead = (weekday as i64 - today as i64).rem_euclid(7);
    let today_at = at_time(now, h, m)?;
    if days_ahead == 0 && today_at <= now {
        days_ahead = 7;
    }
    (now.date() + Duration::days(days_ahead)).and_hms_opt(h, m, 0)
}

/// The latest datetime ≤ `now` that lands on `weekday` at `h:m`. Direct port of
/// `scheduler.ts` `mostRecentOccurrence`.
pub fn most_recent_occurrence(
    weekday: u32,
    h: u32,
    m: u32,
    now: NaiveDateTime,
) -> Option<NaiveDateTime> {
    let today = weekday_mon0(now);
    let mut days_back = (today as i64 - weekday as i64).rem_euclid(7);
    let today_at = at_time(now, h, m)?;
    if days_back == 0 && today_at > now {
        days_back = 7;
    }
    (now.date() - Duration::days(days_back)).and_hms_opt(h, m, 0)
}

// ─────────────────────────────────────────────────────────────────────────────
//   Upcoming / next selection
// ─────────────────────────────────────────────────────────────────────────────

/// All future START occurrences (one per active slot-weekday, plus each future
/// special) within `days_ahead` days of `now`, sorted ascending. Drives wake
/// scheduling and the "next 14 days" UI. Mirrors `getUpcomingDates`: one entry
/// per recurrence job (its single next invocation), bounded by the cutoff.
pub fn upcoming_dates(
    slots: &[ScheduleSlot],
    specials: &[SpecialRecording],
    now: NaiveDateTime,
    days_ahead: i64,
) -> Vec<NaiveDateTime> {
    let cutoff = now + Duration::days(days_ahead);
    let mut out: Vec<NaiveDateTime> = Vec::new();

    for slot in slots {
        if is_degenerate(&slot.start, &slot.stop) {
            continue;
        }
        let (sh, sm) = parse_hm(&slot.start, (11, 0));
        for &d in &slot.days {
            if let Some(inv) = next_occurrence(d, sh, sm, now) {
                if inv > now && inv < cutoff {
                    out.push(inv);
                }
            }
        }
    }
    for sp in specials {
        if let Some(start) = parse_date_time(&sp.date, &sp.start, (11, 0)) {
            if start > now && start < cutoff {
                out.push(start);
            }
        }
    }
    out.sort();
    out
}

/// The single nearest future START across all slots and specials, or `None` if
/// nothing is scheduled ahead. Port of `getNextRecording` (minus the job key).
pub fn next_recording(
    slots: &[ScheduleSlot],
    specials: &[SpecialRecording],
    now: NaiveDateTime,
) -> Option<NaiveDateTime> {
    let mut best: Option<NaiveDateTime> = None;
    let mut consider = |dt: NaiveDateTime| {
        if dt > now && best.map(|b| dt < b).unwrap_or(true) {
            best = Some(dt);
        }
    };
    for slot in slots {
        if is_degenerate(&slot.start, &slot.stop) {
            continue;
        }
        let (sh, sm) = parse_hm(&slot.start, (11, 0));
        for &d in &slot.days {
            if let Some(inv) = next_occurrence(d, sh, sm, now) {
                consider(inv);
            }
        }
    }
    for sp in specials {
        if let Some(start) = parse_date_time(&sp.date, &sp.start, (11, 0)) {
            consider(start);
        }
    }
    best
}

// ─────────────────────────────────────────────────────────────────────────────
//   Upcoming-event enumeration (drives the supervisor timer loop)
// ─────────────────────────────────────────────────────────────────────────────

/// What a [`ScheduledEvent`] tells the supervisor to do when its time arrives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduledEventKind {
    /// Begin recording the source slot/special.
    Start,
    /// Stop the current recording.
    Stop,
    /// Fire the "recording starts in N minutes" reminder notification.
    Reminder,
    /// Run the background preflight check (`PREFLIGHT_LEAD_MIN` before start).
    Preflight,
}

/// A single timed action the scheduler supervisor should perform. The shell
/// sorts these, sleeps until the nearest, fires it, then recomputes — so this
/// enumeration replaces the per-job node-schedule timers from the Electron
/// build with one deterministic, testable list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledEvent {
    /// When to fire (local wall clock).
    pub at: NaiveDateTime,
    /// What to do.
    pub kind: ScheduledEventKind,
    /// Which slot/special this came from (index into the input slices).
    pub source: TriggerKind,
}

/// Enumerate every START/STOP/REMINDER/PREFLIGHT moment within `horizon_days`
/// of `now`, sorted ascending by time. The supervisor sleeps until the first
/// entry, fires it, and re-enumerates — so a fired event naturally drops off
/// (its next occurrence rolls a week/horizon out). Mirrors the set of timers
/// `reschedule()` registers in `scheduler.ts`, minus the DST-gap *warning*
/// (which is a node-schedule artefact handled in the shell, not a decision).
///
/// - Degenerate slots (start == stop) contribute nothing (Electron skips them).
/// - `reminder_min == 0` suppresses REMINDER events (the Electron `reminderMin > 0` guard).
/// - STOP events are emitted for the slot/special's stop time even when the
///   matching start has already passed, exactly like the Electron stop job —
///   so an app launched mid-service still stops on time. `STOP` is idempotent
///   in the shell (a no-op when nothing is recording).
pub fn upcoming_events(
    slots: &[ScheduleSlot],
    specials: &[SpecialRecording],
    now: NaiveDateTime,
    reminder_min: i32,
    horizon_days: i64,
) -> Vec<ScheduledEvent> {
    let cutoff = now + Duration::days(horizon_days);
    let mut out: Vec<ScheduledEvent> = Vec::new();

    let mut push = |at: Option<NaiveDateTime>, kind, source| {
        if let Some(at) = at {
            if at > now && at < cutoff {
                out.push(ScheduledEvent { at, kind, source });
            }
        }
    };

    for (i, slot) in slots.iter().enumerate() {
        if is_degenerate(&slot.start, &slot.stop) {
            continue;
        }
        let (sh, sm) = parse_hm(&slot.start, (11, 0));
        let (eh, em) = parse_hm(&slot.stop, (12, 0));
        let crosses = crosses_midnight(&slot.start, &slot.stop);
        let src = TriggerKind::Slot(i);
        for &d in &slot.days {
            push(
                next_occurrence(d, sh, sm, now),
                ScheduledEventKind::Start,
                src,
            );
            let stop_wd = if crosses { (d + 1) % 7 } else { d };
            push(
                next_occurrence(stop_wd, eh, em, now),
                ScheduledEventKind::Stop,
                src,
            );
            if reminder_min > 0 {
                let le = lead_event(d, sh, sm, reminder_min);
                push(
                    next_occurrence(le.weekday, le.hour, le.minute, now),
                    ScheduledEventKind::Reminder,
                    src,
                );
            }
            let pf = lead_event(d, sh, sm, PREFLIGHT_LEAD_MIN);
            push(
                next_occurrence(pf.weekday, pf.hour, pf.minute, now),
                ScheduledEventKind::Preflight,
                src,
            );
        }
    }

    for (i, sp) in specials.iter().enumerate() {
        let src = TriggerKind::Special(i);
        let start = parse_date_time(&sp.date, &sp.start, (11, 0));
        push(start, ScheduledEventKind::Start, src);
        push(
            parse_date_time(&sp.date, &sp.stop, (12, 0)),
            ScheduledEventKind::Stop,
            src,
        );
        if let Some(start) = start {
            if reminder_min > 0 {
                push(
                    Some(start - Duration::minutes(reminder_min as i64)),
                    ScheduledEventKind::Reminder,
                    src,
                );
            }
            push(
                Some(start - Duration::minutes(PREFLIGHT_LEAD_MIN as i64)),
                ScheduledEventKind::Preflight,
                src,
            );
        }
    }

    out.sort_by_key(|e| e.at);
    out
}

// ─────────────────────────────────────────────────────────────────────────────
//   Special pruning
// ─────────────────────────────────────────────────────────────────────────────

/// Drop specials whose stop time ended more than 7 days before `now`, so the
/// stored list doesn't grow unbounded. Port of the prune pass at
/// `scheduler.ts:154`.
///
/// Deviation from Electron (intentional): a special whose `date`/`stop` can't be
/// parsed is **kept**, not silently dropped. The Electron `new Date('…')`
/// produces an `Invalid Date` that fails the `>=` test and is pruned; we'd
/// rather not delete a user's entry over a parse hiccup. The UI/validation keeps
/// malformed entries from being created in the first place.
pub fn prune_specials(
    specials: &[SpecialRecording],
    now: NaiveDateTime,
) -> (Vec<SpecialRecording>, usize) {
    let threshold = now - Duration::days(7);
    let kept: Vec<SpecialRecording> = specials
        .iter()
        .filter(|s| {
            parse_date_time(&s.date, &s.stop, (12, 0))
                .map(|stop| stop >= threshold)
                .unwrap_or(true)
        })
        .cloned()
        .collect();
    let pruned = specials.len() - kept.len();
    (kept, pruned)
}

// ─────────────────────────────────────────────────────────────────────────────
//   Missed-recording look-back + active-trigger detection
// ─────────────────────────────────────────────────────────────────────────────

/// Which scheduled item a missed-check found active right now, with the dedup
/// key the [`missed_recordings`] pass uses to avoid double-counting it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveTrigger {
    /// Index into the originating slots/specials slice.
    pub kind: TriggerKind,
    /// Stable dedup key shared with [`missed_recordings`].
    pub key: String,
}

/// Whether an [`ActiveTrigger`] came from a weekly slot or a dated special.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerKind {
    Slot(usize),
    Special(usize),
}

/// Dedup key for a slot occurrence — `slot:<weekday>:<start>-<stop>`. Internal
/// to this module (both [`active_within`] and [`missed_recordings`] use it), so
/// the exact shape only has to be self-consistent.
fn slot_key(slot: &ScheduleSlot, when: NaiveDateTime) -> String {
    format!("slot:{}:{}-{}", weekday_mon0(when), slot.start, slot.stop)
}

fn special_key(sp: &SpecialRecording) -> String {
    format!("special:{}:{}", sp.date, sp.start)
}

/// Slots/specials whose start time is within the late-start `window_ms` of
/// `now` and which should therefore be triggered. The engine starts each and
/// feeds the returned keys into [`missed_recordings`] as `triggered`. Mirrors
/// the trigger half of `checkMissedRecordings`.
pub fn active_within(
    slots: &[ScheduleSlot],
    specials: &[SpecialRecording],
    now: NaiveDateTime,
    window_ms: i64,
) -> Vec<ActiveTrigger> {
    let mut out = Vec::new();
    for (i, slot) in slots.iter().enumerate() {
        if slot_active_now(&slot.start, &slot.stop, &slot.days, now, window_ms) {
            out.push(ActiveTrigger {
                kind: TriggerKind::Slot(i),
                key: slot_key(slot, now),
            });
        }
    }
    for (i, sp) in specials.iter().enumerate() {
        if special_active_now(&sp.date, &sp.start, &sp.stop, now, window_ms) {
            out.push(ActiveTrigger {
                kind: TriggerKind::Special(i),
                key: special_key(sp),
            });
        }
    }
    out
}

/// A scheduled recording that the missed-check determined never ran and is too
/// stale to late-start — the engine logs it to history + the wake-failure ring.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissedRecording {
    /// The expected (wall-clock) start time.
    pub when: NaiveDateTime,
    /// Human-readable label for the history row.
    pub label: String,
}

/// Decide which slots/specials in the last 24 h should be logged as *missed*:
/// their start time is older than the late-start window (can't be run now) but
/// recent enough to matter, isn't already covered by a `triggered` late-start,
/// and isn't already present in `history` (within ±30 min). Direct port of
/// `scheduler.ts` `logMissedRecordings`.
///
/// `history` and `now` are in the same local-wall `NaiveDateTime` frame — the
/// shell converts stored epoch-ms history into local time before calling, so
/// every comparison here is tz-free.
pub fn missed_recordings(
    slots: &[ScheduleSlot],
    specials: &[SpecialRecording],
    now: NaiveDateTime,
    history: &[NaiveDateTime],
    triggered: &HashSet<String>,
) -> Vec<MissedRecording> {
    let mut out = Vec::new();
    let start_cutoff = now - Duration::milliseconds(MISSED_LOG_WINDOW_MS);

    for slot in slots {
        let (sh, sm) = parse_hm(&slot.start, (11, 0));
        for &d in &slot.days {
            let Some(candidate) = most_recent_occurrence(d, sh, sm, now) else {
                continue;
            };
            let age = (now - candidate).num_milliseconds();
            if age <= MISSED_WINDOW_MS {
                continue; // still inside late-start window
            }
            if candidate < start_cutoff {
                continue; // older than 24 h
            }
            if triggered.contains(&slot_key(slot, candidate)) {
                continue;
            }
            if history_covers(history, candidate) {
                continue;
            }
            out.push(MissedRecording {
                when: candidate,
                label: format!("Ukentlig opptak ({}–{})", slot.start, slot.stop),
            });
        }
    }

    for sp in specials {
        let Some(start) = parse_date_time(&sp.date, &sp.start, (11, 0)) else {
            continue;
        };
        let age = (now - start).num_milliseconds();
        if age <= MISSED_WINDOW_MS {
            continue;
        }
        if start < start_cutoff {
            continue;
        }
        if triggered.contains(&special_key(sp)) {
            continue;
        }
        if history_covers(history, start) {
            continue;
        }
        let label = if sp.name.trim().is_empty() {
            "Spesialopptak".to_string()
        } else {
            sp.name.clone()
        };
        out.push(MissedRecording { when: start, label });
    }

    out
}

/// True if any history start time is within ±[`HISTORY_COVER_MS`] of `when`.
fn history_covers(history: &[NaiveDateTime], when: NaiveDateTime) -> bool {
    history
        .iter()
        .any(|&h| (h - when).num_milliseconds().abs() < HISTORY_COVER_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }

    // 2026-06-07 is a Sunday; 2026-06-08 a Monday. We anchor weekday tests here.
    // chrono Mon=0 ⇒ Monday 2026-06-08 has weekday_mon0 == 0.
    #[test]
    fn weekday_convention_is_monday_zero() {
        assert_eq!(weekday_mon0(dt("2026-06-08 10:00")), 0); // Mon
        assert_eq!(weekday_mon0(dt("2026-06-09 10:00")), 1); // Tue
        assert_eq!(weekday_mon0(dt("2026-06-07 10:00")), 6); // Sun
    }

    #[test]
    fn parse_hm_handles_defaults_and_garbage() {
        assert_eq!(parse_hm("09:30", (11, 0)), (9, 30));
        assert_eq!(parse_hm("", (11, 0)), (11, 0));
        assert_eq!(parse_hm("   ", (11, 0)), (11, 0));
        assert_eq!(parse_hm("9", (11, 0)), (11, 0)); // missing minute → fallback
        assert_eq!(parse_hm("ab:cd", (12, 0)), (12, 0));
        assert_eq!(parse_hm("25:00", (12, 0)), (12, 0)); // out of range → fallback
        assert_eq!(parse_hm("10:75", (12, 0)), (12, 0));
        assert_eq!(parse_hm("00:00", (11, 0)), (0, 0));
    }

    #[test]
    fn slot_active_now_inside_and_outside_window() {
        // Sunday slot 11:00–12:00; window 5 min.
        let days = [6]; // Sun
                        // Exactly at start.
        assert!(slot_active_now(
            "11:00",
            "12:00",
            &days,
            dt("2026-06-07 11:00"),
            DEFAULT_WINDOW_MS
        ));
        // 4 min late → still active.
        assert!(slot_active_now(
            "11:00",
            "12:00",
            &days,
            dt("2026-06-07 11:04"),
            DEFAULT_WINDOW_MS
        ));
        // 6 min late → outside the start window.
        assert!(!slot_active_now(
            "11:00",
            "12:00",
            &days,
            dt("2026-06-07 11:06"),
            DEFAULT_WINDOW_MS
        ));
        // Before start.
        assert!(!slot_active_now(
            "11:00",
            "12:00",
            &days,
            dt("2026-06-07 10:59"),
            DEFAULT_WINDOW_MS
        ));
        // Wrong weekday (Monday).
        assert!(!slot_active_now(
            "11:00",
            "12:00",
            &days,
            dt("2026-06-08 11:00"),
            DEFAULT_WINDOW_MS
        ));
    }

    #[test]
    fn slot_active_now_respects_stop_even_with_wide_window() {
        // A 60-min missed-window: at 11:30 the start is 30 min ago (inside the
        // window) but we're still before the 12:00 stop → active.
        assert!(slot_active_now(
            "11:00",
            "12:00",
            &[6],
            dt("2026-06-07 11:30"),
            MISSED_WINDOW_MS
        ));
        // At 12:01 we're past stop → not active even though within 60 min of start.
        assert!(!slot_active_now(
            "11:00",
            "12:00",
            &[6],
            dt("2026-06-07 12:01"),
            MISSED_WINDOW_MS
        ));
    }

    #[test]
    fn special_active_now_matches_dated_window() {
        assert!(special_active_now(
            "2026-06-07",
            "11:00",
            "12:00",
            dt("2026-06-07 11:02"),
            DEFAULT_WINDOW_MS
        ));
        assert!(!special_active_now(
            "2026-06-07",
            "11:00",
            "12:00",
            dt("2026-06-08 11:02"), // wrong day
            DEFAULT_WINDOW_MS
        ));
        assert!(!special_active_now(
            "bad-date",
            "11:00",
            "12:00",
            dt("2026-06-07 11:02"),
            DEFAULT_WINDOW_MS
        ));
    }

    #[test]
    fn crosses_midnight_and_degenerate() {
        assert!(!crosses_midnight("11:00", "12:00"));
        assert!(crosses_midnight("23:00", "01:00"));
        assert!(crosses_midnight("23:30", "23:00"));
        assert!(!crosses_midnight("23:00", "23:30"));

        assert!(is_degenerate("11:00", "11:00"));
        assert!(!is_degenerate("11:00", "12:00"));
    }

    #[test]
    fn lead_event_same_day_and_wraparound() {
        // 11:00 start, 30-min lead → 10:30 same weekday.
        assert_eq!(
            lead_event(6, 11, 0, 30),
            LeadEvent {
                weekday: 6,
                hour: 10,
                minute: 30
            }
        );
        // 00:10 start (Monday=0), 30-min lead → 23:40 previous day (Sunday=6).
        assert_eq!(
            lead_event(0, 0, 10, 30),
            LeadEvent {
                weekday: 6,
                hour: 23,
                minute: 40
            }
        );
        // Lead 0 → unchanged.
        assert_eq!(
            lead_event(3, 9, 15, 0),
            LeadEvent {
                weekday: 3,
                hour: 9,
                minute: 15
            }
        );
    }

    #[test]
    fn next_occurrence_today_future_and_past() {
        // now = Sunday 10:00. Next Sunday-11:00 is today.
        assert_eq!(
            next_occurrence(6, 11, 0, dt("2026-06-07 10:00")),
            Some(dt("2026-06-07 11:00"))
        );
        // now = Sunday 11:30 → today's 11:00 passed → next week.
        assert_eq!(
            next_occurrence(6, 11, 0, dt("2026-06-07 11:30")),
            Some(dt("2026-06-14 11:00"))
        );
        // now = Monday → next Sunday is 6 days out.
        assert_eq!(
            next_occurrence(6, 11, 0, dt("2026-06-08 09:00")),
            Some(dt("2026-06-14 11:00"))
        );
    }

    #[test]
    fn most_recent_occurrence_today_and_back() {
        // now = Sunday 11:30 → most recent Sunday-11:00 is today.
        assert_eq!(
            most_recent_occurrence(6, 11, 0, dt("2026-06-07 11:30")),
            Some(dt("2026-06-07 11:00"))
        );
        // now = Sunday 10:00 → today's 11:00 hasn't happened → last week.
        assert_eq!(
            most_recent_occurrence(6, 11, 0, dt("2026-06-07 10:00")),
            Some(dt("2026-05-31 11:00"))
        );
        // now = Monday → most recent Sunday was yesterday.
        assert_eq!(
            most_recent_occurrence(6, 11, 0, dt("2026-06-08 09:00")),
            Some(dt("2026-06-07 11:00"))
        );
    }

    fn sunday_slot() -> ScheduleSlot {
        ScheduleSlot {
            days: vec![6],
            start: "11:00".to_string(),
            stop: "12:00".to_string(),
            max: None,
        }
    }

    #[test]
    fn next_recording_picks_nearest() {
        let slots = vec![sunday_slot()];
        let specials = vec![SpecialRecording {
            id: None,
            date: "2026-06-09".to_string(), // Tuesday, sooner than next Sunday
            name: "Konsert".to_string(),
            start: "19:00".to_string(),
            stop: "21:00".to_string(),
            device_id: None,
        }];
        // now = Monday 2026-06-08 09:00 → nearest is Tuesday's special.
        assert_eq!(
            next_recording(&slots, &specials, dt("2026-06-08 09:00")),
            Some(dt("2026-06-09 19:00"))
        );
    }

    #[test]
    fn upcoming_dates_bounds_and_sorts() {
        let slots = vec![ScheduleSlot {
            days: vec![6, 0], // Sun + Mon
            start: "11:00".to_string(),
            stop: "12:00".to_string(),
            max: None,
        }];
        // now = Sunday 2026-06-07 09:00, window 14 days.
        let up = upcoming_dates(&slots, &[], dt("2026-06-07 09:00"), 14);
        // Sun 11:00 today, Mon 11:00 tomorrow (next occurrences of each job).
        assert_eq!(up, vec![dt("2026-06-07 11:00"), dt("2026-06-08 11:00")]);
        // Degenerate slot contributes nothing.
        let deg = vec![ScheduleSlot {
            days: vec![6],
            start: "11:00".to_string(),
            stop: "11:00".to_string(),
            max: None,
        }];
        assert!(upcoming_dates(&deg, &[], dt("2026-06-07 09:00"), 14).is_empty());
    }

    #[test]
    fn prune_specials_drops_old_keeps_recent_and_malformed() {
        let now = dt("2026-06-30 12:00");
        let specials = vec![
            // ended 10 days ago → pruned
            SpecialRecording {
                id: None,
                date: "2026-06-20".to_string(),
                name: "Gammel".to_string(),
                start: "11:00".to_string(),
                stop: "12:00".to_string(),
                device_id: None,
            },
            // ended 2 days ago → kept
            SpecialRecording {
                id: None,
                date: "2026-06-28".to_string(),
                name: "Nylig".to_string(),
                start: "11:00".to_string(),
                stop: "12:00".to_string(),
                device_id: None,
            },
            // malformed date → kept (deviation from Electron, documented)
            SpecialRecording {
                id: None,
                date: "garbage".to_string(),
                name: "Rar".to_string(),
                start: "11:00".to_string(),
                stop: "12:00".to_string(),
                device_id: None,
            },
        ];
        let (kept, pruned) = prune_specials(&specials, now);
        assert_eq!(pruned, 1);
        let names: Vec<_> = kept.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["Nylig", "Rar"]);
    }

    #[test]
    fn active_within_finds_current_slot_with_key() {
        let slots = vec![sunday_slot()];
        let triggers = active_within(&slots, &[], dt("2026-06-07 11:03"), DEFAULT_WINDOW_MS);
        assert_eq!(triggers.len(), 1);
        assert_eq!(triggers[0].kind, TriggerKind::Slot(0));
        assert_eq!(triggers[0].key, "slot:6:11:00-12:00");
    }

    #[test]
    fn missed_recordings_logs_stale_uncovered_occurrence() {
        let slots = vec![sunday_slot()];
        // now = Sunday 13:00 → 11:00 start is 2 h ago: older than the 60-min
        // late-start window, within 24 h, not triggered, not in history → missed.
        let now = dt("2026-06-07 13:00");
        let missed = missed_recordings(&slots, &[], now, &[], &HashSet::new());
        assert_eq!(missed.len(), 1);
        assert_eq!(missed[0].when, dt("2026-06-07 11:00"));
        assert_eq!(missed[0].label, "Ukentlig opptak (11:00–12:00)");
    }

    #[test]
    fn missed_recordings_suppressed_when_covered_or_triggered_or_fresh() {
        let slots = vec![sunday_slot()];
        let now = dt("2026-06-07 13:00");

        // Covered by a history entry within ±30 min of 11:00 → suppressed.
        let history = vec![dt("2026-06-07 11:10")];
        assert!(missed_recordings(&slots, &[], now, &history, &HashSet::new()).is_empty());

        // Triggered this pass → suppressed.
        let mut triggered = HashSet::new();
        triggered.insert("slot:6:11:00-12:00".to_string());
        assert!(missed_recordings(&slots, &[], now, &[], &triggered).is_empty());

        // Still inside the 60-min late-start window (11:30) → not yet "missed".
        assert!(
            missed_recordings(&slots, &[], dt("2026-06-07 11:30"), &[], &HashSet::new()).is_empty()
        );
    }

    #[test]
    fn missed_recordings_ignores_occurrences_older_than_24h() {
        let slots = vec![sunday_slot()];
        // now = Monday 14:00, two days after Sunday 11:00 → > 24 h old → ignored.
        let now = dt("2026-06-09 14:00");
        assert!(missed_recordings(&slots, &[], now, &[], &HashSet::new()).is_empty());
    }

    #[test]
    fn special_recording_serde_matches_electron_camel_case() {
        let sp = SpecialRecording {
            id: Some("x1".to_string()),
            date: "2026-06-07".to_string(),
            name: "Konsert".to_string(),
            start: "19:00".to_string(),
            stop: "21:00".to_string(),
            device_id: Some("dev-2".to_string()),
        };
        let json = serde_json::to_value(&sp).unwrap();
        let obj = json.as_object().unwrap();
        assert!(obj.contains_key("deviceId"));
        assert!(!obj.contains_key("device_id"));
        // Round-trips from a partial Electron blob (missing id/deviceId).
        let back: SpecialRecording = serde_json::from_str(
            r#"{ "date": "2026-06-07", "name": "X", "start": "10:00", "stop": "11:00" }"#,
        )
        .unwrap();
        assert_eq!(back.id, None);
        assert_eq!(back.device_id, None);
        assert_eq!(back.start, "10:00");
    }

    #[test]
    fn upcoming_events_enumerates_start_stop_reminder_preflight() {
        let slots = vec![sunday_slot()];
        // now = Sunday 09:00; reminder 15 min; horizon 2 days.
        let now = dt("2026-06-07 09:00");
        let ev = upcoming_events(&slots, &[], now, 15, 2);
        // Expect today: preflight 10:30, reminder 10:45, start 11:00, stop 12:00.
        let want = [
            (dt("2026-06-07 10:30"), ScheduledEventKind::Preflight),
            (dt("2026-06-07 10:45"), ScheduledEventKind::Reminder),
            (dt("2026-06-07 11:00"), ScheduledEventKind::Start),
            (dt("2026-06-07 12:00"), ScheduledEventKind::Stop),
        ];
        assert_eq!(ev.len(), want.len());
        for (got, (at, kind)) in ev.iter().zip(want.iter()) {
            assert_eq!(got.at, *at);
            assert_eq!(got.kind, *kind);
            assert_eq!(got.source, TriggerKind::Slot(0));
        }
    }

    #[test]
    fn upcoming_events_suppresses_reminder_when_zero_and_skips_degenerate() {
        let slots = vec![sunday_slot()];
        let now = dt("2026-06-07 09:00");
        // reminder_min = 0 → no Reminder events.
        let ev = upcoming_events(&slots, &[], now, 0, 2);
        assert!(!ev.iter().any(|e| e.kind == ScheduledEventKind::Reminder));
        assert!(ev.iter().any(|e| e.kind == ScheduledEventKind::Start));

        // Degenerate slot → nothing at all.
        let deg = vec![ScheduleSlot {
            days: vec![6],
            start: "11:00".to_string(),
            stop: "11:00".to_string(),
            max: None,
        }];
        assert!(upcoming_events(&deg, &[], now, 15, 7).is_empty());
    }

    #[test]
    fn upcoming_events_emits_stop_even_when_start_passed() {
        // now = Sunday 11:30 (past the 11:00 start, before 12:00 stop). The
        // start rolls to next week but the stop is still today → emitted, so an
        // app launched mid-service still stops on time.
        let slots = vec![sunday_slot()];
        let ev = upcoming_events(&slots, &[], dt("2026-06-07 11:30"), 0, 1);
        let stops: Vec<_> = ev
            .iter()
            .filter(|e| e.kind == ScheduledEventKind::Stop)
            .collect();
        assert_eq!(stops.len(), 1);
        assert_eq!(stops[0].at, dt("2026-06-07 12:00"));
    }

    #[test]
    fn upcoming_events_handles_midnight_crossing_stop_next_day() {
        // 23:00–01:00 Saturday slot. now = Saturday 22:00.
        let slots = vec![ScheduleSlot {
            days: vec![5], // Sat
            start: "23:00".to_string(),
            stop: "01:00".to_string(),
            max: None,
        }];
        let now = dt("2026-06-06 22:00"); // Sat
        let ev = upcoming_events(&slots, &[], now, 0, 2);
        let start = ev
            .iter()
            .find(|e| e.kind == ScheduledEventKind::Start)
            .unwrap();
        let stop = ev
            .iter()
            .find(|e| e.kind == ScheduledEventKind::Stop)
            .unwrap();
        assert_eq!(start.at, dt("2026-06-06 23:00"));
        // Stop is on Sunday 01:00 (the next day).
        assert_eq!(stop.at, dt("2026-06-07 01:00"));
    }

    #[test]
    fn schedule_slot_defaults_fill_from_partial_json() {
        let s: ScheduleSlot = serde_json::from_str(r#"{ "days": [6] }"#).unwrap();
        assert_eq!(s.days, vec![6]);
        assert_eq!(s.start, "11:00");
        assert_eq!(s.stop, "12:00");
        assert_eq!(s.max, None);
    }
}
