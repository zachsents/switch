//! ⇧⌘/ (the desktop's `ui/shortcuts-sheet.tsx`): every shortcut, a line each, its keys at the end.

use gpui::{App, FontWeight, InteractiveElement, IntoElement, KeyDownEvent, MouseButton, ParentElement, StatefulInteractiveElement, Styled, Window, div, prelude::*, px};

use crate::commands::SHORTCUTS;
use crate::kit;
use crate::look::{Look, u};
use crate::shell::Shell;

pub fn sheet(focus: &gpui::FocusHandle, window: &mut Window, cx: &mut App) -> impl IntoElement {
    let l = Look::get(cx);
    let vh = window.viewport_size().height;
    div()
        .id("shortcuts-backdrop")
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .occlude()
        .on_mouse_down(MouseButton::Left, |_, _, cx| Shell::update(cx, |s| s.shortcuts = false))
        .track_focus(focus)
        // Focus stays in it while it's open.
        .capture_key_down(|e: &KeyDownEvent, _, cx| match e.keystroke.key.as_str() {
            "escape" => {
                cx.stop_propagation();
                Shell::update(cx, |s| s.shortcuts = false);
            }
            "tab" => cx.stop_propagation(),
            _ => {}
        })
        .child(
            kit::sheet(420., window, &l)
                .id("shortcuts")
                .occlude()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(kit::ui(div()).flex().h(u(24.)).items_center().px(u(12.)).font_weight(FontWeight::SEMIBOLD).text_color(l.ink).border_b(px(l.w1)).border_color(l.line1).child("Keyboard Shortcuts"))
                .child(div().id("shortcuts-list").max_h(l.z(520.).min(vh * 0.7)).overflow_y_scroll().children(SHORTCUTS.iter().enumerate().map(|(i, (label, keys))| {
                    kit::ui(div())
                        .flex()
                        .h(u(24.))
                        .items_center()
                        .px(u(12.))
                        .when(i > 0, |d| d.border_t(px(l.w2)).border_color(l.line2))
                        .child(div().min_w_0().flex_1().truncate().child(*label))
                        .child(div().flex_none().text_color(l.ink2).child(*keys))
                }))),
        )
}
