//! Unified ffmpeg capture-argument builder.
//!
//! Ported + hardened from the Electron `unified-recorder.ts`. ONE ffmpeg process
//! opens the camera AND the microphone and writes the recording, with the audio
//! passed through the core filter chain. This is a pure `Vec<String>` builder —
//! no process is spawned — so the whole argument shape is unit-tested without
//! hardware. The engine (`src-tauri/src/recorder/engine.rs`) drives it.
//!
//! ## Inputs
//!   - **macOS** — a single `-f avfoundation -i "<videoIdx>:<audioIdx>"` (or
//!     `:<audioIdx>` audio-only). A deep `-thread_queue_size` ([`MAC_INPUT_QUEUE`])
//!     absorbs avfoundation's scheduling jitter (the anti-choppiness fix);
//!     audio-only adds `-fflags +genpts`.
//!   - **Windows** — `-f dshow` with separate video/audio `-i` (two device clocks).
//!
//! ## Audio chain (`-af`), in order: drift → channel `pan` → silencedetect → astats
//!   - **Native sample rate** by default: [`audio_encode_args`] omits `-ar` so the
//!     device's own rate is kept (forcing 48 kHz on a 44.1 kHz mixer resampled and
//!     dropped samples — the choppiness root cause). Explicit rates still force one.
//!   - **Channel modes** ([`channel_map_filter`]): stereo, or a `pan` downmix for
//!     MonoL / MonoR / MonoMix (real channel selection, not a bare `-ac 1`).
//!   - **`silencedetect`** ([`crate::ffmpeg::build_silence_detect_filter`]) so a
//!     muted mixer emits markers the watcher reacts to.
//!   - **Live `astats` levels** ([`crate::ffmpeg::build_levels_detect_filter`],
//!     droppable via [`CaptureOpts::live_levels`]) drive the L/R meters.
//!   - Codec is chosen from the OUTPUT extension ([`codec_for_extension`]) so the
//!     stream always matches its container (mp3/wav/flac/aac).
//!
//! ## Video + A/V sync (when a camera is present)
//!   - `-c:v libx264 -preset veryfast` + **`-r <fps> -fps_mode cfr`**: conforms the
//!     (variable-frame-rate) camera to TRUE constant frame rate locked to the audio
//!     clock, and the audio chain gets `aresample=async=1000:first_pts=0` — together
//!     these keep lip-sync over a whole service (cameras drop fps in low light; a
//!     USB mixer's clock differs from the camera's).
//!   - **Deadlock-proof live preview** ([`CaptureOpts::preview_jpg`]): a SECOND
//!     output writes a low-fps JPEG to a FILE (`-update 1`) the UI polls. A file
//!     sink — never a stdout pipe — so a slow/absent reader can NEVER back-pressure
//!     and freeze the capture (the bug an earlier pipe version had).
//!
//! Split-recording rotation + reconnect-fragment naming + pre-roll prepend are the
//! recorder/`recorder.rs`/`preroll.rs` concern; this builder shapes one segment's
//! args. The output path is always the primary output (the preview JPEG tails it).

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

/// Explicit per-channel `pan` for multi-channel mixers (e.g. an X32): record any
/// two 0-based device input channels into a stereo file. Returns `Some(filter)`
/// ONLY for `ChannelMode::Stereo` with a non-identity `(l, r)` pair — i.e. when
/// the user picked channels other than the default `(0, 1)`. Mono modes keep
/// [`channel_map_filter`]'s routing (device routing for mono picks is
/// HARDWARE-UNVERIFIED, so we defer it). `None` means "use the mode default".
pub fn custom_channel_map_filter(
    mode: ChannelMode,
    l: Option<i32>,
    r: Option<i32>,
) -> Option<String> {
    match (mode, l, r) {
        (ChannelMode::Stereo, Some(l), Some(r)) if (l, r) != (0, 1) => {
            Some(format!("pan=stereo|c0=c{l}|c1=c{r}"))
        }
        _ => None,
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

/// A camera capture mode as the device advertises it: a resolution plus the
/// frame rates supported at that resolution. Parsed from avfoundation's
/// "Supported modes" block (see [`parse_avfoundation_modes`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CameraMode {
    pub width: u32,
    pub height: u32,
    /// Supported frame rates at this resolution (rounded to whole fps).
    pub framerates: Vec<u32>,
}

/// The resolved camera INPUT mode to pin on avfoundation's `-video_size` /
/// `-framerate` — a size + frame rate the device ACTUALLY advertises.
///
/// This exists because avfoundation REJECTS any size/rate the camera doesn't
/// list: a FaceTime HD camera advertises only 15/30 fps, so `-framerate 25` (the
/// common PAL default) — and even the bare-default 29.97 — fail with "Selected
/// framerate … is not supported" → the camera never opens → the recording dies.
/// We pin a REAL advertised mode on the input, and conform to the user's target
/// fps separately in the encoder (`-r/-fps_mode cfr`), so the two are decoupled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VideoCaptureMode {
    pub width: u32,
    pub height: u32,
    pub input_fps: u32,
}

/// Parse avfoundation's "Supported modes:" stderr block into [`CameraMode`]s.
/// ffmpeg prints, after rejecting a size/rate:
/// ```text
/// [avfoundation @ ..] Supported modes:
/// [avfoundation @ ..]   1920x1080@[15.000000 30.000000]fps
/// ```
/// We scan each line for `<w>x<h>@[<f> <f> …]`, tolerant of the log prefix and
/// fractional rates (rounded). Modes are returned in the order listed.
pub fn parse_avfoundation_modes(stderr: &str) -> Vec<CameraMode> {
    let mut out = Vec::new();
    for line in stderr.lines() {
        let Some(at) = line.find("@[") else { continue };
        let Some(rel_close) = line[at..].find(']') else {
            continue;
        };
        // Size token: the `<w>x<h>` immediately before '@'.
        let size_tok = line[..at].rsplit([' ', '\t']).next().unwrap_or("");
        let Some((w, h)) = size_tok.split_once('x') else {
            continue;
        };
        let (Ok(width), Ok(height)) = (w.trim().parse::<u32>(), h.trim().parse::<u32>()) else {
            continue;
        };
        let inner = &line[at + 2..at + rel_close];
        let framerates: Vec<u32> = inner
            .split_whitespace()
            .filter_map(|t| t.parse::<f64>().ok())
            .map(|f| f.round() as u32)
            .filter(|f| *f > 0)
            .collect();
        if !framerates.is_empty() {
            out.push(CameraMode {
                width,
                height,
                framerates,
            });
        }
    }
    out
}

/// A summary of what a camera can actually capture, derived from its advertised
/// [`CameraMode`]s. Used to GATE the UI so the user can only pick resolutions /
/// frame rates the device supports — a camera can't record a mode that isn't in
/// its descriptor (avfoundation/dshow reject it and the camera never opens).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CameraCapabilities {
    /// Largest advertised width/height (the camera's native ceiling).
    pub max_width: u32,
    pub max_height: u32,
    /// Highest advertised frame rate across all modes.
    pub max_fps: u32,
    /// Which resolution TAGS (`480p`/`720p`/`1080p`/`2160p`) the camera can
    /// deliver — i.e. it advertises a mode at least that tall (we can downscale a
    /// larger native mode, but never upscale to a fake higher resolution).
    pub supported_resolutions: Vec<String>,
    /// The standard UI frame-rate options (24/25/30/50/60) the camera can reach
    /// natively (≤ its advertised max — we never offer frame-duplicated "fake" fps).
    pub supported_framerates: Vec<u32>,
}

/// The resolution tags the UI offers, paired with their pixel height.
const RES_TAGS: &[(&str, u32)] = &[
    ("480p", 480),
    ("720p", 720),
    ("1080p", 1080),
    ("2160p", 2160),
];
/// The frame-rate options the UI offers.
const FPS_OPTIONS: &[u32] = &[24, 25, 30, 50, 60];

/// Summarise a device's advertised modes into [`CameraCapabilities`] for UI
/// gating. Empty input (no modes parsed) yields an all-zero summary with empty
/// lists — the caller should then fall back to offering everything (better to let
/// the user try than to block on a failed probe).
pub fn summarize_camera_capabilities(modes: &[CameraMode]) -> CameraCapabilities {
    let max_width = modes.iter().map(|m| m.width).max().unwrap_or(0);
    let max_height = modes.iter().map(|m| m.height).max().unwrap_or(0);
    let max_fps = modes
        .iter()
        .flat_map(|m| m.framerates.iter().copied())
        .max()
        .unwrap_or(0);
    let supported_resolutions = RES_TAGS
        .iter()
        .filter(|(_, h)| max_height >= *h)
        .map(|(tag, _)| (*tag).to_string())
        .collect();
    let supported_framerates = FPS_OPTIONS
        .iter()
        .copied()
        .filter(|f| *f <= max_fps)
        .collect();
    CameraCapabilities {
        max_width,
        max_height,
        max_fps,
        supported_resolutions,
        supported_framerates,
    }
}

/// Pick the best INPUT mode for a target size + frame rate from the device's
/// advertised modes. Prefers the resolution whose area is closest to the target
/// (a landscape target won't pick a portrait mode of similar area), then the
/// frame rate closest to the target (ties → the higher rate, since conforming
/// DOWN in the encoder is clean). `None` when no modes parsed → caller keeps the
/// legacy guess.
pub fn resolve_camera_mode(
    modes: &[CameraMode],
    target_w: u32,
    target_h: u32,
    target_fps: u32,
) -> Option<VideoCaptureMode> {
    let target_landscape = target_w >= target_h;
    let target_area = i64::from(target_w) * i64::from(target_h);
    let best = modes.iter().min_by_key(|m| {
        let area = i64::from(m.width) * i64::from(m.height);
        let orient_penalty = u8::from((m.width >= m.height) != target_landscape);
        (orient_penalty, (area - target_area).abs())
    })?;
    let input_fps = pick_input_framerate(&best.framerates, target_fps)?;
    Some(VideoCaptureMode {
        width: best.width,
        height: best.height,
        input_fps,
    })
}

/// Map a settings resolution tag (`"480p"`/`"720p"`/`"1080p"`/`"2160p"`) to its
/// (width, height). Used as the camera-mode probe TARGET so a 1080p setting
/// actually records 1080p (when the camera advertises it), not the old hardcoded
/// 720p. `"2160p"` is 4K UHD (3840×2160). Unknown tags fall back to 720p.
pub fn resolution_dims(tag: &str) -> (u32, u32) {
    match tag.trim().to_ascii_lowercase().as_str() {
        "480p" => (854, 480),
        "1080p" => (1920, 1080),
        "2160p" | "4k" => (3840, 2160),
        // "720p" + anything unknown → 720p.
        _ => (1280, 720),
    }
}

/// The advertised frame rate closest to `target`; ties prefer the HIGHER rate.
fn pick_input_framerate(framerates: &[u32], target: u32) -> Option<u32> {
    framerates
        .iter()
        .copied()
        .min_by_key(|f| ((i64::from(*f) - i64::from(target)).abs(), -i64::from(*f)))
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
    /// Explicit 0-based device input channel → LEFT output (multi-channel mixers).
    /// `None` keeps the `channel_mode` default routing. See
    /// [`custom_channel_map_filter`].
    pub input_channel_l: Option<i32>,
    /// Explicit 0-based device input channel → RIGHT output. See `input_channel_l`.
    pub input_channel_r: Option<i32>,
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
    /// For a VIDEO recording, a file path the recorder ALSO writes a low-fps,
    /// auto-overwriting JPEG to (`-update 1`), so the UI can show a live preview
    /// WHILE recording. A FILE sink (NOT a stdout pipe) is deadlock-proof: ffmpeg
    /// never blocks on a file write, so a slow/absent UI reader can NEVER freeze
    /// the capture (the bug that froze recording when this was a pipe). `None`
    /// (and all audio-only recordings) add no second output.
    pub preview_jpg: Option<String>,
    /// The probed camera INPUT mode to pin (`-video_size`/`-framerate`). `None`
    /// keeps the legacy 720p@`framerate` guess — but that guess fails on a camera
    /// that doesn't advertise that exact mode, which is why the recorder probes
    /// and fills this in. The OUTPUT still conforms to `framerate` via `-r`.
    pub video_input: Option<VideoCaptureMode>,
    /// Video output codec — H.264 (default, universal) or H.265/HEVC (~half the
    /// size).
    pub video_codec: crate::editor::VideoCodec,
    /// Use the **VideoToolbox hardware encoder** (macOS) instead of software
    /// x264/x265. Realtime even at 4K — the right choice for live 4K H.265. The
    /// builder honours this ONLY on macOS (`Platform::MacOS`); elsewhere it
    /// silently falls back to software (VideoToolbox is mac-only).
    pub hw_accel: bool,
}

impl Default for CaptureOpts {
    fn default() -> Self {
        Self {
            stop_on_silence: false,
            silence_threshold_db: None,
            framerate: 30,
            channel_mode: ChannelMode::Stereo,
            input_channel_l: None,
            input_channel_r: None,
            sample_rate: None,
            bitrate_kbps: 192,
            live_levels: true,
            preview_jpg: None,
            video_input: None,
            video_codec: crate::editor::VideoCodec::H264,
            hw_accel: false,
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
    // Explicit per-channel pick (multi-channel mixers) overrides the mode default
    // when the user chose channels other than (0, 1); otherwise the mode routing.
    let pan = custom_channel_map_filter(
        opts.channel_mode,
        opts.input_channel_l,
        opts.input_channel_r,
    )
    .or_else(|| channel_map_filter(opts.channel_mode))
    .unwrap_or_default();
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
                // avfoundation REJECTS any size/framerate the camera doesn't
                // advertise — including the bare default 29.97 and the common PAL
                // 25 — with "Selected framerate is not supported" → the camera
                // never opens. So we pin a REAL advertised mode (probed at start;
                // `video_input`), falling back to 720p@`framerate` only when the
                // probe yielded nothing. `-framerate` is a VIDEO option, omitted
                // for audio-only where it would confuse the input clock.
                let (in_w, in_h, in_fps) = match opts.video_input {
                    Some(m) => (m.width, m.height, m.input_fps),
                    None => (1280, 720, opts.framerate),
                };
                args.push("-framerate".into());
                args.push(in_fps.to_string());
                args.push("-video_size".into());
                args.push(format!("{in_w}x{in_h}"));
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
    // `codec_for_extension`) so the encoded stream matches the chosen container —
    // mp3→libmp3lame, wav→pcm_s16le, flac→flac, m4a/mp4/aac→aac. (Previously this
    // hardcoded AAC, which ffmpeg rejects when muxing into a .mp3/.wav/.flac
    // container — the default `Mp3` format never recorded.) Sample rate, bitrate
    // and channel count come from validated settings. Video (when present) stays a
    // simple libx264.
    if has_video {
        // Hardware (VideoToolbox) encoding is honoured ONLY on macOS — it's the
        // realtime path for live 4K H.265. Elsewhere we fall back to software
        // x264/x265 (VideoToolbox is mac-only).
        let use_hw = opts.hw_accel && matches!(platform, Platform::MacOS);
        args.push("-c:v".into());
        if use_hw {
            match opts.video_codec {
                crate::editor::VideoCodec::H264 => args.push("h264_videotoolbox".into()),
                crate::editor::VideoCodec::H265 => {
                    args.push("hevc_videotoolbox".into());
                    args.push("-tag:v".into());
                    args.push("hvc1".into());
                }
            }
            // VideoToolbox has no CRF — target a resolution-appropriate bitrate,
            // and `-realtime 1` biases it for live capture. Output dims = the
            // pinned input mode (capture doesn't scale); default to 1080p.
            let (w, h) = opts
                .video_input
                .map(|m| (m.width, m.height))
                .unwrap_or((1920, 1080));
            args.push("-b:v".into());
            args.push(format!(
                "{}k",
                crate::editor::default_video_bitrate_kbps(w, h)
            ));
            args.push("-realtime".into());
            args.push("1".into());
        } else {
            match opts.video_codec {
                crate::editor::VideoCodec::H264 => args.push("libx264".into()),
                crate::editor::VideoCodec::H265 => {
                    args.push("libx265".into());
                    // `hvc1` tag so QuickTime/Apple players accept the HEVC stream
                    // in an mp4/mov container.
                    args.push("-tag:v".into());
                    args.push("hvc1".into());
                }
            }
            args.push("-preset".into());
            args.push("veryfast".into());
        }
        args.push("-pix_fmt".into());
        args.push("yuv420p".into());
        // NOTE: the OUTPUT resolution is controlled by the INPUT `-video_size`
        // (the probed/pinned camera mode above) — NOT by an output `-vf scale`.
        // An output `-vf` on this primary output conflicted with the preview
        // output's `-map 0:v` (ffmpeg can't feed one input stream into both a
        // simple filtergraph AND a direct map) → the whole recording failed to
        // produce a file. So resolution stays an input-mode concern.
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
    // `+faststart` (progressive playback) is only valid for the ISO/QuickTime
    // containers — mp4/mov/m4v. A Matroska (.mkv) recording would reject it.
    if has_video && matches!(ext_of(output_path), "mp4" | "mov" | "m4v") {
        args.push("-movflags".into());
        args.push("+faststart".into());
    }

    // The mp4/audio file — the PRIMARY output (preceded by `-y`). For audio-only
    // (and video without a preview path) this is the sole output.
    args.push("-y".into());
    args.push(output_path.into());

    // DEADLOCK-PROOF live preview (video recordings only). A SECOND output writes
    // a small, downscaled, low-fps JPEG that ffmpeg auto-overwrites (`-update 1`)
    // so the UI can poll it for a live image WHILE recording. This is a FILE sink,
    // NOT a stdout pipe: ffmpeg never blocks on a file write, so an absent/slow UI
    // reader can NEVER back-pressure and freeze the capture (the bug that froze
    // recording when this was `pipe:1`). The primary mp4 above is already complete,
    // so the preview output is purely additive and the recording finalises
    // normally regardless of it. The `-map 0:v` selects only the camera; the
    // primary output keeps default stream selection (video + audio), which ffmpeg
    // resolves unambiguously (verified).
    if has_video {
        if let Some(preview) = &opts.preview_jpg {
            args.push("-map".into());
            args.push("0:v".into());
            args.push("-an".into());
            args.push("-vf".into());
            args.push("scale=480:-2,fps=4".into());
            args.push("-update".into());
            args.push("1".into());
            args.push("-y".into());
            args.push(preview.clone());
        }
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn has_pair(args: &[String], a: &str, b: &str) -> bool {
        args.windows(2).any(|w| w[0] == a && w[1] == b)
    }

    // ── camera mode probe parsing + resolution (the framerate fix) ──
    const FACETIME_MODES: &str = "\
[avfoundation @ 0x1] Selected framerate (25.000000) is not supported by the device.
[avfoundation @ 0x1] Supported modes:
[avfoundation @ 0x1]   1920x1080@[15.000000 30.000000]fps
[avfoundation @ 0x1]   1280x720@[15.000000 30.000000]fps
[avfoundation @ 0x1]   1080x1920@[15.000000 30.000000]fps
[avfoundation @ 0x1]   640x480@[15.000000 30.000000]fps";

    #[test]
    fn parses_the_avfoundation_modes_block() {
        let modes = parse_avfoundation_modes(FACETIME_MODES);
        assert_eq!(modes.len(), 4);
        assert_eq!(modes[1].width, 1280);
        assert_eq!(modes[1].height, 720);
        assert_eq!(modes[1].framerates, vec![15, 30]);
        // The non-mode lines (the error + header) are ignored.
        assert!(parse_avfoundation_modes("frame= 10 fps= 30").is_empty());
    }

    #[test]
    fn resolves_to_a_real_mode_for_25fps_target() {
        // The actual bug: target 25 fps on a camera that only does 15/30.
        let modes = parse_avfoundation_modes(FACETIME_MODES);
        let r = resolve_camera_mode(&modes, 1280, 720, 25).unwrap();
        assert_eq!((r.width, r.height), (1280, 720)); // closest size to target
        assert_eq!(r.input_fps, 30); // closest supported rate to 25 (ties→higher)
    }

    #[test]
    fn resolve_prefers_landscape_and_nearest_size() {
        let modes = parse_avfoundation_modes(FACETIME_MODES);
        // A 720p landscape target must NOT pick the 1080x1920 portrait mode.
        let r = resolve_camera_mode(&modes, 1280, 720, 30).unwrap();
        assert!(r.width >= r.height, "picked a portrait mode: {r:?}");
        assert_eq!(r.input_fps, 30);
        // Exact-rate target → exact rate.
        assert_eq!(
            resolve_camera_mode(&modes, 1280, 720, 15)
                .unwrap()
                .input_fps,
            15
        );
    }

    #[test]
    fn resolve_is_none_when_no_modes_parsed() {
        assert_eq!(resolve_camera_mode(&[], 1280, 720, 30), None);
    }

    #[test]
    fn resolution_tag_maps_to_dims_and_drives_1080p() {
        assert_eq!(resolution_dims("480p"), (854, 480));
        assert_eq!(resolution_dims("720p"), (1280, 720));
        assert_eq!(resolution_dims("1080p"), (1920, 1080));
        assert_eq!(resolution_dims(""), (1280, 720)); // unknown → 720p
                                                      // A 1080p target on a camera that advertises 1080p resolves to 1080p
                                                      // (the bug: it used to hardcode 720p regardless of the setting).
        let modes = parse_avfoundation_modes(FACETIME_MODES);
        let (w, h) = resolution_dims("1080p");
        let r = resolve_camera_mode(&modes, w, h, 30).unwrap();
        assert_eq!((r.width, r.height), (1920, 1080));
    }

    #[test]
    fn video_input_overrides_the_legacy_720p_guess() {
        let opts = CaptureOpts {
            video_input: Some(VideoCaptureMode {
                width: 1920,
                height: 1080,
                input_fps: 30,
            }),
            ..Default::default()
        };
        let args = build_unified_capture_args(Platform::MacOS, Some("0"), "1", "/tmp/v.mp4", &opts);
        // Input pins the PROBED mode…
        assert!(has_pair(&args, "-framerate", "30"));
        assert!(has_pair(&args, "-video_size", "1920x1080"));
        // …while the OUTPUT still conforms to the user's target (default 30 here).
        assert!(has_pair(&args, "-fps_mode", "cfr"));
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
    fn capabilities_gate_resolution_and_fps_to_advertised() {
        // A 1080p@[30] camera: 480p/720p/1080p supported (downscale), NOT 4K;
        // fps options ≤30 (24/25/30), not 50/60.
        let modes = vec![
            CameraMode {
                width: 1280,
                height: 720,
                framerates: vec![30],
            },
            CameraMode {
                width: 1920,
                height: 1080,
                framerates: vec![15, 30],
            },
        ];
        let cap = summarize_camera_capabilities(&modes);
        assert_eq!(cap.max_width, 1920);
        assert_eq!(cap.max_height, 1080);
        assert_eq!(cap.max_fps, 30);
        assert_eq!(cap.supported_resolutions, vec!["480p", "720p", "1080p"]);
        assert_eq!(cap.supported_framerates, vec![24, 25, 30]);
    }

    #[test]
    fn capabilities_4k60_camera_supports_everything() {
        let modes = vec![CameraMode {
            width: 3840,
            height: 2160,
            framerates: vec![24, 30, 60],
        }];
        let cap = summarize_camera_capabilities(&modes);
        assert_eq!(
            cap.supported_resolutions,
            vec!["480p", "720p", "1080p", "2160p"]
        );
        assert_eq!(cap.supported_framerates, vec![24, 25, 30, 50, 60]);
    }

    #[test]
    fn capabilities_empty_modes_is_all_zero() {
        let cap = summarize_camera_capabilities(&[]);
        assert_eq!(cap.max_height, 0);
        assert!(cap.supported_resolutions.is_empty());
        assert!(cap.supported_framerates.is_empty());
    }

    #[test]
    fn resolution_dims_includes_4k() {
        assert_eq!(resolution_dims("480p"), (854, 480));
        assert_eq!(resolution_dims("720p"), (1280, 720));
        assert_eq!(resolution_dims("1080p"), (1920, 1080));
        assert_eq!(resolution_dims("2160p"), (3840, 2160));
        assert_eq!(resolution_dims("4k"), (3840, 2160));
        assert_eq!(resolution_dims("garbage"), (1280, 720));
    }

    #[test]
    fn h265_recording_uses_libx265_with_hvc1_tag() {
        let opts = CaptureOpts {
            video_codec: crate::editor::VideoCodec::H265,
            ..CaptureOpts::default()
        };
        let args = build_unified_capture_args(Platform::MacOS, Some("0"), "1", "/tmp/s.mp4", &opts);
        assert!(has_pair(&args, "-c:v", "libx265"));
        assert!(has_pair(&args, "-tag:v", "hvc1"));
        // faststart still emitted for mp4.
        assert!(has_pair(&args, "-movflags", "+faststart"));
    }

    #[test]
    fn primary_output_has_no_vf_only_preview_does() {
        // The primary output must NOT carry an output `-vf` — it would conflict
        // with the preview output's `-map 0:v` (one input stream can't feed both a
        // simple filtergraph and a direct map) and break the recording. The only
        // `-vf` is the preview's `scale=480:-2,fps=4`.
        let opts = CaptureOpts {
            preview_jpg: Some("/tmp/p.jpg".into()),
            ..CaptureOpts::default()
        };
        let args = build_unified_capture_args(Platform::MacOS, Some("0"), "1", "/tmp/s.mp4", &opts);
        let vf_values: Vec<&String> = args
            .iter()
            .enumerate()
            .filter(|(i, a)| *a == "-vf" && *i + 1 < args.len())
            .map(|(i, _)| &args[i + 1])
            .collect();
        assert_eq!(
            vf_values.len(),
            1,
            "exactly one -vf (the preview): {args:?}"
        );
        assert!(vf_values[0].contains("scale=480"), "{args:?}");
    }

    #[test]
    fn hw_accel_uses_videotoolbox_on_mac_with_bitrate() {
        let opts = CaptureOpts {
            hw_accel: true,
            video_codec: crate::editor::VideoCodec::H265,
            video_input: Some(VideoCaptureMode {
                width: 3840,
                height: 2160,
                input_fps: 30,
            }),
            ..CaptureOpts::default()
        };
        let args = build_unified_capture_args(Platform::MacOS, Some("0"), "1", "/tmp/s.mov", &opts);
        assert!(has_pair(&args, "-c:v", "hevc_videotoolbox"));
        assert!(has_pair(&args, "-tag:v", "hvc1"));
        assert!(has_pair(&args, "-b:v", "40000k"), "4K bitrate");
        assert!(has_pair(&args, "-realtime", "1"));
        // No software-only preset on the hardware path.
        assert!(
            !args.iter().any(|a| a == "-preset"),
            "hw path has no -preset"
        );
    }

    #[test]
    fn hw_accel_falls_back_to_software_off_mac() {
        let opts = CaptureOpts {
            hw_accel: true,
            ..CaptureOpts::default()
        };
        // Windows has no VideoToolbox → software libx264 with a preset.
        let args =
            build_unified_capture_args(Platform::Windows, Some("Cam"), "Mic", "out.mp4", &opts);
        assert!(has_pair(&args, "-c:v", "libx264"));
        assert!(has_pair(&args, "-preset", "veryfast"));
        assert!(!args.iter().any(|a| a == "h264_videotoolbox"));
    }

    #[test]
    fn mov_recording_keeps_faststart_but_mkv_drops_it() {
        let mov = build_unified_capture_args(
            Platform::MacOS,
            Some("0"),
            "1",
            "/tmp/s.mov",
            &CaptureOpts::default(),
        );
        assert!(
            has_pair(&mov, "-movflags", "+faststart"),
            "mov supports faststart"
        );
        let mkv = build_unified_capture_args(
            Platform::MacOS,
            Some("0"),
            "1",
            "/tmp/s.mkv",
            &CaptureOpts::default(),
        );
        assert!(
            !mkv.iter().any(|a| a == "+faststart"),
            "mkv must not get faststart"
        );
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

    /// A VIDEO recording is a SINGLE clean output ending in the mp4 path — NO
    /// second MJPEG/`pipe:1` output (that fragile preview tee was removed because a
    /// stalled stdout drain could block + freeze the whole capture). libx264 + the
    /// CFR sync lock are present; the args end with `-y <path>`.
    #[test]
    fn video_is_single_clean_output_with_cfr_and_no_pipe() {
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
            // The file is the SOLE, final output.
            assert_eq!(
                args.last().unwrap(),
                "FINAL_OUTPUT.mp4",
                "mp4 is the only output; got: {args:?}"
            );
            assert_eq!(args[args.len() - 2], "-y", "preceded by -y; got: {args:?}");
            // No second-output preview plumbing anywhere.
            assert!(
                !args.iter().any(|a| a == "pipe:1" || a == "mjpeg"),
                "no stdout/MJPEG preview output; got: {args:?}"
            );
            // Video codec + the A/V-sync CFR lock are still there.
            assert!(has_pair(&args, "-c:v", "libx264"), "got: {args:?}");
            assert!(has_pair(&args, "-fps_mode", "cfr"), "got: {args:?}");
            // No preview output unless one is requested.
            assert!(!args.iter().any(|a| a == "-update"), "got: {args:?}");
        }
    }

    /// With a preview path set, a VIDEO recording appends a SECOND output: a
    /// downscaled, low-fps, audio-less JPEG written to a FILE (`-update 1`, NOT a
    /// pipe — deadlock-proof). The mp4 stays the primary output; the preview tails.
    #[test]
    fn video_with_preview_appends_deadlock_proof_jpeg_file_output() {
        let opts = CaptureOpts {
            preview_jpg: Some("/tmp/preview.jpg".into()),
            ..CaptureOpts::default()
        };
        let args = build_unified_capture_args(Platform::MacOS, Some("0"), "1", "/rec/g.mp4", &opts);
        // The preview is the FINAL output, written to the file (NOT a pipe).
        assert_eq!(args.last().unwrap(), "/tmp/preview.jpg", "got: {args:?}");
        assert!(
            !args.iter().any(|a| a == "pipe:1"),
            "preview is a file, never a pipe; got: {args:?}"
        );
        assert!(
            has_pair(&args, "-update", "1"),
            "auto-overwrite; got: {args:?}"
        );
        assert!(
            has_pair(&args, "-vf", "scale=480:-2,fps=4"),
            "got: {args:?}"
        );
        assert!(args.iter().any(|a| a == "-an"), "preview drops audio");
        // The mp4 is still complete + comes before the preview.
        let mp4 = args.iter().position(|a| a == "/rec/g.mp4").unwrap();
        let jpg = args.iter().position(|a| a == "/tmp/preview.jpg").unwrap();
        assert!(mp4 < jpg, "mp4 finalises before the preview; got: {args:?}");
        // AUDIO-only ignores the preview path entirely.
        let audio = build_unified_capture_args(Platform::MacOS, None, "1", "/rec/a.wav", &opts);
        assert!(
            !audio.iter().any(|a| a == "-update"),
            "audio-only has no preview"
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
    fn custom_channel_map_filter_picks_explicit_stereo_channels() {
        // A real multi-channel pick (X32 ch 17 & 18 → 0-based 16 & 17).
        assert_eq!(
            custom_channel_map_filter(ChannelMode::Stereo, Some(16), Some(17)).as_deref(),
            Some("pan=stereo|c0=c16|c1=c17")
        );
        // The identity pair (0, 1) is just plain stereo → no filter.
        assert_eq!(
            custom_channel_map_filter(ChannelMode::Stereo, Some(0), Some(1)),
            None
        );
        // A partial / missing pick falls through to the mode default.
        assert_eq!(
            custom_channel_map_filter(ChannelMode::Stereo, Some(2), None),
            None
        );
        // Mono modes ignore the explicit pick (HARDWARE-UNVERIFIED, deferred).
        assert_eq!(
            custom_channel_map_filter(ChannelMode::MonoL, Some(4), Some(5)),
            None
        );
    }

    #[test]
    fn custom_channels_override_pan_in_af_chain() {
        let opts = CaptureOpts {
            input_channel_l: Some(16),
            input_channel_r: Some(17),
            ..CaptureOpts::default()
        };
        let args = build_unified_capture_args(Platform::MacOS, None, "1", "/tmp/x.wav", &opts);
        let af = args
            .iter()
            .position(|a| a == "-af")
            .map(|i| args[i + 1].clone())
            .expect("an -af chain");
        assert!(af.contains("pan=stereo|c0=c16|c1=c17"), "af was: {af}");
        // Still a stereo output.
        assert!(has_pair(&args, "-ac", "2"));
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
