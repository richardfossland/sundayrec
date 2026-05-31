//! Auto-update status model — pure, GUI-free (R7 P2a).
//!
//! Ported from the Electron `src/main/updater.ts` (the behavioural spec). That
//! module wired `electron-updater`'s event stream
//! (`checking-for-update`/`update-available`/`download-progress`/
//! `update-downloaded`/`error`) to renderer IPC sends, gated its `check()` in
//! development (`process.env.NODE_ENV === 'development' → return`), and followed
//! the `autoUpdate` setting for `autoDownload`/`autoInstallOnAppQuit`.
//!
//! Tauri 2 replaces `electron-updater` with `tauri-plugin-updater` (a pull API:
//! `check()` → optional `Update` → `download_and_install()` with a progress
//! callback). The *plumbing* (network fetch, signature verify, install, relaunch)
//! is the impure half and lives in the `src-tauri` `update` seam behind the
//! default-off `updater` feature. THIS module is the pure half: the localized
//! status enum the renderer renders, the dev-mode check guard, the
//! progress-percentage math, and the semver "is this actually newer" decision —
//! all deterministic and unit-tested here.
//!
//! The status enum tags are camelCase so they line up 1:1 with the existing
//! `update.*` i18n catalog keys ported from Electron (`checking`, `available`,
//! `downloading`, `readyInstall`, `upToDate`, `error`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The current state of an update check/download, as the renderer renders it.
///
/// Mirrors the Electron `update-*` IPC events one-to-one. `Idle` is the
/// pre-check resting state (the renderer shows the "click to check" hint);
/// every other variant maps to an `update.<key>` i18n string.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/UpdateStatus.ts")]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum UpdateStatus {
    /// No check has run yet (or the last one was cleared). Renderer shows the
    /// "click «Se etter oppdateringer»" hint.
    Idle,
    /// A check is in flight (`checking-for-update`).
    Checking,
    /// No newer version exists (`update-not-available`).
    UpToDate,
    /// A newer version exists but isn't downloaded yet (`update-available`).
    /// `version` is the target semver.
    Available { version: String },
    /// The new version is downloading (`download-progress`). `percent` is
    /// clamped 0..=100; `version` is the target.
    Downloading { version: String, percent: u8 },
    /// The new version is downloaded and will install on relaunch
    /// (`update-downloaded`). `version` is the target.
    ReadyToInstall { version: String },
    /// The check/download failed (`error`). `message` is the human-readable
    /// reason (already classified by the seam).
    Error { message: String },
}

impl UpdateStatus {
    /// The `update.<key>` i18n key this status renders under, so the renderer
    /// (and tests) can map a status to its localized string without a `match`.
    /// `Idle` → the "check hint"; the rest mirror the Electron event names.
    pub fn i18n_key(&self) -> &'static str {
        match self {
            UpdateStatus::Idle => "update.checkHint",
            UpdateStatus::Checking => "update.checking",
            UpdateStatus::UpToDate => "update.upToDate",
            UpdateStatus::Available { .. } => "update.available",
            UpdateStatus::Downloading { .. } => "update.downloading",
            UpdateStatus::ReadyToInstall { .. } => "update.readyInstall",
            UpdateStatus::Error { .. } => "update.error",
        }
    }

    /// Whether this status represents a finished, installable download — the
    /// only state in which the "restart & install" action is meaningful.
    pub fn is_ready_to_install(&self) -> bool {
        matches!(self, UpdateStatus::ReadyToInstall { .. })
    }
}

/// Compute a clamped download percentage from bytes — the
/// `download-progress` `prog.percent` Electron exposed, recomputed here so the
/// seam can feed raw `(downloaded, total)` from the plugin's chunk callback.
/// A zero/unknown total yields 0 (the plugin reports `ContentLength` only when
/// the server sends it); a download past 100% is clamped.
pub fn download_percent(downloaded: u64, total: u64) -> u8 {
    if total == 0 {
        return 0;
    }
    let pct = (downloaded.saturating_mul(100)) / total;
    pct.min(100) as u8
}

/// Whether an update check should actually hit the network.
///
/// Direct port of the Electron `check()` guard
/// (`if (process.env.NODE_ENV === 'development') return`): in a dev build there
/// is no signed release to update to, so a check would only error. `is_dev` is
/// supplied by the seam (`cfg!(debug_assertions)` / `tauri::is_dev()`); this
/// keeps the policy testable.
pub fn should_check(is_dev: bool) -> bool {
    !is_dev
}

/// Whether `candidate` is strictly newer than `current` under semver ordering.
///
/// The updater plugin already gates on this server-side, but we re-check so a
/// misconfigured feed (e.g. a re-published same-version `latest.json`) never
/// surfaces a phantom "update available" to the user. Non-semver strings fall
/// back to a byte comparison so a tag like `"2026.05.31"` still orders sanely.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_semver(candidate), parse_semver(current)) {
        (Some(c), Some(cur)) => c > cur,
        // If either side isn't clean semver, only treat as newer when the
        // strings genuinely differ (avoids a same-string false positive).
        _ => candidate != current,
    }
}

/// Parse a `MAJOR.MINOR.PATCH` semver core (ignoring any `-pre`/`+build`
/// suffix) into a comparable tuple. Returns `None` if the three numeric
/// components aren't all present + parseable.
fn parse_semver(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.trim_start_matches('v');
    let core = core.split(['-', '+']).next().unwrap_or(core);
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None; // too many components — not a clean semver core
    }
    Some((major, minor, patch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_maps_to_the_check_hint() {
        assert_eq!(UpdateStatus::Idle.i18n_key(), "update.checkHint");
    }

    #[test]
    fn each_phase_maps_to_its_electron_event_key() {
        assert_eq!(UpdateStatus::Checking.i18n_key(), "update.checking");
        assert_eq!(UpdateStatus::UpToDate.i18n_key(), "update.upToDate");
        assert_eq!(
            UpdateStatus::Available {
                version: "1.2.3".into()
            }
            .i18n_key(),
            "update.available"
        );
        assert_eq!(
            UpdateStatus::Downloading {
                version: "1.2.3".into(),
                percent: 40
            }
            .i18n_key(),
            "update.downloading"
        );
        assert_eq!(
            UpdateStatus::ReadyToInstall {
                version: "1.2.3".into()
            }
            .i18n_key(),
            "update.readyInstall"
        );
        assert_eq!(
            UpdateStatus::Error {
                message: "boom".into()
            }
            .i18n_key(),
            "update.error"
        );
    }

    #[test]
    fn only_ready_to_install_is_installable() {
        assert!(UpdateStatus::ReadyToInstall {
            version: "1.0.0".into()
        }
        .is_ready_to_install());
        assert!(!UpdateStatus::Downloading {
            version: "1.0.0".into(),
            percent: 99
        }
        .is_ready_to_install());
        assert!(!UpdateStatus::Idle.is_ready_to_install());
    }

    #[test]
    fn download_percent_is_clamped_and_zero_safe() {
        assert_eq!(download_percent(0, 0), 0); // unknown total
        assert_eq!(download_percent(50, 200), 25);
        assert_eq!(download_percent(200, 200), 100);
        assert_eq!(download_percent(300, 200), 100); // past 100% clamps
        assert_eq!(download_percent(1, 0), 0); // total 0 never divides
    }

    #[test]
    fn dev_builds_never_check() {
        assert!(!should_check(true));
        assert!(should_check(false));
    }

    #[test]
    fn is_newer_compares_semver_components() {
        assert!(is_newer("1.2.4", "1.2.3"));
        assert!(is_newer("1.3.0", "1.2.9"));
        assert!(is_newer("2.0.0", "1.99.99"));
        assert!(!is_newer("1.2.3", "1.2.3"));
        assert!(!is_newer("1.2.2", "1.2.3"));
    }

    #[test]
    fn is_newer_strips_v_prefix_and_prerelease() {
        assert!(is_newer("v1.2.4", "1.2.3"));
        // A prerelease of the same core is NOT treated as newer (core equal).
        assert!(!is_newer("1.2.3-beta.1", "1.2.3"));
    }

    #[test]
    fn is_newer_falls_back_to_string_diff_for_non_semver() {
        assert!(is_newer("2026.05.31", "2026.05.30"));
        assert!(!is_newer("nightly", "nightly"));
    }
}
