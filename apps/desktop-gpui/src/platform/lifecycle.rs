//! The app's life (the desktop's `bun/index.ts`): the main window, shown and hidden at once with no
//! animation; closing it (⌘W, its red button) hides it, and the app keeps running: the Dock or a
//! link brings it back as it was. A window of one thing still closes. Quitting (⌘Q, the Dock, a
//! script, logging out) quits. The window coming forward and going back is told to the watch (what's in
//! front, for notifications and hangs) and to updates.

use std::sync::atomic::{AtomicBool, Ordering};

use gpui::{AnyWindowHandle, App, AppContext, Application, Bounds, Entity, Global, Pixels, Window, point, px, size};

use super::appkit;

base::kept! {
    static QUITTING: AtomicBool = AtomicBool::new(false);
}

/// The main window, and what watches it come forward.
struct Main(AnyWindowHandle, #[allow(dead_code)] Entity<()>);
impl Global for Main {}

/// The main window, once it's open.
pub fn main_window(cx: &App) -> Option<AnyWindowHandle> {
    cx.try_global::<Main>().map(|m| m.0)
}

/// The main window's first frame: `WxH+X+Y` from $SWITCH_FRAME (a test run's size), else 1240 by
/// 800 at (160, 120).
pub fn first_frame(cx: &App) -> Bounds<Pixels> {
    super::windows::safe(given_frame(), cx)
}

fn given_frame() -> Bounds<Pixels> {
    let given = std::env::var("SWITCH_FRAME").unwrap_or_default();
    let (wh, xy) = given.split_once('+').map(|(a, b)| (a.to_string(), Some(b.to_string()))).unwrap_or((given.clone(), None));
    let Some((w, h)) = wh.split_once('x').and_then(|(w, h)| Some((w.parse::<f32>().ok()?, h.parse::<f32>().ok()?))) else {
        return Bounds { origin: point(px(160.), px(120.)), size: size(px(1240.), px(800.)) };
    };
    let (x, y) = xy.and_then(|xy| xy.split_once('+').and_then(|(x, y)| Some((x.parse::<f32>().ok()?, y.parse::<f32>().ok()?)))).unwrap_or((160., 120.));
    Bounds { origin: point(px(x), px(y)), size: size(px(w), px(h)) }
}

/// Before the app runs: the Dock's reopen brings the main window back. (Links from outside are
/// main.rs's, to links.rs once the brain is read.)
pub fn before_run(app: &Application) {
    one_at_a_time();
    app.on_reopen(show_main);
    // The View menu's own Enter Full Screen is the app's: AppKit adds none of its own beside it.
    objc2_foundation::NSUserDefaults::standardUserDefaults().setBool_forKey(false, objc2_foundation::ns_string!("NSFullScreenMenuItemEverywhere"));
}

/// Before any window: quitting lets every window close; every command and every window's role,
/// whichever window is in front.
pub fn start(cx: &mut App) {
    commands_everywhere(cx);
    appkit::keep_frames_through_full_screen();
    cx.on_window_closed(|_, id| super::oauth::close_window(id)).detach();
    cx.on_app_quit(|cx| {
        QUITTING.store(true, Ordering::Relaxed);
        super::oauth::close();
        crate::auth::release(cx.global::<crate::net::Net>());
        async {}
    })
    .detach();
}

/// The main window is open: it shows and hides at once, its close hides it, and its coming forward
/// and going back are told.
pub fn opened(window: &mut Window, cx: &mut App) {
    let watcher = cx.new(|_| ());
    cx.set_global(Main(window.window_handle(), watcher.clone()));
    appkit::still(window);
    window.on_window_should_close(cx, |window, _| {
        if QUITTING.load(Ordering::Relaxed) {
            return true;
        }
        appkit::hide(window);
        false
    });
    let was = std::cell::Cell::new(window.is_window_active());
    watcher.update(cx, |_, cx| {
        cx.observe_window_activation(window, move |_, window, cx| {
            let on = window.is_window_active();
            if was.replace(on) != on {
                super::watch::focus(on);
                super::update::focus(on, cx);
            }
        })
        .detach();
    });
}

/// Every window shows and hides at once, whichever page opened it: each new one is made still.
pub fn still_all(cx: &mut App) {
    base::kept_local! {
        static STILL: std::cell::RefCell<std::collections::HashSet<gpui::WindowId>> = Default::default();
    }
    for w in cx.windows() {
        if STILL.with(|s| s.borrow_mut().insert(w.window_id())) {
            let _ = w.update(cx, |_, window, _| appkit::still(window));
        }
    }
}

/// ⌘W: the main window hides; a window of one thing closes.
pub fn close(window: &mut Window, cx: &mut App) {
    if main_window(cx) == Some(window.window_handle()) {
        appkit::hide(window);
    } else {
        window.remove_window();
    }
}

/// The main window back on screen and in front.
pub fn show_main(cx: &mut App) {
    if let Some(main) = main_window(cx) {
        let _ = main.update(cx, |_, window, _| appkit::show(window));
    }
    cx.activate(true);
}

/// Whether the main window is on screen: a hidden or occluded one can't hang.
pub fn main_visible(cx: &mut App) -> bool {
    main_window(cx).and_then(|m| m.update(cx, |_, window, _| appkit::visible(window)).ok()).unwrap_or(false)
}

pub fn about() {
    appkit::about();
}

pub fn bring_all_to_front() {
    appkit::bring_all_to_front();
}

pub fn app_name() -> String {
    appkit::app_name()
}

/// Every menu item and shortcut reaches the main window's view (the desktop's menu sends each to
/// it), whichever window is in front, and with it hidden: the main window answers one dispatched in
/// it itself; one from another window, or none, comes here and runs there. ⌘D is dictation's,
/// wherever it's asked. And Close, Minimize, Zoom and Full Screen work in every window, each in the
/// one in front.
fn commands_everywhere(cx: &mut App) {
    use crate::commands::{Command, Do};
    use crate::menu::{CloseWindow, FullScreen, Minimize, Zoom};
    cx.on_action(|d: &Do, cx| {
        if d.0 == Command::Dictate {
            cx.defer(super::dictation::toggle);
            return;
        }
        // After this dispatch: it may be the main window's own, with nothing in it focused, and a
        // window can't be entered while it dispatches.
        if let Some(main) = main_window(cx) {
            let c = d.0.clone();
            cx.defer(move |cx| {
                let _ = main.update(cx, move |_, window, cx| crate::commands::run(&c, window, cx));
            });
        }
    });
    let in_front = |cx: &mut App, f: fn(&mut Window, &mut App)| {
        if let Some(w) = cx.active_window() {
            cx.defer(move |cx| {
                let _ = w.update(cx, |_, window, cx| f(window, cx));
            });
        }
    };
    cx.on_action(move |_: &CloseWindow, cx| in_front(cx, close));
    cx.on_action(move |_: &Minimize, cx| in_front(cx, |w, _| w.minimize_window()));
    // An ask's window fits its card: Zoom leaves it as it is.
    cx.on_action(move |_: &Zoom, cx| {
        if cx.active_window().is_some_and(|w| w.downcast::<crate::asks::window::AskWindow>().is_some()) {
            return;
        }
        in_front(cx, |w, _| w.zoom_window())
    });
    cx.on_action(move |_: &FullScreen, cx| in_front(cx, |w, _| w.toggle_fullscreen()));
}

base::kept! {
    /// Whether the window in front is full screen, as the View menu last heard.
    static FULL: AtomicBool = AtomicBool::new(false);
}

pub fn full_screen(_: &App) -> bool {
    FULL.load(Ordering::Relaxed)
}

/// The View menu's Enter or Exit Full Screen follows the window in front.
pub fn follow_full_screen(cx: &mut App) {
    let now = cx.active_window().and_then(|w| w.update(cx, |_, window, _| window.is_fullscreen()).ok()).unwrap_or(false);
    if FULL.swap(now, Ordering::Relaxed) != now {
        cx.set_menus(crate::menu::build(&crate::menu::model_of(cx)));
    }
}

/// One copy of the app at a time, as macOS opens an app: started while another runs from the same
/// id (a launch by its path, a login item), it brings that one forward and goes. Two would both
/// dial in as the desktop, and an update's relaunch would bring the old one forward instead.
fn one_at_a_time() {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    use objc2_foundation::NSBundle;
    if super::helpers::bundle().is_none() {
        return;
    }
    let Some(id) = NSBundle::mainBundle().bundleIdentifier() else { return };
    let me = std::process::id() as i32;
    let other = NSRunningApplication::runningApplicationsWithBundleIdentifier(&id).iter().find(|a| a.processIdentifier() != me);
    if let Some(other) = other {
        other.activateWithOptions(NSApplicationActivationOptions::empty());
        std::process::exit(0);
    }
}
