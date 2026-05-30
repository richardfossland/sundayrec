//! The recorder *state machine* and recovery/split policy — pure, I/O-free.
//!
//! This is Fase 3's heart: the production recorder's *decisions* lifted out of
//! the Electron `recorder.ts` session model (`sessionStartTime`,
//! `reconnectCount`, `segments[]`, `maxTimer`, `stuckTimer`, `splitTimer`,
//! `splitAutoRestart`) into a deterministic Rust state machine the `src-tauri`
//! engine drives. The engine owns every timer, channel and ffmpeg process; this
//! module owns every *rule* — so the recovery / split / state-transition logic
//! is fully unit-tested without a device, a process or a clock.
//!
//! Two pieces:
//!   - [`RecorderState`] + [`RecorderState::transition`] — the legal lifecycle
//!     (`Idle → Preparing → Recording → {Reconnecting → Recording} →
//!     Stopping → Stopped`, with `→ Failed` reachable from any live state). The
//!     transition table rejects illegal jumps so a bug in the engine surfaces as
//!     a refused transition rather than a silently-wrong state.
//!   - [`RecordingSession`] — the session state holder. It accumulates segment
//!     paths across reconnects AND splits, decides whether an unexpected ffmpeg
//!     death warrants a reconnect (and with how much back-off), and decides when
//!     a split is due. Every method that depends on time takes `now_ms` as an
//!     argument — there is NO clock in here, so the engine's tests can drive it
//!     deterministically (and ts-rs/`no_std`-ish purity is preserved).
//!
//! ## Ported vs improved vs deferred
//!
//!   - **Ported** verbatim-in-spirit: the reconnect budget (20 attempts, the
//!     [`crate::reconnect::reconnect_delay`] back-off), the fatal-error
//!     allowlist that skips reconnect ([`is_fatal_reconnect_error`], mirroring
//!     Electron's `FATAL_RECONNECT_ERRORS`), the `_rN` reconnect-segment naming
//!     and `_N` split-segment naming, and the "use the ORIGINAL session start
//!     for duration/date even after reconnects" rule.
//!   - **Improved:** Electron tracked reconnect timing implicitly through live
//!     timers; here the time budget is an explicit, tested predicate
//!     ([`may_reconnect`] + the back-off schedule). The state machine itself is
//!     new — Electron used a loose `_phase` string; this rejects illegal
//!     transitions.
//!   - **Deferred (documented, not silently dropped):** the two-process
//!     audio+video fallback (Electron's separate `videoHandle` / `_vtmp.mp4`
//!     merge path) is NOT modelled here — Fase 3 targets the *unified* single
//!     ffmpeg pipeline. NDI / streaming likewise stay out (later phases). See
//!     the engine module header for the matching plumbing note.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::errors::RecordingErrorCode;
use crate::reconnect::{may_reconnect, reconnect_delay};

/// The recorder lifecycle, surfaced to the UI as a `recording://state` event.
///
/// Serialised `snake_case` to match the renderer's localisation switch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/RecorderState.ts")]
#[serde(rename_all = "snake_case")]
pub enum RecorderState {
    /// Nothing running. The initial and terminal-after-stop neutral state is
    /// [`RecorderState::Stopped`]; `Idle` is the never-yet-started engine.
    Idle,
    /// Resolving the device + spawning ffmpeg; no `size=` line seen yet.
    Preparing,
    /// ffmpeg is encoding (first `size=` line observed). The steady state.
    Recording,
    /// ffmpeg died unexpectedly and we are inside the reconnect back-off /
    /// respawn loop. Returns to [`RecorderState::Recording`] on success.
    Reconnecting,
    /// A graceful `q` stop is in flight (finalising the container).
    Stopping,
    /// Stopped cleanly. Terminal.
    Stopped,
    /// Gave up (reconnect budget exhausted, or a fatal error). Terminal.
    Failed,
}

impl RecorderState {
    /// Whether this state is terminal (no further transitions expected).
    pub fn is_terminal(self) -> bool {
        matches!(self, RecorderState::Stopped | RecorderState::Failed)
    }

    /// Whether the session is doing useful work (mirrors Electron's
    /// `isActive`: starting, recording, or reconnecting).
    pub fn is_active(self) -> bool {
        matches!(
            self,
            RecorderState::Preparing | RecorderState::Recording | RecorderState::Reconnecting
        )
    }

    /// Attempt a transition to `to`. Returns `Some(to)` when the move is legal,
    /// `None` when it isn't — so the engine can assert legality and a logic bug
    /// surfaces as a refused transition rather than a silently-wrong state.
    ///
    /// Legal edges:
    /// ```text
    /// Idle         → Preparing | Failed
    /// Preparing    → Recording | Stopping | Failed
    /// Recording    → Reconnecting | Stopping | Failed
    /// Reconnecting → Recording | Stopping | Failed
    /// Stopping     → Stopped | Failed
    /// Stopped      → Preparing            (engine reused for a new session)
    /// Failed       → Preparing            (engine reused for a new session)
    /// ```
    /// Any state may go to `Failed` (a fatal error can strike at any moment).
    /// `Stopped`/`Failed` may re-enter `Preparing` because the engine handle is
    /// long-lived and reused for the next recording.
    pub fn transition(self, to: RecorderState) -> Option<RecorderState> {
        use RecorderState::*;
        // A fatal error can always strike.
        if to == Failed {
            return Some(Failed);
        }
        let legal = match (self, to) {
            (Idle, Preparing) => true,
            (Preparing, Recording) | (Preparing, Stopping) => true,
            (Recording, Reconnecting) | (Recording, Stopping) => true,
            (Reconnecting, Recording) | (Reconnecting, Stopping) => true,
            (Stopping, Stopped) => true,
            // Re-arm for a fresh session from a terminal state.
            (Stopped, Preparing) | (Failed, Preparing) => true,
            _ => false,
        };
        if legal {
            Some(to)
        } else {
            None
        }
    }
}

/// Errors that retrying will never fix — the recorder fail-stops immediately
/// instead of burning the whole reconnect budget. Mirrors the Electron
/// `FATAL_RECONNECT_ERRORS` set (`disk_full`, `device_permission_denied`,
/// `no_device`); `device_not_found` is our `no_device` analogue.
///
/// `DeviceError` (the unclassified catch-all) and `DeviceBusy` /
/// `DeviceDisconnected` are treated as *transient* — a fumbled cable, a device
/// briefly grabbed by another app — so they DO get reconnect attempts.
pub fn is_fatal_reconnect_error(code: RecordingErrorCode) -> bool {
    matches!(
        code,
        RecordingErrorCode::DiskFull
            | RecordingErrorCode::DevicePermissionDenied
            | RecordingErrorCode::DeviceNotFound
    )
}

/// What the host should do after ffmpeg exits unexpectedly (not a graceful
/// stop). The engine turns [`RecoveryDecision::Reconnect`] into a real
/// `tokio::time::sleep(delay_ms)` followed by a respawn against `next_segment`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryDecision {
    /// Reconnect: wait `delay_ms`, then respawn ffmpeg writing to
    /// `next_segment` (already appended to the session). `attempt` is the
    /// 1-based attempt number (for logging / the UI).
    Reconnect {
        /// Back-off before respawning, from [`reconnect_delay`].
        delay_ms: u64,
        /// 1-based attempt number.
        attempt: u32,
        /// The fresh segment path the reconnected ffmpeg writes to.
        next_segment: String,
    },
    /// Give up — fail-stop. Either the error is fatal (won't be fixed by a
    /// retry) or the reconnect budget is exhausted.
    GiveUp,
}

/// One **deliverable** — a single finished file the user keeps. A session with
/// no split produces exactly one deliverable; each split boundary closes the
/// current deliverable and opens a new one (so N splits ⇒ N deliverables ⇒ N
/// files ⇒ N history rows).
///
/// `fragments` is the ordered list of on-disk paths that make up THIS
/// deliverable: its start segment first, then any `_rN` reconnect fragments that
/// occurred *inside* this deliverable (a device unplug mid-recording). At
/// finalisation the engine concat-`-c copy` stitches the fragments into one
/// lossless file at `primary_path` (the first fragment). `started_at_ms` is when
/// this deliverable's first segment began — for the per-deliverable history row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Deliverable {
    /// The final file path for this deliverable — its first fragment, which the
    /// concat stitches the rest INTO (and which the history row points at).
    pub primary_path: String,
    /// Every fragment path for this deliverable, in start order (start fragment
    /// then `_rN` reconnect fragments). `fragments[0] == primary_path`.
    pub fragments: Vec<String>,
    /// Epoch ms this deliverable's first fragment started.
    pub started_at_ms: u64,
}

/// The pure recording-session state. The engine constructs one per recording,
/// feeds it events, and acts on its decisions. Holds NO clock, NO process, NO
/// file handles — only the facts needed to decide recovery and splitting.
///
/// ## Deliverable / fragment model (Fase 3.3a)
///
/// The session is a sequence of **deliverables**. The first deliverable opens at
/// `new()`. A **reconnect** (`on_unexpected_exit` → `_rN`) appends a fragment to
/// the *current* deliverable — it stays one file. A **split**
/// (`begin_split_segment` → `_N`) CLOSES the current deliverable and OPENS a new
/// one whose first fragment is the `_N` path. So:
///   - reconnect = stitch (more fragments in the same deliverable),
///   - split = a brand-new deliverable (its own file + own history row),
///   - the pre-roll clip is prepended to the FIRST deliverable's FIRST fragment
///     only (the engine owns that decision; core just exposes the deliverables).
///
/// `segments()` still returns the flat ordered path list (every fragment of
/// every deliverable) for backward compatibility; [`deliverables`] groups them.
#[derive(Debug, Clone)]
pub struct RecordingSession {
    /// Original session start (epoch ms) — NEVER updated on reconnect/split, so
    /// the whole-session duration spans every deliverable.
    session_start_ms: u64,
    /// Wall-clock (ms) the CURRENT segment started — reset on every reconnect
    /// and split, so [`should_split`](Self::should_split) measures per-segment.
    current_segment_start_ms: u64,
    /// How many reconnects have happened (Electron `reconnectCount`).
    reconnect_count: u32,
    /// How many *split* rotations have happened (drives the `_N` suffix).
    split_count: u32,
    /// The base path (deliverable 0's first fragment) all suffixed segment names
    /// derive from.
    base_path: String,
    /// The deliverables produced so far, in order. Always ≥ 1 (the first opens at
    /// construction). The last is the one currently being recorded into.
    deliverables: Vec<Deliverable>,
}

impl RecordingSession {
    /// Start a session writing its first segment to `output_path`, beginning at
    /// `start_ms` (epoch ms supplied by the engine).
    pub fn new(output_path: impl Into<String>, start_ms: u64) -> Self {
        let base_path = output_path.into();
        let first = Deliverable {
            primary_path: base_path.clone(),
            fragments: vec![base_path.clone()],
            started_at_ms: start_ms,
        };
        Self {
            session_start_ms: start_ms,
            current_segment_start_ms: start_ms,
            reconnect_count: 0,
            split_count: 0,
            base_path,
            deliverables: vec![first],
        }
    }

    /// Epoch-ms the session originally started. Use this for the history row's
    /// `started_at` and to compute total duration, so reconnects/splits don't
    /// reset the clock.
    pub fn session_start_ms(&self) -> u64 {
        self.session_start_ms
    }

    /// Total elapsed session time at `now_ms` (saturating, for the history
    /// row's `duration_ms`).
    pub fn elapsed_ms(&self, now_ms: u64) -> u64 {
        now_ms.saturating_sub(self.session_start_ms)
    }

    /// How many reconnects have occurred.
    pub fn reconnect_count(&self) -> u32 {
        self.reconnect_count
    }

    /// How many split rotations have occurred.
    pub fn split_count(&self) -> u32 {
        self.split_count
    }

    /// All segment paths in start order, flattened across every deliverable.
    /// `segments()[0]` is the original output. Kept for backward compatibility /
    /// diagnostics; [`deliverables`](Self::deliverables) is the structured view.
    pub fn segments(&self) -> Vec<String> {
        self.deliverables
            .iter()
            .flat_map(|d| d.fragments.iter().cloned())
            .collect()
    }

    /// The primary (history-representative) file path — the FIRST deliverable's
    /// first fragment (the original output path). Use
    /// [`deliverables`](Self::deliverables) for the per-deliverable paths.
    pub fn primary_path(&self) -> &str {
        &self.deliverables[0].primary_path
    }

    /// The path of the segment currently being written (the most recent fragment
    /// of the current deliverable).
    pub fn current_segment(&self) -> &str {
        self.deliverables
            .last()
            .and_then(|d| d.fragments.last())
            .map(String::as_str)
            .unwrap_or(&self.base_path)
    }

    /// The fragment paths of the deliverable currently being recorded into, in
    /// start order (start fragment + any `_rN` reconnect fragments so far).
    pub fn current_deliverable_fragments(&self) -> &[String] {
        &self
            .deliverables
            .last()
            .expect("a session always has at least one deliverable")
            .fragments
    }

    /// Whether the deliverable currently being recorded is the FIRST one — the
    /// only deliverable the pre-roll clip is prepended to. (Equivalent to "no
    /// split has happened yet".)
    pub fn current_is_first_deliverable(&self) -> bool {
        self.deliverables.len() == 1
    }

    /// All deliverables produced so far, in order. Each is a finished (or
    /// in-progress, for the last) file the user keeps: its `primary_path`, its
    /// ordered `fragments` (start + reconnect `_rN`), and its `started_at_ms`.
    /// The engine writes ONE history row per deliverable and concat-stitches each
    /// deliverable's fragments into its `primary_path`.
    pub fn deliverables(&self) -> Vec<Deliverable> {
        self.deliverables.clone()
    }

    /// Decide what to do after ffmpeg exits UNEXPECTEDLY (not a graceful `q`).
    ///
    /// `now_ms` is the current epoch ms. `last_error`, if classified from
    /// stderr, gates the fatal-error short-circuit. Returns [`RecoveryDecision`]:
    /// on [`RecoveryDecision::Reconnect`] the session has already incremented
    /// `reconnect_count` and appended the new `_rN` segment, so the caller need
    /// only sleep `delay_ms` and respawn against `next_segment`.
    ///
    /// Policy (ported from Electron `startWatchdog` + `tryReconnect`):
    ///   1. A fatal error ([`is_fatal_reconnect_error`]) → [`RecoveryDecision::GiveUp`].
    ///   2. Budget exhausted ([`may_reconnect`] false) → `GiveUp`.
    ///   3. Otherwise reconnect: bump the count, append the `_rN` segment, and
    ///      return the back-off from [`reconnect_delay`] for this attempt.
    pub fn on_unexpected_exit(
        &mut self,
        now_ms: u64,
        last_error: Option<RecordingErrorCode>,
    ) -> RecoveryDecision {
        if let Some(code) = last_error {
            if is_fatal_reconnect_error(code) {
                return RecoveryDecision::GiveUp;
            }
        }
        if !may_reconnect(self.reconnect_count) {
            return RecoveryDecision::GiveUp;
        }
        // `attempt` is 1-based for the UI; `reconnect_delay` is 0-based, so the
        // FIRST attempt (attempt=1) uses the attempt-0 back-off (2000 ms).
        let zero_based = self.reconnect_count;
        self.reconnect_count += 1;
        let attempt = self.reconnect_count;
        // The reconnect fragment derives from the CURRENT deliverable's primary
        // path (NOT the session base), so a reconnect inside a split deliverable
        // is named `g_2_r1.mp3` and groups under that deliverable — its concat
        // target is `g_2.mp3`, not the original `g.mp3`.
        let current_primary = self
            .deliverables
            .last()
            .expect("a session always has at least one deliverable")
            .primary_path
            .clone();
        let next_segment = reconnect_fragment_path(&current_primary, attempt);
        // A reconnect appends a fragment to the CURRENT deliverable — it stays
        // one file (the fragments are stitched at finalisation).
        self.deliverables
            .last_mut()
            .expect("a session always has at least one deliverable")
            .fragments
            .push(next_segment.clone());
        // A reconnect starts a fresh segment clock for split purposes.
        self.current_segment_start_ms = now_ms;
        RecoveryDecision::Reconnect {
            delay_ms: reconnect_delay(zero_based),
            attempt,
            next_segment,
        }
    }

    /// Whether a split is due: split is enabled (`split_minutes > 0`) AND the
    /// CURRENT segment has run at least `split_minutes`. Pure — `now_ms` is the
    /// engine's clock.
    pub fn should_split(&self, now_ms: u64, split_minutes: u32) -> bool {
        if split_minutes == 0 {
            return false;
        }
        let elapsed = now_ms.saturating_sub(self.current_segment_start_ms);
        elapsed >= u64::from(split_minutes) * 60_000
    }

    /// Whether the manual-max auto-stop is due: enabled (`manual_max_minutes >
    /// 0`) AND the WHOLE session has run at least that long. (Electron's
    /// `maxTimer`, which used `sessionStartTime` — so reconnects/splits don't
    /// extend the cap.)
    pub fn should_auto_stop(&self, now_ms: u64, manual_max_minutes: u32) -> bool {
        if manual_max_minutes == 0 {
            return false;
        }
        self.elapsed_ms(now_ms) >= u64::from(manual_max_minutes) * 60_000
    }

    /// Rotate to a fresh split segment: a split CLOSES the current deliverable
    /// and OPENS a new one. Bumps the split count, appends a new [`Deliverable`]
    /// whose first fragment is the `_N` path, resets the per-segment clock, and
    /// returns the new path the engine should spawn ffmpeg against. Call this
    /// when [`should_split`](Self::should_split) returns true (after finalising
    /// the current segment with a graceful `q`).
    ///
    /// `now_ms` becomes the new deliverable's `started_at_ms` — each split file
    /// gets its own history `started_at` (Electron stamped each split file with
    /// the rotation time, not the original session start).
    pub fn begin_split_segment(&mut self, now_ms: u64) -> String {
        self.split_count += 1;
        // Split segments are numbered globally (segment index = how many splits
        // we've started) to keep names monotonic alongside any `_rN` fragments.
        let next = split_segment_path(&self.base_path, self.split_count);
        self.deliverables.push(Deliverable {
            primary_path: next.clone(),
            fragments: vec![next.clone()],
            started_at_ms: now_ms,
        });
        self.current_segment_start_ms = now_ms;
        next
    }
}

/// Build the reconnect-segment path for the 1-based reconnect `attempt`:
/// `name.mp3` → `name_r1.mp3`, `name_r2.mp3`, … Any existing `_rN` suffix on the
/// stem is stripped first so successive reconnects don't stack (`_r1_r2`),
/// mirroring the Electron `base.replace(/_r\d+$/, '')`.
pub fn reconnect_segment_path(base_path: &str, attempt: u32) -> String {
    let (stem, ext) = split_ext(base_path);
    let stem = strip_segment_suffix(stem);
    match ext {
        Some(e) => format!("{stem}_r{attempt}.{e}"),
        None => format!("{stem}_r{attempt}"),
    }
}

/// Build a reconnect-fragment path for the 1-based reconnect `attempt`, derived
/// from a deliverable's PRIMARY path (which may itself carry a `_N` split
/// suffix). Only a trailing `_rN` reconnect suffix is stripped first, so a split
/// deliverable's `_N` is preserved: `g_2.mp3` → `g_2_r1.mp3`, and a stacked
/// reconnect `g_2_r1.mp3` → `g_2_r2.mp3` (no `_r1_r2`).
pub fn reconnect_fragment_path(primary_path: &str, attempt: u32) -> String {
    let (stem, ext) = split_ext(primary_path);
    let stem = strip_reconnect_suffix(stem);
    match ext {
        Some(e) => format!("{stem}_r{attempt}.{e}"),
        None => format!("{stem}_r{attempt}"),
    }
}

/// Strip ONLY a trailing `_rN` reconnect suffix from a stem (leaving any `_N`
/// split suffix intact). Used by [`reconnect_fragment_path`] so reconnects don't
/// stack but a split deliverable's number is preserved.
fn strip_reconnect_suffix(stem: &str) -> &str {
    let bytes = stem.as_bytes();
    let mut i = bytes.len();
    while i > 0 && bytes[i - 1].is_ascii_digit() {
        i -= 1;
    }
    // Only strip when the digit run is preceded by `_r`.
    if i < bytes.len() && i >= 2 && &stem[i - 2..i] == "_r" {
        &stem[..i - 2]
    } else {
        stem
    }
}

/// Build the split-segment path for the 1-based split `index`:
/// `name.mp3` → `name_2.mp3` (the original is conceptually segment 1, so the
/// first split is `_2`). Any existing `_rN`/`_N` suffix is stripped first.
pub fn split_segment_path(base_path: &str, index: u32) -> String {
    let (stem, ext) = split_ext(base_path);
    let stem = strip_segment_suffix(stem);
    // The original file is segment 1; the first split rotation is `_2`.
    let n = index + 1;
    match ext {
        Some(e) => format!("{stem}_{n}.{e}"),
        None => format!("{stem}_{n}"),
    }
}

/// Split a path into `(stem, Some(ext))` on the final dot of the file name, or
/// `(path, None)` when there is no extension. Only the FILE-NAME component's
/// dot counts, so a dotted directory (`/a.b/rec`) is handled correctly.
fn split_ext(path: &str) -> (&str, Option<&str>) {
    // Find the last path separator so we only look for a dot in the file name.
    let name_start = path.rfind(['/', '\\']).map(|i| i + 1).unwrap_or(0);
    match path[name_start..].rfind('.') {
        // A leading dot (dotfile) is not an extension separator.
        Some(rel) if rel > 0 => {
            let abs = name_start + rel;
            (&path[..abs], Some(&path[abs + 1..]))
        }
        _ => (path, None),
    }
}

/// Strip a trailing `_rN` or `_N` segment suffix from a stem so successive
/// segment paths derive from the original base, not from a previous segment.
fn strip_segment_suffix(stem: &str) -> &str {
    let bytes = stem.as_bytes();
    // Walk back over trailing ASCII digits.
    let mut i = bytes.len();
    while i > 0 && bytes[i - 1].is_ascii_digit() {
        i -= 1;
    }
    if i == bytes.len() {
        return stem; // no trailing digits
    }
    // Now `stem[..i]` ends just before the digit run. Accept `_` or `_r`.
    if i >= 2 && &stem[i - 2..i] == "_r" {
        &stem[..i - 2]
    } else if i >= 1 && bytes[i - 1] == b'_' {
        &stem[..i - 1]
    } else {
        stem
    }
}

// ── Concat / mux argument builders (Fase 3.3a) ───────────────────────────────
//
// Pure ports of the Electron `mergeSegments` / pre-roll-concat path. These build
// the ffmpeg concat-demuxer inputs and the concat-list file body; the `src-tauri`
// layer writes the list to a temp file and runs ffmpeg with `-c copy` (lossless —
// every fragment shares the recording's codec/container, and the pre-roll clip is
// re-encoded to that same format at harvest, so no transcode is needed).

/// Escape a path for ffmpeg's concat-demuxer list, an EXACT port of the Electron
/// `escPath`:
///   1. Windows: backslashes → forward slashes (so the concat parser doesn't
///      treat `\` as an escape). POSIX: backslashes → doubled (`\` → `\\`), since
///      a literal `\` inside the single-quoted path must itself be escaped.
///   2. Then single quotes → `\'` on every platform (the path is wrapped in `'…'`
///      in the list, so an embedded quote must be backslash-escaped).
pub fn escape_concat_path(path: &str, is_windows: bool) -> String {
    let normalized = if is_windows {
        path.replace('\\', "/")
    } else {
        path.replace('\\', "\\\\")
    };
    normalized.replace('\'', "\\'")
}

/// Build the body of an ffmpeg concat-demuxer list: one `file '<escaped>'` line
/// per input, in order, each terminated by `\n` (matching the Electron writer's
/// trailing newline).
pub fn build_concat_list(files: &[String], is_windows: bool) -> String {
    let mut out = String::new();
    for f in files {
        out.push_str("file '");
        out.push_str(&escape_concat_path(f, is_windows));
        out.push_str("'\n");
    }
    out
}

/// Build the ffmpeg concat-demuxer argument vector — an EXACT port of the
/// Electron `mergeSegments` / pre-roll-concat args:
/// `["-nostdin","-hide_banner","-f","concat","-safe","0","-i",<list>,"-c","copy","-y",<out>]`.
/// Lossless stream-copy: every input shares the recording's codec/container.
pub fn build_concat_args(list_path: &str, out_path: &str) -> Vec<String> {
    vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        list_path.into(),
        "-c".into(),
        "copy".into(),
        "-y".into(),
        out_path.into(),
    ]
}

/// Whether a concat is actually needed for a deliverable: `true` when there is
/// more than one fragment OR a pre-roll clip must be prepended. With a single
/// fragment and no pre-roll the primary file is already the finished deliverable,
/// so the engine skips ffmpeg entirely.
pub fn concat_needed(fragments: &[String], has_preroll: bool) -> bool {
    fragments.len() > 1 || has_preroll
}

/// The ordered list of ffmpeg concat inputs for a deliverable: the optional
/// pre-roll clip FIRST (only the first deliverable ever passes `Some` here — the
/// engine decides), then the deliverable's fragments in start order.
pub fn concat_inputs(fragments: &[String], preroll_clip_path: Option<&str>) -> Vec<String> {
    let mut inputs = Vec::with_capacity(fragments.len() + 1);
    if let Some(p) = preroll_clip_path {
        inputs.push(p.to_string());
    }
    inputs.extend(fragments.iter().cloned());
    inputs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reconnect::MAX_RECONNECT_ATTEMPTS;

    // ── State machine ─────────────────────────────────────────────────────────

    #[test]
    fn legal_happy_path_transitions() {
        use RecorderState::*;
        assert_eq!(Idle.transition(Preparing), Some(Preparing));
        assert_eq!(Preparing.transition(Recording), Some(Recording));
        assert_eq!(Recording.transition(Stopping), Some(Stopping));
        assert_eq!(Stopping.transition(Stopped), Some(Stopped));
    }

    #[test]
    fn legal_reconnect_cycle() {
        use RecorderState::*;
        assert_eq!(Recording.transition(Reconnecting), Some(Reconnecting));
        assert_eq!(Reconnecting.transition(Recording), Some(Recording));
        // A reconnecting session can also be stopped or fail.
        assert_eq!(Reconnecting.transition(Stopping), Some(Stopping));
    }

    #[test]
    fn any_state_can_fail() {
        use RecorderState::*;
        for s in [Idle, Preparing, Recording, Reconnecting, Stopping] {
            assert_eq!(s.transition(Failed), Some(Failed), "{s:?} → Failed");
        }
    }

    #[test]
    fn illegal_transitions_are_refused() {
        use RecorderState::*;
        // Can't jump straight from Idle to Recording.
        assert_eq!(Idle.transition(Recording), None);
        // Can't reconnect from Preparing (no segment yet).
        assert_eq!(Preparing.transition(Reconnecting), None);
        // Can't go back to Recording from Stopping.
        assert_eq!(Stopping.transition(Recording), None);
        // Terminal states don't resume mid-stream (only re-arm via Preparing).
        assert_eq!(Stopped.transition(Recording), None);
        assert_eq!(Failed.transition(Reconnecting), None);
    }

    #[test]
    fn terminal_states_rearm_for_a_new_session() {
        use RecorderState::*;
        assert_eq!(Stopped.transition(Preparing), Some(Preparing));
        assert_eq!(Failed.transition(Preparing), Some(Preparing));
    }

    #[test]
    fn is_active_and_is_terminal_classify_correctly() {
        use RecorderState::*;
        assert!(Recording.is_active() && Reconnecting.is_active() && Preparing.is_active());
        assert!(!Idle.is_active() && !Stopped.is_active() && !Failed.is_active());
        assert!(Stopped.is_terminal() && Failed.is_terminal());
        assert!(!Recording.is_terminal());
    }

    // ── Fatal-error allowlist ───────────────────────────────────────────────────

    #[test]
    fn fatal_errors_match_electron_set() {
        assert!(is_fatal_reconnect_error(RecordingErrorCode::DiskFull));
        assert!(is_fatal_reconnect_error(
            RecordingErrorCode::DevicePermissionDenied
        ));
        assert!(is_fatal_reconnect_error(RecordingErrorCode::DeviceNotFound));
        // Transient ones DO get retried.
        assert!(!is_fatal_reconnect_error(RecordingErrorCode::DeviceBusy));
        assert!(!is_fatal_reconnect_error(
            RecordingErrorCode::DeviceDisconnected
        ));
        assert!(!is_fatal_reconnect_error(RecordingErrorCode::DeviceError));
    }

    // ── Reconnect decision ──────────────────────────────────────────────────────

    #[test]
    fn first_unexpected_exit_reconnects_with_attempt_zero_backoff() {
        let mut s = RecordingSession::new("/rec/sermon.mp3", 1_000);
        let d = s.on_unexpected_exit(2_000, None);
        match d {
            RecoveryDecision::Reconnect {
                delay_ms,
                attempt,
                next_segment,
            } => {
                assert_eq!(delay_ms, reconnect_delay(0)); // 2000
                assert_eq!(attempt, 1);
                assert_eq!(next_segment, "/rec/sermon_r1.mp3");
            }
            other => panic!("expected Reconnect, got {other:?}"),
        }
        assert_eq!(s.reconnect_count(), 1);
        assert_eq!(s.segments(), ["/rec/sermon.mp3", "/rec/sermon_r1.mp3"]);
        // A reconnect stays in the SAME (first) deliverable, not a new one.
        let dels = s.deliverables();
        assert_eq!(dels.len(), 1);
        assert_eq!(dels[0].primary_path, "/rec/sermon.mp3");
        assert_eq!(dels[0].fragments, ["/rec/sermon.mp3", "/rec/sermon_r1.mp3"]);
    }

    #[test]
    fn successive_reconnects_use_rising_backoff_and_numbering() {
        let mut s = RecordingSession::new("/rec/sermon.mp3", 0);
        // attempt 1 → delay reconnect_delay(0); attempt 2 → reconnect_delay(1) …
        for n in 1..=3u32 {
            let d = s.on_unexpected_exit(n as u64 * 1000, None);
            match d {
                RecoveryDecision::Reconnect {
                    delay_ms,
                    attempt,
                    next_segment,
                } => {
                    assert_eq!(attempt, n);
                    assert_eq!(delay_ms, reconnect_delay(n - 1));
                    assert_eq!(next_segment, format!("/rec/sermon_r{n}.mp3"));
                }
                other => panic!("expected Reconnect, got {other:?}"),
            }
        }
        assert_eq!(s.reconnect_count(), 3);
    }

    #[test]
    fn reconnect_gives_up_when_budget_exhausted() {
        let mut s = RecordingSession::new("/rec/x.mp3", 0);
        // Burn the whole budget.
        for _ in 0..MAX_RECONNECT_ATTEMPTS {
            assert!(matches!(
                s.on_unexpected_exit(0, None),
                RecoveryDecision::Reconnect { .. }
            ));
        }
        assert_eq!(s.reconnect_count(), MAX_RECONNECT_ATTEMPTS);
        // The next one gives up.
        assert_eq!(s.on_unexpected_exit(0, None), RecoveryDecision::GiveUp);
    }

    #[test]
    fn reconnect_gives_up_immediately_on_fatal_error() {
        let mut s = RecordingSession::new("/rec/x.mp3", 0);
        assert_eq!(
            s.on_unexpected_exit(0, Some(RecordingErrorCode::DiskFull)),
            RecoveryDecision::GiveUp
        );
        // No segment was appended and no attempt consumed.
        assert_eq!(s.reconnect_count(), 0);
        assert_eq!(s.segments().len(), 1);
    }

    #[test]
    fn transient_error_still_reconnects() {
        let mut s = RecordingSession::new("/rec/x.mp3", 0);
        assert!(matches!(
            s.on_unexpected_exit(0, Some(RecordingErrorCode::DeviceDisconnected)),
            RecoveryDecision::Reconnect { .. }
        ));
    }

    // ── Split policy ────────────────────────────────────────────────────────────

    #[test]
    fn should_split_off_when_zero() {
        let s = RecordingSession::new("/rec/x.mp3", 0);
        assert!(!s.should_split(999_999_999, 0));
    }

    #[test]
    fn should_split_at_boundary() {
        let s = RecordingSession::new("/rec/x.mp3", 0);
        // 30-minute split. Just under → no; exactly at / over → yes.
        assert!(!s.should_split(30 * 60_000 - 1, 30));
        assert!(s.should_split(30 * 60_000, 30));
        assert!(s.should_split(45 * 60_000, 30));
    }

    #[test]
    fn split_measures_per_segment_not_whole_session() {
        let mut s = RecordingSession::new("/rec/x.mp3", 0);
        // 10 minutes in, rotate a split segment (clock resets).
        let _ = s.begin_split_segment(10 * 60_000);
        // 5 minutes into the NEW segment (= 15 min total) is not yet a 10-min split.
        assert!(!s.should_split(15 * 60_000, 10));
        // 10 minutes into the new segment (= 20 min total) is.
        assert!(s.should_split(20 * 60_000, 10));
    }

    #[test]
    fn begin_split_segment_numbers_and_appends() {
        let mut s = RecordingSession::new("/rec/sermon.mp3", 0);
        assert_eq!(s.begin_split_segment(60_000), "/rec/sermon_2.mp3");
        assert_eq!(s.begin_split_segment(120_000), "/rec/sermon_3.mp3");
        assert_eq!(
            s.segments(),
            ["/rec/sermon.mp3", "/rec/sermon_2.mp3", "/rec/sermon_3.mp3"]
        );
        assert_eq!(s.split_count(), 2);
        assert_eq!(s.current_segment(), "/rec/sermon_3.mp3");
        // Each split opened a NEW deliverable — three one-fragment deliverables.
        let dels = s.deliverables();
        assert_eq!(dels.len(), 3);
        assert_eq!(dels[0].primary_path, "/rec/sermon.mp3");
        assert_eq!(dels[1].primary_path, "/rec/sermon_2.mp3");
        assert_eq!(dels[2].primary_path, "/rec/sermon_3.mp3");
        assert!(dels.iter().all(|d| d.fragments.len() == 1));
    }

    // ── manual-max auto-stop ────────────────────────────────────────────────────

    #[test]
    fn auto_stop_uses_whole_session_and_respects_off() {
        let mut s = RecordingSession::new("/rec/x.mp3", 0);
        assert!(!s.should_auto_stop(999_999_999, 0)); // disabled
        assert!(!s.should_auto_stop(120 * 60_000 - 1, 120));
        assert!(s.should_auto_stop(120 * 60_000, 120));
        // A reconnect mid-session does NOT extend the cap (session_start fixed).
        let _ = s.on_unexpected_exit(60 * 60_000, None);
        assert!(s.should_auto_stop(120 * 60_000, 120));
    }

    // ── Segment accumulation across reconnect + split ───────────────────────────

    #[test]
    fn segments_accumulate_across_reconnect_and_split_in_order() {
        let mut s = RecordingSession::new("/rec/g.mp3", 0);
        // split at 30 min → _2 (opens deliverable 2)
        let _ = s.begin_split_segment(30 * 60_000);
        // reconnect during the _2 deliverable → its fragment derives from the
        // deliverable primary (`g_2`), not the session base → `g_2_r1`.
        let _ = s.on_unexpected_exit(35 * 60_000, None);
        // another split → _3 (opens deliverable 3)
        let _ = s.begin_split_segment(65 * 60_000);
        assert_eq!(
            s.segments(),
            [
                "/rec/g.mp3",
                "/rec/g_2.mp3",
                "/rec/g_2_r1.mp3",
                "/rec/g_3.mp3",
            ]
        );
        // primary is always the FIRST deliverable's original path; duration spans
        // the whole session.
        assert_eq!(s.primary_path(), "/rec/g.mp3");
        assert_eq!(s.elapsed_ms(65 * 60_000), 65 * 60_000);
        assert_eq!(s.session_start_ms(), 0);
    }

    // ── Path helpers ────────────────────────────────────────────────────────────

    #[test]
    fn reconnect_path_strips_existing_suffix() {
        assert_eq!(reconnect_segment_path("/a/b.mp3", 1), "/a/b_r1.mp3");
        // A path that already carries _r2 doesn't stack.
        assert_eq!(reconnect_segment_path("/a/b_r2.mp3", 3), "/a/b_r3.mp3");
        // No extension.
        assert_eq!(reconnect_segment_path("/a/b", 1), "/a/b_r1");
    }

    #[test]
    fn split_path_numbers_from_two_and_strips() {
        assert_eq!(split_segment_path("/a/b.mp3", 1), "/a/b_2.mp3");
        assert_eq!(split_segment_path("/a/b_3.mp3", 2), "/a/b_3.mp3");
    }

    #[test]
    fn split_ext_only_uses_filename_dot() {
        // A dotted directory must not be mistaken for an extension.
        assert_eq!(split_ext("/a.dir/rec"), ("/a.dir/rec", None));
        assert_eq!(split_ext("/a.dir/rec.wav"), ("/a.dir/rec", Some("wav")));
        // Windows separators.
        assert_eq!(split_ext("C:\\rec\\g.flac"), ("C:\\rec\\g", Some("flac")));
        // A leading-dot file name is not an extension.
        assert_eq!(split_ext("/a/.hidden"), ("/a/.hidden", None));
    }

    #[test]
    fn reconnect_fragment_path_preserves_split_number() {
        // A reconnect inside the FIRST deliverable: `g.mp3` → `g_r1.mp3`.
        assert_eq!(reconnect_fragment_path("/rec/g.mp3", 1), "/rec/g_r1.mp3");
        // A reconnect inside a SPLIT deliverable keeps the `_2`: `g_2` → `g_2_r1`.
        assert_eq!(
            reconnect_fragment_path("/rec/g_2.mp3", 1),
            "/rec/g_2_r1.mp3"
        );
        // A stacked reconnect strips only the prior `_rN`, not the `_2`.
        assert_eq!(
            reconnect_fragment_path("/rec/g_2_r1.mp3", 2),
            "/rec/g_2_r2.mp3"
        );
        // No extension.
        assert_eq!(reconnect_fragment_path("/rec/g_2", 1), "/rec/g_2_r1");
    }

    // ── Deliverable / fragment grouping (Fase 3.3a) ──────────────────────────────

    #[test]
    fn fresh_session_is_one_deliverable_one_fragment() {
        let s = RecordingSession::new("/rec/s.mp3", 100);
        let dels = s.deliverables();
        assert_eq!(dels.len(), 1);
        assert_eq!(dels[0].primary_path, "/rec/s.mp3");
        assert_eq!(dels[0].fragments, ["/rec/s.mp3"]);
        assert_eq!(dels[0].started_at_ms, 100);
        assert_eq!(s.current_deliverable_fragments(), ["/rec/s.mp3"]);
        assert!(s.current_is_first_deliverable());
    }

    #[test]
    fn reconnect_appends_fragment_to_current_deliverable() {
        let mut s = RecordingSession::new("/rec/s.mp3", 0);
        let _ = s.on_unexpected_exit(1_000, None);
        let _ = s.on_unexpected_exit(2_000, None);
        let dels = s.deliverables();
        // Still one deliverable, now three fragments.
        assert_eq!(dels.len(), 1);
        assert_eq!(
            dels[0].fragments,
            ["/rec/s.mp3", "/rec/s_r1.mp3", "/rec/s_r2.mp3"]
        );
        assert_eq!(
            s.current_deliverable_fragments(),
            ["/rec/s.mp3", "/rec/s_r1.mp3", "/rec/s_r2.mp3"]
        );
    }

    #[test]
    fn split_opens_new_deliverable_and_reconnect_targets_it() {
        let mut s = RecordingSession::new("/rec/s.mp3", 0);
        let _ = s.begin_split_segment(60_000);
        assert!(!s.current_is_first_deliverable());
        // A reconnect now lands in deliverable 2 → `s_2_r1`.
        let _ = s.on_unexpected_exit(70_000, None);
        let dels = s.deliverables();
        assert_eq!(dels.len(), 2);
        assert_eq!(dels[0].fragments, ["/rec/s.mp3"]);
        assert_eq!(dels[1].primary_path, "/rec/s_2.mp3");
        assert_eq!(dels[1].fragments, ["/rec/s_2.mp3", "/rec/s_2_r1.mp3"]);
        assert_eq!(dels[1].started_at_ms, 60_000);
    }

    #[test]
    fn deliverables_over_a_full_session() {
        // [preroll, frag, _r1, SPLIT, frag2, _r1] → 2 deliverables.
        // (Pre-roll is the engine's concern; here we model the recorder events:
        // start → reconnect → split → reconnect.)
        let mut s = RecordingSession::new("/rec/g.mp3", 0);
        let _ = s.on_unexpected_exit(10_000, None); // _r1 in deliverable 1
        let _ = s.begin_split_segment(1_800_000); // split → deliverable 2
        let _ = s.on_unexpected_exit(1_810_000, None); // _r1 in deliverable 2
        let dels = s.deliverables();
        assert_eq!(dels.len(), 2);
        // Deliverable 1: original + its reconnect fragment.
        assert_eq!(dels[0].primary_path, "/rec/g.mp3");
        assert_eq!(dels[0].fragments, ["/rec/g.mp3", "/rec/g_r1.mp3"]);
        assert_eq!(dels[0].started_at_ms, 0);
        // Deliverable 2: the split file + ITS reconnect fragment. The reconnect
        // ATTEMPT number is session-wide (the budget is session-wide), so this is
        // the SECOND reconnect of the session → `_r2`, derived from the
        // deliverable's `g_2` primary → `g_2_r2`.
        assert_eq!(dels[1].primary_path, "/rec/g_2.mp3");
        assert_eq!(dels[1].fragments, ["/rec/g_2.mp3", "/rec/g_2_r2.mp3"]);
        assert_eq!(dels[1].started_at_ms, 1_800_000);
    }

    // ── Concat-list / args / inputs (ports of Electron escPath + mergeSegments) ──

    #[test]
    fn escape_concat_path_windows_normalises_backslashes() {
        // Windows: `\` → `/`, then `'` → `\'`.
        assert_eq!(escape_concat_path("C:\\rec\\g.mp3", true), "C:/rec/g.mp3");
        assert_eq!(
            escape_concat_path("C:\\re'c\\g.mp3", true),
            "C:/re\\'c/g.mp3"
        );
    }

    #[test]
    fn escape_concat_path_posix_doubles_backslashes_and_quotes() {
        // POSIX: `\` → `\\`, then `'` → `\'`. A plain path is unchanged.
        assert_eq!(escape_concat_path("/rec/g.mp3", false), "/rec/g.mp3");
        // A literal backslash in a POSIX filename is doubled.
        assert_eq!(
            escape_concat_path("/rec/a\\b.mp3", false),
            "/rec/a\\\\b.mp3"
        );
        // An apostrophe (e.g. "St Olav's") is backslash-escaped.
        assert_eq!(
            escape_concat_path("/rec/Olav's.mp3", false),
            "/rec/Olav\\'s.mp3"
        );
    }

    #[test]
    fn build_concat_list_one_line_per_file() {
        let files = vec!["/rec/g.mp3".to_string(), "/rec/g_r1.mp3".to_string()];
        assert_eq!(
            build_concat_list(&files, false),
            "file '/rec/g.mp3'\nfile '/rec/g_r1.mp3'\n"
        );
        // Empty input → empty body.
        assert_eq!(build_concat_list(&[], false), "");
    }

    #[test]
    fn build_concat_args_match_electron() {
        assert_eq!(
            build_concat_args("/tmp/list.txt", "/rec/out.mp3"),
            vec![
                "-nostdin",
                "-hide_banner",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                "/tmp/list.txt",
                "-c",
                "copy",
                "-y",
                "/rec/out.mp3",
            ]
        );
    }

    #[test]
    fn concat_needed_only_when_multiple_fragments_or_preroll() {
        let one = vec!["/rec/g.mp3".to_string()];
        let two = vec!["/rec/g.mp3".to_string(), "/rec/g_r1.mp3".to_string()];
        // 1 fragment, no pre-roll → already finished, no concat.
        assert!(!concat_needed(&one, false));
        // 1 fragment + pre-roll → must prepend.
        assert!(concat_needed(&one, true));
        // >1 fragment → must stitch.
        assert!(concat_needed(&two, false));
        assert!(concat_needed(&two, true));
    }

    #[test]
    fn concat_inputs_prepend_preroll_then_fragments_in_order() {
        let frags = vec!["/rec/g.mp3".to_string(), "/rec/g_r1.mp3".to_string()];
        // No pre-roll → just the fragments in order.
        assert_eq!(concat_inputs(&frags, None), ["/rec/g.mp3", "/rec/g_r1.mp3"]);
        // Pre-roll first, then fragments.
        assert_eq!(
            concat_inputs(&frags, Some("/tmp/pre.mp3")),
            ["/tmp/pre.mp3", "/rec/g.mp3", "/rec/g_r1.mp3"]
        );
    }
}
