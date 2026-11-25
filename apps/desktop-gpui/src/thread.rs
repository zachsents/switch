//! A piece of work opened (the desktop's `ui/thread.tsx` and `steps.tsx`): its transcript, live,
//! what was said in bubbles (a side's words in a row run together, the last of a run with the
//! tail), and each run of steps between under how many there were, a fold that's open until shut;
//! each step a line on a hairline down the left, its icon (red when it failed) and its words, and a
//! click opens what it was given and what came back, raw, with its tool under them. The reply
//! streaming in follows at an even pace; a turn that stopped says why, with Retry; one running says
//! its live step, with Stop (⌘.), and a box to steer it.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClipboardItem, Context, Entity, FocusHandle, Focusable, InteractiveElement, KeyDownEvent, IntoElement,
    ListAlignment, ListState, MouseButton, ParentElement, Render, SharedString, StatefulInteractiveElement,
    Styled, Window, actions, div, list, prelude::*, px,
};

use crate::brain::{Item, ItemKind, Status, Who};
use crate::chatbox::{BoxEvent, BoxOptions, ChatBox};
use crate::follow::{self, Follow};
use crate::kit::{self, Btn};
use crate::look::{Look, MONO, u};
use crate::markdown::Doc;
use crate::marks;
use crate::model::model;
use crate::nav::Beat;
use crate::said::{self, Said, Shared};
use crate::select::SelText;
use crate::smooth::Pacer;
use crate::derive::live_step;
use crate::steps::{OWN_APPS, describe_with, tool_label};

actions!(thread, [StopTurn, CopyThread]);

/// The longest raw input or output shown; the rest is cut.
const RAW_MAX: usize = 20_000;

fn raw(v: &serde_json::Value) -> String {
    // As `JSON.stringify(v, null, 2)` writes it: `null` as null, a whole number without its `.0`.
    fn as_js(v: &serde_json::Value) -> serde_json::Value {
        use serde_json::Value;
        match v {
            Value::Number(n) => match n.as_f64() {
                Some(f) if n.is_f64() && f.fract() == 0. && f.abs() < 9_007_199_254_740_992. => Value::from(f as i64),
                _ => v.clone(),
            },
            Value::Array(a) => Value::Array(a.iter().map(as_js).collect()),
            Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), as_js(v))).collect()),
            _ => v.clone(),
        }
    }
    let text = match v {
        serde_json::Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(&as_js(other)).unwrap_or_default(),
    };
    if text.chars().count() > RAW_MAX { format!("{}\n…", text.chars().take(RAW_MAX).collect::<String>()) } else { text }
}

#[derive(Clone)]
enum Block {
    Said { who: Who, text: String, seq: u64 },
    Steps { key: u64, items: Vec<Item> },
    /// An entry that says nothing here (words the reply gate sent back, a turn's empty start): its
    /// space alone, as the desktop keeps it.
    Empty { seq: u64 },
}

impl Block {
    fn key(&self) -> u64 {
        match self {
            Block::Said { seq, .. } => *seq,
            Block::Steps { key, .. } => *key,
            Block::Empty { seq } => *seq,
        }
    }
}

/// A transcript's entries: what was said, and each run of steps between (its tool calls and their
/// results) as one block.
fn blocks(items: &[Item], rejected: &HashSet<String>) -> Vec<Block> {
    let mut out: Vec<Block> = vec![];
    for item in items {
        match item.kind {
            ItemKind::Tool | ItemKind::Result => match out.last_mut() {
                Some(Block::Steps { items, .. }) => items.push(item.clone()),
                _ => out.push(Block::Steps { key: item.seq, items: vec![item.clone()] }),
            },
            ItemKind::Text => {
                let cut: String = item.text.trim().chars().take(2000).collect();
                out.push(if rejected.contains(&cut) { Block::Empty { seq: item.seq } } else { Block::Said { who: Who::Agent, text: item.text.clone(), seq: item.seq } });
            }
            ItemKind::User | ItemKind::Steer if !item.text.is_empty() => out.push(Block::Said { who: Who::User, text: item.text.clone(), seq: item.seq }),
            _ => out.push(Block::Empty { seq: item.seq }),
        }
    }
    out
}

fn who_of(b: Option<&Block>) -> Option<Who> {
    match b {
        Some(Block::Said { who, .. }) => Some(*who),
        _ => None,
    }
}

pub struct ThreadView {
    thread: String,
    list: ListState,
    blocks: Vec<Block>,
    seen: Option<u64>,
    /// Folds shut, and steps opened.
    shut: HashSet<u64>,
    opened: HashSet<u64>,
    /// Where it was, and how much it held, when it last asked for older history (as the chat's).
    asked: Option<(gpui::Pixels, usize)>,
    /// The column is 48 rem or more, as last laid out: read before the list lays out its rows,
    /// which can't ask the list then.
    wide: bool,
    /// The words' width in the column, as the chat's, laid out then too: 720 less its padding once
    /// it's wide, all of it less its padding below that.
    column: gpui::Pixels,
    docs: HashMap<u64, Rc<Doc>>,
    sh: Shared,
    steer: Entity<ChatBox>,
    pacer: Option<Pacer>,
    live: bool,
    stopping: bool,
    retrying: bool,
    /// Following its end, or let go (follow.rs).
    fl: Follow,
    hovered: bool,
    /// The folds' and steps' focus, by key: Tab reaches them, Enter or Space opens them.
    handles: HashMap<u64, FocusHandle>,
    focus: FocusHandle,
}

impl ThreadView {
    pub fn new(thread: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let m = model(cx);
        cx.observe(&m, |_, _, cx| cx.notify()).detach();
        cx.observe(&crate::pictures::Pictures::entity(cx), |_, _, cx| cx.notify()).detach();
        let web = crate::widgets::media::WebPictures::entity(cx);
        cx.observe(&web, |_, _, cx| cx.notify()).detach();
        cx.observe(&Beat::entity(cx), |this: &mut ThreadView, _, cx| {
            if this.live {
                cx.notify();
            }
        })
        .detach();
        let list = ListState::new(0, ListAlignment::Bottom, px(800.));
        m.update(cx, |m, cx| m.want_thread(&thread, cx));
        let steer = cx.new(|cx| ChatBox::new(BoxOptions { placeholder: "Steer…".into(), place: format!("thread:{thread}"), attach: false, words_only: true }, window, cx));
        cx.subscribe(&steer, |this: &mut ThreadView, b, e: &BoxEvent, cx| {
            let BoxEvent::Send(sent) = e else { return };
            this.follow(cx);
            // The last one's error goes as the next steer starts.
            b.update(cx, |b, cx| {
                b.error = None;
                cx.notify();
            });
            let answer = model(cx).read(cx).steer(&this.thread, sent.text.clone(), sent.dictated.clone(), cx);
            let b = b.downgrade();
            cx.spawn(async move |_, cx| {
                let got = answer.await;
                b.update(cx, |b, cx| {
                    b.error = match got {
                        Ok(Ok(_)) => None,
                        Ok(Err(why)) => Some(why),
                        Err(_) => Some("Can't reach the core".into()),
                    };
                    cx.notify();
                })
                .ok();
            })
            .detach();
        })
        .detach();
        ThreadView {
            thread,
            list: list.clone(),
            blocks: vec![],
            seen: None,
            shut: HashSet::new(),
            opened: HashSet::new(),
            asked: None,
            wide: true,
            column: px(0.),
            docs: HashMap::new(),
            // Its Said is given no title (thread.tsx): a reading window opened from it has none.
            sh: Shared::new(String::new(), String::new(), None),
            steer,
            pacer: None,
            live: false,
            stopping: false,
            retrying: false,
            fl: Follow::new(list.clone()),
            hovered: false,
            handles: HashMap::new(),
            focus: cx.focus_handle(),
        }
    }

    fn follow(&mut self, cx: &mut Context<Self>) {
        self.fl.follow();
        cx.notify();
    }

    fn sync(&mut self, cx: &mut Context<Self>) {
        let m = model(cx).read(cx);
        let ver = m.brain.thread_version(&self.thread);
        let streaming = m.brain.threads.get(&self.thread).map(|t| (t.streaming.len(), t.status as u64)).unwrap_or_default();
        let ver = ver.wrapping_mul(31).wrapping_add(streaming.0 as u64).wrapping_add(streaming.1 * 7);
        if self.seen == Some(ver) {
            return;
        }
        self.seen = Some(ver);
        let mut items: Vec<Item> = m.brain.transcripts.get(&self.thread).map(|t| t.items.clone()).unwrap_or_default();
        let last = items.last().map(|i| i.seq).unwrap_or(0);
        let mut rejected = m.brain.transcripts.get(&self.thread).map(|t| t.rejected.clone()).unwrap_or_default();
        if let Some(t) = m.brain.threads.get(&self.thread) {
            items.extend(t.items.iter().filter(|i| i.seq > last).cloned());
            rejected.extend(t.rejected.iter().cloned());
        }
        let next = blocks(&items, &rejected);
        let old = std::mem::take(&mut self.blocks);
        let same = |a: &Block, b: &Block| match (a, b) {
            (Block::Said { seq: x, text: s, .. }, Block::Said { seq: y, text: t, .. }) => x == y && s == t,
            (Block::Steps { key: x, items: a }, Block::Steps { key: y, items: b }) => x == y && a.len() == b.len(),
            (Block::Empty { seq: x }, Block::Empty { seq: y }) => x == y,
            _ => false,
        };
        // The tail (what streams, the live step) is the list's last item, after the blocks.
        if old.is_empty() {
            self.list.reset(next.len() + 1);
        } else {
            let prefix = old.iter().zip(next.iter()).take_while(|(a, b)| same(a, b)).count();
            let max_suffix = old.len().min(next.len()) - prefix;
            let suffix = old.iter().rev().zip(next.iter().rev()).take(max_suffix).take_while(|(a, b)| same(a, b)).count();
            self.list.splice(prefix..old.len() - suffix + 1, next.len() - prefix - suffix + 1);
        }
        self.blocks = next;
    }

    fn step_list(&mut self, items: &[Item], key: u64, l: &Look, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let m = model(cx).read(cx);
        let apps: Vec<String> = OWN_APPS.iter().map(|s| s.to_string()).chain(m.brain.extensions.iter().cloned()).collect();
        let results: HashMap<&str, &Item> = items.iter().filter(|i| i.kind == ItemKind::Result).map(|i| (i.id.as_str(), i)).collect();
        let mut n = 0u32;
        let rows: Vec<AnyElement> = items
            .iter()
            .filter(|i| i.kind == ItemKind::Tool)
            .map(|i| {
                let result = results.get(i.id.as_str()).copied();
                let step = describe_with(if i.name.is_empty() { "tool" } else { &i.name }, &i.input, &apps, result.map(|r| r.text.as_str()).unwrap_or_default());
                let tool = tool_label(if i.name.is_empty() { "tool" } else { &i.name });
                let open = self.opened.contains(&i.seq);
                let seq = i.seq;
                let words = div().flex().flex_1().min_w_0().items_center().overflow_hidden().whitespace_nowrap().children(step.parts.iter().map(|p| {
                    div().when(p.code, |d| d.font_family(MONO).min_w_0().truncate()).when(!p.code && p.text.chars().count() <= 24, |d| d.flex_none()).when(!p.code && p.text.chars().count() > 24, |d| d.min_w_0().truncate()).child(p.text.clone())
                }));
                let mut row = div().flex().flex_col().child(
                    ring(
                        div()
                        .id(SharedString::from(format!("step-{seq}")))
                        .track_focus(&self.handle(seq, cx))
                        .relative()
                        .mx(u(-8.))
                        .flex()
                        .h(u(24.))
                        .min_w_0()
                        .items_center()
                        .gap(u(8.))
                        .rounded(u(4.))
                        .px(u(8.))
                        .text_size(u(11.))
                        .line_height(u(14.))
                        .text_color(l.ink2)
                        .hover(|s| s.bg(l.hover))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if !this.opened.remove(&seq) {
                                this.opened.insert(seq);
                            }
                            if let Some(ix) = this.blocks.iter().position(|b| b.key() == key) {
                                this.list.remeasure_items(ix..ix + 1);
                            }
                            cx.notify();
                        }))
                        .child(marks::step_icon(step.icon, if result.is_some_and(|r| r.error) { l.red } else { l.ink3 }, l.z(14.)))
                        .child(words),
                        &self.handle(seq, cx),
                        &l,
                        window,
                    ),
                );
                if open {
                    let detail = |text: String, n: &mut u32, sh: &Shared| {
                        (!text.trim().is_empty()).then(|| {
                            *n += 1;
                            div()
                                .rounded(u(4.))
                                .border_1()
                                .border_color(l.line2)
                                .p(u(8.))
                                .font_family(MONO)
                                .text_size(u(11.))
                                .line_height(u(14.))
                                .whitespace_normal()
                                .text_color(l.ink)
                                .child(SelText::new(SharedString::from(format!("detail-{seq}-{n}")), (seq, *n), &sh.sel, SharedString::from(text), None))
                        })
                    };
                    row = row.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(u(4.))
                            .pt(u(4.))
                            .pl(u(24.))
                            .children(detail(raw(&i.input), &mut n, &self.sh))
                            .children(detail(raw(&serde_json::Value::String(result.map(|r| r.text.clone()).unwrap_or_default())), &mut n, &self.sh))
                            .when(!tool.is_empty(), |d| d.child(div().text_size(u(11.)).line_height(u(14.)).text_color(l.ink3).child(tool.clone()))),
                    );
                }
                row.into_any_element()
            })
            .collect();
        div().ml(px(2.)).my(px(2.)).flex().flex_col().w_full().max_w(u(560.)).pl(u(12.)).border_l(px(l.w2)).border_color(l.line2).children(rows).into_any_element()
    }

    fn render_block(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let l = Look::get(cx);
        let last = ix + 1 >= self.blocks.len() + 1;
        let body: AnyElement = match self.blocks.get(ix).cloned() {
            None => self.tail(window, cx),
            Some(b) => {
                let ink = self.ink(cx);
                let who = who_of(Some(&b));
                let before = who_of(ix.checked_sub(1).and_then(|j| self.blocks.get(j)));
                let after = who_of(self.blocks.get(ix + 1));
                let run = who.is_some() && who == before;
                let tail = who != after;
                let inner = match &b {
                    Block::Said { who, text, seq } => {
                        let doc = (*who == Who::Agent).then(|| self.docs.entry(*seq).or_insert_with(|| Rc::new(Doc::of(text))).clone());
                        said::said(
                            Said {
                                who: *who,
                                ink,
                                text,
                                detail: None,
                                dim: false,
                                streaming: false,
                                time: None,
                                seq: None,
                                tail,
                                reactions: None,
                                reply_to: &[],
                                here: None,
                                parts: &[],
                                model: None,
                                key: &format!("t{seq}"),
                                order: *seq,
                                doc,
                                width: Some(self.column),
                            },
                            &self.sh,
                            &l,
                            window,
                            cx,
                        )
                    }
                    Block::Empty { .. } => div().into_any_element(),
                    Block::Steps { key, items } => {
                        let count = items.iter().filter(|i| i.kind == ItemKind::Tool).count();
                        let open = !self.shut.contains(key);
                        let k = *key;
                        div()
                            .flex()
                            .flex_col()
                            .items_start()
                            .w_full()
                            .child(
                                ring(
                                div()
                                    .id(SharedString::from(format!("steps-{key}")))
                                    .track_focus(&self.handle(*key ^ (1 << 63), cx))
                                    .relative()
                                    .ml(u(-4.))
                                    .flex()
                                    .min_h(px(26.))
                                    .min_w_0()
                                    .items_center()
                                    .gap(u(8.))
                                    .rounded(u(4.))
                                    .pr(u(8.))
                                    .pl(u(4.))
                                    .text_size(u(11.))
                                    .line_height(u(14.))
                                    .whitespace_nowrap()
                                    .text_color(l.ink3)
                                    .hover(|s| s.bg(l.hover))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if !this.shut.remove(&k) {
                                            this.shut.insert(k);
                                        }
                                        if let Some(ix) = this.blocks.iter().position(|b| b.key() == k) {
                                            this.list.remeasure_items(ix..ix + 1);
                                        }
                                        cx.notify();
                                    }))
                                    .child(format!("{count} {}", if count == 1 { "step" } else { "steps" }))
                                    .child(marks::caret(open, l.ink3, l.z(10.))),
                                &self.handle(*key ^ (1 << 63), cx),
                                &l,
                                window,
                                ),
                            )
                            .when(open, |d| d.child(self.step_list(items, *key, &l, window, cx)))
                            .into_any_element()
                    }
                };
                div().flex().flex_col().min_w_0().when(run, |d| d.pt(px(2.))).when(!run, |d| d.pt(u(8.))).child(inner).into_any_element()
            }
        };
        div()
            .w_full()
            .flex()
            .justify_center()
            .when(ix == 0, |d| d.pt(u(12.)))
            .when(last, |d| d.pb(u(12.)))
            // `@3xl:max-w-column`: the column's cap only once it's 48 rem wide.
            .child(div().w_full().when(self.wide, |d| d.max_w(u(720.))).px(u(12.)).flex().flex_col().child(body))
            .into_any_element()
    }

    fn ink(&self, cx: &App) -> gpui::Hsla {
        let l = Look::get(cx);
        let space = crate::nav::Nav::entity(cx).read(cx).page.space().to_string();
        if space == crate::brain::HOME { l.home } else { l.ink_of(&model(cx).read(cx).derived.station(&space)) }
    }

    /// What follows the transcript: the reply streaming in, why it stopped (Retry), its live step
    /// (Stop).
    fn tail(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let l = Look::get(cx);
        let m = model(cx).read(cx);
        let Some(t) = m.brain.threads.get(&self.thread).cloned() else { return div().into_any_element() };
        let running = t.status == Status::Running;
        let stopped = matches!(t.status, Status::Failed | Status::Limited | Status::Interrupted);
        let apps: Vec<String> = OWN_APPS.iter().map(|s| s.to_string()).chain(m.brain.extensions.iter().cloned()).collect();
        let step = if running { live_step(&t, &apps) } else { String::new() };
        // The reply streaming in, at an even pace.
        let streaming = t.streaming.clone();
        let shown = if streaming.is_empty() {
            self.pacer = None;
            String::new()
        } else {
            let p = self.pacer.get_or_insert_with(|| Pacer::new(&streaming, true));
            p.take(&streaming, true);
            if p.tick() {
                window.request_animation_frame();
            }
            p.shown().to_string()
        };
        let ink = self.ink(cx);
        let mut out = div().flex().flex_col();
        if !shown.is_empty() {
            let doc = Rc::new(Doc::of(&shown));
            out = out.child(said::said(
                Said { who: Who::Agent, ink, text: &shown, detail: None, dim: false, streaming: true, time: None, seq: None, tail: true, reactions: None, reply_to: &[], here: None, parts: &[], model: None, key: "streaming", order: u64::MAX - 3, doc: Some(doc), width: Some(self.column) },
                &self.sh,
                &l,
                window,
                cx,
            ));
        }
        if stopped {
            let (thread, on) = (self.thread.clone(), !self.retrying);
            out = out.child(
                div()
                    .flex()
                    .items_center()
                    .gap(u(8.))
                    .self_start()
                    .px(u(4.))
                    .text_size(u(12.))
                    .line_height(u(16.))
                    .text_color(l.ink)
                    .max_w_full()
                    .child(marks::stop(px(12.), &l))
                    // A long reason wraps rather than running out past the column.
                    .child(div().min_w_0().whitespace_normal().child(t.result.clone()))
                    .child(kit::press(kit::button("retry", Btn::Key, on, &l), on, cx.listener(move |this, _, _, cx| {
                        this.retrying = true;
                        let answer = model(cx).read(cx).retry(&thread, cx);
                        cx.spawn(async move |this, cx| {
                            let _ = answer.await;
                            this.update(cx, |this, cx| {
                                this.retrying = false;
                                cx.notify();
                            })
                            .ok();
                        })
                        .detach();
                        cx.notify();
                    }))
                    .aria_label("Retry").child("Retry")),
            );
        }
        if running {
            let on = !self.stopping;
            out = out.child(
                div()
                    .flex()
                    .items_center()
                    .gap(u(8.))
                    .self_start()
                    .px(u(4.))
                    .text_size(u(12.))
                    .line_height(u(16.))
                    .text_color(l.ink2)
                    .child(marks::runner_mark(l.z(14.), Beat::step(cx), l.orange))
                    .child(div().min_w_0().whitespace_normal().child(step))
                    .child(kit::press(kit::button("stop", Btn::Danger, on, &l), on, cx.listener(|this, _, _, cx| this.stop(cx))).aria_label("Stop").child("Stop")),
            );
        }
        out.into_any_element()
    }

    /// A fold's or a step's place in the keyboard's order, made once.
    fn handle(&mut self, key: u64, cx: &mut Context<Self>) -> FocusHandle {
        self.handles.entry(key).or_insert_with(|| cx.focus_handle().tab_stop(true)).clone()
    }

    /// A paste no field took goes to the steer box while it's there.
    pub fn paste_outside(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.running(cx) {
            let b = self.steer.clone();
            b.update(cx, |b, cx| b.paste_outside(window, cx));
        }
    }

    fn running(&self, cx: &App) -> bool {
        model(cx).read(cx).brain.threads.get(&self.thread).is_some_and(|t| t.status == Status::Running)
    }

    /// Opened again: its folds and steps as a page newly drawn has them, open and shut.
    pub fn visited(&mut self, cx: &mut Context<Self>) {
        self.shut.clear();
        self.opened.clear();
        cx.notify();
    }

    /// "/" puts the cursor in the steer box, while it's there.
    pub fn focus_box(&self, window: &mut Window, cx: &mut App) {
        if self.running(cx) {
            let b = self.steer.clone();
            b.update(cx, |b, cx| b.focus(window, cx));
        }
    }

    /// A key no field took: a letter typed, or ⌘V, goes to the steer box while it's there.
    /// `pressing`: a button has the focus, so Space is its press, not a letter.
    pub fn typed_outside(&mut self, e: &KeyDownEvent, pressing: bool, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let k = &e.keystroke;
        let m = &k.modifiers;
        if m.control || m.alt || !self.running(cx) {
            return false;
        }
        let b = self.steer.clone();
        if m.platform && k.key == "v" && !m.shift {
            b.update(cx, |b, cx| b.paste_outside(window, cx));
            return true;
        }
        match crate::chatbox::printable(e, pressing) {
            Some(_) => {
                let key = k.clone();
                b.update(cx, |b, cx| b.typed(key, window, cx));
                true
            }
            None => false,
        }
    }

    fn stop(&mut self, cx: &mut Context<Self>) {
        if self.stopping {
            return;
        }
        self.stopping = true;
        let answer = model(cx).read(cx).stop(&self.thread, cx);
        cx.spawn(async move |this, cx| {
            let _ = answer.await;
            this.update(cx, |this, cx| {
                this.stopping = false;
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
}

impl Focusable for ThreadView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// ⌘. stops a running turn; ⌘C copies what's selected.
pub fn bindings() -> Vec<gpui::KeyBinding> {
    vec![gpui::KeyBinding::new("cmd-.", StopTurn, Some("Thread")), gpui::KeyBinding::new("cmd-c", CopyThread, Some("Thread && !TextField")), gpui::KeyBinding::new("cmd-a", ui_sdk::native::text_field::SelectAll, Some("Thread && !TextField"))]
}

impl ThreadView {
    fn body(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        // Paged again whenever the brain dropped it (a snapshot), as the desktop's query refetches.
        let thread = self.thread.clone();
        let failed = model(cx).read(cx).brain.transcripts.get(&thread).and_then(|t| t.failed.clone());
        if let Some(reason) = failed {
            let key = format!("thread:{thread}");
            return crate::boundary::failed_read(&key, &reason, move |cx| model(cx).update(cx, |m, cx| m.retry_thread(&thread, cx)), cx);
        }
        model(cx).update(cx, |m, cx| m.want_thread(&thread, cx));
        self.sync(cx);
        // Older history comes in within half a screen of the top, and while it all fits.
        let top = -self.list.scroll_px_offset_for_scrollbar().y;
        if top < self.list.viewport_bounds().size.height / 2. && self.asked != Some((top, self.blocks.len())) {
            self.asked = Some((top, self.blocks.len()));
            let t = self.thread.clone();
            model(cx).update(cx, |m, cx| m.older_thread(&t, cx));
        }
        self.fl.settle(window);
        let latest = self.fl.latest(window);
        let look = Look::get(cx);
        let thumb = self.fl.thumb_shown(self.hovered).then(|| follow::thumb(&self.list, &look));
        self.sh.sel.frame();
        let l = Look::get(cx);
        let running = model(cx).read(cx).brain.threads.get(&self.thread).is_some_and(|t| t.status == Status::Running);
        self.live = running || self.pacer.as_ref().is_some_and(Pacer::coming);
        let w = self.list.viewport_bounds().size.width;
        self.wide = w >= l.z(768.);
        self.column = ((if self.wide { l.z(720.) } else { w }) - l.z(24.)).max(px(0.));
        let list = list(self.list.clone(), cx.processor(|this: &mut ThreadView, ix, window, cx| this.render_block(ix, window, cx))).size_full();
        div()
            .key_context("Thread")
            .track_focus(&self.focus)
            // ⌘. only while it runs: otherwise the key isn't the page's.
            .when(running, |d| d.on_action(cx.listener(|this, _: &StopTurn, _, cx| this.stop(cx))))
            // ⌘V or Edit ▸ Paste with the page focused: to the steer box while it's there.
            .on_action(cx.listener(|this, _: &ui_sdk::native::text_field::Paste, window, cx| this.paste_outside(window, cx)))
            .on_action(cx.listener(|this, _: &ui_sdk::native::text_field::SelectAll, window, _| {
                this.sh.sel.select_all();
                window.refresh();
            }))
            // The scroll keys, with no field taking them.
            .on_key_down(cx.listener(|this, e: &KeyDownEvent, window, cx| {
                // The page's keys, with it or a key in it focused; never a field's. Enter and Space
                // press the focused key.
                if crate::follow::in_field(window) {
                    return;
                }
                let pressing = !this.focus.is_focused(window);
                if pressing && matches!(e.keystroke.key.as_str(), "enter" | "space") {
                    return;
                }
                if this.typed_outside(e, pressing, window, cx) || this.fl.key(e) {
                    cx.stop_propagation();
                    cx.notify();
                }
            }))
            // Edit ▸ Copy, as ⌘C (a field with focus copies its own first).
            .on_action(cx.listener(|this, _: &ui_sdk::native::text_field::Copy, _, cx| {
                let t = this.sh.sel.text();
                if !t.is_empty() {
                    cx.write_to_clipboard(ClipboardItem::new_string(t));
                }
            }))
            .on_action(cx.listener(|this, _: &CopyThread, _, cx| {
                let t = this.sh.sel.text();
                if !t.is_empty() {
                    cx.write_to_clipboard(ClipboardItem::new_string(t));
                }
            }))
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .child(
                div()
                    .id("thread-column")
                    .relative()
                    .on_hover(cx.listener(|this, h: &bool, _, cx| {
                        this.hovered = *h;
                        cx.notify();
                    }))
                    .flex_1()
                    .min_h_0()
                    .capture_any_mouse_down(cx.listener(|this, e: &gpui::MouseDownEvent, _, _| {
                        if e.button == MouseButton::Left && !e.modifiers.shift && e.click_count == 1 {
                            this.sh.sel.clear();
                        }
                    }))
                    // And takes the focus from any field, unless what's under it kept it (Latest
                    // leaves it in the box) or took it (a key of its own).
                    .on_any_mouse_down(cx.listener(|this, _: &gpui::MouseDownEvent, window, cx| {
                        if !window.default_prevented() {
                            window.focus(&this.focus, cx);
                        }
                    }))
                    .child(list)
                    .child({
                        let (view, moved) = (self.list.clone(), cx.entity().downgrade());
                        crate::select::drag_anywhere(
                            &self.sh.sel,
                            move || view.viewport_bounds(),
                            move |by, _, cx| {
                                moved
                                    .update(cx, |this, cx| {
                                        if by < px(0.) {
                                            this.fl.release();
                                        }
                                        crate::follow::scroll_by(&this.list, by);
                                        cx.notify();
                                    })
                                    .ok();
                            },
                            |_, _| {},
                        )
                    })
                    .children(thumb.map(|t| div().absolute().top_0().left_0().size_full().child(t).child(crate::follow::thumb_cut())))
                    .when(latest, |d| {
                        d.child(div().absolute().right(u(16.)).bottom(u(12.)).child(crate::webview::cutting()).child(kit::button("thread-latest", Btn::Key, true, &l).aria_label("Jump to latest").on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default()).on_click(cx.listener(|this, _, _, cx| this.follow(cx))).child("Latest ↓")))
                    }),
            )
            .when(running, |d| d.child(self.steer.clone()))
            .into_any_element()
    }
}

impl Render for ThreadView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        crate::boundary::guard("thread", window, cx, |window, cx| self.body(window, cx))
    }
}

/// Keyboard focus drawn over what has it, a hairline that never moves the layout.
fn ring(d: gpui::Stateful<gpui::Div>, focus: &FocusHandle, l: &Look, window: &Window) -> gpui::Stateful<gpui::Div> {
    // From the keyboard only, as `focus-visible`: a click shows none.
    let on = focus.is_focused(window) && window.last_input_was_keyboard();
    d.when(on, |d| d.child(div().absolute().top_0().left_0().size_full().rounded(u(4.)).border_1().border_color(l.ink3)))
}
