//! Showing people what an agent did.

use gpui::{App, Window};
use objc2_app_kit::NSView;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

use crate::agent;

/// Brings `window` in front of every other app's windows, restoring it if it's minimized, without
/// making it key or activating the app, so typing elsewhere carries on. For a window an agent
/// opened or changed, so the person sees it happen.
pub fn present(window: &Window) {
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return;
    };
    // SAFETY: GPUI's AppKit handle points at its window's live content view.
    let view = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
    if let Some(native) = view.window() {
        if native.isMiniaturized() {
            native.deminiaturize(None);
        }
        native.orderFrontRegardless();
    }
}

/// Whether the action being handled was sent by an agent, so its window should be presented.
pub fn from_agent(cx: &App) -> bool {
    agent::handling_agent_call(cx)
}
