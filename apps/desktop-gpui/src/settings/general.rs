//! General (the desktop's `ui/settings/general.tsx`): launching at login and updating by itself
//! (this Mac's own), the version and Update now, and every shortcut.

use gpui::{AnyElement, App, Global, InteractiveElement, IntoElement, ParentElement, Styled, Window, div, prelude::*};

use crate::commands::SHORTCUTS;
use crate::kit::{self, Btn, W40};
use crate::local::{Local, local, set_local};
use crate::look::Look;

/// The version running and one downloaded that waits to be applied ("" for none), as the updater
/// last said.
#[derive(Clone, Default)]
pub struct Updates {
    pub current: String,
    pub waiting: String,
}
impl Global for Updates {}

/// Applies the waiting update: the app relaunches (the updater answers it).
#[derive(Clone, Debug, PartialEq, Default, gpui::Action)]
#[action(namespace = switch)]
pub struct UpdateNow;

struct Held(Local);
impl Global for Held {}

/// Asks this Mac (launchctl, plutil, a file) off the window's thread; what it says shows once it
/// answers.
fn ask(f: impl FnOnce() -> Local + Send + 'static, cx: &mut App) {
    let task = cx.background_executor().spawn(async move { f() });
    cx.spawn(async move |cx| {
        let now = task.await;
        cx.update(|cx| {
            cx.set_global(Held(now));
            cx.refresh_windows();
        });
    })
    .detach();
}

/// Read again from this Mac as General opens.
pub fn reread(cx: &mut App) {
    ask(local, cx);
}

/// What's held, as the desktop's `localQuery` starts: off, updating by itself, until this Mac says.
fn held(cx: &mut App) -> Local {
    if cx.try_global::<Held>().is_none() {
        cx.set_global(Held(Local { login: false, auto_update: true, error: None }));
        ask(local, cx);
    }
    cx.global::<Held>().0.clone()
}

pub fn render(window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let local = held(cx);
    let update = cx.try_global::<Updates>().cloned().unwrap_or_default();
    let on_off = [("off", "Off"), ("on", "On")];
    let mut app: Vec<AnyElement> = vec![kit::setting("Launch at login", W40, &l)
        .child(kit::controls().child(kit::segmented("login", "Launch at login", &on_off, if local.login { "on" } else { "off" }, &l, |v, _, cx| {
            let on = v == "on";
            ask(move || set_local(Some(on), None), cx);
        }, window, cx)))
        .into_any_element()];
    if let Some(e) = &local.error {
        app.push(kit::small(div()).id("login-error").role(gpui::Role::Alert).px(crate::look::u(8.)).py(crate::look::u(8.)).text_color(l.red).child(e.clone()).into_any_element());
    }
    app.push(
        kit::setting("Updates", W40, &l)
            .child(kit::controls().child(kit::segmented("updates", "Updates", &[("auto", "Automatic"), ("manual", "Manual")], if local.auto_update { "auto" } else { "manual" }, &l, |v, _, cx| {
                let auto = v == "auto";
                ask(move || set_local(None, Some(auto)), cx);
            }, window, cx)))
            .into_any_element(),
    );
    if !update.current.is_empty() {
        app.push(
            kit::setting("Version", W40, &l)
                .child(
                    kit::controls()
                        .child(kit::data(div()).text_color(l.ink).child(update.current.clone()))
                        .when(!update.waiting.is_empty(), |d| d.child(kit::button("update-now", Btn::Go, true, &l).aria_label("Update now").child("Update now").on_click(|_, window, cx| window.dispatch_action(Box::new(UpdateNow), cx)))),
                )
                .into_any_element(),
        );
    }
    let shortcuts: Vec<AnyElement> = SHORTCUTS.iter().map(|(label, keys)| kit::setting(*label, W40, &l).child(kit::controls().child(kit::ui(div()).text_color(l.ink).child(*keys))).into_any_element()).collect();
    kit::pane_scroll("general", None, div().flex().flex_col().child(kit::group("App", None, app, &l)).child(kit::group("Shortcuts", None, shortcuts, &l)), window, cx)
}
