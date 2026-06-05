//! App-level commands. For Phase 0 this is the "Hello SundayRec" IPC roundtrip:
//! the renderer calls `app_info` on startup to prove the Rust ↔ React bridge
//! works and to show the running build's identity.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::AppResult;

/// Identity of the running backend — surfaced on the home screen so the user
/// (and we, during development) can confirm the IPC bridge is live.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/AppInfo.ts")]
pub struct AppInfo {
    /// Product name.
    pub name: String,
    /// Semver of the app (from Cargo).
    pub version: String,
    /// Tauri runtime version backing this build.
    pub tauri_version: String,
    /// Target OS the backend was compiled for (`macos`, `windows`, ...).
    pub platform: String,
    /// CPU architecture (`aarch64`, `x86_64`, ...).
    pub arch: String,
    /// A friendly greeting so the home screen has human-readable proof of life.
    pub greeting: String,
}

/// Return the backend's identity. The first Phase-0 command; later phases add
/// the real domain commands (settings, devices, recorder, editor, ...).
#[tauri::command]
pub fn app_info() -> AppResult<AppInfo> {
    Ok(AppInfo {
        name: "SundayRec".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        tauri_version: tauri::VERSION.to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        greeting: "Hello SundayRec — backend connected.".to_string(),
    })
}

/// Register or remove the OS login item (launch-at-login) so scheduled recordings
/// can fire after a reboot. Backs the "Start automatisk med Windows/Mac" toggle —
/// previously that toggle only stored a boolean and never touched the OS.
#[tauri::command]
pub fn set_launch_at_login<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    enabled: bool,
) -> AppResult<()> {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    let res = if enabled { mgr.enable() } else { mgr.disable() };
    res.map_err(|e| crate::error::AppError::Internal(format!("autostart: {e}")))?;
    Ok(())
}

/// Whether the OS login item is currently registered (source of truth = the OS,
/// not the stored setting — they can drift if the user removes it manually).
#[tauri::command]
pub fn get_launch_at_login<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_reports_identity() {
        let info = app_info().expect("app_info ok");
        assert_eq!(info.name, "SundayRec");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert!(!info.platform.is_empty());
        assert!(info.greeting.contains("SundayRec"));
    }
}
