//! Sunday Bridge deep-link builders (sender side).
//!
//! Hands a finished recording to a sister Sunday-suite app via its
//! `<scheme>://import?…` URL. Today that's SundayEdit (captioning): a recording
//! flows straight into it with `returnTo=sundayrec` so SundayEdit can hand the
//! captions back. This is the pure, testable builder; the `src-tauri` shell
//! opens the URL via the OS.
//!
//! The grammar mirrors SundayEdit's receiving `deeplink.rs` and the platform
//! `sunday-contracts::deeplink::MediaHandoff` contract: `application/
//! x-www-form-urlencoded` component encoding, but spaces as `%20` (never `+`)
//! so they survive the receiver's `+`→space decode. Once the `sunday-contracts`
//! crate is published (git tag), this should converge onto it.

/// The scheme SundayEdit registers for inbound import links.
pub const SUNDAYEDIT_SCHEME: &str = "sundayedit";
/// The scheme SundayStudio registers (podcast/jingle import).
pub const SUNDAYSTUDIO_SCHEME: &str = "sundaystudio";

/// Build a `<scheme>://import?path=<enc>[&returnTo=<enc>]` deep link to hand a
/// media file to a sister app.
pub fn build_import_url(scheme: &str, path: &str, return_to: Option<&str>) -> String {
    let mut url = format!("{scheme}://import?path={}", encode_component(path));
    if let Some(rt) = return_to.filter(|s| !s.is_empty()) {
        url.push_str("&returnTo=");
        url.push_str(&encode_component(rt));
    }
    url
}

/// Percent-encode a URL query-component value: RFC 3986 unreserved chars pass
/// through, everything else (incl. `/`, spaces, non-ASCII) becomes `%XX`.
/// Spaces always encode as `%20`, never `+`.
fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push(hex_digit(b >> 4));
                out.push(hex_digit(b & 0x0f));
            }
        }
    }
    out
}

fn hex_digit(n: u8) -> char {
    match n {
        0..=9 => (b'0' + n) as char,
        _ => (b'A' + (n - 10)) as char,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//   Inbound deep-link parsing / dispatch (receiver side, PU-2)
// ─────────────────────────────────────────────────────────────────────────────
//
// SundayRec registers its own `sundayrec://` scheme so two flows can reach a
// running (or cold-started) instance via the OS:
//   - the Google OAuth redirect could fall back to a custom-scheme deliverer,
//   - a sister app handing captions/edits back (`returnTo=sundayrec`).
// The `src-tauri` shell receives the raw URL string from the deep-link plugin
// and asks [`parse_deep_link`] what to do — keeping the OS plumbing dumb and the
// routing decision unit-tested.

/// The scheme SundayRec itself registers for inbound links.
pub const SUNDAYREC_SCHEME: &str = "sundayrec";

/// What an inbound `sundayrec://…` URL asks the app to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLinkAction {
    /// `sundayrec://oauth?code=…&state=…` — an OAuth redirect delivered via the
    /// custom scheme. Carries the raw query pairs for the existing core
    /// `oauth::parse_loopback_callback` to validate.
    OAuthCallback { query: Vec<(String, String)> },
    /// `sundayrec://import?path=…[&returnTo=…]` — a sister app handed media
    /// (e.g. captions) back to us.
    Import {
        path: String,
        return_to: Option<String>,
    },
    /// `sundayrec://captions?path=<srt>[&recording=<video>]` — SundayEdit
    /// finished captioning a recording we sent it and is handing the subtitle
    /// file back. `path` is the SRT/VTT sidecar; `recording` is the original
    /// recording the captions belong to (so we can write its `.transcript.json`
    /// next to it). `recording` is optional for forward-compatibility — a caller
    /// that omits it leaves the app to resolve which recording to attach to.
    Captions {
        path: String,
        recording: Option<String>,
    },
    /// A recognised scheme but an action we don't route — surface for logging.
    Unknown { host: String },
}

/// Parse an inbound deep link. Returns `None` when the URL isn't ours (wrong
/// scheme) so the shell can ignore it. The "host" is the segment between
/// `sundayrec://` and the `?` (`oauth`, `import`, …); query decoding reuses the
/// same percent-decoding the OAuth callback path relies on.
pub fn parse_deep_link(url: &str) -> Option<DeepLinkAction> {
    let rest = url.strip_prefix("sundayrec://")?;
    let (host, query_str) = match rest.split_once('?') {
        Some((h, q)) => (h.trim_end_matches('/'), q),
        None => (rest.trim_end_matches('/'), ""),
    };
    let pairs = decode_query_pairs(query_str);

    match host {
        "oauth" | "oauth-callback" => Some(DeepLinkAction::OAuthCallback { query: pairs }),
        "import" => {
            let path = pick(&pairs, "path").unwrap_or_default();
            let return_to = pick(&pairs, "returnTo");
            Some(DeepLinkAction::Import { path, return_to })
        }
        "captions" => {
            let path = pick(&pairs, "path").unwrap_or_default();
            let recording = pick(&pairs, "recording");
            Some(DeepLinkAction::Captions { path, recording })
        }
        other => Some(DeepLinkAction::Unknown {
            host: other.to_string(),
        }),
    }
}

/// Find the first non-empty value for `key` in decoded query `pairs`.
fn pick(pairs: &[(String, String)], key: &str) -> Option<String> {
    pairs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
        .filter(|s| !s.is_empty())
}

/// Percent-decode an `application/x-www-form-urlencoded` query string into key/
/// value pairs. `+` decodes to space; `%XX` to its byte; UTF-8 is decoded
/// lossily. Pairs with an empty key are dropped (junk like a bare `?`).
fn decode_query_pairs(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|p| !p.is_empty())
        .filter_map(|pair| {
            let (k, v) = match pair.split_once('=') {
                Some((k, v)) => (k, v),
                None => (pair, ""),
            };
            let key = decode_component(k);
            if key.is_empty() {
                return None;
            }
            Some((key, decode_component(v)))
        })
        .collect()
}

/// Decode one URL component: `+`→space, `%XX`→byte, then UTF-8 (lossy).
fn decode_component(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hi = hex_val(bytes[i + 1]);
                let lo = hex_val(bytes[i + 2]);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    out.push((hi << 4) | lo);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_sundayedit_import_link() {
        let url = build_import_url(
            SUNDAYEDIT_SCHEME,
            "/Users/ola/Opptak 2026.mp4",
            Some("sundayrec"),
        );
        assert_eq!(
            url,
            "sundayedit://import?path=%2FUsers%2Fola%2FOpptak%202026.mp4&returnTo=sundayrec"
        );
    }

    #[test]
    fn omits_return_to_when_absent_or_empty() {
        assert_eq!(
            build_import_url("sundaystudio", "/a.wav", None),
            "sundaystudio://import?path=%2Fa.wav"
        );
        assert_eq!(
            build_import_url("sundaystudio", "/a.wav", Some("")),
            "sundaystudio://import?path=%2Fa.wav"
        );
    }

    #[test]
    fn spaces_are_percent20_not_plus() {
        let url = build_import_url(SUNDAYEDIT_SCHEME, "/a b.mp4", None);
        assert!(url.contains("%20"));
        assert!(!url.contains('+'));
    }

    #[test]
    fn encodes_non_ascii() {
        // æøå must survive as %XX bytes (the receiver decodes UTF-8 lossily).
        let url = build_import_url(SUNDAYEDIT_SCHEME, "/søndag.mp4", None);
        assert!(url.starts_with("sundayedit://import?path=%2Fs"));
        assert!(!url.contains('ø'));
    }

    // ── inbound parse ──────────────────────────────────────────────────────

    #[test]
    fn ignores_links_that_are_not_ours() {
        assert_eq!(parse_deep_link("https://example.com"), None);
        assert_eq!(parse_deep_link("sundayedit://import?path=/a"), None);
    }

    #[test]
    fn parses_an_oauth_callback() {
        let action = parse_deep_link("sundayrec://oauth?code=abc&state=xyz").unwrap();
        assert_eq!(
            action,
            DeepLinkAction::OAuthCallback {
                query: vec![
                    ("code".into(), "abc".into()),
                    ("state".into(), "xyz".into()),
                ]
            }
        );
        // The `oauth-callback` host is an accepted alias.
        assert!(matches!(
            parse_deep_link("sundayrec://oauth-callback?code=c&state=s"),
            Some(DeepLinkAction::OAuthCallback { .. })
        ));
    }

    #[test]
    fn parses_an_import_round_trip_with_our_own_encoder() {
        // A link built by build_import_url must parse back to the same path.
        let url = build_import_url(SUNDAYREC_SCHEME, "/Users/ola/Opptak 2026.mp4", Some("edit"));
        let action = parse_deep_link(&url).unwrap();
        assert_eq!(
            action,
            DeepLinkAction::Import {
                path: "/Users/ola/Opptak 2026.mp4".into(),
                return_to: Some("edit".into()),
            }
        );
    }

    #[test]
    fn import_without_return_to_is_none() {
        let action = parse_deep_link("sundayrec://import?path=%2Fa.mp4").unwrap();
        assert_eq!(
            action,
            DeepLinkAction::Import {
                path: "/a.mp4".into(),
                return_to: None,
            }
        );
    }

    #[test]
    fn unknown_host_is_surfaced_not_dropped() {
        assert_eq!(
            parse_deep_link("sundayrec://wat?x=1"),
            Some(DeepLinkAction::Unknown { host: "wat".into() })
        );
    }

    #[test]
    fn parses_captions_hand_back_with_recording() {
        // SundayEdit hands the SRT back with the original recording path so we
        // can write its `.transcript.json` sidecar.
        let action =
            parse_deep_link("sundayrec://captions?path=%2FUsers%2Fola%2Ftale.srt&recording=%2FUsers%2Fola%2Ftale.mp4")
                .unwrap();
        assert_eq!(
            action,
            DeepLinkAction::Captions {
                path: "/Users/ola/tale.srt".into(),
                recording: Some("/Users/ola/tale.mp4".into()),
            }
        );
    }

    #[test]
    fn parses_captions_without_recording() {
        // A caller may omit the recording; the app resolves which one to attach.
        let action = parse_deep_link("sundayrec://captions?path=%2Fa.srt").unwrap();
        assert_eq!(
            action,
            DeepLinkAction::Captions {
                path: "/a.srt".into(),
                recording: None,
            }
        );
    }

    #[test]
    fn captions_with_spaces_and_non_ascii_round_trip() {
        // %20 for spaces and %C3%B8 for 'ø' must decode (SundayEdit encodes both).
        let action = parse_deep_link(
            "sundayrec://captions?path=%2FUsers%2Fola%2FB%C3%B8nn%20m%C3%B8te.srt\
             &recording=%2FUsers%2Fola%2FB%C3%B8nn%20m%C3%B8te.mp4",
        )
        .unwrap();
        assert_eq!(
            action,
            DeepLinkAction::Captions {
                path: "/Users/ola/Bønn møte.srt".into(),
                recording: Some("/Users/ola/Bønn møte.mp4".into()),
            }
        );
    }

    #[test]
    fn decodes_plus_as_space_and_non_ascii_bytes() {
        // OAuth providers may use `+` for spaces; %C3%B8 is 'ø'.
        let action = parse_deep_link("sundayrec://import?path=a+b%2Fs%C3%B8ndag").unwrap();
        assert_eq!(
            action,
            DeepLinkAction::Import {
                path: "a b/søndag".into(),
                return_to: None,
            }
        );
    }
}
