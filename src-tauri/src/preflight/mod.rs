//! Preflight I/O plumbing (F2.2) — gathers the facts the pure core decides on.
//!
//! The *decisions* (which findings to raise, in which order, with the Electron
//! thresholds + messages) live in [`sundayrec_core::preflight`] and carry the
//! tests. This module only does the I/O the core deliberately can't: resolving
//! the save folder, probing it for writability, reading free disk space, and
//! checking the ffmpeg binary. It then hands those facts to
//! [`assemble_findings`](sundayrec_core::preflight::assemble_findings).
//!
//! ## macOS mic/camera permission — honestly deferred
//!
//! The Electron build used `systemPreferences.getMediaAccessStatus('microphone'
//! | 'camera')` to raise an `error/device` finding when permission was denied.
//! Tauri 2 has no equivalent clean API, and shelling out to AppleScript / `tccutil`
//! to read the TCC database is fragile and entitlement-sensitive. So the F2.2
//! plumbing leaves `mic_denied`/`cam_denied` as `false` (permission check NOT
//! performed) and defers a proper probe to **Fase 5** (wake/permission), where
//! the macOS permission flow is built. This is an honest gap, not a silent pass:
//! the core path for the finding exists and is tested; only the live probe is
//! absent.
//!
//! ## Hardware-unverified
//!
//! [`run_preflight`] itself needs a real machine: a real ffmpeg, a real volume
//! with real free space. The writable-folder probe, the free-space read and the
//! ffmpeg health-check are exercised here only against whatever the dev box has.
//! The pure decision over the facts is what the tests cover.

use std::path::PathBuf;

use sqlx::SqlitePool;
use sundayrec_core::preflight::{
    assemble_findings, video_active, PreflightFacts, PreflightFinding,
};

use crate::media::ffmpeg::ffmpeg_health;
use crate::settings;

/// Resolve the effective save folder: the user's `save_folder`, or the default
/// `<documents>/SundayRec` (mirrors Electron `preflight.ts:39`). `documents_dir`
/// is injected so this is testable without a desktop environment — the command
/// passes the Tauri-resolved Documents directory.
fn resolve_save_folder(save_folder: Option<&str>, documents_dir: &std::path::Path) -> PathBuf {
    match save_folder {
        Some(f) if !f.trim().is_empty() => PathBuf::from(f),
        _ => documents_dir.join("SundayRec"),
    }
}

/// Probe a folder for writability the way Electron did (`preflight.ts:40-47`):
/// create it (recursively) if missing, write then delete a probe file. Returns
/// `true` only when every step succeeds.
fn folder_writable(folder: &std::path::Path) -> bool {
    if std::fs::create_dir_all(folder).is_err() {
        return false;
    }
    let probe = folder.join(format!(
        ".preflight_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    if std::fs::write(&probe, b"").is_err() {
        return false;
    }
    // Best-effort cleanup; failure to remove doesn't make the folder unwritable.
    let _ = std::fs::remove_file(&probe);
    true
}

/// Free bytes on the volume holding `folder`, or `None` when the platform can't
/// report it (mirrors Electron's `statfs`-unsupported branch — the core then
/// skips the space check rather than fail-stop).
fn free_bytes(folder: &std::path::Path) -> Option<u64> {
    fs4::available_space(folder).ok()
}

/// Run the preflight check: load settings, gather the filesystem/ffmpeg facts,
/// and let the core decide the findings. `documents_dir` is the OS Documents
/// directory the Tauri command resolves (used only when no `save_folder` is set).
///
/// macOS mic/camera permission is NOT probed here — see the module docs
/// (deferred to Fase 5). An empty result means "alt klart".
pub async fn run_preflight(
    pool: &SqlitePool,
    documents_dir: &std::path::Path,
) -> Vec<PreflightFinding> {
    let settings = settings::load(pool).await.unwrap_or_default();

    let ffmpeg_missing = !ffmpeg_health().available;

    let folder = resolve_save_folder(settings.save_folder.as_deref(), documents_dir);
    let writable = folder_writable(&folder);
    // Only read free space if the folder exists/was created — otherwise the read
    // would fail anyway and we'd skip the check (None) regardless.
    let free = free_bytes(&folder);

    let facts = PreflightFacts {
        ffmpeg_missing,
        folder_writable: writable,
        free_bytes: free,
        video_active: video_active(&settings),
        // macOS permission probe deferred to Fase 5 — see module docs.
        mic_denied: false,
        cam_denied: false,
    };

    assemble_findings(facts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_save_folder_uses_setting_when_present() {
        let docs = std::path::Path::new("/home/u/Documents");
        let got = resolve_save_folder(Some("/recordings"), docs);
        assert_eq!(got, PathBuf::from("/recordings"));
    }

    #[test]
    fn resolve_save_folder_defaults_under_documents() {
        let docs = std::path::Path::new("/home/u/Documents");
        assert_eq!(resolve_save_folder(None, docs), docs.join("SundayRec"));
        // Blank/whitespace setting falls back to the default too.
        assert_eq!(
            resolve_save_folder(Some("   "), docs),
            docs.join("SundayRec")
        );
    }

    #[test]
    fn folder_writable_true_for_a_real_temp_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(folder_writable(dir.path()));
        // Probe file is cleaned up — directory is empty again.
        let entries = std::fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(entries, 0, "probe file should be removed");
    }

    #[test]
    fn folder_writable_creates_missing_nested_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let nested = dir.path().join("a/b/c");
        assert!(folder_writable(&nested));
        assert!(nested.is_dir());
    }

    #[test]
    fn free_bytes_reads_a_real_volume() {
        let dir = tempfile::tempdir().expect("tempdir");
        // The temp dir lives on a real volume, so this must report something.
        let bytes = free_bytes(dir.path());
        assert!(bytes.is_some());
        assert!(bytes.unwrap() > 0);
    }
}
