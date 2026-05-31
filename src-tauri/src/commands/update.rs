//! Auto-update commands (R7 P2b) — the thin IPC layer over `crate::update`.
//!
//! `update_status` reports the live [`UpdateStatus`] (works in every build — it
//! starts at `idle`). `update_check` and `update_download_install` drive the
//! `tauri-plugin-updater` pull API; `update_relaunch` restarts the app to apply
//! a staged update.
//!
//! The check/download/install path is behind the **default-off `updater`**
//! feature; in the default build those commands return a clear `feature_disabled`
//! error so the panel shows a calm "auto-update isn't built into this build"
//! hint. NETWORK/GUI-UNVERIFIED behind `--features updater` (needs a signed
//! release + the updater public key — see docs/NEEDS-RICHARD.md).

use tauri::{AppHandle, State};

use sundayrec_core::update::UpdateStatus;

use crate::error::AppResult;
use crate::update::UpdateEngine;

/// The current update status (poll between the long-running check/download
/// commands). Works in every build; starts at [`UpdateStatus::Idle`].
#[tauri::command]
pub fn update_status(engine: State<'_, UpdateEngine>) -> UpdateStatus {
    engine.status()
}

/// Check for a newer signed release. Parks the result in the engine and returns
/// it. `feature_disabled` in the default build; dev builds report `upToDate`.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    engine: State<'_, UpdateEngine>,
) -> AppResult<UpdateStatus> {
    crate::update::check(&app, &engine).await
}

/// Download + install the pending update, leaving the status at
/// `readyToInstall`. The renderer then offers "restart & install"
/// (`update_relaunch`). `feature_disabled` in the default build.
#[tauri::command]
pub async fn update_download_install(
    app: AppHandle,
    engine: State<'_, UpdateEngine>,
) -> AppResult<UpdateStatus> {
    crate::update::download_and_install(&app, &engine).await
}

/// Relaunch the app to apply a staged update (the Electron `quitAndInstall`).
/// `feature_disabled` in the default build.
#[tauri::command]
pub fn update_relaunch(app: AppHandle) -> AppResult<()> {
    crate::update::relaunch(&app)
}
