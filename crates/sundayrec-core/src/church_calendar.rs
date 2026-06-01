//! Norwegian liturgical calendar — pure, ported from the Electron
//! `shared/church-calendar.ts`.
//!
//! Computes Easter Sunday (anonymous Gregorian / Meeus–Jones–Butcher computus)
//! and resolves a [`NaiveDate`] to the Norwegian name of a known liturgical day:
//! the moveable feasts anchored on Easter, plus the fixed-date holidays. Ordinary
//! days return `None` so [`crate::filename::build_filename`] keeps its
//! `"gudstjeneste"` fallback for the `church` pattern.
//!
//! No clock features are used — every entry point takes an explicit date.

use chrono::{Datelike, NaiveDate};

/// Easter Sunday for a Gregorian `year`, returned as `(month, day)`.
///
/// Anonymous Gregorian algorithm (Meeus–Jones–Butcher). Pure integer math,
/// valid for all Gregorian years.
pub fn easter_sunday(year: i32) -> (u32, u32) {
    let a = year % 19;
    let b = year / 100;
    let c = year % 100;
    let d = b / 4;
    let e = b % 4;
    let f = (b + 8) / 25;
    let g = (b - f + 1) / 3;
    let h = (19 * a + b - d - g + 15) % 30;
    let i = c / 4;
    let k = c % 4;
    let l = (32 + 2 * e + 2 * i - h - k) % 7;
    let m = (a + 11 * h + 22 * l) / 451;
    let month = (h + l - 7 * m + 114) / 31; // 3 = March, 4 = April
    let day = ((h + l - 7 * m + 114) % 31) + 1;
    (month as u32, day as u32)
}

/// The Norwegian name of the liturgical day on `date`, or `None` for an ordinary
/// day. Moveable feasts are computed relative to Easter Sunday; fixed holidays
/// are matched by month/day.
pub fn liturgical_day_name(date: NaiveDate) -> Option<String> {
    let year = date.year();
    let (em, ed) = easter_sunday(year);
    // `NaiveDate::from_ymd_opt` only fails on impossible dates; Easter is always
    // a valid March/April date, so this never panics in practice.
    let easter = NaiveDate::from_ymd_opt(year, em, ed)?;

    // Moveable feasts, by signed day-offset from Easter Sunday.
    let offset = (date - easter).num_days();
    let moveable = match offset {
        -7 => Some("palmesøndag"),
        -3 => Some("skjærtorsdag"),
        -2 => Some("langfredag"),
        0 => Some("1. påskedag"),
        1 => Some("2. påskedag"),
        39 => Some("Kristi himmelfartsdag"),
        49 => Some("1. pinsedag"),
        50 => Some("2. pinsedag"),
        _ => None,
    };
    if let Some(name) = moveable {
        return Some(name.to_string());
    }

    // Fixed-date holidays.
    let fixed = match (date.month(), date.day()) {
        (1, 1) => Some("1. nyttårsdag"),
        (5, 1) => Some("1. mai"),
        (5, 17) => Some("Grunnlovsdag"),
        (12, 24) => Some("julaften"),
        (12, 25) => Some("1. juledag"),
        (12, 26) => Some("2. juledag"),
        (12, 31) => Some("nyttårsaften"),
        _ => None,
    };
    fixed.map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn easter_known_dates() {
        // Verified against published Easter tables.
        assert_eq!(easter_sunday(2024), (3, 31));
        assert_eq!(easter_sunday(2025), (4, 20));
        assert_eq!(easter_sunday(2026), (4, 5));
    }

    #[test]
    fn easter_sunday_resolves_first_paaskedag() {
        assert_eq!(
            liturgical_day_name(d(2026, 4, 5)).as_deref(),
            Some("1. påskedag")
        );
    }

    #[test]
    fn moveable_feasts_around_easter_2026() {
        // Easter 2026 = April 5.
        assert_eq!(
            liturgical_day_name(d(2026, 3, 29)).as_deref(), // -7
            Some("palmesøndag")
        );
        assert_eq!(
            liturgical_day_name(d(2026, 4, 2)).as_deref(), // -3
            Some("skjærtorsdag")
        );
        assert_eq!(
            liturgical_day_name(d(2026, 4, 3)).as_deref(), // -2
            Some("langfredag")
        );
        assert_eq!(
            liturgical_day_name(d(2026, 4, 6)).as_deref(), // +1
            Some("2. påskedag")
        );
        assert_eq!(
            liturgical_day_name(d(2026, 5, 14)).as_deref(), // +39
            Some("Kristi himmelfartsdag")
        );
        assert_eq!(
            liturgical_day_name(d(2026, 5, 24)).as_deref(), // +49
            Some("1. pinsedag")
        );
        assert_eq!(
            liturgical_day_name(d(2026, 5, 25)).as_deref(), // +50
            Some("2. pinsedag")
        );
    }

    #[test]
    fn fixed_holidays() {
        assert_eq!(
            liturgical_day_name(d(2026, 5, 17)).as_deref(),
            Some("Grunnlovsdag")
        );
        assert_eq!(
            liturgical_day_name(d(2026, 12, 25)).as_deref(),
            Some("1. juledag")
        );
        assert_eq!(
            liturgical_day_name(d(2026, 1, 1)).as_deref(),
            Some("1. nyttårsdag")
        );
        assert_eq!(
            liturgical_day_name(d(2026, 12, 24)).as_deref(),
            Some("julaften")
        );
        assert_eq!(
            liturgical_day_name(d(2026, 12, 26)).as_deref(),
            Some("2. juledag")
        );
    }

    #[test]
    fn ordinary_day_is_none() {
        assert_eq!(liturgical_day_name(d(2026, 6, 7)), None);
        assert_eq!(liturgical_day_name(d(2026, 8, 15)), None);
    }
}
