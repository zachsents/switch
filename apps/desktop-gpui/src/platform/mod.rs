//! What the desktop's bun process and native helpers did (apps/desktop/src/bun, src/native), in the
//! app: its life and windows, the menu bar, pairing (auth.rs), updates, files and Quick Look,
//! dictation, notifications, the desktop extension, reports, and what's this Mac's own. PORTING.md's
//! parity table says which file each came from.

// Much here is what the views call (files, dictation, windows of one thing, Connections' sign-in),
// some not yet ported.
#![allow(dead_code)]

pub mod appkit;
pub mod dictation;
pub mod extension;
pub mod files;
pub mod helpers;
pub mod hotkey;
pub mod idle;
pub mod lifecycle;
pub mod mesh;
pub mod notify;
pub mod oauth;
pub mod quicklook;
pub mod snapshot;
pub mod timing;
pub mod update;
pub mod watch;
pub mod windows;
pub mod words;

use gpui::{App, Application, Window};

/// Before the app runs: what macOS hands it as it launches (links, the Dock's reopen).
pub fn before_run(app: &Application) {
    // TLS (an https or wss core) through rustls with ring, the one provider in the app.
    let _ = rustls::crypto::ring::default_provider().install_default();
    // A panic from here on is a report, the main window or not.
    watch::hook();
    lifecycle::before_run(app);
}

/// As the app starts, before its window: the services every window shares.
pub fn start(cx: &mut App) {
    sweep_quiet_folders();
    crate::auth::keep_paired(cx.global::<crate::net::Net>().clone());
    dictation::init(cx);
    files::init(cx);
    windows::init(cx);
    notify::start(cx);
    lifecycle::start(cx);
    hotkey::start(cx);
}

/// The main window is open: the watch, updates and the desktop extension, which need it and the
/// brain.
pub fn opened(window: &mut Window, cx: &mut App) {
    lifecycle::opened(window, cx);
    watch::start(cx);
    update::start(cx);
    extension::start(cx);
}

/// A quiet copy's data folder lasts its run: those of copies no longer running are removed.
fn sweep_quiet_folders() {
    if !crate::outbox::quiet() {
        return;
    }
    let Some(base) = dirs::data_dir() else { return };
    let Ok(all) = std::fs::read_dir(&base) else { return };
    for d in all.flatten() {
        let name = d.file_name().to_string_lossy().to_string();
        let Some(pid) = name.strip_prefix("switch-gpui-quiet-").and_then(|p| p.parse::<i32>().ok()) else { continue };
        // SAFETY: kill with signal 0 only asks whether the process is there.
        let alive = unsafe { kill(pid, 0) } == 0;
        if !alive {
            let _ = std::fs::remove_dir_all(d.path());
        }
    }
}

unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}
