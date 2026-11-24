//! How full something is (`meter.tsx`): a line with its label, a track filled to `value` of `max`
//! (100), and the figure (with a prefix or suffix, else the share). The fill is the first series'
//! color, square where it starts and rounded at its end; the track the lightest step of its hue.

use gpui::{AnyElement, App, IntoElement, ParentElement, Styled, Window, div, relative};
use serde_json::Value;

use super::data;
use super::figures::{figure, percent};
use crate::widgets::palette;
use crate::widgets::render::Ctx;

/// The track's height, and its end's radius.
const TRACK: f32 = 6.;
const END: f32 = 3.;

pub fn meter(c: &Value, ctx: &Ctx, _window: &mut Window, _cx: &mut App) -> Option<AnyElement> {
    let l = ctx.look;
    let value = data::number_of(&ctx.scope.prop(c, "value"))?;
    // `max` as the original takes it: as written (`?? 100`), divided as JavaScript divides.
    let max = c.get("max").filter(|m| !m.is_null()).map(super::figures::number_of).unwrap_or(100.);
    let share = (value / max).clamp(0., 1.);
    let fig = super::figures::figures_of(c);
    let label = ctx.scope.text(c, "label");
    let end = |d: gpui::Div| d.rounded_r(l.z(END));
    let words = if fig.prefix.is_empty() && fig.suffix.is_empty() { percent(value / max) } else { figure(value, &fig) };
    Some(
        div()
            .flex()
            .h(l.z(24.))
            .items_center()
            .gap(l.z(10.))
            .px(l.z(8.))
            .text_size(l.z(13.))
            .line_height(l.z(16.))
            .text_color(l.ink)
            .font_features(super::parts::tnum())
            .when(!label.is_empty(), |d| d.child(div().flex_none().w(relative(0.25)).min_w(l.z(64.)).truncate().child(super::parts::said(ctx.id(c, "label"), label.clone()))))
            .child(
                end(div().relative().flex_1().min_w(l.z(48.)).h(l.z(TRACK)).bg(palette::scale(&l, 1)))
                    .when(share > 0., |d| d.child(end(div().absolute().top_0().left_0().h_full().w(relative(share as f32)).min_w(l.z(END)).bg(data::first(&l))))),
            )
            .child(div().flex_none().text_size(l.z(11.)).line_height(l.z(14.)).text_color(l.ink2).child(super::parts::said(ctx.id(c, "figure"), words)))
            .into_any_element(),
    )
}

use gpui::prelude::FluentBuilder;
