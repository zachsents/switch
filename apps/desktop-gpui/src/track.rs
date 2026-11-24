//! UI analytics (the desktop's `ui/use-track.ts`): what the user looked at, how long, and where
//! they went next, as events in the brain's log. Best effort, never a word on screen.

use std::time::Instant;

use gpui::{App, Global};
use serde_json::json;

use crate::nav::{Nav, Page};
use crate::net::Net;

/// Quicker than this, leaving is backing out; longer, a dwell.
const BACKED_OUT_MS: u128 = 2000;

/// The page in view, since when, and the move it came with: the same space at a new line is a new
/// page, so a new view.
struct Last(Option<(Page, Instant)>, u64);
impl Global for Last {}

fn where_of(p: &Page) -> (&'static str, String) {
    match p {
        Page::Space(id) => ("desktop/space", id.clone()),
        Page::Thread(id, _) => ("desktop/thread", id.clone()),
    }
}

fn opened(at: Page, turn: u64, cx: &mut App) {
    if cx.global::<Last>().0.is_some() && cx.global::<Last>().1 == turn {
        return;
    }
    cx.global_mut::<Last>().1 = turn;
    let net = cx.global::<Net>().clone();
    let (surface, item) = where_of(&at);
    if let Some((prev, since)) = cx.global_mut::<Last>().0.take() {
        let (was_surface, was_item) = where_of(&prev);
        let ms = since.elapsed().as_millis();
        let kind = if ms < BACKED_OUT_MS { "ui.backed_out" } else { "ui.dwelled" };
        let _ = net.emit(kind, json!({ "surface": was_surface, "item": was_item, "ms": ms as u64 }), None);
        if was_surface == surface && was_item != item {
            let _ = net.emit("ui.switched", json!({ "surface": surface, "from": was_item, "to": item }), None);
        }
    }
    let _ = net.emit("ui.viewed", json!({ "surface": surface, "item": item }), None);
    cx.global_mut::<Last>().0 = Some((at, Instant::now()));
}

pub fn init(cx: &mut App) {
    cx.set_global(Last(None, 0));
    let nav = Nav::entity(cx);
    let (page, turn) = (nav.read(cx).page.clone(), nav.read(cx).turn);
    opened(page, turn, cx);
    cx.observe(&nav, |nav, cx| {
        let (page, turn) = (nav.read(cx).page.clone(), nav.read(cx).turn);
        opened(page, turn, cx);
    })
    .detach();
}
