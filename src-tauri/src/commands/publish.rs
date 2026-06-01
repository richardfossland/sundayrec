//! Podcast-publish commands (PU-3 P2b) — the thin IPC layer over `crate::publish`
//! + the unit-tested `sundayrec_core::feed`.
//!
//! `publish_feed_status` reports whether this build can WRITE/UPLOAD the feed
//! (the default-off `publish` cargo feature) plus how many recordings would be
//! candidates, so the renderer can render the panel WITHOUT provoking a failed
//! write. `publish_feed_preview` builds the feed XML in memory from the recording
//! history + the channel metadata resolved from settings — this is the pure
//! [`sundayrec_core::feed`] shaping and works in EVERY build, so the UI can show
//! a live preview of the feed even where publishing isn't compiled in.
//!
//! `publish_generate_feed` is the impure write: it writes `podcast.xml` next to
//! the save folder (and, once the Drive glue lands, uploads + shares it). It is
//! behind the **default-off `publish`** feature; in the default build it returns
//! a clear `feature_disabled` error so the panel shows a calm "not built into this
//! build" hint. NETWORK-UNVERIFIED behind `--features publish`.
//!
//! ## ⚠️ Schema gap (mirrors the module header)
//!
//! The per-recording public-share URLs the real feed needs are not yet persisted
//! (the `recording` table has no `cloudUrls` column). For the preview we use each
//! recording's local `file_path` as a placeholder `audio_url` so the operator can
//! see the feed's shape; the published feed (`publish_generate_feed`) only emits
//! rows that have a real share URL once that column lands. See docs/NEEDS-RICHARD.md.

use serde::{Deserialize, Serialize};
use tauri::State;
use ts_rs::TS;

use sundayrec_core::feed::{build_podcast_xml, PodcastChannel, PodcastEpisode};

use crate::db::store::{self, RecordingRow};
use crate::db::Db;
use crate::error::AppResult;

/// Whether this build can write/upload the feed, plus the candidate episode count
/// (every recording in history — the placeholder preview keeps them all). Works in
/// every build: `feature_built` reflects the compile-time `publish` feature.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/PublishStatus.ts")]
#[serde(rename_all = "camelCase")]
pub struct PublishStatus {
    /// True when this build was compiled with `--features publish` (can write/upload).
    pub feature_built: bool,
    /// How many recordings would appear in the feed (all of history, newest-first).
    pub episode_count: usize,
}

/// The result of a feed preview/generate: the rendered XML (preview) or the
/// written path (generate), plus the episode count.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/FeedPreview.ts")]
#[serde(rename_all = "camelCase")]
pub struct FeedPreview {
    /// The rendered feed XML.
    pub xml: String,
    /// How many episodes the feed contains.
    pub episode_count: usize,
    /// Where the feed was written on disk, if `publish_generate_feed` wrote it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    /// The public feed URL once uploaded + shared (None until the Drive glue lands).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feed_url: Option<String>,
}

/// Resolve the channel metadata from settings, mirroring the Electron `podcast`
/// settings object's fields + defaults (`regeneratePodcastFeed`). A missing/blank
/// setting falls back to the same defaults the renderer showed.
async fn resolve_channel(db: &Db) -> AppResult<PodcastChannel> {
    let read = |v: Option<String>| v.filter(|s| !s.trim().is_empty());
    let get = |key: &'static str| {
        let pool = db.pool.clone();
        async move { store::get_setting(&pool, key).await }
    };

    let title = read(get("podcastTitle").await?).unwrap_or_else(|| "SundayRec".into());
    let description =
        read(get("podcastDescription").await?).unwrap_or_else(|| "Lydopptak fra SundayRec".into());
    let author = read(get("podcastAuthor").await?).unwrap_or_else(|| title.clone());
    let language = read(get("podcastLanguage").await?).unwrap_or_else(|| "no".into());
    let category =
        read(get("podcastCategory").await?).unwrap_or_else(|| "Religion & Spirituality".into());
    // `explicit` is a JSON bool stored as a string; anything but "true" is false.
    let explicit = get("podcastExplicit")
        .await?
        .map(|v| v.trim() == "true")
        .unwrap_or(false);

    Ok(PodcastChannel {
        title,
        description,
        link: read(get("podcastLink").await?),
        author,
        language,
        image_url: read(get("podcastImageUrl").await?),
        category,
        explicit,
        email: read(get("podcastEmail").await?),
        feed_url: read(get("podcastFeedUrl").await?),
    })
}

/// Map history rows into preview episodes, newest-first, using each recording's
/// local `file_path` as a placeholder `audio_url` (the real share URLs aren't
/// persisted yet — see the module header). The title strips the file extension,
/// as Electron did.
fn preview_episodes(rows: &[RecordingRow]) -> Vec<PodcastEpisode> {
    use chrono::{TimeZone, Utc};
    use std::path::Path;

    let mut eps: Vec<(f64, PodcastEpisode)> = rows
        .iter()
        .filter_map(|r| {
            let pub_date = Utc
                .timestamp_millis_opt(r.started_at as i64)
                .single()?
                .naive_utc();
            let title = Path::new(&r.file_path)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            Some((
                r.started_at,
                PodcastEpisode {
                    title,
                    description: r.note.clone().filter(|n| !n.is_empty()),
                    pub_date,
                    guid: format!("sundayrec-{}", r.started_at as i64),
                    audio_url: r.file_path.clone(),
                    audio_bytes: r.byte_size.unwrap_or(0).max(0),
                    mime_type: None,
                    duration_sec: r.duration_ms.map(|ms| (ms / 1000.0).round() as u32),
                },
            ))
        })
        .collect();
    eps.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    eps.into_iter().map(|(_, e)| e).collect()
}

/// Whether this build can write/upload the feed + the candidate episode count.
#[tauri::command]
pub async fn publish_feed_status(db: State<'_, Db>) -> AppResult<PublishStatus> {
    let rows = store::list_recordings(&db.pool).await?;
    Ok(PublishStatus {
        feature_built: cfg!(feature = "publish"),
        episode_count: rows.len(),
    })
}

/// Build the feed XML in memory from the recording history + the channel metadata
/// resolved from settings, returning the rendered XML for preview. Pure shaping —
/// works in every build (no disk write, no upload). `audio_url` is the local file
/// path placeholder until share URLs are persisted (see the module header).
#[tauri::command]
pub async fn publish_feed_preview(db: State<'_, Db>) -> AppResult<FeedPreview> {
    use chrono::Utc;

    let channel = resolve_channel(&db).await?;
    let rows = store::list_recordings(&db.pool).await?;
    let episodes = preview_episodes(&rows);
    let xml = build_podcast_xml(&channel, &episodes, Utc::now().naive_utc());
    Ok(FeedPreview {
        xml,
        episode_count: episodes.len(),
        local_path: None,
        feed_url: None,
    })
}

/// Write the feed to `<save_folder>/podcast.xml` (and, once the Drive glue lands,
/// upload + share it), returning the written path. Behind the **default-off
/// `publish`** feature; the default build returns `feature_disabled` so the panel
/// shows a calm "not built into this build" hint. NETWORK-UNVERIFIED.
#[tauri::command]
#[cfg_attr(not(feature = "publish"), allow(unused_variables))]
pub async fn publish_generate_feed(db: State<'_, Db>) -> AppResult<FeedPreview> {
    #[cfg(not(feature = "publish"))]
    {
        Err(crate::error::AppError::Validation(
            "feature_disabled: podcast publishing requires a build with `--features publish`"
                .into(),
        ))
    }

    #[cfg(feature = "publish")]
    {
        use crate::error::AppError;
        use std::path::Path;

        // The local save folder the recorder writes into (mirrors the recorder's
        // `saveFolder` setting). The feed is written alongside it.
        let save_folder = store::get_setting(&db.pool, "saveFolder")
            .await?
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| AppError::Validation("no_config: save folder not set".into()))?;

        let channel = resolve_channel(&db).await?;
        let rows = store::list_recordings(&db.pool).await?;
        let episodes = preview_episodes(&rows);
        // NETWORK-UNVERIFIED: the Drive upload + share-URL creation land once a
        // recording→share-URL column exists; for now we write the feed locally and
        // report the path (mirrors `crate::publish::publish_feed`'s local half).
        let path = crate::publish::write_feed(Path::new(&save_folder), &channel, &episodes)?;
        let xml = std::fs::read_to_string(&path)?;
        Ok(FeedPreview {
            xml,
            episode_count: episodes.len(),
            local_path: Some(path.to_string_lossy().into_owned()),
            feed_url: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, path: &str, started: f64, bytes: Option<i64>) -> RecordingRow {
        RecordingRow {
            id: id.into(),
            file_path: path.into(),
            device_name: None,
            started_at: started,
            duration_ms: Some(120_000.0),
            byte_size: bytes,
            created_at: started,
            note: Some("Høymesse".into()),
        }
    }

    #[test]
    fn preview_episodes_newest_first_with_placeholder_url() {
        let rows = vec![
            row("a", "/rec/old.mp3", 1_000.0, Some(100)),
            row("b", "/rec/new.mp3", 5_000.0, Some(200)),
        ];
        let eps = preview_episodes(&rows);
        assert_eq!(eps.len(), 2);
        // Newest (b) first; placeholder audio_url is the local file path.
        assert_eq!(eps[0].title, "new");
        assert_eq!(eps[0].audio_url, "/rec/new.mp3");
        assert_eq!(eps[0].guid, "sundayrec-5000");
        assert_eq!(eps[0].duration_sec, Some(120));
        assert_eq!(eps[1].title, "old");
    }

    #[test]
    fn preview_episodes_drops_empty_note_description() {
        let mut r = row("a", "/rec/a.mp3", 1.0, Some(1));
        r.note = Some(String::new());
        let eps = preview_episodes(&[r]);
        assert_eq!(eps[0].description, None);
    }
}
