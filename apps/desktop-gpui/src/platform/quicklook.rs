//! Files in the Quick Look panel at the one numbered `at`, the arrow keys moving through them. One
//! helper (native/quicklook.swift) shows them all for as long as the app runs, with no Dock icon or
//! app switcher entry; a new look replaces what it shows. It exits when the app does: its stdin
//! closes.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{LazyLock, Mutex};

use serde_json::json;

use super::helpers::native_helper;

static HELPER: LazyLock<Mutex<Option<Child>>> = LazyLock::new(Default::default);

pub fn show(files: &[PathBuf], at: usize) -> Result<(), String> {
    let path = native_helper("switch-quicklook").ok_or("No Quick Look helper")?;
    let mut held = HELPER.lock().map_err(|e| e.to_string())?;
    let gone = held.as_mut().is_none_or(|c| !matches!(c.try_wait(), Ok(None)));
    if gone {
        *held = Some(Command::new(path).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?);
    }
    let child = held.as_mut().ok_or("No Quick Look helper")?;
    let stdin = child.stdin.as_mut().ok_or("No Quick Look helper")?;
    let line = json!({ "files": files.iter().map(|f| f.to_string_lossy()).collect::<Vec<_>>(), "at": at });
    writeln!(stdin, "{line}").and_then(|_| stdin.flush()).map_err(|e| e.to_string())
}
