//! The composer: the message box (chatbox.rs, all of it) in a small floating window over whatever
//! app is in front, a third of the way down the display the pointer is on. ⌘/ opens it from any app
//! and in this one (`platform/hotkey.rs`), and Tab on a space in ⌘K opens it aimed there. It never
//! takes the front, so Esc, ⌘W or a click away hands the keyboard straight back. Over the box is
//! where what's in it goes: the space it's aimed at, or with none the core's pick for the words a
//! moment after the last key (`/route`: the space they're plainly for, else Home). `#` at the start
//! lists the spaces to aim it at, and a new space by the name typed, made only once it's chosen;
//! `#name` sent as it is goes to the space by that name. Enter sends and closes it, and the user
//! stays where they are; ⌘Enter sends and opens the main window on that space, at the message.
//! Opened again within a couple of minutes it still has what was left in it, and its aim.

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, AnyWindowHandle, App, AppContext, Bounds, Context, ElementId, Entity, FocusHandle, Global, InteractiveElement, IntoElement, KeyDownEvent,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Task, WeakEntity, Window, WindowBounds, WindowKind, WindowOptions, div, point, prelude::*, px, size,
};
use serde_json::{Value, json};

use crate::brain::HOME;
use crate::chatbox::{BoxEvent, BoxOptions, ChatBox, Sent};
use crate::kit::{self, Btn};
use crate::look::{Look, SANS, u};
use crate::marks;
use crate::model::{Post, model};
use crate::nav::{Beat, Nav, Page};
use crate::net::Net;
use crate::palette::fold;
use crate::platform::appkit::{self, Front};
use crate::spaces::{new_space_id, warmest};

/// Where its draft is kept.
const PLACE: &str = "composer";
const WIDTH: f32 = 640.;
/// How long what's left in a closed one waits for the next.
const KEEP: Duration = Duration::from_secs(120);
/// How long after the last key the core is asked where the words go.
const SETTLE: Duration = Duration::from_millis(400);
/// How long a send waits for the core's pick before it goes to Home.
const ROUTING: Duration = Duration::from_secs(10);
/// The `#` list's rows, at most.
const ROWS: usize = 8;

#[derive(Default)]
struct Composer {
    open: Option<(AnyWindowHandle, WeakEntity<ComposerView>)>,
    /// What a closed one leaves: its aim, and when it closed.
    aim: Option<String>,
    closed: Option<Instant>,
}
impl Global for Composer {}

/// Its window, while it's up.
pub fn window(cx: &App) -> Option<AnyWindowHandle> {
    cx.try_global::<Composer>().and_then(|c| c.open.as_ref().map(|(w, _)| *w))
}

/// Opens it (aimed at `aim`, a space), or closes it if it's up; aimed while it's up, it takes the aim.
pub fn toggle(aim: Option<String>, cx: &mut App) {
    if let Some((w, v)) = cx.try_global::<Composer>().and_then(|c| c.open.clone()) {
        let done = w.update(cx, |_, window, cx| {
            v.update(cx, |v, cx| match aim.clone() {
                Some(a) => v.aim_at(a, window, cx),
                None => v.close(window, cx),
            })
        });
        if matches!(done, Ok(Ok(()))) {
            return;
        }
    }
    open(aim, cx);
}

fn open(aim: Option<String>, cx: &mut App) {
    // Before it's up, though it never takes the front anyway.
    let front = Front::now();
    let c = cx.default_global::<Composer>();
    let kept = c.closed.is_some_and(|t| t.elapsed() < KEEP);
    let aim = aim.or_else(|| c.aim.take().filter(|_| kept));
    if !kept && let Some(d) = crate::outbox::draft(PLACE) {
        for f in d.files.unwrap_or_default() {
            crate::outbox::drop_file(&f.id);
        }
        crate::outbox::set_draft(PLACE, crate::outbox::Draft::default());
    }
    let display = appkit::pointer_display().and_then(|id| cx.find_display(gpui::DisplayId::new(id.into()))).or_else(|| cx.primary_display());
    let Some(display) = display else { return };
    let area = display.visible_bounds();
    let width = px(WIDTH).min(area.size.width - px(32.));
    // A third of the way down, as it grows down.
    let at = point(area.origin.x + (area.size.width - width) / 2., area.origin.y + area.size.height * 0.26);
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(at, size(width, px(96.))))),
        titlebar: None,
        kind: WindowKind::PopUp,
        is_movable: false,
        is_resizable: false,
        is_minimizable: false,
        display_id: Some(display.id()),
        show: false,
        focus: false,
        ..Default::default()
    };
    let opened = cx.open_window(options, |window, cx| {
        appkit::still(window);
        appkit::hide_buttons(window);
        cx.new(|cx| ComposerView::new(aim, front, window, cx))
    });
    let Ok(handle) = opened else { return };
    let view = handle.update(cx, |_, window, _| {
        // Shown once it's drawn, with no animation: key, without the app taking the front.
        appkit::show(window);
    });
    if view.is_ok()
        && let Ok(v) = handle.entity(cx)
    {
        cx.global_mut::<Composer>().open = Some((handle.into(), v.downgrade()));
    }
}

/// A row of the `#` list.
#[derive(Clone)]
enum Row {
    Space(String, String),
    /// A new space by the name typed.
    New(String),
}

/// A name as a `#` compares it: case, accents and everything but letters and digits set aside.
fn squash(s: &str) -> String {
    fold(s).chars().filter(|c| c.is_alphanumeric()).collect()
}

/// The `#name` being typed at the start: the words after `#`, until a space.
fn typing_tag(text: &str) -> Option<&str> {
    text.strip_prefix('#').filter(|t| !t.chars().any(char::is_whitespace))
}

/// A `#name` at the start that names a space: the space, and where the words after it start.
fn named(text: &str, cx: &App) -> Option<(String, usize)> {
    let rest = text.strip_prefix('#')?;
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let tag = squash(&rest[..end]);
    if tag.is_empty() {
        return None;
    }
    let b = &model(cx).read(cx).brain;
    let id = b.spaces.values().find(|s| !s.archived && (squash(&s.name) == tag || s.id == rest[..end]))?.id.clone();
    let after = rest[end..].len() - rest[end..].trim_start().len();
    Some((id, 1 + end + after))
}

pub struct ComposerView {
    chatbox: Entity<ChatBox>,
    aim: Option<String>,
    /// The core's pick for the words, once it's answered: the words, and the space.
    guess: Option<(String, String)>,
    /// The words the core was last asked about, and the asking.
    asked: String,
    asking: Task<()>,
    /// The `#` list's highlight, and whether Esc put the list away (until the words change).
    lit: usize,
    dismissed: bool,
    last: String,
    /// ⌘Enter: the next send follows to its space.
    follow: bool,
    front: Option<Front>,
    /// Whether it has had the keyboard yet: a click away closes it only after.
    was_active: bool,
    focus: FocusHandle,
    /// Its height as last asked of the window.
    height: Rc<Cell<f32>>,
}

impl ComposerView {
    fn new(aim: Option<String>, front: Option<Front>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let chatbox = cx.new(|cx| ChatBox::new(BoxOptions { placeholder: "Talk to Switch…".into(), place: PLACE.into(), attach: true, words_only: false }, window, cx));
        cx.subscribe_in(&chatbox, window, |this: &mut Self, _, e: &BoxEvent, window, cx| {
            if let BoxEvent::Send(sent) = e {
                this.send(sent, window, cx);
            }
        })
        .detach();
        cx.observe(&chatbox, |this: &mut Self, _, cx| this.typed(cx)).detach();
        cx.observe(&model(cx), |_, _, cx| cx.notify()).detach();
        cx.observe_window_activation(window, |this: &mut Self, window, cx| {
            if window.is_window_active() {
                this.was_active = true;
            } else if this.was_active {
                this.close(window, cx);
            }
        })
        .detach();
        let b = chatbox.clone();
        window.defer(cx, move |window, cx| b.update(cx, |b, cx| b.focus(window, cx)));
        ComposerView { chatbox, aim, guess: None, asked: String::new(), asking: Task::ready(()), lit: 0, dismissed: false, last: String::new(), follow: false, front, was_active: false, focus: cx.focus_handle(), height: Rc::new(Cell::new(0.)) }
    }

    fn text(&self, cx: &App) -> String {
        self.chatbox.read(cx).text(cx)
    }

    fn aim_at(&mut self, space: String, window: &mut Window, cx: &mut Context<Self>) {
        self.aim = Some(space);
        self.chatbox.update(cx, |b, cx| b.focus(window, cx));
        cx.notify();
    }

    /// The words changed: the list starts over, and the core is asked where they go a moment after
    /// the last key, unless they're aimed.
    fn typed(&mut self, cx: &mut Context<Self>) {
        let text = self.text(cx);
        if text == self.last {
            return;
        }
        self.last = text.clone();
        self.lit = 0;
        self.dismissed = false;
        let q = text.trim().to_string();
        let aimed = self.aim.is_some() || typing_tag(&text).is_some() || named(&text, cx).is_some();
        if aimed || q.is_empty() || q == self.asked {
            if q.is_empty() {
                self.asked.clear();
                self.asking = Task::ready(());
            }
            cx.notify();
            return;
        }
        self.asked = q.clone();
        self.asking = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SETTLE).await;
            let Ok(job) = this.update(cx, |_, cx| ask_route(&q, cx)) else { return };
            let got = job.await;
            this.update(cx, |this, cx| {
                // One the core can't place goes to Home.
                this.guess = Some((q, got.unwrap_or_else(|| HOME.into())));
                cx.notify();
            })
            .ok();
        });
        cx.notify();
    }

    /// Where what's in it goes, and whether that's still being worked out: its aim, a space named
    /// with `#`, the `#` list's highlighted row (what Enter picks), else the core's pick for the words.
    fn to(&self, cx: &App) -> (Option<Row>, bool) {
        if let Some(a) = &self.aim {
            return (Some(Row::Space(a.clone(), String::new())), false);
        }
        let text = self.text(cx);
        if let Some((id, _)) = named(&text, cx) {
            return (Some(Row::Space(id, String::new())), false);
        }
        let rows = self.rows(cx);
        if !rows.is_empty() {
            return (rows.get(self.lit.min(rows.len() - 1)).cloned(), false);
        }
        let q = text.trim();
        if q.is_empty() {
            return (Some(Row::Space(HOME.into(), String::new())), false);
        }
        match &self.guess {
            Some((t, s)) => (Some(Row::Space(s.clone(), String::new())), t != q),
            None => (None, true),
        }
    }

    /// The `#` list for the name being typed: spaces whose names hold it, warmest first, and a new
    /// space by it when none is called that.
    fn rows(&self, cx: &App) -> Vec<Row> {
        if self.dismissed || self.aim.is_some() {
            return vec![];
        }
        let text = self.text(cx);
        let Some(tag) = typing_tag(&text) else { return vec![] };
        let want = squash(tag);
        let b = &model(cx).read(cx).brain;
        let mut rows: Vec<Row> = warmest(b).into_iter().filter(|s| squash(&s.name).contains(&want)).take(ROWS).map(|s| Row::Space(s.id.clone(), if s.id == HOME { "Home".into() } else { s.name.clone() })).collect();
        if !want.is_empty() && !b.spaces.values().any(|s| !s.archived && squash(&s.name) == want) {
            rows.push(Row::New(tag.to_string()));
        }
        rows
    }

    /// A row chosen: aimed there, the `#name` out of the box. A new space is made now, shown at once.
    fn pick(&mut self, row: Row, window: &mut Window, cx: &mut Context<Self>) {
        let id = match row {
            Row::Space(id, _) => id,
            Row::New(name) => {
                let id = new_space_id(&name);
                let b = self.chatbox.downgrade();
                let this = cx.entity().downgrade();
                crate::spaces::create(
                    &id,
                    &name,
                    None,
                    Box::new(|_| {}),
                    Box::new(move |reason, cx| {
                        b.update(cx, |b, cx| {
                            b.error = Some(if reason.is_empty() { "Didn't go through".into() } else { reason });
                            cx.notify();
                        })
                        .ok();
                        this.update(cx, |this, cx| {
                            this.aim = None;
                            cx.notify();
                        })
                        .ok();
                    }),
                    cx,
                );
                id
            }
        };
        self.aim = Some(id);
        self.chatbox.update(cx, |b, cx| b.put_text(String::new(), window, cx));
        cx.notify();
    }

    fn on_key(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let k = &e.keystroke;
        let m = &k.modifiers;
        if k.key == "enter" && m.platform && !m.shift && !m.control && !m.alt {
            cx.stop_propagation();
            window.prevent_default();
            // The send comes as the box's event, after this key; the flag goes once it has.
            self.follow = true;
            self.chatbox.update(cx, |b, cx| b.submit(window, cx));
            cx.defer_in(window, |this, _, _| this.follow = false);
            return;
        }
        let rows = self.rows(cx);
        if rows.is_empty() || m.platform || m.control || m.alt {
            return;
        }
        match k.key.as_str() {
            "down" => self.lit = (self.lit + 1) % rows.len(),
            "up" => self.lit = (self.lit + rows.len() - 1) % rows.len(),
            "tab" | "enter" => {
                let row = rows[self.lit.min(rows.len() - 1)].clone();
                cx.stop_propagation();
                window.prevent_default();
                self.pick(row, window, cx);
                return;
            }
            "escape" => self.dismissed = true,
            _ => return,
        }
        cx.stop_propagation();
        window.prevent_default();
        cx.notify();
    }

    /// Sent: it closes, and the message goes where it was shown going; one sent before the core
    /// answered goes where the core says, or Home if it can't say.
    fn send(&mut self, sent: &Sent, window: &mut Window, cx: &mut Context<Self>) {
        let follow = self.follow;
        let mut text = sent.text.clone();
        let mut dictated = sent.dictated.clone();
        let space = match self.aim.take() {
            Some(a) => Some(a),
            None => match named(&text, cx) {
                // `#name` sent as it is: to that space, without the `#name`.
                Some((id, from)) => {
                    let cut = text[..from].chars().count() as u64;
                    text = text[from..].to_string();
                    dictated = dictated
                        .into_iter()
                        .filter_map(|mut d| {
                            let start = d.get("start")?.as_u64()?.checked_sub(cut)?;
                            d["start"] = json!(start);
                            Some(d)
                        })
                        .collect();
                    Some(id)
                }
                None => self.guess.as_ref().filter(|(t, _)| *t == text.trim()).map(|(_, s)| s.clone()),
            },
        };
        let post = Post { id: None, space: String::new(), text, dictated, files: sent.files.clone(), attachments: vec![], reply_to: vec![] };
        self.guess = None;
        // Following, the main window takes the front: the app that had it doesn't get it back.
        if follow {
            self.front = None;
        }
        cx.defer_in(window, |this, window, cx| this.close(window, cx));
        match space {
            Some(space) => deliver(space, post, follow, cx),
            None => {
                let q = post.text.trim().to_string();
                let job = ask_route(&q, cx);
                cx.spawn(async move |_, cx| {
                    let space = futures::FutureExt::fuse(job);
                    let timer = futures::FutureExt::fuse(cx.background_executor().timer(ROUTING));
                    futures::pin_mut!(space, timer);
                    let space = futures::select! {
                        s = space => s.unwrap_or_else(|| HOME.into()),
                        _ = timer => HOME.into(),
                    };
                    cx.update(|cx| deliver(space, post, follow, cx));
                })
                .detach();
            }
        }
    }

    /// Closes it, leaving its words and aim for the next one, and hands the keyboard back.
    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let d = crate::platform::dictation::entity(cx).read(cx).listening.clone();
        if d.status != crate::platform::dictation::Status::Idle && d.field.as_deref() == Some(PLACE) {
            crate::platform::dictation::cancel(cx);
        }
        let c = cx.default_global::<Composer>();
        c.open = None;
        c.aim = self.aim.clone();
        c.closed = Some(Instant::now());
        if let Some(f) = &self.front {
            f.restore();
        }
        window.remove_window();
    }

    /// Esc: the `#` list goes, else it closes (a dictation under way is the box's Esc).
    fn escape(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.rows(cx).is_empty() {
            self.dismissed = true;
            cx.notify();
            return;
        }
        self.close(window, cx);
    }
}

/// The core's pick for the words: the space they're plainly for, else Home; none if it can't say.
fn ask_route(text: &str, cx: &App) -> impl std::future::Future<Output = Option<String>> + use<> {
    let clipped: String = text.chars().take(2000).collect();
    let q = percent_encoding::utf8_percent_encode(&clipped, percent_encoding::NON_ALPHANUMERIC).to_string();
    let job = cx.global::<Net>().get(format!("/route?text={q}"));
    async move {
        let a = job.await.ok()?.ok()?;
        a.ok().then(|| a.json()).and_then(|v| v.get("space").and_then(Value::as_str).map(str::to_string))
    }
}

/// Posts it to `space`; following, the main window comes forward on that space, at the message.
fn deliver(space: String, mut post: Post, follow: bool, cx: &mut App) {
    post.space = space.clone();
    model(cx).update(cx, |m, cx| m.post_message(post, cx));
    if follow {
        crate::platform::lifecycle::show_main(cx);
        Nav::open(Page::Space(space), cx);
    }
}

/// A space's ring.
fn ring(id: &str, cx: &App, l: &Look) -> AnyElement {
    let st = model(cx).read(cx).derived.station(id);
    marks::ring(&st.code, l.ink_of(&st), l.z(18.), l.bg, l.ink, id == HOME).into_any_element()
}

/// A space not made yet, as ⌘K draws one.
fn new_ring(l: &Look) -> AnyElement {
    div().size(l.z(18.)).rounded_full().border(l.z(2.3)).border_dashed().border_color(l.ink3).into_any_element()
}

fn name_of(id: &str, cx: &App) -> String {
    if id == HOME {
        return "Home".into();
    }
    model(cx).read(cx).brain.spaces.get(id).map(|s| s.name.clone()).unwrap_or_default()
}

impl ComposerView {
    fn body(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let l = Look::get(cx);
        let (to, working) = self.to(cx);
        let aimed = self.aim.is_some();
        let beat = Beat::step(cx);
        let dest = div()
            .id("composer-to")
            .flex()
            .h(u(32.))
            .items_center()
            .gap(u(8.))
            .px(u(12.))
            .text_size(u(13.))
            .line_height(u(16.))
            .when_some(to, |d, row| {
                let (icon, name) = match row {
                    Row::Space(id, _) => (ring(&id, cx, &l), name_of(&id, cx)),
                    Row::New(name) => (new_ring(&l), name),
                };
                d.child(div().flex().w(u(18.)).flex_none().justify_center().child(icon)).child(div().min_w_0().truncate().child(SharedString::from(name)))
            })
            .when(working, |d| d.child(crate::chat_marks::spin12(&l, beat)))
            .when(aimed, |d| {
                d.child(div().flex_1()).child(
                    kit::button("composer-unaim", Btn::Flat, true, &l)
                        .aria_label("Clear")
                        .w(u(22.))
                        .px_0()
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.aim = None;
                            this.last.clear();
                            this.typed(cx);
                        }))
                        .child("×"),
                )
            });
        let rows = self.rows(cx);
        let lit = self.lit.min(rows.len().saturating_sub(1));
        let list: Vec<AnyElement> = rows
            .iter()
            .enumerate()
            .map(|(n, row)| {
                let (key, icon, label) = match row {
                    Row::Space(id, name) => (format!("s:{id}"), ring(id, cx, &l), name.clone()),
                    Row::New(name) => ("new".to_string(), new_ring(&l), format!("New space “{name}”")),
                };
                let chosen = row.clone();
                div()
                    .id(ElementId::Name(key.into()))
                    .flex()
                    .h(u(24.))
                    .items_center()
                    .gap(u(8.))
                    .px(u(12.))
                    .text_size(u(13.))
                    .line_height(u(16.))
                    .when(n == lit, |d| d.bg(l.hover))
                    .on_mouse_move(cx.listener(move |this, _, _, cx| {
                        if this.lit != n {
                            this.lit = n;
                            cx.notify();
                        }
                    }))
                    .on_click(cx.listener(move |this, _, window, cx| this.pick(chosen.clone(), window, cx)))
                    .child(div().flex().w(u(18.)).flex_none().justify_center().child(icon))
                    .child(div().min_w_0().truncate().child(SharedString::from(label)))
                    .into_any_element()
            })
            .collect();
        let height = self.height.clone();
        let content = div()
            .relative()
            .flex()
            .flex_none()
            .flex_col()
            .w_full()
            .child(dest)
            .child(self.chatbox.clone())
            .when(!list.is_empty(), |d| d.child(div().flex().flex_col().py(u(4.)).border_t(px(l.w2)).border_color(l.line2).children(list)))
            // The window fits what it shows, its top edge where it is.
            .child(
                gpui::canvas(
                    move |b, window, _| {
                        let h = b.size.height.as_f32().ceil();
                        if h > 0. && h != height.get() {
                            height.set(h);
                            window.on_next_frame(move |window, _| {
                                let w = window.bounds().size.width;
                                window.resize(size(w, px(h)));
                            });
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            );
        div()
            .id("composer")
            .key_context("Composer")
            .track_focus(&self.focus)
            .capture_key_down(cx.listener(|this, e: &KeyDownEvent, window, cx| this.on_key(e, window, cx)))
            .on_action(cx.listener(|this, _: &crate::commands::Escape, window, cx| this.escape(window, cx)))
            .on_action(cx.listener(|this, _: &crate::menu::CloseWindow, window, cx| this.close(window, cx)))
            // The menu bar over it is another app's, so ⌘Q here closes it.
            .on_action(cx.listener(|this, _: &crate::Quit, window, cx| this.close(window, cx)))
            .on_drop(cx.listener(|this, paths: &gpui::ExternalPaths, window, cx| {
                let chosen = crate::files::choose_paths(paths.paths());
                this.chatbox.update(cx, |b, cx| b.attach(chosen, window, cx));
            }))
            .size_full()
            .bg(l.bg)
            .text_color(l.ink)
            .font_family(SANS)
            .font_features(crate::look::tabular())
            .child(content)
            .child(ui_sdk::foundation::platform::live_regions(window))
            .into_any_element()
    }
}

impl Render for ComposerView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        crate::boundary::guard("composer", window, cx, |window, cx| self.body(window, cx))
    }
}

pub fn bindings() -> Vec<gpui::KeyBinding> {
    vec![gpui::KeyBinding::new("escape", crate::commands::Escape, Some("Composer"))]
}
