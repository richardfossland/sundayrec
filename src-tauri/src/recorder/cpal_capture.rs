//! Windows cpal capture session — records from a cpal input stream (WASAPI by
//! default, ASIO for pro interfaces) by piping its routed PCM into the existing
//! ffmpeg sidecar.
//!
//! ## Why this exists
//!
//! SundayRec records via an ffmpeg sidecar, and on Windows ffmpeg's only audio
//! input is **dshow** (DirectShow) — an old API that splits pro multichannel
//! interfaces into stereo pairs and is the source of the "works sometimes"
//! Windows instability. ffmpeg has NO WASAPI input and CANNOT do ASIO. So on
//! Windows we capture the audio ourselves with **cpal** (whose Windows host is
//! WASAPI, plus ASIO when built with `--features asio`) and pipe the raw PCM into
//! ffmpeg's `stdin` (`-f f32le -i pipe:0`) — ffmpeg still does ALL encoding/muxing
//! (and, for a video session, the camera via dshow as input 0). The entire
//! downstream pipeline (codecs, containers, history, preview) is unchanged; only
//! the AUDIO SOURCE moves from dshow to cpal.
//!
//! macOS is untouched: ffmpeg `avfoundation` → Core Audio already exposes the
//! aggregate device as one, so the engine keeps its existing path there.
//!
//! ## Architecture (mirrors [`crate::recorder::two_process`]'s self-contained shape)
//!
//! ```text
//!   cpal stream (WASAPI|ASIO) ─(routed f32 PCM)─► ringbuf ─► writer task ─► ffmpeg stdin
//!   (dedicated thread; the Stream is !Send                  (tokio task)        │
//!    so it is built + held on its own thread,                                   ▼
//!    exactly like audio/vu.rs)                                             encode/mux → file
//! ```
//!
//!   - **Stop = EOF on the pipe.** stdin carries PCM, so we CANNOT also send the
//!     `q` graceful-stop nudge; the writer drains the ring, drops `ChildStdin`
//!     (EOF), and ffmpeg finalises the container cleanly.
//!   - **Channel routing + sample conversion in the callback**: the callback
//!     converts ANY sample format to f32 (cpal `from_sample`, so 24-bit pro
//!     devices work) and copies only the chosen channel indices
//!     ([`crate::audio::asio::build_route_plan`]), so the pipe carries exactly the
//!     recorded layout and ffmpeg needs no `pan` filter.
//!
//! ## Scope (the rest falls back to the dshow path)
//!
//! Audio-only AND video+cpal-audio are supported. **Split, reconnect, preroll,
//! live levels and stop-on-silence are NOT** wired on the cpal path (they assume
//! an ffmpeg-managed input / a `q` stop). Manual-max auto-stop IS honoured. A cpal
//! stream error ends the session cleanly (finalise what we have) rather than
//! reconnecting — same honest boundary as the two-process path. When cpal can't
//! START, the engine falls back to the dshow capture automatically (see
//! `engine::start`).
//!
//! ## ⚠️ HARDWARE-UNVERIFIED — Windows only
//!
//! The capture path compiles only under `#[cfg(windows)]` (ASIO host-open under
//! the extra `feature = "asio"`) and can only be exercised on a Windows rig. The
//! pure parts (arg building, channel routing) live in [`sundayrec_core::capture`]
//! / [`crate::audio::asio`] and ARE unit-tested off-Windows. Off-Windows this
//! module is a stub that signals a clear error (never reached — the engine only
//! routes here on Windows).

/// Which cpal host to capture through. WASAPI is the default Windows path
/// (replaces dshow for normal devices); ASIO is the pro-interface path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CpalHostKind {
    Wasapi,
    Asio,
}

#[cfg(windows)]
pub use imp::run_cpal_session;

#[cfg(not(windows))]
#[allow(clippy::too_many_arguments)]
pub async fn run_cpal_session(
    _host_kind: CpalHostKind,
    _app: tauri::AppHandle,
    _pool: Option<sqlx::SqlitePool>,
    _opts: crate::recorder::engine::RecordingOpts,
    _video: Option<sundayrec_core::device_match::FfmpegDevice>,
    _stop_rx: tokio::sync::mpsc::Receiver<()>,
    ready_tx: tokio::sync::oneshot::Sender<crate::error::AppResult<()>>,
    _last_state: std::sync::Arc<std::sync::Mutex<sundayrec_core::recorder::RecorderState>>,
) {
    let _ = ready_tx.send(Err(crate::error::AppError::Recording(
        "cpal capture is only available on Windows".into(),
    )));
}

#[cfg(windows)]
#[allow(deprecated)] // cpal 0.17 deprecates `name()`; still the human device name we match settings against.
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{FromSample, Sample, SampleFormat};
    use sqlx::SqlitePool;
    use sundayrec_core::capture::{build_cpal_pipe_audio_args, build_cpal_pipe_video_args};
    use sundayrec_core::device_match::FfmpegDevice;
    use sundayrec_core::recorder::RecorderState;
    use tauri::{AppHandle, Emitter};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    use super::CpalHostKind;
    use crate::audio::asio::{build_route_plan, route_frame, ChannelRoute};
    use crate::db::store::{insert_recording, RecordingRow};
    use crate::error::{AppError, AppResult};
    use crate::media::ffmpeg::spawn_ffmpeg;
    use crate::recorder::engine::{
        RecorderStatePayload, RecordingEvent, RecordingFinished, RecordingOpts, ERROR_EVENT,
        FINISHED_EVENT, STATE_EVENT,
    };

    /// Ring capacity in f32 samples: ~500 ms of stereo audio at 96 kHz. A generous
    /// cushion so a transient writer/pipe stall never drops samples; on overrun the
    /// callback drops the newest block (and bumps a counter) — it never blocks the
    /// real-time thread.
    const RING_CAPACITY: usize = 96_000;

    /// Open the requested cpal host. WASAPI is always available on Windows; ASIO
    /// only when compiled with `--features asio`.
    fn open_host(kind: CpalHostKind) -> Result<cpal::Host, String> {
        match kind {
            CpalHostKind::Wasapi => cpal::host_from_id(cpal::HostId::Wasapi)
                .map_err(|e| format!("could not open WASAPI host: {e}")),
            CpalHostKind::Asio => {
                #[cfg(feature = "asio")]
                {
                    cpal::host_from_id(cpal::HostId::Asio)
                        .map_err(|e| format!("could not open ASIO host: {e}"))
                }
                #[cfg(not(feature = "asio"))]
                {
                    Err("ASIO support not compiled in (build with --features asio)".to_string())
                }
            }
        }
    }

    /// Find an input device by name (empty → host default).
    fn find_device(host: &cpal::Host, name: &str) -> Result<cpal::Device, String> {
        if name.is_empty() {
            return host
                .default_input_device()
                .ok_or_else(|| "no default input device".to_string());
        }
        host.input_devices()
            .map_err(|e| format!("listing input devices: {e}"))?
            .find(|d| d.name().ok().as_deref() == Some(name))
            .ok_or_else(|| format!("input device not found: {name}"))
    }

    /// The OUTPUT channel count of a route plan (1 mono / 2 stereo).
    fn out_channels(plan: &[ChannelRoute]) -> u8 {
        plan.len() as u8
    }

    /// Probe a device's stream config WITHOUT keeping the (`!Send`) handle: returns
    /// the native sample rate, total input-channel count, and sample format as
    /// plain `Copy` values for building the ffmpeg args. Runs on a blocking thread.
    fn probe_config(
        host_kind: CpalHostKind,
        device_name: &str,
    ) -> AppResult<(u32, u16, SampleFormat)> {
        let host = open_host(host_kind).map_err(AppError::Recording)?;
        let device = find_device(&host, device_name).map_err(AppError::Recording)?;
        let cfg = device
            .default_input_config()
            .map_err(|e| AppError::Recording(format!("querying input config: {e}")))?;
        Ok((cfg.sample_rate(), cfg.channels(), cfg.sample_format()))
    }

    /// Build an input stream for sample type `T`: convert each sample to f32 via
    /// cpal `from_sample` (covers i16/i32/f32/**I24**/u16/…), route the chosen
    /// channels, and push into the ring. `conv` + `scratch` are allocated once here,
    /// never in the real-time callback.
    #[allow(clippy::too_many_arguments)]
    fn build_typed<T>(
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        total: usize,
        plan: Vec<ChannelRoute>,
        mut prod: ringbuf::HeapProd<f32>,
        dropped: Arc<AtomicU64>,
        err_fn: impl FnMut(cpal::StreamError) + Send + 'static,
    ) -> Result<cpal::Stream, cpal::BuildStreamError>
    where
        T: cpal::SizedSample,
        f32: FromSample<T>,
    {
        use ringbuf::traits::Producer;
        let mut conv: Vec<f32> = Vec::with_capacity(4096);
        let mut scratch: Vec<f32> = Vec::with_capacity(4096);
        device.build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                if total == 0 {
                    return;
                }
                conv.clear();
                conv.extend(data.iter().map(|&s| f32::from_sample(s)));
                scratch.clear();
                for frame in conv.chunks_exact(total) {
                    route_frame(&plan, frame, &mut scratch);
                }
                let pushed = prod.push_slice(&scratch);
                if pushed < scratch.len() {
                    dropped.fetch_add((scratch.len() - pushed) as u64, Ordering::Relaxed);
                }
            },
            err_fn,
            None,
        )
    }

    /// The cpal stream thread. Reopens the host (the `!Send` `Stream`/`Device`
    /// never leave this thread, exactly like `audio/vu.rs`), builds + plays the
    /// stream, then parks until `stop` flips and drops it. Reports the build result
    /// through `built_tx` exactly once.
    #[allow(clippy::too_many_arguments)]
    fn stream_thread(
        host_kind: CpalHostKind,
        device_name: String,
        sample_rate: u32,
        total_channels: u16,
        sample_format: SampleFormat,
        plan: Vec<ChannelRoute>,
        prod: ringbuf::HeapProd<f32>,
        stop: Arc<AtomicBool>,
        dropped: Arc<AtomicU64>,
        built_tx: std::sync::mpsc::Sender<Result<(), String>>,
        err_tx: tokio::sync::mpsc::Sender<String>,
    ) {
        let build = (|| -> Result<cpal::Stream, String> {
            let host = open_host(host_kind)?;
            let device = find_device(&host, &device_name)?;
            let config = cpal::StreamConfig {
                channels: total_channels,
                sample_rate, // cpal 0.17: SampleRate is a plain u32
                buffer_size: cpal::BufferSize::Default,
            };
            let total = total_channels as usize;
            // On a device error mid-recording (USB pulled, driver reset) cpal calls
            // this — tell the supervisor so it finalises instead of hanging on a
            // pipe that will never get more data.
            let err_fn = move |e: cpal::StreamError| {
                tracing::error!("cpal input stream error: {e}");
                let _ = err_tx.try_send(e.to_string());
            };

            use cpal::SampleFormat as SF;
            let stream = match sample_format {
                SF::I8 => build_typed::<i8>(&device, &config, total, plan, prod, dropped, err_fn),
                SF::I16 => build_typed::<i16>(&device, &config, total, plan, prod, dropped, err_fn),
                SF::I24 => {
                    build_typed::<cpal::I24>(&device, &config, total, plan, prod, dropped, err_fn)
                }
                SF::I32 => build_typed::<i32>(&device, &config, total, plan, prod, dropped, err_fn),
                SF::U8 => build_typed::<u8>(&device, &config, total, plan, prod, dropped, err_fn),
                SF::U16 => build_typed::<u16>(&device, &config, total, plan, prod, dropped, err_fn),
                SF::F32 => build_typed::<f32>(&device, &config, total, plan, prod, dropped, err_fn),
                SF::F64 => build_typed::<f64>(&device, &config, total, plan, prod, dropped, err_fn),
                other => return Err(format!("unsupported sample format: {other:?}")),
            }
            .map_err(|e| format!("building input stream: {e}"))?;

            stream
                .play()
                .map_err(|e| format!("starting stream: {e}"))?;
            Ok(stream)
        })();

        match build {
            Ok(stream) => {
                let _ = built_tx.send(Ok(()));
                while !stop.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                drop(stream); // stops capture cleanly
            }
            Err(e) => {
                let _ = built_tx.send(Err(e));
            }
        }
    }

    /// Drain the ring into ffmpeg's stdin as little-endian f32 bytes until stop is
    /// requested AND the ring is empty, then drop stdin (EOF) so ffmpeg finalises.
    async fn writer_task(
        mut cons: ringbuf::HeapCons<f32>,
        mut stdin: tokio::process::ChildStdin,
        stop: Arc<AtomicBool>,
    ) {
        use ringbuf::traits::Consumer;
        let mut samples = vec![0.0f32; 8192];
        let mut bytes: Vec<u8> = Vec::with_capacity(8192 * 4);
        loop {
            let n = cons.pop_slice(&mut samples);
            if n > 0 {
                bytes.clear();
                for &s in &samples[..n] {
                    bytes.extend_from_slice(&s.to_le_bytes());
                }
                if stdin.write_all(&bytes).await.is_err() {
                    break; // ffmpeg closed its input (e.g. it died)
                }
            } else if stop.load(Ordering::Relaxed) {
                break; // stop requested and ring drained
            } else {
                tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            }
        }
        let _ = stdin.flush().await;
        drop(stdin); // EOF → ffmpeg flushes + finalises the container
    }

    /// Run a cpal capture session (audio-only OR video+cpal-audio) over the given
    /// host. See the module header for architecture and scope.
    #[allow(clippy::too_many_arguments)]
    pub async fn run_cpal_session(
        host_kind: CpalHostKind,
        app: AppHandle,
        pool: Option<SqlitePool>,
        opts: RecordingOpts,
        video: Option<FfmpegDevice>,
        mut stop_rx: tokio::sync::mpsc::Receiver<()>,
        ready_tx: tokio::sync::oneshot::Sender<AppResult<()>>,
        last_state: Arc<Mutex<RecorderState>>,
    ) {
        let label = match host_kind {
            CpalHostKind::Wasapi => "WASAPI",
            CpalHostKind::Asio => "ASIO",
        };

        // ── Resolve device config + routing (pure once probed) ───────────────
        let device_name = opts.audio_device_name.clone();
        let probe = {
            let name = device_name.clone();
            tokio::task::spawn_blocking(move || probe_config(host_kind, &name)).await
        };
        let (sample_rate, total_channels, sample_format) = match probe {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                let _ = ready_tx.send(Err(e));
                return;
            }
            Err(e) => {
                let _ = ready_tx.send(Err(AppError::Recording(format!("probe task failed: {e}"))));
                return;
            }
        };

        let plan = build_route_plan(
            opts.channel_mode,
            opts.input_channel_l,
            opts.input_channel_r,
            total_channels,
        );
        let out_ch = out_channels(&plan);

        // ── Build ffmpeg args (audio-only or video+pipe) ─────────────────────
        let has_video = video.is_some();
        let args: Vec<String> = match &video {
            Some(v) => build_cpal_pipe_video_args(
                &v.name,
                opts.framerate.max(1),
                sample_rate,
                out_ch,
                &opts.output_path,
                opts.sample_rate,
                opts.bitrate_kbps,
                video_codec_of(&opts),
                None, // live preview wiring deferred for the cpal path
            ),
            None => build_cpal_pipe_audio_args(
                sample_rate,
                out_ch,
                &opts.output_path,
                opts.sample_rate,
                opts.bitrate_kbps,
            ),
        };

        // ── Spawn ffmpeg, take stdin + drain stderr ──────────────────────────
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        tracing::info!(?arg_refs, host = label, device = %device_name, sample_rate, out_ch, ?sample_format, "recorder: cpal capture starting");
        let mut child = match spawn_ffmpeg(&arg_refs).await {
            Ok(c) => c,
            Err(e) => {
                let _ = ready_tx.send(Err(e));
                return;
            }
        };
        let stdin = match child.stdin.take() {
            Some(s) => s,
            None => {
                let _ = child.start_kill();
                let _ = ready_tx.send(Err(AppError::Recording(
                    "ffmpeg gave no stdin pipe for cpal audio".into(),
                )));
                return;
            }
        };
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        let stderr_log = child.stderr.take().map(|s| {
            let tail = Arc::clone(&stderr_tail);
            tauri::async_runtime::spawn(drain_stderr(s, tail))
        });

        // ── Ring + threads ───────────────────────────────────────────────────
        let stop = Arc::new(AtomicBool::new(false));
        let dropped = Arc::new(AtomicU64::new(0));
        let rb = ringbuf::HeapRb::<f32>::new(RING_CAPACITY);
        let (prod, cons) = {
            use ringbuf::traits::Split;
            rb.split()
        };

        let (built_tx, built_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let (err_tx, mut err_rx) = tokio::sync::mpsc::channel::<String>(1);
        let st_name = device_name.clone();
        let st_plan = plan.clone();
        let st_stop = Arc::clone(&stop);
        let st_dropped = Arc::clone(&dropped);
        let stream_handle = std::thread::Builder::new()
            .name("cpal-capture".into())
            .spawn(move || {
                stream_thread(
                    host_kind,
                    st_name,
                    sample_rate,
                    total_channels,
                    sample_format,
                    st_plan,
                    prod,
                    st_stop,
                    st_dropped,
                    built_tx,
                    err_tx,
                )
            });
        let stream_handle = match stream_handle {
            Ok(h) => h,
            Err(e) => {
                let _ = child.start_kill();
                let _ = ready_tx.send(Err(AppError::Recording(format!(
                    "could not spawn cpal capture thread: {e}"
                ))));
                return;
            }
        };

        // Wait for the stream to actually build + play before reporting ready, so a
        // bad device fails the Start call (→ engine falls back to dshow) instead of
        // silently producing nothing.
        match tokio::task::spawn_blocking(move || built_rx.recv()).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                let _ = stream_handle.join();
                let _ = ready_tx.send(Err(AppError::Recording(e)));
                return;
            }
            _ => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                stop.store(true, Ordering::Relaxed);
                let _ = stream_handle.join();
                let _ = ready_tx.send(Err(AppError::Recording(
                    "cpal capture thread exited before signalling".into(),
                )));
                return;
            }
        }

        // Stream is live → start draining into ffmpeg and report ready.
        let writer = tauri::async_runtime::spawn(writer_task(cons, stdin, Arc::clone(&stop)));
        set_state(&app, &last_state, RecorderState::Recording);
        let _ = ready_tx.send(Ok(()));

        // ── Run until stop / auto-stop / device or ffmpeg death ──────────────
        let auto_stop = opts.manual_max_minutes;
        let auto_stop_fut = async {
            if auto_stop == 0 {
                std::future::pending::<()>().await
            } else {
                tokio::time::sleep(std::time::Duration::from_secs(u64::from(auto_stop) * 60)).await
            }
        };
        tokio::pin!(auto_stop_fut);

        tokio::select! {
            _ = stop_rx.recv() => tracing::info!("recorder: cpal — graceful stop requested"),
            _ = &mut auto_stop_fut => tracing::info!("recorder: cpal — manual-max auto-stop"),
            msg = err_rx.recv() => {
                let reason = msg.unwrap_or_else(|| "audio device error".into());
                tracing::warn!(%reason, "recorder: cpal — device error, finalising");
                emit_error(&app, "device_disconnected", &reason);
            }
            status = child.wait() => {
                tracing::warn!(?status, "recorder: cpal — ffmpeg exited unexpectedly");
                let tail = stderr_tail.lock().map(|g| g.clone()).unwrap_or_default();
                emit_error(&app, "ffmpeg_exited", tail.lines().last().unwrap_or("ffmpeg stopped"));
            }
        }

        // ── Tear down: stop stream → writer EOF → ffmpeg finalises ───────────
        set_state(&app, &last_state, RecorderState::Stopping);
        stop.store(true, Ordering::Relaxed);
        let _ = writer.await; // closes stdin (EOF)
        let _ = child.wait().await; // ffmpeg finalises the container
        let _ = stream_handle.join();
        if let Some(h) = stderr_log {
            h.abort();
        }
        let dropped_total = dropped.load(Ordering::Relaxed);
        if dropped_total > 0 {
            tracing::warn!(dropped_total, "recorder: cpal — ring overran, samples dropped");
        }

        // ── History + finished event ─────────────────────────────────────────
        write_history(&pool, &opts.output_path, &device_name).await;
        if tokio::fs::metadata(&opts.output_path)
            .await
            .map(|m| m.len() > 0)
            .unwrap_or(false)
        {
            let _ = app.emit(
                FINISHED_EVENT,
                RecordingFinished {
                    file_path: opts.output_path.clone(),
                    has_video,
                },
            );
        }
        set_state(&app, &last_state, RecorderState::Stopped);
        tracing::info!(host = label, "recorder: cpal session stopped cleanly");
    }

    /// Map the recording opts' video-codec tag to the core enum (H.264 default).
    fn video_codec_of(opts: &RecordingOpts) -> sundayrec_core::editor::VideoCodec {
        if opts.video_codec.eq_ignore_ascii_case("h265") {
            sundayrec_core::editor::VideoCodec::H265
        } else {
            sundayrec_core::editor::VideoCodec::H264
        }
    }

    /// Emit a `recording://state` payload and update the shared last-state mirror.
    /// The cpal path has no reconnects and no armed auto-stop deadline to report.
    fn set_state(app: &AppHandle, last_state: &Arc<Mutex<RecorderState>>, to: RecorderState) {
        if let Ok(mut g) = last_state.lock() {
            *g = to;
        }
        let _ = app.emit(
            STATE_EVENT,
            RecorderStatePayload {
                state: to,
                reconnect_count: 0,
                scheduled_stop_ms: None,
            },
        );
    }

    /// Emit a classified error to the renderer (mirrors `engine::emit_error`).
    fn emit_error(app: &AppHandle, code: &str, message: &str) {
        let _ = app.emit(
            ERROR_EVENT,
            RecordingEvent {
                code: code.to_string(),
                message: message.to_string(),
            },
        );
    }

    /// Best-effort history row for the finished file (None pool / DB error = no-op).
    async fn write_history(pool: &Option<SqlitePool>, final_path: &str, device_name: &str) {
        let byte_size = tokio::fs::metadata(final_path)
            .await
            .map(|m| m.len() as i64)
            .ok();
        let Some(pool) = pool else { return };
        let row = RecordingRow {
            id: String::new(),
            file_path: final_path.to_string(),
            device_name: Some(device_name.to_string()),
            started_at: 0.0,
            duration_ms: None,
            byte_size,
            created_at: 0.0,
            note: None,
        };
        if let Err(e) = insert_recording(pool, row).await {
            tracing::error!("recorder: cpal failed to write history row: {e}");
        }
    }

    /// Drain ffmpeg stderr to the log and keep the last ~2 KB so a failure can
    /// report the real reason (mirrors `two_process::drain_stderr`).
    async fn drain_stderr<R>(stderr: R, tail: Arc<Mutex<String>>)
    where
        R: tokio::io::AsyncRead + Unpin,
    {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::trace!(target: "cpal_ffmpeg", "{line}");
            if let Ok(mut t) = tail.lock() {
                t.push_str(&line);
                t.push('\n');
                if t.len() > 2048 {
                    let mut cut = t.len() - 2048;
                    while cut < t.len() && !t.is_char_boundary(cut) {
                        cut += 1;
                    }
                    *t = t.split_off(cut);
                }
            }
        }
    }
}
