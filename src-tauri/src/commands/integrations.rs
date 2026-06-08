//! Sunday-suite integration commands (P2b parity) — the thin IPC layer over
//! `sundayrec_core::integrations`.
//!
//! Mirrors the Electron `src/main/ipc/integrations.ts` handlers: read/patch the
//! opt-in integration settings (stored as a JSON blob under the `integrations`
//! kv key), read a recording's `.service.json` sidecar, the SundaySong API-key
//! keychain slot + usage submission, the SundayPlan fetch/update, and the
//! SundayEdit send/import hand-off. Stage import already lives in
//! `commands::review::stage_import_manifest`.
//!
//! The pure mappers (settings merge, usage-payload shaping, plan metadata/
//! schedule, sundayedit deep link + subtitle parse, sidecar paths) are unit-tested
//! in `sundayrec_core::integrations`. The HTTP submissions + the `sundayedit://`
//! launch are **NETWORK-UNVERIFIED** (they reuse the always-present `reqwest` and
//! the tauri opener — no new dep, no feature gate); they return structured
//! `{ ok, error }` results rather than throwing, exactly like the Electron
//! handlers, so the panel renders a calm hint on failure.

use serde::Serialize;
use tauri::State;

use sundayrec_core::integrations::plan::{
    service_to_metadata, service_to_schedule, PlanMetadata, PlanSchedule, PlanService,
};
use sundayrec_core::integrations::settings::{
    merge_patch_json, parse_settings, IntegrationSettings,
};
use sundayrec_core::integrations::song::build_usage_payloads;
use sundayrec_core::integrations::sundayedit::{
    build_sundayedit_deep_link, subtitles_to_transcript, SundayEditImportOptions,
};
use sundayrec_core::integrations::{service_link_path, transcript_sidecar_path, ServiceLink};

use crate::db::store::{get_setting, now_ms, set_setting};
use crate::db::Db;
use crate::error::AppResult;
use crate::secrets::{self, SecretProvider};

const INTEGRATIONS_KEY: &str = "integrations";

/// A structured `{ ok, error?, ... }` result, mirroring the Electron handlers
/// (which return objects, never throw, so the renderer always gets a shape).
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submitted: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
}

impl OpResult {
    fn err(code: &str) -> Self {
        OpResult {
            ok: false,
            error: Some(code.into()),
            ..Default::default()
        }
    }
}

/// Read the stored integration settings (the disabled default when unset/corrupt).
#[tauri::command]
pub async fn integrations_get_settings(db: State<'_, Db>) -> AppResult<IntegrationSettings> {
    let raw = get_setting(&db.pool, INTEGRATIONS_KEY).await?;
    Ok(parse_settings(raw.as_deref()))
}

/// Shallow-merge a patch into the stored integration settings (so a renderer
/// toggling one flag can't clobber connection details it didn't send). Returns
/// the merged settings. Mirrors `integrations-set-settings`.
#[tauri::command]
pub async fn integrations_set_settings(
    db: State<'_, Db>,
    patch: serde_json::Value,
) -> AppResult<IntegrationSettings> {
    let current = get_setting(&db.pool, INTEGRATIONS_KEY)
        .await?
        .unwrap_or_else(|| "{}".into());
    let patch_str = patch.to_string();
    let merged = merge_patch_json(&current, &patch_str);
    set_setting(&db.pool, INTEGRATIONS_KEY, &merged).await?;
    Ok(parse_settings(Some(&merged)))
}

/// Read a recording's `.service.json` service link, or `null`. Never errors — a
/// missing / corrupt sidecar is just "no link". Mirrors `integrations-get-service-link`.
#[tauri::command]
pub fn integrations_get_service_link(recording_path: String) -> Option<ServiceLink> {
    if recording_path.is_empty() {
        return None;
    }
    let path = service_link_path(&recording_path);
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<ServiceLink>(&raw).ok()
}

// ── SundaySong usage / licensing ─────────────────────────────────────────────

/// Store (replace) the encrypted SundaySong/Plan API key in the keychain.
#[tauri::command]
pub fn integrations_song_set_apikey(plaintext: String) -> AppResult<()> {
    secrets::set(SecretProvider::SongApiKey, &plaintext)
}

/// Whether a SundaySong API key is stored.
#[tauri::command]
pub fn integrations_song_has_apikey() -> bool {
    secrets::has(SecretProvider::SongApiKey)
}

/// Submit usage for a recording that has a `.service.json` sidecar. Builds one
/// payload per song (the pure `build_usage_payloads`) and POSTs each to
/// `<songApiUrl>/v1/usage/log`. NETWORK-UNVERIFIED. Returns a structured result.
#[tauri::command]
pub async fn integrations_song_submit_usage(
    db: State<'_, Db>,
    recording_path: String,
) -> AppResult<OpResult> {
    if recording_path.is_empty() {
        return Ok(OpResult::err("invalid_path"));
    }
    let settings = parse_settings(get_setting(&db.pool, INTEGRATIONS_KEY).await?.as_deref());
    if !settings.song_enabled() {
        return Ok(OpResult::err("disabled"));
    }
    let link = match integrations_get_service_link(recording_path) {
        Some(l) => l,
        None => {
            return Ok(OpResult {
                ok: false,
                error: Some("no_service_link".into()),
                hint: Some("Import Stage-kapitler first or link manually.".into()),
                ..Default::default()
            })
        }
    };
    let connection = settings.connection.clone().unwrap_or_default();
    let payloads = build_usage_payloads(&link, &connection);
    if payloads.is_empty() {
        return Ok(OpResult {
            ok: false,
            error: Some("no_songs".into()),
            hint: Some("No church_id or empty setlist.".into()),
            ..Default::default()
        });
    }
    let base_url = connection
        .song_api_url
        .clone()
        .unwrap_or_else(|| "https://api.sundaysong.com".into());
    let api_key = secrets::get(SecretProvider::SongApiKey);

    // NETWORK-UNVERIFIED: best-effort POST per payload; a 409 (duplicate
    // idempotency key) counts as already-submitted, matching the Electron path.
    let client = reqwest::Client::new();
    let mut submitted = 0usize;
    let mut errors = 0usize;
    for payload in &payloads {
        let mut req = client
            .post(format!("{base_url}/v1/usage/log"))
            .json(payload)
            .timeout(std::time::Duration::from_secs(15));
        if let Some(key) = api_key.as_deref() {
            req = req.bearer_auth(key);
        }
        match req.send().await {
            Ok(r) if r.status().is_success() || r.status().as_u16() == 409 => submitted += 1,
            _ => errors += 1,
        }
    }
    Ok(OpResult {
        ok: errors == 0,
        submitted: Some(submitted),
        ..Default::default()
    })
}

// ── SundayPlan ───────────────────────────────────────────────────────────────

/// A fetched Plan service enriched with the derived metadata + schedule. Mirrors
/// the Electron `services.map(s => ({ ...s, _meta, _schedule }))`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanServiceView {
    #[serde(flatten)]
    pub service: PlanService,
    pub meta: PlanMetadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule: Option<PlanSchedule>,
}

/// The result of a Plan fetch. Mirrors the Electron `{ ok, services } | { ok:false, error }`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFetchResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub services: Option<Vec<PlanServiceView>>,
}

/// Fetch upcoming Plan services from `<planApiUrl>/rest/v1/service`, enriching
/// each with derived metadata + a schedule slot (the pure mappers). The UTC→local
/// conversion for the schedule uses the host local offset. NETWORK-UNVERIFIED.
#[tauri::command]
pub async fn integrations_plan_fetch_services(
    db: State<'_, Db>,
    from_iso: Option<String>,
) -> AppResult<PlanFetchResult> {
    let settings = parse_settings(get_setting(&db.pool, INTEGRATIONS_KEY).await?.as_deref());
    let plan_ready = settings.plan_enabled();
    let connection = settings.connection.clone().unwrap_or_default();
    let Some(base_url) = connection.plan_api_url.clone().filter(|u| !u.is_empty()) else {
        return Ok(PlanFetchResult {
            ok: false,
            error: Some("plan_not_ready".into()),
            services: None,
        });
    };
    if !plan_ready {
        return Ok(PlanFetchResult {
            ok: false,
            error: Some("plan_not_ready".into()),
            services: None,
        });
    }
    let Some(church_id) = connection.church_id.clone().filter(|c| !c.is_empty()) else {
        return Ok(PlanFetchResult {
            ok: false,
            error: Some("no_church_id".into()),
            services: None,
        });
    };

    let from = from_iso.unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let url = format!(
        "{base_url}/rest/v1/service?church_id=eq.{}&starts_at_utc=gte.{}&order=starts_at_utc.asc&limit=30",
        urlencoding(&church_id),
        urlencoding(&from)
    );
    let client = reqwest::Client::new();
    let mut req = client
        .get(&url)
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(15));
    if let Some(key) = secrets::get(SecretProvider::SongApiKey) {
        req = req.bearer_auth(key);
    }
    let services: Vec<PlanService> = match req.send().await {
        Ok(r) if r.status().is_success() => r.json().await.unwrap_or_default(),
        Ok(r) => {
            return Ok(PlanFetchResult {
                ok: false,
                error: Some(format!("Plan API {}", r.status().as_u16())),
                services: None,
            })
        }
        Err(e) => {
            return Ok(PlanFetchResult {
                ok: false,
                error: Some(e.to_string()),
                services: None,
            })
        }
    };

    let views = services
        .into_iter()
        .map(|s| {
            let meta = service_to_metadata(&s);
            // UTC→local schedule: parse the ISO, convert to local naive time.
            let schedule = chrono::DateTime::parse_from_rfc3339(&s.starts_at_utc)
                .ok()
                .map(|dt| dt.with_timezone(&chrono::Local).naive_local())
                .map(|local| service_to_schedule(&s, local));
            PlanServiceView {
                service: s,
                meta,
                schedule,
            }
        })
        .collect();
    Ok(PlanFetchResult {
        ok: true,
        error: None,
        services: Some(views),
    })
}

/// Write the streaming flag + optional recording URL back to a Plan service.
/// NETWORK-UNVERIFIED. Returns a structured result.
#[tauri::command]
pub async fn integrations_plan_update_service(
    db: State<'_, Db>,
    service_id: String,
    was_streamed: Option<bool>,
    recording_url: Option<String>,
) -> AppResult<OpResult> {
    let settings = parse_settings(get_setting(&db.pool, INTEGRATIONS_KEY).await?.as_deref());
    let connection = settings.connection.clone().unwrap_or_default();
    let Some(base_url) = connection.plan_api_url.clone().filter(|u| !u.is_empty()) else {
        return Ok(OpResult::err("plan_not_ready"));
    };
    if !settings.plan_enabled() {
        return Ok(OpResult::err("plan_not_ready"));
    }
    if service_id.is_empty() {
        return Ok(OpResult::err("invalid_id"));
    }
    let mut body = serde_json::Map::new();
    if let Some(s) = was_streamed {
        body.insert("was_streamed_flag".into(), serde_json::json!(s));
    }
    if let Some(u) = recording_url.filter(|u| !u.is_empty()) {
        body.insert("recording_url".into(), serde_json::json!(u));
    }
    let url = format!(
        "{base_url}/rest/v1/service?id=eq.{}",
        urlencoding(&service_id)
    );
    let client = reqwest::Client::new();
    let mut req = client
        .patch(&url)
        .header("Prefer", "return=minimal")
        .json(&serde_json::Value::Object(body))
        .timeout(std::time::Duration::from_secs(15));
    if let Some(key) = secrets::get(SecretProvider::SongApiKey) {
        req = req.bearer_auth(key);
    }
    match req.send().await {
        Ok(r) if r.status().is_success() => Ok(OpResult {
            ok: true,
            ..Default::default()
        }),
        Ok(r) => Ok(OpResult::err(&format!("Plan API {}", r.status().as_u16()))),
        Err(e) => Ok(OpResult::err(&e.to_string())),
    }
}

// ── SundayEdit hand-off ───────────────────────────────────────────

/// Launch SundayEdit with a recording via the `sundayedit://import` deep
/// link, primed with sermon context + glossary. Returns `ok=false` with
/// `sundayedit_not_installed` when the OS has no handler for the scheme.
/// NETWORK/HARDWARE-UNVERIFIED (the launch needs the peer app installed).
#[tauri::command]
pub async fn integrations_sundayedit_send(
    app: tauri::AppHandle,
    video_path: String,
    language: Option<String>,
    context: Option<String>,
    glossary: Option<Vec<String>>,
) -> AppResult<OpResult> {
    if video_path.is_empty() {
        return Ok(OpResult::err("invalid_path"));
    }
    let link = build_sundayedit_deep_link(&SundayEditImportOptions {
        video_path,
        language,
        context,
        glossary: glossary.unwrap_or_default(),
    });
    use tauri_plugin_opener::OpenerExt;
    match app.opener().open_url(link, None::<&str>) {
        Ok(()) => Ok(OpResult {
            ok: true,
            ..Default::default()
        }),
        Err(_) => Ok(OpResult::err("sundayedit_not_installed")),
    }
}

/// Import a SundayEdit-exported subtitle file (SRT/VTT) into the recording's
/// `.transcript.json` sidecar so it shows up in transcript search + the editor.
/// The parse/convert is the pure `subtitles_to_transcript`; the fs read/write is
/// the I/O here. Returns `no_captions_parsed` when the file yields no segments.
#[tauri::command]
pub fn integrations_sundayedit_import(
    recording_path: String,
    subtitle_path: String,
    language: Option<String>,
) -> AppResult<OpResult> {
    if recording_path.is_empty() || subtitle_path.is_empty() {
        return Ok(OpResult::err("invalid_path"));
    }
    let text = match std::fs::read_to_string(&subtitle_path) {
        Ok(t) => t,
        Err(e) => return Ok(OpResult::err(&e.to_string())),
    };
    let transcript = subtitles_to_transcript(&text, language.as_deref(), now_ms() as i64);
    if transcript.segments.is_empty() {
        return Ok(OpResult::err("no_captions_parsed"));
    }
    let out = transcript_sidecar_path(&recording_path);
    let body = match serde_json::to_string_pretty(&transcript) {
        Ok(b) => b,
        Err(e) => return Ok(OpResult::err(&e.to_string())),
    };
    if let Err(e) = std::fs::write(&out, body) {
        return Ok(OpResult::err(&e.to_string()));
    }
    Ok(OpResult {
        ok: true,
        transcript_path: Some(out),
        ..Default::default()
    })
}

/// Minimal percent-encoding for the Supabase REST query values (church/service
/// id). Keeps the RFC-3986 unreserved set; everything else `%XX`.
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
