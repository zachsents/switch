//! Screenshots of the app's own windows for agents, taken in the background: nothing comes
//! forward and the person at the computer isn't interrupted.
//!
//! GPUI stops drawing a window while it's covered, on another Space or behind other apps, so a
//! plain capture shows whatever it drew last. While a screenshot is underway, the app's windows
//! report themselves as visible, which keeps GPUI drawing them. The capture uses
//! ScreenCaptureKit's view of the app's own windows, which needs no Screen Recording permission.

use std::{
    path::{Path, PathBuf},
    pin::pin,
    sync::{
        Once,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use block2::RcBlock;
use futures::{
    StreamExt,
    channel::mpsc,
    future::{Either, select},
};
use gpui::{AnyWindowHandle, App, Task};
use objc2::{
    AnyThread, ClassType, msg_send,
    rc::Retained,
    runtime::{AnyClass, Imp, NSObjectProtocol, Sel},
    sel,
};
use objc2_app_kit::{NSApplication, NSWindow, NSWindowOcclusionState};
use objc2_core_foundation::{CFString, CFURL};
use objc2_core_graphics::CGImage;
use objc2_foundation::{MainThreadMarker, NSError};
use objc2_image_io::CGImageDestination;
use objc2_screen_capture_kit::{
    SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration,
};
use serde_json::{Value, json};

use crate::{AppInfo, MainWindow};

/// How many screenshots are underway. While any are, windows draw as if nothing covered them.
static CAPTURING: AtomicUsize = AtomicUsize::new(0);

/// GPUI's window classes, whose drawing follows `occlusionState`.
const WINDOW_CLASSES: [&std::ffi::CStr; 2] = [c"GPUIWindow", c"GPUIPanel"];

/// Saves a PNG of each of the app's open windows. With none open, it captures the main window,
/// opened just for this where nobody sees it. The reply lists each window's title and where its
/// image is, or why it couldn't be captured. Images replace the previous ones.
pub(crate) fn capture(app: AppInfo, cx: &mut App) -> Task<Result<Value, String>> {
    let hidden = open_windows().is_empty().then(|| open_hidden(cx)).flatten();
    let windows = open_windows();
    if windows.is_empty() {
        return Task::ready(Err(format!("{} has no windows to capture", app.name)));
    }
    keep_drawing_while_capturing();
    CAPTURING.fetch_add(1, Ordering::SeqCst);
    windows.iter().for_each(|window| recheck_visibility(window));
    for window in cx.windows() {
        window.update(cx, |_, window, _| window.refresh()).ok();
    }
    let targets: Vec<_> = windows
        .iter()
        .map(|window| (window.windowNumber() as u32, window.title().to_string()))
        .collect();
    let folder = std::env::temp_dir().join("plain-screenshots");
    let executor = cx.background_executor().clone();
    cx.spawn(async move |cx| {
        // Give windows that had stopped drawing time to draw a frame, and a window just opened
        // time to load what it shows.
        let settle = if hidden.is_some() { 1000 } else { 300 };
        executor.timer(Duration::from_millis(settle)).await;
        let shots = shoot_all(app, &targets, &folder);
        let timeout = executor.timer(Duration::from_secs(10));
        let outcome = match select(pin!(shots), timeout).await {
            Either::Left((shots, _)) => Ok(json!({ "screenshots": shots })),
            Either::Right(_) => Err("The screenshot took too long".to_string()),
        };
        CAPTURING.fetch_sub(1, Ordering::SeqCst);
        open_windows()
            .iter()
            .for_each(|window| recheck_visibility(window));
        if let Some(hidden) = hidden {
            cx.update(|cx| hidden.update(cx, |_, window, _| window.remove_window()))
                .ok();
        }
        outcome
    })
}

/// Opens the app's main window under the desktop picture, for capturing when no window is open.
/// It's moved there before it ever draws, so it never shows. Returns it, to close afterwards.
fn open_hidden(cx: &mut App) -> Option<AnyWindowHandle> {
    let open = cx.try_global::<MainWindow>()?.0.clone();
    let before = cx.windows();
    crate::presence::unseen(|| open(cx));
    for window in open_windows() {
        window.setLevel(i32::MIN as isize + 20);
    }
    cx.windows()
        .into_iter()
        .find(|window| !before.contains(window))
}

/// Captures each `(window number, title)` into `folder`.
async fn shoot_all(app: AppInfo, targets: &[(u32, String)], folder: &Path) -> Vec<Value> {
    if let Err(error) = std::fs::create_dir_all(folder) {
        return vec![json!({ "error": format!("Couldn't make {}: {error}", folder.display()) })];
    }
    let (sender, receiver) = mpsc::unbounded();
    for &(id, _) in targets {
        shoot(
            id,
            folder.join(format!("{}-{id}.png", app.id)),
            sender.clone(),
        );
    }
    let mut shots: Vec<(u32, Result<PathBuf, String>)> =
        receiver.take(targets.len()).collect().await;
    shots.sort_by_key(|(id, _)| targets.iter().position(|(target, _)| target == id));
    shots
        .into_iter()
        .zip(targets)
        .map(|((_, shot), (_, title))| match shot {
            Ok(path) => json!({ "window": title, "path": path }),
            Err(error) => json!({ "window": title, "error": error }),
        })
        .collect()
}

/// The app's windows that are open, though maybe covered or on another Space. Minimized ones
/// are left out, since there's nothing of them to capture.
fn open_windows() -> Vec<Retained<NSWindow>> {
    let Some(main_thread) = MainThreadMarker::new() else {
        return Vec::new();
    };
    let classes: Vec<_> = WINDOW_CLASSES
        .iter()
        .filter_map(|name| AnyClass::get(name))
        .collect();
    NSApplication::sharedApplication(main_thread)
        .windows()
        .iter()
        .filter(|window| {
            window.isVisible() && classes.iter().any(|class| window.isKindOfClass(class))
        })
        .collect()
}

/// Has GPUI's window classes report themselves visible while a screenshot is underway. GPUI
/// reads `occlusionState` to decide whether to keep drawing, so overriding it in those classes
/// leaves every other window alone.
fn keep_drawing_while_capturing() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        // SAFETY: `occlusion_state` has the signature of `-[NSWindow occlusionState]`, which
        // returns an NSUInteger ("Q") and takes no arguments besides self and the selector.
        let imp: Imp = unsafe {
            std::mem::transmute::<
                unsafe extern "C-unwind" fn(&NSWindow, Sel) -> NSWindowOcclusionState,
                Imp,
            >(occlusion_state)
        };
        for class in WINDOW_CLASSES.iter().filter_map(|name| AnyClass::get(name)) {
            unsafe {
                objc2::ffi::class_addMethod(
                    std::ptr::from_ref(class).cast_mut(),
                    sel!(occlusionState),
                    imp,
                    c"Q@:".as_ptr(),
                );
            }
        }
    });
}

/// GPUI windows' `occlusionState`: NSWindow's answer, plus visible while a screenshot is
/// underway.
unsafe extern "C-unwind" fn occlusion_state(window: &NSWindow, _: Sel) -> NSWindowOcclusionState {
    let state: NSWindowOcclusionState =
        unsafe { msg_send![super(window, NSWindow::class()), occlusionState] };
    if CAPTURING.load(Ordering::SeqCst) > 0 {
        state | NSWindowOcclusionState::Visible
    } else {
        state
    }
}

/// Has GPUI look at the window's visibility again, so it starts or stops drawing it.
fn recheck_visibility(window: &NSWindow) {
    let selector = sel!(windowDidChangeOcclusionState:);
    if window.respondsToSelector(selector) {
        // GPUI's handler ignores the notification, so none is passed.
        unsafe {
            let _: () = msg_send![window, windowDidChangeOcclusionState: Option::<&NSWindow>::None];
        }
    }
}

/// Captures the window numbered `id` into a PNG at `path`, then sends where it went, or why it
/// failed, to `done`. ScreenCaptureKit calls back on its own threads.
fn shoot(id: u32, path: PathBuf, done: mpsc::UnboundedSender<(u32, Result<PathBuf, String>)>) {
    let found = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            let fail = |message: String| {
                done.unbounded_send((id, Err(message))).ok();
            };
            let Some(content) = (unsafe { content.as_ref() }) else {
                return fail(describe(error));
            };
            let windows = unsafe { content.windows() };
            let Some(window) = windows
                .iter()
                .find(|window| unsafe { window.windowID() } == id)
            else {
                return fail("The window can't be captured right now".into());
            };
            let filter = unsafe {
                SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window)
            };
            let configuration = unsafe { SCStreamConfiguration::new() };
            let scale = f64::from(unsafe { filter.pointPixelScale() });
            let size = unsafe { filter.contentRect() }.size;
            unsafe {
                configuration.setWidth((size.width * scale).round() as usize);
                configuration.setHeight((size.height * scale).round() as usize);
                configuration.setShowsCursor(false);
                configuration.setIgnoreShadowsSingleWindow(true);
            }
            let (done, path) = (done.clone(), path.clone());
            let captured = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
                let shot = match unsafe { image.as_ref() } {
                    Some(image) => write_png(image, &path).map(|()| path.clone()),
                    None => Err(describe(error)),
                };
                done.unbounded_send((id, shot)).ok();
            });
            unsafe {
                SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
                    &filter,
                    &configuration,
                    Some(&captured),
                );
            }
        },
    );
    unsafe { SCShareableContent::getCurrentProcessShareableContentWithCompletionHandler(&found) };
}

fn write_png(image: &CGImage, path: &Path) -> Result<(), String> {
    let failed = || format!("Couldn't write {}", path.display());
    let url = CFURL::from_file_path(path).ok_or_else(failed)?;
    let png = CFString::from_static_str("public.png");
    let destination =
        unsafe { CGImageDestination::with_url(&url, &png, 1, None) }.ok_or_else(failed)?;
    unsafe { destination.add_image(image, None) };
    unsafe { destination.finalize() }
        .then_some(())
        .ok_or_else(failed)
}

fn describe(error: *mut NSError) -> String {
    unsafe { error.as_ref() }.map_or_else(
        || "The window couldn't be captured".into(),
        |error| error.localizedDescription().to_string(),
    )
}
