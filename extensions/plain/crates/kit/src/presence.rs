//! Whether an app shows in the Dock and the app switcher. An app an agent started in the
//! background stays out of both until it has a window for someone to see, and goes back out once
//! its last window closes, unless the person has brought it forward themselves.

use std::sync::atomic::{AtomicBool, Ordering};

use gpui::{ActivationPolicy, App, Global};

/// Whether the app is only running for agents, so it hides when it has no windows.
struct Presence {
    for_agents: bool,
}

impl Global for Presence {}

/// Set while opening a window nobody will see, like one opened just for a screenshot.
static OPENING_UNSEEN: AtomicBool = AtomicBool::new(false);

/// Sets the app up for how it was launched: hidden from the Dock and switcher when started in
/// the background for an agent.
pub(crate) fn start(background: bool, cx: &mut App) {
    cx.set_global(Presence {
        for_agents: background,
    });
    if background {
        cx.set_activation_policy(ActivationPolicy::Accessory);
    }
    cx.on_window_closed(|cx, _| {
        if cx.windows().is_empty() && cx.global::<Presence>().for_agents {
            cx.set_activation_policy(ActivationPolicy::Accessory);
        }
    })
    .detach();
}

/// The person opened the app or brought it forward, so it's an ordinary app from now on, in
/// the Dock whether or not it has windows.
pub(crate) fn opened_by_person(cx: &mut App) {
    cx.global_mut::<Presence>().for_agents = false;
    cx.set_activation_policy(ActivationPolicy::Regular);
}

/// A window is opening. One people will see puts the app in the Dock and switcher.
pub(crate) fn window_opening(cx: &mut App) {
    if !OPENING_UNSEEN.load(Ordering::SeqCst) {
        cx.set_activation_policy(ActivationPolicy::Regular);
    }
}

/// Runs `open` without the windows it opens counting as seen.
pub(crate) fn unseen<R>(open: impl FnOnce() -> R) -> R {
    OPENING_UNSEEN.store(true, Ordering::SeqCst);
    let opened = open();
    OPENING_UNSEEN.store(false, Ordering::SeqCst);
    opened
}
