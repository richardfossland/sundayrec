//! Menubar tray + deep-link plumbing (PU-2 P2b) — **GUI-UNVERIFIED**, default-off `tray` feature.
//!
//! The impure half of the tray. The *model* — which localized items, their
//! actions, the tooltip, the icon — is the unit-tested [`sundayrec_core::tray`];
//! the inbound `sundayrec://` parse/dispatch is the unit-tested
//! [`sundayrec_core::link::parse_deep_link`]. This module is only the glue:
//!   - turn a [`TrayItem`] list into a `tauri::menu::Menu` ([`build_menu`]),
//!   - wire each [`TrayAction`] to an app event the renderer/commands handle
//!     ([`emit_action`]),
//!   - route an inbound deep link to the right side effect ([`dispatch_deep_link`]).
//!
//! ## ⚠️ GUI-UNVERIFIED
//!
//! The `TrayIconBuilder`, the menu rendering, and the OS scheme delivery
//! (`tauri-plugin-deep-link`) need a real desktop session to verify — wired +
//! compiling under `--features tray`, never run headless. The tray icon assets
//! aren't bundled yet (see docs/NEEDS-RICHARD.md PU-2), so [`build_tray`] builds
//! the menu without setting an image; the shell adds the icon once assets land.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use sundayrec_core::link::{parse_deep_link, DeepLinkAction};
use sundayrec_core::tray::{build_menu as build_model, TrayAction, TrayItem, TrayLang, TrayState};

/// The event the tray emits for an action the renderer/commands handle. The
/// payload is the action's stable string id (see [`action_id`]). Mirrors the
/// `tray-…` IPC sends in the Electron `tray.ts` click handlers.
pub const TRAY_ACTION_EVENT: &str = "tray://action";
/// The event emitted when an inbound deep link is an import hand-off.
pub const DEEP_LINK_IMPORT_EVENT: &str = "deeplink://import";

/// The stable string id for a [`TrayAction`], used as the menu-item id and the
/// emitted event payload so the shell can route a click without re-deriving it.
pub fn action_id(action: TrayAction) -> &'static str {
    match action {
        TrayAction::ShowOnError => "show-on-error",
        TrayAction::None => "none",
        TrayAction::OpenReviewQueue => "open-review-queue",
        TrayAction::OpenWindow => "open-window",
        TrayAction::StartRecording => "start-recording",
        TrayAction::StopRecording => "stop-recording",
        TrayAction::OpenRecordingsFolder => "open-recordings-folder",
        TrayAction::RunPreflight => "run-preflight",
        TrayAction::RunDiagnostics => "run-diagnostics",
        TrayAction::Quit => "quit",
    }
}

/// Reverse of [`action_id`] — resolve a menu-item id back to its [`TrayAction`].
pub fn action_from_id(id: &str) -> Option<TrayAction> {
    Some(match id {
        "show-on-error" => TrayAction::ShowOnError,
        "none" => TrayAction::None,
        "open-review-queue" => TrayAction::OpenReviewQueue,
        "open-window" => TrayAction::OpenWindow,
        "start-recording" => TrayAction::StartRecording,
        "stop-recording" => TrayAction::StopRecording,
        "open-recordings-folder" => TrayAction::OpenRecordingsFolder,
        "run-preflight" => TrayAction::RunPreflight,
        "run-diagnostics" => TrayAction::RunDiagnostics,
        "quit" => TrayAction::Quit,
        _ => return None,
    })
}

/// Build a `tauri::menu::Menu` from the core tray model for `state` + `lang`.
/// Each clickable item carries the [`action_id`] as its menu-item id so the
/// `on_menu_event` handler can resolve it via [`action_from_id`]. Disabled rows
/// (status / next-recording info) become disabled items. GUI-UNVERIFIED.
pub fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    state: &TrayState,
    lang: TrayLang,
) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    for item in build_model(state, lang) {
        match item {
            TrayItem::Separator => {
                menu.append(&PredefinedMenuItem::separator(app)?)?;
            }
            TrayItem::Item {
                label,
                action,
                enabled,
            } => {
                let mi = MenuItem::with_id(app, action_id(action), &label, enabled, None::<&str>)?;
                menu.append(&mi)?;
            }
        }
    }
    Ok(menu)
}

/// Emit the [`TRAY_ACTION_EVENT`] for `action`, or perform it directly for the
/// ones the backend owns end-to-end:
///   - **show** (`OpenWindow`/`ShowOnError`) → bring the window forward;
///   - **stop** (`StopRecording`) → call the recorder engine's `stop()` directly
///     (the same path as the `stop_recording` command), so a tray "Stopp opptak"
///     works even with no window focused;
///   - **quit** → exit.
///
/// Everything else (start — which needs the renderer's device/settings context,
/// preflight, diagnostics, review-queue) is emitted as [`TRAY_ACTION_EVENT`] for
/// the renderer to turn into the matching `invoke(...)`. This mirrors how the
/// Electron `tray.ts` mixed `app.quit()`/`win.show()` + a direct stop with
/// `webContents.send(...)` for the rest.
pub fn emit_action<R: Runtime>(app: &AppHandle<R>, action: TrayAction) {
    match action {
        TrayAction::OpenWindow | TrayAction::ShowOnError => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
        TrayAction::StopRecording => {
            // Wire straight to the recorder command's effect — `RecorderEngine`
            // is managed state, and `stop()` is safe when nothing is running.
            app.state::<crate::recorder::engine::RecorderEngine>()
                .stop();
            // Still surface the event so the renderer can refresh its UI state.
            let _ = app.emit(TRAY_ACTION_EVENT, action_id(action));
        }
        TrayAction::Quit => app.exit(0),
        TrayAction::None => {}
        other => {
            let _ = app.emit(TRAY_ACTION_EVENT, action_id(other));
        }
    }
}

/// Handle an `on_menu_event` by id: resolve it to an action and run [`emit_action`].
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, menu_id: &str) {
    if let Some(action) = action_from_id(menu_id) {
        emit_action(app, action);
    }
}

/// Route an inbound `sundayrec://…` deep link. Returns the parsed action so the
/// caller can log it; performs the side effect (show window + emit) for the ones
/// the backend owns. The OAuth-callback branch is surfaced for the cloud flow to
/// validate via its existing core path (no replay state lives here). GUI-UNVERIFIED.
pub fn dispatch_deep_link<R: Runtime>(app: &AppHandle<R>, url: &str) -> Option<DeepLinkAction> {
    let action = parse_deep_link(url)?;
    match &action {
        DeepLinkAction::Import { path, return_to } => {
            // Bring the window forward and hand the import to the renderer.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
            let _ = app.emit(
                DEEP_LINK_IMPORT_EVENT,
                serde_json::json!({ "path": path, "returnTo": return_to }),
            );
        }
        DeepLinkAction::OAuthCallback { .. } | DeepLinkAction::Unknown { .. } => {
            // OAuth-via-scheme is delivered to the cloud flow elsewhere; Unknown
            // is just logged by the caller.
        }
    }
    Some(action)
}

/// Build + install the menubar tray icon with the current [`TrayState`] menu
/// and wire its `on_menu_event` to [`handle_menu_event`]. Called once from the
/// app `setup` under the `tray` feature.
///
/// The icon image is the app's default window icon (the dedicated tray assets
/// aren't bundled yet — see docs/NEEDS-RICHARD.md PU-2); the menu *shape* is the
/// unit-tested [`build_model`] projection. Returns the [`TrayIcon`] so the shell
/// can keep it alive (dropping it removes the tray). GUI-UNVERIFIED.
pub fn install<R: Runtime>(
    app: &AppHandle<R>,
    state: &TrayState,
    lang: TrayLang,
) -> tauri::Result<tauri::tray::TrayIcon<R>> {
    use tauri::tray::TrayIconBuilder;

    let menu = build_menu(app, state, lang)?;
    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| handle_menu_event(app, event.id.as_ref()));

    // Reuse the app's default icon until dedicated tray assets land.
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_id_round_trips_for_every_variant() {
        for action in [
            TrayAction::ShowOnError,
            TrayAction::None,
            TrayAction::OpenReviewQueue,
            TrayAction::OpenWindow,
            TrayAction::StartRecording,
            TrayAction::StopRecording,
            TrayAction::OpenRecordingsFolder,
            TrayAction::RunPreflight,
            TrayAction::RunDiagnostics,
            TrayAction::Quit,
        ] {
            assert_eq!(action_from_id(action_id(action)), Some(action));
        }
    }

    #[test]
    fn action_from_id_rejects_unknown() {
        assert_eq!(action_from_id("not-a-real-id"), None);
    }
}
