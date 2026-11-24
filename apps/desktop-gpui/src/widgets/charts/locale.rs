//! Figures and days in this Mac's locale, as `Intl` reads them in the desktop (its default locale is
//! the system's): Foundation's formatters, which are CLDR's as Intl's are, rounding half away from
//! zero as Intl does (0.125 to two places is "0.13"). Compact figures are ICU4X's, CLDR's patterns
//! for the same locale, rounded as ICU rounds Intl's `notation: "compact"` at one place.

use std::cell::RefCell;

use chrono::{NaiveDate, TimeZone};
use objc2::rc::Retained;
use objc2_foundation::{NSDate, NSDateFormatter, NSLocale, NSNumber, NSNumberFormatter, NSNumberFormatterRoundingMode, NSNumberFormatterStyle, NSString};

thread_local! {
    static COMPACT: std::cell::OnceCell<Option<icu_decimal::CompactDecimalFormatter>> = const { std::cell::OnceCell::new() };
    static NUMBERS: RefCell<Vec<((u8, usize), Retained<NSNumberFormatter>)>> = const { RefCell::new(vec![]) };
    static DAYS: RefCell<Vec<(&'static str, Retained<NSDateFormatter>)>> = const { RefCell::new(vec![]) };
}

fn number_formatter(percent: bool, places: usize) -> Retained<NSNumberFormatter> {
    let key = (u8::from(percent), places);
    NUMBERS.with(|n| {
        if let Some((_, f)) = n.borrow().iter().find(|(k, _)| *k == key) {
            return f.clone();
        }
        let f = NSNumberFormatter::new();
        f.setLocale(Some(&NSLocale::autoupdatingCurrentLocale()));
        f.setNumberStyle(if percent { NSNumberFormatterStyle::PercentStyle } else { NSNumberFormatterStyle::DecimalStyle });
        f.setUsesGroupingSeparator(true);
        f.setMinimumFractionDigits(0);
        f.setMaximumFractionDigits(places);
        f.setRoundingMode(NSNumberFormatterRoundingMode::RoundHalfUp);
        n.borrow_mut().push((key, f.clone()));
        f
    })
}

/// A figure grouped as the locale groups, to at most `places` places (`maximumFractionDigits`).
pub fn number(v: f64, places: usize) -> String {
    number_formatter(false, places).stringFromNumber(&NSNumber::new_f64(v)).map(|s| s.to_string()).unwrap_or_else(|| format!("{v}"))
}

/// A share as the locale writes a percent, whole (`style: "percent"`).
pub fn percent(part: f64) -> String {
    if !part.is_finite() {
        // Intl's infinity and not-a-number in the locale's percent: its whole, the figure swapped.
        let whole = percent(if part < 0. { -1. } else { 1. });
        let figure = if part.is_nan() { "NaN" } else { "∞" };
        return whole.replacen("100", figure, 1);
    }
    number_formatter(true, 0).stringFromNumber(&NSNumber::new_f64(part)).map(|s| s.to_string()).unwrap_or_else(|| format!("{}%", (part * 100.).round()))
}

/// A day as the locale writes it from a template (`toLocaleString` with those parts): "MMM" a
/// month's short name, "EEEMMMdy" a weekday, month, day and year.
pub fn day(d: NaiveDate, template: &'static str) -> String {
    let f = DAYS.with(|days| {
        if let Some((_, f)) = days.borrow().iter().find(|(t, _)| *t == template) {
            return f.clone();
        }
        let f = NSDateFormatter::new();
        f.setLocale(Some(&NSLocale::autoupdatingCurrentLocale()));
        f.setLocalizedDateFormatFromTemplate(&NSString::from_str(template));
        days.borrow_mut().push((template, f.clone()));
        f
    });
    // Noon that day, here: the day it is whatever the zone.
    let noon = d.and_hms_opt(12, 0, 0).and_then(|t| chrono::Local.from_local_datetime(&t).single()).map(|t| t.timestamp() as f64).unwrap_or(0.);
    f.stringFromDate(&NSDate::dateWithTimeIntervalSince1970(noon)).to_string()
}

/// This Mac's locale as a BCP 47 tag: "de_DE@rg=chzzzz" is "de-DE".
fn tag() -> String {
    let id = NSLocale::autoupdatingCurrentLocale().localeIdentifier().to_string();
    id.split('@').next().unwrap_or_default().replace('_', "-")
}

/// A figure of 1,000 or more as Intl's `notation: "compact", maximumFractionDigits: 1` writes it in
/// the locale ("1.2K", "1,2 Tsd.", "1,2 mil"): its magnitude's pattern, the figure scaled to it and
/// rounded half away from zero to one place, the next pattern when rounding reaches it (999,950 is
/// "1M"), trailing zeros dropped.
pub fn compact(v: f64) -> String {
    use fixed_decimal::{Decimal, Sign, UnsignedDecimal, UnsignedRoundingMode};
    COMPACT.with(|c| {
        let f = c.get_or_init(|| {
            let locale = icu_locale_core::Locale::try_from_str(&tag()).unwrap_or(icu_locale_core::locale!("en"));
            icu_decimal::CompactDecimalFormatter::try_new_short((&locale).into(), Default::default()).ok()
        });
        let half = UnsignedRoundingMode::HalfExpand;
        let read = f.as_ref().and_then(|f| {
            let d: UnsignedDecimal = format!("{}", v.abs()).parse().ok()?;
            let magnitude = d.nonzero_magnitude_start();
            let mut exponent = f.compact_exponent_for_magnitude(magnitude);
            let mut q = d.multiplied_pow10(-i16::from(exponent));
            q.round_with_mode(-1, half);
            if !q.is_zero() && q.nonzero_magnitude_start() + i16::from(exponent) != magnitude {
                let next = f.compact_exponent_for_magnitude(magnitude + 1);
                if next != exponent {
                    q.multiply_pow10(i16::from(exponent) - i16::from(next));
                    q.round_with_mode(-1, half);
                    exponent = next;
                }
            }
            q.trim_end();
            let q = Decimal::new(Sign::None, q);
            f.format_with_exponent(&q, exponent).ok().map(|w| w.to_string())
        });
        read.unwrap_or_else(|| number(v, 1))
    })
}
