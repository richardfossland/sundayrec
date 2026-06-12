//! Live cue-bridge consumer (Bridge Integration #2) — pure mapping (P2a).
//!
//! SundayStage publishes "what is on the stage right now" over a Supabase
//! Realtime channel (`church:{churchId}:service:{serviceId}`); SundayRec
//! SUBSCRIBES so the running recording gains live chapter markers and tracks the
//! service's live/ended state. The actual Realtime subscribe is a NETWORK/INFRA
//! seam the `src-tauri` shell owns (behind the default-off `bridge` feature);
//! THIS module is the pure, deterministic mapping:
//!   - [`live_channel_name`] — the channel-name derivation (matches the
//!     canonical `liveChannel` and Stage's `liveEmitter.ts`),
//!   - [`LiveEvent`] — the mirrored event union,
//!   - [`LiveBridgeState`] + [`apply_event`] — fold an inbound event into the
//!     recording's chapter list + live/ended flag, with monotonic-`sequence` gap
//!     detection so the shell can log dropped broadcasts.
//!
//! ## Contract mirror
//!
//! [`LiveEvent`] and [`SongRef`] are FIELD-IDENTICAL mirrors of the canonical
//! contract in sunday-platform `sunday-contracts` v0.4.0
//! (`crates/sunday-contracts/src/live.rs` / `src/song.rs`; the sender is
//! Stage's `src/lib/liveEmitter.ts`, the same mirror): snake_case wire keys, a
//! `type` discriminator, a `schema_version`/`service_id`/`emitted_at`(ISO
//! 8601)/`sequence` envelope. Converge onto the published crate once apps can
//! depend on it; do not add or rename fields without changing the canonical
//! contract first.

use serde::{Deserialize, Serialize};

use super::ChapterMarker;

/// Realtime channel name: one channel per live service. Matches the canonical
/// `live_channel(church_id, service_id)` exactly. Returns `None` when either id
/// is empty (Stage throws; we surface it as `None` so the shell can refuse to
/// subscribe rather than panic).
pub fn live_channel_name(church_id: &str, service_id: &str) -> Option<String> {
    if church_id.is_empty() || service_id.is_empty() {
        return None;
    }
    Some(format!("church:{church_id}:service:{service_id}"))
}

/// Wire schema version every canonical payload carries.
pub const SCHEMA_VERSION: u32 = 1;

fn default_schema_version() -> u32 {
    SCHEMA_VERSION
}

/// A cross-app reference to a song. FIELD-IDENTICAL mirror of the canonical
/// `SongRef` (sunday-contracts v0.4.0, song.rs). The sender's local song row id
/// rides in `local_id`; `sundaysong_id` is the shared-catalog id when linked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SongRef {
    pub sundaysong_id: Option<String>,
    pub local_id: Option<String>,
    pub title: String,
    pub ccli_song_id: Option<String>,
    pub tono_work_id: Option<String>,
    pub default_key: Option<String>,
    pub language: String,
}

// ── Event union (canonical LiveEvent mirror) ────────────────────────────────

/// An inbound live event. FIELD-IDENTICAL mirror of the canonical `LiveEvent`
/// (sunday-contracts v0.4.0, live.rs): internally tagged on `type`, snake_case
/// keys, ISO-8601 `emitted_at`, monotonic `sequence`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum LiveEvent {
    /// The presenter moved to a new cue/slide.
    #[serde(rename = "cue.advanced")]
    CueAdvanced {
        #[serde(default = "default_schema_version")]
        schema_version: u32,
        service_id: String,
        emitted_at: String,
        sequence: u64,
        item_id: Option<String>,
        item_position: Option<i64>,
        label: Option<String>,
        slide_index: Option<i64>,
    },
    /// A song became the active item (the prime source of recording chapters).
    #[serde(rename = "now_playing")]
    NowPlaying {
        #[serde(default = "default_schema_version")]
        schema_version: u32,
        service_id: String,
        emitted_at: String,
        sequence: u64,
        song_ref: Option<SongRef>,
        item_position: Option<i64>,
        title: Option<String>,
    },
    /// The service went live (presentation started).
    #[serde(rename = "service.live")]
    ServiceLive {
        #[serde(default = "default_schema_version")]
        schema_version: u32,
        service_id: String,
        emitted_at: String,
        sequence: u64,
    },
    /// The service ended.
    #[serde(rename = "service.ended")]
    ServiceEnded {
        #[serde(default = "default_schema_version")]
        schema_version: u32,
        service_id: String,
        emitted_at: String,
        sequence: u64,
    },
}

impl LiveEvent {
    /// The monotonic per-service sequence number on this event.
    pub fn sequence(&self) -> u64 {
        match self {
            LiveEvent::CueAdvanced { sequence, .. }
            | LiveEvent::NowPlaying { sequence, .. }
            | LiveEvent::ServiceLive { sequence, .. }
            | LiveEvent::ServiceEnded { sequence, .. } => *sequence,
        }
    }

    /// The event's ISO-8601 mint time, verbatim off the wire.
    pub fn emitted_at(&self) -> &str {
        match self {
            LiveEvent::CueAdvanced { emitted_at, .. }
            | LiveEvent::NowPlaying { emitted_at, .. }
            | LiveEvent::ServiceLive { emitted_at, .. }
            | LiveEvent::ServiceEnded { emitted_at, .. } => emitted_at,
        }
    }

    /// The event's mint time as unix ms, when `emitted_at` parses as RFC 3339.
    /// `None` for a malformed stamp — the fold degrades to time 0 rather than
    /// dropping the event.
    pub fn emitted_at_ms(&self) -> Option<i64> {
        chrono::DateTime::parse_from_rfc3339(self.emitted_at())
            .ok()
            .map(|dt| dt.timestamp_millis())
    }

    /// The service id this event belongs to.
    pub fn service_id(&self) -> &str {
        match self {
            LiveEvent::CueAdvanced { service_id, .. }
            | LiveEvent::NowPlaying { service_id, .. }
            | LiveEvent::ServiceLive { service_id, .. }
            | LiveEvent::ServiceEnded { service_id, .. } => service_id,
        }
    }
}

// ── Consumer state machine ──────────────────────────────────────────────────

/// The live-service status as the bridge consumer understands it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LiveStatus {
    /// No `service.live` seen yet.
    #[default]
    Idle,
    /// `service.live` received; service is running.
    Live,
    /// `service.ended` received.
    Ended,
}

/// What [`apply_event`] decided to do with one inbound event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeEffect {
    /// A new chapter marker was appended (from a `now_playing` / labelled cue).
    ChapterAdded(ChapterMarker),
    /// The service went live; the shell may stamp the recording start origin.
    /// `started_at_ms` is the event's `emitted_at` (None if it didn't parse).
    WentLive { started_at_ms: Option<i64> },
    /// The service ended; the shell may finalize/stop or just note it.
    Ended,
    /// A cue advanced (or a now_playing with no usable title) but carried no
    /// chapter-worthy label — state-only.
    CueOnly { item_position: Option<i64> },
    /// The event was for a different service / out of scope — ignored.
    Ignored,
}

/// The folded state of the cue bridge for one recording. The shell holds one of
/// these per live subscription and feeds every inbound event through
/// [`apply_event`].
#[derive(Debug, Clone, PartialEq)]
pub struct LiveBridgeState {
    /// The service we're tracking; events for other services are ignored.
    pub service_id: String,
    /// Recording start in unix ms — chapter time is `(event_ms - this)/1000`.
    /// `None` until `service.live` (or the shell) sets the origin.
    pub recording_start_ms: Option<i64>,
    /// Highest `sequence` seen; a lower/equal value is a stale/replayed
    /// broadcast.
    pub last_seq: u64,
    /// Count of detected gaps (a sequence jump > 1) — surfaced for logging.
    pub gaps: u32,
    pub status: LiveStatus,
    /// Chapters accumulated from the live cues, in arrival (time) order.
    pub chapters: Vec<ChapterMarker>,
}

impl LiveBridgeState {
    /// Start tracking `service_id`. `recording_start_ms` may be known already
    /// (the recorder started first) or `None` (set on `service.live`).
    pub fn new(service_id: impl Into<String>, recording_start_ms: Option<i64>) -> Self {
        Self {
            service_id: service_id.into(),
            recording_start_ms,
            last_seq: 0,
            gaps: 0,
            status: LiveStatus::Idle,
            chapters: Vec::new(),
        }
    }

    /// Chapter time (seconds, clamped ≥0) for an event time, given the current
    /// origin. `None` when no origin (or no parseable event time) is known yet.
    fn chapter_time(&self, at_ms: Option<i64>) -> Option<i64> {
        match (self.recording_start_ms, at_ms) {
            (Some(origin), Some(at)) => {
                Some((((at - origin) as f64 / 1000.0).round().max(0.0)) as i64)
            }
            _ => None,
        }
    }
}

/// Fold one inbound [`LiveEvent`] into the bridge state, returning the effect the
/// shell should act on. Mirrors how SundayRec consumes the cue feed:
///
/// - events for a different service are `Ignored`,
/// - a non-advancing `sequence` (≤ `last_seq`) is a stale replay → `Ignored`
///   (and does NOT mutate state); a jump > 1 increments the gap counter,
/// - `service.live` sets the origin (if not already set, from `emitted_at`) +
///   status → `WentLive`,
/// - `service.ended` sets status → `Ended`,
/// - `now_playing` appends a chapter at the song title (the event `title`, else
///   the `song_ref` title); with neither it's a state-only `CueOnly`,
/// - `cue.advanced` with a non-empty `label` appends a chapter at that label;
///   otherwise it's a state-only `CueOnly`.
pub fn apply_event(state: &mut LiveBridgeState, event: &LiveEvent) -> BridgeEffect {
    if event.service_id() != state.service_id {
        return BridgeEffect::Ignored;
    }

    let sequence = event.sequence();
    // Stale or replayed broadcast — ignore without mutating (idempotent).
    if sequence <= state.last_seq {
        return BridgeEffect::Ignored;
    }
    if state.last_seq != 0 && sequence > state.last_seq + 1 {
        state.gaps += 1;
    }
    state.last_seq = sequence;

    let at_ms = event.emitted_at_ms();

    match event {
        LiveEvent::ServiceLive { .. } => {
            state.status = LiveStatus::Live;
            if state.recording_start_ms.is_none() {
                state.recording_start_ms = at_ms;
            }
            BridgeEffect::WentLive {
                started_at_ms: at_ms,
            }
        }
        LiveEvent::ServiceEnded { .. } => {
            state.status = LiveStatus::Ended;
            BridgeEffect::Ended
        }
        LiveEvent::NowPlaying {
            title,
            song_ref,
            item_position,
            ..
        } => {
            // The song's clean title; the event-level title wins, then the ref's.
            let chapter = title
                .as_deref()
                .filter(|t| !t.is_empty())
                .or_else(|| {
                    song_ref
                        .as_ref()
                        .map(|r| r.title.as_str())
                        .filter(|t| !t.is_empty())
                })
                .map(str::to_owned);
            match chapter {
                Some(title) => {
                    let marker = ChapterMarker {
                        time: state.chapter_time(at_ms).unwrap_or(0),
                        title,
                    };
                    state.chapters.push(marker.clone());
                    BridgeEffect::ChapterAdded(marker)
                }
                None => BridgeEffect::CueOnly {
                    item_position: *item_position,
                },
            }
        }
        LiveEvent::CueAdvanced {
            label,
            item_position,
            ..
        } => match label.as_ref().filter(|l| !l.is_empty()) {
            Some(label) => {
                let marker = ChapterMarker {
                    time: state.chapter_time(at_ms).unwrap_or(0),
                    title: label.clone(),
                };
                state.chapters.push(marker.clone());
                BridgeEffect::ChapterAdded(marker)
            }
            None => BridgeEffect::CueOnly {
                item_position: *item_position,
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ISO stamp for a unix-ms instant (what Stage's builders emit).
    fn iso(ms: i64) -> String {
        chrono::DateTime::from_timestamp_millis(ms)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    #[test]
    fn channel_name_matches_stage_emitter() {
        assert_eq!(
            live_channel_name("ch1", "svc1").as_deref(),
            Some("church:ch1:service:svc1")
        );
        assert!(live_channel_name("", "svc1").is_none());
        assert!(live_channel_name("ch1", "").is_none());
    }

    fn song_ref(local_id: &str, title: &str) -> SongRef {
        SongRef {
            sundaysong_id: None,
            local_id: Some(local_id.into()),
            title: title.into(),
            ccli_song_id: None,
            tono_work_id: None,
            default_key: None,
            language: "und".into(),
        }
    }

    fn now_playing(sequence: u64, at_ms: i64, title: &str) -> LiveEvent {
        LiveEvent::NowPlaying {
            schema_version: SCHEMA_VERSION,
            service_id: "svc1".into(),
            emitted_at: iso(at_ms),
            sequence,
            song_ref: Some(song_ref("song-1", title)),
            item_position: Some(0),
            title: Some(title.into()),
        }
    }

    #[test]
    fn live_event_deserializes_from_canonical_wire_shape() {
        // Exactly what Stage's buildCueAdvanced serialises (canonical v0.4.0).
        let json = r#"{"type":"cue.advanced","schema_version":1,"service_id":"svc1",
            "emitted_at":"2026-05-31T09:01:00.000Z","sequence":3,
            "item_id":"item-2","item_position":2,"label":"Vers 2","slide_index":null}"#;
        let e: LiveEvent = serde_json::from_str(json).unwrap();
        assert_eq!(e.sequence(), 3);
        assert_eq!(e.service_id(), "svc1");
        assert!(e.emitted_at_ms().is_some());
        match e {
            LiveEvent::CueAdvanced {
                label,
                item_position,
                ..
            } => {
                assert_eq!(label.as_deref(), Some("Vers 2"));
                assert_eq!(item_position, Some(2));
            }
            _ => panic!("expected cue.advanced"),
        }

        // A canonical now_playing with a song_ref.
        let json = r#"{"type":"now_playing","schema_version":1,"service_id":"svc1",
            "emitted_at":"2026-05-31T09:00:00Z","sequence":1,
            "song_ref":{"sundaysong_id":null,"local_id":"song-9","title":"Amazing Grace",
                        "ccli_song_id":null,"tono_work_id":null,"default_key":null,
                        "language":"und"},
            "item_position":3,"title":"Amazing Grace"}"#;
        let e: LiveEvent = serde_json::from_str(json).unwrap();
        match e {
            LiveEvent::NowPlaying { song_ref, .. } => {
                assert_eq!(
                    song_ref.as_ref().and_then(|r| r.local_id.as_deref()),
                    Some("song-9")
                );
            }
            _ => panic!("expected now_playing"),
        }

        // A bare service.live and a payload missing schema_version (older
        // emitter) both still parse.
        let live: LiveEvent = serde_json::from_str(
            r#"{"type":"service.live","service_id":"svc1","emitted_at":"2026-05-31T09:00:00Z","sequence":1}"#,
        )
        .unwrap();
        assert!(
            matches!(live, LiveEvent::ServiceLive { schema_version, .. } if schema_version == SCHEMA_VERSION)
        );
    }

    #[test]
    fn service_live_sets_origin_and_status_from_emitted_at() {
        let mut st = LiveBridgeState::new("svc1", None);
        let e = LiveEvent::ServiceLive {
            schema_version: SCHEMA_VERSION,
            service_id: "svc1".into(),
            emitted_at: iso(100_000),
            sequence: 1,
        };
        assert_eq!(
            apply_event(&mut st, &e),
            BridgeEffect::WentLive {
                started_at_ms: Some(100_000)
            }
        );
        assert_eq!(st.status, LiveStatus::Live);
        assert_eq!(st.recording_start_ms, Some(100_000));
    }

    #[test]
    fn now_playing_adds_a_chapter_at_offset_from_origin() {
        let mut st = LiveBridgeState::new("svc1", Some(100_000));
        let effect = apply_event(&mut st, &now_playing(1, 160_000, "Amazing Grace"));
        // (160000 - 100000)/1000 = 60s
        assert_eq!(
            effect,
            BridgeEffect::ChapterAdded(ChapterMarker {
                time: 60,
                title: "Amazing Grace".into()
            })
        );
        assert_eq!(st.chapters.len(), 1);
    }

    #[test]
    fn now_playing_falls_back_to_the_song_ref_title() {
        let mut st = LiveBridgeState::new("svc1", Some(0));
        let e = LiveEvent::NowPlaying {
            schema_version: SCHEMA_VERSION,
            service_id: "svc1".into(),
            emitted_at: iso(5_000),
            sequence: 1,
            song_ref: Some(song_ref("song-2", "Oceans")),
            item_position: Some(1),
            title: None, // event-level title absent → the ref's title carries it
        };
        assert_eq!(
            apply_event(&mut st, &e),
            BridgeEffect::ChapterAdded(ChapterMarker {
                time: 5,
                title: "Oceans".into()
            })
        );
    }

    #[test]
    fn now_playing_without_any_title_is_state_only() {
        let mut st = LiveBridgeState::new("svc1", Some(0));
        let e = LiveEvent::NowPlaying {
            schema_version: SCHEMA_VERSION,
            service_id: "svc1".into(),
            emitted_at: iso(5_000),
            sequence: 1,
            song_ref: None,
            item_position: Some(4),
            title: None,
        };
        assert_eq!(
            apply_event(&mut st, &e),
            BridgeEffect::CueOnly {
                item_position: Some(4)
            }
        );
        assert!(st.chapters.is_empty());
    }

    #[test]
    fn cue_advanced_with_label_adds_chapter_without_label_is_state_only() {
        let mut st = LiveBridgeState::new("svc1", Some(0));
        let labelled = LiveEvent::CueAdvanced {
            schema_version: SCHEMA_VERSION,
            service_id: "svc1".into(),
            emitted_at: iso(3_000),
            sequence: 1,
            item_id: Some("item-1".into()),
            item_position: Some(1),
            label: Some("Preken".into()),
            slide_index: None,
        };
        assert!(matches!(
            apply_event(&mut st, &labelled),
            BridgeEffect::ChapterAdded(_)
        ));

        let bare = LiveEvent::CueAdvanced {
            schema_version: SCHEMA_VERSION,
            service_id: "svc1".into(),
            emitted_at: iso(4_000),
            sequence: 2,
            item_id: None,
            item_position: Some(2),
            label: None,
            slide_index: None,
        };
        assert_eq!(
            apply_event(&mut st, &bare),
            BridgeEffect::CueOnly {
                item_position: Some(2)
            }
        );
        assert_eq!(st.chapters.len(), 1); // bare cue added no chapter
    }

    #[test]
    fn events_for_other_services_are_ignored() {
        let mut st = LiveBridgeState::new("svc1", Some(0));
        let other = LiveEvent::NowPlaying {
            schema_version: SCHEMA_VERSION,
            service_id: "OTHER".into(),
            emitted_at: iso(0),
            sequence: 1,
            song_ref: None,
            item_position: None,
            title: Some("x".into()),
        };
        assert_eq!(apply_event(&mut st, &other), BridgeEffect::Ignored);
        assert_eq!(st.last_seq, 0); // not advanced
    }

    #[test]
    fn stale_or_replayed_sequence_is_ignored_idempotently() {
        let mut st = LiveBridgeState::new("svc1", Some(0));
        apply_event(&mut st, &now_playing(5, 1000, "first"));
        assert_eq!(st.last_seq, 5);
        // Replay of sequence 5 (or lower) → ignored, no extra chapter.
        assert_eq!(
            apply_event(&mut st, &now_playing(5, 1000, "first")),
            BridgeEffect::Ignored
        );
        assert_eq!(
            apply_event(&mut st, &now_playing(3, 500, "older")),
            BridgeEffect::Ignored
        );
        assert_eq!(st.chapters.len(), 1);
    }

    #[test]
    fn sequence_gap_increments_gap_counter() {
        let mut st = LiveBridgeState::new("svc1", Some(0));
        apply_event(&mut st, &now_playing(1, 0, "a"));
        apply_event(&mut st, &now_playing(4, 1000, "b")); // jumped 1 → 4 = gap
        assert_eq!(st.gaps, 1);
        assert_eq!(st.last_seq, 4);
        assert_eq!(st.chapters.len(), 2); // both still applied
    }

    #[test]
    fn service_ended_sets_status() {
        let mut st = LiveBridgeState::new("svc1", Some(0));
        let e = LiveEvent::ServiceEnded {
            schema_version: SCHEMA_VERSION,
            service_id: "svc1".into(),
            emitted_at: iso(9),
            sequence: 1,
        };
        assert_eq!(apply_event(&mut st, &e), BridgeEffect::Ended);
        assert_eq!(st.status, LiveStatus::Ended);
    }

    #[test]
    fn chapter_time_is_zero_when_origin_unknown() {
        let mut st = LiveBridgeState::new("svc1", None);
        let effect = apply_event(&mut st, &now_playing(1, 999_999, "x"));
        assert_eq!(
            effect,
            BridgeEffect::ChapterAdded(ChapterMarker {
                time: 0,
                title: "x".into()
            })
        );
    }

    #[test]
    fn chapter_time_is_zero_when_emitted_at_is_malformed() {
        // A garbage timestamp must degrade (chapter at 0), never drop the event.
        let mut st = LiveBridgeState::new("svc1", Some(100_000));
        let e = LiveEvent::NowPlaying {
            schema_version: SCHEMA_VERSION,
            service_id: "svc1".into(),
            emitted_at: "not-a-timestamp".into(),
            sequence: 1,
            song_ref: None,
            item_position: None,
            title: Some("Hymn".into()),
        };
        assert_eq!(
            apply_event(&mut st, &e),
            BridgeEffect::ChapterAdded(ChapterMarker {
                time: 0,
                title: "Hymn".into()
            })
        );
    }
}
