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
use crate::settings::ChannelMode;

/// Depth of avfoundation's input `-thread_queue_size` on mac/linux. A TUNABLE
/// KNOB: avfoundation's internal capture buffer is tiny, so under scheduling
/// jitter it silently DROPS samples → choppy ("hakkete") audio. A deeper queue
/// absorbs the jitter. Raised from the old `1024` to `4096` after a USB Behringer
/// mixer recorded choppy at the smaller depth.
const MAC_INPUT_QUEUE: &str = "4096";

/// The audio codec selected from an output container extension. The ONE place
/// extension→codec is decided, so the main recorder and the pre-roll harvest can
/// never disagree (a mismatch there muxes an AAC pre-roll onto an mp3/wav/flac
/// recording → corrupt `-c copy` concat).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioCodec {
    Mp3,
    PcmS16le,
    Flac,
    Aac,
}

impl AudioCodec {
    /// The ffmpeg `-c:a` codec name.
    pub fn ffmpeg_name(self) -> &'static str {
        match self {
            AudioCodec::Mp3 => "libmp3lame",
            AudioCodec::PcmS16le => "pcm_s16le",
            AudioCodec::Flac => "flac",
            AudioCodec::Aac => "aac",
        }
    }

    /// Whether this codec takes a `-b:a` bitrate. PCM and FLAC are lossless and
    /// REJECT a bitrate argument, so it must be omitted for them.
    pub fn uses_bitrate(self) -> bool {
        matches!(self, AudioCodec::Mp3 | AudioCodec::Aac)
    }

    /// The container extension this codec belongs in when none is supplied (used
    /// to normalise an empty/unknown extension so codec and container always
    /// agree). AAC lives in m4a; the others share their own name.
    pub fn default_extension(self) -> &'static str {
        match self {
            AudioCodec::Mp3 => "mp3",
            AudioCodec::PcmS16le => "wav",
            AudioCodec::Flac => "flac",
            AudioCodec::Aac => "m4a",
        }
    }
}

/// Map an output file extension (with or without a leading dot, any case) to its
/// codec. Unknown / empty extensions fall back to AAC (the safe, widely-muxable
/// default). This is the single source of truth shared by the recorder and the
/// pre-roll path.
pub fn codec_for_extension(extension: &str) -> AudioCodec {
    match extension
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" => AudioCodec::Mp3,
        "wav" => AudioCodec::PcmS16le,
        "flac" => AudioCodec::Flac,
        // aac / m4a / mp4 / unknown / empty → AAC.
        _ => AudioCodec::Aac,
    }
}

/// The full `-c:a … [-b:a …k] [-ar …] -ac …` argument run for an output
/// extension. Codec comes from [`codec_for_extension`]; `bitrate_kbps` comes
/// from validated settings. `-b:a` is omitted for the lossless codecs.
///
/// `sample_rate` is `Option<u32>`: `Some(sr)` emits `-ar sr` (forced rate);
/// `None` OMITS `-ar` entirely so ffmpeg captures at the device's NATIVE rate.
/// This is the anti-choppiness fix — forcing `-ar 48000` on a 44.1 kHz USB
/// mixer triggers an internal resample that drops samples ("hakkete"). The
/// omission mirrors the existing `-b:a` conditional for the lossless codecs.
pub fn audio_encode_args(
    extension: &str,
    channels: u8,
    sample_rate: Option<u32>,
    bitrate_kbps: u32,
) -> Vec<String> {
    let codec = codec_for_extension(extension);
    let mut a: Vec<String> = vec!["-c:a".into(), codec.ffmpeg_name().into()];
    if codec.uses_bitrate() {
        a.push("-b:a".into());
        a.push(format!("{bitrate_kbps}k"));
    }
    if let Some(sr) = sample_rate {
        a.push("-ar".into());
        a.push(sr.to_string());
    }
    a.push("-ac".into());
    a.push(channels.to_string());
    a
}

/// The channel-select `pan` filter for a capture, or `None` for plain stereo (no
/// remap). MonoL/MonoR pick ONE source channel; MonoMix averages both. Without
/// this, every non-stereo mode collapsed to a bare `-ac 1` that let ffmpeg
/// downmix arbitrarily — MonoL/MonoR produced the wrong channel or silence.
pub fn channel_map_filter(mode: ChannelMode) -> Option<String> {
    match mode {
        ChannelMode::Stereo => None,
        ChannelMode::MonoL => Some("pan=mono|c0=c0".into()),
        ChannelMode::MonoR => Some("pan=mono|c0=c1".into()),
        ChannelMode::MonoMix => Some("pan=mono|c0=0.5*c0+0.5*c1".into()),
    }
}

/// Output channel count for an `-ac` argument: stereo keeps both, every mono mode
/// downmixes to one (the [`channel_map_filter`] selects WHICH signal).
fn ac_count(mode: ChannelMode) -> u8 {
    match mode {
        ChannelMode::Stereo => 2,
        _ => 1,
    }
}

/// The output file's extension (lower-cased by the codec mapper later), parsed
/// from the basename so a dotted directory can't be mistaken for an extension.
fn ext_of(output_path: &str) -> &str {
    output_path
        .rsplit(['/', '\\'])
        .next()
        .and_then(|name| name.rsplit_once('.').map(|(_, e)| e))
        .unwrap_or_default()
}

/// Tunables for [`build_unified_capture_args`] — the audio settings surface that
/// actually reaches ffmpeg (format/codec is derived from the output extension).
#[derive(Debug, Clone)]
pub struct CaptureOpts {
    /// User opted into stop-on-silence (drives the silencedetect threshold).
    pub stop_on_silence: bool,
    /// User's silence threshold in dB, if set (clamped by the filter builder).
    pub silence_threshold_db: Option<i32>,
    /// Capture framerate (video), e.g. 30.
    pub framerate: u32,
    /// Output channel layout / downmix mode.
    pub channel_mode: ChannelMode,
    /// Output sample rate in Hz, or `None` to capture at the device's NATIVE
    /// rate (omit `-ar`). `None` is the default — forcing a rate that doesn't
    /// match the device resamples and drops samples (the choppiness root cause).
    pub sample_rate: Option<u32>,
    /// Output bitrate in kbps for lossy codecs (ignored by PCM/FLAC).
    pub bitrate_kbps: u32,
    /// Emit the live per-channel `astats` levels filter (drives the L/R meters)?
    /// `true` by default. When `false` the filter is dropped from the `-af`
    /// chain — its ~94 lines/s of stderr can starve the capture reader on a
    /// loaded machine, so the user can turn the meters off for max stability.
    pub live_levels: bool,
}

impl Default for CaptureOpts {
    fn default() -> Self {
        Self {
            stop_on_silence: false,
            silence_threshold_db: None,
            framerate: 30,
            channel_mode: ChannelMode::Stereo,
            sample_rate: None,
            bitrate_kbps: 192,
            live_levels: true,
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

    // Build the audio filter chain shared by every platform, IN ORDER:
    //   1. drift correction (`aresample`, Windows only — two device clocks),
    //   2. channel `pan` (MonoL/MonoR/MonoMix downmix; empty for stereo),
    //   3. silencedetect, then 4. the per-channel peak-levels astats pass-through.
    // The pan comes BEFORE silencedetect + astats so the meters and the
    // silence/auto-stop logic measure the POST-downmix signal the user actually
    // records (on a MonoL take the meter then shows the one kept channel). Comma-
    // join only the NON-EMPTY filters. `astats` is pass-through — it never alters
    // the recorded audio, only emits telemetry to stderr.
    let has_video = video_device.is_some();
    // Audio drift correction for the `-af` chain. For an A/V recording the camera
    // and the mic can be on DIFFERENT hardware clocks (a USB mixer's 48 kHz is not
    // exactly the camera/system clock), so even on macOS the audio slowly slides
    // against the (CFR) video over a long service → lip-sync drift.
    // `aresample=async=1000:first_pts=0` continuously resamples the audio to track
    // the video clock and pins the first sample to t=0, keeping A/V LOCKED for the
    // whole recording. Audio-ONLY recordings stay RAW (the platform default —
    // nothing on macOS, the existing two-clock fix on Windows).
    let drift = if has_video {
        "aresample=async=1000:first_pts=0".to_string()
    } else {
        unified_audio_drift_filter(platform).to_string()
    };
    let pan = channel_map_filter(opts.channel_mode).unwrap_or_default();
    let silence = build_silence_detect_filter(opts.stop_on_silence, opts.silence_threshold_db);
    // The live-levels astats pass is OPTIONAL: when the user turns the meters off
    // (`live_levels = false`) we drop it from the chain so its per-frame stderr
    // can't starve the capture. drift + pan + silencedetect always stay.
    let levels = if opts.live_levels {
        build_levels_detect_filter()
    } else {
        String::new()
    };
    let af_chain = [drift, pan, silence, levels]
        .into_iter()
        .filter(|f| !f.is_empty())
        .collect::<Vec<_>>()
        .join(",");

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
            args.push(MAC_INPUT_QUEUE.into());
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

    // For a VIDEO recording we add a SECOND output (a downscaled, low-fps,
    // audio-less MJPEG to stdout) AFTER the mp4. With two outputs ffmpeg's
    // implicit stream selection becomes ambiguous, so we make the FIRST (mp4)
    // output map BOTH streams EXPLICITLY (`-map 0:v -map 0:a`). On macOS video +
    // audio share one combined input (input 0), so `0:v`/`0:a` address them; on
    // Windows video is input 0 and audio input 1, but `0:v` still names the video
    // stream and (since dshow's audio carries no video) `0:a` still resolves to
    // the audio. (The audio-ONLY path adds no mapping and no second output — it is
    // byte-for-byte unchanged.)
    if has_video {
        args.push("-map".into());
        args.push("0:v".into());
        args.push("-map".into());
        args.push("0:a".into());
    }

    // Codecs. The audio codec is chosen from the OUTPUT extension (see
    // `codec_for_extension`) so the encoded stream matches the chosen container —
    // mp3→libmp3lame, wav→pcm_s16le, flac→flac, m4a/mp4/aac→aac. (Previously this
    // hardcoded AAC, which ffmpeg rejects when muxing into a .mp3/.wav/.flac
    // container — the default `Mp3` format never recorded.) Sample rate, bitrate
    // and channel count come from validated settings. Video (when present) stays a
    // simple libx264.
    if has_video {
        args.push("-c:v".into());
        args.push("libx264".into());
        args.push("-preset".into());
        args.push("veryfast".into());
        args.push("-pix_fmt".into());
        args.push("yuv420p".into());
        // PERFECT A/V SYNC: avfoundation cameras deliver VARIABLE frame rate (they
        // drop to ~15 fps in low light). Muxed as-is the video timeline diverges
        // from the audio and lip-sync drifts over a service. `-r <fps> -fps_mode
        // cfr` conforms the capture to TRUE constant frame rate, duplicating /
        // dropping frames against their real PTS so the video stays locked to the
        // audio clock for the whole recording. (Per-output: the MJPEG preview
        // output below sets its own rate via `fps=8` and is unaffected.)
        args.push("-r".into());
        args.push(opts.framerate.to_string());
        args.push("-fps_mode".into());
        args.push("cfr".into());
    }
    args.extend(audio_encode_args(
        ext_of(output_path),
        ac_count(opts.channel_mode),
        opts.sample_rate,
        opts.bitrate_kbps,
    ));

    // Normalise leading timestamps so the file plays from t=0 in every player.
    args.push("-avoid_negative_ts".into());
    args.push("make_zero".into());
    if has_video {
        args.push("-movflags".into());
        args.push("+faststart".into());
    }

    // The mp4 file output — for a video recording this is the FIRST of two
    // outputs (the MJPEG preview to stdout follows); for audio-only it is the sole
    // output. ALWAYS preceded by `-y` (overwrite).
    args.push("-y".into());
    args.push(output_path.into());

    // SECOND output (video recordings only): a best-effort live PREVIEW stream.
    // The SAME recording ffmpeg also emits a tiny, downscaled, low-fps, audio-less
    // MJPEG to stdout so the UI can show a live image WHILE recording (macOS gives
    // the camera a single owner, so a separate preview process can't open it).
    // This is appended AFTER the complete mp4 output above, so the mp4 is fully
    // specified and finalises normally regardless of the preview. The supervisor
    // reads `pipe:1` and splits frames; a stdout read failure only ends the
    // preview, never the recording.
    if has_video {
        args.push("-map".into());
        args.push("0:v".into());
        args.push("-an".into());
        args.push("-vf".into());
        args.push("scale=480:-2,fps=8".into());
        args.push("-c:v".into());
        args.push("mjpeg".into());
        args.push("-q:v".into());
        args.push("10".into());
        args.push("-f".into());
        args.push("mjpeg".into());
        args.push("pipe:1".into());
    }
    args
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
    fn mac_audio_only_has_silencedetect_but_no_aresample() {
        // AUDIO-ONLY (no camera) stays RAW on macOS — one clock, no resampling.
        let args = build_unified_capture_args(
            Platform::MacOS,
            None,
            "1",
            "/tmp/out.m4a",
            &CaptureOpts::default(),
        );
        let af = args
            .iter()
            .position(|a| a == "-af")
            .map(|i| args[i + 1].clone())
            .expect("an -af chain");
        assert!(
            !af.contains("aresample"),
            "mac audio-only is raw — no drift filter; got: {af}"
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
    fn video_recording_locks_av_sync_cfr_and_aresample() {
        // A/V recording on EVERY platform gets the sync lock: CFR video + audio
        // drift resampling. Audio-only recordings get NEITHER.
        for platform in [Platform::MacOS, Platform::Windows] {
            let args = build_unified_capture_args(
                platform,
                Some("0"),
                "1",
                "/tmp/out.mp4",
                &CaptureOpts {
                    framerate: 30,
                    ..CaptureOpts::default()
                },
            );
            // Video conformed to true constant frame rate, locked to the audio clock.
            assert!(
                has_pair(&args, "-fps_mode", "cfr"),
                "{platform:?} video must be CFR"
            );
            assert!(has_pair(&args, "-r", "30"), "{platform:?} CFR rate");
            // Audio continuously drift-corrected + pinned to t=0.
            let af = args
                .iter()
                .position(|a| a == "-af")
                .map(|i| args[i + 1].clone())
                .expect("an -af chain");
            assert!(
                af.contains("aresample=async=1000:first_pts=0"),
                "{platform:?} A/V audio must be drift-corrected; got: {af}"
            );
        }
        // Audio-only: NO CFR, NO aresample (raw).
        let audio = build_unified_capture_args(
            Platform::MacOS,
            None,
            "1",
            "/tmp/a.wav",
            &CaptureOpts::default(),
        );
        assert!(!audio.iter().any(|a| a == "-fps_mode"), "audio-only ≠ CFR");
        let af = audio
            .iter()
            .position(|a| a == "-af")
            .map(|i| audio[i + 1].clone())
            .unwrap_or_default();
        assert!(!af.contains("aresample"), "audio-only stays raw");
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
        // Channel count still flows through. The default sample rate is Auto
        // (native) → NO `-ar` flag at all (the anti-resample / anti-choppiness fix).
        assert!(has_pair(&mk("/tmp/x.mp3"), "-ac", "2"));
        assert!(
            !mk("/tmp/x.mp3").iter().any(|a| a == "-ar"),
            "default (Auto) sample rate must omit -ar"
        );
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
        assert!(has_pair(&a, "-thread_queue_size", "4096"));
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
        assert!(has_pair(&a, "-thread_queue_size", "4096"));
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
        // The mp4 file output is still `-y /tmp/sermon.mp4` (now followed by the
        // MJPEG preview second output, so not the literal last args).
        let y = args.iter().position(|a| a == "-y").expect("a -y");
        assert_eq!(args[y + 1], "/tmp/sermon.mp4");
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
    fn audio_only_output_path_is_always_last() {
        // For an AUDIO-ONLY recording the mp4/audio output is the SOLE output, so
        // `-y <path>` are the final two args (no MJPEG preview second output).
        let args = build_unified_capture_args(
            Platform::MacOS,
            None,
            "1",
            "FINAL_OUTPUT.m4a",
            &CaptureOpts::default(),
        );
        assert_eq!(args.last().unwrap(), "FINAL_OUTPUT.m4a");
        let n = args.len();
        assert_eq!(args[n - 2], "-y");
    }

    /// The MJPEG-preview second output is added ONLY for video recordings, after a
    /// COMPLETE mp4 output. The file output's `-y <path>` is the last-but-one
    /// output (immediately preceding the `pipe:1` preview run); the preview ends
    /// the arg vector with `… -f mjpeg pipe:1`.
    #[test]
    fn video_appends_mjpeg_preview_second_output_after_complete_mp4() {
        for (plat, vid, aud) in [
            (Platform::Windows, Some("Cam"), "Mic"),
            (Platform::MacOS, Some("0"), "1"),
        ] {
            let args = build_unified_capture_args(
                plat,
                vid,
                aud,
                "FINAL_OUTPUT.mp4",
                &CaptureOpts::default(),
            );
            // The mp4 file output is still complete: preceded by -y, followed by
            // the second (preview) output — so it is NOT last, but `-y <path>` are
            // still adjacent and in order.
            let y = args
                .iter()
                .position(|a| a == "-y")
                .expect("the mp4 output has a -y");
            assert_eq!(args[y + 1], "FINAL_OUTPUT.mp4", "got: {args:?}");
            // The preview second output is the tail.
            assert_eq!(args.last().unwrap(), "pipe:1", "got: {args:?}");
            // The mp4 path comes BEFORE pipe:1 (file output is fully specified
            // first; the preview is the LAST output).
            let path_idx = args.iter().position(|a| a == "FINAL_OUTPUT.mp4").unwrap();
            let pipe_idx = args.iter().position(|a| a == "pipe:1").unwrap();
            assert!(
                path_idx < pipe_idx,
                "mp4 output before the preview; got: {args:?}"
            );
        }
    }

    /// The video MJPEG preview second output: maps only video, drops audio, scales
    /// down + caps fps, encodes mjpeg to stdout. The mp4 output maps BOTH streams
    /// explicitly so the two outputs are unambiguous.
    #[test]
    fn video_mjpeg_preview_args_are_present_and_well_formed() {
        let args = build_unified_capture_args(
            Platform::MacOS,
            Some("0"),
            "1",
            "/tmp/sermon.mp4",
            &CaptureOpts::default(),
        );
        // Explicit mapping on the mp4 output (video + audio).
        assert!(
            has_pair(&args, "-map", "0:v"),
            "mp4 maps video; got: {args:?}"
        );
        assert!(
            has_pair(&args, "-map", "0:a"),
            "mp4 maps audio; got: {args:?}"
        );
        // The preview tail: -an (no audio), the scale+fps filter, mjpeg to pipe:1.
        assert!(
            args.iter().any(|a| a == "-an"),
            "preview drops audio; got: {args:?}"
        );
        assert!(
            has_pair(&args, "-vf", "scale=480:-2,fps=8"),
            "preview downscales + caps fps; got: {args:?}"
        );
        assert!(
            has_pair(&args, "-c:v", "mjpeg"),
            "preview encodes mjpeg; got: {args:?}"
        );
        assert!(
            has_pair(&args, "-f", "mjpeg"),
            "preview muxes mjpeg; got: {args:?}"
        );
        assert_eq!(args.last().unwrap(), "pipe:1", "preview writes to stdout");
        // The recording video codec (libx264) is still present for the mp4.
        assert!(
            has_pair(&args, "-c:v", "libx264"),
            "mp4 still libx264; got: {args:?}"
        );
    }

    /// SAFETY GUARD: the AUDIO-ONLY path (the common church case) must carry NO
    /// second output / NO `pipe:1` / NO mjpeg / NO explicit `-map`. A regression
    /// here would change the byte-for-byte audio-only args.
    #[test]
    fn audio_only_has_no_second_output_no_pipe_no_mjpeg() {
        for (plat, aud, path) in [
            (Platform::MacOS, "1", "/tmp/x.mp3"),
            (Platform::MacOS, "2", "/tmp/x.m4a"),
            (Platform::Windows, "USB Audio CODEC", "out.wav"),
        ] {
            let args = build_unified_capture_args(plat, None, aud, path, &CaptureOpts::default());
            assert!(
                !args.iter().any(|a| a == "pipe:1"),
                "audio-only must not write to stdout; got: {args:?}"
            );
            assert!(
                !args.iter().any(|a| a == "mjpeg"),
                "audio-only must not encode/mux mjpeg; got: {args:?}"
            );
            assert!(
                !args.iter().any(|a| a == "-map"),
                "audio-only needs no explicit stream mapping; got: {args:?}"
            );
            assert!(
                !args.iter().any(|a| a == "-an"),
                "audio-only has no audio-less preview; got: {args:?}"
            );
            // The audio output path is the SOLE output → last, preceded by -y.
            assert_eq!(args.last().unwrap(), path, "got: {args:?}");
            let n = args.len();
            assert_eq!(args[n - 2], "-y", "got: {args:?}");
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
            channel_mode: ChannelMode::MonoMix,
            framerate: 25,
            ..CaptureOpts::default()
        };
        let args =
            build_unified_capture_args(Platform::Windows, Some("Cam"), "Mic", "out.mp4", &opts);
        assert!(has_pair(&args, "-ac", "1"), "mono → -ac 1");
        assert!(has_pair(&args, "-framerate", "25"));
    }

    #[test]
    fn codec_for_extension_normalises_case_and_dot() {
        assert_eq!(codec_for_extension("mp3"), AudioCodec::Mp3);
        assert_eq!(codec_for_extension(".MP3"), AudioCodec::Mp3);
        assert_eq!(codec_for_extension("WAV"), AudioCodec::PcmS16le);
        assert_eq!(codec_for_extension(".Flac"), AudioCodec::Flac);
        assert_eq!(codec_for_extension("m4a"), AudioCodec::Aac);
        assert_eq!(codec_for_extension("mp4"), AudioCodec::Aac);
        assert_eq!(codec_for_extension("aac"), AudioCodec::Aac);
        // Unknown / empty → AAC (never panics, always a valid codec).
        assert_eq!(codec_for_extension("ogg"), AudioCodec::Aac);
        assert_eq!(codec_for_extension(""), AudioCodec::Aac);
    }

    #[test]
    fn audio_encode_args_emit_bitrate_only_for_lossy() {
        // mp3/aac carry -b:a; pcm/flac must NOT (ffmpeg rejects it).
        let mp3 = audio_encode_args("mp3", 2, Some(48_000), 192);
        assert!(has_pair(&mp3, "-c:a", "libmp3lame"));
        assert!(has_pair(&mp3, "-b:a", "192k"));
        let aac = audio_encode_args("m4a", 2, Some(48_000), 256);
        assert!(has_pair(&aac, "-c:a", "aac"));
        assert!(has_pair(&aac, "-b:a", "256k"));
        let wav = audio_encode_args("wav", 1, Some(48_000), 192);
        assert!(has_pair(&wav, "-c:a", "pcm_s16le"));
        assert!(!wav.iter().any(|a| a == "-b:a"));
        let flac = audio_encode_args("flac", 2, Some(48_000), 192);
        assert!(has_pair(&flac, "-c:a", "flac"));
        assert!(!flac.iter().any(|a| a == "-b:a"));
    }

    #[test]
    fn audio_encode_args_omits_ar_when_native() {
        // `None` = capture at the device's native rate → NO `-ar` flag at all
        // (the anti-resample fix). The rest of the run is unchanged.
        let mp3 = audio_encode_args("mp3", 2, None, 192);
        assert!(has_pair(&mp3, "-c:a", "libmp3lame"));
        assert!(has_pair(&mp3, "-b:a", "192k"));
        assert!(has_pair(&mp3, "-ac", "2"));
        assert!(!mp3.iter().any(|a| a == "-ar"), "native rate omits -ar");
        // Lossless + native: no -b:a AND no -ar.
        let wav = audio_encode_args("wav", 1, None, 192);
        assert!(has_pair(&wav, "-c:a", "pcm_s16le"));
        assert!(!wav.iter().any(|a| a == "-b:a"));
        assert!(!wav.iter().any(|a| a == "-ar"));
    }

    #[test]
    fn sample_rate_and_bitrate_flow_into_args() {
        let opts = CaptureOpts {
            sample_rate: Some(44_100),
            bitrate_kbps: 256,
            ..CaptureOpts::default()
        };
        let mp3 = build_unified_capture_args(Platform::MacOS, None, "1", "/tmp/x.mp3", &opts);
        assert!(has_pair(&mp3, "-ar", "44100"), "sample rate reaches ffmpeg");
        assert!(has_pair(&mp3, "-b:a", "256k"), "bitrate reaches ffmpeg");
        // FLAC ignores the bitrate but still honours the sample rate.
        let flac_opts = CaptureOpts {
            sample_rate: Some(96_000),
            ..CaptureOpts::default()
        };
        let flac =
            build_unified_capture_args(Platform::MacOS, None, "1", "/tmp/x.flac", &flac_opts);
        assert!(has_pair(&flac, "-ar", "96000"));
        assert!(!flac.iter().any(|a| a == "-b:a"));
    }

    #[test]
    fn auto_sample_rate_omits_ar_in_full_capture_args() {
        // The default CaptureOpts now means "native rate" → the full builder must
        // not emit `-ar` (forcing a rate on a 44.1 kHz mixer caused choppiness).
        let args = build_unified_capture_args(
            Platform::MacOS,
            None,
            "1",
            "/tmp/x.mp3",
            &CaptureOpts::default(),
        );
        assert!(
            !args.iter().any(|a| a == "-ar"),
            "Auto (native) sample rate must omit -ar; got: {args:?}"
        );
    }

    #[test]
    fn live_levels_off_drops_astats_keeps_rest() {
        let opts = CaptureOpts {
            live_levels: false,
            stop_on_silence: true,
            channel_mode: ChannelMode::MonoMix,
            ..CaptureOpts::default()
        };
        // Windows so drift is present too — every NON-levels filter must survive.
        let args =
            build_unified_capture_args(Platform::Windows, Some("Cam"), "Mic", "out.mp4", &opts);
        let af = args
            .iter()
            .position(|a| a == "-af")
            .map(|i| args[i + 1].clone())
            .expect("an -af chain");
        assert!(!af.contains("astats"), "levels must be dropped; got: {af}");
        assert!(af.contains("aresample"), "drift must remain; got: {af}");
        assert!(af.contains("pan="), "pan must remain; got: {af}");
        assert!(
            af.contains("silencedetect"),
            "silencedetect must remain; got: {af}"
        );
    }

    #[test]
    fn live_levels_on_includes_astats() {
        // Default has live_levels = true → the astats pass is present.
        let args = build_unified_capture_args(
            Platform::MacOS,
            None,
            "1",
            "/tmp/x.mp3",
            &CaptureOpts::default(),
        );
        let af = args
            .iter()
            .position(|a| a == "-af")
            .map(|i| args[i + 1].clone())
            .expect("an -af chain");
        assert!(af.contains("astats=metadata=1"));
    }

    #[test]
    fn channel_map_filter_strings() {
        assert_eq!(channel_map_filter(ChannelMode::Stereo), None);
        assert_eq!(
            channel_map_filter(ChannelMode::MonoL).as_deref(),
            Some("pan=mono|c0=c0")
        );
        assert_eq!(
            channel_map_filter(ChannelMode::MonoR).as_deref(),
            Some("pan=mono|c0=c1")
        );
        assert_eq!(
            channel_map_filter(ChannelMode::MonoMix).as_deref(),
            Some("pan=mono|c0=0.5*c0+0.5*c1")
        );
    }

    #[test]
    fn stereo_emits_ac_2_and_no_pan() {
        let args = build_unified_capture_args(
            Platform::MacOS,
            None,
            "1",
            "/tmp/x.mp3",
            &CaptureOpts::default(),
        );
        assert!(has_pair(&args, "-ac", "2"));
        let af = args
            .iter()
            .position(|a| a == "-af")
            .map(|i| args[i + 1].clone())
            .unwrap();
        assert!(!af.contains("pan="), "stereo needs no pan; got: {af}");
    }

    #[test]
    fn mono_modes_emit_ac_1_and_pan() {
        for (mode, expected) in [
            (ChannelMode::MonoL, "pan=mono|c0=c0"),
            (ChannelMode::MonoR, "pan=mono|c0=c1"),
            (ChannelMode::MonoMix, "pan=mono|c0=0.5*c0+0.5*c1"),
        ] {
            let opts = CaptureOpts {
                channel_mode: mode,
                ..CaptureOpts::default()
            };
            let args = build_unified_capture_args(Platform::MacOS, None, "1", "/tmp/x.mp3", &opts);
            assert!(has_pair(&args, "-ac", "1"), "{mode:?} → -ac 1");
            let af = args
                .iter()
                .position(|a| a == "-af")
                .map(|i| args[i + 1].clone())
                .unwrap();
            assert!(
                af.contains(expected),
                "{mode:?} needs {expected}; got: {af}"
            );
        }
    }

    #[test]
    fn pan_slots_after_drift_before_silencedetect() {
        // Windows MonoMix: the chain order must be aresample, pan, silencedetect,
        // astats — so the meters/silence see the post-downmix signal.
        let opts = CaptureOpts {
            channel_mode: ChannelMode::MonoMix,
            stop_on_silence: true,
            ..CaptureOpts::default()
        };
        let args =
            build_unified_capture_args(Platform::Windows, Some("Cam"), "Mic", "out.mp4", &opts);
        let af = args
            .iter()
            .position(|a| a == "-af")
            .map(|i| args[i + 1].clone())
            .unwrap();
        let drift = af.find("aresample").unwrap();
        let pan = af.find("pan=").unwrap();
        let sil = af.find("silencedetect").unwrap();
        let lvl = af.find("astats").unwrap();
        assert!(drift < pan, "pan after drift; got: {af}");
        assert!(pan < sil, "pan before silencedetect; got: {af}");
        assert!(sil < lvl, "silencedetect before astats; got: {af}");
    }
}
