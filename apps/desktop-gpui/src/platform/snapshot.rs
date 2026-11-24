//! The window's own picture (native/snapshot.m): gpui's frame rendered again off screen, with the
//! web views and the window's buttons drawn over it. Drawn by the app, never read off the screen, so
//! it asks for no Screen Recording; and it works with the window behind others.

use std::ffi::{CString, c_char, c_void};

use base64::Engine;
use gpui::{App, Task};
use objc2::rc::Retained;
use tokio::sync::oneshot;

unsafe extern "C" {
    fn switch_window_snapshot(window: *mut c_void, rgba: *const u8, width: i32, height: i32, path: *const c_char, done: extern "C" fn(i32, *mut c_void), context: *mut c_void);
}

extern "C" fn done(status: i32, context: *mut c_void) {
    // SAFETY: the sender boxed for this call, handed back once.
    let tx = unsafe { Box::from_raw(context.cast::<oneshot::Sender<i32>>()) };
    let _ = tx.send(status);
}

/// A JPEG of the main window, base64.
pub fn window_shot(cx: &mut App) -> Task<Result<String, String>> {
    let Some(main) = super::lifecycle::main_window(cx) else { return Task::ready(Err("No Switch window".into())) };
    let file = std::env::temp_dir().join(format!("switch-window-{}.jpg", uuid::Uuid::new_v4()));
    let path = CString::new(file.to_string_lossy().as_bytes()).unwrap_or_default();
    let asked = main.update(cx, |_, window, _| {
        let image = window.render_to_image().map_err(|_| "Can't draw the window".to_string())?;
        let ns: Retained<_> = super::appkit::ns_window(window).ok_or("No Switch window")?;
        let (tx, rx) = oneshot::channel::<i32>();
        let context = Box::into_raw(Box::new(tx)).cast::<c_void>();
        // SAFETY: the window is this process's and alive; the pixels are copied before this returns;
        // `done` takes the context back once, on the main thread.
        unsafe { switch_window_snapshot(Retained::as_ptr(&ns) as *mut c_void, image.as_raw().as_ptr(), image.width() as i32, image.height() as i32, path.as_ptr(), done, context) };
        Ok::<_, String>(rx)
    });
    let rx = match asked {
        Ok(Ok(rx)) => rx,
        Ok(Err(e)) => return Task::ready(Err(e)),
        Err(_) => return Task::ready(Err("No Switch window".into())),
    };
    cx.background_executor().spawn(async move {
        match rx.await {
            Ok(1) => {
                let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(&file);
                Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
            }
            _ => Err("Can't draw the window".into()),
        }
    })
}
