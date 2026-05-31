//! Auto-update I/O plumbing (R7 P2b) — **NETWORK/GUI-UNVERIFIED**, default-off
//! `updater` feature.
//!
//! The impure half of auto-update. Every *decision* lives in the unit-tested
//! [`sundayrec_core::update`]:
//!   - the localized [`UpdateStatus`] phases the renderer renders,
//!   - the dev-mode "should we even check" guard ([`should_check`]),
//!   - the download-percentage math ([`download_percent`]),
//!   - the semver "is this genuinely newer" decision ([`is_newer`]).
//!
//! This module performs the side effects the Electron `src/main/updater.ts`
//! did, but via Tauri 2's pull-style `tauri-plugin-updater` instead of
//! `electron-updater`'s event stream:
//!   - [`check`] asks the plugin for an [`Update`], double-checks it's newer, and
//!     parks the result as `Available` (download is a separate, explicit step —
//!     matching the Electron flow where `autoDownload` could be off);
//!   - [`download_and_install`] streams the bytes (updating the live percent),
//!     installs, and leaves the status at `ReadyToInstall`;
//!   - [`relaunch`] restarts the app so the staged update takes effect (the
//!     Electron `quitAndInstall`).
//!
//! The live [`UpdateStatus`] is held in [`UpdateEngine`] (managed state) so the
//! renderer can poll `update_status` between the long-running check/download
//! commands — the same shape as the recorder/stream engines.
//!
//! ## Feature flag
//!
//! Behind the **default-off `updater`** cargo feature, because a real update
//! needs a SIGNED release + an updater keypair in `tauri.conf.json` (see
//! docs/NEEDS-RICHARD.md). The DTO + [`UpdateEngine`] + the public entry points
//! compile either way; when the feature is OFF, [`check`]/[`download_and_install`]
//! return a clear `feature_disabled` error so the renderer surfaces "auto-update
//! isn't built into this build" (mirrors the `editor`/`streaming` idiom).
//!
//! ## ⚠️ NETWORK/GUI-UNVERIFIED
//!
//! Under `--features updater` the feed fetch, signature verify, download and
//! relaunch are wired but unproven — they need a signed release + the public key
//! configured. Only the `sundayrec_core::update` decisions are unit-tested. See
//! docs/SMOKE-TEST.md §R7 and docs/NEEDS-RICHARD.md.

use std::sync::Mutex;

use tauri::AppHandle;

use sundayrec_core::update::UpdateStatus;

use crate::error::{AppError, AppResult};

/// Holds the latest [`UpdateStatus`] so the renderer can poll it (`update_status`)
/// while a check/download runs. At most one check/download is meaningful at a
/// time; the status is the single source of truth for the panel.
pub struct UpdateEngine {
    status: Mutex<UpdateStatus>,
}

impl Default for UpdateEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl UpdateEngine {
    /// A fresh engine resting at [`UpdateStatus::Idle`] (no check has run yet).
    pub fn new() -> Self {
        Self {
            status: Mutex::new(UpdateStatus::Idle),
        }
    }

    /// The current status (cheap clone for the renderer).
    pub fn status(&self) -> UpdateStatus {
        self.status
            .lock()
            .map(|s| s.clone())
            .unwrap_or(UpdateStatus::Idle)
    }

    /// Overwrite the status (used as the check/download progresses).
    pub fn set(&self, next: UpdateStatus) {
        if let Ok(mut s) = self.status.lock() {
            *s = next;
        }
    }
}

/// Whether this build is a dev build (no signed release to update to). Mirrors
/// the Electron `process.env.NODE_ENV === 'development'` guard. `debug_assertions`
/// is off in release bundles, which is exactly when a real update exists. Only
/// the `updater`-feature path (and the test) consume it, so it is gated to keep
/// the default lib build free of a dead-code warning.
#[cfg(any(feature = "updater", test))]
fn is_dev_build() -> bool {
    cfg!(debug_assertions)
}

#[cfg(feature = "updater")]
use sundayrec_core::update::should_check;

// ── Feature-OFF stubs (default build) ───────────────────────────────────────

/// Check for an update. In the default build this returns `feature_disabled`
/// (the panel shows "auto-update isn't built into this build"). Under
/// `--features updater` it queries the plugin — see the `cfg(feature)` impl.
#[cfg(not(feature = "updater"))]
#[cfg_attr(not(feature = "updater"), allow(unused_variables))]
pub async fn check(app: &AppHandle, engine: &UpdateEngine) -> AppResult<UpdateStatus> {
    Err(feature_disabled())
}

/// Download + install the pending update. `feature_disabled` in the default build.
#[cfg(not(feature = "updater"))]
#[cfg_attr(not(feature = "updater"), allow(unused_variables))]
pub async fn download_and_install(app: &AppHandle, engine: &UpdateEngine) -> AppResult<UpdateStatus> {
    let _ = (app, engine);
    Err(feature_disabled())
}

/// Relaunch the app so a staged update takes effect. `feature_disabled` here.
#[cfg(not(feature = "updater"))]
#[cfg_attr(not(feature = "updater"), allow(unused_variables))]
pub fn relaunch(app: &AppHandle) -> AppResult<()> {
    let _ = app;
    Err(feature_disabled())
}

#[cfg(not(feature = "updater"))]
fn feature_disabled() -> AppError {
    AppError::Validation(
        "feature_disabled: auto-update requires a build with `--features updater`".into(),
    )
}

// ── Feature-ON impl (NETWORK/GUI-UNVERIFIED) ────────────────────────────────

/// Check for a newer signed release.
///
/// Dev builds short-circuit to [`UpdateStatus::UpToDate`] (the [`should_check`]
/// guard) so a developer never sees an error from a missing feed. Otherwise we
/// ask the plugin; a returned `Update` is re-checked with the core's
/// [`is_newer`] (defence against a re-published same-version feed) before being
/// parked as [`UpdateStatus::Available`]. NETWORK-UNVERIFIED.
#[cfg(feature = "updater")]
pub async fn check(app: &AppHandle, engine: &UpdateEngine) -> AppResult<UpdateStatus> {
    use sundayrec_core::update::is_newer;
    use tauri_plugin_updater::UpdaterExt;

    if !should_check(is_dev_build()) {
        let s = UpdateStatus::UpToDate;
        engine.set(s.clone());
        return Ok(s);
    }

    engine.set(UpdateStatus::Checking);

    let updater = app
        .updater()
        .map_err(|e| AppError::Internal(format!("updater init: {e}")))?;

    let next = match updater.check().await {
        Ok(Some(update)) => {
            let current = app.package_info().version.to_string();
            if is_newer(&update.version, &current) {
                UpdateStatus::Available {
                    version: update.version.clone(),
                }
            } else {
                UpdateStatus::UpToDate
            }
        }
        Ok(None) => UpdateStatus::UpToDate,
        Err(e) => UpdateStatus::Error {
            message: format!("{e}"),
        },
    };

    engine.set(next.clone());
    Ok(next)
}

/// Download + install the pending update, updating the live percent as the
/// bytes stream in, then leave the status at [`UpdateStatus::ReadyToInstall`].
/// NETWORK/GUI-UNVERIFIED.
#[cfg(feature = "updater")]
pub async fn download_and_install(
    app: &AppHandle,
    engine: &UpdateEngine,
) -> AppResult<UpdateStatus> {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    use sundayrec_core::update::download_percent;
    use tauri_plugin_updater::UpdaterExt;

    let updater = app
        .updater()
        .map_err(|e| AppError::Internal(format!("updater init: {e}")))?;

    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => {
            let s = UpdateStatus::UpToDate;
            engine.set(s.clone());
            return Ok(s);
        }
        Err(e) => {
            let s = UpdateStatus::Error {
                message: format!("{e}"),
            };
            engine.set(s.clone());
            return Ok(s);
        }
    };

    let version = update.version.clone();
    engine.set(UpdateStatus::Downloading {
        version: version.clone(),
        percent: 0,
    });

    // The plugin's `download_and_install` reports `(chunk_len, content_length)`
    // per chunk; we accumulate and feed the core's clamped percent math into
    // the live status. The `on_download` closure is `Fn` (not `FnMut`), so we
    // track the running total in an atomic. GUI-UNVERIFIED.
    let downloaded = Arc::new(AtomicU64::new(0));
    let ver_for_progress = version.clone();
    let result = update
        .download_and_install(
            {
                let downloaded = downloaded.clone();
                let engine_ptr: &UpdateEngine = engine;
                // SAFETY of `&UpdateEngine` capture: `download_and_install`
                // awaits to completion within this scope, so the borrow lives
                // long enough; we only read/write the Mutex behind it.
                move |chunk_len, content_length| {
                    let total = content_length.unwrap_or(0);
                    let so_far = downloaded.fetch_add(chunk_len as u64, Ordering::SeqCst)
                        + chunk_len as u64;
                    engine_ptr.set(UpdateStatus::Downloading {
                        version: ver_for_progress.clone(),
                        percent: download_percent(so_far, total),
                    });
                }
            },
            || {},
        )
        .await;

    let next = match result {
        Ok(()) => UpdateStatus::ReadyToInstall { version },
        Err(e) => UpdateStatus::Error {
            message: format!("{e}"),
        },
    };
    engine.set(next.clone());
    Ok(next)
}

/// Relaunch the app so the staged update takes effect (the Electron
/// `quitAndInstall`). GUI-UNVERIFIED.
#[cfg(feature = "updater")]
pub fn relaunch(app: &AppHandle) -> AppResult<()> {
    // `restart()` diverges (`-> !`): the process is replaced and never returns
    // here. The `Ok(())` is unreachable but keeps the signature identical to
    // the feature-OFF stub so the command layer is feature-agnostic.
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_starts_idle_and_updates() {
        let engine = UpdateEngine::new();
        assert_eq!(engine.status(), UpdateStatus::Idle);
        engine.set(UpdateStatus::Checking);
        assert_eq!(engine.status(), UpdateStatus::Checking);
        engine.set(UpdateStatus::ReadyToInstall {
            version: "1.2.3".into(),
        });
        assert!(engine.status().is_ready_to_install());
    }

    #[test]
    fn is_dev_build_tracks_debug_assertions() {
        // In `cargo test` (a debug build) this is true; the assertion just pins
        // that the helper reflects the compile profile rather than a constant.
        assert_eq!(is_dev_build(), cfg!(debug_assertions));
    }
}
