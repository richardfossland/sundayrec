//! NDI commands (R3 P2c) — the thin IPC layer over the `crate::ndi` STUB seam.
//!
//! `ndi_list_sources` lets the overlay UI populate an NDI-source picker;
//! `ndi_start_receiver` would resolve a loopback-TCP receiver for the streamer.
//! Both are behind the default-off `ndi` feature: the default build returns
//! `feature_disabled`, and even feature-on the seam is a STUB (the NDI SDK isn't
//! bundled) — list returns empty, start points at docs/NEEDS-RICHARD.md.

use sundayrec_core::ndi::{NdiReceiverInfo, NdiSource};

use crate::error::AppResult;
use crate::ndi as seam;

/// NDI sources currently advertising on the LAN (empty until the SDK is bundled).
#[tauri::command]
pub async fn ndi_list_sources() -> AppResult<Vec<NdiSource>> {
    seam::list_sources().await
}

/// Start a loopback-TCP receiver for one NDI source. STUB until the SDK ships.
#[tauri::command]
pub async fn ndi_start_receiver(
    source_name: String,
    want_alpha: bool,
) -> AppResult<NdiReceiverInfo> {
    seam::start_receiver(&source_name, want_alpha).await
}
