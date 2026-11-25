//! The house's Gallery (the desktop's `widgets/pictures.tsx`, and `ui/picture-row.tsx` in its cell
//! look): several pictures as one row that scrolls sideways, edge to edge in the cell, each 160 tall
//! and its own width (at most 420), a hairline between them; a click opens the row's pictures
//! full screen at that one (`viewer.rs`). When the row holds more than it shows, its count shows under it. A
//! picture without an address A2UI's Image would show (http, https or data) is left out.

use std::rc::Rc;

use gpui::{AnyElement, App, InteractiveElement, IntoElement, ObjectFit, ParentElement, ScrollHandle, StatefulInteractiveElement, Styled, StyledImage, Window, div, img, prelude::*, px};
use serde_json::Value;

use crate::look::u;
use crate::widgets::media::{WebPictures, safe_url};
use crate::widgets::render::Ctx;

/// The file a picture opens as: its description, else its address's last part.
fn name_of(url: &str, description: Option<&str>) -> String {
    if let Some(d) = description.filter(|d| !d.is_empty()) {
        return d.to_string();
    }
    if let Some(rest) = url.strip_prefix("data:") {
        let from = rest.find('/').map_or(0, |i| i + 1);
        let to = rest.find([';', ',']).unwrap_or(rest.len());
        return format!("picture.{}", rest.get(from..to).unwrap_or_default());
    }
    let last = url::Url::parse(url).ok().and_then(|u| u.path().rsplit('/').next().map(str::to_string)).unwrap_or_default();
    let name = percent_encoding::percent_decode_str(&last).decode_utf8_lossy().to_string();
    if name.is_empty() { "picture".into() } else { name }
}

/// The pictures it shows: those with an address A2UI's Image would show, and the names they open as.
pub fn pictures(c: &Value, ctx: &Ctx, cx: &App) -> Vec<(String, String)> {
    ctx
        .scope
        .prop(c, "images")
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|i| {
            let raw = i.get("url")?.as_str()?;
            // `{ url, description? }`: a description that isn't words isn't a picture.
            let description = match i.get("description") {
                None => None,
                Some(Value::String(d)) => Some(d.as_str()),
                Some(_) => return None,
            };
            let url = safe_url(raw, cx)?;
            let name = name_of(&url, description);
            Some((url, name))
        })
        .collect()
}

pub fn gallery(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = ctx.look;
    let pictures = pictures(c, ctx, cx);
    if pictures.is_empty() {
        return div().into_any_element();
    }
    let scroll = ctx.state(c, "scroll", window, cx, |_, _| ScrollHandle::new()).read(cx).clone();
    let over = scroll.max_offset().x > px(0.);
    let all = Rc::new(pictures.clone());
    let tiles: Vec<AnyElement> = pictures
        .iter()
        .enumerate()
        .map(|(i, (url, name))| {
            let all = all.clone();
            let picture = WebPictures::get(url, cx);
            // Base UI's Button: Tab, Space and Enter, named as the file it opens as, ringed in focus.
            div()
                .id(ctx.id(c, &format!("picture:{i}")))
                .role(gpui::Role::Button)
                .aria_label(name.clone())
                .tab_index(0)
                .focus_visible(move |s| s.shadow(vec![gpui::BoxShadow { color: l.ink, offset: gpui::point(px(0.), px(0.)), blur_radius: px(0.), spread_radius: px(2.), inset: true }]))
                .flex_none()
                .h(px(160.))
                .overflow_hidden()
                .when(i > 0, |d| d.border_l(px(l.w1)).border_color(l.line1))
                // Full screen on the pictures from this one (`viewer.rs`), as Quick Look was; a
                // right-click is the file's menu (pictures.tsx, picture-row.tsx).
                .on_click(move |_, window, cx| {
                    let items = all.iter().map(|(url, name)| crate::viewer::Item { route: url.clone(), name: name.clone(), kind: "image/*".into(), blob: None }).collect();
                    crate::viewer::open(items, i, window, cx);
                })
                .on_mouse_down(gpui::MouseButton::Right, {
                    let (u, n) = (url.clone(), name.clone());
                    move |_, window, cx| crate::chat_platform::file(&u, &n, crate::platform::files::Do::Menu, window, cx).detach()
                })
                .map(|d| match picture {
                    Some(p) => d.child(img(p).h(px(160.)).max_w(px(420.)).object_fit(ObjectFit::Cover)),
                    None => d.w(px(160.)),
                })
                .into_any_element()
        })
        .collect();
    let count = pictures.len();
    div()
        .flex()
        .flex_col()
        .gap(u(4.))
        .w_full()
        .child(div().id(ctx.id(c, "row")).w_full().overflow_x_scroll().track_scroll(&scroll).on_scroll(crate::app::sideways(Some(scroll.clone()))).child(div().flex().children(tiles)))
        .when(over, |d| {
            d.child(div().px(u(8.)).pb(u(6.)).text_size(u(11.)).line_height(u(14.)).text_color(l.ink3).child(format!("{count} picture{}", if count == 1 { "" } else { "s" })))
        })
        .into_any_element()
}
