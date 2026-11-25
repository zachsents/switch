//! An ask in full, as old Switchboard's card (the desktop's `ask-card.tsx`, `ask-answer.tsx`,
//! `ask-reply.tsx`, `ask-sealed.tsx`, `ask-decided.tsx`, `use-held.ts`, `use-draft-edits.ts`,
//! `connection-actions.tsx`, `connection-verify.tsx`): a head line (the hand, what kind it is, how
//! long ago, the model that wrote it), its title and its words as Markdown in a quieter size, its
//! live view (portal.rs), its files in a row, then what the user can do: an approval's drafts to
//! edit (kept here at each keystroke, sent once typing rests, not an approval), one green key, the
//! options as keys, an Answer field, and Reply and Dismiss at the row's end. What they do is held
//! five seconds with Undo before it goes; leaving the card sends it at once. Closed, it's read-only:
//! how it ended as the head's mark, and what was decided in place of what the user can do.

use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;
use std::time::Duration;

use gpui::{
    AnyElement, App, AppContext, Context, Focusable, Entity, FontWeight, InteractiveElement, IntoElement, ParentElement, Render, SharedString, StatefulInteractiveElement,
    Styled, Task, Window, div, prelude::*, px,
};
use ui_sdk::components::input::{Input, InputOptions, Textarea, TextareaOptions, TextareaSubmitShortcut};
use ui_sdk::kernel::ChangeOptions;
use ui_sdk::native::TextFieldKind;

use crate::asks::{files, portal::Portal};
use crate::mutations::{CloseAs, Done, ItemAnswer};
use crate::outbox;
use crate::items::{ActionItem, Kind, ending_of};
use crate::kit::{self, Btn, button};
use crate::look::{Look, u};
use crate::markdown::{self, Doc};
use crate::marks;
use crate::model::model;
use crate::settings::parts::action_error;
use crate::time::{age_of, now_ms};

/// How long what the user did is held for Undo.
const HOLD_MS: u64 = 5000;
/// How long typing rests before an edit is sent.
const SAVE_MS: u64 = 800;

/// What the user did with an item, held a moment for Undo before it goes.
#[derive(Clone)]
struct Held {
    id: String,
    done: Done,
    label: String,
    sent: bool,
}

/// An assist key's call, a sign-in check, a reply or a sealed answer going.
#[derive(Default)]
struct Going {
    pending: bool,
    error: Option<String>,
}

pub struct AskCard {
    id: String,
    item: ActionItem,
    held: Option<Held>,
    hold_timer: Option<Task<()>>,
    /// What the brain said when it didn't take what was held: the keys come back.
    error: Option<String>,
    replying: bool,
    reply: Entity<Textarea>,
    reply_going: Going,
    answer: Entity<Textarea>,
    sealed: Entity<Input>,
    sealed_going: Going,
    assist: Going,
    /// Each draft's field, by its name, in the item's order.
    drafts: Vec<(String, Entity<Textarea>)>,
    /// The versions the fields last took from the core, by draft.
    seen: HashMap<String, String>,
    /// What this card has kept of each draft, so its own edits coming back aren't news.
    mine: HashMap<String, String>,
    /// The edit kept here and not sent yet, by its command's id.
    pending_edit: Option<String>,
    save_timer: Option<Task<()>>,
    /// A draft field had the keyboard as the card last drew: leaving it sends the edit at once.
    in_draft: bool,
    body: Option<(String, Rc<Doc>)>,
    /// The reply field's read-only state to set as it next draws, and whether it takes the cursor.
    reply_mode: Option<bool>,
    reply_focus: bool,
    /// The reply closed: its field and what came of sending it go, a fresh one in their place.
    renew_reply: bool,
    /// Undone: the answer's fields go, fresh ones in their place.
    remount: bool,
    /// The space shown when it last looked: back on it, the drafts' copies are asked for again.
    shown_here: bool,
    /// Values the card puts in its fields as it next draws (the core's newer draft, a reply sent).
    to_set: Vec<(Entity<Textarea>, Option<String>)>,
    portal: Portal,
    /// Each files row's sideways scroll, by row.
    scrolls: HashMap<String, gpui::ScrollHandle>,
    /// The card itself: what the brain says of what it held comes back to this card only.
    me: gpui::WeakEntity<AskCard>,
    /// The errors read out already, so each is announced once as it shows.
    announced: Vec<String>,
    /// What the sealed field is for, as its label and placeholder last took it.
    sealed_use: String,
    /// The age in the head, again every 30 seconds (`useNow`).
    _ticking: Task<()>,
    /// In a window of its own: its videos bigger.
    pub own: bool,
    portal_tick: Option<Task<()>>,
    /// Reply attaches it to its space's box instead of opening a field here.
    pub on_reply: Option<Rc<dyn Fn(&ActionItem, &mut Window, &mut App)>>,
}

/// The reply's field: Enter sends; read-only while it's going.
fn reply_options(weak: gpui::WeakEntity<AskCard>, read_only: bool) -> TextareaOptions {
    let w2 = weak.clone();
    TextareaOptions::default()
        .placeholder("Reply…")
        .rows(1)
        .auto_resize(true)
        .read_only(read_only)
        .submit_shortcut(TextareaSubmitShortcut::Enter)
        .field_style(kit::field_style())
        .on_value_change(move |_, _, _, cx| {
            w2.update(cx, |_, cx| cx.notify()).ok();
        })
        .on_submit(move |value, _, window, cx| {
            let text = value.trim().to_string();
            weak.update(cx, |this, cx| this.send_reply(text, window, cx)).ok();
        })
}

/// The typed answer: Enter answers.
fn answer_options(weak: gpui::WeakEntity<AskCard>) -> TextareaOptions {
    TextareaOptions::default().placeholder("Answer…").rows(1).auto_resize(true).submit_shortcut(TextareaSubmitShortcut::Enter).field_style(kit::field_style()).on_submit(move |value, _, _, cx| {
        let text = value.trim().to_string();
        weak.update(cx, |this, cx| this.answer_text(text, cx)).ok();
    })
}

/// The sealed field: a password's, labelled with what it's for.
fn sealed_options(weak: gpui::WeakEntity<AskCard>, usage: &str) -> InputOptions {
    InputOptions::default().kind(TextFieldKind::Password).placeholder(usage.to_string()).field_style(kit::field_style()).on_value_change(move |_, _, _, cx| {
        weak.update(cx, |_, cx| cx.notify()).ok();
    })
}

/// What went wrong, as the house shows an error (`safe-error.ts`): no addresses, tokens or secrets,
/// at most 400 characters.
fn safe(e: &str) -> String {
    crate::mutations::safe_error(e)
}

/// A draft's field, its edits kept as typed.
fn draft_field(start: String, window: &mut Window, cx: &mut Context<AskCard>) -> Entity<Textarea> {
    let weak = cx.entity().downgrade();
    cx.new(|cx| {
        Textarea::new(
            TextareaOptions::default().default_value(start).rows(2).auto_resize(true).field_style(kit::field_style()).on_value_change(move |_, details, _, cx| {
                // A value the card put in itself (the core's newer version) isn't typing.
                if matches!(details.source, ui_sdk::kernel::ChangeSource::Programmatic) {
                    return;
                }
                weak.update(cx, |this, cx| this.keep_edits(cx)).ok();
            }),
            window,
            cx,
        )
    })
}

/// A field in a card: full width, on a hairline (ink3 while it has the keyboard), its whole box the
/// click.
fn field_box(id: &str, focus: gpui::FocusHandle, l: &Look, window: &Window, cx: &App) -> gpui::Stateful<gpui::Div> {
    let on = focus.contains_focused(window, cx);
    div()
        .id(gpui::ElementId::Name(id.to_string().into()))
        .min_h(u(32.))
        .w_full()
        .rounded(u(4.))
        .border_1()
        .border_color(if on { l.ink3 } else { l.line2 })
        .bg(l.bg)
        .px(u(10.))
        .py(u(6.))
        .text_size(u(14.))
        .line_height(u(20.))
        .text_color(l.ink)
        .cursor_text()
        .on_mouse_down(gpui::MouseButton::Left, move |_, window, cx| {
            // Its own: the window's root would take the keyboard back otherwise.
            window.focus(&focus, cx);
            window.prevent_default();
        })
}

/// A key in the card, a button to VoiceOver by its words.
fn key(id: impl Into<gpui::ElementId>, look: Btn, on: bool, l: &Look, name: impl Into<SharedString>) -> gpui::Stateful<gpui::Div> {
    let name: SharedString = name.into();
    button(id, look, on, l).role(gpui::Role::Button).aria_label(name.clone()).child(name)
}

/// A field's most (`max-h-40`, border and padding inside it).
const FIELD_MOST: f32 = 160. - 12. - 2.;

/// What the sealed field is for: its label and placeholder.
fn use_of(item: &ActionItem) -> String {
    item.sealed.as_ref().map(|s| s.usage.clone()).unwrap_or_else(|| "Secret".into())
}

impl AskCard {
    pub fn new(item: ActionItem, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let weak = cx.entity().downgrade();
        let answer = cx.new(|cx| Textarea::new(answer_options(weak.clone()), window, cx));
        let reply = cx.new(|cx| Textarea::new(reply_options(weak.clone(), false), window, cx));
        let usage = use_of(&item);
        let sealed = cx.new(|cx| Input::new(sealed_options(weak.clone(), &usage), window, cx));
        // The fields open on his newest version: kept here from before, else saved, else the agent's.
        let opening = model(cx).read(cx).kept_edit(&item.id);
        let shown: HashMap<String, String> = item.drafts.iter().map(|d| (d.name.clone(), item.shown_text(d))).collect();
        let mine: HashMap<String, String> = opening.as_ref().map(|(_, ds)| ds.clone()).unwrap_or_default();
        let drafts = item.drafts.iter().map(|d| (d.name.clone(), draft_field(mine.get(&d.name).cloned().unwrap_or_else(|| item.shown_text(d)), window, cx))).collect();
        // One kept from before may be on its way already, so new words go under a new id; a quiet copy
        // sends nothing, so it keeps the one.
        let pending_edit = if outbox::quiet() { opening.as_ref().map(|(id, _)| id.clone()) } else { None };
        // Its card opened: the core brings each draft's copy (an email draft) and the card to one version.
        if !item.drafts.is_empty() {
            let id = item.id.clone();
            model(cx).update(cx, |m, cx| m.item_drafts(&id, cx)).detach();
        }
        // The card or its window going sends the last edit, and what's held, at once.
        cx.on_release(|this: &mut AskCard, cx| {
            this.send_edit(cx);
            this.go(cx);
        })
        .detach();
        cx.observe(&model(cx), |this: &mut AskCard, _, cx| this.refresh(cx)).detach();
        // A card in its space's chat: leaving the space sends what's held at once, and coming back
        // asks for the drafts' latest copies again.
        cx.observe(&crate::nav::Nav::entity(cx), |this: &mut AskCard, nav, cx| {
            if this.on_reply.is_none() {
                return;
            }
            let here = nav.read(cx).page == crate::nav::Page::Space(this.item.space.clone());
            if here == this.shown_here {
                return;
            }
            this.shown_here = here;
            if here {
                if !this.item.drafts.is_empty() {
                    let id = this.item.id.clone();
                    model(cx).update(cx, |m, cx| m.item_drafts(&id, cx)).detach();
                }
            } else {
                // Gone from the screen, as the desktop's card unmounts: its live view goes too.
                this.send_edit(cx);
                this.go(cx);
                this.portal.close();
                this.portal.let_go();
                cx.notify();
            }
        })
        .detach();
        // The age in the head moves on every 30 seconds.
        let ticking = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(30)).await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        });
        AskCard {
            id: item.id.clone(),
            portal: Portal::new(&item.id, cx),
            scrolls: HashMap::new(),
            me: weak,
            announced: vec![],
            sealed_use: usage,
            _ticking: ticking,
            own: false,
            item,
            held: None,
            hold_timer: None,
            error: None,
            replying: false,
            reply,
            reply_going: Going::default(),
            answer,
            sealed,
            sealed_going: Going::default(),
            assist: Going::default(),
            drafts,
            seen: shown,
            mine,
            pending_edit,
            save_timer: None,
            in_draft: false,
            body: None,
            to_set: vec![],
            reply_mode: None,
            reply_focus: false,
            renew_reply: false,
            remount: false,
            shown_here: true,
            portal_tick: None,
            on_reply: None,
        }
    }

    pub fn item(&self) -> &ActionItem {
        &self.item
    }

    /// Its live view's controller is open, with the keyboard.
    pub fn controlling(&self) -> bool {
        self.portal.controlling()
    }

    /// The item as the brain has it now (open, or lately closed); a window opened on a closed one
    /// keeps it as it was decided.
    fn refresh(&mut self, cx: &mut Context<Self>) {
        let now = model(cx).read(cx).brain.items.find(&self.id).cloned();
        if let Some(now) = now
            && now != self.item
        {
            // Closed: its live view goes.
            if !now.is_open() {
                self.portal.close();
                self.portal.let_go();
            }
            self.item = now;
            self.took(cx);
            cx.notify();
        }
    }

    /// The core's newer version of a draft (his edit on another device, or in a draft's copy) goes in,
    /// unless he's typed over it here.
    fn took(&mut self, cx: &mut Context<Self>) {
        let now: HashMap<String, String> = self.item.drafts.iter().map(|d| (d.name.clone(), self.item.shown_text(d))).collect();
        for (name, text) in &now {
            let Some(before) = self.seen.get(name).cloned() else { continue };
            if *text == before || self.mine.get(name) == Some(text) {
                continue;
            }
            let Some(field) = self.field(name) else { continue };
            if field.read(cx).get_value().as_ref() != before {
                continue;
            }
            self.to_set.push((field, Some(text.clone())));
        }
        self.seen.extend(now);
    }

    fn field(&self, name: &str) -> Option<Entity<Textarea>> {
        self.drafts.iter().find(|(n, _)| n == name).map(|(_, f)| f.clone())
    }

    /// A files row's own sideways scroll.
    fn scroll(&mut self, key: &str) -> gpui::ScrollHandle {
        self.scrolls.entry(key.to_string()).or_default().clone()
    }

    /// The fields follow the drafts the item has now: one a revision adds is shown (his kept
    /// version, else the item's), one it drops goes. What Approve sends is always what's shown.
    fn sync_drafts(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut next = Vec::with_capacity(self.item.drafts.len());
        for d in self.item.drafts.clone() {
            let field = match self.field(&d.name) {
                Some(f) => f,
                None => {
                    let start = self.mine.get(&d.name).cloned().unwrap_or_else(|| self.item.shown_text(&d));
                    self.seen.insert(d.name.clone(), self.item.shown_text(&d));
                    draft_field(start, window, cx)
                }
            };
            next.push((d.name.clone(), field));
        }
        self.drafts = next;
    }

    /// Keeps his version on this Mac at once, and sends it once typing rests.
    fn keep_edits(&mut self, cx: &mut Context<Self>) {
        let left: HashMap<String, String> = self.drafts.iter().map(|(n, f)| (n.clone(), f.read(cx).get_value().to_string())).collect();
        let mut changed: HashMap<String, String> = HashMap::new();
        for d in &self.item.drafts {
            match left.get(&d.name) {
                Some(t) if *t != self.item.shown_text(d) => {
                    changed.insert(d.name.clone(), t.clone());
                    self.mine.insert(d.name.clone(), t.clone());
                }
                _ => {
                    self.mine.remove(&d.name);
                }
            }
        }
        if changed.is_empty() {
            if let Some(id) = self.pending_edit.take() {
                outbox::drop(&id, false);
            }
            cx.notify();
            return;
        }
        let id = self.pending_edit.get_or_insert_with(|| uuid::Uuid::new_v4().to_string()).clone();
        model(cx).read(cx).keep_edit(&id, &self.item.id, &changed, SAVE_MS);
        self.save_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(SAVE_MS)).await;
            this.update(cx, |this, cx| this.send_edit(cx)).ok();
        }));
        cx.notify();
    }

    /// Sends what's kept and not sent yet, now.
    fn send_edit(&mut self, cx: &mut App) {
        self.save_timer = None;
        let Some(id) = self.pending_edit.take() else { return };
        let item = self.item.id.clone();
        let Some((kept, drafts)) = model(cx).read(cx).kept_edit(&item) else { return };
        if kept != id {
            return;
        }
        model(cx).update(cx, |m, cx| m.edit_item(&id, &item, drafts, cx)).detach();
    }

    /// Holds what the user did a few seconds, with Undo; kept from the click so it can't be lost.
    fn hold(&mut self, done: Done, label: String, cx: &mut Context<Self>) {
        self.error = None;
        let id = uuid::Uuid::new_v4().to_string();
        model(cx).read(cx).hold(&id, &done, HOLD_MS);
        self.held = Some(Held { id, done, label, sent: false });
        self.hold_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(HOLD_MS)).await;
            this.update(cx, |this, cx| {
                this.go(cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Undo drops what's held, and the answer comes back as it mounts afresh (ask-card.tsx): its
    /// fields from his kept version, else the item's, nothing typed, the drafts' copies asked for.
    fn undo(&mut self, cx: &mut Context<Self>) {
        self.hold_timer = None;
        if let Some(h) = self.held.take() {
            model(cx).read(cx).unhold(&h.id);
        }
        self.remount = true;
        if !self.item.drafts.is_empty() {
            let id = self.item.id.clone();
            model(cx).update(cx, |m, cx| m.item_drafts(&id, cx)).detach();
        }
        cx.notify();
    }

    /// What's held goes, with the id it was kept under, so a resend after a relaunch is the same
    /// command; one the brain won't take brings the keys back with its reason.
    fn go(&mut self, cx: &mut App) {
        self.hold_timer = None;
        let Some(h) = self.held.as_mut().filter(|h| !h.sent) else { return };
        h.sent = true;
        let (id, done) = (h.id.clone(), h.done.clone());
        let job = model(cx).update(cx, |m, cx| m.done(&id, &done, cx));
        let me = self.me.clone();
        cx.spawn(async move |cx| {
            if let Err(r) = job.await {
                // Not a command the brain would take: nothing to send again.
                outbox::drop(&id, false);
                let reason = if r.is_empty() { "Didn't go through".to_string() } else { r };
                me.update(cx, |this, cx| {
                    this.held = None;
                    this.error = Some(safe(&reason));
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    fn approve(&mut self, cx: &mut Context<Self>) {
        // Exactly what's shown: each draft's field as it reads now.
        let left: HashMap<String, String> = self.drafts.iter().map(|(n, f)| (n.clone(), f.read(cx).get_value().to_string())).collect();
        let mut answer = ItemAnswer { id: self.item.id.clone(), approved: Some(true), ..Default::default() };
        if !self.item.drafts.is_empty() {
            answer.drafts = Some(self.item.drafts.iter().map(|d| (d.name.clone(), left.get(&d.name).cloned().unwrap_or_else(|| d.text.clone()))).collect());
            let edited: Vec<String> = self.item.drafts.iter().filter(|d| left.get(&d.name) != Some(&d.text)).map(|d| d.name.clone()).collect();
            if !edited.is_empty() {
                answer.edited = Some(edited);
            }
        }
        self.hold(Done::Answer(answer), "Approved".into(), cx);
    }

    fn answer_text(&mut self, text: String, cx: &mut Context<Self>) {
        if !text.is_empty() {
            self.hold(Done::Answer(ItemAnswer { id: self.item.id.clone(), text: Some(text), ..Default::default() }), "Answered".into(), cx);
        }
    }

    /// Words on an item, to the work that raised it: a message in its space that names the item.
    fn send_reply(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        if text.is_empty() || self.reply_going.pending {
            return;
        }
        self.reply_going = Going { pending: true, error: None };
        self.reply_mode = Some(true);
        let (space, item) = (self.item.space.clone(), self.item.id.clone());
        let job = model(cx).update(cx, |m, cx| m.reply_on(&space, &text, &item, cx));
        let _ = window;
        cx.spawn(async move |this, cx| {
            let got = job.await;
            this.update(cx, |this, cx| {
                this.reply_going.pending = false;
                this.reply_mode = Some(false);
                match got {
                    Ok(_) => {
                        this.replying = false;
                        this.renew_reply = true;
                    }
                    Err(r) => {
                        this.reply_going.error = Some(safe(if r.is_empty() { "Didn't go through" } else { &r }));
                        this.reply_focus = true;
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// A sealed answer: sealed here, only the sealed bytes to the core; the field clears as it goes,
    /// and nothing of it is kept or tried again.
    fn send_sealed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let secret = self.sealed.read(cx).get_value().to_string();
        // Enter does nothing while one is going, as Send.
        if secret.is_empty() || self.sealed_going.pending {
            return;
        }
        self.sealed.update(cx, |t, cx| {
            t.clear(ChangeOptions::default(), window, cx);
        });
        let item = self.item.clone();
        let job = model(cx).update(cx, |m, cx| m.answer_sealed(&item, &secret, cx));
        drop(secret);
        self.sealed_going = Going { pending: true, error: None };
        cx.spawn(async move |this, cx| {
            let got = job.await;
            this.update(cx, |this, cx| {
                this.sealed_going.pending = false;
                this.sealed_going.error = got.err().map(|e| safe(&e));
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// The assist key: the app's tool, called from here (a connection's start through the OAuth
    /// relay); a view it returns opens in a window of its own, a key's sealed ask in its.
    fn assist(&mut self, cx: &mut Context<Self>) {
        let Some(a) = self.item.action.clone() else { return };
        if self.assist.pending {
            return;
        }
        self.assist = Going { pending: true, error: None };
        let task = crate::settings::connection_actions::run_action(&a.call.app, &a.call.tool, &a.call.args, cx);
        cx.spawn(async move |this, cx| {
            let got = task.await;
            this.update(cx, |this, cx| {
                this.assist.pending = false;
                this.assist.error = got.err().map(|e| safe(&e));
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    fn head(&self, l: &Look) -> AnyElement {
        let it = &self.item;
        div()
            .flex()
            .items_center()
            .h(u(20.))
            .gap(px(9.))
            .text_size(u(12.))
            .line_height(u(16.))
            .text_color(l.ink2)
            .child(if it.is_open() { marks::hand(px(14.), l).into_any_element() } else { marks::ending(ending_of(it), px(14.), l) })
            .child(div().font_weight(FontWeight::MEDIUM).child(it.kind.label()))
            .child(div().text_size(u(11.)).line_height(u(14.)).font_features(crate::chat_marks::tabular()).text_color(l.ink3).child(age_of(now_ms() - it.at)))
            .when_some(it.model.clone(), |d, m| d.child(div().text_size(u(11.)).line_height(u(14.)).text_color(l.ink3).child(m)))
            .into_any_element()
    }

    /// Its title and its words, selectable as one.
    fn body(&mut self, l: &Look, window: &mut Window, cx: &mut App) -> AnyElement {
        let it = self.item.clone();
        let doc = (!it.body.is_empty() && it.body != it.title).then(|| match &self.body {
            Some((text, doc)) if *text == it.body => doc.clone(),
            _ => {
                let doc = Rc::new(Doc::of(&it.body));
                self.body = Some((it.body.clone(), doc.clone()));
                doc
            }
        });
        let l = *l;
        let id = format!("ask-text-{}", it.id);
        crate::kit::selecting(id.clone(), window, cx, move |sel, window, cx| {
            let title = markdown::plain(&it.title, format!("{id}-title"), (0, 0), sel);
            div()
                .flex()
                .flex_col()
                .gap(u(4.))
                .cursor_text()
                .child(div().text_size(u(14.)).line_height(u(20.)).font_weight(FontWeight::MEDIUM).text_color(l.ink).child(title))
                .when_some(doc, |d, doc| {
                    let ctx = markdown::Ctx { id: id.clone(), order: 0, sel: sel.clone(), on_link: crate::chat::on_link(), on_picture: crate::chat::on_picture(), ink: Some(l.ink2), cell: false, pictures: Default::default(), formulas: Default::default() };
                    d.child(div().text_size(u(13.)).line_height(u(16.)).text_color(l.ink2).child(markdown::render(&doc, &ctx, &l, window, cx)))
                })
                .into_any_element()
        })
    }

    /// An approval's drafts to edit, each in its box with its label and "Edited" once changed.
    fn drafts(&self, l: &Look, window: &Window, cx: &App) -> Vec<AnyElement> {
        self.item
            .drafts
            .iter()
            .filter_map(|d| {
                let field = &self.field(&d.name)?;
                let edited = field.read(cx).get_value().as_ref() != d.text;
                let focus = field.read(cx).focus_handle(cx);
                let within = focus.contains_focused(window, cx);
                Some(
                    div()
                        .flex()
                        .flex_col()
                        .overflow_hidden()
                        .rounded(px(8.))
                        .border_1()
                        .border_color(if within { l.ink3 } else { l.line2 })
                        .bg(l.bg)
                        .child(
                            // Its label is the field's: a click on it puts the cursor in the field.
                            div()
                                .id(gpui::ElementId::Name(format!("draft-head-{}", d.name).into()))
                                .on_mouse_down(gpui::MouseButton::Left, move |_, window, cx| {
            // Its own: the window's root would take the keyboard back otherwise.
            window.focus(&focus, cx);
            window.prevent_default();
        })
                                .flex()
                                .items_center()
                                .gap(u(8.))
                                .h(u(32.))
                                .px(u(14.))
                                .text_size(u(12.))
                                .text_color(l.ink2)
                                .border_b(px(l.w2))
                                .border_color(l.line2)
                                .child(div().flex_1().min_w_0().truncate().child(d.label.clone()))
                                .when(edited, |h| h.child(div().flex_none().font_weight(FontWeight::MEDIUM).text_color(l.ink).child("Edited"))),
                        )
                        .child(Textarea::root(field, cx).text_color(l.ink).aria_label(d.label.clone()).w_full().min_h(u(56.)).max_h(px(296.)).px(u(14.)).py(u(8.)).text_size(u(14.)).line_height(u(20.)))
                        .into_any_element(),
                )
            })
            .collect()
    }

    fn keys(&mut self, l: &Look, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let it = self.item.clone();
        let can_answer = !it.owner_completes;
        let mut row = div().flex().flex_wrap().items_center().gap(u(8.));
        if let Some(a) = &it.action {
            row = row.child(key("assist", Btn::Key, !self.assist.pending, l, a.label.clone()).when(!self.assist.pending, |b| b.on_click(cx.listener(|this, _, _, cx| this.assist(cx)))));
        }
        if let Some(e) = &self.assist.error {
            row = row.child(action_error(e, l));
        }
        // A connection's: Cancel while it signs in, and Check sign-in.
        if let Some(a) = &it.action {
            row = row.children(crate::settings::connection_actions::connection_actions(&format!("ask-{}", it.id), &a.call.app, &a.call.args, self.assist.pending, window, cx));
        }
        for (i, link) in it.links.iter().enumerate() {
            let url = link.url.clone();
            row = row.child(key(gpui::ElementId::Name(format!("link-{i}").into()), Btn::Key, true, l, format!("{} ↗", link.label)).on_click(move |_, _, cx| cx.open_url(&url)));
        }
        if can_answer && it.kind == Kind::Approval {
            let word = if it.send.is_some() && !it.drafts.is_empty() { "Approve & send" } else { "Approve" };
            row = row
                .child(key("approve", Btn::Go, true, l, word).on_click(cx.listener(|this, _, _, cx| this.approve(cx))))
                .child(key("decline", Btn::Key, true, l, "Decline").on_click(cx.listener(|this, _, _, cx| {
                    let id = this.item.id.clone();
                    this.hold(Done::Answer(ItemAnswer { id, approved: Some(false), ..Default::default() }), "Declined".into(), cx);
                })));
        }
        if can_answer && it.kind == Kind::Question {
            for (i, o) in it.options.iter().enumerate() {
                let files: Vec<AnyElement> = it
                    .attachments
                    .iter()
                    .enumerate()
                    .filter(|(_, a)| a.option == Some(i as f64))
                    .map(|(n, a)| {
                        let key = format!("ask-{}-{i}-{n}", it.id);
                        let scroll = self.scroll(&key);
                        files::file(a, &key, &scroll, l, window, cx)
                    })
                    .collect();
                let choice = o.clone();
                row = row.child(
                    div().flex().items_center().gap(u(6.)).children(files).child(key(gpui::ElementId::Name(format!("option-{i}").into()), Btn::Key, true, l, o.clone()).on_click(cx.listener(
                        move |this, _, _, cx| {
                            let id = this.item.id.clone();
                            this.hold(Done::Answer(ItemAnswer { id, choice: Some(choice.clone()), ..Default::default() }), choice.clone(), cx);
                        },
                    ))),
                );
            }
        }
        if can_answer && it.kind == Kind::Task && it.action.as_ref().is_none_or(|a| a.call.app != "connections") {
            row = row.child(key("done", Btn::Go, true, l, "Done").on_click(cx.listener(|this, _, _, cx| {
                let id = this.item.id.clone();
                this.hold(Done::Close { id, status: CloseAs::Done }, "Done".into(), cx);
            })));
        }
        row.child(div().ml_auto().flex().items_center().gap(u(8.)).child(self.reply_key(l, cx)).child(key("dismiss", Btn::Flat, true, l, "Dismiss").on_click(cx.listener(|this, _, _, cx| {
            let id = this.item.id.clone();
            this.hold(Done::Close { id, status: CloseAs::Dismissed }, "Dismissed".into(), cx);
        }))))
        .into_any_element()
    }

    fn reply_key(&self, l: &Look, cx: &mut Context<Self>) -> AnyElement {
        key("reply", Btn::Flat, true, l, "Reply")
            .when(self.replying, |b| b.text_color(l.ink))
            .aria_toggled(if self.replying { gpui::Toggled::True } else { gpui::Toggled::False })
            .on_click(cx.listener(|this, _, window, cx| {
                if let Some(f) = this.on_reply.clone() {
                    let item = this.item.clone();
                    f(&item, window, cx);
                } else {
                    this.replying = !this.replying;
                    if this.replying {
                        // The field takes the keys once it's drawn (ask-reply.tsx's autoFocus), after
                        // the press that opened it settles.
                        this.reply_focus = true;
                    } else {
                        // Closed, the reply goes with what was typed in it, as its form unmounts: open
                        // again, it's a fresh one.
                        this.renew_reply = true;
                    }
                    cx.notify();
                }
            }))
            .into_any_element()
    }

    fn reply_row(&self, l: &Look, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let ready = !self.reply.read(cx).get_value().trim().is_empty() && !self.reply_going.pending;
        let focus = self.reply.read(cx).focus_handle(cx);
        div()
            .flex()
            .items_end()
            .gap(u(8.))
            .child(field_box("reply-box", focus, l, window, cx).flex_1().child(Textarea::root(&self.reply, cx).text_color(l.ink).aria_label("Reply").w_full().max_h(u(FIELD_MOST))))
            .when_some(self.reply_going.error.clone(), |d, e| d.child(action_error(&e, l)))
            .child(key("reply-send", Btn::Key, ready, l, "Send").when(ready, |b| {
                b.on_click(cx.listener(|this, _, window, cx| {
                    let text = this.reply.read(cx).get_value().trim().to_string();
                    this.send_reply(text, window, cx);
                }))
            }))
            .into_any_element()
    }

    fn sealed_row(&self, l: &Look, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let ready = !self.sealed.read(cx).get_value().is_empty() && !self.sealed_going.pending;
        let usage = use_of(&self.item);
        let focus = self.sealed.read(cx).focus_handle(cx);
        div()
            .flex()
            .flex_col()
            .when_some(self.sealed_going.error.clone(), |d, e| {
                d.child(div().flex().items_center().gap(u(8.)).h(u(24.)).text_size(u(12.)).text_color(l.ink).child(marks::stop(px(12.), l)).child(e))
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(u(8.))
                    .child(
                        field_box("sealed-box", focus, l, window, cx)
                            .flex_1()
                            .min_w_0()
                            .on_key_down(cx.listener(|this, e: &gpui::KeyDownEvent, window, cx| {
                                if e.keystroke.key == "enter" {
                                    this.send_sealed(window, cx);
                                }
                            }))
                            .child(Input::root(&self.sealed, cx).text_color(l.ink).aria_label(usage).w_full()),
                    )
                    .child(key("sealed-send", Btn::Go, ready, l, "Send").when(ready, |b| b.on_click(cx.listener(|this, _, window, cx| this.send_sealed(window, cx))))),
            )
            .into_any_element()
    }

    /// A closed ask's card, read-only: each draft as it went (his edit included), then the option
    /// picked or the words typed.
    fn decided(&self, l: &Look, window: &mut Window, cx: &mut App) -> AnyElement {
        let it = &self.item;
        let a = it.answer.clone().unwrap_or_default();
        let words = a.choice.clone().or(a.text.clone());
        let sent: BTreeMap<String, String> = a.drafts.clone().unwrap_or_default();
        div()
            .flex()
            .flex_col()
            .gap(u(12.))
            .children(it.drafts.iter().map(|d| {
                div()
                    .flex()
                    .flex_col()
                    .overflow_hidden()
                    .rounded(px(8.))
                    .border_1()
                    .border_color(l.line2)
                    .bg(l.bg)
                    .child(div().flex().items_center().h(u(32.)).px(u(14.)).text_size(u(12.)).text_color(l.ink2).border_b(px(l.w2)).border_color(l.line2).child(div().flex_1().min_w_0().truncate().child(d.label.clone())))
                    .child(div().px(u(14.)).py(u(8.)).text_size(u(14.)).line_height(u(20.)).text_color(l.ink).whitespace_normal().child(crate::kit::selectable(format!("ask-sent-{}-{}", it.id, d.name), sent.get(&d.name).cloned().unwrap_or_else(|| it.shown_text(d)), window, cx)))
            }))
            .when_some(words, |d, w| d.child(div().text_size(u(14.)).line_height(u(20.)).text_color(l.ink).whitespace_normal().child(crate::kit::selectable(format!("ask-answer-{}", it.id), w, window, cx))))
            .into_any_element()
    }

    /// What the user can do, or what they did, held with Undo.
    fn doing(&mut self, l: &Look, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if let Some(h) = self.held.clone() {
            return div()
                .flex()
                .items_center()
                .gap(u(8.))
                .h(u(24.))
                .text_size(u(13.))
                .text_color(l.ink)
                .child(div().flex_1().min_w_0().truncate().child(h.label))
                .when(!h.sent, |d| d.child(key("undo", Btn::Key, true, l, "Undo").on_click(cx.listener(|this, _, _, cx| this.undo(cx)))))
                .into_any_element();
        }
        let mut col = div().flex().flex_col().gap(u(12.));
        if self.item.kind == Kind::Sealed {
            col = col.child(self.sealed_row(l, window, cx)).child(div().flex().items_center().justify_end().child(self.reply_key(l, cx)));
        } else {
            col = col.children(self.drafts(l, window, cx)).child(self.keys(l, window, cx));
            if !self.item.owner_completes && self.item.kind == Kind::Question {
                let focus = self.answer.read(cx).focus_handle(cx);
                col = col.child(field_box("answer-box", focus, l, window, cx).child(Textarea::root(&self.answer, cx).text_color(l.ink).aria_label("Answer").w_full().max_h(u(FIELD_MOST))));
            }
        }
        if self.replying {
            col = col.child(self.reply_row(l, window, cx));
        }
        col.into_any_element()
    }
}

impl Render for AskCard {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if std::mem::take(&mut self.remount) {
            let opts = answer_options(cx.entity().downgrade());
            self.answer = cx.new(|cx| Textarea::new(opts, window, cx));
            let opening = model(cx).read(cx).kept_edit(&self.item.id);
            self.mine = opening.as_ref().map(|(_, ds)| ds.clone()).unwrap_or_default();
            self.pending_edit = if outbox::quiet() { opening.map(|(id, _)| id) } else { None };
            self.seen = self.item.drafts.iter().map(|d| (d.name.clone(), self.item.shown_text(d))).collect();
            self.drafts.clear();
            self.in_draft = false;
            self.renew_reply = true;
        }
        if std::mem::take(&mut self.renew_reply) {
            let opts = reply_options(cx.entity().downgrade(), false);
            self.reply = cx.new(|cx| Textarea::new(opts, window, cx));
            self.reply_going = Going::default();
            self.reply_mode = None;
        }
        if let Some(ro) = self.reply_mode.take() {
            let opts = reply_options(cx.entity().downgrade(), ro);
            self.reply.update(cx, |t, cx| t.set_options(opts, window, cx));
        }
        if std::mem::take(&mut self.reply_focus) {
            self.reply.update(cx, |t, cx| t.focus(window, cx));
        }
        for (field, value) in std::mem::take(&mut self.to_set) {
            field.update(cx, |t, cx| match value {
                Some(v) => {
                    t.set_value(v, ChangeOptions::default(), window, cx);
                }
                None => {
                    t.clear(ChangeOptions::default(), window, cx);
                }
            });
        }
        // A revision's new use for the sealed field is its label and placeholder.
        let usage = use_of(&self.item);
        if usage != self.sealed_use {
            let opts = sealed_options(cx.entity().downgrade(), &usage);
            self.sealed.update(cx, |t, cx| t.set_options(opts, window, cx));
            self.sealed_use = usage;
        }
        // An error that shows is read out, as an alert is.
        let errors: Vec<String> = [&self.assist.error, &self.reply_going.error].into_iter().flatten().cloned().collect();
        for e in &errors {
            if !self.announced.contains(e) {
                ui_sdk::foundation::platform::announce_with(e, ui_sdk::foundation::platform::AnnouncePriority::Assertive, window, cx);
            }
        }
        self.announced = errors;
        self.sync_drafts(window, cx);
        let in_draft = self.drafts.iter().any(|(_, f)| f.read(cx).focus_handle(cx).contains_focused(window, cx));
        if self.in_draft && !in_draft {
            self.send_edit(cx);
        }
        self.in_draft = in_draft;
        let l = Look::get(cx);
        let open = self.item.is_open();
        let head = self.head(&l);
        let body = self.body(&l, window, cx);
        let portal = if self.item.portal.is_some() && open {
            if self.portal_tick.is_none() {
                self.portal_tick = Some(cx.spawn(async move |this, cx| {
                    loop {
                        cx.background_executor().timer(Duration::from_millis(500)).await;
                        if this.update(cx, |this, cx| if this.portal.tick() { cx.notify() }).is_err() {
                            break;
                        }
                    }
                }));
            }
            Some(self.portal.picture(window, cx, move |this: &mut AskCard, window, cx| {
                this.portal.open(window, cx, |this: &mut AskCard, window, cx| {
                    this.portal.close_here(window, cx);
                    cx.notify();
                });
                cx.notify();
            }))
        } else {
            None
        };
        let controller = self.portal.controller(&self.item.title, window, cx, |this: &mut AskCard, window, cx| {
            this.portal.close_here(window, cx);
            cx.notify();
        });
        let key = format!("ask-{}", self.item.id);
        let scroll = self.scroll(&key);
        let files = files::files(&self.item.attachments, self.own, &key, &scroll, &l, window, cx);
        let error = self.error.clone();
        let lower = if open { self.doing(&l, window, cx) } else { self.decided(&l, window, cx) };
        div()
            .flex()
            .flex_col()
            .gap(u(12.))
            .pt(u(12.))
            .pb(u(14.))
            .child(head)
            .child(body)
            .children(portal)
            .children(files)
            .when_some(error, |d, e| d.child(div().flex().items_center().gap(u(8.)).h(u(24.)).text_size(u(12.)).text_color(l.ink).child(marks::stop(px(12.), &l)).child(SharedString::from(e))))
            .child(lower)
            .children(controller)
    }
}

/// A card for an item.
pub fn make(item: ActionItem, window: &mut Window, cx: &mut App) -> Entity<AskCard> {
    cx.new(|cx| AskCard::new(item, window, cx))
}
