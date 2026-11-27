//! A document read in its own window (Switch's catalog's Document, `widgets/house/document.rs`):
//! its words a section at a time down a centred column (a PDF's pages numbered), every word
//! selectable. A selection opens a popover under it: a word's dictionary senses and an article's
//! summary when its extension finds them, and Ask, which starts a thread about that passage; a
//! link to Wikipedia opens its article's summary there too. Threads live down the right: each its
//! passage (marked in the words, a click opens it) and its questions and answers, with a box to ask
//! the next, never in a space's chat. Highlights are washed in yellow. Esc closes the popover, then
//! the thread, then the window; ⌘D looks up what's selected, ⇧⌘H highlights it, Return asks about
//! it.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext, ClipboardItem, Context, Entity, FocusHandle, Focusable, FontWeight, InteractiveElement, IntoElement, KeyDownEvent, ListAlignment,
    ListOffset, ListState, MouseButton, ParentElement, Pixels, Point, Render, SharedString, StatefulInteractiveElement, Styled, Task, WeakEntity, Window, anchored, deferred,
    div, img, list, point, prelude::*, px,
};
use serde_json::{Value, json};
use ui_sdk::components::input::{Textarea, TextareaOptions, TextareaSubmitShortcut};

use crate::kit::{self, Btn};
use crate::look::{Look, SANS, u};
use crate::markdown::{self, Doc, Mark};
use crate::select::{Key, Sel};

/// The tools a document's extension answers it with, by their names there.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tools {
    pub content: String,
    pub define: String,
    pub ask: String,
    pub highlight: String,
    pub unhighlight: String,
}

/// A passage, as its extension keeps it (W3C's text quote): its section, its words, and a little
/// of what's around them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Quote {
    pub section: u64,
    pub exact: String,
    pub prefix: String,
    pub suffix: String,
}

impl Quote {
    fn of(v: &Value) -> Option<Quote> {
        let exact = v.get("exact")?.as_str()?.to_string();
        Some(Quote {
            section: v.get("section").and_then(Value::as_u64).unwrap_or(0),
            exact,
            prefix: v.get("prefix").and_then(Value::as_str).unwrap_or_default().to_string(),
            suffix: v.get("suffix").and_then(Value::as_str).unwrap_or_default().to_string(),
        })
    }

    fn json(&self) -> Value {
        json!({ "section": self.section, "exact": self.exact, "prefix": self.prefix, "suffix": self.suffix })
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Message {
    user: bool,
    text: String,
    failed: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct Thread {
    id: String,
    quote: Option<Quote>,
    messages: Vec<Message>,
    waiting: bool,
}

/// What the document's widget data says: its title, size, highlights and threads.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Data {
    pub title: String,
    pub paged: bool,
    pub version: u64,
    pub highlights: Value,
    pub threads: Value,
    pub open: String,
}

/// A section's words, read once.
struct Section {
    label: Option<String>,
    doc: Rc<Doc>,
}

/// What a lookup found: a word's senses and an article's summary.
#[derive(Clone, Debug, Default)]
struct Found {
    word: String,
    senses: Vec<(String, String)>,
    dictionary: Option<String>,
    article: Option<Article>,
}

#[derive(Clone, Debug)]
struct Article {
    title: String,
    description: String,
    extract: String,
    url: String,
    thumbnail: Option<String>,
}

enum Looked {
    /// Not looked up: a passage, not a word.
    No,
    Looking,
    Found(Found),
    Failed,
}

/// The popover over a selection or a link.
struct Pop {
    /// Under what it's about; `top` is that thing's top, for when there's no room under it.
    at: Point<Pixels>,
    top: Pixels,
    quote: Option<Quote>,
    looked: Looked,
    ask: Entity<Textarea>,
    _task: Option<Task<()>>,
}

/// A question asked and not yet in the data.
#[derive(Clone)]
struct Asking {
    question: String,
    quote: Option<Quote>,
    failed: Option<String>,
}

pub struct Reader {
    app: String,
    doc: String,
    tools: Tools,
    data: Data,
    highlights: Vec<(String, Quote)>,
    threads: Vec<Thread>,
    sections: Vec<Section>,
    loaded: Option<u64>,
    loading: Option<Task<()>>,
    failed: Option<String>,
    list: ListState,
    sel: Sel,
    focus: FocusHandle,
    pop: Option<Pop>,
    /// The thread open in the panel; `None` lists them.
    open: Option<String>,
    opened_from_data: bool,
    asking: HashMap<String, Asking>,
    composer: Entity<Textarea>,
    /// Where each mark was drawn this frame, by what it names: for bringing a passage into view.
    drawn: Rc<RefCell<HashMap<String, (Key, Range<usize>)>>>,
    /// A passage to bring into view once it's drawn.
    reveal: Option<String>,
    hovered: bool,
    last_mouse: Point<Pixels>,
    /// An error from a highlight or a lookup's own call.
    note: Option<String>,
    /// The highlight the popover is over, which it can take away.
    held: Option<String>,
    /// The panel's own words, selectable apart from the document's.
    panel_sel: Sel,
    panel_scroll: gpui::ScrollHandle,
}

const MEASURE: f32 = 680.;
const PANEL: f32 = 360.;

fn new_id() -> String {
    format!("th-{}", uuid::Uuid::new_v4().simple().to_string().chars().take(10).collect::<String>())
}

fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

/// At most `n` characters from the end of `s`.
fn tail(s: &str, n: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    chars[chars.len().saturating_sub(n)..].iter().collect()
}

fn head(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Where a passage is in one run of words: all of it, or its part in this run when it spans runs
/// (its words split where a copy joins runs).
fn find(run: &str, q: &Quote) -> Option<Range<usize>> {
    let frags: Vec<&str> = q.exact.split(['\n', '\t']).map(str::trim).filter(|f| !f.is_empty()).collect();
    match frags.as_slice() {
        [] => None,
        [one] => {
            let hits: Vec<usize> = run.match_indices(one).map(|(i, _)| i).collect();
            let best = hits.iter().copied().find(|i| {
                let before = &run[..*i];
                !q.prefix.is_empty() && (before.ends_with(q.prefix.trim()) || q.prefix.trim().ends_with(before.trim()) && !before.trim().is_empty())
            });
            let at = best.or(hits.first().copied())?;
            Some(at..at + one.len())
        }
        [first, middle @ .., last] => {
            let t = run.trim_end();
            if t.ends_with(first) && t.len() >= first.len() {
                return Some(t.len() - first.len()..t.len());
            }
            if middle.iter().any(|m| run.trim() == *m) {
                let lead = run.len() - run.trim_start().len();
                return Some(lead..lead + run.trim().len());
            }
            let lead = run.len() - run.trim_start().len();
            run.trim_start().starts_with(last).then(|| lead..lead + last.len())
        }
    }
}

/// A selection short enough to look up: a few words, no sentence.
fn wordish(s: &str) -> bool {
    let t = s.trim();
    !t.is_empty() && t.chars().count() <= 48 && t.split_whitespace().count() <= 4 && !t.contains(". ")
}

fn is_wikipedia(url: &str) -> bool {
    url::Url::parse(url).ok().is_some_and(|u| u.host_str().is_some_and(|h| h.ends_with(".wikipedia.org")) && u.path().starts_with("/wiki/"))
}

impl Reader {
    pub fn new(app: String, doc: String, tools: Tools, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let web = crate::widgets::media::WebPictures::entity(cx);
        cx.observe(&web, |_, _, cx| cx.notify()).detach();
        let pictures = crate::pictures::Pictures::entity(cx);
        cx.observe(&pictures, |_, _, cx| cx.notify()).detach();
        let beat = crate::nav::Beat::entity(cx);
        cx.observe(&beat, |this: &mut Reader, _, cx| {
            if this.busy() {
                cx.notify();
            }
        })
        .detach();
        let me = cx.entity().downgrade();
        let composer = cx.new(|cx| Textarea::new(Self::box_options("Ask…", me, None), window, cx));
        Reader {
            app,
            doc,
            tools,
            data: Data::default(),
            highlights: vec![],
            threads: vec![],
            sections: vec![],
            loaded: None,
            loading: None,
            failed: None,
            list: ListState::new(0, ListAlignment::Top, px(1200.)),
            sel: Sel::new(),
            focus: cx.focus_handle(),
            pop: None,
            open: None,
            opened_from_data: false,
            asking: HashMap::new(),
            composer,
            drawn: Rc::default(),
            reveal: None,
            hovered: false,
            last_mouse: point(px(0.), px(0.)),
            note: None,
            held: None,
            panel_sel: Sel::new(),
            panel_scroll: gpui::ScrollHandle::new(),
        }
    }

    /// A box that asks on Return: the panel's (a thread's next question) or a popover's (a new
    /// thread about its passage).
    fn box_options(placeholder: &str, me: WeakEntity<Reader>, quote: Option<Quote>) -> TextareaOptions {
        TextareaOptions::default()
            .placeholder(placeholder.to_string())
            .rows(1)
            .auto_resize(true)
            .submit_shortcut(TextareaSubmitShortcut::Enter)
            .field_style(kit::field_style())
            .on_submit(move |value, _, window, cx| {
                let question = value.trim().to_string();
                if question.is_empty() {
                    return;
                }
                let quote = quote.clone();
                me.update(cx, |r, cx| r.submitted(question, quote, window, cx)).ok();
            })
    }

    fn busy(&self) -> bool {
        self.loading.is_some() || matches!(self.pop.as_ref().map(|p| &p.looked), Some(Looked::Looking)) || self.threads.iter().any(|t| t.waiting) || self.asking.values().any(|a| a.failed.is_none())
    }

    pub fn focus(&self) -> FocusHandle {
        self.focus.clone()
    }

    /// The widget's data as it is now: a change redraws, a new version reads the words again.
    pub fn take(&mut self, data: Data, cx: &mut Context<Self>) {
        if data == self.data {
            if self.loaded.is_none() && self.loading.is_none() && self.failed.is_none() {
                self.load(cx);
            }
            return;
        }
        let version_moved = data.version != self.data.version;
        self.highlights = data.highlights.as_array().into_iter().flatten().filter_map(|h| Some((str_of(h, "id").to_string(), Quote::of(h)?))).collect();
        self.threads = data
            .threads
            .as_array()
            .into_iter()
            .flatten()
            .map(|t| Thread {
                id: str_of(t, "id").to_string(),
                quote: t.get("quote").and_then(Quote::of),
                waiting: t.get("waiting").and_then(Value::as_bool).unwrap_or(false),
                messages: t
                    .get("messages")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|m| Message { user: str_of(m, "role") == "user", text: str_of(m, "text").to_string(), failed: m.get("failed").and_then(Value::as_str).map(str::to_string) })
                    .collect(),
            })
            .collect();
        // What the data now holds is no longer only ours.
        let held: Vec<String> = self.threads.iter().map(|t| t.id.clone()).collect();
        self.asking.retain(|id, a| a.failed.is_some() || !held.contains(id) || self.threads.iter().find(|t| &t.id == id).is_some_and(|t| !t.messages.iter().any(|m| m.user && m.text == a.question)));
        if !self.opened_from_data && !data.open.is_empty() {
            self.opened_from_data = true;
            self.open = Some(data.open.clone());
            self.reveal = Some(data.open.clone());
        }
        self.data = data;
        if version_moved || (self.loaded.is_none() && self.loading.is_none()) {
            self.load(cx);
        }
        cx.notify();
    }

    /// Reads the document's words, a section at a time, off the main thread.
    fn load(&mut self, cx: &mut Context<Self>) {
        if self.tools.content.is_empty() || self.doc.is_empty() {
            return;
        }
        let version = self.data.version;
        let call = crate::model::model(cx).update(cx, |m, cx| m.call_checked(&self.app, &self.tools.content, json!({ "doc": self.doc }), cx));
        self.failed = None;
        self.loading = Some(cx.spawn(async move |this, cx| {
            let got = call.await;
            let read = match got {
                Ok(answer) => {
                    let sections = answer.pointer("/structuredContent/sections").cloned().unwrap_or(Value::Null);
                    let parsed = cx
                        .background_executor()
                        .spawn(async move {
                            sections
                                .as_array()
                                .into_iter()
                                .flatten()
                                .map(|s| (s.get("label").and_then(Value::as_str).map(str::to_string), Doc::reading(str_of(s, "markdown"))))
                                .collect::<Vec<_>>()
                        })
                        .await;
                    Ok(parsed)
                }
                Err(e) => Err(e),
            };
            this.update(cx, |r, cx| {
                r.loading = None;
                match read {
                    Ok(parsed) => {
                        let first = r.loaded.is_none();
                        let at = r.list.logical_scroll_top();
                        r.sections = parsed.into_iter().map(|(label, doc)| Section { label, doc: Rc::new(doc) }).collect();
                        r.list.reset(r.sections.len());
                        if !first {
                            r.list.scroll_to(at);
                        }
                        r.loaded = Some(version);
                    }
                    Err(e) => r.failed = Some(e),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn call(&self, tool: &str, args: Value, cx: &mut Context<Self>) -> Task<Result<Value, String>> {
        crate::model::model(cx).update(cx, |m, cx| m.call_checked(&self.app, tool, args, cx))
    }

    /// The selection as a passage: its section, its words, and a little either side.
    fn quote(&self) -> Option<Quote> {
        let (from, to) = self.sel.range()?;
        let exact = self.sel.text();
        if exact.trim().is_empty() {
            return None;
        }
        let run = |k: Key| self.sel.runs(k..=k).into_iter().next().map(|(_, t)| t.to_string()).unwrap_or_default();
        let a = run(from.key);
        let b = run(to.key);
        Some(Quote {
            section: from.key.0,
            exact,
            prefix: tail(a.get(..from.offset).unwrap_or_default(), 40),
            suffix: head(b.get(to.offset..).unwrap_or_default(), 40),
        })
    }

    /// Where a popover goes: under the selection's last line.
    fn under_selection(&self) -> Option<(Point<Pixels>, Pixels)> {
        let (from, to) = self.sel.range()?;
        let start = if from.key == to.key { from.offset } else { 0 };
        let last = self.sel.rects(to.key, start..to.offset).into_iter().last().or_else(|| self.sel.first_rect())?;
        let top = self.sel.first_rect().map(|r| r.top()).unwrap_or(last.top());
        Some((point(last.left(), last.bottom() + px(6.)), top - px(6.)))
    }

    /// Opens the popover over what's selected, looking it up when it's a word or a name.
    fn pop_selection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(quote), Some((at, top))) = (self.quote(), self.under_selection()) else { return };
        let term = quote.exact.trim().to_string();
        let lookup = wordish(&term).then(|| json!({ "term": term, "doc": self.doc }));
        self.open_pop(at, top, Some(quote), lookup, window, cx);
    }

    fn open_pop(&mut self, at: Point<Pixels>, top: Pixels, quote: Option<Quote>, lookup: Option<Value>, window: &mut Window, cx: &mut Context<Self>) {
        let me = cx.entity().downgrade();
        let ask = cx.new(|cx| Textarea::new(Self::box_options("Ask…", me, quote.clone()), window, cx));
        let (looked, task) = match lookup.filter(|_| !self.tools.define.is_empty()) {
            Some(args) => {
                let call = self.call(&self.tools.define.clone(), args, cx);
                let task = cx.spawn(async move |this, cx| {
                    let got = call.await;
                    this.update(cx, |r, cx| {
                        if let Some(p) = r.pop.as_mut() {
                            p.looked = match got {
                                Ok(a) => Looked::Found(found_of(a.get("structuredContent").unwrap_or(&Value::Null))),
                                Err(_) => Looked::Failed,
                            };
                        }
                        cx.notify();
                    })
                    .ok();
                });
                (Looked::Looking, Some(task))
            }
            None => (Looked::No, None),
        };
        self.pop = Some(Pop { at, top, quote, looked, ask, _task: task });
        self.held = None;
        cx.notify();
    }

    fn close_pop(&mut self, cx: &mut Context<Self>) -> bool {
        self.held = None;
        let had = self.pop.take().is_some();
        if had {
            cx.notify();
        }
        had
    }

    /// A link in the words: Wikipedia's opens its summary here; any other, the browser.
    fn link(&mut self, url: &str, window: &mut Window, cx: &mut Context<Self>) {
        if is_wikipedia(url) && !self.tools.define.is_empty() {
            let at = point(self.last_mouse.x, self.last_mouse.y + px(14.));
            let top = self.last_mouse.y - px(14.);
            self.open_pop(at, top, None, Some(json!({ "url": url, "doc": self.doc })), window, cx);
            return;
        }
        crate::chat::reading_on_link()(url, window, cx);
    }

    /// A question from a box: in the open thread, or a new one about the popover's passage (or
    /// the whole document).
    fn submitted(&mut self, question: String, quote: Option<Quote>, window: &mut Window, cx: &mut Context<Self>) {
        let from_pop = self.pop.is_some() && quote.is_some();
        let (thread, quote) = match (&self.open, from_pop) {
            (Some(open), false) => (open.clone(), None),
            _ => (new_id(), quote),
        };
        self.ask(thread, question, quote, cx);
        if from_pop {
            self.pop = None;
            self.sel.clear();
        } else {
            self.composer.update(cx, |t, cx| {
                t.clear(Default::default(), window, cx);
            });
        }
        cx.notify();
    }

    fn ask(&mut self, thread: String, question: String, quote: Option<Quote>, cx: &mut Context<Self>) {
        if self.tools.ask.is_empty() {
            return;
        }
        let mut args = json!({ "doc": self.doc, "thread": thread, "question": question });
        if let Some(q) = &quote {
            args["quote"] = q.json();
        }
        self.asking.insert(thread.clone(), Asking { question, quote, failed: None });
        self.open = Some(thread.clone());
        let call = self.call(&self.tools.ask.clone(), args, cx);
        cx.spawn(async move |this, cx| {
            let got = call.await;
            this.update(cx, |r, cx| {
                match got {
                    Ok(_) => {
                        r.asking.remove(&thread);
                    }
                    Err(e) => {
                        if let Some(a) = r.asking.get_mut(&thread) {
                            a.failed = Some(e);
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Highlights what's selected, or takes away the highlight it's in.
    fn highlight(&mut self, cx: &mut Context<Self>) {
        let Some(quote) = self.quote().or_else(|| self.pop.as_ref().and_then(|p| p.quote.clone())) else { return };
        if self.tools.highlight.is_empty() {
            return;
        }
        let call = self.call(&self.tools.highlight.clone(), json!({ "doc": self.doc, "quote": quote.json() }), cx);
        self.pop = None;
        self.sel.clear();
        // Shown at once; the data takes over when it comes.
        self.highlights.push((String::new(), quote));
        cx.spawn(async move |this, cx| {
            let got = call.await;
            this.update(cx, |r, cx| {
                r.note = got.err();
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn unhighlight(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.tools.unhighlight.is_empty() || id.is_empty() {
            return;
        }
        let call = self.call(&self.tools.unhighlight.clone(), json!({ "doc": self.doc, "highlight": id }), cx);
        self.highlights.retain(|(h, _)| h != id);
        self.pop = None;
        cx.spawn(async move |this, cx| {
            let got = call.await;
            this.update(cx, |r, cx| {
                r.note = got.err();
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn open_thread(&mut self, id: &str, cx: &mut Context<Self>) {
        self.open = Some(id.to_string());
        self.reveal = Some(id.to_string());
        self.pop = None;
        cx.notify();
    }

    /// What's marked in a run of words: highlights in yellow, threads' passages in ink, the open
    /// one darker.
    fn marks(&self, l: &Look) -> markdown::Reading {
        let mut anchors: Vec<(String, Quote, gpui::Hsla, bool)> = vec![];
        let wash = if l.dark { l.yellow.opacity(0.28) } else { l.yellow.opacity(0.38) };
        for (id, q) in &self.highlights {
            anchors.push((id.clone(), q.clone(), wash, false));
        }
        let threads = self.threads.iter().filter_map(|t| Some((t.id.clone(), t.quote.clone()?))).chain(self.asking.iter().filter_map(|(id, a)| Some((id.clone(), a.quote.clone()?))));
        for (id, q) in threads {
            let open = self.open.as_deref() == Some(id.as_str());
            anchors.push((id, q, l.ink3.opacity(if open { 0.34 } else { 0.16 }), true));
        }
        let drawn = self.drawn.clone();
        markdown::Reading {
            marks: Box::new(move |key, text| {
                let mut out = vec![];
                for (id, q, wash, thread) in &anchors {
                    if q.section != key.0 {
                        continue;
                    }
                    if let Some(range) = find(text, q) {
                        drawn.borrow_mut().insert(id.clone(), (key, range.clone()));
                        out.push(Mark { range, wash: *wash, id: thread.then(|| id.clone()).or_else(|| (!id.is_empty()).then(|| format!("hl:{id}"))) });
                    }
                }
                out
            }),
            on_mark: Rc::new(|_, _, _| {}),
        }
    }

    /// The passage of what's to be revealed, brought to the middle of the column once drawn.
    fn reveal_now(&mut self) {
        let Some(id) = self.reveal.clone() else { return };
        let quote = self.threads.iter().find(|t| t.id == id).and_then(|t| t.quote.clone()).or_else(|| self.asking.get(&id).and_then(|a| a.quote.clone()));
        let Some(quote) = quote else {
            self.reveal = None;
            return;
        };
        let at = self.drawn.borrow().get(&id).cloned();
        match at.and_then(|(key, range)| self.sel.rects(key, range).into_iter().next()) {
            Some(rect) => {
                let view = self.list.viewport_bounds();
                let middle = view.top() + view.size.height / 3.;
                crate::follow::scroll_by(&self.list, rect.top() - middle);
                self.reveal = None;
            }
            None => {
                let ix = quote.section as usize;
                if ix < self.sections.len() {
                    self.list.scroll_to(ListOffset { item_ix: ix, offset_in_item: px(0.) });
                }
            }
        }
    }

    fn section(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let l = Look::get(cx);
        let Some(s) = self.sections.get(ix) else { return div().into_any_element() };
        let doc = s.doc.clone();
        let label = s.label.clone().filter(|_| self.data.paged);
        let me = cx.entity().downgrade();
        let me2 = me.clone();
        let mut reading = self.marks(&l);
        reading.on_mark = Rc::new(move |id: &str, window: &mut Window, cx: &mut App| {
            let id = id.to_string();
            me2.update(cx, |r, cx| {
                if let Some(h) = id.strip_prefix("hl:") {
                    // A click on a highlight offers to take it away.
                    let at = point(r.last_mouse.x, r.last_mouse.y + px(14.));
                    r.pop_highlight(h.to_string(), at, r.last_mouse.y - px(14.), window, cx);
                } else {
                    r.open_thread(&id, cx);
                }
            })
            .ok();
        });
        let on_link: markdown::OnLink = Rc::new(move |url: &str, window: &mut Window, cx: &mut App| {
            let url = url.to_string();
            me.update(cx, |r, cx| r.link(&url, window, cx)).ok();
        });
        let ctx = markdown::Ctx {
            id: format!("reader.{ix}"),
            order: ix as u64,
            sel: self.sel.clone(),
            on_link,
            on_picture: crate::chat::on_picture(),
            ink: None,
            cell: false,
            pictures: Default::default(),
            formulas: Default::default(),
            reading: Some(Rc::new(reading)),
        };
        let words = markdown::render(&doc, &ctx, &l, window, cx);
        div()
            .w_full()
            .flex()
            .justify_center()
            .child(
                div()
                    .w_full()
                    .max_w(u(MEASURE + 64.))
                    .px(u(32.))
                    .pt(if ix == 0 { u(40.) } else if label.is_some() { u(24.) } else { u(36.) })
                    .when(ix + 1 == self.sections.len(), |d| d.pb(u(96.)))
                    // A PDF's page: its number over its words, on a hairline.
                    .when_some(label, |d, label| {
                        d.child(
                            div()
                                .flex()
                                .justify_end()
                                .mb(u(16.))
                                .when(ix > 0, |d| d.pt(u(8.)).border_t(px(l.w2)).border_color(l.line2))
                                .text_size(u(11.))
                                .line_height(u(14.))
                                .text_color(l.ink3)
                                .child(SharedString::from(label)),
                        )
                    })
                    .child(words),
            )
            .into_any_element()
    }

    /// The popover offering to take a highlight away.
    fn pop_highlight(&mut self, id: String, at: Point<Pixels>, top: Pixels, window: &mut Window, cx: &mut Context<Self>) {
        let quote = self.highlights.iter().find(|(h, _)| *h == id).map(|(_, q)| q.clone());
        self.open_pop(at, top, quote, None, window, cx);
        if let Some(p) = self.pop.as_mut() {
            p.looked = Looked::No;
        }
        self.held = Some(id);
    }
}

/// Whole sentences of `text`, as many as fit in about `most` characters (always the first).
fn sentences(text: &str, most: usize) -> String {
    let mut out = String::new();
    for s in text.split_inclusive(". ") {
        if !out.is_empty() && out.chars().count() + s.chars().count() > most {
            break;
        }
        out.push_str(s);
    }
    out.trim().to_string()
}

/// A lookup's answer, as `define` gives it.
fn found_of(v: &Value) -> Found {
    let d = v.get("dictionary").filter(|d| !d.is_null());
    let w = v.get("wikipedia").filter(|w| !w.is_null());
    Found {
        word: d.map(|d| str_of(d, "word").to_string()).unwrap_or_else(|| str_of(v, "term").to_string()),
        senses: d
            .and_then(|d| d.get("senses"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|s| (str_of(s, "pos").to_string(), str_of(s, "text").to_string()))
            .collect(),
        dictionary: d.map(|d| str_of(d, "url").to_string()).filter(|u| !u.is_empty()),
        article: w.map(|w| Article {
            title: str_of(w, "title").to_string(),
            description: str_of(w, "description").to_string(),
            extract: sentences(str_of(w, "extract"), 360),
            url: str_of(w, "url").to_string(),
            thumbnail: w.get("thumbnail").and_then(Value::as_str).map(str::to_string),
        }),
    }
}

/// A key that opens an address in the browser: its words and ↗.
fn link_key(id: impl Into<SharedString>, label: &'static str, url: String, l: &Look) -> AnyElement {
    let id: SharedString = id.into();
    kit::press(kit::button(id, Btn::Flat, true, l), true, move |_, _, cx| cx.open_url(&url)).child(label).child(div().text_color(l.ink3).child("↗")).into_any_element()
}

impl Reader {
    /// What the popover shows: the word's senses, the article, and Ask with Highlight.
    fn popover(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let l = Look::get(cx);
        let p = self.pop.as_ref()?;
        let mut parts: Vec<AnyElement> = vec![];
        match &p.looked {
            Looked::Looking => parts.push(div().h(u(40.)).flex().items_center().px(u(12.)).child(kit::spin(crate::nav::Beat::step(cx), &l)).into_any_element()),
            Looked::Found(f) => {
                if !f.senses.is_empty() {
                    let mut senses = div().flex().flex_col().gap(u(6.)).px(u(12.)).pb(u(10.));
                    let mut last_pos = String::new();
                    for (i, (pos, text)) in f.senses.iter().enumerate() {
                        let shown_pos = (*pos != last_pos).then(|| pos.clone());
                        last_pos = pos.clone();
                        senses = senses.child(
                            div()
                                .flex()
                                .flex_col()
                                .when_some(shown_pos.filter(|p| !p.is_empty()), |d, pos| d.when(i > 0, |d| d.mt(u(4.))).child(div().text_size(u(11.)).line_height(u(14.)).italic().text_color(l.ink3).child(SharedString::from(pos))))
                                .child(div().text_size(u(13.)).line_height(u(18.)).text_color(l.ink).child(SharedString::from(text.clone()))),
                        );
                    }
                    parts.push(
                        div()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .h(u(32.))
                                    .pl(u(12.))
                                    .pr(u(4.))
                                    .child(div().text_size(u(15.)).line_height(u(20.)).font_weight(FontWeight::SEMIBOLD).child(SharedString::from(f.word.clone())))
                                    .children(f.dictionary.clone().map(|u| link_key("reader-wiktionary", "Wiktionary", u, &l))),
                            )
                            .child(senses)
                            .into_any_element(),
                    );
                }
                if let Some(a) = &f.article {
                    let thumb = a.thumbnail.as_ref().and_then(|t| crate::widgets::media::WebPictures::get(t, cx));
                    parts.push(
                        div()
                            .flex()
                            .flex_col()
                            .when(!parts.is_empty(), |d| d.border_t(px(l.w2)).border_color(l.line2))
                            // Its title and its source on one row, as the dictionary's.
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap(u(8.))
                                    .h(u(32.))
                                    .pl(u(12.))
                                    .pr(u(4.))
                                    .child(div().min_w_0().truncate().text_size(u(15.)).line_height(u(20.)).font_weight(FontWeight::SEMIBOLD).child(SharedString::from(a.title.clone())))
                                    .child(link_key("reader-wikipedia", "Wikipedia", a.url.clone(), &l)),
                            )
                            .child(
                                div()
                                    .flex()
                                    .gap(u(10.))
                                    .px(u(12.))
                                    .pb(u(10.))
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .flex()
                                            .flex_col()
                                            .gap(u(4.))
                                            .when(!a.description.is_empty(), |d| d.child(div().text_size(u(12.)).line_height(u(16.)).text_color(l.ink2).child(SharedString::from(a.description.clone()))))
                                            .child(div().text_size(u(13.)).line_height(u(18.)).text_color(l.ink).child(SharedString::from(a.extract.clone()))),
                                    )
                                    .children(thumb.map(|t| img(t).flex_none().size(u(56.)).rounded(u(4.)).object_fit(gpui::ObjectFit::Cover))),
                            )
                            .into_any_element(),
                    );
                }
            }
            Looked::No | Looked::Failed => {}
        }
        let me = cx.entity().downgrade();
        let me2 = me.clone();
        let held = self.held.clone();
        let mark = match held {
            Some(id) => kit::press(kit::button("reader-unhighlight", Btn::Flat, true, &l), true, move |_, _, cx| {
                me2.update(cx, |r, cx| r.unhighlight(&id, cx)).ok();
            })
            .child("Remove highlight")
            .into_any_element(),
            None => kit::press(kit::button("reader-highlight", Btn::Flat, true, &l), true, move |_, _, cx| {
                me2.update(cx, |r, cx| r.highlight(cx)).ok();
            })
            .child("Highlight")
            .into_any_element(),
        };
        let has_quote = p.quote.is_some();
        let ask = Textarea::root(&p.ask, cx).text_color(l.ink).aria_label("Ask").flex_1().min_w_0().text_size(u(13.)).line_height(u(18.));
        // A link's card has no passage to ask about or mark: no row for them.
        if has_quote || self.held.is_some() {
        parts.push(
            div()
                .flex()
                .items_center()
                .gap(u(4.))
                .min_h(u(36.))
                .pl(u(12.))
                .pr(u(4.))
                .when(!parts.is_empty(), |d| d.border_t(px(l.w2)).border_color(l.line2))
                .when(has_quote, |d| d.child(ask))
                .child(mark)
                .into_any_element(),
        );
        }
        if parts.is_empty() {
            return None;
        }
        let body = kit::float(&l)
            .id("reader-pop")
            .w(l.z(360.))
            .flex()
            .flex_col()
            .font_family(SANS)
            .occlude()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .children(parts);
        // Under what it's about, or over it when the window has more room there.
        let room_under = window.viewport_size().height - p.at.y;
        let place = if room_under < px(320.) && p.top > room_under {
            anchored().anchor(gpui::Anchor::BottomLeft).position(point(p.at.x, p.top))
        } else {
            anchored().position(p.at)
        };
        Some(deferred(place.snap_to_window_with_margin(px(8.)).child(body)).with_priority(2).into_any_element())
    }

    /// The threads down the right: the list, or one open, and the box under them.
    fn panel(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let l = Look::get(cx);
        self.panel_sel.frame();
        let me = cx.entity().downgrade();
        let open = self.open.clone();
        let body: AnyElement = match open {
            Some(id) => self.thread_view(&id, window, cx),
            None => {
                let rows: Vec<AnyElement> = self
                    .threads
                    .iter()
                    .map(|t| {
                        let id = t.id.clone();
                        let me = me.clone();
                        let first = t.messages.iter().find(|m| m.user).map(|m| m.text.clone()).unwrap_or_default();
                        let replies = t.messages.iter().filter(|m| !m.user && m.failed.is_none()).count();
                        div()
                            .id(SharedString::from(format!("reader-thread-{id}")))
                            .flex()
                            .flex_col()
                            .gap(u(4.))
                            .px(u(12.))
                            .py(u(10.))
                            .border_b(px(l.w2))
                            .border_color(l.line2)
                            .cursor_pointer()
                            .hover(|s| s.bg(l.hover))
                            .on_click(move |_, _, cx| {
                                me.update(cx, |r, cx| r.open_thread(&id, cx)).ok();
                            })
                            .when_some(t.quote.as_ref(), |d, q| d.child(div().pl(u(8.)).border_l_2().border_color(l.line1).text_size(u(12.)).line_height(u(16.)).text_color(l.ink2).line_clamp(2).child(SharedString::from(q.exact.replace(['\n', '\t'], " ")))))
                            .child(
                                div()
                                    .flex()
                                    .items_baseline()
                                    .gap(u(8.))
                                    .child(div().flex_1().min_w_0().truncate().text_size(u(13.)).line_height(u(18.)).text_color(l.ink).child(SharedString::from(first)))
                                    .when(t.waiting, |d| d.child(kit::spin(crate::nav::Beat::step(cx), &l)))
                                    .when(!t.waiting && replies > 1, |d| d.child(div().flex_none().text_size(u(11.)).text_color(l.ink3).child(SharedString::from(replies.to_string())))),
                            )
                            .into_any_element()
                    })
                    .collect();
                div().id("reader-threads").flex().flex_col().size_full().overflow_y_scroll().children(rows).into_any_element()
            }
        };
        let head = match &self.open {
            Some(_) => {
                let me = me.clone();
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .h(u(24.))
                    .px(u(4.))
                    .border_b(px(l.w2))
                    .border_color(l.line2)
                    .child(
                        kit::press(kit::button("reader-back", Btn::Flat, true, &l).aria_label("Threads"), true, move |_, _, cx| {
                            me.update(cx, |r, cx| {
                                r.open = None;
                                cx.notify();
                            })
                            .ok();
                        })
                        .text_size(u(11.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child("‹ THREADS"),
                    )
                    .into_any_element()
            }
            None => div()
                .flex()
                .flex_none()
                .items_center()
                .justify_between()
                .h(u(24.))
                .px(u(12.))
                .border_b(px(l.w2))
                .border_color(l.line2)
                .text_size(u(11.))
                .line_height(u(14.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(l.ink2)
                .child("THREADS")
                .child(div().text_color(l.ink3).child(SharedString::from(self.threads.len().to_string())))
                .into_any_element(),
        };
        let composer = Textarea::root(&self.composer, cx).text_color(l.ink).aria_label("Ask").w_full().min_w_0().text_size(u(13.)).line_height(u(18.));
        div()
            .flex()
            .flex_col()
            .flex_none()
            .w(u(PANEL))
            .h_full()
            .border_l(px(l.w1))
            .border_color(l.line1)
            .child(head)
            .child(div().flex_1().min_h_0().child(body))
            .child(div().flex_none().px(u(12.)).py(u(8.)).border_t(px(l.w2)).border_color(l.line2).child(composer))
            .into_any_element()
    }

    /// One thread: its passage (a click brings it into view), then each question and its answer.
    fn thread_view(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let l = Look::get(cx);
        let t = self.threads.iter().find(|t| t.id == id).cloned();
        let asking = self.asking.get(id).cloned();
        let quote = t.as_ref().and_then(|t| t.quote.clone()).or_else(|| asking.as_ref().and_then(|a| a.quote.clone()));
        let mut messages = t.as_ref().map(|t| t.messages.clone()).unwrap_or_default();
        let mut waiting = t.as_ref().is_some_and(|t| t.waiting);
        let mut failed = None;
        if let Some(a) = &asking {
            if !messages.iter().any(|m| m.user && m.text == a.question) {
                messages.push(Message { user: true, text: a.question.clone(), failed: None });
            }
            match &a.failed {
                Some(e) => failed = Some(e.clone()),
                None => waiting = true,
            }
        }
        let me = cx.entity().downgrade();
        let reveal_id = id.to_string();
        let mut out = div().flex().flex_col().px(u(12.)).pt(u(12.)).pb(u(16.)).gap(u(4.));
        if let Some(q) = quote {
            out = out.child(
                div()
                    .id("reader-thread-quote")
                    .pl(u(8.))
                    .mb(u(8.))
                    .border_l_2()
                    .border_color(l.line1)
                    .cursor_pointer()
                    .text_size(u(13.))
                    .line_height(u(18.))
                    .text_color(l.ink2)
                    .line_clamp(6)
                    .on_click(move |_, _, cx| {
                        let id = reveal_id.clone();
                        me.update(cx, |r, cx| {
                            r.reveal = Some(id);
                            cx.notify();
                        })
                        .ok();
                    })
                    .child(SharedString::from(q.exact.replace(['\n', '\t'], " "))),
            );
        }
        for (i, m) in messages.iter().enumerate() {
            let key_order = i as u64;
            if m.user {
                out = out.child(
                    div()
                        .when(i > 0, |d| d.mt(u(12.)))
                        .text_size(u(13.))
                        .line_height(u(18.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(markdown::plain(&m.text, format!("reader-q-{id}-{i}"), (key_order, 0), &self.panel_sel)),
                );
            } else if let Some(e) = &m.failed {
                out = out.child(div().mt(u(4.)).text_size(u(13.)).line_height(u(18.)).text_color(l.ink2).child(SharedString::from(format!("Can't answer: {e}"))));
            } else {
                let doc = Doc::of(&m.text);
                let ctx = markdown::Ctx {
                    id: format!("reader-a-{id}-{i}"),
                    order: key_order,
                    sel: self.panel_sel.clone(),
                    on_link: crate::chat::reading_on_link(),
                    on_picture: crate::chat::on_picture(),
                    ink: None,
                    cell: false,
                    pictures: Default::default(),
                    formulas: Default::default(),
                    reading: None,
                };
                out = out.child(div().mt(u(4.)).text_size(u(13.)).line_height(u(20.)).child(markdown::render(&doc, &ctx, &l, window, cx)));
            }
        }
        if waiting {
            out = out.child(div().mt(u(8.)).child(kit::spin(crate::nav::Beat::step(cx), &l)));
        }
        if let Some(e) = failed {
            out = out.child(div().mt(u(8.)).text_size(u(13.)).line_height(u(18.)).text_color(l.ink2).child(SharedString::from(e)));
        }
        let sel = self.panel_sel.clone();
        let (down, moved) = (sel.clone(), sel.clone());
        div()
            .id("reader-thread")
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&self.panel_scroll)
            .capture_any_mouse_down(move |e: &gpui::MouseDownEvent, _, _| {
                if e.button == MouseButton::Left && !e.modifiers.shift && e.click_count == 1 {
                    down.clear();
                }
            })
            .on_mouse_move(move |e: &gpui::MouseMoveEvent, window, _| {
                if moved.drag_to(e.position) {
                    window.refresh();
                }
            })
            .child(out)
            .into_any_element()
    }

    fn panel_shown(&self) -> bool {
        !self.threads.is_empty() || self.open.is_some() || !self.asking.is_empty()
    }

    fn on_key(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let k = &e.keystroke;
        let m = &k.modifiers;
        if k.key == "escape" {
            if self.close_pop(cx) {
                cx.stop_propagation();
                return;
            }
            if !self.sel.is_empty() {
                self.sel.clear();
                cx.stop_propagation();
                cx.notify();
                return;
            }
            if self.open.take().is_some() {
                cx.stop_propagation();
                cx.notify();
            }
            return;
        }
        if crate::follow::in_field(window) {
            return;
        }
        if m.platform && !m.shift && k.key == "d" {
            self.pop_selection(window, cx);
            cx.stop_propagation();
            return;
        }
        if m.platform && m.shift && k.key == "h" {
            self.highlight(cx);
            cx.stop_propagation();
            return;
        }
        if k.key == "enter" && !m.platform && !m.shift {
            if self.pop.is_none() {
                self.pop_selection(window, cx);
            }
            if let Some(p) = &self.pop {
                let ask = p.ask.clone();
                ask.update(cx, |t, cx| t.focus(window, cx));
                cx.stop_propagation();
            }
            return;
        }
        // The scroll keys, as a column's.
        let back = m.shift && k.key == "space";
        if m.platform || m.control || m.alt || (m.shift && !back) {
            return;
        }
        let page = self.list.viewport_bounds().size.height * 0.9;
        let by = match k.key.as_str() {
            "space" if back => -page,
            "pageup" => -page,
            "pagedown" | "space" => page,
            "up" => px(-40.),
            "down" => px(40.),
            "home" => px(-1e7),
            "end" => px(1e7),
            _ => return,
        };
        self.pop = None;
        crate::follow::scroll_by(&self.list, by);
        cx.stop_propagation();
        cx.notify();
    }
}

impl Focusable for Reader {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Reader {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = Look::get(cx);
        self.sel.frame();
        self.reveal_now();
        let column: AnyElement = if !self.sections.is_empty() {
            let sel = self.sel.clone();
            let sel_up = self.sel.clone();
            let me = cx.entity().downgrade();
            let (view, by_list) = (self.list.clone(), self.list.clone());
            let words = list(self.list.clone(), cx.processor(|this: &mut Reader, ix, window, cx| this.section(ix, window, cx))).size_full();
            let thumb = self.hovered || self.list.is_scrollbar_dragging();
            div()
                .id("reader-column")
                .relative()
                .size_full()
                .on_hover(cx.listener(|this, h: &bool, _, cx| {
                    this.hovered = *h;
                    cx.notify();
                }))
                .on_mouse_move(cx.listener(|this, e: &gpui::MouseMoveEvent, _, _| this.last_mouse = e.position))
                .capture_any_mouse_down(cx.listener(move |this, e: &gpui::MouseDownEvent, _, cx| {
                    this.last_mouse = e.position;
                    if e.button == MouseButton::Left && !e.modifiers.shift && e.click_count == 1 {
                        sel.clear();
                        this.close_pop(cx);
                    }
                }))
                .on_scroll(cx.listener(|this, _: &gpui::ScrollEvent, _, cx| {
                    this.close_pop(cx);
                }))
                .child(words)
                .child(crate::select::drag_anywhere(
                    &sel_up,
                    move || view.viewport_bounds(),
                    move |by, window, _| {
                        crate::follow::scroll_by(&by_list, by);
                        window.refresh();
                    },
                    move |window, cx| {
                        me.update(cx, |r, cx| {
                            if !r.sel.is_empty() {
                                r.pop_selection(window, cx);
                            }
                        })
                        .ok();
                    },
                ))
                .when(thumb, |d| d.child(crate::follow::thumb(&self.list, &l)))
                .into_any_element()
        } else if let Some(e) = self.failed.clone() {
            let me = cx.entity().downgrade();
            div()
                .size_full()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(u(8.))
                .text_color(l.ink2)
                .child(SharedString::from(e))
                .child(
                    kit::press(kit::button("reader-retry", Btn::Key, true, &l), true, move |_, _, cx| {
                        me.update(cx, |r, cx| {
                            r.failed = None;
                            r.load(cx);
                            cx.notify();
                        })
                        .ok();
                    })
                    .child("Retry"),
                )
                .into_any_element()
        } else {
            div().size_full().flex().items_center().justify_center().child(kit::spin(crate::nav::Beat::step(cx), &l)).into_any_element()
        };
        let panel = self.panel_shown().then(|| self.panel(window, cx));
        let pop = self.popover(window, cx);
        div()
            .key_context("Reader")
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &ui_sdk::native::text_field::SelectAll, window, _| {
                if !crate::follow::in_field(window) {
                    this.sel.select_all();
                    window.refresh();
                }
            }))
            .on_action(cx.listener(|this, _: &ui_sdk::native::text_field::Copy, _, cx| {
                let t = if this.sel.is_empty() { this.panel_sel.text() } else { this.sel.text() };
                if !t.is_empty() {
                    cx.write_to_clipboard(ClipboardItem::new_string(t));
                }
            }))
            .on_key_down(cx.listener(|this, e: &KeyDownEvent, window, cx| this.on_key(e, window, cx)))
            .size_full()
            .flex()
            .bg(l.bg)
            .text_color(l.ink)
            .font_family(SANS)
            .child(div().flex_1().min_w_0().h_full().text_size(u(16.)).line_height(u(26.)).child(column))
            .children(panel)
            .children(pop)
    }
}
