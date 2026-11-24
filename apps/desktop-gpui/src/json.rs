//! Reading payloads loosely, as the desktop's `json.ts` does: a string or empty, a number or zero,
//! a list or empty. The brain's payloads are trusted to be close to their schema; what doesn't read
//! reads as empty.

use serde_json::Value;

static NULL: Value = Value::Null;

/// A field of an object, or null.
pub fn get<'a>(v: &'a Value, key: &str) -> &'a Value {
    v.get(key).unwrap_or(&NULL)
}

/// A string, or empty.
pub fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

/// A string field, or empty.
pub fn gs(v: &Value, key: &str) -> String {
    s(get(v, key))
}

/// A number, or zero.
pub fn n(v: &Value) -> f64 {
    match v {
        Value::Number(x) => x.as_f64().unwrap_or(0.),
        Value::String(x) => x.parse().unwrap_or(0.),
        _ => 0.,
    }
}

pub fn gn(v: &Value, key: &str) -> f64 {
    n(get(v, key))
}

/// A seq, or zero.
pub fn gu(v: &Value, key: &str) -> u64 {
    gn(v, key).max(0.) as u64
}

pub fn gb(v: &Value, key: &str) -> bool {
    get(v, key).as_bool() == Some(true)
}

/// A list, or empty.
pub fn list(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}

/// A string field when it's a non-empty string.
pub fn opt(v: &Value, key: &str) -> Option<String> {
    get(v, key).as_str().filter(|x| !x.is_empty()).map(str::to_string)
}
