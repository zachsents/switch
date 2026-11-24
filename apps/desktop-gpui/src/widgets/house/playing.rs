//! The house's Playing (the desktop's `widgets/playing.tsx`, `along.ts`): what's playing, its art edge
//! to edge at the cell's left, its title and who by, keys back, play or pause, and next, each calling
//! its extension's tool, and a rule along the foot that runs while it plays. Paused, one quiet line:
//! its title and the play key. A key's error takes who by's place.

use gpui::{AnyElement, App, FontWeight, IntoElement, ObjectFit, ParentElement, Styled, StyledImage, Window, div, img, prelude::*, px, relative};
use serde_json::{Map, Value};

use crate::kit::{self, Btn};
use crate::look::u;
use crate::time::now_ms;
use crate::widgets::basic::{glyph, tick};
use crate::widgets::house::lines::{Calling, run};
use crate::widgets::media::{WebPictures, safe_url};
use crate::widgets::render::Ctx;

/// How far in, 0 to 1: `at` as of `as_of`, run on to now while it plays.
fn along(at: Option<f64>, length: Option<f64>, as_of: Option<f64>, playing: bool) -> Option<f64> {
    let (at, length) = (at?, length.filter(|l| *l > 0.)?);
    let ran = match (playing, as_of) {
        (true, Some(a)) => (now_ms() - a).max(0.),
        _ => 0.,
    };
    Some(((at + ran) / length).clamp(0., 1.))
}

pub fn playing(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = ctx.look;
    let calling = ctx.state(c, "press", window, cx, |_, _| Calling::default());
    let (pending, error) = {
        let s = calling.read(cx);
        (s.pending, s.error.clone())
    };
    let playing = ctx.scope.flag(c, "playing");
    if playing {
        tick(c, ctx, 1000, window, cx);
    }
    let done = along(ctx.scope.number(c, "at"), ctx.scope.number(c, "length"), ctx.scope.number(c, "asOf"), playing);
    let by = error.clone().unwrap_or_else(|| ctx.scope.text(c, "by"));
    let title = ctx.scope.text(c, "title");
    let key = |tool_key: &str, label: &'static str, icon: &str, tag: &str| {
        let tool = c.get(tool_key).and_then(Value::as_str).unwrap_or_default().to_string();
        let (calling, surface) = (calling.clone(), ctx.surface_key());
        kit::press(kit::button(ctx.id(c, tag), Btn::Flat, !pending, &l).role(gpui::Role::Button).aria_label(label), !pending, move |_, _, cx| run(&surface, &tool, Map::new(), Map::new(), calling.clone(), |_| {}, cx)).child(glyph(icon, l.ink2))
    };
    if !playing {
        return div()
            .flex()
            .h(u(24.))
            .items_center()
            .gap(u(8.))
            .pl(u(8.))
            .child(div().flex_1().min_w_0().truncate().text_size(u(13.)).line_height(u(16.)).text_color(l.ink2).child(title))
            .child(div().flex().flex_none().pr(u(4.)).child(key("toggle", "Play", "play", "play")))
            .into_any_element();
    }
    // Its art's place is kept while the picture comes.
    let art = Some(ctx.scope.text(c, "art")).filter(|a| !a.is_empty()).map(|a| safe_url(&a, cx).and_then(|u| WebPictures::get(&u, cx)));
    div()
        .relative()
        .flex()
        .h(px(48.))
        .items_center()
        .children(art.map(|a| div().size(px(48.)).flex_none().children(a.map(|a| img(a).size_full().object_fit(ObjectFit::Cover)))))
        .child(
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_w_0()
                .gap(u(4.))
                .px(u(8.))
                .pb(u(6.))
                .child(div().truncate().text_size(u(13.)).line_height(u(16.)).font_weight(FontWeight::MEDIUM).text_color(l.ink).child(title))
                .when(!by.is_empty(), |d| d.child(div().truncate().text_size(u(12.)).line_height(u(16.)).text_color(if error.is_some() { l.ink } else { l.ink2 }).child(by))),
        )
        .child(div().flex().flex_none().pr(u(4.)).child(key("back", "Back", "skipPrevious", "back")).child(key("toggle", "Pause", "pause", "pause")).child(key("next", "Next", "skipNext", "next")))
        .children(done.map(|f| div().absolute().bottom_0().left_0().h(px(2.)).w(relative(f as f32)).bg(l.ink)))
        .into_any_element()
}
