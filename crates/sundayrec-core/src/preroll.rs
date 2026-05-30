//! Pre-roll buffer: the rolling-capture / harvest-trim decision mat (Fase 3.2).
//!
//! Pre-roll captures the last N seconds *before* the user presses record, so a
//! manual recording can include audio from before the button press (the organ's
//! first chord, the opening word). The `src-tauri` engine runs a continuous
//! 90-second WAV capture loop; when recording starts it **harvests** that
//! segment — stops the capture, measures how long it actually ran, and trims it
//! to the requested window — then prepends the trimmed audio to the recording.
//!
//! Ported from the Electron `src/main/preroll.ts`:
//!   - the 90-second per-segment cap (`-t 90`, [`PREROLL_SEGMENT_CAP_S`]),
//!   - the 300 ms harvest safety margin ([`HARVEST_SAFETY_MARGIN_MS`]),
//!   - the < 4096-byte "nothing captured" guard ([`MIN_VALID_SEGMENT_BYTES`]),
//!   - the ~200 ms auto-restart gap after the natural 90 s cap
//!     ([`RESTART_GAP_MS`]),
//!   - the `trim = min(requested, captured - 300)` clamp and its `trim <= 0`
//!     guard ([`harvest_trim_ms`]),
//!   - the exponential capture-loop retry back-off ([`preroll_restart_delay`]).
//!
//! As with the rest of the core, this module models only the *decisions* — every
//! rule is deterministic and unit-tested. The `src-tauri` layer turns these
//! verdicts into real ffmpeg captures, temp files and tokio sleeps.

/// Cap each capture segment at 90 seconds (`ffmpeg -t 90`). A WAV at 48 kHz
/// stereo is ~16 MB for 90 s — bounding the temp file while still covering any
/// realistic pre-roll window (the setting clamps to ≤ 60 s). On the natural exit
/// at this cap the host auto-restarts the loop after [`RESTART_GAP_MS`].
pub const PREROLL_SEGMENT_CAP_S: u32 = 90;

/// Safety margin (ms) left at the END of the captured segment when trimming. The
/// capture device may not have flushed its last buffer when we stop the process,
/// so we never trust the final 300 ms — mirrors the Electron `capturedMs - 300`.
pub const HARVEST_SAFETY_MARGIN_MS: u64 = 300;

/// Minimum byte count for a captured segment to be considered usable. Below this
/// the file is just a WAV header (or an empty/aborted capture) with no real
/// audio — the Electron `stat.size < 4096` guard.
pub const MIN_VALID_SEGMENT_BYTES: u64 = 4096;

/// Gap (ms) before auto-restarting the capture loop after a segment ends — both
/// the natural 90 s cap and an unexpected exit. Mirrors the Electron
/// `setTimeout(..., 200)` in the `proc.on('close')` handler. On macOS only one
/// process can own AVFoundation at a time, so a small gap lets the device be
/// released and reacquired cleanly.
pub const RESTART_GAP_MS: u64 = 200;

/// Decide how many milliseconds of the captured segment to keep when harvesting.
///
/// Direct port of the Electron `harvest()` (`preroll.ts:116`):
///   - `segment_bytes < MIN_VALID_SEGMENT_BYTES` → `None` (nothing real captured),
///   - otherwise `trim = min(requested_seconds * 1000, captured_ms - 300)`,
///   - `trim <= 0` → `None` (the capture is shorter than the safety margin, e.g.
///     it had only just started when record was pressed).
///
/// On success returns `Some(trim_ms)` — the host keeps the LAST `trim_ms` of the
/// segment (the most recent audio, ending at the record button press).
///
/// `captured_ms` is `now - capture_start`, NOT the requested window — a capture
/// that only ran 4 s can yield at most ~3.7 s no matter what the user requested.
pub fn harvest_trim_ms(
    captured_ms: u64,
    requested_seconds: u32,
    segment_bytes: u64,
) -> Option<u64> {
    if segment_bytes < MIN_VALID_SEGMENT_BYTES {
        return None;
    }
    let requested_ms = u64::from(requested_seconds) * 1_000;
    // `captured_ms - 300`, guarded so a capture shorter than the margin yields 0
    // (→ None below) rather than wrapping around on unsigned subtraction.
    let usable_ms = captured_ms.saturating_sub(HARVEST_SAFETY_MARGIN_MS);
    let trim = requested_ms.min(usable_ms);
    if trim == 0 {
        None
    } else {
        Some(trim)
    }
}

/// Where (ms from the start of the captured segment) the kept window begins, for
/// ffmpeg's `-ss`. We keep the LAST `trim_ms`, so trimming starts at
/// `captured_ms - trim_ms`. `harvest_trim_ms` guarantees `trim_ms` never exceeds
/// `captured_ms - 300`, so this never underflows; the `saturating_sub` is
/// defensive against a caller passing an inconsistent pair.
pub fn preroll_start_offset_ms(captured_ms: u64, trim_ms: u64) -> u64 {
    captured_ms.saturating_sub(trim_ms)
}

/// Build the ffmpeg arguments for ONE rolling pre-roll capture segment.
///
/// A pre-roll segment is **audio-only, raw PCM WAV** (`pcm_s16le`) capped at
/// [`PREROLL_SEGMENT_CAP_S`] seconds — exactly the Electron `startLoop` args
/// (`preroll.ts:80`). WAV/PCM is chosen deliberately: it has a fixed,
/// position-addressable layout so the later `-ss`/`-t` trim is sample-accurate
/// and cheap (no decode), and pre-roll never needs video.
///
/// `audio_device`:
///   - macOS: the avfoundation audio **index** as a string → input `":<idx>"`.
///   - Windows: the dshow audio device **name** → input `"audio=<name>"`.
///
/// `output_path` (a temp WAV) is always the final argument. `-y` overwrites.
pub fn build_preroll_capture_args(
    platform: crate::ffmpeg::Platform,
    audio_device: &str,
    sample_rate: u32,
    channels: u8,
    output_path: &str,
) -> Vec<String> {
    use crate::ffmpeg::Platform;
    let mut args: Vec<String> = vec!["-hide_banner".into()];
    match platform {
        Platform::MacOS | Platform::Linux => {
            // avfoundation audio-only input is ":<audioIdx>".
            args.push("-f".into());
            args.push("avfoundation".into());
            args.push("-i".into());
            args.push(format!(":{audio_device}"));
        }
        Platform::Windows => {
            args.push("-f".into());
            args.push("dshow".into());
            args.push("-i".into());
            args.push(format!("audio={audio_device}"));
        }
    }
    args.push("-ar".into());
    args.push(sample_rate.to_string());
    args.push("-ac".into());
    args.push(channels.to_string());
    args.push("-c:a".into());
    args.push("pcm_s16le".into());
    // Cap the segment length so the temp WAV stays bounded; the host auto-restarts
    // the loop when ffmpeg exits at this cap.
    args.push("-t".into());
    args.push(PREROLL_SEGMENT_CAP_S.to_string());
    args.push("-y".into());
    args.push(output_path.into());
    args
}

/// Build the ffmpeg arguments that TRIM a harvested pre-roll segment to the kept
/// window: seek `start_offset_ms` into the raw WAV and keep `trim_ms` of audio,
/// **re-encoding to the recording's own audio codec** so the trimmed clip can be
/// concatenated in front of the recording with a lossless `-c copy` (Fase 3.3a).
///
/// `audio_codec` MUST match the recording's audio codec (the unified recorder
/// uses `aac`), and `output_path` MUST carry the recording's container extension
/// — then the F3.3a concat is a true stream-copy of the (untouched) main
/// recording, and only the short pre-roll clip is ever re-encoded.
///
/// `-ss` BEFORE `-i` is an (accurate, for WAV) input seek; `-t` bounds the
/// output duration. `-ss`/`-t` are given in seconds (with millisecond
/// precision) — ffmpeg accepts fractional seconds.
pub fn build_preroll_trim_args(
    raw_path: &str,
    start_offset_ms: u64,
    trim_ms: u64,
    sample_rate: u32,
    channels: u8,
    audio_codec: &str,
    output_path: &str,
) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        // Accurate input seek to the start of the kept window.
        "-ss".into(),
        ms_to_seconds_string(start_offset_ms),
        "-i".into(),
        raw_path.into(),
        "-t".into(),
        ms_to_seconds_string(trim_ms),
        // Match the recording's codec so the later concat is `-c copy`.
        "-c:a".into(),
        audio_codec.into(),
        "-b:a".into(),
        "192k".into(),
        "-ar".into(),
        sample_rate.to_string(),
        "-ac".into(),
        channels.to_string(),
        "-avoid_negative_ts".into(),
        "make_zero".into(),
        "-y".into(),
        output_path.into(),
    ]
}

/// Format a millisecond duration as a seconds string with millisecond precision
/// (e.g. `9700` → `"9.700"`), the form ffmpeg's `-ss`/`-t` accept.
fn ms_to_seconds_string(ms: u64) -> String {
    format!("{}.{:03}", ms / 1_000, ms % 1_000)
}

/// Back-off (milliseconds) before capture-loop restart `attempt` (0-based) when
/// the device could not be resolved / opened.
///
/// Port of the Electron `retryDelay` (`preroll.ts:46`):
/// `min(5000 * 2^attempt, 60000)` — `5s → 10s → 20s → 40s → 60s (cap)`. This is
/// the *error* back-off; the ordinary natural-90s-cap restart uses the short
/// [`RESTART_GAP_MS`] instead. Pre-roll is best-effort background work, so the
/// schedule is deliberately slow — a missing device must not busy-spin ffmpeg.
///
/// (Distinct from [`crate::reconnect::reconnect_delay`], which is the *recording*
/// watchdog's faster linear ramp; pre-roll is non-critical so it backs off much
/// harder.)
pub fn preroll_restart_delay(attempt: u32) -> u64 {
    // `5000 * 2^attempt` can overflow for large `attempt`; compute the doubling
    // with a checked shift and saturate to the 60 s cap on overflow.
    let scaled = 5_000u64.checked_shl(attempt).unwrap_or(u64::MAX);
    scaled.min(60_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_electron() {
        assert_eq!(PREROLL_SEGMENT_CAP_S, 90);
        assert_eq!(HARVEST_SAFETY_MARGIN_MS, 300);
        assert_eq!(MIN_VALID_SEGMENT_BYTES, 4096);
        assert_eq!(RESTART_GAP_MS, 200);
    }

    #[test]
    fn trim_clamped_to_requested_when_capture_is_long() {
        // Captured a full 90 s; user wants 15 s → keep 15 s (15000 ms), well
        // under captured-300.
        assert_eq!(harvest_trim_ms(90_000, 15, 16_000_000), Some(15_000));
    }

    #[test]
    fn trim_clamped_to_captured_minus_margin() {
        // User wants 30 s but the capture only ran 10 s → keep 10000-300 = 9700.
        assert_eq!(harvest_trim_ms(10_000, 30, 2_000_000), Some(9_700));
    }

    #[test]
    fn too_small_segment_yields_none() {
        // Below the 4096-byte threshold: just a header / aborted capture.
        assert_eq!(harvest_trim_ms(90_000, 15, 0), None);
        assert_eq!(harvest_trim_ms(90_000, 15, 4_095), None);
        // Exactly the threshold IS valid (>= 4096).
        assert!(harvest_trim_ms(90_000, 15, 4_096).is_some());
    }

    #[test]
    fn short_capture_below_margin_yields_none() {
        // Capture ran only 250 ms — less than the 300 ms safety margin → trim 0 → None.
        assert_eq!(harvest_trim_ms(250, 15, 8_000), None);
        // Exactly the margin → usable 0 → None.
        assert_eq!(harvest_trim_ms(300, 15, 8_000), None);
        // Just over the margin → tiny but valid window.
        assert_eq!(harvest_trim_ms(301, 15, 8_000), Some(1));
    }

    #[test]
    fn requested_15_vs_30_seconds() {
        // Same long capture, different requests → the request is the limiter.
        assert_eq!(harvest_trim_ms(90_000, 15, 16_000_000), Some(15_000));
        assert_eq!(harvest_trim_ms(90_000, 30, 16_000_000), Some(30_000));
    }

    #[test]
    fn start_offset_is_captured_minus_trim() {
        // Keep the LAST 15 s of a 90 s capture → start 75 s in.
        assert_eq!(preroll_start_offset_ms(90_000, 15_000), 75_000);
        // Keep everything usable from a 10 s capture (9700 ms) → start 300 ms in.
        assert_eq!(preroll_start_offset_ms(10_000, 9_700), 300);
    }

    #[test]
    fn start_offset_for_a_real_harvest_pair() {
        // The offset is always derived from the SAME captured_ms the trim used.
        let captured = 42_000;
        let trim = harvest_trim_ms(captured, 30, 8_000_000).unwrap();
        assert_eq!(trim, 30_000); // 30 s requested < captured-300
        assert_eq!(preroll_start_offset_ms(captured, trim), 12_000);
    }

    #[test]
    fn start_offset_never_underflows_on_inconsistent_input() {
        // Defensive: trim larger than captured saturates to 0, never panics.
        assert_eq!(preroll_start_offset_ms(1_000, 5_000), 0);
    }

    #[test]
    fn capture_args_mac_audio_only_wav() {
        use crate::ffmpeg::Platform;
        let args = build_preroll_capture_args(Platform::MacOS, "1", 48_000, 2, "/tmp/pre.wav");
        assert!(args.windows(2).any(|w| w == ["-f", "avfoundation"]));
        assert!(args.iter().any(|a| a == ":1"), "audio-only input :1");
        assert!(args.windows(2).any(|w| w == ["-c:a", "pcm_s16le"]));
        assert!(args.windows(2).any(|w| w == ["-t", "90"]), "90 s cap");
        assert!(args.windows(2).any(|w| w == ["-ar", "48000"]));
        assert!(args.windows(2).any(|w| w == ["-ac", "2"]));
        assert_eq!(args.last().unwrap(), "/tmp/pre.wav");
        // No video codec — pre-roll is audio-only.
        assert!(!args.iter().any(|a| a == "-c:v"));
    }

    #[test]
    fn capture_args_windows_named_device() {
        use crate::ffmpeg::Platform;
        let args = build_preroll_capture_args(
            Platform::Windows,
            "Soundcraft USB Audio",
            44_100,
            1,
            "C:/t/pre.wav",
        );
        assert!(args.windows(2).any(|w| w == ["-f", "dshow"]));
        assert!(args.iter().any(|a| a == "audio=Soundcraft USB Audio"));
        assert!(args.windows(2).any(|w| w == ["-ar", "44100"]));
        assert!(args.windows(2).any(|w| w == ["-ac", "1"]));
        assert!(args.windows(2).any(|w| w == ["-t", "90"]));
    }

    #[test]
    fn trim_args_seek_and_duration() {
        // Keep 15 s starting 75 s into the raw capture.
        let args = build_preroll_trim_args(
            "/tmp/pre.wav",
            75_000,
            15_000,
            48_000,
            2,
            "aac",
            "/tmp/pre.m4a",
        );
        // -ss BEFORE -i (input seek).
        let ss = args.iter().position(|a| a == "-ss").unwrap();
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert!(ss < i, "-ss must precede -i");
        assert_eq!(args[ss + 1], "75.000");
        let t = args.iter().position(|a| a == "-t").unwrap();
        assert_eq!(args[t + 1], "15.000");
        assert!(args.windows(2).any(|w| w == ["-c:a", "aac"]));
        assert_eq!(args.last().unwrap(), "/tmp/pre.m4a");
    }

    #[test]
    fn trim_args_use_the_passed_codec_for_concat_copy() {
        // The codec must be threaded through so the clip matches the recording's
        // codec → the F3.3a concat is a lossless `-c copy`.
        let args =
            build_preroll_trim_args("/tmp/pre.wav", 0, 5_000, 44_100, 1, "aac", "/tmp/pre.mp4");
        assert!(args.windows(2).any(|w| w == ["-c:a", "aac"]));
        assert!(args.windows(2).any(|w| w == ["-ar", "44100"]));
        assert!(args.windows(2).any(|w| w == ["-ac", "1"]));
        assert_eq!(args.last().unwrap(), "/tmp/pre.mp4");
    }

    #[test]
    fn ms_seconds_formatting_keeps_millis() {
        assert_eq!(ms_to_seconds_string(9_700), "9.700");
        assert_eq!(ms_to_seconds_string(75_000), "75.000");
        assert_eq!(ms_to_seconds_string(1), "0.001");
        assert_eq!(ms_to_seconds_string(0), "0.000");
    }

    #[test]
    fn restart_delay_matches_electron_schedule() {
        assert_eq!(preroll_restart_delay(0), 5_000);
        assert_eq!(preroll_restart_delay(1), 10_000);
        assert_eq!(preroll_restart_delay(2), 20_000);
        assert_eq!(preroll_restart_delay(3), 40_000);
    }

    #[test]
    fn restart_delay_caps_at_sixty_seconds() {
        // attempt 4 → 80000 → capped to 60000, and stays there.
        assert_eq!(preroll_restart_delay(4), 60_000);
        assert_eq!(preroll_restart_delay(5), 60_000);
        assert_eq!(preroll_restart_delay(20), 60_000);
        // Huge attempt must not panic (overflow → saturates to the cap).
        assert_eq!(preroll_restart_delay(1_000), 60_000);
    }
}
