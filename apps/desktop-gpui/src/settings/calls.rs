//! The plumbing Settings' sections share: an act's answer landing in a section's state, what a
//! section holds while it's shown (a mounted component's state in the desktop), and a number as
//! JavaScript prints it.

use std::cell::Cell;
use std::future::Future;
use std::rc::Rc;

use gpui::{App, Context, ElementId, Entity, Window};

use crate::model::model;

/// An act's answer landing in a section's state, which redraws; dropped if the section has gone.
pub fn land<S: 'static, T: 'static>(e: &Entity<S>, got: impl Future<Output = Result<T, String>> + 'static, f: impl FnOnce(&mut S, Result<T, String>, &mut Context<S>) + 'static, cx: &mut App) {
    let weak = e.downgrade();
    cx.spawn(async move |cx| {
        let got = got.await;
        weak.update(cx, |s, cx| {
            f(s, got, cx);
            cx.notify();
        })
        .ok();
    })
    .detach();
}

/// One of the data layer's acts on the model (`mutations.rs`), landing in a section's state.
pub fn act<S: 'static, T: 'static>(e: &Entity<S>, run: impl FnOnce(&mut crate::model::Model, &mut Context<crate::model::Model>) -> gpui::Task<Result<T, String>>, f: impl FnOnce(&mut S, Result<T, String>, &mut Context<S>) + 'static, cx: &mut App) {
    let task = model(cx).update(cx, run);
    land(e, task, f, cx);
}

/// A section's own state while it's shown, made as it's first drawn (`fresh` true that frame) and
/// dropped when it isn't drawn.
pub fn mounted<S: 'static>(id: impl Into<ElementId>, window: &mut Window, cx: &mut App, init: impl FnOnce(&mut Context<S>) -> S) -> (Entity<S>, bool) {
    let fresh = Rc::new(Cell::new(false));
    let made = fresh.clone();
    let e = window.use_keyed_state(id, cx, move |_, cx| {
        made.set(true);
        init(cx)
    });
    (e, fresh.get())
}

/// A JavaScript number as it prints: no ".0" on a whole one.
pub fn num(n: f64) -> String {
    if n.fract() == 0. && n.abs() < 1e21 { format!("{}", n as i64) } else { format!("{n}") }
}
