//! Live-stream RTMP argument builders + stream-key validation (R3 streaming).
//!
//! Ported from the Electron `src/main/streamer.ts` behaviour: one ffmpeg
//! process encodes the camera/mic once and *tees* the output to multiple RTMP
//! destinations (YouTube/Facebook/custom). The hardened argument knowledge —
//! the `tee:` muxer shape, `onfail=ignore` so one dead destination doesn't kill
//! the others, the keyframe-every-2-seconds GOP YouTube/Facebook require, the
//! bitrate/bufsize math — is the asset we carry forward, independent of how the
//! process is launched.
//!
//! Everything here is a pure string/decision builder: never spawns ffmpeg,
//! never touches the network. That keeps the filter/codec/tee math trivially
//! testable, and keeps the keys *out* of any logged argv (see [`joined_rtmp_url`]
//! and [`StreamArgs::loggable`]).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

// ── Resolution / bitrate table ───────────────────────────────────────────────

/// Output resolution preset. Mirrors the Electron `RES_MAP` keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/StreamResolution.ts")]
#[serde(rename_all = "lowercase")]
pub enum StreamResolution {
    /// 854×480, ~1500 kbps auto.
    P480,
    /// 1280×720, ~4500 kbps auto.
    P720,
    /// 1920×1080, ~6000 kbps auto.
    P1080,
}

impl StreamResolution {
    /// Pixel width.
    pub fn width(self) -> u32 {
        match self {
            StreamResolution::P480 => 854,
            StreamResolution::P720 => 1280,
            StreamResolution::P1080 => 1920,
        }
    }

    /// Pixel height.
    pub fn height(self) -> u32 {
        match self {
            StreamResolution::P480 => 480,
            StreamResolution::P720 => 720,
            StreamResolution::P1080 => 1080,
        }
    }

    /// The default video bitrate (kbps) when the caller doesn't override it,
    /// matching the Electron `auto_kbps` column.
    pub fn auto_bitrate_kbps(self) -> u32 {
        match self {
            StreamResolution::P480 => 1500,
            StreamResolution::P720 => 4500,
            StreamResolution::P1080 => 6000,
        }
    }
}

// ── Destinations ─────────────────────────────────────────────────────────────

/// One RTMP push target. The `stream_key` is sensitive — it's joined into the
/// URL only inside [`joined_rtmp_url`] and never appears in [`StreamArgs::loggable`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/StreamDestination.ts")]
#[serde(rename_all = "camelCase")]
pub struct StreamDestination {
    /// Stable id for UI tracking + key storage.
    pub id: String,
    /// User-facing name ("YouTube", "Kirkens server", …).
    pub name: String,
    /// RTMP base URL, no stream key. Example: `rtmp://a.rtmp.youtube.com/live2`.
    pub rtmp_url: String,
    /// Stream key — sensitive, resolved from the vault by the caller.
    pub stream_key: String,
    /// Skip this destination without deleting it.
    pub enabled: bool,
}

impl StreamDestination {
    /// A destination is *pushable* when enabled and carrying both a URL and a
    /// key — mirrors the Electron `d.enabled && d.rtmpUrl && d.streamKey` filter
    /// used everywhere a destination list is consumed.
    pub fn is_pushable(&self) -> bool {
        self.enabled
            && !self.rtmp_url.trim().is_empty()
            && !self.stream_key.trim().is_empty()
    }
}

/// Full set of options for one stream launch. The renderer-facing mirror of the
/// Electron `StreamOptions` (overlays are threaded in separately by the seam via
/// [`crate::overlay`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/StreamOptions.ts")]
#[serde(rename_all = "camelCase")]
pub struct StreamOptions {
    pub resolution: StreamResolution,
    /// Frames per second — 25 or 30 in the Electron app; the GOP is `fps × 2`.
    pub framerate: u32,
    /// Video bitrate (kbps); `None` → the resolution's `auto_bitrate_kbps`.
    pub video_bitrate_kbps: Option<u32>,
    /// Audio bitrate (kbps); `None` → 128.
    pub audio_bitrate_kbps: Option<u32>,
    /// Push targets. Non-pushable ones are skipped.
    pub destinations: Vec<StreamDestination>,
    /// Optional local MP4 written by the same pipeline (the "stream + opptak"
    /// pattern). `None` → no local copy. The bitrate defaults to `video × 1.6`.
    pub also_record_path: Option<String>,
}

impl StreamOptions {
    /// Effective video bitrate (kbps).
    pub fn video_bitrate(&self) -> u32 {
        self.video_bitrate_kbps
            .unwrap_or_else(|| self.resolution.auto_bitrate_kbps())
    }

    /// Effective audio bitrate (kbps).
    pub fn audio_bitrate(&self) -> u32 {
        self.audio_bitrate_kbps.unwrap_or(128)
    }

    /// Local-recording bitrate (kbps) — defaults to `video × 1.6` for a
    /// noticeably higher-quality local file than the livestream.
    pub fn record_bitrate(&self) -> u32 {
        (self.video_bitrate() as f64 * 1.6).round() as u32
    }

    /// The pushable destinations, in order.
    pub fn pushable(&self) -> Vec<&StreamDestination> {
        self.destinations.iter().filter(|d| d.is_pushable()).collect()
    }
}

// ── Stream-key validation ─────────────────────────────────────────────────────

/// Why a stream key / RTMP URL was rejected. Stable so the renderer can map to
/// a localized message without parsing free text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/StreamKeyError.ts")]
#[serde(rename_all = "snake_case")]
pub enum StreamKeyError {
    /// The key was empty/whitespace.
    Empty,
    /// The key contained whitespace (a paste artefact) or control chars.
    HasWhitespace,
    /// The key was implausibly short (< 4 chars after trim).
    TooShort,
    /// The RTMP base URL didn't start with `rtmp://` or `rtmps://`.
    BadScheme,
}

/// Validate a stream key. Pure — no network. Rejects the paste artefacts that
/// silently break a stream (leading/trailing space, an embedded newline) and
/// obvious empties. We deliberately do *not* enforce a charset: keys vary across
/// providers (YouTube uses `xxxx-xxxx-xxxx-xxxx`, custom RTMP servers anything).
pub fn validate_stream_key(key: &str) -> Result<(), StreamKeyError> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err(StreamKeyError::Empty);
    }
    // Internal whitespace or any control char is always a mistake in a key.
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(StreamKeyError::HasWhitespace);
    }
    if trimmed.chars().count() < 4 {
        return Err(StreamKeyError::TooShort);
    }
    Ok(())
}

/// Validate an RTMP base URL (no key). Must be a plausible `rtmp://`/`rtmps://`
/// URL with a host after the scheme.
pub fn validate_rtmp_url(url: &str) -> Result<(), StreamKeyError> {
    let u = url.trim();
    let rest = u
        .strip_prefix("rtmps://")
        .or_else(|| u.strip_prefix("rtmp://"));
    match rest {
        Some(host) if !host.is_empty() => Ok(()),
        _ => Err(StreamKeyError::BadScheme),
    }
}

/// Join an RTMP base URL with a stream key, percent-encoding the key path
/// segment (matches the Electron `joinRtmpUrl` `encodeURIComponent`). The base's
/// trailing slashes are trimmed first so we never produce `…/live2//KEY`.
pub fn joined_rtmp_url(base: &str, key: &str) -> String {
    let b = base.trim_end_matches('/');
    format!("{b}/{}", percent_encode_segment(key))
}

/// Minimal RFC 3986 path-segment percent-encoder — encodes everything that
/// isn't an unreserved char (`A-Za-z0-9-._~`). Matches `encodeURIComponent` for
/// the characters that actually turn up in stream keys (it additionally encodes
/// `!*'()` which `encodeURIComponent` leaves alone, but those never appear in a
/// real key, so the streams are identical in practice).
fn percent_encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => {
                out.push('%');
                out.push(hex_upper(b >> 4));
                out.push(hex_upper(b & 0x0f));
            }
        }
    }
    out
}

fn hex_upper(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        _ => (b'A' + (nibble - 10)) as char,
    }
}

// ── Output argument builder ───────────────────────────────────────────────────

/// The result of building a stream launch's output args. `args` is the full
/// ffmpeg argv from `-filter_complex` onward (the caller prepends the input +
/// overlay args). `loggable` is the same argv with every stream key redacted —
/// always log THIS one, never `args`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamArgs {
    /// The real argv (contains keys inside the tee/flv URLs).
    pub args: Vec<String>,
    /// A key-redacted copy safe to log.
    pub loggable: Vec<String>,
}

/// Why building the output args failed before any spawn. Stable for the renderer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/StreamArgError.ts")]
#[serde(rename_all = "snake_case")]
pub enum StreamArgError {
    /// No enabled destination carried both a URL and a key.
    NoDestinations,
}

/// macOS bundles camera+mic into one avfoundation input (audio rides input 0);
/// Windows takes audio as a separate dshow input after the overlays. The audio
/// map string differs accordingly — mirrors the Electron `audioMap` branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioInputLayout {
    /// Audio bundled on input 0 (macOS avfoundation).
    BundledInputZero,
    /// Audio is the input AFTER `overlay_count` overlays (Windows dshow).
    SeparateAfterOverlays,
}

impl AudioInputLayout {
    /// The `-map` value for the audio stream given how many overlay inputs were
    /// inserted between the camera (input 0) and the audio input.
    fn audio_map(self, overlay_count: u32) -> String {
        match self {
            AudioInputLayout::BundledInputZero => "0:a?".to_string(),
            AudioInputLayout::SeparateAfterOverlays => format!("{}:a?", 1 + overlay_count),
        }
    }
}

/// Build the full output argument vector for a stream launch: the
/// `-filter_complex` split (+ optional overlay chain), the libx264/aac encode
/// for the live branch, the `tee`/`flv` destination muxer, an optional local MP4
/// branch, and the 0.5 fps preview snapshot branch. Mirrors the Electron
/// `buildOutputArgs`.
///
/// - `overlay_count` / `overlay_label` / `overlay_chain` come from
///   [`crate::overlay::build_overlay_pipeline`]: when there are no overlays the
///   chain is empty and the label is the base (`0:v`).
/// - `snapshot_path` is where the 0.5 fps preview JPG is written.
///
/// Returns [`StreamArgError::NoDestinations`] when nothing is pushable — the
/// caller validates upstream too, this is the last line of defence.
pub fn build_output_args(
    opts: &StreamOptions,
    snapshot_path: &str,
    audio_layout: AudioInputLayout,
    overlay_count: u32,
    overlay_label: &str,
    overlay_chain: &str,
) -> Result<StreamArgs, StreamArgError> {
    let pushable = opts.pushable();
    if pushable.is_empty() {
        return Err(StreamArgError::NoDestinations);
    }

    let v_bitrate = opts.video_bitrate();
    let a_bitrate = opts.audio_bitrate();
    let fps = opts.framerate;
    let audio_map = audio_layout.audio_map(overlay_count);

    // ── filter_complex: overlay chain → split → preview thumb ──
    let mut filter_parts: Vec<String> = Vec::new();
    if !overlay_chain.is_empty() {
        filter_parts.push(overlay_chain.to_string());
    }
    if opts.also_record_path.is_some() {
        filter_parts.push(format!("[{overlay_label}]split=3[v_stream][v_rec][v_pre]"));
    } else {
        filter_parts.push(format!("[{overlay_label}]split=2[v_stream][v_pre]"));
    }
    filter_parts.push("[v_pre]fps=1/2,scale=320:-1[v_thumb]".to_string());

    let mut args: Vec<String> = vec!["-filter_complex".into(), filter_parts.join(";")];

    // ── live encode branch ──
    args.extend(
        [
            "-map", "[v_stream]", "-map", &audio_map, "-c:v", "libx264", "-preset", "veryfast",
            "-tune", "zerolatency", "-pix_fmt", "yuv420p",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    args.extend([
        "-b:v".into(),
        format!("{v_bitrate}k"),
        "-maxrate".into(),
        format!("{v_bitrate}k"),
        "-bufsize".into(),
        format!("{}k", v_bitrate * 2),
        // keyframe every 2 sec — required by YouTube/Facebook.
        "-g".into(),
        (fps * 2).to_string(),
        "-keyint_min".into(),
        (fps * 2).to_string(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        format!("{a_bitrate}k"),
        "-ar".into(),
        "44100".into(),
        "-ac".into(),
        "2".into(),
    ]);

    // ── destination muxer: single → flv, multi → tee ──
    if pushable.len() == 1 {
        let d = pushable[0];
        args.push("-f".into());
        args.push("flv".into());
        args.push(joined_rtmp_url(&d.rtmp_url, &d.stream_key));
    } else {
        let tee = pushable
            .iter()
            .map(|d| {
                format!(
                    "[f=flv:onfail=ignore]{}",
                    joined_rtmp_url(&d.rtmp_url, &d.stream_key)
                )
            })
            .collect::<Vec<_>>()
            .join("|");
        args.push("-f".into());
        args.push("tee".into());
        args.push(tee);
    }

    // ── optional local MP4 (higher bitrate, faststart) ──
    if let Some(path) = &opts.also_record_path {
        let rec_bitrate = opts.record_bitrate();
        args.extend([
            "-map".into(),
            "[v_rec]".into(),
            "-map".into(),
            audio_map.clone(),
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "veryfast".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-b:v".into(),
            format!("{rec_bitrate}k"),
            "-maxrate".into(),
            format!("{rec_bitrate}k"),
            "-bufsize".into(),
            format!("{}k", rec_bitrate * 2),
            "-g".into(),
            (fps * 2).to_string(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
            "-ar".into(),
            "48000".into(),
            "-ac".into(),
            "2".into(),
            "-movflags".into(),
            "+faststart".into(),
            "-y".into(),
            path.clone(),
        ]);
    }

    // ── preview snapshot branch (overwrites same JPG) ──
    args.extend([
        "-map".into(),
        "[v_thumb]".into(),
        "-f".into(),
        "image2".into(),
        "-update".into(),
        "1".into(),
        "-y".into(),
        snapshot_path.to_string(),
    ]);

    // Build the redacted copy: any arg that contains an rtmp(s) URL has its key
    // path-segment swapped for `***`. We redact per pushable key so a key that
    // also appears verbatim in stderr could be scrubbed by the same helper.
    let loggable = redact_keys(&args, &pushable);

    Ok(StreamArgs { args, loggable })
}

/// Replace every pushable destination's stream key in `args` with `***`, so the
/// argv can be logged without leaking a key. Operates on the already-joined URL
/// so it scrubs both the single-`flv` form and each `tee` segment.
fn redact_keys(args: &[String], pushable: &[&StreamDestination]) -> Vec<String> {
    args.iter()
        .map(|a| {
            let mut s = a.clone();
            for d in pushable {
                let enc = percent_encode_segment(&d.stream_key);
                if !enc.is_empty() {
                    s = s.replace(&enc, "***");
                }
            }
            s
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dest(id: &str, url: &str, key: &str, enabled: bool) -> StreamDestination {
        StreamDestination {
            id: id.into(),
            name: id.into(),
            rtmp_url: url.into(),
            stream_key: key.into(),
            enabled,
        }
    }

    fn opts(dests: Vec<StreamDestination>) -> StreamOptions {
        StreamOptions {
            resolution: StreamResolution::P720,
            framerate: 30,
            video_bitrate_kbps: None,
            audio_bitrate_kbps: None,
            destinations: dests,
            also_record_path: None,
        }
    }

    // ── resolution table ──
    #[test]
    fn resolution_table_matches_electron() {
        assert_eq!(StreamResolution::P480.width(), 854);
        assert_eq!(StreamResolution::P480.height(), 480);
        assert_eq!(StreamResolution::P480.auto_bitrate_kbps(), 1500);
        assert_eq!(StreamResolution::P720.width(), 1280);
        assert_eq!(StreamResolution::P720.auto_bitrate_kbps(), 4500);
        assert_eq!(StreamResolution::P1080.height(), 1080);
        assert_eq!(StreamResolution::P1080.auto_bitrate_kbps(), 6000);
    }

    // ── bitrate defaults ──
    #[test]
    fn bitrate_defaults_fall_back_to_table_and_128() {
        let o = opts(vec![]);
        assert_eq!(o.video_bitrate(), 4500);
        assert_eq!(o.audio_bitrate(), 128);
    }

    #[test]
    fn explicit_bitrates_win() {
        let mut o = opts(vec![]);
        o.video_bitrate_kbps = Some(3000);
        o.audio_bitrate_kbps = Some(96);
        assert_eq!(o.video_bitrate(), 3000);
        assert_eq!(o.audio_bitrate(), 96);
    }

    #[test]
    fn record_bitrate_is_video_times_1_6() {
        let mut o = opts(vec![]);
        o.video_bitrate_kbps = Some(5000);
        assert_eq!(o.record_bitrate(), 8000);
    }

    // ── pushable filter ──
    #[test]
    fn pushable_requires_enabled_url_and_key() {
        assert!(dest("a", "rtmp://x/live", "key123", true).is_pushable());
        assert!(!dest("a", "rtmp://x/live", "key123", false).is_pushable());
        assert!(!dest("a", "", "key123", true).is_pushable());
        assert!(!dest("a", "rtmp://x/live", "", true).is_pushable());
        assert!(!dest("a", "rtmp://x/live", "   ", true).is_pushable());
    }

    // ── key validation ──
    #[test]
    fn validate_key_rejects_empty_and_blank() {
        assert_eq!(validate_stream_key(""), Err(StreamKeyError::Empty));
        assert_eq!(validate_stream_key("   "), Err(StreamKeyError::Empty));
    }

    #[test]
    fn validate_key_rejects_internal_whitespace_and_control() {
        assert_eq!(
            validate_stream_key("abcd efgh"),
            Err(StreamKeyError::HasWhitespace)
        );
        assert_eq!(
            validate_stream_key("abcd\nefgh"),
            Err(StreamKeyError::HasWhitespace)
        );
    }

    #[test]
    fn validate_key_rejects_too_short() {
        assert_eq!(validate_stream_key("ab"), Err(StreamKeyError::TooShort));
    }

    #[test]
    fn validate_key_accepts_realistic_keys() {
        assert!(validate_stream_key("xxxx-xxxx-xxxx-xxxx").is_ok());
        assert!(validate_stream_key("live_123456789_abcDEF").is_ok());
    }

    // ── rtmp url validation ──
    #[test]
    fn validate_url_accepts_rtmp_and_rtmps() {
        assert!(validate_rtmp_url("rtmp://a.rtmp.youtube.com/live2").is_ok());
        assert!(validate_rtmp_url("rtmps://live-api.facebook.com:443/rtmp").is_ok());
    }

    #[test]
    fn validate_url_rejects_bad_scheme_and_empty_host() {
        assert_eq!(
            validate_rtmp_url("https://example.com"),
            Err(StreamKeyError::BadScheme)
        );
        assert_eq!(validate_rtmp_url("rtmp://"), Err(StreamKeyError::BadScheme));
        assert_eq!(validate_rtmp_url(""), Err(StreamKeyError::BadScheme));
    }

    // ── url joining + encoding ──
    #[test]
    fn joined_url_trims_trailing_slashes_and_encodes_key() {
        assert_eq!(
            joined_rtmp_url("rtmp://a.rtmp.youtube.com/live2/", "ab-cd"),
            "rtmp://a.rtmp.youtube.com/live2/ab-cd"
        );
        // A space in a key (paste artefact that slipped validation upstream) is
        // percent-encoded, not left raw in the argv.
        assert_eq!(
            joined_rtmp_url("rtmp://x/live", "a b"),
            "rtmp://x/live/a%20b"
        );
        // Slash inside a key is encoded so it can't escape the path segment.
        assert_eq!(joined_rtmp_url("rtmp://x/live", "a/b"), "rtmp://x/live/a%2Fb");
    }

    #[test]
    fn percent_encode_leaves_unreserved_untouched() {
        assert_eq!(percent_encode_segment("aZ09-._~"), "aZ09-._~");
    }

    // ── output args: single destination ──
    #[test]
    fn single_destination_uses_flv_not_tee() {
        let o = opts(vec![dest("yt", "rtmp://x/live2", "secretkey", true)]);
        let built =
            build_output_args(&o, "/tmp/preview.jpg", AudioInputLayout::BundledInputZero, 0, "0:v", "")
                .unwrap();
        let joined = built.args.join(" ");
        assert!(joined.contains("-f flv rtmp://x/live2/secretkey"));
        assert!(!joined.contains("tee"));
        // GOP = fps × 2.
        assert!(joined.contains("-g 60"));
        assert!(joined.contains("-keyint_min 60"));
        // bufsize = bitrate × 2 (720p auto = 4500).
        assert!(joined.contains("-b:v 4500k"));
        assert!(joined.contains("-bufsize 9000k"));
        // bundled audio map.
        assert!(joined.contains("-map [v_stream] -map 0:a?"));
        // 2-branch split (no local recording).
        assert!(joined.contains("[0:v]split=2[v_stream][v_pre]"));
        assert!(joined.contains("[v_pre]fps=1/2,scale=320:-1[v_thumb]"));
        // preview snapshot output.
        assert!(joined.contains("-map [v_thumb] -f image2 -update 1 -y /tmp/preview.jpg"));
    }

    // ── output args: multi destination tee ──
    #[test]
    fn multi_destination_builds_tee_with_onfail_ignore() {
        let o = opts(vec![
            dest("yt", "rtmp://a.youtube/live2", "ytkey", true),
            dest("fb", "rtmp://b.facebook/rtmp", "fbkey", true),
            dest("off", "rtmp://c/live", "ckey", false),
        ]);
        let built =
            build_output_args(&o, "/tmp/p.jpg", AudioInputLayout::BundledInputZero, 0, "0:v", "")
                .unwrap();
        let joined = built.args.join(" ");
        assert!(joined.contains("-f tee"));
        // Both enabled destinations present with onfail=ignore; disabled one absent.
        assert!(joined.contains(
            "[f=flv:onfail=ignore]rtmp://a.youtube/live2/ytkey|[f=flv:onfail=ignore]rtmp://b.facebook/rtmp/fbkey"
        ));
        assert!(!joined.contains("ckey"));
    }

    #[test]
    fn no_pushable_destinations_is_an_error() {
        let o = opts(vec![dest("off", "rtmp://x/live", "key123", false)]);
        let err = build_output_args(&o, "/tmp/p.jpg", AudioInputLayout::BundledInputZero, 0, "0:v", "")
            .unwrap_err();
        assert_eq!(err, StreamArgError::NoDestinations);
    }

    // ── windows audio map shifts past overlays ──
    #[test]
    fn windows_audio_map_shifts_past_overlay_inputs() {
        let o = opts(vec![dest("yt", "rtmp://x/live", "secretkey", true)]);
        // 2 overlays → audio input index is 1 + 2 = 3.
        let built = build_output_args(
            &o,
            "/tmp/p.jpg",
            AudioInputLayout::SeparateAfterOverlays,
            2,
            "vov1",
            "[1:v]scale=100:-2[ov1];[0:v][ov1]overlay=0:0[vov0];[vov0][ov2]overlay=0:0[vov1]",
        )
        .unwrap();
        let joined = built.args.join(" ");
        assert!(joined.contains("-map [v_stream] -map 3:a?"));
        // overlay chain is prepended into filter_complex before the split.
        assert!(joined.contains("[vov1]split=2[v_stream][v_pre]"));
        assert!(joined.contains("overlay=0:0[vov1]"));
    }

    // ── also-record adds a 3-way split + local mp4 branch ──
    #[test]
    fn also_record_adds_three_way_split_and_mp4_branch() {
        let mut o = opts(vec![dest("yt", "rtmp://x/live", "secretkey", true)]);
        o.also_record_path = Some("/recordings/live.mp4".into());
        o.video_bitrate_kbps = Some(5000);
        let built = build_output_args(
            &o,
            "/tmp/p.jpg",
            AudioInputLayout::BundledInputZero,
            0,
            "0:v",
            "",
        )
        .unwrap();
        let joined = built.args.join(" ");
        assert!(joined.contains("[0:v]split=3[v_stream][v_rec][v_pre]"));
        // local mp4 branch: record bitrate 5000 × 1.6 = 8000, faststart, 48k audio.
        assert!(joined.contains("-map [v_rec] -map 0:a?"));
        assert!(joined.contains("-b:v 8000k"));
        assert!(joined.contains("-bufsize 16000k"));
        assert!(joined.contains("-movflags +faststart -y /recordings/live.mp4"));
        assert!(joined.contains("-ar 48000"));
    }

    // ── loggable copy never leaks keys ──
    #[test]
    fn loggable_args_redact_every_stream_key() {
        let o = opts(vec![
            dest("yt", "rtmp://a/live", "ytsupersecret", true),
            dest("fb", "rtmp://b/rtmp", "fbsupersecret", true),
        ]);
        let built =
            build_output_args(&o, "/tmp/p.jpg", AudioInputLayout::BundledInputZero, 0, "0:v", "")
                .unwrap();
        let logline = built.loggable.join(" ");
        assert!(!logline.contains("ytsupersecret"));
        assert!(!logline.contains("fbsupersecret"));
        assert!(logline.contains("rtmp://a/live/***"));
        assert!(logline.contains("rtmp://b/rtmp/***"));
        // The REAL args still carry the keys (so the spawn works).
        let realline = built.args.join(" ");
        assert!(realline.contains("ytsupersecret"));
    }
}
