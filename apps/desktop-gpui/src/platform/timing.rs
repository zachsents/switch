//! How long a window takes to open, in the desktop log (the desktop's `bun/timing.ts`): from the ask
//! to open it to its first frame on screen.

use std::io::Write;
use std::time::Instant;

use super::helpers::{home, quiet};

fn log(line: &str) {
    let dir = home().join("Library/Logs/switch");
    // A test copy beside the live app ($SWITCH_QUIET) keeps its own.
    let file = dir.join(if quiet() { "desktop-test.log" } else { "desktop.log" });
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
        let _ = writeln!(f, "{} {line}", chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ"));
    }
}

/// One open of `kind`, timed from `start`, logged at its first frame: gpui draws a window whole on
/// its first frame, so it's seen and painted at once.
pub fn opened(kind: &str, start: Instant, window: &mut gpui::Window) {
    let kind = kind.to_string();
    window.on_next_frame(move |_, _| {
        let ms = start.elapsed().as_millis();
        log(&format!("open {kind}: shown {ms}ms, painted {ms}ms"));
    });
}
