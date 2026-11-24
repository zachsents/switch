//! Reads how long something should run, the way people type it: a length ("5 minutes", "1h 30m",
//! "an hour and a half", "1:30") or a time of day ("until 3pm", "at noon", "9am tomorrow").
//! Parsing is local and instant, so a field can preview what it understood on every keystroke,
//! and agents get exactly the same reading as people. What the parser can't read goes to the
//! suite's decision model with [`TimeInput::understand`].

use std::time::{Duration, SystemTime};

use gpui::{App, Task};
use jiff::{Timestamp, Zoned, civil::Date};
use schemars::JsonSchema;
use serde::Deserialize;

const LONGEST: Duration = Duration::from_secs(100 * 3_600);
const HINT: &str = "Try 5m, 1:30, 1h 30m or until 3pm";

/// A parsed length or end time, fixed against the moment it was parsed.
#[derive(Clone, Debug, PartialEq)]
pub struct TimeInput {
    pub duration: Duration,
    pub ends_at: Zoned,
    /// Whether it was given as a time of day ("until 3pm") rather than a length ("5 min").
    pub until: bool,
}

impl TimeInput {
    /// Reads `input` relative to the current local time.
    pub fn parse_now(input: &str) -> Result<Self, String> {
        Self::parse(input, &Zoned::now())
    }

    pub fn parse(input: &str, now: &Zoned) -> Result<Self, String> {
        let text = normalize(input);
        if text.is_empty() {
            return Err(HINT.into());
        }
        let clock = |rest: &str| until(rest, now);
        let length = |rest: &str| {
            let seconds = length(rest).ok_or(HINT)?;
            let duration = Duration::from_secs_f64(seconds);
            let ends_at = now
                .checked_add(jiff::SignedDuration::try_from(duration).map_err(|_| HINT)?)
                .map_err(|_| HINT)?;
            Ok::<_, String>(Self {
                duration,
                ends_at,
                until: false,
            })
        };
        let parsed = match strip_any(&text, &["until ", "till ", "til ", "at ", "by ", "to "]) {
            Some(rest) => clock(rest),
            None => match strip_any(&text, &["in ", "for "]) {
                Some(rest) => length(rest),
                None => length(&text).or_else(|_| clock(&text)),
            },
        }?;
        parsed.checked()
    }

    /// Reads `input` like [`TimeInput::parse_now`], asking the suite's decision model about
    /// anything the parser can't read, like "until the top of the hour" or "through lunch".
    /// Without an AI key only the parser's forms work.
    pub fn understand(input: String, cx: &App) -> Task<Result<Self, String>> {
        if let Ok(reading) = Self::parse_now(&input) {
            return Task::ready(Ok(reading));
        }
        cx.background_executor().spawn(async move {
            let key = ai::keys::find(ai::Provider::Gateway).ok_or(HINT)?;
            let now = Zoned::now();
            let task = format!(
                "Someone is setting a timer and typed how long it should run, or when it should \
                 end. It's {} now, local time. Read it as a length of time or as a time of day \
                 to end at.",
                now.strftime("%A, %B %-d, %Y, %H:%M")
            );
            let said: Said = ai::decide(&key, &task, &input)?;
            Self::from_said(said, &now)
        })
    }

    /// A reading of what the decision model said, against `now`.
    fn from_said(said: Said, now: &Zoned) -> Result<Self, String> {
        let unreadable = |_| HINT.to_string();
        let reading = match said {
            Said::Length { seconds } => {
                let ends_at = now
                    .checked_add(jiff::SignedDuration::from_secs(seconds as i64))
                    .map_err(unreadable)?;
                Self {
                    duration: Duration::from_secs(seconds),
                    ends_at,
                    until: false,
                }
            }
            Said::Until {
                hour,
                minute,
                days_from_today,
            } => {
                let ends_at = now
                    .date()
                    .checked_add(jiff::Span::new().days(i64::from(days_from_today)))
                    .map_err(unreadable)?
                    .at(hour as i8, minute as i8, 0, 0)
                    .to_zoned(now.time_zone().clone())
                    .map_err(unreadable)?;
                let duration = Duration::try_from(ends_at.duration_since(now))
                    .map_err(|_| "That time has already passed".to_string())?;
                Self {
                    duration,
                    ends_at,
                    until: true,
                }
            }
        };
        reading.checked()
    }

    /// The reading, if it's a length timers can run for.
    fn checked(self) -> Result<Self, String> {
        if self.duration < Duration::from_secs(1) {
            return Err("That's less than a second".into());
        }
        if self.duration > LONGEST {
            return Err("That's longer than 100 hours".into());
        }
        Ok(self)
    }

    /// What `input` would mean right now, for a live preview as someone types: a reading like
    /// "25 min, ends 2:35 PM", or what's wrong with it.
    pub fn preview(input: &str) -> Result<String, String> {
        let now = Zoned::now();
        Self::parse(input, &now).map(|reading| reading.describe(&now))
    }

    /// [`TimeInput::describe`] against the current time.
    pub fn describe_now(&self) -> String {
        self.describe(&Zoned::now())
    }

    /// A short reading of the input for a live preview, like "25 min, ends 11:52 AM" or
    /// "17 h 50 min, until tomorrow 9:00 AM".
    pub fn describe(&self, now: &Zoned) -> String {
        let day = if self.ends_at.date() == now.date() {
            ""
        } else if Some(self.ends_at.date()) == now.date().tomorrow().ok() {
            "tomorrow "
        } else {
            "on a later day at "
        };
        let verb = if self.until { "until" } else { "ends" };
        format!(
            "{}, {verb} {day}{}",
            format_length(self.duration),
            clock_time(&self.ends_at)
        )
    }
}

/// What the decision model can read a time as.
#[derive(Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Said {
    /// A length of time.
    Length { seconds: u64 },
    /// A time of day to end at, in 24-hour local time, today or a number of days from now.
    Until {
        hour: u8,
        minute: u8,
        days_from_today: u8,
    },
}

/// A wall-clock time like "3:00 PM", in the local time zone.
pub fn local_clock_time(time: SystemTime) -> Option<String> {
    let timestamp = Timestamp::try_from(time).ok()?;
    Some(clock_time(
        &timestamp.to_zoned(jiff::tz::TimeZone::system()),
    ))
}

fn clock_time(time: &Zoned) -> String {
    time.strftime("%-I:%M %p").to_string()
}

/// "1 h 23 min", "5 min", "1 min 30 s" or "45 s". Seconds are dropped from an hour or more.
fn format_length(duration: Duration) -> String {
    let total = duration.as_secs() + u64::from(duration.subsec_nanos() >= 500_000_000);
    let (hours, minutes, seconds) = (total / 3_600, total / 60 % 60, total % 60);
    let parts = [
        (hours, "h", true),
        (minutes, "min", true),
        (seconds, "s", hours == 0),
    ];
    let shown: Vec<_> = parts
        .iter()
        .filter(|(amount, _, allowed)| *amount > 0 && *allowed)
        .map(|(amount, unit, _)| format!("{amount} {unit}"))
        .collect();
    if shown.is_empty() {
        "0 s".into()
    } else {
        shown.join(" ")
    }
}

/// Lowercases, spells out "a.m." and "p.m.", and turns commas and hyphens into spaces.
fn normalize(input: &str) -> String {
    let text = input
        .to_lowercase()
        .replace("a.m.", "am")
        .replace("p.m.", "pm")
        .replace([',', '-'], " ");
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_any<'a>(text: &'a str, prefixes: &[&str]) -> Option<&'a str> {
    prefixes.iter().find_map(|prefix| text.strip_prefix(prefix))
}

/// The number of seconds in a length, or `None` if it isn't one.
fn length(text: &str) -> Option<f64> {
    if text.contains(':') {
        let parts: Vec<f64> = text
            .split(':')
            .map(|part| part.trim().parse().ok())
            .collect::<Option<_>>()?;
        return match parts[..] {
            [minutes, seconds] => Some(minutes * 60. + seconds),
            [hours, minutes, seconds] => Some(hours * 3_600. + minutes * 60. + seconds),
            _ => None,
        };
    }
    if let Ok(minutes) = text.parse::<f64>() {
        return Some(minutes * 60.);
    }
    units(text)
}

/// Splits "1h30m" into "1", "h", "30", "m", and spaces into separate words.
fn tokens(text: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    for word in text.split_whitespace() {
        let mut current = String::new();
        for character in word.chars() {
            let numeric = character.is_ascii_digit() || character == '.';
            let boundary = current
                .chars()
                .last()
                .is_some_and(|last| (last.is_ascii_digit() || last == '.') != numeric);
            if boundary {
                tokens.push(std::mem::take(&mut current));
            }
            current.push(character);
        }
        tokens.push(current);
    }
    tokens
}

fn unit_seconds(word: &str) -> Option<f64> {
    match word {
        "h" | "hr" | "hrs" | "hour" | "hours" => Some(3_600.),
        "m" | "min" | "mins" | "minute" | "minutes" => Some(60.),
        "s" | "sec" | "secs" | "second" | "seconds" => Some(1.),
        _ => None,
    }
}

fn number_word(word: &str) -> Option<f64> {
    let words = [
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
        "twenty",
    ];
    if let Some(index) = words.iter().position(|candidate| *candidate == word) {
        return Some(index as f64);
    }
    match word {
        "thirty" => Some(30.),
        "forty" => Some(40.),
        "fifty" => Some(50.),
        "sixty" => Some(60.),
        "ninety" => Some(90.),
        _ => word.parse().ok(),
    }
}

/// Lengths written with units, like "1 hour and 30 minutes", "two and a half hours",
/// "an hour and a half", "half an hour" or "1h 30". A trailing bare number counts in the next
/// smaller unit, so "1h 30" is an hour and a half.
fn units(text: &str) -> Option<f64> {
    let mut total = 0.;
    let mut pending: Option<f64> = None;
    let mut last_unit: Option<f64> = None;
    let mut joined = false;
    for token in tokens(text) {
        if let Some(scale) = unit_seconds(&token) {
            total += pending.take()? * scale;
            last_unit = Some(scale);
            joined = false;
            continue;
        }
        match token.as_str() {
            "and" => joined = true,
            "of" => {}
            "a" | "an" => {
                // "half an hour" and "a quarter of an hour" already have their amount.
                if pending.is_none() && !joined {
                    pending = Some(1.);
                }
            }
            "half" | "quarter" => {
                let fraction = if token == "half" { 0.5 } else { 0.25 };
                match (pending, joined, last_unit) {
                    (Some(amount), true, _) => pending = Some(amount + fraction),
                    (None, true, Some(unit)) => total += fraction * unit,
                    (Some(1.), false, _) | (None, false, _) => pending = Some(fraction),
                    _ => return None,
                }
                joined = false;
            }
            word => {
                let number = number_word(word)?;
                pending = match pending {
                    // "twenty five"
                    Some(tens) if tens >= 20. && tens % 10. == 0. && number < 10. => {
                        Some(tens + number)
                    }
                    Some(_) => return None,
                    None => Some(number),
                };
            }
        }
    }
    if let Some(amount) = pending {
        let unit = match last_unit {
            Some(3_600.) => 60.,
            Some(60.) => 1.,
            Some(_) => return None,
            None => 60.,
        };
        total += amount * unit;
    }
    (total > 0.).then_some(total)
}

/// A time of day: "3pm", "3:30 pm", "15:00", "noon", "midnight", with "tomorrow" before or after.
/// Without am or pm, "3" means whichever 3:00 comes next.
fn until(text: &str, now: &Zoned) -> Result<TimeInput, String> {
    let words: Vec<_> = text.split_whitespace().collect();
    let tomorrow = words.contains(&"tomorrow");
    let time: String = words
        .iter()
        .filter(|word| !matches!(**word, "tomorrow" | "at"))
        .copied()
        .collect::<Vec<_>>()
        .join("");
    let (hours, minute) = clock(&time).ok_or(HINT)?;
    let today = now.date();
    let tomorrow_date = today.tomorrow().map_err(|_| HINT)?;
    let candidates = hours.iter().flat_map(|&hour| {
        let days: &[Date] = if tomorrow {
            &[tomorrow_date]
        } else {
            &[today, tomorrow_date]
        };
        days.iter()
            .filter_map(move |day| {
                day.at(hour, minute, 0, 0)
                    .to_zoned(now.time_zone().clone())
                    .ok()
            })
            .collect::<Vec<_>>()
    });
    let ends_at = candidates
        .filter(|candidate| candidate > now)
        .min()
        .ok_or("That time has already passed")?;
    let duration = Duration::try_from(ends_at.duration_since(now)).map_err(|_| HINT)?;
    Ok(TimeInput {
        duration,
        ends_at,
        until: true,
    })
}

/// The possible hours (in 24-hour time) and the minute of a clock time.
fn clock(time: &str) -> Option<(Vec<i8>, i8)> {
    match time {
        "noon" => return Some((vec![12], 0)),
        "midnight" => return Some((vec![0], 0)),
        _ => {}
    }
    let (digits, meridiem) = match time {
        time if time.ends_with("am") => (&time[..time.len() - 2], Some(false)),
        time if time.ends_with("pm") => (&time[..time.len() - 2], Some(true)),
        time => (time, None),
    };
    let (hour, minute) = match digits.split_once(':') {
        Some((hour, minute)) if minute.len() == 2 => (hour, minute.parse::<i8>().ok()?),
        Some(_) => return None,
        None => (digits, 0),
    };
    let leading_zero = hour.len() == 2 && hour.starts_with('0');
    let hour: i8 = hour.parse().ok()?;
    if !(0..60).contains(&minute) {
        return None;
    }
    let hours = match meridiem {
        Some(pm) if (1..=12).contains(&hour) => vec![hour % 12 + if pm { 12 } else { 0 }],
        Some(_) => return None,
        None if (13..=23).contains(&hour) || hour == 0 || leading_zero => vec![hour],
        None if (1..=12).contains(&hour) => vec![hour % 12, hour % 12 + 12],
        None => return None,
    };
    Some((hours, minute))
}
