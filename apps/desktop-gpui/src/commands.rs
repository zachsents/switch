//! What the window can be told to do, from a shortcut, the palette, the menu bar or a right-click
//! (the desktop's `shared/commands.ts`, `ui/use-commands.ts` and `ui/use-shortcuts.ts`): one list,
//! so each does the same thing however it's asked. `Do(command)` is the one action; the menu bar and
//! the key bindings carry it.

use gpui::{App, KeyBinding, Window};
use serde_json::json;

use crate::brain::HOME;
use crate::model::model;
use crate::nav::{Nav, Page};
use crate::shell::Shell;
use crate::spaces;

#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    /// ⌘K.
    Find,
    /// ⌘/: the composer, from anywhere (`platform/hotkey.rs`).
    Compose,
    /// ⌘F's bar on the space's chat.
    FindIn,
    /// To the message box, on the space's page.
    Message,
    /// ⌘L: the menu's Chat, the same as New Message.
    Chat,
    Home,
    /// The enclosing space; from a thread, back.
    Up,
    Next,
    Previous,
    Back,
    Forward,
    Connections,
    Shortcuts,
    Memory,
    System,
    Dictate,
    /// Stops the running turn: the thread open's, else the space's own.
    Stop,
    Space(String),
    /// Done to a space: the one open (None), or the one right-clicked.
    Rename(String),
    Split(Option<String>),
    Archive(String),
    Unarchive(String),
    CopyLink(String),
    /// `to` None is the top level.
    Move(String, Option<String>),
    /// Settings, open at one of its sections.
    Settings(String),
    /// A `switchboard://` link opened.
    Link(String),
}

/// The one action every command rides on.
#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = switch, no_json)]
pub struct Do(pub Command);

/// An action item opened in a window of its own (the asks' window answers it).
#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = switch, no_json)]
pub struct OpenItem(pub String);

/// Escape: up a space, unless something of its own takes it.
#[derive(Clone, Debug, PartialEq, Default, gpui::Action)]
#[action(namespace = switch)]
pub struct Escape;

/// Every shortcut, as the ⇧⌘/ sheet and Settings list them.
pub const SHORTCUTS: [(&str, &str); 19] = [
    ("Find", "⌘K"),
    ("Composer", "⌘/"),
    ("Find in Chat", "⌘F"),
    ("New Message", "⌘N"),
    ("Chat", "⌘L"),
    ("To the Message Box", "/"),
    ("Send", "↵"),
    ("New Line", "⇧↵"),
    ("Dictate", "⌘D"),
    ("Go Home", "⇧⌘H"),
    ("Previous Space", "⌘↑"),
    ("Next Space", "⌘↓"),
    ("Enclosing Space", "Esc"),
    ("Back", "⌘["),
    ("Forward", "⌘]"),
    ("Split Off", "⇧⌘N"),
    ("Settings", "⌘,"),
    ("Close Window", "⌘W"),
    ("Keyboard Shortcuts", "⇧⌘/"),
];

/// The window's keys. ⌘↑ and ⌘↓ hold in a field too (the box's caret doesn't take them).
pub fn bindings() -> Vec<KeyBinding> {
    let k = |keys: &'static str, c: Command| KeyBinding::new(keys, Do(c), None);
    vec![
        k("cmd-k", Command::Find),
        k("cmd-f", Command::FindIn),
        k("cmd-[", Command::Back),
        k("cmd-]", Command::Forward),
        k("cmd-shift-h", Command::Home),
        k("cmd-up", Command::Previous),
        k("cmd-down", Command::Next),
        k("cmd-n", Command::Message),
        k("cmd-l", Command::Chat),
        k("cmd-shift-n", Command::Split(None)),
        k(crate::platform::hotkey::KEY, Command::Compose),
        k("cmd-?", Command::Shortcuts),
        k("cmd-.", Command::Stop),
        k("cmd-d", Command::Dictate),
        k("cmd-,", Command::Settings("general".into())),
        // In a field the caret would take ⌘↑ and ⌘↓: there they're still the spaces'.
        KeyBinding::new("cmd-up", Do(Command::Previous), Some("TextField")),
        KeyBinding::new("cmd-down", Do(Command::Next), Some("TextField")),
        KeyBinding::new("escape", Escape, Some("Switch")),
    ]
}

/// The space the window is in: a thread's space, or the space open (an archived one too); one not
/// yet known is Home, once the log has said so.
pub fn here(cx: &App) -> String {
    let page = Nav::entity(cx).read(cx).page.clone();
    let b = &model(cx).read(cx).brain;
    let at = page.space().to_string();
    if b.spaces.contains_key(&at) || !b.ready { at } else { HOME.into() }
}

/// Every live space as the boards nest them: Home, then each space and the spaces in it.
fn in_order(cx: &App) -> Vec<String> {
    let d = &model(cx).read(cx).derived;
    let mut out: Vec<String> = vec![];
    fn walk(id: &str, d: &crate::derive::Derived, out: &mut Vec<String>) {
        if out.iter().any(|x| x == id) {
            return;
        }
        out.push(id.to_string());
        for c in d.children.get(id).cloned().unwrap_or_default() {
            walk(&c, d, out);
        }
    }
    walk(HOME, d, &mut out);
    out
}

/// The space `by` places from the one open, in the boards' order, wrapping round.
fn step(by: isize, cx: &mut App) {
    let order = in_order(cx);
    let space = here(cx);
    let at = order.iter().position(|x| *x == space).map(|i| i as isize).unwrap_or(-1);
    let n = order.len() as isize;
    if n == 0 {
        return;
    }
    let to = order[((at + by + n) % n) as usize].clone();
    Nav::open(Page::Space(to), cx);
}

/// The running turn to stop: the thread open's, else the space's own.
fn running(cx: &App) -> Option<String> {
    let page = Nav::entity(cx).read(cx).page.clone();
    let b = &model(cx).read(cx).brain;
    let id = match &page {
        Page::Thread(t, _) => t.clone(),
        Page::Space(_) => format!("space:{}", here(cx)),
    };
    b.threads.get(&id).filter(|t| t.status == crate::brain::Status::Running).map(|t| t.id.clone())
}

pub fn run(c: &Command, window: &mut Window, cx: &mut App) {
    let page = Nav::entity(cx).read(cx).page.clone();
    let space = here(cx);
    let on_space = matches!(page, Page::Space(_));
    match c {
        Command::Find => Shell::update(cx, |s| s.finding = !s.finding),
        Command::Compose => crate::composer::toggle(None, cx),
        Command::FindIn => {
            if !on_space {
                Nav::open(Page::Space(space.clone()), cx);
            }
            // Each ⌘F puts the cursor in the bar (its autoFocus as it opens, focusFind once open).
            Shell::update(cx, |s| {
                s.searching_in = Some(space.clone());
                s.find_focus += 1;
            });
        }
        Command::Message | Command::Chat => {
            if !on_space {
                Nav::open(Page::Space(space), cx);
            }
            // On the next frame: a space just opened has drawn its box by then.
            window.on_next_frame(|window, cx| window.dispatch_action(Box::new(crate::app::ToBox), cx));
        }
        Command::Home => Nav::open(Page::Space(HOME.into()), cx),
        Command::Up => {
            if !on_space {
                Nav::back(cx);
            } else if space != HOME {
                let parent = model(cx).read(cx).brain.spaces.get(&space).and_then(|s| s.parent.clone()).unwrap_or_else(|| HOME.into());
                Nav::open(Page::Space(parent), cx);
            }
        }
        Command::Next => step(1, cx),
        Command::Previous => step(-1, cx),
        Command::Back => Nav::back(cx),
        Command::Forward => Nav::forward(cx),
        Command::Connections => crate::settings::open("connections", cx),
        Command::Memory => crate::settings::open("memory", cx),
        Command::System => crate::settings::open("system", cx),
        Command::Settings(section) => crate::settings::open(section, cx),
        Command::Shortcuts => Shell::update(cx, |s| s.shortcuts = !s.shortcuts),
        // Dictation answers it where it listens (`Do(Command::Dictate)` as a global action).
        Command::Dictate => {}
        Command::Stop => {
            if let Some(thread) = running(cx) {
                let _ = model(cx).update(cx, |m, cx| m.command("thread.stop", json!({ "thread": thread }), cx));
            }
        }
        Command::Space(id) => Nav::open(Page::Space(id.clone()), cx),
        Command::Rename(id) => {
            Nav::open(Page::Space(id.clone()), cx);
            Shell::start_rename(id, cx);
        }
        Command::Split(id) => spaces::split(id.as_deref().unwrap_or(&space), cx),
        Command::Archive(id) => {
            spaces::archive(id, true, cx);
            if *id == space {
                let parent = model(cx).read(cx).brain.spaces.get(id).and_then(|s| s.parent.clone()).unwrap_or_else(|| HOME.into());
                Nav::open(Page::Space(parent), cx);
            }
        }
        Command::Unarchive(id) => spaces::archive(id, false, cx),
        Command::Move(id, to) => spaces::move_to(id, to.as_deref(), cx),
        Command::CopyLink(id) => spaces::copy_link(id, cx),
        Command::Link(url) => crate::links::when_ready(url.clone(), cx),
    }
}
