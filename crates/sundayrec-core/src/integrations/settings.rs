//! Opt-in Sunday-suite integration settings + the shallow-merge patch decision.
//!
//! Pure port of the Electron `IntegrationSettings` shape (src/types/index.ts
//! L584) + the `integrations-set-settings` shallow-merge in
//! `src/main/ipc/integrations.ts`. Everything here is a decision — the actual
//! persistence (a JSON blob under the `integrations` settings key) is the shell's.
//!
//! The whole area is **opt-in**: `enabled` gates it, and each peer (sundayedit /
//! stage / song / plan) carries its own `enabled` so toggling one never enables
//! the others. API keys are NOT stored here — they live in the OS keychain
//! (mirrors the SMTP-password pattern), exactly as in Electron.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The opt-in connection details shared by the Song/Plan flows + the live bridge.
/// Mirrors `IntegrationSettings.connection` (camelCase). No secrets here.
// mirrors src/types/index.ts IntegrationSettings.connection
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(
    export,
    export_to = "../../../src/lib/bindings/IntegrationConnection.ts"
)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationConnection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub church_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub song_api_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_api_url: Option<String>,
}

/// A single peer-app toggle. Mirrors the Electron `{ enabled: boolean }` peers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/PeerToggle.ts")]
#[serde(rename_all = "camelCase")]
pub struct PeerToggle {
    #[serde(default)]
    pub enabled: bool,
}

/// The full opt-in integration settings bag. Mirrors `IntegrationSettings`
/// field-for-field (camelCase). `enabled` is the master opt-in for the area.
// mirrors src/types/index.ts IntegrationSettings
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/IntegrationSettings.ts")]
#[serde(rename_all = "camelCase")]
pub struct IntegrationSettings {
    #[serde(default)]
    pub enabled: bool,
    // `alias = "verbatim"` keeps settings saved under the old working-title key loadable.
    #[serde(default, alias = "verbatim", skip_serializing_if = "Option::is_none")]
    pub sundayedit: Option<PeerToggle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<PeerToggle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub song: Option<PeerToggle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<PeerToggle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<IntegrationConnection>,
}

impl IntegrationSettings {
    /// Whether the `song` flow is fully enabled (master + the song peer).
    pub fn song_enabled(&self) -> bool {
        self.enabled && self.song.map(|p| p.enabled).unwrap_or(false)
    }

    /// Whether the `plan` flow is fully enabled (master + the plan peer).
    pub fn plan_enabled(&self) -> bool {
        self.enabled && self.plan.map(|p| p.enabled).unwrap_or(false)
    }
}

/// Apply a shallow-merge patch onto the current settings, mirroring the Electron
/// `integrations-set-settings` handler (`{ ...current, ...patch }`). A patch
/// field that is `Some` overwrites the current value; a field that is `None`
/// (absent from the patch JSON) leaves the current value untouched — so a
/// renderer toggling one flag can't clobber connection details it didn't send.
///
/// `enabled` is a plain `bool` (not `Option`) on the wire, so the Electron
/// spread always wrote whatever the patch carried. To preserve the "patch can't
/// clobber what it didn't send" guarantee for a partial patch, callers send the
/// patch as a JSON value and we merge object keys; see [`merge_patch_json`] for
/// the JSON-level merge that matches Electron exactly. This typed helper merges
/// the option fields and takes the patch's `enabled` (the common full-object
/// save the renderer does).
pub fn merge_settings(
    current: IntegrationSettings,
    patch: IntegrationSettings,
) -> IntegrationSettings {
    IntegrationSettings {
        enabled: patch.enabled,
        sundayedit: patch.sundayedit.or(current.sundayedit),
        stage: patch.stage.or(current.stage),
        song: patch.song.or(current.song),
        plan: patch.plan.or(current.plan),
        connection: patch.connection.or(current.connection),
    }
}

/// JSON-level shallow merge, matching the Electron `{ ...current, ...patch }`
/// exactly: every top-level key present in `patch` overwrites `current`; keys
/// only in `current` survive. Non-object inputs fall back to the patch (Electron
/// would spread `undefined` into `{}`). This is the authoritative merge the
/// settings handler uses, so a partial patch (e.g. just `{ enabled: true }`)
/// keeps the stored `connection`.
pub fn merge_patch_json(current: &str, patch: &str) -> String {
    let cur: serde_json::Value = serde_json::from_str(current).unwrap_or(serde_json::Value::Null);
    let pat: serde_json::Value = serde_json::from_str(patch).unwrap_or(serde_json::Value::Null);
    match (cur, pat) {
        (serde_json::Value::Object(mut c), serde_json::Value::Object(p)) => {
            for (k, v) in p {
                c.insert(k, v);
            }
            serde_json::Value::Object(c).to_string()
        }
        // A non-object patch wins (mirrors spreading into the object).
        (_, p) => p.to_string(),
    }
}

/// Parse the stored integration-settings JSON blob, falling back to the disabled
/// default for missing/corrupt input (mirrors the Electron `?? DISABLED`).
pub fn parse_settings(json: Option<&str>) -> IntegrationSettings {
    json.and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_settings_defaults_to_disabled() {
        assert!(!parse_settings(None).enabled);
        assert!(!parse_settings(Some("not json")).enabled);
        let s = parse_settings(Some(r#"{"enabled":true}"#));
        assert!(s.enabled);
    }

    #[test]
    fn merge_patch_json_keeps_keys_the_patch_did_not_send() {
        let current = r#"{"enabled":false,"connection":{"churchId":"c1"}}"#;
        let patch = r#"{"enabled":true}"#;
        let merged = merge_patch_json(current, patch);
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["enabled"], serde_json::json!(true));
        // connection survived the partial patch (the Electron guarantee).
        assert_eq!(v["connection"]["churchId"], serde_json::json!("c1"));
    }

    #[test]
    fn merge_patch_json_overwrites_sent_keys() {
        let current = r#"{"connection":{"churchId":"old"}}"#;
        let patch = r#"{"connection":{"churchId":"new"}}"#;
        let v: serde_json::Value = serde_json::from_str(&merge_patch_json(current, patch)).unwrap();
        assert_eq!(v["connection"]["churchId"], serde_json::json!("new"));
    }

    #[test]
    fn song_and_plan_enabled_require_master_plus_peer() {
        let mut s = IntegrationSettings {
            enabled: true,
            song: Some(PeerToggle { enabled: true }),
            ..Default::default()
        };
        assert!(s.song_enabled());
        assert!(!s.plan_enabled());
        // Master off disables everything.
        s.enabled = false;
        assert!(!s.song_enabled());
    }

    #[test]
    fn merge_settings_takes_patch_options_else_keeps_current() {
        let current = IntegrationSettings {
            enabled: false,
            connection: Some(IntegrationConnection {
                church_id: Some("c1".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let patch = IntegrationSettings {
            enabled: true,
            song: Some(PeerToggle { enabled: true }),
            ..Default::default()
        };
        let merged = merge_settings(current, patch);
        assert!(merged.enabled);
        assert!(merged.song.unwrap().enabled);
        // connection survived (patch sent None).
        assert_eq!(merged.connection.unwrap().church_id, Some("c1".to_string()));
    }
}
