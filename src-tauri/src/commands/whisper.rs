//! Whisper transcription commands (PU-5 P2b).
//!
//! The model registry + installed-status read are pure (no feature needed) so
//! the renderer can show the model picker regardless. The actual transcription
//! ([`transcribe`]) is behind the default-off `whisper` feature and returns a
//! clear `feature_disabled` error otherwise — HARDWARE-UNVERIFIED.

use tauri::{Manager, State};

use sundayrec_core::whisper::{
    self, InstalledStatus, TranscribeOptions, TranscriptData, TranscriptExportFormat,
    WhisperModelMeta,
};

use crate::db::store::now_ms;
use crate::error::{AppError, AppResult};
use crate::whisper as seam;

/// The curated whisper model registry, in display order.
#[tauri::command]
pub fn whisper_list_models() -> Vec<WhisperModelMeta> {
    seam::list_models()
}

/// Installed-status for one model id (exists + correct size on disk).
#[tauri::command]
pub fn whisper_model_status(app: tauri::AppHandle, id: String) -> AppResult<InstalledStatus> {
    let dir = whisper_models_dir(&app)?;
    Ok(seam::model_status(&dir, &id))
}

/// Transcribe a recording. HARDWARE-UNVERIFIED behind `--features whisper`;
/// returns `feature_disabled` in the default build.
#[tauri::command]
pub async fn whisper_transcribe(
    app: tauri::AppHandle,
    _db: State<'_, crate::db::Db>,
    input_path: String,
    model_id: String,
    language: Option<String>,
    translate: Option<bool>,
    subtitle_style: Option<bool>,
) -> AppResult<TranscriptData> {
    let dir = whisper_models_dir(&app)?;
    let opts = TranscribeOptions {
        language: language.unwrap_or_else(|| "auto".into()),
        translate: translate.unwrap_or(false),
        subtitle_style: subtitle_style.unwrap_or(true),
    };
    seam::transcribe(&dir, &input_path, &model_id, opts, now_ms() as i64).await
}

/// Render a transcript to a subtitle/text file at `path` (the renderer picks the
/// destination through the native save dialog). The rendering is the pure
/// `sundayrec_core::whisper::export_transcript`; works in every build (no
/// `whisper` feature needed — there's nothing to infer, just format + write).
#[tauri::command]
pub fn whisper_export_transcript(
    data: TranscriptData,
    format: TranscriptExportFormat,
    path: String,
) -> AppResult<()> {
    let body = whisper::export_transcript(&data, format);
    std::fs::write(&path, body)
        .map_err(|e| AppError::Internal(format!("write transcript {path}: {e}")))?;
    Ok(())
}

/// The OS app-data `whisper-models/` directory (created if missing).
fn whisper_models_dir(app: &tauri::AppHandle) -> AppResult<std::path::PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("app data dir: {e}")))?
        .join("whisper-models");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
