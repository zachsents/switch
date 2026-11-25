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
    /// ⌘2 to ⌘9: the space at that place among Home's (1 the first).
    Nth(usize),
    /// The keyboard to the rail's first row, or back to the box.
    Sidebar,
    /// The keyboard to the first control in the space's widgets, or back to the box.
    Widgets,
    /// ⌥⌘N: the palette, to name a new space.
    NewSpace,
    /// The system's file panel, its files to the box.
    Attach,
    /// The text a size bigger (1), smaller (-1), or as it comes (0).
    TextSize(i8),
    /// Light, or dark: the other of the one shown.
    Appearance,
    /// Done to a space: the one open (None), or the one right-clicked.
    Rename(Option<String>),
    Split(Option<String>),
    Archive(Option<String>),
    Unarchive(String),
    CopyLink(Option<String>),
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

/// Lists' keys, for the row with the keyboard: the rail's, a piece of work's steps.
#[derive(Clone, Debug, PartialEq, Default, gpui::Action)]
#[action(namespace = switch)]
pub struct NextRow;
#[derive(Clone, Debug, PartialEq, Default, gpui::Action)]
#[action(namespace = switch)]
pub struct PreviousRow;
/// An ask's Approve (or Done), on its row or in its window.
#[derive(Clone, Debug, PartialEq, Default, gpui::Action)]
#[action(namespace = switch)]
pub struct Approve;
/// An ask's Dismiss, on its row or in its window; on a running row, its Stop.
#[derive(Clone, Debug, PartialEq, Default, gpui::Action)]
#[action(namespace = switch)]
pub struct Dismiss;
/// A question's option, by its place (1 the first), in its window.
#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = switch, no_json)]
pub struct Choose(pub usize);
/// The chat's message picked from the keys: the one before or after it.
#[derive(Clone, Debug, PartialEq, Default, gpui::Action)]
#[action(namespace = switch)]
pub struct PickUp;
#[derive(Clone, Debug, PartialEq, Default, gpui::Action)]
#[action(namespace = switch)]
pub struct PickDown;
/// Done to the message picked.
#[derive(Clone, Debug, PartialEq, Default, gpui::Action)]
#[action(namespace = switch)]
pub struct ReplyPicked;
#[derive(Clone, Debug, PartialEq, Default, gpui::Action)]
#[action(namespace = switch)]
pub struct ReactPicked;
#[derive(Clone, Debug, PartialEq, Default, gpui::Action)]
#[action(namespace = switch)]
pub struct CopyPicked;
/// The message picked, whole, in its reading window (as its More).
#[derive(Clone, Debug, PartialEq, Default, gpui::Action)]
#[action(namespace = switch)]
pub struct ReadPicked;
/// Settings' next and previous section.
#[derive(Clone, Debug, PartialEq, Default, gpui::Action)]
#[action(namespace = switch)]
pub struct NextSection;
#[derive(Clone, Debug, PartialEq, Default, gpui::Action)]
#[action(namespace = switch)]
pub struct PreviousSection;

/// What a shortcut does: a command (the palette runs it too), another action (its binding made
/// for a key and a context), or a key a part takes itself (listed only).
pub enum Act {
    Do(Command),
    Action(fn(&'static str, Option<&'static str>) -> KeyBinding),
    Own,
}

macro_rules! act {
    ($a:expr) => {
        Act::Action(|k, c| KeyBinding::new(k, $a, c))
    };
}

/// A shortcut: its group and name in the sheet, its keys (gpui's; the first two shown), where they
/// hold, and what they do.
pub struct Shortcut {
    pub group: &'static str,
    pub label: &'static str,
    pub keys: Vec<&'static str>,
    pub context: Option<&'static str>,
    pub act: Act,
    /// Shown in the sheet with these keys instead: a range, or a key a part takes.
    pub shown: Option<&'static str>,
}

/// The one list: the window's keys, the ⇧⌘/ sheet, Settings' list and the palette's commands.
pub fn shortcuts() -> Vec<Shortcut> {
    fn s(group: &'static str, label: &'static str, keys: &[&'static str], context: Option<&'static str>, act: Act) -> Shortcut {
        Shortcut { group, label, keys: keys.to_vec(), context, act, shown: None }
    }
    fn own(group: &'static str, label: &'static str, shown: &'static str) -> Shortcut {
        Shortcut { group, label, keys: vec![], context: None, act: Act::Own, shown: Some(shown) }
    }
    fn c(group: &'static str, label: &'static str, keys: &[&'static str], cmd: Command) -> Shortcut {
        s(group, label, keys, None, Act::Do(cmd))
    }
    let mut out = vec![
        c("General", "Find", &["cmd-k"], Command::Find),
        c("General", "Composer", &[crate::platform::hotkey::KEY], Command::Compose),
        c("General", "Keyboard Shortcuts", &["cmd-?"], Command::Shortcuts),
        c("General", "Settings", &["cmd-,"], Command::Settings("general".into())),
        c("General", "Dictate", &["cmd-d"], Command::Dictate),
        c("General", "Bigger Text", &["cmd-=", "cmd-+"], Command::TextSize(1)),
        c("General", "Smaller Text", &["cmd--"], Command::TextSize(-1)),
        c("General", "Actual Size", &["cmd-0"], Command::TextSize(0)),
        c("General", "Light or Dark", &["cmd-alt-t"], Command::Appearance),
        own("General", "Close Window", "⌘W"),
        c("Go", "Home", &["cmd-shift-h", "cmd-1"], Command::Home),
        own("Go", "Spaces in Order", "⌘2–⌘9"),
        c("Go", "Previous Space", &["cmd-up"], Command::Previous),
        c("Go", "Next Space", &["cmd-down"], Command::Next),
        own("Go", "Enclosing Space", "Esc"),
        c("Go", "Back", &["cmd-["], Command::Back),
        c("Go", "Forward", &["cmd-]"], Command::Forward),
        c("Go", "Sidebar", &["cmd-j"], Command::Sidebar),
        c("Go", "Widgets", &["cmd-shift-j"], Command::Widgets),
        c("Go", "New Message", &["cmd-n"], Command::Message),
        s("Go", "To the Message Box", &["/"], Some("Switch && !TextField"), act!(crate::app::ToBox)),
        c("Go", "Chat", &["cmd-l"], Command::Chat),
        c("Space", "New Space", &["cmd-alt-n"], Command::NewSpace),
        c("Space", "Split Off", &["cmd-shift-n"], Command::Split(None)),
        c("Space", "Rename", &["cmd-r"], Command::Rename(None)),
        c("Space", "Copy Link", &["cmd-shift-c"], Command::CopyLink(None)),
        c("Space", "Archive", &["ctrl-cmd-a"], Command::Archive(None)),
        c("Space", "Find in Chat", &["cmd-f"], Command::FindIn),
        c("Space", "Attach Files", &["cmd-shift-a"], Command::Attach),
        c("Space", "Stop", &["cmd-."], Command::Stop),
        own("Messages", "Send", "↵"),
        own("Messages", "New Line", "⇧↵"),
        own("Messages", "Edit Last", "↑"),
        s("Messages", "Pick a Message", &["alt-up"], Some("Chat && !TextField"), act!(PickUp)),
        s("Messages", "Previous Message", &["up", "k", "alt-up"], Some("Picking && !TextField"), act!(PickUp)),
        s("Messages", "Next Message", &["down", "j", "alt-down"], Some("Picking && !TextField"), act!(PickDown)),
        s("Messages", "Reply", &["r", "enter"], Some("Picking && !TextField"), act!(ReplyPicked)),
        s("Messages", "React", &["t", "e"], Some("Picking && !TextField"), act!(ReactPicked)),
        s("Messages", "Copy", &["c", "cmd-c"], Some("Picking && !TextField"), act!(CopyPicked)),
        s("Messages", "Read Whole", &["space", "o"], Some("Picking && !TextField"), act!(ReadPicked)),
        s("Lists", "Previous Row", &["up", "k"], Some("Row"), act!(PreviousRow)),
        s("Lists", "Next Row", &["down", "j"], Some("Row"), act!(NextRow)),
        s("Lists", "Previous Row", &["k"], Some("Thread && !TextField"), act!(PreviousRow)),
        s("Lists", "Next Row", &["j"], Some("Thread && !TextField"), act!(NextRow)),
        own("Lists", "Open", "↵"),
        own("Lists", "Back to the Box", "Esc"),
        s("Asks", "Approve", &["cmd-enter"], Some("Rail"), act!(Approve)),
        s("Asks", "Dismiss", &["cmd-backspace"], Some("Rail"), act!(Dismiss)),
        s("Asks", "Approve", &["cmd-enter"], Some("AskWindow"), act!(Approve)),
        s("Asks", "Dismiss", &["cmd-backspace"], Some("AskWindow && !TextField"), act!(Dismiss)),
        s("Asks", "Approve", &["cmd-enter"], Some("AskCard"), act!(Approve)),
        s("Asks", "Dismiss", &["cmd-backspace"], Some("AskCard && !TextField"), act!(Dismiss)),
        own("Asks", "Choose an Option", "⌘1–⌘9"),
        s("Running", "Stop", &["cmd-backspace", "cmd-."], Some("Work"), act!(Dismiss)),
        s("Settings", "Next Section", &["ctrl-tab", "cmd-}"], Some("Settings"), act!(NextSection)),
        s("Settings", "Previous Section", &["ctrl-shift-tab", "cmd-{"], Some("Settings"), act!(PreviousSection)),
    ];
    // Each of Settings' sections, by its name, in the palette.
    for (key, label) in crate::settings::SECTIONS.into_iter().filter(|(k, _)| *k != "general") {
        out.push(Shortcut { group: "Settings", label, keys: vec![], context: None, act: Act::Do(Command::Settings(key.into())), shown: None });
    }
    out
}

/// A shortcut's keys as the Mac writes them: `cmd-shift-n` is ⇧⌘N.
pub fn keys_of(keys: &str) -> String {
    let parts: Vec<&str> = if let Some(m) = keys.strip_suffix("--") { m.split('-').chain(["-"]).collect() } else { keys.split('-').collect() };
    let (mods, key) = parts.split_at(parts.len() - 1);
    let mut shift = mods.contains(&"shift");
    let key = match key[0] {
        "?" | "}" | "{" => {
            shift = true;
            match key[0] {
                "?" => "/",
                "}" => "]",
                _ => "[",
            }
            .to_string()
        }
        "up" => "↑".into(),
        "down" => "↓".into(),
        "left" => "←".into(),
        "right" => "→".into(),
        "enter" => "↵".into(),
        "escape" => "Esc".into(),
        "backspace" => "⌫".into(),
        "tab" => "⇥".into(),
        "space" => "Space".into(),
        k => k.to_uppercase(),
    };
    let mut out = String::new();
    if mods.contains(&"ctrl") {
        out.push('⌃');
    }
    if mods.contains(&"alt") {
        out.push('⌥');
    }
    if shift {
        out.push('⇧');
    }
    if mods.contains(&"cmd") {
        out.push('⌘');
    }
    out + &key
}

/// A shortcut's keys as the sheet and the palette show them: the first two, each once.
pub fn shown_keys(s: &Shortcut) -> String {
    if let Some(k) = s.shown {
        return k.to_string();
    }
    let mut ks: Vec<String> = s.keys.iter().take(2).map(|k| keys_of(k)).collect();
    ks.dedup();
    ks.join("  ")
}

/// The sheet's lines, by group: a name once in its group, the first keys it's listed with.
pub fn sheet_lines() -> Vec<(&'static str, Vec<(&'static str, String)>)> {
    let mut out: Vec<(&'static str, Vec<(&'static str, String)>)> = vec![];
    for s in shortcuts() {
        let keys = shown_keys(&s);
        if keys.is_empty() {
            continue;
        }
        match out.iter_mut().find(|(g, _)| *g == s.group) {
            Some((_, lines)) => {
                if !lines.iter().any(|(l, _)| *l == s.label) {
                    lines.push((s.label, keys));
                }
            }
            None => out.push((s.group, vec![(s.label, keys)])),
        }
    }
    out
}

/// Every key the app binds: the list's; ⌘2 to ⌘9 the spaces in Home's order, and a question's
/// options in its window; and the parts' own (copying, selecting, closing, the menu bar's).
/// Later ones win where two hold at once.
pub fn bindings() -> Vec<KeyBinding> {
    use ui_sdk::native::text_field;
    let mut out = vec![
        // ⌘C copies what's selected in a chat (a message picked copies itself, below) or a thread.
        KeyBinding::new("cmd-c", crate::chat::CopySelection, Some("Chat && !Picking")),
        KeyBinding::new("cmd-a", text_field::SelectAll, Some("Chat && !TextField")),
        // ⌘. stops a thread's running turn.
        KeyBinding::new("cmd-.", crate::thread::StopTurn, Some("Thread")),
        KeyBinding::new("cmd-c", crate::thread::CopyThread, Some("Thread && !TextField")),
        KeyBinding::new("cmd-a", text_field::SelectAll, Some("Thread && !TextField")),
    ];
    for s in shortcuts() {
        for k in &s.keys {
            match &s.act {
                Act::Do(c) => out.push(KeyBinding::new(k, Do(c.clone()), s.context)),
                Act::Action(bind) => out.push(bind(k, s.context)),
                Act::Own => {}
            }
        }
    }
    const DIGITS: [&str; 9] = ["cmd-1", "cmd-2", "cmd-3", "cmd-4", "cmd-5", "cmd-6", "cmd-7", "cmd-8", "cmd-9"];
    for (i, k) in DIGITS.iter().enumerate() {
        if i > 0 {
            out.push(KeyBinding::new(k, Do(Command::Nth(i)), None));
        }
        out.push(KeyBinding::new(k, Choose(i + 1), Some("AskWindow")));
    }
    // In a field the caret would take ⌘↑ and ⌘↓: there they're still the spaces'.
    out.push(KeyBinding::new("cmd-up", Do(Command::Previous), Some("TextField")));
    out.push(KeyBinding::new("cmd-down", Do(Command::Next), Some("TextField")));
    out.push(KeyBinding::new("escape", Escape, Some("Switch")));
    out.extend([
        KeyBinding::new("escape", Escape, Some("Composer")),
        // Esc closes what floats (a select's list, a pick's, a confirm) before anything under it hears it.
        KeyBinding::new("escape", crate::kit::Dismiss, Some("KitFloat")),
        KeyBinding::new("cmd-c", crate::reading::CopyWords, Some("Reading")),
        KeyBinding::new("cmd-a", text_field::SelectAll, Some("Reading")),
        KeyBinding::new("escape", crate::platform::windows::CloseOne, Some("OneThing")),
        // A field's own edits, so the Edit menu shows their keys (in a field they're its own).
        KeyBinding::new("cmd-z", text_field::Undo, Some("TextField")),
        KeyBinding::new("cmd-shift-z", text_field::Redo, Some("TextField")),
        KeyBinding::new("cmd-x", text_field::Cut, Some("TextField")),
        KeyBinding::new("cmd-c", text_field::Copy, Some("TextField")),
        KeyBinding::new("cmd-v", text_field::Paste, Some("TextField")),
        KeyBinding::new("cmd-a", text_field::SelectAll, Some("TextField")),
        KeyBinding::new("cmd-h", crate::menu::Hide, None),
        KeyBinding::new("cmd-alt-h", crate::menu::HideOthers, None),
        KeyBinding::new("cmd-w", crate::menu::CloseWindow, None),
        KeyBinding::new("cmd-m", crate::menu::Minimize, None),
        KeyBinding::new("ctrl-cmd-f", crate::menu::FullScreen, None),
        KeyBinding::new("cmd-alt-shift-v", crate::menu::PasteAndMatchStyle, None),
        KeyBinding::new("cmd-q", crate::Quit, None),
    ]);
    out
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
                Nav::open(Page::Space(space), cx);
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
        Command::Nth(n) => {
            let top = model(cx).read(cx).derived.children.get(HOME).cloned().unwrap_or_default();
            if let Some(id) = top.get(n - 1) {
                Nav::open(Page::Space(id.clone()), cx);
            }
        }
        Command::Sidebar => window.dispatch_action(Box::new(crate::app::ToRail), cx),
        Command::Widgets => window.dispatch_action(Box::new(crate::app::ToWidgets), cx),
        Command::NewSpace => Shell::update(cx, |s| {
            s.finding = true;
            s.making = true;
        }),
        Command::Attach => {
            if !on_space {
                Nav::open(Page::Space(space), cx);
            }
            window.on_next_frame(|window, cx| window.dispatch_action(Box::new(crate::app::AttachFiles), cx));
        }
        Command::TextSize(by) => {
            use crate::theme::{Held, Size};
            let mut t = Held::theme(cx);
            t.size = match (by, t.size) {
                (0, _) => Size::Default,
                (1, Size::Small) => Size::Default,
                (1, _) => Size::Large,
                (_, Size::Large) => Size::Default,
                _ => Size::Small,
            };
            Held::set(t, cx);
        }
        Command::Appearance => {
            use crate::theme::{Appearance, Held};
            let mut t = Held::theme(cx);
            t.appearance = if crate::look::Look::get(cx).dark { Appearance::Light } else { Appearance::Dark };
            Held::set(t, cx);
        }
        Command::Rename(id) => {
            let id = id.clone().unwrap_or_else(|| space.clone());
            if id == HOME {
                return;
            }
            Nav::open(Page::Space(id.clone()), cx);
            Shell::start_rename(&id, cx);
        }
        Command::Split(id) => spaces::split(id.as_deref().unwrap_or(&space), cx),
        Command::Archive(id) => {
            let id = &id.clone().unwrap_or_else(|| space.clone());
            if id == HOME {
                return;
            }
            spaces::archive(id, true, cx);
            if *id == space {
                let parent = model(cx).read(cx).brain.spaces.get(id).and_then(|s| s.parent.clone()).unwrap_or_else(|| HOME.into());
                Nav::open(Page::Space(parent), cx);
            }
        }
        Command::Unarchive(id) => spaces::archive(id, false, cx),
        Command::Move(id, to) => spaces::move_to(id, to.as_deref(), cx),
        Command::CopyLink(id) => spaces::copy_link(id.as_deref().unwrap_or(&space), cx),
        Command::Link(url) => crate::links::when_ready(url.clone(), cx),
    }
}
