//! The basic catalog's functions, as `@a2ui/web_core`'s `basic_functions.js` runs them:
//! formatString (its `${…}` expressions: a path, a literal, a call with named arguments), the
//! number, currency and date formats in en-US, pluralize, the checks (required, regex, length,
//! numeric, email), and, or, not. `openUrl` is run by the host when it's pressed.

use chrono::{DateTime, Datelike, FixedOffset, NaiveDateTime, Timelike};
use serde_json::{Map, Value, json};

use super::Scope;

/// Whether a value counts as true: a check's result by its `valid`, else JavaScript's truthiness.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0. && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) => true,
        Value::Object(o) => o.get("valid").and_then(Value::as_bool).unwrap_or(true),
    }
}

/// A figure as JavaScript writes one: whole without a point.
pub fn number_text(x: f64) -> String {
    if x.fract() == 0. && x.abs() < 1e15 { format!("{}", x as i64) } else { format!("{x}") }
}

/// A value as words, as `coerceToString`: an object as its JSON.
fn coerce(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) => number_text(n.as_f64().unwrap_or(0.)),
        Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

fn num(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        // As JavaScript's Number: blank words are 0.
        Value::String(s) if s.trim().is_empty() => 0.,
        Value::String(s) => s.trim().parse().unwrap_or(f64::NAN),
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Null => 0.,
        _ => f64::NAN,
    }
}

/// Digits with en-US grouping, to `decimals` places (or as many as the figure has, up to three).
pub fn format_number(x: f64, decimals: Option<usize>, grouping: bool) -> String {
    if x.is_nan() {
        return String::new();
    }
    let s = match decimals {
        Some(d) => format!("{:.*}", d, x.abs()),
        None => {
            let t = format!("{:.3}", x.abs());
            let t = t.trim_end_matches('0').trim_end_matches('.').to_string();
            if t.is_empty() { "0".into() } else { t }
        }
    };
    let (int, frac) = s.split_once('.').map(|(a, b)| (a.to_string(), Some(b.to_string()))).unwrap_or((s.clone(), None));
    let int = if grouping {
        let mut out = String::new();
        for (i, c) in int.chars().enumerate() {
            if i > 0 && (int.len() - i) % 3 == 0 {
                out.push(',');
            }
            out.push(c);
        }
        out
    } else {
        int
    };
    let sign = if x < 0. && s.chars().any(|c| c.is_ascii_digit() && c != '0') { "-" } else { "" };
    match frac {
        Some(f) => format!("{sign}{int}.{f}"),
        None => format!("{sign}{int}"),
    }
}

fn currency_symbol(code: &str) -> Option<&'static str> {
    Some(match code {
        "USD" => "$",
        "EUR" => "€",
        "GBP" => "£",
        "JPY" => "¥",
        "CAD" => "CA$",
        "AUD" => "A$",
        "INR" => "₹",
        "CNY" => "CN¥",
        "KRW" => "₩",
        "MXN" => "MX$",
        "BRL" => "R$",
        "HKD" => "HK$",
        "NZD" => "NZ$",
        "ILS" => "₪",
        "VND" => "₫",
        "TWD" => "NT$",
        "PHP" => "₱",
        _ => return None,
    })
}

fn format_currency(x: f64, code: &str, decimals: usize, grouping: bool) -> String {
    if x.is_nan() {
        return String::new();
    }
    let code = code.to_uppercase();
    let digits = format_number(x.abs(), Some(decimals), grouping);
    let sign = if x < 0. { "-" } else { "" };
    match currency_symbol(&code) {
        Some(sym) => format!("{sign}{sym}{digits}"),
        None => format!("{sign}{code}\u{a0}{digits}"),
    }
}

const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS: [&str; 7] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/// A timestamp's wall time as written (its own offset, or none as UTC), and its instant.
fn parse_timestamp(value: &str) -> Option<(NaiveDateTime, DateTime<FixedOffset>)> {
    if let Ok(t) = DateTime::parse_from_rfc3339(value) {
        return Some((t.naive_local(), t));
    }
    let utc = FixedOffset::east_opt(0)?;
    for f in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(n) = NaiveDateTime::parse_from_str(value, f) {
            return Some((n, n.and_local_timezone(utc).single()?));
        }
    }
    let d = chrono::NaiveDate::parse_from_str(value.get(..10)?, "%Y-%m-%d").ok()?;
    let n = d.and_hms_opt(0, 0, 0)?;
    Some((n, n.and_local_timezone(utc).single()?))
}

pub fn format_date(value: &Value, pattern: &str) -> String {
    let text = coerce(value);
    if text.is_empty() {
        return String::new();
    }
    let Some((t, instant)) = parse_timestamp(&text) else { return String::new() };
    let pattern = if pattern.is_empty() { "yyyy-MM-dd" } else { pattern };
    if pattern == "ISO" {
        return instant.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    }
    let tokens = ["yyyy", "yy", "MMMM", "MMM", "MM", "M", "EEEE", "E", "dd", "d", "HH", "H", "hh", "h", "mm", "ss", "a"];
    let mut out = String::new();
    let mut rest = pattern;
    'outer: while !rest.is_empty() {
        for tok in tokens {
            if let Some(after) = rest.strip_prefix(tok) {
                let h = t.hour();
                let h12 = if h % 12 == 0 { 12 } else { h % 12 };
                let wd = t.weekday().num_days_from_monday() as usize;
                out.push_str(&match tok {
                    "yyyy" => t.year().to_string(),
                    "yy" => format!("{:02}", t.year() % 100),
                    "MMMM" => MONTHS[t.month0() as usize].into(),
                    "MMM" => MONTHS[t.month0() as usize][..3].into(),
                    "MM" => format!("{:02}", t.month()),
                    "M" => t.month().to_string(),
                    "EEEE" => DAYS[wd].into(),
                    "E" => DAYS[wd][..3].into(),
                    "dd" => format!("{:02}", t.day()),
                    "d" => t.day().to_string(),
                    "HH" => format!("{h:02}"),
                    "H" => h.to_string(),
                    "hh" => format!("{h12:02}"),
                    "h" => h12.to_string(),
                    "mm" => format!("{:02}", t.minute()),
                    "ss" => format!("{:02}", t.second()),
                    _ => (if h < 12 { "AM" } else { "PM" }).into(),
                });
                rest = after;
                continue 'outer;
            }
        }
        let c = rest.chars().next().unwrap_or_default();
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

fn valid(ok: bool, message: &str) -> Value {
    if ok { json!({ "valid": true }) } else { json!({ "valid": false, "message": message }) }
}

/// Runs one of the catalog's functions on its arguments, resolved here.
/// The basic catalog's functions (and Switch's, which has them): what a call to one runs here.
pub const BASIC_FUNCTIONS: [&str; 13] = ["required", "regex", "length", "numeric", "email", "formatString", "formatNumber", "formatCurrency", "formatDate", "pluralize", "and", "or", "not"];

pub fn call(name: &str, raw_args: &Value, scope: &Scope) -> Value {
    if name == "formatString" {
        let template = raw_args.get("value").map(|v| scope.resolve(v)).map(|v| coerce(&v)).unwrap_or_default();
        return Value::String(format_string(&template, scope));
    }
    let args: Map<String, Value> = raw_args.as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), scope.resolve(v))).collect()).unwrap_or_default();
    let arg = |k: &str| args.get(k).cloned().unwrap_or(Value::Null);
    let opt_num = |k: &str| args.get(k).filter(|v| !v.is_null()).map(num).filter(|x| !x.is_nan());
    match name {
        "required" => {
            let v = arg("value");
            let ok = !(v.is_null() || v.as_str() == Some("") || v.as_array().is_some_and(Vec::is_empty));
            valid(ok, "This field is required.")
        }
        "regex" => {
            let text = coerce(&arg("value"));
            let pattern = coerce(&arg("pattern"));
            // JavaScript's patterns: lookaround and backreferences too.
            match fancy_regex::Regex::new(&pattern) {
                Ok(re) => valid(re.is_match(&text).unwrap_or(false), "Value does not match required pattern."),
                Err(_) => valid(false, "Value does not match required pattern."),
            }
        }
        "length" => {
            let v = arg("value");
            let len = match &v {
                Value::String(s) => s.chars().count(),
                Value::Array(a) => a.len(),
                _ => 0,
            } as f64;
            match (opt_num("min"), opt_num("max")) {
                (Some(min), _) if len < min => valid(false, &format!("Minimum length is {}.", number_text(min))),
                (_, Some(max)) if len > max => valid(false, &format!("Maximum length is {}.", number_text(max))),
                _ => valid(true, ""),
            }
        }
        "numeric" => {
            let x = num(&arg("value"));
            if x.is_nan() {
                return valid(false, "Value must be a valid number.");
            }
            match (opt_num("min"), opt_num("max")) {
                (Some(min), _) if x < min => valid(false, &format!("Minimum value is {}.", number_text(min))),
                (_, Some(max)) if x > max => valid(false, &format!("Maximum value is {}.", number_text(max))),
                _ => valid(true, ""),
            }
        }
        "email" => {
            let ok = arg("value").as_str().is_some_and(|s| {
                regex_lite::Regex::new(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$").is_ok_and(|re| re.is_match(s))
            });
            valid(ok, "Please enter a valid email address (e.g. user@example.com).")
        }
        "formatNumber" => {
            let decimals = opt_num("decimals").map(|d| d.max(0.) as usize);
            let grouping = args.get("grouping").and_then(Value::as_bool).unwrap_or(true);
            Value::String(format_number(num(&arg("value")), decimals, grouping))
        }
        "formatCurrency" => {
            let decimals = opt_num("decimals").map(|d| d.max(0.) as usize).unwrap_or(2);
            let grouping = args.get("grouping").and_then(Value::as_bool).unwrap_or(true);
            Value::String(format_currency(num(&arg("value")), &coerce(&arg("currency")), decimals, grouping))
        }
        "formatDate" => {
            let pattern = args.get("format").map(coerce).unwrap_or_default();
            Value::String(format_date(&arg("value"), &pattern))
        }
        "pluralize" => {
            let x = num(&arg("value"));
            let form = |k: &str| args.get(k).filter(|v| !v.is_null()).map(coerce);
            let chosen = if x == 0. && form("zero").is_some() {
                form("zero")
            } else if x == 1. && form("one").is_some() {
                form("one")
            } else if x == 2. && form("two").is_some() {
                form("two")
            } else if x == 1. {
                form("one")
            } else {
                None
            };
            Value::String(chosen.or_else(|| form("other")).unwrap_or_default())
        }
        "and" => Value::Bool(args.get("values").and_then(Value::as_array).is_some_and(|v| v.len() >= 2 && v.iter().all(truthy))),
        "or" => Value::Bool(args.get("values").and_then(Value::as_array).is_some_and(|v| v.len() >= 2 && v.iter().any(truthy))),
        "not" => Value::Bool(!truthy(&arg("value"))),
        "@index" => {
            let ix = scope.base.rsplit('/').next().and_then(|t| t.parse::<f64>().ok()).unwrap_or(0.);
            json!(ix + opt_num("offset").unwrap_or(0.))
        }
        _ => Value::Null,
    }
}

/// A template's `${…}` expressions put in (ExpressionParser): a path, a quoted string, a figure,
/// true, false, null, or a call `name(arg: expr, …)`; `\${` is a literal.
pub fn format_string(template: &str, scope: &Scope) -> String {
    let mut out = String::new();
    let b = template.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && template[i..].starts_with("\\${") {
            out.push_str("${");
            i += 3;
        } else if template[i..].starts_with("${") {
            let start = i + 2;
            let mut depth = 1;
            let mut j = start;
            let mut quote: Option<u8> = None;
            while j < b.len() && depth > 0 {
                let c = b[j];
                if let Some(q) = quote {
                    if c == b'\\' {
                        j += 1;
                    } else if c == q {
                        quote = None;
                    }
                } else if c == b'\'' || c == b'"' {
                    quote = Some(c);
                } else if c == b'{' {
                    depth += 1;
                } else if c == b'}' {
                    depth -= 1;
                }
                j += 1;
            }
            let inner = &template[start..j.saturating_sub(1).max(start)];
            let mut p = Parser { s: inner.trim(), at: 0 };
            let v = p.expr();
            out.push_str(&coerce(&scope.resolve(&v)));
            i = j;
        } else {
            let c = template[i..].chars().next().unwrap_or_default();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

/// An expression inside `${…}`, read as the dynamic value it stands for.
struct Parser<'a> {
    s: &'a str,
    at: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<char> {
        self.s[self.at..].chars().next()
    }

    fn skip(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.at += 1;
        }
    }

    fn expr(&mut self) -> Value {
        self.skip();
        let rest = &self.s[self.at..];
        if rest.starts_with("${") {
            self.at += 2;
            let v = self.expr();
            self.skip();
            if self.peek() == Some('}') {
                self.at += 1;
            }
            return v;
        }
        match self.peek() {
            Some(q @ ('\'' | '"')) => {
                self.at += 1;
                let mut out = String::new();
                while let Some(c) = self.peek() {
                    self.at += c.len_utf8();
                    if c == '\\' {
                        if let Some(n) = self.peek() {
                            self.at += n.len_utf8();
                            out.push(n);
                        }
                    } else if c == q {
                        break;
                    } else {
                        out.push(c);
                    }
                }
                Value::String(out)
            }
            Some(c) if c.is_ascii_digit() || ((c == '-' || c == '+' || c == '.') && rest.len() > 1 && rest[1..].starts_with(|d: char| d.is_ascii_digit())) => {
                let end = rest.find(|ch: char| !(ch.is_ascii_digit() || matches!(ch, '.' | 'e' | 'E' | '+' | '-'))).unwrap_or(rest.len());
                self.at += end;
                rest[..end].parse::<f64>().map(|x| json!(x)).unwrap_or(Value::Null)
            }
            _ => {
                for (kw, v) in [("true", Value::Bool(true)), ("false", Value::Bool(false)), ("null", Value::String(String::new()))] {
                    if rest.starts_with(kw) && !rest[kw.len()..].starts_with(|c: char| c.is_alphanumeric() || c == '_') {
                        self.at += kw.len();
                        return v;
                    }
                }
                let end = rest.find(|ch: char| !(ch.is_alphanumeric() || matches!(ch, '_' | '/' | '.' | '-' | '@' | '~'))).unwrap_or(rest.len());
                let token = rest[..end].to_string();
                self.at += end;
                self.skip();
                if self.peek() == Some('(') {
                    self.at += 1;
                    let mut args = Map::new();
                    loop {
                        self.skip();
                        if self.peek().is_none_or(|c| c == ')') {
                            break;
                        }
                        let r = &self.s[self.at..];
                        let end = r.find(|ch: char| !(ch.is_alphanumeric() || ch == '_')).unwrap_or(r.len());
                        let name = r[..end].to_string();
                        self.at += end;
                        self.skip();
                        if self.peek() == Some(':') {
                            self.at += 1;
                        }
                        let v = self.expr();
                        args.insert(name, v);
                        self.skip();
                        if self.peek() == Some(',') {
                            self.at += 1;
                        }
                    }
                    if self.peek() == Some(')') {
                        self.at += 1;
                    }
                    json!({ "@call": token, "args": args })
                } else if token.is_empty() {
                    Value::String(String::new())
                } else {
                    json!({ "@path": token })
                }
            }
        }
    }
}
