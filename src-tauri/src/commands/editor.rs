//! Editor commands (R1 P2b) — the thin IPC layer over `crate::editor`.
//!
//! All five delegate to the seam, which delegates every decision to the
//! unit-tested `sundayrec-core` (`editor`/`mastering`/`audio_analysis`). The
//! ffmpeg/ffprobe runs are HARDWARE-UNVERIFIED behind `--features editor`; in the
//! default build the seam returns a clear `feature_disabled` error the renderer
//! handles gracefully (the panel shows a "not built into this build" hint).

use crate::editor::{
    self, EditorAudioExtract, EditorAutoProcess, EditorChannelDiagnosis, EditorChapter,
    EditorExportRequest,
    EditorExportResult, EditorFileRead, EditorLoudness, EditorMasterApplyRequest,
    EditorMasterApplyResult, EditorMasterPreviewRequest, EditorMasterPreviewResult,
    EditorMasterProgress, EditorMediaInfo, EditorPeaks, EditorSegment, EditorSidecar,
    EditorStreamInfo, EditorTranscriptLine, MasterEngine,
};
use crate::error::AppResult;
use tauri::{Emitter, State};

/// Probe a recording's duration/streams for the editor's first paint.
#[tauri::command]
pub async fn editor_load_recording(input_path: String) -> AppResult<EditorMediaInfo> {
    editor::load_recording(&input_path).await
}

/// Decode the audio to a renderer waveform (peaks + sample rate).
#[tauri::command]
pub async fn editor_peaks(input_path: String) -> AppResult<EditorPeaks> {
    editor::peaks(&input_path).await
}

/// Extract a large/exotic recording to a small decodable 8 kHz mono WAV (bytes +
/// duration) — the renderer's preview buffer when the file is over the inline
/// limit or in a codec the browser can't decode.
#[tauri::command]
pub async fn editor_extract_audio(input_path: String) -> AppResult<EditorAudioExtract> {
    editor::extract_audio(&input_path).await
}

/// Content-detect timeline segments (silence/speech/music + promoted sermon).
#[tauri::command]
pub async fn editor_segments(input_path: String) -> AppResult<Vec<EditorSegment>> {
    editor::segments(&input_path).await
}

/// The built-in mastering presets for the editor's preset dropdown. Pure core
/// (no ffmpeg / feature gate), so the panel is never empty.
#[tauri::command]
pub fn editor_master_presets() -> AppResult<Vec<crate::editor::EditorMasterPreset>> {
    Ok(editor::master_presets())
}

/// Detect topic chapters from a transcript (Bible references + enumeration
/// points). Pure/offline/deterministic — no ffmpeg, works without the `whisper`
/// or `editor` features. Returns chapters on the original recording timeline.
#[tauri::command]
pub fn editor_detect_chapters(
    lines: Vec<EditorTranscriptLine>,
    lang: Option<String>,
) -> AppResult<Vec<EditorChapter>> {
    Ok(editor::detect_chapters(
        &lines,
        lang.as_deref().unwrap_or("no"),
    ))
}

/// Analyse a recording's stereo channel balance and recommend a repair
/// (swap / duplicate the good channel / per-channel makeup). HARDWARE-UNVERIFIED.
#[tauri::command]
pub async fn editor_diagnose_channels(input_path: String) -> AppResult<EditorChannelDiagnosis> {
    editor::diagnose_channels(&input_path).await
}

/// One-click "auto-improve": diagnose channels + recommend the full best-result
/// processing setup (channel repair + podcast vocal chain + clear mastering).
#[tauri::command]
pub async fn editor_auto_process(input_path: String) -> AppResult<EditorAutoProcess> {
    editor::auto_process(&input_path).await
}

/// Measure the recording's loudness against a mastering preset (pass 1 only).
#[tauri::command]
pub async fn editor_mastering_analyze(
    input_path: String,
    preset_id: String,
) -> AppResult<EditorLoudness> {
    editor::mastering_analyze(&input_path, &preset_id).await
}

/// Apply the cut-plan (+ optional mastering) and render to the chosen format.
#[tauri::command]
pub async fn editor_export(request: EditorExportRequest) -> AppResult<EditorExportResult> {
    editor::export(&request).await
}

/// Extract a single video frame at `sec` seconds as a base64 JPEG (480px wide)
/// for the editor's video-preview scrubber. HARDWARE-UNVERIFIED.
#[tauri::command]
pub async fn editor_extract_frame(input_path: String, sec: f64) -> AppResult<String> {
    editor::extract_frame(&input_path, sec).await
}

// ── P1 parity: sidecars, probe, file guard, cleanup, mastering flow ──────────────

/// Read a per-recording sidecar JSON (.meta / .cuts-draft / .transcript), or
/// `null` when absent/corrupt. The editor's reopen-ability — cuts/intro-outro/
/// metadata persist across sessions.
#[tauri::command]
pub fn editor_read_sidecar(
    media_path: String,
    sidecar: EditorSidecar,
) -> AppResult<Option<serde_json::Value>> {
    editor::read_sidecar(&media_path, sidecar)
}

/// Write a per-recording sidecar JSON (pretty). Returns whether it persisted.
#[tauri::command]
pub fn editor_write_sidecar(
    media_path: String,
    sidecar: EditorSidecar,
    value: serde_json::Value,
) -> AppResult<bool> {
    Ok(editor::write_sidecar(&media_path, sidecar, &value))
}

/// Delete a per-recording sidecar. Returns whether one was removed.
#[tauri::command]
pub fn editor_delete_sidecar(media_path: String, sidecar: EditorSidecar) -> AppResult<bool> {
    Ok(editor::delete_sidecar(&media_path, sidecar))
}

/// Probe just has_video/has_audio for the editor's audio-vs-video layout.
#[tauri::command]
pub async fn editor_probe_streams(input_path: String) -> AppResult<EditorStreamInfo> {
    editor::probe_streams(&input_path).await
}

/// Stat a recording and either return its bytes inline (≤400 MB) or signal
/// `tooLarge` so the renderer streams it via the peaks-extract path. Async +
/// spawn_blocking: a sync command runs on the main thread, and reading a
/// hundreds-of-MB recording there froze the whole UI for the duration.
#[tauri::command]
pub async fn editor_read_file(media_path: String) -> AppResult<EditorFileRead> {
    tokio::task::spawn_blocking(move || editor::read_file_guarded(&media_path))
        .await
        .map_err(|e| crate::error::AppError::Internal(format!("editor read join: {e}")))?
}

/// Sweep the given folders for crashed-edit temp/backup leftovers. Returns the
/// count removed. Called at startup over the save-folder + history folders.
#[tauri::command]
pub fn editor_cleanup_temp_files(folders: Vec<String>) -> AppResult<usize> {
    Ok(editor::cleanup_temp_files(&folders))
}

/// Render a windowed single-pass mastering preview to a temp mp3.
#[tauri::command]
pub async fn editor_master_preview(
    request: EditorMasterPreviewRequest,
) -> AppResult<EditorMasterPreviewResult> {
    editor::master_preview(&request).await
}

/// Run the full two-pass mastering apply, emitting `editor-master-progress`
/// ticks, tracked by job id for cancellation.
#[tauri::command]
pub async fn editor_master_apply(
    app: tauri::AppHandle,
    engine: State<'_, MasterEngine>,
    request: EditorMasterApplyRequest,
) -> AppResult<EditorMasterApplyResult> {
    let job_id = request.job_id.clone();
    editor::master_apply(&engine, &request, move |current_sec, total_sec| {
        let _ = app.emit(
            "editor-master-progress",
            EditorMasterProgress {
                job_id: job_id.clone(),
                current_sec,
                total_sec,
            },
        );
    })
    .await
}

/// Abort an in-flight mastering apply by job id. Returns whether it was live.
#[tauri::command]
pub async fn editor_master_cancel(
    engine: State<'_, MasterEngine>,
    job_id: String,
) -> AppResult<bool> {
    editor::master_cancel(&engine, &job_id).await
}
