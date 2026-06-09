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
    active_within, capped_supervisor_sleep_ms, missed_recordings, next_recording, prune_specials,
    scheduled_max_minutes, supervisor_should_fire, upcoming_dates, upcoming_events, ScheduledEvent,
    ScheduledEventKind, TriggerKind, MISSED_WINDOW_MS,
};
use sundayrec_core::settings::{FileFormat, Settings};

use crate::db::Db;
use crate::error::AppResult;
use crate::recorder::engine::{RecorderEngine, RecordingOpts};
use crate::settings;
use crate::util::lock_recover;

/// How far ahead the supervisor enumerates events before sleeping. A weekly slot
/// recurs at most every 7 days, so 8 always captures the next occurrence of
/// every active timer.
const HORIZON_DAYS: i64 = 8;

/// How many days of upcoming starts the status command reports.
const UPCOMING_DAYS: i64 = 14;

/// How many days of upcoming starts wake scheduling considers.
const WAKE_HORIZON_DAYS: i64 = 14;

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
    ///
    /// SAFEGUARD: the supervisor runs inside a SUPERVISING wrapper that re-spawns
    /// it if it ever ends — a panic unwinds the inner task and its `JoinHandle`
    /// resolves, so we restart it after a short delay. A silently-dead scheduler
    /// would miss EVERY future recording, which for a church recorder is the worst
    /// possible failure; this makes that self-healing.
    pub fn start(&self, app: AppHandle) {
        {
            let mut started = lock_recover(&self.started);
            if *started {
                return;
            }
            *started = true;
        }
        let notify = self.notify.clone();
        let next = self.next.clone();
        tauri::async_runtime::spawn(async move {
            // Count CONSECUTIVE rapid restarts so a persistently-crashing supervisor
            // escalates from a silent log line to a user-visible alert + backoff,
            // instead of spinning forever while every scheduled recording is missed.
            let mut rapid_restarts: u32 = 0;
            loop {
                // The supervisor loops forever; if its task handle EVER resolves
                // (a panic, or an unexpected return) the scheduler is effectively
                // dead — restart it.
                let started = tokio::time::Instant::now();
                let handle = tauri::async_runtime::spawn(supervisor(
                    app.clone(),
                    notify.clone(),
                    next.clone(),
                ));
                let _ = handle.await;
                // A supervisor that ran healthily for a while then died is a one-off
                // — reset. A quick re-death is a real, persistent fault.
                if started.elapsed() >= StdDuration::from_secs(300) {
                    rapid_restarts = 0;
                } else {
                    rapid_restarts += 1;
                }
                tracing::error!(
                    rapid_restarts,
                    "scheduler supervisor ENDED unexpectedly (panic?) — restarting; \
                     a dead scheduler would miss every scheduled recording"
                );
                let delay = if rapid_restarts >= 3 {
                    // Escalate ONCE (at the threshold), then back off so we don't spin.
                    if rapid_restarts == 3 {
                        notify_user(
                            &app,
                            "SundayRec — planlegger-feil",
                            "Planleggeren har en vedvarende feil og kan gå glipp av planlagte \
                             opptak. Start appen på nytt; vedvarer det, kjør Diagnose under \
                             Innstillinger → Lyd.",
                        );
                    }
                    StdDuration::from_secs(30)
                } else {
                    StdDuration::from_secs(5)
                };
                tokio::time::sleep(delay).await;
            }
        });
    }

    /// Wake the supervisor to recompute its timers (e.g. after settings save).
    pub fn reschedule(&self) {
        self.notify.notify_one();
    }

    /// The cached nearest future start, if any.
    pub fn next_recording(&self) -> Option<NaiveDateTime> {
        *lock_recover(&self.next)
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
        *lock_recover(&next_cache) = nxt;
        let _ = app.emit(NEXT_EVENT, nxt.map(fmt_dt));

        // Schedule OS wake-from-sleep timers for upcoming recordings (Fase 5.2).
        // Non-admin (no prompt) from the supervisor — the WakeEngine dedups so an
        // unchanged schedule is a cheap no-op. A user-initiated reschedule (which
        // may prompt for admin) goes through the `wake_reschedule` command.
        if settings.wake_from_sleep {
            if let Some(wake) = app.try_state::<crate::wake::WakeEngine>() {
                let upcoming = upcoming_dates(&settings.slots, &kept, now, WAKE_HORIZON_DAYS);
                let res = wake.reschedule(&upcoming, now, true, false).await;
                // Best-effort from the supervisor (non-admin, no prompt), but a
                // failure that ISN'T just "needs admin"/"disabled" is worth a
                // breadcrumb — a silently un-scheduled wake means a missed record.
                if !res.ok
                    && !matches!(
                        res.reason.as_deref(),
                        Some("permission") | Some("disabled") | Some("cancelled")
                    )
                {
                    tracing::warn!(
                        "scheduler: background wake reschedule failed: {:?} {:?}",
                        res.reason,
                        res.message
                    );
                }
            }
        }

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
        // SAFEGUARD: never `sleep` a multi-day wait in one go — a tokio timer can
        // drift / under-count across macOS system-sleep, and a clock change (NTP /
        // DST) mid-wait would make the recording fire late or never. Cap the sleep
        // so we re-evaluate against the real wall clock at least every few minutes;
        // only FIRE when this sleep covers the WHOLE remaining wait (otherwise it's
        // a periodic re-check → loop + recompute).
        let sleep_ms = capped_supervisor_sleep_ms(wait_ms);
        let fire_now = supervisor_should_fire(wait_ms);

        tokio::select! {
            _ = tokio::time::sleep(StdDuration::from_millis(sleep_ms)) => {
                if fire_now {
                    fire(&app, &pool, &settings, &kept, &ev).await;
                    tokio::time::sleep(FIRE_GUARD).await;
                }
                // else: periodic re-check — recompute against the fresh clock.
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
            let engine = app.state::<RecorderEngine>();
            // SAFEGUARD: never clobber a recording already in progress (a manual
            // take, or an earlier scheduled one still finalising). Skip + tell the
            // user, leaving the running recording untouched.
            if engine.current_state().is_active() {
                tracing::warn!(
                    "scheduler: a recording is already active — skipping the scheduled start"
                );
                notify_user(
                    app,
                    "SundayRec",
                    "Planlagt opptak hoppet over — et opptak pågår allerede.",
                );
                return;
            }
            let (custom_name, slot_max) = match ev.source {
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
            // SAFEGUARD: a scheduled recording ALWAYS carries a max-duration
            // backstop, so even a missed Stop event can't leave it recording until
            // the disk fills.
            let max_minutes = scheduled_max_minutes(slot_max);
            match build_opts(app, settings, custom_name.as_deref(), max_minutes, None) {
                Ok(opts) => {
                    // SAFEGUARD: bound the start. A stuck device-open must not wedge
                    // the supervisor (which would then miss EVERY later recording).
                    match tokio::time::timeout(
                        StdDuration::from_secs(30),
                        engine.start(app.clone(), Some(pool.clone()), opts, None),
                    )
                    .await
                    {
                        Ok(Ok(())) => tracing::info!("scheduler: started scheduled recording"),
                        Ok(Err(e)) => {
                            tracing::error!("scheduler: scheduled start failed: {e}");
                            notify_user(
                                app,
                                "SundayRec",
                                &format!("Planlagt opptak startet ikke: {e}"),
                            );
                        }
                        Err(_) => {
                            tracing::error!("scheduler: scheduled start TIMED OUT after 30s");
                            notify_user(
                                app,
                                "SundayRec",
                                "Planlagt opptak startet ikke (tidsavbrudd) — sjekk kamera/mikrofon.",
                            );
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("scheduler: could not build opts: {e}");
                    notify_user(
                        app,
                        "SundayRec",
                        &format!("Planlagt opptak kunne ikke forberedes: {e}"),
                    );
                }
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
pub(crate) fn build_opts(
    app: &AppHandle,
    settings: &Settings,
    custom_name: Option<&str>,
    max_minutes: u32,
    // `Some(b)` overrides the persisted `video_enabled` (the Home video toggle is
    // local UI state that isn't persisted); `None` uses the setting (scheduler).
    video_override: Option<bool>,
) -> AppResult<RecordingOpts> {
    let folder = resolve_save_folder(app, settings);
    std::fs::create_dir_all(&folder)?;

    // Video is on when the user wants it (override, else the setting) AND a camera
    // is actually configured. When video is on the main file MUST be a video
    // container (mp4) — an audio container like .wav can't hold a video stream, so
    // ffmpeg would drop the camera and silently record audio-only (the ".wav
    // instead of .mp4 / no video" bug). The chosen audio `format` /
    // `separate_audio_format` then only governs the SEPARATE audio sidecar;
    // audio-only recordings still use it.
    let camera_configured =
        settings.video_device_name.is_some() || settings.video_device_index.is_some();
    let video_on = video_override.unwrap_or(settings.video_enabled) && camera_configured;
    // Video recordings use the configured container (mp4 default, or mov); audio
    // recordings use the chosen audio format. `validate()` has already normalised
    // `video_container` to mp4/mov, so this is always a safe extension.
    let main_ext = if video_on {
        match settings.video_container.as_str() {
            "mov" => "mov",
            _ => "mp4",
        }
    } else {
        format_ext(settings.format)
    };
    let fname = build_filename(&FilenameParams {
        format: main_ext,
        pattern: settings.filename_pattern,
        custom_name,
        // church-calendar name not ported yet → falls back to "gudstjeneste".
        church_name: None,
        split_timestamp: None,
        now: Local::now().naive_local(),
    });
    let output_path = folder.join(fname).to_string_lossy().into_owned();
    // Never overwrite a same-day recording: bump to `_2`, `_3`, … if the chosen
    // filename already exists on disk (pure suffix logic in core; `Path::exists`
    // is the only I/O seam).
    let output_path = sundayrec_core::filename::make_unique_path(&output_path, |p| {
        std::path::Path::new(p).exists()
    });

    Ok(RecordingOpts {
        audio_device_name: settings.device_name.clone().unwrap_or_default(),
        video_device_name: if video_on {
            settings.video_device_name.clone()
        } else {
            None
        },
        output_path,
        stop_on_silence: settings.stop_on_silence,
        silence_threshold_db: Some(settings.silence_threshold),
        silence_timeout_minutes: settings.silence_timeout_minutes.max(1) as u32,
        framerate: settings.video_framerate.clamp(1, 120) as u32,
        channel_mode: settings.channels,
        input_channel_l: settings.input_channel_l,
        input_channel_r: settings.input_channel_r,
        // Auto (native) → None (omit -ar, no resample → no choppiness); explicit
        // modes → Some(hz). The legacy `sample_rate: i32` field is NOT used.
        sample_rate: settings.resolved_sample_rate(),
        bitrate_kbps: settings.bitrate_kbps(),
        split_minutes: settings.split_minutes.max(0) as u32,
        manual_max_minutes: max_minutes,
        // ON: the overlay L/R meters + waveform are now driven by THIS backend
        // `astats` telemetry (`recording://levels`) instead of a second
        // getUserMedia mic stream. Opening the mic twice (ffmpeg + getUserMedia)
        // made macOS re-mux the shared device and drop samples → choppy capture;
        // ffmpeg's own astats reads the already-captured signal, so the mic is
        // opened exactly once. The engine reader drains stderr, so the astats
        // lines don't back-pressure the capture.
        live_levels: true,
        keep_separate_audio: settings.keep_separate_audio,
        separate_audio_format: format_ext(settings.separate_audio_format).to_string(),
        // The probe targets this resolution so 1080p actually records 1080p.
        video_resolution: settings.video_resolution.clone(),
        // H.264 (default) or H.265/HEVC for the recording.
        video_codec: settings.video_codec.clone(),
        // software (libx264/5) or hardware (VideoToolbox, mac) encoder backend.
        video_encoder: settings.video_encoder.clone(),
        // Windows: force legacy DirectShow audio instead of cpal (WASAPI/ASIO).
        classic_directshow: settings.classic_directshow,
        // Resolved server-side by the recorder's camera-mode probe at start.
        video_input: None,
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
        match build_opts(app, &settings, custom_name.as_deref(), max_minutes, None) {
            Ok(opts) => {
                let engine = app.state::<RecorderEngine>();
                if let Err(e) = engine
                    .start(app.clone(), Some(pool.clone()), opts, None)
                    .await
                {
                    tracing::error!("scheduler: late-start of missed recording failed: {e}");
                    notify_user(
                        app,
                        "SundayRec",
                        &format!("Forsinket oppstart av planlagt opptak feilet: {e}"),
                    );
                }
            }
            Err(e) => tracing::error!("scheduler: could not build opts for late-start: {e}"),
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

    // ── Scheduler decision contract (time-injected) ─────────────────────────
    //
    // The supervisor (`fire`) + `check_missed` thread these pure core decisions
    // to pick the next start, late-start an active slot/special, and surface what
    // was missed. The supervisor itself needs an `AppHandle` (a live recorder +
    // notifier), so these exercise the SAME decisions the shell threads, with an
    // injected `now` — no clock, no app, no device.
    use std::collections::HashSet;
    use sundayrec_core::schedule::{
        active_within, missed_recordings, next_recording, upcoming_events, ScheduleSlot,
        ScheduledEventKind, SpecialRecording, TriggerKind, MISSED_WINDOW_MS,
    };

    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }

    /// A Sunday 11:00–12:00 weekly slot (weekday 6 = Sunday in the Mon=0 frame).
    fn sunday_slot() -> ScheduleSlot {
        ScheduleSlot {
            days: vec![6],
            start: "11:00".into(),
            stop: "12:00".into(),
            max: None,
        }
    }

    fn special(date: &str, start: &str, stop: &str, name: &str) -> SpecialRecording {
        SpecialRecording {
            id: Some(format!("sp-{date}")),
            date: date.into(),
            name: name.into(),
            start: start.into(),
            stop: stop.into(),
            device_id: None,
        }
    }

    #[test]
    fn next_start_picks_the_nearest_future_occurrence() {
        // 2026-06-03 is a Wednesday at 09:00 → the next Sunday 11:00 start is
        // 2026-06-07 11:00.
        let now = dt("2026-06-03 09:00");
        let next = next_recording(&[sunday_slot()], &[], now).unwrap();
        assert_eq!(fmt_dt(next), "2026-06-07T11:00:00");
    }

    #[test]
    fn late_start_triggers_a_slot_inside_the_missed_window() {
        // 30 min past the Sunday 11:00 start (window is 60 min) → still triggerable.
        let now = dt("2026-06-07 11:30");
        let triggers = active_within(&[sunday_slot()], &[], now, MISSED_WINDOW_MS);
        assert_eq!(triggers.len(), 1);
        assert_eq!(triggers[0].kind, TriggerKind::Slot(0));
    }

    #[test]
    fn no_late_start_once_past_the_missed_window() {
        // 90 min past start → beyond the 60-min late-start window, so the
        // supervisor would NOT late-start it (it becomes a missed candidate).
        let now = dt("2026-06-07 12:30");
        assert!(active_within(&[sunday_slot()], &[], now, MISSED_WINDOW_MS).is_empty());
    }

    #[test]
    fn missed_check_reports_a_stale_uncovered_occurrence() {
        // 2 h past the Sunday start: outside the late-start window, recent enough
        // to matter, no history covering it, not currently triggered → missed.
        let now = dt("2026-06-07 13:00");
        let missed = missed_recordings(&[sunday_slot()], &[], now, &[], &HashSet::new());
        assert_eq!(missed.len(), 1);
        assert_eq!(missed[0].when, dt("2026-06-07 11:00"));
    }

    #[test]
    fn missed_check_suppressed_when_history_covers_the_occurrence() {
        // A recording within ±30 min of the scheduled start means it DID run.
        let now = dt("2026-06-07 13:00");
        let history = [dt("2026-06-07 11:05")];
        let missed = missed_recordings(&[sunday_slot()], &[], now, &history, &HashSet::new());
        assert!(missed.is_empty(), "covered by history → not missed");
    }

    #[test]
    fn missed_check_suppressed_when_already_triggered() {
        // If the supervisor already late-started this occurrence (its key is in the
        // triggered set), it must not ALSO be logged as missed (no double-count).
        let now = dt("2026-06-07 13:00");
        let triggers = active_within(
            &[sunday_slot()],
            &[],
            dt("2026-06-07 11:30"),
            MISSED_WINDOW_MS,
        );
        let keys: HashSet<String> = triggers.into_iter().map(|t| t.key).collect();
        assert!(!keys.is_empty(), "precondition: the slot was triggerable");
        let missed = missed_recordings(&[sunday_slot()], &[], now, &[], &keys);
        assert!(missed.is_empty(), "already triggered → not missed");
    }

    #[test]
    fn overlapping_slot_and_special_both_late_start() {
        // A weekly slot AND a dated special both start at the same time: the
        // supervisor late-starts each independently (two distinct triggers, two
        // distinct dedup keys).
        let now = dt("2026-06-07 11:20");
        let sp = special("2026-06-07", "11:00", "12:00", "Konfirmasjon");
        let triggers = active_within(
            &[sunday_slot()],
            std::slice::from_ref(&sp),
            now,
            MISSED_WINDOW_MS,
        );
        assert_eq!(triggers.len(), 2, "slot + special both active");
        let kinds: Vec<TriggerKind> = triggers.iter().map(|t| t.kind).collect();
        assert!(kinds.contains(&TriggerKind::Slot(0)));
        assert!(kinds.contains(&TriggerKind::Special(0)));
        let keys: HashSet<&str> = triggers.iter().map(|t| t.key.as_str()).collect();
        assert_eq!(keys.len(), 2, "distinct dedup keys");
    }

    #[test]
    fn special_wins_when_it_is_the_nearest_future_start() {
        // A dated special on Wednesday beats the next Sunday slot.
        let now = dt("2026-06-03 08:00");
        let sp = special("2026-06-03", "10:00", "11:00", "Begravelse");
        let next = next_recording(&[sunday_slot()], std::slice::from_ref(&sp), now).unwrap();
        assert_eq!(fmt_dt(next), "2026-06-03T10:00:00");
    }

    #[test]
    fn upcoming_events_emit_a_reminder_lead_before_the_start() {
        // With a 15-min reminder lead the supervisor fires a Reminder event 15 min
        // before the Sunday 11:00 Start.
        let now = dt("2026-06-03 09:00");
        let events = upcoming_events(&[sunday_slot()], &[], now, 15, 8);
        let reminder = events
            .iter()
            .find(|e| e.kind == ScheduledEventKind::Reminder)
            .expect("a reminder event");
        assert_eq!(fmt_dt(reminder.at), "2026-06-07T10:45:00");
        // The Start fires at the slot time itself.
        let start = events
            .iter()
            .find(|e| e.kind == ScheduledEventKind::Start)
            .expect("a start event");
        assert_eq!(fmt_dt(start.at), "2026-06-07T11:00:00");
        // The reminder precedes the start.
        assert!(reminder.at < start.at);
    }

    #[test]
    fn missed_check_ignores_an_occurrence_older_than_24h() {
        // Last Sunday's slot, checked the FOLLOWING Sunday before its start: older
        // than the 24 h log window → not reported (avoids week-old noise).
        let now = dt("2026-06-14 10:00");
        let missed = missed_recordings(&[sunday_slot()], &[], now, &[], &HashSet::new());
        assert!(missed.is_empty(), "older than 24h → not logged");
    }
}
