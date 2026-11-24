//! A2UI's basic catalog (v1.0), drawn in Switch's look (the desktop's `widgets/basic/`): each part
//! its properties A2UI's own, laid as the house lays a widget's cell: a part on a line of its own,
//! its words inset from the cell's edges; no gaps, padding or boxes of a layout's own. What's
//! shared by the parts here and the house's (`house/`) is here too: a property's words, a part's
//! share of its row (`weight`), what its checks find wrong, a control's held value, the figures at
//! a line's end, a glyph, and a clock that ticks while something runs.

#[cfg(feature = "shot")]
pub mod gallery;
pub mod controls;
pub mod icons;
pub mod layout;
pub mod playback;
pub mod text;

use std::time::Duration;

use gpui::{AnyElement, App, Div, Entity, Hsla, InteractiveElement, IntoElement, ParentElement, Pixels, SharedString, StatefulInteractiveElement, Styled, Window, div, px, relative, svg};
use serde_json::Value;

use crate::look::{Look, u};
use crate::widgets::render::Ctx;

/// A part of the basic catalog drawn, or none when it isn't one of its parts.
pub fn draw(name: &str, c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    Some(match name {
        "Text" => text::text(c, ctx, window, cx),
        "Image" => layout::image(c, ctx, cx),
        "Icon" => layout::icon(c, ctx),
        "Video" => playback::video(c, ctx, window, cx),
        "AudioPlayer" => playback::audio(c, ctx, window, cx),
        "Row" => layout::row(c, ctx, window, cx),
        "Column" => layout::column(c, ctx, window, cx),
        "List" => layout::list(c, ctx, window, cx),
        "Card" => layout::card(c, ctx, window, cx),
        "Tabs" => layout::tabs(c, ctx, window, cx),
        "Modal" => layout::modal(c, ctx, window, cx),
        "Divider" => layout::divider(c, ctx),
        "Button" => layout::button(c, ctx, window, cx),
        "TextField" => controls::text_field(c, ctx, window, cx),
        "CheckBox" => controls::check_box(c, ctx, window, cx),
        "ChoicePicker" => controls::choice_picker(c, ctx, window, cx),
        "Slider" => controls::slider(c, ctx, window, cx),
        "DateTimeInput" => controls::date_time(c, ctx, window, cx),
        _ => return None,
    })
}

/// A part's share of its Row's or Column's room, from its `weight` (`flex: weight`).
pub fn share(d: Div, c: &Value, ctx: &Ctx) -> Div {
    match ctx.scope.number(c, "weight") {
        Some(w) => {
            let mut d = d;
            d.style().flex_grow = Some(w as f32);
            d.style().flex_shrink = Some(1.);
            d.style().flex_basis = Some(relative(0.).into());
            d.min_w_0()
        }
        None => d,
    }
}

/// A line-2 under a part (`line-2-b`).
pub fn line2_b(d: Div, l: &Look) -> Div {
    d.border_b(px(l.w2)).border_color(l.line2)
}

/// What a part's checks found wrong, each under it as the house says what's wrong: small, in red.
pub fn problems(c: &Value, ctx: &Ctx) -> Vec<AnyElement> {
    let l = ctx.look;
    ctx.scope
        .problems(c)
        .into_iter()
        .enumerate()
        .map(|(i, e)| {
            // `role="alert"`: a screen reader says it as it comes.
            div()
                .id(ctx.id(c, &format!("problem:{i}")))
                .role(gpui::Role::Alert)
                .aria_label(e.clone())
                .px(u(8.))
                .pb(u(4.))
                .text_size(u(12.))
                .line_height(u(16.))
                .text_color(l.red)
                .child(e)
                .into_any_element()
        })
        .collect()
}

/// Figures at a line's end (`parts.tsx` Data): caption size, supporting ink, after the words.
pub fn data(words: impl Into<SharedString>, l: &Look) -> Div {
    div().ml_auto().flex_none().pl(u(12.)).text_size(u(11.)).line_height(u(14.)).text_color(l.ink2).whitespace_nowrap().child(words.into())
}

/// A glyph, 14 px as the house's marks are, in `color`: one of A2UI's icons (Phosphor's 256 box).
pub fn glyph(name: &str, color: Hsla) -> AnyElement {
    svg().path(format!("icon/{name}.svg")).flex_none().size(px(14.)).text_color(color).into_any_element()
}

/// A glyph from a part's own `svgPath`, on A2UI's 24 box.
pub fn glyph24(d: &str, color: Hsla) -> AnyElement {
    let hex: String = d.bytes().map(|b| format!("{b:02x}")).collect();
    svg().path(format!("path24/{hex}.svg")).flex_none().size(px(14.)).text_color(color).into_any_element()
}

/// One of the house's marks, by name (`marks/<name>.svg`).
pub fn mark(name: &str, size: Pixels, color: Hsla) -> gpui::Svg {
    svg().path(format!("marks/{name}.svg")).flex_none().size(size).text_color(color)
}

/// Didn't go as expected: a red triangle, with its "!" when it's over 10 px.
pub use crate::marks::warn;

/// A check mark, the select's (`kit/select.tsx` Check): 12 px.
pub fn check_mark(color: Hsla) -> gpui::Svg {
    mark("check", px(12.), color)
}

/// A control's value: what the surface's data model holds, written back as it's changed (A2UI's
/// two-way binding). One bound to nothing keeps what was last chosen in it; whatever the model
/// holds next shows at once (`held.ts`).
pub struct Held {
    was: Value,
    now: Value,
}

pub fn held(c: &Value, ctx: &Ctx, key: &str, value: Value, window: &mut Window, cx: &mut App) -> (Value, impl Fn(Value, &mut App) + Clone + 'static) {
    let start = value.clone();
    let state: Entity<Held> = ctx.state(c, &format!("held:{key}"), window, cx, move |_, _| Held { was: start.clone(), now: start });
    let shown = {
        let h = state.read(cx);
        if h.was == value { h.now.clone() } else { value.clone() }
    };
    let writer = ctx.writer(c, key).map(std::rc::Rc::new);
    let set = move |next: Value, cx: &mut App| {
        let was = value.clone();
        state.update(cx, |h, cx| {
            h.was = was;
            h.now = next.clone();
            cx.notify();
        });
        if let Some(w) = &writer {
            w(next, cx);
        }
    };
    (shown, set)
}

/// A clock that ticks every `ms` while a part is drawn with it (`use-now.ts`): the view drawing the
/// surface draws again on each tick.
pub struct Tick;

pub fn tick(c: &Value, ctx: &Ctx, ms: u64, window: &mut Window, cx: &mut App) {
    ctx.state(c, &format!("tick:{ms}"), window, cx, move |_, cx| {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(ms)).await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        })
        .detach();
        Tick
    });
}

/// A span as a clock (`time.ts` spanOf): to the second, "4:05" or "1:04:05"; to the minute, "1:04".
pub fn span_of(ms: f64, minute: bool) -> String {
    let ms = ms.max(0.).trunc();
    if minute {
        let mins = (ms / 60_000.).round() as u64;
        return format!("{}:{:02}", mins / 60, mins % 60);
    }
    let s = (ms / 1000.) as u64;
    let (h, m, s) = (s / 3600, (s / 60) % 60, s % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

/// A picture's width over its height, read from its header.
pub fn ratio_of(picture: &gpui::Image) -> Option<f32> {
    let (w, h) = image::ImageReader::new(std::io::Cursor::new(&picture.bytes)).with_guessed_format().ok()?.into_dimensions().ok()?;
    (w > 0 && h > 0).then(|| w as f32 / h as f32)
}

/// A part that draws nothing.
pub fn nothing() -> AnyElement {
    div().into_any_element()
}
