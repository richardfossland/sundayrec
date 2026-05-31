//! Database commands — the thin IPC layer over `crate::db::store`.
//!
//! These borrow the managed [`Db`] pool and delegate straight to the
//! pool-taking store functions (which carry the tests).

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri::{Manager, State};
use ts_rs::TS;

use sundayrec_core::history::{decide_prune, PruneCandidate};

use crate::db::store::{self, RecordingRow};
use crate::db::Db;
use crate::error::AppResult;
use crate::settings;

/// Read a setting's raw (JSON-encoded) value, or `null` if unset.
#[tauri::command]
pub async fn setting_get(db: State<'_, Db>, key: String) -> AppResult<Option<String>> {
    store::get_setting(&db.pool, &key).await
}

/// Insert or update a setting.
#[tauri::command]
pub async fn setting_set(db: State<'_, Db>, key: String, value: String) -> AppResult<()> {
    store::set_setting(&db.pool, &key, &value).await
}

/// List recordings, newest first, for the home-screen history.
#[tauri::command]
pub async fn recordings_list(db: State<'_, Db>) -> AppResult<Vec<RecordingRow>> {
    store::list_recordings(&db.pool).await
}

/// Delete one recording-history row by id.
#[tauri::command]
pub async fn recordings_delete(db: State<'_, Db>, id: String) -> AppResult<()> {
    store::delete_recording(&db.pool, &id).await
}

/// Delete the entire recording history.
#[tauri::command]
pub async fn recordings_clear(db: State<'_, Db>) -> AppResult<()> {
    store::clear_recordings(&db.pool).await
}

/// Set (or clear, with `null`) a recording's free-text note (capped at 4096
/// chars in the store).
#[tauri::command]
pub async fn recording_update_note(
    db: State<'_, Db>,
    id: String,
    note: Option<String>,
) -> AppResult<()> {
    store::update_recording_note(&db.pool, &id, note).await
}

/// The outcome of one auto-delete prune pass. Mirrors the Electron
/// `cleanupOldRecordings` bookkeeping (`deleted` + `skippedAwaitingCloud`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/PruneSummary.ts")]
#[serde(rename_all = "camelCase")]
pub struct PruneSummary {
    /// Recordings whose file was deleted and history row dropped.
    pub deleted: usize,
    /// Rows held back this pass because a configured cloud service hasn't
    /// confirmed the upload yet (only counted when cloud auto-backup is on).
    pub kept_awaiting_cloud: usize,
    /// Whether retention is disabled (`autoDeleteDays <= 0`) — the UI shows a
    /// hint rather than "0 deleted".
    pub disabled: bool,
}

/// Auto-delete recordings past the `autoDeleteDays` retention window.
///
/// Reads `autoDeleteDays` + `saveFolder` from settings, runs the pure
/// [`decide_prune`] decision over the current history, then unlinks the chosen
/// files and drops their rows. Returns a [`PruneSummary`]. Disabled (no-op) when
/// `autoDeleteDays <= 0`, matching the Electron early-return.
///
/// The Tauri history doesn't yet persist per-recording cloud-upload confirmation,
/// so `expected_cloud` is empty here (the cloud-completeness guard is exercised
/// in the core unit tests); when that column lands the wiring is a one-line map.
#[tauri::command]
pub async fn recordings_prune(app: AppHandle, db: State<'_, Db>) -> AppResult<PruneSummary> {
    let s = settings::load(&db.pool).await.unwrap_or_default();
    let days = s.auto_delete_days as i64;

    // Resolve the save folder (fall back to the OS documents dir, mirroring the
    // Electron default). An empty save dir disables pruning in the core decision.
    let save_dir = s.save_folder.clone().unwrap_or_else(|| {
        app.path()
            .document_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    });

    if days <= 0 {
        return Ok(PruneSummary {
            deleted: 0,
            kept_awaiting_cloud: 0,
            disabled: true,
        });
    }

    let rows = store::list_recordings(&db.pool).await?;
    let cutoff_ms = (store::now_ms() as i64) - days * 86_400_000;
    let candidates: Vec<PruneCandidate> = rows
        .iter()
        .map(|r| PruneCandidate {
            id: r.id.clone(),
            file_path: Some(r.file_path.clone()),
            started_at_ms: Some(r.started_at as i64),
            cloud_uploaded: Vec::new(),
        })
        .collect();

    let decision = decide_prune(&candidates, days, cutoff_ms, &save_dir, &[]);

    let mut deleted = 0usize;
    for id in &decision.delete_ids {
        if let Some(row) = rows.iter().find(|r| &r.id == id) {
            // Best-effort unlink: a missing file (already gone) still counts as
            // pruned; a failed unlink keeps the history row so the user can see it.
            match std::fs::remove_file(&row.file_path) {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => continue,
            }
        }
        store::delete_recording(&db.pool, id).await?;
        deleted += 1;
    }

    Ok(PruneSummary {
        deleted,
        kept_awaiting_cloud: decision.kept_awaiting_cloud,
        disabled: false,
    })
}
