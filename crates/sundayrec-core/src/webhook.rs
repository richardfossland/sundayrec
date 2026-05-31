//! Webhook-notification decisions — pure, GUI-free, network-free.
//!
//! Ports the Electron `src/main/webhook.ts` (the behavioural spec). That module
//! interleaved the *decisions* (URL validation, Slack/Discord detection, the
//! human-readable message shaping, the generic-vs-chat payload choice) with the
//! actual `fetch` POST. Here we keep ONLY the deterministic parts so the body the
//! shell sends is unit-tested without a network: the `src-tauri` `email` seam
//! builds the [`WebhookPayload`], calls [`build_webhook_body`], and POSTs it
//! (NETWORK-UNVERIFIED behind the `email` feature).

use serde::{Deserialize, Serialize};

/// Severity of a webhook notification. Mirrors the Electron `'warn' | 'error'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WebhookSeverity {
    Warn,
    Error,
}

/// The structured notification the generic-JSON branch sends. Mirrors the
/// Electron `WebhookPayload` field-for-field (the `app` is always `SundayRec`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WebhookPayload {
    pub app: String,
    pub church: String,
    pub severity: WebhookSeverity,
    pub category: String,
    pub message: String,
    pub timestamp: String,
}

impl WebhookPayload {
    /// A test payload (the "Send test" button). Mirrors the Electron `test-webhook`
    /// handler's payload: `severity: warn`, `category: device`, a Norwegian body.
    pub fn test(church: &str, timestamp: &str) -> Self {
        Self {
            app: "SundayRec".into(),
            church: if church.is_empty() {
                "untitled".into()
            } else {
                church.into()
            },
            severity: WebhookSeverity::Warn,
            category: "device".into(),
            message: "Test fra SundayRec — webhook fungerer.".into(),
            timestamp: timestamp.into(),
        }
    }
}

/// Whether a webhook URL is well-formed enough to POST to. Mirrors the Electron
/// `/^https?:\/\//i` guard — an empty or non-http(s) URL is rejected (the send
/// then no-ops with `false`).
pub fn is_valid_webhook_url(url: &str) -> bool {
    let lower = url.trim().to_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Whether `url` is a Slack or Discord incoming-webhook endpoint, which take a
/// `{text|content}` chat payload rather than our structured JSON. Mirrors the
/// Electron `/hooks\.slack\.com|discord(app)?\.com\/api\/webhooks/i` test.
pub fn is_chat_webhook(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("hooks.slack.com")
        || lower.contains("discord.com/api/webhooks")
        || lower.contains("discordapp.com/api/webhooks")
}

/// The human-readable one-liner Slack/Discord render. Mirrors the Electron
/// template: a severity glyph + `*SundayRec* (church)`, the `[category] message`,
/// and the italicised timestamp.
pub fn human_message(p: &WebhookPayload) -> String {
    let glyph = match p.severity {
        WebhookSeverity::Error => "⚠️",
        WebhookSeverity::Warn => "ℹ️",
    };
    let church = if p.church.is_empty() {
        "untitled"
    } else {
        &p.church
    };
    format!(
        "{glyph} *SundayRec* ({church})\n[{}] {}\n_{}_",
        p.category, p.message, p.timestamp
    )
}

/// Build the JSON request body for `url` + `payload`. For Slack/Discord URLs this
/// is `{"text": …, "content": …}` (a single body that satisfies either); for any
/// other URL it's the structured payload serialised as-is. Returns `None` when
/// the URL is invalid (the caller then reports the `no_url`/invalid no-op).
pub fn build_webhook_body(url: &str, payload: &WebhookPayload) -> Option<String> {
    if !is_valid_webhook_url(url) {
        return None;
    }
    if is_chat_webhook(url) {
        let human = human_message(payload);
        // Both Slack (`text`) and Discord (`content`) keys present → one body
        // works for either. Serialised manually so the escaping is correct.
        Some(
            serde_json::json!({ "text": human, "content": human }).to_string(),
        )
    } else {
        serde_json::to_string(payload).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> WebhookPayload {
        WebhookPayload::test("Vår Frelsers", "2026-06-01T10:00:00Z")
    }

    #[test]
    fn url_validation() {
        assert!(is_valid_webhook_url("https://example.com/hook"));
        assert!(is_valid_webhook_url("HTTP://example.com"));
        assert!(!is_valid_webhook_url(""));
        assert!(!is_valid_webhook_url("ftp://example.com"));
        assert!(!is_valid_webhook_url("example.com"));
    }

    #[test]
    fn chat_detection() {
        assert!(is_chat_webhook("https://hooks.slack.com/services/T/B/X"));
        assert!(is_chat_webhook("https://discord.com/api/webhooks/1/abc"));
        assert!(is_chat_webhook("https://discordapp.com/api/webhooks/1/abc"));
        assert!(!is_chat_webhook("https://example.com/generic"));
    }

    #[test]
    fn human_message_shape() {
        let h = human_message(&payload());
        assert!(h.contains("*SundayRec* (Vår Frelsers)"));
        assert!(h.contains("[device] Test fra SundayRec"));
        assert!(h.contains("_2026-06-01T10:00:00Z_"));
        assert!(h.starts_with("ℹ️")); // warn glyph
    }

    #[test]
    fn human_message_error_glyph() {
        let mut p = payload();
        p.severity = WebhookSeverity::Error;
        assert!(human_message(&p).starts_with("⚠️"));
    }

    #[test]
    fn body_generic_is_structured_json() {
        let body = build_webhook_body("https://example.com/hook", &payload()).unwrap();
        assert!(body.contains("\"app\":\"SundayRec\""));
        assert!(body.contains("\"category\":\"device\""));
        assert!(body.contains("\"severity\":\"warn\""));
        // not the chat shape
        assert!(!body.contains("\"text\""));
    }

    #[test]
    fn body_chat_has_text_and_content() {
        let body =
            build_webhook_body("https://hooks.slack.com/services/T/B/X", &payload()).unwrap();
        assert!(body.contains("\"text\""));
        assert!(body.contains("\"content\""));
        assert!(body.contains("SundayRec"));
    }

    #[test]
    fn body_none_for_invalid_url() {
        assert!(build_webhook_body("", &payload()).is_none());
        assert!(build_webhook_body("not-a-url", &payload()).is_none());
    }

    #[test]
    fn test_payload_defaults_church() {
        let p = WebhookPayload::test("", "t");
        assert_eq!(p.church, "untitled");
        assert_eq!(p.app, "SundayRec");
    }
}
