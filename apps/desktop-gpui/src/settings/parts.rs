//! A list's parts as the desktop's `ui/parts.tsx` has them: its heading (a name, a count at its
//! end), its rows a line each, a row's figures; and the line a failed act says (`action-error.tsx`).

use gpui::{AnyElement, Div, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px};

use crate::kit;
use crate::look::{Look, u};
use crate::mutations::safe_error;

/// A list's heading: its name, and a count at its end when there's one.
pub fn head(label: impl Into<SharedString>, count: Option<usize>, l: &Look) -> Div {
    let label: SharedString = label.into();
    kit::ui(div())
        .flex()
        .h(u(24.))
        .flex_none()
        .items_center()
        .gap(u(8.))
        .px(u(8.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(l.ink)
        .child(div().min_w_0().truncate().child(label))
        .when_some(count.filter(|n| *n > 0), |d, n| d.child(kit::caption(div()).ml_auto().font_weight(FontWeight::NORMAL).text_color(l.ink3).child(n.to_string())))
}

/// A list: a heading, then its rows, one a line.
pub fn section(label: impl Into<SharedString>, count: Option<usize>, rows: impl IntoIterator<Item = AnyElement>, l: &Look) -> AnyElement {
    div().flex().flex_col().child(head(label, count, l)).child(div().flex().flex_col().children(rows)).into_any_element()
}

/// A row of a list: a line high, its words inset.
pub fn line(l: &Look) -> Div {
    kit::ui(div()).flex().h(u(24.)).items_center().gap(u(10.)).px(u(8.)).text_color(l.ink)
}

/// Figures at a row's end; `w`, a column's width, so figures line up.
pub fn data(text: impl Into<SharedString>, w: Option<f32>, l: &Look) -> Div {
    let text: SharedString = text.into();
    kit::caption(div())
        .ml_auto()
        .flex_none()
        .pl(u(12.))
        .flex()
        .justify_end()
        .whitespace_nowrap()
        .text_color(l.ink2)
        .when_some(w, |d, w| d.w(u(w)))
        .child(text)
}

/// What went wrong with the section's acts, on its own line over the lists.
pub fn notice(text: impl Into<SharedString>, l: &Look) -> Div {
    let text: SharedString = text.into();
    kit::small(div()).flex().h(u(24.)).items_center().px(u(8.)).text_color(l.ink).border_b(px(l.w2)).border_color(l.line2).child(text)
}

/// A failed act's words, safe to show, in red on a line of their own (`action-error.tsx`): an
/// alert, which VoiceOver reaches and reads.
pub fn action_error(message: &str, l: &Look) -> AnyElement {
    let text = safe_error(message);
    kit::small(div()).id(gpui::ElementId::Name(format!("alert-{text}").into())).role(gpui::Role::Alert).aria_label(text.clone()).w_full().text_color(l.red).child(text).into_any_element()
}

/// Didn't go as expected.
pub fn warn(l: &Look) -> impl IntoElement {
    crate::marks::warn(l.z(14.), l)
}
