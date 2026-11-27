//! An ask's command in a terminal on this Mac: a Ghostty window in its folder with the command
//! typed, waiting for the user's ↵, through this Mac's ghostty extension (`ghostty-<machine>`'s
//! `open`). It's typed rather than run: the agent wrote it and it runs as the user, so their ↵ is
//! the go-ahead, after reading it. Where that extension isn't, Terminal opens it here, the same way.

use std::path::Path;
use std::sync::LazyLock;

use gpui::{App, Task};
use serde_json::{Value, json};

use crate::items::Command;
use crate::model::model;

/// The control's name, from the shared command list.
pub const SHORTCUT: &str = "Open in Terminal";

/// Whether Ghostty is installed on this Mac: the button says where the command opens.
static GHOSTTY: LazyLock<bool> = LazyLock::new(|| {
    let home = std::env::var("HOME").unwrap_or_default();
    ["/Applications/Ghostty.app".to_string(), format!("{home}/Applications/Ghostty.app")].iter().any(|p| Path::new(p).exists())
});

/// What the button says.
pub fn label() -> &'static str {
    if *GHOSTTY { "Open in Ghostty" } else { "Open in Terminal" }
}

/// Opens it; an error is what went wrong.
pub fn open(command: &Command, cx: &mut App) -> Task<Result<(), String>> {
    let mut args = json!({ "command": command.run, "place": "window" });
    if let Some(cwd) = &command.cwd {
        args["cwd"] = Value::String(cwd.clone());
    }
    let app = format!("ghostty-{}", crate::auth::machine_name());
    let call = model(cx).update(cx, |m, cx| m.call_checked(&app, "open", args, cx));
    let command = command.clone();
    cx.background_executor().spawn(async move {
        match call.await {
            Ok(_) => Ok(()),
            // No extension here (or no core): Terminal, from here.
            Err(e) if e.starts_with("No app ") || e == "Can't reach the core" => in_terminal(&command),
            Err(e) => Err(e),
        }
    })
}

/// A value as one single-quoted word for zsh.
fn quoted(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The script Terminal runs (the extension's `terminal.ts`): it removes itself, clears the window,
/// goes to the folder and puts the command at a prompt to edit; ↵ runs it, and a login shell stays.
fn script(command: &Command) -> String {
    let mut lines = vec!["#!/bin/zsh".to_string(), r#"rm -f -- "$0"; rmdir -- "$0:h" 2>/dev/null; print -n "\e[H\e[2J\e[3J""#.to_string()];
    if let Some(cwd) = command.cwd.as_deref().filter(|c| !c.is_empty()) {
        let to = match cwd.strip_prefix('~') {
            Some(rest) if rest.is_empty() || rest.starts_with('/') => format!(r#""$HOME"{}"#, quoted(rest)),
            _ => quoted(cwd),
        };
        lines.push(format!("cd -- {to} || exit 1"));
    }
    lines.push(format!("cmd={}", quoted(&command.run)));
    lines.push(r#"vared -p "%~ %# " cmd || exec "$SHELL" -l"#.to_string());
    lines.push(r#"eval "$cmd""#.to_string());
    lines.push(r#"exec "$SHELL" -l"#.to_string());
    lines.join("\n") + "\n"
}

fn in_terminal(command: &Command) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("switch-command-{}-{at}", std::process::id()));
    std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("Switch.command");
    std::fs::write(&file, script(command)).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    let out = std::process::Command::new("/usr/bin/open").args(["-a", "Terminal"]).arg(&file).output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err("Terminal didn't open".into()) }
}
