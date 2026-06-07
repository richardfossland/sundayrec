//! The VU metering engine: a cpal input stream feeding the pure `PeakMeters`
//! mat, plus a sampler that emits a `vu://levels` Tauri event ~30×/sec.
//!
//! ⚠️ HARDWARE-UNVERIFIED. The cpal stream construction (`build_vu_stream`) and
//! the worker thread that owns it are the ONE part of this spike that needs real
//! audio hardware, and therefore the part the test suite cannot exercise.
//! Everything compiles and is wired to the (fully tested) `PeakMeters` mat in
//! `sundayrec-core`, but it has not been run against a real microphone in this
//! build. It must be smoke-tested on an actual device before the VU is declared
//! done: open the app, pick a mic, speak, and confirm the bar tracks the voice.
//!
//! Design (mirrors SundayStudio's audio-thread discipline):
//!   - The cpal data callback does ONLY real-time-safe work: per-block peak +
//!     RMS into atomic slots (`PeakMeters`). No locks, no allocation, no I/O.
//!   - cpal's `Stream` is `!Send` on some platforms, so it is built and held on
//!     a dedicated worker thread and never crosses a thread boundary.
//!   - A sampler loop on that same thread reads (and resets) the held levels
//!     ~30×/sec and emits them to the renderer via a Tauri event.
//!   - Start/stop is coordinated with an `AtomicBool` + a `JoinHandle`; the
//!     engine state lives behind a `Mutex` in Tauri-managed state.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
// `Sample` provides the ergonomic `f32::from_sample(s)`; `FromSample` is the bound.
use cpal::{FromSample, Sample};
use sundayrec_core::audio::{PeakMeters, VuLevels};
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};
use crate::util::lock_recover;

/// The Tauri event channel the renderer listens on for live VU snapshots.
pub const VU_EVENT: &str = "vu://levels";

/// How often the sampler reads the meters and emits a snapshot (~30 fps).
const SAMPLE_INTERVAL: Duration = Duration::from_millis(33);

/// A running VU session: the worker thread (owning the cpal stream) plus the
/// stop flag that tells it to wind down.
struct VuSession {
    stop: Arc<AtomicBool>,
    worker: JoinHandle<()>,
}

/// The engine handle stored in Tauri-managed state. At most one session runs at
/// a time; starting again stops the previous one first.
#[derive(Default)]
pub struct VuEngine {
    session: Mutex<Option<VuSession>>,
}

impl VuEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start metering the given input device (or the host default when `None`).
    /// Idempotent in effect: any previous session is stopped first.
    pub async fn start(&self, app: AppHandle, device_name: Option<String>) -> AppResult<()> {
        self.stop();

        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_worker = Arc::clone(&stop);

        // The cpal `Stream` is `!Send`, so it must be built AND owned entirely on
        // this worker thread. Readiness comes back over a `tokio::oneshot` we
        // `.await` (NOT a blocking `recv()`): building the cpal input stream can
        // stall when the mic is momentarily contended (e.g. just after a
        // recording releases it), and a blocking wait there pins a Tauri runtime
        // worker → the whole app beachballs. The async await frees the worker
        // while the cpal thread finishes building. (The worker is a std::thread,
        // so it can send on the oneshot from any thread.)
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<AppResult<()>>();

        let worker = std::thread::Builder::new()
            .name("sundayrec-vu".into())
            .spawn(move || {
                run_vu_worker(app, device_name, stop_for_worker, ready_tx);
            })
            .map_err(|e| AppError::Audio(format!("spawning VU thread: {e}")))?;

        // Wait for the worker to report whether the stream built + started.
        match ready_rx.await {
            Ok(Ok(())) => {
                *lock_recover(&self.session) = Some(VuSession { stop, worker });
                Ok(())
            }
            Ok(Err(e)) => {
                // Worker already returned; join it so we don't leak the thread.
                let _ = worker.join();
                Err(e)
            }
            Err(_) => {
                let _ = worker.join();
                Err(AppError::Audio("VU thread exited before signalling".into()))
            }
        }
    }

    /// Stop the current session, if any. Safe to call when nothing is running.
    pub fn stop(&self) {
        let session = lock_recover(&self.session).take();
        if let Some(session) = session {
            session.stop.store(true, Ordering::Release);
            // The worker checks the flag each tick and then drops the stream.
            let _ = session.worker.join();
        }
    }
}

/// The worker body: build + start the cpal stream, signal readiness, then sample
/// the meters and emit events until asked to stop. Holds the `!Send` stream for
/// its whole lifetime so it never crosses a thread boundary.
fn run_vu_worker(
    app: AppHandle,
    device_name: Option<String>,
    stop: Arc<AtomicBool>,
    ready_tx: tokio::sync::oneshot::Sender<AppResult<()>>,
) {
    let built = build_vu_stream(device_name.as_deref());
    let (stream, meters) = match built {
        Ok(parts) => parts,
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            return;
        }
    };

    if let Err(e) = stream.play() {
        let _ = ready_tx.send(Err(AppError::Audio(format!("starting VU stream: {e}"))));
        return;
    }

    // We're live — unblock the caller.
    let _ = ready_tx.send(Ok(()));

    let channels = meters.channels();
    while !stop.load(Ordering::Acquire) {
        let mut peak_dbfs = Vec::with_capacity(channels);
        let mut rms_dbfs = Vec::with_capacity(channels);
        for ch in 0..channels {
            // `take_dbfs` reads peak; RMS is tracked in its own meter bank below.
            peak_dbfs.push(meters.peak.take_dbfs(ch));
            rms_dbfs.push(meters.rms.take_dbfs(ch));
        }

        // Emit failures (e.g. window closed) just end the loop quietly.
        if app
            .emit(
                VU_EVENT,
                VuLevels {
                    peak_dbfs,
                    rms_dbfs,
                },
            )
            .is_err()
        {
            break;
        }

        std::thread::sleep(SAMPLE_INTERVAL);
    }

    // Dropping `stream` here stops capture and releases the device.
    drop(stream);
}

/// The two atomic meter banks a VU needs: peak (transient) and RMS (energy).
struct VuMeters {
    peak: PeakMeters,
    rms: PeakMeters,
}

impl VuMeters {
    fn channels(&self) -> usize {
        self.peak.channels()
    }
}

/// De-interleave an interleaved f32 block per channel and observe peak + RMS into
/// the meters. Real-time safe: a bounded, allocation-free pass per block (one
/// scalar per channel per callback). Shared by every sample-format path.
fn observe_levels(data: &[f32], chans: usize, m: &VuMeters) {
    if chans == 0 {
        return;
    }
    for ch in 0..chans {
        let mut peak = 0.0_f32;
        let mut sum_sq = 0.0_f64;
        let mut n = 0u64;
        let mut i = ch;
        while i < data.len() {
            let s = data[i];
            if s.is_finite() {
                let a = s.abs();
                if a > peak {
                    peak = a;
                }
                sum_sq += (s as f64) * (s as f64);
                n += 1;
            }
            i += chans;
        }
        m.peak.observe(ch, peak);
        let r = if n == 0 {
            0.0
        } else {
            (sum_sq / n as f64).sqrt() as f32
        };
        m.rms.observe(ch, r);
    }
}

/// Build a VU input stream for sample type `T`, converting each sample to f32 via
/// cpal's `FromSample` so EVERY format (i16/i32/f32/**I24**/u16/…) is handled
/// uniformly — important because pro ASIO/WASAPI devices commonly deliver 24- or
/// 32-bit integer. The scratch buffer is allocated once here, never in the
/// real-time callback.
fn build_vu_stream_typed<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    meters: Arc<VuMeters>,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: cpal::SizedSample,
    f32: FromSample<T>,
{
    let mut scratch: Vec<f32> = Vec::new();
    device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            scratch.clear();
            scratch.reserve(data.len());
            for &s in data {
                scratch.push(f32::from_sample(s));
            }
            observe_levels(&scratch, channels, &meters);
        },
        |e| tracing::error!("VU input stream error: {e}"),
        None,
    )
}

/// Resolve an input device by name (or host default), then build + return a
/// running-capable cpal stream that writes per-block peak/RMS into `VuMeters`.
///
/// ⚠️ HARDWARE-UNVERIFIED — see the module header. This is the only function
/// that touches real audio hardware.
#[allow(deprecated)] // cpal 0.17 deprecates `name()`; it is still the human device
                     // name we match settings against (id()-based identity is a
                     // separate, larger change — see docs/BUILD_ASIO.md TODO).
fn build_vu_stream(device_name: Option<&str>) -> AppResult<(cpal::Stream, Arc<VuMeters>)> {
    let host = cpal::default_host();

    let device = match device_name {
        None => host
            .default_input_device()
            .ok_or_else(|| AppError::Audio("no default input device".into()))?,
        Some(want) => host
            .input_devices()
            .map_err(|e| AppError::Audio(format!("listing input devices: {e}")))?
            .find(|d| d.name().ok().as_deref() == Some(want))
            .ok_or_else(|| AppError::Audio(format!("input device not found: {want}")))?,
    };

    let supported = device
        .default_input_config()
        .map_err(|e| AppError::Audio(format!("querying default input config: {e}")))?;

    let channels = supported.channels() as usize;
    let config: cpal::StreamConfig = supported.config();

    let meters = Arc::new(VuMeters {
        peak: PeakMeters::new(channels),
        rms: PeakMeters::new(channels),
    });

    use cpal::SampleFormat as SF;
    let m = Arc::clone(&meters);
    let stream = match supported.sample_format() {
        SF::I8 => build_vu_stream_typed::<i8>(&device, &config, channels, m),
        SF::I16 => build_vu_stream_typed::<i16>(&device, &config, channels, m),
        SF::I24 => build_vu_stream_typed::<cpal::I24>(&device, &config, channels, m),
        SF::I32 => build_vu_stream_typed::<i32>(&device, &config, channels, m),
        SF::U8 => build_vu_stream_typed::<u8>(&device, &config, channels, m),
        SF::U16 => build_vu_stream_typed::<u16>(&device, &config, channels, m),
        SF::F32 => build_vu_stream_typed::<f32>(&device, &config, channels, m),
        SF::F64 => build_vu_stream_typed::<f64>(&device, &config, channels, m),
        other => {
            return Err(AppError::Audio(format!(
                "unsupported input sample format: {other:?}"
            )))
        }
    }
    .map_err(|e| AppError::Audio(format!("building VU input stream: {e}")))?;

    Ok((stream, meters))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_stop_is_safe_when_idle() {
        // No session running: stop must be a no-op, not a panic/deadlock.
        let engine = VuEngine::new();
        engine.stop();
        engine.stop();
    }

    #[test]
    fn event_name_is_stable() {
        assert_eq!(VU_EVENT, "vu://levels");
    }
}
