//! The audio backend — cpal contact with the OS audio layer.
//!
//! Spike A (Phase 0) proves the riskiest VU path end to end: read microphone
//! level in Rust via cpal and push it to React over a Tauri event, so the
//! webview never needs `getUserMedia`.
//!
//!   - [`devices`]     enumerate input devices + capabilities (cpal, for the VU)
//!   - [`device_enum`] real ffmpeg `-list_devices` enumeration (recorder addressing)
//!   - [`vu`]          the VU engine: cpal input stream → `PeakMeters` → `vu://levels`
//!
//! The pure metering math (peak/RMS/dBFS, the lock-free `PeakMeters`) lives in
//! `sundayrec-core::audio` and is fully unit-tested without hardware. The cpal
//! stream in [`vu`] is the only hardware-touching part and is marked
//! HARDWARE-UNVERIFIED until smoke-tested on a real device.

pub mod device_enum;
pub mod devices;
pub mod vu;
