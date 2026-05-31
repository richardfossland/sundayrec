//! Two-process audio+video capture fallback — pure argument builders + A/V
//! offset decision.
//!
//! ## When this path is taken
//!
//! The production recorder ([`crate::capture::build_unified_capture_args`])
//! opens the camera AND the microphone in ONE ffmpeg process. That is the ideal:
//! a single scheduler, and on macOS a single hardware clock. But some device
//! combinations can't be opened as one input (a capture card the OS won't expose
//! alongside a USB mixer, a driver that refuses the combined avfoundation spec,
//! a dshow pair ffmpeg rejects in one graph). For those, the recorder falls back
//! to **two separate ffmpeg processes** — one capturing video, one capturing
//! audio — and **muxes** them together at stop.
//!
//! This module is the pure half of that fallback (ported from the Electron
//! `unified-recorder.ts` separate-handle path + `video-recorder.ts`
//! `muxAudioVideo`): it builds the per-process capture arguments, decides the
//! A/V head-alignment from the two files' container `start_time`, and builds the
//! mux arguments. No process is spawned here — every function returns a
//! `Vec<String>` (or a small decision struct) so the argument shape and the
//! offset maths are fully unit-tested without hardware. The I/O (probing
//! `start_time`, spawning the two captures, running the mux) lives in
//! `src-tauri` (`recorder/two_process.rs`).
//!
//! ## A/V sync strategy (mirrors Electron exactly)
//!
//! Both captures use `-use_wallclock_as_timestamps 1`, so each file's container
//! `start_time` is a Unix epoch in seconds. Camera warm-up (typically 0.5–3 s)
//! shows up as a difference between the two start times. [`av_offset_decision`]
//! turns that difference into either a head-trim of the audio (audio led) or an
//! `-itsoffset` push of the audio (video led). On top of that head-alignment the
//! mux applies `aresample=async=1000:first_pts=0` so any residual sample-rate
//! drift over a 90-minute service is corrected too, and `-shortest` stops the
//! muxer when the shorter input ends (no trailing audio over a frozen frame).

use crate::ffmpeg::Platform;

/// A unified-capture startup failure dies within this many ms of session start
/// (the camera+mic were refused as one ffmpeg input). Past it, a death is a
/// genuine mid-recording disconnect that the reconnect machinery handles.
pub const STARTUP_FAILURE_MS: i64 = 3000;

/// Decide whether a failed unified capture should fall back to the two-process
/// path. True only for a VIDEO session whose FIRST segment died almost
/// immediately (`elapsed_ms < STARTUP_FAILURE_MS`) without producing output
/// (`bytes_produced == 0`) and before any reconnect — the signature of "this
/// camera+mic pair can't share one ffmpeg process". A later death, or one after
/// bytes were written, is a real disconnect (reconnect handles it), not a
/// startup incompatibility — so the two paths never fight over the same failure.
/// Pure.
pub fn should_fallback_to_two_process(
    has_video: bool,
    is_first_segment: bool,
    reconnect_count: u32,
    bytes_produced: u64,
    elapsed_ms: i64,
) -> bool {
    has_video
        && is_first_segment
        && reconnect_count == 0
        && bytes_produced == 0
        && elapsed_ms < STARTUP_FAILURE_MS
}

/// The decided A/V head-alignment for the mux step.
///
/// Exactly one of these is ever non-zero (or both zero when no/unknown offset):
///   - `trim_sec > 0` — audio started *before* video (audio led); trim that many
///     seconds off the audio head with `-ss` so it begins at the first video
///     frame.
///   - `offset_sec > 0` — video started *before* audio (video led); push the
///     audio start later by that many seconds with `-itsoffset`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AvOffset {
    /// Seconds to trim off the audio head (`-ss`), when audio led. 0 otherwise.
    pub trim_sec: f64,
    /// Seconds to delay the audio (`-itsoffset`), when video led. 0 otherwise.
    pub offset_sec: f64,
}

impl AvOffset {
    /// No head-alignment (rely on `aresample` for residual drift only).
    pub const NONE: AvOffset = AvOffset {
        trim_sec: 0.0,
        offset_sec: 0.0,
    };
}

/// Decide the A/V head-alignment from the two files' container `start_time`.
///
/// Ported EXACTLY from Electron `muxAudioVideo`:
///
/// ```text
/// raw = videoStart - audioStart        // positive ⇒ video lagged audio
/// 0.05 < raw  < 60   → trim  = raw      // audio led → trim audio head
/// -60  < raw < -0.05 → offset = -raw    // video led → push audio start
/// otherwise          → both 0           // ignore (noise, or implausible gap)
/// ```
///
/// A `None` on either input (we couldn't probe `start_time`) yields
/// [`AvOffset::NONE`] — the mux still runs and relies on `aresample` for drift.
/// The `±0.05 s` dead-zone ignores sub-frame jitter; the `±60 s` ceiling ignores
/// an implausible gap (a wrong/missing wall-clock stamp) that would otherwise
/// silently destroy sync.
pub fn av_offset_decision(audio_start_sec: Option<f64>, video_start_sec: Option<f64>) -> AvOffset {
    match (audio_start_sec, video_start_sec) {
        (Some(audio), Some(video)) => {
            let raw = video - audio; // positive ⇒ video lagged audio (audio led)
            if raw > 0.05 && raw < 60.0 {
                AvOffset {
                    trim_sec: raw,
                    offset_sec: 0.0,
                }
            } else if raw < -0.05 && raw > -60.0 {
                AvOffset {
                    trim_sec: 0.0,
                    offset_sec: -raw,
                }
            } else {
                AvOffset::NONE
            }
        }
        _ => AvOffset::NONE,
    }
}

/// Format a seconds value the way Electron does (`toFixed(3)`), so the mux args
/// are byte-comparable with the proven Electron output.
fn fixed3(v: f64) -> String {
    format!("{v:.3}")
}

/// Build the VIDEO-only capture arguments for the two-process fallback.
///
/// `video_device`:
///   - macOS: the avfoundation camera **index** as a string (e.g. `"0"`). Emitted
///     as the video-only input `"<idx>:none"` (no audio on this process).
///   - Windows: the dshow camera **name**, emitted as `video=<name>`.
///
/// `-use_wallclock_as_timestamps 1` tags the container `start_time` with the
/// capture's Unix epoch so [`av_offset_decision`] can align it against the audio
/// file. Video is encoded `libx264 -preset veryfast` (same simple encode as the
/// unified video path — the spike doesn't tune the encoder). `output_path` is
/// always the final argument.
pub fn build_video_capture_args(
    platform: Platform,
    video_device: &str,
    output_path: &str,
    framerate: u32,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-use_wallclock_as_timestamps".into(),
        "1".into(),
    ];

    match platform {
        Platform::MacOS | Platform::Linux => {
            // avfoundation video-only: "<videoIdx>:none" opens the camera with NO
            // audio device on this process (audio is the other ffmpeg).
            args.push("-f".into());
            args.push("avfoundation".into());
            args.push("-framerate".into());
            args.push(framerate.to_string());
            args.push("-i".into());
            args.push(format!("{video_device}:none"));
        }
        Platform::Windows => {
            // dshow video-only: a single video=<name> input.
            args.push("-f".into());
            args.push("dshow".into());
            args.push("-rtbufsize".into());
            args.push("200M".into());
            args.push("-framerate".into());
            args.push(framerate.to_string());
            args.push("-i".into());
            args.push(format!("video={video_device}"));
        }
    }

    // Simple H.264 encode (the spike doesn't tune the encoder).
    args.push("-c:v".into());
    args.push("libx264".into());
    args.push("-preset".into());
    args.push("veryfast".into());
    args.push("-pix_fmt".into());
    args.push("yuv420p".into());

    // Normalise leading timestamps + faststart for a directly-playable temp file.
    args.push("-avoid_negative_ts".into());
    args.push("make_zero".into());
    args.push("-movflags".into());
    args.push("+faststart".into());

    args.push("-y".into());
    args.push(output_path.into());
    args
}

/// Build the AUDIO-only capture arguments for the two-process fallback.
///
/// `audio_device`:
///   - macOS: the avfoundation audio **index** as a string (e.g. `"1"`). Emitted
///     as the audio-only input `":<idx>"` (leading colon = no video on this
///     process).
///   - Windows: the dshow audio **name**, emitted as `audio=<name>`.
///
/// Encoded AAC @ 48 kHz with the requested channel count, matching the unified
/// recorder's audio codec so the mux can `-c copy` the audio if it wanted — but
/// the mux re-encodes to AAC anyway (it has to apply `aresample`). `start_time`
/// is wall-clock-stamped for [`av_offset_decision`]. `output_path` is last.
pub fn build_audio_capture_args(
    platform: Platform,
    audio_device: &str,
    output_path: &str,
    channels: u8,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-use_wallclock_as_timestamps".into(),
        "1".into(),
    ];

    match platform {
        Platform::MacOS | Platform::Linux => {
            // avfoundation audio-only: ":<audioIdx>" (leading colon = no video).
            args.push("-f".into());
            args.push("avfoundation".into());
            args.push("-i".into());
            args.push(format!(":{audio_device}"));
        }
        Platform::Windows => {
            // dshow audio-only: a single audio=<name> input.
            args.push("-f".into());
            args.push("dshow".into());
            args.push("-rtbufsize".into());
            args.push("50M".into());
            args.push("-i".into());
            args.push(format!("audio={audio_device}"));
        }
    }

    args.push("-c:a".into());
    args.push("aac".into());
    args.push("-b:a".into());
    args.push("192k".into());
    args.push("-ar".into());
    args.push("48000".into());
    args.push("-ac".into());
    args.push(channels.to_string());

    args.push("-avoid_negative_ts".into());
    args.push("make_zero".into());

    args.push("-y".into());
    args.push(output_path.into());
    args
}

/// Build the MUX arguments — combine the separate audio + video files into one
/// MP4 with the decided head-alignment.
///
/// Ported EXACTLY from Electron `muxAudioVideo`:
///
///   - `-nostdin -hide_banner -fflags +genpts` — regenerate PTS uniformly.
///   - The optional head-alignment goes **before** the audio `-i`:
///       - audio led → `-ss <trim>` (trim the audio head),
///       - video led → `-itsoffset <offset>` (push the audio start later).
///   - `-i audio`, then `-i video`.
///   - `-map 0:a -map 1:v` (audio from input 0, video from input 1).
///   - `-c:v copy` — the video is muxed losslessly (no re-encode).
///   - `-af aresample=async=1000:first_pts=0` — correct residual drift.
///   - `-c:a aac -b:a 192k` — audio is re-encoded (it has to be, for the filter).
///   - `-avoid_negative_ts make_zero` — earliest PTS to zero after trim/offset.
///   - `-shortest` — stop at the shorter input's end (no trailing frozen frame).
///   - `-movflags +faststart -y <out>` — directly-streamable output, last.
pub fn build_mux_args(
    audio_path: &str,
    video_path: &str,
    output_path: &str,
    offset: AvOffset,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-fflags".into(),
        "+genpts".into(),
    ];

    // Audio input — optionally trimmed (audio-led) or offset (video-led). These
    // flags MUST precede `-i audio` to affect that input.
    if offset.trim_sec > 0.0 {
        args.push("-ss".into());
        args.push(fixed3(offset.trim_sec));
    }
    if offset.offset_sec > 0.0 {
        args.push("-itsoffset".into());
        args.push(fixed3(offset.offset_sec));
    }
    args.push("-i".into());
    args.push(audio_path.into());

    // Video input (no pre-input flags).
    args.push("-i".into());
    args.push(video_path.into());

    args.push("-map".into());
    args.push("0:a".into());
    args.push("-map".into());
    args.push("1:v".into());
    args.push("-c:v".into());
    args.push("copy".into());
    args.push("-af".into());
    args.push("aresample=async=1000:first_pts=0".into());
    args.push("-c:a".into());
    args.push("aac".into());
    args.push("-b:a".into());
    args.push("192k".into());
    args.push("-avoid_negative_ts".into());
    args.push("make_zero".into());
    args.push("-shortest".into());
    args.push("-movflags".into());
    args.push("+faststart".into());
    args.push("-y".into());
    args.push(output_path.into());
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn has_pair(args: &[String], a: &str, b: &str) -> bool {
        args.windows(2).any(|w| w[0] == a && w[1] == b)
    }

    fn index_of(args: &[String], needle: &str) -> Option<usize> {
        args.iter().position(|a| a == needle)
    }

    // ── should_fallback_to_two_process — the auto-fallback trigger ───────────

    #[test]
    fn fallback_fires_only_on_first_video_startup_failure() {
        // The textbook case: video session, first segment, no reconnect, no
        // bytes, died fast → fall back.
        assert!(should_fallback_to_two_process(true, true, 0, 0, 800));

        // Audio-only session never needs the fallback.
        assert!(!should_fallback_to_two_process(false, true, 0, 0, 800));
        // Bytes were produced → a real mid-recording death (reconnect handles it).
        assert!(!should_fallback_to_two_process(true, true, 0, 4096, 800));
        // A later death (past the startup window) is a disconnect, not a startup
        // incompatibility.
        assert!(!should_fallback_to_two_process(
            true,
            true,
            0,
            0,
            STARTUP_FAILURE_MS
        ));
        // Already reconnecting, or not the first segment → leave it to reconnect.
        assert!(!should_fallback_to_two_process(true, true, 1, 0, 800));
        assert!(!should_fallback_to_two_process(true, false, 0, 0, 800));
    }

    // ── av_offset_decision — both directions, dead-zone, ceilings, None ──────

    #[test]
    fn offset_audio_led_trims_head() {
        // video started 2.0 s after audio → audio led by 2.0 s → trim 2.0.
        let d = av_offset_decision(Some(1000.0), Some(1002.0));
        assert_eq!(d.trim_sec, 2.0);
        assert_eq!(d.offset_sec, 0.0);
    }

    #[test]
    fn offset_video_led_offsets_audio() {
        // video started 3.0 s before audio → video led by 3.0 s → offset 3.0.
        let d = av_offset_decision(Some(1003.0), Some(1000.0));
        assert_eq!(d.trim_sec, 0.0);
        assert_eq!(d.offset_sec, 3.0);
    }

    #[test]
    fn offset_dead_zone_below_50ms_is_ignored_both_directions() {
        // |raw| < 0.05 → no alignment (sub-frame jitter).
        assert_eq!(
            av_offset_decision(Some(1000.0), Some(1000.04)),
            AvOffset::NONE
        );
        assert_eq!(
            av_offset_decision(Some(1000.04), Some(1000.0)),
            AvOffset::NONE
        );
        // exactly 0.05 is NOT > 0.05 → ignored.
        assert_eq!(
            av_offset_decision(Some(1000.0), Some(1000.05)),
            AvOffset::NONE
        );
    }

    #[test]
    fn offset_above_60s_ceiling_is_ignored() {
        // raw > 60 (audio led by 61 s — implausible) → ignored.
        assert_eq!(
            av_offset_decision(Some(1000.0), Some(1061.0)),
            AvOffset::NONE
        );
    }

    #[test]
    fn offset_below_minus_60s_ceiling_is_ignored() {
        // raw < -60 (video led by 61 s — implausible) → ignored.
        assert_eq!(
            av_offset_decision(Some(1061.0), Some(1000.0)),
            AvOffset::NONE
        );
    }

    #[test]
    fn offset_none_input_yields_no_alignment() {
        assert_eq!(av_offset_decision(None, Some(1000.0)), AvOffset::NONE);
        assert_eq!(av_offset_decision(Some(1000.0), None), AvOffset::NONE);
        assert_eq!(av_offset_decision(None, None), AvOffset::NONE);
    }

    // ── build_mux_args — order: -ss/-itsoffset BEFORE -i audio ───────────────

    #[test]
    fn mux_audio_led_puts_ss_before_audio_input() {
        let offset = AvOffset {
            trim_sec: 2.5,
            offset_sec: 0.0,
        };
        let args = build_mux_args("a.m4a", "v.mp4", "out.mp4", offset);
        let ss = index_of(&args, "-ss").expect("-ss present for audio-led");
        // -ss value is toFixed(3).
        assert_eq!(args[ss + 1], "2.500");
        // First -i is the audio path, and -ss precedes it.
        let first_i = index_of(&args, "-i").unwrap();
        assert!(ss < first_i, "-ss must come before -i audio");
        assert_eq!(args[first_i + 1], "a.m4a");
        // No -itsoffset in the audio-led case.
        assert!(index_of(&args, "-itsoffset").is_none());
    }

    #[test]
    fn mux_video_led_puts_itsoffset_before_audio_input() {
        let offset = AvOffset {
            trim_sec: 0.0,
            offset_sec: 1.25,
        };
        let args = build_mux_args("a.m4a", "v.mp4", "out.mp4", offset);
        let off = index_of(&args, "-itsoffset").expect("-itsoffset present for video-led");
        assert_eq!(args[off + 1], "1.250");
        let first_i = index_of(&args, "-i").unwrap();
        assert!(off < first_i, "-itsoffset must come before -i audio");
        assert_eq!(args[first_i + 1], "a.m4a");
        assert!(index_of(&args, "-ss").is_none());
    }

    #[test]
    fn mux_no_offset_has_neither_ss_nor_itsoffset() {
        let args = build_mux_args("a.m4a", "v.mp4", "out.mp4", AvOffset::NONE);
        assert!(index_of(&args, "-ss").is_none());
        assert!(index_of(&args, "-itsoffset").is_none());
        // First -i still the audio path.
        let first_i = index_of(&args, "-i").unwrap();
        assert_eq!(args[first_i + 1], "a.m4a");
    }

    #[test]
    fn mux_maps_audio_from_0_and_video_from_1_copy_video() {
        let args = build_mux_args("a.m4a", "v.mp4", "out.mp4", AvOffset::NONE);
        assert!(has_pair(&args, "-map", "0:a"));
        assert!(has_pair(&args, "-map", "1:v"));
        assert!(has_pair(&args, "-c:v", "copy"), "video is stream-copied");
        // The two inputs in order: audio first (input 0), video second (input 1).
        let audio_i = args.iter().position(|a| a == "a.m4a").unwrap();
        let video_i = args.iter().position(|a| a == "v.mp4").unwrap();
        assert!(audio_i < video_i, "audio is input 0, video is input 1");
    }

    #[test]
    fn mux_has_aresample_shortest_genpts_and_faststart() {
        let args = build_mux_args("a.m4a", "v.mp4", "out.mp4", AvOffset::NONE);
        assert!(has_pair(&args, "-af", "aresample=async=1000:first_pts=0"));
        assert!(args.iter().any(|a| a == "-shortest"));
        assert!(has_pair(&args, "-fflags", "+genpts"));
        assert!(has_pair(&args, "-movflags", "+faststart"));
        assert!(has_pair(&args, "-c:a", "aac"));
        assert!(has_pair(&args, "-b:a", "192k"));
        assert!(has_pair(&args, "-avoid_negative_ts", "make_zero"));
    }

    #[test]
    fn mux_output_path_is_last() {
        let args = build_mux_args("a.m4a", "v.mp4", "FINAL.mp4", AvOffset::NONE);
        assert_eq!(args.last().unwrap(), "FINAL.mp4");
        let n = args.len();
        assert_eq!(args[n - 2], "-y");
    }

    // ── video-only capture args — mac vs win ─────────────────────────────────

    #[test]
    fn video_capture_mac_uses_idx_none_and_wallclock() {
        let args = build_video_capture_args(Platform::MacOS, "0", "/tmp/v.mp4", 30);
        assert!(has_pair(&args, "-use_wallclock_as_timestamps", "1"));
        assert!(has_pair(&args, "-f", "avfoundation"));
        assert!(args.iter().any(|a| a == "0:none"), "got: {args:?}");
        assert!(has_pair(&args, "-c:v", "libx264"));
        // No audio codec on a video-only process.
        assert!(!args.iter().any(|a| a == "-c:a"));
        assert_eq!(args.last().unwrap(), "/tmp/v.mp4");
    }

    #[test]
    fn video_capture_windows_uses_named_video_input() {
        let args = build_video_capture_args(Platform::Windows, "Logitech BRIO", "C:/v.mp4", 25);
        assert!(has_pair(&args, "-f", "dshow"));
        assert!(args.iter().any(|a| a == "video=Logitech BRIO"));
        assert!(has_pair(&args, "-framerate", "25"));
        assert!(!args.iter().any(|a| a == "-c:a"));
    }

    // ── audio-only capture args — mac vs win ─────────────────────────────────

    #[test]
    fn audio_capture_mac_uses_leading_colon_and_no_video_codec() {
        let args = build_audio_capture_args(Platform::MacOS, "1", "/tmp/a.m4a", 2);
        assert!(has_pair(&args, "-use_wallclock_as_timestamps", "1"));
        assert!(has_pair(&args, "-f", "avfoundation"));
        assert!(args.iter().any(|a| a == ":1"), "leading-colon audio input");
        assert!(has_pair(&args, "-c:a", "aac"));
        assert!(has_pair(&args, "-ac", "2"));
        assert!(!args.iter().any(|a| a == "-c:v"));
        assert_eq!(args.last().unwrap(), "/tmp/a.m4a");
    }

    #[test]
    fn audio_capture_windows_uses_named_audio_input_and_channels() {
        let args = build_audio_capture_args(Platform::Windows, "Yamaha AG06", "C:/a.m4a", 1);
        assert!(has_pair(&args, "-f", "dshow"));
        assert!(args.iter().any(|a| a == "audio=Yamaha AG06"));
        assert!(has_pair(&args, "-ac", "1"), "mono → -ac 1");
        assert!(!args.iter().any(|a| a == "-c:v"));
    }
}
