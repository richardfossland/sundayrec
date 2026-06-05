//! Pure parser for the per-channel peak-level telemetry that ffmpeg's `astats`
//! filter prints to stderr.
//!
//! WHY: the "Opptaksmodus" UI shows live L/R level meters. Instead of opening a
//! second audio stream (which would grab the mic twice), the recorder's OWN
//! ffmpeg carries an `astats` pass-through filter
//! ([`crate::ffmpeg::build_levels_detect_filter`]) that emits periodic
//! per-channel peak levels to stderr. This module turns those stderr blocks into
//! a small [`ChannelLevels`] value the engine forwards to the renderer.
//!
//! ## What astats stderr looks like
//!
//! With `metadata=1` + a periodic `reset`, astats prints a block per measurement
//! window. Each channel gets a `Channel: N` header followed by its measurements,
//! e.g. (the `@ 0x…` is an ffmpeg pointer address — noise we ignore):
//!
//! ```text
//! [Parsed_astats_0 @ 0x7f8b1c00] Channel: 1
//! [Parsed_astats_0 @ 0x7f8b1c00] Peak level dB: -12.500000
//! [Parsed_astats_0 @ 0x7f8b1c00] Channel: 2
//! [Parsed_astats_0 @ 0x7f8b1c00] Peak level dB: -9.300000
//! ```
//!
//! Mono audio prints a single `Channel: 1` block. A fully-silent buffer prints
//! `Peak level dB: -inf` (or sometimes `nan`).
//!
//! This is a **per-chunk** parser: feed it whatever text you have (a single
//! stderr line, or a multi-line blob) and it returns the peaks it can extract
//! from THAT chunk, or `None` if the chunk carries no `Peak level dB:` line.

/// The latest per-channel peak levels, in dBFS (always ≤ 0 in normal use).
///
/// `peak_db_right` is `None` for mono sources (one channel only). A
/// fully-silent / non-finite reading is mapped to [`SILENCE_FLOOR_DB`] so the
/// UI shows a pinned-low meter rather than `-inf`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChannelLevels {
    /// Peak level (dBFS) of channel 1 (left / the only channel on mono).
    pub peak_db_left: f64,
    /// Peak level (dBFS) of channel 2 (right), or `None` when the source is mono.
    pub peak_db_right: Option<f64>,
}

/// Floor used for `-inf` / `nan` / non-finite peak readings. Chosen well below
/// the meter's usable range so it reads as "silent" without being `-inf` (which
/// the UI's `formatDbfs` would render as `−∞`, but a numeric floor keeps the
/// segment math finite and steady).
pub const SILENCE_FLOOR_DB: f64 = -120.0;

const CHANNEL_MARKER: &str = "Channel:";
const PEAK_MARKER: &str = "Peak level dB:";

/// Parse a chunk of `astats` stderr into [`ChannelLevels`].
///
/// Tracks the current `Channel: N` header and assigns each following
/// `Peak level dB:` value to channel 1 (left) or 2 (right). Channels beyond 2
/// are ignored (the meters are stereo). Tolerant of the `@ 0x…` address noise
/// and arbitrary surrounding whitespace.
///
/// Returns `None` when the chunk contains no `Peak level dB:` line at all (so a
/// pure progress / silence / unrelated chunk is cleanly rejected).
pub fn parse_levels(chunk: &str) -> Option<ChannelLevels> {
    let mut current_channel: Option<u32> = None;
    let mut left: Option<f64> = None;
    let mut right: Option<f64> = None;
    let mut saw_peak = false;

    for line in chunk.lines() {
        if let Some(ch) = parse_channel_header(line) {
            current_channel = Some(ch);
            continue;
        }
        if let Some(db) = parse_peak_db(line) {
            saw_peak = true;
            // A Peak line with no preceding Channel header (mono astats can omit
            // it in some builds) is treated as channel 1.
            match current_channel.unwrap_or(1) {
                1 => left = Some(db),
                2 => right = Some(db),
                _ => {} // ignore >2 channels; the meters are stereo
            }
        }
    }

    if !saw_peak {
        return None;
    }

    Some(ChannelLevels {
        // If we saw a peak line at all, `left` is set (a Peak with no Channel
        // header defaults to channel 1); fall back to the floor defensively.
        peak_db_left: left.unwrap_or(SILENCE_FLOOR_DB),
        peak_db_right: right,
    })
}

/// Parse ONE `ametadata=mode=print` line into `(channel, dBFS)`.
///
/// WHY a second parser: the live meter is driven by ffmpeg's `ametadata` print
/// (see [`crate::ffmpeg::build_levels_detect_filter`]), which emits one line PER
/// CHANNEL PER FRAME — a flat `key=value`, NOT the multi-line `Channel:` /
/// `Peak level dB:` block [`parse_levels`] consumes. The lines look like:
///
/// ```text
/// lavfi.astats.1.Peak_level=-12.500000     // channel 1 = left
/// lavfi.astats.2.Peak_level=-9.300000      // channel 2 = right
/// lavfi.astats.Overall.Peak_level=-9.300000   // ignored (we meter per-channel)
/// ```
///
/// Returns `None` for any line that is not a per-channel `Peak_level` reading
/// (the interleaved `frame:N`/`pts_time:` headers, the `Overall` rollup, and all
/// unrelated stderr noise). `-inf` / `nan` / non-finite values map to
/// [`SILENCE_FLOOR_DB`] so a silent buffer reads as a pinned-low meter, never
/// `-inf`.
pub fn parse_ametadata_peak(line: &str) -> Option<(u8, f64)> {
    // `lavfi.astats.<chan>.Peak_level=<value>` — tolerate leading whitespace and
    // any `[…]` prefix ffmpeg may attach by scanning to the marker.
    let marker = "lavfi.astats.";
    let start = line.find(marker)? + marker.len();
    let rest = &line[start..];
    let (chan_str, after) = rest.split_once('.')?;
    // "Overall" (the rollup) fails the u8 parse → `?` returns None → skipped.
    let chan: u8 = chan_str.parse().ok()?;
    let value = after.strip_prefix("Peak_level=")?;
    Some((chan, parse_db_token(value)))
}

/// Map a raw dB token (`-12.5`, `-inf`, `nan`, `inf`) to a finite dBFS value,
/// flooring any non-finite reading at [`SILENCE_FLOOR_DB`].
fn parse_db_token(token: &str) -> f64 {
    let t = token.trim().to_ascii_lowercase();
    if t.contains("inf") || t.contains("nan") {
        return SILENCE_FLOOR_DB;
    }
    match t.parse::<f64>() {
        Ok(v) if v.is_finite() => v,
        _ => SILENCE_FLOOR_DB,
    }
}

/// Parse the file-wide **noise floor** (dBFS) from an astats summary, used to
/// pick a one-click processing preset (clean vs noisy recording). astats prints
/// `Noise floor dB: <value>` per-channel and once in its `Overall` block; the
/// Overall block is printed LAST, so we return the value from the LAST matching
/// line. `-inf`/`nan` and non-finite tokens are ignored (return `None`), as is a
/// summary with no noise-floor line at all.
pub fn parse_noise_floor_db(stderr: &str) -> Option<f64> {
    const MARKER: &str = "Noise floor dB:";
    let mut last: Option<f64> = None;
    for line in stderr.lines() {
        if let Some(idx) = line.find(MARKER) {
            let tail = line[idx + MARKER.len()..].trim();
            let token: String = tail
                .chars()
                .take_while(|c| !c.is_whitespace())
                .collect::<String>()
                .to_ascii_lowercase();
            if token.contains("inf") || token.contains("nan") {
                continue;
            }
            if let Ok(v) = token.parse::<f64>() {
                if v.is_finite() {
                    last = Some(v);
                }
            }
        }
    }
    last
}

/// Extract `N` from a `… Channel: N` line, ignoring address noise / whitespace.
fn parse_channel_header(line: &str) -> Option<u32> {
    let idx = line.find(CHANNEL_MARKER)?;
    let tail = line[idx + CHANNEL_MARKER.len()..].trim();
    // Leading digits only (e.g. "1" from "1 (FL)" should that ever appear).
    let token: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
    token.parse::<u32>().ok()
}

/// Extract the dB value from a `… Peak level dB: <value>` line. `-inf`, `nan` and
/// any other non-finite token map to [`SILENCE_FLOOR_DB`].
fn parse_peak_db(line: &str) -> Option<f64> {
    let idx = line.find(PEAK_MARKER)?;
    let tail = line[idx + PEAK_MARKER.len()..].trim();
    // The numeric token may carry a trailing unit/word ("-inf dB"); take the
    // leading value token.
    let token: String = tail
        .chars()
        .take_while(|c| !c.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase();
    if token.is_empty() {
        return None;
    }
    // Explicit infinities / nan → floor.
    if token.contains("inf") || token.contains("nan") {
        return Some(SILENCE_FLOOR_DB);
    }
    match token.parse::<f64>() {
        Ok(v) if v.is_finite() => Some(v),
        _ => Some(SILENCE_FLOOR_DB),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ametadata_parses_left_and_right_channels() {
        assert_eq!(
            parse_ametadata_peak("lavfi.astats.1.Peak_level=-12.500000"),
            Some((1, -12.5))
        );
        assert_eq!(
            parse_ametadata_peak("lavfi.astats.2.Peak_level=-9.300000"),
            Some((2, -9.3))
        );
    }

    #[test]
    fn ametadata_floors_inf_and_nan() {
        assert_eq!(
            parse_ametadata_peak("lavfi.astats.1.Peak_level=-inf"),
            Some((1, SILENCE_FLOOR_DB))
        );
        assert_eq!(
            parse_ametadata_peak("lavfi.astats.2.Peak_level=nan"),
            Some((2, SILENCE_FLOOR_DB))
        );
    }

    #[test]
    fn ametadata_ignores_overall_and_non_level_lines() {
        // The `Overall` rollup is not a per-channel meter reading.
        assert_eq!(
            parse_ametadata_peak("lavfi.astats.Overall.Peak_level=-9.3"),
            None
        );
        // ametadata's interleaved frame headers carry no peak level.
        assert_eq!(
            parse_ametadata_peak("frame:42 pts:512 pts_time:0.0106667"),
            None
        );
        assert_eq!(
            parse_ametadata_peak("size=    1024kB time=00:00:05.00 bitrate=..."),
            None
        );
        assert_eq!(parse_ametadata_peak(""), None);
    }

    #[test]
    fn parses_stereo_two_channels() {
        let chunk = "\
[Parsed_astats_0 @ 0x7f8b1c00] Channel: 1
[Parsed_astats_0 @ 0x7f8b1c00] Peak level dB: -12.500000
[Parsed_astats_0 @ 0x7f8b1c00] Channel: 2
[Parsed_astats_0 @ 0x7f8b1c00] Peak level dB: -9.300000";
        let lv = parse_levels(chunk).expect("stereo levels");
        assert_eq!(lv.peak_db_left, -12.5);
        assert_eq!(lv.peak_db_right, Some(-9.3));
    }

    #[test]
    fn parses_mono_single_channel() {
        let chunk = "\
[Parsed_astats_0 @ 0xdead] Channel: 1
[Parsed_astats_0 @ 0xdead] Peak level dB: -20.000000";
        let lv = parse_levels(chunk).expect("mono levels");
        assert_eq!(lv.peak_db_left, -20.0);
        assert_eq!(lv.peak_db_right, None, "mono has no right channel");
    }

    #[test]
    fn maps_inf_to_silence_floor() {
        let chunk = "\
[Parsed_astats_0 @ 0x1] Channel: 1
[Parsed_astats_0 @ 0x1] Peak level dB: -inf
[Parsed_astats_0 @ 0x1] Channel: 2
[Parsed_astats_0 @ 0x1] Peak level dB: -inf dB";
        let lv = parse_levels(chunk).expect("silent levels still parse");
        assert_eq!(lv.peak_db_left, SILENCE_FLOOR_DB);
        assert_eq!(lv.peak_db_right, Some(SILENCE_FLOOR_DB));
    }

    #[test]
    fn maps_nan_to_silence_floor() {
        let chunk = "[Parsed_astats_0 @ 0x2] Channel: 1\n\
[Parsed_astats_0 @ 0x2] Peak level dB: nan";
        let lv = parse_levels(chunk).expect("nan levels parse to floor");
        assert_eq!(lv.peak_db_left, SILENCE_FLOOR_DB);
        assert_eq!(lv.peak_db_right, None);
    }

    #[test]
    fn noise_floor_takes_last_overall_value() {
        let chunk = "\
[Parsed_astats_0 @ 0x1] Channel: 1
[Parsed_astats_0 @ 0x1] Noise floor dB: -58.2
[Parsed_astats_0 @ 0x1] Channel: 2
[Parsed_astats_0 @ 0x1] Noise floor dB: -57.9
[Parsed_astats_0 @ 0x1] Overall
[Parsed_astats_0 @ 0x1] Noise floor dB: -55.1";
        assert_eq!(parse_noise_floor_db(chunk), Some(-55.1));
    }

    #[test]
    fn noise_floor_none_when_absent_or_non_finite() {
        assert_eq!(parse_noise_floor_db("no stats here"), None);
        assert_eq!(parse_noise_floor_db("Noise floor dB: -inf"), None);
        assert_eq!(parse_noise_floor_db("Noise floor dB: nan"), None);
    }

    #[test]
    fn no_astats_lines_returns_none() {
        assert!(parse_levels("size=    1024kB time=00:00:05.00 bitrate=...").is_none());
        assert!(parse_levels("").is_none());
        assert!(parse_levels("[silencedetect] silence_start: 12.3").is_none());
    }

    #[test]
    fn mixed_chunk_with_size_and_astats_parses_levels() {
        let chunk = "\
size=    2048kB time=00:00:10.00 bitrate=1677.7kbits/s
[Parsed_astats_0 @ 0x7f8b1c00] Channel: 1
[Parsed_astats_0 @ 0x7f8b1c00] Peak level dB: -6.250000
[Parsed_astats_0 @ 0x7f8b1c00] Channel: 2
[Parsed_astats_0 @ 0x7f8b1c00] Peak level dB: -7.000000
frame= 300 fps= 30";
        let lv = parse_levels(chunk).expect("levels amid noise");
        assert_eq!(lv.peak_db_left, -6.25);
        assert_eq!(lv.peak_db_right, Some(-7.0));
    }

    #[test]
    fn tolerant_of_extra_whitespace_and_address_noise() {
        let chunk = "  [Parsed_astats_0 @ 0xABCDEF12]   Channel:   1  \n\
   [Parsed_astats_0 @ 0xABCDEF12]   Peak level dB:    -3.250000   ";
        let lv = parse_levels(chunk).expect("whitespace-tolerant");
        assert_eq!(lv.peak_db_left, -3.25);
        assert_eq!(lv.peak_db_right, None);
    }
}
