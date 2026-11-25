//! A reading window (the desktop's `ui/reading-page.tsx`, opened as `bun/reading.ts` opens it): one
//! long reply, whole, under the space's name, its words selectable. Esc closes it, as ⌘W does.
//! Each opens a little further down and right of the last, 640 × 720.

use std::rc::Rc;

use gpui::{
    App, AppContext, ClipboardItem, Context, FocusHandle, Focusable, FontWeight, InteractiveElement, IntoElement, MouseButton,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Window, actions, div, prelude::FluentBuilder, px,
};

use crate::look::{Look, SANS, SIGN, u};
use crate::markdown::{self, Ctx, Doc};
use crate::select::Sel;

actions!(reading, [CopyWords]);

pub struct Reading {
    title: String,
    doc: Rc<Doc>,
    sel: Sel,
    focus: FocusHandle,
    scroll: gpui::ScrollHandle,
    /// The pointer's over the words: the thumb shows.
    hovered: bool,
    /// When it last moved (a key, the wheel), and where it was: the thumb shows a moment after.
    moved: Option<std::time::Instant>,
    last_y: gpui::Pixels,
}

/// Says how the platform's reading window draws a reply: this page.
pub fn init(cx: &mut App) {
    crate::platform::windows::register(
        "read",
        |shows, window, cx| {
            let crate::platform::windows::Shows::Read { title, text } = shows.clone();
            let view = cx.new(|cx| Reading { title, doc: Rc::new(Doc::of(&text)), sel: Sel::new(), focus: cx.focus_handle(), scroll: gpui::ScrollHandle::new(), hovered: false, moved: None, last_y: px(0.) });
            let f = view.read(cx).focus.clone();
            window.focus(&f, cx);
            view.into()
        },
        cx,
    );
}

impl Focusable for Reading {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Reading {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = Look::get(cx);
        self.sel.frame();
        // The thumb: under the pointer, and a moment after it moves (a key, the wheel), as a
        // column's.
        let y = self.scroll.offset().y;
        if y != self.last_y {
            self.last_y = y;
            self.moved = Some(std::time::Instant::now());
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(crate::follow::THUMB_STAYS).await;
                this.update(cx, |_, cx| cx.notify()).ok();
            })
            .detach();
        }
        let thumb = self.hovered || self.moved.is_some_and(|m| m.elapsed() < crate::follow::THUMB_STAYS);
        let ctx = Ctx {
            id: "reading".into(),
            order: 0,
            sel: self.sel.clone(),
            on_link: crate::chat::reading_on_link(),
            on_picture: crate::chat::on_picture(),
            cell: false,
            ink: None,
            pictures: Default::default(),
            formulas: Default::default(),
        };
        let words = markdown::render(&self.doc, &ctx, &l, window, cx);
        let sel = self.sel.clone();
        let sel_up = self.sel.clone();
        div()
            .key_context("Reading")
            .track_focus(&self.focus)
            // ⌘A and Edit ▸ Select All take the whole reply; Edit ▸ Copy as ⌘C.
            .on_action(cx.listener(|this, _: &ui_sdk::native::text_field::SelectAll, window, _| {
                this.sel.select_all();
                window.refresh();
            }))
            .on_action(cx.listener(|this, _: &ui_sdk::native::text_field::Copy, _, cx| {
                let t = this.sel.text();
                if !t.is_empty() {
                    cx.write_to_clipboard(ClipboardItem::new_string(t));
                }
            }))
            // The scroll keys: PageUp, PageDown, Home, End, the arrows, Space.
            .on_key_down(cx.listener(|this, e: &gpui::KeyDownEvent, window, cx| {
                if crate::follow::scroll_key(&this.scroll, e) {
                    cx.stop_propagation();
                    window.refresh();
                }
            }))
            .on_action(cx.listener(|this, _: &CopyWords, _, cx| {
                let t = this.sel.text();
                if !t.is_empty() {
                    cx.write_to_clipboard(ClipboardItem::new_string(t));
                }
            }))
            .size_full()
            .flex()
            .flex_col()
            .bg(l.bg)
            .text_color(l.ink)
            .font_family(SANS)
            .child(
                div()
                    .id("reading-band")
                    .flex()
                    .flex_none()
                    .h(u(30.))
                    .items_center()
                    .pl(px(84.))
                    .pr(u(12.))
                    .border_b(px(l.w1))
                    .border_color(l.line1)
                    .on_mouse_down(MouseButton::Left, |e, window, _| {
                        if e.click_count == 2 {
                            window.titlebar_double_click();
                        } else {
                            window.start_window_move();
                        }
                    })
                    .child(div().min_w_0().truncate().font_family(SIGN).font_weight(FontWeight::BOLD).text_size(u(15.)).line_height(u(15.)).pt(u(3.)).child(SharedString::from(self.title.to_uppercase()))),
            )
            .child(
                div()
                .id("reading-column")
                .relative()
                .flex_1()
                .min_h_0()
                .on_hover(cx.listener(|this, h: &bool, _, cx| {
                    this.hovered = *h;
                    cx.notify();
                }))
                .child(
                div()
                    .id("reading-words")
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    // Cleared before the words under the press take it, as a column's is.
                    .capture_any_mouse_down(move |e: &gpui::MouseDownEvent, _, _| {
                        if e.button == MouseButton::Left && !e.modifiers.shift && e.click_count == 1 {
                            sel.clear();
                        }
                    })
                    .child({
                        let (view, by_h) = (self.scroll.clone(), self.scroll.clone());
                        crate::select::drag_anywhere(
                            &sel_up,
                            move || view.bounds(),
                            move |by, window, _| {
                                let max = by_h.max_offset().y;
                                let y = (by_h.offset().y - by).min(px(0.)).max(-max);
                                by_h.set_offset(gpui::point(px(0.), y));
                                window.refresh();
                            },
                            |_, _| {},
                        )
                    })
                    .child(div().w_full().flex().justify_center().child(div().w_full().max_w(u(720.)).px(u(24.)).py(u(24.)).text_size(u(14.)).line_height(u(20.)).child(words))),
                )
                // Its bar, as a chat column's: the overlay thumb, while the pointer's over it.
                .when(thumb, |d| d.child(crate::follow::handle_thumb(&self.scroll, &l))),
            )
    }
}
