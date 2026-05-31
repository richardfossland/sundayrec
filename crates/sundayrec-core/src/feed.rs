//! Podcast RSS-feed builder — pure, GUI-free (PU-3 P2a).
//!
//! Ported from the Electron `src/main/publish/rss-feed.ts` (the behavioural
//! spec). That module was already pure (data in, XML string out); this is the
//! Rust port. It produces an RSS 2.0 feed with iTunes namespace extensions — the
//! format every major podcast directory (Spotify, Apple Podcasts, Pocket Casts,
//! Overcast, …) accepts.
//!
//! The orchestration (which history rows qualify, writing the file, uploading
//! it, sharing it) lives in the `src-tauri` shell behind the `publish` feature;
//! this module only shapes the XML. `pub_date` / `last_build_date` come in as
//! already-resolved [`chrono::NaiveDateTime`] UTC instants (the shell owns the
//! wall clock), formatted here to RFC 2822 — matching `rss-feed.ts`'s
//! `toUTCString()`.

use chrono::{Datelike, NaiveDateTime, Timelike};

/// Channel-level metadata for the feed. Mirrors `rss-feed.ts` `PodcastChannel`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PodcastChannel {
    pub title: String,
    pub description: String,
    pub link: Option<String>,
    pub author: String,
    /// ISO 639-1 language code, e.g. `"no"`, `"en"`.
    pub language: String,
    pub image_url: Option<String>,
    pub category: String,
    pub explicit: bool,
    pub email: Option<String>,
    pub feed_url: Option<String>,
}

/// One episode. Mirrors `rss-feed.ts` `PodcastEpisode`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PodcastEpisode {
    pub title: String,
    pub description: Option<String>,
    /// UTC instant the episode was published.
    pub pub_date: NaiveDateTime,
    pub guid: String,
    pub audio_url: String,
    pub audio_bytes: i64,
    /// Override the auto-detected MIME type if needed.
    pub mime_type: Option<String>,
    pub duration_sec: Option<u32>,
}

/// XML-escape `& < > " '` to entities. Ports `rss-feed.ts` `escXml` exactly
/// (note `'` → `&apos;`, distinct from the HTML mailer's `&#39;`).
fn esc_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// Format a UTC instant as an RFC 2822 date (e.g. `Sun, 17 May 2026 11:00:00 GMT`),
/// matching JS `Date.toUTCString()` which `rss-feed.ts` used.
fn rfc2822_date(d: NaiveDateTime) -> String {
    const DAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let weekday = DAYS[d.weekday().num_days_from_monday() as usize];
    let month = MONTHS[(d.month0()) as usize];
    format!(
        "{}, {:02} {} {} {:02}:{:02}:{:02} GMT",
        weekday,
        d.day(),
        month,
        d.year(),
        d.hour(),
        d.minute(),
        d.second()
    )
}

/// Infer an audio MIME type from a URL/filename's extension. Ports
/// `audioMimeTypeFromFilename`; defaults to `audio/mpeg`.
fn audio_mime_from_url(url: &str) -> &'static str {
    let stem = url.split(['#', '?']).next().unwrap_or(url);
    let ext = stem
        .rsplit('.')
        .next()
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "m4a" | "aac" => "audio/aac",
        "ogg" | "opus" | "oga" => "audio/ogg",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        _ => "audio/mpeg",
    }
}

/// Format a duration as `HH:MM:SS` (Apple's most widely-recognized form). Ports
/// `formatDuration`.
fn format_duration(sec: u32) -> String {
    let h = sec / 3600;
    let m = (sec % 3600) / 60;
    let s = sec % 60;
    format!("{h:02}:{m:02}:{s:02}")
}

/// Build a complete podcast RSS feed. Episodes are emitted in the order given —
/// callers sort newest-first for the standard display order. `now` is the
/// already-resolved UTC build time (the shell passes `Utc::now().naive_utc()`).
/// Ports `buildPodcastXml`, including element order + which fields are optional.
pub fn build_podcast_xml(
    channel: &PodcastChannel,
    episodes: &[PodcastEpisode],
    now: NaiveDateTime,
) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push("<?xml version=\"1.0\" encoding=\"UTF-8\"?>".into());
    lines.push("<rss version=\"2.0\" xmlns:itunes=\"http://www.itunes.com/dtds/podcast-1.0.dtd\" xmlns:atom=\"http://www.w3.org/2005/Atom\" xmlns:content=\"http://purl.org/rss/1.0/modules/content/\">".into());
    lines.push("  <channel>".into());
    lines.push(format!("    <title>{}</title>", esc_xml(&channel.title)));
    if let Some(link) = &channel.link {
        lines.push(format!("    <link>{}</link>", esc_xml(link)));
    }
    lines.push(format!(
        "    <language>{}</language>",
        esc_xml(&channel.language)
    ));
    lines.push(format!(
        "    <description>{}</description>",
        esc_xml(&channel.description)
    ));
    lines.push(format!(
        "    <itunes:author>{}</itunes:author>",
        esc_xml(&channel.author)
    ));
    lines.push(format!(
        "    <itunes:summary>{}</itunes:summary>",
        esc_xml(&channel.description)
    ));
    if let Some(img) = &channel.image_url {
        lines.push(format!("    <itunes:image href=\"{}\"/>", esc_xml(img)));
    }
    lines.push(format!(
        "    <itunes:explicit>{}</itunes:explicit>",
        if channel.explicit { "true" } else { "false" }
    ));
    lines.push(format!(
        "    <itunes:category text=\"{}\"/>",
        esc_xml(&channel.category)
    ));
    if let Some(email) = &channel.email {
        lines.push("    <itunes:owner>".into());
        lines.push(format!(
            "      <itunes:name>{}</itunes:name>",
            esc_xml(&channel.author)
        ));
        lines.push(format!(
            "      <itunes:email>{}</itunes:email>",
            esc_xml(email)
        ));
        lines.push("    </itunes:owner>".into());
    }
    if let Some(feed_url) = &channel.feed_url {
        lines.push(format!(
            "    <atom:link href=\"{}\" rel=\"self\" type=\"application/rss+xml\"/>",
            esc_xml(feed_url)
        ));
    }
    lines.push(format!(
        "    <lastBuildDate>{}</lastBuildDate>",
        rfc2822_date(now)
    ));
    lines.push("    <generator>SundayRec</generator>".into());

    for ep in episodes {
        lines.push("    <item>".into());
        lines.push(format!("      <title>{}</title>", esc_xml(&ep.title)));
        if let Some(desc) = &ep.description {
            lines.push(format!(
                "      <description>{}</description>",
                esc_xml(desc)
            ));
        }
        lines.push(format!(
            "      <pubDate>{}</pubDate>",
            rfc2822_date(ep.pub_date)
        ));
        lines.push(format!(
            "      <guid isPermaLink=\"false\">{}</guid>",
            esc_xml(&ep.guid)
        ));
        let mime = ep
            .mime_type
            .clone()
            .unwrap_or_else(|| audio_mime_from_url(&ep.audio_url).to_string());
        lines.push(format!(
            "      <enclosure url=\"{}\" length=\"{}\" type=\"{}\"/>",
            esc_xml(&ep.audio_url),
            ep.audio_bytes.max(0),
            esc_xml(&mime)
        ));
        if let Some(dur) = ep.duration_sec {
            if dur > 0 {
                lines.push(format!(
                    "      <itunes:duration>{}</itunes:duration>",
                    format_duration(dur)
                ));
            }
        }
        lines.push("    </item>".into());
    }

    lines.push("  </channel>".into());
    lines.push("</rss>".into());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
    }

    fn sample_channel() -> PodcastChannel {
        PodcastChannel {
            title: "St Mary's".into(),
            description: "Sunday services".into(),
            link: Some("https://stmarys.example".into()),
            author: "St Mary's Church".into(),
            language: "no".into(),
            image_url: Some("https://stmarys.example/cover.jpg".into()),
            category: "Religion & Spirituality".into(),
            explicit: false,
            email: Some("post@stmarys.example".into()),
            feed_url: Some("https://stmarys.example/podcast.xml".into()),
        }
    }

    #[test]
    fn rfc2822_matches_to_utc_string() {
        // 2026-05-17 is a Sunday.
        assert_eq!(
            rfc2822_date(dt("2026-05-17 11:00:00")),
            "Sun, 17 May 2026 11:00:00 GMT"
        );
        // A Monday with single-digit day.
        assert_eq!(
            rfc2822_date(dt("2026-06-01 09:05:03")),
            "Mon, 01 Jun 2026 09:05:03 GMT"
        );
    }

    #[test]
    fn mime_inference_by_extension() {
        assert_eq!(audio_mime_from_url("a.mp3"), "audio/mpeg");
        assert_eq!(audio_mime_from_url("a.wav"), "audio/wav");
        assert_eq!(audio_mime_from_url("a.flac"), "audio/flac");
        assert_eq!(audio_mime_from_url("a.m4a"), "audio/aac");
        assert_eq!(audio_mime_from_url("a.MP4"), "video/mp4");
        assert_eq!(audio_mime_from_url("a.mov"), "video/quicktime");
        // Query string is stripped before extension lookup.
        assert_eq!(
            audio_mime_from_url("https://x/a.mp3?token=abc"),
            "audio/mpeg"
        );
        // Unknown → default.
        assert_eq!(audio_mime_from_url("a.xyz"), "audio/mpeg");
    }

    #[test]
    fn duration_is_hhmmss() {
        assert_eq!(format_duration(0), "00:00:00");
        assert_eq!(format_duration(3661), "01:01:01");
        assert_eq!(format_duration(45), "00:00:45");
    }

    #[test]
    fn builds_a_well_formed_channel() {
        let xml = build_podcast_xml(&sample_channel(), &[], dt("2026-05-17 12:00:00"));
        assert!(xml.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));
        assert!(xml.contains("<rss version=\"2.0\""));
        // The apostrophe in the title is XML-escaped to &apos;.
        assert!(xml.contains("<title>St Mary&apos;s</title>"));
        assert!(xml.contains("<language>no</language>"));
        assert!(xml.contains("<itunes:explicit>false</itunes:explicit>"));
        assert!(xml.contains("<itunes:category text=\"Religion &amp; Spirituality\"/>"));
        assert!(xml.contains("<itunes:owner>"));
        assert!(xml.contains("<itunes:email>post@stmarys.example</itunes:email>"));
        assert!(
            xml.contains("<atom:link href=\"https://stmarys.example/podcast.xml\" rel=\"self\"")
        );
        assert!(xml.contains("<lastBuildDate>Sun, 17 May 2026 12:00:00 GMT</lastBuildDate>"));
        assert!(xml.contains("<generator>SundayRec</generator>"));
        assert!(xml.trim_end().ends_with("</rss>"));
    }

    #[test]
    fn omits_optional_channel_fields_when_absent() {
        let channel = PodcastChannel {
            link: None,
            image_url: None,
            email: None,
            feed_url: None,
            ..sample_channel()
        };
        let xml = build_podcast_xml(&channel, &[], dt("2026-05-17 12:00:00"));
        assert!(!xml.contains("<link>"));
        assert!(!xml.contains("<itunes:image"));
        assert!(!xml.contains("<itunes:owner>"));
        assert!(!xml.contains("<atom:link"));
    }

    #[test]
    fn emits_an_episode_with_enclosure_and_duration() {
        let ep = PodcastEpisode {
            title: "Gudstjeneste 17. mai".into(),
            description: Some("Festgudstjeneste".into()),
            pub_date: dt("2026-05-17 11:00:00"),
            guid: "sundayrec-1747476000000".into(),
            audio_url: "https://drive.example/a.mp3".into(),
            audio_bytes: 12_345_678,
            mime_type: None,
            duration_sec: Some(3661),
        };
        let xml = build_podcast_xml(
            &sample_channel(),
            std::slice::from_ref(&ep),
            dt("2026-05-17 12:00:00"),
        );
        assert!(xml.contains("<title>Gudstjeneste 17. mai</title>"));
        assert!(xml.contains("<description>Festgudstjeneste</description>"));
        assert!(xml.contains("<pubDate>Sun, 17 May 2026 11:00:00 GMT</pubDate>"));
        assert!(xml.contains("<guid isPermaLink=\"false\">sundayrec-1747476000000</guid>"));
        assert!(xml.contains(
            "<enclosure url=\"https://drive.example/a.mp3\" length=\"12345678\" type=\"audio/mpeg\"/>"
        ));
        assert!(xml.contains("<itunes:duration>01:01:01</itunes:duration>"));
    }

    #[test]
    fn negative_bytes_clamp_to_zero_and_zero_duration_is_omitted() {
        let ep = PodcastEpisode {
            title: "x".into(),
            description: None,
            pub_date: dt("2026-05-17 11:00:00"),
            guid: "g".into(),
            audio_url: "a.mp3".into(),
            audio_bytes: -5,
            mime_type: None,
            duration_sec: Some(0),
        };
        let xml = build_podcast_xml(&sample_channel(), &[ep], dt("2026-05-17 12:00:00"));
        assert!(xml.contains("length=\"0\""));
        assert!(!xml.contains("<itunes:duration>"));
        // No description element when absent.
        assert!(!xml.contains("<description>x"));
    }

    #[test]
    fn explicit_mime_override_wins_over_extension() {
        let ep = PodcastEpisode {
            title: "x".into(),
            description: None,
            pub_date: dt("2026-05-17 11:00:00"),
            guid: "g".into(),
            audio_url: "a.bin".into(),
            audio_bytes: 1,
            mime_type: Some("audio/mpeg".into()),
            duration_sec: None,
        };
        let xml = build_podcast_xml(&sample_channel(), &[ep], dt("2026-05-17 12:00:00"));
        assert!(xml.contains("type=\"audio/mpeg\""));
    }

    #[test]
    fn xml_special_chars_in_episode_title_are_escaped() {
        let ep = PodcastEpisode {
            title: "Rock & <Roll>".into(),
            description: None,
            pub_date: dt("2026-05-17 11:00:00"),
            guid: "g".into(),
            audio_url: "a.mp3".into(),
            audio_bytes: 1,
            mime_type: None,
            duration_sec: None,
        };
        let xml = build_podcast_xml(&sample_channel(), &[ep], dt("2026-05-17 12:00:00"));
        assert!(xml.contains("<title>Rock &amp; &lt;Roll&gt;</title>"));
    }
}
