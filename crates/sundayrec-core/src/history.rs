//! Recording-history retention decisions — pure, GUI-free, fs/network-free.
//!
//! Ports the Electron `cleanupOldRecordings` decision (`src/main/index.ts`):
//! when the user sets an `autoDeleteDays` retention window, recordings older
//! than the cutoff that live under the save-folder are deleted **from disk** and
//! dropped from the history — but only once every cloud service the user is
//! actively backing up to has confirmed the upload (so we never delete a file
//! that hasn't reached the cloud yet).
//!
//! The Electron code interleaved the *decision* (which rows are due, the
//! cloud-completeness guard, the save-dir-prefix guard) with the I/O (`fs.unlink`,
//! `store.set`). Here we keep ONLY the deterministic decision: given a snapshot
//! of candidate rows + the current config, return the ids to delete and the
//! count kept-back awaiting cloud. The `src-tauri` shell does the actual file
//! unlink + DB delete and feeds the facts back in.

use std::path::{Path, MAIN_SEPARATOR};

/// One history row, reduced to the fields the retention decision needs. Mirrors
/// the relevant subset of the Electron history entry + the Tauri `RecordingRow`.
#[derive(Debug, Clone, PartialEq)]
pub struct PruneCandidate {
    /// History row id (opaque; echoed back in the verdict).
    pub id: String,
    /// Absolute file path of the recording, if known. `None` rows are never
    /// deletion candidates (we can't unlink what we can't address).
    pub file_path: Option<String>,
    /// When the recording started, epoch ms. Compared against the cutoff.
    /// `None` rows are never candidates (an undated row can't be "too old").
    pub started_at_ms: Option<i64>,
    /// The cloud service ids that have confirmed this file is uploaded
    /// (kebab-case, e.g. `google-drive`). Compared against `expected_cloud`.
    pub cloud_uploaded: Vec<String>,
}

/// The retention decision for one prune pass. Mirrors `cleanupOldRecordings`'s
/// `remaining`/`changed`/`skippedAwaitingCloud` bookkeeping.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PruneDecision {
    /// Ids whose file should be unlinked and history row dropped.
    pub delete_ids: Vec<String>,
    /// How many rows matched the age/dir gate but were held back because a
    /// configured cloud service hasn't confirmed the upload yet.
    pub kept_awaiting_cloud: usize,
}

/// Decide which recordings to prune. Pure mirror of the Electron loop.
///
/// A row is a deletion candidate when ALL of:
///   - it has a `started_at_ms` strictly before `cutoff_ms` (now − days·86 400 000),
///   - it has a `file_path` that resolves under `save_dir` (prefix guard, so we
///     never delete a file the user moved elsewhere),
///   - every id in `expected_cloud` is present in the row's `cloud_uploaded`
///     (the "don't delete before it's safe in the cloud" guard). When
///     `expected_cloud` is empty this guard passes trivially.
///
/// `days <= 0` disables retention entirely (returns an empty decision), matching
/// the Electron early-return.
pub fn decide_prune(
    candidates: &[PruneCandidate],
    days: i64,
    cutoff_ms: i64,
    save_dir: &str,
    expected_cloud: &[String],
) -> PruneDecision {
    if days <= 0 || save_dir.is_empty() {
        return PruneDecision::default();
    }
    let mut decision = PruneDecision::default();
    for c in candidates {
        let Some(started) = c.started_at_ms else {
            continue;
        };
        let Some(path) = c.file_path.as_deref().filter(|p| !p.is_empty()) else {
            continue;
        };
        let old_enough = started < cutoff_ms;
        let under_save_dir = path_under(path, save_dir);
        if !old_enough || !under_save_dir {
            continue;
        }
        // Cloud-completeness guard: every configured service must have confirmed.
        if !expected_cloud.is_empty() {
            let missing = expected_cloud
                .iter()
                .any(|svc| !c.cloud_uploaded.iter().any(|u| u == svc));
            if missing {
                decision.kept_awaiting_cloud += 1;
                continue;
            }
        }
        decision.delete_ids.push(c.id.clone());
    }
    decision
}

/// True when `path` resolves under `save_dir` (the file lives in the user's
/// save folder, not somewhere they moved it). Mirrors the Electron
/// `path.resolve(entry.path).startsWith(saveDir + path.sep)` check: the path
/// must be strictly *inside* the dir (a deeper component), not the dir itself.
fn path_under(path: &str, save_dir: &str) -> bool {
    // Normalise both with the platform's path semantics, then compare the
    // canonical-ish string prefixes. We avoid touching the filesystem (no
    // `canonicalize`) so this stays pure + testable; `Path::starts_with`
    // compares whole components, which is the right granularity.
    let p = Path::new(path);
    let dir = Path::new(save_dir);
    // `starts_with` is true for `dir == p` too; the Electron check required a
    // trailing separator (strictly inside), so reject the exact-equal case.
    if p == dir {
        return false;
    }
    if p.starts_with(dir) {
        return true;
    }
    // Fallback string-prefix check for inputs that aren't byte-identical at the
    // component boundary (e.g. a trailing separator on `save_dir`).
    let needle = if save_dir.ends_with(MAIN_SEPARATOR) {
        save_dir.to_string()
    } else {
        format!("{save_dir}{MAIN_SEPARATOR}")
    };
    path.starts_with(&needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(id: &str, path: Option<&str>, started: Option<i64>, uploaded: &[&str]) -> PruneCandidate {
        PruneCandidate {
            id: id.into(),
            file_path: path.map(Into::into),
            started_at_ms: started,
            cloud_uploaded: uploaded.iter().map(|s| s.to_string()).collect(),
        }
    }

    const SAVE: &str = if cfg!(windows) {
        "C:\\Recordings"
    } else {
        "/recordings"
    };

    fn under(name: &str) -> String {
        if cfg!(windows) {
            format!("C:\\Recordings\\{name}")
        } else {
            format!("/recordings/{name}")
        }
    }

    #[test]
    fn disabled_when_days_zero() {
        let c = [cand("a", Some(&under("x.mp4")), Some(0), &[])];
        let d = decide_prune(&c, 0, i64::MAX, SAVE, &[]);
        assert!(d.delete_ids.is_empty());
        assert_eq!(d.kept_awaiting_cloud, 0);
    }

    #[test]
    fn disabled_when_days_negative() {
        let c = [cand("a", Some(&under("x.mp4")), Some(0), &[])];
        assert!(decide_prune(&c, -1, i64::MAX, SAVE, &[]).delete_ids.is_empty());
    }

    #[test]
    fn deletes_old_file_under_save_dir() {
        let c = [cand("old", Some(&under("a.mp4")), Some(1_000), &[])];
        // cutoff after the start → old enough
        let d = decide_prune(&c, 30, 2_000, SAVE, &[]);
        assert_eq!(d.delete_ids, vec!["old".to_string()]);
    }

    #[test]
    fn keeps_recent_file() {
        let c = [cand("new", Some(&under("a.mp4")), Some(5_000), &[])];
        let d = decide_prune(&c, 30, 2_000, SAVE, &[]);
        assert!(d.delete_ids.is_empty());
    }

    #[test]
    fn keeps_file_outside_save_dir() {
        let outside = if cfg!(windows) { "D:\\Other\\a.mp4" } else { "/other/a.mp4" };
        let c = [cand("ext", Some(outside), Some(1_000), &[])];
        let d = decide_prune(&c, 30, 2_000, SAVE, &[]);
        assert!(d.delete_ids.is_empty());
    }

    #[test]
    fn never_deletes_the_save_dir_itself() {
        let c = [cand("dir", Some(SAVE), Some(1_000), &[])];
        let d = decide_prune(&c, 30, 2_000, SAVE, &[]);
        assert!(d.delete_ids.is_empty());
    }

    #[test]
    fn skips_pathless_or_dateless_rows() {
        let c = [
            cand("nopath", None, Some(1_000), &[]),
            cand("nodate", Some(&under("a.mp4")), None, &[]),
            cand("emptypath", Some(""), Some(1_000), &[]),
        ];
        let d = decide_prune(&c, 30, 2_000, SAVE, &[]);
        assert!(d.delete_ids.is_empty());
    }

    #[test]
    fn holds_back_when_cloud_upload_incomplete() {
        let c = [cand("a", Some(&under("a.mp4")), Some(1_000), &["youtube"])];
        // expects google-drive; only youtube uploaded → held back
        let d = decide_prune(&c, 30, 2_000, SAVE, &["google-drive".into()]);
        assert!(d.delete_ids.is_empty());
        assert_eq!(d.kept_awaiting_cloud, 1);
    }

    #[test]
    fn deletes_when_all_expected_cloud_done() {
        let c = [cand(
            "a",
            Some(&under("a.mp4")),
            Some(1_000),
            &["google-drive", "youtube"],
        )];
        let d = decide_prune(&c, 30, 2_000, SAVE, &["google-drive".into()]);
        assert_eq!(d.delete_ids, vec!["a".to_string()]);
        assert_eq!(d.kept_awaiting_cloud, 0);
    }

    #[test]
    fn mixed_batch_reports_both_buckets() {
        let c = [
            cand("del", Some(&under("a.mp4")), Some(1_000), &["google-drive"]),
            cand("wait", Some(&under("b.mp4")), Some(1_000), &[]),
            cand("recent", Some(&under("c.mp4")), Some(9_000), &["google-drive"]),
        ];
        let d = decide_prune(&c, 30, 2_000, SAVE, &["google-drive".into()]);
        assert_eq!(d.delete_ids, vec!["del".to_string()]);
        assert_eq!(d.kept_awaiting_cloud, 1);
    }
}
