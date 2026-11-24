//! An ask's live view (the desktop's `ask-portal.tsx`, core/portal.ts), as Switchboard's portal on
//! a Mac: the card shows the screen live while it's on screen, and a click on it opens the
//! controller over the whole window, where clicks, drags, the wheel and typing go to that Mac.
//! Opening it brings the ask's tab to the front there. The view is the core's own page, in a web
//! view; it says when it ends, and the controller closes. The card's picture pauses while the
//! controller is open. The picture is a key (Tab, Space, Enter); the controller is a dialog with the
//! keyboard, whose Esc closes it and nothing else, the keyboard back on the picture.

use std::rc::Rc;
use std::time::{Duration, Instant};

use futures::StreamExt;
use gpui::{AnyElement, App, Context, FocusHandle, FontWeight, InteractiveElement, IntoElement, KeyDownEvent, ParentElement, StatefulInteractiveElement, Styled, Window, anchored, deferred, div, point, px, relative};
use serde_json::Value;

use crate::kit::{Btn, button};
use crate::look::{Look, u};
use crate::net::Net;
use crate::webview::{self, Source, WebView};

/// How long the picture keeps streaming off screen before it's let go.
const UNSEEN: Duration = Duration::from_secs(2);

pub struct Portal {
    item: String,
    watch: Option<Rc<WebView>>,
    control: Option<Rc<WebView>>,
    unseen: Option<Instant>,
    /// The picture, as a key.
    screen: FocusHandle,
    /// The controller, which keeps the keyboard while it's open.
    trap: FocusHandle,
}

/// The core's portal page for an item: the item and the credential ride in its fragment, which never
/// leaves this machine; `watch` only shows it.
/// A quiet copy (a test beside the live app) has none: the page would act on the remote Mac with
/// the credential, past the outbox's quiet.
fn url(item: &str, watch: bool, cx: &App) -> Option<String> {
    if crate::outbox::quiet() {
        return None;
    }
    let auth = cx.global::<Net>().auth()?;
    let enc = crate::widgets::host::urlencode;
    let mut hash = format!("item={}&token={}", enc(item), enc(&auth.token));
    if watch {
        hash.push_str("&watch=1");
    }
    Some(format!("{}/portal#{hash}", auth.core))
}

impl Portal {
    pub fn new(item: &str, cx: &mut App) -> Self {
        Portal { item: item.into(), watch: None, control: None, unseen: None, screen: cx.focus_handle(), trap: cx.focus_handle() }
    }

    /// Lets the picture go once it's been off screen a while: it streams only while it's seen.
    pub fn tick(&mut self) -> bool {
        let Some(w) = &self.watch else { return false };
        if w.is_shown() {
            self.unseen = None;
            return false;
        }
        let since = *self.unseen.get_or_insert_with(Instant::now);
        if since.elapsed() >= UNSEEN {
            self.watch = None;
            self.unseen = None;
            return true;
        }
        false
    }

    /// The picture on the card: the screen at 16:9 on black, the whole of it a key that opens the
    /// controller.
    pub fn picture<T: 'static>(&mut self, window: &mut Window, cx: &mut Context<T>, open: impl Fn(&mut T, &mut Window, &mut Context<T>) + 'static) -> AnyElement {
        if self.watch.is_none() && self.control.is_none()
            && let Some(u) = url(&self.item, true, cx)
            && let Some(v) = WebView::new(window, Source::Framed(&u), &[], cx)
        {
            v.passthrough(true);
            v.forward_wheel(true);
            self.watch = Some(v);
        }
        let l = Look::get(cx);
        crate::kit::focusable(div().id(gpui::ElementId::Name(format!("portal-{}", self.item).into())), &l)
            .track_focus(&self.screen)
            .relative()
            .w_full()
            .h(px(0.))
            .pb(relative(9. / 16.))
            .bg(gpui::black())
            .overflow_hidden()
            .role(gpui::Role::Button).aria_label("Screen")
            .on_click(cx.listener(move |this, _, window, cx| open(this, window, cx)))
            .when_some(self.watch.clone().filter(|_| self.control.is_none()), |d, v| d.child(div().absolute().top_0().left_0().size_full().child(webview::slot(v, None))))
            .into_any_element()
    }

    /// Opens the controller: the page with the keyboard and the pointer, over the whole window.
    pub fn open<T: 'static>(&mut self, window: &mut Window, cx: &mut Context<T>, ended: impl Fn(&mut T, &mut Window, &mut Context<T>) + 'static) {
        let Some(u) = url(&self.item, false, cx) else { return };
        // Esc in the live screen is the remote Mac's, as a key in the desktop's frame is; the
        // controller's own Esc closes it when the window has the keys.
        let Some(v) = WebView::new(window, Source::Framed(&u), &[], cx) else { return };
        v.forward_wheel(false);
        self.watch = None;
        let item = self.item.clone();
        if let Some(mut inbox) = v.messages() {
            let ended = Rc::new(ended);
            cx.spawn_in(window, async move |this, cx| {
                while let Some(text) = inbox.next().await {
                    let Ok(m) = serde_json::from_str::<Value>(&text) else { continue };
                    if (m.get("portal").and_then(Value::as_str) == Some(item.as_str()) && m.get("ended").is_some()) {
                        let ended = ended.clone();
                        this.update_in(cx, move |t, window, cx| ended(t, window, cx)).ok();
                        break;
                    }
                }
            })
            .detach();
        }
        let focus = v.clone();
        window.on_next_frame(move |_, _| focus.focus());
        window.focus(&self.trap, cx);
        self.control = Some(v);
    }

    /// The controller is open.
    pub fn controlling(&self) -> bool {
        self.control.is_some()
    }

    pub fn close(&mut self) {
        self.control = None;
    }

    /// Closed by the user: the keyboard goes back to the picture, as a dialog gives it back.
    pub fn close_here(&mut self, window: &mut Window, cx: &mut App) {
        self.control = None;
        window.focus(&self.screen, cx);
    }

    /// The picture let go too (its ask closed).
    pub fn let_go(&mut self) {
        self.watch = None;
        self.unseen = None;
    }

    /// The controller over the whole window: a band with the ask's title and Close, then the screen.
    pub fn controller<T: 'static>(&self, title: &str, window: &mut Window, cx: &mut Context<T>, close: impl Fn(&mut T, &mut Window, &mut Context<T>) + 'static) -> Option<AnyElement> {
        let v = self.control.clone()?;
        let l = Look::get(cx);
        let size = window.viewport_size();
        let close = Rc::new(close);
        let (on_key, on_escape) = (close.clone(), close.clone());
        Some(
            deferred(
                anchored().position(point(px(0.), px(0.))).child(
                    div()
                        .id("portal-controller")
                        .role(gpui::Role::Dialog)
                        .aria_label(title.to_string())
                        .track_focus(&self.trap)
                        // Esc closes it, and only it: the main window's Esc
                        // (up a space) is an action, which the controller takes first.
                        .on_action(cx.listener(move |t, _: &crate::commands::Escape, window, cx| on_escape(t, window, cx)))
                        .capture_key_down(cx.listener(move |t, e: &KeyDownEvent, window, cx| {
                            if e.keystroke.key == "escape" {
                                cx.stop_propagation();
                                on_key(t, window, cx);
                            }
                        }))
                        .occlude()
                        .relative()
                        .child(crate::webview::covering())
                        .w(size.width)
                        .h(size.height)
                        .flex()
                        .flex_col()
                        .bg(gpui::black())
                        .child(
                            div()
                                .flex()
                                .flex_none()
                                .items_center()
                                .gap(u(8.))
                                .h(u(24.))
                                .px(u(12.))
                                .bg(l.bg)
                                .border_b(px(l.w1))
                                .border_color(l.line1)
                                .child(div().flex_1().min_w_0().truncate().text_size(u(13.)).font_weight(FontWeight::MEDIUM).text_color(l.ink).child(title.to_string()))
                                .child(button("portal-close", Btn::Flat, true, &l).role(gpui::Role::Button).aria_label("Close").child("Close").on_click(cx.listener(move |t, _, window, cx| close(t, window, cx)))),
                        )
                        .child(div().flex_1().min_h_0().w_full().child(webview::slot(v, None))),
                ),
            )
            .with_priority(10)
            .into_any_element(),
        )
    }
}

use gpui::prelude::FluentBuilder;
