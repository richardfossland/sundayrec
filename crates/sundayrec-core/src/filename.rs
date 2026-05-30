//! Output-filename construction — pure, ported from the Electron
//! `src/main/recorder-utils.ts` (`sanitizeFilename`, `localDateStr`,
//! `buildFilename`).
//!
//! This was renderer/main-side string building in Electron. The scheduler
//! (Fase 5) needs it on the Rust side so a backend-triggered recording can name
//! its file without round-tripping to the webview (the window may be hidden or
//! closed when a scheduled recording fires). It's pure and reusable, so manual
//! recording can adopt it too.
//!
//! ## `church` pattern — honest partial
//!
//! The Electron `church` pattern names the file after the liturgical day via
//! `shared/church-calendar.ts` (an Easter-computus + Norwegian holiday table).
//! That ~110-line module is **not yet ported** — it belongs with a dedicated
//! recorder-utils/metadata port, not bolted onto Fase 5. So [`build_filename`]
//! takes an OPTIONAL precomputed `church_name`: pass `Some(name)` once the
//! calendar lands, or `None` to fall back to the `plain` wording
//! (`"gudstjeneste"`). The fallback only affects the `church` pattern; every
//! other pattern is a faithful port today.

use chrono::{Datelike, NaiveDateTime, Timelike};

use crate::settings::FilenamePattern;

/// Windows reserved device base names (case-insensitive) that can't be used as
/// filenames. Mirrors the Electron `WIN_RESERVED` regex.
const WIN_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Make `name` safe as a filename across macOS and Windows: strip path/illegal
/// characters, trim trailing dots/spaces, dodge reserved device names, and
/// never return empty. Direct port of `recorder-utils.ts` `sanitizeFilename`.
pub fn sanitize_filename(name: &str) -> String {
    let mut safe: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect();
    safe = safe.trim().to_string();
    // Strip trailing dots/spaces (Windows disallows them).
    safe = safe.trim_end_matches(['.', ' ']).to_string();
    if WIN_RESERVED.iter().any(|r| r.eq_ignore_ascii_case(&safe)) {
        safe = format!("_{safe}");
    }
    if safe.is_empty() {
        "opptak".to_string()
    } else {
        safe
    }
}

/// `YYYY-MM-DD` from the local-wall datetime. Port of `localDateStr`.
pub fn local_date_str(dt: NaiveDateTime) -> String {
    format!("{:04}-{:02}-{:02}", dt.year(), dt.month(), dt.day())
}

/// Inputs to [`build_filename`]. Borrowed so the caller keeps ownership.
pub struct FilenameParams<'a> {
    /// Output container/codec extension (`mp3`, `wav`, `flac`, `aac`).
    pub format: &'a str,
    /// The pattern the user selected.
    pub pattern: FilenamePattern,
    /// A user/override name (e.g. a special recording's title). When non-blank
    /// it wins over the pattern, exactly like the Electron `customName` branch.
    pub custom_name: Option<&'a str>,
    /// Precomputed liturgical day name for the `church` pattern, or `None` to
    /// fall back to the `plain` wording (see module header).
    pub church_name: Option<&'a str>,
    /// Segment timestamp suffix for split recordings (`splitTimestamp`), or
    /// `None` for the primary/only segment.
    pub split_timestamp: Option<&'a str>,
    /// The recording's start instant (local wall clock).
    pub now: NaiveDateTime,
}

/// Build the output filename (basename + extension, no directory). Direct port
/// of `recorder-utils.ts` `buildFilename`.
pub fn build_filename(p: &FilenameParams) -> String {
    let date = local_date_str(p.now);
    let ext = p.format;
    let ts = p
        .split_timestamp
        .map(|t| format!("_{t}"))
        .unwrap_or_default();

    if let Some(name) = p.custom_name {
        if !name.trim().is_empty() {
            let safe = sanitize_filename(name.trim());
            return format!("{safe}{ts}_{date}.{ext}");
        }
    }

    match p.pattern {
        FilenamePattern::Church => {
            let name = p.church_name.unwrap_or("gudstjeneste");
            format!("{name}{ts}_{date}.{ext}")
        }
        FilenamePattern::Plain => format!("gudstjeneste{ts}_{date}.{ext}"),
        FilenamePattern::Datetime => {
            let time = format!("{:02}{:02}", p.now.hour(), p.now.minute());
            format!("{date}_{time}.{ext}")
        }
        FilenamePattern::Date => format!("{date}{ts}.{ext}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }

    #[test]
    fn sanitize_strips_illegal_and_reserved() {
        assert_eq!(sanitize_filename("a/b:c*?"), "a_b_c__");
        assert_eq!(sanitize_filename("  trailing.  "), "trailing");
        assert_eq!(sanitize_filename("CON"), "_CON");
        assert_eq!(sanitize_filename("com1"), "_com1");
        assert_eq!(sanitize_filename(""), "opptak");
        assert_eq!(sanitize_filename("   "), "opptak");
        assert_eq!(sanitize_filename("Julaften"), "Julaften");
    }

    #[test]
    fn date_pattern_default() {
        let p = FilenameParams {
            format: "mp3",
            pattern: FilenamePattern::Date,
            custom_name: None,
            church_name: None,
            split_timestamp: None,
            now: dt("2026-06-07 11:00"),
        };
        assert_eq!(build_filename(&p), "2026-06-07.mp3");
    }

    #[test]
    fn date_pattern_with_split_timestamp() {
        let p = FilenameParams {
            format: "wav",
            pattern: FilenamePattern::Date,
            custom_name: None,
            church_name: None,
            split_timestamp: Some("1130"),
            now: dt("2026-06-07 11:30"),
        };
        assert_eq!(build_filename(&p), "2026-06-07_1130.wav");
    }

    #[test]
    fn plain_and_datetime_patterns() {
        let base = FilenameParams {
            format: "mp3",
            pattern: FilenamePattern::Plain,
            custom_name: None,
            church_name: None,
            split_timestamp: None,
            now: dt("2026-06-07 09:05"),
        };
        assert_eq!(build_filename(&base), "gudstjeneste_2026-06-07.mp3");

        let dt_pat = FilenameParams {
            pattern: FilenamePattern::Datetime,
            ..base_like(dt("2026-06-07 09:05"))
        };
        assert_eq!(build_filename(&dt_pat), "2026-06-07_0905.mp3");
    }

    #[test]
    fn church_pattern_uses_name_or_falls_back() {
        let with_name = FilenameParams {
            format: "mp3",
            pattern: FilenamePattern::Church,
            custom_name: None,
            church_name: Some("1. søndag i advent"),
            split_timestamp: None,
            now: dt("2026-11-29 11:00"),
        };
        assert_eq!(
            build_filename(&with_name),
            "1. søndag i advent_2026-11-29.mp3"
        );

        // No precomputed name → falls back to the plain wording.
        let fallback = FilenameParams {
            church_name: None,
            ..base_like(dt("2026-11-29 11:00"))
        };
        let fallback = FilenameParams {
            pattern: FilenamePattern::Church,
            ..fallback
        };
        assert_eq!(build_filename(&fallback), "gudstjeneste_2026-11-29.mp3");
    }

    #[test]
    fn custom_name_wins_over_pattern() {
        let p = FilenameParams {
            format: "flac",
            pattern: FilenamePattern::Date,
            custom_name: Some("Julaften gudstjeneste"),
            church_name: None,
            split_timestamp: None,
            now: dt("2026-12-24 16:00"),
        };
        assert_eq!(build_filename(&p), "Julaften gudstjeneste_2026-12-24.flac");

        // Blank custom name is ignored (falls through to the pattern).
        let blank = FilenameParams {
            custom_name: Some("   "),
            ..base_like(dt("2026-12-24 16:00"))
        };
        assert_eq!(build_filename(&blank), "2026-12-24.mp3");
    }

    /// A `Date`-pattern, mp3, no-extras params at `now` — test convenience.
    fn base_like(now: NaiveDateTime) -> FilenameParams<'static> {
        FilenameParams {
            format: "mp3",
            pattern: FilenamePattern::Date,
            custom_name: None,
            church_name: None,
            split_timestamp: None,
            now,
        }
    }
}
