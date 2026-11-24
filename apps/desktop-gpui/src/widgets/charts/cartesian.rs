//! The charts on two axes (`bar-chart.tsx`, `segment.tsx`, `peak.tsx`, `trend.tsx`,
//! `line-chart.tsx`, `area-chart.tsx`, `lone.tsx`, `ends.tsx`, `sparkline.tsx`,
//! `scatter-chart.tsx`, `point.tsx`, `histogram.tsx`), laid out as Recharts lays them in the
//! desktop: a value axis whose width is its widest shown tick's, an axis of 20 px along the bottom,
//! each axis's words shown as Recharts' `interval` shows them; gridlines in line-2 hairlines at each
//! tick, the baseline at zero in line-1; everything stacked in Recharts' layers (grid, plain marks,
//! areas, the band under the pointer, bars, lines, axes, points, the crosshair, the active dots). Each
//! chart is laid out from the width it's drawn at, so its marks and its tooltip agree. The tooltip is
//! at the label under the pointer, else at the one the keys are at (Recharts' accessibility layer),
//! kept in the plot.

use std::rc::Rc;

use gpui::{AnyElement, App, Corners, Entity, Hsla, IntoElement, ParentElement, Styled, Window, canvas, div, px};
use serde_json::Value;

use super::data::{self, Points, Series};
use super::figures::{self, Figures, figure, tick};
use super::parts::{self, Interval, KeyKind, Pointer, TipRead, TipRow, Within, Word, bounds, k};
use super::scale::{self, Bin, Scale};
use crate::look::Look;
use crate::widgets::render::Ctx;

/// Lines ending in their value, at most.
const LABELLED: usize = 4;
/// The gap the label axes keep between words (`minTickGap={8}`).
const LABEL_GAP: f32 = 8.;

/// The plot, in the chart's own place.
#[derive(Clone, Copy, Debug)]
struct Plot {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

impl Plot {
    fn bottom(&self) -> f32 {
        self.y + self.h
    }
    fn right(&self) -> f32 {
        self.x + self.w
    }
    fn holds(&self, (x, y): (f32, f32)) -> bool {
        x >= self.x && x <= self.right() && y >= self.y && y <= self.bottom()
    }
    /// A value's place down the plot.
    fn y_of(&self, s: &Scale, v: f64) -> f32 {
        self.y + self.h * (1. - s.at(v) as f32)
    }
    /// A value's place along it.
    fn x_of(&self, s: &Scale, v: f64) -> f32 {
        self.x + self.w * s.at(v) as f32
    }
    fn moved(&self, (ox, oy): (f32, f32)) -> Plot {
        Plot { x: self.x + ox, y: self.y + oy, ..*self }
    }
    /// The tooltip's box.
    fn within(&self) -> Within {
        Within { x: self.x, y: self.y, w: self.w, h: self.h }
    }
}

fn fig_of(_ctx: &Ctx, c: &Value) -> Figures {
    figures::figures_of(c)
}

/// The chart's height as the original styles it (`height ?? HEIGHT`, as written): a positive figure
/// or CSS pixels, its own when none; anything else isn't a height CSS takes, and the chart draws
/// nothing.
fn height_of(_ctx: &Ctx, c: &Value, own: f32) -> f32 {
    match c.get("height") {
        None | Some(Value::Null) => own,
        Some(Value::Number(n)) => n.as_f64().filter(|h| *h > 0.).map_or(0., |h| h as f32),
        Some(Value::String(t)) => t.trim().strip_suffix("px").and_then(|n| n.trim().parse::<f32>().ok()).filter(|h| *h >= 0.).unwrap_or(0.),
        Some(_) => 0.,
    }
}

/// A flag as the original reads it: `true` as written.
fn flag(c: &Value, key: &str) -> bool {
    c.get(key) == Some(&Value::Bool(true))
}

/// Words as the original reads them (`typeof x === "string"`), as written.
fn words(c: &Value, key: &str) -> String {
    c.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn widest<'a>(words: impl IntoIterator<Item = &'a String>, l: &Look, window: &Window) -> f32 {
    words.into_iter().map(|w| parts::width_of(w, l, window)).fold(0., f32::max)
}

/// A value axis down the left: where each of its words shows (from the top back, a line's height
/// each, 5 px apart, in the chart's height), and its width from the widest of those.
fn y_axis(scale: &Scale, words: &[String], top: f32, plot_h: f32, height: f32, l: &Look, window: &Window) -> (Vec<Option<f32>>, f32) {
    let s = k(l);
    let p = Plot { x: 0., y: top, w: 0., h: plot_h };
    let coords: Vec<f32> = scale.ticks.iter().map(|t| p.y_of(scale, *t)).collect();
    let sizes = vec![parts::TICK_LINE * s; coords.len()];
    let shown = parts::ticks_shown(&coords, &sizes, (0., height), parts::TICK_GAP * s, Interval::End);
    let w = widest(words.iter().zip(&shown).filter(|(_, at)| at.is_some()).map(|(w, _)| w), l, window);
    (shown, parts::axis_width(w, l))
}

/// Words down the left, right-aligned to `right`, each set where it shows.
fn y_words(shown: &[Option<f32>], words: &[String], oy: f32, right: f32, l: &Look, window: &Window) -> Vec<Word> {
    shown.iter().zip(words).filter_map(|(at, w)| at.map(|at| Word::right(w, l.ink3, right, parts::y_baseline(oy + at, l), true, l, window))).collect()
}

/// Words along the bottom of `p`, each centred where it shows of `coords`, in the chart's box from
/// `lo` to `hi`.
#[allow(clippy::too_many_arguments)]
fn x_words(p: &Plot, coords: &[f32], words: &[String], (lo, hi): (f32, f32), gap: f32, interval: Interval, l: &Look, window: &Window) -> Vec<Word> {
    let lines: Vec<_> = words.iter().map(|w| parts::shape(w, parts::SMALL, l.ink3, false, l, window)).collect();
    let widths: Vec<f32> = lines.iter().map(|ln| f32::from(ln.width)).collect();
    let shown = parts::ticks_shown(coords, &widths, (lo, hi), gap * k(l), interval);
    let baseline = parts::x_baseline(p.bottom(), l);
    lines
        .into_iter()
        .enumerate()
        .filter(|(i, _)| !words[*i].is_empty())
        .filter_map(|(i, line)| shown[i].map(|at| Word { text: words[i].clone(), left: at - widths[i] / 2., baseline, line, over: true }))
        .collect()
}

/// The tooltip of what's at `at`, kept in `within`.
fn tip_at(id: gpui::ElementId, read: Option<TipRead>, at: (f32, f32), within: Within, l: &Look, window: &Window) -> Option<AnyElement> {
    let t = read.filter(|t| !t.rows.is_empty())?;
    let size = parts::tip_size(&t, l, window);
    Some(parts::tip_over(id, &t, parts::tip_place(at, size, within, l), l))
}

/// The chart's box: its canvas `height` tall, the tooltip over it, taking the keys over `n` labels.
#[allow(clippy::too_many_arguments)]
fn chart_box(ctx: &Ctx, c: &Value, pointer: &Entity<Pointer>, n: usize, height: f32, canvas_el: AnyElement, tip: Option<AnyElement>, cx: &App) -> AnyElement {
    // No height, no chart (Recharts draws nothing in a box without one).
    if height <= 0. {
        return div().w_full().into_any_element();
    }
    parts::keyed(ctx.id(c, "chart"), pointer, n, &ctx.look, cx).relative().w_full().h(px(height)).child(canvas_el).children(tip).into_any_element()
}

/// What a chart's tooltip and hover show: the label under the pointer, else the one the keys are at.
#[derive(Clone, Copy)]
enum Active {
    Pointer(usize, (f32, f32)),
    Keys(usize),
}

impl Active {
    fn of(p: &Pointer, under: Option<usize>, n: usize) -> Option<Active> {
        match (under, p.local()) {
            (Some(i), Some(at)) => Some(Active::Pointer(i, at)),
            _ => p.keyed(n).map(Active::Keys),
        }
    }
    fn index(&self) -> usize {
        match self {
            Active::Pointer(i, _) | Active::Keys(i) => *i,
        }
    }
}

/// Where an axis's tooltip is at (Recharts' active coordinate): across a label's place, the pointer's
/// height, or the keys' (halfway between the plot's top and the chart's foot); down a row's, the
/// pointer's left or halfway between the plot's left and the chart's right.
fn coordinate(active: Active, along: f32, rows: bool, plot: &Plot, size: (f32, f32)) -> (f32, f32) {
    match (active, rows) {
        (Active::Pointer(_, at), false) => (along, at.1),
        (Active::Pointer(_, at), true) => (at.0, along),
        (Active::Keys(_), false) => (along, (plot.y + size.1) / 2.),
        (Active::Keys(_), true) => ((plot.x + size.0) / 2., along),
    }
}

/// Bars' slots in a band (Recharts' `getBarPositions`): 10% of the band clear each side, bars `GAP`
/// apart (none when there's no room), each the rest shared out to a whole CSS pixel, at most `BAR`
/// thick, the group centred when held to it. The first's offset, a bar's thickness, and the step
/// from one to the next.
fn slots(band: f32, n: usize, l: &Look) -> (f32, f32, f32) {
    let s = k(l);
    let (b, n) = (band / s, n.max(1) as f32);
    let offset = b * 0.1;
    let mut gap = parts::GAP;
    if b - 2. * offset - (n - 1.) * gap <= 0. {
        gap = 0.;
    }
    let mut whole = (b - 2. * offset - (n - 1.) * gap) / n;
    if whole > 1. {
        whole = whole.round();
    }
    let size = whole.min(parts::BAR);
    ((offset + n * (whole - size) / 2.) * s, size * s, (size + gap) * s)
}

/// A bar's corners: rounded at its data end, square at the baseline.
fn data_end(horizontal: bool, up: bool, r: f32) -> Corners<gpui::Pixels> {
    let r = px(r);
    let z = px(0.);
    match (horizontal, up) {
        (false, true) => Corners { top_left: r, top_right: r, bottom_right: z, bottom_left: z },
        (false, false) => Corners { top_left: z, top_right: z, bottom_right: r, bottom_left: r },
        (true, true) => Corners { top_left: z, top_right: r, bottom_right: r, bottom_left: z },
        (true, false) => Corners { top_left: r, top_right: z, bottom_right: z, bottom_left: r },
    }
}

/// Recharts' `Rectangle`: its radius no more than half its sides.
fn rounded(window: &mut Window, b: gpui::Bounds<gpui::Pixels>, color: Hsla, horizontal: bool, up: bool, r: f32) {
    let (w, h) = (f32::from(b.size.width), f32::from(b.size.height));
    if w <= 0. || h <= 0. {
        return;
    }
    parts::rect(window, b, color, data_end(horizontal, up, r.min(w / 2.).min(h / 2.)));
}

/// The band under the pointer, washed (Recharts' cursor rectangle): its band across the plot, half a
/// pixel in from the plot's edges.
fn wash(window: &mut Window, p: &Plot, from: f32, band: f32, rows: bool, l: &Look) {
    let b = if rows { bounds(p.x + 0.5, from, p.w - 1., band) } else { bounds(from, p.y + 0.5, band, p.h - 1.) };
    parts::rect(window, b, l.hover, Corners::default());
}

/// The extreme's words at a bar's data end: over a column's cap (under one below zero), beside a
/// row's tip.
fn peak_word(text: &str, value: f64, along: f32, end: f32, horizontal: bool, l: &Look, window: &Window) -> Word {
    let s = k(l);
    let line = parts::shape(text, parts::SMALL, l.ink2, false, l, window);
    let tw = f32::from(line.width);
    let out = if value < 0. { -1. } else { 1. };
    let (left, baseline) = if horizontal {
        let x = end + out * parts::BESIDE * s;
        (if out > 0. { x } else { x - tw }, parts::central(&line, along))
    } else {
        let y = end - out * parts::BESIDE * s;
        (along - tw / 2., if out > 0. { y } else { y + parts::hanging(&line) })
    };
    // Recharts draws it among the chart's own marks, under the band the pointer washes.
    Word { text: text.to_string(), line, left, baseline, over: false }
}

// ——— Bars ———

struct Bars {
    labels: Vec<String>,
    series: Vec<Series>,
    stacked: bool,
    horizontal: bool,
    fig: Figures,
    scale: Scale,
    value_words: Vec<String>,
    tops: Vec<Option<usize>>,
    peak: Option<(usize, f64)>,
    peak_text: String,
    height: f32,
}

struct BarsLaid {
    plot: Plot,
    band: f32,
    axis_w: f32,
    /// Where the value axis's words show, down the left (columns).
    shown: Vec<Option<f32>>,
}

impl Bars {
    fn lay(&self, w: f32, l: &Look, window: &Window) -> BarsLaid {
        let s = k(l);
        let top = if self.peak.is_some() && !self.horizontal { 16. } else { 6. } * s;
        let right = if self.peak.is_some() && self.horizontal { parts::width_up(&self.peak_text, l, window) + (parts::BESIDE + 4.) * s } else { 6. * s };
        let h = (self.height - top - parts::X_AXIS * s).max(1.);
        let (shown, axis_w) =
            if self.horizontal { (vec![], parts::axis_width(widest(&self.labels, l, window), l)) } else { y_axis(&self.scale, &self.value_words, top, h, self.height, l, window) };
        let plot = Plot { x: axis_w, y: top, w: (w - axis_w - right).max(1.), h };
        let n = self.labels.len().max(1) as f32;
        let band = if self.horizontal { plot.h / n } else { plot.w / n };
        BarsLaid { plot, band, axis_w, shown }
    }

    /// The label under the pointer: the band it's in, in the plot.
    fn hit(&self, lay: &BarsLaid, at: Option<(f32, f32)>) -> Option<usize> {
        let at = at.filter(|at| lay.plot.holds(*at))?;
        let along = if self.horizontal { at.1 - lay.plot.y } else { at.0 - lay.plot.x };
        Some(((along / lay.band).floor().max(0.) as usize).min(self.labels.len() - 1))
    }

    fn read(&self, j: usize) -> TipRead {
        TipRead {
            title: self.labels[j].clone(),
            rows: self
                .series
                .iter()
                .filter_map(|s| s.values[j].map(|v| TipRow { value: figure(v, &self.fig), name: s.name.clone(), color: s.color, note: String::new() }))
                .collect(),
        }
    }

    /// A value's place along the value axis.
    fn v(&self, p: &Plot, v: f64) -> f32 {
        if self.horizontal { p.x_of(&self.scale, v) } else { p.y_of(&self.scale, v) }
    }

    /// A label's band's middle.
    fn along(&self, p: &Plot, band: f32, j: usize) -> f32 {
        (if self.horizontal { p.y } else { p.x }) + (j as f32 + 0.5) * band
    }

    fn tip(&self, id: gpui::ElementId, lay: &BarsLaid, active: Active, w: f32, l: &Look, window: &Window) -> Option<AnyElement> {
        let j = active.index();
        let at = coordinate(active, self.along(&lay.plot, lay.band, j), self.horizontal, &lay.plot, (w, self.height));
        tip_at(id, Some(self.read(j)), at, lay.plot.within(), l, window)
    }

    /// Its words: the extreme's, and the axes'.
    fn texts(&self, lay: &BarsLaid, origin: (f32, f32), w: f32, l: &Look, window: &Window) -> Vec<Word> {
        let s = k(l);
        let (ox, oy) = origin;
        let p = lay.plot.moved(origin);
        let mut out: Vec<Word> = self.peak.map(|(at, value)| peak_word(&self.peak_text, value, self.along(&p, lay.band, at), self.v(&p, value), self.horizontal, l, window)).into_iter().collect();
        if self.horizontal {
            let coords: Vec<f32> = self.scale.ticks.iter().map(|t| self.v(&p, *t)).collect();
            out.extend(x_words(&p, &coords, &self.value_words, (ox, ox + w), parts::TICK_GAP, Interval::End, l, window));
            let right = ox + lay.axis_w - parts::TICK_OFF * s;
            out.extend(self.labels.iter().enumerate().map(|(j, label)| Word::right(label, l.ink3, right, parts::y_baseline(self.along(&p, lay.band, j), l), true, l, window)));
        } else {
            out.extend(y_words(&lay.shown, &self.value_words, oy, ox + lay.axis_w - parts::TICK_OFF * s, l, window));
            let coords: Vec<f32> = (0..self.labels.len()).map(|j| self.along(&p, lay.band, j)).collect();
            out.extend(x_words(&p, &coords, &self.labels, (ox, ox + w), LABEL_GAP, Interval::StartEnd, l, window));
        }
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn paint(&self, lay: &BarsLaid, origin: (f32, f32), active: Option<usize>, words: &[Word], l: &Look, window: &mut Window, cx: &mut App) {
        let s = k(l);
        let p = lay.plot.moved(origin);
        // Gridlines at each value tick.
        for t in &self.scale.ticks {
            let at = self.v(&p, *t);
            if self.horizontal {
                parts::vline(window, at, p.y, p.bottom(), l.w2, l.line2);
            } else {
                parts::hline(window, p.x, p.right(), at, l.w2, l.line2);
            }
        }
        // The extreme, at its bar's data end, under the band the pointer washes.
        parts::paint_words(words, false, window, cx);
        if let Some(j) = active {
            wash(window, &p, (if self.horizontal { p.y } else { p.x }) + j as f32 * lay.band, lay.band, self.horizontal, l);
        }
        // The bars.
        let zero = self.v(&p, 0.);
        let n = if self.stacked { 1 } else { self.series.len() };
        let (offset, size, step) = slots(lay.band, n, l);
        let gap = parts::GAP * s;
        let radius = parts::END * s;
        let slot = |j: usize, i: usize| (if self.horizontal { p.y } else { p.x }) + j as f32 * lay.band + offset + i as f32 * step;
        let bar_box = |start: f32, a: f32, b: f32| {
            let (lo, hi) = (a.min(b), a.max(b));
            if self.horizontal { bounds(lo, start, hi - lo, size) } else { bounds(start, lo, size, hi - lo) }
        };
        for j in 0..self.labels.len() {
            if self.stacked {
                // Each series on the running sum of those before it (Recharts' stack, its offset none:
                // a value below zero comes back down the stack), a gap of the background where it sits
                // on another, the stack's data end rounded on the topmost above zero.
                let mut sum = 0.;
                for (si, ser) in self.series.iter().enumerate() {
                    let v = ser.values[j].unwrap_or(0.);
                    let (base, end) = (sum, sum + v);
                    sum = end;
                    let up = end >= base;
                    let (from, to) = (self.v(&p, base), self.v(&p, end));
                    let (mut lo, mut hi) = (from.min(to), from.max(to));
                    // The side it starts on: a column's foot, a row's left (the other way below zero).
                    let at_hi = self.horizontal != up;
                    if (from - zero).abs() > 0.5 {
                        if at_hi { hi -= gap } else { lo += gap }
                    }
                    if hi - lo <= 0. || size <= 0. {
                        continue;
                    }
                    let b = bar_box(slot(j, 0), lo, hi);
                    let r = if up && self.tops[j] == Some(si) { radius } else { 0. };
                    rounded(window, b, ser.color, self.horizontal, true, r);
                }
            } else {
                for (si, ser) in self.series.iter().enumerate() {
                    if let Some(v) = ser.values[j] {
                        rounded(window, bar_box(slot(j, si), zero, self.v(&p, v)), ser.color, self.horizontal, v >= 0., radius);
                    }
                }
            }
        }
        // The baseline at zero.
        if self.horizontal {
            parts::vline(window, zero, p.y, p.bottom(), l.w1, l.line1);
        } else {
            parts::hline(window, p.x, p.right(), zero, l.w1, l.line1);
        }
        // The axes' words.
        parts::paint_words(words, true, window, cx);
    }
}

pub fn bar_chart(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    let l = ctx.look;
    let s = k(&l);
    let labels = data::labels_of(&ctx.scope.prop(c, "labels"));
    let stacked = flag(c, "stacked");
    let horizontal = flag(c, "horizontal");
    let series = data::series_of(&ctx.scope.prop(c, "series"), labels.len(), stacked, &l);
    if labels.is_empty() || !data::any_value(&series) {
        return None;
    }
    let fig = fig_of(ctx, c);
    let peak = (stacked || series.len() == 1).then(|| scale::peak_of(&(0..labels.len()).map(|j| scale::sum_at(&series, j)).collect::<Vec<_>>())).flatten();
    let peak_text = peak.map(|(_, v)| figure(v, &fig)).unwrap_or_default();
    let scale = scale::value_scale(&series, labels.len(), stacked, true);
    let m = Rc::new(Bars {
        value_words: scale.ticks.iter().map(|t| tick(*t, &fig)).collect(),
        scale,
        tops: scale::tops_of(&series, labels.len()),
        peak,
        peak_text,
        height: height_of(ctx, c, parts::HEIGHT) * s,
        labels,
        series,
        stacked,
        horizontal,
        fig,
    });
    let n = m.labels.len();
    let pointer = parts::pointer(ctx, c, window, cx);
    let tip = {
        let p = pointer.read(cx);
        p.width().and_then(|w| {
            let lay = m.lay(w, &l, window);
            Active::of(p, m.hit(&lay, p.local()), n).and_then(|a| m.tip(ctx.id(c, "tip"), &lay, a, w, &l, window))
        })
    };
    let legend = parts::legend(ctx.id(c, "legend"), &m.series.iter().map(|s| (s.name.clone(), s.color)).collect::<Vec<_>>(), KeyKind::Square, &l);
    let (m2, ptr) = (m.clone(), pointer.clone());
    let m3 = m.clone();
    let drawn = parts::drawn(
        ctx.id(c, "marks"),
        move |b, window, _| {
            let w = f32::from(b.size.width);
            let lay = m3.lay(w, &l, window);
            let words = m3.texts(&lay, (f32::from(b.origin.x), f32::from(b.origin.y)), w, &l, window);
            ((parts::hitbox(b, window), lay), words)
        },
        move |b, (hit, lay), words, window, cx| {
            parts::follow(&ptr, b, hit, window, cx);
            let p = ptr.read(cx);
            let active = Active::of(p, m2.hit(&lay, p.local()), n).map(|a| a.index());
            m2.paint(&lay, (f32::from(b.origin.x), f32::from(b.origin.y)), active, words, &l, window, cx);
        },
    )
    .into_any_element();
    Some(div().px(l.z(8.)).py(l.z(8.)).font_features(parts::tnum()).children(legend).child(chart_box(ctx, c, &pointer, n, m.height, drawn, tip, cx)).into_any_element())
}

// ——— Histogram ———

struct Hist {
    bins: Vec<Bin>,
    fig: Figures,
    counts: Scale,
    words: Vec<String>,
    xs: Scale,
    peak: Option<(usize, f64)>,
    color: Hsla,
    height: f32,
}

struct HistLaid {
    plot: Plot,
    axis_w: f32,
    shown: Vec<Option<f32>>,
}

impl Hist {
    fn lay(&self, w: f32, l: &Look, window: &Window) -> HistLaid {
        let s = k(l);
        let top = 16. * s;
        let h = (self.height - top - parts::X_AXIS * s).max(1.);
        let (shown, axis_w) = y_axis(&self.counts, &self.words, top, h, self.height, l, window);
        HistLaid { plot: Plot { x: axis_w, y: top, w: (w - axis_w - 8. * s).max(1.), h }, axis_w, shown }
    }

    fn mid(&self, p: &Plot, i: usize) -> f32 {
        let b = self.bins[i];
        p.x_of(&self.xs, (b.lo + b.hi) / 2.)
    }

    /// The bin under the pointer: the one whose middle is nearest, in the plot.
    fn hit(&self, p: &Plot, at: Option<(f32, f32)>) -> Option<usize> {
        let at = at.filter(|at| p.holds(*at))?;
        Some(self.bins.iter().position(|b| at.0 < p.x_of(&self.xs, b.hi)).unwrap_or(self.bins.len() - 1))
    }

    fn read(&self, i: usize) -> TipRead {
        let b = self.bins[i];
        TipRead {
            title: format!("{}–{}", figure(b.lo, &self.fig), figure(b.hi, &self.fig)),
            rows: vec![TipRow { value: figure(b.count as f64, &figures::bare()), name: String::new(), color: self.color, note: String::new() }],
        }
    }

    #[allow(clippy::too_many_arguments)]
    /// Its words: the fullest bin's count, and the axes'.
    fn texts(&self, lay: &HistLaid, origin: (f32, f32), w: f32, l: &Look, window: &Window) -> Vec<Word> {
        let s = k(l);
        let p = lay.plot.moved(origin);
        let mut out: Vec<Word> =
            self.peak.map(|(at, value)| peak_word(&figure(value, &figures::bare()), value, self.mid(&p, at), p.y_of(&self.counts, value), false, l, window)).into_iter().collect();
        out.extend(y_words(&lay.shown, &self.words, origin.1, origin.0 + lay.axis_w - parts::TICK_OFF * s, l, window));
        let edges: Vec<f64> = std::iter::once(self.bins[0].lo).chain(self.bins.iter().map(|b| b.hi)).collect();
        let coords: Vec<f32> = edges.iter().map(|e| p.x_of(&self.xs, *e)).collect();
        let words: Vec<String> = edges.iter().map(|e| tick(*e, &self.fig)).collect();
        out.extend(x_words(&p, &coords, &words, (origin.0, origin.0 + w), LABEL_GAP, Interval::StartEnd, l, window));
        out
    }

    fn paint(&self, lay: &HistLaid, origin: (f32, f32), active: Option<usize>, words: &[Word], l: &Look, window: &mut Window, cx: &mut App) {
        let s = k(l);
        let p = lay.plot.moved(origin);
        for t in &self.counts.ticks {
            parts::hline(window, p.x, p.right(), p.y_of(&self.counts, *t), l.w2, l.line2);
        }
        parts::paint_words(words, false, window, cx);
        // A bin's band: its width on the axis.
        let band = |b: &Bin| p.x_of(&self.xs, b.hi) - p.x_of(&self.xs, b.lo);
        if let Some(i) = active {
            let b = self.bins[i];
            wash(window, &p, p.x_of(&self.xs, b.lo), band(&b), false, l);
        }
        let zero = p.y_of(&self.counts, 0.);
        for b in &self.bins {
            // A pixel of the background either side (`barCategoryGap={1}`), the rest to a whole pixel.
            let mut size = band(b) / s - 2.;
            if size > 1. {
                size = size.round();
            }
            let top = p.y_of(&self.counts, b.count as f64);
            if b.count > 0 {
                rounded(window, bounds(p.x_of(&self.xs, b.lo) + s, top, size * s, zero - top), self.color, false, true, parts::END * s);
            }
        }
        parts::hline(window, p.x, p.right(), zero, l.w1, l.line1);
        parts::paint_words(words, true, window, cx);
    }
}

pub fn histogram(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    let l = ctx.look;
    let s = k(&l);
    // `bins` as written, read as JavaScript's arithmetic reads it.
    let given = c.get("bins").filter(|b| !b.is_null()).map(figures::number_of);
    let bins = scale::bins_of(&data::numbers_of(&ctx.scope.prop(c, "values")), given);
    let (first, last) = (bins.first().copied()?, bins.last().copied()?);
    let counts: Vec<Option<f64>> = bins.iter().map(|b| Some(b.count as f64)).collect();
    let most = scale::extent_of(counts.iter().copied()).map(|e| e.1).unwrap_or(0.);
    let count_scale = scale::scale_of(0., most, true, true);
    let m = Rc::new(Hist {
        fig: fig_of(ctx, c),
        // Counts as the axis writes a number left as it is: "1000", never "1K".
        words: count_scale.ticks.iter().map(|t| figures::number_text(*t)).collect(),
        counts: count_scale,
        xs: Scale { domain: (first.lo, last.hi), ticks: vec![] },
        peak: scale::peak_of(&counts),
        color: data::first(&l),
        height: height_of(ctx, c, parts::HEIGHT) * s,
        bins,
    });
    let n = m.bins.len();
    let pointer = parts::pointer(ctx, c, window, cx);
    let tip = {
        let p = pointer.read(cx);
        p.width().and_then(|w| {
            let lay = m.lay(w, &l, window);
            let a = Active::of(p, m.hit(&lay.plot, p.local()), n)?;
            let at = coordinate(a, m.mid(&lay.plot, a.index()), false, &lay.plot, (w, m.height));
            tip_at(ctx.id(c, "tip"), Some(m.read(a.index())), at, lay.plot.within(), &l, window)
        })
    };
    let (m2, ptr) = (m.clone(), pointer.clone());
    let m3 = m.clone();
    let drawn = parts::drawn(
        ctx.id(c, "marks"),
        move |b, window, _| {
            let w = f32::from(b.size.width);
            let lay = m3.lay(w, &l, window);
            let words = m3.texts(&lay, (f32::from(b.origin.x), f32::from(b.origin.y)), w, &l, window);
            ((parts::hitbox(b, window), lay), words)
        },
        move |b, (hit, lay), words, window, cx| {
            parts::follow(&ptr, b, hit, window, cx);
            let p = ptr.read(cx);
            let active = Active::of(p, m2.hit(&lay.plot, p.local()), n).map(|a| a.index());
            m2.paint(&lay, (f32::from(b.origin.x), f32::from(b.origin.y)), active, words, &l, window, cx);
        },
    )
    .into_any_element();
    Some(div().px(l.z(8.)).py(l.z(8.)).font_features(parts::tnum()).child(chart_box(ctx, c, &pointer, n, m.height, drawn, tip, cx)).into_any_element())
}

// ——— Lines and areas ———

/// A line's end: where, its value, its words, its color.
struct EndMark {
    at: usize,
    value: f64,
    text: String,
    color: Hsla,
}

/// Each line's end: a dot in a ring of the background, its latest value beside it; when two would
/// touch, none is labelled. Drawn under the lines, as Recharts draws a chart's own marks.
fn paint_ends(placed: &[(f32, f32, &EndMark)], words: &[Word], l: &Look, window: &mut Window, cx: &mut App) {
    let s = k(l);
    for (x, y, e) in placed {
        parts::dot(window, *x, *y, (parts::DOT + parts::RING) * s, l.bg);
        parts::dot(window, *x, *y, parts::DOT * s, e.color);
    }
    parts::paint_words(words, false, window, cx);
}

/// The ends' words, beside their dots, when no two would touch.
fn end_words(placed: &[(f32, f32, &EndMark)], l: &Look, window: &Window) -> Vec<Word> {
    let s = k(l);
    let mut ys: Vec<f32> = placed.iter().map(|(_, y, _)| *y).collect();
    ys.sort_by(f32::total_cmp);
    if !ys.windows(2).all(|w| w[1] - w[0] >= (parts::SMALL + 2.) * s) {
        return vec![];
    }
    placed
        .iter()
        .filter(|(_, _, e)| !e.text.is_empty())
        .map(|(x, y, e)| {
            let line = parts::shape(&e.text, parts::SMALL, l.ink2, false, l, window);
            Word { text: e.text.clone(), baseline: parts::central(&line, *y), line, left: x + (parts::DOT + parts::BESIDE) * s, over: false }
        })
        .collect()
}

/// An active dot: the series' color in a ring of the background.
fn active_dot(window: &mut Window, x: f32, y: f32, color: Hsla, l: &Look) {
    let s = k(l);
    parts::dot(window, x, y, (parts::DOT + parts::RING) * s, l.bg);
    parts::dot(window, x, y, parts::DOT * s, color);
}

struct Trend {
    labels: Vec<String>,
    series: Vec<Series>,
    area: bool,
    stacked: bool,
    fig: Figures,
    scale: Scale,
    words: Vec<String>,
    ends: Vec<EndMark>,
    height: f32,
}

struct TrendLaid {
    plot: Plot,
    axis_w: f32,
    shown: Vec<Option<f32>>,
}

impl Trend {
    fn lay(&self, w: f32, l: &Look, window: &Window) -> TrendLaid {
        let s = k(l);
        let room = self.ends.iter().map(|e| parts::width_up(&e.text, l, window)).fold(0., f32::max);
        let right = if self.ends.is_empty() { 8. * s } else { room + (parts::DOT + parts::BESIDE + 4.) * s };
        let top = 8. * s;
        let h = (self.height - top - parts::X_AXIS * s).max(1.);
        let (shown, axis_w) = y_axis(&self.scale, &self.words, top, h, self.height, l, window);
        TrendLaid { plot: Plot { x: axis_w, y: top, w: (w - axis_w - right).max(1.), h }, axis_w, shown }
    }

    fn x(&self, p: &Plot, i: usize) -> f32 {
        let n = self.labels.len();
        if n <= 1 { p.x + p.w / 2. } else { p.x + p.w * i as f32 / (n - 1) as f32 }
    }

    fn hit(&self, p: &Plot, at: Option<(f32, f32)>) -> Option<usize> {
        let at = at.filter(|at| p.holds(*at))?;
        let n = self.labels.len();
        if n <= 1 {
            return Some(0);
        }
        Some((((at.0 - p.x) / p.w) * (n - 1) as f32).round().clamp(0., (n - 1) as f32) as usize)
    }

    fn read(&self, j: usize) -> TipRead {
        TipRead {
            title: self.labels[j].clone(),
            rows: self
                .series
                .iter()
                .filter_map(|s| s.values[j].map(|v| TipRow { value: figure(v, &self.fig), name: s.name.clone(), color: s.color, note: String::new() }))
                .collect(),
        }
    }

    /// Each series' values as drawn: stacked on those before it when stacked.
    fn drawn(&self) -> Vec<(Vec<Option<f64>>, Vec<f64>)> {
        let n = self.labels.len();
        let mut under = vec![0.; n];
        self.series
            .iter()
            .map(|s| {
                if !self.stacked {
                    return (s.values.clone(), vec![0.; n]);
                }
                let base = under.clone();
                let top: Vec<Option<f64>> = (0..n).map(|j| s.values[j].map(|v| base[j] + v)).collect();
                for j in 0..n {
                    under[j] += s.values[j].unwrap_or(0.);
                }
                (top, base)
            })
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    /// Its words: the ends' values, and the axes'.
    fn texts(&self, lay: &TrendLaid, origin: (f32, f32), w: f32, l: &Look, window: &Window) -> Vec<Word> {
        let s = k(l);
        let p = lay.plot.moved(origin);
        let placed: Vec<(f32, f32, &EndMark)> = self.ends.iter().map(|e| (self.x(&p, e.at), p.y_of(&self.scale, e.value), e)).collect();
        let mut out = end_words(&placed, l, window);
        out.extend(y_words(&lay.shown, &self.words, origin.1, origin.0 + lay.axis_w - parts::TICK_OFF * s, l, window));
        let coords: Vec<f32> = (0..self.labels.len()).map(|i| self.x(&p, i)).collect();
        out.extend(x_words(&p, &coords, &self.labels, (origin.0, origin.0 + w), LABEL_GAP, Interval::StartEnd, l, window));
        out
    }

    fn paint(&self, lay: &TrendLaid, origin: (f32, f32), active: Option<usize>, words: &[Word], l: &Look, window: &mut Window, cx: &mut App) {
        let s = k(l);
        let p = lay.plot.moved(origin);
        for t in &self.scale.ticks {
            parts::hline(window, p.x, p.right(), p.y_of(&self.scale, *t), l.w2, l.line2);
        }
        let placed: Vec<(f32, f32, &EndMark)> = self.ends.iter().map(|e| (self.x(&p, e.at), p.y_of(&self.scale, e.value), e)).collect();
        paint_ends(&placed, words, l, window, cx);
        let drawn = self.drawn();
        let (lo, hi) = self.scale.domain;
        // Runs of values with none between: a line can't cross a gap.
        let runs_of = |top: &[Option<f64>]| {
            let mut runs: Vec<Vec<usize>> = vec![];
            for (i, v) in top.iter().enumerate() {
                match (v, runs.last_mut()) {
                    (Some(_), Some(r)) if r.last() == Some(&(i.wrapping_sub(1))) => r.push(i),
                    (Some(_), _) => runs.push(vec![i]),
                    _ => {}
                }
            }
            runs
        };
        let lw = parts::LINE * s;
        let zero_line = |window: &mut Window| {
            if lo <= 0. && hi >= 0. {
                parts::hline(window, p.x, p.right(), p.y_of(&self.scale, 0.), l.w1, l.line1);
            }
        };
        if self.area {
            // Areas, each its wash and its line; the baseline over them.
            for (ser, (top, base)) in self.series.iter().zip(&drawn) {
                for run in runs_of(top).iter().filter(|r| r.len() > 1) {
                    let pts: Vec<(f32, f32)> = run.iter().map(|&i| (self.x(&p, i), p.y_of(&self.scale, top[i].unwrap_or(0.)))).collect();
                    let floor = |i: usize| p.y_of(&self.scale, if self.stacked { base[i] } else { 0f64.clamp(lo, hi) });
                    let mut shape = pts.clone();
                    shape.extend(run.iter().rev().map(|&i| (self.x(&p, i), floor(i))));
                    parts::polygon(window, &shape, ser.color.opacity(parts::WASH));
                    parts::polyline(window, &pts, lw, ser.color, false);
                }
            }
            zero_line(window);
        } else {
            // The baseline, then the lines over it.
            zero_line(window);
            for (ser, (top, _)) in self.series.iter().zip(&drawn) {
                for run in runs_of(top) {
                    let pts: Vec<(f32, f32)> = run.iter().map(|&i| (self.x(&p, i), p.y_of(&self.scale, top[i].unwrap_or(0.)))).collect();
                    if run.len() > 1 {
                        parts::polyline(window, &pts, lw, ser.color, true);
                    } else {
                        // A value with none either side, which a line can't draw: a dot, so it isn't lost.
                        parts::dot(window, pts[0].0, pts[0].1, (parts::DOT / 2. + 1.) * s, ser.color);
                    }
                }
            }
        }
        // The axes: the line along the bottom and their words.
        parts::hline(window, p.x, p.right(), p.bottom(), l.w1, l.line1);
        parts::paint_words(words, true, window, cx);
        if let Some(j) = active {
            let x = self.x(&p, j);
            parts::vline(window, x, p.y, p.bottom(), s, l.line1);
            for (ser, (top, _)) in self.series.iter().zip(&drawn) {
                if let Some(v) = top[j] {
                    active_dot(window, x, p.y_of(&self.scale, v), ser.color, l);
                }
            }
        }
    }
}

fn trend(c: &Value, ctx: &Ctx, area: bool, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    let l = ctx.look;
    let s = k(&l);
    let labels = data::labels_of(&ctx.scope.prop(c, "labels"));
    let stacked = area && flag(c, "stacked");
    let series = data::series_of(&ctx.scope.prop(c, "series"), labels.len(), stacked, &l);
    if labels.is_empty() || !data::any_value(&series) {
        return None;
    }
    let fig = fig_of(ctx, c);
    let ends = if stacked || series.len() > LABELLED {
        vec![]
    } else {
        series
            .iter()
            .filter_map(|ser| {
                let at = ser.values.iter().rposition(Option::is_some)?;
                let value = ser.values[at]?;
                Some(EndMark { at, value, text: figure(value, &fig), color: ser.color })
            })
            .collect()
    };
    let scale = scale::value_scale(&series, labels.len(), stacked, area);
    let m = Rc::new(Trend {
        words: scale.ticks.iter().map(|t| tick(*t, &fig)).collect(),
        scale,
        height: height_of(ctx, c, parts::HEIGHT) * s,
        labels,
        series,
        area,
        stacked,
        fig,
        ends,
    });
    let n = m.labels.len();
    let pointer = parts::pointer(ctx, c, window, cx);
    let tip = {
        let p = pointer.read(cx);
        p.width().and_then(|w| {
            let lay = m.lay(w, &l, window);
            let a = Active::of(p, m.hit(&lay.plot, p.local()), n)?;
            let at = coordinate(a, m.x(&lay.plot, a.index()), false, &lay.plot, (w, m.height));
            tip_at(ctx.id(c, "tip"), Some(m.read(a.index())), at, lay.plot.within(), &l, window)
        })
    };
    let legend = parts::legend(ctx.id(c, "legend"), &m.series.iter().map(|s| (s.name.clone(), s.color)).collect::<Vec<_>>(), if area { KeyKind::Square } else { KeyKind::Line }, &l);
    let (m2, ptr) = (m.clone(), pointer.clone());
    let m3 = m.clone();
    let drawn = parts::drawn(
        ctx.id(c, "marks"),
        move |b, window, _| {
            let w = f32::from(b.size.width);
            let lay = m3.lay(w, &l, window);
            let words = m3.texts(&lay, (f32::from(b.origin.x), f32::from(b.origin.y)), w, &l, window);
            ((parts::hitbox(b, window), lay), words)
        },
        move |b, (hit, lay), words, window, cx| {
            parts::follow(&ptr, b, hit, window, cx);
            let p = ptr.read(cx);
            let active = Active::of(p, m2.hit(&lay.plot, p.local()), n).map(|a| a.index());
            m2.paint(&lay, (f32::from(b.origin.x), f32::from(b.origin.y)), active, words, &l, window, cx);
        },
    )
    .into_any_element();
    Some(div().px(l.z(8.)).py(l.z(8.)).font_features(parts::tnum()).children(legend).child(chart_box(ctx, c, &pointer, n, m.height, drawn, tip, cx)).into_any_element())
}

pub fn line_chart(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    trend(c, ctx, false, window, cx)
}

pub fn area_chart(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    trend(c, ctx, true, window, cx)
}

// ——— Sparkline ———

/// A line's height (index.css `--spacing-line`).
const ROW: f32 = 24.;

struct Spark {
    values: Vec<f64>,
    lo: f64,
    hi: f64,
    color: Hsla,
    height: f32,
}

impl Spark {
    fn plot(&self, w: f32, l: &Look) -> Plot {
        let room = (parts::DOT + parts::RING) * k(l);
        Plot { x: room, y: room, w: (w - 2. * room).max(1.), h: (self.height - 2. * room).max(1.) }
    }

    fn at(&self, p: &Plot, i: usize) -> (f32, f32) {
        let n = self.values.len();
        let x = if n <= 1 { p.x + p.w / 2. } else { p.x + p.w * i as f32 / (n - 1) as f32 };
        let t = if self.hi - self.lo == 0. { 0.5 } else { (self.values[i] - self.lo) / (self.hi - self.lo) };
        (x, p.y + p.h * (1. - t as f32))
    }

    /// The value under the pointer, in the plot.
    fn hit(&self, p: &Plot, at: Option<(f32, f32)>) -> Option<usize> {
        let at = at.filter(|at| p.holds(*at))?;
        let n = self.values.len();
        Some(if n <= 1 { 0 } else { (((at.0 - p.x) / p.w) * (n - 1) as f32).round().clamp(0., (n - 1) as f32) as usize })
    }
}

pub fn sparkline(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    let l = ctx.look;
    let s = k(&l);
    let values = data::numbers_of(&ctx.scope.prop(c, "values"));
    let last = *values.last()?;
    let flat = values.iter().all(|v| *v == last);
    let (lo, hi) = if flat { (last - 1., last + 1.) } else { scale::extent_of(values.iter().map(|v| Some(*v))).unwrap_or((last, last)) };
    let m = Rc::new(Spark { values, lo, hi, color: data::first(&l), height: height_of(ctx, c, ROW) * s });
    let n = m.values.len();
    let pointer = parts::pointer(ctx, c, window, cx);
    let tip = {
        let p = pointer.read(cx);
        p.width().and_then(|w| {
            let plot = m.plot(w, &l);
            let i = Active::of(p, m.hit(&plot, p.local()), n)?.index();
            let t = TipRead { title: String::new(), rows: vec![TipRow { value: figure(m.values[i], &figures::bare()), name: String::new(), color: m.color, note: String::new() }] };
            let size = parts::tip_size(&t, &l, window);
            // At the top of its row (`position={{ y: 0 }}`), beside the value along it.
            let x = parts::tip_place((m.at(&plot, i).0, 0.), size, plot.within(), &l).0;
            Some(parts::tip_over(ctx.id(c, "tip"), &t, (x, 0.), &l))
        })
    };
    let (m2, ptr) = (m.clone(), pointer.clone());
    let drawn = canvas(
        move |b, window, _| parts::hitbox(b, window),
        move |b, hit, window, cx| {
            parts::follow(&ptr, b, hit, window, cx);
            let w = f32::from(b.size.width);
            let p = m2.plot(w, &l).moved((f32::from(b.origin.x), f32::from(b.origin.y)));
            let pr = ptr.read(cx);
            let active = Active::of(pr, m2.hit(&m2.plot(w, &l), pr.local()), n).map(|a| a.index());
            let pts: Vec<(f32, f32)> = (0..m2.values.len()).map(|i| m2.at(&p, i)).collect();
            // Its latest value's dot, under the line.
            let end = *pts.last().unwrap_or(&(0., 0.));
            active_dot(window, end.0, end.1, m2.color, &l);
            if pts.len() > 1 {
                parts::polyline(window, &pts, parts::LINE * s, m2.color, true);
            } else {
                parts::dot(window, pts[0].0, pts[0].1, (parts::DOT / 2. + 1.) * s, m2.color);
            }
            if let Some(i) = active {
                let (x, y) = m2.at(&p, i);
                parts::vline(window, x, p.y, p.bottom(), s, l.line1);
                active_dot(window, x, y, m2.color, &l);
            }
        },
    )
    .size_full()
    .into_any_element();
    Some(div().px(l.z(8.)).font_features(parts::tnum()).child(chart_box(ctx, c, &pointer, n, m.height, drawn, tip, cx)).into_any_element())
}

// ——— Scatter ———

/// Half a point's hit, wider than its dot.
const HIT: f32 = 12.;

struct Scatter {
    series: Vec<Points>,
    x_label: String,
    y_label: String,
    xs: Scale,
    ys: Scale,
    words: Vec<String>,
    height: f32,
}

struct ScatterLaid {
    plot: Plot,
    axis_w: f32,
    shown: Vec<Option<f32>>,
}

impl Scatter {
    fn lay(&self, w: f32, l: &Look, window: &Window) -> ScatterLaid {
        let s = k(l);
        let top = 8. * s;
        let h = (self.height - top - parts::X_AXIS * s).max(1.);
        let (shown, axis_w) = y_axis(&self.ys, &self.words, top, h, self.height, l, window);
        ScatterLaid { plot: Plot { x: axis_w, y: top, w: (w - axis_w - 8. * s).max(1.), h }, axis_w, shown }
    }

    fn place(&self, p: &Plot, (x, y): (f64, f64)) -> (f32, f32) {
        (p.x_of(&self.xs, x), p.y_of(&self.ys, y))
    }

    /// The point under the pointer: the topmost whose hit holds it (the last drawn).
    fn hit(&self, p: &Plot, at: (f32, f32), l: &Look) -> Option<(usize, usize)> {
        let reach = HIT * k(l);
        let mut out = None;
        for (si, ser) in self.series.iter().enumerate() {
            for (pi, pt) in ser.points.iter().enumerate() {
                let (x, y) = self.place(p, *pt);
                if (x - at.0).powi(2) + (y - at.1).powi(2) <= reach * reach {
                    out = Some((si, pi));
                }
            }
        }
        out
    }

    /// What the keys show at `i` (an item tooltip's first series, by index): its point, if it has one.
    fn keyed(&self, i: usize) -> Option<(usize, usize)> {
        (i < self.series[0].points.len()).then_some((0, i))
    }

    /// How many places the keys move over: every point (Recharts' displayed data).
    fn count(&self) -> usize {
        self.series.iter().map(|s| s.points.len()).sum()
    }

    fn read(&self, (si, pi): (usize, usize)) -> TipRead {
        let ser = &self.series[si];
        let (x, y) = ser.points[pi];
        TipRead {
            title: if self.series.len() > 1 { ser.name.clone() } else { String::new() },
            rows: vec![
                TipRow { value: figure(x, &figures::bare()), name: if self.x_label.is_empty() { "x".into() } else { self.x_label.clone() }, color: ser.color, note: String::new() },
                TipRow { value: figure(y, &figures::bare()), name: if self.y_label.is_empty() { "y".into() } else { self.y_label.clone() }, color: ser.color, note: String::new() },
            ],
        }
    }

    /// The point under the pointer, else the one the keys are at.
    fn active(&self, p: &Pointer, plot: &Plot, l: &Look) -> Option<(usize, usize)> {
        p.local().and_then(|at| self.hit(plot, at, l)).or_else(|| p.keyed(self.count()).and_then(|i| self.keyed(i)))
    }
}

pub fn scatter_chart(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    let l = ctx.look;
    let s = k(&l);
    let series = data::points_of(&ctx.scope.prop(c, "series"), &l);
    if series.is_empty() {
        return None;
    }
    let xe = scale::extent_of(series.iter().flat_map(|s| s.points.iter().map(|p| Some(p.0)))).unwrap_or((0., 0.));
    let ye = scale::extent_of(series.iter().flat_map(|s| s.points.iter().map(|p| Some(p.1)))).unwrap_or((0., 0.));
    let ys = scale::scale_of(ye.0, ye.1, false, false);
    let m = Rc::new(Scatter {
        x_label: words(c, "xLabel"),
        y_label: words(c, "yLabel"),
        xs: scale::scale_of(xe.0, xe.1, false, false),
        words: ys.ticks.iter().map(|t| tick(*t, &figures::bare())).collect(),
        ys,
        height: height_of(ctx, c, parts::HEIGHT) * s,
        series,
    });
    let n = m.count();
    let pointer = parts::pointer(ctx, c, window, cx);
    let tip = {
        let p = pointer.read(cx);
        p.width().and_then(|w| {
            let lay = m.lay(w, &l, window);
            let h = m.active(p, &lay.plot, &l)?;
            tip_at(ctx.id(c, "tip"), Some(m.read(h)), m.place(&lay.plot, m.series[h.0].points[h.1]), lay.plot.within(), &l, window)
        })
    };
    let legend = parts::legend(ctx.id(c, "legend"), &m.series.iter().map(|s| (s.name.clone(), s.color)).collect::<Vec<_>>(), KeyKind::Dot, &l);
    let caption = |tag: &str, words: &str| div().text_size(l.z(11.)).line_height(l.z(14.)).text_color(l.ink3).child(parts::said(ctx.id(c, tag), words.to_string()));
    let (m2, ptr) = (m.clone(), pointer.clone());
    let m3 = m.clone();
    let drawn = parts::drawn(
        ctx.id(c, "marks"),
        move |b, window, _| {
            let w = f32::from(b.size.width);
            let lay = m3.lay(w, &l, window);
            let (ox, oy) = (f32::from(b.origin.x), f32::from(b.origin.y));
            let p = lay.plot.moved((ox, oy));
            let mut words = y_words(&lay.shown, &m3.words, oy, ox + lay.axis_w - parts::TICK_OFF * s, &l, window);
            let coords: Vec<f32> = m3.xs.ticks.iter().map(|t| p.x_of(&m3.xs, *t)).collect();
            let xs: Vec<String> = m3.xs.ticks.iter().map(|t| tick(*t, &figures::bare())).collect();
            words.extend(x_words(&p, &coords, &xs, (ox, ox + w), parts::TICK_GAP, Interval::End, &l, window));
            ((parts::hitbox(b, window), lay), words)
        },
        move |b, (hit, lay), words, window, cx| {
            parts::follow(&ptr, b, hit, window, cx);
            let p = lay.plot.moved((f32::from(b.origin.x), f32::from(b.origin.y)));
            for t in &m2.ys.ticks {
                parts::hline(window, p.x, p.right(), p.y_of(&m2.ys, *t), l.w2, l.line2);
            }
            parts::hline(window, p.x, p.right(), p.bottom(), l.w1, l.line1);
            parts::paint_words(words, true, window, cx);
            for ser in &m2.series {
                for pt in &ser.points {
                    let (x, y) = m2.place(&p, *pt);
                    active_dot(window, x, y, ser.color, &l);
                }
            }
        },
    )
    .into_any_element();
    Some(
        div()
            .flex()
            .flex_col()
            .px(l.z(8.))
            .py(l.z(8.))
            .font_features(parts::tnum())
            .children(legend)
            .when(!m.y_label.is_empty(), |d| d.child(caption("yLabel", &m.y_label).pb(l.z(6.))))
            .child(chart_box(ctx, c, &pointer, n, m.height, drawn, tip, cx))
            .when(!m.x_label.is_empty(), |d| d.child(div().flex().justify_end().pt(l.z(4.)).child(caption("xLabel", &m.x_label))))
            .into_any_element(),
    )
}

use gpui::prelude::FluentBuilder;
