//! A section that fails alone (the desktop's `ui/boundary.tsx`): its own fallback, "Can't show
//! this" with Retry, and the failure kept as a report until it's in the brain (`client.crashed`,
//! platform/watch.rs). The app's sections each draw inside one: the band, a space's rail and chat, a
//! thread, the palette, each widget, a widget's window, Settings.
//!
//! What it catches is a panic while the section builds its elements (a view's `render`, a widget's
//! surface): it's caught there, before gpui lays anything out. A panic while gpui lays out or paints
//! is past every section, and is a crash (reported on the next launch).
//!
//! Every section's building updates entities too (the model, a field, a part's state made with
//! `use_keyed_state`), and a panic inside one of those updates unwinds through gpui's: that entity
//! is never given back, and the update never ends, so nothing gpui holds back till then (notifies,
//! observers, defers) runs again. Nothing mends that, so such a panic is the app's crash, with
//! itself as the cause (`watch::section_fatal`); one in the section's own building is caught, and
//! the section shows its fallback.

use std::cell::Cell;
use std::collections::HashSet;
use std::ops::DerefMut;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::rc::Rc;

use gpui::{AnyElement, App, Context, Global, IntoElement, ParentElement, StatefulInteractiveElement, Styled, Window, div, px};

use crate::kit::{Btn, button};
use crate::look::{Look, u};
use crate::marks;

thread_local! {
    static INSIDE: Cell<u32> = const { Cell::new(0) };
}

/// Whether a section is being built: a panic now is the section's, an error, not the app's crash.
pub fn inside() -> bool {
    INSIDE.with(|i| i.get() > 0)
}

/// The sections that failed, until Retry.
#[derive(Default)]
struct Failed(HashSet<String>);
impl Global for Failed {}

fn failed(key: &str, cx: &App) -> bool {
    cx.try_global::<Failed>().is_some_and(|f| f.0.contains(key))
}

/// The fallback: a stop, "Can't show this", and Retry, which builds the section again.
fn fallback(key: String, cx: &App) -> AnyElement {
    let l = Look::get(cx);
    div()
        .flex()
        .flex_none()
        .w_full()
        .h(u(24.))
        .items_center()
        .gap(u(10.))
        .px(u(8.))
        .text_size(u(12.))
        .line_height(u(16.))
        .text_color(l.ink)
        .border_b(px(l.w2))
        .border_color(l.line2)
        .child(marks::stop(px(12.), &l))
        .child(div().flex_1().min_w_0().truncate().child("Can't show this"))
        .child(button(gpui::ElementId::Name(format!("retry-{key}").into()), Btn::Key, true, &l).aria_label("Retry").child("Retry").on_click(move |_, _, cx| {
            if cx.try_global::<Failed>().is_some() {
                cx.global_mut::<Failed>().0.remove(&key);
            }
            // Its queries that failed are asked again.
            crate::queries::retry_failed(cx);
            cx.refresh_windows();
        }))
        .into_any_element()
}

/// Builds a section under `key`: what `body` gives, or the fallback once it has panicked.
pub fn guard_in<C: DerefMut<Target = App>>(key: String, window: &mut Window, cx: &mut C, body: impl FnOnce(&mut Window, &mut C) -> AnyElement) -> AnyElement {
    if failed(&key, cx) {
        return fallback(key, cx);
    }
    INSIDE.with(|i| i.set(i.get() + 1));
    let built = catch_unwind(AssertUnwindSafe(|| body(window, &mut *cx)));
    INSIDE.with(|i| i.set(i.get() - 1));
    match built {
        Ok(e) => e,
        Err(_) => {
            // The panic hook (platform/watch.rs) has kept it as an error report, unsure till then.
            settle(cx);
            if cx.try_global::<Failed>().is_none() {
                cx.set_global(Failed::default());
            }
            cx.global_mut::<Failed>().0.insert(key.clone());
            fallback(key, cx)
        }
    }
}

/// Whether the panic left gpui mid-update: an update it unwound through never ends, and what's
/// deferred runs only as the outermost one ends. A task runs only once every update on the stack is
/// over, so by then the mark is there, unless one never will be.
fn settle(cx: &mut App) {
    let ended = Rc::new(Cell::new(false));
    let mark = ended.clone();
    cx.defer(move |_| mark.set(true));
    cx.spawn(async move |_| {
        if ended.get() {
            crate::platform::watch::section_whole();
        } else {
            crate::platform::watch::section_fatal();
        }
    })
    .detach();
}

/// A section whose first read failed (a query that throws, as the desktop's do into its boundary):
/// the same fallback, the failure reported once, and Retry asks again (`again`).
pub fn failed_read(key: &str, reason: &str, again: impl Fn(&mut App) + 'static, cx: &mut App) -> AnyElement {
    #[derive(Default)]
    struct Told(HashSet<String>);
    impl Global for Told {}
    let told = format!("{key}:{reason}");
    if !cx.default_global::<Told>().0.contains(&told) {
        cx.default_global::<Told>().0.insert(told);
        crate::platform::watch::error(reason, reason);
    }
    let l = Look::get(cx);
    div()
        .flex()
        .flex_none()
        .w_full()
        .h(u(24.))
        .items_center()
        .gap(u(10.))
        .px(u(8.))
        .text_size(u(12.))
        .line_height(u(16.))
        .text_color(l.ink)
        .border_b(px(l.w2))
        .border_color(l.line2)
        .child(marks::stop(px(12.), &l))
        .child(div().flex_1().min_w_0().truncate().child("Can't show this"))
        .child(button(gpui::ElementId::Name(format!("retry-{key}").into()), Btn::Key, true, &l).aria_label("Retry").child("Retry").on_click(move |_, _, cx| again(cx)))
        .into_any_element()
}

/// A view's whole render as a section of its own, `kind` and the view telling it from others.
pub fn guard<T: 'static>(kind: &str, window: &mut Window, cx: &mut Context<T>, body: impl FnOnce(&mut Window, &mut Context<T>) -> AnyElement) -> AnyElement {
    let key = format!("{kind}:{}", cx.entity_id());
    guard_in(key, window, cx, body)
}
