//! An ask in its space's chat, where it was raised (the desktop's `ask-in-chat.tsx`,
//! `chat-asks.ts`): each by when it was raised, before the first line said after it; one raised
//! before the history held so far sits at its top, one raised after the last line at its end. Open,
//! its card the whole column's width with rules above and below (its Reply attaches it to the
//! space's box); closed, how it ended as a mark by its title, and under them what came of it. A
//! click opens it as it was decided, in a window of its own.

use gpui::{AnyElement, App, Entity, FontWeight, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement, Styled, div, prelude::*, px};

use crate::asks::card::AskCard;
use crate::items::{ActionItem, detail_of, ending_of};
use crate::look::{Look, u};
use crate::marks;

/// Where each entry goes: a line (its index), or an ask (open or not).
pub enum Slot {
    Line(usize),
    Ask(ActionItem, bool),
}

/// The chat's lines (their times, when said) with its asks in them, each where it was raised.
pub fn with_asks(times: &[Option<f64>], open: Vec<ActionItem>, closed: Vec<ActionItem>) -> Vec<Slot> {
    let mut asks: Vec<(ActionItem, bool)> = open.into_iter().map(|i| (i, true)).chain(closed.into_iter().map(|i| (i, false))).collect();
    asks.sort_by(|a, b| a.0.at.total_cmp(&b.0.at));
    let mut out = Vec::with_capacity(times.len() + asks.len());
    let mut next = 0;
    for (i, time) in times.iter().enumerate() {
        // An ask's `at` is when it was raised: it goes before the first line said after it.
        while next < asks.len() && time.is_some_and(|t| asks[next].0.at < t) {
            let (item, open) = asks[next].clone();
            out.push(Slot::Ask(item, open));
            next += 1;
        }
        out.push(Slot::Line(i));
    }
    // Those raised after the last line said, or with no history yet.
    for (item, open) in asks.into_iter().skip(next) {
        out.push(Slot::Ask(item, open));
    }
    out
}

/// An open ask's card in the chat: the whole column's width, a section line above and below.
pub fn open(card: Entity<AskCard>, l: &Look) -> AnyElement {
    div()
        .mx(px(-8.))
        .border_t(px(l.w_section))
        .border_b(px(l.w_section))
        .border_color(l.line_section)
        .child(div().px(px(8.)).child(card))
        .into_any_element()
}

/// A closed ask: how it ended and its title, what came of it under them; a click opens its window.
pub fn closed(item: &ActionItem, l: &Look, _cx: &mut App) -> AnyElement {
    let detail = detail_of(item);
    let id = item.id.clone();
    // A key: Tab reaches it, Space and Enter open it.
    crate::kit::focusable(div().id(gpui::ElementId::Name(format!("ask-closed-{}", item.id).into())), l)
        .role(gpui::Role::Button)
        .aria_label(match &detail {
            Some(d) => format!("{} {}{}", item.title, d.who.as_ref().map(|w| format!("{w} ")).unwrap_or_default(), d.words),
            None => item.title.clone(),
        })
        .mx(px(-6.))
        .self_start()
        .flex()
        .flex_col()
        .gap(u(4.))
        .max_w_full()
        .min_w_0()
        .rounded(u(4.))
        .px(px(6.))
        .py(u(4.))
        .hover(|s| s.bg(l.hover))
        .on_click(move |_, _, cx| crate::asks::window::open(&id, cx))
        .child(
            div()
                .flex()
                .min_w_0()
                .items_center()
                .gap(u(8.))
                .text_size(u(13.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(l.ink2)
                .child(marks::ending(ending_of(item), px(14.), l))
                .child(div().min_w_0().truncate().child(item.title.clone())),
        )
        .when_some(detail, |d, detail| {
            d.child(
                div()
                    .pl(px(22.))
                    .text_size(u(13.))
                    .line_height(u(16.))
                    .text_color(l.ink2)
                    .line_clamp(2)
                    .child(
                        gpui::StyledText::new(match &detail.who {
                            Some(w) => format!("{w} {}", detail.words),
                            None => detail.words.clone(),
                        })
                        .with_highlights(detail.who.as_ref().map(|w| {
                            (0..w.len(), gpui::HighlightStyle { color: Some(l.ink), font_weight: Some(FontWeight::MEDIUM), ..Default::default() })
                        })),
                    ),
            )
        })
        .into_any_element()
}
