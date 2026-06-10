//! Crash-recovery I/O — persist the session manifest while recording, and on the
//! next launch finalise any orphaned recording instead of losing it.
//!
//! This is the filesystem shell over the pure decisions in
//! [`sundayrec_core::recovery`]: it writes one small JSON manifest per session
//! (under `<app-data>/recovery/`) as the deliverable layout grows, deletes it on
//! a clean finish, and — on startup — concat-finalises any survivor's fragments
//! (reusing the SAME [`finalize_deliverable`] + [`output_is_valid`] path a live
//! stop uses) and writes the recovered history rows.
//!
//! Everything here is best-effort: a failure to persist recovery state must never
//! break an in-progress recording, and a failure to recover one session must not
//! block recovering the others.
//!
//! ⚠️ HARDWARE-UNVERIFIED — touches the filesystem + spawns ffmpeg on recovery.

use std::path::{Path, PathBuf};

use sqlx::SqlitePool;
use tauri::{AppHandle, Manager};

use sundayrec_core::recovery::{recoverable_deliverables, SessionManifest};

use crate::db::store::{insert_recording, RecordingRow};
use crate::recorder::concat::{finalize_deliverable, output_is_valid};

/// `<app-data>/recovery` — where session manifests live. Created on demand.
fn manifest_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("recovery");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

fn manifest_path(app: &AppHandle, session_id: &str) -> Option<PathBuf> {
    Some(manifest_dir(app)?.join(format!("{session_id}.json")))
}

/// Write / overwrite the session manifest atomically (temp + rename). Best-effort:
/// a persistence failure is logged at debug and never propagated — recovery state
/// is a safety net, not a recording dependency.
pub async fn write_manifest(app: &AppHandle, manifest: &SessionManifest) {
    let (Some(path), Ok(body)) = (manifest_path(app, &manifest.session_id), manifest.to_json())
    else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if tokio::fs::write(&tmp, body.as_bytes()).await.is_ok() {
        let _ = tokio::fs::rename(&tmp, &path).await;
    }
}

/// Delete the manifest on a clean finish (best-effort).
pub async fn delete_manifest(app: &AppHandle, session_id: &str) {
    if let Some(path) = manifest_path(app, session_id) {
        let _ = tokio::fs::remove_file(&path).await;
    }
}

/// Startup scan: finalise every orphaned session, write its history rows, and
/// delete its manifest. Returns how many recordings were recovered. Never errors
/// — a single bad manifest is logged + cleared, the rest still process.
pub async fn scan_and_recover(app: AppHandle, pool: SqlitePool) -> usize {
    let Some(dir) = manifest_dir(&app) else {
        return 0;
    };
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(e) => e,
        Err(_) => return 0,
    };
    let mut recovered = 0usize;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(body) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        match SessionManifest::from_json(&body) {
            Ok(manifest) => {
                recovered += recover_session(&pool, &manifest).await;
                // Clean up the manifest + any leftover pre-roll clip.
                let _ = tokio::fs::remove_file(&path).await;
                if let Some(clip) = &manifest.preroll_clip_path {
                    let _ = tokio::fs::remove_file(clip).await;
                }
            }
            Err(e) => {
                tracing::warn!(file = %path.display(), "recovery: corrupt manifest, deleting: {e}");
                let _ = tokio::fs::remove_file(&path).await;
            }
        }
    }
    if recovered > 0 {
        tracing::info!("recovery: recovered {recovered} interrupted recording(s) on startup");
    }
    recovered
}

/// Finalise one orphaned session's surviving deliverables into history rows.
async fn recover_session(pool: &SqlitePool, manifest: &SessionManifest) -> usize {
    let recoverable = recoverable_deliverables(manifest, |p| Path::new(p).exists());
    let mut count = 0usize;
    for (index, dm) in recoverable.iter().enumerate() {
        let deliverable = dm.to_deliverable();
        // The pre-roll clip is prepended only to the first deliverable, and only
        // if it still exists.
        let preroll = if index == 0 {
            manifest
                .preroll_clip_path
                .as_deref()
                .filter(|p| Path::new(p).exists())
        } else {
            None
        };

        let final_path = finalize_deliverable(&deliverable, preroll)
            .await
            .unwrap_or_else(|e| {
                tracing::warn!(
                    deliverable = %dm.primary_path,
                    "recovery: concat failed, keeping primary: {e}"
                );
                dm.primary_path.clone()
            });

        if !output_is_valid(Path::new(&final_path)).await {
            tracing::warn!(file = %final_path, "recovery: finished file invalid — skipping history row");
            continue;
        }

        // Idempotency: a deliverable finalised live (e.g. a split closed before
        // the device failed) already has a history row. A non-clean session end
        // doesn't delete the manifest, so this replay would otherwise insert a
        // DUPLICATE row pointing at the same file. Skip anything already recorded.
        if crate::db::store::recording_exists_for_path(pool, &final_path)
            .await
            .unwrap_or(false)
        {
            tracing::info!(file = %final_path, "recovery: history row already exists — skipping duplicate");
            continue;
        }

        let byte_size = tokio::fs::metadata(&final_path)
            .await
            .map(|m| m.len() as i64)
            .ok();
        // Duration: known for a deliverable that another one followed (a split);
        // unknown for the LAST one (we don't know when the crash hit) → None.
        let duration_ms = recoverable
            .get(index + 1)
            .map(|next| (next.started_at_ms.saturating_sub(dm.started_at_ms)) as f64)
            .filter(|d| *d > 0.0);

        let row = RecordingRow {
            id: String::new(),
            file_path: final_path,
            device_name: Some(manifest.device_name.clone()),
            started_at: dm.started_at_ms as f64,
            duration_ms,
            byte_size,
            created_at: 0.0,
            note: Some("Gjenopprettet etter uventet avslutning".into()),
        };
        if insert_recording(pool, row).await.is_ok() {
            count += 1;
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::store::{list_recordings, open_pool};
    use sundayrec_core::recovery::{
        has_recoverable_audio, recoverable_deliverables, DeliverableManifest,
    };

    /// A fully-migrated pool over a temp-dir database file (mirrors the db/settings
    /// test helper). Kept alongside its `TempDir` so the file lives for the test.
    async fn temp_pool() -> (SqlitePool, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = open_pool(&dir.path().join("test.sqlite"))
            .await
            .expect("open_pool");
        (pool, dir)
    }

    /// Write an above-gate fake fragment file so `output_is_valid`'s size gate
    /// accepts it (ffprobe is advisory and tolerant when the sidecar is absent).
    async fn write_fragment(path: &Path) {
        tokio::fs::write(path, vec![0u8; 64 * 1024])
            .await
            .expect("write fragment");
    }

    /// A manifest whose two single-fragment deliverables live under `dir`. No
    /// reconnects / pre-roll, so the recovery finalize path is a no-op concat
    /// (single fragment → returned untouched) and never spawns ffmpeg.
    fn manifest_in(dir: &Path) -> SessionManifest {
        let a = dir.join("sermon.m4a").to_string_lossy().into_owned();
        let b = dir.join("sermon_2.m4a").to_string_lossy().into_owned();
        SessionManifest {
            session_id: "1700000000000-sermon".into(),
            device_name: "Soundcraft USB".into(),
            session_start_ms: 1_700_000_000_000,
            preroll_clip_path: None,
            deliverables: vec![
                DeliverableManifest {
                    primary_path: a.clone(),
                    fragments: vec![a],
                    started_at_ms: 1_700_000_000_000,
                },
                DeliverableManifest {
                    primary_path: b.clone(),
                    fragments: vec![b],
                    started_at_ms: 1_700_000_600_000,
                },
            ],
        }
    }

    #[tokio::test]
    async fn recover_session_writes_history_rows_for_surviving_fragments() {
        let (pool, _db) = temp_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let m = manifest_in(dir.path());
        // Both deliverables' files exist on disk.
        write_fragment(Path::new(&m.deliverables[0].primary_path)).await;
        write_fragment(Path::new(&m.deliverables[1].primary_path)).await;

        let recovered = recover_session(&pool, &m).await;
        assert_eq!(recovered, 2, "both surviving deliverables recovered");

        let rows = list_recordings(&pool).await.unwrap();
        assert_eq!(rows.len(), 2);
        // Every recovered row carries the device + the recovery note, and a size.
        for r in &rows {
            assert_eq!(r.device_name.as_deref(), Some("Soundcraft USB"));
            assert_eq!(
                r.note.as_deref(),
                Some("Gjenopprettet etter uventet avslutning")
            );
            assert!(r.byte_size.unwrap_or(0) > 0, "byte_size stamped from disk");
        }
        // The FIRST deliverable's duration is known (the next one's start − its own);
        // the LAST is unknown (None) since we can't know when the crash hit.
        let mut by_start = rows.clone();
        by_start.sort_by(|a, b| a.started_at.partial_cmp(&b.started_at).unwrap());
        assert_eq!(
            by_start[0].duration_ms,
            Some(600_000.0),
            "split gives a duration"
        );
        assert_eq!(
            by_start[1].duration_ms, None,
            "last deliverable duration unknown"
        );
    }

    #[tokio::test]
    async fn recover_session_picks_up_only_the_surviving_deliverable() {
        let (pool, _db) = temp_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let m = manifest_in(dir.path());
        // Only the SECOND deliverable's file survived; the first is missing.
        write_fragment(Path::new(&m.deliverables[1].primary_path)).await;

        // The pure decision agrees: exactly one deliverable is recoverable.
        let rec = recoverable_deliverables(&m, |p| Path::new(p).exists());
        assert_eq!(rec.len(), 1);

        let recovered = recover_session(&pool, &m).await;
        assert_eq!(
            recovered, 1,
            "only the deliverable with a survivor recovers"
        );
        let rows = list_recordings(&pool).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].file_path, m.deliverables[1].primary_path);
    }

    #[tokio::test]
    async fn recover_session_is_idempotent_for_already_recorded_deliverables() {
        // Regression: a split finalised LIVE already wrote its history row. A
        // non-clean session end (e.g. reconnect GiveUp) doesn't delete the
        // manifest, so the next-launch replay must NOT insert a duplicate row
        // for that deliverable — only the not-yet-recorded one.
        let (pool, _db) = temp_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let m = manifest_in(dir.path());
        write_fragment(Path::new(&m.deliverables[0].primary_path)).await;
        write_fragment(Path::new(&m.deliverables[1].primary_path)).await;

        // Deliverable 0 was already recorded live (a row exists for its path).
        crate::db::store::insert_recording(
            &pool,
            crate::db::store::RecordingRow {
                id: String::new(),
                file_path: m.deliverables[0].primary_path.clone(),
                device_name: Some("Soundcraft USB".into()),
                started_at: m.deliverables[0].started_at_ms as f64,
                duration_ms: Some(600_000.0),
                byte_size: Some(1234),
                created_at: 0.0,
                note: None,
            },
        )
        .await
        .unwrap();

        let recovered = recover_session(&pool, &m).await;
        assert_eq!(
            recovered, 1,
            "only the not-yet-recorded deliverable is added"
        );

        let rows = list_recordings(&pool).await.unwrap();
        assert_eq!(
            rows.len(),
            2,
            "no duplicate row for the already-recorded file"
        );
        let d0 = &m.deliverables[0].primary_path;
        assert_eq!(
            rows.iter().filter(|r| &r.file_path == d0).count(),
            1,
            "the already-recorded deliverable must not be re-inserted"
        );
    }

    #[tokio::test]
    async fn recover_session_recovers_nothing_when_all_fragments_are_missing() {
        let (pool, _db) = temp_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let m = manifest_in(dir.path());
        // Write NO files — every fragment path is missing.
        assert!(!has_recoverable_audio(&m, |p| Path::new(p).exists()));

        let recovered = recover_session(&pool, &m).await;
        assert_eq!(recovered, 0, "nothing on disk → nothing to recover");
        assert!(list_recordings(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn recover_session_on_empty_manifest_is_a_noop() {
        let (pool, _db) = temp_pool().await;
        let m = SessionManifest {
            session_id: "empty".into(),
            device_name: "dev".into(),
            session_start_ms: 0,
            preroll_clip_path: None,
            deliverables: vec![],
        };
        assert_eq!(recover_session(&pool, &m).await, 0);
        assert!(list_recordings(&pool).await.unwrap().is_empty());
    }

    /// Mirror of `scan_and_recover`'s manifest read → parse → cleanup loop, exercised
    /// directly against a real recovery directory (the production fn needs an
    /// `AppHandle` only to LOCATE that directory; the loop body is what matters).
    async fn scan_dir(pool: &SqlitePool, dir: &Path) -> usize {
        let mut entries = tokio::fs::read_dir(dir).await.unwrap();
        let mut recovered = 0usize;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(body) = tokio::fs::read_to_string(&path).await else {
                continue;
            };
            match SessionManifest::from_json(&body) {
                Ok(manifest) => {
                    recovered += recover_session(pool, &manifest).await;
                    let _ = tokio::fs::remove_file(&path).await;
                    if let Some(clip) = &manifest.preroll_clip_path {
                        let _ = tokio::fs::remove_file(clip).await;
                    }
                }
                Err(_) => {
                    let _ = tokio::fs::remove_file(&path).await;
                }
            }
        }
        recovered
    }

    #[tokio::test]
    async fn scan_loop_recovers_a_valid_manifest_then_deletes_it() {
        let (pool, _db) = temp_pool().await;
        let recovery = tempfile::tempdir().unwrap();
        let rec = tempfile::tempdir().unwrap();

        // Write a real fragment + a manifest JSON pointing at it.
        let m = manifest_in(rec.path());
        write_fragment(Path::new(&m.deliverables[0].primary_path)).await;
        write_fragment(Path::new(&m.deliverables[1].primary_path)).await;
        let manifest_file = recovery.path().join("session.json");
        tokio::fs::write(&manifest_file, m.to_json().unwrap())
            .await
            .unwrap();

        let recovered = scan_dir(&pool, recovery.path()).await;
        assert_eq!(recovered, 2);
        assert_eq!(list_recordings(&pool).await.unwrap().len(), 2);
        assert!(!manifest_file.exists(), "manifest cleared after recovery");
    }

    #[tokio::test]
    async fn scan_loop_skips_and_clears_a_corrupt_manifest() {
        let (pool, _db) = temp_pool().await;
        let recovery = tempfile::tempdir().unwrap();
        let bad = recovery.path().join("corrupt.json");
        tokio::fs::write(&bad, b"{ not valid json ]]] ")
            .await
            .unwrap();

        let recovered = scan_dir(&pool, recovery.path()).await;
        assert_eq!(recovered, 0, "a corrupt manifest recovers nothing");
        assert!(list_recordings(&pool).await.unwrap().is_empty());
        assert!(
            !bad.exists(),
            "corrupt manifest is deleted, not left to retry"
        );
    }

    #[tokio::test]
    async fn scan_loop_with_all_fragments_missing_recovers_nothing_and_clears_litter() {
        let (pool, _db) = temp_pool().await;
        let recovery = tempfile::tempdir().unwrap();
        let rec = tempfile::tempdir().unwrap();
        // A manifest whose fragments are all MISSING (no files written) is pure
        // litter: nothing recovers, and the manifest is still cleaned up.
        let m = manifest_in(rec.path());
        let manifest_file = recovery.path().join("orphan.json");
        tokio::fs::write(&manifest_file, m.to_json().unwrap())
            .await
            .unwrap();

        let recovered = scan_dir(&pool, recovery.path()).await;
        assert_eq!(recovered, 0);
        assert!(list_recordings(&pool).await.unwrap().is_empty());
        assert!(!manifest_file.exists(), "litter manifest cleared");
    }

    #[tokio::test]
    async fn scan_loop_ignores_non_json_files() {
        let (pool, _db) = temp_pool().await;
        let recovery = tempfile::tempdir().unwrap();
        let stray = recovery.path().join("notes.txt");
        tokio::fs::write(&stray, b"hello").await.unwrap();

        assert_eq!(scan_dir(&pool, recovery.path()).await, 0);
        assert!(stray.exists(), "non-json files are left untouched");
    }
}
