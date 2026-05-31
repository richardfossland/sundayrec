//! Test-recording seam (P2b) — **HARDWARE-UNVERIFIED**.
//!
//! The impure half of the "Test mikrofon" button. Every decision (the ffmpeg
//! argv, the size floor, the stderr error-kind classifier, the `astats` RMS →
//! signal classifier) lives in the unit-tested [`sundayrec_core::test_recording`].
//! This module performs the side effects the Electron `src/main/test-recorder.ts`
//! did: enumerate devices, resolve the configured mic, spawn a short capture via
//! the bundled ffmpeg sidecar, stat the output, run the astats pass, and clean up.
//!
//! No new dependency or cargo feature: it reuses the ffmpeg sidecar the recorder
//! already drives (`crate::media::ffmpeg`). It is annotated HARDWARE-UNVERIFIED —
//! the spawn/stat path needs a real mic + the sidecar binary; only the core
//! decisions are proven in the gate. See docs/SMOKE-TEST.md.

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use ts_rs::TS;

use sundayrec_core::device_match::find_best_device_match;
use sundayrec_core::ffmpeg::Platform;
use sundayrec_core::test_recording::{
    build_astats_args, build_test_args, classify_ffmpeg_error, classify_signal,
    parse_strongest_rms, size_is_plausible, TestRecordingError, TestRecordingSignal,
};

use crate::audio::device_enum::enumerate_ffmpeg_devices;
use crate::error::AppResult;
use crate::media::ffmpeg::spawn_ffmpeg;
use crate::recorder::engine::current_platform;

/// The result of a test recording. Mirrors the Electron `TestRecordingResult`
/// (camelCase): on success, the captured file's size + measured signal; on
/// failure, the classified error kind.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/TestRecordingResult.ts")]
#[serde(rename_all = "camelCase")]
pub struct TestRecordingResult {
    /// Whether the test produced a plausible recording.
    pub ok: bool,
    /// The classified failure, when `ok == false`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<TestRecordingError>,
    /// Output file size in bytes, when a file was produced.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub size_bytes: Option<u64>,
    /// Measured signal strength, on success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<TestRecordingSignal>,
}

/// Resolve the platform capture format + the addressable device token for the
/// configured mic name, matching the recorder's avfoundation/dshow model (NOT
/// the Electron wasapi path — the Tauri recorder captures via avfoundation on
/// mac / dshow on Windows). Returns `(format, device)` or `None` when no device
/// matched.
async fn resolve_input(audio_device_name: &str) -> AppResult<Option<(String, String)>> {
    let inv = enumerate_ffmpeg_devices().await?;
    let Some(dev) = find_best_device_match(&inv.audio_inputs, audio_device_name) else {
        return Ok(None);
    };
    let (format, device) = match current_platform() {
        Platform::MacOS | Platform::Linux => {
            // avfoundation audio-only input is ":<index>".
            let idx = dev.index.map(|i| i.to_string()).unwrap_or_default();
            ("avfoundation".to_string(), format!(":{idx}"))
        }
        Platform::Windows => ("dshow".to_string(), format!("audio={}", dev.name)),
    };
    Ok(Some((format, device)))
}

/// Run a ~10 s test capture for the configured mic, returning size + signal.
/// HARDWARE-UNVERIFIED: the spawn/stat/astats path is wired but unproven on a
/// device — only the core argv/classifier decisions are gate-tested.
pub async fn run_test_recording(audio_device_name: &str) -> AppResult<TestRecordingResult> {
    let Some((format, device)) = resolve_input(audio_device_name).await? else {
        return Ok(TestRecordingResult {
            ok: false,
            error: Some(TestRecordingError::DeviceNotFound),
            size_bytes: None,
            signal: None,
        });
    };

    // Capture to a temp file under the OS temp dir (mirrors the Electron
    // `os.tmpdir()/sundayrec-test`). We clean it up best-effort at the end; a
    // crash mid-test leaves at most one small mp3 the OS reaps eventually.
    let tmp_dir = std::env::temp_dir().join("sundayrec-test");
    std::fs::create_dir_all(&tmp_dir)?;
    let out = tmp_dir.join(format!("test_{}.mp3", crate::db::store::now_ms() as u64));
    let out_str = out.to_string_lossy().into_owned();

    // 1. Run the capture. Drain stderr so we can classify a failure.
    let args = build_test_args(&format, &device, &out_str);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut child = spawn_ffmpeg(&arg_refs).await?;
    let mut stderr_buf = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes).await;
        stderr_buf = String::from_utf8_lossy(&bytes).into_owned();
    }
    let status = child.wait().await.ok();

    if !status.map(|s| s.success()).unwrap_or(false) {
        return Ok(TestRecordingResult {
            ok: false,
            error: Some(classify_ffmpeg_error(&stderr_buf)),
            size_bytes: None,
            signal: None,
        });
    }

    // 2. Size sanity floor.
    let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    if !size_is_plausible(size) {
        return Ok(TestRecordingResult {
            ok: false,
            error: Some(TestRecordingError::NoAudio),
            size_bytes: Some(size),
            signal: None,
        });
    }

    // 3. Measure RMS via astats. A parse failure → Normal (don't flag a working
    //    capture as silent), exactly the core's `classify_signal(None)` behaviour.
    let astats_args = build_astats_args(&out_str);
    let astats_refs: Vec<&str> = astats_args.iter().map(String::as_str).collect();
    let signal = match spawn_ffmpeg(&astats_refs).await {
        Ok(mut c) => {
            let mut buf = String::new();
            if let Some(mut stderr) = c.stderr.take() {
                let mut bytes = Vec::new();
                let _ = stderr.read_to_end(&mut bytes).await;
                buf = String::from_utf8_lossy(&bytes).into_owned();
            }
            let _ = c.wait().await;
            classify_signal(parse_strongest_rms(&buf))
        }
        Err(_) => classify_signal(None),
    };

    // Best-effort cleanup — the test file has served its purpose.
    let _ = std::fs::remove_file(&out);

    Ok(TestRecordingResult {
        ok: true,
        error: None,
        size_bytes: Some(size),
        signal: Some(signal),
    })
}
