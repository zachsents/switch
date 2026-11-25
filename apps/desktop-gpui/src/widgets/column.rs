//! A space's widgets, right of its chat (the desktop's `widget-column.tsx`, `widget-cell.tsx`, and
//! index.css's widget rules): those placed in it that their extension offers, in their order, each
//! the column's width and its own height, a section line between two shown. The column scrolls as
//! a whole; nothing in it scrolls inside itself. A widget whose surface draws only headings and
//! captions (an empty state's words, which never paint here) is out of the column until it has
//! something; with nothing in it to show, the column is out of the page. Two live pictures one under
//! the other have the page between them.

use gpui::{AnyElement, Context, IntoElement, ParentElement, Render, Styled, Window, div, px};

use crate::look::Look;
use crate::model::model;
use crate::widgets::host::{Host, Source};
use crate::widgets::media::WebPictures;
use crate::widgets::render::{self, Ctx};

pub struct WidgetColumn {
    space: String,
}

impl WidgetColumn {
    pub fn new(space: String, cx: &mut Context<Self>) -> Self {
        cx.observe(&Host::entity(cx), |_, _, cx| cx.notify()).detach();
        cx.observe(&model(cx), |_, _, cx| cx.notify()).detach();
        let pictures = WebPictures::entity(cx);
        cx.observe(&pictures, |_, _, cx| cx.notify()).detach();
        WidgetColumn { space }
    }

    /// The widgets placed in it that their extension offers, in their order.
    fn placed(&self, cx: &gpui::App) -> Vec<crate::items::Placed> {
        let host = Host::entity(cx).read(cx);
        model(cx).read(cx).brain.placed.iter().filter(|w| w.space == self.space && host.offered.contains_key(&w.widget())).cloned().collect()
    }
}

impl Render for WidgetColumn {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if f32::from(window.viewport_size().width) < crate::app::WIDE {
            return div().into_any_element();
        }
        let l = Look::get(cx);
        let host = Host::entity(cx);
        // Each cell is drawn, shown or not (widget-cell.tsx: one with nothing to show is hidden, still
        // there, so a live picture keeps asking for frames until it has one).
        let mut cells: Vec<AnyElement> = vec![];
        let mut hidden: Vec<AnyElement> = vec![];
        let mut shown = 0;
        let mut feed_before = false;
        for w in self.placed(cx) {
            let key = w.key();
            host.update(cx, |h, cx| h.want(&key, Source::placed(&w), cx));
            let Some(surface) = host.read(cx).surface(&key) else {
                // One still loading isn't an empty one: it holds the column's room, drawing nothing.
                cells.push(div().w_full().when(shown > 0, |d| d.border_t(px(l.w_section)).border_color(l.line_section)).when(shown > 0 && feed_before, |d| d.pt(px(16.))).into_any_element());
                shown += 1;
                continue;
            };
            let mut ctx = Ctx::new(&key, surface, l);
            ctx.in_column = true;
            // Each widget fails alone.
            let drawn = crate::boundary::guard_in(format!("widget:{key}"), window, cx, |window, cx| render::surface(&ctx, window, cx));
            if render::nothing(&ctx, window, cx) {
                hidden.push(drawn);
                continue;
            }
            let feed = render::has_feed(&ctx, "root", 0);
            cells.push(
                div()
                    .w_full()
                    .when(shown > 0, |d| d.border_t(px(l.w_section)).border_color(l.line_section))
                    .when(shown > 0 && feed_before, |d| d.pt(px(16.)))
                    .child(drawn)
                    .into_any_element(),
            );
            shown += 1;
            feed_before |= feed;
        }
        let out_of_view = div().absolute().size_0().overflow_hidden().children(hidden);
        if shown == 0 {
            // With nothing in it to show, the column is out of the page.
            return out_of_view.into_any_element();
        }
        div()
            .relative()
            .flex()
            .flex_col()
            .flex_none()
            .w(window.viewport_size().width * 0.27)
            .h_full()
            .border_l(px(l.w1))
            .border_color(l.line1)
            .child(out_of_view)
            .child(crate::kit::pane_scroll(gpui::ElementId::Name(format!("widgets-{}", self.space).into()), Some("Widgets"), div().flex().flex_col().children(cells), window, cx))
            .into_any_element()
    }
}

use gpui::prelude::FluentBuilder;
