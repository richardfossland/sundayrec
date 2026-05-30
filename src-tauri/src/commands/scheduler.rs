//! Scheduler commands (Fase 5.1) — the thin IPC layer over [`crate::scheduler`].
//!
//! The renderer:
//!   - saves slots/specials through the normal `settings_save`, then calls
//!     `scheduler_reschedule` so the supervisor picks up the change immediately,
//!   - reads `scheduler_status` for the "next recording" + the next 14 days,
//!   - calls `scheduler_check_missed` on launch/focus to late-start anything in
//!     progress and surface recordings that never ran.
//!
//! Live updates arrive as `scheduler://{next,missed,preflight}` events.

use tauri::{AppHandle, State};

use crate::db::Db;
use crate::error::AppResult;
use crate::scheduler::{
    check_missed, status, MissedRecordingInfo, ScheduleStatus, SchedulerEngine,
};

/// Wake the supervisor to recompute its timers (call after saving schedule
/// settings) and return the fresh status.
#[tauri::command]
pub async fn scheduler_reschedule(
    engine: State<'_, SchedulerEngine>,
    db: State<'_, Db>,
) -> AppResult<ScheduleStatus> {
    engine.reschedule();
    status(&db.pool).await
}

/// The next scheduled start + the next 14 days of starts.
#[tauri::command]
pub async fn scheduler_status(db: State<'_, Db>) -> AppResult<ScheduleStatus> {
    status(&db.pool).await
}

/// Late-start anything currently in its window and return scheduled recordings
/// that were missed. Also emits `scheduler://missed`.
#[tauri::command]
pub async fn scheduler_check_missed(
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<Vec<MissedRecordingInfo>> {
    check_missed(&app, &db.pool).await
}
