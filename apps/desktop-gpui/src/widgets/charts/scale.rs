//! A value axis's scale (`ticks.ts`), raw values in bins (`bins.ts`), and what a chart works out of
//! its series (`rows.ts`): from a multiple of a round step (1, 2, 2.5 or 5 times a power of ten)
//! below the least to one above the most, about four steps apart, ticked at each. Bars, areas and
//! counts keep zero in it; lines and points fit their values.

use super::data::Series;

const FACTORS: [f64; 5] = [1., 2., 2.5, 5., 10.];

/// The round step at least `raw` (give or take a float's error); a whole one when `whole`.
pub fn round_step(raw: f64, whole: bool) -> f64 {
    let power = 10f64.powf(raw.log10().floor());
    let step = FACTORS.iter().find(|f| *f * power >= raw * (1. - 1e-9)).copied().unwrap_or(10.) * power;
    if !whole {
        return step;
    }
    if step < 1. {
        return 1.;
    }
    if step.fract() == 0. { step } else { step * 2. }
}

/// A tick without a float's error: 0.30000000000000004 is 0.3.
fn clean(v: f64) -> f64 {
    format!("{v:.11e}").parse().unwrap_or(v)
}

#[derive(Clone, Debug)]
pub struct Scale {
    pub domain: (f64, f64),
    pub ticks: Vec<f64>,
}

impl Scale {
    /// Where a value is, from 0 at the domain's start to 1 at its end.
    pub fn at(&self, v: f64) -> f64 {
        let (lo, hi) = self.domain;
        if hi - lo == 0. { 0.5 } else { (v - lo) / (hi - lo) }
    }
}

/// The scale for values from `min` to `max`.
pub fn scale_of(min: f64, max: f64, zero: bool, whole: bool) -> Scale {
    let mut lo = if zero { min.min(0.) } else { min };
    let mut hi = if zero { max.max(0.) } else { max };
    if hi - lo <= 0. {
        lo -= if lo == 0. { 0. } else { 1. };
        hi += 1.;
    }
    let step = round_step((hi - lo) / 4., whole);
    let from = (lo / step + 1e-9).floor() as i64;
    let to = (hi / step - 1e-9).ceil() as i64;
    let ticks = (from..=to).map(|k| clean(k as f64 * step)).collect();
    Scale { domain: (clean(from as f64 * step), clean(to as f64 * step)), ticks }
}

/// The least and most of values, none when there are none.
pub fn extent_of(values: impl IntoIterator<Item = Option<f64>>) -> Option<(f64, f64)> {
    let mut out: Option<(f64, f64)> = None;
    for v in values.into_iter().flatten() {
        out = Some(match out {
            Some((a, b)) => (a.min(v), b.max(v)),
            None => (v, v),
        });
    }
    out
}

#[derive(Clone, Copy, Debug)]
pub struct Bin {
    pub lo: f64,
    pub hi: f64,
    pub count: usize,
}

/// Raw values counted into bins of equal width at round edges: `given` of them, else Sturges' count.
/// `given` is read as the original's arithmetic reads it: past a whole count its step still reaches
/// the most, but only the whole bins are kept, what falls past them left out.
pub fn bins_of(values: &[f64], given: Option<f64>) -> Vec<Bin> {
    if values.is_empty() {
        return vec![];
    }
    let min = values.iter().copied().fold(f64::INFINITY, f64::min);
    let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    if min == max {
        return vec![Bin { lo: min - 0.5, hi: max + 0.5, count: values.len() }];
    }
    let count = given.unwrap_or(((values.len() as f64).log2().ceil()) + 1.);
    // None, none above zero or past every figure: no bins (`Array.from` of no length).
    if !(count > 0.) || !count.is_finite() {
        return vec![];
    }
    let mut step = round_step((max - min) / count, false);
    let mut lo = (min / step).floor() * step;
    // Given a count, the step grows until that many bins reach the most.
    if let Some(g) = given {
        while lo + g * step < max {
            step = round_step(step * (1. + 1e-6), false);
            lo = (min / step).floor() * step;
        }
    }
    let last = given.map_or_else(|| (((max - lo) / step).ceil()).max(1.), |g| g) - 1.;
    let n = (last + 1.).floor() as usize;
    if n == 0 {
        return vec![];
    }
    let mut counts = vec![0usize; n];
    for v in values {
        let k = ((v - lo) / step).floor().min(last);
        // A place that isn't a whole bin (past a count that isn't whole) holds nothing that's kept.
        if k.fract() == 0. && k >= 0. && (k as usize) < n {
            counts[k as usize] += 1;
        }
    }
    counts.into_iter().enumerate().map(|(k, c)| Bin { lo: lo + k as f64 * step, hi: lo + (k + 1) as f64 * step, count: c }).collect()
}

/// Each label's stack: its values above zero summed, and those below.
pub fn stacks_of(series: &[Series], count: usize) -> Vec<(f64, f64)> {
    (0..count)
        .map(|j| {
            let (mut up, mut down) = (0., 0.);
            for s in series {
                let v = s.values.get(j).copied().flatten().unwrap_or(0.);
                if v > 0. { up += v } else { down += v }
            }
            (up, down)
        })
        .collect()
}

/// How far a label's stack reaches: its values above zero summed, else those below; none if none.
pub fn sum_at(series: &[Series], j: usize) -> Option<f64> {
    let (mut up, mut down, mut any) = (0., 0., false);
    for s in series {
        if let Some(v) = s.values.get(j).copied().flatten() {
            any = true;
            if v > 0. { up += v } else { down += v }
        }
    }
    any.then_some(if up > 0. { up } else { down })
}

/// The extreme: the value furthest from zero, and where; none when every value is zero or none.
pub fn peak_of(values: &[Option<f64>]) -> Option<(usize, f64)> {
    let mut peak: Option<(usize, f64)> = None;
    for (at, v) in values.iter().enumerate() {
        if let Some(v) = *v
            && v != 0.
            && peak.is_none_or(|(_, p)| v.abs() > p.abs())
        {
            peak = Some((at, v));
        }
    }
    peak
}

/// Each label's topmost series above zero, which takes the stack's rounded end.
pub fn tops_of(series: &[Series], count: usize) -> Vec<Option<usize>> {
    (0..count).map(|j| series.iter().rposition(|s| s.values.get(j).copied().flatten().unwrap_or(0.) > 0.)).collect()
}

/// The scale for series' values, or their stacks' when stacked; from zero when `zero`.
pub fn value_scale(series: &[Series], count: usize, stacked: bool, zero: bool) -> Scale {
    let extent = if stacked {
        extent_of(stacks_of(series, count).into_iter().flat_map(|(u, d)| [Some(u), Some(d)]))
    } else {
        extent_of(series.iter().flat_map(|s| s.values.iter().copied()))
    };
    let (min, max) = extent.unwrap_or((0., 0.));
    scale_of(min, max, zero, false)
}
