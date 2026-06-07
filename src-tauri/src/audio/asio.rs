//! Windows ASIO device + channel enumeration (Fase 2).
//!
//! The DirectShow/WASAPI path the recorder uses today splits a pro multichannel
//! interface (e.g. a Soundcraft MADI-USB) into several stereo "devices", so you
//! can never address channel 9/10 of a mixer. ASIO exposes the whole interface
//! as ONE device with all its channels — which is exactly what church A/V rigs
//! need. This module enumerates the ASIO host so the picker can list those
//! devices + channels and tag them with a [`AudioBackendKind::Asio`] badge.
//!
//! ## Windows-only, behind a feature
//!
//! Every real ASIO call is `#[cfg(all(target_os = "windows", feature = "asio"))]`.
//! On macOS/Linux, or when the feature is off, the functions return empty/`false`
//! so the rest of the app reads identically on every platform and the recorder
//! falls back to the existing dshow/WASAPI capture automatically. See
//! `docs/BUILD_ASIO.md` for the Windows build env.
//!
//! ## ⚠️ HARDWARE-UNVERIFIED
//!
//! The cpal ASIO calls can only be exercised on a Windows box with an ASIO driver
//! installed (ASIO4ALL is enough for a smoke test). Off-Windows builds compile the
//! stubs; the types + their serde/ts-rs derives are what the unit tests cover.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Standard sample rates we surface in the UI. A device advertises a *range*; we
/// report which of these well-known rates fall inside it. Mirrors the constant in
/// [`crate::audio::devices`].
#[cfg(all(target_os = "windows", feature = "asio"))]
const STANDARD_RATES: [u32; 6] = [44_100, 48_000, 88_200, 96_000, 176_400, 192_000];

/// Which OS audio backend a device is reached through. The frontend renders this
/// as a small badge next to the device name ("ASIO" / "WASAPI" / "CoreAudio") so
/// the user can see they're getting the low-latency multichannel path — the rest
/// of the picker UI is identical across backends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/AudioBackendKind.ts")]
#[serde(rename_all = "lowercase")]
pub enum AudioBackendKind {
    /// Windows ASIO (low-latency, single-device multichannel).
    Asio,
    /// Windows WASAPI / DirectShow (the default Windows fallback).
    Wasapi,
    /// macOS Core Audio.
    CoreAudio,
}

/// One ASIO device with the capabilities the picker needs. `id` and `name` are
/// the same string today (ASIO addresses devices by name); `id` is kept separate
/// so a later backend can use a stabler handle without changing the contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/AsioDevice.ts")]
#[serde(rename_all = "camelCase")]
pub struct AsioDevice {
    /// Stable-ish identifier the recorder addresses (the ASIO device name).
    pub id: String,
    /// Human-readable device name as reported by the driver.
    pub name: String,
    /// Always [`AudioBackendKind::Asio`] — present so the device shares one shape
    /// with any future unified device list.
    pub backend: AudioBackendKind,
    /// Number of input channels the interface exposes under this one device.
    pub input_channels: u16,
    /// Number of output channels (for later playback work; 0 if none).
    pub output_channels: u16,
    /// The device's default/native sample rate (Hz), or 0 if unknown.
    pub default_sample_rate: u32,
    /// Standard sample rates (Hz) the device supports.
    pub supported_sample_rates: Vec<u32>,
}

/// One addressable input channel. `label` is human-readable. cpal reports channel
/// *count*, not per-channel driver names, so v1 labels are `"Input N"`; true
/// driver-supplied names would need the ASIO SDK's `ASIOGetChannelInfo` (TODO).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/AudioChannel.ts")]
#[serde(rename_all = "camelCase")]
pub struct AudioChannel {
    /// 0-based channel index as the recorder addresses it.
    pub index: u16,
    /// Human-readable label, e.g. `"Input 1"`.
    pub label: String,
}

/// Build `["Input 1", "Input 2", …]` channel labels for `n` input channels.
/// Pure + unit-testable; shared by the real and stub paths.
pub fn input_channels_for(count: u16) -> Vec<AudioChannel> {
    (0..count)
        .map(|index| AudioChannel {
            index,
            label: format!("Input {}", index + 1),
        })
        .collect()
}

/// How one OUTPUT channel is produced from the ASIO device's interleaved input
/// frame. The cpal callback applies a `Vec<ChannelRoute>` per frame so the PCM it
/// pushes into the pipe is ALREADY the recorded layout — ffmpeg then needs no
/// `pan` filter (the dshow path's [`sundayrec_core::capture::channel_map_filter`]
/// equivalent, done in the callback for lower latency).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelRoute {
    /// Copy source channel `n` straight through.
    Pick(u16),
    /// Average source channels `a` and `b` (the MonoMix downmix).
    MixHalf(u16, u16),
}

/// Build the per-frame output routing for an ASIO capture from the recording's
/// channel mode + the user's explicit L/R picks, clamped to the device's actual
/// input-channel count. Pure + unit-tested; mirrors the dshow `pan` semantics in
/// [`sundayrec_core::capture::custom_channel_map_filter`]/`channel_map_filter`:
///   - Stereo → two channels (custom L/R picks, else 0 & 1),
///   - MonoL/MonoR → one channel (the picked L resp. R, else 0/1),
///   - MonoMix → one channel averaging 0 & 1.
///
/// Indices that would exceed `total_input_channels` are clamped to the last valid
/// channel so a stale settings pick can never read out of bounds.
pub fn build_route_plan(
    mode: sundayrec_core::settings::ChannelMode,
    input_channel_l: Option<i32>,
    input_channel_r: Option<i32>,
    total_input_channels: u16,
) -> Vec<ChannelRoute> {
    use sundayrec_core::settings::ChannelMode;
    let max = total_input_channels.saturating_sub(1);
    let clamp = |i: i32| -> u16 { (i.max(0) as u16).min(max) };
    let l = clamp(input_channel_l.unwrap_or(0));
    let r = clamp(input_channel_r.unwrap_or(1));
    match mode {
        ChannelMode::Stereo => vec![ChannelRoute::Pick(l), ChannelRoute::Pick(r)],
        ChannelMode::MonoL => vec![ChannelRoute::Pick(l)],
        ChannelMode::MonoR => vec![ChannelRoute::Pick(r)],
        // Mix channels 0 & 1; on a 1-channel device both clamp to 0 (mixes ch0
        // with itself = ch0).
        ChannelMode::MonoMix => vec![ChannelRoute::MixHalf(0, 1u16.min(max))],
    }
}

/// Apply a route plan to one interleaved input frame (`total` source samples),
/// appending the routed output samples to `out`. The real-time cpal callback
/// calls this per frame; it does only arithmetic + pushes (no allocation when
/// `out` is pre-reserved), so it is RT-safe. Pure → unit-tested off-Windows.
pub fn route_frame(plan: &[ChannelRoute], frame: &[f32], out: &mut Vec<f32>) {
    for route in plan {
        let s = match *route {
            ChannelRoute::Pick(n) => frame.get(n as usize).copied().unwrap_or(0.0),
            ChannelRoute::MixHalf(a, b) => {
                let av = frame.get(a as usize).copied().unwrap_or(0.0);
                let bv = frame.get(b as usize).copied().unwrap_or(0.0);
                0.5 * (av + bv)
            }
        };
        out.push(s);
    }
}

/// One entry in the unified, backend-tagged input-device list the picker renders.
/// ASIO devices and the host's cpal (WASAPI/CoreAudio) devices share this one
/// shape so the frontend renders them identically, differing only in the badge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/TaggedAudioInput.ts")]
#[serde(rename_all = "camelCase")]
pub struct TaggedAudioInput {
    /// Identifier the recorder addresses (device name today).
    pub id: String,
    /// Human-readable device name.
    pub name: String,
    /// Which backend this device is reached through (drives the UI badge).
    pub backend: AudioBackendKind,
    /// Number of input channels (drives the L/R channel selector).
    pub input_channels: u16,
    /// Standard sample rates (Hz) the device supports.
    pub sample_rates: Vec<u32>,
    /// Whether this is the host's default device.
    pub is_default: bool,
}

/// The backend kind for the host's non-ASIO cpal devices on this platform:
/// WASAPI on Windows, Core Audio everywhere else.
pub const fn host_backend_kind() -> AudioBackendKind {
    #[cfg(target_os = "windows")]
    {
        AudioBackendKind::Wasapi
    }
    #[cfg(not(target_os = "windows"))]
    {
        AudioBackendKind::CoreAudio
    }
}

/// Merge the ASIO devices with the host's cpal input devices into one tagged
/// list. ASIO devices come FIRST and take precedence: a cpal device whose name
/// matches an ASIO device is dropped, so a pro interface isn't listed twice (once
/// as ASIO, once as its WASAPI stereo-pair shadow). Pure → unit-testable.
pub fn merge_audio_inputs(
    asio: Vec<AsioDevice>,
    cpal: &[crate::audio::devices::AudioDevice],
) -> Vec<TaggedAudioInput> {
    let asio_names: std::collections::HashSet<&str> =
        asio.iter().map(|d| d.name.as_str()).collect();

    let mut out: Vec<TaggedAudioInput> = asio
        .iter()
        .map(|d| TaggedAudioInput {
            id: d.id.clone(),
            name: d.name.clone(),
            backend: AudioBackendKind::Asio,
            input_channels: d.input_channels,
            sample_rates: d.supported_sample_rates.clone(),
            is_default: false,
        })
        .collect();

    let host_backend = host_backend_kind();
    for d in cpal {
        // A WASAPI device names a pro card's stereo pair under the same interface
        // name — skip it when ASIO already exposes that interface in full.
        if asio_names.contains(d.name.as_str()) {
            continue;
        }
        out.push(TaggedAudioInput {
            id: d.name.clone(),
            name: d.name.clone(),
            backend: host_backend,
            input_channels: d.channels,
            sample_rates: d.sample_rates.clone(),
            is_default: d.is_default,
        });
    }
    out
}

// ── Real ASIO enumeration (Windows + feature only) ───────────────────────────
// cpal 0.17: `SampleRate` is a plain `u32` (no `.0`), and `name()` is deprecated
// but is still the human device name we match settings against — hence the
// module-wide `allow(deprecated)`.
#[cfg(all(target_os = "windows", feature = "asio"))]
#[allow(deprecated)]
mod imp {
    use super::*;
    use cpal::traits::{DeviceTrait, HostTrait};

    /// Open the ASIO host. Returns `None` if cpal can't reach an ASIO driver
    /// (none installed / driver error) — the caller then falls back to WASAPI.
    fn asio_host() -> Option<cpal::Host> {
        cpal::host_from_id(cpal::HostId::Asio).ok()
    }

    /// Summarise one ASIO device into an [`AsioDevice`]. Never panics: a device
    /// that refuses to report configs is returned with what we could read.
    fn summarise(device: &cpal::Device) -> AsioDevice {
        let name = device.name().unwrap_or_else(|_| "Unknown ASIO device".to_string());

        let mut input_channels: u16 = 0;
        let mut output_channels: u16 = 0;
        let mut rate_min = u32::MAX;
        let mut rate_max = 0u32;

        if let Ok(configs) = device.supported_input_configs() {
            for cfg in configs {
                input_channels = input_channels.max(cfg.channels());
                rate_min = rate_min.min(cfg.min_sample_rate());
                rate_max = rate_max.max(cfg.max_sample_rate());
            }
        }
        if let Ok(configs) = device.supported_output_configs() {
            for cfg in configs {
                output_channels = output_channels.max(cfg.channels());
            }
        }

        let supported_sample_rates: Vec<u32> = if rate_min == u32::MAX {
            Vec::new()
        } else {
            STANDARD_RATES
                .into_iter()
                .filter(|r| *r >= rate_min && *r <= rate_max)
                .collect()
        };

        let default_sample_rate = device
            .default_input_config()
            .map(|c| c.sample_rate())
            .unwrap_or(0);

        AsioDevice {
            id: name.clone(),
            name,
            backend: AudioBackendKind::Asio,
            input_channels,
            output_channels,
            default_sample_rate,
            supported_sample_rates,
        }
    }

    pub fn list_asio_devices() -> Vec<AsioDevice> {
        let Some(host) = asio_host() else {
            return Vec::new();
        };
        let Ok(devices) = host.devices() else {
            return Vec::new();
        };
        devices.map(|d| summarise(&d)).collect()
    }

    pub fn list_asio_input_channels(device_id: &str) -> Vec<AudioChannel> {
        let Some(host) = asio_host() else {
            return Vec::new();
        };
        let Ok(devices) = host.devices() else {
            return Vec::new();
        };
        for d in devices {
            if d.name().ok().as_deref() == Some(device_id) {
                let count = d
                    .supported_input_configs()
                    .map(|cfgs| cfgs.map(|c| c.channels()).max().unwrap_or(0))
                    .unwrap_or(0);
                return input_channels_for(count);
            }
        }
        Vec::new()
    }

    pub fn is_asio_device(name: &str) -> bool {
        list_asio_devices().iter().any(|d| d.name == name || d.id == name)
    }
}

// ── Stub path (everything else) ──────────────────────────────────────────────
#[cfg(not(all(target_os = "windows", feature = "asio")))]
mod imp {
    use super::*;

    pub fn list_asio_devices() -> Vec<AsioDevice> {
        Vec::new()
    }

    pub fn list_asio_input_channels(_device_id: &str) -> Vec<AudioChannel> {
        Vec::new()
    }

    pub fn is_asio_device(_name: &str) -> bool {
        false
    }
}

/// Enumerate the ASIO input devices visible on this machine. Empty when ASIO is
/// unavailable (non-Windows, feature off, or no driver installed).
pub fn list_asio_devices() -> Vec<AsioDevice> {
    imp::list_asio_devices()
}

/// List the input channels of one ASIO device. Empty if the device is gone or
/// ASIO is unavailable.
pub fn list_asio_input_channels(device_id: &str) -> Vec<AudioChannel> {
    imp::list_asio_input_channels(device_id)
}

/// Whether `name` matches a currently-present ASIO device. Used by the recorder to
/// decide whether to take the ASIO capture path or fall back to dshow/WASAPI.
/// Always `false` when ASIO is unavailable.
pub fn is_asio_device(name: &str) -> bool {
    imp::is_asio_device(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_channels_are_one_based_labels_zero_based_indices() {
        let chans = input_channels_for(3);
        assert_eq!(chans.len(), 3);
        assert_eq!(chans[0], AudioChannel { index: 0, label: "Input 1".into() });
        assert_eq!(chans[2], AudioChannel { index: 2, label: "Input 3".into() });
    }

    #[test]
    fn input_channels_for_zero_is_empty() {
        assert!(input_channels_for(0).is_empty());
    }

    #[test]
    fn enumeration_is_empty_without_asio() {
        // On the CI/dev machines (non-Windows or feature off) the stub returns
        // empty and never panics. On a Windows+asio rig this would be non-empty;
        // the contract here is only "does not panic / sane shape".
        let _ = list_asio_devices();
        let _ = list_asio_input_channels("whatever");
        assert!(!is_asio_device("definitely not a device"));
    }

    #[test]
    fn asio_device_serde_roundtrip() {
        let d = AsioDevice {
            id: "Soundcraft MADI USB".into(),
            name: "Soundcraft MADI USB".into(),
            backend: AudioBackendKind::Asio,
            input_channels: 32,
            output_channels: 32,
            default_sample_rate: 48_000,
            supported_sample_rates: vec![44_100, 48_000, 96_000],
        };
        let json = serde_json::to_string(&d).expect("serialise");
        let back: AsioDevice = serde_json::from_str(&json).expect("deserialise");
        assert_eq!(d, back);
    }

    #[test]
    fn merge_puts_asio_first_and_dedups_wasapi_shadow() {
        use crate::audio::devices::AudioDevice;
        let asio = vec![AsioDevice {
            id: "Soundcraft MADI USB".into(),
            name: "Soundcraft MADI USB".into(),
            backend: AudioBackendKind::Asio,
            input_channels: 32,
            output_channels: 32,
            default_sample_rate: 48_000,
            supported_sample_rates: vec![48_000],
        }];
        let cpal = vec![
            // The same interface, seen by WASAPI as a stereo pair — must be dropped.
            AudioDevice {
                name: "Soundcraft MADI USB".into(),
                direction: "input".into(),
                channels: 2,
                sample_rates: vec![48_000],
                is_default: false,
            },
            // A genuine other device — must be kept.
            AudioDevice {
                name: "USB Audio CODEC".into(),
                direction: "input".into(),
                channels: 2,
                sample_rates: vec![44_100, 48_000],
                is_default: true,
            },
        ];
        let merged = merge_audio_inputs(asio, &cpal);
        assert_eq!(merged.len(), 2, "ASIO + the one genuine WASAPI device");
        assert_eq!(merged[0].backend, AudioBackendKind::Asio);
        assert_eq!(merged[0].name, "Soundcraft MADI USB");
        assert_eq!(merged[0].input_channels, 32);
        assert_eq!(merged[1].name, "USB Audio CODEC");
        assert_eq!(merged[1].backend, host_backend_kind());
        assert!(merged[1].is_default);
    }

    #[test]
    fn merge_with_no_asio_is_just_the_host_list() {
        use crate::audio::devices::AudioDevice;
        let cpal = vec![AudioDevice {
            name: "MacBook Pro-mikrofon".into(),
            direction: "input".into(),
            channels: 1,
            sample_rates: vec![48_000],
            is_default: true,
        }];
        let merged = merge_audio_inputs(Vec::new(), &cpal);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].backend, host_backend_kind());
    }

    #[test]
    fn route_plan_stereo_default_and_custom() {
        use sundayrec_core::settings::ChannelMode;
        // Default stereo on a 32-ch device → channels 0 and 1.
        let p = build_route_plan(ChannelMode::Stereo, None, None, 32);
        assert_eq!(p, vec![ChannelRoute::Pick(0), ChannelRoute::Pick(1)]);
        // Custom picks (mixer channels 8 & 9) flow through.
        let p = build_route_plan(ChannelMode::Stereo, Some(8), Some(9), 32);
        assert_eq!(p, vec![ChannelRoute::Pick(8), ChannelRoute::Pick(9)]);
    }

    #[test]
    fn route_plan_mono_modes() {
        use sundayrec_core::settings::ChannelMode;
        assert_eq!(
            build_route_plan(ChannelMode::MonoL, Some(4), Some(5), 8),
            vec![ChannelRoute::Pick(4)]
        );
        assert_eq!(
            build_route_plan(ChannelMode::MonoR, Some(4), Some(5), 8),
            vec![ChannelRoute::Pick(5)]
        );
        assert_eq!(
            build_route_plan(ChannelMode::MonoMix, None, None, 8),
            vec![ChannelRoute::MixHalf(0, 1)]
        );
    }

    #[test]
    fn route_plan_clamps_out_of_range_picks() {
        use sundayrec_core::settings::ChannelMode;
        // A stale settings pick of channel 30 on a 2-channel device clamps to 1,
        // so the callback can never read out of bounds.
        let p = build_route_plan(ChannelMode::Stereo, Some(30), Some(31), 2);
        assert_eq!(p, vec![ChannelRoute::Pick(1), ChannelRoute::Pick(1)]);
    }

    #[test]
    fn route_frame_picks_and_mixes() {
        // A 4-channel interleaved frame.
        let frame = [0.1f32, 0.2, 0.3, 0.4];
        let mut out = Vec::new();
        // Stereo picking channels 2 & 3.
        route_frame(
            &[ChannelRoute::Pick(2), ChannelRoute::Pick(3)],
            &frame,
            &mut out,
        );
        assert_eq!(out, vec![0.3, 0.4]);
        // MixHalf averages.
        let mut out2 = Vec::new();
        route_frame(&[ChannelRoute::MixHalf(0, 1)], &frame, &mut out2);
        assert!((out2[0] - 0.15).abs() < 1e-6);
        // Out-of-range index yields silence, never a panic.
        let mut out3 = Vec::new();
        route_frame(&[ChannelRoute::Pick(99)], &frame, &mut out3);
        assert_eq!(out3, vec![0.0]);
    }

    #[test]
    fn backend_kind_serialises_lowercase() {
        assert_eq!(
            serde_json::to_string(&AudioBackendKind::Asio).unwrap(),
            "\"asio\""
        );
        assert_eq!(
            serde_json::to_string(&AudioBackendKind::CoreAudio).unwrap(),
            "\"coreaudio\""
        );
    }
}
