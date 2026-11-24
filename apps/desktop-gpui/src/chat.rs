//! A space's chat (the desktop's `ui/space-chat.tsx`, `chat.tsx`'s lines, `runs.ts`,
//! `chat-asks.ts`, `scroll.tsx`, `timeline-*.ts`, `use-timeline-follow.ts`, `follow-end.ts`,
//! `use-read.ts`): its master thread as iMessage draws one, its asks in it where they were raised,
//! and the box as the whole bottom cell. gpui's list, virtualized, keeps to its latest as T3 Code's
//! timeline does: it opens at its end, follows new lines while it's there and stops once the user
//! scrolls up, shows Latest while it's away (a moment after leaving, at once gone), pages older
//! history in at the top without moving, and brings a line found (⌘F's, the palette's) into view.
//! On screen in the window the user is in, it's read to its latest reply. Words select across
//! bubbles and copy with ⌘C; selected in one bubble, a bar over them offers Reply and tapbacks.
//! Typing or pasting with no field taking it lands in the box; files dropped on it join the box.

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    AnyElement, App, ClipboardItem, Context, Entity, ExternalPaths, FocusHandle, Focusable, FontWeight,
    Hsla, InteractiveElement, IntoElement, KeyDownEvent, ListAlignment, ListOffset, ListState, MouseButton, ParentElement, Pixels, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement, Styled, Window, actions, div, list, prelude::*, px,
};

use crate::attached;
use crate::brain::{HOME, Line, Pending, Quiet, Reply, Status, Who};
use crate::chat_marks;
use crate::chat_platform::{self, Do};
use crate::chatbox::{BoxEvent, BoxOptions, ChatBox, Sent};
use crate::follow::{self, Follow};
use crate::derive::typing_since;
use crate::items::ActionItem;
use crate::kit::{self, Btn};
use crate::look::{Look, u};
use crate::markdown::{Doc, OnLink, OnPicture};
use crate::marks;
use crate::model::{Post, model};
use crate::nav::{Beat, Nav, Page};
use crate::quiet;
use crate::replying;
use crate::said::{self, Said, Shared};
use crate::tapback::{ReactMenu, Target};
use crate::time::{day_of, now_ms, same_day, time_of};

actions!(chat, [CopySelection]);

/// Lines from one side this close run together.
const RUN_MS: f64 = 5. * 60_000.;
/// A quiet this long puts the time over the next line.
const GAP_MS: f64 = 10. * 60_000.;
/// What the core ends a turn the user stopped on, and one the deploy paused.
const STOPPED: &str = "Stopped";
const PAUSED: &str = "Paused for an update";

/// How a line sits under the one before: in its run, apart, or after a gap with the time over it.
#[derive(Clone, Copy, PartialEq)]
pub enum Lead {
    Run,
    Apart,
    Gap(f64),
}

#[derive(Clone)]
enum Kind_ {
    Line(Arc<Line>),
    Pending(Pending),
    /// An ask where it was raised: open, its card; answered, its one line.
    Ask(Box<ActionItem>, bool),
    Typing,
}

#[derive(Clone)]
struct Entry {
    key: String,
    kind: Kind_,
    lead: Lead,
    /// The last of its run: it has the tail.
    tail: bool,
    /// Its place in the column's order, for the selection.
    order: u64,
    /// The chat turn whose answering of this line failed: Not Delivered under it.
    undelivered: Option<String>,
    /// What it draws, in brief: a change remeasures it.
    sig: u64,
}

/// Said, in a bubble: not a quiet line or a widget; by whom, and a peer's name.
fn said_of(k: &Kind_) -> Option<(Who, Option<&str>)> {
    match k {
        Kind_::Line(l) if l.quiet.is_none() && l.widget.is_none() && !general_of(l).is_empty() => Some((l.who, l.from.as_deref())),
        Kind_::Pending(p) if !p.text.is_empty() => Some((Who::User, None)),
        _ => None,
    }
}

fn time_of_kind(k: &Kind_) -> Option<f64> {
    match k {
        Kind_::Line(l) => Some(l.time),
        _ => None,
    }
}

/// Each entry's lead and tail, as iMessage sets lines.
fn runs(kinds: Vec<(String, Kind_, u64, Option<String>)>) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::with_capacity(kinds.len());
    let mut last: Option<f64> = None;
    for (i, (key, kind, order, undelivered)) in kinds.iter().enumerate() {
        let time = time_of_kind(kind);
        let lead = match time {
            Some(t) if last.is_none_or(|l| t - l >= GAP_MS) => Lead::Gap(t),
            _ => {
                let before = i.checked_sub(1).map(|j| &kinds[j].1);
                let run = match (said_of(kind), before.and_then(said_of)) {
                    (Some(a), Some(b)) if a == b => match (time, before.and_then(time_of_kind)) {
                        (Some(t), Some(bt)) => t - bt < RUN_MS,
                        _ => true,
                    },
                    _ => false,
                };
                if run { Lead::Run } else { Lead::Apart }
            }
        };
        if time.is_some() {
            last = time;
        }
        out.push(Entry { key: key.clone(), kind: kind.clone(), lead, tail: true, order: *order, undelivered: undelivered.clone(), sig: 0 });
    }
    for i in 0..out.len() {
        out[i].tail = out.get(i + 1).is_none_or(|n| n.lead != Lead::Run);
        let mut h = std::collections::hash_map::DefaultHasher::new();
        let e = &out[i];
        e.key.hash(&mut h);
        e.tail.hash(&mut h);
        e.undelivered.hash(&mut h);
        match e.lead {
            Lead::Run => 0u8.hash(&mut h),
            Lead::Apart => 1u8.hash(&mut h),
            Lead::Gap(t) => (t as u64).hash(&mut h),
        }
        match &e.kind {
            Kind_::Line(l) => {
                l.text.hash(&mut h);
                l.edited.hash(&mut h);
                l.attachments.len().hash(&mut h);
                l.mentions.hash(&mut h);
                l.home.hash(&mut h);
                l.reactions.hash(&mut h);
                l.parts.hash(&mut h);
                l.reply_to.hash(&mut h);
                l.detail.hash(&mut h);
                l.model.hash(&mut h);
                l.from.hash(&mut h);
                format!("{:?}", l.quiet).hash(&mut h);
            }
            Kind_::Pending(p) => {
                p.failed.hash(&mut h);
                p.text.hash(&mut h);
                p.files.hash(&mut h);
                p.reply_to.hash(&mut h);
            }
            Kind_::Ask(item, open) => {
                open.hash(&mut h);
                format!("{item:?}").hash(&mut h);
            }
            Kind_::Typing => 2u8.hash(&mut h),
        }
        out[i].sig = h.finish();
    }
    out
}

/// Opens a link in the agent's words: another space's exchange, a page here, or the browser's.
pub fn on_link() -> OnLink {
    links(true)
}

/// A link in a reading window: as the chat's, but a citation's space opens nowhere (the desktop's
/// reading window moves its own page, which it doesn't show).
pub fn reading_on_link() -> OnLink {
    links(false)
}

fn links(cites: bool) -> OnLink {
    Rc::new(move |url: &str, _window: &mut Window, cx: &mut App| {
        if let Some(space) = crate::markdown::cited_space(url) {
            if cites {
                Nav::open(Page::Space(space), cx);
            }
        } else if url.starts_with('#') {
            // A footnote's own anchor: the words are all in the bubble.
        } else if url.starts_with("switchboard:") {
            crate::links::follow_link(url, cx);
        } else if url.split_once(':').is_some_and(|(scheme, _)| matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https" | "mailto")) {
            // Only the web and mail go to the system, as the desktop lets them (`bun/index.ts`).
            cx.open_url(url);
        }
    })
}

/// A picture in the agent's words: Quick Look on a click, its file's menu on a right-click.
pub fn on_picture() -> OnPicture {
    Rc::new(|src: &str, name: &str, menu: bool, window: &mut Window, cx: &mut App| {
        chat_platform::file(src, name, if menu { Do::Menu } else { Do::Look }, window, cx).detach();
    })
}

/// The time over a line after a gap ("Today 9:12 PM", "Friday, Nov 20 9:12 PM"): words of the page, as ⌘A and a drag take them (its line's
/// first run).
fn gap_time(t: f64, order: u64, sel: &crate::select::Sel, l: &Look) -> gpui::Div {
    let day = if same_day(t, now_ms()) { "Today".to_string() } else { day_of(t) };
    let words = format!("{day} {}", time_of(t));
    div().pt(u(16.)).pb(u(8.)).flex().justify_center().text_size(u(11.)).line_height(u(14.)).font_weight(FontWeight::MEDIUM).text_color(l.ink2).child(crate::markdown::plain(&words, format!("gap.{order}"), (order, 0), sel))
}

fn text_hash(s: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

/// The space's chat turn answering the user, when it ended with no reply and the user didn't stop
/// it (it failed, hit a limit, or was cut off; not paused for an update).
fn undelivered(b: &crate::brain::Brain, space: &str) -> Option<String> {
    let t = b.threads.get(&format!("space:{space}"))?;
    let unanswered = matches!(t.status, Status::Failed | Status::Limited) || (t.status == Status::Interrupted && t.result != STOPPED && t.result != PAUSED);
    (unanswered && !t.woken).then(|| t.id.clone())
}

/// A line's general words: none when they only repeat its replies under what it replies to.
fn general_of(line: &Line) -> String {
    let replies: Vec<&str> = line.reply_to.iter().map(|r| r.reply().trim()).filter(|r| !r.is_empty()).collect();
    if !replies.is_empty() && line.text.trim() == replies.join("\n\n") { String::new() } else { line.text.clone() }
}

/// What a line replies to: its own refs, and the item an older reply was on.
fn replies_to(line: &Line) -> Vec<Reply> {
    let mut out = line.reply_to.clone();
    if let Some(item) = &line.item
        && !out.iter().any(|r| matches!(r, Reply::Ask { id, .. } if id == item))
    {
        out.push(Reply::Ask { id: item.clone(), title: None, reply: None });
    }
    out
}

pub struct ChatView {
    space: String,
    list: ListState,
    entries: Vec<Entry>,
    seen: Option<u64>,
    docs: HashMap<u64, (u64, Rc<Doc>)>,
    sh: Shared,
    menu: Entity<ReactMenu>,
    pub chatbox: Entity<ChatBox>,
    /// The seq of the message being edited in the box.
    editing: Option<u64>,
    typing: bool,
    /// Following its end, or let go (follow.rs).
    fl: Follow,
    /// The window's rem as last drawn, for the room a line's lead takes.
    rem: Pixels,
    /// Where the column was, and how many lines it held, when it last asked for older ones: asked
    /// again once it moves or changes, as a scroll asks, never on every frame (a refused page).
    asked: Option<(Pixels, usize)>,
    blip: Option<quiet::Open>,
    focus: FocusHandle,
    widgets: HashMap<String, Entity<crate::widgets::chat_widget::ChatWidget>>,
    cards: HashMap<String, Entity<crate::asks::card::AskCard>>,
    rows: HashMap<String, ScrollHandle>,
    /// The line last brought into view.
    target: Option<(u64, u64)>,
    /// The reply last marked read.
    read: Option<u64>,
    width: Rc<Cell<Pixels>>,
    retrying: bool,
    hovered: bool,
    /// Pictures that couldn't be had, as last counted.
    failures: usize,
    /// The row brought into view, to centre once it's laid out.
    centering: Option<usize>,
}

impl ChatView {
    pub fn new(space: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let m = model(cx);
        cx.observe(&m, |_, _, cx| cx.notify()).detach();
        // A picture keeps the height it's drawn at while it comes, so its row needn't be measured
        // again as it lands: drawing it again is enough. One that can't be had is its name, shorter:
        // then the rows are measured again.
        cx.observe(&crate::pictures::Pictures::entity(cx), |this: &mut ChatView, _, cx| {
            let failures = crate::pictures::Pictures::failures(cx);
            if failures != this.failures {
                this.failures = failures;
                this.list.remeasure();
            }
            cx.notify();
        })
        .detach();
        let web = crate::widgets::media::WebPictures::entity(cx);
        cx.observe(&web, |_, _, cx| cx.notify()).detach();
        cx.observe(&Beat::entity(cx), |this: &mut ChatView, _, cx| {
            if this.typing {
                cx.notify();
            }
        })
        .detach();
        cx.observe_window_activation(window, |_, _, cx| cx.notify()).detach();
        // "Today" over a gap, and each line's stamp, turn with the clock.
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(std::time::Duration::from_secs(30)).await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        })
        .detach();
        let name = m.read(cx).brain.spaces.get(&space).map(|s| s.name.clone()).unwrap_or_else(|| "Chat".into());
        let placeholder = if space == HOME { "Talk to Switch…".to_string() } else { format!("Talk to Switch about {name}…") };
        let menu = cx.new(|cx| ReactMenu::new(window, cx));
        cx.subscribe_in(&menu, window, |this: &mut ChatView, _, e: &crate::tapback::Closed, window, cx| {
            if e.chosen && this.sh.sel.entry().is_some() {
                this.sh.sel.clear();
            }
            // Its search and keys gone with it, the focus comes back to the column (the box keeps
            // its own): keys typed next go where a page's would.
            if !this.chatbox.read(cx).is_focused(window, cx) {
                window.focus(&this.focus, cx);
            }
            window.refresh();
            cx.notify();
        })
        .detach();
        let chatbox = cx.new(|cx| ChatBox::new(BoxOptions { placeholder, place: format!("space:{space}"), attach: true, words_only: false }, window, cx));
        cx.subscribe_in(&chatbox, window, |this: &mut ChatView, _, e: &BoxEvent, window, cx| match e {
            BoxEvent::Send(sent) => this.send(sent, window, cx),
            BoxEvent::Recall => {
                if let Some(text) = this.recall(cx) {
                    this.chatbox.update(cx, |b, cx| b.put_text(text, window, cx));
                }
            }
            BoxEvent::Cancel => {
                this.editing = None;
                cx.notify();
            }
        })
        .detach();
        // Its box takes the focus as the space first opens.
        if Nav::entity(cx).read(cx).page == Page::Space(space.clone()) {
            chatbox.update(cx, |b, cx| b.focus(window, cx));
        }
        let list = ListState::new(0, ListAlignment::Bottom, px(800.));
        m.update(cx, |m, cx| m.want_chat(&space, cx));
        let sh = Shared::new(space.clone(), name, Some(menu.downgrade()));
        ChatView {
            space,
            fl: Follow::new(list.clone()),
            rem: px(16.),
            asked: None,
            list,
            entries: vec![],
            seen: None,
            docs: HashMap::new(),
            sh,
            menu,
            chatbox,
            editing: None,
            typing: false,
            blip: None,
            focus: cx.focus_handle(),
            widgets: HashMap::new(),
            cards: HashMap::new(),
            rows: HashMap::new(),
            target: None,
            read: None,
            width: Rc::new(Cell::new(px(0.))),
            retrying: false,
            hovered: false,
            failures: 0,
            centering: None,
        }
    }

    pub fn focus_box(&self, window: &mut Window, cx: &mut App) {
        let b = self.chatbox.clone();
        b.update(cx, |b, cx| b.focus(window, cx));
    }

    /// Back to the end, following it again: the user sent something, or pressed Latest.
    fn follow(&mut self, cx: &mut Context<Self>) {
        self.fl.follow();
        cx.notify();
    }

    /// ↑ in the empty box: the user's last message here, to edit, unless it's still being sent.
    fn recall(&mut self, cx: &mut Context<Self>) -> Option<String> {
        let last = self.entries.iter().rev().find_map(|e| match &e.kind {
            Kind_::Line(l) if l.who == Who::User && l.widget.is_none() => Some(Some(l.clone())),
            Kind_::Pending(_) => Some(None),
            _ => None,
        })?;
        let line = last?;
        if line.home != self.space {
            return None;
        }
        self.editing = Some(line.seq);
        self.chatbox.update(cx, |b, _| b.editing = true);
        cx.notify();
        Some(general_of(&line))
    }

    fn send(&mut self, sent: &Sent, _window: &mut Window, cx: &mut Context<Self>) {
        self.chatbox.update(cx, |b, _| b.error = None);
        self.follow(cx);
        let space = self.space.clone();
        match self.editing.take() {
            None => {
                let reply_to = replying::replying_to(&space, cx);
                model(cx).update(cx, |m, cx| m.post_message(Post { id: None, space: space.clone(), text: sent.text.clone(), dictated: sent.dictated.clone(), files: sent.files.clone(), attachments: vec![], reply_to }, cx));
                replying::clear(&space, cx);
            }
            Some(seq) => {
                self.chatbox.update(cx, |b, _| b.editing = false);
                let answer = model(cx).read(cx).edit_message(seq, sent.text.clone(), cx);
                let b = self.chatbox.downgrade();
                cx.spawn(async move |_, cx| {
                    if let Ok(Err(why)) = answer.await {
                        b.update(cx, |b, cx| {
                            b.error = Some(why);
                            cx.notify();
                        })
                        .ok();
                    }
                })
                .detach();
            }
        }
        cx.notify();
    }

    /// The entries as the brain has them now, put in the list where they changed.
    fn sync(&mut self, cx: &mut Context<Self>) {
        let m = model(cx);
        let space = self.space.clone();
        let needs = m.read(cx).brain.chats.get(&space).is_none_or(|c| (!c.loaded || c.stale) && !c.fetching);
        if needs {
            m.update(cx, |m, cx| m.want_chat(&space, cx));
        }
        // A line to bring into view: older pages come in until it's held.
        if let Some(t) = crate::find::target(&space, cx) {
            let short = m.read(cx).brain.chats.get(&space).is_some_and(|c| c.more && c.lines.first().is_some_and(|f| f.seq > t));
            if short {
                m.update(cx, |m, cx| m.older_chat(&space, cx));
            }
        }
        let m = m.read(cx);
        let b = &m.brain;
        let since = typing_since(b, &space);
        let empty = vec![];
        let lines = b.chats.get(&space).map(|c| &c.lines).unwrap_or(&empty);
        // Typing until its reply lands.
        let typing = since.is_some_and(|s| !lines.iter().any(|l| l.who == Who::Agent && l.time >= s));
        self.typing = typing;
        let undelivered = undelivered(b, &space);
        let open = b.items.open_in(&space);
        let closed = b.items.closed_in(&space);
        // A card is an open ask's: closed or gone, its card goes, so open again it's a fresh one
        // (ask-in-chat.tsx), whether or not its closed line was ever drawn.
        self.cards.retain(|id, _| open.iter().any(|i| &i.id == id));
        let mut h = std::collections::hash_map::DefaultHasher::new();
        b.chat_version(&space).hash(&mut h);
        typing.hash(&mut h);
        undelivered.hash(&mut h);
        format!("{open:?}{closed:?}").hash(&mut h);
        b.spaces.len().hash(&mut h);
        b.pending.len().hash(&mut h);
        let ver = h.finish();
        if self.seen == Some(ver) {
            return;
        }
        self.seen = Some(ver);
        // The message the chat's turn answered: their last one here.
        let last_said = lines.iter().rev().find(|l| l.who == Who::User && l.widget.is_none() && l.home == space).map(|l| l.seq);
        // Lines, then what's sent and not yet in the log, with the asks where they were raised.
        let pending: Vec<&Pending> = b.pending.iter().filter(|p| p.space == space).collect();
        let times: Vec<Option<f64>> = lines.iter().map(|l| Some(l.time)).chain(pending.iter().map(|_| None)).collect();
        let mut kinds: Vec<(String, Kind_, u64, Option<String>)> = vec![];
        for slot in crate::asks::chat::with_asks(&times, open, closed) {
            match slot {
                crate::asks::chat::Slot::Ask(item, open) => kinds.push((format!("ask:{}", item.id), Kind_::Ask(Box::new(item), open), 0, None)),
                crate::asks::chat::Slot::Line(i) if i < lines.len() => {
                    let l = &lines[i];
                    let nd = if Some(l.seq) == last_said { undelivered.clone() } else { None };
                    kinds.push((l.seq.to_string(), Kind_::Line(l.clone()), l.seq, nd));
                }
                crate::asks::chat::Slot::Line(i) => {
                    let n = i - lines.len();
                    let p = pending[n];
                    kinds.push((p.id.clone(), Kind_::Pending(p.clone()), u64::MAX / 2 + n as u64, None));
                }
            }
        }
        if typing {
            kinds.push(("typing".into(), Kind_::Typing, u64::MAX - 2, None));
        }
        let next = runs(kinds);
        let old = std::mem::take(&mut self.entries);
        // Where the column stands, by the line at its top: older lines coming in change that
        // line's lead (and which is first), and the list would put its top back at the start of
        // what changed; it stays where it was instead, less what the lead gained or lost.
        let rem = self.rem;
        let head = |e: &Entry, first: bool| -> Pixels {
            let lead = match e.lead {
                Lead::Run => px(2.),
                Lead::Apart => u(12.).to_pixels(rem),
                Lead::Gap(_) => u(16. + 14. + 8.).to_pixels(rem),
            };
            lead + if first { u(12.).to_pixels(rem) } else { px(0.) }
        };
        let top = self.list.logical_scroll_top();
        let held = (!self.fl.is_following()).then(|| old.get(top.item_ix).map(|e| (e.key.clone(), head(e, top.item_ix == 0), top.offset_in_item))).flatten();
        if old.is_empty() {
            self.list.reset(next.len());
        } else {
            let same = |a: &Entry, b: &Entry| a.key == b.key && a.sig == b.sig;
            let prefix = old.iter().zip(next.iter()).take_while(|(a, b)| same(a, b)).count();
            let max_suffix = old.len().min(next.len()) - prefix;
            let suffix = old.iter().rev().zip(next.iter().rev()).take(max_suffix).take_while(|(a, b)| same(a, b)).count();
            self.list.splice(prefix..old.len() - suffix, next.len() - prefix - suffix);
            if let Some((key, was, offset)) = held
                && let Some(ix) = next.iter().position(|e| e.key == key)
            {
                let now = head(&next[ix], ix == 0);
                self.list.scroll_to(ListOffset { item_ix: ix, offset_in_item: (offset + now - was).max(px(0.)) });
            }
        }
        let held: HashSet<u64> = next.iter().map(|e| e.order).chain([u64::MAX - 1]).collect();
        self.sh.sel.keep(&held);
        self.entries = next;
    }

    /// A found line brought into view, centred; it leaves the end.
    fn bring_into_view(&mut self, cx: &mut Context<Self>) {
        let target = crate::find::target_turn(&self.space, cx);
        if target == self.target {
            return;
        }
        let Some((t, _)) = target else {
            self.target = None;
            return;
        };
        let Some(ix) = self.entries.iter().position(|e| matches!(&e.kind, Kind_::Line(l) if l.seq == t)) else { return };
        self.target = target;
        self.fl.release();
        self.list.scroll_to(ListOffset { item_ix: ix, offset_in_item: px(0.) });
        self.centering = Some(ix);
        cx.notify();
    }

    /// Once the line brought into view is laid out where it now is, it's centred.
    fn center(&mut self, window: &mut Window) {
        let Some(ix) = self.centering else { return };
        match self.list.bounds_for_item(ix) {
            Some(b) => {
                self.centering = None;
                let view = self.list.viewport_bounds();
                crate::follow::scroll_by(&self.list, b.center().y - view.center().y);
                window.refresh();
            }
            None => window.request_animation_frame(),
        }
    }

    /// On screen in the window the user is in: read to its latest reply, here and on every device.
    fn mark_read(&mut self, window: &Window, cx: &mut Context<Self>) {
        if !window.is_window_active() {
            return;
        }
        let at = model(cx).read(cx).brain.unread_at(&self.space);
        if let Some(seq) = at
            && self.read != Some(seq)
        {
            self.read = Some(seq);
            let space = self.space.clone();
            model(cx).update(cx, |m, cx| m.read(&space, seq, cx));
        }
    }

    fn doc(&mut self, seq: u64, text: &str) -> Rc<Doc> {
        let h = text_hash(text);
        if let Some((held, doc)) = self.docs.get(&seq)
            && *held == h
        {
            return doc.clone();
        }
        let doc = Rc::new(Doc::of(text));
        self.docs.insert(seq, (h, doc.clone()));
        doc
    }

    fn ink(&self, cx: &App) -> Hsla {
        let l = Look::get(cx);
        if self.space == HOME { l.home } else { l.ink_of(&model(cx).read(cx).derived.station(&self.space)) }
    }

    /// The column's width less its sides, for the room beside a bubble.
    /// The words' width in the column: 720 less its padding once the column is `@3xl` (48 rem),
    /// all of it less its padding below that, as the desktop's list is.
    fn col_width(&self, l: &Look) -> Pixels {
        let w = self.width.get();
        let wide = w >= l.z(768.);
        ((if wide { l.z(720.) } else { w }) - l.z(24.)).max(px(0.))
    }

    fn render_entry(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(e) = self.entries.get(ix).cloned() else { return div().into_any_element() };
        let l = Look::get(cx);
        let ink = self.ink(cx);
        let first = ix == 0;
        let last = ix + 1 == self.entries.len();
        let body: AnyElement = match &e.kind {
            Kind_::Typing => said::typing(&l),
            Kind_::Ask(item, open) => {
                let drawn = if *open {
                    let card = self.card(item, &e.key, window, cx);
                    crate::asks::chat::open(card, &l)
                } else {
                    crate::asks::chat::closed(item, &l, cx)
                };
                div().flex().flex_col().min_w_0().pt(u(12.)).child(drawn).into_any_element()
            }
            Kind_::Pending(p) => self.pending(p, &e, ink, &l, window, cx),
            Kind_::Line(line) => {
                let col = div().flex().flex_col().min_w_0();
                let col = match e.lead {
                    Lead::Run => col.pt(px(2.)),
                    Lead::Apart => col.pt(u(12.)),
                    Lead::Gap(t) => col.child(gap_time(t, e.order, &self.sh.sel, &l)),
                };
                col.child(self.line(line, &e, ink, &l, window, cx)).into_any_element()
            }
        };
        div()
            .w_full()
            .flex()
            .justify_center()
            .when(first, |d| d.pt(u(12.)))
            .when(last, |d| d.pb(u(12.)))
            .child(div().w_full().when(self.width.get() >= l.z(768.), |d| d.max_w(u(720.))).px(u(12.)).flex().flex_col().child(body))
            .into_any_element()
    }

    /// Sent, not yet in the log: dimmed, its files' names, and "Not sent" if the core said no (a
    /// click gives its words back to the box, to change and send again).
    fn pending(&mut self, p: &Pending, e: &Entry, ink: Hsla, l: &Look, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let mut col = div().flex().flex_col().min_w_0().map(|d| match e.lead {
            Lead::Run => d.pt(px(2.)),
            _ => d.pt(u(12.)),
        });
        if !p.text.is_empty() || !p.reply_to.is_empty() {
            col = col.child(said::said(
                Said {
                    who: Who::User,
                    ink,
                    text: &p.text,
                    detail: None,
                    dim: true,
                    streaming: false,
                    time: None,
                    seq: None,
                    tail: e.tail,
                    reactions: None,
                    reply_to: &p.reply_to,
                    here: Some(&self.space),
                    parts: &[],
                    model: None,
                    key: &e.key,
                    order: e.order,
                    doc: None,
                    width: Some(self.col_width(l)),
                },
                &self.sh,
                l,
                window,
                cx,
            ));
        }
        if !p.files.is_empty() {
            col = col.child(attached::sending(&p.files, l));
        }
        if p.failed {
            let (id, space) = (p.id.clone(), self.space.clone());
            col = col.child(
                kit::button(SharedString::from(format!("{}.notsent", e.key)), Btn::Bare, true, l)
                    .mt(u(4.))
                    .gap(u(6.))
                    .self_end()
                    .text_size(u(12.))
                    .text_color(l.red)
                    // Its words and files back in the box, to change and send again.
                    .on_click(move |_, _, cx| model(cx).update(cx, |m, _| m.restore(&id, &format!("space:{space}"))))
                    .child(marks::stop(px(12.), l))
                    .child("Not sent"),
            );
        }
        col.into_any_element()
    }

    fn line(&mut self, line: &Arc<Line>, e: &Entry, ink: Hsla, l: &Look, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let key = e.key.clone();
        let mut out = div().flex().flex_col().min_w_0();
        if let Some(q) = &line.quiet {
            let weak = cx.entity().downgrade();
            let (k, text, time, quiet) = (key.clone(), line.text.clone(), line.time, q.clone());
            let open = Rc::new(move |anchor, _: &mut Window, cx: &mut App| {
                weak.update(cx, |this, cx| {
                    // A click on the blip that's open shuts it.
                    if this.blip.as_ref().is_some_and(|o| o.key == k) {
                        this.blip = None;
                    } else {
                        this.blip = Some(quiet::Open { key: k.clone(), anchor, text: text.clone(), time: Some(time), quiet: quiet.clone(), forgetting: false, error: None });
                    }
                    cx.notify();
                })
                .ok();
            });
            out = out.child(quiet::blip(&key, q, &line.text, e.order, &self.sh.sel, self.sh.blips.clone(), open, l));
        } else if let Some(w) = &line.widget {
            out = out.child(self.widget(&key, w, line.seq, cx));
        } else if !line.text.is_empty() || !line.reply_to.is_empty() || line.item.is_some() {
            let text = general_of(line);
            let doc = (line.who != Who::User).then(|| self.doc(line.seq, &text));
            let replies = replies_to(line);
            // A peer's name over the first of its run, as a group chat names a sender.
            if line.who == Who::Peer
                && e.lead != Lead::Run
                && let Some(from) = &line.from
            {
                out = out.child(div().self_start().px(u(12.)).pb(px(2.)).text_size(u(12.)).line_height(u(16.)).text_color(l.ink2).child(from.clone()));
            }
            out = out.child(said::said(
                Said {
                    who: line.who,
                    ink,
                    text: &text,
                    detail: line.detail.as_deref(),
                    dim: false,
                    streaming: false,
                    time: Some(line.time),
                    seq: Some(line.seq),
                    tail: e.tail,
                    reactions: Some(&line.reactions),
                    reply_to: &replies,
                    here: Some(&self.space),
                    parts: &line.parts,
                    model: line.model.as_deref(),
                    key: &key,
                    order: e.order,
                    doc,
                    width: Some(self.col_width(l)),
                },
                &self.sh,
                l,
                window,
                cx,
            ));
        }
        if line.edited && line.quiet.is_none() {
            out = out.child(div().mt(u(4.)).self_start().px(u(4.)).text_size(u(12.)).line_height(u(16.)).text_color(l.ink2).child("Edited"));
        }
        if !line.attachments.is_empty() {
            let row = self.rows.entry(key.clone()).or_default().clone();
            out = out.child(attached::attached(&line.attachments, line.who == Who::User, !general_of(line).is_empty(), &key, &row, l, window, cx));
        }
        if let Some(thread) = &e.undelivered {
            let thread = thread.clone();
            let on = !self.retrying;
            out = out.child(
                kit::press(kit::button(SharedString::from(format!("{key}.nd")), Btn::Flat, on, l).mt(u(4.)).gap(u(6.)).self_end().text_color(l.red), on, cx.listener(move |this, _, _, cx| {
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
                .aria_label("Not Delivered").child("Not Delivered")
                .child(chat_marks::not_delivered(px(14.), l)),
            );
        }
        let m = model(cx).read(cx);
        let also: Vec<(String, String, Hsla, String)> = std::iter::once(&line.home)
            .chain(line.mentions.iter())
            .filter(|x| **x != self.space)
            .filter_map(|id| {
                let s = m.brain.spaces.get(id)?;
                let st = m.derived.station(id);
                Some((id.clone(), st.code.clone(), l.ink_of(&st), s.name.clone()))
            })
            .collect();
        if !also.is_empty() {
            let right = line.who == Who::User;
            out = out.child(
                div()
                    .mt(u(4.))
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_x(u(12.))
                    .gap_y(u(4.))
                    .px(u(4.))
                    .text_size(u(12.))
                    .text_color(l.ink2)
                    .map(|d| if right { d.self_end() } else { d.self_start() })
                    .children(also.into_iter().map(|(id, code, sink, name)| {
                        let to = id.clone();
                        kit::button(SharedString::from(format!("{key}.also.{id}")), Btn::Flat, true, l)
                            .mx(u(-4.))
                            .px(u(4.))
                            .on_click(move |_, _, cx| Nav::open(Page::Space(to.clone()), cx))
                            .child(marks::ring(&code, sink, l.z(14.), l.bg, l.ink, id == HOME))
                            .child(name)
                    })),
            );
        }
        out.into_any_element()
    }

    /// An open ask's card, made once; its row is measured again as it changes.
    fn card(&mut self, item: &ActionItem, key: &str, window: &mut Window, cx: &mut Context<Self>) -> Entity<crate::asks::card::AskCard> {
        if let Some(c) = self.cards.get(&item.id) {
            return c.clone();
        }
        let c = crate::asks::card::make(item.clone(), window, cx);
        // Its Reply attaches it to the space's box (replying.rs) and puts the cursor there.
        c.update(cx, |c, _| {
            c.on_reply = Some(std::rc::Rc::new(|item: &ActionItem, window: &mut Window, cx: &mut App| {
                crate::replying::attach(&item.space, crate::brain::Reply::Ask { id: item.id.clone(), title: Some(item.title.clone()), reply: None }, cx);
                crate::chatbox::focus_box_of(&item.space, window, cx);
            }));
        });
        let k = key.to_string();
        cx.observe(&c, move |this: &mut ChatView, _, cx| {
            if let Some(ix) = this.entries.iter().position(|x| x.key == k) {
                this.list.remeasure_items(ix..ix + 1);
            }
            cx.notify();
        })
        .detach();
        self.cards.insert(item.id.clone(), c.clone());
        c
    }

    /// A widget in the chat (widgets/chat_widget.rs), made once per line; its row is measured again
    /// as what it draws changes.
    fn widget(&mut self, key: &str, w: &crate::brain::Shown, seq: u64, cx: &mut Context<Self>) -> AnyElement {
        if let Some(e) = self.widgets.get(key) {
            return e.clone().into_any_element();
        }
        let e = cx.new(|cx| crate::widgets::chat_widget::ChatWidget::new(w.clone(), seq, cx));
        let k = key.to_string();
        cx.observe(&e, move |this: &mut ChatView, _, cx| {
            if let Some(ix) = this.entries.iter().position(|x| x.key == k) {
                this.list.remeasure_items(ix..ix + 1);
            }
            cx.notify();
        })
        .detach();
        self.widgets.insert(key.to_string(), e.clone());
        e.into_any_element()
    }

    /// The words selected, when they're all in one bubble of this chat: the bar over them.
    fn words_bar(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(seq) = self.sh.sel.entry() else { return };
        let in_bubble = self.entries.iter().any(|e| matches!(&e.kind, Kind_::Line(l) if l.seq == seq && l.quiet.is_none() && l.widget.is_none()));
        let text = self.sh.sel.text().trim().to_string();
        let Some(anchor) = self.sh.sel.first_rect() else { return };
        if !in_bubble || text.is_empty() {
            return;
        }
        let mine = model(cx).read(cx).brain.part_of(seq, &text);
        let space = self.space.clone();
        self.menu.update(cx, |m, cx| m.open(Target { seq, space, quote: Some(text), mine, anchor }, window, cx));
    }

    /// Keys over the column with no field taking them: the scrolling keys move it; a letter typed,
    /// or ⌘V, goes to the box.
    fn key(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // The column's keys, with it or a key in it focused; never a field's.
        if crate::follow::in_field(window) {
            return;
        }
        let k = &e.keystroke;
        let m = &k.modifiers;
        if m.control || m.alt {
            return;
        }
        let pressing = !self.focus.is_focused(window);
        if self.typed_outside(e, pressing, window, cx) {
            return cx.stop_propagation();
        }
        // Enter and Space press the focused key.
        if pressing && matches!(k.key.as_str(), "enter" | "space") {
            return;
        }
        if self.fl.key(e) {
            cx.stop_propagation();
            cx.notify();
        }
    }

    /// Files dropped anywhere on the window join the box.
    pub fn drop_paths(&mut self, paths: &ExternalPaths, window: &mut Window, cx: &mut Context<Self>) {
        let chosen = crate::files::choose_paths(paths.paths());
        let b = self.chatbox.clone();
        b.update(cx, |b, cx| b.attach(chosen, window, cx));
    }

    /// A key no field took: a letter typed (Space too), or ⌘V, goes to the box, as it goes down.
    /// `pressing`: a button has the focus, so Space is its press, not a letter.
    pub fn typed_outside(&mut self, e: &KeyDownEvent, pressing: bool, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let k = &e.keystroke;
        let m = &k.modifiers;
        // Not with a popover open over the column: a blip's, or the reactions menu.
        if m.control || m.alt || self.blip.is_some() || self.menu.read(cx).is_open() {
            return false;
        }
        let b = self.chatbox.clone();
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

    /// A learned line's Undo: forgets the memory, putting back what it replaced.
    fn forget(&mut self, cx: &mut Context<Self>) {
        let Some(o) = self.blip.as_mut() else { return };
        let Quiet::Learned { id, restore } = o.quiet.clone() else { return };
        o.forgetting = true;
        o.error = None;
        let answer = model(cx).read(cx).forget(&id, &restore, cx);
        cx.spawn(async move |this, cx| {
            let got = answer.await;
            this.update(cx, |this, cx| {
                match got {
                    Ok(Ok(_)) => this.blip = None,
                    Ok(Err(why)) => {
                        if let Some(o) = this.blip.as_mut() {
                            o.forgetting = false;
                            o.error = Some(why);
                        }
                    }
                    Err(_) => {
                        if let Some(o) = this.blip.as_mut() {
                            o.forgetting = false;
                            o.error = Some("Can't reach the core".into());
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
}

impl Focusable for ChatView {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// ⌘C copies what's selected in a chat.
pub fn bindings() -> Vec<gpui::KeyBinding> {
    vec![gpui::KeyBinding::new("cmd-c", CopySelection, Some("Chat")), gpui::KeyBinding::new("cmd-a", ui_sdk::native::text_field::SelectAll, Some("Chat && !TextField"))]
}

impl ChatView {
    fn body(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = Look::get(cx);
        self.sync(cx);
        self.center(window);
        // A space renamed: its box's placeholder and its reading windows' title follow.
        let name = model(cx).read(cx).brain.spaces.get(&self.space).map(|s| s.name.clone()).unwrap_or_else(|| "Chat".into());
        if name != self.sh.title {
            self.sh.title = name.clone();
            let placeholder = if self.space == HOME { "Talk to Switch…".to_string() } else { format!("Talk to Switch about {name}…") };
            self.chatbox.update(cx, |b, cx| {
                b.opts.placeholder = placeholder;
                cx.notify();
            });
        }
        self.bring_into_view(cx);
        self.mark_read(window, cx);
        self.sh.sel.frame();
        let ready = model(cx).read(cx).brain.ready;
        // The agent typing is no message: "No messages" stays under its dots.
        let empty = ready && self.entries.iter().all(|e| matches!(e.kind, Kind_::Typing));
        let list = list(self.list.clone(), cx.processor(|this: &mut ChatView, ix, window, cx| this.render_entry(ix, window, cx))).size_full();
        let width = self.width.clone();
        let blip = self.blip.as_ref().map(|o| {
            let weak = cx.entity().downgrade();
            let close = Rc::new(move |_: &mut Window, cx: &mut App| {
                weak.update(cx, |this, cx| {
                    this.blip = None;
                    cx.notify();
                })
                .ok();
            });
            let weak = cx.entity().downgrade();
            let undo = Rc::new(move |_: &mut Window, cx: &mut App| {
                weak.update(cx, |this, cx| this.forget(cx)).ok();
            });
            quiet::popover(o, &self.sh.sel, close, undo, &l)
        });
        // Older history comes in within half a screen of the top.
        let top = -self.list.scroll_px_offset_for_scrollbar().y;
        if top < self.list.viewport_bounds().size.height / 2. && self.asked != Some((top, self.entries.len())) {
            self.asked = Some((top, self.entries.len()));
            let space = self.space.clone();
            model(cx).update(cx, |m, cx| m.older_chat(&space, cx));
        }
        self.fl.settle(window);
        // What floats keeps to what it's over as the column scrolls: a bubble, words chosen, a blip.
        let follow_to = self.menu.read(cx).target.as_ref().and_then(|t| if t.quote.is_some() { self.sh.sel.first_rect() } else { self.sh.bubbles.borrow().get(&t.seq).copied() });
        if let Some(b) = follow_to {
            self.menu.update(cx, |m, cx| m.set_anchor(b, cx));
        }
        if let Some(o) = self.blip.as_mut()
            && let Some(b) = self.sh.blips.borrow().get(&o.key)
        {
            o.anchor = *b;
        }
        let latest = self.fl.latest(window);
        let thumb = self.fl.thumb_shown(self.hovered).then(|| follow::thumb(&self.list, &l));
        div()
            .key_context("Chat")
            .track_focus(&self.focus)
            // Edit ▸ Copy, as ⌘C.
            // ⌘A and Edit ▸ Select All: the column's words.
            // ⌘V or Edit ▸ Paste with the column focused (no field): to the box, files and words.
            .on_action(cx.listener(|this, _: &ui_sdk::native::text_field::Paste, window, cx| {
                let b = this.chatbox.clone();
                b.update(cx, |b, cx| b.paste_outside(window, cx));
            }))
            .on_action(cx.listener(|this, _: &ui_sdk::native::text_field::SelectAll, window, _| {
                this.sh.sel.select_all();
                window.refresh();
            }))
            .on_action(cx.listener(|this, _: &ui_sdk::native::text_field::Copy, _, cx| {
                let t = this.sh.sel.text();
                if !t.is_empty() {
                    cx.write_to_clipboard(ClipboardItem::new_string(t));
                }
            }))
            .on_action(cx.listener(|this, _: &CopySelection, _, cx| {
                let t = this.sh.sel.text();
                if !t.is_empty() {
                    cx.write_to_clipboard(ClipboardItem::new_string(t));
                }
            }))
            .capture_key_down(cx.listener(|this, e: &KeyDownEvent, window, cx| {
                if this.menu.read(cx).is_open() && this.menu.update(cx, |m, cx| m.key(e, window, cx)) {
                    cx.stop_propagation();
                }
            }))
            .on_key_down(cx.listener(|this, e: &KeyDownEvent, window, cx| this.key(e, window, cx)))
            // Esc clears the reactions menu's search, then closes it; closes a blip; else it's the
            // window's.
            .on_action(cx.listener(|this, _: &crate::commands::Escape, window, cx| {
                if this.menu.read(cx).is_open() {
                    this.menu.update(cx, |m, cx| m.escape(window, cx));
                } else if this.blip.take().is_some() {
                    cx.notify();
                } else {
                    cx.propagate();
                }
            }))
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .child(
                div()
                    .id(SharedString::from(format!("chat-{}", self.space)))
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .on_hover(cx.listener(|this, h: &bool, _, cx| {
                        this.hovered = *h;
                        cx.notify();
                    }))
                    // A press on the column clears what's selected, and leaves any field.
                    .capture_any_mouse_down(cx.listener(|this, e: &gpui::MouseDownEvent, window, cx| {
                        if e.button == MouseButton::Left && !e.modifiers.shift && e.click_count == 1 {
                            this.sh.sel.clear();
                            if this.menu.read(cx).target.as_ref().is_some_and(|t| t.quote.is_some()) {
                                this.menu.update(cx, |m, cx| m.close(window, cx));
                            }
                        }
                    }))
                    // And takes the focus from any field, unless what's under it kept it (Latest
                    // leaves it in the box) or took it (a key of its own).
                    .on_any_mouse_down(cx.listener(|this, _: &gpui::MouseDownEvent, window, cx| {
                        if !window.default_prevented() {
                            window.focus(&this.focus, cx);
                        }
                    }))
                    .child(gpui::canvas(move |b, _, _| width.set(b.size.width), |_, _, _, _| {}).absolute().size_full())
                    .child(list)
                    .child({
                        let (view, up) = (self.list.clone(), cx.entity().downgrade());
                        let moved = cx.entity().downgrade();
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
                            // The selection settles as the press is let go.
                            move |window, cx| {
                                up.update(cx, |this, cx| this.words_bar(window, cx)).ok();
                            },
                        )
                    })
                    .children(thumb.map(|t| div().absolute().top_0().left_0().size_full().child(t).child(crate::follow::thumb_cut())))
                    .when(empty, |d| {
                        d.child(div().absolute().top_0().left_0().size_full().flex().items_center().justify_center().text_size(u(13.)).text_color(l.ink2).child("No messages"))
                    })
                    .when(latest, |d| {
                        d.child(
                            div().absolute().right(u(16.)).bottom(u(12.)).child(crate::webview::cutting()).child(
                                kit::button("latest", Btn::Key, true, &l).aria_label("Jump to latest")
                                    .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
                                    .on_click(cx.listener(|this, _, _, cx| this.follow(cx)))
                                    .child("Latest ↓"),
                            ),
                        )
                    }),
            )
            .child(self.chatbox.clone())
            .child(self.menu.clone())
            .children(blip)
    }
}

impl Render for ChatView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.rem = window.rem_size();
        crate::boundary::guard("chat", window, cx, |window, cx| self.body(window, cx).into_any_element())
    }
}

/// A key in its hairline, as a UI SDK button's root draws it.
pub fn key_look(part: ui_sdk::kernel::Part<ui_sdk::components::button::ButtonState>, l: &Look) -> ui_sdk::kernel::Part<ui_sdk::components::button::ButtonState> {
    part.h(u(22.))
        .px(u(8.))
        .flex()
        .items_center()
        .gap(u(6.))
        .rounded(u(4.))
        .border_1()
        .border_color(l.key_border)
        .bg(l.bg)
        .text_size(u(12.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(l.ink)
        .hover(|s| s.bg(l.hover))
}
