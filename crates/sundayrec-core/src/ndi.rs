//! NDI source-discovery model + the pure rawvideo input-arg builder (R3 NDI).
//!
//! Ported from the Electron `src/main/ndi-receiver.ts` + the `buildNdiInputArgs`
//! branch of `overlay.ts`. The NDI architecture bridges frames from a network
//! source into the streamer's single ffmpeg via a **loopback TCP socket**:
//! libndi receives frames, a TCP server serves the raw bytes, and ffmpeg reads
//! `tcp://127.0.0.1:<port>` with `-f rawvideo`.
//!
//! The parts that are PURE — the discovered-source model, picking the ffmpeg
//! pixel format from the delivered FourCC + the alpha request, and building the
//! `-f rawvideo …` input args for a resolved receiver — live here and are unit
//! tested. The libndi binding + the TCP server itself need the NDI runtime + a
//! rig, so they live in the `src-tauri` seam behind the default-off `ndi`
//! feature (a STUB until the SDK is bundled — see docs/NEEDS-RICHARD.md).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A source advertising on the network, as surfaced to the UI. Mirrors the
/// Electron `NdiSourceInfo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/NdiSource.ts")]
#[serde(rename_all = "camelCase")]
pub struct NdiSource {
    /// Full advertised name, e.g. `"STUDIO-PC (ProPresenter Output 1)"`.
    pub name: String,
    /// Resolvable `IP:port` (or a LOCAL HOST marker for same-machine sources).
    pub address: String,
}

/// The ffmpeg rawvideo pixel format we read NDI frames as. UYVY is the smaller,
/// no-alpha 4:2:2 format; BGRA carries the alpha channel (for chroma/alpha-key
/// compositing). Mirrors the Electron `'uyvy422' | 'bgra'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/NdiPixFmt.ts")]
#[serde(rename_all = "lowercase")]
pub enum NdiPixFmt {
    Uyvy422,
    Bgra,
}

impl NdiPixFmt {
    /// The ffmpeg `-pix_fmt` token.
    pub fn ffmpeg_token(self) -> &'static str {
        match self {
            NdiPixFmt::Uyvy422 => "uyvy422",
            NdiPixFmt::Bgra => "bgra",
        }
    }
}

/// NDI FourCC codes we recognise (subset of libndi's set). Used by [`pick_pix_fmt`]
/// to choose the ffmpeg pixel format from what a frame actually delivered.
pub mod fourcc {
    pub const UYVY: u32 = 0x5959_5655; // 'UYVY'
    pub const BGRA: u32 = 0x4152_4742; // 'BGRA'
    pub const BGRX: u32 = 0x5852_4742; // 'BGRX'
}

/// Pick the ffmpeg pixel format from the delivered frame's FourCC, falling back
/// to "what we asked for" (alpha→BGRA, else UYVY) when the FourCC isn't one we
/// know — mirrors the Electron `pickPixFmt`. Preferring the actual FourCC over
/// the request avoids a misaligned colour decode when libndi delivers something
/// other than we asked for.
pub fn pick_pix_fmt(delivered_fourcc: u32, want_alpha: bool) -> NdiPixFmt {
    match delivered_fourcc {
        fourcc::BGRA | fourcc::BGRX => NdiPixFmt::Bgra,
        fourcc::UYVY => NdiPixFmt::Uyvy422,
        _ => {
            if want_alpha {
                NdiPixFmt::Bgra
            } else {
                NdiPixFmt::Uyvy422
            }
        }
    }
}

/// A receiver resolved enough to wire ffmpeg: the loopback port it serves on,
/// the pixel format, the frame size (from the first frame), and the framerate.
/// The renderer-facing mirror of the Electron `ReceiverHandle`'s data fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/NdiReceiverInfo.ts")]
#[serde(rename_all = "camelCase")]
pub struct NdiReceiverInfo {
    /// Loopback TCP port ffmpeg connects to.
    pub port: u16,
    pub pix_fmt: NdiPixFmt,
    pub width: u32,
    pub height: u32,
    /// Best-effort framerate (libndi reports, or a 30 fallback the seam sets).
    pub framerate: u32,
}

/// Build the ffmpeg `-f rawvideo …` input args for a resolved NDI receiver. Pure
/// — mirrors the Electron `buildNdiInputArgs`. `default_framerate` is the
/// stream's base framerate used when the receiver reports `framerate == 0`.
///
/// ffmpeg reads the loopback TCP server the receiver exposes; the receiver
/// pushes raw bytes in the negotiated pixel format, so we must tell ffmpeg the
/// exact size + pixel format (rawvideo carries no header).
pub fn build_ndi_input_args(rt: &NdiReceiverInfo, default_framerate: u32) -> Vec<String> {
    let fr = if rt.framerate == 0 {
        default_framerate
    } else {
        rt.framerate
    };
    vec![
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        rt.pix_fmt.ffmpeg_token().into(),
        "-s".into(),
        format!("{}x{}", rt.width, rt.height),
        "-framerate".into(),
        fr.to_string(),
        "-i".into(),
        format!("tcp://127.0.0.1:{}", rt.port),
    ]
}

/// Filter discovered sources by a (case-insensitive) name substring, the
/// "best match" helper the overlay UI uses to reconcile a saved source name
/// against what's currently advertising. Exact name match wins; otherwise the
/// first case-insensitive substring hit; otherwise `None`.
pub fn match_source<'a>(sources: &'a [NdiSource], wanted: &str) -> Option<&'a NdiSource> {
    let w = wanted.trim();
    if w.is_empty() {
        return None;
    }
    if let Some(exact) = sources.iter().find(|s| s.name == w) {
        return Some(exact);
    }
    let lw = w.to_lowercase();
    sources.iter().find(|s| s.name.to_lowercase().contains(&lw))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rx(port: u16, fmt: NdiPixFmt, w: u32, h: u32, fr: u32) -> NdiReceiverInfo {
        NdiReceiverInfo {
            port,
            pix_fmt: fmt,
            width: w,
            height: h,
            framerate: fr,
        }
    }

    // ── pixel-format selection ──
    #[test]
    fn pix_fmt_follows_delivered_fourcc() {
        assert_eq!(pick_pix_fmt(fourcc::BGRA, false), NdiPixFmt::Bgra);
        assert_eq!(pick_pix_fmt(fourcc::BGRX, false), NdiPixFmt::Bgra);
        assert_eq!(pick_pix_fmt(fourcc::UYVY, true), NdiPixFmt::Uyvy422);
    }

    #[test]
    fn pix_fmt_falls_back_to_alpha_request_for_unknown_fourcc() {
        assert_eq!(pick_pix_fmt(0xDEAD_BEEF, true), NdiPixFmt::Bgra);
        assert_eq!(pick_pix_fmt(0xDEAD_BEEF, false), NdiPixFmt::Uyvy422);
    }

    #[test]
    fn pix_fmt_ffmpeg_tokens() {
        assert_eq!(NdiPixFmt::Uyvy422.ffmpeg_token(), "uyvy422");
        assert_eq!(NdiPixFmt::Bgra.ffmpeg_token(), "bgra");
    }

    // ── input args ──
    #[test]
    fn input_args_match_electron_rawvideo_shape() {
        let args = build_ndi_input_args(&rx(54321, NdiPixFmt::Bgra, 1920, 1080, 50), 30);
        assert_eq!(
            args,
            vec![
                "-f",
                "rawvideo",
                "-pix_fmt",
                "bgra",
                "-s",
                "1920x1080",
                "-framerate",
                "50",
                "-i",
                "tcp://127.0.0.1:54321",
            ]
        );
    }

    #[test]
    fn input_args_fall_back_to_default_framerate_when_zero() {
        let args = build_ndi_input_args(&rx(7000, NdiPixFmt::Uyvy422, 1280, 720, 0), 25);
        assert!(args.windows(2).any(|w| w == ["-framerate", "25"]));
        assert!(args.windows(2).any(|w| w == ["-pix_fmt", "uyvy422"]));
    }

    // ── source matching ──
    #[test]
    fn match_source_prefers_exact_then_substring() {
        let sources = vec![
            NdiSource {
                name: "STUDIO-PC (ProPresenter Output 1)".into(),
                address: "10.0.0.5:5961".into(),
            },
            NdiSource {
                name: "LAPTOP (NDI Scan Converter)".into(),
                address: "10.0.0.7:5962".into(),
            },
        ];
        // exact
        assert_eq!(
            match_source(&sources, "LAPTOP (NDI Scan Converter)")
                .unwrap()
                .address,
            "10.0.0.7:5962"
        );
        // case-insensitive substring
        assert_eq!(
            match_source(&sources, "propresenter").unwrap().address,
            "10.0.0.5:5961"
        );
        // no match
        assert!(match_source(&sources, "OBS").is_none());
        // blank
        assert!(match_source(&sources, "  ").is_none());
    }
}
