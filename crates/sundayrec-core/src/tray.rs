//! Tray menu *model* — pure, GUI-free (PU-2 P2a).
//!
//! Ported from the Electron `src/main/tray.ts` (the behavioural spec). That file
//! mixed the *decisions* (which localized labels to show, whether the status row
//! is clickable, when to surface the review-queue callout, what each item does)
//! with Electron's `Menu.buildFromTemplate` + `Tray` icon side effects.
//!
//! Here we keep ONLY the decision: given the current [`TrayState`] + language,
//! produce the ordered list of [`TrayItem`]s and the tooltip + icon base. The
//! `src-tauri` shell (behind the `tray` feature) maps each [`TrayItem`] to a
//! `tauri::menu::MenuItem` and wires its [`TrayItem::action`] to the matching
//! command/event — so the menu's *shape* is unit-tested and the GUI layer is a
//! dumb projection.

/// The seven UI languages, matching `tray.ts` `TRAY_LABELS`. Unknown codes fall
/// back to Norwegian (the Electron default).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayLang {
    No,
    En,
    De,
    Sv,
    Da,
    Pl,
    Fr,
}

impl TrayLang {
    pub fn from_code(code: Option<&str>) -> Self {
        match code.unwrap_or("no") {
            "en" => TrayLang::En,
            "de" => TrayLang::De,
            "sv" => TrayLang::Sv,
            "da" => TrayLang::Da,
            "pl" => TrayLang::Pl,
            "fr" => TrayLang::Fr,
            _ => TrayLang::No,
        }
    }
}

/// The live recorder/scheduler facts the menu reflects. Mirrors the module-level
/// mutable state in `tray.ts` (`isRecording`, `hasError`, `nextRecording`,
/// `reviewQueueCount`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TrayState {
    pub is_recording: bool,
    pub has_error: bool,
    /// Pre-formatted short label of the next recording (e.g. "Sun 11:00"), or
    /// `None`. Wall-clock formatting is a shell concern; the core just places it.
    pub next_recording_label: Option<String>,
    /// Episodes awaiting human review (0 hides the callout row).
    pub review_queue_count: u32,
}

/// A stable identifier for what a menu item does. The shell switches on this to
/// wire the click (emit an event / call a command). Mirrors the distinct `click`
/// handlers in `tray.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    /// Status row — only clickable (→ show window) when there's an error.
    ShowOnError,
    /// Non-interactive info row (next-recording line).
    None,
    OpenReviewQueue,
    OpenWindow,
    StartRecording,
    StopRecording,
    OpenRecordingsFolder,
    RunPreflight,
    RunDiagnostics,
    Quit,
}

/// One row of the tray menu (or a separator).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrayItem {
    Separator,
    Item {
        label: String,
        action: TrayAction,
        /// Whether the row is clickable. A disabled row shows context (status,
        /// next-recording) but does nothing.
        enabled: bool,
    },
}

impl TrayItem {
    fn item(label: impl Into<String>, action: TrayAction, enabled: bool) -> Self {
        TrayItem::Item {
            label: label.into(),
            action,
            enabled,
        }
    }
}

/// The icon variant the tray should display, by precedence: recording > error >
/// idle. The shell maps this to a platform-specific asset name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayIcon {
    Recording,
    Error,
    Idle,
}

/// Pick the icon for the current state. Recording wins over error wins over idle
/// (matches `tray.ts` `base` selection).
pub fn icon_for(state: &TrayState) -> TrayIcon {
    if state.is_recording {
        TrayIcon::Recording
    } else if state.has_error {
        TrayIcon::Error
    } else {
        TrayIcon::Idle
    }
}

/// The tooltip text. Mirrors `tray.ts` `updateTooltip`: a base line plus, when a
/// next recording is known, a "Neste opptak: <label>" line.
pub fn tooltip(state: &TrayState, lang: TrayLang) -> String {
    let base = match lang {
        TrayLang::No => "SundayRec — kjører i bakgrunnen",
        TrayLang::En => "SundayRec — running in background",
        TrayLang::De => "SundayRec — läuft im Hintergrund",
        TrayLang::Sv => "SundayRec — körs i bakgrunden",
        TrayLang::Da => "SundayRec — kører i baggrunden",
        TrayLang::Pl => "SundayRec — działa w tle",
        TrayLang::Fr => "SundayRec — s'exécute en arrière-plan",
    };
    match &state.next_recording_label {
        Some(next) => format!("{base}\n{}: {next}", next_label(lang)),
        None => base.to_string(),
    }
}

/// Build the ordered tray menu for `state` + `lang`. Order + clickability mirror
/// `tray.ts` `updateMenu`:
///   status → [next-recording info] → [review-queue callout] → open → start/stop
///   → open-folder → check-system → diagnostics → quit.
pub fn build_menu(state: &TrayState, lang: TrayLang) -> Vec<TrayItem> {
    let mut items = Vec::new();

    // Status row — clickable (show window) only on error.
    let status_label = if state.is_recording {
        recording_label(lang)
    } else if state.has_error {
        error_label(lang)
    } else {
        ready_label(lang)
    };
    items.push(TrayItem::item(
        status_label,
        TrayAction::ShowOnError,
        state.has_error,
    ));

    // Next-recording info line (only when not recording and known).
    if !state.is_recording {
        if let Some(next) = &state.next_recording_label {
            items.push(TrayItem::item(
                format!("{}: {next}", next_label(lang)),
                TrayAction::None,
                false,
            ));
        }
    }

    // High-priority review-queue callout.
    if state.review_queue_count > 0 {
        items.push(TrayItem::Separator);
        items.push(TrayItem::item(
            review_queue_label(lang, state.review_queue_count),
            TrayAction::OpenReviewQueue,
            true,
        ));
    }

    items.push(TrayItem::Separator);
    items.push(TrayItem::item(
        open_label(lang),
        TrayAction::OpenWindow,
        true,
    ));
    if state.is_recording {
        items.push(TrayItem::item(
            stop_label(lang),
            TrayAction::StopRecording,
            true,
        ));
    } else {
        items.push(TrayItem::item(
            start_label(lang),
            TrayAction::StartRecording,
            true,
        ));
    }

    items.push(TrayItem::Separator);
    items.push(TrayItem::item(
        open_folder_label(lang),
        TrayAction::OpenRecordingsFolder,
        true,
    ));
    items.push(TrayItem::item(
        check_system_label(lang),
        TrayAction::RunPreflight,
        true,
    ));

    items.push(TrayItem::Separator);
    items.push(TrayItem::item(
        diagnose_label(lang),
        TrayAction::RunDiagnostics,
        true,
    ));

    items.push(TrayItem::Separator);
    items.push(TrayItem::item(quit_label(lang), TrayAction::Quit, true));

    items
}

// ── localized labels (ported verbatim from tray.ts) ─────────────────────────

fn recording_label(l: TrayLang) -> &'static str {
    match l {
        TrayLang::No => "🔴 Tar opp…",
        TrayLang::En => "🔴 Recording…",
        TrayLang::De => "🔴 Aufnahme…",
        TrayLang::Sv => "🔴 Spelar in…",
        TrayLang::Da => "🔴 Optager…",
        TrayLang::Pl => "🔴 Nagrywa…",
        TrayLang::Fr => "🔴 Enregistrement…",
    }
}
fn error_label(l: TrayLang) -> &'static str {
    match l {
        TrayLang::No => "⚠️ Feil — klikk for detaljer",
        TrayLang::En => "⚠️ Error — click for details",
        TrayLang::De => "⚠️ Fehler — klicken für Details",
        TrayLang::Sv => "⚠️ Fel — klicka för detaljer",
        TrayLang::Da => "⚠️ Fejl — klik for detaljer",
        TrayLang::Pl => "⚠️ Błąd — kliknij po szczegóły",
        TrayLang::Fr => "⚠️ Erreur — cliquez pour détails",
    }
}
fn ready_label(l: TrayLang) -> &'static str {
    match l {
        TrayLang::No => "✅ Klar",
        TrayLang::En => "✅ Ready",
        TrayLang::De => "✅ Bereit",
        TrayLang::Sv => "✅ Klar",
        TrayLang::Da => "✅ Klar",
        TrayLang::Pl => "✅ Gotowy",
        TrayLang::Fr => "✅ Prêt",
    }
}
fn open_label(l: TrayLang) -> &'static str {
    match l {
        TrayLang::No => "Åpne SundayRec",
        TrayLang::En => "Open SundayRec",
        TrayLang::De => "SundayRec öffnen",
        TrayLang::Sv => "Öppna SundayRec",
        TrayLang::Da => "Åbn SundayRec",
        TrayLang::Pl => "Otwórz SundayRec",
        TrayLang::Fr => "Ouvrir SundayRec",
    }
}
fn stop_label(l: TrayLang) -> &'static str {
    match l {
        TrayLang::No => "Stopp opptak",
        TrayLang::En => "Stop recording",
        TrayLang::De => "Aufnahme stoppen",
        TrayLang::Sv => "Stoppa inspelning",
        TrayLang::Da => "Stop optagelse",
        TrayLang::Pl => "Zatrzymaj nagrywanie",
        TrayLang::Fr => "Arrêter l'enregistrement",
    }
}
fn start_label(l: TrayLang) -> &'static str {
    match l {
        TrayLang::No => "Start opptak nå",
        TrayLang::En => "Start recording now",
        TrayLang::De => "Aufnahme starten",
        TrayLang::Sv => "Starta inspelning nu",
        TrayLang::Da => "Start optagelse nu",
        TrayLang::Pl => "Rozpocznij nagrywanie",
        TrayLang::Fr => "Démarrer un enregistrement",
    }
}
fn quit_label(l: TrayLang) -> &'static str {
    match l {
        TrayLang::No => "Avslutt",
        TrayLang::En => "Quit",
        TrayLang::De => "Beenden",
        TrayLang::Sv => "Avsluta",
        TrayLang::Da => "Afslut",
        TrayLang::Pl => "Wyjdź",
        TrayLang::Fr => "Quitter",
    }
}
fn diagnose_label(l: TrayLang) -> &'static str {
    match l {
        TrayLang::No => "Diagnoser system…",
        TrayLang::En => "Run diagnostics…",
        TrayLang::De => "Diagnose starten…",
        TrayLang::Sv => "Kör diagnostik…",
        TrayLang::Da => "Kør diagnostik…",
        TrayLang::Pl => "Uruchom diagnostykę…",
        TrayLang::Fr => "Lancer le diagnostic…",
    }
}
fn open_folder_label(l: TrayLang) -> &'static str {
    match l {
        TrayLang::No => "Åpne lagringsmappe",
        TrayLang::En => "Open recordings folder",
        TrayLang::De => "Aufnahmeordner öffnen",
        TrayLang::Sv => "Öppna inspelningsmapp",
        TrayLang::Da => "Åbn optagelsesmappe",
        TrayLang::Pl => "Otwórz folder nagrań",
        TrayLang::Fr => "Ouvrir le dossier des enregistrements",
    }
}
fn check_system_label(l: TrayLang) -> &'static str {
    match l {
        TrayLang::No => "Sjekk system nå",
        TrayLang::En => "Check system now",
        TrayLang::De => "System jetzt prüfen",
        TrayLang::Sv => "Kontrollera systemet nu",
        TrayLang::Da => "Tjek systemet nu",
        TrayLang::Pl => "Sprawdź system teraz",
        TrayLang::Fr => "Vérifier le système",
    }
}
fn next_label(l: TrayLang) -> &'static str {
    match l {
        TrayLang::No => "Neste opptak",
        TrayLang::En => "Next recording",
        TrayLang::De => "Nächste Aufnahme",
        TrayLang::Sv => "Nästa inspelning",
        TrayLang::Da => "Næste optagelse",
        TrayLang::Pl => "Następne nagranie",
        TrayLang::Fr => "Prochain enregistrement",
    }
}

/// The review-queue callout label, with the count + singular/plural. Mirrors
/// `tray.ts` `REVIEW_QUEUE_LABEL`.
fn review_queue_label(l: TrayLang, n: u32) -> String {
    let one = n == 1;
    match l {
        TrayLang::No => format!(
            "📬 {n} {} for gjennomgang",
            if one {
                "episode klar"
            } else {
                "episoder klare"
            }
        ),
        TrayLang::En => format!(
            "📬 {n} {} ready for review",
            if one { "episode" } else { "episodes" }
        ),
        TrayLang::De => format!(
            "📬 {n} {} zur Überprüfung",
            if one {
                "Episode bereit"
            } else {
                "Episoden bereit"
            }
        ),
        TrayLang::Sv => format!("📬 {n} avsnitt klart för granskning"),
        TrayLang::Da => format!(
            "📬 {n} {} klar til gennemgang",
            if one { "episode" } else { "episoder" }
        ),
        TrayLang::Pl => format!(
            "📬 {n} {} do przeglądu",
            if one {
                "odcinek gotowy"
            } else {
                "odcinki gotowe"
            }
        ),
        TrayLang::Fr => format!(
            "📬 {n} {} à examiner",
            if one {
                "épisode prêt"
            } else {
                "épisodes prêts"
            }
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actions(items: &[TrayItem]) -> Vec<TrayAction> {
        items
            .iter()
            .filter_map(|i| match i {
                TrayItem::Item { action, .. } => Some(*action),
                TrayItem::Separator => None,
            })
            .collect()
    }

    #[test]
    fn idle_menu_offers_start_and_no_review_callout() {
        let menu = build_menu(&TrayState::default(), TrayLang::En);
        let acts = actions(&menu);
        assert!(acts.contains(&TrayAction::StartRecording));
        assert!(!acts.contains(&TrayAction::StopRecording));
        assert!(!acts.contains(&TrayAction::OpenReviewQueue));
        // Status row is disabled when there's no error.
        assert_eq!(
            menu[0],
            TrayItem::Item {
                label: "✅ Ready".into(),
                action: TrayAction::ShowOnError,
                enabled: false,
            }
        );
    }

    #[test]
    fn recording_menu_swaps_start_for_stop_and_hides_next_line() {
        let state = TrayState {
            is_recording: true,
            next_recording_label: Some("Sun 11:00".into()),
            ..Default::default()
        };
        let menu = build_menu(&state, TrayLang::No);
        let acts = actions(&menu);
        assert!(acts.contains(&TrayAction::StopRecording));
        assert!(!acts.contains(&TrayAction::StartRecording));
        // Next-recording info line is suppressed while recording.
        assert!(!acts.contains(&TrayAction::None));
        assert_eq!(
            menu[0].clone(),
            TrayItem::item("🔴 Tar opp…", TrayAction::ShowOnError, false)
        );
    }

    #[test]
    fn error_state_makes_status_row_clickable() {
        let state = TrayState {
            has_error: true,
            ..Default::default()
        };
        let menu = build_menu(&state, TrayLang::En);
        assert_eq!(
            menu[0],
            TrayItem::Item {
                label: "⚠️ Error — click for details".into(),
                action: TrayAction::ShowOnError,
                enabled: true,
            }
        );
        assert_eq!(icon_for(&state), TrayIcon::Error);
    }

    #[test]
    fn next_recording_info_row_appears_when_idle() {
        let state = TrayState {
            next_recording_label: Some("Sun 11:00".into()),
            ..Default::default()
        };
        let menu = build_menu(&state, TrayLang::En);
        let info = menu.iter().find_map(|i| match i {
            TrayItem::Item {
                label,
                action: TrayAction::None,
                enabled,
            } => Some((label.clone(), *enabled)),
            _ => None,
        });
        assert_eq!(info, Some(("Next recording: Sun 11:00".into(), false)));
    }

    #[test]
    fn review_callout_pluralizes_and_is_clickable() {
        let one = TrayState {
            review_queue_count: 1,
            ..Default::default()
        };
        let menu = build_menu(&one, TrayLang::En);
        let label = menu.iter().find_map(|i| match i {
            TrayItem::Item {
                label,
                action: TrayAction::OpenReviewQueue,
                ..
            } => Some(label.clone()),
            _ => None,
        });
        assert_eq!(label, Some("📬 1 episode ready for review".into()));

        let many = TrayState {
            review_queue_count: 3,
            ..Default::default()
        };
        assert_eq!(
            review_queue_label(TrayLang::En, 3),
            "📬 3 episodes ready for review"
        );
        assert!(actions(&build_menu(&many, TrayLang::En)).contains(&TrayAction::OpenReviewQueue));
    }

    #[test]
    fn menu_always_ends_with_quit() {
        for lang in [TrayLang::No, TrayLang::Fr, TrayLang::Pl] {
            let menu = build_menu(&TrayState::default(), lang);
            let last = menu.last().unwrap();
            assert!(matches!(
                last,
                TrayItem::Item {
                    action: TrayAction::Quit,
                    ..
                }
            ));
        }
    }

    #[test]
    fn tooltip_appends_next_recording_when_known() {
        let bare = tooltip(&TrayState::default(), TrayLang::En);
        assert_eq!(bare, "SundayRec — running in background");
        let with_next = tooltip(
            &TrayState {
                next_recording_label: Some("Sun 11:00".into()),
                ..Default::default()
            },
            TrayLang::En,
        );
        assert_eq!(
            with_next,
            "SundayRec — running in background\nNext recording: Sun 11:00"
        );
    }

    #[test]
    fn lang_defaults_to_norwegian() {
        assert_eq!(TrayLang::from_code(None), TrayLang::No);
        assert_eq!(TrayLang::from_code(Some("zz")), TrayLang::No);
        assert_eq!(TrayLang::from_code(Some("de")), TrayLang::De);
    }

    #[test]
    fn icon_precedence_recording_over_error() {
        let state = TrayState {
            is_recording: true,
            has_error: true,
            ..Default::default()
        };
        assert_eq!(icon_for(&state), TrayIcon::Recording);
        assert_eq!(icon_for(&TrayState::default()), TrayIcon::Idle);
    }
}
