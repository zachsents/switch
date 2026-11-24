//! Parts of a whole round a ring, the total in it (`donut-chart.tsx`, `slice.tsx`); beside it each
//! part's key, name and figure, in order. Past six slices, the rest fold into Other. The pointer
//! shows a slice's value and share, the slice lifting; its tooltip, at the slice's middle, may leave
//! the ring's box. The ring takes the keys as Recharts' accessibility layer has it: → ← move along
//! the slices.

use std::f32::consts::{PI, TAU};
use std::rc::Rc;

use gpui::InteractiveElement as _;
use gpui::{AnyElement, App, FontWeight, IntoElement, ParentElement, PathBuilder, Styled, Window, canvas, div, point, px};
use serde_json::Value;

use super::data::{self, Slice};
use super::figures::{figure, headline, percent};
use super::parts::{self, KeyKind, TipRead, TipRow, Within, k};
use crate::look::Look;
use crate::widgets::render::Ctx;

/// The ring's box, and its edges: a thin ring.
const SIZE: f32 = 140.;
const OUTER: f32 = 70.;
const INNER: f32 = 53.;

/// A point on a circle, `a` turned clockwise from the top.
fn on(cx: f32, cy: f32, r: f32, a: f32) -> gpui::Point<gpui::Pixels> {
    point(px(cx + r * a.sin()), px(cy - r * a.cos()))
}

/// A ring's sector from `a0` to `a1`, clockwise from the top.
fn sector(cx: f32, cy: f32, inner: f32, outer: f32, a0: f32, a1: f32, b: &mut PathBuilder) {
    // A whole ring is two halves: an arc can't end where it starts.
    if a1 - a0 >= TAU - 1e-4 {
        sector(cx, cy, inner, outer, a0, a0 + PI, b);
        sector(cx, cy, inner, outer, a0 + PI, a1, b);
        return;
    }
    let large = a1 - a0 > PI;
    b.move_to(on(cx, cy, outer, a0));
    b.arc_to(point(px(outer), px(outer)), px(0.), large, true, on(cx, cy, outer, a1));
    b.line_to(on(cx, cy, inner, a1));
    b.arc_to(point(px(inner), px(inner)), px(0.), large, false, on(cx, cy, inner, a0));
    b.close();
}

/// Each slice's turn, clockwise from the top.
fn turns(slices: &[Slice]) -> Vec<(f32, f32)> {
    let total: f64 = slices.iter().map(|s| s.value).sum();
    let mut at = 0.;
    slices
        .iter()
        .map(|s| {
            let a0 = at;
            at += (s.value / total) as f32 * TAU;
            (a0, at)
        })
        .collect()
}

/// The slice under the pointer, in the ring's own place: the topmost (the last drawn) whose sector,
/// its edge of the background with it, holds the pointer.
fn hit(slices: &[Slice], at: (f32, f32), l: &Look) -> Option<usize> {
    let s = k(l);
    let c = SIZE * s / 2.;
    let (dx, dy) = (at.0 - c, at.1 - c);
    let r = (dx * dx + dy * dy).sqrt();
    let edge = if slices.len() > 1 { parts::GAP * s / 2. } else { 0. };
    if r < INNER * s - edge || r > OUTER * s + edge || r == 0. {
        return None;
    }
    let a = dx.atan2(-dy).rem_euclid(TAU);
    let beyond = edge / r;
    let within = |a0: f32, a1: f32| (a - (a0 - beyond)).rem_euclid(TAU) <= a1 - a0 + 2. * beyond;
    turns(slices).iter().rposition(|(a0, a1)| within(*a0, *a1))
}

/// Where a slice's tooltip is at: its sector's middle (Recharts' `tooltipPosition`).
fn middle(slices: &[Slice], i: usize, l: &Look) -> (f32, f32) {
    let s = k(l);
    let c = SIZE * s / 2.;
    let (a0, a1) = turns(slices)[i];
    let p = on(c, c, (INNER + OUTER) / 2. * s, (a0 + a1) / 2.);
    (f32::from(p.x), f32::from(p.y))
}

/// The slice under the pointer, else the one the keys are at.
fn active(p: &parts::Pointer, slices: &[Slice], l: &Look) -> Option<usize> {
    p.local().and_then(|at| hit(slices, at, l)).or_else(|| p.keyed(slices.len()))
}

pub fn donut_chart(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    let l = ctx.look;
    let s = k(&l);
    let slices = Rc::new(data::slices_of(&ctx.scope.prop(c, "slices"), &l));
    if slices.is_empty() {
        return None;
    }
    let fig = super::figures::figures_of(c);
    let total: f64 = slices.iter().map(|s| s.value).sum();
    let n = slices.len();
    let pointer = parts::pointer(ctx, c, window, cx);
    let tip = active(pointer.read(cx), &slices, &l).map(|i| {
        let sl = &slices[i];
        let t = TipRead { title: String::new(), rows: vec![TipRow { value: figure(sl.value, &fig), name: sl.label.clone(), color: sl.color, note: percent(sl.value / total) }] };
        let size = parts::tip_size(&t, &l, window);
        // Free to leave the ring's box.
        parts::tip_over(ctx.id(c, "tip"), &t, parts::tip_place(middle(&slices, i, &l), size, Within::ANYWHERE, &l), &l)
    });
    let (sl2, ptr) = (slices.clone(), pointer.clone());
    let ring = canvas(
        move |b, window, _| parts::hitbox(b, window),
        move |b, hitbox, window, cx| {
            parts::follow(&ptr, b, hitbox, window, cx);
            let (ox, oy) = (f32::from(b.origin.x), f32::from(b.origin.y));
            let c = SIZE * s / 2.;
            let hover = active(ptr.read(cx), &sl2, &l);
            let gap = sl2.len() > 1;
            for (i, ((a0, a1), sl)) in turns(&sl2).into_iter().zip(sl2.iter()).enumerate() {
                let mut fillp = PathBuilder::fill();
                sector(ox + c, oy + c, INNER * s, OUTER * s, a0, a1, &mut fillp);
                if let Ok(path) = fillp.build() {
                    window.paint_path(path, if hover == Some(i) { sl.color.opacity(0.8) } else { sl.color });
                }
                if gap {
                    // A gap of the background between slices.
                    let mut edge = PathBuilder::stroke(px(parts::GAP * s));
                    sector(ox + c, oy + c, INNER * s, OUTER * s, a0, a1, &mut edge);
                    if let Ok(path) = edge.build() {
                        window.paint_path(path, l.bg);
                    }
                }
            }
        },
    )
    .size_full();
    let total_words = headline(total, &fig);
    // The list's grid: the figures one column as wide as the widest, right-aligned; the names the rest.
    let figures: Vec<String> = slices.iter().map(|sl| figure(sl.value, &fig)).collect();
    let column = figures.iter().map(|f| f32::from(parts::shape(f, 12., l.ink, false, &l, window).width)).fold(0., f32::max).ceil();
    let rows = slices.iter().zip(figures).enumerate().map(|(i, (sl, words))| {
        div()
            .flex()
            .items_center()
            .gap_x(l.z(8.))
            .child(parts::key(KeyKind::Square, sl.color, &l))
            .child(div().flex_1().min_w_0().truncate().text_size(l.z(12.)).line_height(l.z(16.)).text_color(l.ink2).child(parts::said(("label", i), sl.label.clone())))
            .child(div().flex_none().w(px(column)).flex().justify_end().whitespace_nowrap().text_size(l.z(12.)).line_height(l.z(16.)).text_color(l.ink).child(parts::said(("figure", i), words)))
    });
    Some(
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .font_features(parts::tnum())
            .gap_x(l.z(24.))
            .gap_y(l.z(12.))
            .px(l.z(8.))
            .py(l.z(8.))
            .child(
                parts::keyed(ctx.id(c, "ring"), &pointer, n, &l, cx)
                    .relative()
                    .flex_none()
                    .size(px(SIZE * s))
                    .child(ring)
                    .child(
                        div()
                            .absolute()
                            .top_0()
                            .left_0()
                            .size_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(l.z(22.))
                            .line_height(l.z(22.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .font_features(parts::pnum())
                            .text_color(l.ink)
                            .child(parts::said(ctx.id(c, "total"), total_words)),
                    )
                    .children(tip),
            )
            .child(div().id(ctx.id(c, "list")).flex().flex_col().gap_y(l.z(6.)).flex_1().min_w(l.z(160.)).max_w(l.z(260.)).children(rows))
            .into_any_element(),
    )
}
