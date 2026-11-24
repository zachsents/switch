//! A round box that ticks something off, like an item in a list.

use gpui::{
    Action, App, ElementId, IntoElement, ParentElement, RenderOnce, SharedString, Styled, Window,
    div, prelude::*, px,
};

use crate::{
    ActiveTheme, Icon,
    button::pressed_by_key,
    icon,
    keys::shortcut_keys,
    overlay::{Tip, revealing, tip},
};

/// A tick box: an empty circle, or a ticked one when `done`. Clicking it dispatches `action`.
/// Hovering shows `label` with the shortcut of `shortcut`, the same command for the selection,
/// since a box in every row of a list can't have a shortcut of its own. The selected row's box
/// shows pressed when that shortcut is used.
#[derive(IntoElement)]
pub struct Tick {
    id: ElementId,
    done: bool,
    selected: bool,
    label: SharedString,
    action: Box<dyn Action>,
    shortcut: Box<dyn Action>,
}

impl Tick {
    pub fn new(
        id: impl Into<ElementId>,
        done: bool,
        label: impl Into<SharedString>,
        action: impl Action,
        shortcut: impl Action,
    ) -> Self {
        Self {
            id: id.into(),
            done,
            selected: false,
            label: label.into(),
            action: action.boxed_clone(),
            shortcut: shortcut.boxed_clone(),
        }
    }

    /// Marks the box as the selected row's, which its shortcut acts on.
    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }
}

impl RenderOnce for Tick {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let hovered = window.use_keyed_state(self.id.clone(), cx, |_, _| false);
        let keys = shortcut_keys(window, self.shortcut.as_ref());
        let pressed = self.selected && pressed_by_key(self.shortcut.as_ref(), cx);
        let shown_tip = (*hovered.read(cx) && !revealing(window, cx)).then(|| Tip::Tooltip {
            label: self.label.clone(),
            keys,
        });
        let action = self.action;
        let ink = if self.done || pressed {
            theme.text
        } else {
            theme.text_muted
        };
        let mark = icon(if self.done {
            Icon::CheckCircle
        } else {
            Icon::Circle
        });
        div()
            .id(self.id)
            .group("tick")
            .relative()
            .size(px(28.))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .cursor_pointer()
            .child(
                mark.text_color(ink)
                    .group_hover("tick", |style| style.text_color(theme.text)),
            )
            .on_hover(move |&now, _, cx| {
                hovered.update(cx, |hovered, cx| {
                    *hovered = now;
                    cx.notify();
                })
            })
            .on_click(move |_, window, cx| {
                cx.stop_propagation();
                window.dispatch_action(action.boxed_clone(), cx)
            })
            .children(shown_tip.map(tip))
    }
}
