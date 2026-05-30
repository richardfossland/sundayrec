//! Pure parsers for ffmpeg's `-list_devices` stderr output.
//!
//! ffmpeg can be asked to *enumerate* (not capture) the OS audio/video devices
//! by passing `-list_devices true` on a capture format (`avfoundation` on macOS,
//! `dshow`/`wasapi` on Windows). It writes the device list to **stderr** and
//! exits non-zero by design (there's no real input to capture) — the caller must
//! NOT treat that exit code as an error (see `src-tauri/.../device_enum.rs`).
//!
//! This module is the behavioural port of the Electron `native-recorder.ts`
//! parsers (`parseWasapiDeviceList` L120, `parseDshowDeviceList` L145,
//! `parseAvfoundationDeviceList` L166, `parseVideoDshowDeviceList` L352,
//! `parseVideoAvfoundationDeviceList` L372, `findBestVideoDeviceMatch` L390),
//! rebuilt as pure `&str → Vec<FfmpegDevice>` functions exercised entirely under
//! `cargo test` with synthetic stderr fixtures — no real ffmpeg, no hardware.
//!
//! Both audio and video devices use the same minimal [`FfmpegDevice`] shape
//! (`{ name, index, format }`) from [`crate::device_match`] — a separate video
//! type would carry the same two fields, so we reuse it and tag the `format`
//! accordingly. The avfoundation index is the device's `[N]` ordinal (the number
//! ffmpeg expects in the `-i ":N"` / `-i "N:..."` address); dshow/wasapi devices
//! are addressed by name, so their `index` is `None` (the enumeration order is
//! irrelevant to capture there).

use crate::device_match::FfmpegDevice;

/// Push `name` as a dshow/wasapi device (addressed by name, no index) unless a
/// device with that exact name is already present. Mirrors the Electron
/// `!devices.find(d => d.name === name)` dedup.
fn push_named_deduped(devices: &mut Vec<FfmpegDevice>, name: &str, format: &str) {
    if !devices.iter().any(|d| d.name == name) {
        devices.push(FfmpegDevice::new(name, format, None));
    }
}

/// Extract the first single-quoted (`'…'`) or double-quoted (`"…"`) substring
/// after a `device #N :` / `Device N:` prefix, case-insensitively. Returns the
/// inner text, trimmed.
///
/// Handles WASAPI Format 1 (`WASAPI input device #0 : 'Name'`) and Format 2/3
/// (`Device 0: 'Name'` / `Device 0: "Name"`), both with optional `#` and any
/// surrounding spacing — the Rust equivalent of the Electron `m1`/`m2` regexes
/// (`/device\s*[#]?\s*\d+\s*:\s*'([^']+)'/i` and the `"…"` variant).
fn parse_device_numbered(line: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    // Find the "device" keyword, then walk past optional spaces, optional '#',
    // spaces, one-or-more digits, spaces, a ':' and spaces, to the quote.
    let kw = lower.find("device")?;
    let bytes = line.as_bytes();
    let mut i = kw + "device".len();
    let skip_ws = |bytes: &[u8], mut i: usize| {
        while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
            i += 1;
        }
        i
    };
    i = skip_ws(bytes, i);
    if i < bytes.len() && bytes[i] == b'#' {
        i += 1;
        i = skip_ws(bytes, i);
    }
    // Require at least one digit (the device number).
    let digit_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == digit_start {
        return None;
    }
    i = skip_ws(bytes, i);
    if i >= bytes.len() || bytes[i] != b':' {
        return None;
    }
    i += 1;
    i = skip_ws(bytes, i);
    // Now expect an opening quote.
    let quote = *bytes.get(i)?;
    if quote != b'\'' && quote != b'"' {
        return None;
    }
    i += 1;
    let rest = &line[i..];
    let end = rest.find(quote as char)?;
    let name = rest[..end].trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// Extract the inner text of the FIRST double-quoted substring on the line, if
/// any. Mirrors the Electron `line.match(/"([^"]+)"/)`.
fn first_double_quoted(line: &str) -> Option<&str> {
    let start = line.find('"')?;
    let rest = &line[start + 1..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

/// Parse a WASAPI device list from ffmpeg stderr.
///
/// Handles all four known ffmpeg WASAPI output shapes (mirrors the Electron
/// `parseWasapiDeviceList`, L120):
///   - Format 1 (ffmpeg 5+): `[wasapi @ …] WASAPI input device #0 : 'Name'`
///   - Format 2 (older):     `[wasapi @ …] Device 0: 'Name'`
///   - Format 3 (dbl-quote): `[wasapi @ …] Device 0: "Name"`
///   - Format 4 (legacy):    `[wasapi @ …] "Name"`
///
/// Lines mentioning `Alternative name` or `@device_` are skipped; legacy `{…}`
/// GUID values are ignored; names are deduped on exact match; `index` is the
/// insertion order (wasapi is addressed by name, so it's informational only).
pub fn parse_wasapi_device_list(stderr: &str) -> Vec<FfmpegDevice> {
    let mut devices: Vec<FfmpegDevice> = Vec::new();
    for line in stderr.lines() {
        if line.contains("Alternative name") || line.contains("@device_") {
            continue;
        }
        // Format 1/2/3: a "device #N : 'Name'" / "Device N: \"Name\"".
        let mut name = parse_device_numbered(line);
        // Format 4 (legacy): a bare `[wasapi @ addr] "Name"` with no number.
        // Only when the numbered form didn't match, and the quoted value is not
        // a `{GUID}` blob (mirrors the Electron `!m3[1].startsWith('{')`).
        if name.is_none() && line.contains("[wasapi") {
            if let Some(q) = first_double_quoted(line) {
                if !q.starts_with('{') && !q.is_empty() {
                    name = Some(q.trim().to_string());
                }
            }
        }
        if let Some(name) = name {
            // Electron guards `name.length > 1`; keep the same minimum so a stray
            // single character can't register as a device.
            if name.chars().count() > 1 {
                push_named_deduped(&mut devices, &name, "wasapi");
            }
        }
    }
    devices
}

/// Parse a DirectShow AUDIO device list from ffmpeg stderr.
///
/// Mirrors the Electron `parseDshowDeviceList` (L145): take the first
/// double-quoted substring per line, skip `Alternative name` lines and names
/// starting with `@` (the dshow "alternative" device path), dedup on name. The
/// `index` is insertion order (dshow is addressed by name).
pub fn parse_dshow_device_list(stderr: &str) -> Vec<FfmpegDevice> {
    let mut devices: Vec<FfmpegDevice> = Vec::new();
    for line in stderr.lines() {
        if line.contains("Alternative name") {
            continue;
        }
        if let Some(name) = first_double_quoted(line) {
            if !name.starts_with('@') {
                push_named_deduped(&mut devices, name, "dshow");
            }
        }
    }
    devices
}

/// Parse an AVFoundation AUDIO device list from ffmpeg stderr.
///
/// Mirrors the Electron `parseAvfoundationDeviceList` (L166): only lines in the
/// **audio** section (between `AVFoundation audio devices` and the next
/// `AVFoundation video devices` header) are considered, so audio and video — both
/// of which restart their `[N]` indexing at 0 — never get their indices mixed.
/// Each `[N] Name` line yields a device whose `index` is `N` (the avfoundation
/// address ffmpeg expects).
pub fn parse_avfoundation_device_list(stderr: &str) -> Vec<FfmpegDevice> {
    parse_avfoundation_section(stderr, AvSection::Audio)
}

/// Parse a DirectShow VIDEO device list from ffmpeg stderr.
///
/// Mirrors the Electron `parseVideoDshowDeviceList` (L352): dshow output starts
/// with the video devices, so we begin "in section" and stop as soon as the
/// `DirectShow audio devices` header appears. Otherwise identical to the audio
/// dshow parser (quoted name, skip `@` and `Alternative name`, dedup).
pub fn parse_video_dshow_device_list(stderr: &str) -> Vec<FfmpegDevice> {
    let mut devices: Vec<FfmpegDevice> = Vec::new();
    let mut in_video = true; // dshow lists video first
    for line in stderr.lines() {
        if line
            .to_ascii_lowercase()
            .contains("directshow audio devices")
        {
            in_video = false;
            continue;
        }
        if !in_video || line.contains("Alternative name") {
            continue;
        }
        if let Some(name) = first_double_quoted(line) {
            if !name.starts_with('@') {
                push_named_deduped(&mut devices, name, "dshow");
            }
        }
    }
    devices
}

/// Parse an AVFoundation VIDEO device list from ffmpeg stderr.
///
/// Mirrors the Electron `parseVideoAvfoundationDeviceList` (L372): only the
/// **video** section (between `AVFoundation video devices` and the next
/// `AVFoundation audio devices` header) is considered. Each `[N] Name` line
/// yields a device whose `index` is `N`.
pub fn parse_video_avfoundation_device_list(stderr: &str) -> Vec<FfmpegDevice> {
    parse_avfoundation_section(stderr, AvSection::Video)
}

/// Which AVFoundation section a parse pass is collecting.
#[derive(Clone, Copy, PartialEq, Eq)]
enum AvSection {
    Audio,
    Video,
}

/// Shared avfoundation section parser: walk the lines tracking which section
/// header we're under, and collect `[N] Name` rows only while inside `want`.
/// Both sections re-index from 0, so the section gating is what keeps audio
/// `[0]` (e.g. the mic) from colliding with video `[0]` (e.g. the webcam).
fn parse_avfoundation_section(stderr: &str, want: AvSection) -> Vec<FfmpegDevice> {
    let mut devices: Vec<FfmpegDevice> = Vec::new();
    let mut current: Option<AvSection> = None;
    for line in stderr.lines() {
        if line.contains("AVFoundation audio devices") {
            current = Some(AvSection::Audio);
            continue;
        }
        if line.contains("AVFoundation video devices") {
            current = Some(AvSection::Video);
            continue;
        }
        if current != Some(want) {
            continue;
        }
        if let Some((index, name)) = parse_indexed_line(line) {
            devices.push(FfmpegDevice::new(name, "avfoundation", Some(index)));
        }
    }
    devices
}

/// Parse an avfoundation `[N] Name` enumeration line into `(N, name)`. Mirrors
/// the Electron `line.match(/\[(\d+)\]\s+(.+)/)`: a bracketed index, whitespace,
/// then the rest of the line as the name (trimmed). Returns `None` for any line
/// that doesn't carry that shape (e.g. the `[AVFoundation indev @ …]` banner,
/// which has no digits-only bracket followed by a name).
fn parse_indexed_line(line: &str) -> Option<(u32, String)> {
    // Scan every `[…]` bracket on the line (a real avfoundation row carries a
    // `[AVFoundation indev @ …]` banner bracket BEFORE the `[N]` index bracket),
    // matching the Electron regex which searches anywhere in the line.
    let mut search = 0;
    while let Some(rel_open) = line[search..].find('[') {
        let open = search + rel_open;
        let after_open = &line[open + 1..];
        let Some(close_rel) = after_open.find(']') else {
            break;
        };
        let inner = &after_open[..close_rel];
        // The bracketed token must be a pure number (`[0]`, `[1]`, …).
        if let Ok(index) = inner.parse::<u32>() {
            // After ']' must come whitespace then a non-empty name.
            let rest = &after_open[close_rel + 1..];
            let trimmed_left = rest.trim_start();
            // Require ≥ 1 whitespace char (the `\s+`) and a non-empty remainder.
            if trimmed_left.len() != rest.len() && !trimmed_left.is_empty() {
                return Some((index, trimmed_left.trim().to_string()));
            }
        }
        // Not the index bracket — advance past this '[' and keep scanning.
        search = open + 1;
    }
    None
}

/// Find the best matching VIDEO device for a stored `name`, applying a 4-step
/// ladder (no brand-word step — cameras don't share the generic USB-audio
/// vocabulary the audio matcher strips). Mirrors the Electron
/// `findBestVideoDeviceMatch` (L390):
///   1. **Exact** (case-insensitive).
///   2. **Stored ⊂ device** name.
///   3. **Device ⊂ stored** name.
///   4. **Word overlap ≥ 2** (prefix-aware, for localisation).
///
/// An empty `name` returns the first device (the OS default). No match → `None`.
pub fn find_best_video_device_match<'a>(
    devices: &'a [FfmpegDevice],
    name: &str,
) -> Option<&'a FfmpegDevice> {
    if name.is_empty() {
        return devices.first();
    }
    let n = name.to_lowercase();

    // 1. Exact.
    if let Some(d) = devices.iter().find(|d| d.name.to_lowercase() == n) {
        return Some(d);
    }
    // 2. Stored is a substring of device.
    if let Some(d) = devices.iter().find(|d| d.name.to_lowercase().contains(&n)) {
        return Some(d);
    }
    // 3. Device is a substring of stored.
    if let Some(d) = devices.iter().find(|d| n.contains(&d.name.to_lowercase())) {
        return Some(d);
    }
    // 4. Word overlap ≥ 2 (prefix-aware).
    let stored_words = video_words(&n);
    devices.iter().find(|d| {
        let dev_words = video_words(&d.name.to_lowercase());
        let overlaps = stored_words
            .iter()
            .filter(|sw| {
                dev_words
                    .iter()
                    .any(|dw| dw.starts_with(sw.as_str()) || sw.starts_with(dw.as_str()))
            })
            .count();
        overlaps >= 2
    })
}

/// Tokenise a (lowercased) device name on the separator class, dropping tokens
/// ≤ 2 chars. Mirrors the Electron `split(/[\s\-()+]+/).filter(w => w.length > 2)`
/// used by `findBestVideoDeviceMatch`.
fn video_words(s: &str) -> Vec<String> {
    s.split([' ', '\t', '\n', '\r', '-', '(', ')', '+'])
        .filter(|w| w.chars().count() > 2)
        .map(|w| w.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── WASAPI (all four formats) ─────────────────────────────────────────────

    #[test]
    fn wasapi_format1_numbered_with_hash() {
        // ffmpeg 5+ shape.
        let stderr = "\
[wasapi @ 000001] WASAPI input device #0 : 'Microphone (Realtek Audio)'
[wasapi @ 000001]   Alternative name '@device_cm_{guid}'
[wasapi @ 000001] WASAPI input device #1 : 'Line In (USB Audio CODEC)'";
        let devs = parse_wasapi_device_list(stderr);
        assert_eq!(devs.len(), 2);
        assert_eq!(devs[0].name, "Microphone (Realtek Audio)");
        assert_eq!(devs[1].name, "Line In (USB Audio CODEC)");
        assert_eq!(devs[0].format, "wasapi");
    }

    #[test]
    fn wasapi_format2_numbered_no_hash_single_quotes() {
        let stderr = "\
[wasapi @ 000001] Device 0: 'Mikrofon (USB Audio)'
[wasapi @ 000001] Device 1: 'Stereo Mix'";
        let devs = parse_wasapi_device_list(stderr);
        assert_eq!(devs.len(), 2);
        assert_eq!(devs[0].name, "Mikrofon (USB Audio)");
        assert_eq!(devs[1].name, "Stereo Mix");
    }

    #[test]
    fn wasapi_format3_numbered_double_quotes() {
        let stderr = "[wasapi @ 000001] Device 0: \"Yamaha AG06\"";
        let devs = parse_wasapi_device_list(stderr);
        assert_eq!(devs.len(), 1);
        assert_eq!(devs[0].name, "Yamaha AG06");
    }

    #[test]
    fn wasapi_format4_legacy_bare_quoted_name() {
        // No device-number prefix; bare `[wasapi @ …] "Name"`. GUID blobs and the
        // alternative-name lines must be skipped.
        let stderr = "\
[wasapi @ 000001] \"Soundcraft USB Audio\"
[wasapi @ 000001] \"{0.0.1.00000000}.{guid}\"
[wasapi @ 000001] Alternative name \"@device_cm_xyz\"";
        let devs = parse_wasapi_device_list(stderr);
        assert_eq!(devs.len(), 1, "GUID + alt-name skipped; got {devs:?}");
        assert_eq!(devs[0].name, "Soundcraft USB Audio");
    }

    #[test]
    fn wasapi_dedups_repeated_names() {
        let stderr = "\
[wasapi @ 1] WASAPI input device #0 : 'Mic'
[wasapi @ 2] WASAPI input device #0 : 'Mic'";
        let devs = parse_wasapi_device_list(stderr);
        assert_eq!(devs.len(), 1);
    }

    #[test]
    fn wasapi_case_insensitive_keyword() {
        // "device" / "Device" / "DEVICE" all match (Electron uses /…/i).
        let stderr = "[wasapi @ 1] DEVICE 0 : 'Loud Mic'";
        let devs = parse_wasapi_device_list(stderr);
        assert_eq!(devs.len(), 1);
        assert_eq!(devs[0].name, "Loud Mic");
    }

    // ── DirectShow audio ──────────────────────────────────────────────────────

    #[test]
    fn dshow_audio_quoted_names_skip_at_and_alt() {
        let stderr = "\
[dshow @ 000001] DirectShow audio devices
[dshow @ 000001]  \"Microphone (USB Audio CODEC)\"
[dshow @ 000001]     Alternative name \"@device_cm_{guid}\\wave_{guid}\"
[dshow @ 000001]  \"@System Mixer\"";
        let devs = parse_dshow_device_list(stderr);
        // "@System Mixer" starts with '@' → skipped; alt-name line skipped.
        assert_eq!(devs.len(), 1, "got {devs:?}");
        assert_eq!(devs[0].name, "Microphone (USB Audio CODEC)");
        assert_eq!(devs[0].format, "dshow");
        assert_eq!(devs[0].index, None);
    }

    #[test]
    fn dshow_audio_dedups() {
        let stderr = "\
[dshow @ 1] \"Mic\"
[dshow @ 2] \"Mic\"";
        assert_eq!(parse_dshow_device_list(stderr).len(), 1);
    }

    // ── AVFoundation audio (section boundaries) ───────────────────────────────

    #[test]
    fn avf_audio_only_reads_audio_section_with_indices() {
        let stderr = "\
[AVFoundation indev @ 0x7f] AVFoundation video devices:
[AVFoundation indev @ 0x7f] [0] FaceTime HD Camera
[AVFoundation indev @ 0x7f] [1] Capture screen 0
[AVFoundation indev @ 0x7f] AVFoundation audio devices:
[AVFoundation indev @ 0x7f] [0] MacBook Pro-mikrofon
[AVFoundation indev @ 0x7f] [1] Soundcraft Signature 12";
        let devs = parse_avfoundation_device_list(stderr);
        assert_eq!(devs.len(), 2, "video rows must not leak in: {devs:?}");
        assert_eq!(devs[0].index, Some(0));
        assert_eq!(devs[0].name, "MacBook Pro-mikrofon");
        assert_eq!(devs[1].index, Some(1));
        assert_eq!(devs[1].name, "Soundcraft Signature 12");
        // The "[AVFoundation indev @ …]" banner is not a [digit] row → ignored.
        assert!(devs.iter().all(|d| d.format == "avfoundation"));
    }

    #[test]
    fn avf_audio_empty_when_no_audio_section() {
        let stderr = "\
[AVFoundation indev @ 0x7f] AVFoundation video devices:
[AVFoundation indev @ 0x7f] [0] FaceTime HD Camera";
        assert!(parse_avfoundation_device_list(stderr).is_empty());
    }

    // ── AVFoundation video (section boundaries) ───────────────────────────────

    #[test]
    fn avf_video_only_reads_video_section() {
        let stderr = "\
[AVFoundation indev @ 0x7f] AVFoundation video devices:
[AVFoundation indev @ 0x7f] [0] FaceTime HD Camera
[AVFoundation indev @ 0x7f] [1] Logitech BRIO
[AVFoundation indev @ 0x7f] AVFoundation audio devices:
[AVFoundation indev @ 0x7f] [0] MacBook Pro-mikrofon";
        let devs = parse_video_avfoundation_device_list(stderr);
        assert_eq!(devs.len(), 2, "audio rows must not leak in: {devs:?}");
        assert_eq!(devs[0].name, "FaceTime HD Camera");
        assert_eq!(devs[0].index, Some(0));
        assert_eq!(devs[1].name, "Logitech BRIO");
        assert_eq!(devs[1].index, Some(1));
    }

    #[test]
    fn avf_audio_and_video_indices_do_not_collide() {
        // Both sections have a [0] device; the parsers must keep them apart.
        let stderr = "\
[AVFoundation indev @ 0x7f] AVFoundation video devices:
[AVFoundation indev @ 0x7f] [0] FaceTime HD Camera
[AVFoundation indev @ 0x7f] AVFoundation audio devices:
[AVFoundation indev @ 0x7f] [0] MacBook Pro-mikrofon";
        let audio = parse_avfoundation_device_list(stderr);
        let video = parse_video_avfoundation_device_list(stderr);
        assert_eq!(audio.len(), 1);
        assert_eq!(audio[0].name, "MacBook Pro-mikrofon");
        assert_eq!(video.len(), 1);
        assert_eq!(video[0].name, "FaceTime HD Camera");
        // Same index number, different devices — proof the section gate works.
        assert_eq!(audio[0].index, Some(0));
        assert_eq!(video[0].index, Some(0));
    }

    // ── DirectShow video (section boundary) ───────────────────────────────────

    #[test]
    fn dshow_video_stops_at_audio_section() {
        let stderr = "\
[dshow @ 000001] DirectShow video devices (some may be both video and audio devices)
[dshow @ 000001]  \"Logitech BRIO\"
[dshow @ 000001]     Alternative name \"@device_pnp_\\\\?\\usb#vid\"
[dshow @ 000001]  \"OBS Virtual Camera\"
[dshow @ 000001] DirectShow audio devices
[dshow @ 000001]  \"Microphone (USB Audio CODEC)\"";
        let devs = parse_video_dshow_device_list(stderr);
        assert_eq!(devs.len(), 2, "audio device must not leak in: {devs:?}");
        assert_eq!(devs[0].name, "Logitech BRIO");
        assert_eq!(devs[1].name, "OBS Virtual Camera");
        // The audio "Microphone …" is past the boundary → excluded.
        assert!(!devs.iter().any(|d| d.name.contains("Microphone")));
    }

    #[test]
    fn dshow_video_skips_at_prefixed_and_dedups() {
        let stderr = "\
[dshow @ 1] DirectShow video devices
[dshow @ 1] \"@odd path device\"
[dshow @ 1] \"Cam\"
[dshow @ 1] \"Cam\"";
        let devs = parse_video_dshow_device_list(stderr);
        assert_eq!(devs.len(), 1);
        assert_eq!(devs[0].name, "Cam");
    }

    // ── find_best_video_device_match (4-step ladder) ──────────────────────────

    #[test]
    fn video_match_exact_case_insensitive() {
        let devs = vec![
            FfmpegDevice::new("FaceTime HD Camera", "avfoundation", Some(0)),
            FfmpegDevice::new("Logitech BRIO", "avfoundation", Some(1)),
        ];
        let got = find_best_video_device_match(&devs, "logitech brio").unwrap();
        assert_eq!(got.name, "Logitech BRIO");
        assert_eq!(got.index, Some(1));
    }

    #[test]
    fn video_match_stored_substring_of_device() {
        let devs = vec![FfmpegDevice::new(
            "Logitech BRIO 4K",
            "avfoundation",
            Some(0),
        )];
        let got = find_best_video_device_match(&devs, "Logitech BRIO").unwrap();
        assert_eq!(got.name, "Logitech BRIO 4K");
    }

    #[test]
    fn video_match_device_substring_of_stored() {
        let devs = vec![FfmpegDevice::new("BRIO", "avfoundation", Some(0))];
        let got = find_best_video_device_match(&devs, "Logitech BRIO 4K Webcam").unwrap();
        assert_eq!(got.name, "BRIO");
    }

    #[test]
    fn video_match_word_overlap_handles_localisation() {
        // English stored name vs OS-localised enumerated name share ≥ 2 distinct
        // words > 2 chars ("logitech" + "brio"); the localised suffix differs.
        let devs = vec![
            FfmpegDevice::new("FaceTime HD-kamera", "avfoundation", Some(0)),
            FfmpegDevice::new("Logitech BRIO webkamera", "avfoundation", Some(1)),
        ];
        let got = find_best_video_device_match(&devs, "Logitech BRIO Webcam").unwrap();
        assert_eq!(got.name, "Logitech BRIO webkamera");
    }

    #[test]
    fn video_match_empty_name_returns_first() {
        let devs = vec![
            FfmpegDevice::new("Cam A", "dshow", None),
            FfmpegDevice::new("Cam B", "dshow", None),
        ];
        assert_eq!(
            find_best_video_device_match(&devs, "").unwrap().name,
            "Cam A"
        );
    }

    #[test]
    fn video_match_no_match_is_none() {
        let devs = vec![FfmpegDevice::new(
            "FaceTime HD Camera",
            "avfoundation",
            Some(0),
        )];
        assert!(find_best_video_device_match(&devs, "Blackmagic Studio 4K").is_none());
    }

    #[test]
    fn video_match_single_word_overlap_is_not_enough() {
        // Only one shared word ("camera") → below the ≥2 threshold → None.
        let devs = vec![FfmpegDevice::new(
            "Razer Kiyo Camera",
            "avfoundation",
            Some(0),
        )];
        assert!(find_best_video_device_match(&devs, "Elgato Facecam Camera").is_none());
    }
}
