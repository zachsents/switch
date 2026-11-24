//! An ask in a window of its own, as old Switchboard's ask window (the desktop's `item-window.tsx`,
//! `item-held.ts`, bun's `openItem`): the band to drag it by, with where it's from (its space's ring
//! and name), then the card. It opens 640 by 480 at the screen's centre and comes on screen once
//! the card is drawn, fitted to it (at most 720, its bottom edge kept); the title is the ask's.
//! Opened on an ask the brain doesn't hold, it doesn't open. Opened on an open ask, it closes
//! itself once the ask closes (answered here or anywhere); opened on a closed one, it shows it
//! read-only, as it was decided. Esc and ⌘W close it too. One window per ask: opening it again
//! brings it to the front.

use std::collections::HashMap;

use gpui::{
    AnyWindowHandle, App, AppContext, Bounds, Context, Entity, FocusHandle, Focusable, FontWeight, InteractiveElement, IntoElement, KeyDownEvent, MouseButton,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, TitlebarOptions, Window, WindowBounds, WindowOptions, canvas, div, point, px, size,
};

use crate::asks::card::{self, AskCard};
use crate::brain::HOME;
use crate::look::{Look, SANS, SIGN, u};
use crate::marks;
use crate::model::model;

/// The windows open, by item.
#[derive(Default)]
struct Open(HashMap<String, AnyWindowHandle>);
impl gpui::Global for Open {}

pub struct AskWindow {
    id: String,
    decided: bool,
    card: Option<Entity<AskCard>>,
    focus: FocusHandle,
    /// The card's height the window was last fitted to.
    fitted: f32,
    /// On screen yet: it comes on once the card is drawn and fitted.
    shown: bool,
    opened_at: std::time::Instant,
    title: String,
}

/// Opens an ask's window, or brings it to the front.
pub fn open(id: &str, cx: &mut App) {
    if !cx.has_global::<Open>() {
        cx.set_global(Open::default());
    }
    if let Some(h) = cx.global::<Open>().0.get(id).copied()
        && h.update(cx, |_, window, _| window.activate_window()).is_ok()
    {
        return;
    }
    // One the brain, caught up, doesn't hold: there's nothing to show (item-window.tsx closes).
    let held = model(cx).read(cx).brain.items.find(id).is_some();
    if model(cx).read(cx).brain.ready && !held {
        return;
    }
    let title: SharedString = "Ask".into();
    let bounds = crate::platform::windows::safe(Bounds::centered(None, size(px(640.), px(480.)), cx), cx);
    let id = id.to_string();
    let key = id.clone();
    // Timed from the ask to its first frame, in the desktop log.
    let opened_at = std::time::Instant::now();
    let made = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions { title: Some(title), appears_transparent: true, traffic_light_position: Some(point(px(10.), px(8.))) }),
            // On screen but unseen till the card is drawn and the window fits it: a window off screen
            // gets no frames to fit itself in.
            show: true,
            ..Default::default()
        },
        move |window, cx| {
            crate::platform::appkit::set_alpha(window, 0.);
            crate::platform::appkit::still(window);
            let w = cx.new(|cx| AskWindow::new(id, opened_at, window, cx));
            let focus = w.read(cx).focus.clone();
            window.focus(&focus, cx);
            w
        },
    );
    if let Ok(h) = made {
        cx.global_mut::<Open>().0.insert(key, h.into());
    }
}

/// An ask's window, while it's open.
#[cfg(feature = "shot")]
pub fn handle(id: &str, cx: &App) -> Option<AnyWindowHandle> {
    cx.try_global::<Open>()?.0.get(id).copied()
}

impl AskWindow {
    fn new(id: String, opened_at: std::time::Instant, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let item = model(cx).read(cx).brain.items.find(&id).cloned();
        let decided = item.as_ref().is_some_and(|i| !i.is_open());
        let card = item.map(|i| card::make(i, window, cx));
        if let Some(c) = &card {
            c.update(cx, |c, _| c.own = true);
        }
        cx.observe_in(&model(cx), window, |this: &mut AskWindow, _, window, cx| this.check(window, cx)).detach();
        let key = id.clone();
        cx.on_release(move |_, cx| {
            if cx.has_global::<Open>() {
                cx.global_mut::<Open>().0.remove(&key);
            }
        })
        .detach();
        AskWindow { id, decided, card, focus: cx.focus_handle(), fitted: 0., shown: false, opened_at, title: String::new() }
    }

    /// Opened on an open ask, it closes once the ask does.
    fn check(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let m = model(cx).read(cx);
        if !m.brain.ready {
            return;
        }
        // One being reworked is out of the queue: its window goes too.
        let open = m.brain.items.open.contains_key(&self.id);
        let known = m.brain.items.find(&self.id).cloned();
        if self.card.is_none()
            && let Some(item) = known.clone()
        {
            self.decided = !item.is_open();
            let c = card::make(item, window, cx);
            c.update(cx, |c, _| c.own = true);
            self.card = Some(c);
        }
        if !self.decided && !open {
            window.remove_window();
            return;
        }
        cx.notify();
    }
}

impl Focusable for AskWindow {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for AskWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        crate::webview::start_frame(window, cx);
        // The keyboard stays in the window: one whose focused key went (Done, now Undo) goes back to
        // the window, so Esc still closes it, as a page's keys go to its body.
        let controlling = self.card.as_ref().is_some_and(|c| c.read(cx).controlling());
        if !controlling && !self.focus.contains_focused(window, cx) {
            window.focus(&self.focus, cx);
        }
        let l = Look::get(cx);
        let m = model(cx).read(cx);
        let space = self.card.as_ref().map(|c| c.read(cx).item().space.clone()).unwrap_or_else(|| HOME.into());
        let home = space == HOME;
        let st = m.derived.station(&space);
        let ink = if home { l.ink } else { l.ink_of(&st) };
        let name = if home { "Home".to_string() } else { m.brain.spaces.get(&space).map(|s| s.name.clone()).unwrap_or_else(|| "Home".into()) };
        let entity = cx.entity().downgrade();
        // Its title is the ask's.
        let title = self.card.as_ref().map(|c| c.read(cx).item().title.clone()).unwrap_or_else(|| "Ask".into());
        if title != self.title {
            window.set_window_title(&title);
            self.title = title;
        }
        div()
            .track_focus(&self.focus)
            .on_key_down(|e: &KeyDownEvent, window, _| {
                let k = &e.keystroke;
                if k.key == "escape" || (k.key == "w" && k.modifiers.platform) {
                    window.remove_window();
                }
            })
            .size_full()
            .flex()
            .flex_col()
            .bg(l.bg)
            .text_color(l.ink)
            .font_family(SANS)
            .text_size(u(13.))
            .line_height(u(16.))
            .child(
                div()
                    .id("band")
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(u(6.))
                    .h(u(30.))
                    .pl(px(72.))
                    .pr(u(12.))
                    .bg(l.bg)
                    .border_b(px(l.w1))
                    .border_color(l.line1)
                    .on_mouse_down(MouseButton::Left, |e, window, _| {
                        if e.click_count == 2 {
                            window.titlebar_double_click();
                        } else {
                            window.start_window_move();
                        }
                    })
                    .when(self.card.is_some(), |d| {
                        d.child(marks::ring(&st.code, ink, l.z(18.), l.bg, l.ink, home))
                            .child(div().min_w_0().truncate().font_family(SIGN).font_weight(FontWeight::BOLD).text_size(u(15.)).line_height(u(15.)).text_color(ink).child(SharedString::from(name.to_uppercase())))
                    }),
            )
            .child(
                div().id("ask").flex_1().min_h_0().overflow_y_scroll().child(
                    div()
                        .relative()
                        .px(u(16.))
                        .children(self.card.clone())
                        // The window takes the card's height: the band, the card, nothing under it.
                        .child(
                            canvas(
                                move |bounds, window, cx| {
                                    let h = f32::from(bounds.size.height);
                                    let entity = entity.clone();
                                    if h > 0. {
                                        window.on_next_frame(move |window, cx| {
                                            entity
                                                .update(cx, |this, cx| {
                                                    if (this.fitted - h).abs() >= 1. {
                                                        this.fitted = h;
                                                        // The band and the card, at most 720 tall (bun/reading.ts), its
                                                        // bottom edge kept: a longer card scrolls in it.
                                                        let band = f32::from(u(30.).to_pixels(window.rem_size()));
                                                        crate::platform::windows::fit(window, h + band);
                                                        return;
                                                    }
                                                    // Fitted, and drawn at that size: on screen now, timed to this frame.
                                                    if !this.shown && this.card.is_some() {
                                                        this.shown = true;
                                                        crate::platform::timing::opened("item", this.opened_at, window);
                                                        crate::platform::appkit::set_alpha(window, 1.);
                                                        crate::platform::appkit::show(window);
                                                        cx.notify();
                                                    }
                                                })
                                                .ok();
                                        });
                                    }
                                    let _ = cx;
                                },
                                |_, _, _, _| {},
                            )
                            .absolute()
                            .top_0()
                            .left_0()
                            .size_full(),
                        ),
                ),
            )
            .child(ui_sdk::foundation::platform::live_regions(window))
    }
}

use gpui::prelude::FluentBuilder;
