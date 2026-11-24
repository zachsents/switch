//! Times as the screen shows them (the desktop's `ui/time.ts`): a day, a time of day, how long.
//! Days and times are in the Mac's own language and clock (12 or 24 hours), as the web view's
//! `toLocaleString([], …)` gives them: Foundation's formatter from CLDR's skeletons.

use chrono::{DateTime, Local, TimeZone};

fn local(ms: f64) -> DateTime<Local> {
    Local.timestamp_millis_opt(ms as i64).single().unwrap_or_else(Local::now)
}

pub fn now_ms() -> f64 {
    Local::now().timestamp_millis() as f64
}

thread_local! {
    static FORMATS: std::cell::RefCell<std::collections::HashMap<&'static str, objc2::rc::Retained<objc2_foundation::NSDateFormatter>>> = Default::default();
}

/// A time as the Mac's locale writes a CLDR skeleton ("EEEEMMMd", "jmm").
fn localized(skeleton: &'static str, ms: f64) -> String {
    use objc2_foundation::{NSDate, NSDateFormatter, NSLocale, NSString};
    FORMATS.with(|f| {
        let mut f = f.borrow_mut();
        let formatter = f.entry(skeleton).or_insert_with(|| {
            let formatter = NSDateFormatter::new();
            let locale = NSLocale::currentLocale();
            let pattern = NSDateFormatter::dateFormatFromTemplate_options_locale(&NSString::from_str(skeleton), 0, Some(&locale));
            formatter.setLocale(Some(&locale));
            formatter.setDateFormat(pattern.as_deref());
            formatter
        });
        formatter.stringFromDate(&NSDate::dateWithTimeIntervalSince1970(ms / 1000.)).to_string()
    })
}

/// "Friday, Nov 20".
pub fn day_of(ms: f64) -> String {
    localized("EEEEMMMd", ms)
}

/// "2:00 PM".
pub fn time_of(ms: f64) -> String {
    localized("jmm", ms)
}

pub fn same_day(a: f64, b: f64) -> bool {
    local(a).date_naive() == local(b).date_naive()
}

/// A span as a clock: "4:05", or "1:04:05" past an hour.
pub fn span_of(ms: f64) -> String {
    let s = (ms.max(0.) / 1000.) as u64;
    let (h, m, s) = (s / 3600, (s / 60) % 60, s % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

/// How long ago, as a sign says it: "4m", "6h", "3d".
pub fn age_of(ms: f64) -> String {
    let minutes = (ms.max(0.) / 60_000.) as u64;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if hours < 24 { format!("{hours}h") } else { format!("{}d", hours / 24) }
}

/// When, as a tooltip says it: the time today, else the day and time (the year when not this one).
pub fn when_of(ms: f64) -> String {
    let at = local(ms);
    let now = chrono::Local::now();
    if at.date_naive() == now.date_naive() {
        time_of(ms)
    } else if chrono::Datelike::year(&at) == chrono::Datelike::year(&now) {
        localized("MMMdjmm", ms)
    } else {
        localized("yMMMdjmm", ms)
    }
}

/// A span to the minute, as a Live Activity's end says it: "1:05".
pub fn span_to_minute(ms: f64) -> String {
    let m = (ms.max(0.) / 60_000.).round() as u64;
    format!("{}:{:02}", m / 60, m % 60)
}

/// A line's stamp beside it, kept short: "2:00 PM" today, "Nov 12" before.
pub fn stamp_of(ms: f64) -> String {
    let at = local(ms);
    if at.date_naive() == Local::now().date_naive() { time_of(ms) } else { localized("MMMd", ms) }
}
