//! Diagnostics + preflight commands — the thin IPC layer over
//! `crate::diagnostics` and `crate::preflight`.
//!
//! Both gather live facts (ffmpeg, devices, disk) and delegate the *decisions*
//! / *formatting* to the pure `sundayrec-core` modules that carry the tests.

use tauri::{AppHandle, Manager, State};

use crate::db::Db;
use crate::diagnostics::{run_diagnostics as run, DiagnosticsReport};
use crate::error::AppResult;
use crate::preflight::run_preflight as preflight;
use sundayrec_core::preflight::PreflightFinding;

/// Run the "ready-to-record" preflight check and return the findings (empty =
/// "alt klart"). Resolves the OS Documents dir for the default save folder.
#[tauri::command]
pub async fn run_preflight(app: AppHandle, db: State<'_, Db>) -> AppResult<Vec<PreflightFinding>> {
    // Documents dir for the default `<documents>/SundayRec` save folder; fall
    // back to the app-data dir if the platform can't report Documents.
    let documents = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    Ok(preflight(&db.pool, &documents).await)
}

/// Run diagnostics: build the markdown report, save it under the app-data dir,
/// and return it for the panel to render + copy.
#[tauri::command]
pub async fn run_diagnostics(app: AppHandle, db: State<'_, Db>) -> AppResult<DiagnosticsReport> {
    run(&app, &db.pool).await
}
