//! Switch's own A2UI catalog (the desktop's `widgets/catalog.tsx`): the house components, drawn as
//! DESIGN.md says, beside A2UI's basic catalog. Its charts are `charts/`.

pub mod document;
pub mod feed;
pub mod gallery;
pub mod lines;
pub mod pick;
pub mod playing;
pub mod row;

use gpui::{AnyElement, App, Window};
use serde_json::Value;

use crate::widgets::render::Ctx;

/// A part of this catalog drawn, or none when it isn't one of its parts.
pub fn draw(name: &str, c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    Some(match name {
        "Line" => lines::line(c, ctx, window, cx),
        "Row" => row::row(c, ctx, window, cx),
        "Pick" => pick::pick(c, ctx, window, cx),
        "Slot" => lines::slot(c, ctx, window, cx),
        "Field" => lines::field(c, ctx),
        "Feed" => feed::feed(c, ctx, window, cx),
        "Gallery" => gallery::gallery(c, ctx, window, cx),
        "Title" => lines::title(c, ctx),
        "Check" => lines::check(c, ctx, window, cx),
        "Entry" => lines::entry(c, ctx, window, cx),
        "Playing" => playing::playing(c, ctx, window, cx),
        "Document" => document::document(c, ctx, window, cx),
        _ => return None,
    })
}

/// A value as an object, else empty.
pub fn record(v: &Value) -> serde_json::Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

/// The running mark at the beat's step; the surface draws again eight times a second while it runs.
pub fn runner(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    use gpui::{IntoElement, px};
    crate::widgets::basic::tick(c, ctx, 125, window, cx);
    crate::marks::runner_mark(px(14.), crate::nav::Beat::step(cx), ctx.look.orange).into_any_element()
}
