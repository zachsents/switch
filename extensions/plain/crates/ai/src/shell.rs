//! The user's login shell environment. Apps opened from Finder don't inherit it, but that's where
//! people keep their API keys, so it's read once, the way editors like Zed and VS Code do.

use std::{
    collections::HashMap,
    io::Read,
    os::unix::process::CommandExt,
    process::{Command, Stdio},
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};

/// How long a slow shell profile gets before giving up on it.
const PATIENCE: Duration = Duration::from_secs(5);
/// Around the environment dump, so anything the profile prints is skipped.
const MARKER: &str = "\u{0}__PLAIN_ENVIRONMENT__\u{0}";

/// The value of `name` in the login shell, if it's one of `wanted`. The shell is only started
/// the first time, which can take a few seconds, so call this off the main thread.
pub(crate) fn variable(name: &str, wanted: &[&str]) -> Option<String> {
    static ENVIRONMENT: OnceLock<HashMap<String, String>> = OnceLock::new();
    ENVIRONMENT
        .get_or_init(|| capture(wanted).unwrap_or_default())
        .get(name)
        .cloned()
}

/// Runs the login shell once, non-interactively, and keeps only the `wanted` variables. Nothing
/// it prints is logged, since it holds secrets.
fn capture(wanted: &[&str]) -> Option<HashMap<String, String>> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let script = format!(
        "printf '{marker}'; /usr/bin/env -0; printf '{marker}'",
        marker = MARKER.replace('\u{0}', "\\0")
    );
    let mut child = Command::new(shell)
        .args(["-l", "-c", &script])
        .env("PLAIN_RESOLVING_ENVIRONMENT", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = thread::spawn(move || {
        let mut output = Vec::new();
        stdout.read_to_end(&mut output).map(|_| output)
    });
    let started = Instant::now();
    // The shell's exit code doesn't matter: profiles often end with a failing command.
    while child.try_wait().ok()?.is_none() {
        if started.elapsed() > PATIENCE {
            child.kill().ok();
            child.wait().ok();
            return None;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let output = String::from_utf8(reader.join().ok()?.ok()?).ok()?;
    let dump = output.split(MARKER).nth(1)?;
    Some(
        dump.split('\u{0}')
            .filter_map(|entry| entry.split_once('='))
            .filter(|(name, _)| wanted.contains(name))
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect(),
    )
}
