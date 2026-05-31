//! Mastering — EBU R128 loudness, pure (P2a).
//!
//! Ported from the Electron `src/main/mastering.ts` (the behavioural spec).
//! Professional speech mastering for sermons/podcasts: a per-preset ffmpeg
//! filter chain (HPF / EQ / compression) plus two-pass EBU R128 loudness
//! normalisation. The two passes:
//!   1. **measure** — run the preset chain + `loudnorm(print_format=json)` to a
//!      null sink; parse the measured `input_i / input_lra / input_tp /
//!      input_thresh / target_offset` from ffmpeg's stderr JSON block,
//!   2. **apply** — re-run with those measured values fed back into `loudnorm`
//!      in `linear=true` mode for a clean, deterministic result at the target.
//!
//! This module is the *pure* half: the preset table, the loudnorm JSON parser,
//! and the three filter-string builders (measure / apply / preview). The
//! `src-tauri` shell (`media::mastering`, behind the `editor` feature) spawns
//! ffmpeg with these strings and parses progress.

/// A mastering preset — a named target loudness + the ffmpeg filter chain that
/// precedes `loudnorm`. Mirrors `mastering.ts` `MasterPreset`. `label` and
/// `description` are the Norwegian user-facing strings (kept verbatim).
#[derive(Debug, Clone, PartialEq)]
pub struct MasterPreset {
    pub id: String,
    pub label: String,
    pub description: String,
    /// Integrated LUFS target.
    pub target_lufs: f64,
    /// Loudness range target.
    pub target_lra: f64,
    /// Max true peak in dBTP.
    pub true_peak_db: f64,
    /// ffmpeg filter chain WITHOUT loudnorm.
    pub filters: String,
}

/// The built-in presets, verbatim from `MASTER_PRESETS`. The four cover the
/// common church-service publishing targets (natural → punchy speech, plus a
/// dynamics-preserving music+speech chain).
pub fn master_presets() -> Vec<MasterPreset> {
    vec![
        MasterPreset {
            id: "speech-natural".into(),
            label: "Tale — naturlig".into(),
            description: "Lett polering. Bra for opptak som allerede er gode.".into(),
            target_lufs: -19.0,
            target_lra: 7.0,
            true_peak_db: -1.0,
            filters:
                "highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=5:release=50:makeup=2"
                    .into(),
        },
        MasterPreset {
            id: "speech-clear".into(),
            label: "Tale — tydelig (anbefalt)".into(),
            description:
                "Standard mastering for taler og prekener. Tydeligere stemme, jevnere lyd.".into(),
            target_lufs: -16.0,
            target_lra: 8.0,
            true_peak_db: -1.0,
            filters: "highpass=f=80,equalizer=f=200:t=q:w=2:g=-1.5,equalizer=f=3000:t=q:w=1:g=2,\
                      equalizer=f=7000:t=q:w=1.5:g=-2,\
                      acompressor=threshold=-20dB:ratio=3:attack=5:release=80:makeup=2"
                .into(),
        },
        MasterPreset {
            id: "speech-punchy".into(),
            label: "Tale — kraftig".into(),
            description: "For svake stemmer eller støyete opptak. Sterkere prosessering.".into(),
            target_lufs: -14.0,
            target_lra: 6.0,
            true_peak_db: -1.0,
            filters: "highpass=f=100,equalizer=f=200:t=q:w=2:g=-2,equalizer=f=2500:t=q:w=1:g=3,\
                      equalizer=f=7000:t=q:w=1.5:g=-3,\
                      acompressor=threshold=-24dB:ratio=4:attack=3:release=50:makeup=3,\
                      acompressor=threshold=-12dB:ratio=2:attack=50:release=300:makeup=1"
                .into(),
        },
        MasterPreset {
            id: "music-speech".into(),
            label: "Musikk + tale".into(),
            description: "For gudstjenester med salmer eller annen musikk. Bevarer dynamikk."
                .into(),
            target_lufs: -16.0,
            target_lra: 11.0,
            true_peak_db: -1.0,
            filters:
                "highpass=f=50,acompressor=threshold=-22dB:ratio=2:attack=10:release=100:makeup=1"
                    .into(),
        },
    ]
}

/// Find a preset by id. Mirrors `getPresetById`.
pub fn get_preset_by_id(id: &str) -> Option<MasterPreset> {
    master_presets().into_iter().find(|p| p.id == id)
}

// ── loudnorm measurement ──────────────────────────────────────────────────────

/// The measured loudness values parsed from a pass-1 `loudnorm` JSON block.
/// Mirrors `LoudnessMeasurement`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoudnessMeasurement {
    /// Measured integrated LUFS.
    pub input_i: f64,
    /// Measured LRA.
    pub input_lra: f64,
    /// Measured true peak (dBTP).
    pub input_tp: f64,
    /// Measurement threshold.
    pub input_thresh: f64,
    /// Suggested gain offset.
    pub target_offset: f64,
}

/// Scan `stderr` for the standalone JSON object `loudnorm` prints at the end of
/// pass 1 and parse the five fields. Mirrors `parseLoudnormJson`:
///   - identify single-level `{…}` blocks by brace depth (loudnorm never nests),
///   - prefer the *last* block containing both `input_i` and `input_tp`,
///   - parse the string-valued numeric fields, defaulting LRA→0, thresh→-70,
///     offset→0 when absent/non-finite,
///   - require finite `input_i` and `input_tp`, else return `None`.
pub fn parse_loudnorm_json(stderr: &str) -> Option<LoudnessMeasurement> {
    if stderr.is_empty() {
        return None;
    }
    // Collect top-level brace blocks.
    let bytes = stderr.as_bytes();
    let mut blocks: Vec<&str> = Vec::new();
    let mut depth = 0i32;
    let mut start: i64 = -1;
    for (i, &c) in bytes.iter().enumerate() {
        if c == b'{' {
            if depth == 0 {
                start = i as i64;
            }
            depth += 1;
        } else if c == b'}' {
            depth -= 1;
            if depth == 0 && start != -1 {
                blocks.push(&stderr[start as usize..=i]);
                start = -1;
            }
        }
    }

    for block in blocks.iter().rev() {
        if !block.contains("input_i") || !block.contains("input_tp") {
            continue;
        }
        let val = |key: &str| extract_json_number(block, key);
        let input_i = val("input_i");
        let input_tp = val("input_tp");
        // target_offset, falling back to normalization_type (matches the TS
        // `obj.target_offset ?? obj.normalization_type` chain), then 0.
        let target_offset = val("target_offset")
            .or_else(|| val("normalization_type"))
            .unwrap_or(0.0);
        match (input_i, input_tp) {
            (Some(i), Some(tp)) if i.is_finite() && tp.is_finite() => {
                return Some(LoudnessMeasurement {
                    input_i: i,
                    input_lra: val("input_lra").filter(|v| v.is_finite()).unwrap_or(0.0),
                    input_tp: tp,
                    input_thresh: val("input_thresh")
                        .filter(|v| v.is_finite())
                        .unwrap_or(-70.0),
                    target_offset: if target_offset.is_finite() {
                        target_offset
                    } else {
                        0.0
                    },
                });
            }
            _ => continue,
        }
    }
    None
}

/// Pull a quoted-string-valued number out of a flat loudnorm JSON block by key,
/// e.g. `"input_i" : "-23.45"` → `-23.45`. loudnorm emits all numerics as
/// strings, so we locate `"key"`, skip to the next quote-delimited value and
/// `parseFloat` it (matching JS `parseFloat` lenience: leading number, trailing
/// junk ignored).
fn extract_json_number(block: &str, key: &str) -> Option<f64> {
    let needle = format!("\"{key}\"");
    let key_pos = block.find(&needle)?;
    let after = &block[key_pos + needle.len()..];
    // Find the value: after the colon, the next `"…"` quoted token.
    let colon = after.find(':')?;
    let rest = &after[colon + 1..];
    let q1 = rest.find('"')?;
    let after_q1 = &rest[q1 + 1..];
    let q2 = after_q1.find('"')?;
    parse_float_lenient(&after_q1[..q2])
}

/// JS-`parseFloat`-style lenient parse: take the leading numeric prefix
/// (optional sign, digits, decimal point, exponent) and ignore trailing junk.
fn parse_float_lenient(s: &str) -> Option<f64> {
    let t = s.trim();
    let mut end = 0;
    let bytes = t.as_bytes();
    let mut seen_dot = false;
    let mut seen_e = false;
    while end < bytes.len() {
        let c = bytes[end];
        let ok = match c {
            b'0'..=b'9' => true,
            b'+' | b'-' => end == 0 || matches!(bytes[end - 1], b'e' | b'E'),
            b'.' if !seen_dot && !seen_e => {
                seen_dot = true;
                true
            }
            b'e' | b'E' if !seen_e => {
                seen_e = true;
                true
            }
            _ => false,
        };
        if !ok {
            break;
        }
        end += 1;
    }
    t[..end].parse::<f64>().ok()
}

// ── Filter-chain builders ──────────────────────────────────────────────────────

/// Pass-1 (measurement) filters: the preset chain + `loudnorm(…:print_format=json)`.
/// Mirrors `buildMeasurePassFilters`.
pub fn build_measure_pass_filters(preset: &MasterPreset) -> String {
    format!(
        "{},loudnorm=I={}:LRA={}:TP={}:print_format=json",
        preset.filters,
        fmt_num(preset.target_lufs),
        fmt_num(preset.target_lra),
        fmt_num(preset.true_peak_db)
    )
}

/// Pass-2 (apply) filters: the preset chain + a `loudnorm` carrying the measured
/// values in `linear=true` mode. Mirrors `buildApplyPassFilters`. The measured
/// values are formatted to 2 decimals exactly as the TS `.toFixed(2)` did.
pub fn build_apply_pass_filters(preset: &MasterPreset, m: &LoudnessMeasurement) -> String {
    let loudnorm = format!(
        "loudnorm=I={}:LRA={}:TP={}:measured_I={:.2}:measured_LRA={:.2}:measured_TP={:.2}\
         :measured_thresh={:.2}:offset={:.2}:linear=true:print_format=summary",
        fmt_num(preset.target_lufs),
        fmt_num(preset.target_lra),
        fmt_num(preset.true_peak_db),
        m.input_i,
        m.input_lra,
        m.input_tp,
        m.input_thresh,
        m.target_offset
    );
    format!("{},{loudnorm}", preset.filters)
}

/// Single-pass preview filters — target loudnorm only, lower CPU. Mirrors
/// `buildPreviewPassFilters`.
pub fn build_preview_pass_filters(preset: &MasterPreset) -> String {
    format!(
        "{},loudnorm=I={}:LRA={}:TP={}",
        preset.filters,
        fmt_num(preset.target_lufs),
        fmt_num(preset.target_lra),
        fmt_num(preset.true_peak_db)
    )
}

/// Format a preset target number the way JS template strings did — integers
/// without a trailing `.0` (`-16`, not `-16.0`), fractionals as-is (`-1.5`).
fn fmt_num(v: f64) -> String {
    if v.fract() == 0.0 {
        format!("{}", v as i64)
    } else {
        // Trim trailing zeros while keeping the value, matching JS number→string.
        let s = format!("{v}");
        s
    }
}

/// Output codec args for a mastered file — mirrors `masterCodecArgs` (a subset
/// of the editor's, with an mp3 default).
pub fn master_codec_args(ext: &str, bitrate: Option<u32>) -> Vec<String> {
    let s = |v: &str| v.to_string();
    let br = |dflt: u32| format!("{}k", bitrate.unwrap_or(dflt));
    match ext {
        "wav" => vec![s("-c:a"), s("pcm_s16le")],
        "flac" => vec![s("-c:a"), s("flac")],
        "aac" | "m4a" | "m4b" | "m4r" | "caf" => vec![s("-c:a"), s("aac"), s("-b:a"), br(192)],
        "ogg" | "oga" => vec![s("-c:a"), s("libvorbis"), s("-b:a"), br(192)],
        "opus" => vec![s("-c:a"), s("libopus"), s("-b:a"), br(128)],
        _ => vec![s("-c:a"), s("libmp3lame"), s("-b:a"), br(192)],
    }
}

// ── Progress parsing ───────────────────────────────────────────────────────────

/// Parse a current-time (seconds) from an ffmpeg `-progress` line, accepting
/// either `out_time_ms=` (microseconds, despite the name) or
/// `out_time=HH:MM:SS.ffffff`. Mirrors `parseProgressTime`.
pub fn parse_progress_time(line: &str) -> Option<f64> {
    for l in line.lines() {
        if let Some(rest) = l.strip_prefix("out_time_ms=") {
            if let Ok(us) = rest.trim().parse::<u64>() {
                return Some(us as f64 / 1_000_000.0);
            }
        }
    }
    for l in line.lines() {
        if let Some(rest) = l.strip_prefix("out_time=") {
            if let Some(sec) = parse_hms(rest) {
                return Some(sec);
            }
        }
    }
    None
}

/// Parse `HH:MM:SS.fff` → seconds.
fn parse_hms(s: &str) -> Option<f64> {
    let parts: Vec<&str> = s.trim().split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let sec: f64 = parts[2].parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec)
}

/// Clamp a measure-preview snippet duration to the `[1, 60]` second band the
/// Electron `buildPreview` enforced, defaulting a non-finite request to 15 s.
pub fn clamp_preview_duration(requested: f64) -> f64 {
    let d = if requested.is_finite() {
        requested
    } else {
        15.0
    };
    d.clamp(1.0, 60.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── presets ────────────────────────────────────────────────────────────────

    #[test]
    fn four_presets_with_unique_ids() {
        let presets = master_presets();
        assert_eq!(presets.len(), 4);
        let mut ids: Vec<&str> = presets.iter().map(|p| p.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 4);
    }

    #[test]
    fn lookup_by_id() {
        assert_eq!(get_preset_by_id("speech-clear").unwrap().target_lufs, -16.0);
        assert!(get_preset_by_id("nope").is_none());
    }

    // ── loudnorm JSON parse ──────────────────────────────────────────────────────

    const SAMPLE: &str = r#"
[Parsed_loudnorm_0 @ 0x600003a8c000]
{
        "input_i" : "-23.45",
        "input_tp" : "-3.12",
        "input_lra" : "9.40",
        "input_thresh" : "-33.51",
        "output_i" : "-16.00",
        "target_offset" : "7.45"
}
"#;

    #[test]
    fn parses_a_real_loudnorm_block() {
        let m = parse_loudnorm_json(SAMPLE).unwrap();
        assert_eq!(m.input_i, -23.45);
        assert_eq!(m.input_tp, -3.12);
        assert_eq!(m.input_lra, 9.40);
        assert_eq!(m.input_thresh, -33.51);
        assert_eq!(m.target_offset, 7.45);
    }

    #[test]
    fn returns_none_for_empty_or_non_loudnorm() {
        assert!(parse_loudnorm_json("").is_none());
        assert!(parse_loudnorm_json("no json here at all").is_none());
        assert!(parse_loudnorm_json("{ \"foo\" : \"1\" }").is_none());
    }

    #[test]
    fn missing_lra_and_thresh_default() {
        let block = r#"{ "input_i" : "-20.0", "input_tp" : "-2.0" }"#;
        let m = parse_loudnorm_json(block).unwrap();
        assert_eq!(m.input_lra, 0.0);
        assert_eq!(m.input_thresh, -70.0);
        assert_eq!(m.target_offset, 0.0);
    }

    #[test]
    fn prefers_last_loudnorm_block() {
        let two =
            format!("{{ \"input_i\" : \"-30.0\", \"input_tp\" : \"-9.0\" }}\nnoise\n{SAMPLE}");
        let m = parse_loudnorm_json(&two).unwrap();
        // The SAMPLE block is later → its values win.
        assert_eq!(m.input_i, -23.45);
    }

    // ── filter builders ──────────────────────────────────────────────────────────

    #[test]
    fn measure_filters_append_json_loudnorm() {
        let p = get_preset_by_id("speech-clear").unwrap();
        let f = build_measure_pass_filters(&p);
        assert!(f.starts_with(&p.filters));
        assert!(f.ends_with(",loudnorm=I=-16:LRA=8:TP=-1:print_format=json"));
    }

    #[test]
    fn apply_filters_embed_measured_values_to_2dp() {
        let p = get_preset_by_id("speech-natural").unwrap();
        let m = LoudnessMeasurement {
            input_i: -23.456,
            input_lra: 9.4,
            input_tp: -3.1,
            input_thresh: -33.5,
            target_offset: 7.451,
        };
        let f = build_apply_pass_filters(&p, &m);
        assert!(f.contains("measured_I=-23.46"));
        assert!(f.contains("measured_LRA=9.40"));
        assert!(f.contains("measured_TP=-3.10"));
        assert!(f.contains("measured_thresh=-33.50"));
        assert!(f.contains("offset=7.45"));
        assert!(f.contains(":linear=true:print_format=summary"));
    }

    #[test]
    fn preview_filters_are_single_pass() {
        let p = get_preset_by_id("music-speech").unwrap();
        let f = build_preview_pass_filters(&p);
        assert!(f.ends_with(",loudnorm=I=-16:LRA=11:TP=-1"));
        assert!(!f.contains("print_format"));
    }

    #[test]
    fn fmt_num_keeps_integers_clean_and_fractions() {
        assert_eq!(fmt_num(-16.0), "-16");
        assert_eq!(fmt_num(-1.5), "-1.5");
        assert_eq!(fmt_num(11.0), "11");
    }

    // ── codec args ───────────────────────────────────────────────────────────────

    #[test]
    fn master_codec_defaults_to_mp3_192() {
        assert_eq!(
            master_codec_args("xyz", None),
            vec!["-c:a", "libmp3lame", "-b:a", "192k"]
        );
    }

    #[test]
    fn master_codec_wav_is_16le() {
        assert_eq!(master_codec_args("wav", None), vec!["-c:a", "pcm_s16le"]);
    }

    // ── progress parsing ───────────────────────────────────────────────────────────

    #[test]
    fn progress_prefers_out_time_ms_microseconds() {
        assert_eq!(parse_progress_time("out_time_ms=12345678"), Some(12.345678));
    }

    #[test]
    fn progress_falls_back_to_hms() {
        assert_eq!(
            parse_progress_time("frame=1\nout_time=00:01:30.500000\nspeed=1x"),
            Some(90.5)
        );
    }

    #[test]
    fn progress_none_when_absent() {
        assert!(parse_progress_time("frame=1\nfps=30").is_none());
    }

    // ── preview clamp ─────────────────────────────────────────────────────────────

    #[test]
    fn preview_duration_clamps_to_band() {
        assert_eq!(clamp_preview_duration(0.5), 1.0);
        assert_eq!(clamp_preview_duration(120.0), 60.0);
        assert_eq!(clamp_preview_duration(30.0), 30.0);
        assert_eq!(clamp_preview_duration(f64::NAN), 15.0);
    }
}
