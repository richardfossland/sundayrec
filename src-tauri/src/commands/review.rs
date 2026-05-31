//! Episode-prep + review-queue + Stage-import commands (PU-6 P2b) — **INFRA-UNVERIFIED**.
//!
//! The thin IPC layer over the unit-tested `sundayrec_core::{prep, review_queue,
//! integrations::stage}`. The review queue is persisted exactly as the Electron
//! app did — a JSON blob under the `reviewQueue` settings key (no new migration,
//! so this never touches the recording schema). The shell owns the clock + uuid
//! + the JSON (de)serialisation; the decisions are the core's.
//!
//! ## ⚠️ INFRA-UNVERIFIED
//!
//! - [`prep_build_episode`] takes the analysis segments as input rather than
//!   running audio-analysis itself — the ffmpeg/FFT analysis (`audio-analysis.ts`)
//!   is NOT ported yet, so the caller (or a later analysis seam) supplies the
//!   segments. The assembly + status decision ARE the unit-tested core.
//! - [`review_process_reminders`] returns the actions the scheduler should fire;
//!   the actual notify/email/webhook dispatch is left to the existing seams
//!   (PU-1 email, scheduler notifications) and is not wired through here yet.
//!   See docs/NEEDS-RICHARD.md (PU-6).

use tauri::State;

use sundayrec_core::integrations::stage::{self, StageManifest};
use sundayrec_core::integrations::{ChapterMarker, ServiceLink};
use sundayrec_core::prep::{self, EpisodePrep, PrepAnalysisSegment, PrepDefaults};
use sundayrec_core::review_queue::{self, ReminderAction, ReviewQueueEntry};

use crate::db::store::{self, new_id, now_ms};
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// The settings key the review queue is persisted under (mirrors Electron's
/// `electron-store` `reviewQueue` key).
const REVIEW_QUEUE_KEY: &str = "reviewQueue";

fn now_i64() -> i64 {
    now_ms() as i64
}

// ── Review-queue persistence (JSON blob under a settings key) ───────────────

async fn load_queue(db: &Db) -> AppResult<Vec<ReviewQueueEntry>> {
    match store::get_setting(&db.pool, REVIEW_QUEUE_KEY).await? {
        Some(json) if !json.is_empty() => Ok(serde_json::from_str(&json).unwrap_or_default()),
        _ => Ok(Vec::new()),
    }
}

async fn save_queue(db: &Db, entries: &[ReviewQueueEntry]) -> AppResult<()> {
    // Strip the derived age before persisting (mirrors `writeRaw`).
    let sanitised: Vec<ReviewQueueEntry> = entries
        .iter()
        .cloned()
        .map(|mut e| {
            e.age_in_days = 0.0;
            e
        })
        .collect();
    let json = serde_json::to_string(&sanitised)?;
    store::set_setting(&db.pool, REVIEW_QUEUE_KEY, &json).await
}

// ── Episode prep ────────────────────────────────────────────────────────────

/// Resolve the podcast defaults from settings (master preset + intro/outro). A
/// missing/blank setting falls back to the Electron defaults via [`PrepDefaults`].
async fn prep_defaults(db: &Db) -> AppResult<PrepDefaults> {
    let read = |v: Option<String>| v.filter(|s| !s.trim().is_empty());
    let master = read(store::get_setting(&db.pool, "podcastDefaultMasterPreset").await?)
        .unwrap_or_else(|| "speech-clear".into());
    let intro = read(store::get_setting(&db.pool, "podcastDefaultIntroPath").await?);
    let outro = read(store::get_setting(&db.pool, "podcastDefaultOutroPath").await?);
    Ok(PrepDefaults {
        master_preset: master,
        intro_path: intro,
        outro_path: outro,
    })
}

/// Build an [`EpisodePrep`] from already-computed analysis segments + the
/// resolved defaults, and add it to the review queue. INFRA-UNVERIFIED: the
/// analysis itself isn't ported; the caller supplies `segments`.
#[tauri::command]
pub async fn prep_build_episode(
    db: State<'_, Db>,
    recording_path: String,
    segments: Vec<PrepAnalysisSegment>,
) -> AppResult<EpisodePrep> {
    let defaults = prep_defaults(&db).await?;
    let now = now_i64();
    let episode = prep::build_episode_prep(new_id(), recording_path, segments, &defaults, now);

    let queue = load_queue(&db).await?;
    let queue = review_queue::enqueue(queue, episode.clone(), now);
    save_queue(&db, &queue).await?;
    Ok(episode)
}

// ── Review queue ──────────────────────────────────────────────────────────

/// The review queue, newest-first, with `ageInDays` filled in.
#[tauri::command]
pub async fn review_queue_list(db: State<'_, Db>) -> AppResult<Vec<ReviewQueueEntry>> {
    let queue = load_queue(&db).await?;
    Ok(review_queue::read_with_age(&queue, now_i64()))
}

/// Mark a queued prep published (kept briefly for the UI toast).
#[tauri::command]
pub async fn review_mark_published(db: State<'_, Db>, id: String) -> AppResult<bool> {
    let mut queue = load_queue(&db).await?;
    let ok = review_queue::mark_published(&mut queue, &id, now_i64());
    if ok {
        save_queue(&db, &queue).await?;
    }
    Ok(ok)
}

/// Mark a queued prep discarded ("ikke publiser denne uka").
#[tauri::command]
pub async fn review_mark_discarded(db: State<'_, Db>, id: String) -> AppResult<bool> {
    let mut queue = load_queue(&db).await?;
    let ok = review_queue::mark_discarded(&mut queue, &id, now_i64());
    if ok {
        save_queue(&db, &queue).await?;
    }
    Ok(ok)
}

/// Run the reminder timeline over the queue and persist the result, returning
/// the reminder actions the scheduler should fire. INFRA-UNVERIFIED: dispatching
/// each action (notify/email/webhook) is left to the existing seams.
#[tauri::command]
pub async fn review_process_reminders(db: State<'_, Db>) -> AppResult<Vec<ReminderActionDto>> {
    let queue = load_queue(&db).await?;
    let outcome = review_queue::process_reminders(&queue, now_i64());
    if outcome.changed {
        save_queue(&db, &outcome.survivors).await?;
    }
    Ok(outcome.actions.into_iter().map(Into::into).collect())
}

/// A reminder action flattened for the IPC boundary (the core enums don't derive
/// `Serialize`; this is the wire shape).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderActionDto {
    pub id: String,
    /// `notify` | `notify_email` | `notify_email_webhook` |
    /// `notify_email_webhook_warning` | `auto_discard`.
    pub channel: &'static str,
    /// `day1` | `day2` | `day7` | `discard`.
    pub message: &'static str,
}

impl From<ReminderAction> for ReminderActionDto {
    fn from(a: ReminderAction) -> Self {
        use review_queue::{ReminderChannel as C, ReminderMessage as M};
        ReminderActionDto {
            id: a.id,
            channel: match a.channel {
                C::Notify => "notify",
                C::NotifyEmail => "notify_email",
                C::NotifyEmailWebhook => "notify_email_webhook",
                C::NotifyEmailWebhookWarning => "notify_email_webhook_warning",
                C::AutoDiscard => "auto_discard",
            },
            message: match a.message {
                M::Day1 => "day1",
                M::Day2 => "day2",
                M::Day7 => "day7",
                M::Discard => "discard",
            },
        }
    }
}

// ── Stage manifest import ────────────────────────────────────────────────────

/// The result of applying a Stage manifest to a recording.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageApplyResult {
    pub chapters: Vec<ChapterMarker>,
    pub service_link: ServiceLink,
}

/// Parse a SundayStage `service-manifest.json` and map it to chapter markers +
/// a service link, aligned to the recording's start. The fs writes
/// (`.meta.json` chapters + `.service.json` link) are left to the shell's
/// sidecar writer; this returns the mapped data. INFRA-UNVERIFIED.
#[tauri::command]
pub async fn stage_import_manifest(
    manifest_json: String,
    recording_start_ms: i64,
    duration_sec: Option<i64>,
    was_streamed: Option<bool>,
    service_date: Option<String>,
) -> AppResult<StageApplyResult> {
    let manifest: StageManifest = stage::parse_stage_manifest(&manifest_json)
        .ok_or_else(|| AppError::Validation("invalid_manifest".into()))?;
    let chapters = stage::manifest_to_chapters(&manifest, recording_start_ms, duration_sec);
    let service_link = stage::build_service_link(
        &manifest,
        recording_start_ms,
        was_streamed,
        service_date,
        now_i64(),
    );
    Ok(StageApplyResult {
        chapters,
        service_link,
    })
}

#[cfg(test)]
mod tests {
    //! Review-queue persistence over a temp sqlite store. The Tauri commands take
    //! `State<Db>` (not constructible in a unit test), so these exercise the same
    //! load/save seam the commands call, plus the core transitions they thread,
    //! against a real (throwaway) database — no app, no clock prompts.
    use super::*;
    use sundayrec_core::prep::{build_episode_prep, EpisodePrepStatus, PrepDefaults};

    /// A migrated temp-dir database wrapped in a [`Db`] handle.
    async fn temp_db() -> (Db, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = store::open_pool(&dir.path().join("test.sqlite"))
            .await
            .expect("open_pool");
        (Db::new(pool), dir)
    }

    /// A ready-status episode prep with the given id/path, built through the core
    /// so the fixture matches what `prep_build_episode` produces.
    fn prep(id: &str, path: &str, now: i64) -> EpisodePrep {
        build_episode_prep(
            id.to_string(),
            path.to_string(),
            Vec::new(),
            &PrepDefaults::default(),
            now,
        )
    }

    #[tokio::test]
    async fn load_queue_is_empty_on_a_fresh_store() {
        let (db, _d) = temp_db().await;
        assert!(load_queue(&db).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn save_then_load_round_trips_an_entry() {
        let (db, _d) = temp_db().await;
        let entry = review_queue::ReviewQueueEntry {
            id: "rec-1".into(),
            prep: prep("rec-1", "/rec/a.m4a", 1_000),
            added_at: 1_000,
            reminded: 0,
            age_in_days: 0.0,
        };
        save_queue(&db, std::slice::from_ref(&entry)).await.unwrap();

        let back = load_queue(&db).await.unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].id, "rec-1");
        assert_eq!(back[0].prep.recording_path, "/rec/a.m4a");
    }

    #[tokio::test]
    async fn save_queue_strips_the_derived_age_before_persisting() {
        let (db, _d) = temp_db().await;
        let entry = review_queue::ReviewQueueEntry {
            id: "rec-1".into(),
            prep: prep("rec-1", "/rec/a.m4a", 1_000),
            added_at: 1_000,
            reminded: 0,
            // A non-zero derived age must NOT survive the write (mirrors writeRaw).
            age_in_days: 9.5,
        };
        save_queue(&db, std::slice::from_ref(&entry)).await.unwrap();
        assert_eq!(load_queue(&db).await.unwrap()[0].age_in_days, 0.0);
    }

    #[tokio::test]
    async fn enqueue_persists_and_dedupes_by_id() {
        let (db, _d) = temp_db().await;
        let q = load_queue(&db).await.unwrap();
        let q = review_queue::enqueue(q, prep("rec-1", "/rec/a.m4a", 1_000), 1_000);
        save_queue(&db, &q).await.unwrap();

        // Re-enqueue the same id with a new path: replaces, never a second row.
        let q = load_queue(&db).await.unwrap();
        let q = review_queue::enqueue(q, prep("rec-1", "/rec/b.m4a", 2_000), 2_000);
        save_queue(&db, &q).await.unwrap();

        let back = load_queue(&db).await.unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].prep.recording_path, "/rec/b.m4a");
    }

    #[tokio::test]
    async fn read_with_age_sorts_newest_first_and_fills_age() {
        let (db, _d) = temp_db().await;
        let mut q = Vec::new();
        q = review_queue::enqueue(q, prep("old", "/rec/old.m4a", 1_000), 1_000);
        q = review_queue::enqueue(q, prep("new", "/rec/new.m4a", 5_000), 5_000);
        save_queue(&db, &q).await.unwrap();

        // now is two days past the newest entry.
        let now = 5_000 + 2 * 24 * 60 * 60 * 1_000;
        let listed = review_queue::read_with_age(&load_queue(&db).await.unwrap(), now);
        assert_eq!(listed[0].id, "new", "newest first");
        assert_eq!(listed[1].id, "old");
        assert!((listed[0].age_in_days - 2.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn mark_published_persists_the_status_transition() {
        let (db, _d) = temp_db().await;
        let q = review_queue::enqueue(Vec::new(), prep("rec-1", "/rec/a.m4a", 1_000), 1_000);
        save_queue(&db, &q).await.unwrap();

        let mut loaded = load_queue(&db).await.unwrap();
        assert!(review_queue::mark_published(&mut loaded, "rec-1", 2_000));
        save_queue(&db, &loaded).await.unwrap();

        let back = load_queue(&db).await.unwrap();
        assert_eq!(back[0].prep.status, EpisodePrepStatus::Published);

        // An unknown id is a no-op (no panic, returns false).
        let mut loaded = load_queue(&db).await.unwrap();
        assert!(!review_queue::mark_published(&mut loaded, "ghost", 3_000));
    }

    #[tokio::test]
    async fn mark_discarded_persists_the_status_transition() {
        let (db, _d) = temp_db().await;
        let q = review_queue::enqueue(Vec::new(), prep("rec-1", "/rec/a.m4a", 1_000), 1_000);
        save_queue(&db, &q).await.unwrap();

        let mut loaded = load_queue(&db).await.unwrap();
        assert!(review_queue::mark_discarded(&mut loaded, "rec-1", 2_000));
        save_queue(&db, &loaded).await.unwrap();

        assert_eq!(
            load_queue(&db).await.unwrap()[0].prep.status,
            EpisodePrepStatus::Discarded
        );
    }

    #[tokio::test]
    async fn load_queue_tolerates_a_corrupt_blob() {
        let (db, _d) = temp_db().await;
        // A non-array / malformed value must degrade to an empty queue, not error
        // (mirrors the `unwrap_or_default` in load_queue).
        store::set_setting(&db.pool, REVIEW_QUEUE_KEY, "not json at all")
            .await
            .unwrap();
        assert!(load_queue(&db).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn reminder_action_dto_maps_every_channel_and_message() {
        use review_queue::{ReminderAction, ReminderChannel as C, ReminderMessage as M};
        let cases = [
            (C::Notify, M::Day1, "notify", "day1"),
            (C::NotifyEmail, M::Day2, "notify_email", "day2"),
            (
                C::NotifyEmailWebhook,
                M::Day7,
                "notify_email_webhook",
                "day7",
            ),
            (
                C::NotifyEmailWebhookWarning,
                M::Day7,
                "notify_email_webhook_warning",
                "day7",
            ),
            (C::AutoDiscard, M::Discard, "auto_discard", "discard"),
        ];
        for (channel, message, want_channel, want_message) in cases {
            let dto: ReminderActionDto = ReminderAction {
                id: "x".into(),
                channel,
                message,
            }
            .into();
            assert_eq!(dto.channel, want_channel);
            assert_eq!(dto.message, want_message);
            assert_eq!(dto.id, "x");
        }
    }
}
