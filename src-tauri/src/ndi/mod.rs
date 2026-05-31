//! NDI receiver plumbing (R3 P2c) — **STUB**, default-off `ndi` feature.
//!
//! The NDI architecture (per the Electron `src/main/ndi-receiver.ts`) bridges
//! frames from a network NDI source into the streamer's single ffmpeg via a
//! **loopback TCP socket**: libndi receives frames, a TCP server serves the raw
//! bytes, and ffmpeg reads `tcp://127.0.0.1:<port>` with `-f rawvideo`. The PURE
//! parts — the discovered-source model, the FourCC→pixfmt choice, and the
//! `-f rawvideo …` input-arg builder — live in the unit-tested
//! [`sundayrec_core::ndi`].
//!
//! ## Feature flag + STUB
//!
//! Behind the **default-off `ndi`** cargo feature. The real receiver needs the
//! NDI SDK runtime (libndi) + a native FFI binding + an actual NDI source on the
//! LAN — NONE of which are present in this repo or this environment. So even
//! WITH `--features ndi` the seam is a STUB: [`list_sources`] returns an empty
//! list and [`start_receiver`] returns a clear, actionable error pointing at
//! `docs/NEEDS-RICHARD.md`. The default build returns `feature_disabled`.
//!
//! Wiring the real binding (the FFI crate, the loopback TCP server, the
//! grandiose-equivalent frame pump) is the documented needs-Richard step — the
//! pure decision logic it will lean on is already built + tested.

use sundayrec_core::ndi::{NdiReceiverInfo, NdiSource};

use crate::error::{AppError, AppResult};

/// The clear, stable error every NDI seam call returns until the SDK is bundled.
/// Kept as a constant so the message (and the doc pointer) is identical across
/// entry points and the renderer can match on it.
pub const NDI_NOT_BUNDLED: &str =
    "ndi_not_bundled: NDI SDK not bundled — see docs/NEEDS-RICHARD.md";

#[cfg(not(feature = "ndi"))]
fn disabled<T>(verb: &str) -> AppResult<T> {
    Err(AppError::Validation(format!(
        "feature_disabled: ndi.{verb} requires a build with `--features ndi`"
    )))
}

/// List NDI sources advertising on the LAN. Default build → `feature_disabled`.
#[cfg(not(feature = "ndi"))]
pub async fn list_sources() -> AppResult<Vec<NdiSource>> {
    disabled("listSources")
}

/// List NDI sources. **STUB** (feature-on): the NDI SDK isn't bundled, so there
/// is nothing to discover — returns an empty list rather than erroring, so the
/// overlay UI can show "no NDI sources found" calmly. The real discovery
/// (libndi `find`) is the needs-Richard step.
#[cfg(feature = "ndi")]
pub async fn list_sources() -> AppResult<Vec<NdiSource>> {
    tracing::warn!("[ndi] list_sources called but NDI SDK is not bundled — returning empty");
    Ok(Vec::new())
}

/// Start a loopback-TCP receiver for `source_name`, resolving the frame size +
/// pixel format from the first frame. Default build → `feature_disabled`.
#[cfg(not(feature = "ndi"))]
pub async fn start_receiver(_source_name: &str, _want_alpha: bool) -> AppResult<NdiReceiverInfo> {
    disabled("startReceiver")
}

/// Start a receiver. **STUB** (feature-on): without the NDI SDK there is no
/// libndi to receive frames from, so this returns the clear [`NDI_NOT_BUNDLED`]
/// error pointing at the needs-Richard doc. The real implementation (open the
/// source, bind an ephemeral loopback TCP port, pump frames, resolve the size
/// from the first frame, hand back [`NdiReceiverInfo`] for
/// `sundayrec_core::ndi::build_ndi_input_args`) needs the SDK + a rig.
#[cfg(feature = "ndi")]
pub async fn start_receiver(_source_name: &str, _want_alpha: bool) -> AppResult<NdiReceiverInfo> {
    Err(AppError::Recording(NDI_NOT_BUNDLED.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(feature = "ndi"))]
    #[tokio::test]
    async fn list_sources_is_disabled_without_the_feature() {
        let err = list_sources().await.unwrap_err();
        assert_eq!(err.code(), "validation");
        assert!(err.to_string().contains("feature_disabled"));
    }

    #[cfg(not(feature = "ndi"))]
    #[tokio::test]
    async fn start_receiver_is_disabled_without_the_feature() {
        let err = start_receiver("Studio", false).await.unwrap_err();
        assert!(err.to_string().contains("feature_disabled"));
    }

    #[cfg(feature = "ndi")]
    #[tokio::test]
    async fn stub_list_sources_is_empty_and_start_points_at_needs_richard() {
        assert!(list_sources().await.unwrap().is_empty());
        let err = start_receiver("Studio", false).await.unwrap_err();
        assert!(err.to_string().contains("NDI SDK not bundled"));
        assert!(err.to_string().contains("NEEDS-RICHARD"));
    }
}
