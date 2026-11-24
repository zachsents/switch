//! What the app asks of AppKit itself, beyond gpui: a window's NSWindow, showing and hiding it at
//! once with no animation (the desktop's `bun/still.ts`), keeping its bottom edge, whether it's on screen,
//! and the app's own panels.

use gpui::Window;
use objc2::MainThreadMarker;
use objc2::rc::Retained;
use objc2_app_kit::{NSApplication, NSRunningApplication, NSView, NSWindow, NSWindowAnimationBehavior, NSWindowOcclusionState};
use objc2_foundation::NSRect;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

/// The AppKit window behind a gpui window.
pub fn ns_window(window: &Window) -> Option<Retained<NSWindow>> {
    // Not gpui's own `window_handle`, which names the window to gpui.
    let RawWindowHandle::AppKit(handle) = HasWindowHandle::window_handle(window).ok()?.as_raw() else { return None };
    // SAFETY: gpui's AppKit handle points at its window's live NSView, and windows are only touched
    // on the main thread, where this runs.
    let view = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
    view.window()
}

/// A window shows and hides at once: macOS's own zoom and fade when a window is ordered in or out is
/// turned off, as everything else in the app moves only to show where something goes.
pub fn still(window: &Window) {
    if let Some(w) = ns_window(window) {
        w.setAnimationBehavior(NSWindowAnimationBehavior::None);
    }
}

/// Hides the window (ordered out); the app keeps running.
pub fn hide(window: &Window) {
    if let Some(w) = ns_window(window) {
        w.orderOut(None);
    }
}

/// How opaque the window is: 0, on screen (so it draws) but not seen; 1, seen.
pub fn set_alpha(window: &Window, alpha: f64) {
    if let Some(w) = ns_window(window) {
        w.setAlphaValue(alpha);
    }
}

/// Shows the window and brings it forward.
pub fn show(window: &Window) {
    if let Some(w) = ns_window(window) {
        w.makeKeyAndOrderFront(None);
    }
}

/// Whether the window is on screen and not hidden behind others.
pub fn visible(window: &Window) -> bool {
    ns_window(window).is_some_and(|w| w.isVisible() && w.occlusionState().contains(NSWindowOcclusionState::Visible))
}

/// Where the window's bottom edge is (AppKit counts up from the bottom).
pub fn bottom(window: &Window) -> Option<f64> {
    ns_window(window).map(|w| w.frame().origin.y)
}

/// Moves the window up or down so its bottom edge is at `y`, within its display's work area.
pub fn set_bottom(window: &Window, y: f64) {
    if let Some(w) = ns_window(window) {
        let f = w.frame();
        let mut at = f.origin;
        at.y = y;
        if let Some(area) = w.screen().map(|s| s.visibleFrame()) {
            at.y = at.y.max(area.origin.y).min(area.origin.y + area.size.height - f.size.height);
        }
        w.setFrameOrigin(at);
    }
}

/// The standard About panel.
pub fn about() {
    if let Some(mtm) = MainThreadMarker::new() {
        NSApplication::sharedApplication(mtm).orderFrontStandardAboutPanel(None);
    }
}

/// Window ▸ Bring All to Front.
pub fn bring_all_to_front() {
    if let Some(mtm) = MainThreadMarker::new() {
        NSApplication::sharedApplication(mtm).arrangeInFront(None);
    }
}

/// The app's name, as macOS shows it.
pub fn app_name() -> String {
    NSRunningApplication::currentApplication().localizedName().map(|n| n.to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| "Switch".into())
}

/// A window comes out of full screen where it was before it went in. AppKit puts it back with its
/// top under the menu bar; the frame it had is kept as it goes in, and given back once it's out.
pub fn keep_frames_through_full_screen() {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::ptr::NonNull;
    use std::rc::Rc;

    use block2::RcBlock;
    use objc2_app_kit::{NSWindowDidExitFullScreenNotification, NSWindowWillEnterFullScreenNotification};
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSOperationQueue};

    let saved: Rc<RefCell<HashMap<usize, NSRect>>> = Rc::default();
    let window_of = |n: NonNull<NSNotification>| -> Option<Retained<NSWindow>> {
        // SAFETY: AppKit's notification, alive for the block's call; its object is the window.
        let object = unsafe { n.as_ref() }.object()?;
        object.downcast::<NSWindow>().ok()
    };
    let keep = {
        let saved = saved.clone();
        RcBlock::new(move |n: NonNull<NSNotification>| {
            if let Some(w) = window_of(n) {
                saved.borrow_mut().insert(Retained::as_ptr(&w) as usize, w.frame());
            }
        })
    };
    let give_back = RcBlock::new(move |n: NonNull<NSNotification>| {
        if let Some(w) = window_of(n)
            && let Some(f) = saved.borrow_mut().remove(&(Retained::as_ptr(&w) as usize))
        {
            w.setFrame_display(f, true);
        }
    });
    let center = NSNotificationCenter::defaultCenter();
    let main = NSOperationQueue::mainQueue();
    // SAFETY: the blocks run on the main queue, where the windows are; the observers last as long
    // as the app.
    unsafe {
        std::mem::forget(center.addObserverForName_object_queue_usingBlock(Some(NSWindowWillEnterFullScreenNotification), None, Some(&main), &keep));
        std::mem::forget(center.addObserverForName_object_queue_usingBlock(Some(NSWindowDidExitFullScreenNotification), None, Some(&main), &give_back));
    }
}

/// Whether the event AppKit is handling now is the left button dragged: a window drag started on
/// any other (a stale press, a move with the button up) moves the window by an old offset.
pub fn left_dragging() -> bool {
    let Some(mtm) = MainThreadMarker::new() else { return false };
    NSApplication::sharedApplication(mtm).currentEvent().is_some_and(|e| e.r#type() == objc2_app_kit::NSEventType::LeftMouseDragged)
}
