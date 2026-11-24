//! The house's Row (the desktop's `widgets/row.tsx`): a line with its live mark, name and what's
//! under it, data at the end, a progress rule along the bottom and a countdown to `endsAt`; its
//! children below, one equal column each, tucked under it. With a `url`, the whole line opens it in
//! the browser. A detail said short shows its `note`, the whole of it, while the pointer is over it.
//! In a column with a live picture (a camera and its printer), the line is the picture's name plate
//! (black, flush left near the top, rounded at the right, the name in the sign face and where it's
//! at after it) and what it holds a black band along the picture's foot (index.css).

use gpui::{AnyElement, App, FontWeight, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement, Styled, Window, div, prelude::*, px, relative};
use serde_json::Value;

use crate::look::{Look, SIGN, u};
use crate::marks;
use crate::time::now_ms;
use crate::widgets::basic::{data, span_of, tick, warn};
use crate::widgets::house::runner;
use crate::widgets::render::Ctx;

/// The look on a picture: black, the inks white.
fn on_picture(l: &Look) -> Look {
    let w = l.white;
    Look { bg: l.black, ink: w, ink2: w.opacity(0.8), ink3: w.opacity(0.55), line1: w.opacity(0.22), line2: w.opacity(0.45), hover: w.opacity(0.18), ..*l }
}

pub fn row(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let plate = ctx.on_picture;
    let l = if plate { on_picture(&ctx.look) } else { ctx.look };
    let mark = match ctx.scope.text(c, "mark").as_str() {
        "running" => Some(runner(c, ctx, window, cx)),
        "needsYou" => Some(marks::hand(px(14.), &l).into_any_element()),
        "stop" => Some(marks::stop(px(14.), &l).into_any_element()),
        "warn" => Some(warn(px(14.), &l).into_any_element()),
        _ => None,
    };
    let ends = ctx.scope.prop(c, "endsAt").as_f64();
    let progress = ctx.scope.prop(c, "progress").as_f64();
    if ends.is_some() {
        tick(c, ctx, 30_000, window, cx);
    }
    let values: Vec<String> = ctx.scope.prop(c, "values").as_array().map(|a| a.iter().map(crate::a2ui::words_of).collect()).unwrap_or_default();
    let url = ctx.scope.text(c, "url");
    let note = ctx.scope.text(c, "note");
    let alert = ctx.scope.flag(c, "alert");
    let kids = ctx.scope.children(c, "children");
    let label = div()
        .min_w_0()
        .flex_none()
        .truncate()
        .map(|d| if plate { d.font_family(SIGN).text_size(u(15.)).line_height(u(15.)).font_weight(FontWeight::BOLD).child(ctx.scope.text(c, "label").to_uppercase()) } else { d.font_weight(FontWeight::MEDIUM).child(ctx.scope.text(c, "label")) });
    let detail = div()
        .id(ctx.id(c, "detail-words"))
        .min_w_0()
        .map(|d| if plate { d.flex_initial() } else { d.flex_1() })
        .truncate()
        .text_size(u(12.))
        .line_height(u(16.))
        .text_color(if alert && !plate { l.ink } else { l.ink2 })
        .child(ctx.scope.text(c, "detail"));
    // The note, the detail in full, under it while the pointer is over it.
    let detail = if note.is_empty() { detail } else { crate::kit::tip_under_at(detail.cursor_default(), &format!("{:?}", ctx.id(c, "detail")), note.clone(), 14., window, cx) };
    let mut head = div()
        .relative()
        .flex()
        .items_center()
        .gap(u(8.))
        .text_size(u(13.))
        .line_height(u(16.))
        .text_color(l.ink)
        .children(mark)
        .child(label)
        .child(detail)
        .children(values.into_iter().map(|v| data(v, &l)))
        .children(ends.map(|e| data(span_of(e - now_ms(), true), &l)));
    head = if plate {
        head.max_w_full().min_w_0().pt(px(6.)).pb(px(6.)).pr(px(10.)).pl(px(14.)).rounded_r(px(6.)).bg(l.black)
    } else {
        head.h(u(24.))
            .px(u(8.))
            .children(progress.map(|p| div().absolute().bottom_0().left_0().h(px(2.)).w(relative((p.clamp(0., 100.) / 100.) as f32)).bg(l.ink)))
    };
    // On a picture, the plate sits near its top, flush left, short of its right edge.
    let head = if plate { div().absolute().top(px(8.)).left_0().right(px(8.)).flex().child(head) } else { head };
    let head = if url.is_empty() {
        head.into_any_element()
    } else {
        // The whole line a key (Base UI's Button): Tab, Space and Enter open it too, named as the line.
        let open = url.clone();
        crate::kit::focusable(div().id(ctx.id(c, "open")).role(gpui::Role::Button).aria_label(ctx.scope.text(c, "label")), &l)
            .relative()
            .hover(|s| s.bg(l.hover))
            .active(|s| s.bg(l.hover))
            .on_click(move |_, _, cx| cx.open_url(&open))
            .child(head)
            .into_any_element()
    };
    let under = (!kids.is_empty()).then(|| {
        let mut k = ctx.clone();
        k.look = l;
        k.on_picture = false;
        let built = k.build_all(&kids, true, window, cx);
        div()
            .flex()
            .children(built.into_iter().map(|b| div().flex_1().min_w_0().child(b)))
            .map(|d| if plate { d.absolute().bottom_0().left_0().right_0().bg(l.black) } else { d.mt(u(-4.)) })
    });
    if plate {
        // Laid over the picture: the plate near its top, the band along its foot.
        div().absolute().top_0().left_0().size_full().child(head).children(under).into_any_element()
    } else {
        div().flex().flex_col().when(!kids.is_empty(), |d| d.pb(u(6.))).child(head).children(under).into_any_element()
    }
}
