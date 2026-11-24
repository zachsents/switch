//! A value per day, as weeks of squares, darker for more (`calendar-heatmap.tsx`, `calendar.tsx`):
//! weeks as columns of seven days, Sunday on top, each day a square darker for more (the one-hue
//! scale's five steps from zero to the most); a day with nothing, or none, in line-2. Each month
//! over the week it starts in; under the weeks the scale, zero to the most. Squares are 12 px at
//! most, smaller where the cell is narrow. The pointer shows a day, its square ringed: the day it
//! last came onto, as it was then, until it leaves the calendar.

use std::collections::BTreeMap;
use std::rc::Rc;

use chrono::{Datelike, Duration, NaiveDate};
use gpui::{AnyElement, App, Corners, Hsla, IntoElement, ParentElement, Styled, Window, div, fill, px};
use serde_json::Value;

use super::data;
use super::figures::{Figures, figure};
use super::parts::{self, TipRead, TipRow, bounds, k};
use crate::look::Look;
use crate::widgets::palette;
use crate::widgets::render::Ctx;

/// A day's square at most, and the gap of the background between squares.
const SQUARE: f32 = 12.;
const GAP: f32 = 2.;
/// Months named at least this many weeks apart, so their names don't run together.
const APART: i64 = 4;
/// The rows a day's tooltip opens under rather than over, having no room above them.
const LOW: usize = 3;
/// The months' row: a caption trimmed to its capitals, its padding and the 4 px under it.
const MONTHS: f32 = 18.6;
/// The scale's row under the weeks: 8 px over a caption's line.
const SCALE_ROW: f32 = 22.;

#[derive(Clone)]
struct Cell {
    day: NaiveDate,
    value: Option<f64>,
    color: Hsla,
    col: usize,
    row: usize,
}

struct Cal {
    cells: Vec<Cell>,
    weeks: usize,
    most: f64,
    fig: Figures,
    months: Vec<(usize, String)>,
}

/// The day the pointer came onto, as it was then, and where its tooltip goes from it: its square's
/// middle along, and the edge it opens from, the side it opens to.
#[derive(Clone)]
struct Hover {
    cell: Cell,
    x: f32,
    y: f32,
    align: Align,
}

#[derive(Clone, Copy)]
enum Align {
    Start,
    Center,
    End,
}

fn color_of(value: Option<f64>, most: f64, l: &Look) -> Hsla {
    match value {
        Some(v) if v > 0. && most > 0. => palette::scale(l, (((v / most) * 5.).ceil() as usize).clamp(1, 5)),
        _ => l.line2,
    }
}

impl Cal {
    /// A square's side and the grid's width, at `w`.
    fn square(&self, w: f32, l: &Look) -> f32 {
        let s = k(l);
        let n = self.weeks as f32;
        (SQUARE * s).min(((w - GAP * s * (n - 1.)) / n).max(1.))
    }

    fn height(&self, w: f32, l: &Look) -> f32 {
        let s = k(l);
        let sq = self.square(w, l);
        self.months_h(s) + GAP * s + 7. * sq + 6. * GAP * s + if self.most > 0. { SCALE_ROW * s } else { 0. }
    }

    /// The months' row: none when no month is named over the weeks (a week alone).
    fn months_h(&self, s: f32) -> f32 {
        if self.months.is_empty() { 0. } else { MONTHS * s }
    }

    fn cell_at(&self, i: usize, w: f32, l: &Look) -> (f32, f32, f32) {
        let s = k(l);
        let sq = self.square(w, l);
        let c = &self.cells[i];
        (c.col as f32 * (sq + GAP * s), self.months_h(s) + GAP * s + c.row as f32 * (sq + GAP * s), sq)
    }

    fn hit(&self, w: f32, at: (f32, f32), l: &Look) -> Option<usize> {
        (0..self.cells.len()).find(|&i| {
            let (x, y, sq) = self.cell_at(i, w, l);
            at.0 >= x && at.0 < x + sq && at.1 >= y && at.1 < y + sq
        })
    }
}

pub fn calendar_heatmap(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    let l = ctx.look;
    let s = k(&l);
    let days: BTreeMap<NaiveDate, f64> = data::days_of(&ctx.scope.prop(c, "days"));
    let (first, last) = (*days.keys().next()?, *days.keys().next_back()?);
    let most = days.values().copied().fold(0., f64::max);
    let start = first - Duration::days(i64::from(first.weekday().num_days_from_sunday()));
    let from = (first - start).num_days();
    let to = (last - start).num_days();
    let cells: Vec<Cell> = (from..=to)
        .map(|i| {
            let day = start + Duration::days(i);
            let value = days.get(&day).copied();
            Cell { day, value, color: color_of(value, most, &l), col: (i / 7) as usize, row: (i % 7) as usize }
        })
        .collect();
    let weeks = (to / 7) as usize + 1;
    // The month a week starts, over it, unless too near the one before.
    let starts: Vec<&Cell> = cells.iter().enumerate().filter(|(i, c)| *i == 0 || c.day.day() == 1).map(|(_, c)| c).collect();
    let mut months: Vec<(usize, String)> = vec![];
    for (i, c) in starts.iter().enumerate() {
        let crowded_first = i == 0 && starts.get(1).is_some_and(|n| (n.col as i64 - c.col as i64) < APART);
        let crowded = months.last().is_some_and(|(col, _)| (c.col as i64 - *col as i64) < APART);
        if !crowded_first && !crowded && c.col + 2 <= weeks {
            months.push((c.col, super::locale::day(c.day, "MMM")));
        }
    }
    let fig = super::figures::figures_of(c);
    let m = Rc::new(Cal { cells, weeks, most, fig, months });
    let pointer = parts::pointer(ctx, c, window, cx);
    let w = pointer.read(cx).width().or(ctx.width.map(|w| w - 16. * s)).unwrap_or(600.);
    let height = m.height(w, &l);
    // The day the pointer last came onto, kept across the gaps between days (and as it was, should the
    // days change under it) until the pointer leaves the calendar.
    let held = ctx.state(c, "held", window, cx, |_, _| None::<Hover>);
    let now = match pointer.read(cx).local() {
        None => None,
        Some(at) => match m.hit(w, at, &l) {
            Some(i) if held.read(cx).as_ref().is_none_or(|h| h.cell.day != m.cells[i].day) => {
                let cell = m.cells[i].clone();
                let (x, y, sq) = m.cell_at(i, w, &l);
                let mid = x + sq / 2.;
                // Where it is in the calendar's padded box, which the tooltip keeps 64 px in from.
                let (at, wide) = (mid + 8. * s, w + 16. * s);
                let align = if at < 64. * s {
                    Align::Start
                } else if at > wide - 64. * s {
                    Align::End
                } else {
                    Align::Center
                };
                let y = if cell.row < LOW { y + sq + 4. * s } else { y - 4. * s };
                Some(Hover { cell, x: mid, y, align })
            }
            _ => held.read(cx).clone(),
        },
    };
    if held.read(cx).as_ref().map(|h| (h.cell.day, h.x, h.y)) != now.as_ref().map(|h| (h.cell.day, h.x, h.y)) {
        let h2 = now.clone();
        held.update(cx, |h, _| *h = h2);
    }
    let shown = now.as_ref().map(|h| h.cell.day);
    let tip = now.map(|h| {
        let cell = &h.cell;
        let t = TipRead {
            title: super::locale::day(cell.day, "EEEMMMdy"),
            rows: cell.value.map(|v| TipRow { value: figure(v, &m.fig), name: String::new(), color: cell.color, note: String::new() }).into_iter().collect(),
        };
        let (tw, th) = parts::tip_size(&t, &l, window);
        let left = match h.align {
            Align::Start => h.x - 6. * s,
            Align::Center => h.x - tw / 2.,
            Align::End => h.x - tw + 6. * s,
        };
        let top = if cell.row < LOW { h.y } else { h.y - th };
        div().absolute().left(px(left)).top(px(top)).child(gpui::deferred(parts::tip_box(ctx.id(c, "tip"), &t, &l)).with_priority(1)).into_any_element()
    });
    let (m2, ptr) = (m.clone(), pointer.clone());
    let m3 = m.clone();
    let drawn = parts::drawn(
        ctx.id(c, "days"),
        move |b, window, _| {
            let w = f32::from(b.size.width);
            let (ox, oy) = (f32::from(b.origin.x), f32::from(b.origin.y));
            let sq = m3.square(w, &l);
            let mut words: Vec<parts::Word> = m3
                .months
                .iter()
                .map(|(col, text)| {
                    let line = parts::shape(text, 11., l.ink3, false, &l, window);
                    let baseline = parts::central(&line, oy + (MONTHS - 4.) * s / 2.);
                    parts::Word { text: text.clone(), line, left: ox + *col as f32 * (sq + GAP * s), baseline, over: true }
                })
                .collect();
            // The scale, zero to the most, at the right of the weeks: where its keys start, and their middle.
            let mut keys = None;
            if m3.most > 0. {
                let grid_w = m3.weeks as f32 * sq + (m3.weeks as f32 - 1.) * GAP * s;
                let zero = parts::Word::at(&figure(0., &m3.fig), l.ink3, 0., 0., &l, window);
                let top = parts::Word::at(&figure(m3.most, &m3.fig), l.ink3, 0., 0., &l, window);
                let (zw, tw) = (f32::from(zero.line.width), f32::from(top.line.width));
                let row_w = zw + 4. * s + 6. * 10. * s + 7. * 4. * s + 4. * s + tw;
                let mid = oy + m3.height(w, &l) - SCALE_ROW * s + 8. * s + 7. * s;
                let x = ox + grid_w.max(row_w) - row_w;
                let from = x + zw + 8. * s;
                words.push(parts::Word { left: x, baseline: parts::central(&zero.line, mid), ..zero });
                words.push(parts::Word { left: from + 6. * 14. * s + 4. * s, baseline: parts::central(&top.line, mid), ..top });
                keys = Some((from, mid));
            }
            // The pointer is the calendar's over its padding too.
            ((parts::hitbox(b.dilate(px(8. * s)), window), keys), words)
        },
        move |b, (hitbox, keys), words, window, cx| {
            parts::follow(&ptr, b, hitbox, window, cx);
            let w = f32::from(b.size.width);
            let (ox, oy) = (f32::from(b.origin.x), f32::from(b.origin.y));
            parts::paint_words(words, true, window, cx);
            for i in 0..m2.cells.len() {
                let (x, y, sq) = m2.cell_at(i, w, &l);
                let b = bounds(ox + x, oy + y, sq, sq);
                window.paint_quad(fill(b, m2.cells[i].color).corner_radii(Corners::all(px(sq * 0.2))));
                if shown == Some(m2.cells[i].day) {
                    // Its square ringed (`focused`): a hairline in ink3 just inside its rounded box.
                    window.paint_quad(gpui::quad(b, Corners::all(px(2. * s)), gpui::transparent_black(), px(s), l.ink3, gpui::BorderStyle::Solid));
                }
            }
            if let Some((mut x, mid)) = keys {
                for step in 0..6 {
                    let color = if step == 0 { l.line2 } else { palette::scale(&l, step) };
                    parts::rect(window, bounds(x, mid - 5. * s, 10. * s, 10. * s), color, Corners::all(px(2. * s)));
                    x += 14. * s;
                }
            }
        },
    );
    Some(
        div()
            .px(l.z(8.))
            .py(l.z(8.))
            .font_features(parts::tnum())
            .child(div().relative().w_full().h(px(height)).child(drawn).children(tip))
            .into_any_element(),
    )
}
