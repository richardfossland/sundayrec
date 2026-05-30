//! Audio commands — input-device discovery and the VU metering engine.
//!
//! Thin IPC layer over `crate::audio`. The renderer calls:
//!   - `list_input_devices` once to populate the mic dropdown,
//!   - `start_vu` / `stop_vu` to drive the live VU, listening for the
//!     `vu://levels` event for the per-channel dB snapshots.

use tauri::{AppHandle, State};

use crate::audio::device_enum::{enumerate_ffmpeg_devices, DeviceInventory};
use crate::audio::devices::{list_input_devices as enumerate_inputs, AudioDeviceList};
use crate::audio::vu::VuEngine;
use crate::error::AppResult;

/// List the available input (microphone) devices for the VU dropdown (cpal).
#[tauri::command]
pub fn list_input_devices() -> AppResult<AudioDeviceList> {
    enumerate_inputs()
}

/// Enumerate the capture devices ffmpeg can see (audio + video), for the F2.1
/// device picker. The recorder addresses these (avfoundation index / dshow name);
/// the VU meter still uses the cpal `list_input_devices` list. See
/// [`crate::audio::device_enum`].
///
/// ⚠️ HARDWARE/GUI-UNVERIFIED — the underlying `ffmpeg -list_devices` spawn needs
/// real devices; only the pure argument/parse helpers are tested.
#[tauri::command]
pub async fn list_devices() -> AppResult<DeviceInventory> {
    enumerate_ffmpeg_devices().await
}

/// Start the VU engine on `device_name` (or the host default when `None`).
/// Streams `vu://levels` events until `stop_vu`. Stops any previous session.
#[tauri::command]
pub fn start_vu(
    app: AppHandle,
    engine: State<'_, VuEngine>,
    device_name: Option<String>,
) -> AppResult<()> {
    engine.start(app, device_name)
}

/// Stop the VU engine. Safe to call when nothing is running.
#[tauri::command]
pub fn stop_vu(engine: State<'_, VuEngine>) -> AppResult<()> {
    engine.stop();
    Ok(())
}
