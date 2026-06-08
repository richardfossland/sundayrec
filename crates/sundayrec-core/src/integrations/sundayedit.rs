//! SundayEdit hand-off helpers.
//!
//! Pure port of the Electron SundayEdit integration helper: build the
//! `sundayedit://import?…` deep link, and parse a SundayEdit-exported subtitle file
//! (SRT / WebVTT) into the recording's `TranscriptData` sidecar shape so
//! SundayRec's transcript search/editor consume it unchanged. The deep-link
//! *launch* and the sidecar *write* are the shell's side effects; the URL
//! building + the subtitle parsing are the unit-tested decisions here.

use crate::whisper::{TranscriptData, TranscriptSegment};

/// Options for the SundayEdit deep link.
#[derive(Debug, Clone, Default)]
pub struct SundayEditImportOptions {
    pub video_path: String,
    pub language: Option<String>,
    pub context: Option<String>,
    pub glossary: Vec<String>,
}

/// Percent-encode a query-parameter value (RFC 3986 unreserved kept; everything
/// else `%XX`). Matches `URLSearchParams` for the characters we emit (spaces
/// become `%20`, not `+`, which SundayEdit's parser decodes identically).
fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Build the `sundayedit://import` deep link. Mirrors `buildSundayEditDeepLink`:
/// always carries `path` + `returnTo=sundayrec`; adds `language`/`context` when
/// present and a comma-joined `glossary` when non-empty. Pure.
pub fn build_sundayedit_deep_link(opts: &SundayEditImportOptions) -> String {
    let mut params = vec![format!("path={}", encode_component(&opts.video_path))];
    if let Some(lang) = opts.language.as_deref().filter(|s| !s.is_empty()) {
        params.push(format!("language={}", encode_component(lang)));
    }
    if let Some(ctx) = opts.context.as_deref().filter(|s| !s.is_empty()) {
        params.push(format!("context={}", encode_component(ctx)));
    }
    if !opts.glossary.is_empty() {
        params.push(format!(
            "glossary={}",
            encode_component(&opts.glossary.join(","))
        ));
    }
    params.push("returnTo=sundayrec".to_string());
    format!("sundayedit://import?{}", params.join("&"))
}

/// Parse one `HH:MM:SS,mmm` / `HH:MM:SS.mmm` timestamp into seconds. Mirrors the
/// Electron `parseTimestamp` regex (`(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})`).
fn parse_timestamp(s: &str) -> Option<f64> {
    // Find the first match anywhere in the line.
    let bytes: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        // Try to match starting at i.
        if let Some((secs, _consumed)) = try_match_ts(&bytes[i..]) {
            return Some(secs);
        }
        i += 1;
    }
    None
}

/// Try to parse a timestamp at the very start of `cs`. Returns `(seconds, len)`.
fn try_match_ts(cs: &[char]) -> Option<(f64, usize)> {
    let mut idx = 0;
    let read_digits = |cs: &[char], idx: &mut usize, min: usize, max: usize| -> Option<u64> {
        let start = *idx;
        while *idx < cs.len() && *idx - start < max && cs[*idx].is_ascii_digit() {
            *idx += 1;
        }
        let n = *idx - start;
        if n < min {
            return None;
        }
        cs[start..*idx]
            .iter()
            .collect::<String>()
            .parse::<u64>()
            .ok()
    };
    let hh = read_digits(cs, &mut idx, 1, 2)?;
    if idx >= cs.len() || cs[idx] != ':' {
        return None;
    }
    idx += 1;
    let mm = read_digits(cs, &mut idx, 2, 2)?;
    if idx >= cs.len() || cs[idx] != ':' {
        return None;
    }
    idx += 1;
    let ss = read_digits(cs, &mut idx, 2, 2)?;
    if idx >= cs.len() || (cs[idx] != '.' && cs[idx] != ',') {
        return None;
    }
    idx += 1;
    // Milliseconds 1..3 digits, right-padded to 3 (mirrors `padEnd(3,'0')`).
    let ms_start = idx;
    while idx < cs.len() && idx - ms_start < 3 && cs[idx].is_ascii_digit() {
        idx += 1;
    }
    if idx == ms_start {
        return None;
    }
    let mut ms_str: String = cs[ms_start..idx].iter().collect();
    while ms_str.len() < 3 {
        ms_str.push('0');
    }
    let ms: u64 = ms_str.parse().ok()?;
    let secs = hh as f64 * 3600.0 + mm as f64 * 60.0 + ss as f64 + ms as f64 / 1000.0;
    Some((secs, idx))
}

/// Parse SRT or WebVTT text into transcript segments. Mirrors `parseSubtitles`:
/// strips a BOM + normalises CR/CRLF, splits on blank lines, finds the `-->`
/// cue-timing line, parses both timestamps, and joins the remaining non-empty
/// lines as the text. Cue numbers / `WEBVTT` / `NOTE` headers are skipped (no
/// `-->`). Pure.
pub fn parse_subtitles(text: &str) -> Vec<TranscriptSegment> {
    let clean = text
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut segments = Vec::new();
    for block in clean.split("\n\n").flat_map(|b| {
        // Collapse runs of >1 blank line into block boundaries too.
        b.split("\n\n\n")
    }) {
        let lines: Vec<&str> = block.lines().map(|l| l.trim_end()).collect();
        let Some(t_idx) = lines.iter().position(|l| l.contains("-->")) else {
            continue;
        };
        let parts: Vec<&str> = lines[t_idx].split("-->").collect();
        let (Some(start), Some(end)) = (
            parse_timestamp(parts.first().copied().unwrap_or("")),
            parse_timestamp(parts.get(1).copied().unwrap_or("")),
        ) else {
            continue;
        };
        let seg_text = lines[t_idx + 1..]
            .iter()
            .filter(|l| !l.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(" ");
        let seg_text = seg_text.trim().to_string();
        if seg_text.is_empty() {
            continue;
        }
        segments.push(TranscriptSegment {
            start,
            end,
            text: seg_text,
        });
    }
    segments
}

/// Convert subtitle text into the `TranscriptData` sidecar shape (model
/// `"sundayedit"`). Mirrors `subtitlesToTranscript`: duration is the last
/// segment's end (0 when empty); `created_at` is supplied by the shell.
pub fn subtitles_to_transcript(
    text: &str,
    language: Option<&str>,
    created_at: i64,
) -> TranscriptData {
    let segments = parse_subtitles(text);
    let duration = segments.last().map(|s| s.end).unwrap_or(0.0);
    TranscriptData {
        version: 1,
        model: "sundayedit".to_string(),
        language: language.unwrap_or("auto").to_string(),
        duration,
        created_at,
        translated: None,
        segments,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deep_link_carries_path_and_return_to() {
        let link = build_sundayedit_deep_link(&SundayEditImportOptions {
            video_path: "/rec/sermon.mp4".into(),
            ..Default::default()
        });
        assert!(link.starts_with("sundayedit://import?"));
        assert!(link.contains("path=%2Frec%2Fsermon.mp4"));
        assert!(link.contains("returnTo=sundayrec"));
        // No language/context/glossary params when unset.
        assert!(!link.contains("language="));
        assert!(!link.contains("glossary="));
    }

    #[test]
    fn deep_link_includes_optional_params_encoded() {
        let link = build_sundayedit_deep_link(&SundayEditImportOptions {
            video_path: "/v.mp4".into(),
            language: Some("no".into()),
            context: Some("Preken. Taler: Ola".into()),
            glossary: vec!["Ola".into(), "Bergen".into()],
        });
        assert!(link.contains("language=no"));
        assert!(link.contains("context=Preken.%20Taler%3A%20Ola"));
        assert!(link.contains("glossary=Ola%2CBergen"));
    }

    #[test]
    fn parse_srt_with_comma_ms_and_cue_numbers() {
        let srt = "1\n00:00:01,000 --> 00:00:03,500\nHello world\n\n2\n00:00:04,000 --> 00:00:05,000\nSecond line";
        let segs = parse_subtitles(srt);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].start, 1.0);
        assert_eq!(segs[0].end, 3.5);
        assert_eq!(segs[0].text, "Hello world");
        assert_eq!(segs[1].text, "Second line");
    }

    #[test]
    fn parse_vtt_skips_header_and_uses_dot_ms() {
        let vtt = "\u{feff}WEBVTT\n\n00:00:00.000 --> 00:00:02.250\nIntro\n";
        let segs = parse_subtitles(vtt);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].end, 2.25);
        assert_eq!(segs[0].text, "Intro");
    }

    #[test]
    fn subtitles_to_transcript_sets_model_and_duration() {
        let t = subtitles_to_transcript("00:00:00,000 --> 00:00:10,000\nText", Some("no"), 42);
        assert_eq!(t.model, "sundayedit");
        assert_eq!(t.language, "no");
        assert_eq!(t.duration, 10.0);
        assert_eq!(t.created_at, 42);
        assert_eq!(t.version, 1);
    }

    #[test]
    fn empty_subtitles_yield_no_segments_and_zero_duration() {
        let t = subtitles_to_transcript("WEBVTT\n\nNOTE just a note", None, 0);
        assert!(t.segments.is_empty());
        assert_eq!(t.duration, 0.0);
        assert_eq!(t.language, "auto");
    }
}
