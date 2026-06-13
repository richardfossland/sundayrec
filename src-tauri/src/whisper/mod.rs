//! Whisper transcription plumbing (PU-5 P2b).
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
//! Transcription is behind the `whisper` cargo feature (in `default` and the
//! macOS release build), which pulls `whisper-rs` (libwhisper compiled from
//! C/C++ source; the macOS target adds the `metal` GPU backend — CPU-only
//! inference ran the medium model slower than realtime on an M1 Pro, Metal runs
//! it ~30× realtime). The public entry points below compile either way, and
//! when the feature is OFF [`transcribe`] returns a clear `feature_disabled`
//! error (mirrors SundayPaper's `pdf`-feature idiom).
//!
//! ## Hardware verification
//!
//! The full convert → Metal inference → normalise path, the progress callback,
//! and the abort-flag cancel are verified on a real M1 Pro with the downloaded
//! ggml-medium model by the two `live_transcribe_*` tests below (`#[ignore]`d —
//! they need a model + audio file on the machine; invocation in their doc
//! comments). The model download (SHA-verified) was proven by a real 1.5 GB
//! download on the rig 2026-06-09.

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

/// Tracks in-flight transcriptions so `whisper_cancel_transcribe` can abort one.
/// The flag is read by whisper's abort callback between encoder/decoder steps
/// (an [`std::sync::atomic::AtomicBool`], not a Notify — inference is synchronous
/// C++ on a blocking thread, so a poll-on-step flag is the only abort channel
/// whisper.cpp offers). Managed as Tauri state, mirrors [`DownloadGuard`].
#[derive(Default)]
pub struct TranscribeGuard {
    flags: std::sync::Mutex<
        std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>,
    >,
}

impl TranscribeGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a transcription job, returning its cancel flag. Returns `None`
    /// when the job id is already in flight (the renderer mints unique ids, so a
    /// duplicate means a double-submit — refuse the second).
    pub fn register(&self, job_id: &str) -> Option<std::sync::Arc<std::sync::atomic::AtomicBool>> {
        let mut map = guard_lock(&self.flags);
        if map.contains_key(job_id) {
            return None;
        }
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        map.insert(job_id.to_string(), flag.clone());
        Some(flag)
    }

    /// Raise the cancel flag for `job_id`'s in-flight transcription, if any.
    /// Returns whether a job was registered to cancel.
    pub fn cancel(&self, job_id: &str) -> bool {
        match guard_lock(&self.flags).get(job_id) {
            Some(flag) => {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    /// Drop `job_id`'s flag once its transcription finished (success, error, or
    /// cancel).
    pub fn clear(&self, job_id: &str) {
        guard_lock(&self.flags).remove(job_id);
    }
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
    _progress: impl Fn(i32) + Send + Sync + 'static,
    _cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> AppResult<TranscriptData> {
    Err(AppError::Validation(
        "feature_disabled: transcription requires a build with `--features whisper`".into(),
    ))
}

/// Transcribe `input_path` with `model_id` + `opts`. `progress` is called with
/// 0–100 from whisper's progress callback (the command layer forwards it to the
/// renderer as `whisper://progress`); `cancel` is polled by whisper's abort
/// callback between encoder/decoder steps, so a raised flag stops inference
/// within a step or two.
#[cfg(feature = "whisper")]
pub async fn transcribe(
    models_dir: &std::path::Path,
    input_path: &str,
    model_id: &str,
    opts: TranscribeOptions,
    now_ms: i64,
    progress: impl Fn(i32) + Send + Sync + 'static,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> AppResult<TranscriptData> {
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;
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
    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::Validation("cancelled".into()));
    }

    // 2. Read the 16-bit PCM WAV into f32 samples whisper-rs wants.
    let samples = read_wav_f32(&wav_path)?;

    // 3. Run inference on a blocking thread — whisper.cpp is synchronous C++
    //    that can run for many minutes on a long service recording, and it must
    //    not occupy a tokio worker for that long. The argv heuristic
    //    (`thread_count`) is the core's; here we map onto whisper-rs's typed
    //    params. The model path / opts move into the closure.
    let cpu = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let model_path_str = model_path.to_string_lossy().into_owned();
    let infer_opts = opts.clone();
    let infer_cancel = cancel.clone();
    let raw = tokio::task::spawn_blocking(move || -> AppResult<whisper::WhisperRawOutput> {
        let ctx =
            WhisperContext::new_with_params(&model_path_str, WhisperContextParameters::default())
                .map_err(|e| AppError::Internal(format!("whisper context: {e}")))?;
        let mut state = ctx
            .create_state()
            .map_err(|e| AppError::Internal(format!("whisper state: {e}")))?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(whisper::thread_count(cpu) as i32);
        params.set_translate(infer_opts.translate);
        if infer_opts.language != "auto" {
            params.set_language(Some(&infer_opts.language));
        }
        if infer_opts.subtitle_style {
            // Electron parity (`-ml 100 -sow`): caption-sized segments split on
            // word boundaries. max_len only takes effect with token timestamps.
            params.set_token_timestamps(true);
            params.set_max_len(100);
            params.set_split_on_word(true);
        }
        params.set_progress_callback_safe(move |pct: i32| progress(pct));
        // UPSTREAM BUG (whisper-rs ≤0.16): set_abort_callback_safe's C trampoline
        // is instantiated with the caller's closure type F, but user_data points
        // at a `Box<dyn FnMut() -> bool>` — for any other F the cast is UB and
        // the garbage return aborted EVERY run ("failed to encode", code -6).
        // Passing an already-boxed dyn closure makes F == Box<dyn FnMut() ->
        // bool>, so the trampoline's cast is exact. Don't "simplify" this back
        // to a bare closure.
        let abort_cancel = infer_cancel.clone();
        let abort_cb: Box<dyn FnMut() -> bool> =
            Box::new(move || abort_cancel.load(Ordering::Relaxed));
        params.set_abort_callback_safe(abort_cb);
        if let Err(e) = state.full(params, &samples) {
            // An abort surfaces as a generic inference error — report the cancel
            // as the renderer-recognised "cancelled" instead of a scary failure.
            if infer_cancel.load(Ordering::Relaxed) {
                return Err(AppError::Validation("cancelled".into()));
            }
            return Err(AppError::Internal(format!("whisper inference: {e}")));
        }

        // Build the raw-shape the core normaliser consumes (ms offsets).
        let n = state.full_n_segments();
        let mut transcription = Vec::new();
        for i in 0..n {
            let seg = state
                .get_segment(i)
                .ok_or_else(|| AppError::Internal(format!("whisper segment {i} out of bounds")))?;
            let text = seg
                .to_str_lossy()
                .map_err(|e| AppError::Internal(format!("whisper text: {e}")))?
                .into_owned();
            // whisper t is centiseconds → ms. saturating_mul defends against a
            // pathological timestamp wrapping i64 (impossible for real audio, but
            // free insurance rather than a silent wrap).
            let from = seg.start_timestamp().saturating_mul(10);
            let to = seg.end_timestamp().saturating_mul(10);
            transcription.push(whisper::WhisperRawSegment {
                offsets: whisper::WhisperOffsets { from, to },
                text,
            });
        }
        Ok(whisper::WhisperRawOutput {
            result: None,
            transcription,
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("whisper task join: {e}")))??;
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
        // Chunks are word-aligned. `size` comes from untrusted file bytes, so use
        // a checked advance: a corrupt size near usize::MAX would overflow on a
        // 32-bit target, and a non-advancing step would loop forever — bail to the
        // "no data chunk" error instead.
        let next = i
            .checked_add(8)
            .and_then(|v| v.checked_add(size))
            .and_then(|v| v.checked_add(size & 1));
        match next {
            Some(n) if n > i => i = n,
            _ => break,
        }
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
            |_pct| {},
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "validation");
        assert!(err.to_string().contains("feature_disabled"));
    }

    /// Live end-to-end inference — needs a real model + audio file + ffmpeg, so
    /// it's `#[ignore]`d (run explicitly). Drives the EXACT production path:
    /// ffmpeg convert → whisper-rs Metal inference → normalised transcript.
    ///
    /// ```sh
    /// SUNDAYREC_FFMPEG=$(which ffmpeg) \
    /// SUNDAYREC_TEST_MODELS_DIR="$HOME/Library/Application Support/no.sundayrec.app/whisper-models" \
    /// SUNDAYREC_TEST_INPUT=/tmp/wtest.wav \
    /// cargo test --features whisper live_transcribe -- --ignored --nocapture
    /// ```
    #[cfg(feature = "whisper")]
    #[tokio::test]
    #[ignore = "needs a downloaded model + audio file + ffmpeg on the machine"]
    async fn live_transcribe_runs_inference_and_reports_progress() {
        let models_dir = std::path::PathBuf::from(
            std::env::var("SUNDAYREC_TEST_MODELS_DIR").expect("set SUNDAYREC_TEST_MODELS_DIR"),
        );
        let input = std::env::var("SUNDAYREC_TEST_INPUT").expect("set SUNDAYREC_TEST_INPUT");
        let model_id = std::env::var("SUNDAYREC_TEST_MODEL").unwrap_or("ggml-medium".into());

        let seen = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen_in_cb = seen.clone();
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let data = transcribe(
            &models_dir,
            &input,
            &model_id,
            TranscribeOptions::default(),
            12345,
            move |pct| {
                println!("progress = {pct}%");
                seen_in_cb.store(true, std::sync::atomic::Ordering::Relaxed);
            },
            cancel,
        )
        .await
        .expect("live transcription succeeds");
        println!("segments: {:?}", data.segments);
        assert!(!data.segments.is_empty(), "expected at least one segment");
        assert!(
            seen.load(std::sync::atomic::Ordering::Relaxed),
            "progress callback never fired"
        );
    }

    /// Live cancel — a pre-raised flag must abort inference and surface the
    /// renderer-recognised "cancelled" error, not a generic failure.
    #[cfg(feature = "whisper")]
    #[tokio::test]
    #[ignore = "needs a downloaded model + audio file + ffmpeg on the machine"]
    async fn live_transcribe_cancel_aborts_with_cancelled() {
        let models_dir = std::path::PathBuf::from(
            std::env::var("SUNDAYREC_TEST_MODELS_DIR").expect("set SUNDAYREC_TEST_MODELS_DIR"),
        );
        let input = std::env::var("SUNDAYREC_TEST_INPUT").expect("set SUNDAYREC_TEST_INPUT");
        let model_id = std::env::var("SUNDAYREC_TEST_MODEL").unwrap_or("ggml-medium".into());

        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let err = transcribe(
            &models_dir,
            &input,
            &model_id,
            TranscribeOptions::default(),
            12345,
            |_pct| {},
            cancel,
        )
        .await
        .expect_err("pre-cancelled transcription must error");
        assert!(
            err.to_string().contains("cancelled"),
            "expected cancelled, got: {err}"
        );
    }

    #[test]
    fn transcribe_guard_rejects_duplicate_job_and_cancel_raises_the_flag() {
        let guard = TranscribeGuard::new();
        let flag = guard.register("job-1").expect("first register succeeds");
        assert!(guard.register("job-1").is_none(), "duplicate id refused");
        assert!(!flag.load(std::sync::atomic::Ordering::Relaxed));
        assert!(guard.cancel("job-1"));
        assert!(flag.load(std::sync::atomic::Ordering::Relaxed));
        assert!(!guard.cancel("job-2"));
        guard.clear("job-1");
        assert!(guard.register("job-1").is_some());
    }
}
