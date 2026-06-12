//! Live cue-bridge subscription (Bridge Integration #2, P2b) — **INFRA-UNVERIFIED**.
//!
//! The impure half of the Rec-side live cue bridge. The channel-name derivation,
//! the `LiveEvent` shape, and the event→chapter/state fold all live in the
//! unit-tested [`sundayrec_core::integrations::live_bridge`]. This module owns
//! the side effect: SUBSCRIBING to the SundayStage Supabase Realtime channel
//! `church:{churchId}:service:{serviceId}` and feeding each inbound broadcast
//! through the core fold.
//!
//! ## Feature flag
//!
//! Behind the **default-off `bridge`** cargo feature (pulls `tokio-tungstenite`
//! for the WebSocket). The default build + CI gate carry no WS client; with the
//! feature off, [`subscribe`] returns a clear `feature_disabled` error.
//!
//! ## ⚠️ INFRA-UNVERIFIED
//!
//! The Realtime WebSocket handshake, the channel `phx_join`, and the broadcast
//! frame decoding are wired but unproven — they need a live Supabase project +
//! the Stage app actually publishing. Only the core fold is unit-tested. See
//! docs/SMOKE-TEST.md.

#[cfg(feature = "bridge")]
use sundayrec_core::integrations::live_bridge::LiveBridgeState;
use sundayrec_core::integrations::live_bridge::{self, LiveEvent};

use crate::error::{AppError, AppResult};

/// Resolve the Realtime channel name for a live service, refusing empty ids
/// (the core returns `None`; we surface a validation error so the shell never
/// subscribes to a malformed topic).
pub fn channel_name(church_id: &str, service_id: &str) -> AppResult<String> {
    live_bridge::live_channel_name(church_id, service_id)
        .ok_or_else(|| AppError::Validation("church_id and service_id are required".into()))
}

/// Decode one raw broadcast payload (the JSON Stage published) into a typed
/// [`LiveEvent`]. Pure passthrough so the renderer (or a test) can drive the
/// fold without the WS feature; an unrecognised shape is a validation error.
pub fn decode_event(payload: &str) -> AppResult<LiveEvent> {
    serde_json::from_str::<LiveEvent>(payload)
        .map_err(|e| AppError::Validation(format!("unrecognised live event: {e}")))
}

/// Subscribe to the live cue channel for `service_id` and fold every inbound
/// event into a [`LiveBridgeState`], invoking `on_effect` for each. The
/// `recording_start_ms` seeds the chapter-time origin (may be `None` until the
/// `service.live` event arrives).
///
/// When the `bridge` feature is OFF this returns a clear `feature_disabled` error
/// rather than silently doing nothing.
#[cfg(not(feature = "bridge"))]
pub async fn subscribe(
    _supabase_url: &str,
    _api_key: &str,
    _church_id: &str,
    _service_id: &str,
    _recording_start_ms: Option<i64>,
) -> AppResult<()> {
    Err(AppError::Validation(
        "feature_disabled: the live cue bridge requires a build with `--features bridge`".into(),
    ))
}

/// Subscribe to the live cue channel over Supabase Realtime. INFRA-UNVERIFIED:
/// the WebSocket handshake + `phx_join` + broadcast decoding are wired but
/// unproven against a live backend. Each decoded event is folded through the
/// core; the resulting [`BridgeEffect`](live_bridge::BridgeEffect) is logged
/// (the Tauri-event emit + the chapter-write are the remaining glue — see
/// docs/NEEDS-RICHARD.md).
#[cfg(feature = "bridge")]
pub async fn subscribe(
    supabase_url: &str,
    api_key: &str,
    church_id: &str,
    service_id: &str,
    recording_start_ms: Option<i64>,
) -> AppResult<()> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let topic = format!("realtime:{}", channel_name(church_id, service_id)?);
    // Supabase Realtime endpoint: wss://<ref>.supabase.co/realtime/v1/websocket
    let ws_url = format!(
        "{}/realtime/v1/websocket?apikey={}&vsn=1.0.0",
        supabase_url
            .trim_end_matches('/')
            .replace("https://", "wss://"),
        api_key
    );

    // Bound the WebSocket handshake: a dead/unreachable host must fail fast rather
    // than block the subscribe task forever (the connect has no built-in timeout).
    let connect = tokio_tungstenite::connect_async(&ws_url);
    let (mut ws, _resp) =
        match tokio::time::timeout(std::time::Duration::from_secs(20), connect).await {
            Ok(r) => r.map_err(|e| AppError::Internal(format!("realtime connect: {e}")))?,
            Err(_) => return Err(AppError::Internal("realtime connect timed out".into())),
        };

    // Phoenix channel join frame (Supabase Realtime speaks the Phoenix protocol).
    let join = serde_json::json!({
        "topic": topic,
        "event": "phx_join",
        "payload": { "config": { "broadcast": { "self": false } } },
        "ref": "1"
    });
    ws.send(Message::Text(join.to_string()))
        .await
        .map_err(|e| AppError::Internal(format!("realtime join: {e}")))?;

    let mut state = LiveBridgeState::new(service_id, recording_start_ms);

    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| AppError::Internal(format!("realtime recv: {e}")))?;
        let Message::Text(text) = msg else { continue };
        // Phoenix wraps the broadcast in {topic,event,payload,ref}; the LiveEvent
        // is the inner payload. Be lenient: try the inner payload, then the whole.
        let event = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("payload").cloned())
            .and_then(|p| serde_json::from_value::<LiveEvent>(p).ok())
            .or_else(|| serde_json::from_str::<LiveEvent>(&text).ok());
        let Some(event) = event else { continue };
        let effect = live_bridge::apply_event(&mut state, &event);
        tracing::debug!(
            ?effect,
            sequence = event.sequence(),
            "live cue event folded"
        );
        if matches!(effect, live_bridge::BridgeEffect::Ended) {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_name_requires_both_ids() {
        assert_eq!(
            channel_name("ch1", "svc1").unwrap(),
            "church:ch1:service:svc1"
        );
        assert!(channel_name("", "svc1").is_err());
    }

    #[test]
    fn decode_event_parses_stage_wire_shape() {
        // The canonical LiveEvent shape (sunday-contracts v0.4.0) Stage emits.
        let json = r#"{"type":"now_playing","schema_version":1,"service_id":"s",
            "emitted_at":"2026-05-31T09:00:00Z","sequence":1,
            "song_ref":null,"item_position":null,"title":"Hymn"}"#;
        let e = decode_event(json).unwrap();
        assert_eq!(e.sequence(), 1);
        assert!(decode_event("garbage").is_err());
    }

    #[cfg(not(feature = "bridge"))]
    #[tokio::test]
    async fn subscribe_is_disabled_without_the_feature() {
        let err = subscribe("https://x.supabase.co", "key", "c", "s", None)
            .await
            .unwrap_err();
        assert_eq!(err.code(), "validation");
        assert!(err.to_string().contains("feature_disabled"));
    }
}
