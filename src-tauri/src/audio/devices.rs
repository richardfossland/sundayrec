//! Audio input-device discovery via cpal.
//!
//! The first real contact with the OS audio layer (CoreAudio on macOS, WASAPI
//! on Windows). For the VU spike we only need *inputs* (microphones), but the
//! enumeration helper is direction-agnostic so a later phase can surface outputs
//! cheaply. We summarise each device's capabilities: channel count, supported
//! sample-rate range, and which standard rates fall inside it.
//!
//! Ported in spirit from SundayStudio `audio/devices.rs`.

use cpal::traits::{DeviceTrait, HostTrait};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{AppError, AppResult};

/// Standard sample rates we surface in the UI. A device advertises a *range*;
/// we report which of these well-known rates fall inside it.
const STANDARD_RATES: [u32; 4] = [44_100, 48_000, 88_200, 96_000];

/// One audio device with the capabilities the VU UI needs.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/AudioDevice.ts")]
pub struct AudioDevice {
    /// Human-readable device name as reported by the OS.
    pub name: String,
    /// `"input"` or `"output"`.
    pub direction: String,
    /// Max channel count across the device's supported configs (0 if unknown).
    pub channels: u16,
    /// Standard sample rates (Hz) the device supports.
    pub sample_rates: Vec<u32>,
    /// Whether this is the host's default device for its direction.
    pub is_default: bool,
}

/// The result of enumerating the system's input devices.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/AudioDeviceList.ts")]
pub struct AudioDeviceList {
    /// The cpal host backing this enumeration (e.g. `"CoreAudio"`, `"WASAPI"`).
    pub host: String,
    /// Available input (microphone) devices.
    pub inputs: Vec<AudioDevice>,
}

/// Summarise one device's capabilities. Never fails hard: a device that refuses
/// to report a name or configs is reported with what we could read (defaults of
/// 0 channels / empty rates) rather than aborting the whole enumeration.
#[allow(deprecated)] // cpal 0.17 deprecates `name()`; still the human name we match on.
fn summarise_input(device: &cpal::Device, is_default: bool) -> AudioDevice {
    let name = device
        .name()
        .unwrap_or_else(|_| "Unknown device".to_string());

    // Walk every supported config range, tracking the widest channel count and
    // the union of supported sample-rate ranges.
    let mut max_channels: u16 = 0;
    let mut rate_min = u32::MAX;
    let mut rate_max = 0u32;

    let configs: Vec<cpal::SupportedStreamConfigRange> = device
        .supported_input_configs()
        .map(|c| c.collect())
        .unwrap_or_default();

    for cfg in &configs {
        max_channels = max_channels.max(cfg.channels());
        // cpal 0.17: SampleRate is a plain `u32` (no `.0`).
        rate_min = rate_min.min(cfg.min_sample_rate());
        rate_max = rate_max.max(cfg.max_sample_rate());
    }

    let sample_rates: Vec<u32> = if rate_min == u32::MAX {
        Vec::new()
    } else {
        STANDARD_RATES
            .into_iter()
            .filter(|r| *r >= rate_min && *r <= rate_max)
            .collect()
    };

    AudioDevice {
        name,
        direction: "input".to_string(),
        channels: max_channels,
        sample_rates,
        is_default,
    }
}

/// Enumerate input devices on the default host.
#[allow(deprecated)] // cpal 0.17 deprecates `name()`; still the human name we match on.
pub fn list_input_devices() -> AppResult<AudioDeviceList> {
    let host = cpal::default_host();

    let default_in = host.default_input_device().and_then(|d| d.name().ok());

    let inputs = host
        .input_devices()
        .map_err(|e| AppError::Audio(format!("listing input devices: {e}")))?
        .map(|d| {
            let is_default = d.name().ok().as_deref() == default_in.as_deref();
            summarise_input(&d, is_default)
        })
        .collect();

    Ok(AudioDeviceList {
        host: host.id().name().to_string(),
        inputs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_input_devices_does_not_panic_and_reports_a_host() {
        // CI runners may have zero microphones; the contract is only that the
        // call succeeds and names a host. Device counts are environment-dependent.
        let list = list_input_devices().expect("enumeration should not error");
        assert!(!list.host.is_empty(), "host should be named");
        // Every reported input is tagged as an input.
        for d in &list.inputs {
            assert_eq!(d.direction, "input");
        }
    }

    #[test]
    fn standard_rates_filter_is_within_range() {
        for r in STANDARD_RATES {
            assert!((44_100..=96_000).contains(&r));
        }
    }

    #[test]
    fn audio_device_serde_roundtrip() {
        let d = AudioDevice {
            name: "RØDE NT-USB".to_string(),
            direction: "input".to_string(),
            channels: 2,
            sample_rates: vec![44_100, 48_000],
            is_default: true,
        };
        let json = serde_json::to_string(&d).expect("serialise");
        let back: AudioDevice = serde_json::from_str(&json).expect("deserialise");
        assert_eq!(d, back);
    }
}
