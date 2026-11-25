//! The brain in the window: one entity every view observes, the desktop's `client.ts` and its query
//! cache. The network's news folds in here, in batches, and what the views show is worked out once
//! per change (`Derived`). Pages go out through `Net` and come back here; every command the views
//! send is a method in `commands.rs`, and every read that isn't the sync is in `queries.rs`.
//! Views that want each live event (widgets refreshing on the events they name), a box's words
//! given back, or the snapshot's arrival subscribe to `BrainEvent`.
// The typed API the views use; parts not yet drawn are still the API.
#![allow(dead_code)]

use std::collections::HashMap;
use std::time::{Duration, Instant};

use futures::StreamExt;
use futures::channel::mpsc::UnboundedReceiver;
use gpui::{AppContext, Context, Entity, EventEmitter, Global};
use serde_json::{Value, json};

use crate::files::Chosen;

use crate::brain::{Brain, Event, Link, PageOf, Pending, Reply};
use crate::derive::Derived;
use crate::files::Upload;
use crate::net::{DOWN, Incoming, Net};
use crate::outbox;

/// Live events as they're folded in, for what refreshes on them (widgets' data).
pub struct Heard(pub std::rc::Rc<Vec<Event>>);
impl EventEmitter<Heard> for Model {}

/// What else a view may want to hear besides a redraw.
#[derive(Clone, Debug)]
pub enum BrainEvent {
    /// The live snapshot landed.
    Snapshot,
    /// Words came back to a box (`space:<id>`, `thread:<id>`) from outside it.
    Restored(String),
}

/// Before every seq: the latest page.
const LATEST: u64 = 9007199254740991;

pub struct Model {
    pub brain: Brain,
    pub derived: Derived,
    /// The code the core waits on, while this app pairs.
    pub pairing: Option<String>,
    /// The core and credential are known.
    pub authed: bool,
    pub link: Link,
    /// When the socket last dropped, while it's down.
    dropped: Option<Instant>,
    /// When the window was made, and when the snapshot first came: its startup.
    pub started: Instant,
    pub first_snapshot: Option<Duration>,
    /// Each chosen file's upload, by its id.
    pub uploads: HashMap<String, Upload>,
    /// A line to bring into view in a space's chat, by seq: older pages come in until it's held.
    pub reach: HashMap<String, u64>,
}

pub struct ModelHandle(pub Entity<Model>);
impl Global for ModelHandle {}

impl EventEmitter<BrainEvent> for Model {}

impl Model {
    pub fn new(incoming: UnboundedReceiver<Incoming>, started: Instant, cx: &mut Context<Self>) -> Self {
        cx.spawn(async move |this, cx| {
            let mut incoming = incoming.ready_chunks(256);
            while let Some(batch) = incoming.next().await {
                if this.update(cx, |m, cx| m.take(batch, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        let mut brain = Brain::new();
        // The last run's snapshot, so the first frame is in its final layout; the core's replaces it.
        if let Some(snap) = crate::net::held_snapshot() {
            brain.take_snapshot(snap);
            brain.kept = true;
        }
        let derived = Derived::of(&brain);
        let mut m = Model {
            brain,
            derived,
            pairing: None,
            authed: false,
            link: Link::Connecting,
            dropped: None,
            started,
            first_snapshot: None,
            uploads: HashMap::new(),
            reach: HashMap::new(),
        };
        m.follow_outbox();
        m.refresh();
        m
    }

    fn take(&mut self, batch: Vec<Incoming>, cx: &mut Context<Self>) {
        let mut changed = false;
        for m in batch {
            match m {
                Incoming::Pairing(code) => {
                    self.pairing = Some(code);
                    changed = true;
                }
                Incoming::Authed => {
                    self.authed = true;
                    changed = true;
                }
                Incoming::Snapshot(snap) => {
                    self.pairing = None;
                    self.brain.take_snapshot(*snap);
                    if self.first_snapshot.is_none() {
                        let took = self.started.elapsed();
                        self.first_snapshot = Some(took);
                        log::info!("snapshot in {} ms", took.as_millis());
                    }
                    cx.emit(BrainEvent::Snapshot);
                    changed = true;
                }
                Incoming::Events(events) => {
                    self.brain.apply(&events);
                    crate::queries::on_events(&events, cx);
                    cx.emit(Heard(std::rc::Rc::new(events)));
                    changed = true;
                }
                Incoming::Link(link) => {
                    self.set_link(link, cx);
                    changed = true;
                }
                Incoming::Closed => self.closed(cx),
                // Its line is in once the log reaches `seq`; it shows as sent till then.
                Incoming::Receipt(id, seq) => {
                    self.brain.landed(&id, seq);
                    changed = true;
                }
                Incoming::Outbox => changed |= self.follow_outbox(),
                Incoming::Restored(place) => cx.emit(BrainEvent::Restored(place)),
            }
        }
        if changed {
            self.refresh();
            cx.notify();
        }
    }

    /// The messages kept in the outbox, as the chat shows them.
    fn follow_outbox(&mut self) -> bool {
        let now: Vec<Pending> = outbox::kept()
            .into_iter()
            .filter(|e| e.name == "message.post")
            .filter_map(|e| {
                let space = e.payload.get("space")?.as_str()?.to_string();
                let text = e.payload.get("text")?.as_str()?.to_string();
                // Read all or nothing, as the desktop decodes the view.
                // Each file up already draws from here under its blob.
                for f in e.files.iter().flatten() {
                    if let Some(b) = &f.blob {
                        crate::own::up(b, &f.id, &f.name);
                    }
                }
                let reply_to: Vec<Reply> = e.view.as_ref().and_then(|v| v.get("replyTo")).and_then(crate::brain::replies_strict).unwrap_or_default();
                Some(Pending {
                    id: e.id,
                    space,
                    text,
                    files: e.files.unwrap_or_default(),
                    failed: e.rejected.is_some(),
                    landed: None,
                    reply_to,
                })
            })
            .collect();
        self.brain.follow_outbox(now)
    }

    /// As connection.ts says it: connecting at each attempt, open once it opens, and down when a
    /// close lasts (`DOWN`) with no open since.
    fn set_link(&mut self, link: Link, _cx: &mut Context<Self>) {
        if link == Link::Open {
            self.dropped = None;
        }
        self.link = link;
    }

    fn closed(&mut self, cx: &mut Context<Self>) {
        let at = Instant::now();
        self.dropped = Some(at);
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(DOWN).await;
            this.update(cx, |m, cx| {
                if m.dropped == Some(at) {
                    m.link = Link::Down;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn refresh(&mut self) {
        if self.derived.version != self.brain.version {
            self.derived = Derived::of(&self.brain);
        }
    }

    /// A space's chat, asked for when it isn't held (or the brain moved lines): its latest page.
    pub fn want_chat(&mut self, space: &str, cx: &mut Context<Self>) {
        let held = self.brain.chats.get(space);
        if held.is_some_and(|c| (c.loaded && !c.stale) || c.fetching || c.retry_at.is_some_and(|t| Instant::now() < t)) {
            return;
        }
        let chat = self.brain.chats.entry(space.to_string()).or_default();
        chat.fetching = true;
        if chat.loaded && chat.stale {
            let pages = chat.pages;
            self.refetch(PageOf::Chat(space.into()), pages, cx);
        } else {
            self.page(PageOf::Chat(space.into()), None, cx);
        }
    }

    /// The page before what's held, once at a time.
    pub fn older_chat(&mut self, space: &str, cx: &mut Context<Self>) {
        let Some(chat) = self.brain.chats.get_mut(space) else { return };
        if !chat.loaded || !chat.more || chat.fetching {
            return;
        }
        // From the last page's first line, as pages.ts asks: an empty page has no next one.
        let Some(before) = chat.next else { return };
        chat.fetching = true;
        self.page(PageOf::Chat(space.into()), Some(before), cx);
    }

    /// Brings line `seq` of a space's chat into what's held: older pages come in until it is.
    pub fn reach_chat(&mut self, space: &str, seq: u64, cx: &mut Context<Self>) {
        self.reach.insert(space.into(), seq);
        self.go_on_reaching(space, cx);
    }

    fn go_on_reaching(&mut self, space: &str, cx: &mut Context<Self>) {
        let Some(&seq) = self.reach.get(space) else { return };
        let Some(chat) = self.brain.chats.get(space) else { return };
        let oldest = chat.lines.first().map(|l| l.seq);
        if chat.loaded && chat.more && chat.next.is_some() && oldest.is_some_and(|o| o > seq) {
            self.older_chat(space, cx);
        } else if chat.loaded {
            self.reach.remove(space);
        }
    }

    pub fn want_thread(&mut self, thread: &str, cx: &mut Context<Self>) {
        let held = self.brain.transcripts.get(thread);
        if held.is_some_and(|t| t.loaded || t.fetching || t.failed.is_some()) {
            return;
        }
        let t = self.brain.transcripts.entry(thread.to_string()).or_default();
        t.fetching = true;
        // Paged before a snapshot: every page it held is asked for again.
        if t.pages > 0 {
            let pages = t.pages;
            self.refetch(PageOf::Thread(thread.into()), pages, cx);
        } else {
            self.page(PageOf::Thread(thread.into()), None, cx);
        }
    }

    /// A first page that failed, asked again.
    pub fn retry_thread(&mut self, thread: &str, cx: &mut Context<Self>) {
        if let Some(t) = self.brain.transcripts.get_mut(thread) {
            t.failed = None;
        }
        self.want_thread(thread, cx);
    }

    pub fn older_thread(&mut self, thread: &str, cx: &mut Context<Self>) {
        let Some(t) = self.brain.transcripts.get_mut(thread) else { return };
        if !t.loaded || !t.more || t.fetching {
            return;
        }
        let Some(before) = t.next else { return };
        t.fetching = true;
        self.page(PageOf::Thread(thread.into()), Some(before), cx);
    }

    /// A page of a chat or a transcript, asked again once after a second when it fails (the query
    /// client's one retry).
    fn ask(&self, of: &PageOf, before: u64, cx: &mut Context<Self>) -> gpui::Task<Result<Value, String>> {
        let net = cx.global::<Net>().clone();
        let (name, args) = match of {
            PageOf::Chat(space) => ("chat", json!({ "space": space, "before": before })),
            PageOf::Thread(thread) => ("thread", json!({ "thread": thread, "before": before })),
        };
        let timer = cx.background_executor().clone();
        cx.background_executor().spawn(async move {
            let mut got = net.page(name, args.clone()).await.unwrap_or_else(|_| Err("Can't reach the core".into()));
            if got.is_err() {
                timer.timer(Duration::from_secs(1)).await;
                got = net.page(name, args).await.unwrap_or_else(|_| Err("Can't reach the core".into()));
            }
            got
        })
    }

    fn page(&mut self, of: PageOf, before: Option<u64>, cx: &mut Context<Self>) {
        let first = before.is_none();
        let answer = self.ask(&of, before.unwrap_or(LATEST), cx);
        cx.spawn(async move |this, cx| {
            let got = answer.await;
            this.update(cx, |m, cx| {
                match (&of, got) {
                    (PageOf::Chat(space), Ok(v)) => {
                        m.brain.take_chat_page(space, &v, first);
                        m.go_on_reaching(space, cx);
                    }
                    (PageOf::Thread(thread), Ok(v)) => m.brain.take_thread_page(thread, &v, first),
                    (PageOf::Chat(space), Err(_)) => {
                        if let Some(c) = m.brain.chats.get_mut(space) {
                            c.fetching = false;
                            if first {
                                c.backoff();
                            }
                        }
                        // A line being brought into view keeps asking, as use-chat.ts's effect
                        // asks again each time a page is no longer on its way.
                        if !first {
                            m.go_on_reaching(space, cx);
                        }
                    }
                    // A first page that failed is the page's to show; an older one is asked again on scroll.
                    (PageOf::Thread(thread), Err(reason)) => {
                        if let Some(t) = m.brain.transcripts.get_mut(thread) {
                            t.fetching = false;
                            if first {
                                t.failed = Some(reason);
                            }
                        }
                        m.brain.version += 1;
                    }
                }
                m.refresh();
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// A chat the brain moved lines in or out of, or a transcript a snapshot dropped, asked for
    /// again page for page, as many as were held, each from the one before; what's held stays
    /// until they're all in.
    fn refetch(&mut self, of: PageOf, pages: usize, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let key = match &of {
                PageOf::Chat(_) => "lines",
                PageOf::Thread(_) => "items",
            };
            let mut got: Vec<Value> = vec![];
            let mut before = LATEST;
            let mut failed = None;
            while got.len() < pages.max(1) {
                let Ok(ask) = this.update(cx, |m, cx| m.ask(&of, before, cx)) else { return };
                match ask.await {
                    Ok(v) => {
                        let rows = crate::json::list(crate::json::get(&v, key));
                        let more = crate::json::gb(&v, "more");
                        let oldest = rows.first().map(|l| crate::json::gu(l, "seq"));
                        got.push(v);
                        match (more, oldest) {
                            (true, Some(o)) => before = o,
                            _ => break,
                        }
                    }
                    Err(reason) => {
                        failed = Some(reason);
                        break;
                    }
                }
            }
            this.update(cx, |m, cx| {
                match (&of, got.is_empty()) {
                    (PageOf::Chat(space), true) => {
                        if let Some(c) = m.brain.chats.get_mut(space) {
                            c.fetching = false;
                            c.backoff();
                        }
                    }
                    (PageOf::Chat(space), false) => {
                        m.brain.take_chat_pages(space, &got);
                        m.go_on_reaching(space, cx);
                    }
                    // Its first page failed: the page says so.
                    (PageOf::Thread(thread), true) => {
                        if let Some(t) = m.brain.transcripts.get_mut(thread) {
                            t.fetching = false;
                            t.failed = Some(failed.unwrap_or_else(|| "Can't reach the core".into()));
                        }
                        m.brain.version += 1;
                    }
                    (PageOf::Thread(thread), false) => m.brain.take_thread_pages(thread, &got),
                }
                m.refresh();
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// A page of the brain's view, over the socket: find, the memory and system pages.
    pub fn ask_page(&self, name: &str, args: Value, cx: &mut Context<Self>) -> gpui::Task<Result<Value, String>> {
        let rx = cx.global::<Net>().page(name, args);
        cx.background_executor().spawn(async move { rx.await.unwrap_or_else(|_| Err("Can't reach the core".into())) })
    }
}

/// A message to post: its words, which of them were dictated (`{start, text}` in code points), the
/// files chosen for it (kept here, uploaded by the outbox before it goes) or ones already up as the
/// brain takes them (`{blob, name, type, size}`), and what it replies to.
#[derive(Clone, Default)]
pub struct Post {
    pub id: Option<String>,
    pub space: String,
    pub text: String,
    pub dictated: Vec<Value>,
    pub files: Vec<Chosen>,
    pub attachments: Vec<Value>,
    pub reply_to: Vec<Reply>,
}

/// What the brain answered a command: the seq it landed at, or its reason.
pub type Answer = futures::channel::oneshot::Receiver<Result<u64, String>>;

impl Model {
    /// Any command, as the core takes it, kept on this Mac until the brain answers; answers the seq
    /// it landed at or the brain's reason.
    pub fn command(&self, name: &str, payload: Value, cx: &gpui::App) -> Answer {
        self.command_as(uuid::Uuid::new_v4().to_string(), name, payload, cx)
    }

    /// A command under a given id: a resend with the same id is a no-op in the brain.
    pub fn command_as(&self, id: String, name: &str, payload: Value, cx: &gpui::App) -> Answer {
        let (tx, rx) = futures::channel::oneshot::channel();
        let answer = cx.global::<Net>().command(id, name, payload);
        cx.background_executor()
            .spawn(async move {
                let got = answer.await.unwrap_or_else(|_| Err("Can't reach the core".into()));
                let _ = tx.send(got);
            })
            .detach();
        rx
    }

    /// Words alone, to a space.
    pub fn post(&mut self, space: &str, text: String, cx: &mut Context<Self>) {
        self.post_message(Post { space: space.into(), text, ..Default::default() }, cx);
    }

    /// A message, kept in the outbox at once with its files (their bytes kept as they were
    /// attached), which uploads them and sends it; the chat shows it from there, as sent until its
    /// line lands, and "Not sent" if the core says no.
    pub fn post_message(&mut self, post: Post, cx: &mut Context<Self>) {
        let id = post.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let mut payload = json!({ "space": post.space, "text": post.text });
        if !post.dictated.is_empty() {
            payload["dictated"] = Value::Array(post.dictated);
        }
        if !post.attachments.is_empty() {
            payload["attachments"] = Value::Array(post.attachments);
        }
        if !post.reply_to.is_empty() {
            payload["replyTo"] = Value::Array(post.reply_to.iter().map(|r| r.to_json()).collect());
        }
        let mut e = outbox::Entry::command(id, "message.post", payload);
        if !post.files.is_empty() {
            e.files = Some(post.files.iter().map(|c| crate::files::kept_of(c, &self.uploads)).collect());
        }
        if !post.reply_to.is_empty() {
            e.view = Some(json!({ "replyTo": post.reply_to.iter().map(|r| r.to_kept()).collect::<Vec<_>>() }));
        }
        if let Err(why) = crate::checks::checked("message.post", &e.payload) {
            log::warn!("a message didn't go: {why}");
            return;
        }
        outbox::keep(e);
        self.follow_outbox();
        self.refresh();
        cx.notify();
    }

    /// A space's chat read through `seq`: its unread mark clears at once, here and on every device.
    pub fn read(&mut self, space: &str, seq: u64, cx: &mut Context<Self>) {
        self.brain.read_mark(space, seq);
        self.refresh();
        let _ = self.command("space.read", json!({ "space": space, "seq": seq }), cx);
        cx.notify();
    }

    /// The user's tapback on a message, as iMessage's: the same one again takes it off, another
    /// replaces it; on its words alone with `quote`. Shown at once, put back if the brain says no.
    pub fn react(&mut self, seq: u64, reaction: String, was: Option<String>, quote: Option<String>, cx: &mut Context<Self>) {
        let now = (Some(&reaction) != was.as_ref()).then(|| reaction.clone());
        let show = move |b: &mut Brain, r: Option<String>, quote: &Option<String>| match quote {
            None => b.set_reaction(seq, true, r),
            Some(q) => b.set_part(seq, true, q, r),
        };
        show(&mut self.brain, now.clone(), &quote);
        self.refresh();
        let mut payload = json!({ "seq": seq, "reaction": now });
        if let Some(q) = &quote {
            payload["quote"] = json!({ "text": q });
        }
        let answer = self.command("message.react", payload, cx);
        cx.spawn(async move |this, cx| {
            if !matches!(answer.await, Ok(Ok(_))) {
                this.update(cx, |m, cx| {
                    show(&mut m.brain, was.clone(), &quote);
                    m.refresh();
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
        cx.notify();
    }

    /// The user's last message, changed; the brain runs it again or sends it new.
    pub fn edit_message(&self, seq: u64, text: String, cx: &gpui::App) -> Answer {
        self.command("message.edit", json!({ "seq": seq, "text": text }), cx)
    }

    /// Runs a turn that didn't finish again.
    pub fn retry(&self, thread: &str, cx: &gpui::App) -> Answer {
        self.command("thread.retry", json!({ "thread": thread }), cx)
    }

    /// Stops a thread's running turn.
    pub fn stop(&self, thread: &str, cx: &gpui::App) -> Answer {
        self.command("thread.stop", json!({ "thread": thread }), cx)
    }

    /// Words for a running thread to take in.
    pub fn steer(&self, thread: &str, text: String, dictated: Vec<Value>, cx: &gpui::App) -> Answer {
        let mut payload = json!({ "thread": thread, "text": text });
        if !dictated.is_empty() {
            payload["dictated"] = Value::Array(dictated);
        }
        self.command("thread.steer", payload, cx)
    }

    /// Forgets a memory, putting back what it replaced: the memory page's Forget, a line's Undo.
    pub fn forget(&self, id: &str, restore: &[String], cx: &gpui::App) -> Answer {
        let mut payload = json!({ "id": id });
        if !restore.is_empty() {
            payload["restore"] = json!(restore);
        }
        let answer = self.command("memory.forget", payload, cx);
        let (tx, rx) = futures::channel::oneshot::channel();
        cx.spawn(async move |cx| {
            let got = answer.await.unwrap_or_else(|_| Err("Can't reach the core".into()));
            if got.is_ok() {
                cx.update(|cx| crate::queries::invalidate(crate::queries::MEMORIES, cx));
            }
            let _ = tx.send(got);
        })
        .detach();
        rx
    }

    /// A change shown at once, before the brain answers (the desktop's `change`).
    pub fn change(&mut self, f: impl FnOnce(&mut Brain), cx: &mut Context<Self>) {
        f(&mut self.brain);
        self.brain.version += 1;
        self.refresh();
        cx.notify();
    }
}

pub fn model(cx: &gpui::App) -> Entity<Model> {
    cx.global::<ModelHandle>().0.clone()
}

pub fn new_model(incoming: UnboundedReceiver<Incoming>, started: Instant, cx: &mut gpui::App) -> Entity<Model> {
    let m = cx.new(|cx| Model::new(incoming, started, cx));
    cx.set_global(ModelHandle(m.clone()));
    m
}
