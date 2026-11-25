//! The window as a widget host (the desktop's `widgets/host.ts`, `call.ts`, `use-prefetch.ts`,
//! `use-watch.ts`): what extensions offer and each widget's A2UI messages come from the core's
//! `/widgets`, each surface under its own key (`printers/overview`, a chat's `<app>/<name>#<seq>`);
//! a placed widget's surface is fetched once its extension offers it, so a space opens with its
//! widgets drawn; its data comes again when an event it names lands (at most once per 100 ms), and
//! the brain is told which high-rate events to send. A widget's action is one of its extension's
//! tools by name, its context the arguments. A page the agent made (the brain app's) takes this
//! window's theme, and comes again when the theme does.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::Duration;

use gpui::{App, AppContext, Context, Entity, Global};
use serde_json::{Map, Value, json};

use crate::a2ui::{self, Pressed, Surface};
use crate::look::Look;
use crate::model::{Heard, model};
use crate::net::Net;

/// The app whose widgets are the views the agent made (the core's brain app): each is there for as
/// long as the brain is, offered or not, and a page among them takes this window's theme.
pub const MADE: &str = "brain";

/// A widget an extension offers, as `/widgets` lists it.
#[derive(Clone, Debug)]
pub struct Offered {
    pub app: String,
    pub name: String,
    pub refresh: Vec<String>,
}

/// Where a surface's messages come from: a widget's tool, called with its input. A placement's is
/// asked for by the placement's id, so the core calls it with that placement's own input (its
/// `input` here is what it last had, for telling a new one); a chat line's by its input.
#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    pub app: String,
    pub name: String,
    pub input: Option<Value>,
    /// The placement it draws, by id: the core calls its tool with that placement's input, never
    /// the widget's first's.
    pub placement: Option<String>,
}

impl Source {
    /// A placed widget's: by its placement's id.
    pub fn placed(w: &crate::items::Placed) -> Source {
        Source { app: w.app.clone(), name: w.name.clone(), input: w.input.clone(), placement: Some(w.key()) }
    }

    /// Its widget's key, as `/widgets` lists what extensions offer.
    pub fn key(&self) -> String {
        format!("{}/{}", self.app, self.name)
    }

    /// The core's route for its messages: by placement, else by input, else its widget's alone.
    pub fn route(&self) -> String {
        let mut route = format!("/widgets/{}/{}", self.app, self.name);
        if let Some(id) = &self.placement {
            route.push_str(&format!("?placement={}", urlencode(id)));
        } else if let Some(input) = &self.input {
            route.push_str(&format!("?input={}", urlencode(&input.to_string())));
        }
        route
    }
}

pub struct Host {
    pub offered: HashMap<String, Offered>,
    /// `/widgets` has answered once.
    pub listed: bool,
    listing: bool,
    surfaces: HashMap<String, Rc<Surface>>,
    sources: HashMap<String, Source>,
    loading: HashSet<String>,
    /// Asked for again while loading: fetched once more when the load is in (TanStack's refetch
    /// cancels the one under way and starts another).
    again: HashSet<String>,
    failed: HashMap<String, String>,
    /// Those asked again once after failing.
    retried: HashSet<String>,
    due: HashSet<String>,
    watched: Vec<String>,
    /// The theme the agent's pages were last given.
    themed: Option<(bool, u32)>,
}

struct HostHandle(Entity<Host>);
impl Global for HostHandle {}

pub fn key_of(app: &str, name: &str) -> String {
    format!("{app}/{name}")
}

/// Whether an event of `kind` refreshes a widget: a type it names, or `*.<name>` any extension's.
fn refreshes(refresh: &[String], kind: &str) -> bool {
    refresh.iter().any(|r| r == kind || r.strip_prefix('*').is_some_and(|s| s.starts_with('.') && kind.ends_with(s)))
}

impl Host {
    pub fn init(cx: &mut App) {
        let host = cx.new(|cx| {
            let m = model(cx);
            cx.subscribe(&m, |this: &mut Host, _, heard: &Heard, cx| this.heard(&heard.0, cx)).detach();
            cx.observe(&m, |this: &mut Host, _, cx| this.placements(cx)).detach();
            cx.observe_global::<Look>(|this: &mut Host, cx| this.retheme(cx)).detach();
            // A page shown again (its cells back): what failed is asked for again as it's drawn.
            cx.observe(&crate::nav::Nav::entity(cx), |this: &mut Host, _, cx| {
                this.failed.clear();
                this.retried.clear();
                cx.notify();
            })
            .detach();
            Host {
                offered: HashMap::new(),
                listed: false,
                listing: false,
                surfaces: HashMap::new(),
                sources: HashMap::new(),
                loading: HashSet::new(),
                again: HashSet::new(),
                failed: HashMap::new(),
                retried: HashSet::new(),
                due: HashSet::new(),
                watched: vec![],
                themed: None,
            }
        });
        cx.set_global(HostHandle(host));
    }

    pub fn entity(cx: &App) -> Entity<Host> {
        cx.global::<HostHandle>().0.clone()
    }

    /// A surface, once it's in.
    pub fn surface(&self, key: &str) -> Option<Rc<Surface>> {
        self.surfaces.get(key).cloned()
    }

    /// What went wrong loading it, if it did.
    pub fn failure(&self, key: &str) -> Option<&str> {
        self.failed.get(key).map(String::as_str)
    }

    /// Whether a widget can be shown: its extension offers it, or it's one the agent made.
    pub fn shows(&self, app: &str, name: &str) -> bool {
        app == MADE || self.offered.contains_key(&key_of(app, name))
    }

    /// A surface under `key`, from `source`: asked for the first time (or again from a new
    /// source), it's fetched.
    pub fn want(&mut self, key: &str, source: Source, cx: &mut Context<Self>) {
        if self.sources.get(key) == Some(&source) && (self.surfaces.contains_key(key) || self.loading.contains(key) || self.failed.contains_key(key)) {
            return;
        }
        if !self.shows(&source.app, &source.name) {
            if !self.listed {
                self.list(cx);
            }
            return;
        }
        self.want_any(key, source, cx);
    }

    /// A surface under `key` from `source`, offered or not (a view a window was opened on).
    pub fn want_any(&mut self, key: &str, source: Source, cx: &mut Context<Self>) {
        if self.sources.get(key) == Some(&source) && (self.surfaces.contains_key(key) || self.loading.contains(key) || self.failed.contains_key(key)) {
            return;
        }
        self.sources.insert(key.into(), source);
        self.load(key.into(), cx);
        self.watch(cx);
    }

    /// What extensions offer; asked again while a placed widget's extension hasn't connected yet.
    pub fn list(&mut self, cx: &mut Context<Self>) {
        if self.listing {
            return;
        }
        self.listing = true;
        let job = cx.global::<Net>().http("GET", "/widgets".into(), None);
        cx.spawn(async move |this, cx| {
            let got = job.await.ok().and_then(Result::ok).filter(|a| a.status < 300);
            this.update(cx, |h, cx| {
                h.listing = false;
                if let Some(a) = got
                    && let Ok(Value::Array(all)) = serde_json::from_slice::<Value>(&a.body)
                {
                    h.offered = all
                        .iter()
                        .map(|w| {
                            let o = Offered {
                                app: crate::json::gs(w, "app"),
                                name: crate::json::gs(w, "name"),
                                refresh: crate::json::list(crate::json::get(w, "refresh")).iter().map(crate::json::s).collect(),
                            };
                            (key_of(&o.app, &o.name), o)
                        })
                        .collect();
                    h.listed = true;
                }
                h.placements(cx);
                h.watch(cx);
                cx.notify();
                let missing = model(cx).read(cx).brain.placed.iter().any(|w| !h.offered.contains_key(&w.widget()));
                if missing || !h.listed {
                    cx.spawn(async move |this, cx| {
                        cx.background_executor().timer(Duration::from_secs(3)).await;
                        this.update(cx, |h, cx| h.list(cx)).ok();
                    })
                    .detach();
                }
            })
            .ok();
        })
        .detach();
    }

    /// Every placed widget's surface, fetched once its extension offers it.
    fn placements(&mut self, cx: &mut Context<Self>) {
        if !model(cx).read(cx).brain.ready {
            return;
        }
        if !self.listed {
            self.list(cx);
            return;
        }
        let placed = model(cx).read(cx).brain.placed.clone();
        for w in placed {
            let key = w.key();
            if self.offered.contains_key(&w.widget()) && !self.surfaces.contains_key(&key) && !self.loading.contains(&key) && !self.failed.contains_key(&key) {
                self.sources.insert(key.clone(), Source::placed(&w));
                self.load(key, cx);
            }
        }
        self.watch(cx);
    }

    /// The brain is told which high-rate events to send: those the widgets placed or loaded refresh on.
    fn watch(&mut self, cx: &mut Context<Self>) {
        let placed: Vec<String> = model(cx).read(cx).brain.placed.iter().map(|w| w.widget()).collect();
        let shown = self.sources.values().map(Source::key);
        let mut types: Vec<String> =
            placed.into_iter().chain(shown).filter_map(|k| self.offered.get(&k)).flat_map(|o| o.refresh.iter().cloned()).collect::<HashSet<_>>().into_iter().collect();
        types.sort();
        if types != self.watched {
            self.watched = types.clone();
            cx.global::<Net>().watch(types);
        }
    }

    fn load(&mut self, key: String, cx: &mut Context<Self>) {
        let Some(source) = self.sources.get(&key).cloned() else { return };
        if !self.loading.insert(key.clone()) {
            self.again.insert(key);
            return;
        }
        let job = cx.global::<Net>().http("GET", source.route(), None);
        cx.spawn(async move |this, cx| {
            let got = job.await.map_err(|_| "Can't reach the core".to_string()).and_then(|r| r);
            let messages = got.and_then(|a| {
                if a.status >= 300 {
                    return Err(format!("No widget {key}"));
                }
                Ok(serde_json::from_slice::<Value>(&a.body).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default())
            });
            this.update(cx, |h, cx| {
                h.loading.remove(&key);
                if h.again.remove(&key) {
                    // What came is already old: the newer answer is what shows.
                    h.load(key.clone(), cx);
                    return;
                }
                match messages {
                    Ok(ms) => {
                        h.failed.remove(&key);
                        h.retried.remove(&key);
                        h.take(&key, &ms, &source, cx);
                    }
                    // A failed one is asked once more a second later (the queries' one retry);
                    // after that it stays failed until its cell comes back.
                    Err(e) => {
                        if h.retried.insert(key.clone()) {
                            let key = key.clone();
                            cx.spawn(async move |this, cx| {
                                cx.background_executor().timer(Duration::from_secs(1)).await;
                                this.update(cx, |h, cx| h.load(key, cx)).ok();
                            })
                            .detach();
                        } else {
                            h.failed.insert(key.clone(), e);
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// A widget's messages taken into its surface: every message the first time; after that only
    /// data, so the surface and its frames stay.
    fn take(&mut self, key: &str, raw: &[Value], source: &Source, cx: &mut Context<Self>) {
        let scoped = with_input(a2ui::scoped(key, raw), key, source.input.as_ref());
        let look = Look::get(cx);
        let messages: Vec<Value> = if source.app == MADE { scoped.into_iter().map(|m| with_theme(m, &look)).collect() } else { scoped };
        let fresh = !self.surfaces.contains_key(key);
        let surface = self.surfaces.entry(key.into()).or_insert_with(|| Rc::new(Surface::new()));
        let s = Rc::make_mut(surface);
        for m in messages.iter().filter(|m| fresh || m.get("updateDataModel").is_some()) {
            if m.get("deleteSurface").is_some() {
                *s = Surface::new();
                continue;
            }
            s.take(m);
        }
        if source.app == MADE {
            self.themed = Some((look.dark, theme_sig(&look)));
        }
    }

    /// A surface made from messages at hand (the gallery's), under `key`.
    #[cfg(feature = "shot")]
    pub fn hold(&mut self, key: &str, messages: &[Value]) -> Rc<Surface> {
        let mut s = Surface::new();
        for m in a2ui::scoped(key, messages) {
            s.take(&m);
        }
        let s = Rc::new(s);
        self.surfaces.insert(key.into(), s.clone());
        s
    }

    /// A control's value written to its surface's data model.
    pub fn write(&mut self, key: &str, path: &str, value: Value, cx: &mut Context<Self>) {
        if let Some(s) = self.surfaces.get_mut(key) {
            Rc::make_mut(s).write(path, value);
            cx.notify();
        }
    }

    /// A failed one asked for again (Retry), once more after a second if it fails again.
    pub fn retry(&mut self, key: &str, cx: &mut Context<Self>) {
        self.failed.remove(key);
        self.retried.remove(key);
        self.load(key.into(), cx);
        cx.notify();
    }

    fn heard(&mut self, events: &[crate::brain::Event], cx: &mut Context<Self>) {
        for e in events {
            let p = &e.payload;
            let named = key_of(&crate::json::gs(p, "app"), &crate::json::gs(p, "name"));
            if e.kind.starts_with("widget.") && !self.offered.contains_key(&named) {
                self.list(cx);
            }
            // A placement's input may have changed: its data again, called with the new one.
            let placement = crate::items::placement_id(p);
            if (e.kind == "widget.placed" || e.kind == "widget.moved") && self.surfaces.contains_key(&placement) {
                if let Some(s) = self.sources.get_mut(&placement) {
                    s.input = p.get("input").filter(|i| i.is_object()).cloned();
                }
                self.load(placement, cx);
            }
            // Every surface loaded, placed or in a chat, refreshes on the events its widget names.
            let keys: Vec<String> = self
                .sources
                .iter()
                .filter(|(k, src)| self.surfaces.contains_key(*k) && self.offered.get(&src.key()).is_some_and(|o| refreshes(&o.refresh, &e.kind)))
                .map(|(k, _)| k.clone())
                .collect();
            for k in keys {
                self.refresh(k, cx);
            }
        }
    }

    /// Its data asked again at most once per 100 ms, the last event's.
    fn refresh(&mut self, key: String, cx: &mut Context<Self>) {
        if !self.due.insert(key.clone()) {
            return;
        }
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(100)).await;
            this.update(cx, |h, cx| {
                h.due.remove(&key);
                h.load(key, cx);
            })
            .ok();
        })
        .detach();
    }

    /// The theme or the system's appearance changed: the agent's pages shown again in it.
    fn retheme(&mut self, cx: &mut Context<Self>) {
        let look = Look::get(cx);
        let now = Some((look.dark, theme_sig(&look)));
        if self.themed.is_none() || self.themed == now {
            return;
        }
        self.themed = now;
        let made: Vec<String> = self.sources.iter().filter(|(_, s)| s.app == MADE).map(|(k, _)| k.clone()).collect();
        for k in made {
            // Its data comes again in the new theme; the page stays up until it does, then is made
            // again in it.
            self.load(k, cx);
        }
    }

    /// What's pressed in a surface: an event goes to its extension's tool of that name, its context
    /// the arguments; `openUrl` opens the page in the browser.
    pub fn press(key: &str, pressed: Pressed, cx: &mut App) {
        #[cfg(feature = "shot")]
        match &pressed {
            Pressed::Event { name, context } => eprintln!("pressed {key}: event {name} {context}"),
            Pressed::Function { name, args } => eprintln!("pressed {key}: function {name} {args}"),
            Pressed::None => eprintln!("pressed {key}: nothing"),
        }
        match pressed {
            Pressed::Event { name, context } => {
                let app = key.split('/').next().unwrap_or_default().to_string();
                drop(call_tool(&app, &name, &context, cx));
            }
            Pressed::Function { name, args } => {
                // A2UI's openUrl: the address as parsed against the page's own (here the core's, where
                // the app's pages come from), opened only on the web, mail and phone.
                if name == "openUrl"
                    && let Some(target) = args.get("url").and_then(Value::as_str)
                {
                    let base = cx.global::<Net>().auth().and_then(|a| url::Url::parse(&format!("{}/", a.core)).ok());
                    let parsed = match &base {
                        Some(b) => b.join(target),
                        None => url::Url::parse(target),
                    };
                    if let Ok(url) = parsed
                        && ["https", "http", "mailto", "tel"].contains(&url.scheme())
                    {
                        cx.open_url(url.as_str());
                    }
                }
            }
            Pressed::None => {}
        }
    }
}

/// Calls one of an extension's tools for its widget (a swap, a camera frame): its MCP result.
pub fn call_tool(app: &str, tool: &str, args: &Value, cx: &App) -> tokio::task::JoinHandle<Result<crate::net::Answer, String>> {
    let body = if args.is_null() { "{}".to_string() } else { args.to_string() };
    cx.global::<Net>().http("POST", format!("/widgets/{app}/{tool}"), Some(body.into_bytes()))
}

/// MCP Apps receive the requested view input through the standard initialized tool-input event.
fn with_input(messages: Vec<Value>, key: &str, input: Option<&Value>) -> Vec<Value> {
    let Some(input) = input.filter(|i| !i.is_null()) else { return messages };
    let path = "/__switch_view_input";
    let mut fallback = false;
    let mut bound: Vec<Value> = messages
        .into_iter()
        .map(|mut m| {
            if let Some(Value::Array(cs)) = m.pointer_mut("/updateComponents/components") {
                for c in cs.iter_mut() {
                    if c.get("component").and_then(Value::as_str) != Some("McpApp") {
                        continue;
                    }
                    if c.pointer("/data/paths/toolInput").and_then(Value::as_str).is_some() {
                        continue;
                    }
                    fallback = true;
                    let data = c.as_object_mut().map(|o| o.entry("data").or_insert_with(|| Value::Object(Map::new())));
                    if let Some(Value::Object(d)) = data {
                        let paths = d.entry("paths").or_insert_with(|| Value::Object(Map::new()));
                        if let Value::Object(p) = paths {
                            p.insert("toolInput".into(), Value::String(path.into()));
                        }
                    }
                }
            }
            m
        })
        .collect();
    if fallback {
        bound.push(json!({ "version": "1.0", "updateDataModel": { "surfaceId": key, "path": path, "value": input } }));
    }
    bound
}

/// A page's data in this window's theme; any other message as it is.
fn with_theme(mut m: Value, look: &Look) -> Value {
    if let Some(Value::String(page)) = m.pointer_mut("/updateDataModel/value/page") {
        *page = crate::widgets::page::themed(page, look);
    }
    m
}

fn theme_sig(l: &Look) -> u32 {
    let c = |h: gpui::Hsla| {
        let r = gpui::Rgba::from(h);
        ((r.r * 255.) as u32) << 16 | ((r.g * 255.) as u32) << 8 | (r.b * 255.) as u32
    };
    c(l.bg) ^ c(l.ink).rotate_left(7) ^ c(l.line1).rotate_left(13) ^ c(l.go).rotate_left(19)
}

pub fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
