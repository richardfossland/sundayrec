//! Unified ffmpeg capture-argument builder.
//!
//! Ported from the Electron `unified-recorder.ts` — but deliberately reduced to
//! the **audio-focused unified capture** that proves the Spike-B plumbing, not
//! the full production pipeline. See "What this spike simplifies vs Phase 3"
//! below; the hardened *argument knowledge* (combined-input on mac, two clocks
//! on Windows → drift filter, silencedetect in the chain) is what we carry
//! forward, independent of the encoding details.
//!
//! ## What this builds
//!
//! ONE ffmpeg process that opens the camera AND the microphone and writes a
//! single output file, with the audio passed through the core filter chain:
//!
//!   - **macOS** — a single `-f avfoundation -i "<videoIdx>:<audioIdx>"`. Camera
//!     and mic come from one input → one hardware clock → no drift → NO
//!     `aresample` filter.
//!   - **Windows** — `-f dshow` with TWO `-i` (video `video=<name>`, then audio
//!     `audio=<name>`). Two independent device clocks → they drift over a 90-min
//!     service → the audio chain gets `aresample=async=1000:first_pts=0` from
//!     [`crate::ffmpeg::unified_audio_drift_filter`].
//!
//! In BOTH cases the audio chain also carries `silencedetect` (from
//! [`crate::ffmpeg::build_silence_detect_filter`]) so a muted mixer emits
//! `silence_start` / `silence_end` markers the watcher reacts to. The output path
//! is always the final argument.
//!
//! ## What this spike simplifies vs Phase 3
//!
//!   - **No `filter_complex` video graph.** Production splits the camera into a
//!     full-quality recording stream + a low-rate MJPEG preview feed and encodes
//!     H.264 with bitrate/maxrate/bufsize tuning. Here we keep video simple
//!     (`-c:v libx264 -preset veryfast`, or copy when there is no video device)
//!     because the spike's job is to prove the audio-progress-silence-stop
//!     plumbing, not to tune the encoder.
//!   - **No second/third output** (separate lossless audio master, MJPEG-to-
//!     stdout preview). Single output file.
//!   - **No preroll, no split-recording rotation.** Phase 3.
//!   - **No per-device capture-format negotiation** (`MAC_CONFIGS`, dshow
//!     `rtbufsize` matrix, framerate fallbacks) beyond a single sane default.
//!
//! Everything here is a pure `Vec<String>` builder — no process is spawned — so
//! the argument shape is fully unit-tested without hardware.

use crate::ffmpeg::{
    build_levels_detect_filter, build_silence_detect_filter, unified_audio_drift_filter, Platform,
};

/// Audio channel layout for the captured output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channels {
    Mono,
    Stereo,
}

impl Channels {
    fn count(self) -> u8 {
        match self {
            Channels::Mono => 1,
            Channels::Stereo => 2,
        }
    }
}

/// Tunables for [`build_unified_capture_args`]. Kept small for the spike; Phase 3
/// expands this into the full settings surface (bitrate, resolution, flip, …).
#[derive(Debug, Clone)]
pub struct CaptureOpts {
    /// User opted into stop-on-silence (drives the silencedetect threshold).
    pub stop_on_silence: bool,
    /// User's silence threshold in dB, if set (clamped by the filter builder).
    pub silence_threshold_db: Option<i32>,
    /// Capture framerate (video), e.g. 30.
    pub framerate: u32,
    /// Output audio channel layout.
    pub channels: Channels,
}

impl Default for CaptureOpts {
    fn default() -> Self {
        Self {
            stop_on_silence: false,
            silence_threshold_db: None,
            framerate: 30,
            channels: Channels::Stereo,
        }
    }
}

/// Build the unified-capture ffmpeg argument vector.
///
/// `video_device`:
///   - macOS: the avfoundation **index** as a string (e.g. `"0"`). Combined with
///     the audio index into a single `"<vid>:<aud>"` input.
///   - Windows: the dshow camera **name** (wrapped as `video=<name>`).
///   - `None`: audio-only capture (no camera) — still a valid unified path the
///     spike supports, useful on a box with a mic but no camera.
///
/// `audio_device`:
///   - macOS: the avfoundation audio **index** as a string (e.g. `"1"`).
///   - Windows: the dshow audio **name** (wrapped as `audio=<name>`).
///
/// `output_path` is always emitted as the final argument.
pub fn build_unified_capture_args(
    platform: Platform,
    video_device: Option<&str>,
    audio_device: &str,
    output_path: &str,
    opts: &CaptureOpts,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["-hide_banner".into()];

    // Build the audio filter chain shared by every platform: optional drift
    // correction first (Windows only), then silencedetect, then the per-channel
    // peak-levels astats pass-through (drives the live UI meters). Comma-join
    // only the NON-EMPTY filters (the drift slot is empty on mac/linux). `astats`
    // is pass-through — it never alters the recorded audio, only emits telemetry
    // to stderr.
    let drift = unified_audio_drift_filter(platform);
    let silence = build_silence_detect_filter(opts.stop_on_silence, opts.silence_threshold_db);
    let levels = build_levels_detect_filter();
    let af_chain = [drift.to_string(), silence, levels]
        .into_iter()
        .filter(|f| !f.is_empty())
        .collect::<Vec<_>>()
        .join(",");

    let has_video = video_device.is_some();

    match platform {
        Platform::MacOS | Platform::Linux => {
            // avfoundation combined input: "<videoIdx>:<audioIdx>" gives camera +
            // mic on ONE input sharing one clock. Audio-only is ":<audioIdx>".
            // (Linux has no avfoundation; we use the same combined-input shape so
            // the dev box stays usable — it's not a shipping target.)
            args.push("-f".into());
            args.push("avfoundation".into());
            // avfoundation's internal capture buffer is tiny; under any scheduling
            // jitter it silently DROPS samples → the recording sounds choppy
            // ("hakkete"). A deeper input queue absorbs the jitter. This is the
            // single most important fix for glitchy macOS capture.
            args.push("-thread_queue_size".into());
            args.push("1024".into());
            if has_video {
                // `-framerate` is a VIDEO option — only meaningful with a camera.
                // Applying it to an audio-only input confuses ffmpeg's input clock
                // and contributes to the choppiness, so we omit it for audio-only.
                args.push("-framerate".into());
                args.push(opts.framerate.to_string());
                // avfoundation REJECTS a bare framerate without a paired, supported
                // video size ("Selected framerate is not supported by the device" →
                // "Input/output error" → zero frames). Pin a known-good capture mode
                // (1280x720, advertised by the FaceTime HD camera) so the camera
                // actually opens for recording, same as the preview does.
                args.push("-video_size".into());
                args.push("1280x720".into());
            } else {
                // Audio-only: avfoundation reports a wild initial timestamp (the
                // log showed `time=-577014:…`); regenerate clean PTS so the first
                // frames aren't malformed.
                args.push("-fflags".into());
                args.push("+genpts".into());
            }
            args.push("-i".into());
            match video_device {
                Some(v) => args.push(format!("{v}:{audio_device}")),
                None => args.push(format!(":{audio_device}")),
            }
        }
        Platform::Windows => {
            // dshow: two independent inputs in ONE process. Video first (input 0),
            // audio second (input 1). Same process = same scheduler, but TWO
            // device clocks → the drift filter in `af_chain` corrects the slide.
            if let Some(v) = video_device {
                args.push("-f".into());
                args.push("dshow".into());
                args.push("-framerate".into());
                args.push(opts.framerate.to_string());
                args.push("-i".into());
                args.push(format!("video={v}"));
            }
            args.push("-f".into());
            args.push("dshow".into());
            args.push("-i".into());
            args.push(format!("audio={audio_device}"));
        }
    }

    // Audio filter chain (drift + silencedetect + peak-levels astats) on the
    // captured audio. Only emit `-af` when the chain is non-empty — in practice
    // levels is always present, so `-af` is always emitted.
    if !af_chain.is_empty() {
        args.push("-af".into());
        args.push(af_chain);
    }

    // Codecs. The audio codec is chosen from the OUTPUT extension (see
    // `audio_codec_args`) so the encoded stream matches the chosen container —
    // mp3→libmp3lame, wav→pcm_s16le, flac→flac, m4a/mp4/aac→aac. (Previously this
    // hardcoded AAC, which ffmpeg rejects when muxing into a .mp3/.wav/.flac
    // container — the default `Mp3` format never recorded.) Always 48 kHz with the
    // requested channel count. Video (when present) stays a simple libx264.
    if has_video {
        args.push("-c:v".into());
        args.push("libx264".into());
        args.push("-preset".into());
        args.push("veryfast".into());
        args.push("-pix_fmt".into());
        args.push("yuv420p".into());
    }
    args.extend(audio_codec_args(output_path, opts.channels.count()));

    // Normalise leading timestamps so the file plays from t=0 in every player.
    args.push("-avoid_negative_ts".into());
    args.push("make_zero".into());
    if has_video {
        args.push("-movflags".into());
        args.push("+faststart".into());
    }

    // Overwrite + output path — ALWAYS last.
    args.push("-y".into());
    args.push(output_path.into());
    args
}

/// Audio codec + bitrate/sample-rate/channel args, chosen from the OUTPUT file's
/// extension so the encoded stream is valid for its container. AAC only muxes
/// into m4a/mp4/aac; an `.mp3`/`.wav`/`.flac` output needs its own codec, or
/// ffmpeg refuses to write the file. Unknown extensions fall back to AAC.
fn audio_codec_args(output_path: &str, channels: u8) -> Vec<String> {
    let ext = output_path
        .rsplit(['/', '\\'])
        .next()
        .and_then(|name| name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()))
        .unwrap_or_default();

    let mut a: Vec<String> = vec!["-c:a".into()];
    match ext.as_str() {
        "mp3" => {
            a.push("libmp3lame".into());
            a.push("-b:a".into());
            a.push("192k".into());
        }
        "wav" => a.push("pcm_s16le".into()), // lossless PCM — no bitrate
        "flac" => a.push("flac".into()),     // lossless — no bitrate
        // aac / m4a / mp4 / unknown → AAC (the safe, widely-muxable default).
        _ => {
            a.push("aac".into());
            a.push("-b:a".into());
            a.push("192k".into());
        }
    }
    a.push("-ar".into());
    a.push("48000".into());
    a.push("-ac".into());
    a.push(channels.to_string());
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    fn has_pair(args: &[String], a: &str, b: &str) -> bool {
        args.windows(2).any(|w| w[0] == a && w[1] == b)
    }

    fn count_i(args: &[String]) -> usize {
        args.iter().filter(|a| a.as_str() == "-i").count()
    }

    #[test]
    fn windows_has_aresample_drift_and_silencedetect() {
        let args = build_unified_capture_args(
            Platform::Windows,
            Some("Logitech BRIO"),
            "Soundcraft USB Audio",
            "C:/recordings/out.mp4",
            &CaptureOpts::default(),
        );
        let af = args
            .iter()
            .position(|a| a == "-af")
            .map(|i| args[i + 1].clone())
            .expect("an -af chain");
        assert!(
            af.contains("aresample=async=1000:first_pts=0"),
            "windows needs drift correction; got: {af}"
        );
        assert!(
            af.contains("silencedetect="),
            "silencedetect must be present"
        );
        assert!(
            af.contains("astats=metadata=1"),
            "per-channel levels astats must be present; got: {af}"
        );
        // chain order: drift, then silencedetect, then levels.
        let drift_idx = af.find("aresample").unwrap();
        let sil_idx = af.find("silencedetect").unwrap();
        let lvl_idx = af.find("astats").unwrap();
        assert!(drift_idx < sil_idx);
        assert!(sil_idx < lvl_idx);
    }

    #[test]
    fn mac_has_silencedetect_but_not_aresample() {
        let args = build_unified_capture_args(
            Platform::MacOS,
            Some("0"),
            "1",
            "/tmp/out.mp4",
            &CaptureOpts::default(),
        );
        let af = args
            .iter()
            .position(|a| a == "-af")
            .map(|i| args[i + 1].clone())
            .expect("an -af chain");
        assert!(
            !af.contains("aresample"),
            "mac shares one clock — no drift filter; got: {af}"
        );
        assert!(af.contains("silencedetect="));
        assert!(
            af.contains(
                "astats=metadata=1:reset=10:measure_perchannel=Peak_level,ametadata=mode=print:file=/dev/stderr"
            ),
            "live per-channel levels astats+ametadata must be present; got: {af}"
        );
        // On mac/linux the chain has no empty leading slot — it starts with
        // silencedetect (no stray leading comma).
        assert!(!af.starts_with(','), "no empty drift slot leaking a comma");
    }

    #[test]
    fn audio_codec_matches_output_extension() {
        let mk = |path: &str| {
            build_unified_capture_args(Platform::MacOS, None, "1", path, &CaptureOpts::default())
        };
        // mp3 → libmp3lame (NOT aac — the bug that froze every default recording).
        assert!(has_pair(&mk("/tmp/x.mp3"), "-c:a", "libmp3lame"));
        assert!(!has_pair(&mk("/tmp/x.mp3"), "-c:a", "aac"));
        // wav → pcm_s16le, no -b:a bitrate.
        let wav = mk("/tmp/x.wav");
        assert!(has_pair(&wav, "-c:a", "pcm_s16le"));
        assert!(!wav.iter().any(|a| a == "-b:a"), "pcm needs no bitrate");
        // flac → flac, no -b:a bitrate.
        let flac = mk("/tmp/x.flac");
        assert!(has_pair(&flac, "-c:a", "flac"));
        assert!(!flac.iter().any(|a| a == "-b:a"), "flac needs no bitrate");
        // m4a / mp4 / aac → aac.
        assert!(has_pair(&mk("/tmp/x.m4a"), "-c:a", "aac"));
        assert!(has_pair(&mk("/tmp/x.mp4"), "-c:a", "aac"));
        assert!(has_pair(&mk("/tmp/x.aac"), "-c:a", "aac"));
        // Unknown extension → AAC fallback (never crashes the builder).
        assert!(has_pair(&mk("/tmp/x.weird"), "-c:a", "aac"));
        // Channel count still flows through, and sample rate is fixed at 48 kHz.
        assert!(has_pair(&mk("/tmp/x.mp3"), "-ac", "2"));
        assert!(has_pair(&mk("/tmp/x.mp3"), "-ar", "48000"));
    }

    #[test]
    fn mac_audio_only_buffers_input_and_drops_framerate() {
        // Anti-choppiness: audio-only capture needs a deep input queue + clean
        // PTS, and must NOT carry `-framerate` (a video option that worsens
        // avfoundation audio timing).
        let a = build_unified_capture_args(
            Platform::MacOS,
            None,
            "0",
            "/tmp/x.mp3",
            &CaptureOpts::default(),
        );
        assert!(has_pair(&a, "-thread_queue_size", "1024"));
        assert!(has_pair(&a, "-fflags", "+genpts"));
        assert!(
            !a.iter().any(|x| x == "-framerate"),
            "audio-only must not set -framerate"
        );
        assert!(
            !a.iter().any(|x| x == "-video_size"),
            "audio-only must not request a video capture size"
        );
    }

    #[test]
    fn mac_video_keeps_framerate_and_input_buffer() {
        // With a camera the buffer is still present and `-framerate` IS set
        // (video needs it); no genpts on the video path.
        let a = build_unified_capture_args(
            Platform::MacOS,
            Some("0"),
            "1",
            "/tmp/x.mp4",
            &CaptureOpts::default(),
        );
        assert!(has_pair(&a, "-thread_queue_size", "1024"));
        assert!(has_pair(&a, "-framerate", "30"));
        // The camera must be opened with a supported capture mode (avfoundation
        // rejects a bare framerate → "Input/output error", zero frames).
        assert!(has_pair(&a, "-video_size", "1280x720"));
        assert!(
            !a.iter().any(|x| x == "+genpts"),
            "the video path uses -framerate, not genpts"
        );
    }

    #[test]
    fn levels_filter_is_present_and_output_path_unchanged() {
        // The levels filter is added on every platform; the file output args
        // (`-y <path>` last, codecs, container) must be untouched by it.
        let args = build_unified_capture_args(
            Platform::MacOS,
            Some("0"),
            "1",
            "/tmp/sermon.mp4",
            &CaptureOpts::default(),
        );
        let af = args
            .iter()
            .position(|a| a == "-af")
            .map(|i| args[i + 1].clone())
            .expect("an -af chain");
        assert!(af.contains("astats=metadata=1"));
        // Output is still `-y /tmp/sermon.mp4` as the final two args.
        assert_eq!(args.last().unwrap(), "/tmp/sermon.mp4");
        let n = args.len();
        assert_eq!(args[n - 2], "-y");
        // Codecs unchanged by the added telemetry filter.
        assert!(has_pair(&args, "-c:a", "aac"));
        assert!(has_pair(&args, "-c:v", "libx264"));
    }

    #[test]
    fn windows_uses_two_inputs_with_named_devices() {
        let args = build_unified_capture_args(
            Platform::Windows,
            Some("Logitech BRIO"),
            "Yamaha AG06",
            "out.mp4",
            &CaptureOpts::default(),
        );
        assert_eq!(count_i(&args), 2, "video + audio = two -i on windows");
        assert!(args.iter().any(|a| a == "video=Logitech BRIO"));
        assert!(args.iter().any(|a| a == "audio=Yamaha AG06"));
    }

    #[test]
    fn mac_uses_single_combined_input() {
        let args = build_unified_capture_args(
            Platform::MacOS,
            Some("0"),
            "1",
            "out.mp4",
            &CaptureOpts::default(),
        );
        assert_eq!(count_i(&args), 1, "one combined avfoundation input on mac");
        // combined "videoIdx:audioIdx"
        assert!(args.iter().any(|a| a == "0:1"));
        assert!(has_pair(&args, "-f", "avfoundation"));
    }

    #[test]
    fn output_path_is_always_last() {
        for (plat, vid, aud) in [
            (Platform::Windows, Some("Cam"), "Mic"),
            (Platform::MacOS, Some("0"), "1"),
            (Platform::MacOS, None, "1"),
        ] {
            let args = build_unified_capture_args(
                plat,
                vid,
                aud,
                "FINAL_OUTPUT.mp4",
                &CaptureOpts::default(),
            );
            assert_eq!(args.last().unwrap(), "FINAL_OUTPUT.mp4");
            // and preceded by -y
            let n = args.len();
            assert_eq!(args[n - 2], "-y");
        }
    }

    #[test]
    fn mac_audio_only_has_leading_colon_input_and_no_video_codec() {
        let args = build_unified_capture_args(
            Platform::MacOS,
            None,
            "2",
            "out.m4a",
            &CaptureOpts::default(),
        );
        assert_eq!(count_i(&args), 1);
        assert!(
            args.iter().any(|a| a == ":2"),
            "audio-only avfoundation input"
        );
        assert!(
            !args.iter().any(|a| a == "-c:v"),
            "no video codec when no camera"
        );
        assert!(has_pair(&args, "-c:a", "aac"));
    }

    #[test]
    fn windows_audio_only_has_single_input() {
        let args = build_unified_capture_args(
            Platform::Windows,
            None,
            "USB Audio CODEC",
            "out.m4a",
            &CaptureOpts::default(),
        );
        assert_eq!(count_i(&args), 1, "audio-only windows = single dshow input");
        assert!(args.iter().any(|a| a == "audio=USB Audio CODEC"));
        assert!(!args.iter().any(|a| a == "-c:v"));
    }

    #[test]
    fn stop_on_silence_threshold_flows_into_filter() {
        let opts = CaptureOpts {
            stop_on_silence: true,
            silence_threshold_db: Some(-40),
            ..CaptureOpts::default()
        };
        let args = build_unified_capture_args(Platform::MacOS, Some("0"), "1", "out.mp4", &opts);
        let af = args
            .iter()
            .position(|a| a == "-af")
            .map(|i| args[i + 1].clone())
            .unwrap();
        assert!(af.contains("silencedetect=noise=-40dB:duration=1"));
    }

    #[test]
    fn channels_and_framerate_are_honoured() {
        let opts = CaptureOpts {
            channels: Channels::Mono,
            framerate: 25,
            ..CaptureOpts::default()
        };
        let args =
            build_unified_capture_args(Platform::Windows, Some("Cam"), "Mic", "out.mp4", &opts);
        assert!(has_pair(&args, "-ac", "1"), "mono → -ac 1");
        assert!(has_pair(&args, "-framerate", "25"));
    }
}
