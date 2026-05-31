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

/// Standard MP4 output codec args — mirrors `editor.MP4_CODEC_ARGS`.
pub fn mp4_codec_args() -> Vec<String> {
    [
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
        "+faststart",
    ]
    .into_iter()
    .map(String::from)
    .collect()
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
    for (i, ch) in meta.chapters.iter().enumerate() {
        let start = (ch.time * 1000.0).round() as i64;
        let end = match meta.chapters.get(i + 1) {
            Some(next) => (next.time * 1000.0).round() as i64 - 1,
            None => (duration * 1000.0).round() as i64,
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
}
