//! Scheduler engine (Fase 5.1) — the impure timer/trigger shell over the pure
//! [`sundayrec_core::schedule`] decision core.
//!
//! Replaces the Electron `src/main/scheduler.ts` + node-schedule. The *decisions*
//! (which weekday/time fires, the reminder/preflight lead offsets, what counts as
//! "active now", which past occurrences are missed) all live in the core and
//! carry the tests. This module owns only what can't be pure:
//!   - reading `Local::now()` and converting it to the core's `NaiveDateTime`
//!     local-wall frame,
//!   - one supervisor task that enumerates upcoming events
//!     ([`sundayrec_core::schedule::upcoming_events`]), sleeps until the nearest,
//!     fires it, then recomputes — woken early by [`SchedulerEngine::reschedule`]
//!     whenever settings change,
//!   - building the [`RecordingOpts`] for a scheduled start and calling the
//!     recorder engine directly (so a scheduled recording runs even when the
//!     window is hidden in the tray),
//!   - firing native reminder/preflight notifications,
//!   - pruning expired specials and persisting the trimmed list.
//!
//! ## ⚠️ TIMING/HARDWARE-UNVERIFIED
//!
//! The supervisor's wall-clock timing and the recorder hand-off can only be
//! validated on a real run (a clock ticking to a slot time, a mic attached). The
//! logic it delegates to is fully unit-tested; the orchestration here is wired
//! and compiles but has NOT been exercised against a live clock/device. Mac
//! permission prompts (mic/notification) are also a runtime concern.
//!
//! ## Honest gaps (carried to a later Fase-5 slice)
//!
//! - **Missed-recording persistence.** [`sundayrec_core::schedule::missed_recordings`]
//!   decides what was missed, and [`check_missed`] emits it + notifies, but the
//!   current `recording` table has no `status`/`error` column to store a "missed"
//!   row (Electron used a `wakeFailureHistory` ring + a `status` field). Logging
//!   missed/skipped rows waits on that schema. Dedup therefore only considers
//!   real recordings, not previously-logged misses.
//! - **Special device override.** `SpecialRecording.device_id` is a stored id, but
//!   the recorder matches by NAME; mapping id→name needs the device list. Until
//!   then a special uses the global `device_name`.
//! - **Wake-from-sleep.** Actually waking the machine (pmset/schtasks/powercfg) is
//!   Fase 5.2; this slice schedules and fires while the app is running/awake.

use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use chrono::{Local, NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;
use ts_rs::TS;

use sundayrec_core::filename::{build_filename, FilenameParams};
use sundayrec_core::schedule::{
    active_within, missed_recordings, next_recording, prune_specials, upcoming_dates,
    upcoming_events, ScheduledEvent, ScheduledEventKind, TriggerKind, MISSED_WINDOW_MS,
};
use sundayrec_core::settings::{ChannelMode, FileFormat, Settings};

use crate::db::Db;
use crate::error::AppResult;
use crate::recorder::engine::{RecorderEngine, RecordingOpts};
use crate::settings;

/// How far ahead the supervisor enumerates events before sleeping. A weekly slot
/// recurs at most every 7 days, so 8 always captures the next occurrence of
/// every active timer.
const HORIZON_DAYS: i64 = 8;

/// How many days of upcoming starts the status command reports.
const UPCOMING_DAYS: i64 = 14;

/// After firing an event the supervisor sleeps this long before recomputing, so
/// a timer that fired a few ms early can't re-select the same event and
/// double-fire it. Harmless at the scheduler's minute granularity.
const FIRE_GUARD: StdDuration = StdDuration::from_secs(1);

/// Emitted whenever the next scheduled start changes — payload is an ISO-like
/// local string (`YYYY-MM-DDTHH:MM:SS`) or `null`. Drives the tray tooltip / UI.
pub const NEXT_EVENT: &str = "scheduler://next";
/// Emitted when [`check_missed`] finds scheduled recordings that never ran.
pub const MISSED_EVENT: &str = "scheduler://missed";

// ─────────────────────────────────────────────────────────────────────────────
//   Engine (Tauri-managed state)
// ─────────────────────────────────────────────────────────────────────────────

/// Managed-state handle for the scheduler supervisor. At most one supervisor
/// task runs; [`reschedule`](Self::reschedule) wakes it to recompute.
pub struct SchedulerEngine {
    /// Wakes the supervisor to recompute (settings changed / manual reschedule).
    notify: Arc<Notify>,
    /// Guards against spawning the supervisor twice.
    started: Mutex<bool>,
    /// Cached nearest future start, for synchronous status reads.
    next: Arc<Mutex<Option<NaiveDateTime>>>,
}

impl Default for SchedulerEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl SchedulerEngine {
    pub fn new() -> Self {
        Self {
            notify: Arc::new(Notify::new()),
            started: Mutex::new(false),
            next: Arc::new(Mutex::new(None)),
        }
    }

    /// Spawn the supervisor loop (idempotent). Called once at setup with the app
    /// handle, through which the supervisor reaches the db pool + recorder engine.
    pub fn start(&self, app: AppHandle) {
        {
            let mut started = self.started.lock().expect("scheduler started lock");
            if *started {
                return;
            }
            *started = true;
        }
        let notify = self.notify.clone();
        let next = self.next.clone();
        tauri::async_runtime::spawn(async move {
            supervisor(app, notify, next).await;
        });
    }

    /// Wake the supervisor to recompute its timers (e.g. after settings save).
    pub fn reschedule(&self) {
        self.notify.notify_one();
    }

    /// The cached nearest future start, if any.
    pub fn next_recording(&self) -> Option<NaiveDateTime> {
        *self.next.lock().expect("scheduler next lock")
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//   Supervisor loop
// ─────────────────────────────────────────────────────────────────────────────

async fn supervisor(
    app: AppHandle,
    notify: Arc<Notify>,
    next_cache: Arc<Mutex<Option<NaiveDateTime>>>,
) {
    loop {
        let pool = match app.try_state::<Db>() {
            Some(db) => db.pool.clone(),
            None => {
                // DB not ready yet — wait for a reschedule signal and retry.
                notify.notified().await;
                continue;
            }
        };

        let mut settings = settings::load(&pool).await.unwrap_or_default();

        // Prune specials that ended > 7 days ago and persist the trimmed list.
        let now = Local::now().naive_local();
        let (kept, pruned) = prune_specials(&settings.special_recordings, now);
        if pruned > 0 {
            settings.special_recordings = kept.clone();
            if let Err(e) = settings::save(&pool, settings.clone()).await {
                tracing::warn!("scheduler: pruning save failed: {e}");
            }
            tracing::info!("scheduler: pruned {pruned} expired special(s)");
        }

        // Cache + broadcast the next start.
        let nxt = next_recording(&settings.slots, &kept, now);
        *next_cache.lock().expect("scheduler next lock") = nxt;
        let _ = app.emit(NEXT_EVENT, nxt.map(fmt_dt));

        let events = upcoming_events(
            &settings.slots,
            &kept,
            now,
            settings.reminder_minutes,
            HORIZON_DAYS,
        );

        let Some(ev) = events.first().cloned() else {
            // Nothing scheduled ahead — sleep until a reschedule wakes us.
            notify.notified().await;
            continue;
        };

        let wait_ms = (ev.at - Local::now().naive_local())
            .num_milliseconds()
            .max(0) as u64;

        tokio::select! {
            _ = tokio::time::sleep(StdDuration::from_millis(wait_ms)) => {
                fire(&app, &pool, &settings, &kept, &ev).await;
                tokio::time::sleep(FIRE_GUARD).await;
            }
            _ = notify.notified() => {
                // Settings changed — fall through to recompute.
            }
        }
    }
}

/// Perform a single scheduled event.
async fn fire(
    app: &AppHandle,
    pool: &SqlitePool,
    settings: &Settings,
    specials: &[sundayrec_core::schedule::SpecialRecording],
    ev: &ScheduledEvent,
) {
    match ev.kind {
        ScheduledEventKind::Start => {
            let (custom_name, max_minutes) = match ev.source {
                TriggerKind::Slot(i) => (
                    None,
                    settings
                        .slots
                        .get(i)
                        .and_then(|s| s.max)
                        .unwrap_or(0)
                        .max(0) as u32,
                ),
                TriggerKind::Special(i) => (specials.get(i).map(|s| s.name.clone()), 0u32),
            };
            match build_opts(app, settings, custom_name.as_deref(), max_minutes) {
                Ok(opts) => {
                    let engine = app.state::<RecorderEngine>();
                    if let Err(e) = engine
                        .start(app.clone(), Some(pool.clone()), opts, None)
                        .await
                    {
                        tracing::error!("scheduler: scheduled start failed: {e}");
                        notify_user(
                            app,
                            "SundayRec",
                            &format!("Planlagt opptak startet ikke: {e}"),
                        );
                    } else {
                        tracing::info!("scheduler: started scheduled recording");
                    }
                }
                Err(e) => tracing::error!("scheduler: could not build opts: {e}"),
            }
        }
        ScheduledEventKind::Stop => {
            app.state::<RecorderEngine>().stop();
            tracing::info!("scheduler: stop fired");
        }
        ScheduledEventKind::Reminder => {
            let body = reminder_body(settings.language.as_deref(), settings.reminder_minutes);
            notify_user(app, "SundayRec", &body);
        }
        ScheduledEventKind::Preflight => {
            run_scheduled_preflight(app, pool).await;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//   Opts building
// ─────────────────────────────────────────────────────────────────────────────

/// Build [`RecordingOpts`] for a scheduled recording from the persisted
/// settings. Resolves the save folder (creating it), names the file via the
/// core [`build_filename`], and maps the audio-processing settings the slim
/// Tauri `RecordingOpts` carries.
fn build_opts(
    app: &AppHandle,
    settings: &Settings,
    custom_name: Option<&str>,
    max_minutes: u32,
) -> AppResult<RecordingOpts> {
    let folder = resolve_save_folder(app, settings);
    std::fs::create_dir_all(&folder)?;

    let fname = build_filename(&FilenameParams {
        format: format_ext(settings.format),
        pattern: settings.filename_pattern,
        custom_name,
        // church-calendar name not ported yet → falls back to "gudstjeneste".
        church_name: None,
        split_timestamp: None,
        now: Local::now().naive_local(),
    });
    let output_path = folder.join(fname).to_string_lossy().into_owned();

    Ok(RecordingOpts {
        audio_device_name: settings.device_name.clone().unwrap_or_default(),
        video_device_name: if settings.video_enabled {
            settings.video_device_name.clone()
        } else {
            None
        },
        output_path,
        stop_on_silence: settings.stop_on_silence,
        silence_threshold_db: Some(settings.silence_threshold),
        silence_timeout_minutes: settings.silence_timeout_minutes.max(1) as u32,
        framerate: 30,
        stereo: matches!(settings.channels, ChannelMode::Stereo),
        split_minutes: settings.split_minutes.max(0) as u32,
        manual_max_minutes: max_minutes,
    })
}

/// `<saveFolder>` or the default `<Documents>/SundayRec`.
fn resolve_save_folder(app: &AppHandle, settings: &Settings) -> std::path::PathBuf {
    if let Some(f) = &settings.save_folder {
        if !f.trim().is_empty() {
            return std::path::PathBuf::from(f);
        }
    }
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    base.join("SundayRec")
}

fn format_ext(f: FileFormat) -> &'static str {
    match f {
        FileFormat::Mp3 => "mp3",
        FileFormat::Wav => "wav",
        FileFormat::Flac => "flac",
        FileFormat::Aac => "aac",
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//   Preflight + missed-check
// ─────────────────────────────────────────────────────────────────────────────

async fn run_scheduled_preflight(app: &AppHandle, pool: &SqlitePool) {
    use sundayrec_core::preflight::PreflightSeverity;
    let documents = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let findings = crate::preflight::run_preflight(pool, &documents).await;
    let errors: Vec<_> = findings
        .iter()
        .filter(|f| f.severity == PreflightSeverity::Error)
        .collect();
    if let Some(first) = errors.first() {
        notify_user(app, "SundayRec — sjekk før opptak", &first.message);
    }
    let _ = app.emit("scheduler://preflight", &findings);
}

/// A missed scheduled recording, surfaced to the UI.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/MissedRecordingInfo.ts")]
#[serde(rename_all = "camelCase")]
pub struct MissedRecordingInfo {
    /// ISO-like local start time the recording was supposed to begin.
    pub at: String,
    /// Human-readable label.
    pub label: String,
}

/// On-demand missed-recording check (call at startup / resume). Late-starts any
/// slot/special currently inside the 60-min window, then returns + emits the
/// older occurrences that were missed. See the module header for the
/// persistence gap.
pub async fn check_missed(
    app: &AppHandle,
    pool: &SqlitePool,
) -> AppResult<Vec<MissedRecordingInfo>> {
    let settings = settings::load(pool).await.unwrap_or_default();
    let now = Local::now().naive_local();
    let specials = &settings.special_recordings;

    // Late-start anything active right now (unless a recording is already going).
    let recording = !matches!(
        app.state::<RecorderEngine>().current_state(),
        sundayrec_core::recorder::RecorderState::Idle
    );
    let triggers = active_within(&settings.slots, specials, now, MISSED_WINDOW_MS);
    let mut triggered_keys = std::collections::HashSet::new();
    for t in &triggers {
        triggered_keys.insert(t.key.clone());
        if recording {
            continue;
        }
        let (custom_name, max_minutes) = match t.kind {
            TriggerKind::Slot(i) => (
                None,
                settings
                    .slots
                    .get(i)
                    .and_then(|s| s.max)
                    .unwrap_or(0)
                    .max(0) as u32,
            ),
            TriggerKind::Special(i) => (specials.get(i).map(|s| s.name.clone()), 0u32),
        };
        if let Ok(opts) = build_opts(app, &settings, custom_name.as_deref(), max_minutes) {
            let engine = app.state::<RecorderEngine>();
            let _ = engine
                .start(app.clone(), Some(pool.clone()), opts, None)
                .await;
        }
    }

    // History start times → local naive, for the dedup window.
    let history = recording_history_local(pool).await;
    let missed = missed_recordings(&settings.slots, specials, now, &history, &triggered_keys);
    let out: Vec<MissedRecordingInfo> = missed
        .into_iter()
        .map(|m| MissedRecordingInfo {
            at: fmt_dt(m.when),
            label: m.label,
        })
        .collect();
    if !out.is_empty() {
        let _ = app.emit(MISSED_EVENT, &out);
    }
    Ok(out)
}

/// Recording start times converted to the local-wall `NaiveDateTime` frame the
/// core compares in.
async fn recording_history_local(pool: &SqlitePool) -> Vec<NaiveDateTime> {
    let rows = crate::db::store::list_recordings(pool)
        .await
        .unwrap_or_default();
    rows.into_iter()
        .filter_map(|r| {
            Local
                .timestamp_millis_opt(r.started_at as i64)
                .single()
                .map(|dt| dt.naive_local())
        })
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
//   Status (for commands)
// ─────────────────────────────────────────────────────────────────────────────

/// The scheduler snapshot the UI renders: the next start and the next 14 days
/// of starts (ISO-like local strings).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/ScheduleStatus.ts")]
#[serde(rename_all = "camelCase")]
pub struct ScheduleStatus {
    pub next: Option<String>,
    pub upcoming: Vec<String>,
}

/// Compute the current [`ScheduleStatus`] from persisted settings.
pub async fn status(pool: &SqlitePool) -> AppResult<ScheduleStatus> {
    let settings = settings::load(pool).await.unwrap_or_default();
    let now = Local::now().naive_local();
    let next = next_recording(&settings.slots, &settings.special_recordings, now).map(fmt_dt);
    let upcoming = upcoming_dates(
        &settings.slots,
        &settings.special_recordings,
        now,
        UPCOMING_DAYS,
    )
    .into_iter()
    .map(fmt_dt)
    .collect();
    Ok(ScheduleStatus { next, upcoming })
}

// ─────────────────────────────────────────────────────────────────────────────
//   Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Format a wall-clock datetime as `YYYY-MM-DDTHH:MM:SS` (no zone — it's already
/// local). The UI parses it with `new Date(...)`, which treats a zone-less
/// string as local time, matching the frame it was produced in.
fn fmt_dt(dt: NaiveDateTime) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn notify_user(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        tracing::warn!("scheduler: notification failed: {e}");
    }
}

/// The localised "recording starts in N minutes" body. Ports the Electron
/// `REMINDER_LABELS` map; unknown languages fall back to Norwegian.
fn reminder_body(lang: Option<&str>, minutes: i32) -> String {
    let tpl = match lang.unwrap_or("no") {
        "en" => "Recording starts in {min} minutes",
        "de" => "Aufnahme beginnt in {min} Minuten",
        "sv" => "Inspelning börjar om {min} minuter",
        "da" => "Optagelse starter om {min} minutter",
        "pl" => "Nagranie rozpocznie się za {min} minut",
        "fr" => "Enregistrement dans {min} minutes",
        _ => "Opptak starter om {min} minutter",
    };
    tpl.replace("{min}", &minutes.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fmt_dt_is_zoneless_local_iso() {
        let dt = NaiveDateTime::parse_from_str("2026-06-07 11:00", "%Y-%m-%d %H:%M").unwrap();
        assert_eq!(fmt_dt(dt), "2026-06-07T11:00:00");
    }

    #[test]
    fn reminder_body_localises_and_falls_back() {
        assert_eq!(
            reminder_body(Some("en"), 15),
            "Recording starts in 15 minutes"
        );
        assert_eq!(
            reminder_body(Some("no"), 10),
            "Opptak starter om 10 minutter"
        );
        // Unknown language → Norwegian.
        assert_eq!(reminder_body(Some("xx"), 5), "Opptak starter om 5 minutter");
        assert_eq!(reminder_body(None, 30), "Opptak starter om 30 minutter");
    }

    #[test]
    fn format_ext_maps_every_variant() {
        assert_eq!(format_ext(FileFormat::Mp3), "mp3");
        assert_eq!(format_ext(FileFormat::Wav), "wav");
        assert_eq!(format_ext(FileFormat::Flac), "flac");
        assert_eq!(format_ext(FileFormat::Aac), "aac");
    }
}
