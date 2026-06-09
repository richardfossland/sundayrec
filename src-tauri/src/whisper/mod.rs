//! Whisper transcription plumbing (PU-5 P2b) — **HARDWARE-UNVERIFIED**.
//!
//! The impure half of transcription. Every decision (the model registry, the
//! whisper-cli argv + thread heuristic, the ffmpeg convert argv, the progress/
//! exit parsing, the JSON-sidecar normalise into [`TranscriptData`], the chunk
//! plan + segment merge) lives in the unit-tested [`sundayrec_core::whisper`].
//! This module performs the side effects the Electron `src/main/whisper.ts` did:
//! resolving a whisper-rs context, converting the input to 16 kHz mono WAV via
//! the ffmpeg sidecar, and running inference + normalising the result.
//!
//! ## Feature flag
//!
//! Transcription is behind the **default-off `whisper`** cargo feature, which
//! pulls `whisper-rs` (libwhisper compiled from C/C++ source). The default build
//! and the headless CI gate carry NO whisper dep — the public entry points below
//! compile either way, and when the feature is OFF [`transcribe`] returns a clear
//! `feature_disabled` error (mirrors SundayPaper's `pdf`-feature idiom).
//!
//! ## ⚠️ HARDWARE-UNVERIFIED
//!
//! Under `--features whisper` the model download (SHA-verified), the ffmpeg
//! conversion, and the actual inference are wired but unproven — they need a real
//! model file, a real audio file, and (ideally) a GPU/Metal backend. Only the
//! `sundayrec-core::whisper` decisions are unit-tested. See docs/SMOKE-TEST.md.

#[cfg(feature = "whisper")]
use sundayrec_core::whisper::model_meta;
use sundayrec_core::whisper::{
    self, models, InstalledStatus, TranscribeOptions, TranscriptData, WhisperModelMeta,
};

use crate::error::{AppError, AppResult};

/// The curated model registry — pure passthrough so the renderer can list models
/// without the feature being on.
pub fn list_models() -> Vec<WhisperModelMeta> {
    models()
}

/// Installed-status for one model id, derived from the on-disk file the shell
/// stats. `models_dir` is the OS app-data `whisper-models/` dir.
pub fn model_status(models_dir: &std::path::Path, id: &str) -> InstalledStatus {
    let path = models_dir.join(format!("{id}.bin"));
    let (exists, size) = match std::fs::metadata(&path) {
        Ok(m) => (true, Some(m.len())),
        Err(_) => (false, None),
    };
    whisper::installed_status(id, exists, size)
}

/// The on-disk file for a model id (`<models_dir>/<id>.bin`).
fn model_file(models_dir: &std::path::Path, id: &str) -> std::path::PathBuf {
    models_dir.join(format!("{id}.bin"))
}

/// Delete a downloaded model file. Returns whether a file was removed (a missing
/// file is `false`, not an error — mirrors the Electron `deleteModel` unlink in a
/// try/catch). Works in every build (it's just fs); the model registry is the
/// only thing the renderer needs to know which ids exist.
pub fn delete_model(models_dir: &std::path::Path, id: &str) -> bool {
    std::fs::remove_file(model_file(models_dir, id)).is_ok()
}

/// Tracks in-flight model downloads so `whisper_cancel_download` can abort one.
/// The per-model [`tokio::sync::Notify`] is fired by `cancel`; the download loop
/// races each chunk read against it. Managed as Tauri state. Mirrors the Electron
/// `modelDownloads` map of abort callbacks (one entry per active model id).
#[derive(Default)]
pub struct DownloadGuard {
    notify:
        std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Notify>>>,
}

impl DownloadGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a download for `id`, returning its cancel signal. Returns `None`
    /// when a download for that id is already in flight (mirrors the Electron
    /// `already_downloading` guard — the map can't hold two for one id).
    pub fn register(&self, id: &str) -> Option<std::sync::Arc<tokio::sync::Notify>> {
        let mut map = guard_lock(&self.notify);
        if map.contains_key(id) {
            return None;
        }
        let n = std::sync::Arc::new(tokio::sync::Notify::new());
        map.insert(id.to_string(), n.clone());
        Some(n)
    }

    /// Fire the cancel signal for `id`'s in-flight download, if any. Returns
    /// whether a download was registered to cancel.
    pub fn cancel(&self, id: &str) -> bool {
        let map = guard_lock(&self.notify);
        match map.get(id) {
            Some(n) => {
                n.notify_waiters();
                true
            }
            None => false,
        }
    }

    /// Drop `id`'s signal once its download finished (success, error, or cancel).
    pub fn clear(&self, id: &str) {
        guard_lock(&self.notify).remove(id);
    }
}

/// Lock the download-guard mutex, recovering the guard if a previous holder
/// panicked. It guards a simple `id → cancel-signal` map (no invariant a panic
/// could half-break), so taking the poisoned inner guard is correct and strictly
/// safer than `.expect()`-ing — a panic in one download path must not cascade and
/// crash the app on every later register/cancel/clear.
fn guard_lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Transcribe `input_path` with `model_id` + `opts`. The pure decisions come
/// from `sundayrec-core::whisper`; the I/O is feature-gated.
///
/// When the `whisper` feature is OFF this returns a clear `feature_disabled`
/// error so the renderer can surface "transcription isn't built into this
/// build" rather than failing opaquely.
#[cfg(not(feature = "whisper"))]
pub async fn transcribe(
    _models_dir: &std::path::Path,
    _input_path: &str,
    _model_id: &str,
    _opts: TranscribeOptions,
    _now_ms: i64,
) -> AppResult<TranscriptData> {
    Err(AppError::Validation(
        "feature_disabled: transcription requires a build with `--features whisper`".into(),
    ))
}

/// Transcribe `input_path` with `model_id` + `opts`. HARDWARE-UNVERIFIED: the
/// ffmpeg conversion + whisper-rs inference are wired but unproven on a device.
#[cfg(feature = "whisper")]
pub async fn transcribe(
    models_dir: &std::path::Path,
    input_path: &str,
    model_id: &str,
    opts: TranscribeOptions,
    now_ms: i64,
) -> AppResult<TranscriptData> {
    use std::path::PathBuf;
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    // 0. The core decides the model must be present + the right size first.
    let meta = model_meta(model_id)
        .ok_or_else(|| AppError::Validation(format!("unknown_model: {model_id}")))?;
    let model_path: PathBuf = models_dir.join(format!("{model_id}.bin"));
    let status = model_status(models_dir, model_id);
    if !status.installed || !status.size_ok {
        return Err(AppError::Validation(format!(
            "model_not_ready: {} ({} bytes expected)",
            meta.id, meta.size_bytes
        )));
    }
    if !std::path::Path::new(input_path).exists() {
        return Err(AppError::Validation("source_missing".into()));
    }

    // 1. Convert to 16 kHz mono WAV using the bundled ffmpeg sidecar (argv from
    //    the core). HARDWARE-UNVERIFIED: the actual conversion isn't proven here.
    let tmp = tempfile::Builder::new()
        .prefix("sundayrec-whisper-")
        .tempdir()?;
    let wav_path = tmp.path().join("input.wav");
    let wav_str = wav_path.to_string_lossy().into_owned();
    let convert_args = whisper::build_convert_args(input_path, &wav_str);
    let arg_refs: Vec<&str> = convert_args.iter().map(String::as_str).collect();
    let mut child = crate::media::ffmpeg::spawn_ffmpeg(&arg_refs).await?;
    let status = child
        .wait()
        .await
        .map_err(|e| AppError::Internal(format!("whisper convert wait: {e}")))?;
    if !status.success() || !wav_path.exists() {
        return Err(AppError::Internal(
            "whisper convert failed (ffmpeg non-zero / no output)".into(),
        ));
    }

    // 2. Read the 16-bit PCM WAV into f32 samples whisper-rs wants.
    let samples = read_wav_f32(&wav_path)?;

    // 3. Run inference. The argv heuristic (`thread_count`) is the core's; here
    //    we map onto whisper-rs's typed params.
    let cpu = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let ctx = WhisperContext::new_with_params(
        &model_path.to_string_lossy(),
        WhisperContextParameters::default(),
    )
    .map_err(|e| AppError::Internal(format!("whisper context: {e}")))?;
    let mut state = ctx
        .create_state()
        .map_err(|e| AppError::Internal(format!("whisper state: {e}")))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(whisper::thread_count(cpu) as i32);
    params.set_translate(opts.translate);
    if opts.language != "auto" {
        params.set_language(Some(&opts.language));
    }
    state
        .full(params, &samples)
        .map_err(|e| AppError::Internal(format!("whisper inference: {e}")))?;

    // 4. Build the raw-shape the core normaliser consumes (ms offsets).
    let n = state
        .full_n_segments()
        .map_err(|e| AppError::Internal(format!("whisper segments: {e}")))?;
    let mut transcription = Vec::new();
    for i in 0..n {
        let text = state
            .full_get_segment_text(i)
            .map_err(|e| AppError::Internal(format!("whisper text: {e}")))?;
        // whisper t is centiseconds → ms. saturating_mul defends against a
        // pathological timestamp wrapping i64 (impossible for real audio, but
        // free insurance rather than a silent wrap).
        let from = state
            .full_get_segment_t0(i)
            .map_err(|e| AppError::Internal(format!("whisper t0: {e}")))?
            .saturating_mul(10);
        let to = state
            .full_get_segment_t1(i)
            .map_err(|e| AppError::Internal(format!("whisper t1: {e}")))?
            .saturating_mul(10);
        transcription.push(whisper::WhisperRawSegment {
            offsets: whisper::WhisperOffsets { from, to },
            text,
        });
    }
    let raw = whisper::WhisperRawOutput {
        result: None,
        transcription,
    };
    Ok(whisper::normalize_output(&raw, model_id, &opts, now_ms))
}

/// Download a model into `models_dir`. The progress shaping + SHA-256 integrity
/// decision are the unit-tested `sundayrec-core::whisper`; this streams the
/// bytes, emits `whisper://model-progress` events through `app`, and races each
/// chunk read against `cancel`. NETWORK-UNVERIFIED behind `--features whisper`;
/// returns `feature_disabled` in the default build.
#[cfg(not(feature = "whisper"))]
pub async fn download_model(
    _app: &tauri::AppHandle,
    _models_dir: &std::path::Path,
    _id: &str,
    _cancel: std::sync::Arc<tokio::sync::Notify>,
) -> AppResult<()> {
    Err(AppError::Validation(
        "feature_disabled: model download requires a build with `--features whisper`".into(),
    ))
}

/// Download `id` into `models_dir`, emitting progress + verifying integrity.
/// NETWORK-UNVERIFIED: the HTTPS stream + the on-disk write are wired but unproven.
#[cfg(feature = "whisper")]
pub async fn download_model(
    app: &tauri::AppHandle,
    models_dir: &std::path::Path,
    id: &str,
    cancel: std::sync::Arc<tokio::sync::Notify>,
) -> AppResult<()> {
    use sha2::{Digest, Sha256};
    use tauri::Emitter;
    use tokio::io::AsyncWriteExt;

    // 0. The core knows the URL, expected size + SHA for this id.
    let meta =
        model_meta(id).ok_or_else(|| AppError::Validation(format!("unknown_model: {id}")))?;
    std::fs::create_dir_all(models_dir)?;
    let dest = model_file(models_dir, id);
    let partial = dest.with_extension("bin.partial");

    // 1. Open the stream (reqwest follows redirects: HF 302 → CloudFront). A
    //    CONNECT timeout fails fast on a dead/unreachable host; we deliberately do
    //    NOT set an overall request timeout — a model is 148 MB–1.5 GB and a slow
    //    connection can legitimately take many minutes (the user can cancel via the
    //    download guard). `reqwest::Client::new()` had no bound at all, so a host
    //    that accepted the TCP connection but never responded would hang forever.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| AppError::Internal(format!("http client: {e}")))?;
    let resp = client
        .get(&meta.url)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("model download request: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Internal(format!(
            "Download failed: HTTP {}",
            resp.status().as_u16()
        )));
    }
    let header_total = resp.content_length().unwrap_or(0);

    // 2. Stream chunks to the .partial file, hashing as we go + emitting progress.
    //    Each chunk-await races the cancel signal so a cancel aborts promptly.
    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(|e| AppError::Internal(format!("create partial: {e}")))?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut stream = resp;
    loop {
        let chunk = tokio::select! {
            biased;
            () = cancel.notified() => {
                drop(file);
                let _ = tokio::fs::remove_file(&partial).await;
                return Err(AppError::Validation("cancelled".into()));
            }
            c = stream.chunk() => c.map_err(|e| AppError::Internal(format!("download chunk: {e}")))?,
        };
        let Some(bytes) = chunk else { break };
        hasher.update(&bytes);
        file.write_all(&bytes)
            .await
            .map_err(|e| AppError::Internal(format!("write chunk: {e}")))?;
        downloaded += bytes.len() as u64;
        let progress = whisper::download_progress(id, downloaded, header_total, meta.size_bytes);
        let _ = app.emit("whisper://model-progress", &progress);
    }
    file.flush()
        .await
        .map_err(|e| AppError::Internal(format!("flush: {e}")))?;
    drop(file);

    // 3. Verify integrity (the core compares against the registry SHA), then
    //    atomically promote .partial → .bin. A mismatch deletes the partial.
    let computed = hex_lower(&hasher.finalize());
    if !whisper::verify_model_hash(id, &computed) {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(AppError::Internal(
            "Download integrity check failed (SHA-256 mismatch). Try again.".into(),
        ));
    }
    tokio::fs::rename(&partial, &dest)
        .await
        .map_err(|e| AppError::Internal(format!("promote model file: {e}")))?;
    Ok(())
}

/// Lowercase-hex encode a byte digest (no extra dep — `sha2` gives raw bytes).
#[cfg(feature = "whisper")]
fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Read a 16 kHz mono 16-bit PCM WAV into normalised f32 samples. Minimal RIFF
/// parser — the conversion step guarantees this exact format.
#[cfg(feature = "whisper")]
fn read_wav_f32(path: &std::path::Path) -> AppResult<Vec<f32>> {
    let bytes = std::fs::read(path)?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(AppError::Internal("not a WAV file".into()));
    }
    // Walk the chunks: validate `fmt ` is the mono 16 kHz the convert step
    // promised, then read the `data` chunk.
    let mut i = 12;
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let size =
            u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]) as usize;
        // The ffmpeg convert step forces `-ac 1 -ar 16000`; assert it rather than
        // trust it blindly, so a future change to the args can't silently feed
        // whisper mis-rated or interleaved audio.
        if id == b"fmt " && size >= 16 && i + 8 + 16 <= bytes.len() {
            let fmt = i + 8;
            let channels = u16::from_le_bytes([bytes[fmt + 2], bytes[fmt + 3]]);
            let rate = u32::from_le_bytes([
                bytes[fmt + 4],
                bytes[fmt + 5],
                bytes[fmt + 6],
                bytes[fmt + 7],
            ]);
            if channels != 1 || rate != 16_000 {
                return Err(AppError::Internal(format!(
                    "unexpected WAV format ({channels} ch, {rate} Hz; whisper needs mono 16 kHz)"
                )));
            }
        }
        if id == b"data" {
            let start = i + 8;
            let end = (start + size).min(bytes.len());
            let mut out = Vec::with_capacity((end - start) / 2);
            let mut j = start;
            while j + 1 < end {
                let s = i16::from_le_bytes([bytes[j], bytes[j + 1]]);
                out.push(s as f32 / 32768.0);
                j += 2;
            }
            return Ok(out);
        }
        i += 8 + size + (size & 1); // chunks are word-aligned
    }
    Err(AppError::Internal("WAV has no data chunk".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_models_passes_through_the_core_registry() {
        assert_eq!(list_models().len(), 4);
    }

    #[test]
    fn model_status_reports_missing_for_absent_file() {
        let dir = tempfile::tempdir().unwrap();
        let st = model_status(dir.path(), "ggml-base");
        assert!(!st.installed);
    }

    #[test]
    fn delete_model_removes_an_existing_file_and_is_false_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("ggml-base.bin");
        std::fs::write(&f, b"x").unwrap();
        assert!(delete_model(dir.path(), "ggml-base"));
        assert!(!f.exists());
        // Second delete: nothing to remove → false, not an error.
        assert!(!delete_model(dir.path(), "ggml-base"));
    }

    #[test]
    fn download_guard_rejects_a_second_in_flight_and_cancel_finds_it() {
        let guard = DownloadGuard::new();
        let first = guard.register("ggml-base");
        assert!(first.is_some(), "first register must succeed");
        // A second register for the same id while in flight is refused.
        assert!(guard.register("ggml-base").is_none());
        // Cancel finds the registered download; a different id does not.
        assert!(guard.cancel("ggml-base"));
        assert!(!guard.cancel("ggml-small"));
        // After clear, a fresh register succeeds again.
        guard.clear("ggml-base");
        assert!(guard.register("ggml-base").is_some());
    }

    /// Build a minimal PCM WAV (canonical RIFF/fmt /data) for the reader tests.
    #[cfg(feature = "whisper")]
    fn wav_bytes(channels: u16, rate: u32, samples: &[i16]) -> Vec<u8> {
        let data: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36u32 + data.len() as u32).to_le_bytes());
        b.extend_from_slice(b"WAVE");
        b.extend_from_slice(b"fmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes()); // PCM
        b.extend_from_slice(&channels.to_le_bytes());
        b.extend_from_slice(&rate.to_le_bytes());
        let byte_rate = rate * channels as u32 * 2;
        b.extend_from_slice(&byte_rate.to_le_bytes());
        b.extend_from_slice(&(channels * 2).to_le_bytes()); // block align
        b.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
        b.extend_from_slice(b"data");
        b.extend_from_slice(&(data.len() as u32).to_le_bytes());
        b.extend_from_slice(&data);
        b
    }

    #[cfg(feature = "whisper")]
    #[test]
    fn read_wav_f32_accepts_mono_16k_and_normalises() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("ok.wav");
        std::fs::write(&p, wav_bytes(1, 16_000, &[0, 16_384, -16_384])).unwrap();
        let out = read_wav_f32(&p).unwrap();
        assert_eq!(out.len(), 3);
        assert!((out[0] - 0.0).abs() < 1e-6);
        assert!((out[1] - 0.5).abs() < 1e-3);
        assert!((out[2] + 0.5).abs() < 1e-3);
    }

    #[cfg(feature = "whisper")]
    #[test]
    fn read_wav_f32_rejects_stereo_or_wrong_rate() {
        let dir = tempfile::tempdir().unwrap();
        let stereo = dir.path().join("stereo.wav");
        std::fs::write(&stereo, wav_bytes(2, 16_000, &[0, 0])).unwrap();
        let err = read_wav_f32(&stereo).unwrap_err();
        assert!(err.to_string().contains("mono 16 kHz"));

        let wrong_rate = dir.path().join("44k.wav");
        std::fs::write(&wrong_rate, wav_bytes(1, 44_100, &[0])).unwrap();
        assert!(read_wav_f32(&wrong_rate)
            .unwrap_err()
            .to_string()
            .contains("mono 16 kHz"));
    }

    #[cfg(not(feature = "whisper"))]
    #[tokio::test]
    async fn transcribe_is_disabled_without_the_feature() {
        let dir = tempfile::tempdir().unwrap();
        let err = transcribe(
            dir.path(),
            "/x.mp4",
            "ggml-base",
            TranscribeOptions::default(),
            0,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "validation");
        assert!(err.to_string().contains("feature_disabled"));
    }
}
