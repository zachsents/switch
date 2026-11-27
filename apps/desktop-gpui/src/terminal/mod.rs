//! Terminals: a shell on this Mac drawn natively (Alacritty's emulator, as Zed's terminal uses it),
//! pinned in a space's widget column or in a window of its own, typed into by the user and by the
//! agent (the desktop extension's `terminal_*` tools), its screen read back as words.
//!
//! A pinned one is a placement of `desktop-<mac>/terminal` (`place_widget`, or Add Terminal on a
//! space): the Mac in its name is where its shell runs, so another Mac's column doesn't draw it.
//! Its input is how it starts (`cwd`, `command`, `rows`). Each placement or window is its own
//! shell, by its id: the placement's id, or `window:<n>`.

pub mod colors;
pub mod keys;
pub mod session;
pub mod view;
pub mod window;

use std::collections::HashSet;
use std::sync::LazyLock;

use gpui::{App, AppContext, Entity, Global, KeyBinding};
use indexmap::IndexMap;
use serde_json::{Value, json};

use crate::items::Placed;
use crate::model::model;
use session::{Session, Start};
use view::TerminalView;

/// The widget a pinned terminal is a placement of.
pub const NAME: &str = "terminal";

/// This Mac, as its desktop extension is named.
pub fn mac() -> &'static str {
    static MAC: LazyLock<String> = LazyLock::new(crate::auth::machine_name);
    &MAC
}

/// The app a terminal on this Mac is placed as: this Mac's desktop extension.
pub fn app() -> String {
    format!("desktop-{}", mac())
}

/// Whether a placement is a terminal (on any Mac).
pub fn is_terminal(p: &Placed) -> bool {
    p.name == NAME && p.app.starts_with("desktop-")
}

/// Whether a placement is a terminal whose shell runs here.
pub fn is_here(p: &Placed) -> bool {
    is_terminal(p) && p.app == app()
}

#[derive(Default)]
pub struct Terminals {
    pub sessions: IndexMap<String, Entity<Session>>,
    views: IndexMap<String, Entity<TerminalView>>,
    /// Pinned ones open in a window: their column cell steps aside.
    pub windowed: HashSet<String>,
    opened: u32,
}
impl Global for Terminals {}

/// Something done to a terminal from its right-click menu.
#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    Copy,
    Paste,
    Clear,
    Window,
    Remove,
}

#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = switch, no_json)]
pub struct TerminalDo(pub String, pub Op);

pub fn init(cx: &mut App) {
    cx.set_global(Terminals::default());
    cx.bind_keys(bindings());
    cx.on_action(|a: &TerminalDo, cx| act_on(&a.0, &a.1, cx));
}

/// The keys a terminal keeps while it has the keyboard: Esc is the program's (vim's, a TUI's),
/// ⌘Esc leaves; ⌘C, ⌘V and ⌘A are the terminal's own. Every other ⌘ key is the app's.
fn bindings() -> Vec<KeyBinding> {
    use ui_sdk::native::text_field;
    vec![
        KeyBinding::new("escape", view::Key("escape".into()), Some("Terminal")),
        KeyBinding::new("shift-escape", view::Key("shift-escape".into()), Some("Terminal")),
        KeyBinding::new("alt-escape", view::Key("alt-escape".into()), Some("Terminal")),
        KeyBinding::new("tab", view::Key("tab".into()), Some("Terminal")),
        KeyBinding::new("shift-tab", view::Key("shift-tab".into()), Some("Terminal")),
        KeyBinding::new("cmd-escape", view::Leave, Some("Terminal")),
        KeyBinding::new("cmd-c", text_field::Copy, Some("Terminal")),
        KeyBinding::new("cmd-v", text_field::Paste, Some("Terminal")),
        KeyBinding::new("cmd-a", text_field::SelectAll, Some("Terminal")),
    ]
}

pub fn session(id: &str, cx: &App) -> Option<Entity<Session>> {
    cx.global::<Terminals>().sessions.get(id).cloned()
}

fn begin(id: String, start: Start, cx: &mut App) -> Entity<Session> {
    let s = session::start(id.clone(), start, cx);
    cx.global_mut::<Terminals>().sessions.insert(id, s.clone());
    emit_opened(s.read(cx), cx);
    s
}

/// A terminal's view, made (and its shell started) the first time it's asked for.
pub fn view_of(id: &str, start: impl FnOnce() -> Start, cx: &mut App) -> Entity<TerminalView> {
    if let Some(v) = cx.global::<Terminals>().views.get(id).cloned() {
        return v;
    }
    let s = match session(id, cx) {
        Some(s) => s,
        None => begin(id.to_string(), start(), cx),
    };
    let v = cx.new(|cx| TerminalView::new(s, cx));
    cx.global_mut::<Terminals>().views.insert(id.to_string(), v.clone());
    v
}

/// How a placement starts: its input's folder, command and height.
pub fn start_of(p: &Placed) -> Start {
    let s = |k: &str| p.input.as_ref().and_then(|i| i.get(k)).and_then(Value::as_str).map(str::to_string);
    Start { cwd: s("cwd").map(|c| session::folder(&c)), command: s("command"), space: Some(p.space.clone()) }
}

/// A pinned terminal's rows: its input's, else 18.
pub fn rows_of(p: &Placed) -> usize {
    p.input.as_ref().and_then(|i| i.get("rows")).and_then(Value::as_u64).map_or(18, |r| r.clamp(4, 80) as usize)
}

/// A terminal in a window of its own, its shell started; its id.
pub fn open(start: Start, cx: &mut App) -> String {
    let t = cx.global_mut::<Terminals>();
    t.opened += 1;
    let id = format!("window:{}", t.opened);
    begin(id.clone(), start, cx);
    window::open(id.clone(), cx);
    id
}

/// A terminal pinned in a space (this Mac's), its shell started; its id, the placement's.
pub fn pin(space: &str, start: Start, rows: Option<usize>, cx: &mut App) -> String {
    let short = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
    let app = app();
    let id = format!("{app}/{NAME}#{short}");
    let mut input = serde_json::Map::new();
    if let Some(c) = &start.cwd {
        input.insert("cwd".into(), json!(c.display().to_string()));
    }
    if let Some(c) = &start.command {
        input.insert("command".into(), json!(c));
    }
    if let Some(r) = rows {
        input.insert("rows".into(), json!(r));
    }
    // First in the column, where it's seen.
    let payload = json!({ "app": app, "name": NAME, "id": id, "space": space, "index": 0, "input": input });
    let start = Start { space: Some(space.to_string()), ..start };
    view_of(&id, || start, cx);
    // Shown at once, as the brain will have it.
    model(cx).update(cx, |m, cx| {
        crate::items::fold_placed(&mut m.brain.placed, "widget.placed", &payload);
        let _ = m.command("widget.place", payload, cx);
        cx.notify();
    });
    id
}

/// Ends a terminal: its shell, its window, its placement.
pub fn close(id: &str, cx: &mut App) {
    let t = cx.global_mut::<Terminals>();
    let s = t.sessions.shift_remove(id);
    t.views.shift_remove(id);
    t.windowed.remove(id);
    if let Some(s) = s {
        s.update(cx, |s, _| s.close());
    }
    window::close(id, cx);
    let placed = model(cx).read(cx).brain.placed.iter().find(|p| p.id == id).cloned();
    if let Some(p) = placed {
        let payload = json!({ "app": p.app, "name": p.name, "id": p.id });
        model(cx).update(cx, |m, cx| {
            crate::items::fold_placed(&mut m.brain.placed, "widget.removed", &payload);
            let _ = m.command("widget.remove", payload, cx);
            cx.notify();
        });
    }
}

pub fn act_on(id: &str, op: &Op, cx: &mut App) {
    let Some(s) = session(id, cx) else { return };
    match op {
        Op::Copy => {
            if let Some(text) = s.read(cx).term.lock().selection_to_string() {
                cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
            }
        }
        Op::Paste => {
            if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
                s.update(cx, |s, _| {
                    let bytes = keys::paste(&text, s.mode());
                    s.typed(bytes);
                });
            }
        }
        Op::Clear => {
            s.update(cx, |s, cx| {
                s.term.lock().grid_mut().clear_history();
                // ⌃L: the shell draws its prompt again at the top.
                s.typed(vec![0x0c]);
                cx.notify();
            });
        }
        Op::Window => {
            cx.global_mut::<Terminals>().windowed.insert(id.to_string());
            window::open(id.to_string(), cx);
            model(cx).update(cx, |_, cx| cx.notify());
        }
        Op::Remove => close(id, cx),
    }
}

/// The terminals on this Mac, as the agent's list has them.
pub fn list(cx: &App) -> Vec<Value> {
    cx.global::<Terminals>().sessions.values().map(|s| s.read(cx).about()).collect()
}

pub fn emit_opened(s: &Session, _cx: &App) {
    let data = json!({ "id": s.id, "mac": mac(), "cwd": s.start.cwd.as_ref().map(|p| p.display().to_string()), "command": s.start.command, "space": s.start.space });
    crate::platform::extension::emit("terminal.opened", data);
}

pub fn emit_exited(s: &Session, _cx: &App) {
    let data = json!({ "id": s.id, "mac": mac(), "code": s.exited, "space": s.start.space });
    crate::platform::extension::emit("terminal.exited", data);
}
