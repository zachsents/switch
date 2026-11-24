//! What a chart is given, read defensively (`data.ts`): any of it may be bound to the surface's data
//! model, where anything can arrive. A value that can't be read is none; a series, slice, point or
//! day that can't be read is left out. With nothing left, a chart draws nothing. The series' colors
//! in their order, never cycled; what's folded past a cap is Other, in the gray that steps back.

use std::collections::BTreeMap;

use chrono::NaiveDate;
use gpui::Hsla;
use serde_json::Value;

use crate::look::Look;
use crate::widgets::palette;

/// How many series a chart draws; past it the rest fold into Other, or aren't drawn.
pub const CAP: usize = 8;
const OTHER_NAME: &str = "Other";
/// How many slices read at a glance; past it the rest fold into Other.
const SLICES: usize = 6;
/// How many series of points stay apart, any two side by side.
const POINT_SERIES: usize = 3;

/// The `i`th series' color (from 0), or Other's past the eighth.
pub fn color_of(l: &Look, i: usize) -> Hsla {
    palette::series(l, i + 1).unwrap_or(l.ink3)
}

/// The first series' color.
pub fn first(l: &Look) -> Hsla {
    color_of(l, 0)
}

fn list(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}

/// A number, or none.
pub fn number_of(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

/// Raw values: the numbers among them.
pub fn numbers_of(v: &Value) -> Vec<f64> {
    list(v).iter().filter_map(number_of).collect()
}

/// Labels as words: a number reads as itself.
pub fn labels_of(v: &Value) -> Vec<String> {
    list(v)
        .iter()
        .map(|l| match l {
            Value::String(s) => s.clone(),
            other => number_of(other).map(super::figures::number_text).unwrap_or_default(),
        })
        .collect()
}

#[derive(Clone, Debug)]
pub struct Series {
    pub name: String,
    pub color: Hsla,
    pub values: Vec<Option<f64>>,
}

fn sum_of(values: impl IntoIterator<Item = Option<f64>>) -> Option<f64> {
    values.into_iter().flatten().fold(None, |s, v| Some(s.unwrap_or(0.) + v))
}

/// Named series with a value for each of `count` labels, or none; each takes its color by its place.
/// Past the cap, the rest are summed into Other when `sum` (parts of a whole), else not drawn.
pub fn series_of(v: &Value, count: usize, sum: bool, l: &Look) -> Vec<Series> {
    let read: Vec<Series> = list(v)
        .iter()
        .filter_map(|s| {
            let name = s.get("name")?.as_str()?.to_string();
            let values = s.get("values")?.as_array()?;
            Some((name, values))
        })
        .enumerate()
        .map(|(i, (name, values))| Series { name, color: color_of(l, i), values: (0..count).map(|j| values.get(j).and_then(number_of)).collect() })
        .collect();
    if read.len() <= CAP {
        return read;
    }
    if !sum {
        return read.into_iter().take(CAP).collect();
    }
    let other = Series {
        name: OTHER_NAME.into(),
        color: l.ink3,
        values: (0..count).map(|j| sum_of(read[CAP - 1..].iter().map(|s| s.values[j]))).collect(),
    };
    read.into_iter().take(CAP - 1).chain(std::iter::once(other)).collect()
}

/// Whether any series has a value to draw.
pub fn any_value(series: &[Series]) -> bool {
    series.iter().any(|s| s.values.iter().any(Option::is_some))
}

#[derive(Clone, Debug)]
pub struct Slice {
    pub label: String,
    pub value: f64,
    pub color: Hsla,
}

/// Parts of a whole: the slices with something in them, each its color by its place; past six, Other.
pub fn slices_of(v: &Value, l: &Look) -> Vec<Slice> {
    let read: Vec<Slice> = list(v)
        .iter()
        .filter_map(|s| Some((s.get("label")?.as_str()?.to_string(), number_of(s.get("value")?)?)))
        .filter(|(_, value)| *value > 0.)
        .enumerate()
        .map(|(i, (label, value))| Slice { label, value, color: color_of(l, i) })
        .collect();
    if read.len() <= SLICES {
        return read;
    }
    let other = Slice { label: OTHER_NAME.into(), value: read[SLICES - 1..].iter().map(|s| s.value).sum(), color: l.ink3 };
    read.into_iter().take(SLICES - 1).chain(std::iter::once(other)).collect()
}

#[derive(Clone, Debug)]
pub struct Points {
    pub name: String,
    pub color: Hsla,
    pub points: Vec<(f64, f64)>,
}

/// Series of points, each its color by its place: the first three.
pub fn points_of(v: &Value, l: &Look) -> Vec<Points> {
    list(v)
        .iter()
        .filter_map(|s| Some((s.get("name")?.as_str()?.to_string(), s.get("points")?.as_array()?)))
        .enumerate()
        .map(|(i, (name, pts))| Points {
            name,
            color: color_of(l, i),
            points: pts
                .iter()
                .filter_map(|p| {
                    let a = p.as_array().filter(|a| a.len() == 2)?;
                    Some((number_of(&a[0])?, number_of(&a[1])?))
                })
                .collect(),
        })
        .filter(|s| !s.points.is_empty())
        .take(POINT_SERIES)
        .collect()
}

/// A value per day, by the day ("2026-11-02"); a day given twice keeps its last; a day that isn't
/// one ("2026-02-30") is left out.
pub fn days_of(v: &Value) -> BTreeMap<NaiveDate, f64> {
    let mut days = BTreeMap::new();
    for raw in list(v) {
        let (Some(date), Some(value)) = (raw.get("date").and_then(Value::as_str), raw.get("value").and_then(number_of)) else { continue };
        let b = date.as_bytes();
        let shaped = b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
        if let Some(day) = shaped.then(|| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()).flatten() {
            days.insert(day, value);
        }
    }
    days
}
