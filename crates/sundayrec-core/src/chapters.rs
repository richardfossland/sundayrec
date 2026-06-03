//! Deterministic, offline chapter detection from a sermon transcript.
//!
//! Scans each timestamped transcript line for **Bible references** (Norwegian
//! book names + chapter/verse) and explicit **enumeration points** ("for det
//! første", "punkt 2"), emitting a [`Chapter`](crate::editor::Chapter) at the
//! line's start time. Dense by design — every reference/point is a candidate —
//! but identical references that repeat within a short window are de-duplicated,
//! and markers that land too close together are thinned.
//!
//! No network, no model: pure string/regex work over the transcript, so it is
//! fully unit-tested and runs entirely on-device (matching the user's "local +
//! deterministic + dense" choice).
//!
//! Times are relative to the ORIGINAL recording (the transcript's timeline). The
//! editor export trims silence/cuts, so before embedding the chapters in the
//! exported file call [`remap_chapters_to_keeps`] with the export's
//! [`KeepSegment`](crate::editor::KeepSegment)s — it shifts each chapter onto the
//! output timeline and drops any that fall inside a cut.

use crate::editor::{Chapter, KeepSegment};
use regex::Regex;
use std::sync::OnceLock;

/// One timestamped transcript line fed to the detector. Decoupled from the
/// whisper-feature `TranscriptSegment` so detection compiles + tests without the
/// `whisper` feature; the command layer maps `TranscriptSegment` → this.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct TranscriptLine {
    pub start: f64,
    pub text: String,
}

/// Two markers closer than this (output seconds) collapse to the first — avoids a
/// cluster when several references share one short transcript line.
const MIN_GAP_SECONDS: f64 = 3.0;
/// The same reference repeated within this window is one chapter, not several
/// (a preacher re-reading the verse a line later).
const DEDUP_WINDOW_SECONDS: f64 = 45.0;

/// Norwegian Bible books: `(canonical display base, &[lowercase aliases])`. The
/// optional 1./2./3. ordinal is captured generically by the regex and prepended
/// to the display, so books that are sometimes/always numbered (Mosebok,
/// Korinterbrev, Johannes …) need only their base here.
const BOOKS: &[(&str, &[&str])] = &[
    // ── Det gamle testamente ──
    ("Mosebok", &["mosebok", "mos"]),
    ("Josva", &["josva", "jos"]),
    ("Dommerne", &["dommerne", "dom"]),
    ("Rut", &["rut"]),
    ("Samuelsbok", &["samuelsbok", "samuel", "sam"]),
    ("Kongebok", &["kongebok", "kong"]),
    ("Krønikebok", &["krønikebok", "krøn"]),
    ("Esra", &["esra"]),
    ("Nehemja", &["nehemja", "neh"]),
    ("Ester", &["ester"]),
    ("Job", &["job"]),
    ("Salme", &["salmene", "salme", "salm", "sal"]),
    ("Ordspråkene", &["ordspråkene", "ordspråk", "ordsp"]),
    ("Forkynneren", &["forkynneren", "fork"]),
    ("Høysangen", &["høysangen", "høys"]),
    ("Jesaja", &["jesaja", "jes"]),
    ("Jeremia", &["jeremia", "jer"]),
    ("Klagesangene", &["klagesangene", "klag"]),
    ("Esekiel", &["esekiel", "esek"]),
    ("Daniel", &["daniel", "dan"]),
    ("Hosea", &["hosea", "hos"]),
    ("Joel", &["joel"]),
    ("Amos", &["amos"]),
    ("Obadja", &["obadja", "obad"]),
    ("Jona", &["jona"]),
    ("Mika", &["mika"]),
    ("Nahum", &["nahum"]),
    ("Habakkuk", &["habakkuk", "hab"]),
    ("Sefanja", &["sefanja", "sef"]),
    ("Haggai", &["haggai", "hag"]),
    ("Sakarja", &["sakarja", "sak"]),
    ("Malaki", &["malaki", "mal"]),
    // ── Det nye testamente ──
    ("Matteus", &["matteus", "matt", "mat"]),
    ("Markus", &["markus", "mark", "mrk"]),
    ("Lukas", &["lukas", "luk"]),
    ("Johannes", &["johannes", "joh"]),
    (
        "Apostlenes gjerninger",
        &["apostlenes gjerninger", "apostlenes", "apg"],
    ),
    ("Romerne", &["romerbrevet", "romerne", "rom"]),
    (
        "Korinterbrev",
        &["korinterbrev", "korinterne", "korinter", "kor"],
    ),
    ("Galaterne", &["galaterne", "gal"]),
    ("Efeserne", &["efeserne", "ef"]),
    ("Filipperne", &["filipperne", "fil"]),
    ("Kolosserne", &["kolosserne", "kol"]),
    ("Tessaloniker", &["tessalonikerne", "tessaloniker", "tess"]),
    ("Timoteus", &["timoteus", "tim"]),
    ("Titus", &["titus"]),
    ("Filemon", &["filemon", "filem"]),
    ("Hebreerne", &["hebreerne", "hebr", "heb"]),
    ("Jakob", &["jakob", "jak"]),
    ("Peter", &["peters", "peter", "pet"]),
    ("Judas", &["judas"]),
    ("Åpenbaringen", &["åpenbaringen", "åpenbaring", "åp"]),
];

/// Compiled once: the big alternation regex + an alias→canonical lookup.
struct BibleMatcher {
    re: Regex,
    canonical: Vec<(String, &'static str)>,
}

fn bible_matcher() -> &'static BibleMatcher {
    static M: OnceLock<BibleMatcher> = OnceLock::new();
    M.get_or_init(|| {
        // Aliases longest-first so "korinterbrev" wins over "kor", "mosebok" over
        // "mos", etc. (regex alternation is leftmost, so order matters).
        let mut alias_pairs: Vec<(String, &'static str)> = Vec::new();
        for (canon, aliases) in BOOKS {
            for a in *aliases {
                alias_pairs.push(((*a).to_string(), *canon));
            }
        }
        alias_pairs.sort_by_key(|p| std::cmp::Reverse(p.0.len()));
        let alt = alias_pairs
            .iter()
            .map(|(a, _)| regex::escape(a))
            .collect::<Vec<_>>()
            .join("|");
        // (?ix): case-insensitive. Optional ordinal, book, chapter, optional
        // verse (`:` or `,` or `.` separator, or the spoken "kapittel N vers M").
        let pattern = format!(
            r"(?ix)
            \b
            (?: (?P<ord>[1-3]) \s* \.? \s* )?
            (?P<book> {alt} ) \b \.?
            \s+ (?: kapittel \s+ )?
            (?P<chap> \d{{1,3}} )
            (?:
                \s* (?: [:,.] | \s vers \s ) \s*
                (?P<verse> \d{{1,3}} )
                (?: \s* [-–] \s* (?P<vend> \d{{1,3}} ) )?
            )?
            "
        );
        BibleMatcher {
            re: Regex::new(&pattern).expect("bible regex compiles"),
            canonical: alias_pairs,
        }
    })
}

fn canonical_for(alias_lower: &str) -> &'static str {
    let m = bible_matcher();
    m.canonical
        .iter()
        .find(|(a, _)| a == alias_lower)
        .map(|(_, c)| *c)
        .unwrap_or("")
}

/// Enumeration / point markers ("for det andre", "punkt 2", "mitt tredje poeng").
fn point_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"(?ix)\b(
                for \s+ det \s+ (?:første|andre|tredje|fjerde|femte|sjette|sjuende|syvende)
              | (?:mitt|det) \s+ (?:første|andre|tredje|fjerde|femte) \s+ poeng(?:et)?
              | punkt \s+ (?:\d{1,2}|én|en|to|tre|fire|fem|seks)
              | nummer \s+ (?:\d{1,2}|én|en|to|tre|fire|fem|seks)
            )\b",
        )
        .expect("point regex compiles")
    })
}

/// Title-case the first letter of a matched phrase, collapsing inner whitespace.
fn tidy_phrase(s: &str) -> String {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = collapsed.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => collapsed,
    }
}

/// Format a Bible reference title from the captured parts, e.g. `1. Korinterbrev
/// 13:4-7`, `Salme 23`, `Johannes 3:16`.
fn format_reference(
    ord: Option<&str>,
    canon: &str,
    chap: &str,
    verse: Option<&str>,
    vend: Option<&str>,
) -> String {
    let mut s = String::new();
    if let Some(o) = ord {
        s.push_str(o);
        s.push_str(". ");
    }
    s.push_str(canon);
    s.push(' ');
    s.push_str(chap);
    if let Some(v) = verse {
        s.push(':');
        s.push_str(v);
        if let Some(ve) = vend {
            s.push('-');
            s.push_str(ve);
        }
    }
    s
}

/// Detect chapters across the transcript. Returns markers sorted by time, deduped
/// (identical title within `DEDUP_WINDOW_SECONDS`) and thinned (no two closer
/// than `MIN_GAP_SECONDS`). Times are in the ORIGINAL recording's timeline.
pub fn detect_chapters(lines: &[TranscriptLine]) -> Vec<Chapter> {
    let bible = bible_matcher();
    let points = point_re();
    let mut raw: Vec<Chapter> = Vec::new();

    for line in lines {
        for cap in bible.re.captures_iter(&line.text) {
            let book_lower = cap.name("book").unwrap().as_str().to_lowercase();
            let canon = canonical_for(&book_lower);
            if canon.is_empty() {
                continue;
            }
            let title = format_reference(
                cap.name("ord").map(|m| m.as_str()),
                canon,
                cap.name("chap").unwrap().as_str(),
                cap.name("verse").map(|m| m.as_str()),
                cap.name("vend").map(|m| m.as_str()),
            );
            raw.push(Chapter {
                time: line.start,
                title,
            });
        }
        for cap in points.captures_iter(&line.text) {
            raw.push(Chapter {
                time: line.start,
                title: tidy_phrase(cap.get(0).unwrap().as_str()),
            });
        }
    }

    raw.sort_by(|a, b| {
        a.time
            .partial_cmp(&b.time)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Dedup identical titles within the window + thin markers that are too close.
    let mut out: Vec<Chapter> = Vec::new();
    for ch in raw {
        let dup_recent = out
            .iter()
            .rev()
            .take_while(|p| ch.time - p.time <= DEDUP_WINDOW_SECONDS)
            .any(|p| p.title == ch.title);
        if dup_recent {
            continue;
        }
        if let Some(last) = out.last() {
            if ch.time - last.time < MIN_GAP_SECONDS {
                continue;
            }
        }
        out.push(ch);
    }
    out
}

/// Shift detected chapters (original-recording timeline) onto the EXPORTED
/// timeline defined by `keeps`. A chapter inside a kept region maps to
/// `cumulative_kept_before + (time - keep.start)`; a chapter that falls inside a
/// cut (no keep contains it) is dropped. Result is sorted, with any markers that
/// collapsed onto the same output time thinned.
pub fn remap_chapters_to_keeps(chapters: &[Chapter], keeps: &[KeepSegment]) -> Vec<Chapter> {
    let mut out: Vec<Chapter> = Vec::new();
    for ch in chapters {
        let mut base = 0.0;
        for k in keeps {
            if ch.time >= k.start && ch.time < k.end {
                out.push(Chapter {
                    time: base + (ch.time - k.start),
                    title: ch.title.clone(),
                });
                break;
            }
            base += k.end - k.start;
        }
    }
    out.sort_by(|a, b| {
        a.time
            .partial_cmp(&b.time)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    // After remap two chapters can collapse onto (almost) the same time.
    let mut thinned: Vec<Chapter> = Vec::new();
    for ch in out {
        if let Some(last) = thinned.last() {
            if ch.time - last.time < MIN_GAP_SECONDS {
                continue;
            }
        }
        thinned.push(ch);
    }
    thinned
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::KeepSegment;

    fn line(start: f64, text: &str) -> TranscriptLine {
        TranscriptLine {
            start,
            text: text.to_string(),
        }
    }

    #[test]
    fn detects_common_bible_reference_forms() {
        let t = vec![
            line(10.0, "La oss lese fra Johannes 3:16 i kveld."),
            line(60.0, "Og vi ser i Salme 23 hvordan Herren er min hyrde."),
            line(
                120.0,
                "Paulus skriver i 1. Korinterbrev 13:4-7 om kjærligheten.",
            ),
            line(180.0, "I Matteus kapittel 5 vers 14 kalles vi verdens lys."),
            line(240.0, "Den norske komma-formen finner vi i Romerne 8,28."),
        ];
        let ch = detect_chapters(&t);
        let titles: Vec<&str> = ch.iter().map(|c| c.title.as_str()).collect();
        assert!(titles.contains(&"Johannes 3:16"), "got {titles:?}");
        assert!(titles.contains(&"Salme 23"), "got {titles:?}");
        assert!(titles.contains(&"1. Korinterbrev 13:4-7"), "got {titles:?}");
        assert!(titles.contains(&"Matteus 5:14"), "got {titles:?}");
        assert!(titles.contains(&"Romerne 8:28"), "got {titles:?}");
    }

    #[test]
    fn detects_enumeration_points() {
        let t = vec![
            line(30.0, "For det første må vi forstå nåden."),
            line(300.0, "For det andre handler det om tjeneste."),
            line(600.0, "Mitt tredje poeng er om håpet."),
        ];
        let ch = detect_chapters(&t);
        let titles: Vec<&str> = ch.iter().map(|c| c.title.as_str()).collect();
        assert!(
            titles.iter().any(|t| t.starts_with("For det første")),
            "got {titles:?}"
        );
        assert!(
            titles.iter().any(|t| t.starts_with("For det andre")),
            "got {titles:?}"
        );
        assert!(
            titles.iter().any(|t| t.starts_with("Mitt tredje poeng")),
            "got {titles:?}"
        );
    }

    #[test]
    fn dedups_repeated_reference_in_window_but_keeps_later_repeat() {
        let t = vec![
            line(10.0, "Johannes 3:16 sier at Gud elsket verden."),
            line(20.0, "Igjen, Johannes 3:16 — så høyt elsket Gud."), // within 45 s → dropped
            line(400.0, "Tilbake til Johannes 3:16 til slutt."),      // far later → kept
        ];
        let ch = detect_chapters(&t);
        let j316: Vec<f64> = ch
            .iter()
            .filter(|c| c.title == "Johannes 3:16")
            .map(|c| c.time)
            .collect();
        assert_eq!(j316, vec![10.0, 400.0], "got {ch:?}");
    }

    #[test]
    fn thins_markers_that_are_too_close() {
        let t = vec![line(10.0, "Som Johannes 3:16 og Romerne 8:28 begge viser.")];
        let ch = detect_chapters(&t);
        // Both refs share start=10.0; MIN_GAP keeps only the first.
        assert_eq!(ch.len(), 1, "got {ch:?}");
    }

    #[test]
    fn remap_shifts_into_export_timeline_and_drops_chapters_in_cuts() {
        // Kept 0–100 and 200–300 (the 100–200 stretch was cut).
        let keeps = vec![
            KeepSegment {
                start: 0.0,
                end: 100.0,
            },
            KeepSegment {
                start: 200.0,
                end: 300.0,
            },
        ];
        let chapters = vec![
            Chapter {
                time: 50.0,
                title: "A".into(),
            }, // in keep 1 → 50.0
            Chapter {
                time: 150.0,
                title: "B".into(),
            }, // inside the cut → dropped
            Chapter {
                time: 250.0,
                title: "C".into(),
            }, // in keep 2 → 100 + 50 = 150.0
        ];
        let out = remap_chapters_to_keeps(&chapters, &keeps);
        assert_eq!(out.len(), 2, "got {out:?}");
        assert_eq!(out[0].title, "A");
        assert!((out[0].time - 50.0).abs() < 1e-6);
        assert_eq!(out[1].title, "C");
        assert!((out[1].time - 150.0).abs() < 1e-6);
    }
}
