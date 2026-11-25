//! ⌘F (the desktop's `ui/find-bar.tsx` and `use-find-in.ts`): the bar on a chat's top, its words,
//! which match of how many, Enter and ⇧Enter between them, Esc to close. The brain finds the
//! matching lines in the whole history; which is current counts from the latest, and the chat
//! brings it into view and rings it (`target`).

use std::time::Duration;

use gpui::{
    App, AppContext, Context, Entity, InteractiveElement, IntoElement, KeyDownEvent, ParentElement, Render, Styled, Task, Window,
    div, prelude::*, px,
};
use serde_json::{Value, json};
use ui_sdk::components::input::{Input, InputOptions, TextFieldStyle};

use crate::json::{list, n};
use crate::kit;
use crate::look::{Look, u};
use crate::nav::Nav;
use crate::net::Net;
use crate::shell::Shell;

pub struct FindBar {
    space: String,
    input: Entity<Input>,
    /// The words the brain was last asked about, and the seqs it found, oldest first.
    settled: String,
    seqs: Vec<u64>,
    fetching: bool,
    asking: Task<()>,
    /// Which match is current, counting back from the latest; kept with the words it was for.
    at: usize,
    focused: u64,
}

/// The chat line to bring into view and ring in a space's chat: ⌘F's current match while its bar
/// is open there, else the line the window was opened at.
pub fn target(space: &str, cx: &App) -> Option<u64> {
    let s = Shell::entity(cx).read(cx);
    if s.searching_in.as_deref() == Some(space) {
        return s.find_seq;
    }
    let nav = Nav::entity(cx).read(cx);
    if nav.page.space() == space { nav.at } else { None }
}

/// The target with the move it came with: the same line opened again (Back to it) is brought into
/// view again.
pub fn target_turn(space: &str, cx: &App) -> Option<(u64, u64)> {
    let t = target(space, cx)?;
    let s = Shell::entity(cx).read(cx);
    let turn = if s.searching_in.as_deref() == Some(space) { 0 } else { Nav::entity(cx).read(cx).turn };
    Some((t, turn))
}

impl FindBar {
    pub fn new(space: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let l = Look::get(cx);
        let weak = cx.entity().downgrade();
        let input = cx.new(|cx| {
            Input::new(
                InputOptions::default()
                    .placeholder("Find")
                    .field_style(TextFieldStyle { text_color: Some(l.ink), placeholder_color: Some(l.ink3), caret_color: Some(l.ink), ..Default::default() })
                    .on_value_change(move |_, _, _, cx| {
                        weak.update(cx, |this, cx| this.typed(cx)).ok();
                    }),
                window,
                cx,
            )
        });
        cx.observe(&Shell::entity(cx), |_, _, cx| cx.notify()).detach();
        FindBar { space, input, settled: String::new(), seqs: vec![], fetching: false, asking: Task::ready(()), at: 0, focused: u64::MAX }
    }

    fn query(&self, cx: &App) -> String {
        self.input.read(cx).get_value().trim().to_string()
    }

    fn typed(&mut self, cx: &mut Context<Self>) {
        let q = self.query(cx);
        if q.is_empty() {
            self.settled.clear();
            self.seqs.clear();
            self.fetching = false;
            self.asking = Task::ready(());
            self.publish(cx);
            return;
        }
        let space = self.space.clone();
        self.fetching = true;
        self.asking = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(120)).await;
            let Ok(answer) = this.update(cx, |_, cx| cx.global::<Net>().page("find", json!({ "query": q, "space": space }))) else { return };
            let got = answer.await;
            this.update(cx, |this, cx| {
                // New words start again at the latest.
                if this.settled != q {
                    this.at = 0;
                }
                this.settled = q;
                this.seqs = match got {
                    Ok(Ok(v)) => seqs_of(&v),
                    _ => vec![],
                };
                // Fewer matches than the one it was at: the latest.
                if this.at >= this.seqs.len() {
                    this.at = 0;
                }
                this.fetching = false;
                this.publish(cx);
            })
            .ok();
        });
        cx.notify();
    }

    /// One back in time (1) or forward (-1), wrapping.
    fn step(&mut self, by: isize, cx: &mut Context<Self>) {
        let n = self.seqs.len() as isize;
        if n > 0 {
            self.at = ((self.at as isize + by + n) % n) as usize;
            self.publish(cx);
        }
    }

    fn current(&self) -> Option<u64> {
        if self.seqs.is_empty() { None } else { self.seqs.get(self.seqs.len() - 1 - self.at.min(self.seqs.len() - 1)).copied() }
    }

    fn publish(&mut self, cx: &mut Context<Self>) {
        let seq = self.current();
        Shell::update(cx, |s| s.find_seq = seq);
        cx.notify();
    }
}

fn seqs_of(v: &Value) -> Vec<u64> {
    list(v).iter().map(|x| n(x).max(0.) as u64).collect()
}

impl Render for FindBar {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = Look::get(cx);
        let ask = Shell::entity(cx).read(cx).find_focus;
        if self.focused != ask {
            // Opened, or ⌘F again: the cursor in it, its words selected.
            self.focused = ask;
            // Opened again with its words: back to its match.
            let seq = self.current();
            if Shell::entity(cx).read(cx).find_seq != seq {
                Shell::update(cx, |s| s.find_seq = seq);
            }
            let h = gpui::Focusable::focus_handle(self.input.read(cx), cx);
            window.focus(&h, cx);
            window.dispatch_action(Box::new(ui_sdk::native::text_field::SelectAll), cx);
        }
        let asked = !self.query(cx).is_empty();
        let ready = self.settled == self.query(cx) && !self.fetching;
        let count = self.seqs.len();
        div()
            .key_context("FindBar")
            .flex()
            .flex_none()
            .h(u(24.))
            .items_center()
            .gap(u(12.))
            .border_b(px(l.w2))
            .border_color(l.line2)
            .bg(l.bg)
            .px(u(8.))
            .capture_key_down(cx.listener(|this, e: &KeyDownEvent, _, cx| match e.keystroke.key.as_str() {
                "enter" => {
                    cx.stop_propagation();
                    this.step(if e.keystroke.modifiers.shift { -1 } else { 1 }, cx);
                }
                "escape" => {
                    cx.stop_propagation();
                    Shell::update(cx, |s| {
                        s.searching_in = None;
                        s.find_seq = None;
                    });
                }
                _ => {}
            }))
            .child(div().flex_1().min_w_0().text_size(u(13.)).line_height(u(16.)).child(Input::root(&self.input, cx).aria_label("Find in chat").w_full()))
            .when(asked && ready, |d| {
                d.child(kit::caption(div()).flex_none().text_color(l.ink3).child(if count == 0 { "None".to_string() } else { format!("{}/{}", self.at.min(count - 1) + 1, count) }))
            })
    }
}
