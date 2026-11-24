//! Connections as the client reaches them (the desktop's `connections.ts`): connecting through the
//! OAuth relay (`platform/oauth.rs`), and an action item's tool as its button calls it; what each
//! returned opens (an extension's view in its window, a key's sealed ask in its). And what an ask
//! from the connections app shows beside its buttons (`connection-actions.tsx`,
//! `connection-verify.tsx`): Cancel while it signs in, Check sign-in and what that found. The
//! needs, disconnecting and verifying are the data layer's (`queries::needs`, `mutations.rs`).
// The asks' API (an action item's button, its Cancel and Check sign-in), drawn by the ask card.
#![allow(dead_code)]

use gpui::{AnyElement, App, ElementId, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement, Styled, Task, Window, div};
use serde_json::Value;

use crate::commands::OpenItem;
use crate::json::get;
use crate::kit::{self, Btn};
use crate::look::Look;
use crate::model::model;
use crate::platform::oauth::{self, ConnectionStart};
use crate::settings::calls::{act, mounted};
use crate::settings::parts::action_error;
use crate::widgets::window::{self, View};

/// Opens a view or an item a connection's answer carries.
fn open_returned(answer: &Value, item: bool, cx: &mut App) {
    let s = get(answer, "structuredContent");
    let view = get(s, "view");
    if let (Some(app), Some(name)) = (get(view, "app").as_str(), get(view, "name").as_str())
        && view.get("input").is_none_or(Value::is_object)
    {
        window::open(View { app: app.into(), name: name.into(), input: view.get("input").cloned() }, cx);
    }
    if item && let Some(id) = get(s, "item").as_str() {
        cx.dispatch_action(&OpenItem(id.to_string()));
    }
}

/// Runs `got`, then opens what it returned.
fn then_open(got: Task<Result<Value, String>>, item: bool, cx: &mut App) -> Task<Result<(), String>> {
    cx.spawn(async move |cx| {
        let got = got.await;
        if let Ok(answer) = &got {
            cx.update(|cx| open_returned(answer, item, cx));
        }
        got.map(|_| ())
    })
}

/// Opens a provider's consent in the system browser; a key's sealed ask, in a window of its own.
pub fn connect(provider: &str, account: Option<&str>, cx: &mut App) -> Task<Result<(), String>> {
    let got = oauth::connect(ConnectionStart { tool: "connect".into(), provider: provider.into(), account: account.map(str::to_string), scopes: None }, cx);
    then_open(got, true, cx)
}

/// Ends a provider's sign-in under way.
pub fn cancel_connection(provider: &str, cx: &App) {
    oauth::cancel(provider, cx);
}

/// An action's arguments as a connection's start, when they read as one.
fn start_of(tool: &str, args: &Value) -> Option<ConnectionStart> {
    if !matches!(tool, "connect" | "oauth") {
        return None;
    }
    let provider = get(args, "provider").as_str()?.to_string();
    let account = match args.get("account") {
        None => None,
        Some(v) => Some(v.as_str()?.to_string()),
    };
    let scopes = match args.get("scopes") {
        None => None,
        Some(v) => Some(v.as_array()?.iter().map(|x| x.as_str().map(str::to_string)).collect::<Option<Vec<_>>>()?),
    };
    Some(ConnectionStart { tool: tool.into(), provider, account, scopes })
}

/// An app's tool, as an action item's button calls it: the connections app's starts go through
/// the relay.
pub fn run_action(app: &str, tool: &str, args: &Value, cx: &mut App) -> Task<Result<(), String>> {
    let got = match start_of(tool, args).filter(|_| app == "connections") {
        Some(start) => oauth::connect(start, cx),
        None => {
            let (app, tool, args) = (app.to_string(), tool.to_string(), args.clone());
            model(cx).update(cx, |m, cx| m.call_checked(&app, &tool, args, cx))
        }
    };
    then_open(got, false, cx)
}

#[derive(Default)]
struct Verify {
    pending: bool,
    answer: Option<Result<bool, String>>,
    /// The answer has been read out (an alert, or the `output` "Connected").
    told: bool,
}

/// What an ask from the connections app shows beside its buttons: Cancel while `pending` signs
/// in, Check sign-in and what it found. `id` keys its state to the ask; nothing for another app's.
pub fn connection_actions(id: &str, app: &str, args: &Value, pending: bool, window: &mut Window, cx: &mut App) -> Vec<AnyElement> {
    if app != "connections" {
        return vec![];
    }
    let l = Look::get(cx);
    let mut out = vec![];
    if pending && let Some(provider) = get(args, "provider").as_str() {
        let provider = provider.to_string();
        out.push(kit::button(ElementId::Name(format!("{id}-cancel").into()), Btn::Flat, true, &l).role(gpui::Role::Button).aria_label("Cancel").child("Cancel").on_click(move |_, _, cx| cancel_connection(&provider, cx)).into_any_element());
    }
    out.extend(connection_verify(id, args, window, cx));
    out
}

const UNSIGNED: &str = "Not signed in; finish sign-in and check again.";

/// Check sign-in, for an action whose arguments name a provider (and maybe an account).
fn connection_verify(id: &str, args: &Value, window: &mut Window, cx: &mut App) -> Vec<AnyElement> {
    let Some(provider) = get(args, "provider").as_str().map(str::to_string) else { return vec![] };
    let account = match args.get("account") {
        None => None,
        Some(Value::String(a)) => Some(a.clone()),
        Some(_) => return vec![],
    };
    let l = Look::get(cx);
    let (state, _) = mounted(ElementId::Name(format!("{id}-verify").into()), window, cx, |_| Verify::default());
    let v = state.read(cx);
    let on = !v.pending;
    let mut out = vec![kit::press(kit::button(ElementId::Name(format!("{id}-check").into()), Btn::Key, on, &l), on, {
        let state = state.clone();
        move |_, _, cx| {
            state.update(cx, |v, cx| {
                v.pending = true;
                v.answer = None;
                v.told = false;
                cx.notify();
            });
            let (provider, account) = (provider.clone(), account.clone());
            act(&state, move |m, cx| m.verify_connection(&provider, account.as_deref(), cx), |v, got, _| {
                v.pending = false;
                v.answer = Some(got);
            }, cx);
        }
    })
    .role(gpui::Role::Button)
    .aria_label("Check sign-in")
    .child("Check sign-in")
    .into_any_element()];
    let (answer, told) = (v.answer.clone(), v.told);
    // What it found is read out as it shows: the alerts at once, "Connected" politely.
    if let Some(a) = &answer
        && !told
    {
        use ui_sdk::foundation::platform::{AnnouncePriority, announce_with};
        match a {
            Ok(true) => announce_with("Connected", AnnouncePriority::Polite, window, cx),
            Ok(false) => announce_with(UNSIGNED, AnnouncePriority::Assertive, window, cx),
            Err(e) => announce_with(&crate::mutations::safe_error(e), AnnouncePriority::Assertive, window, cx),
        }
        state.update(cx, |v, _| v.told = true);
    }
    match &answer {
        Some(Err(e)) => out.push(action_error(e, &l)),
        Some(Ok(false)) => {
            let text = UNSIGNED;
            out.push(kit::small(div()).id(ElementId::Name(format!("{id}-unsigned").into())).role(gpui::Role::Alert).aria_label(text).w_full().text_color(l.red).child(text).into_any_element());
        }
        Some(Ok(true)) => out.push(kit::small(div()).id(ElementId::Name(format!("{id}-connected").into())).role(gpui::Role::Status).aria_label("Connected").text_color(l.ink2).child("Connected").into_any_element()),
        None => {}
    }
    out
}
