//! Podcast-publish plumbing (PU-3 P2b) — **NETWORK-UNVERIFIED**, default-off `publish` feature.
//!
//! The impure half of podcast publishing. The XML *shaping* is the unit-tested
//! [`sundayrec_core::feed`]; this module performs the side effects the Electron
//! `src/main/publish/index.ts` did:
//!   - turn the recording history (+ a per-recording public-share-URL map) into
//!     [`PodcastEpisode`]s ([`episodes_from_rows`], a pure, tested mapping),
//!   - build the feed XML and write `podcast.xml` next to the save folder
//!     ([`write_feed`]),
//!   - upload it to Drive + make it public ([`publish_feed`] — the
//!     NETWORK-UNVERIFIED part).
//!
//! ## ⚠️ NETWORK-UNVERIFIED / schema gap
//!
//! [`publish_feed`] is wired to compile under `--features publish` but its Drive
//! upload + share-URL creation are unproven on the wire. The per-recording
//! public-share URLs it consumes are not yet persisted — the current `recording`
//! table has no `cloudUrls` column (the Electron history did). Until that lands,
//! the caller supplies the share-URL map explicitly (and `episodes_from_rows`
//! simply skips rows without one). See docs/NEEDS-RICHARD.md (PU-3).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{TimeZone, Utc};

use sundayrec_core::feed::{build_podcast_xml, PodcastChannel, PodcastEpisode};

use crate::db::store::RecordingRow;
use crate::error::AppResult;

/// The local feed filename, matching the Electron `RSS_FILENAME`.
pub const RSS_FILENAME: &str = "podcast.xml";

/// Map recording history rows into podcast episodes, newest-first, keeping only
/// rows that have a public-share URL in `share_urls` (keyed by recording id).
/// Pure + tested — mirrors the `regeneratePodcastFeed` candidate filter +
/// mapping (status 'ok' + has a cloud URL), minus the not-yet-persisted status
/// field. The episode title strips the file extension, as Electron did.
pub fn episodes_from_rows(
    rows: &[RecordingRow],
    share_urls: &HashMap<String, String>,
) -> Vec<PodcastEpisode> {
    let mut eps: Vec<(f64, PodcastEpisode)> = rows
        .iter()
        .filter_map(|r| {
            let url = share_urls.get(&r.id)?;
            // started_at is unix-ms; convert to a UTC civil instant for pubDate.
            let pub_date = Utc
                .timestamp_millis_opt(r.started_at as i64)
                .single()?
                .naive_utc();
            let title = file_stem(&r.file_path);
            Some((
                r.started_at,
                PodcastEpisode {
                    title,
                    description: r.note.clone().filter(|n| !n.is_empty()),
                    pub_date,
                    guid: format!("sundayrec-{}", r.started_at as i64),
                    audio_url: url.clone(),
                    audio_bytes: r.byte_size.unwrap_or(0).max(0),
                    mime_type: None,
                    duration_sec: r.duration_ms.map(|ms| (ms / 1000.0).round() as u32),
                },
            ))
        })
        .collect();
    // Newest first — the standard podcast-app display order.
    eps.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    eps.into_iter().map(|(_, e)| e).collect()
}

/// The file's base name without its extension (e.g. `/x/Opptak.mp4` → `Opptak`).
fn file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Build the feed XML and write it to `<save_folder>/podcast.xml`, returning the
/// path. Uses `Utc::now()` for `lastBuildDate` (the only wall-clock read; the
/// shaping itself is pure). Mirrors the local-write half of `regeneratePodcastFeed`.
pub fn write_feed(
    save_folder: &Path,
    channel: &PodcastChannel,
    episodes: &[PodcastEpisode],
) -> AppResult<PathBuf> {
    let xml = build_podcast_xml(channel, episodes, Utc::now().naive_utc());
    let path = save_folder.join(RSS_FILENAME);
    // Write-to-temp + rename so a crash/disk-full mid-write can never leave a
    // truncated podcast.xml where a working feed used to be.
    let tmp = save_folder.join(format!("{RSS_FILENAME}.tmp"));
    std::fs::write(&tmp, xml)?;
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

/// Build + write the feed, then upload it to Drive and make it public, returning
/// the public feed URL. **NETWORK-UNVERIFIED** — the Drive upload + share-URL
/// creation are wired but unproven on the wire, and the per-recording share URLs
/// are not yet persisted (see the module header + docs/NEEDS-RICHARD.md). The
/// `_access_token` is threaded in (the caller mints it like the cloud worker);
/// the actual Drive calls are deferred to the glue commit.
pub async fn publish_feed(
    save_folder: &Path,
    channel: &PodcastChannel,
    episodes: &[PodcastEpisode],
    _access_token: &str,
) -> AppResult<PublishOutcome> {
    let local_path = write_feed(save_folder, channel, episodes)?;
    // NETWORK-UNVERIFIED: the Drive resumable upload + createPublicShareUrl glue
    // (reusing the cloud worker's upload path) lands once a recording→share-URL
    // column exists to feed it. For now we report the local write so the UI can
    // surface "feed written locally; connect Drive to publish".
    Ok(PublishOutcome {
        local_path,
        feed_url: None,
        episode_count: episodes.len(),
    })
}

/// The result of a publish attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishOutcome {
    /// Where the feed was written on disk.
    pub local_path: PathBuf,
    /// The public feed URL once uploaded + shared (None until the Drive glue lands).
    pub feed_url: Option<String>,
    pub episode_count: usize,
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
            duration_ms: Some(90_000.0),
            byte_size: bytes,
            created_at: started,
            note: Some("Festgudstjeneste".into()),
        }
    }

    #[test]
    fn maps_only_rows_with_a_share_url_newest_first() {
        let rows = vec![
            row("a", "/rec/old.mp3", 1_000.0, Some(100)),
            row("b", "/rec/new.mp3", 5_000.0, Some(200)),
            row("c", "/rec/unshared.mp3", 3_000.0, Some(300)),
        ];
        let mut urls = HashMap::new();
        urls.insert("a".to_string(), "https://x/old.mp3".to_string());
        urls.insert("b".to_string(), "https://x/new.mp3".to_string());
        // "c" has no share URL → dropped.

        let eps = episodes_from_rows(&rows, &urls);
        assert_eq!(eps.len(), 2);
        // Newest (b, started 5000) first.
        assert_eq!(eps[0].title, "new");
        assert_eq!(eps[0].audio_url, "https://x/new.mp3");
        assert_eq!(eps[0].guid, "sundayrec-5000");
        assert_eq!(eps[1].title, "old");
        // 90 s duration rounds to 90.
        assert_eq!(eps[0].duration_sec, Some(90));
        assert_eq!(eps[0].audio_bytes, 200);
        assert_eq!(eps[0].description.as_deref(), Some("Festgudstjeneste"));
    }

    #[test]
    fn empty_note_becomes_no_description() {
        let mut r = row("a", "/rec/a.mp3", 1.0, Some(1));
        r.note = Some(String::new());
        let mut urls = HashMap::new();
        urls.insert("a".to_string(), "https://x/a.mp3".to_string());
        let eps = episodes_from_rows(&[r], &urls);
        assert_eq!(eps[0].description, None);
    }

    #[test]
    fn negative_bytes_clamp_to_zero() {
        let r = row("a", "/rec/a.mp3", 1.0, Some(-9));
        let mut urls = HashMap::new();
        urls.insert("a".to_string(), "https://x/a.mp3".to_string());
        let eps = episodes_from_rows(&[r], &urls);
        assert_eq!(eps[0].audio_bytes, 0);
    }

    #[test]
    fn write_feed_writes_podcast_xml_to_disk() {
        let dir = tempfile::tempdir().unwrap();
        let channel = PodcastChannel {
            title: "St Mary's".into(),
            description: "Sunday services".into(),
            link: None,
            author: "St Mary's".into(),
            language: "no".into(),
            image_url: None,
            category: "Religion & Spirituality".into(),
            explicit: false,
            email: None,
            feed_url: None,
        };
        let path = write_feed(dir.path(), &channel, &[]).unwrap();
        assert!(path.ends_with(RSS_FILENAME));
        let xml = std::fs::read_to_string(&path).unwrap();
        assert!(xml.contains("<title>St Mary&apos;s</title>"));
        assert!(xml.contains("<generator>SundayRec</generator>"));
    }
}
