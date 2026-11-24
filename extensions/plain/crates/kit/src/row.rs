//! A line in a list that can be selected.

use gpui::{App, Div, ElementId, Stateful, div, prelude::*, px};

use crate::ActiveTheme;

/// A clickable 28px row for lists. Selected, it has the selection fill. Otherwise hovering
/// shows a fainter one, so a selected row never looks merely hovered.
pub fn row(id: impl Into<ElementId>, selected: bool, cx: &App) -> Stateful<Div> {
    let theme = cx.theme();
    div()
        .id(id)
        .w_full()
        .h(px(28.))
        .px(px(8.))
        .flex()
        .items_center()
        .gap(px(8.))
        .rounded(px(6.))
        .cursor_pointer()
        .map(|this| {
            if selected {
                this.bg(theme.selection)
            } else {
                this.hover(|style| style.bg(theme.surface))
            }
        })
}
