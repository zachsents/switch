//! A2UI's layout and display parts in the house look (the desktop's `widgets/basic/`): Row, Column,
//! List (`row.tsx`, `column.tsx`, `list.tsx`, `flex.ts`, `each.tsx`): children laid with no gaps or
//! padding of their own, `justify` along and `align` across as A2UI's own, `stretch` an equal share
//! each; Card (`card.tsx`), a region on the grid with a line-1 after it; Tabs (`tabs.tsx`), Modal
//! (`modal.tsx`), Divider (`divider.tsx`), Button (`button.tsx`, `in-key.ts`), Icon (`icon.tsx`,
//! `glyph.tsx`) and Image (`image.tsx`). A column holding a live picture (a camera and its printer)
//! puts the picture first and lays its lines on it (index.css's `[data-column]:has([data-feed])`).

use gpui::{
    AnyElement, App, Div, InteractiveElement, IntoElement, ObjectFit, ParentElement, StatefulInteractiveElement,
    Styled, StyledImage, Window, div, img, prelude::*, px,
};
use serde_json::Value;

use crate::kit::{self, Btn};
use crate::look::u;
use crate::widgets::basic::{glyph, glyph24, icons, nothing, share};
use crate::widgets::media::{WebPictures, safe_url};
use crate::widgets::render::{Ctx, has_feed};

/// `justify` along a Row or Column, as CSS's own values.
fn justify(d: Div, j: &str) -> Div {
    match j {
        "center" => d.justify_center(),
        "end" => d.justify_end(),
        "spaceBetween" => d.justify_between(),
        "spaceAround" => d.justify_around(),
        "spaceEvenly" => d.justify_evenly(),
        "start" => d.justify_start(),
        _ => d,
    }
}

/// `align` across.
fn align(d: Div, a: &str) -> Div {
    match a {
        "start" => d.items_start(),
        "center" => d.items_center(),
        "end" => d.items_end(),
        "stretch" => d.items_stretch(),
        _ => d,
    }
}

/// Children each in an equal share (`stretch`, or a list across).
fn equal(children: Vec<AnyElement>) -> Vec<AnyElement> {
    children.into_iter().map(|c| div().flex_1().min_w_0().flex().flex_col().child(c).into_any_element()).collect()
}

pub fn row(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let kids = ctx.scope.children(c, "children");
    let j = ctx.scope.text(c, "justify");
    let mut built = ctx.build_all(&kids, true, window, cx);
    if j == "stretch" {
        built = equal(built);
    }
    let d = div().flex().when(ctx.in_key, |d| d.items_center().gap(u(6.)));
    share(align(justify(d, &j), &ctx.scope.text(c, "align")), c, ctx).children(built).into_any_element()
}

/// A part between a picture's column and its lines (a List of Rows) lies over the whole picture
/// too, so the lines' plate and band find the picture's edges (gpui lays an absolute child in its
/// own parent, where CSS finds the nearest positioned one).
fn over(d: gpui::Div, ctx: &Ctx) -> gpui::Div {
    if ctx.on_picture { d.absolute().top_0().left_0().size_full() } else { d }
}

pub fn column(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let kids = ctx.scope.children(c, "children");
    let j = ctx.scope.text(c, "justify");
    let feed = kids.iter().any(|k| has_feed(&ctx.for_child(k, true, false), &k.id, 0));
    let d = share(align(justify(div().flex().flex_col(), &j), &ctx.scope.text(c, "align")), c, ctx);
    if !feed {
        let mut built = ctx.build_all(&kids, false, window, cx);
        if j == "stretch" {
            built = equal(built);
        }
        return over(d, ctx).children(built).into_any_element();
    }
    // The picture first, edge to edge, and everything the column's lines say laid on it.
    let n = kids.len();
    let mut pictures = vec![];
    let mut on = vec![];
    for (i, k) in kids.iter().enumerate() {
        let mut child = ctx.for_child(k, i + 1 == n, false);
        if has_feed(&child, &k.id, 0) {
            pictures.push(child.build(k, window, cx));
        } else {
            child.on_picture = true;
            on.push(child.build(k, window, cx));
        }
    }
    d.relative().children(pictures).children(on).into_any_element()
}

pub fn list(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let kids = ctx.scope.children(c, "children");
    let a = ctx.scope.text(c, "align");
    if ctx.scope.text(c, "direction") == "horizontal" {
        let built = equal(ctx.build_all(&kids, true, window, cx));
        return over(share(align(div().flex(), &a), c, ctx), ctx).children(built).into_any_element();
    }
    let built = ctx.build_all(&kids, false, window, cx);
    over(share(align(div().flex().flex_col(), &a), c, ctx), ctx).children(built).into_any_element()
}

/// A2UI's Card, on the grid: no box, no rounding, no padding. Its child edge to edge, a region of
/// its own: a line-1 parts it from what follows it, under it down a column, beside it across a row;
/// the last one's edge is its parent's.
pub fn card(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = ctx.look;
    let inner = ctx.scope.child(c, "child").map(|ch| ctx.for_child(&ch, true, false).build(&ch, window, cx));
    over(share(div().flex().flex_col(), c, ctx), ctx)
        .when(!ctx.last && !ctx.on_picture, |d| d.border_b(px(l.w1)).border_color(l.line1))
        .when(!ctx.last && ctx.across, |d| d.border_r(px(l.w1)).border_color(l.line1))
        .children(inner)
        .into_any_element()
}

/// A2UI's Tabs: their titles as the house's Segmented over the chosen tab's child, on a strip (inset,
/// a line-2 under it). The first is chosen until another is, and again when the chosen one is gone.
pub struct Chosen(pub usize);

pub fn tabs(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = ctx.look;
    let tabs: Vec<(String, Option<String>)> = c
        .get("tabs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|t| (crate::a2ui::words_of(&ctx.scope.resolve(t.get("title").unwrap_or(&Value::Null))), t.get("child").and_then(Value::as_str).map(str::to_string)))
        .collect();
    let chosen = ctx.state(c, "tab", window, cx, |_, _| Chosen(0));
    let at = chosen.read(cx).0;
    let at = if at < tabs.len() { at } else { 0 };
    let values: Vec<String> = (0..tabs.len()).map(|i| i.to_string()).collect();
    let options: Vec<(&str, &str)> = values.iter().zip(tabs.iter()).map(|(v, t)| (v.as_str(), t.0.as_str())).collect();
    let id = format!("{:?}", ctx.id(c, "tabs"));
    let strip = kit::tabs(id, "Tabs", &options, &at.to_string(), &l, move |next, _, cx| {
        let n = next.parse().unwrap_or(0);
        chosen.update(cx, |c, cx| {
            c.0 = n;
            cx.notify();
        });
    }, window, cx);
    let child = tabs.get(at).and_then(|t| t.1.clone()).map(|id| {
        let ch = crate::a2ui::Child { id, base: ctx.scope.base.clone() };
        ctx.for_child(&ch, true, false).build(&ch, window, cx)
    });
    share(div().flex().flex_col(), c, ctx)
        .child(div().flex().h(u(36.)).items_center().px(u(8.)).border_b(px(l.w2)).border_color(l.line2).child(strip))
        .children(child)
        .into_any_element()
}

/// A2UI's Modal: its trigger in place, and pressing it (what's in it acts too) floats its content
/// over the window as what floats does (the background, a line-1 hairline, no shadow, a little
/// rounded), centred, at least 280 wide and its content's size up to most of the window. UI SDK's
/// Dialog (Base UI's): the trigger a button, Tab kept inside it while it's open, focus back on the
/// trigger after; Esc, a press outside or its ✕ (a flat key in its corner) puts it away.
pub fn modal(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    use ui_sdk::components::dialog::{Dialog, DialogCloseProps, DialogContentProps, DialogOptions, DialogTriggerProps};
    let l = ctx.look;
    let dialog = ctx.state(c, "modal", window, cx, |window, cx| Dialog::<()>::new(DialogOptions::default(), window, cx));
    let trigger = ctx.scope.child(c, "trigger").map(|ch| ctx.for_child(&ch, true, false).build(&ch, window, cx));
    // Named by what's in it, as a screen reader names a button.
    let named = ctx.scope.child(c, "trigger").map(|ch| crate::widgets::render::words_in(&ctx.for_child(&ch, true, false), &ch.id, 0)).unwrap_or_default();
    let vp = window.viewport_size();
    let backdrop = Dialog::backdrop(&dialog, None, cx).map(|b| b.child(crate::webview::covering()));
    let content = ctx.scope.child(c, "content").map(|ch| ctx.for_child(&ch, true, false).build(&ch, window, cx));
    let popup = Dialog::content(&dialog, DialogContentProps::default(), cx).map(|p| {
        let close = Dialog::close_part(&dialog, "close", DialogCloseProps::default(), cx)
            .aria_label("Close")
            .with(move |el, _| el.hover(|s| s.bg(l.hover)).active(|s| s.bg(l.hover)).focus_visible(move |s| s.shadow(kit::ring(&l))))
            .flex()
            .items_center()
            .justify_center()
            .h(u(22.))
            .rounded(u(4.))
            .px(u(6.))
            .text_size(u(12.))
            .line_height(u(16.))
            .font_weight(gpui::FontWeight::MEDIUM)
            .text_color(l.ink2)
            .child("✕");
        // What floats (kit::float): the background in a line-1 hairline, a little rounded.
        p.with(move |el, _| el.overflow_y_scroll())
            .m_auto()
            .relative()
            .rounded(u(6.))
            .border_1()
            .border_color(l.line1)
            .bg(l.bg)
            .text_color(l.ink)
            .min_w(px(280.))
            .max_w(vp.width * 0.8)
            .max_h(vp.height * 0.85)
            .child(crate::webview::covering())
            .children(content)
            .child(div().absolute().top(u(4.)).right(u(4.)).child(close))
    });
    share(div(), c, ctx)
        .child(Dialog::trigger(&dialog, "trigger", DialogTriggerProps::default(), cx).aria_label(named).children(trigger))
        .children(backdrop)
        .children(popup)
        .into_any_element()
}

/// A2UI's Divider: a line-2, the line within a region, across the cell, or down it beside what's in
/// a row.
pub fn divider(c: &Value, ctx: &Ctx) -> AnyElement {
    let l = ctx.look;
    if ctx.scope.text(c, "axis") == "vertical" {
        share(div().w(px(l.w2)).flex_none().self_stretch().bg(l.line2), c, ctx).into_any_element()
    } else {
        share(div().h(px(l.w2)).flex_none().bg(l.line2), c, ctx).into_any_element()
    }
}

/// A2UI's Button as the house's keys: a raised key, the primary one the green key that acts, a
/// borderless one a flat key, on a line inset from the cell's edge. What's in it draws as a key's
/// words and glyphs. Pressing it fires its action, through the host to its extension's tool; while
/// its checks fail it's off.
pub fn button(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = ctx.look;
    let look = match ctx.scope.text(c, "variant").as_str() {
        "primary" => Btn::Go,
        "borderless" => Btn::Flat,
        _ => Btn::Key,
    };
    let valid = ctx.scope.problems(c).is_empty() && ctx.scope.prop(c, "isValid").as_bool() != Some(false);
    let inner = ctx.scope.child(c, "child").map(|ch| {
        let mut k = ctx.for_child(&ch, true, false);
        k.in_key = true;
        k.build(&ch, window, cx)
    });
    let action = c.get("action").cloned().unwrap_or(Value::Null);
    let press = ctx.on_press(&action);
    // Base UI's Button: named by what's in it.
    let named = ctx.scope.child(c, "child").map(|ch| crate::widgets::render::words_in(&ctx.for_child(&ch, true, false), &ch.id, 0)).unwrap_or_default();
    let key = kit::press(kit::button(ctx.id(c, "key"), look, valid, &l).role(gpui::Role::Button).aria_label(named), valid, move |_, _, cx| press(cx)).children(inner);
    share(div().flex().h(u(24.)).items_center().px(u(8.)), c, ctx).child(key).into_any_element()
}

/// A2UI's Icon: one of its names as old Switchboard drew it (Phosphor, bold), or its own `svgPath`,
/// in the ink around it. On its own it sits on a line, inset from the cell's edge; inside a key, only
/// the glyph. A name it doesn't know keeps the glyph's room.
pub fn icon(c: &Value, ctx: &Ctx) -> AnyElement {
    let l = ctx.look;
    let name = ctx.scope.prop(c, "name");
    let ink = l.ink;
    let g = match &name {
        Value::String(n) if icons::icon(n).is_some() => glyph(n, ink),
        Value::Object(o) => match o.get("svgPath").and_then(Value::as_str) {
            Some(d) => glyph24(d, ink),
            None => div().size(px(14.)).flex_none().into_any_element(),
        },
        _ => div().size(px(14.)).flex_none().into_any_element(),
    };
    if ctx.in_key {
        return g;
    }
    share(div().flex().h(u(24.)).items_center().px(u(8.)).text_color(ink), c, ctx).child(g).into_any_element()
}

/// A2UI's Image as the house's Picture was: edge to edge, the cell's whole width at the picture's own
/// ratio, nothing without an address A2UI's own would show. A small one at old Switchboard's sizes:
/// an icon 24, an avatar 40 and round, a small feature 100 wide, each inset; a header the whole width
/// and 200 tall. `fit` fits a picture to a fixed size, `cover` when unsaid.
pub fn image(c: &Value, ctx: &Ctx, cx: &mut App) -> AnyElement {
    let Some(url) = safe_url(&ctx.scope.text(c, "url"), cx) else { return nothing() };
    let fit = match ctx.scope.text(c, "fit").as_str() {
        "contain" => ObjectFit::Contain,
        "fill" => ObjectFit::Fill,
        "none" => ObjectFit::None,
        "scaleDown" => ObjectFit::ScaleDown,
        _ => ObjectFit::Cover,
    };
    let variant = ctx.scope.text(c, "variant");
    let picture = WebPictures::get(&url, cx);
    let sized = |d: Div| -> Div {
        match variant.as_str() {
            "icon" => d.mx(u(8.)).size(px(24.)),
            "avatar" => d.mx(u(8.)).size(px(40.)).rounded_full().overflow_hidden(),
            "smallFeature" => d.mx(u(8.)).w(px(100.)),
            "header" => d.h(px(200.)).w_full(),
            _ => d.w_full(),
        }
    };
    let fixed = matches!(variant.as_str(), "icon" | "avatar" | "header");
    let inner = match picture {
        Some(p) => {
            // Not at a set size, it's at the picture's own ratio.
            let ratio = crate::widgets::basic::ratio_of(&p);
            let i = img(p).object_fit(fit).size_full();
            let mut d = sized(div());
            if !fixed {
                d.style().aspect_ratio = ratio;
            }
            d.child(i).into_any_element()
        }
        None => if fixed { sized(div()).into_any_element() } else { div().into_any_element() },
    };
    // Its `alt`, the description, for a screen reader.
    let about = ctx.scope.words(c, "description");
    share(div(), c, ctx).child(div().id(ctx.id(c, "picture")).role(gpui::Role::Image).aria_label(about).child(inner)).into_any_element()
}
