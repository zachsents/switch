//! The message box (the desktop's `ui/box.tsx`, `use-box-draft.ts`, `reply-rows.tsx`, `chip.tsx`,
//! and `mic.tsx`'s keys): the whole bottom cell. Enter sends, ⇧Enter breaks the line; "/" from
//! anywhere puts the cursor in it, and so does typing or pasting with no other field taking it.
//! ↑ in the empty box can call back the last message to edit; Esc puts it down. It takes
//! dictation (the platform's engine): the mic or ⌘D starts one, and the words come after what's in
//! it, dimmed until they're done, so several dictations build one message; Enter, ✓ or ⌘D keeps
//! them, × or Esc drops them, and what's sent says which words were dictated, kept through every
//! edit (platform/words.rs). With `attach`, files dropped on the chat or pasted in join it as
//! chips, each uploading at once (the outbox's). Rows over what's typed are what it replies to (a
//! space's box), each with the user's reply. Its draft is kept in the outbox on every change, so a
//! crash or relaunch loses nothing typed, dictated, attached or replied to, and words the core
//! said no to come back to it.

use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext, ClickEvent, Context, Entity, FocusHandle, Focusable, Global,
    InteractiveElement, IntoElement, KeyDownEvent, ParentElement, Render, SharedString, StatefulInteractiveElement,
    Styled, WeakEntity, Window, div, img, prelude::*, px,
};
use serde_json::{Value, json};
use ui_sdk::components::input::{TextFieldStyle, Textarea, TextareaOptions, TextareaSubmitShortcut};
use ui_sdk::kernel::ChangeOptions;

use crate::attached::{FileKind, kind_of};
use crate::brain::Reply;
use crate::chat_marks;
use crate::files::{self, Chosen, Upload};
use crate::kit::{self, Btn};
use crate::look::{Look, u};
use crate::marks;
use crate::model::model;
use crate::nav::Beat;
use crate::outbox;
use crate::platform::dictation::{self as dict, LEVELS, Listening, Status, Stopped};
use crate::platform::words::{self, Span};
use crate::replying;

fn listening_for(field: &str, cx: &App) -> Option<Listening> {
    let l = dict::entity(cx).read(cx).listening.clone();
    (l.status != Status::Idle && l.field.as_deref() == Some(field)).then_some(l)
}

/// Why the last dictation stopped short.
pub fn stopped_text(s: Stopped, message: Option<&str>) -> String {
    match (s, message) {
        (Stopped::Denied, _) => "Microphone not allowed".into(),
        (Stopped::NoInput, _) => "No microphone".into(),
        (Stopped::Missing, _) => "Dictation not installed".into(),
        (Stopped::Failed, None) => "Dictation failed".into(),
        (Stopped::Failed, Some(m)) => format!("Dictation failed: {m}"),
    }
}

/// What's sent: the words, which of them were dictated (`{start, text}`), and the files.
pub struct Sent {
    pub text: String,
    pub dictated: Vec<Value>,
    pub files: Vec<Chosen>,
}

/// A key typed outside any field that the box takes, as the desktop's `typed`: one printable
/// character without ⌘, ⌃ or ⌥, not "/" (the window's own key). Enter, Tab and the like are never
/// one (macOS gives them as "\n", "\t"), and Space is a focused button's press.
pub fn printable(e: &KeyDownEvent, pressing: bool) -> Option<String> {
    let k = &e.keystroke;
    let m = &k.modifiers;
    if m.platform || m.control || m.alt {
        return None;
    }
    let c = k.key_char.clone()?;
    let mut chars = c.chars();
    let one = chars.next()?;
    if chars.next().is_some() || one.is_control() || c == "/" || (one == ' ' && pressing) || k.key == "enter" || k.key == "tab" {
        return None;
    }
    Some(c)
}

/// What the box tells whoever holds it, after its own update: what's sent, ↑ in it empty (the last
/// message to edit, which the holder puts in with `put_text`), and an edit put down.
pub enum BoxEvent {
    Send(Sent),
    Recall,
    Cancel,
}

impl gpui::EventEmitter<BoxEvent> for ChatBox {}

/// What the box is for.
pub struct BoxOptions {
    pub placeholder: String,
    /// Where its draft is kept: `space:<id>`, `thread:<id>`.
    pub place: String,
    /// Files may join it.
    pub attach: bool,
    /// Words are needed to send (the steer box); else words or files.
    pub words_only: bool,
}

pub struct ChatBox {
    pub opts: BoxOptions,
    /// The next paste is the words alone: a paste from outside already brought its files in.
    words_only: bool,
    input: Entity<Textarea>,
    dictated: Vec<Span>,
    files: Vec<Chosen>,
    /// What went wrong with the last one sent.
    pub error: Option<String>,
    stopped: Option<(Stopped, Option<String>)>,
    /// Whether what's in it is an edit.
    pub editing: bool,
    /// The text as it was when the dictation under way started.
    heard_base: Option<String>,
    /// A dictation's end, put in at the next frame (it ends where no window is to hand).
    heard: Option<(String, Option<Stopped>, Option<String>)>,
    /// The space whose replies sit over it.
    replies_of: Option<String>,
    replies: Vec<(Reply, Entity<Textarea>)>,
    seeded: bool,
    last_text: String,
    /// Its width as last laid out: wide, it keeps to the column.
    width: Rc<std::cell::Cell<gpui::Pixels>>,
}

/// Every box made, by place, so a reply's Reply finds the one for its space.
#[derive(Default)]
struct Boxes(Vec<(String, WeakEntity<ChatBox>)>);
impl Global for Boxes {}

/// Puts the cursor in a space's box.
pub fn focus_box_of(space: &str, window: &mut Window, cx: &mut App) {
    let place = format!("space:{space}");
    let found = cx.try_global::<Boxes>().and_then(|b| b.0.iter().find(|(p, _)| *p == place).and_then(|(_, w)| w.upgrade()));
    if let Some(b) = found {
        b.update(cx, |b, cx| b.focus(window, cx));
    }
}

fn field_style(l: &Look) -> TextFieldStyle {
    TextFieldStyle { text_color: Some(l.ink), placeholder_color: Some(l.ink3), caret_color: Some(l.ink), ..Default::default() }
}

/// Dictated stretches as a draft keeps them.
fn spans_json(spans: &[Span]) -> Option<Value> {
    (!spans.is_empty()).then(|| Value::Array(spans.iter().map(|s| json!({ "start": s.start, "end": s.end })).collect()))
}

fn spans_of(v: Option<&Value>) -> Vec<Span> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|s| Some(Span { start: s.get("start")?.as_u64()? as usize, end: s.get("end")?.as_u64()? as usize })).collect())
        .unwrap_or_default()
}

impl ChatBox {
    pub fn new(opts: BoxOptions, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let l = Look::get(cx);
        let weak = cx.entity().downgrade();
        let input = {
            let (change, submit) = (weak.clone(), weak.clone());
            cx.new(|cx| {
                Textarea::new(
                    TextareaOptions::default()
                        .rows(1)
                        .auto_resize(true)
                        .submit_shortcut(TextareaSubmitShortcut::Enter)
                        .field_style(field_style(&l))
                        .on_value_change(move |value, _, window, cx| {
                            let value = value.to_string();
                            change.update(cx, |b, cx| b.changed(value, window, cx)).ok();
                        })
                        .on_submit(move |_, _, window, cx| {
                            let submit = submit.clone();
                            window.defer(cx, move |window, cx| drop(submit.update(cx, |b, cx| b.submit(window, cx))));
                        }),
                    window,
                    cx,
                )
            })
        };
        cx.default_global::<Boxes>().0.push((opts.place.clone(), weak.clone()));
        let d = dict::entity(cx);
        cx.observe(&d, |b: &mut ChatBox, _, cx| {
            if b.heard_base.is_none() && b.listening(cx).is_some() {
                b.heard_base = Some(b.text(cx));
            }
            cx.notify();
        })
        .detach();
        cx.observe(&model(cx), |_, _, cx| cx.notify()).detach();
        let replies_of = opts.place.strip_prefix("space:").map(str::to_string);
        if replies_of.is_some() {
            let r = replying::entity(cx);
            cx.observe_in(&r, window, |b: &mut ChatBox, _, window, cx| {
                b.sync_replies(window, cx);
                cx.notify();
            })
            .detach();
        }
        // Words given back from outside it (a message the core said no to) come in again.
        let place = opts.place.clone();
        cx.subscribe(&model(cx), move |b: &mut ChatBox, _, e: &crate::model::BrainEvent, cx| {
            if let crate::model::BrainEvent::Restored(p) = e
                && *p == place
            {
                b.seeded = false;
                cx.notify();
            }
        })
        .detach();
        ChatBox {
            opts,
            input,
            dictated: vec![],
            files: vec![],
            error: None,
            stopped: None,
            editing: false,
            heard_base: None,
            heard: None,
            replies_of,
            replies: vec![],
            seeded: false,
            words_only: false,
            last_text: String::new(),
            width: Rc::new(std::cell::Cell::new(px(0.))),
        }
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        let input = self.input.clone();
        input.update(cx, |t, cx| t.focus(window, cx));
    }

    pub fn is_focused(&self, window: &Window, cx: &App) -> bool {
        self.input.read(cx).field().read(cx).is_focused(window)
    }

    pub fn text(&self, cx: &App) -> String {
        self.input.read(cx).get_value().to_string()
    }

    fn listening(&self, cx: &App) -> Option<Listening> {
        listening_for(&self.opts.place, cx)
    }

    /// Its words go in once per place, before it's drawn; its files as they're read back.
    fn seed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.seeded {
            return;
        }
        self.seeded = true;
        if let Some(d) = outbox::draft(&self.opts.place) {
            self.seed_from(d, window, cx);
        }
        // What it replies to, kept in its draft, is over it from the first frame (after its words,
        // which keeping the draft writes back).
        self.sync_replies(window, cx);
    }

    fn seed_from(&mut self, d: outbox::Draft, window: &mut Window, cx: &mut Context<Self>) {
        self.last_text = d.text.clone();
        self.dictated = words::from_utf16(&d.text, &spans_of(d.dictated.as_ref()));
        let text = d.text.clone();
        self.input.update(cx, |t, cx| {
            t.set_value(text, ChangeOptions::default(), window, cx);
        });
        let had: Vec<String> = self.files.iter().map(|f| f.id.clone()).collect();
        let back: Vec<Chosen> = d.files.unwrap_or_default().iter().filter(|k| !had.contains(&k.id)).filter_map(files::chosen_of).collect();
        if !back.is_empty() {
            let back = model(cx).update(cx, |m, cx| m.choose(back, cx));
            self.files.extend(back);
        }
    }

    /// Keeps what's in it as its place's draft, unless it holds an edit.
    fn keep(&self, cx: &mut App) {
        if self.editing || self.listening(cx).is_some() {
            return;
        }
        let reply_to = self.replies_of.as_ref().map(|s| replying::replying_to(s, cx)).unwrap_or_default();
        let uploads = &model(cx).read(cx).uploads;
        let d = outbox::Draft {
            text: self.text(cx),
            dictated: spans_json(&words::to_utf16(&self.text(cx), &self.dictated)),
            files: (!self.files.is_empty()).then(|| self.files.iter().map(|c| files::kept_of(c, uploads)).collect()),
            reply_to: (!reply_to.is_empty()).then(|| Value::Array(reply_to.iter().map(Reply::to_kept).collect())),
        };
        outbox::set_draft(&self.opts.place, d);
    }

    fn changed(&mut self, value: String, _window: &mut Window, cx: &mut Context<Self>) {
        if self.heard_base.is_some() {
            return;
        }
        let caret = self.input.read(cx).field().read(cx).selection_end();
        self.dictated = words::edit(&self.dictated, &self.last_text, &value, Some(caret));
        self.last_text = value;
        self.keep(cx);
        cx.notify();
    }

    /// The words go after what's in it, as one edit, marked dictated.
    fn take_heard(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((heard, why, message)) = self.heard.take() else { return };
        let base = self.heard_base.take().unwrap_or_else(|| self.text(cx));
        let mut text = base.clone();
        if let Some((put, span)) = words::insertion(&base, &heard) {
            text.push_str(&put);
            self.dictated = words::add(&self.dictated, span);
        }
        self.last_text = text.clone();
        self.input.update(cx, |t, cx| {
            t.set_value(text, ChangeOptions::default(), window, cx);
        });
        self.stopped = why.map(|w| (w, message));
        self.keep(cx);
        self.focus(window, cx);
    }

    pub fn dictate(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.stopped = None;
        self.heard_base = Some(self.text(cx));
        let weak = cx.entity().downgrade();
        dict::start(
            &self.opts.place,
            Box::new(move |words, why, message, cx| {
                weak.update(cx, |b, cx| {
                    b.heard = Some((words, why, message));
                    cx.notify();
                })
                .ok();
            }),
            cx,
        );
        self.focus(window, cx);
        cx.notify();
    }
    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Enter while dictating keeps the words, to edit and send.
        if self.listening(cx).is_some() {
            dict::stop(cx);
            return;
        }
        let text = self.text(cx);
        let more = self.more(cx);
        if more && text.trim().is_empty() && self.files.is_empty() {
            self.send(Sent { text: String::new(), dictated: vec![], files: vec![] }, window, cx);
            return;
        }
        let valid = if self.opts.words_only { !text.trim().is_empty() } else { !text.trim().is_empty() || !self.files.is_empty() };
        if !valid {
            return;
        }
        let (text, dictated) = words::said(&text, &self.dictated);
        let dictated = dictated.and_then(|v| v.as_array().cloned()).unwrap_or_default();
        let files = std::mem::take(&mut self.files);
        self.send(Sent { text, dictated, files }, window, cx);
    }

    fn send(&mut self, sent: Sent, window: &mut Window, cx: &mut Context<Self>) {
        let editing = self.editing;
        cx.emit(BoxEvent::Send(sent));
        if editing {
            self.end_edit(window, cx);
        } else {
            self.reset(window, cx);
        }
        self.stopped = None;
    }

    /// An edit sent or put down: the box empties without touching the draft it had before the edit
    /// (which kept still while editing), and that draft, its files with it, comes back.
    fn end_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.editing = true;
        self.dictated.clear();
        self.files.clear();
        self.last_text.clear();
        self.input.update(cx, |t, cx| {
            t.clear(ChangeOptions::default(), window, cx);
        });
        self.editing = false;
        self.seeded = false;
        self.seed(window, cx);
        cx.notify();
    }

    /// Empty again: each send, an edit put down.
    pub fn reset(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dictated.clear();
        self.files.clear();
        self.last_text.clear();
        self.input.update(cx, |t, cx| {
            t.clear(ChangeOptions::default(), window, cx);
        });
        self.keep(cx);
        cx.notify();
    }

    /// Words to edit, in place of what's in it.
    pub fn put_text(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        self.last_text = text.clone();
        self.dictated.clear();
        self.input.update(cx, |t, cx| {
            t.set_value(text, ChangeOptions::default(), window, cx);
        });
        cx.notify();
    }

    /// The rows above hold words of the user's own, so it can send with nothing typed.
    fn more(&self, cx: &mut App) -> bool {
        self.replies_of.as_ref().is_some_and(|s| replying::answered(&replying::replying_to(s, cx)))
    }

    /// Files dropped or pasted: they join it, each kept here and uploading at once.
    pub fn attach(&mut self, chosen: Vec<Chosen>, window: &mut Window, cx: &mut Context<Self>) {
        if !self.opts.attach || chosen.is_empty() {
            return;
        }
        let chosen = model(cx).update(cx, |m, cx| m.choose(chosen, cx));
        self.files.extend(chosen);
        self.keep(cx);
        self.focus(window, cx);
        cx.notify();
    }

    fn remove(&mut self, id: &str, cx: &mut Context<Self>) {
        self.files.retain(|c| c.id != id);
        outbox::drop_file(id);
        self.keep(cx);
        cx.notify();
    }

    /// Files on the pasteboard join it as chips (a copied file, a picture's data), as the desktop's
    /// paste takes `clipboardData.files`; answers whether there were any.
    pub fn pasted(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.opts.attach {
            return false;
        }
        let files = files::pasted();
        if files.is_empty() {
            return false;
        }
        // Its chips join it where the cursor is; a paste in a reply row keeps it there.
        let chosen = model(cx).update(cx, |m, cx| m.choose(files, cx));
        self.files.extend(chosen);
        self.keep(cx);
        cx.notify();
        true
    }

    /// Typing that no field took lands here: the key's letter after what's in it.
    /// The cursor goes in it as the key goes down, and the key lands there, at its caret, once the
    /// field is drawn with the keyboard.
    pub fn typed(&mut self, key: gpui::Keystroke, window: &mut Window, cx: &mut Context<Self>) {
        if self.listening(cx).is_some() {
            return;
        }
        self.focus(window, cx);
        // A letter goes in at the caret now, so the next key (which the field takes itself once
        // it's drawn) can't land before it; anything else (⌘V) is the field's own, once it's drawn.
        let plain = !(key.modifiers.platform || key.modifiers.control || key.modifiers.alt);
        if let Some(text) = key.key_char.clone().filter(|_| plain) {
            let field = self.input.read(cx).field().clone();
            field.update(cx, |f, cx| {
                let at = f.selection();
                f.replace_range(at, &text, window, cx);
            });
            return;
        }
        window.on_next_frame(move |window, cx| {
            window.dispatch_keystroke(key, cx);
        });
        window.refresh();
    }

    /// A paste no field took: its files join the box and its words go in at the box's caret, as
    /// the desktop's `pasted` has both.
    pub fn paste_outside(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let files = self.pasted(cx);
        if files {
            self.focus(window, cx);
        }
        let words = files::pasted_words();
        // The field's own paste, once it has the focus: the words go in at its caret (its files
        // are in already).
        if words && self.listening(cx).is_none() {
            self.words_only = files;
            let paste = gpui::Keystroke::parse("cmd-v").expect("cmd-v");
            self.typed(paste, window, cx);
        } else {
            self.focus(window, cx);
        }
    }

    fn cancel_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.end_edit(window, cx);
        cx.emit(BoxEvent::Cancel);
    }

    /// Keys the box hears before its field: ↑ in the empty box, Esc on an edit, ⌘V with files,
    /// ⌘D for dictation.
    fn key(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let k = &e.keystroke;
        let m = &k.modifiers;
        let listening = self.listening(cx).is_some();
        // While it listens the field is read-only: its words are the dictation's. Enter still keeps
        // them (`submit`), and Tab still moves on.
        let eats = match k.key.as_str() {
            "enter" => m.shift,
            "tab" => false,
            _ => k.key_char.is_some(),
        };
        if listening && eats && !m.platform && !m.control {
            cx.stop_propagation();
            window.prevent_default();
            return;
        }
        // Enter sends (or keeps a dictation), from the box's field or a reply row: taken here, so
        // the field never also writes its line break, and the send comes after this key's own
        // update rather than inside the field's.
        if k.key == "enter" && !m.shift && !m.platform && !m.control && !m.alt && !ui_sdk::kernel::is_composing(window, cx) && crate::follow::in_field(window) {
            cx.stop_propagation();
            window.prevent_default();
            cx.defer_in(window, |b, window, cx| b.submit(window, cx));
            return;
        }
        if k.key == "up" && !m.platform && !m.control && !m.alt && !m.shift && self.text(cx).is_empty() && !listening {
            // An empty box's ↑ moves nothing: it asks for the last message to edit.
            cx.stop_propagation();
            window.prevent_default();
            cx.emit(BoxEvent::Recall);
        }
    }

    /// The reply fields over the box, one per reply, made as replies come and go.
    fn sync_replies(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(space) = self.replies_of.clone() else { return };
        let now = replying::replying_to(&space, cx);
        let same = now.len() == self.replies.len() && now.iter().zip(&self.replies).all(|(a, (b, _))| a.same(b));
        if !same {
            let l = Look::get(cx);
            let mut next = vec![];
            for r in &now {
                let field = match self.replies.iter().find(|(b, _)| b.same(r)) {
                    Some((_, f)) => f.clone(),
                    None => {
                        let (s, which) = (space.clone(), r.clone());
                        let submit = cx.entity().downgrade();
                        let reply = r.reply().to_string();
                        cx.new(|cx| {
                            Textarea::new(
                                TextareaOptions::default()
                                    .rows(1)
                                    .auto_resize(true)
                                    .default_value(reply)
                                    .placeholder("Reply…")
                                    .submit_shortcut(TextareaSubmitShortcut::Enter)
                                    .field_style(field_style(&l))
                                    .on_value_change(move |v, _, _, cx| {
                                        let now = replying::replying_to(&s, cx);
                                        if let Some(at) = now.iter().position(|x| x.same(&which)) {
                                            replying::answer(&s, at, v.to_string(), cx);
                                        }
                                    })
                                    .on_submit(move |_, _, window, cx| {
                                        let submit = submit.clone();
                                        window.defer(cx, move |window, cx| drop(submit.update(cx, |b, cx| b.submit(window, cx))));
                                    }),
                                window,
                                cx,
                            )
                        })
                    }
                };
                next.push((r.clone(), field));
            }
            self.replies = next;
        }
        if let Some(at) = replying::entity(cx).update(cx, |r, _| r.take_focus(&space))
            && let Some((_, f)) = self.replies.get(at)
        {
            let f = f.clone();
            f.update(cx, |t, cx| t.focus(window, cx));
        }
        self.keep(cx);
    }
}

const KIND: [(FileKind, &str); 5] = [(FileKind::Image, "IMG"), (FileKind::Video, "VID"), (FileKind::Audio, "AUD"), (FileKind::Model, "3D"), (FileKind::File, "FILE")];

/// A row above the box: what went wrong with the last one sent, or with dictation.
fn note(text: String, on_click: Option<Rc<dyn Fn(&mut App)>>, l: &Look) -> AnyElement {
    let row = div()
        .id("box-note")
        .flex()
        .h(u(24.))
        .w_full()
        .items_center()
        .gap(u(8.))
        .px(u(12.))
        .text_size(u(12.))
        .line_height(u(16.))
        .text_color(l.ink)
        .border_b(px(l.w2))
        .border_color(l.line2)
        .child(marks::stop(px(12.), l))
        .child(div().min_w_0().truncate().child(text));
    match on_click {
        Some(f) => row.hover(|s| s.bg(l.hover)).tab_index(0).focus_visible(|s| s.bg(l.hover)).on_click(move |_, _, cx| f(cx)).into_any_element(),
        None => row.into_any_element(),
    }
}

/// How loud they've been lately, newest on the right; it pulses until it hears, and as it finishes.
fn meter(levels: &[f32], busy: bool, _beat: usize, l: &Look) -> AnyElement {
    let pad = LEVELS.saturating_sub(levels.len());
    let bars = div().flex().items_center().gap(px(1.5)).h(u(20.)).children((0..LEVELS).map(|i| {
        let level = if i < pad { 0. } else { levels.get(i - pad).copied().unwrap_or(0.) };
        div().w(px(2.)).rounded_full().bg(l.ink2).h(px(2. + 16. * level))
    }));
    if !busy {
        return bars.into_any_element();
    }
    // Tailwind's animate-pulse: to half and back every two seconds, eased.
    gpui::AnimationExt::with_animation(bars, "meter-pulse", gpui::Animation::new(std::time::Duration::from_secs(2)).repeat(), |d, t| {
        let half = if t < 0.5 { t * 2. } else { (1. - t) * 2. };
        d.opacity(1. - 0.5 * gpui::ease_in_out(half))
    })
    .into_any_element()
}

impl Render for ChatBox {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = Look::get(cx);
        self.seed(window, cx);
        self.take_heard(window, cx);
        if dict::can_dictate() {
            let weak = cx.entity().downgrade();
            let focus = self.input.read(cx).focus_handle(cx);
            dict::takes_dictation(&self.opts.place, &focus, window, move |window, cx| {
                weak.update(cx, |b, cx| b.dictate(window, cx)).ok();
            }, cx);
        }
        let listening = self.listening(cx);
        // While it listens, the words heard so far show after what's typed, dimmed.
        if let (Some(heard), Some(base)) = (&listening, &self.heard_base) {
            let shown = match words::insertion(base, &heard.words) {
                Some((put, _)) => format!("{base}{put}"),
                None => base.clone(),
            };
            if self.text(cx) != shown {
                self.input.update(cx, |t, cx| {
                    t.set_value(shown, ChangeOptions::default(), window, cx);
                });
            }
        }
        let text = self.text(cx);
        let more = self.more(cx);
        let ready = if !text.trim().is_empty() || !self.files.is_empty() {
            if self.opts.words_only { !text.trim().is_empty() } else { true }
        } else {
            more
        };
        let focused = self.is_focused(window, cx);
        let can_dictate = dict::can_dictate();
        let beat = Beat::step(cx);
        let width = window.viewport_size().width;
        let _ = width;
        let field = Textarea::root(&self.input, cx)
            .aria_label(SharedString::from(self.opts.placeholder.clone()))
            .flex_1()
            .min_w_0()
            .max_h(u(240.))
            .min_h(u(22.))
            .py(px(1.))
            .text_size(u(14.))
            .line_height(u(20.))
            .text_color(if listening.is_some() { l.ink2 } else { l.ink });
        // There till words are in it, the dictation's too.
        let placeholder = text.is_empty().then(|| {
            div()
                .absolute()
                .left_0()
                .right_0()
                .top(px(1.))
                .flex()
                .items_center()
                .gap(u(6.))
                .text_size(u(14.))
                .line_height(u(20.))
                .text_color(l.ink3)
                .child(div().min_w_0().truncate().child(SharedString::from(self.opts.placeholder.clone())))
                .when(!focused, |d| {
                    d.child(div().flex_none().rounded(px(2.)).border_1().border_color(l.line2).px(px(4.)).text_size(u(11.)).line_height(px(16.)).text_color(l.ink3).child("/"))
                })
        });
        let send = kit::button("send", Btn::Go, ready, &l).aria_label("Send")
            .when(ready, |d| d.on_click(cx.listener(|b, _, window, cx| b.submit(window, cx))))
            .child("Send");
        let keys: AnyElement = match &listening {
            Some(heard) => div()
                .flex()
                .flex_none()
                .items_center()
                .gap(u(8.))
                .child(meter(&heard.levels, heard.status != Status::Listening, beat, &l))
                .child(kit::button("dictate-cancel", Btn::Flat, true, &l).aria_label("Cancel").w(u(22.)).px_0().on_click(|_, _, cx| dict::cancel(cx)).child(chat_marks::drawn("cancel", px(16.), l.ink2)))
                .child(kit::button("dictate-done", Btn::Key, !(heard.status == Status::Stopping), &l).aria_label("Done").on_click(|_, _, cx| dict::stop(cx)).child(chat_marks::drawn("done", px(16.), l.ink)))
                .into_any_element(),
            None => div()
                .flex()
                .flex_none()
                .items_end()
                .gap(u(6.))
                .when(can_dictate, |d| {
                    d.child(kit::button("dictate", Btn::Flat, true, &l).aria_label("Dictate").w(u(22.)).px_0().on_click(cx.listener(|b, _, window, cx| b.dictate(window, cx))).child(chat_marks::drawn("mic", px(16.), l.ink2)))
                })
                .child(send)
                .into_any_element(),
        };
        let stopped_fix: Option<Rc<dyn Fn(&mut App)>> = match &self.stopped {
            Some((Stopped::Denied, _)) => Some(Rc::new(dict::open_microphone_settings)),
            _ => None,
        };
        let m = model(cx).read(cx);
        let ask_of = |id: &str| m.brain.items.find(id).map(|a| (a.title.clone(), m.brain.spaces.get(&a.space).map(|s| s.name.clone()).unwrap_or_else(|| "Home".into())));
        let pairs: Vec<AnyElement> = self
            .replies
            .iter()
            .enumerate()
            .map(|(i, (r, f))| {
                let head: AnyElement = match r {
                    Reply::Quote { text, .. } => div().min_w_0().flex_1().border_l_2().border_color(l.ink3).pl(u(8.)).line_clamp(2).whitespace_normal().child(SharedString::from(text.clone())).into_any_element(),
                    Reply::Ask { id, title, .. } => {
                        let (name, space) = ask_of(id).unwrap_or_else(|| (title.clone().unwrap_or_default(), String::new()));
                        div()
                            .flex()
                            .flex_1()
                            .min_w_0()
                            .items_center()
                            .gap(u(8.))
                            .child(marks::hand(px(12.), &l))
                            .child(div().min_w_0().truncate().text_color(l.ink).child(name))
                            .child(div().flex_none().text_color(l.ink3).child(space))
                            .into_any_element()
                    }
                };
                let space = self.replies_of.clone().unwrap_or_default();
                let focus_field = f.clone();
                div()
                    .flex()
                    .min_w_0()
                    .items_start()
                    .gap(u(8.))
                    .pr(u(4.))
                    .pl(u(12.))
                    .border_b(px(l.w2))
                    .border_color(l.line2)
                    .child(
                        div()
                            .id(SharedString::from(format!("reply-pair-{i}")))
                            .flex()
                            .flex_1()
                            .min_w_0()
                            .flex_col()
                            .gap(u(4.))
                            .pt(u(6.))
                            .pb(u(4.))
                            .cursor_text()
                            .on_click(move |_, window, cx| focus_field.update(cx, |t, cx| t.focus(window, cx)))
                            .child(div().flex().min_h(u(24.)).min_w_0().items_center().text_size(u(12.)).line_height(u(16.)).text_color(l.ink2).child(head))
                            .child(div().pl(u(10.)).child(Textarea::root(f, cx).aria_label("Reply").w_full().max_h(u(160.)).min_h(u(22.)).py(px(1.)).text_size(u(14.)).line_height(u(20.)).text_color(l.ink))),
                    )
                    .child(kit::button(SharedString::from(format!("reply-remove-{i}")), Btn::Flat, true, &l).aria_label("Remove").mt(u(6.)).on_click(move |_, _, cx| replying::detach(&space, i, cx)).child("✕"))
                    .into_any_element()
            })
            .collect();
        let files_now = self.files.clone();
        let uploads: std::collections::HashMap<String, Upload> = files_now.iter().filter_map(|c| model(cx).read(cx).uploads.get(&c.id).map(|u| (c.id.clone(), u.clone()))).collect();
        let chips: Vec<AnyElement> = files_now
            .iter()
            .map(|c| {
                let kind = kind_of(&files::type_of(&c.name, &c.kind), &c.name);
                let id = c.id.clone();
                let status: AnyElement = match uploads.get(&c.id) {
                    Some(Upload::Failed { reason, .. }) => {
                        let why = SharedString::from(reason.clone());
                        div().id(SharedString::from(format!("chip-err-{id}"))).flex().flex_none().items_center().tooltip(crate::band::tip(why)).child(marks::stop(px(12.), &l)).into_any_element()
                    }
                    Some(Upload::Up(_)) => div().flex_none().text_size(u(11.)).font_features(crate::chat_marks::tabular()).text_color(l.ink3).child(files::size_of(c.size)).into_any_element(),
                    _ => chat_marks::spin12(&l, beat).into_any_element(),
                };
                let preview = c.is_image().then(|| crate::pictures::Pictures::local(c.path(), 80, cx)).flatten();
                div()
                    .flex()
                    .h(u(40.))
                    .max_w(u(256.))
                    .items_center()
                    .gap(u(8.))
                    .rounded(u(4.))
                    .border_1()
                    .border_color(l.line2)
                    .bg(l.bg)
                    .pr(u(4.))
                    .text_size(u(12.))
                    .overflow_hidden()
                    .child(match preview {
                        Some(p) => img(p).size(u(40.)).flex_none().object_fit(gpui::ObjectFit::Cover).into_any_element(),
                        None => div()
                            .flex()
                            .flex_none()
                            .size(u(40.))
                            .items_center()
                            .justify_center()
                            .border_r_1()
                            .border_color(l.line2)
                            .text_size(u(11.))
                            .text_color(l.ink3)
                            .child(KIND.iter().find(|(k, _)| *k == kind).map(|(_, s)| *s).unwrap_or("FILE"))
                            .into_any_element(),
                    })
                    .child(div().min_w_0().flex_1().truncate().text_color(l.ink).child(if c.name.is_empty() { "file".to_string() } else { c.name.clone() }))
                    .child(status)
                    .child(
                        kit::button(SharedString::from(format!("chip-x-{id}")), Btn::Bare, true, &l)
                            .aria_label(format!("Remove {}", if c.name.is_empty() { "file" } else { &c.name }))
                            .border_1()
                            .border_color(gpui::transparent_black())
                            .focus_visible(|s| s.border_color(l.ink3))
                            .flex()
                            .flex_none()
                            .size(u(28.))
                            .items_center()
                            .justify_center()
                            .rounded(u(4.))
                            .text_color(l.ink3)
                            .hover(|s| s.bg(l.hover))
                            .on_click(cx.listener(move |b, _: &ClickEvent, _, cx| b.remove(&id, cx)))
                            .child("×"),
                    )
                    .into_any_element()
            })
            .collect();
        let error = self.error.clone();
        let stopped = self.stopped.clone();
        let editing = self.editing;
        let wide = self.width.get() >= l.z(768.);
        let side = if wide { (self.width.get() - l.z(720.)) / 2. } else { px(0.) };
        let width = self.width.clone();
        div()
            .id(SharedString::from(format!("box-{}", self.opts.place)))
            .flex_none()
            .flex()
            .flex_col()
            .border_t(px(l.w2))
            .border_color(l.line2)
            .capture_key_down(cx.listener(|b, e: &KeyDownEvent, window, cx| b.key(e, window, cx)))
            // ⌘V and Edit ▸ Paste in its field or a reply row: files on the pasteboard join it as
            // chips and nothing else is pasted, as the desktop's field takes a paste with files;
            // words alone are the field's to paste. (⌘V is a menu key and a binding, so it comes
            // here as the action, never as a key.)
            .capture_action(cx.listener(|b, _: &ui_sdk::native::text_field::Paste, _, cx| {
                if std::mem::take(&mut b.words_only) {
                    return;
                }
                if b.pasted(cx) {
                    cx.stop_propagation();
                }
            }))
            // Esc drops a dictation, else puts an edit down; else it's the window's (up a space).
            .on_action(cx.listener(|b, _: &crate::commands::Escape, window, cx| {
                // An edit's Esc is the box's own field's; in a reply row it's the window's.
                if b.listening(cx).is_some() {
                    dict::cancel(cx);
                } else if b.editing && b.is_focused(window, cx) {
                    b.cancel_edit(window, cx);
                } else {
                    cx.propagate();
                }
            }))
            .child(gpui::canvas(move |bounds, _, _| width.set(bounds.size.width), |_, _, _, _| {}).absolute().size_full())
            .when(editing, |d| {
                d.child(
                    div()
                        .flex()
                        .h(u(24.))
                        .items_center()
                        .gap(u(8.))
                        .px(u(12.))
                        .text_size(u(12.))
                        .text_color(l.ink2)
                        .border_b(px(l.w2))
                        .border_color(l.line2)
                        .child(div().flex_1().child("Editing"))
                        .child(kit::button("edit-cancel", Btn::Key, true, &l).on_click(cx.listener(|b, _, window, cx| b.cancel_edit(window, cx))).aria_label("Cancel").child("Cancel")),
                )
            })
            .when_some(error, |d, e| d.child(note(e, None, &l)))
            .when(self.error.is_none(), |d| d.when_some(stopped, |d, (s, msg)| d.child(note(stopped_text(s, msg.as_deref()), stopped_fix.clone(), &l))))
            .children(pairs)
            .when(!chips.is_empty(), |d| d.child(div().flex().flex_wrap().gap(u(8.)).px(u(12.)).pt(u(10.)).children(chips)))
            .child(
                div()
                    .id("box-cell")
                    .flex()
                    .min_h(u(48.))
                    .cursor_text()
                    .items_end()
                    .gap(u(6.))
                    .py(u(10.))
                    .map(|d| if wide { d.px(side.max(px(12.))) } else { d.pr(u(10.)).pl(u(12.)) })
                    .on_click(cx.listener(|b, _, window, cx| b.focus(window, cx)))
                    .child(div().relative().flex().flex_1().min_w_0().children(placeholder).child(field))
                    .child(keys),
            )
    }
}

impl Focusable for ChatBox {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.input.read(cx).focus_handle(cx)
    }
}
