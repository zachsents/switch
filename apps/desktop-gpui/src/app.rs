//! The window: the band across the top (it's the titlebar, the window's buttons centred on it),
//! then a space's page, one layout on every space (the desktop's `ui/space-page.tsx`): its rail
//! and its chat, or a piece of work opened. Each space's chat is made once and kept, so switching
//! back to one is instant and keeps its place. A narrower window (under 1000 px) folds the widgets
//! away; a narrow one (under 720 px) is one column, the rail over the chat, scrolling as one. Over
//! the pages: ⌘K's palette, the ⌘/ sheet; ⌘F's bar is the chat's top cell.

use std::collections::HashMap;

use gpui::{
    AnyElement, Context, Entity, FontWeight, InteractiveElement, IntoElement, ParentElement, Render, Styled, Window,
    WindowAppearance, actions, div, prelude::*, px,
};

use crate::band::{RenameField, band};
use crate::chat::ChatView;
use crate::commands::{Do, Escape};
use crate::find::FindBar;
use crate::look::{Look, SANS, u};
use crate::menu::MenuModel;
use crate::model::model;
use crate::nav::{Nav, Page};
use crate::palette::Palette;
use crate::rail::Rail;
use crate::shell::Shell;
use crate::theme::Held;
use crate::thread::ThreadView;

actions!(switch, [ToBox]);

/// Under this window width, px, the widgets fold away.
pub const WIDE: f32 = 1000.;
/// Under this window width, px, the page is one column.
pub const NARROW: f32 = 720.;

pub struct Root {
    rail: Entity<Rail>,
    chats: HashMap<String, Entity<ChatView>>,
    threads: HashMap<String, Entity<ThreadView>>,
    /// Each space's widgets, right of its chat (widgets/column.rs).
    columns: HashMap<String, Entity<crate::widgets::column::WidgetColumn>>,
    drew_ready: bool,
    palette: Entity<Palette>,
    finds: HashMap<String, Entity<FindBar>>,
    rename: Option<(String, Entity<RenameField>)>,
    menus: Option<MenuModel>,
    /// The page whose box last took the cursor: only another page opened takes it again.
    boxed: Option<Page>,
    /// gpui's focus as last drawn, to see it move.
    focused_last: Option<gpui::FocusHandle>,
    /// A two-finger swipe across the trackpad under way: how far it's gone, when it last moved, and
    /// whether it has gone back or forward already.
    swipe: (f32, std::time::Instant, bool),
    /// The ⌘/ sheet's focus while it's open, and what had it before, which gets it back.
    sheet_focus: gpui::FocusHandle,
    sheet_restore: Option<Option<gpui::FocusHandle>>,
}

thread_local! {
    /// A scroll event passed over something that scrolls sideways: set as it bubbles past it.
    static SIDEWAYS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// For what scrolls sideways (a picture row, a wide table, code): a scroll over it, while it has
/// more than it shows across (`handle`; none: always), is its own, not a swipe Back or Forward.
pub fn sideways(handle: Option<gpui::ScrollHandle>) -> impl Fn(&gpui::ScrollEvent, &mut Window, &mut gpui::App) + 'static {
    move |_, _, _| {
        if handle.as_ref().is_none_or(|h| h.max_offset().x > px(1.)) {
            SIDEWAYS.with(|s| s.set(true));
        }
    }
}

/// How far a swipe goes before it counts, px, and how long a pause ends one.
const SWIPE_PX: f32 = 140.;
const PAUSE: std::time::Duration = std::time::Duration::from_millis(250);

fn dark(a: WindowAppearance) -> bool {
    matches!(a, WindowAppearance::Dark | WindowAppearance::VibrantDark)
}

impl Root {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let m = model(cx);
        cx.observe_in(&m, window, |this, _, window, cx| {
            this.restyle(window, cx);
            this.prefetch(cx);
            crate::menu::refresh(&mut this.menus, cx);
            cx.notify();
        })
        .detach();
        cx.observe_window_appearance(window, |this, window, cx| this.restyle(window, cx)).detach();
        cx.observe_in(&Nav::entity(cx), window, |this, _, _, cx| {
            this.prefetch(cx);
            crate::menu::refresh(&mut this.menus, cx);
            cx.notify();
        })
        .detach();
        cx.observe_in(&Shell::entity(cx), window, |_, _, _, cx| cx.notify()).detach();
        cx.observe_global_in::<Held>(window, |this, window, cx| this.restyle(window, cx)).detach();
        let rail = cx.new(|cx| Rail::new(window, cx));
        let palette = cx.new(|cx| Palette::new(window, cx));
        let mut root = Root { rail, chats: HashMap::new(), threads: HashMap::new(), columns: HashMap::new(), drew_ready: false, palette, finds: HashMap::new(), rename: None, menus: None, boxed: None, focused_last: None, swipe: (0., std::time::Instant::now(), false), sheet_focus: cx.focus_handle(), sheet_restore: None };
        root.restyle(window, cx);
        root
    }

    /// The theme (the brain's, else this Mac's copy), in the window's appearance.
    fn restyle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let pref = model(cx).read(cx).brain.prefs.get("theme").cloned();
        Held::from_brain(pref.as_ref(), cx);
        let look = Look::of(&Held::theme(cx), dark(window.appearance()));
        let was = Look::get(cx);
        let same = was.bg == look.bg && was.zoom == look.zoom && was.dark == look.dark && was.line1 == look.line1 && was.line2 == look.line2 && was.line_section == look.line_section && was.w1 == look.w1 && was.w2 == look.w2 && was.w_section == look.w_section && was.go == look.go && was.yellow == look.yellow && was.orange == look.orange && was.red == look.red;
        if !same {
            cx.set_global(look);
            window.set_rem_size(px(16. * look.zoom));
            cx.refresh_windows();
        }
    }

    /// The chats of the spaces in the rail come in ahead of a click.
    fn prefetch(&mut self, cx: &mut Context<Self>) {
        let here = Nav::entity(cx).read(cx).page.space().to_string();
        let m = model(cx);
        if !m.read(cx).brain.ready {
            return;
        }
        let kids: Vec<String> = m.read(cx).derived.children.get(&here).cloned().unwrap_or_default();
        m.update(cx, |m, cx| {
            for k in kids.iter().take(12) {
                m.want_chat(k, cx);
            }
        });
    }

    fn chat(&mut self, space: &str, window: &mut Window, cx: &mut Context<Self>) -> Entity<ChatView> {
        if let Some(c) = self.chats.get(space) {
            return c.clone();
        }
        let c = cx.new(|cx| ChatView::new(space.to_string(), window, cx));
        self.chats.insert(space.to_string(), c.clone());
        c
    }

    /// The cursor in the page's box: a space's, or a running task's steer box.
    fn focus_page_box(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // The page shown, which may be Home for a space not yet known.
        let Some(page) = self.boxed.clone() else { return };
        match &page {
            Page::Space(space) => {
                if let Some(c) = self.chats.get(space).cloned() {
                    c.update(cx, |c, cx| c.focus_box(window, cx));
                }
            }
            Page::Thread(t, _) => {
                if let Some(v) = self.threads.get(t).cloned() {
                    v.update(cx, |v, cx| v.focus_box(window, cx));
                }
            }
        }
    }

    fn thread(&mut self, thread: &str, window: &mut Window, cx: &mut Context<Self>) -> Entity<ThreadView> {
        if let Some(t) = self.threads.get(thread) {
            return t.clone();
        }
        let t = cx.new(|cx| ThreadView::new(thread.to_string(), window, cx));
        self.threads.insert(thread.to_string(), t.clone());
        t
    }

    fn find(&mut self, space: &str, window: &mut Window, cx: &mut Context<Self>) -> Entity<FindBar> {
        if let Some(f) = self.finds.get(space) {
            return f.clone();
        }
        let f = cx.new(|cx| FindBar::new(space.to_string(), window, cx));
        self.finds.insert(space.to_string(), f.clone());
        f
    }

    /// The band's name field, while a space's name is in edit.
    fn rename_field(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<Entity<RenameField>> {
        let renaming = Shell::entity(cx).read(cx).renaming.clone();
        match renaming {
            None => {
                self.rename = None;
                None
            }
            Some(id) => {
                if self.rename.as_ref().is_none_or(|(r, _)| *r != id) {
                    let name = model(cx).read(cx).brain.spaces.get(&id).map(|s| s.name.clone()).unwrap_or_default();
                    let field = cx.new(|cx| RenameField::new(id.clone(), name, window, cx));
                    self.rename = Some((id, field));
                }
                self.rename.as_ref().map(|(_, f)| f.clone())
            }
        }
    }
}

impl Render for Root {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        crate::webview::start_frame(window, cx);
        // gpui's focus moved (a field clicked, the box focused): AppKit's keys come with it, from a
        // page that had them or from nothing.
        let focused = window.focused(cx);
        if focused != self.focused_last {
            self.focused_last = focused.clone();
            if focused.is_some() {
                crate::webview::keys_to_app(window);
            }
        }
        let l = Look::get(cx);
        let page = Nav::entity(cx).read(cx).page.clone();
        let m = model(cx).read(cx);
        let pairing = m.pairing.clone();
        let ready = m.brain.ready;
        if ready && !self.drew_ready {
            self.drew_ready = true;
            if std::env::var("SWITCH_GPUI_TIMING").is_ok() {
                eprintln!("timing: first full frame at {} ms", m.started.elapsed().as_millis());
            }
        }
        let width = window.viewport_size().width;
        // The breakpoints and the rail's least width are in the page's own points, which the text
        // size scales (the desktop's zoom).
        let rail_w = (width * 0.25).max(l.z(240.));
        let here = crate::commands::here(cx);
        // A space archived or not yet known shows Home, once the log has said so.
        let shown = match &page {
            Page::Space(_) => Page::Space(here.clone()),
            p => p.clone(),
        };
        let main: AnyElement = match &shown {
            Page::Space(space) => self.chat(space, window, cx).into_any_element(),
            Page::Thread(t, _) => self.thread(t, window, cx).into_any_element(),
        };
        // A page shown anew puts the cursor in its box, as the desktop's box takes the focus as it
        // mounts (at launch too, once the page it shows is made); the same page told again (a line
        // brought into view) leaves it where it is.
        if self.boxed.as_ref() != Some(&shown) {
            // A task's page drawn anew, as the desktop mounts it: no fold or step kept.
            if let Page::Thread(t, _) = &shown
                && let Some(v) = self.threads.get(t).cloned()
            {
                v.update(cx, |v, cx| v.visited(cx));
            }
            self.boxed = Some(shown.clone());
            cx.defer_in(window, |this, window, cx| this.focus_page_box(window, cx));
        }
        let shell = Shell::entity(cx).read(cx);
        let searching = matches!(shown, Page::Space(_)) && shell.searching_in.as_deref() == Some(here.as_str());
        let shortcuts_open = shell.shortcuts;
        let find = searching.then(|| self.find(&here, window, cx));
        if shortcuts_open && self.sheet_restore.is_none() {
            self.sheet_restore = Some(window.focused(cx));
            window.focus(&self.sheet_focus, cx);
        } else if !shortcuts_open && let Some(was) = self.sheet_restore.take() {
            if let Some(h) = was {
                window.focus(&h, cx);
            }
        }
        let rename = self.rename_field(window, cx);
        let band = crate::boundary::guard_in("band".into(), window, cx, |window, cx| band(&shown, &here, rename, &l, window, cx));
        let chat = div().flex().flex_col().flex_1().min_w_0().min_h_0().children(find).child(div().flex_1().min_h_0().child(main));
        let narrow = width < l.z(NARROW);
        let body = if matches!(shown, Page::Thread(..)) {
            // A piece of work opened is the page, full width under the band.
            chat.size_full().into_any_element()
        } else if narrow {
            crate::kit::pane_scroll(
                "narrow",
                None,
                div()
                    .flex()
                    .flex_col()
                    .child(self.rail.clone())
                    .child(chat.h(window.viewport_size().height - u(30.).to_pixels(window.rem_size())).flex_none().border_t(px(l.w1)).border_color(l.line1)),
                window,
                cx,
            )
        } else {
            div()
                .flex()
                .size_full()
                .child(div().flex_none().w(rail_w).h_full().border_r(px(l.w1)).border_color(l.line1).child(self.rail.clone()))
                .child(chat.h_full())
                // A narrower window folds the widgets away first.
                .children(match &shown {
                    Page::Space(space) if width >= l.z(WIDE) => Some(self.columns.entry(space.clone()).or_insert_with(|| cx.new(|cx| crate::widgets::column::WidgetColumn::new(space.clone(), cx))).clone()),
                    _ => None,
                })
                .into_any_element()
        };
        crate::menu::window_roles(div(), true)
            .key_context("Switch")
            .on_action(|d: &Do, window, cx| {
                // Dictation answers ⌘D where it listens, a global action.
                if d.0 == crate::commands::Command::Dictate {
                    cx.propagate();
                }
                crate::commands::run(&d.0, window, cx)
            })
            .on_action(|_: &Escape, window, cx| {
                let shown = match &Nav::entity(cx).read(cx).page {
                    Page::Space(_) => Some(crate::commands::here(cx)),
                    Page::Thread(..) => None,
                };
                let s = Shell::entity(cx).read(cx);
                if s.shortcuts {
                    Shell::update(cx, |s| s.shortcuts = false);
                } else if s.busy(shown.as_deref()) {
                    // The palette, ⌘F's bar or the rename takes it, as a key of its own.
                    cx.propagate();
                } else if crate::platform::dictation::dictating(cx) {
                    // Escape drops a dictation under way, else goes up.
                    crate::platform::dictation::cancel(cx);
                } else {
                    crate::commands::run(&crate::commands::Command::Up, window, cx);
                }
            })
            // Back and forward from a mouse's side buttons and a two-finger swipe (as Safari: fingers
            // to the right go back).
            .on_mouse_up(gpui::MouseButton::Navigate(gpui::NavigationDirection::Back), |_, _, cx| Nav::back(cx))
            .on_mouse_up(gpui::MouseButton::Navigate(gpui::NavigationDirection::Forward), |_, _, cx| Nav::forward(cx))
            .on_scroll(cx.listener(|this, e: &gpui::ScrollEvent, window, cx| {
                // One that lands where something scrolls sideways is that thing's.
                if SIDEWAYS.with(|s| s.replace(false)) {
                    return;
                }
                let d = e.delta.pixel_delta(window.line_height());
                let (dx, dy) = (f32::from(d.x), f32::from(d.y));
                if dx.abs() <= dy.abs() * 2. {
                    return;
                }
                if this.swipe.1.elapsed() > PAUSE {
                    this.swipe = (0., std::time::Instant::now(), false);
                }
                this.swipe.1 = std::time::Instant::now();
                this.swipe.0 += dx;
                if this.swipe.2 {
                    return;
                }
                if this.swipe.0 > SWIPE_PX {
                    this.swipe.2 = true;
                    Nav::back(cx);
                } else if this.swipe.0 < -SWIPE_PX {
                    this.swipe.2 = true;
                    Nav::forward(cx);
                }
            }))
            .on_action(cx.listener(|this, _: &ToBox, window, cx| this.focus_page_box(window, cx)))
            // A paste with nothing focused goes to the page's box, as one from its column does.
            .on_action(cx.listener(|this, _: &ui_sdk::native::text_field::Paste, window, cx| match this.boxed.clone() {
                Some(Page::Space(space)) => {
                    if let Some(c) = this.chats.get(&space).cloned() {
                        let b = c.read(cx).chatbox.clone();
                        b.update(cx, |b, cx| b.paste_outside(window, cx));
                    }
                }
                Some(Page::Thread(t, _)) => {
                    if let Some(v) = this.threads.get(&t).cloned() {
                        v.update(cx, |v, cx| v.paste_outside(window, cx));
                    }
                }
                None => {}
            }))
            // Files dropped anywhere on the window join the box of the space open.
            .on_drop(cx.listener(|this, paths: &gpui::ExternalPaths, window, cx| {
                if let Page::Space(space) = Nav::entity(cx).read(cx).page.clone()
                    && let Some(c) = this.chats.get(&space).cloned()
                {
                    c.update(cx, |c, cx| c.drop_paths(paths, window, cx));
                }
            }))
            // A key no field takes (nothing has the focus, or no field does) goes to the page's box.
            .on_key_down(cx.listener(|this, e: &gpui::KeyDownEvent, window, cx| {
                let in_field = window.context_stack().iter().any(|c| c.contains("TextField"));
                if in_field || Shell::entity(cx).read(cx).busy(None) {
                    return;
                }
                let page = Nav::entity(cx).read(cx).page.clone();
                // Something with the focus that isn't a field is a button: Space presses it.
                let pressing = window.focused(cx).is_some();
                let took = match &page {
                    Page::Space(space) => this.chats.get(space).cloned().is_some_and(|c| c.update(cx, |c, cx| c.typed_outside(e, pressing, window, cx))),
                    Page::Thread(t, _) => this.threads.get(t).cloned().is_some_and(|v| v.update(cx, |v, cx| v.typed_outside(e, pressing, window, cx))),
                };
                if took {
                    cx.stop_propagation();
                }
            }))
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .bg(l.bg)
            .text_color(l.ink)
            .font_family(SANS)
            // Figures line up: times and counts in tabular digits (`tabular-nums`).
            .font_features(crate::look::tabular())
            .text_size(u(13.))
            .line_height(u(16.))
            .map(|d| match pairing {
                // The window while this app waits to be paired: the code to approve on another
                // desktop (pairing.tsx).
                Some(code) => d
                    .child(
                        crate::kit::drags(div().id("pairing-band"), "pairing-band", window, cx).flex_none().h(u(30.)).border_b(px(l.w1)).border_color(l.line1),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .child(div().flex().flex_none().h(u(24.)).items_center().gap(u(8.)).px(u(8.)).text_size(u(13.)).line_height(u(16.)).font_weight(FontWeight::SEMIBOLD).child("Pair"))
                            .child(
                                div()
                                    .flex()
                                    .h(u(340.))
                                    .items_center()
                                    .justify_center()
                                    .border_b(px(l.w2))
                                    .border_color(l.line2)
                                    .font_family(crate::look::MONO)
                                    .text_size(u(22.))
                                    .line_height(u(22.))
                                    .child(crate::kit::selectable_all("pairing-code", code, window, cx)),
                            ),
                    ),
                None => d.child(band).child(div().flex().flex_1().min_h_0().child(body)),
            })
            // Always drawn: closed, it clears its words as it goes.
            .child(self.palette.clone())
            .when(shortcuts_open, |d| d.child(crate::shortcuts::sheet(&self.sheet_focus, window, cx)))
            .child(ui_sdk::foundation::platform::live_regions(window))
    }
}

pub fn bindings() -> Vec<gpui::KeyBinding> {
    vec![
        gpui::KeyBinding::new("/", ToBox, Some("Switch && !TextField")),
    ]
}

