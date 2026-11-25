//! What the chat asks of this Mac, in one place: a file's Open, Quick Look, Show in Finder,
//! Download and right-click menu (`use-menu.ts`'s `fileAction`), and a long reply
//! in a reading window of its own (`rpc.send.read`). The platform does the work (platform/files.rs,
//! platform/windows.rs).

use gpui::{App, Window};

pub use crate::platform::files::Do;

/// A chat's file: where it's served (a core route like `/blobs/…`, or an address) and its name.
/// Answers whether it was done.
pub fn file(url: &str, name: &str, what: Do, window: &mut Window, cx: &mut App) -> gpui::Task<bool> {
    crate::platform::files::file(crate::platform::files::FileAsk { url: url.to_string(), name: name.to_string(), r#do: what }, window, cx)
}

/// A long reply's words, whole, in a window of its own under the space's name.
pub fn read(title: &str, text: &str, cx: &mut App) {
    crate::platform::windows::open_reading(title, text, cx);
}
