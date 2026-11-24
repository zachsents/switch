//! Dictation into a field (the desktop's `bun/dictation.ts` and `mainview/dictation/dictation.ts`):
//! the helper (native/dictation.swift) listens to the microphone and turns it into text with Apple's
//! SpeechAnalyzer, one helper per dictation. It reports how loud the user is and the phrases it hears
//! as JSON lines, and finishes the last phrase when its stdin closes. There's one microphone, so one
//! dictation at a time, app-wide: starting one in a field finishes any other first.
//!
//! A field reads `entity(cx).read(cx).listening` (its status, field, words and levels), starts one
//! with `start` (its words come to `on_end` once it's done), and says it takes dictation with
//! `takes_dictation` as it's drawn, so ⌘D finds it.

use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::rc::Rc;
use std::time::Instant;

use futures::StreamExt;
use futures::channel::mpsc::{UnboundedSender, unbounded};
use gpui::{AnyWindowHandle, App, AppContext, Entity, FocusHandle, Global, Window};
use serde_json::Value;

use super::helpers::native_helper;

/// How many levels the meter keeps.
pub const LEVELS: usize = 24;

const SETTINGS: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Idle,
    Starting,
    Listening,
    Stopping,
}

/// Why a dictation stopped short.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stopped {
    /// macOS keeps the microphone from the app.
    Denied,
    /// There's no microphone.
    NoInput,
    /// The helper isn't in the app.
    Missing,
    Failed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Listening {
    pub status: Status,
    /// The field it's dictating into.
    pub field: Option<String>,
    /// All the words heard so far.
    pub words: String,
    /// How loud they've been lately, oldest first, each 0 to 1.
    pub levels: Vec<f32>,
}

const IDLE: Listening = Listening { status: Status::Idle, field: None, words: String::new(), levels: Vec::new() };

/// A field's end of a dictation: all the words, and why it stopped short (and macOS's words), if it
/// did.
pub type Ended = Box<dyn FnOnce(String, Option<Stopped>, Option<String>, &mut App)>;

/// What the helper says, or that it's gone.
enum Said {
    Line(String),
    Exited,
}

/// The helper under way.
struct Session {
    id: u64,
    child: Child,
    stdin: Option<ChildStdin>,
    finished: String,
    volatile: String,
    stopped: Option<Stopped>,
    message: Option<String>,
}

/// A field that takes dictation, as it was last drawn.
struct Field {
    field: String,
    focus: FocusHandle,
    window: AnyWindowHandle,
    start: Rc<dyn Fn(&mut Window, &mut App)>,
    drawn: Instant,
}

pub struct Dictation {
    pub listening: Listening,
    id: u64,
    ended: Option<Ended>,
    /// A dictation asked for while another finishes.
    next: Option<(String, Ended)>,
    session: Option<Session>,
    fields: Vec<Field>,
}

struct DictationHandle(Entity<Dictation>);
impl Global for DictationHandle {}

pub fn init(cx: &mut App) {
    let e = cx.new(|_| Dictation { listening: IDLE, id: 0, ended: None, next: None, session: None, fields: vec![] });
    cx.set_global(DictationHandle(e));
}

pub fn entity(cx: &App) -> Entity<Dictation> {
    cx.global::<DictationHandle>().0.clone()
}

/// Whether this window can dictate: in the app, always (the desktop's `canDictate`); without its
/// helper a dictation ends at once as missing, "Dictation not installed".
pub fn can_dictate() -> bool {
    true
}

/// Whether a dictation is under way: an update waits for it to end.
pub fn dictating(cx: &App) -> bool {
    cx.try_global::<DictationHandle>().is_some_and(|h| h.0.read(cx).listening.status != Status::Idle)
}

/// `text` spaced from the phrases finished before it: the helper reports them bare.
fn spaced(before: &str, text: &str) -> String {
    let apart = match (before.chars().last(), text.chars().next()) {
        (Some(last), Some(first)) => !last.is_whitespace() && !first.is_whitespace() && !",.?!;:)".contains(first),
        _ => false,
    };
    if apart { format!(" {text}") } else { text.to_string() }
}

fn failure(kind: &str) -> Stopped {
    match kind {
        "denied" => Stopped::Denied,
        "no-input" => Stopped::NoInput,
        _ => Stopped::Failed,
    }
}

impl Dictation {
    fn set(&mut self, l: Listening, cx: &mut gpui::Context<Self>) {
        self.listening = l;
        cx.notify();
    }

    fn begin(&mut self, field: String, on_end: Ended, cx: &mut gpui::Context<Self>) {
        self.id += 1;
        self.ended = Some(on_end);
        self.set(Listening { status: Status::Starting, field: Some(field), ..IDLE }, cx);
        self.spawn(cx);
    }

    /// The helper for dictation `self.id`, heard line by line.
    fn spawn(&mut self, cx: &mut gpui::Context<Self>) {
        if let Some(mut s) = self.session.take() {
            let _ = s.child.kill();
        }
        let id = self.id;
        let Some(path) = native_helper("switch-dictation") else {
            self.heard_end(id, String::new(), Some(Stopped::Missing), None, cx);
            return;
        };
        let spawned = Command::new(path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn();
        let Ok(mut child) = spawned else {
            self.heard_end(id, String::new(), Some(Stopped::Failed), Some("The dictation helper quit.".into()), cx);
            return;
        };
        let (tx, mut rx) = unbounded::<Said>();
        if let Some(out) = child.stdout.take() {
            read(out, tx);
        }
        let stdin = child.stdin.take();
        self.session = Some(Session { id, child, stdin, finished: String::new(), volatile: String::new(), stopped: None, message: None });
        cx.spawn(async move |this, cx| {
            while let Some(said) = rx.next().await {
                if this.update(cx, |d, cx| d.hear(id, said, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    fn hear(&mut self, id: u64, said: Said, cx: &mut gpui::Context<Self>) {
        let Some(s) = self.session.as_mut().filter(|s| s.id == id) else { return };
        match said {
            Said::Line(raw) => {
                // Anything else on its stdout is a framework talking to itself.
                let Ok(l) = serde_json::from_str::<Value>(&raw) else { return };
                let text = l.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
                match l.get("event").and_then(Value::as_str).unwrap_or_default() {
                    "ready" => {
                        if self.listening.status == Status::Starting {
                            let l = Listening { status: Status::Listening, ..self.listening.clone() };
                            self.set(l, cx);
                        }
                    }
                    "level" => {
                        let level = l.get("level").and_then(Value::as_f64).unwrap_or(0.).clamp(0., 1.) as f32;
                        let mut levels = self.listening.levels.clone();
                        levels.push(level);
                        let over = levels.len().saturating_sub(LEVELS);
                        levels.drain(..over);
                        let l = Listening { levels, ..self.listening.clone() };
                        self.set(l, cx);
                    }
                    "volatile" => {
                        s.volatile = spaced(&s.finished, &text);
                        let words = format!("{}{}", s.finished, s.volatile);
                        let l = Listening { words, ..self.listening.clone() };
                        self.set(l, cx);
                    }
                    "final" => {
                        let add = spaced(&s.finished, &text);
                        s.finished.push_str(&add);
                        s.volatile.clear();
                        let words = s.finished.clone();
                        let l = Listening { words, ..self.listening.clone() };
                        self.set(l, cx);
                    }
                    "error" => {
                        s.stopped = Some(failure(l.get("kind").and_then(Value::as_str).unwrap_or_default()));
                        s.message = l.get("message").and_then(Value::as_str).map(str::to_string);
                    }
                    _ => {}
                }
            }
            Said::Exited => {
                let Some(mut s) = self.session.take() else { return };
                // Its stdout closed: it's exiting.
                let code = s.child.wait().ok().and_then(|st| st.code()).unwrap_or(1);
                // Done when it finished as asked; else it died.
                let died = code != 0 && s.stopped.is_none();
                let words = format!("{}{}", s.finished, s.volatile);
                let (stopped, message) = if died { (Some(Stopped::Failed), Some("The dictation helper quit.".to_string())) } else { (s.stopped, s.message) };
                self.heard_end(id, words, stopped, message, cx);
            }
        }
    }

    fn heard_end(&mut self, id: u64, words: String, stopped: Option<Stopped>, message: Option<String>, cx: &mut gpui::Context<Self>) {
        if id != self.id || self.listening.status == Status::Idle {
            return;
        }
        self.end(words, stopped, message, cx);
    }

    /// It's over: the field gets its words; one asked for meanwhile starts.
    fn end(&mut self, words: String, stopped: Option<Stopped>, message: Option<String>, cx: &mut gpui::Context<Self>) {
        let done = self.ended.take();
        self.set(IDLE, cx);
        if let Some(done) = done {
            cx.defer(move |cx| done(words, stopped, message, cx));
        }
        if let Some((field, on_end)) = self.next.take() {
            self.begin(field, on_end, cx);
        }
    }

    fn stop(&mut self, cx: &mut gpui::Context<Self>) {
        if matches!(self.listening.status, Status::Starting | Status::Listening) {
            let l = Listening { status: Status::Stopping, ..self.listening.clone() };
            self.set(l, cx);
            // Closing its stdin is the end of the audio.
            if let Some(s) = self.session.as_mut() {
                s.stdin = None;
            }
        }
    }
}

/// The helper's lines, and its exit, on a thread of their own.
fn read(out: std::process::ChildStdout, tx: UnboundedSender<Said>) {
    std::thread::spawn(move || {
        for line in BufReader::new(out).lines() {
            let Ok(line) = line else { break };
            if tx.unbounded_send(Said::Line(line)).is_err() {
                return;
            }
        }
        let _ = tx.unbounded_send(Said::Exited);
    });
}

/// Starts listening for `field`; `on_end` gets the words once it's done.
pub fn start(field: &str, on_end: Ended, cx: &mut App) {
    let field = field.to_string();
    entity(cx).update(cx, |d, cx| {
        if d.listening.status == Status::Idle {
            d.begin(field, on_end, cx);
        } else if d.listening.field.as_deref() != Some(field.as_str()) {
            d.next = Some((field, on_end));
            d.stop(cx);
        }
    });
}

/// Finishes the dictation under way, keeping its words.
pub fn stop(cx: &mut App) {
    entity(cx).update(cx, |d, cx| d.stop(cx));
}

/// Drops the dictation under way and its words.
pub fn cancel(cx: &mut App) {
    entity(cx).update(cx, |d, cx| {
        if d.listening.status != Status::Idle {
            d.next = None;
            if let Some(mut s) = d.session.take() {
                let _ = s.child.kill();
            }
            d.end(String::new(), None, None, cx);
        }
    });
}

pub fn open_microphone_settings(cx: &mut App) {
    cx.open_url(SETTINGS);
}

/// Lets ⌘D find a field: called as it's drawn, with how to start a dictation in it.
pub fn takes_dictation(field: &str, focus: &FocusHandle, window: &Window, start: impl Fn(&mut Window, &mut App) + 'static, cx: &mut App) {
    let f = Field { field: field.to_string(), focus: focus.clone(), window: window.window_handle(), start: Rc::new(start), drawn: Instant::now() };
    entity(cx).update(cx, |d, _| {
        d.fields.retain(|x| x.field != f.field);
        d.fields.push(f);
    });
}

/// ⌘D: finishes the dictation under way, or starts one in the main window's view (the menu sends it
/// there, whichever window is in front): in its field with focus, else the one in view.
pub fn toggle(cx: &mut App) {
    if dictating(cx) {
        stop(cx);
        return;
    }
    let Some(front) = super::lifecycle::main_window(cx) else { return };
    let fields: Vec<(FocusHandle, AnyWindowHandle, Rc<dyn Fn(&mut Window, &mut App)>, Instant)> =
        entity(cx).read(cx).fields.iter().filter(|f| f.window == front).map(|f| (f.focus.clone(), f.window, f.start.clone(), f.drawn)).collect();
    let _ = front.update(cx, move |_, window, cx| {
        let here = fields.iter().find(|f| f.0.is_focused(window));
        // In view: drawn in the latest frame.
        let shown = fields.iter().max_by_key(|f| f.3);
        if let Some(f) = here.or(shown) {
            (f.2)(window, cx);
        }
    });
}

impl Drop for Dictation {
    fn drop(&mut self) {
        if let Some(mut s) = self.session.take() {
            let _ = s.child.kill();
        }
    }
}
