//! Editor DSP — pure, GUI-free (P2a).
//!
//! Ported from the Electron `src/main/editor.ts` (the behavioural spec). That
//! module mixed pure planning (turn cut regions into keep segments, build the
//! ffmpeg filter graph, pick the output path + codec) with impure I/O (spawn
//! ffmpeg, atomic file replace). This module is the *pure* half: everything that
//! is a deterministic function of the inputs, so the entire cut/trim/export
//! planning is unit-testable without ffmpeg, a file system, or a process. The
//! `src-tauri` shell (`media::editor`, behind the `editor` feature) drives the
//! actual ffmpeg run over these decisions.
//!
//! What lives here:
//!   - [`build_keeps`]            — cut regions → keep segments (the core trim math)
//!   - [`codec_args`]             — output-format → ffmpeg `-c:a …` arguments
//!   - [`audio_filter_complex`]   — keep segments (+ processing) → audio filter graph
//!   - [`video_filter_complex`]   — keep segments (+ processing) → A/V filter graph
//!   - [`ffmetadata`]             — chapter metadata → the `;FFMETADATA1` sidecar text
//!   - [`save_output_path`]       — collision-avoiding output path policy
//!   - [`resolve_save_ext`]       — extension policy incl. FORCE_WAV refusal
//!   - format constants ([`FORCE_WAV_FORMATS`], [`AUDIO_SAVE_EXTS`])
//!
//! All time arithmetic uses the same `0.05 s` keep-gap epsilon and `.4`-decimal
//! `atrim`/`trim` formatting as the Electron module, so the produced filter
//! strings are byte-for-byte identical to what the Electron app shipped.

use std::collections::HashSet;

/// Minimum gap (seconds) below which a keep-segment is dropped as a rounding
/// artefact. Matches the Electron `cursor + 0.05` epsilon exactly.
pub const KEEP_EPSILON: f64 = 0.05;

/// Audio formats with no encoder in ffmpeg-static — losslessly saving these
/// means transcoding to WAV. Replace-mode on these would silently write WAV
/// bytes under a non-WAV extension and corrupt the file, so we refuse it.
/// Mirrors the Electron `FORCE_WAV_FORMATS` set.
pub fn force_wav_formats() -> HashSet<&'static str> {
    ["ape", "dts", "mpc", "ra", "ram", "spx", "gsm", "amr", "3ga"]
        .into_iter()
        .collect()
}

/// Extensions we keep on a "save" (audio). Anything outside this set falls back
/// to `mp3`. Mirrors the Electron `AUDIO_SAVE_EXTS` set.
pub fn audio_save_exts() -> HashSet<&'static str> {
    [
        "mp3", "mp1", "mp2", "wav", "flac", "aac", "m4a", "m4b", "m4r", "ogg", "oga", "opus",
        "aiff", "aif", "wma", "mka", "ac3", "eac3", "amr", "3ga", "caf", "wv", "tta", "au", "snd",
        "ape", "dts", "mpc", "ra", "ram", "spx", "gsm",
    ]
    .into_iter()
    .collect()
}

// ── Keep-segment planning ────────────────────────────────────────────────────

/// A region the user marked to *cut* (remove).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CutRegion {
    pub start: f64,
    pub end: f64,
}

/// A region we *keep* — the inverse of the cuts within `[0, duration]`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct KeepSegment {
    pub start: f64,
    pub end: f64,
}

/// Turn cut regions into the keep-segments list, exactly as the Electron
/// `saveEdited`/`buildKeeps` inner loops did:
///   - sort cuts by start,
///   - walk a cursor; emit a keep for any gap > `KEEP_EPSILON` before the next
///     cut, then advance the cursor past the cut (clamping monotonically),
///   - emit a final keep to `duration` if the tail gap exceeds the epsilon.
///
/// Overlapping cuts collapse naturally because the cursor only moves forward
/// (`cursor = max(cursor, c.end)`).
pub fn build_keeps(cut_regions: &[CutRegion], duration: f64) -> Vec<KeepSegment> {
    let mut sorted: Vec<CutRegion> = cut_regions.to_vec();
    sorted.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut keeps: Vec<KeepSegment> = Vec::new();
    let mut cursor = 0.0_f64;
    for c in &sorted {
        if c.start > cursor + KEEP_EPSILON {
            keeps.push(KeepSegment {
                start: cursor,
                end: c.start,
            });
        }
        cursor = cursor.max(c.end);
    }
    if cursor < duration - KEEP_EPSILON {
        keeps.push(KeepSegment {
            start: cursor,
            end: duration,
        });
    }
    keeps
}

// ── Save extension policy ─────────────────────────────────────────────────────

/// Why a save was refused outright (no fixable output exists).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveExtError {
    /// Replace-mode on a FORCE_WAV format would corrupt the original file.
    ForceWavReplaceUnsafe,
}

/// Decide the output extension for an audio save, mirroring `saveEdited`:
///   - unknown extension → `mp3`,
///   - a FORCE_WAV format → `wav`,
///   - otherwise keep the source extension.
///
/// In `replace` mode a FORCE_WAV source is refused (`ForceWavReplaceUnsafe`) —
/// the caller should offer "save as new" instead.
pub fn resolve_save_ext(raw_ext: &str, replace: bool) -> Result<String, SaveExtError> {
    let ext = raw_ext.to_lowercase();
    let force = force_wav_formats();
    if replace && force.contains(ext.as_str()) {
        return Err(SaveExtError::ForceWavReplaceUnsafe);
    }
    if !audio_save_exts().contains(ext.as_str()) {
        Ok("mp3".to_string())
    } else if force.contains(ext.as_str()) {
        Ok("wav".to_string())
    } else {
        Ok(ext)
    }
}

// ── Codec arguments ───────────────────────────────────────────────────────────

/// Build the ffmpeg `-c:a …` (and bitrate/depth) arguments for an output
/// extension, porting `editor.codecArgs` exactly (same encoder choices and the
/// same `bitrate ?? <default>` fallbacks). `bit_depth` only affects WAV.
pub fn codec_args(fmt: &str, bitrate: Option<u32>, bit_depth: Option<u8>) -> Vec<String> {
    let s = |v: &str| v.to_string();
    let br = |dflt: u32| format!("{}k", bitrate.unwrap_or(dflt));
    match fmt {
        "wav" => vec![
            s("-c:a"),
            s(if bit_depth == Some(24) {
                "pcm_s24le"
            } else {
                "pcm_s16le"
            }),
        ],
        "flac" | "mka" => vec![s("-c:a"), s("flac")],
        "aac" | "m4a" | "m4b" | "m4r" | "caf" => {
            vec![s("-c:a"), s("aac"), s("-b:a"), br(192)]
        }
        "ogg" | "oga" => vec![s("-c:a"), s("libvorbis"), s("-b:a"), br(192)],
        "opus" => vec![s("-c:a"), s("libopus"), s("-b:a"), br(128)],
        "aiff" | "aif" => vec![s("-c:a"), s("pcm_s16be")],
        "au" | "snd" => vec![s("-c:a"), s("pcm_mulaw")],
        "wma" => vec![s("-c:a"), s("wmav2"), s("-b:a"), br(192)],
        "mp2" | "mp1" => vec![s("-c:a"), s("mp2"), s("-b:a"), br(192)],
        "ac3" => vec![s("-c:a"), s("ac3"), s("-b:a"), br(192)],
        "eac3" => vec![s("-c:a"), s("eac3"), s("-b:a"), br(192)],
        "amr" | "3ga" => vec![
            s("-c:a"),
            s("amr_nb"),
            s("-ar"),
            s("8000"),
            s("-ac"),
            s("1"),
        ],
        "wv" => vec![s("-c:a"), s("wavpack")],
        "tta" => vec![s("-c:a"), s("tta")],
        // ape/dts/mpc/ra/ram/spx/gsm: no reliable encoder → transcode to wav.
        "ape" | "dts" | "mpc" | "ra" | "ram" | "spx" | "gsm" => vec![s("-c:a"), s("pcm_s16le")],
        _ => vec![s("-c:a"), s("libmp3lame"), s("-b:a"), br(192)],
    }
}

/// Standard MP4 output codec args — mirrors `editor.MP4_CODEC_ARGS`. Kept as the
/// H.264/mp4 default; [`video_codec_args`] generalises this to other containers
/// and to H.265.
pub fn mp4_codec_args() -> Vec<String> {
    video_codec_args("mp4", VideoCodec::H264, None)
}

/// The video codec for a video export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VideoCodec {
    /// H.264 / AVC (`libx264`) — universal compatibility.
    #[default]
    H264,
    /// H.265 / HEVC (`libx265`) — ~half the size at the same quality, but needs a
    /// newer player. Tagged `hvc1` so Apple/QuickTime players accept it.
    H265,
}

/// Output containers that carry a video stream (the editor re-encodes video +
/// audio through the filter graph). webm is intentionally excluded — it needs a
/// VP8/VP9 + Vorbis/Opus path, not the H.264/H.265 + AAC chain here.
pub fn is_video_container(fmt: &str) -> bool {
    matches!(fmt, "mp4" | "mov" | "mkv" | "m4v")
}

/// Every output format the editor can export to: any video container above, or
/// any audio format [`codec_args`] handles (including the force-to-WAV set,
/// which still produces a valid file). The export seam validates against this.
pub fn is_supported_export_format(fmt: &str) -> bool {
    is_video_container(fmt)
        || matches!(
            fmt,
            "mp3"
                | "aac"
                | "m4a"
                | "m4b"
                | "m4r"
                | "caf"
                | "wav"
                | "flac"
                | "mka"
                | "ogg"
                | "oga"
                | "opus"
                | "aiff"
                | "aif"
                | "au"
                | "snd"
                | "wma"
                | "mp1"
                | "mp2"
                | "ac3"
                | "eac3"
                | "amr"
                | "3ga"
                | "wv"
                | "tta"
                | "ape"
                | "dts"
                | "mpc"
                | "ra"
                | "ram"
                | "spx"
                | "gsm"
        )
}

/// Build the video + audio codec args for a video export, honouring the chosen
/// container and codec. H.265 carries the `hvc1` tag for QuickTime/Apple
/// compatibility; `+faststart` (web progressive playback) is only emitted for
/// the ISO/QuickTime containers that support it (mp4/mov/m4v — NOT mkv).
pub fn video_codec_args(container: &str, codec: VideoCodec, crf: Option<u8>) -> Vec<String> {
    let s = |v: &str| v.to_string();
    let crf = crf.unwrap_or(18);
    let mut a: Vec<String> = match codec {
        VideoCodec::H264 => vec![s("-c:v"), s("libx264")],
        VideoCodec::H265 => vec![s("-c:v"), s("libx265"), s("-tag:v"), s("hvc1")],
    };
    a.extend([s("-preset"), s("veryfast"), s("-crf"), crf.to_string()]);
    a.extend([s("-c:a"), s("aac"), s("-b:a"), s("192k")]);
    if matches!(container, "mp4" | "mov" | "m4v") {
        a.extend([s("-movflags"), s("+faststart")]);
    }
    a
}

/// The encoder backend for a video output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VideoEncoder {
    /// Software `libx264`/`libx265` — best quality-per-bit, but CPU-bound (a
    /// modest machine can't encode 4K H.265 in realtime).
    #[default]
    Software,
    /// Apple **VideoToolbox** hardware encoder (`h264_videotoolbox` /
    /// `hevc_videotoolbox`) — realtime even at 4K, the right choice for LIVE
    /// capture. macOS-only: the caller MUST gate this to macOS and fall back to
    /// [`VideoEncoder::Software`] elsewhere (VideoToolbox doesn't exist on
    /// Windows/Linux; Windows would use qsv/nvenc/amf, not wired here).
    Hardware,
}

/// Suggested target video bitrate (kbps) for an output resolution. The hardware
/// (VideoToolbox) encoder targets a BITRATE rather than a CRF, so we pick a
/// sensible rate per resolution (≈ the common streaming ladder, tuned a touch
/// high for clean sermon/podcast capture). `long_side` is `max(width, height)`.
pub fn default_video_bitrate_kbps(width: u32, height: u32) -> u32 {
    match width.max(height) {
        l if l >= 3840 => 40_000, // 4K UHD
        l if l >= 1920 => 12_000, // 1080p
        l if l >= 1280 => 6_000,  // 720p
        _ => 2_500,               // 480p and below
    }
}

/// Build the video + audio codec args for the HARDWARE (VideoToolbox) path —
/// the realtime encoder for live 4K. Unlike software x264/x265 it has no CRF, so
/// it targets `-b:v <bitrate>`; `-realtime 1` biases it for live capture, HEVC
/// carries the `hvc1` tag, and `+faststart` is emitted only for ISO/QuickTime
/// containers. macOS-only (caller-gated; see [`VideoEncoder::Hardware`]).
pub fn videotoolbox_codec_args(
    container: &str,
    codec: VideoCodec,
    bitrate_kbps: u32,
) -> Vec<String> {
    let s = |v: &str| v.to_string();
    let mut a: Vec<String> = match codec {
        VideoCodec::H264 => vec![s("-c:v"), s("h264_videotoolbox")],
        VideoCodec::H265 => vec![s("-c:v"), s("hevc_videotoolbox"), s("-tag:v"), s("hvc1")],
    };
    a.extend([
        s("-b:v"),
        format!("{bitrate_kbps}k"),
        s("-realtime"),
        s("1"),
    ]);
    a.extend([s("-c:a"), s("aac"), s("-b:a"), s("192k")]);
    if matches!(container, "mp4" | "mov" | "m4v") {
        a.extend([s("-movflags"), s("+faststart")]);
    }
    a
}

// ── Filter graph construction ─────────────────────────────────────────────────

/// Format a seconds value the way Electron's `.toFixed(4)` did — fixed 4
/// decimals. This is what makes the produced filter strings byte-identical.
fn ts(v: f64) -> String {
    format!("{v:.4}")
}

/// An `atrim` chain for one keep segment off input label `input_ref`.
fn atrim(input_ref: &str, seg: &KeepSegment) -> String {
    format!(
        "{input_ref}atrim=start={}:end={},asetpts=PTS-STARTPTS",
        ts(seg.start),
        ts(seg.end)
    )
}

/// The audio filter graph for an *export* (the general case): trims, optional
/// processing filters, optional intro/outro concat. Mirrors `exportEdited`'s
/// `concatParts` builder. Returns the `-filter_complex` string and the output
/// pad label to `-map`.
///
/// `main_input_idx` is the ffmpeg input index of the *main* recording (0, or 1
/// when an intro is prepended). `proc_filters` is the per-preset processing
/// chain (may be empty). `has_intro`/`has_outro` toggle the surrounding concat;
/// the intro is always input 0, the outro the input after the main one.
pub fn audio_export_filter_complex(
    keeps: &[KeepSegment],
    main_input_idx: usize,
    proc_filters: &[String],
    has_intro: bool,
    has_outro: bool,
) -> (String, String) {
    let main_ref = format!("[{main_input_idx}:a]");
    let outro_idx = main_input_idx + 1;
    let mut filter_parts: Vec<String> = Vec::new();

    if keeps.len() == 1 {
        let seg = &keeps[0];
        let mut chain = vec![atrim(&main_ref, seg)];
        chain.extend(proc_filters.iter().cloned());
        filter_parts.push(format!("{}[main_out]", chain.join(",")));
    } else {
        for (i, seg) in keeps.iter().enumerate() {
            filter_parts.push(format!("{}[seg{i}]", atrim(&main_ref, seg)));
        }
        let seg_inputs: String = (0..keeps.len()).map(|i| format!("[seg{i}]")).collect();
        if !proc_filters.is_empty() {
            filter_parts.push(format!(
                "{seg_inputs}concat=n={}:v=0:a=1[concat_out]",
                keeps.len()
            ));
            filter_parts.push(format!("[concat_out]{}[main_out]", proc_filters.join(",")));
        } else {
            filter_parts.push(format!(
                "{seg_inputs}concat=n={}:v=0:a=1[main_out]",
                keeps.len()
            ));
        }
    }

    let mut concat_parts: Vec<String> = Vec::new();
    if has_intro {
        concat_parts.push("[0:a]aformat=sample_fmts=fltp[intro_fmt]".to_string());
    }
    concat_parts.extend(filter_parts);
    if has_outro {
        concat_parts.push(format!(
            "[{outro_idx}:a]aformat=sample_fmts=fltp[outro_fmt]"
        ));
    }

    let map_arg = if has_intro || has_outro {
        let mut inputs = String::new();
        if has_intro {
            inputs.push_str("[intro_fmt]");
        }
        inputs.push_str("[main_out]");
        if has_outro {
            inputs.push_str("[outro_fmt]");
        }
        let n = (has_intro as usize) + 1 + (has_outro as usize);
        concat_parts.push(format!("{inputs}concat=n={n}:v=0:a=1[final_out]"));
        "[final_out]".to_string()
    } else {
        "[main_out]".to_string()
    };

    (concat_parts.join(";"), map_arg)
}

/// Whether the export can take the *simple* single-segment fast path (one keep,
/// no processing, no intro/outro) which uses a plain `-af atrim=…` rather than a
/// filter_complex. Mirrors the `exportEdited` branch condition.
pub fn is_simple_audio_export(
    keeps: &[KeepSegment],
    proc_filters: &[String],
    has_intro: bool,
    has_outro: bool,
) -> bool {
    keeps.len() == 1 && proc_filters.is_empty() && !has_intro && !has_outro
}

/// The single-segment `-af` value for the simple audio path.
pub fn audio_simple_af(seg: &KeepSegment) -> String {
    format!(
        "atrim=start={}:end={},asetpts=PTS-STARTPTS",
        ts(seg.start),
        ts(seg.end)
    )
}

/// The audio filter graph for a *save* (no intro/outro/processing — the
/// `saveEdited` path). Returns `None` for the single-keep case (caller uses a
/// plain `-af`), or the filter_complex string + `[out]` map for multi-keep.
pub fn audio_save_filter_complex(keeps: &[KeepSegment]) -> Option<String> {
    if keeps.len() <= 1 {
        return None;
    }
    let mut parts: Vec<String> = keeps
        .iter()
        .enumerate()
        .map(|(i, seg)| format!("{}[seg{i}]", atrim("[0:a]", seg)))
        .collect();
    let inputs: String = (0..keeps.len()).map(|i| format!("[seg{i}]")).collect();
    parts.push(format!("{inputs}concat=n={}:v=0:a=1[out]", keeps.len()));
    Some(parts.join(";"))
}

/// The video filter graph (trim + audio-processing) for a single main input.
/// Mirrors `buildVideoFilterComplex`. Returns `(filter_complex, v_out, a_out)`.
pub fn video_filter_complex(
    main_idx: usize,
    keeps: &[KeepSegment],
    proc_filters: &[String],
) -> (String, String, String) {
    let mut parts: Vec<String> = Vec::new();
    if keeps.len() == 1 {
        let seg = &keeps[0];
        parts.push(format!(
            "[{main_idx}:v]trim=start={}:end={},setpts=PTS-STARTPTS[v_main]",
            ts(seg.start),
            ts(seg.end)
        ));
        let mut a_chain = vec![format!(
            "[{main_idx}:a]atrim=start={}:end={},asetpts=PTS-STARTPTS",
            ts(seg.start),
            ts(seg.end)
        )];
        a_chain.extend(proc_filters.iter().cloned());
        parts.push(format!("{}[a_main]", a_chain.join(",")));
    } else {
        for (i, seg) in keeps.iter().enumerate() {
            parts.push(format!(
                "[{main_idx}:v]trim=start={}:end={},setpts=PTS-STARTPTS[vseg{i}]",
                ts(seg.start),
                ts(seg.end)
            ));
            parts.push(format!(
                "[{main_idx}:a]atrim=start={}:end={},asetpts=PTS-STARTPTS[aseg{i}]",
                ts(seg.start),
                ts(seg.end)
            ));
        }
        let v_in: String = (0..keeps.len()).map(|i| format!("[vseg{i}]")).collect();
        let a_in: String = (0..keeps.len()).map(|i| format!("[aseg{i}]")).collect();
        if !proc_filters.is_empty() {
            parts.push(format!("{v_in}concat=n={}:v=1:a=0[v_main]", keeps.len()));
            parts.push(format!("{a_in}concat=n={}:v=0:a=1[a_concat]", keeps.len()));
            parts.push(format!("[a_concat]{}[a_main]", proc_filters.join(",")));
        } else {
            parts.push(format!("{v_in}concat=n={}:v=1:a=0[v_main]", keeps.len()));
            parts.push(format!("{a_in}concat=n={}:v=0:a=1[a_main]", keeps.len()));
        }
    }
    (
        parts.join(";"),
        "[v_main]".to_string(),
        "[a_main]".to_string(),
    )
}

// ── FFmetadata chapters ───────────────────────────────────────────────────────

/// One chapter marker (a title at a time, in seconds).
#[derive(Debug, Clone, PartialEq)]
pub struct Chapter {
    pub time: f64,
    pub title: String,
}

/// Optional recording metadata for the export — title/speaker/description plus
/// chapters. Mirrors the `RecordingMetadata` shape the editor consumed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RecordingMetadata {
    pub title: Option<String>,
    pub speaker: Option<String>,
    pub description: Option<String>,
    pub chapters: Vec<Chapter>,
}

/// Build the `;FFMETADATA1` sidecar text for chapters, mirroring `exportEdited`'s
/// `lines` builder: title/artist/comment header, then a `[CHAPTER]` block per
/// chapter with `TIMEBASE=1/1000` and START/END in milliseconds (each chapter
/// ends 1 ms before the next; the last ends at `duration`). Returns `None` when
/// there are no chapters.
pub fn ffmetadata(meta: &RecordingMetadata, duration: f64) -> Option<String> {
    if meta.chapters.is_empty() {
        return None;
    }
    let mut lines = vec![";FFMETADATA1".to_string()];
    if let Some(t) = &meta.title {
        lines.push(format!("title={t}"));
    }
    if let Some(s) = &meta.speaker {
        lines.push(format!("artist={s}"));
    }
    if let Some(d) = &meta.description {
        lines.push(format!("comment={d}"));
    }
    // Chapters MUST be time-sorted before deriving each END from the next START —
    // ffmpeg silently mishandles a `[CHAPTER]` whose END < START. The renderer
    // doesn't guarantee order, so sort a clone here (mirrors how cut regions are
    // sorted before use). `end.max(start)` is a final defensive clamp.
    let mut chapters = meta.chapters.clone();
    chapters.sort_by(|a, b| a.time.total_cmp(&b.time));
    for (i, ch) in chapters.iter().enumerate() {
        let start = (ch.time * 1000.0).round() as i64;
        let end = match chapters.get(i + 1) {
            Some(next) => ((next.time * 1000.0).round() as i64 - 1).max(start),
            None => ((duration * 1000.0).round() as i64).max(start),
        };
        lines.push("[CHAPTER]".to_string());
        lines.push("TIMEBASE=1/1000".to_string());
        lines.push(format!("START={start}"));
        lines.push(format!("END={end}"));
        lines.push(format!("title={}", ch.title));
    }
    Some(lines.join("\n"))
}

/// The `-metadata` output arguments (title/artist/comment) for an export, the
/// non-chapter half of `metaArgs`. Chapters arrive via `-map_metadata`.
pub fn metadata_args(meta: &RecordingMetadata) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(t) = &meta.title {
        args.push("-metadata".to_string());
        args.push(format!("title={t}"));
    }
    if let Some(s) = &meta.speaker {
        args.push("-metadata".to_string());
        args.push(format!("artist={s}"));
    }
    if let Some(d) = &meta.description {
        args.push("-metadata".to_string());
        args.push(format!("comment={d}"));
    }
    args
}

// ── Output path policy ────────────────────────────────────────────────────────

/// A picked output path candidate, separated from any actual `existsSync`
/// probing: the caller supplies an `exists` predicate so the policy stays pure
/// and testable. Mirrors the `for (let i = 2; existsSync(cand); i++)` loops.
///
/// `base` is the file-stem (no extension), `ext` the chosen extension, `dir`
/// the directory. Produces `dir/base.ext`, then `dir/base_2.ext`, … until a
/// non-existing candidate is found.
pub fn collision_free_path<F>(dir: &str, base: &str, ext: &str, exists: F) -> String
where
    F: Fn(&str) -> bool,
{
    let first = join(dir, &format!("{base}.{ext}"));
    if !exists(&first) {
        return first;
    }
    let mut i = 2;
    loop {
        let cand = join(dir, &format!("{base}_{i}.{ext}"));
        if !exists(&cand) {
            return cand;
        }
        i += 1;
    }
}

/// Join a directory and filename with a forward slash, collapsing a trailing
/// separator. Kept tiny + platform-neutral so the path policy is testable
/// without `std::path` host quirks (the shell uses real `PathBuf::join`).
fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        let trimmed = dir.trim_end_matches(['/', '\\']);
        format!("{trimmed}/{name}")
    }
}

/// The dynamic export timeout (ms): at least `MAX_EDIT_MS`, scaling to 0.6× the
/// recording's real-time duration for long multi-pass jobs. Mirrors
/// `exportEdited`'s `dynamicTimeoutMs`.
pub const MAX_EDIT_MS: u64 = 10 * 60 * 1000;

/// Compute the kill-timer for an export given the source `duration` (seconds).
pub fn export_timeout_ms(duration: f64) -> u64 {
    let scaled = (duration * 1000.0 * 0.6).round() as u64;
    MAX_EDIT_MS.max(scaled)
}

// ── ffprobe / decode argv (the I/O seam runs these; the args are tested) ────────

/// ffprobe arguments that print the duration / channel-count / sample-format of
/// the first audio stream plus whether a video stream exists, as compact CSV.
/// The seam parses the single output line via [`parse_probe_line`]. Mirrors the
/// Electron `probeMediaStreams` intent (which scanned `-i` stderr), but uses
/// ffprobe's structured `-show_entries` so the parse is robust, not regex-on-log.
pub fn ffprobe_load_args(input_path: &str) -> Vec<String> {
    [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,channels,sample_fmt",
        "-of",
        "default=noprint_wrappers=1:nokey=0",
        input_path,
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

/// What a load-probe resolved about a recording. Mirrors the Electron
/// `MediaStreamInfo` plus the duration the editor needs to plan cuts.
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeResult {
    pub duration_sec: f64,
    pub has_video: bool,
    pub has_audio: bool,
    pub channels: Option<u32>,
    pub sample_fmt: Option<String>,
}

/// Parse the `key=value` lines ffprobe prints for [`ffprobe_load_args`]. ffprobe
/// emits one block per stream plus the format block, so we take the first audio
/// stream's channels/sample_fmt and OR the video presence across all streams.
pub fn parse_probe_output(stdout: &str) -> ProbeResult {
    let mut duration_sec = 0.0;
    let mut has_video = false;
    let mut has_audio = false;
    let mut channels: Option<u32> = None;
    let mut sample_fmt: Option<String> = None;
    // ffprobe prints stream blocks then the format block; a `codec_type=audio`
    // line opens an audio stream whose subsequent `channels=`/`sample_fmt=`
    // belong to it. Track the current stream kind to attribute fields.
    let mut current_audio = false;
    for line in stdout.lines() {
        let line = line.trim();
        let Some((key, val)) = line.split_once('=') else {
            continue;
        };
        match key {
            "codec_type" => {
                current_audio = val == "audio";
                if val == "audio" {
                    has_audio = true;
                } else if val == "video" {
                    has_video = true;
                }
            }
            "channels" if current_audio && channels.is_none() => {
                channels = val.parse::<u32>().ok();
            }
            "sample_fmt"
                if current_audio && sample_fmt.is_none() && val != "N/A" && !val.is_empty() =>
            {
                sample_fmt = Some(val.to_string());
            }
            "duration" => {
                if let Ok(d) = val.parse::<f64>() {
                    if d.is_finite() && d > 0.0 {
                        duration_sec = d;
                    }
                }
            }
            _ => {}
        }
    }
    ProbeResult {
        duration_sec,
        has_video,
        has_audio,
        channels,
        sample_fmt,
    }
}

/// ffmpeg arguments to extract the audio of `input_path` as an 8 kHz mono WAV to
/// `out_path`, for renderer-side waveform/peaks. Mirrors `extractAudioForPeaks`'s
/// `-vn -ac 1 -ar 8000 -f wav` exactly (8 kHz keeps the buffer tiny — plenty for
/// peaks). The seam streams this to a temp WAV then decodes it.
pub fn peaks_extract_args(input_path: &str, out_path: &str) -> Vec<String> {
    [
        "-nostdin",
        "-hide_banner",
        "-i",
        input_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "8000",
        "-f",
        "wav",
        "-y",
        out_path,
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

/// ffmpeg arguments to decode `input_path` to 16 kHz mono signed-16 PCM on stdout
/// for the [`crate::audio_analysis`] classifier (it expects 16 kHz). `-f s16le`
/// to a pipe so the seam reads raw samples without a WAV header. Mirrors the
/// analysis-decode the Electron `audio-analysis.ts` ran.
pub fn analysis_decode_args(input_path: &str) -> Vec<String> {
    [
        "-nostdin",
        "-hide_banner",
        "-i",
        input_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "-",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

/// ffmpeg arguments to extract a single video frame at `sec` seconds from
/// `input_path`, scaled to 480px wide (height auto, even), as one MJPEG image on
/// stdout (`pipe:1`). The seam reads stdout and base64-encodes it so the editor's
/// video preview can scrub frames without a `<video>` element. `-ss` is placed
/// BEFORE `-i` for a fast input seek; `sec` is clamped non-negative + finite.
/// Mirrors the Electron editor's `editor-extract-frame` ffmpeg invocation.
pub fn frame_extract_args(input_path: &str, sec: f64) -> Vec<String> {
    let seek = if sec.is_finite() && sec > 0.0 {
        sec
    } else {
        0.0
    };
    [
        "-nostdin".to_string(),
        "-hide_banner".to_string(),
        "-ss".to_string(),
        format!("{seek}"),
        "-i".to_string(),
        input_path.to_string(),
        "-vf".to_string(),
        "scale=480:-2".to_string(),
        "-frames:v".to_string(),
        "1".to_string(),
        "-f".to_string(),
        "image2pipe".to_string(),
        "-vcodec".to_string(),
        "mjpeg".to_string(),
        "pipe:1".to_string(),
    ]
    .into_iter()
    .collect()
}

/// Number of f32 peak buckets we down-sample the decoded mono PCM into for the
/// renderer waveform. Matches the Electron renderer's ~2000-bar waveform.
pub const PEAK_BUCKETS: usize = 2000;

/// Down-sample `samples` to `buckets` peak amplitudes (max-abs per bucket), the
/// shape the renderer waveform draws. Pure + tested. An empty input yields an
/// empty vec; fewer samples than buckets yields one peak per sample.
pub fn downsample_peaks(samples: &[f32], buckets: usize) -> Vec<f32> {
    if samples.is_empty() || buckets == 0 {
        return Vec::new();
    }
    let buckets = buckets.min(samples.len());
    let per = samples.len() as f64 / buckets as f64;
    let mut out = Vec::with_capacity(buckets);
    for b in 0..buckets {
        let lo = (b as f64 * per).floor() as usize;
        let hi = (((b + 1) as f64 * per).ceil() as usize).min(samples.len());
        let mut peak = 0.0_f32;
        for &s in &samples[lo..hi.max(lo + 1).min(samples.len())] {
            let a = s.abs();
            if a > peak {
                peak = a;
            }
        }
        out.push(peak);
    }
    out
}

// ── Sidecar path policy (P1 parity) ──────────────────────────────────────────
//
// The Electron editor persisted per-recording editor state in three JSON
// sidecars written *next to* the media file (`<base>.meta.json`,
// `<base>.cuts-draft.json`, `<base>.transcript.json` — the killer reopen-ability:
// reopen a recording and your cuts / intro-outro / metadata are right there).
// The path is `dir/<stem><suffix>` where `<stem>` drops the media extension.
// We refuse a `suffix`/`stem` that would escape the media's own directory
// (matches the Electron `sidecarPath` `path.dirname(result) !== dir` guard
// against a stem containing `..`). Pure; the fs read/write/delete is the seam.

/// The three sidecar suffixes the editor persists, mirroring the Electron
/// `editor-read-meta` / `editor-read-cuts-draft` / `editor-read-transcript`
/// handlers. Kept as a typed enum so the seam can't fat-finger a suffix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sidecar {
    /// `<base>.meta.json` — title/speaker/description/chapters.
    Meta,
    /// `<base>.cuts-draft.json` — autosaved cut regions for crash recovery.
    CutsDraft,
    /// `<base>.transcript.json` — the saved transcript.
    Transcript,
}

impl Sidecar {
    /// The filename suffix appended to the media's stem.
    pub fn suffix(self) -> &'static str {
        match self {
            Sidecar::Meta => ".meta.json",
            Sidecar::CutsDraft => ".cuts-draft.json",
            Sidecar::Transcript => ".transcript.json",
        }
    }
}

/// Compute the sidecar path for a media file, mirroring the Electron
/// `sidecarPath(audioPath, suffix)`:
///   - take the media's directory + its stem (filename minus the last extension),
///   - join `<stem><suffix>` back onto that directory,
///   - refuse (return `None`) if the result would land in a *different*
///     directory — the `path.dirname(result) !== dir` guard against a crafted
///     stem (`..`) escaping the recording's own folder.
///
/// `dir` and `stem` are supplied pre-split (the seam derives them with
/// `Path::parent`/`file_stem`) so the policy stays host-path-quirk-free and
/// testable; the only logic here is the suffix join + the escape guard.
pub fn sidecar_path(dir: &str, stem: &str, sidecar: Sidecar) -> Option<String> {
    // A stem that itself contains a separator would relocate the file out of
    // `dir` — reject it (mirrors the dirname-equality guard).
    if stem.contains('/') || stem.contains('\\') || stem.is_empty() {
        return None;
    }
    Some(join(dir, &format!("{stem}{}", sidecar.suffix())))
}

// ── Inline-vs-stream file-size guard (P1 parity) ─────────────────────────────

/// 400 MB — the editor reads a media file's bytes inline up to this size (covers
/// a 4-hour service in lossless WAV); anything larger the renderer must stream
/// via the ffmpeg peaks-extract path instead. Mirrors `EDITOR_INLINE_LIMIT`.
pub const EDITOR_INLINE_LIMIT: u64 = 400 * 1024 * 1024;

/// What `editor-read-file` should do for a file of `size` bytes:
/// read it inline, or signal `{ tooLarge }` so the renderer streams it.
/// Mirrors the `stat.size > EDITOR_INLINE_LIMIT` branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InlineDecision {
    /// Small enough to return the bytes inline.
    Inline,
    /// Over the limit — return `{ tooLarge, size }` instead.
    TooLarge,
}

/// Decide inline vs stream for a media file of `size` bytes.
pub fn inline_decision(size: u64) -> InlineDecision {
    if size > EDITOR_INLINE_LIMIT {
        InlineDecision::TooLarge
    } else {
        InlineDecision::Inline
    }
}

// ── Crashed-edit temp-file cleanup (P1 parity) ───────────────────────────────

/// The two suffixes the editor's atomic save leaves behind when it crashes
/// mid-write. Startup sweeps every save-folder for them. Mirror the Electron
/// `.__editor_tmp` / `.__editor_bak` constants.
pub const EDITOR_TMP_SUFFIX: &str = ".__editor_tmp";
pub const EDITOR_BAK_SUFFIX: &str = ".__editor_bak";

/// Whether a directory entry name is a leftover editor temp/backup file the
/// startup sweep should delete. Mirrors `cleanupEditorTempFiles`'s
/// `name.endsWith('.__editor_tmp') || name.endsWith('.__editor_bak')`. The
/// `.mp4` video-save variant (`.__editor_tmp.mp4`) also matches via the contains
/// check the Electron suffix-endsWith would miss, so a crashed *video* export's
/// temp is swept too.
pub fn is_editor_temp_name(name: &str) -> bool {
    name.ends_with(EDITOR_TMP_SUFFIX)
        || name.ends_with(EDITOR_BAK_SUFFIX)
        || name.contains(".__editor_tmp.")
}

/// De-duplicate + canonicalise a list of candidate cleanup folders, dropping
/// empties and preserving first-seen order — the pure half of
/// `cleanupEditorTempFiles`'s folder-prep loop (the `existsSync` filter + the
/// `readdir`/`unlink` are the seam). `resolve` lets the caller plug in the host
/// path canonicaliser (or identity in tests).
pub fn dedupe_cleanup_dirs<F>(folders: &[String], resolve: F) -> Vec<String>
where
    F: Fn(&str) -> String,
{
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for f in folders {
        if f.is_empty() {
            continue;
        }
        let r = resolve(f);
        if seen.insert(r.clone()) {
            out.push(r);
        }
    }
    out
}

// ── Atomic safe-replace decision (P1 parity) ─────────────────────────────────

/// The platform-specific plan for atomically replacing a target file with a
/// freshly rendered temp file, mirroring `safeReplaceFile`:
///   - POSIX `rename()` replaces the target atomically (no missing-file gap),
///   - Windows `rename()` fails if the target exists, so we rename the target
///     to a `.__editor_bak`, move the temp into place, then unlink the backup
///     (restoring the backup on failure).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SafeReplacePlan {
    /// One atomic `rename(temp → target)` (POSIX).
    Rename { temp: String, target: String },
    /// `rename(target → bak)`, `rename(temp → target)`, `unlink(bak)` (Windows).
    BackupSwap {
        temp: String,
        target: String,
        bak: String,
    },
}

/// Build the safe-replace plan for `temp → target`. `windows` selects the
/// backup-swap path; the `bak` path is `target + ".__editor_bak"` exactly as
/// the Electron code formed it. Pure — the seam executes the renames/unlink.
pub fn safe_replace_plan(temp: &str, target: &str, windows: bool) -> SafeReplacePlan {
    if windows {
        SafeReplacePlan::BackupSwap {
            temp: temp.to_string(),
            target: target.to_string(),
            bak: format!("{target}{EDITOR_BAK_SUFFIX}"),
        }
    } else {
        SafeReplacePlan::Rename {
            temp: temp.to_string(),
            target: target.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cut(start: f64, end: f64) -> CutRegion {
        CutRegion { start, end }
    }

    // ── build_keeps ──────────────────────────────────────────────────────────

    #[test]
    fn no_cuts_keeps_whole_file() {
        let keeps = build_keeps(&[], 100.0);
        assert_eq!(keeps.len(), 1);
        assert_eq!(
            keeps[0],
            KeepSegment {
                start: 0.0,
                end: 100.0
            }
        );
    }

    #[test]
    fn single_middle_cut_splits_into_two_keeps() {
        let keeps = build_keeps(&[cut(30.0, 40.0)], 100.0);
        assert_eq!(
            keeps,
            vec![
                KeepSegment {
                    start: 0.0,
                    end: 30.0
                },
                KeepSegment {
                    start: 40.0,
                    end: 100.0
                },
            ]
        );
    }

    #[test]
    fn cut_at_start_drops_leading_keep() {
        let keeps = build_keeps(&[cut(0.0, 10.0)], 100.0);
        assert_eq!(
            keeps,
            vec![KeepSegment {
                start: 10.0,
                end: 100.0
            }]
        );
    }

    #[test]
    fn cut_at_end_drops_trailing_keep() {
        let keeps = build_keeps(&[cut(90.0, 100.0)], 100.0);
        assert_eq!(
            keeps,
            vec![KeepSegment {
                start: 0.0,
                end: 90.0
            }]
        );
    }

    #[test]
    fn overlapping_cuts_collapse() {
        let keeps = build_keeps(&[cut(10.0, 30.0), cut(20.0, 40.0)], 100.0);
        assert_eq!(
            keeps,
            vec![
                KeepSegment {
                    start: 0.0,
                    end: 10.0
                },
                KeepSegment {
                    start: 40.0,
                    end: 100.0
                },
            ]
        );
    }

    #[test]
    fn unsorted_cuts_are_sorted_first() {
        let keeps = build_keeps(&[cut(60.0, 70.0), cut(10.0, 20.0)], 100.0);
        assert_eq!(
            keeps,
            vec![
                KeepSegment {
                    start: 0.0,
                    end: 10.0
                },
                KeepSegment {
                    start: 20.0,
                    end: 60.0
                },
                KeepSegment {
                    start: 70.0,
                    end: 100.0
                },
            ]
        );
    }

    #[test]
    fn sub_epsilon_gap_is_dropped() {
        // A cut starting 0.02 s in leaves a gap below the 0.05 epsilon → no keep.
        let keeps = build_keeps(&[cut(0.02, 50.0)], 100.0);
        assert_eq!(
            keeps,
            vec![KeepSegment {
                start: 50.0,
                end: 100.0
            }]
        );
    }

    #[test]
    fn cutting_everything_yields_no_keeps() {
        let keeps = build_keeps(&[cut(0.0, 100.0)], 100.0);
        assert!(keeps.is_empty());
    }

    // ── resolve_save_ext ───────────────────────────────────────────────────────

    #[test]
    fn unknown_ext_falls_back_to_mp3() {
        assert_eq!(resolve_save_ext("xyz", false).unwrap(), "mp3");
    }

    #[test]
    fn known_ext_is_preserved() {
        assert_eq!(resolve_save_ext("FLAC", false).unwrap(), "flac");
        assert_eq!(resolve_save_ext("wav", false).unwrap(), "wav");
    }

    #[test]
    fn force_wav_format_transcodes_to_wav_when_saving_new() {
        assert_eq!(resolve_save_ext("ape", false).unwrap(), "wav");
    }

    #[test]
    fn force_wav_replace_is_refused() {
        assert_eq!(
            resolve_save_ext("ape", true),
            Err(SaveExtError::ForceWavReplaceUnsafe)
        );
    }

    // ── codec_args ───────────────────────────────────────────────────────────

    #[test]
    fn wav_codec_respects_bit_depth() {
        assert_eq!(codec_args("wav", None, Some(24)), vec!["-c:a", "pcm_s24le"]);
        assert_eq!(codec_args("wav", None, Some(16)), vec!["-c:a", "pcm_s16le"]);
        assert_eq!(codec_args("wav", None, None), vec!["-c:a", "pcm_s16le"]);
    }

    #[test]
    fn aac_codec_uses_bitrate_with_default_192() {
        assert_eq!(
            codec_args("aac", None, None),
            vec!["-c:a", "aac", "-b:a", "192k"]
        );
        assert_eq!(
            codec_args("m4a", Some(256), None),
            vec!["-c:a", "aac", "-b:a", "256k"]
        );
    }

    #[test]
    fn opus_default_is_128k() {
        assert_eq!(
            codec_args("opus", None, None),
            vec!["-c:a", "libopus", "-b:a", "128k"]
        );
    }

    #[test]
    fn unknown_codec_defaults_to_mp3() {
        assert_eq!(
            codec_args("weird", None, None),
            vec!["-c:a", "libmp3lame", "-b:a", "192k"]
        );
    }

    #[test]
    fn no_encoder_formats_transcode_to_pcm() {
        assert_eq!(codec_args("dts", None, None), vec!["-c:a", "pcm_s16le"]);
    }

    // ── format breadth + video codecs ────────────────────────────────────────────

    #[test]
    fn mp4_codec_args_unchanged_after_generalisation() {
        // The generalised builder must still produce the exact legacy mp4 args.
        assert_eq!(
            mp4_codec_args(),
            vec![
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "18",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart"
            ]
        );
    }

    #[test]
    fn video_containers_recognised() {
        for c in ["mp4", "mov", "mkv", "m4v"] {
            assert!(is_video_container(c), "{c} should be a video container");
        }
        for c in ["mp3", "wav", "webm", "flac", "opus"] {
            assert!(!is_video_container(c), "{c} is not a video container");
        }
    }

    #[test]
    fn supported_export_covers_audio_and_video() {
        for f in [
            "mp3", "wav", "flac", "aac", "m4a", "ogg", "opus", "wma", "aiff", "mp4", "mov", "mkv",
        ] {
            assert!(is_supported_export_format(f), "{f} should be supported");
        }
        assert!(!is_supported_export_format("xyz"));
        assert!(!is_supported_export_format("exe"));
    }

    #[test]
    fn h265_args_carry_hvc1_tag_and_faststart_only_on_iso() {
        let mov = video_codec_args("mov", VideoCodec::H265, None);
        assert!(mov.windows(2).any(|w| w == ["-c:v", "libx265"]), "{mov:?}");
        assert!(mov.windows(2).any(|w| w == ["-tag:v", "hvc1"]), "{mov:?}");
        assert!(mov.windows(2).any(|w| w == ["-movflags", "+faststart"]));
        // mkv does NOT support faststart.
        let mkv = video_codec_args("mkv", VideoCodec::H265, None);
        assert!(!mkv.iter().any(|a| a == "+faststart"), "{mkv:?}");
    }

    #[test]
    fn video_codec_args_crf_override() {
        let a = video_codec_args("mp4", VideoCodec::H264, Some(23));
        assert!(a.windows(2).any(|w| w == ["-crf", "23"]), "{a:?}");
    }

    #[test]
    fn default_video_bitrate_scales_with_resolution() {
        assert_eq!(default_video_bitrate_kbps(3840, 2160), 40_000);
        assert_eq!(default_video_bitrate_kbps(1920, 1080), 12_000);
        assert_eq!(default_video_bitrate_kbps(1280, 720), 6_000);
        assert_eq!(default_video_bitrate_kbps(854, 480), 2_500);
    }

    #[test]
    fn videotoolbox_uses_hw_encoder_bitrate_and_realtime() {
        let a = videotoolbox_codec_args("mov", VideoCodec::H265, 40_000);
        assert!(
            a.windows(2).any(|w| w == ["-c:v", "hevc_videotoolbox"]),
            "{a:?}"
        );
        assert!(a.windows(2).any(|w| w == ["-tag:v", "hvc1"]));
        assert!(a.windows(2).any(|w| w == ["-b:v", "40000k"]));
        assert!(a.windows(2).any(|w| w == ["-realtime", "1"]));
        // No software-only knobs.
        assert!(!a.iter().any(|x| x == "-crf"));
        assert!(!a.iter().any(|x| x == "-preset"));
        // H.264 hardware variant.
        let h264 = videotoolbox_codec_args("mp4", VideoCodec::H264, 12_000);
        assert!(h264.windows(2).any(|w| w == ["-c:v", "h264_videotoolbox"]));
    }

    // ── filter graphs ──────────────────────────────────────────────────────────

    #[test]
    fn save_filter_complex_is_none_for_single_keep() {
        let keeps = vec![KeepSegment {
            start: 0.0,
            end: 10.0,
        }];
        assert!(audio_save_filter_complex(&keeps).is_none());
    }

    #[test]
    fn save_filter_complex_concats_multiple_keeps() {
        let keeps = vec![
            KeepSegment {
                start: 0.0,
                end: 10.0,
            },
            KeepSegment {
                start: 20.0,
                end: 30.0,
            },
        ];
        let fc = audio_save_filter_complex(&keeps).unwrap();
        assert_eq!(
            fc,
            "[0:a]atrim=start=0.0000:end=10.0000,asetpts=PTS-STARTPTS[seg0];\
             [0:a]atrim=start=20.0000:end=30.0000,asetpts=PTS-STARTPTS[seg1];\
             [seg0][seg1]concat=n=2:v=0:a=1[out]"
        );
    }

    #[test]
    fn simple_export_path_detection() {
        let one = vec![KeepSegment {
            start: 0.0,
            end: 10.0,
        }];
        let two = vec![
            KeepSegment {
                start: 0.0,
                end: 5.0,
            },
            KeepSegment {
                start: 6.0,
                end: 10.0,
            },
        ];
        assert!(is_simple_audio_export(&one, &[], false, false));
        assert!(!is_simple_audio_export(&two, &[], false, false));
        assert!(!is_simple_audio_export(
            &one,
            &["x".to_string()],
            false,
            false
        ));
        assert!(!is_simple_audio_export(&one, &[], true, false));
    }

    #[test]
    fn export_filter_single_keep_with_processing() {
        let keeps = vec![KeepSegment {
            start: 1.0,
            end: 2.0,
        }];
        let (fc, map) =
            audio_export_filter_complex(&keeps, 0, &["volume=2".to_string()], false, false);
        assert_eq!(
            fc,
            "[0:a]atrim=start=1.0000:end=2.0000,asetpts=PTS-STARTPTS,volume=2[main_out]"
        );
        assert_eq!(map, "[main_out]");
    }

    #[test]
    fn export_filter_with_intro_and_outro_concats_three() {
        // intro is input 0, main is input 1, outro is input 2.
        let keeps = vec![KeepSegment {
            start: 0.0,
            end: 10.0,
        }];
        let (fc, map) = audio_export_filter_complex(&keeps, 1, &[], true, true);
        assert!(fc.starts_with("[0:a]aformat=sample_fmts=fltp[intro_fmt];"));
        assert!(fc.contains("[1:a]atrim=start=0.0000:end=10.0000,asetpts=PTS-STARTPTS[main_out]"));
        assert!(fc.contains("[2:a]aformat=sample_fmts=fltp[outro_fmt]"));
        assert!(fc.ends_with("[intro_fmt][main_out][outro_fmt]concat=n=3:v=0:a=1[final_out]"));
        assert_eq!(map, "[final_out]");
    }

    #[test]
    fn export_filter_multi_keep_with_processing_routes_via_concat_out() {
        let keeps = vec![
            KeepSegment {
                start: 0.0,
                end: 5.0,
            },
            KeepSegment {
                start: 6.0,
                end: 10.0,
            },
        ];
        let (fc, _map) =
            audio_export_filter_complex(&keeps, 0, &["loudnorm".to_string()], false, false);
        assert!(fc.contains("[seg0][seg1]concat=n=2:v=0:a=1[concat_out]"));
        assert!(fc.contains("[concat_out]loudnorm[main_out]"));
    }

    #[test]
    fn video_filter_single_keep() {
        let keeps = vec![KeepSegment {
            start: 2.0,
            end: 8.0,
        }];
        let (fc, v, a) = video_filter_complex(0, &keeps, &[]);
        assert_eq!(v, "[v_main]");
        assert_eq!(a, "[a_main]");
        assert!(fc.contains("[0:v]trim=start=2.0000:end=8.0000,setpts=PTS-STARTPTS[v_main]"));
        assert!(fc.contains("[0:a]atrim=start=2.0000:end=8.0000,asetpts=PTS-STARTPTS[a_main]"));
    }

    #[test]
    fn video_filter_multi_keep_with_processing() {
        let keeps = vec![
            KeepSegment {
                start: 0.0,
                end: 5.0,
            },
            KeepSegment {
                start: 6.0,
                end: 10.0,
            },
        ];
        let (fc, _v, _a) = video_filter_complex(1, &keeps, &["acompressor".to_string()]);
        assert!(fc.contains("[vseg0]"));
        assert!(fc.contains("[vseg0][vseg1]concat=n=2:v=1:a=0[v_main]"));
        assert!(fc.contains("[aseg0][aseg1]concat=n=2:v=0:a=1[a_concat]"));
        assert!(fc.contains("[a_concat]acompressor[a_main]"));
    }

    // ── ffmetadata ───────────────────────────────────────────────────────────

    #[test]
    fn ffmetadata_none_without_chapters() {
        let meta = RecordingMetadata::default();
        assert!(ffmetadata(&meta, 100.0).is_none());
    }

    #[test]
    fn ffmetadata_builds_chapter_blocks() {
        let meta = RecordingMetadata {
            title: Some("Service".into()),
            speaker: Some("Pastor".into()),
            description: None,
            chapters: vec![
                Chapter {
                    time: 0.0,
                    title: "Intro".into(),
                },
                Chapter {
                    time: 60.0,
                    title: "Sermon".into(),
                },
            ],
        };
        let out = ffmetadata(&meta, 120.0).unwrap();
        assert!(out.starts_with(";FFMETADATA1\ntitle=Service\nartist=Pastor\n[CHAPTER]"));
        // First chapter: 0 → 60000-1 = 59999.
        assert!(out.contains("START=0\nEND=59999\ntitle=Intro"));
        // Last chapter ends at duration.
        assert!(out.contains("START=60000\nEND=120000\ntitle=Sermon"));
    }

    #[test]
    fn ffmetadata_sorts_unsorted_chapters() {
        // Renderer sends chapters out of order — output must be time-sorted so no
        // block has END < START (ffmpeg silently drops those).
        let meta = RecordingMetadata {
            title: None,
            speaker: None,
            description: None,
            chapters: vec![
                Chapter {
                    time: 60.0,
                    title: "Sermon".into(),
                },
                Chapter {
                    time: 0.0,
                    title: "Intro".into(),
                },
            ],
        };
        let out = ffmetadata(&meta, 120.0).unwrap();
        // Intro (0→59999) must come BEFORE Sermon (60000→120000) despite input order.
        let intro = out.find("START=0\nEND=59999\ntitle=Intro").unwrap();
        let sermon = out.find("START=60000\nEND=120000\ntitle=Sermon").unwrap();
        assert!(intro < sermon, "chapters must be emitted in time order");
        // No block may have END < START.
        for block in out.split("[CHAPTER]").skip(1) {
            let start: i64 = block
                .lines()
                .find_map(|l| l.strip_prefix("START="))
                .unwrap()
                .parse()
                .unwrap();
            let end: i64 = block
                .lines()
                .find_map(|l| l.strip_prefix("END="))
                .unwrap()
                .parse()
                .unwrap();
            assert!(end >= start, "END {end} < START {start}");
        }
    }

    #[test]
    fn metadata_args_emits_only_present_fields() {
        let meta = RecordingMetadata {
            title: Some("T".into()),
            speaker: None,
            description: Some("D".into()),
            chapters: vec![],
        };
        assert_eq!(
            metadata_args(&meta),
            vec!["-metadata", "title=T", "-metadata", "comment=D"]
        );
    }

    // ── output path policy ─────────────────────────────────────────────────────

    #[test]
    fn collision_free_path_first_candidate_when_free() {
        let p = collision_free_path("/rec", "service", "mp3", |_| false);
        assert_eq!(p, "/rec/service.mp3");
    }

    #[test]
    fn collision_free_path_increments_until_free() {
        let taken: HashSet<String> = ["/rec/service.mp3", "/rec/service_2.mp3"]
            .into_iter()
            .map(String::from)
            .collect();
        let p = collision_free_path("/rec", "service", "mp3", |c| taken.contains(c));
        assert_eq!(p, "/rec/service_3.mp3");
    }

    #[test]
    fn join_handles_trailing_separator() {
        assert_eq!(join("/rec/", "a.mp3"), "/rec/a.mp3");
        assert_eq!(join("", "a.mp3"), "a.mp3");
    }

    // ── timeout ─────────────────────────────────────────────────────────────────

    #[test]
    fn export_timeout_floors_at_max_edit_ms() {
        assert_eq!(export_timeout_ms(10.0), MAX_EDIT_MS);
    }

    #[test]
    fn export_timeout_scales_for_long_recordings() {
        // 4 h = 14400 s → 0.6× = 8640 s = 8_640_000 ms > 600_000 floor.
        assert_eq!(export_timeout_ms(14400.0), 8_640_000);
    }

    // ── probe / decode argv ────────────────────────────────────────────────────

    #[test]
    fn ffprobe_load_args_target_first_audio_and_format_duration() {
        let args = ffprobe_load_args("/rec/a.mp4");
        assert!(args.contains(&"-show_entries".to_string()));
        assert!(args.iter().any(|a| a.contains("format=duration")));
        assert!(args.iter().any(|a| a.contains("codec_type")));
        // the input path is the final argument
        assert_eq!(args.last().unwrap(), "/rec/a.mp4");
    }

    #[test]
    fn parse_probe_output_reads_audio_video_and_duration() {
        // ffprobe prints a stream block per stream then the format block.
        let out = "codec_type=video\n\
                   codec_type=audio\nchannels=2\nsample_fmt=fltp\n\
                   duration=123.456\n";
        let p = parse_probe_output(out);
        assert!(p.has_video);
        assert!(p.has_audio);
        assert_eq!(p.channels, Some(2));
        assert_eq!(p.sample_fmt.as_deref(), Some("fltp"));
        assert_eq!(p.duration_sec, 123.456);
    }

    #[test]
    fn parse_probe_output_audio_only_has_no_video() {
        let out = "codec_type=audio\nchannels=1\nsample_fmt=s16\nduration=60.0\n";
        let p = parse_probe_output(out);
        assert!(!p.has_video);
        assert!(p.has_audio);
        assert_eq!(p.channels, Some(1));
    }

    #[test]
    fn parse_probe_output_ignores_na_sample_fmt_and_bad_duration() {
        let out = "codec_type=audio\nchannels=2\nsample_fmt=N/A\nduration=N/A\n";
        let p = parse_probe_output(out);
        assert_eq!(p.sample_fmt, None);
        assert_eq!(p.duration_sec, 0.0);
        assert_eq!(p.channels, Some(2));
    }

    #[test]
    fn peaks_extract_args_match_electron_8khz_mono_wav() {
        let args = peaks_extract_args("/rec/a.mp4", "/tmp/p.wav");
        let joined = args.join(" ");
        assert!(joined.contains("-vn"));
        assert!(joined.contains("-ac 1"));
        assert!(joined.contains("-ar 8000"));
        assert!(joined.contains("-f wav"));
        assert_eq!(args.last().unwrap(), "/tmp/p.wav");
    }

    #[test]
    fn analysis_decode_args_pipe_16khz_s16le() {
        let args = analysis_decode_args("/rec/a.mp4");
        let joined = args.join(" ");
        assert!(joined.contains("-ar 16000"));
        assert!(joined.contains("-f s16le"));
        // raw stream to stdout
        assert_eq!(args.last().unwrap(), "-");
    }

    #[test]
    fn frame_extract_args_seek_scale_single_mjpeg_to_pipe() {
        let args = frame_extract_args("/rec/a.mp4", 12.5);
        let joined = args.join(" ");
        // Fast input seek: `-ss` BEFORE `-i` with the requested second.
        let ss = args.iter().position(|a| a == "-ss").unwrap();
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert!(ss < i, "-ss must precede -i for a fast input seek");
        assert_eq!(args[ss + 1], "12.5");
        assert_eq!(args[i + 1], "/rec/a.mp4");
        // 480px-wide, even-height scale; exactly one frame; MJPEG to stdout.
        assert!(joined.contains("-vf scale=480:-2"));
        assert!(joined.contains("-frames:v 1"));
        assert!(joined.contains("-f image2pipe"));
        assert!(joined.contains("-vcodec mjpeg"));
        assert_eq!(args.last().unwrap(), "pipe:1");
    }

    #[test]
    fn frame_extract_args_clamps_negative_and_nonfinite_seek_to_zero() {
        for bad in [-3.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let args = frame_extract_args("/rec/a.mp4", bad);
            let ss = args.iter().position(|a| a == "-ss").unwrap();
            assert_eq!(args[ss + 1], "0", "seek {bad} should clamp to 0");
        }
    }

    // ── peak down-sampling ──────────────────────────────────────────────────────

    #[test]
    fn downsample_peaks_empty_input_is_empty() {
        assert!(downsample_peaks(&[], 100).is_empty());
        assert!(downsample_peaks(&[0.5], 0).is_empty());
    }

    #[test]
    fn downsample_peaks_takes_max_abs_per_bucket() {
        // 4 samples → 2 buckets: bucket 0 = max(|-0.3|,|0.7|)=0.7, bucket 1 = 0.9.
        let s = [-0.3, 0.7, 0.9, -0.1];
        let peaks = downsample_peaks(&s, 2);
        assert_eq!(peaks.len(), 2);
        assert!((peaks[0] - 0.7).abs() < 1e-6);
        assert!((peaks[1] - 0.9).abs() < 1e-6);
    }

    #[test]
    fn downsample_peaks_caps_buckets_at_sample_count() {
        let s = [0.2, 0.4, 0.6];
        // more buckets than samples → one peak per sample.
        let peaks = downsample_peaks(&s, 100);
        assert_eq!(peaks.len(), 3);
    }

    // ── sidecar path policy ──────────────────────────────────────────────────────

    #[test]
    fn sidecar_path_joins_stem_and_suffix() {
        assert_eq!(
            sidecar_path("/rec", "service", Sidecar::Meta).unwrap(),
            "/rec/service.meta.json"
        );
        assert_eq!(
            sidecar_path("/rec", "service", Sidecar::CutsDraft).unwrap(),
            "/rec/service.cuts-draft.json"
        );
        assert_eq!(
            sidecar_path("/rec", "service", Sidecar::Transcript).unwrap(),
            "/rec/service.transcript.json"
        );
    }

    #[test]
    fn sidecar_path_refuses_escaping_stem() {
        // A stem containing a separator would relocate the sidecar out of `dir`.
        assert!(sidecar_path("/rec", "../evil", Sidecar::Meta).is_none());
        assert!(sidecar_path("/rec", "sub\\evil", Sidecar::Meta).is_none());
        assert!(sidecar_path("/rec", "", Sidecar::Meta).is_none());
    }

    // ── inline-vs-stream guard ─────────────────────────────────────────────────────

    #[test]
    fn inline_decision_flips_at_400mb() {
        assert_eq!(inline_decision(0), InlineDecision::Inline);
        assert_eq!(inline_decision(EDITOR_INLINE_LIMIT), InlineDecision::Inline);
        assert_eq!(
            inline_decision(EDITOR_INLINE_LIMIT + 1),
            InlineDecision::TooLarge
        );
    }

    // ── temp-file cleanup ──────────────────────────────────────────────────────────

    #[test]
    fn editor_temp_name_matches_tmp_bak_and_video_tmp() {
        assert!(is_editor_temp_name("service.mp3.__editor_tmp"));
        assert!(is_editor_temp_name("service.mp3.__editor_bak"));
        // The video-save variant ends in .mp4 but still carries the tmp marker.
        assert!(is_editor_temp_name("service.__editor_tmp.mp4"));
        assert!(!is_editor_temp_name("service.mp3"));
        assert!(!is_editor_temp_name("service.meta.json"));
    }

    #[test]
    fn dedupe_cleanup_dirs_drops_empties_and_duplicates_preserving_order() {
        let folders = vec![
            "/a".to_string(),
            "".to_string(),
            "/b".to_string(),
            "/a".to_string(),
        ];
        let out = dedupe_cleanup_dirs(&folders, |s| s.to_string());
        assert_eq!(out, vec!["/a".to_string(), "/b".to_string()]);
    }

    #[test]
    fn dedupe_cleanup_dirs_canonicalises_via_resolve() {
        // Two paths that resolve to the same canonical dir collapse to one.
        let folders = vec!["/a/".to_string(), "/a".to_string()];
        let out = dedupe_cleanup_dirs(&folders, |s| s.trim_end_matches('/').to_string());
        assert_eq!(out, vec!["/a".to_string()]);
    }

    // ── atomic safe-replace ────────────────────────────────────────────────────────

    #[test]
    fn safe_replace_posix_is_single_rename() {
        assert_eq!(
            safe_replace_plan("/rec/a.__editor_tmp", "/rec/a.mp3", false),
            SafeReplacePlan::Rename {
                temp: "/rec/a.__editor_tmp".into(),
                target: "/rec/a.mp3".into(),
            }
        );
    }

    #[test]
    fn safe_replace_windows_uses_backup_swap() {
        assert_eq!(
            safe_replace_plan("/rec/a.__editor_tmp", "/rec/a.mp3", true),
            SafeReplacePlan::BackupSwap {
                temp: "/rec/a.__editor_tmp".into(),
                target: "/rec/a.mp3".into(),
                bak: "/rec/a.mp3.__editor_bak".into(),
            }
        );
    }
}
