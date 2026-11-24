//! A change made from Settings, with its own pending and error kept to its element, as a TanStack
//! mutation is kept to its component (the desktop's `use-account-action.ts`): what it runs is the
//! data layer's (`mutations.rs`).

use gpui::{AnyElement, App, ElementId, Entity, IntoElement, ParentElement, Styled, Task, Window, div, px};
use serde_json::Value;

use super::calls::land;
use super::parts::action_error;
use crate::look::{Look, u};
use crate::model::model;
use crate::mutations::urlencode;
use crate::queries;

/// A change's state: under way, and what went wrong the last time.
#[derive(Default)]
pub struct Act {
    pub pending: bool,
    pub error: Option<String>,
}

/// A change's state, kept to its element.
pub fn act(id: impl Into<String>, window: &mut Window, cx: &mut App) -> Entity<Act> {
    window.use_keyed_state(eid(format!("{}-act", id.into())), cx, |_, _| Act::default())
}

/// Under way until `task` answers; its error kept, else `done` with what it answered.
pub fn settle<T: 'static>(act: &Entity<Act>, task: Task<Result<T, String>>, done: impl FnOnce(T, &mut App) + 'static, cx: &mut App) {
    act.update(cx, |a, cx| {
        a.pending = true;
        a.error = None;
        cx.notify();
    });
    land(
        act,
        task,
        move |a, got, cx| {
            a.pending = false;
            a.error = got.as_ref().err().cloned();
            if let Ok(t) = got {
                done(t, cx);
            }
        },
        cx,
    );
}

/// An account route on private HTTP; done, the accounts are read again before it settles (so a
/// second start can't come before its row shows the first), and the catalog (which asks every
/// provider, so takes a while) after, without holding it up.
pub fn account(act: &Entity<Act>, route: String, body: Value, cx: &mut App) {
    let task = model(cx).update(cx, |m, cx| m.account_request(&route, Some(body), cx));
    let task = cx.spawn(async move |cx| {
        let got = task.await;
        let accounts = cx.update(|cx| {
            queries::invalidate(queries::MODELS, cx);
            queries::refetch(queries::ACCOUNTS, cx)
        });
        accounts.await;
        got
    });
    settle(act, task, |_, _| {}, cx);
}

/// `task`, settling only once the accounts are read again after it, so what it added or changed
/// is on its row as the button comes back (an add's or an action's `onSettled`).
pub fn then_accounts<T: 'static>(task: Task<Result<T, String>>, cx: &mut App) -> Task<Result<T, String>> {
    cx.spawn(async move |cx| {
        let got = task.await;
        let accounts = cx.update(|cx| queries::refetch(queries::ACCOUNTS, cx));
        accounts.await;
        got
    })
}

/// An account's action (`accountAction`).
pub fn account_action(act: &Entity<Act>, id: &str, action: &str, body: Value, cx: &mut App) {
    account(act, format!("/auth/accounts/{}/{action}", urlencode(id)), body, cx);
}

/// An error on a row of its own, under what it's about.
pub fn error_row(e: &str, l: &Look) -> AnyElement {
    div().flex().px(u(8.)).py(u(8.)).border_b(px(l.w2)).border_color(l.line2).child(action_error(e, l)).into_any_element()
}

/// An element's id from its words.
pub fn eid(s: impl Into<String>) -> ElementId {
    ElementId::Name(s.into().into())
}
