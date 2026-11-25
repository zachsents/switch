//! ⇧⌘/ (the desktop's `ui/shortcuts-sheet.tsx`): every shortcut by its group, a line each, its keys
//! at the end, in two columns.

use gpui::{App, FontWeight, InteractiveElement, IntoElement, KeyDownEvent, MouseButton, ParentElement, StatefulInteractiveElement, Styled, Window, div, prelude::*, px};

use crate::commands::sheet_lines;
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
            kit::sheet(640., window, &l)
                .id("shortcuts")
                .occlude()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(kit::ui(div()).flex().h(u(24.)).items_center().px(u(12.)).font_weight(FontWeight::SEMIBOLD).text_color(l.ink).border_b(px(l.w1)).border_color(l.line1).child("Keyboard Shortcuts"))
                .child(
                    div()
                        .id("shortcuts-list")
                        .max_h(l.z(620.).min(vh * 0.8))
                        .overflow_y_scroll()
                        .child(div().flex().children(columns().into_iter().enumerate().map(|(i, groups)| {
                            div().flex_1().min_w_0().flex().flex_col().when(i > 0, |d| d.border_l(px(l.w1)).border_color(l.line1)).children(groups.into_iter().enumerate().map(|(g, (name, lines))| {
                                div()
                                    .flex()
                                    .flex_col()
                                    .when(g > 0, |d| d.border_t(px(l.w1)).border_color(l.line1))
                                    .child(kit::small(div()).flex().h(u(24.)).items_center().px(u(12.)).font_weight(FontWeight::SEMIBOLD).text_color(l.ink2).child(name))
                                    .children(lines.into_iter().map(|(label, keys)| {
                                        kit::ui(div())
                                            .flex()
                                            .h(u(24.))
                                            .items_center()
                                            .gap(u(12.))
                                            .px(u(12.))
                                            .border_t(px(l.w2))
                                            .border_color(l.line2)
                                            .child(div().min_w_0().flex_1().truncate().child(label))
                                            .child(div().flex_none().text_color(l.ink2).child(keys))
                                    }))
                            }))
                        }))),
                ),
        )
}

type Groups = Vec<(&'static str, Vec<(&'static str, String)>)>;

/// The groups in two columns, as even as whole groups make them.
fn columns() -> [Groups; 2] {
    let groups = sheet_lines();
    let rows = |g: &(&str, Vec<(&str, String)>)| g.1.len() + 1;
    let total: usize = groups.iter().map(rows).sum();
    let mut left: Groups = vec![];
    let mut right: Groups = vec![];
    let mut so_far = 0;
    for g in groups {
        if so_far < total / 2 {
            so_far += rows(&g);
            left.push(g);
        } else {
            right.push(g);
        }
    }
    [left, right]
}
