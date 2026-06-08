//! The cloud upload-queue state machine — pure, no persistence and no timers.
//!
//! Ported from `src/main/cloud/upload-queue.ts`. The Electron module wove the
//! queue *transitions* (dedup on enqueue, pick the next runnable entry, mark
//! uploading, and — crucially — what a success or failure does to an entry's
//! status / attempt count / next-attempt time) together with `electron-store`
//! persistence, `fs.existsSync`, connectivity probes, `setTimeout` scheduling,
//! and IPC sends. Here we keep only the transitions over an in-memory
//! `Vec<QueueEntry>`; the `src-tauri` shell owns the sqlx-backed persistence,
//! the file-exists / token / connectivity checks, the real timer, and the
//! events. Every function takes `now_ms` rather than reading the clock.
//!
//! The retryable-failure backoff schedule ([`BACKOFF_STEPS_MS`]) and the
//! `MAX_ATTEMPTS` ceiling are reproduced exactly so behaviour matches Electron.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::CloudService;

/// Give up after this many attempts and mark the entry `failed` (`MAX_ATTEMPTS`
/// in `upload-queue.ts`).
pub const MAX_ATTEMPTS: u32 = 10;

/// Per-attempt backoff after a retryable failure, indexed by `attempts - 1` and
/// clamped to the last step. Identical to the Electron `BACKOFF_STEPS_MS`:
/// 1 min → 5 → 10 → 30 → 1 h → 2 → 4 → 8 → 12 → 24 h.
pub const BACKOFF_STEPS_MS: [i64; 10] = [
    60_000,
    5 * 60_000,
    10 * 60_000,
    30 * 60_000,
    60 * 60_000,
    2 * 60 * 60_000,
    4 * 60 * 60_000,
    8 * 60 * 60_000,
    12 * 60 * 60_000,
    24 * 60 * 60_000,
];

/// Where a queue entry is in its lifecycle. Serialised kebab-case to match the
/// Electron union `'pending' | 'uploading' | 'failed' | 'reauth-required'`
/// (`types/index.ts:538`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/UploadStatus.ts")]
#[serde(rename_all = "kebab-case")]
pub enum UploadStatus {
    /// Waiting for its `next_attempt` time to pass.
    Pending,
    /// Currently being uploaded.
    Uploading,
    /// Permanently failed (file missing, not connected, or out of attempts).
    Failed,
    /// The token was revoked — paused until the user reconnects.
    ReauthRequired,
}

/// One file queued for cloud upload. Mirrors the Electron `CloudUploadQueueEntry`
/// field-for-field (camelCase on the wire via the struct-level rename) so the
/// renderer and any persisted rows carry across unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/QueueEntry.ts")]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub id: String,
    pub service: CloudService,
    pub file_path: String,
    /// History-entry timestamp to mark uploaded on success (`entryTimestamp`).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub entry_timestamp: Option<i64>,
    pub attempts: u32,
    /// Unix ms — earliest time the worker may try this entry.
    #[ts(type = "number")]
    pub next_attempt: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[ts(type = "number")]
    pub enqueued_at: i64,
    pub status: UploadStatus,
}

/// Why an upload attempt failed, as classified by the shell from the HTTP/token
/// result. Drives the [`on_failure`] transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// Refresh token revoked (`invalid_grant`) or an explicit `needs_reauth` —
    /// pause the entry as `reauth-required`, don't burn attempts.
    NeedsReauth,
    /// A normal upload failure — retry with backoff until `MAX_ATTEMPTS`.
    Retryable,
}

/// A compact, UI-facing view of one entry (`getQueueStatus` maps to this:
/// filename only, no full path). `filename` is the basename of `file_path`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/QueueEntryView.ts")]
#[serde(rename_all = "camelCase")]
pub struct QueueEntryView {
    pub id: String,
    pub service: CloudService,
    pub filename: String,
    pub attempts: u32,
    #[ts(type = "number")]
    pub next_attempt: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub status: UploadStatus,
}

/// Add a file to the queue, deduplicating by `(service, file_path)`. A matching
/// entry is reset to `pending` for an immediate retry (mirrors `enqueueUpload`).
/// Returns the id of the affected entry. `id` is supplied by the shell (it owns
/// randomness — Electron used `crypto.randomBytes`).
pub fn enqueue(
    entries: &mut Vec<QueueEntry>,
    id: String,
    service: CloudService,
    file_path: String,
    entry_timestamp: Option<i64>,
    now_ms: i64,
) -> String {
    if let Some(existing) = entries
        .iter_mut()
        .find(|e| e.service == service && e.file_path == file_path)
    {
        existing.status = UploadStatus::Pending;
        existing.next_attempt = now_ms;
        existing.last_error = None;
        return existing.id.clone();
    }
    entries.push(QueueEntry {
        id: id.clone(),
        service,
        file_path,
        entry_timestamp,
        attempts: 0,
        next_attempt: now_ms,
        last_error: None,
        enqueued_at: now_ms,
        status: UploadStatus::Pending,
    });
    id
}

/// Pick the id of the next entry to run: the `pending` entry whose
/// `next_attempt` has passed, earliest first. Mirrors the `filter + sort` in
/// `processQueue`. `None` if nothing is runnable right now.
pub fn select_next(entries: &[QueueEntry], now_ms: i64) -> Option<String> {
    entries
        .iter()
        .filter(|e| e.status == UploadStatus::Pending && e.next_attempt <= now_ms)
        .min_by_key(|e| e.next_attempt)
        .map(|e| e.id.clone())
}

/// Reset any entry left in `Uploading` back to `Pending`, returning how many were
/// reset. An entry only reaches `Uploading` while the worker is actively pushing
/// it; if the app crashed or was force-quit mid-upload it stays `Uploading` in the
/// DB forever, and [`select_next`] (which only picks `Pending`) would NEVER retry
/// it — that backup is silently lost. Call this ONCE at worker startup: at boot
/// any `Uploading` is stale by definition, so it's safe to requeue. (Resumable
/// sessions aren't persisted, so the retry restarts the upload from scratch.)
pub fn reset_stale_uploading(entries: &mut [QueueEntry]) -> usize {
    let mut reset = 0;
    for e in entries.iter_mut() {
        if e.status == UploadStatus::Uploading {
            e.status = UploadStatus::Pending;
            reset += 1;
        }
    }
    reset
}

/// Transition an entry to `uploading` and increment its attempt count, as
/// `processQueue` does just before calling `uploadFile`. No-op if the id is
/// unknown.
pub fn mark_uploading(entries: &mut [QueueEntry], id: &str) {
    if let Some(e) = entries.iter_mut().find(|e| e.id == id) {
        e.status = UploadStatus::Uploading;
        e.attempts += 1;
    }
}

/// On a successful upload, remove the entry from the queue (Electron drops it).
/// Returns `true` if an entry was removed.
pub fn on_success(entries: &mut Vec<QueueEntry>, id: &str) -> bool {
    let before = entries.len();
    entries.retain(|e| e.id != id);
    entries.len() != before
}

/// Apply a failed attempt's outcome. Mirrors the `catch` block in `processQueue`:
///   - `NeedsReauth` → status `reauth-required` (no backoff, attempts kept),
///   - else if `attempts >= MAX_ATTEMPTS` → status `failed`,
///   - else → status `pending`, `next_attempt = now + BACKOFF_STEPS_MS[attempts-1]`.
///
/// `error` is stored on the entry for the UI. No-op if the id is unknown.
/// (Attempts are incremented in [`mark_uploading`] before the attempt, so by the
/// time we get here `attempts` already counts this try — same as Electron.)
pub fn on_failure(
    entries: &mut [QueueEntry],
    id: &str,
    kind: FailureKind,
    error: impl Into<String>,
    now_ms: i64,
) {
    if let Some(e) = entries.iter_mut().find(|e| e.id == id) {
        e.last_error = Some(error.into());
        match kind {
            FailureKind::NeedsReauth => e.status = UploadStatus::ReauthRequired,
            FailureKind::Retryable if e.attempts >= MAX_ATTEMPTS => e.status = UploadStatus::Failed,
            FailureKind::Retryable => {
                e.status = UploadStatus::Pending;
                let idx = (e.attempts.saturating_sub(1) as usize).min(BACKOFF_STEPS_MS.len() - 1);
                e.next_attempt = now_ms + BACKOFF_STEPS_MS[idx];
            }
        }
    }
}

/// Mark an entry permanently failed with a fixed reason — used by the shell for
/// the pre-attempt guards (`file_not_found`, `not_connected`) that `processQueue`
/// sets without burning a network attempt. No-op if the id is unknown.
pub fn mark_failed(entries: &mut [QueueEntry], id: &str, reason: impl Into<String>) {
    if let Some(e) = entries.iter_mut().find(|e| e.id == id) {
        e.status = UploadStatus::Failed;
        e.last_error = Some(reason.into());
    }
}

/// Delay (ms from `now`) until the next pending entry is due, for the shell's
/// wake-up timer. Mirrors `scheduleNextWakeup`: floor 5 s so we don't spin,
/// ceiling 1 h so connectivity is rechecked periodically. `None` when nothing
/// is pending (cancel the timer).
pub fn next_wakeup_delay_ms(entries: &[QueueEntry], now_ms: i64) -> Option<i64> {
    let soonest = entries
        .iter()
        .filter(|e| e.status == UploadStatus::Pending)
        .map(|e| e.next_attempt)
        .min()?;
    let delay = (soonest - now_ms).max(5_000);
    Some(delay.min(60 * 60_000))
}

/// Project the queue into the compact UI view (`getQueueStatus`). `basename`
/// derives the filename from a path with either separator (the shell uses
/// `path.basename`; we keep it pure and OS-agnostic here).
pub fn status_view(entries: &[QueueEntry]) -> Vec<QueueEntryView> {
    entries
        .iter()
        .map(|e| QueueEntryView {
            id: e.id.clone(),
            service: e.service,
            filename: basename(&e.file_path),
            attempts: e.attempts,
            next_attempt: e.next_attempt,
            last_error: e.last_error.clone(),
            status: e.status,
        })
        .collect()
}

/// Basename helper that handles both `/` and `\\` separators (recordings can be
/// queued on either platform). Returns the whole string if there is no separator.
fn basename(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drive_entry(id: &str, path: &str) -> QueueEntry {
        QueueEntry {
            id: id.into(),
            service: CloudService::GoogleDrive,
            file_path: path.into(),
            entry_timestamp: None,
            attempts: 0,
            next_attempt: 0,
            last_error: None,
            enqueued_at: 0,
            status: UploadStatus::Pending,
        }
    }

    #[test]
    fn enqueue_appends_new_entry() {
        let mut q = vec![];
        let id = enqueue(
            &mut q,
            "a".into(),
            CloudService::GoogleDrive,
            "/x.wav".into(),
            Some(7),
            100,
        );
        assert_eq!(id, "a");
        assert_eq!(q.len(), 1);
        assert_eq!(q[0].next_attempt, 100);
        assert_eq!(q[0].entry_timestamp, Some(7));
        assert_eq!(q[0].status, UploadStatus::Pending);
    }

    #[test]
    fn enqueue_dedupes_and_resets_for_immediate_retry() {
        let mut q = vec![QueueEntry {
            status: UploadStatus::Failed,
            attempts: 4,
            last_error: Some("boom".into()),
            next_attempt: 999_999,
            ..drive_entry("orig", "/x.wav")
        }];
        let id = enqueue(
            &mut q,
            "new".into(),
            CloudService::GoogleDrive,
            "/x.wav".into(),
            None,
            500,
        );
        assert_eq!(id, "orig"); // kept the existing entry's id
        assert_eq!(q.len(), 1);
        assert_eq!(q[0].status, UploadStatus::Pending);
        assert_eq!(q[0].next_attempt, 500);
        assert_eq!(q[0].last_error, None);
        assert_eq!(q[0].attempts, 4); // attempts are NOT reset (matches Electron)
    }

    #[test]
    fn enqueue_same_path_different_service_is_distinct() {
        let mut q = vec![];
        enqueue(
            &mut q,
            "a".into(),
            CloudService::GoogleDrive,
            "/x.wav".into(),
            None,
            0,
        );
        enqueue(
            &mut q,
            "b".into(),
            CloudService::Youtube,
            "/x.wav".into(),
            None,
            0,
        );
        assert_eq!(q.len(), 2);
    }

    #[test]
    fn select_next_picks_earliest_due_pending() {
        let q = vec![
            QueueEntry {
                next_attempt: 300,
                ..drive_entry("late", "/c")
            },
            QueueEntry {
                next_attempt: 100,
                ..drive_entry("early", "/a")
            },
            QueueEntry {
                next_attempt: 200,
                status: UploadStatus::Uploading,
                ..drive_entry("busy", "/b")
            },
        ];
        assert_eq!(select_next(&q, 1000).as_deref(), Some("early"));
        // Nothing due yet.
        assert_eq!(select_next(&q, 50), None);
        // Only the late one is due.
        assert_eq!(select_next(&q, 150).as_deref(), Some("early"));
    }

    #[test]
    fn mark_uploading_increments_attempts() {
        let mut q = vec![drive_entry("a", "/x")];
        mark_uploading(&mut q, "a");
        assert_eq!(q[0].status, UploadStatus::Uploading);
        assert_eq!(q[0].attempts, 1);
    }

    #[test]
    fn reset_stale_uploading_requeues_only_uploading() {
        let mut q = vec![
            QueueEntry {
                status: UploadStatus::Uploading,
                ..drive_entry("stuck", "/a")
            },
            QueueEntry {
                status: UploadStatus::Pending,
                ..drive_entry("pend", "/b")
            },
            QueueEntry {
                status: UploadStatus::Failed,
                ..drive_entry("dead", "/c")
            },
        ];
        // A stuck `Uploading` is invisible to select_next until reset.
        assert_eq!(select_next(&q, 1_000_000), Some("pend".to_string()));
        let n = reset_stale_uploading(&mut q);
        assert_eq!(n, 1);
        assert_eq!(q[0].status, UploadStatus::Pending); // requeued
        assert_eq!(q[1].status, UploadStatus::Pending); // untouched
        assert_eq!(q[2].status, UploadStatus::Failed); // untouched
    }

    #[test]
    fn on_success_removes_entry() {
        let mut q = vec![drive_entry("a", "/x"), drive_entry("b", "/y")];
        assert!(on_success(&mut q, "a"));
        assert_eq!(q.len(), 1);
        assert_eq!(q[0].id, "b");
        assert!(!on_success(&mut q, "missing"));
    }

    #[test]
    fn retryable_failure_uses_backoff_step_for_attempt() {
        let mut q = vec![QueueEntry {
            attempts: 1,
            ..drive_entry("a", "/x")
        }];
        on_failure(&mut q, "a", FailureKind::Retryable, "net", 1000);
        assert_eq!(q[0].status, UploadStatus::Pending);
        assert_eq!(q[0].next_attempt, 1000 + BACKOFF_STEPS_MS[0]); // attempts-1 = 0 → 1 min
        assert_eq!(q[0].last_error.as_deref(), Some("net"));

        let mut q3 = vec![QueueEntry {
            attempts: 3,
            ..drive_entry("a", "/x")
        }];
        on_failure(&mut q3, "a", FailureKind::Retryable, "net", 0);
        assert_eq!(q3[0].next_attempt, BACKOFF_STEPS_MS[2]); // 10 min
    }

    #[test]
    fn backoff_uses_highest_reachable_step_just_below_max() {
        // attempts=9 is the largest count that still retries (MAX_ATTEMPTS=10);
        // it maps to BACKOFF_STEPS_MS[8] (12 h). The last step, index 9 (24 h),
        // is defensive: any attempt count high enough to reach it via the
        // `min(attempts-1, len-1)` clamp is already `failed`. Same dead-but-safe
        // clamp as the Electron `Math.min(...)`.
        let mut q = vec![QueueEntry {
            attempts: 9,
            ..drive_entry("a", "/x")
        }];
        on_failure(&mut q, "a", FailureKind::Retryable, "net", 0);
        assert_eq!(q[0].status, UploadStatus::Pending);
        assert_eq!(q[0].next_attempt, BACKOFF_STEPS_MS[8]);
    }

    #[test]
    fn max_attempts_marks_failed() {
        let mut q = vec![QueueEntry {
            attempts: MAX_ATTEMPTS,
            ..drive_entry("a", "/x")
        }];
        on_failure(&mut q, "a", FailureKind::Retryable, "net", 0);
        assert_eq!(q[0].status, UploadStatus::Failed);
    }

    #[test]
    fn needs_reauth_pauses_without_backoff() {
        let mut q = vec![QueueEntry {
            attempts: 2,
            next_attempt: 42,
            ..drive_entry("a", "/x")
        }];
        on_failure(&mut q, "a", FailureKind::NeedsReauth, "invalid_grant", 9999);
        assert_eq!(q[0].status, UploadStatus::ReauthRequired);
        assert_eq!(q[0].next_attempt, 42); // unchanged
    }

    #[test]
    fn next_wakeup_floor_and_ceiling() {
        // Due in the past → floored to 5 s.
        let q = vec![QueueEntry {
            next_attempt: 0,
            ..drive_entry("a", "/x")
        }];
        assert_eq!(next_wakeup_delay_ms(&q, 10_000), Some(5_000));
        // Far future → capped to 1 h.
        let q2 = vec![QueueEntry {
            next_attempt: 100 * 60 * 60_000,
            ..drive_entry("a", "/x")
        }];
        assert_eq!(next_wakeup_delay_ms(&q2, 0), Some(60 * 60_000));
        // Nothing pending → None.
        let q3 = vec![QueueEntry {
            status: UploadStatus::Failed,
            ..drive_entry("a", "/x")
        }];
        assert_eq!(next_wakeup_delay_ms(&q3, 0), None);
    }

    #[test]
    fn status_view_uses_basename_both_separators() {
        let q = vec![
            QueueEntry {
                last_error: Some("e".into()),
                ..drive_entry("a", "/Users/r/rec/sermon.wav")
            },
            drive_entry("b", r"C:\Users\r\rec\service.mp4"),
        ];
        let v = status_view(&q);
        assert_eq!(v[0].filename, "sermon.wav");
        assert_eq!(v[0].last_error.as_deref(), Some("e"));
        assert_eq!(v[1].filename, "service.mp4");
    }
}
