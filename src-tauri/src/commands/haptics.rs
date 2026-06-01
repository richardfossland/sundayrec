//! Trackpad haptics (macOS Force Touch).
//!
//! The editor fires subtle, throttled haptic taps at meaningful moments —
//! snapping a trim handle to a segment boundary, hitting a trim min/max limit,
//! and the playhead crossing a chapter/segment marker while scrubbing. The
//! renderer drives the *when* (it owns the interaction); this command is the
//! thin native *how*.
//!
//! On macOS we go through `NSHapticFeedbackManager.defaultPerformer` and map the
//! string pattern to the three system patterns Apple exposes:
//!   - `"alignment"`   → `.alignment`   (a snap clicked into place)
//!   - `"levelChange"` → `.levelChange` (hit a hard limit / detent)
//!   - everything else → `.generic`     (a neutral tick, e.g. marker crossing)
//!
//! On any other platform — and if the Force-Touch performer isn't available —
//! this is a graceful no-op. It never returns an error: a missing haptic engine
//! must never surface as a failed `invoke()` in the UI, so the command returns a
//! plain `bool` (`true` = a tap was dispatched). The objc2 / objc2-app-kit
//! bindings used on the macOS path are pulled in as a macOS-only dependency (the
//! same `objc2` 0.6 lineage Tauri already vendors), so the non-macOS build stays
//! dependency-free. The macOS path is HARDWARE-UNVERIFIED (compiles + wired
//! against the real AppKit API, not yet exercised on a Force-Touch trackpad).

/// Perform a single trackpad haptic tap for the given logical pattern.
///
/// Best-effort and infallible by contract: returns `true` when a tap was
/// dispatched to the system performer, `false` when no haptic path is available
/// (non-macOS). Never errors — the renderer wrapper treats any failure as silent.
#[tauri::command]
pub fn haptic_perform(pattern: String) -> bool {
    perform(&pattern)
}

#[cfg(target_os = "macos")]
fn perform(pattern: &str) -> bool {
    use objc2_app_kit::{
        NSHapticFeedbackManager, NSHapticFeedbackPattern, NSHapticFeedbackPerformanceTime,
        NSHapticFeedbackPerformer,
    };
    use objc2_foundation::MainThreadMarker;

    let pat = match pattern {
        "alignment" => NSHapticFeedbackPattern::Alignment,
        "levelChange" => NSHapticFeedbackPattern::LevelChange,
        _ => NSHapticFeedbackPattern::Generic,
    };

    // The closure that actually rings the trackpad. It touches AppKit, so it must
    // run on the main thread (hopped onto below if we're on a worker thread).
    let ring = move || {
        // `defaultPerformer` is the process-wide Force-Touch performer;
        // `performFeedbackPattern:` is the documented one-shot tap.
        let performer = NSHapticFeedbackManager::defaultPerformer();
        performer
            .performFeedbackPattern_performanceTime(pat, NSHapticFeedbackPerformanceTime::Default);
    };

    // Tauri commands run on a worker thread, so hop to the main thread (where
    // AppKit expects to be driven). If we're already on main, run inline.
    if MainThreadMarker::new().is_some() {
        ring();
    } else {
        dispatch2::DispatchQueue::main().exec_async(ring);
    }
    true
}

#[cfg(not(target_os = "macos"))]
fn perform(_pattern: &str) -> bool {
    // No trackpad-haptic API on non-macOS platforms → graceful no-op.
    false
}
