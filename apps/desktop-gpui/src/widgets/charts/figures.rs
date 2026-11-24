//! How a chart's figures read (`figures.ts`): a prefix and a suffix round each ("$", "%", " kg"), the
//! sign before them; ticks compact from 1,000 up ("1K", "2.5M"), as a figure standing alone is from
//! 10,000.

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Figures {
    pub prefix: String,
    pub suffix: String,
}

/// No prefix or suffix.
pub fn bare() -> Figures {
    Figures::default()
}

/// Digits grouped as this Mac's locale groups them, to at most `places` places, rounding as Intl
/// does.
fn grouped(v: f64, places: usize) -> String {
    super::locale::number(v, places)
}

/// Intl's compact notation in this Mac's locale, at most one place: "1.2K", "2.5M" ("1,2 Tsd.").
fn compact(v: f64) -> String {
    super::locale::compact(v)
}

/// The sign before the prefix, as `read` in figures.ts: any value under zero, its digits its size.
fn read(v: f64, f: &Figures, digits: String) -> String {
    format!("{}{}{digits}{}", if v < 0. { "-" } else { "" }, f.prefix, f.suffix)
}

/// A value in full: "-$1,284.5".
pub fn figure(v: f64, f: &Figures) -> String {
    read(v, f, grouped(v.abs(), 2))
}

/// An axis's tick, compact from 1,000: "$1.2K".
pub fn tick(v: f64, f: &Figures) -> String {
    read(v, f, if v.abs() >= 1000. { compact(v.abs()) } else { grouped(v.abs(), 2) })
}

/// A figure standing alone (a ring's total), compact from 10,000: "1,284", "12.9K".
pub fn headline(v: f64, f: &Figures) -> String {
    read(v, f, if v.abs() >= 10_000. { compact(v.abs()) } else { grouped(v.abs(), 2) })
}

/// A part of a whole: "32%".
pub fn percent(part: f64) -> String {
    super::locale::percent(part)
}

/// A number as JavaScript writes one when nothing formats it (`String(n)`): no grouping, as few
/// digits as tell it apart, in exponent form from 1e21 and under a millionth ("1e+21", "1.5e-7").
pub fn number_text(v: f64) -> String {
    if v == 0. {
        return "0".into();
    }
    let a = v.abs();
    if a >= 1e21 || a < 1e-6 {
        let e = format!("{v:e}");
        let (digits, power) = e.split_once('e').unwrap_or((&e, "0"));
        return if power.starts_with('-') { format!("{digits}e{power}") } else { format!("{digits}e+{power}") };
    }
    format!("{v}")
}

/// A value as JavaScript writes it into words (`${v}`): a string as it is, a number as `String(n)`,
/// a list its parts joined by commas, an object "[object Object]"; none as nothing (`?? ""`).
pub fn words_of(v: Option<&Value>) -> String {
    fn of(v: &Value) -> String {
        match v {
            Value::Null => String::new(),
            Value::String(s) => s.clone(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => number_text(n.as_f64().unwrap_or(0.)),
            Value::Array(a) => a.iter().map(|x| of(x)).collect::<Vec<_>>().join(","),
            Value::Object(_) => "[object Object]".into(),
        }
    }
    v.map(of).unwrap_or_default()
}

/// A value as JavaScript's arithmetic reads it (`ToNumber`): a string's figure (blank is zero, else
/// none that isn't one), a flag 0 or 1, a list as its words, anything else none (NaN).
pub fn number_of(v: &Value) -> f64 {
    fn text(s: &str) -> f64 {
        let t = s.trim();
        if t.is_empty() {
            return 0.;
        }
        match t {
            "Infinity" | "+Infinity" => return f64::INFINITY,
            "-Infinity" => return f64::NEG_INFINITY,
            _ => {}
        }
        for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
            if let Some(d) = t.strip_prefix(prefix) {
                return u128::from_str_radix(d, radix).map(|n| n as f64).unwrap_or(f64::NAN);
            }
        }
        if t.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-')) { t.parse().unwrap_or(f64::NAN) } else { f64::NAN }
    }
    match v {
        Value::Null => 0.,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => text(s),
        Value::Array(_) => text(&words_of(Some(v))),
        Value::Object(_) => f64::NAN,
    }
}

/// A chart's prefix and suffix as written (`figuresOf`: the props as they are, not bound).
pub fn figures_of(c: &Value) -> Figures {
    Figures { prefix: words_of(c.get("prefix")), suffix: words_of(c.get("suffix")) }
}

use serde_json::Value;
