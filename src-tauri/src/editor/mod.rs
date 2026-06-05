//! Editor I/O plumbing (R1 P2b) — **HARDWARE-UNVERIFIED**, default-off `editor` feature.
//!
//! The impure half of the non-destructive editor. Every *decision* lives in the
//! unit-tested core:
//!   - cut/keep planning + filter-graph + codec + output-path + chapters →
//!     [`sundayrec_core::editor`],
//!   - EBU R128 loudness measure/apply filter chains + the loudnorm JSON parse →
//!     [`sundayrec_core::mastering`],
//!   - VAD / content classification + sermon detection →
//!     [`sundayrec_core::audio_analysis`],
//!   - the ffprobe/decode/peaks argv + peak down-sampling →
//!     [`sundayrec_core::editor`] (R1 additions).
//!
//! This module performs the side effects the Electron `src/main/editor.ts`,
//! `mastering.ts` and `audio-analysis.ts` did: spawn the bundled ffmpeg/ffprobe
//! sidecar with the core's argv, stream/collect its output, parse it with the
//! core, and (for export) atomically render the cut-plan + mastering gain to a
//! chosen format.
//!
//! ## Feature flag
//!
//! Behind the **default-off `editor`** cargo feature. NO new native dep — ffmpeg
//! is a sidecar and the WAV/PCM is parsed by hand — so the gate only compiles the
//! I/O seam in or out. The public entry points compile either way; when the
//! feature is OFF they return a clear `feature_disabled` error so the renderer
//! can surface "editing isn't built into this build" (mirrors the `whisper`
//! idiom). Enable with `--features editor` for the smoke test.
//!
//! ## ⚠️ HARDWARE-UNVERIFIED
//!
//! Under `--features editor` the ffprobe load, the peaks/analysis decode, the
//! loudness two-pass measure, and the export render are wired but unproven on
//! real media. Only the `sundayrec-core` decisions are unit-tested. The seam's
//! argv-building is delegated to the (tested) core; only the spawn + the
//! mechanical output→core handoff live here. See docs/SMOKE-TEST.md §9.

use serde::{Deserialize, Serialize};
use std::path::Path;
use ts_rs::TS;

use crate::error::AppError;
use crate::error::AppResult;

// ── IPC DTOs (compile regardless of the feature) ────────────────────────────────

/// What a load-probe resolved about a recording, for the editor's first paint.
/// The renderer-facing mirror of [`sundayrec_core::editor::ProbeResult`].
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/EditorMediaInfo.ts")]
#[serde(rename_all = "camelCase")]
pub struct EditorMediaInfo {
    pub duration_sec: f64,
    pub has_video: bool,
    pub has_audio: bool,
    pub channels: Option<u32>,
    pub sample_fmt: Option<String>,
}

/// The waveform peaks the renderer draws, plus the authoritative duration
/// (ffprobe's, not the renderer's `<audio>.duration` which can lie on VBR).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/EditorPeaks.ts")]
#[serde(rename_all = "camelCase")]
pub struct EditorPeaks {
    /// Max-abs amplitude per bucket, 0..1, length ≤ `PEAK_BUCKETS`.
    pub peaks: Vec<f32>,
    /// The sample rate the peaks were decoded at (8 kHz — see core).
    pub sample_rate: u32,
}

/// One content-detected segment for the editor timeline. Reuses the core
/// `SegmentType` lowercase strings (or `"sermon"` for the promoted block), the
/// same shape `detectSegments` returned to the Electron renderer.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/EditorSegment.ts")]
#[serde(rename_all = "camelCase")]
pub struct EditorSegment {
    pub start: f64,
    pub end: f64,
    pub duration: f64,
    pub label: String,
    /// `silence|speech|music|mixed|unknown|sermon`.
    pub kind: String,
}

/// The measured loudness the mastering UI shows before/after a preset, mirroring
/// the pass-1 `loudnorm` JSON the Electron mastering flow surfaced.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/EditorLoudness.ts")]
#[serde(rename_all = "camelCase")]
pub struct EditorLoudness {
    /// Measured integrated loudness (LUFS).
    pub input_i: f64,
    /// Loudness range.
    pub input_lra: f64,
    /// True peak (dBTP).
    pub input_tp: f64,
    /// The preset this was measured against (its target LUFS for the delta UI).
    pub target_lufs: f64,
}

/// A cut region (seconds) the renderer marked to remove. Mirrors the Electron
/// `CutRegion`; converted to [`sundayrec_core::editor::CutRegion`] in the seam.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/EditorCutRegion.ts")]
#[serde(rename_all = "camelCase")]
pub struct EditorCutRegion {
    pub start: f64,
    pub end: f64,
}

/// Export request — the cut-plan + a chosen format + optional mastering preset,
/// intro/outro jingles, and topic chapters. Mirrors the non-video subset of the
/// Electron `EditorExportParams` the editor UI sent (mp4 video re-encode aside).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/EditorExportRequest.ts")]
#[serde(rename_all = "camelCase")]
pub struct EditorExportRequest {
    pub input_path: String,
    pub cut_regions: Vec<EditorCutRegion>,
    pub duration: f64,
    /// Output container: `mp3|aac|wav|flac|mp4`.
    pub format: String,
    /// Folder to write into; the seam picks a collision-free name there.
    pub output_folder: String,
    /// Output bitrate (kbps) for lossy formats; `None` uses the codec default.
    pub bitrate: Option<u32>,
    /// WAV bit depth (16/24); ignored for non-WAV.
    pub bit_depth: Option<u8>,
    /// Optional mastering preset id (a two-pass loudnorm chain is applied first).
    pub master_preset: Option<String>,
    /// Optional intro clip prepended to the audio on export (non-mp4 only).
    pub intro_path: Option<String>,
    /// Optional outro clip appended to the audio on export (non-mp4 only).
    pub outro_path: Option<String>,
    /// Optional peak-normalization gain (dB) applied as a `volume` filter — what
    /// the editor's "Normalize" button computes. `None`/`0` is a no-op.
    pub gain_db: Option<f64>,
    /// Topic chapters to embed in the exported file (FFMETADATA → ID3 CHAP/CTOC).
    /// Times are in the ORIGINAL recording timeline; export remaps them through
    /// the cut-plan and drops any that fall inside a cut. Empty = none embedded.
    #[serde(default)]
    pub chapters: Vec<EditorChapter>,
    /// Optional file title (FFMETADATA `title`); also used as the chapter header.
    #[serde(default)]
    pub title: Option<String>,
    /// Optional speaker (FFMETADATA `artist`).
    #[serde(default)]
    pub speaker: Option<String>,
    /// Optional description (FFMETADATA `comment`).
    #[serde(default)]
    pub description: Option<String>,
    /// One-click vocal-chain preset id (`voice-light|voice-podcast|
    /// voice-noisy-room`). Resolved server-side; ignored when `processing` is set.
    #[serde(default)]
    pub vocal_chain_preset: Option<String>,
    /// Full per-stage vocal-chain config. Overrides `vocalChainPreset`. The chain
    /// runs BEFORE the mastering loudnorm (tone/dynamics first, loudness last).
    #[serde(default)]
    pub processing: Option<EditorProcessing>,
    /// Channel repair to apply. Overrides the repair carried by `processing`/the
    /// preset, and applies on its own (without any vocal chain) when set alone.
    #[serde(default)]
    pub channel_repair: Option<EditorChannelRepair>,
    /// Video codec for a video-container export (`h264` default, or `h265`/`hevc`
    /// for ~half the size). Ignored for audio formats.
    #[serde(default)]
    pub video_codec: Option<String>,
}

/// One chapter marker (a title at a time, in seconds). The renderer-facing mirror
/// of [`sundayrec_core::editor::Chapter`].
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/EditorChapter.ts")]
#[serde(rename_all = "camelCase")]
pub struct EditorChapter {
    pub time: f64,
    pub title: String,
}

/// One timestamped transcript line fed to chapter detection. Mirrors the whisper
/// `TranscriptSegment` subset the detector needs (start + text).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/EditorTranscriptLine.ts")]
#[serde(rename_all = "camelCase")]
pub struct EditorTranscriptLine {
    pub start: f64,
    pub text: String,
}

/// How to repair the channel layout (mirror of
/// [`sundayrec_core::processing::ChannelRepair`]). `mode` is one of
/// `none|swapLr|duplicateLeft|duplicateRight|monoMix|gainDb`; `leftDb`/`rightDb`
/// are only read for `gainDb`.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/EditorChannelRepair.ts")]
#[serde(rename_all = "camelCase")]
pub struct EditorChannelRepair {
    pub mode: String,
    #[serde(default)]
    pub left_db: f64,
    #[serde(default)]
    pub right_db: f64,
}

impl EditorChannelRepair {
    fn to_core(&self) -> sundayrec_core::processing::ChannelRepair {
        use sundayrec_core::processing::ChannelRepair as R;
        match self.mode.as_str() {
            "swapLr" => R::SwapLr,
            "duplicateLeft" => R::DuplicateLeft,
            "duplicateRight" => R::DuplicateRight,
            "monoMix" => R::MonoMix,
            "gainDb" => R::GainDb {
                left_db: self.left_db,
                right_db: self.right_db,
            },
            _ => R::None,
        }
    }
}

/// One parametric EQ band (mirror of [`sundayrec_core::processing::EqBand`]).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/EditorEqBand.ts")]
#[serde(rename_all = "camelCase")]
pub struct EditorEqBand {
    pub freq_hz: u32,
    pub gain_db: f64,
    pub q: f64,
}

/// The full, per-stage vocal-chain configuration (mirror of
/// [`sundayrec_core::processing::VocalChain`]). Every stage is independently
/// toggleable; `serde(default)` lets the renderer send a partial object. When an
/// export carries this it overrides any `vocalChainPreset`.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/EditorProcessing.ts")]
#[serde(rename_all = "camelCase", default)]
pub struct EditorProcessing {
    pub channel_repair: Option<EditorChannelRepair>,
    pub highpass_enabled: bool,
    pub highpass_hz: u32,
    pub denoise_enabled: bool,
    pub denoise_db: f64,
    pub denoise_floor_db: f64,
    pub dereverb_enabled: bool,
    pub dereverb_strength: f64,
    pub gate_enabled: bool,
    pub gate_threshold_db: f64,
    pub gate_ratio: f64,
    pub eq: Vec<EditorEqBand>,
    pub comp_enabled: bool,
    pub comp_threshold_db: f64,
    pub comp_ratio: f64,
    pub comp_attack_ms: f64,
    pub comp_release_ms: f64,
    pub comp_makeup_db: f64,
    pub deesser_enabled: bool,
    pub deesser_intensity: f64,
    pub limiter_enabled: bool,
    pub limiter_db: f64,
    pub gain_db: f64,
}

impl Default for EditorProcessing {
    fn default() -> Self {
        // Mirrors `VocalChain::default()` so an empty object behaves identically.
        use sundayrec_core::processing::VocalChain;
        let c = VocalChain::default();
        Self {
            channel_repair: None,
            highpass_enabled: c.highpass.enabled,
            highpass_hz: c.highpass.freq_hz,
            denoise_enabled: c.denoise.enabled,
            denoise_db: c.denoise.reduction_db,
            denoise_floor_db: c.denoise.noise_floor_db,
            dereverb_enabled: c.dereverb.enabled,
            dereverb_strength: c.dereverb.strength,
            gate_enabled: c.gate.enabled,
            gate_threshold_db: c.gate.threshold_db,
            gate_ratio: c.gate.ratio,
            eq: Vec::new(),
            comp_enabled: c.compressor.enabled,
            comp_threshold_db: c.compressor.threshold_db,
            comp_ratio: c.compressor.ratio,
            comp_attack_ms: c.compressor.attack_ms,
            comp_release_ms: c.compressor.release_ms,
            comp_makeup_db: c.compressor.makeup_db,
            deesser_enabled: c.deesser.enabled,
            deesser_intensity: c.deesser.intensity,
            limiter_enabled: c.limiter.enabled,
            limiter_db: c.limiter.limit_db,
            gain_db: c.gain_db,
        }
    }
}

impl EditorProcessing {
    fn to_core(&self) -> sundayrec_core::processing::VocalChain {
        use sundayrec_core::processing::*;
        VocalChain {
            channel_repair: self
                .channel_repair
                .as_ref()
                .map(|r| r.to_core())
                .unwrap_or(ChannelRepair::None),
            highpass: HighpassStage {
                enabled: self.highpass_enabled,
                freq_hz: self.highpass_hz,
            },
            denoise: DenoiseStage {
                enabled: self.denoise_enabled,
                reduction_db: self.denoise_db,
                noise_floor_db: self.denoise_floor_db,
            },
            dereverb: DereverbStage {
                enabled: self.dereverb_enabled,
                strength: self.dereverb_strength,
            },
            gate: GateStage {
                enabled: self.gate_enabled,
                threshold_db: self.gate_threshold_db,
                ratio: self.gate_ratio,
                attack_ms: 5.0,
                release_ms: 120.0,
            },
            eq: self
                .eq
                .iter()
                .map(|b| EqBand {
                    freq_hz: b.freq_hz,
                    gain_db: b.gain_db,
                    q: b.q,
                })
                .collect(),
            compressor: CompressorStage {
                enabled: self.comp_enabled,
                threshold_db: self.comp_threshold_db,
                ratio: self.comp_ratio,
                attack_ms: self.comp_attack_ms,
                release_ms: self.comp_release_ms,
                makeup_db: self.comp_makeup_db,
            },
            deesser: DeesserStage {
                enabled: self.deesser_enabled,
                intensity: self.deesser_intensity,
            },
            limiter: LimiterStage {
                enabled: self.limiter_enabled,
                limit_db: self.limiter_db,
            },
            gain_db: self.gain_db,
        }
    }
}

/// The result of analysing a recording's stereo channel balance (mirror of
/// [`sundayrec_core::processing::ChannelDiagnosis`] plus the measured peaks and a
/// ready-to-apply [`EditorChannelRepair`]).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/EditorChannelDiagnosis.ts")]
#[serde(rename_all = "camelCase")]
pub struct EditorChannelDiagnosis {
    /// `balanced|imbalance|dead_left|dead_right|both_dead|mono`.
    pub code: String,
    /// Left − right level difference in dB (positive = left louder).
    pub imbalance_db: f64,
    pub peak_left_db: f64,
    pub peak_right_db: Option<f64>,
    /// The repair to apply (`mode == "none"` when nothing is recommended).
    pub recommended: EditorChannelRepair,
}

/// The one-click "auto-improve" recommendation: the channel diagnosis plus the
/// vocal-chain + mastering presets to apply for the best out-of-the-box result.
/// The renderer applies these to its export settings in a single click.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/EditorAutoProcess.ts")]
#[serde(rename_all = "camelCase")]
pub struct EditorAutoProcess {
    /// The channel-balance analysis + recommended repair.
    pub diagnosis: EditorChannelDiagnosis,
    /// Vocal-chain preset id to apply (e.g. `voice-podcast`).
    pub vocal_chain_preset: String,
    /// Mastering preset id to apply (e.g. `speech-clear`).
    pub master_preset: String,
    /// A short Norwegian summary of what was decided, for a toast/hint.
    pub summary: String,
}

/// A mastering preset for the editor's preset dropdown (mirror of
/// [`sundayrec_core::mastering::MasterPreset`]). The renderer renders `label`/
/// `description` and applies by `id`.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/EditorMasterPreset.ts")]
#[serde(rename_all = "camelCase")]
pub struct EditorMasterPreset {
    pub id: String,
    pub label: String,
    pub description: String,
    pub target_lufs: f64,
    pub target_lra: f64,
    pub true_peak_db: f64,
    pub filters: String,
}

/// The built-in mastering presets, for the editor's preset dropdown. Pure core —
/// no ffmpeg, no feature gate.
pub fn master_presets() -> Vec<EditorMasterPreset> {
    sundayrec_core::mastering::master_presets()
        .into_iter()
        .map(|p| EditorMasterPreset {
            id: p.id,
            label: p.label,
            description: p.description,
            target_lufs: p.target_lufs,
            target_lra: p.target_lra,
            true_peak_db: p.true_peak_db,
            filters: p.filters,
        })
        .collect()
}

/// The outcome of an export: where the file landed.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/EditorExportResult.ts")]
#[serde(rename_all = "camelCase")]
pub struct EditorExportResult {
    pub output_path: String,
}

/// Detect topic chapters from a transcript (Bible references + enumeration
/// points) in the transcript's language (`lang_code`: `en` → English, otherwise
/// Norwegian). Pure, offline, deterministic — no ffmpeg, so it compiles + runs
/// regardless of the `editor`/`whisper` features. Times are in the original
/// recording timeline; `editor_export` remaps them through the cut-plan.
pub fn detect_chapters(lines: &[EditorTranscriptLine], lang_code: &str) -> Vec<EditorChapter> {
    use sundayrec_core::chapters::{detect_chapters as core_detect, Language, TranscriptLine};
    let core_lines: Vec<TranscriptLine> = lines
        .iter()
        .map(|l| TranscriptLine {
            start: l.start,
            text: l.text.clone(),
        })
        .collect();
    core_detect(&core_lines, Language::from_code(lang_code))
        .into_iter()
        .map(|c| EditorChapter {
            time: c.time,
            title: c.title,
        })
        .collect()
}

/// Which sidecar a read/write/delete targets, mirroring the Electron suffixes.
/// Maps 1:1 to [`sundayrec_core::editor::Sidecar`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../src/lib/bindings/EditorSidecar.ts")]
#[serde(rename_all = "camelCase")]
pub enum EditorSidecar {
    Meta,
    CutsDraft,
    Transcript,
}

impl From<EditorSidecar> for sundayrec_core::editor::Sidecar {
    fn from(s: EditorSidecar) -> Self {
        match s {
            EditorSidecar::Meta => sundayrec_core::editor::Sidecar::Meta,
            EditorSidecar::CutsDraft => sundayrec_core::editor::Sidecar::CutsDraft,
            EditorSidecar::Transcript => sundayrec_core::editor::Sidecar::Transcript,
        }
    }
}

/// The result of probing a recording's streams for the editor — has_video /
/// has_audio so the renderer can choose the audio-only vs video editor layout.
/// Mirrors the Electron `editor-probe-streams` `MediaStreamInfo`.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/EditorStreamInfo.ts")]
#[serde(rename_all = "camelCase")]
pub struct EditorStreamInfo {
    pub has_video: bool,
    pub has_audio: bool,
}

/// The `editor-read-file` outcome: either the file is small enough to read its
/// bytes inline, or it is over the 400 MB limit and the renderer must stream it
/// via the peaks-extract path. Mirrors the `{ tooLarge, size }` shape.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/EditorFileRead.ts")]
#[serde(rename_all = "camelCase")]
pub struct EditorFileRead {
    /// Over the inline limit — the renderer should stream instead.
    pub too_large: bool,
    /// The file's size in bytes (always reported).
    pub size: u64,
    /// The bytes, present only when within the inline limit.
    pub bytes: Option<Vec<u8>>,
}

// ── Sidecar fs seam (P1 parity) — pure decisions in core, fs here ────────────────
//
// These compile in BOTH feature states (no ffmpeg) — the per-recording JSON
// sidecars are the editor's reopen-ability and must always work. The *path*
// (incl. the `..`-escape guard) is the tested core; this layer is the read /
// write / delete. INFRA-UNVERIFIED only in that the real on-disk round-trip
// is exercised by the smoke test, not the gate (the gate uses a tempdir test).

/// Split a media path into `(dir, stem)` for the core's [`sidecar_path`], using
/// the host path APIs. Returns `None` if the path has no usable parent/stem.
fn split_dir_stem(media_path: &str) -> Option<(String, String)> {
    let p = Path::new(media_path);
    let dir = p.parent()?.to_string_lossy().into_owned();
    let stem = p.file_stem()?.to_string_lossy().into_owned();
    Some((dir, stem))
}

/// Resolve the on-disk sidecar path for a media file + sidecar kind, applying
/// the core's escape guard. `None` when the path is unusable / would escape.
fn resolve_sidecar(media_path: &str, sidecar: EditorSidecar) -> Option<String> {
    let (dir, stem) = split_dir_stem(media_path)?;
    sundayrec_core::editor::sidecar_path(&dir, &stem, sidecar.into())
}

/// Read a sidecar's JSON, mirroring `editor-read-meta`/`-cuts-draft`/`-transcript`:
/// parse the file as arbitrary JSON, returning `None` when it is missing or
/// unparseable (the editor treats "no sidecar" and "corrupt sidecar" the same —
/// start fresh). The returned value is the raw `serde_json::Value` the renderer
/// shapes per sidecar.
pub fn read_sidecar(
    media_path: &str,
    sidecar: EditorSidecar,
) -> AppResult<Option<serde_json::Value>> {
    let Some(path) = resolve_sidecar(media_path, sidecar) else {
        return Ok(None);
    };
    match std::fs::read_to_string(&path) {
        Ok(raw) => Ok(serde_json::from_str(&raw).ok()),
        Err(_) => Ok(None),
    }
}

/// Write a sidecar's JSON (pretty, 2-space — matches the Electron
/// `JSON.stringify(_, null, 2)`). Returns whether the write succeeded; a bad
/// path (escape guard) or an fs error is a clean `false`, never a throw, so the
/// autosave can fail silently exactly as the Electron handlers did.
pub fn write_sidecar(media_path: &str, sidecar: EditorSidecar, value: &serde_json::Value) -> bool {
    let Some(path) = resolve_sidecar(media_path, sidecar) else {
        return false;
    };
    match serde_json::to_string_pretty(value) {
        Ok(json) => std::fs::write(&path, json).is_ok(),
        Err(_) => false,
    }
}

/// Delete a sidecar, mirroring `editor-delete-cuts-draft`/`-transcript`. A
/// missing file or a bad path is a clean `false`.
pub fn delete_sidecar(media_path: &str, sidecar: EditorSidecar) -> bool {
    match resolve_sidecar(media_path, sidecar) {
        Some(path) => std::fs::remove_file(&path).is_ok(),
        None => false,
    }
}

/// Stat a media file and decide inline-vs-stream, mirroring `editor-read-file`.
/// Reads the bytes only when within the 400 MB limit. A missing file surfaces
/// as an error (the renderer should not have asked for an absent recording).
pub fn read_file_guarded(media_path: &str) -> AppResult<EditorFileRead> {
    use sundayrec_core::editor::{inline_decision, InlineDecision};
    let meta = std::fs::metadata(media_path)
        .map_err(|e| AppError::Validation(format!("file_not_found: {e}")))?;
    let size = meta.len();
    match inline_decision(size) {
        InlineDecision::TooLarge => Ok(EditorFileRead {
            too_large: true,
            size,
            bytes: None,
        }),
        InlineDecision::Inline => {
            let bytes = std::fs::read(media_path)
                .map_err(|e| AppError::Validation(format!("read_failed: {e}")))?;
            Ok(EditorFileRead {
                too_large: false,
                size,
                bytes: Some(bytes),
            })
        }
    }
}

/// Sweep `folders` for crashed-edit `.__editor_tmp`/`.__editor_bak` leftovers,
/// returning how many were deleted. Mirrors `cleanupEditorTempFiles`: the core
/// de-dups + the predicate decides what to unlink; this layer does the readdir/
/// unlink (best-effort, never throws). Non-existent dirs are skipped.
pub fn cleanup_temp_files(folders: &[String]) -> usize {
    use sundayrec_core::editor::{dedupe_cleanup_dirs, is_editor_temp_name};
    let dirs = dedupe_cleanup_dirs(folders, |s| {
        std::fs::canonicalize(s)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| s.to_string())
    });
    let mut removed = 0usize;
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_editor_temp_name(&name) && std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

// ── Mastering preview / apply DTOs + engine (P1 parity) ──────────────────────────

/// A windowed mastering-preview request — render `[startSec, startSec+durationSec]`
/// of `inputPath` through the preset's single-pass chain to a temp mp3 the
/// renderer can `<audio>`-play A/B against the original. Mirrors `master-preview`.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(
    export,
    export_to = "../../src/lib/bindings/EditorMasterPreviewRequest.ts"
)]
#[serde(rename_all = "camelCase")]
pub struct EditorMasterPreviewRequest {
    pub input_path: String,
    pub preset_id: String,
    pub start_sec: f64,
    pub duration_sec: f64,
}

/// Where the rendered preview mp3 landed (a temp file the renderer plays).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(
    export,
    export_to = "../../src/lib/bindings/EditorMasterPreviewResult.ts"
)]
#[serde(rename_all = "camelCase")]
pub struct EditorMasterPreviewResult {
    pub preview_path: String,
}

/// A full two-pass mastering *apply* request — measure (pass 1, here re-measured
/// from the preset) then apply (pass 2) `inputPath` to `outputPath`, tracked by
/// `jobId` so the UI can [`master_cancel`] it. Mirrors `master-apply`.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(
    export,
    export_to = "../../src/lib/bindings/EditorMasterApplyRequest.ts"
)]
#[serde(rename_all = "camelCase")]
pub struct EditorMasterApplyRequest {
    pub input_path: String,
    pub output_path: String,
    pub preset_id: String,
    /// Client-supplied job id for cancellation; the apply is rejected if it is
    /// already in flight (duplicate-id guard, via the core JobRegistry).
    pub job_id: String,
    /// Output bitrate (kbps) for lossy formats; `None` uses the codec default.
    pub bitrate: Option<u32>,
}

/// Where the mastered file landed.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(
    export,
    export_to = "../../src/lib/bindings/EditorMasterApplyResult.ts"
)]
#[serde(rename_all = "camelCase")]
pub struct EditorMasterApplyResult {
    pub output_path: String,
}

/// A mastering-apply progress tick, emitted on the `editor-master-progress`
/// event. Mirrors the Electron `master-progress` `{ currentSec, totalSec }`.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/EditorMasterProgress.ts")]
#[serde(rename_all = "camelCase")]
pub struct EditorMasterProgress {
    pub job_id: String,
    pub current_sec: f64,
    pub total_sec: f64,
}

/// The mastering-apply engine: the pure [`JobRegistry`](sundayrec_core::mastering::JobRegistry)
/// bookkeeping (which ids are legitimately live) plus the real abort handles the
/// seam kills on cancel. At most a handful of jobs run; the registry answers the
/// same booleans the Electron `Map.has/.delete` did. The `children` field is only
/// used feature-on (the ffmpeg handles) but the struct compiles either way — the
/// same idiom as `StreamEngine`.
pub struct MasterEngine {
    /// Pure legitimacy bookkeeping — register/cancel/complete.
    registry: std::sync::Mutex<sundayrec_core::mastering::JobRegistry>,
    /// Real in-flight ffmpeg children keyed by job id (feature-on only).
    #[cfg_attr(not(feature = "editor"), allow(dead_code))]
    children: std::sync::Mutex<std::collections::HashMap<String, tokio::process::Child>>,
}

impl Default for MasterEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl MasterEngine {
    /// A fresh engine with no jobs in flight.
    pub fn new() -> Self {
        Self {
            registry: std::sync::Mutex::new(sundayrec_core::mastering::JobRegistry::new()),
            children: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }
}

// ── Public entry points ─────────────────────────────────────────────────────────
//
// Each compiles in both feature states. OFF → a clear `feature_disabled` error.
// ON → the HARDWARE-UNVERIFIED ffmpeg/ffprobe glue below.

#[cfg(not(feature = "editor"))]
fn disabled<T>(verb: &str) -> AppResult<T> {
    Err(crate::error::AppError::Validation(format!(
        "feature_disabled: editor.{verb} requires a build with `--features editor`"
    )))
}

/// Probe just has_video/has_audio for the editor's audio-vs-video layout choice.
#[cfg(not(feature = "editor"))]
pub async fn probe_streams(_input_path: &str) -> AppResult<EditorStreamInfo> {
    disabled("probeStreams")
}

/// Render a windowed single-pass mastering preview to a temp mp3.
#[cfg(not(feature = "editor"))]
pub async fn master_preview(
    _req: &EditorMasterPreviewRequest,
) -> AppResult<EditorMasterPreviewResult> {
    disabled("masterPreview")
}

/// Run the full two-pass mastering apply, tracked by job id.
#[cfg(not(feature = "editor"))]
pub async fn master_apply<F>(
    _engine: &MasterEngine,
    _req: &EditorMasterApplyRequest,
    _on_progress: F,
) -> AppResult<EditorMasterApplyResult>
where
    F: Fn(f64, f64),
{
    disabled("masterApply")
}

/// Abort an in-flight mastering apply by job id. Returns whether it was live.
/// Compiles in both states — the registry bookkeeping is pure, so even the
/// default build answers "nothing to cancel" rather than erroring.
pub async fn master_cancel(engine: &MasterEngine, job_id: &str) -> AppResult<bool> {
    // Drop the legitimacy record first (returns whether it was live).
    let was_live = engine
        .registry
        .lock()
        .expect("master registry mutex")
        .cancel(job_id);
    // Then kill the real child if we are holding one (feature-on).
    #[cfg(feature = "editor")]
    {
        let child = engine
            .children
            .lock()
            .expect("master children mutex")
            .remove(job_id);
        if let Some(mut c) = child {
            let _ = c.kill().await;
        }
    }
    Ok(was_live)
}

/// Probe a recording's duration/streams for the editor's first paint.
#[cfg(not(feature = "editor"))]
pub async fn load_recording(_input_path: &str) -> AppResult<EditorMediaInfo> {
    disabled("load")
}

/// Decode the audio to a renderer waveform (peaks + sample rate).
#[cfg(not(feature = "editor"))]
pub async fn peaks(_input_path: &str) -> AppResult<EditorPeaks> {
    disabled("peaks")
}

/// Content-detect segments (silence/speech/music + promoted sermon block).
#[cfg(not(feature = "editor"))]
pub async fn segments(_input_path: &str) -> AppResult<Vec<EditorSegment>> {
    disabled("segments")
}

/// Analyse stereo channel balance (needs ffmpeg astats).
#[cfg(not(feature = "editor"))]
pub async fn diagnose_channels(_input_path: &str) -> AppResult<EditorChannelDiagnosis> {
    disabled("diagnoseChannels")
}

/// Measure the recording's loudness against a mastering preset (pass 1 only).
#[cfg(not(feature = "editor"))]
pub async fn mastering_analyze(_input_path: &str, _preset_id: &str) -> AppResult<EditorLoudness> {
    disabled("masteringAnalyze")
}

/// Render the cut-plan (+ optional mastering gain) to the requested format.
#[cfg(not(feature = "editor"))]
pub async fn export(_req: &EditorExportRequest) -> AppResult<EditorExportResult> {
    disabled("export")
}

/// Extract a single video frame at `sec` as a base64 JPEG for the video preview.
#[cfg(not(feature = "editor"))]
pub async fn extract_frame(_input_path: &str, _sec: f64) -> AppResult<String> {
    disabled("extractFrame")
}

// ── HARDWARE-UNVERIFIED implementations (feature on) ─────────────────────────────

/// Probe a recording: spawn ffprobe with the core's argv, parse its output with
/// the core. HARDWARE-UNVERIFIED — needs real media.
#[cfg(feature = "editor")]
pub async fn load_recording(input_path: &str) -> AppResult<EditorMediaInfo> {
    use sundayrec_core::editor::{ffprobe_load_args, parse_probe_output};

    if !std::path::Path::new(input_path).exists() {
        return Err(AppError::Validation("file_not_found".into()));
    }
    let args = ffprobe_load_args(input_path);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    // ffprobe is a one-shot probe → `std::process::Command::output()` is enough
    // (no streaming). We resolve the sidecar through the shared media module.
    let output = tokio::process::Command::new(crate::media::ffmpeg::ffprobe_path())
        .args(&arg_refs)
        .output()
        .await
        .map_err(|e| AppError::Recording(format!("ffprobe spawn: {e}")))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let p = parse_probe_output(&stdout);
    if !p.has_audio && !p.has_video {
        return Err(AppError::Recording(
            "ffprobe found no audio or video stream".into(),
        ));
    }
    Ok(EditorMediaInfo {
        duration_sec: p.duration_sec,
        has_video: p.has_video,
        has_audio: p.has_audio,
        channels: p.channels,
        sample_fmt: p.sample_fmt,
    })
}

/// Decode audio to 8 kHz mono WAV via the sidecar, read the samples, and
/// down-sample to **100 peaks/second** — the SAME rate the renderer's
/// `computePeaks` produces and the waveform indexes against (`pi = sec*100`). A
/// fixed bucket count (the old 2000) would misalign the video waveform with the
/// timeline; 100/s keeps it accurate at any duration. HARDWARE-UNVERIFIED.
#[cfg(feature = "editor")]
pub async fn peaks(input_path: &str) -> AppResult<EditorPeaks> {
    use sundayrec_core::editor::{downsample_peaks, peaks_extract_args};

    if !std::path::Path::new(input_path).exists() {
        return Err(AppError::Validation("file_not_found".into()));
    }
    let tmp = tempdir()?;
    let wav_path = tmp.join("peaks.wav");
    let wav_str = wav_path.to_string_lossy().into_owned();
    let args = peaks_extract_args(input_path, &wav_str);
    run_ffmpeg(&args).await?;
    if !wav_path.exists() {
        return Err(AppError::Recording("peaks extract produced no WAV".into()));
    }
    let samples = read_wav_s16_f32(&wav_path)?;
    // 8 kHz / 100 peaks-per-second = 80 samples per peak.
    let buckets = (samples.len() / 80).max(1);
    let peaks = downsample_peaks(&samples, buckets);
    Ok(EditorPeaks {
        peaks,
        sample_rate: 8000,
    })
}

/// Decode to 16 kHz mono PCM, classify + group with the core, promote the
/// sermon block, and map to UI segments. HARDWARE-UNVERIFIED.
#[cfg(feature = "editor")]
pub async fn segments(input_path: &str) -> AppResult<Vec<EditorSegment>> {
    use sundayrec_core::audio_analysis::{
        classify_and_group, detect_segments, extract_features, FRAME_MS, SAMPLE_RATE,
    };
    use sundayrec_core::editor::analysis_decode_args;

    if !std::path::Path::new(input_path).exists() {
        return Err(AppError::Validation("file_not_found".into()));
    }
    let args = analysis_decode_args(input_path);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let child = crate::media::ffmpeg::spawn_ffmpeg(&arg_refs).await?;
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| AppError::Recording(format!("analysis decode wait: {e}")))?;
    if !out.status.success() {
        return Err(AppError::Recording(
            "analysis decode failed (ffmpeg non-zero)".into(),
        ));
    }
    // Raw s16le mono → f32 normalised samples for the classifier.
    let pcm: Vec<f32> = out
        .stdout
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect();
    let frames = extract_features(&pcm, SAMPLE_RATE, FRAME_MS);
    let grouped = classify_and_group(&frames);
    let detected = detect_segments(&grouped);
    Ok(detected
        .into_iter()
        .map(|d| EditorSegment {
            start: d.start,
            end: d.end,
            duration: d.duration,
            label: d.label,
            kind: d.kind,
        })
        .collect())
}

/// Map a core [`ChannelRepair`](sundayrec_core::processing::ChannelRepair) to the
/// renderer DTO.
#[cfg(feature = "editor")]
fn core_repair_to_dto(r: sundayrec_core::processing::ChannelRepair) -> EditorChannelRepair {
    use sundayrec_core::processing::ChannelRepair as R;
    let (mode, left_db, right_db) = match r {
        R::None => ("none", 0.0, 0.0),
        R::SwapLr => ("swapLr", 0.0, 0.0),
        R::DuplicateLeft => ("duplicateLeft", 0.0, 0.0),
        R::DuplicateRight => ("duplicateRight", 0.0, 0.0),
        R::MonoMix => ("monoMix", 0.0, 0.0),
        R::GainDb { left_db, right_db } => ("gainDb", left_db, right_db),
    };
    EditorChannelRepair {
        mode: mode.to_string(),
        left_db,
        right_db,
    }
}

/// Run `astats` over the whole file to a null sink and return ffmpeg's stderr
/// (the per-channel + overall summary). Shared by channel diagnosis and the
/// one-click auto-process so a single pass yields both the levels and the noise
/// floor. HARDWARE-UNVERIFIED.
#[cfg(feature = "editor")]
async fn run_astats_stderr(input_path: &str) -> AppResult<String> {
    if !std::path::Path::new(input_path).exists() {
        return Err(AppError::Validation("file_not_found".into()));
    }
    let args = [
        "-nostdin",
        "-hide_banner",
        "-i",
        input_path,
        "-af",
        "astats=metadata=0",
        "-f",
        "null",
        "-",
    ];
    let child = crate::media::ffmpeg::spawn_ffmpeg(&args).await?;
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| AppError::Recording(format!("astats wait: {e}")))?;
    Ok(String::from_utf8_lossy(&out.stderr).into_owned())
}

/// Build the channel diagnosis from a parsed astats summary.
#[cfg(feature = "editor")]
fn diagnosis_from_stderr(stderr: &str) -> AppResult<EditorChannelDiagnosis> {
    use sundayrec_core::levels::parse_levels;
    use sundayrec_core::processing::{diagnose_channels as core_diagnose, ChannelLevelsDb};

    let levels = parse_levels(stderr)
        .ok_or_else(|| AppError::Recording("astats produced no channel levels".into()))?;
    let pl = levels.peak_db_left;
    Ok(match levels.peak_db_right {
        // Mono source — nothing to balance.
        None => EditorChannelDiagnosis {
            code: "mono".into(),
            imbalance_db: 0.0,
            peak_left_db: pl,
            peak_right_db: None,
            recommended: core_repair_to_dto(sundayrec_core::processing::ChannelRepair::None),
        },
        Some(pr) => {
            let d = core_diagnose(ChannelLevelsDb {
                peak_left_db: pl,
                peak_right_db: pr,
                rms_left_db: None,
                rms_right_db: None,
            });
            EditorChannelDiagnosis {
                code: d.code.to_string(),
                imbalance_db: d.imbalance_db,
                peak_left_db: pl,
                peak_right_db: Some(pr),
                recommended: core_repair_to_dto(d.recommended),
            }
        }
    })
}

/// Analyse a recording's stereo channel balance: run `astats` over the whole
/// file, parse the per-channel peaks, and ask the core for a recommended repair
/// (swap / duplicate-good-channel / per-channel makeup). HARDWARE-UNVERIFIED.
#[cfg(feature = "editor")]
pub async fn diagnose_channels(input_path: &str) -> AppResult<EditorChannelDiagnosis> {
    let stderr = run_astats_stderr(input_path).await?;
    diagnosis_from_stderr(&stderr)
}

/// One-click "auto-improve": ONE astats pass yields both the channel diagnosis
/// AND the noise floor, so we recommend the full best-result setup — channel
/// repair + a NOISE-AWARE vocal chain (the heavier `voice-noisy-room` when the
/// floor is high, else `voice-podcast`) + clear-speech mastering — with a
/// Norwegian summary. The renderer applies the result in one click.
#[cfg(feature = "editor")]
pub async fn auto_process(input_path: &str) -> AppResult<EditorAutoProcess> {
    let stderr = run_astats_stderr(input_path).await?;
    let diagnosis = diagnosis_from_stderr(&stderr)?;
    let noise_floor = sundayrec_core::levels::parse_noise_floor_db(&stderr);
    let preset = sundayrec_core::processing::recommend_vocal_preset(noise_floor);

    let repair_note = match diagnosis.code.as_str() {
        "dead_left" => "høyre kanal kopieres til begge (venstre er stille — sjekk kabel)",
        "dead_right" => "venstre kanal kopieres til begge (høyre er stille — sjekk kabel)",
        "imbalance" => "kanalene balanseres (ulik styrke)",
        "both_dead" => "begge kanaler er svært svake — sjekk tilkobling",
        "mono" => "mono-opptak",
        _ => "kanalbalanse OK",
    };
    let chain_note = if preset == "voice-noisy-room" {
        "støyete-rom-kjede (sterkere støyreduksjon)"
    } else {
        "podkast-stemme"
    };
    let summary =
        format!("Automatisk lydforbedring: {repair_note}, {chain_note} + tydelig mastering.");
    Ok(EditorAutoProcess {
        diagnosis,
        vocal_chain_preset: preset.to_string(),
        master_preset: "speech-clear".into(),
        summary,
    })
}

/// Auto-process needs ffmpeg (astats) — disabled in the default build.
#[cfg(not(feature = "editor"))]
pub async fn auto_process(_input_path: &str) -> AppResult<EditorAutoProcess> {
    disabled("autoProcess")
}

/// Measure loudness: run the preset's pass-1 measure chain to a null sink and
/// parse the loudnorm JSON with the core. HARDWARE-UNVERIFIED.
#[cfg(feature = "editor")]
pub async fn mastering_analyze(input_path: &str, preset_id: &str) -> AppResult<EditorLoudness> {
    use sundayrec_core::mastering::get_preset_by_id;

    if !std::path::Path::new(input_path).exists() {
        return Err(AppError::Validation("file_not_found".into()));
    }
    let preset = get_preset_by_id(preset_id)
        .ok_or_else(|| AppError::Validation(format!("unknown_preset: {preset_id}")))?;
    let m = measure_loudness(input_path, &preset).await?;
    Ok(EditorLoudness {
        input_i: m.input_i,
        input_lra: m.input_lra,
        input_tp: m.input_tp,
        target_lufs: preset.target_lufs,
    })
}

/// Probe just has_video/has_audio — reuses the full load probe and projects the
/// two booleans the editor's layout choice needs. HARDWARE-UNVERIFIED.
#[cfg(feature = "editor")]
pub async fn probe_streams(input_path: &str) -> AppResult<EditorStreamInfo> {
    let info = load_recording(input_path).await?;
    Ok(EditorStreamInfo {
        has_video: info.has_video,
        has_audio: info.has_audio,
    })
}

/// Render a windowed single-pass mastering preview to a temp mp3, with the
/// core's argv (`-ss`/`-t` before `-i`) + clamped start/duration. The renderer
/// A/B-plays the result against the original. HARDWARE-UNVERIFIED.
#[cfg(feature = "editor")]
pub async fn master_preview(
    req: &EditorMasterPreviewRequest,
) -> AppResult<EditorMasterPreviewResult> {
    use sundayrec_core::mastering::{
        clamp_preview_duration, clamp_preview_start, get_preset_by_id, preview_args,
        PREVIEW_TEMP_PREFIX,
    };

    if !std::path::Path::new(&req.input_path).exists() {
        return Err(AppError::Validation("file_not_found".into()));
    }
    let preset = get_preset_by_id(&req.preset_id)
        .ok_or_else(|| AppError::Validation(format!("unknown_preset: {}", req.preset_id)))?;
    let start = clamp_preview_start(req.start_sec);
    let dur = clamp_preview_duration(req.duration_sec);
    let out_path = std::env::temp_dir().join(format!(
        "{PREVIEW_TEMP_PREFIX}{}.mp3",
        uuid::Uuid::now_v7().simple()
    ));
    let out_str = out_path.to_string_lossy().into_owned();
    let args = preview_args(&req.input_path, &preset, start, dur, &out_str);
    run_ffmpeg(&args).await?;
    if !out_path.exists() {
        return Err(AppError::Recording(
            "master preview produced no file".into(),
        ));
    }
    Ok(EditorMasterPreviewResult {
        preview_path: out_str,
    })
}

/// Run the full two-pass mastering apply: measure (pass 1) then apply (pass 2)
/// with the measured values, tracked by job id so the UI can cancel mid-render.
/// The preset chain / loudnorm filters / codec args are the core's tested
/// decisions; the seam spawns ffmpeg, streams `-progress`, and parses the
/// current-second with the core. HARDWARE-UNVERIFIED.
#[cfg(feature = "editor")]
pub async fn master_apply<F>(
    engine: &MasterEngine,
    req: &EditorMasterApplyRequest,
    on_progress: F,
) -> AppResult<EditorMasterApplyResult>
where
    F: Fn(f64, f64),
{
    use sundayrec_core::mastering::get_preset_by_id;

    if !std::path::Path::new(&req.input_path).exists() {
        return Err(AppError::Validation("file_not_found".into()));
    }
    if req.output_path.is_empty() {
        return Err(AppError::Validation("invalid_output_path".into()));
    }
    let preset = get_preset_by_id(&req.preset_id)
        .ok_or_else(|| AppError::Validation(format!("unknown_preset: {}", req.preset_id)))?;

    // Reject a duplicate job id before doing any work (mirrors the Map guard).
    if !engine
        .registry
        .lock()
        .expect("master registry mutex")
        .register(&req.job_id)
    {
        return Err(AppError::Validation("job_already_running".into()));
    }

    // Wrap the work so the registry record + child handle are always dropped.
    let result = master_apply_inner(engine, req, &preset, &on_progress).await;
    engine
        .registry
        .lock()
        .expect("master registry mutex")
        .complete(&req.job_id);
    engine
        .children
        .lock()
        .expect("master children mutex")
        .remove(&req.job_id);
    result
}

/// The measure→apply work for [`master_apply`], split out so the registry record
/// is dropped on every exit. HARDWARE-UNVERIFIED.
#[cfg(feature = "editor")]
async fn master_apply_inner<F>(
    engine: &MasterEngine,
    req: &EditorMasterApplyRequest,
    preset: &sundayrec_core::mastering::MasterPreset,
    on_progress: &F,
) -> AppResult<EditorMasterApplyResult>
where
    F: Fn(f64, f64),
{
    use sundayrec_core::mastering::{
        append_dither_for_ext, build_apply_pass_filters, master_codec_args, parse_progress_time,
    };
    use tokio::io::AsyncReadExt;

    // 1. Measure (pass 1) for the linear-mode apply chain.
    let measured = measure_loudness(&req.input_path, preset).await?;

    // 2. Apply (pass 2): the preset+measured loudnorm, codec from the output ext.
    let ext = std::path::Path::new(&req.output_path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "mp3".into());
    // Dither the float→16-bit step for a WAV master (no-op otherwise).
    let filters = append_dither_for_ext(build_apply_pass_filters(preset, &measured), &ext);
    let mut args: Vec<String> = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-i".into(),
        req.input_path.clone(),
        "-af".into(),
        filters,
    ];
    args.extend(master_codec_args(&ext, req.bitrate));
    args.extend([
        "-progress".into(),
        "pipe:1".into(),
        "-y".into(),
        req.output_path.clone(),
    ]);

    // Spawn with stdout piped for -progress; store the child for cancellation.
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut child = tokio::process::Command::new(crate::media::ffmpeg::ffmpeg_path())
        .args(&arg_refs)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::Recording(format!("mastering spawn: {e}")))?;

    let mut stdout = child.stdout.take();
    // Register the live child so master_cancel can kill it.
    engine
        .children
        .lock()
        .expect("master children mutex")
        .insert(req.job_id.clone(), child);

    // Stream -progress; total duration is unknown without a probe, so we report
    // current with total 0 (the renderer shows an indeterminate bar) — matches
    // the Electron behaviour when the Duration line hasn't been parsed yet.
    if let Some(mut out) = stdout.take() {
        let mut buf = String::new();
        let mut chunk = [0u8; 4096];
        loop {
            match out.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => {
                    buf.push_str(&String::from_utf8_lossy(&chunk[..n]));
                    if let Some(cur) = parse_progress_time(&buf) {
                        on_progress(cur, 0.0);
                    }
                    // keep the tail so a split line still parses next read
                    if buf.len() > 4096 {
                        buf = buf[buf.len() - 4096..].to_string();
                    }
                }
                Err(_) => break,
            }
        }
    }

    // Reclaim the child to await its exit (it may already be gone if cancelled).
    let child = engine
        .children
        .lock()
        .expect("master children mutex")
        .remove(&req.job_id);
    let status = match child {
        Some(mut c) => c
            .wait()
            .await
            .map_err(|e| AppError::Recording(format!("mastering wait: {e}")))?,
        None => return Err(AppError::Recording("cancelled".into())),
    };
    if !status.success() {
        return Err(AppError::Recording("apply_failed (ffmpeg non-zero)".into()));
    }
    if !std::path::Path::new(&req.output_path).exists() {
        return Err(AppError::Recording("mastering produced no output".into()));
    }
    Ok(EditorMasterApplyResult {
        output_path: req.output_path.clone(),
    })
}

/// Render the cut-plan + optional mastering gain to the requested format. The
/// keep-segments, filter graph, codec args, output path, and timeout are ALL the
/// core's tested decisions; the seam only spawns ffmpeg and picks the collision-
/// free path on disk. HARDWARE-UNVERIFIED.
#[cfg(feature = "editor")]
pub async fn export(req: &EditorExportRequest) -> AppResult<EditorExportResult> {
    use std::path::Path;
    use sundayrec_core::chapters::remap_chapters_to_keeps;
    use sundayrec_core::editor::{
        audio_export_filter_complex, audio_simple_af, build_keeps, codec_args, collision_free_path,
        ffmetadata, is_simple_audio_export, metadata_args, video_filter_complex,
        Chapter as CoreChapter, CutRegion, RecordingMetadata,
    };
    use sundayrec_core::mastering::{build_apply_pass_filters, get_preset_by_id};

    if !Path::new(&req.input_path).exists() {
        return Err(AppError::Validation("file_not_found".into()));
    }
    if !(req.duration.is_finite() && req.duration > 0.0) {
        return Err(AppError::Validation("invalid_duration".into()));
    }
    // Accept any format the core knows how to encode (broad, VLC-like) — audio
    // formats via `codec_args`, video containers (mp4/mov/mkv/m4v) via the video
    // path. The bundled ffmpeg has the encoders; only this gate used to be narrow.
    if !sundayrec_core::editor::is_supported_export_format(&req.format) {
        return Err(AppError::Validation(format!(
            "invalid_format: {}",
            req.format
        )));
    }
    let fmt = req.format.as_str();
    let is_video = sundayrec_core::editor::is_video_container(fmt);

    // 1. Core plans the keep-segments from the cuts.
    let cuts: Vec<CutRegion> = req
        .cut_regions
        .iter()
        .map(|c| CutRegion {
            start: c.start,
            end: c.end,
        })
        .collect();
    let keeps = build_keeps(&cuts, req.duration);
    if keeps.is_empty() {
        return Err(AppError::Validation("no_audio_remaining".into()));
    }

    // 2. Optional mastering: measure (pass 1) → apply chain (pass 2 filters).
    //    When no preset, the processing chain is empty (plain trim).
    let mut proc_filters: Vec<String> = match &req.master_preset {
        Some(id) => {
            let preset = get_preset_by_id(id)
                .ok_or_else(|| AppError::Validation(format!("unknown_preset: {id}")))?;
            let measured = measure_loudness(&req.input_path, &preset).await?;
            // The apply chain is the preset filters + a measured-value loudnorm.
            vec![build_apply_pass_filters(&preset, &measured)]
        }
        None => Vec::new(),
    };
    // Peak-normalization gain (the editor's "Normalize" button) → a `volume`
    // filter ahead of any mastering chain. The waveform/preview already reflect
    // this gain; this makes the rendered file match.
    if let Some(g) = req.gain_db {
        if g.is_finite() && g.abs() > f64::EPSILON {
            proc_filters.insert(0, format!("volume={g:.2}dB"));
        }
    }
    // Vocal chain (channel repair + cleanup/sweetening) runs BEFORE the mastering
    // loudnorm: shape the tone/dynamics first, set delivery loudness last. A full
    // `processing` object wins; otherwise resolve the one-click preset id.
    let mut chain = req.processing.as_ref().map(|p| p.to_core()).or_else(|| {
        req.vocal_chain_preset
            .as_deref()
            .and_then(sundayrec_core::processing::vocal_chain_preset_by_id)
            .map(|p| p.chain)
    });
    // A top-level channel repair overrides the chain's repair, and applies on its
    // own (in an otherwise-empty chain) when no vocal processing was requested.
    if let Some(cr) = req.channel_repair.as_ref().map(|r| r.to_core()) {
        match &mut chain {
            Some(c) => c.channel_repair = cr,
            None => {
                let mut empty = sundayrec_core::processing::VocalChain::default();
                empty.highpass.enabled = false;
                empty.compressor.enabled = false;
                empty.channel_repair = cr;
                chain = Some(empty);
            }
        }
    }
    if let Some(chain) = chain {
        let mut parts = chain.build_filters();
        if !parts.is_empty() {
            parts.append(&mut proc_filters);
            proc_filters = parts;
        }
    }

    // 3. Core picks the collision-free output path.
    let base = Path::new(&req.input_path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "redigert".into());
    let out_path = collision_free_path(&req.output_folder, &format!("{base}_redigert"), fmt, |c| {
        Path::new(c).exists()
    });

    // 4. Intro/outro jingles (audio formats only — they wrap the audio track,
    //    so the mp4 video path ignores them). The intro is ffmpeg input 0, the
    //    main file the next input, the outro the one after that — the order the
    //    core's filter graph expects.
    let intro = req
        .intro_path
        .as_deref()
        .filter(|p| !is_video && Path::new(p).exists());
    let outro = req
        .outro_path
        .as_deref()
        .filter(|p| !is_video && Path::new(p).exists());
    let has_intro = intro.is_some();
    let has_outro = outro.is_some();
    let main_input_idx = if has_intro { 1 } else { 0 };

    // 4b. Topic chapters → FFMETADATA. The detector timed them on the ORIGINAL
    //     recording; remap them through the cut-plan onto the exported timeline
    //     and drop any inside a cut. Title/speaker/description ride along as tags.
    //     NOTE: an intro jingle shifts the audio later; chapter times here are
    //     relative to the main audio (no intro offset) — fine for the common
    //     no-jingle podcast export, slightly early if a long intro is prepended.
    let kept_duration: f64 = keeps.iter().map(|k| k.end - k.start).sum();
    let core_chapters: Vec<CoreChapter> = req
        .chapters
        .iter()
        .map(|c| CoreChapter {
            time: c.time,
            title: c.title.clone(),
        })
        .collect();
    let meta = RecordingMetadata {
        title: req.title.clone(),
        speaker: req.speaker.clone(),
        description: req.description.clone(),
        chapters: remap_chapters_to_keeps(&core_chapters, &keeps),
    };
    // Write the `;FFMETADATA1` sidecar to a temp file ffmpeg reads as an extra
    // input (`-map_metadata <idx>`). `None` when there are no chapters.
    let meta_path: Option<String> = match ffmetadata(&meta, kept_duration) {
        Some(text) => {
            let p = std::env::temp_dir().join(format!("{base}_chapters.ffmeta"));
            std::fs::write(&p, text)
                .map_err(|e| AppError::Recording(format!("write chapters metadata: {e}")))?;
            Some(p.to_string_lossy().into_owned())
        }
        None => None,
    };
    // The metadata file is appended after all real inputs (intro/main/outro).
    let meta_input_idx = 1 + has_intro as usize + has_outro as usize;

    // 5. Build the ffmpeg args — all graph/codec decisions are the core's.
    let mut args: Vec<String> = vec!["-nostdin".into(), "-hide_banner".into()];
    if let Some(p) = intro {
        args.extend(["-i".into(), p.to_string()]);
    }
    args.extend(["-i".into(), req.input_path.clone()]);
    if let Some(p) = outro {
        args.extend(["-i".into(), p.to_string()]);
    }
    if let Some(p) = &meta_path {
        args.extend(["-i".into(), p.clone()]);
    }
    if is_video {
        let (fc, v_out, a_out) = video_filter_complex(0, &keeps, &proc_filters);
        args.extend(["-filter_complex".into(), fc]);
        args.extend(["-map".into(), v_out, "-map".into(), a_out]);
        // Codec: H.264 (default) or H.265 when requested, container-aware flags.
        let codec = match req.video_codec.as_deref() {
            Some("h265") | Some("hevc") => sundayrec_core::editor::VideoCodec::H265,
            _ => sundayrec_core::editor::VideoCodec::H264,
        };
        args.extend(sundayrec_core::editor::video_codec_args(fmt, codec, None));
    } else if is_simple_audio_export(&keeps, &proc_filters, has_intro, has_outro) {
        args.extend(["-af".into(), audio_simple_af(&keeps[0])]);
        args.extend(codec_args(fmt, req.bitrate, req.bit_depth));
    } else {
        let (fc, map) = audio_export_filter_complex(
            &keeps,
            main_input_idx,
            &proc_filters,
            has_intro,
            has_outro,
        );
        args.extend(["-filter_complex".into(), fc]);
        args.extend(["-map".into(), map]);
        args.extend(codec_args(fmt, req.bitrate, req.bit_depth));
    }
    // Pull chapters from the metadata input; title/speaker/description as tags.
    if meta_path.is_some() {
        args.extend(["-map_metadata".into(), meta_input_idx.to_string()]);
    }
    args.extend(metadata_args(&meta));
    args.extend(["-y".into(), out_path.clone()]);

    let result = run_ffmpeg(&args).await;
    if let Some(p) = &meta_path {
        let _ = std::fs::remove_file(p); // best-effort temp cleanup
    }
    result?;
    if !Path::new(&out_path).exists() {
        return Err(AppError::Recording("export produced no output file".into()));
    }
    Ok(EditorExportResult {
        output_path: out_path,
    })
}

/// Extract a single video frame at `sec` seconds, scaled to 480px wide, and
/// return it as a base64-encoded JPEG (the renderer drops it into
/// `data:image/jpeg;base64,…`). The argv (`-ss` before `-i`, `scale=480:-2`,
/// one MJPEG frame to `pipe:1`) is the core's tested
/// [`frame_extract_args`](sundayrec_core::editor::frame_extract_args) decision;
/// the seam only spawns ffmpeg, collects stdout, and base64-encodes it.
/// HARDWARE-UNVERIFIED — needs real video media.
#[cfg(feature = "editor")]
pub async fn extract_frame(input_path: &str, sec: f64) -> AppResult<String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use sundayrec_core::editor::frame_extract_args;

    if !std::path::Path::new(input_path).exists() {
        return Err(AppError::Validation("file_not_found".into()));
    }
    let args = frame_extract_args(input_path, sec);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let child = crate::media::ffmpeg::spawn_ffmpeg(&arg_refs).await?;
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| AppError::Recording(format!("frame extract wait: {e}")))?;
    if !out.status.success() || out.stdout.is_empty() {
        return Err(AppError::Recording(
            "frame extract produced no image (no video stream or seek past end?)".into(),
        ));
    }
    Ok(STANDARD.encode(&out.stdout))
}

// ── seam helpers (feature on) ────────────────────────────────────────────────────

/// Measure loudness against `preset` (pass 1), returning the parsed measurement
/// the apply chain feeds back. Shared by [`mastering_analyze`] + [`export`].
#[cfg(feature = "editor")]
async fn measure_loudness(
    input_path: &str,
    preset: &sundayrec_core::mastering::MasterPreset,
) -> AppResult<sundayrec_core::mastering::LoudnessMeasurement> {
    use sundayrec_core::mastering::{build_measure_pass_filters, parse_loudnorm_json};

    let filters = build_measure_pass_filters(preset);
    let args = vec![
        "-nostdin".to_string(),
        "-hide_banner".to_string(),
        "-i".to_string(),
        input_path.to_string(),
        "-af".to_string(),
        filters,
        "-f".to_string(),
        "null".to_string(),
        "-".to_string(),
    ];
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let child = crate::media::ffmpeg::spawn_ffmpeg(&arg_refs).await?;
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| AppError::Recording(format!("loudness measure wait: {e}")))?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    parse_loudnorm_json(&stderr)
        .ok_or_else(|| AppError::Recording("could not parse loudnorm measurement".into()))
}

/// Spawn ffmpeg with `args`, wait for it, and map a non-zero exit to an error
/// carrying the tail of stderr (what the Electron `spawnFfmpeg` did).
#[cfg(feature = "editor")]
async fn run_ffmpeg(args: &[String]) -> AppResult<()> {
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let child = crate::media::ffmpeg::spawn_ffmpeg(&arg_refs).await?;
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| AppError::Recording(format!("ffmpeg wait: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr.chars().rev().take(500).collect::<String>();
        let tail: String = tail.chars().rev().collect();
        return Err(AppError::Recording(format!("ffmpeg failed: {tail}")));
    }
    Ok(())
}

/// A throwaway temp dir under the OS temp root for the peaks WAV. Returned as a
/// `PathBuf`; the file is cleaned up by the OS (small, short-lived). We avoid the
/// `tempfile` dep here (it's `whisper`-only) since one WAV doesn't warrant it.
#[cfg(feature = "editor")]
fn tempdir() -> AppResult<std::path::PathBuf> {
    let base = std::env::temp_dir().join(format!(
        "sundayrec-editor-{}",
        uuid::Uuid::now_v7().simple()
    ));
    std::fs::create_dir_all(&base)?;
    Ok(base)
}

/// Read a 16-bit PCM WAV into normalised f32 samples. Minimal RIFF parser — the
/// peaks-extract step writes exactly this format. Mirrors the whisper seam's
/// `read_wav_f32`, kept local so the two features don't couple.
#[cfg(feature = "editor")]
fn read_wav_s16_f32(path: &std::path::Path) -> AppResult<Vec<f32>> {
    let bytes = std::fs::read(path)?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(AppError::Recording("peaks WAV is malformed".into()));
    }
    let mut i = 12;
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let size =
            u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]) as usize;
        if id == b"data" {
            let start = i + 8;
            let end = (start + size).min(bytes.len());
            let mut out = Vec::with_capacity((end - start) / 2);
            let mut j = start;
            while j + 1 < end {
                out.push(i16::from_le_bytes([bytes[j], bytes[j + 1]]) as f32 / 32768.0);
                j += 2;
            }
            return Ok(out);
        }
        i += 8 + size + (size & 1);
    }
    Err(AppError::Recording("peaks WAV has no data chunk".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The DTOs + the sidecar/inline/cleanup fs seam compile in both feature
    // states and ARE exercised in the gate (real tempdir round-trips). The
    // ffmpeg-driven entry points are HARDWARE-UNVERIFIED — feature-off they
    // return `feature_disabled` (tested here), feature-on they are proven only
    // in the smoke test.

    #[cfg(not(feature = "editor"))]
    #[tokio::test]
    async fn load_is_disabled_without_the_feature() {
        let err = load_recording("/x.mp4").await.unwrap_err();
        assert_eq!(err.code(), "validation");
        assert!(err.to_string().contains("feature_disabled"));
    }

    #[cfg(not(feature = "editor"))]
    #[tokio::test]
    async fn peaks_segments_mastering_export_disabled_without_feature() {
        assert!(peaks("/x.mp4")
            .await
            .unwrap_err()
            .to_string()
            .contains("feature_disabled"));
        assert!(segments("/x.mp4")
            .await
            .unwrap_err()
            .to_string()
            .contains("feature_disabled"));
        assert!(mastering_analyze("/x.mp4", "speech-clear")
            .await
            .unwrap_err()
            .to_string()
            .contains("feature_disabled"));
        let req = EditorExportRequest {
            input_path: "/x.mp4".into(),
            cut_regions: vec![],
            duration: 10.0,
            format: "mp3".into(),
            output_folder: "/tmp".into(),
            bitrate: None,
            bit_depth: None,
            master_preset: None,
            intro_path: None,
            outro_path: None,
            gain_db: None,
        };
        assert!(export(&req)
            .await
            .unwrap_err()
            .to_string()
            .contains("feature_disabled"));
        assert!(extract_frame("/x.mp4", 1.0)
            .await
            .unwrap_err()
            .to_string()
            .contains("feature_disabled"));
    }

    #[cfg(not(feature = "editor"))]
    #[tokio::test]
    async fn probe_preview_apply_disabled_without_feature() {
        assert!(probe_streams("/x.mp4")
            .await
            .unwrap_err()
            .to_string()
            .contains("feature_disabled"));
        let prev = EditorMasterPreviewRequest {
            input_path: "/x.mp4".into(),
            preset_id: "speech-clear".into(),
            start_sec: 0.0,
            duration_sec: 15.0,
        };
        assert!(master_preview(&prev)
            .await
            .unwrap_err()
            .to_string()
            .contains("feature_disabled"));
        let engine = MasterEngine::new();
        let apply = EditorMasterApplyRequest {
            input_path: "/x.mp4".into(),
            output_path: "/tmp/out.mp3".into(),
            preset_id: "speech-clear".into(),
            job_id: "j1".into(),
            bitrate: None,
        };
        assert!(master_apply(&engine, &apply, |_, _| {})
            .await
            .unwrap_err()
            .to_string()
            .contains("feature_disabled"));
    }

    // ── sidecar fs round-trip (gated to neither feature — pure fs) ────────────────

    fn tmp_media() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("tempdir");
        let media = dir.path().join("service.mp3");
        std::fs::write(&media, b"not really audio").expect("write media");
        let p = media.to_string_lossy().into_owned();
        (dir, p)
    }

    #[test]
    fn sidecar_write_read_delete_round_trip() {
        let (_dir, media) = tmp_media();
        // Nothing there yet → read is None.
        assert!(read_sidecar(&media, EditorSidecar::Meta).unwrap().is_none());
        // Write then read back the same JSON.
        let value = serde_json::json!({ "title": "Søndag", "chapters": [] });
        assert!(write_sidecar(&media, EditorSidecar::Meta, &value));
        let back = read_sidecar(&media, EditorSidecar::Meta).unwrap().unwrap();
        assert_eq!(back, value);
        // The sidecar sits next to the media with the dropped-extension stem.
        let expected = std::path::Path::new(&media)
            .parent()
            .unwrap()
            .join("service.meta.json");
        assert!(expected.exists());
        // Delete removes it; a second delete is a clean false.
        assert!(delete_sidecar(&media, EditorSidecar::Meta));
        assert!(!delete_sidecar(&media, EditorSidecar::Meta));
        assert!(read_sidecar(&media, EditorSidecar::Meta).unwrap().is_none());
    }

    #[test]
    fn cuts_draft_and_transcript_use_distinct_files() {
        let (_dir, media) = tmp_media();
        let cuts = serde_json::json!({ "cuts": [{ "start": 1.0, "end": 2.0 }], "ts": 5 });
        let transcript = serde_json::json!({ "segments": [] });
        assert!(write_sidecar(&media, EditorSidecar::CutsDraft, &cuts));
        assert!(write_sidecar(
            &media,
            EditorSidecar::Transcript,
            &transcript
        ));
        assert_eq!(
            read_sidecar(&media, EditorSidecar::CutsDraft)
                .unwrap()
                .unwrap(),
            cuts
        );
        assert_eq!(
            read_sidecar(&media, EditorSidecar::Transcript)
                .unwrap()
                .unwrap(),
            transcript
        );
    }

    #[test]
    fn read_file_guarded_returns_bytes_for_small_file() {
        let (_dir, media) = tmp_media();
        let r = read_file_guarded(&media).unwrap();
        assert!(!r.too_large);
        assert_eq!(r.size, b"not really audio".len() as u64);
        assert_eq!(r.bytes.unwrap(), b"not really audio");
    }

    #[test]
    fn read_file_guarded_errors_on_missing() {
        let err = read_file_guarded("/no/such/file.mp3").unwrap_err();
        assert!(err.to_string().contains("file_not_found"));
    }

    #[test]
    fn cleanup_temp_files_removes_only_editor_leftovers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let d = dir.path();
        std::fs::write(d.join("service.mp3"), b"keep").unwrap();
        std::fs::write(d.join("service.mp3.__editor_tmp"), b"x").unwrap();
        std::fs::write(d.join("service.mp3.__editor_bak"), b"x").unwrap();
        std::fs::write(d.join("clip.__editor_tmp.mp4"), b"x").unwrap();
        let removed = cleanup_temp_files(&[d.to_string_lossy().into_owned()]);
        assert_eq!(removed, 3);
        assert!(d.join("service.mp3").exists());
        assert!(!d.join("service.mp3.__editor_tmp").exists());
        assert!(!d.join("clip.__editor_tmp.mp4").exists());
    }

    #[test]
    fn master_cancel_unknown_job_is_false() {
        let engine = MasterEngine::new();
        let was = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(master_cancel(&engine, "never-started"))
            .unwrap();
        assert!(!was);
    }

    // ── Real-ffmpeg editor smoke test (feature-on; skips without the sidecar) ─────
    //
    // Generates a 2 s lavfi A/V file, then drives the editor's REAL `export` seam
    // (cut + encode to mp3) against it and ffprobes the result is a valid,
    // non-empty mp3 stream. Mirrors `format_matrix_produces_valid_files_or_skips`
    // in `media/ffmpeg.rs`: it skips cleanly when the bundled sidecars aren't
    // fetched (the sandboxed gate), so it never reddens CI. HARDWARE-FREE — lavfi
    // needs no devices — but HARDWARE-UNVERIFIED in that it only runs where the
    // real ffmpeg is present.
    #[cfg(feature = "editor")]
    mod ffmpeg_smoke {
        use super::*;
        use std::sync::Mutex;

        // Serialise the `SUNDAYREC_*` env overrides against the parallel suite.
        static ENV_LOCK: Mutex<()> = Mutex::new(());

        /// Path to the fetched dev sidecar, if `npm run ffmpeg` populated it.
        /// Same lookup the `media::ffmpeg` integration tests use.
        fn fetched_sidecar(name: &str) -> Option<std::path::PathBuf> {
            let triple = env!("SUNDAYREC_TARGET_TRIPLE");
            let ext = if cfg!(windows) { ".exe" } else { "" };
            let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join(format!("{name}-{triple}{ext}"));
            p.is_file().then_some(p)
        }

        #[test]
        fn export_cuts_and_encodes_mp3_or_skips() {
            let (Some(ffmpeg), Some(ffprobe)) =
                (fetched_sidecar("ffmpeg"), fetched_sidecar("ffprobe"))
            else {
                eprintln!("SKIP: no fetched ffmpeg/ffprobe sidecar (run `npm run ffmpeg`)");
                return;
            };

            let dir = tempfile::tempdir().unwrap();
            // 1. Generate a 2 s lavfi A/V source (testsrc video + sine audio).
            let src = dir.path().join("source.mp4");
            let src_s = src.to_string_lossy().into_owned();
            let gen = std::process::Command::new(&ffmpeg)
                .args([
                    "-hide_banner",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=size=320x240:rate=15:duration=2",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=48000:duration=2",
                    "-shortest",
                    "-pix_fmt",
                    "yuv420p",
                    "-y",
                ])
                .arg(&src)
                .output()
                .expect("ffmpeg should run to generate the lavfi source");
            assert!(
                gen.status.success(),
                "lavfi source generation failed: {}",
                String::from_utf8_lossy(&gen.stderr)
            );

            // 2. Drive the editor's REAL export seam: cut the middle 0.5 s out and
            //    encode the remainder to mp3. The seam resolves ffmpeg via the
            //    SUNDAYREC_FFMPEG override (the production fallback path).
            let req = EditorExportRequest {
                input_path: src_s,
                cut_regions: vec![EditorCutRegion {
                    start: 0.75,
                    end: 1.25,
                }],
                duration: 2.0,
                format: "mp3".into(),
                output_folder: dir.path().to_string_lossy().into_owned(),
                bitrate: Some(128),
                bit_depth: None,
                master_preset: None,
                intro_path: None,
                outro_path: None,
                gain_db: None,
                chapters: Vec::new(),
                title: None,
                speaker: None,
                description: None,
                vocal_chain_preset: None,
                processing: None,
                channel_repair: None,
                video_codec: None,
            };

            let rt = tokio::runtime::Runtime::new().unwrap();
            let out_path = {
                let _guard = ENV_LOCK.lock().unwrap();
                // SAFETY: serialised by ENV_LOCK; removed before releasing it.
                unsafe { std::env::set_var("SUNDAYREC_FFMPEG", &ffmpeg) };
                let result = rt.block_on(export(&req));
                unsafe { std::env::remove_var("SUNDAYREC_FFMPEG") };
                result.expect("editor export should succeed against the lavfi source")
            };

            // 3. The output exists, is non-empty, and ffprobes as a real mp3 stream
            //    shorter than the input (we cut 0.5 s out of 2 s ⇒ ~1.5 s).
            let out = std::path::Path::new(&out_path.output_path);
            let len = std::fs::metadata(out).expect("export output exists").len();
            assert!(len > 0, "export produced an empty file");

            let probe = std::process::Command::new(&ffprobe)
                .args([
                    "-v",
                    "error",
                    "-select_streams",
                    "a:0",
                    "-show_entries",
                    "stream=codec_name:format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                ])
                .arg(out)
                .output()
                .expect("ffprobe should run on the export output");
            assert!(
                probe.status.success(),
                "ffprobe failed on export output: {}",
                String::from_utf8_lossy(&probe.stderr)
            );
            let report = String::from_utf8_lossy(&probe.stdout);
            assert!(
                report.contains("mp3"),
                "export should be an mp3 stream; ffprobe: {report}"
            );
            // Duration should reflect the cut (input 2 s − 0.5 s cut ≈ 1.5 s).
            let dur: f64 = report
                .lines()
                .find_map(|l| l.trim().parse::<f64>().ok())
                .expect("ffprobe should report a numeric duration");
            assert!(
                (1.0..1.9).contains(&dur),
                "cut export duration {dur}s should be ~1.5 s (2 s − 0.5 s cut)"
            );
            eprintln!(
                "editor export smoke: wrote {} ({dur:.2}s mp3)",
                out.display()
            );
        }
    }
}
