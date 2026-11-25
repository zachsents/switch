//! What a hot patch never replaces. `sh scripts/dev.sh` runs the app hot-reloading (UI SDK for
//! gpui's, on Subsecond): a saved change rebuilds the app crate and patches it into the running
//! app, and each patch brings its own copy of every `static` and thread-local the app crate
//! defines, starting from its initial value. So what has to last lives here, in a crate a patch
//! only calls into: the app's Objective-C classes (a class is registered once, and its ivars are
//! found through statics), and the app's state (`kept!`, `kept_local!`). A change to this crate
//! is a rebuild, not a patch.

pub mod color_panel;
mod kept;
pub mod native_menu;
pub mod notify;
pub mod webview;

pub use kept::{Kept, KeptLocal};
