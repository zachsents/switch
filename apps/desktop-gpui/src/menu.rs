//! The menu bar (the desktop's `bun/menu.ts`): every command the window answers, with its shortcut,
//! run as a shortcut or the palette would. The spaces it lists follow the brain, and a space's
//! right-click menu is the same items, drawn natively at the pointer (`native_menu.rs`).

use gpui::{App, Menu, MenuItem, OsAction, Window, actions};
use ui_sdk::native::text_field;

use crate::brain::HOME;
use crate::commands::{Command, Do, here};
use crate::model::model;
use crate::spaces::{SpaceMenu, space_menu_of, warmest};

actions!(switch_menu, [About, Hide, HideOthers, ShowAll, CloseWindow, Minimize, Zoom, FullScreen, BringAllToFront, PasteAndMatchStyle, DeleteSelection]);

/// What the menu bar lists that changes: every space, the ones inside the space open, and it.
#[derive(Clone, PartialEq)]
pub struct MenuModel {
    pub spaces: Vec<(String, String)>,
    pub inside: Vec<(String, String)>,
    /// Home's spaces in its order, the first eight: ⌘2 to ⌘9.
    pub top: Vec<String>,
    pub here: SpaceMenu,
    /// The window in front is full screen: the View menu offers to exit it.
    pub full: bool,
}

pub fn model_of(cx: &App) -> MenuModel {
    let at = here(cx);
    let m = model(cx).read(cx);
    let b = &m.brain;
    let name = |id: &String| b.spaces.get(id).map(|s| s.name.clone()).unwrap_or_default();
    MenuModel {
        spaces: warmest(b).into_iter().map(|x| (x.id.clone(), x.name.clone())).collect(),
        inside: m.derived.children.get(&at).cloned().unwrap_or_default().iter().map(|id| (id.clone(), name(id))).collect(),
        top: m.derived.children.get(HOME).cloned().unwrap_or_default().iter().take(8).map(name).collect(),
        here: space_menu_of(b, &at),
        full: crate::platform::lifecycle::full_screen(cx),
    }
}

fn item(label: &str, c: Command) -> MenuItem {
    MenuItem::action(label.to_string(), Do(c))
}

/// What can be done to a space, in its right-click menu and the Space menu.
pub fn space_items(m: &SpaceMenu) -> Vec<MenuItem> {
    let copy = item("Copy Link", Command::CopyLink(Some(m.id.clone())));
    let split = item("Split Off", Command::Split(Some(m.id.clone())));
    if m.home {
        return vec![split, copy];
    }
    let mut to = vec![item("Top Level", Command::Move(m.id.clone(), None))];
    if !m.move_to.is_empty() {
        to.push(MenuItem::separator());
    }
    to.extend(m.move_to.iter().map(|(id, name)| item(name, Command::Move(m.id.clone(), Some(id.clone())))));
    vec![
        item("Rename…", Command::Rename(Some(m.id.clone()))),
        split,
        item("Add Terminal", Command::PinTerminal(Some(m.id.clone()))),
        MenuItem::submenu(Menu { name: "Move To".into(), items: to, disabled: false }),
        copy,
        MenuItem::separator(),
        if m.archived { item("Unarchive", Command::Unarchive(m.id.clone())) } else { item("Archive", Command::Archive(Some(m.id.clone()))) },
    ]
}

fn menu(name: &str, items: Vec<MenuItem>) -> Menu {
    Menu { name: name.to_string().into(), items, disabled: false }
}

pub fn build(model: &MenuModel) -> Vec<Menu> {
    // The app's own items carry its name, as macOS's roles do.
    let app = crate::platform::appkit::app_name();
    // The Space menu's items are the one open's, on their keys.
    let mut here = space_items(&model.here);
    for i in &mut here {
        if let MenuItem::Action { name, action, .. } = i {
            let open = match name.as_ref() {
                "Split Off" => Some(Command::Split(None)),
                "Rename…" => Some(Command::Rename(None)),
                "Copy Link" => Some(Command::CopyLink(None)),
                "Archive" => Some(Command::Archive(None)),
                "Add Terminal" => Some(Command::PinTerminal(None)),
                _ => None,
            };
            if let Some(c) = open {
                *action = Box::new(Do(c));
            }
        }
    }
    let mut space = vec![item("Stop", Command::Stop), item("Attach Files…", Command::Attach), MenuItem::separator()];
    space.extend(here);
    space.extend([MenuItem::separator(), item("Connections", Command::Connections), item("Memory", Command::Memory)]);
    if !model.inside.is_empty() {
        space.push(MenuItem::separator());
    }
    space.extend(model.inside.iter().map(|(id, name)| item(name, Command::Space(id.clone()))));
    vec![
        menu(
            "Switch",
            vec![
                MenuItem::action(format!("About {app}"), About),
                MenuItem::separator(),
                item("Settings…", Command::Settings("general".into())),
                MenuItem::separator(),
                MenuItem::action(format!("Hide {app}"), Hide),
                MenuItem::action("Hide Others", HideOthers),
                MenuItem::action("Show All", ShowAll),
                MenuItem::separator(),
                MenuItem::action(format!("Quit {app}"), crate::Quit),
            ],
        ),
        menu("File", vec![item("New Message", Command::Message), item("Chat", Command::Chat), item("New Space…", Command::NewSpace), item("New Terminal", Command::Terminal), MenuItem::separator(), MenuItem::action("Close Window", CloseWindow)]),
        menu(
            "Edit",
            vec![
                MenuItem::os_action("Undo", text_field::Undo, OsAction::Undo),
                MenuItem::os_action("Redo", text_field::Redo, OsAction::Redo),
                MenuItem::separator(),
                MenuItem::os_action("Cut", text_field::Cut, OsAction::Cut),
                MenuItem::os_action("Copy", text_field::Copy, OsAction::Copy),
                MenuItem::os_action("Paste", text_field::Paste, OsAction::Paste),
                MenuItem::action("Paste and Match Style", PasteAndMatchStyle),
                MenuItem::action("Delete", DeleteSelection),
                MenuItem::os_action("Select All", text_field::SelectAll, OsAction::SelectAll),
                MenuItem::separator(),
                item("Dictate", Command::Dictate),
                item("Find in Chat", Command::FindIn),
            ],
        ),
        menu(
            "View",
            vec![
                item("Find…", Command::Find),
                item("Composer", Command::Compose),
                item("Sidebar", Command::Sidebar),
                MenuItem::separator(),
                item("Actual Size", Command::TextSize(0)),
                item("Bigger Text", Command::TextSize(1)),
                item("Smaller Text", Command::TextSize(-1)),
                item("Light or Dark", Command::Appearance),
                MenuItem::separator(),
                MenuItem::action("Zoom", Zoom),
                MenuItem::action(if model.full { "Exit Full Screen" } else { "Enter Full Screen" }, FullScreen),
            ],
        ),
        menu(
            "Go",
            vec![
                item("Back", Command::Back),
                item("Forward", Command::Forward),
                MenuItem::separator(),
                item("Home", Command::Home),
                item("Enclosing Space", Command::Up),
                item("Previous Space", Command::Previous),
                item("Next Space", Command::Next),
                MenuItem::separator(),
            ]
            .into_iter()
            .chain(model.top.iter().enumerate().map(|(i, name)| item(name, Command::Nth(i + 1))))
            .chain([
                MenuItem::separator(),
                MenuItem::submenu(menu("Spaces", model.spaces.iter().map(|(id, name)| item(if id == HOME { "Home" } else { name }, Command::Space(id.clone()))).collect())),
            ])
            .collect(),
        ),
        menu("Space", space),
        menu("Window", vec![MenuItem::action("Minimize", Minimize), MenuItem::action("Zoom", Zoom), MenuItem::separator(), MenuItem::action("Bring All to Front", BringAllToFront)]),
        menu("Help", vec![item("Keyboard Shortcuts", Command::Shortcuts)]),
    ]
}

/// The app's own roles, and their keys.
pub fn init(cx: &mut App) {
    cx.on_action(|_: &About, _| crate::native_menu::about());
    // An action item's link, or one a connection returned: its window.
    cx.on_action(|a: &crate::commands::OpenItem, cx| crate::asks::window::open(&a.0, cx));
    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    cx.on_action(|_: &BringAllToFront, _| crate::platform::appkit::bring_all_to_front());
    // A field pastes plain text anyway; Delete takes the selection in the field with focus.
    cx.on_action(|_: &PasteAndMatchStyle, cx| {
        if let Some(w) = cx.active_window() {
            // After this dispatch, which may be the window's own.
            cx.defer(move |cx| {
                let _ = w.update(cx, |_, window, cx| window.dispatch_action(Box::new(text_field::Paste), cx));
            });
        }
    });
    cx.on_action(|_: &DeleteSelection, cx| {
        if let Some(w) = cx.active_window() {
            cx.defer(move |cx| {
                let _ = w.update(cx, |_, window, cx| {
                    if window.context_stack().iter().any(|c| c.contains(text_field::KEY_CONTEXT))
                        && let Ok(k) = gpui::Keystroke::parse("backspace")
                    {
                        window.dispatch_keystroke(k, cx);
                    }
                });
            });
        }
    });
}

/// The window's roles: each window answers them for itself. Closing the main window hides it, and
/// the app keeps running (the Dock or a link brings it back); another window closes.
pub fn window_roles<E: gpui::InteractiveElement>(el: E, main: bool) -> E {
    el.on_action(move |_: &CloseWindow, window: &mut Window, cx: &mut App| if main { crate::platform::lifecycle::close(window, cx) } else { window.remove_window() })
        .on_action(|_: &Minimize, window: &mut Window, _| window.minimize_window())
        .on_action(|_: &Zoom, window: &mut Window, _| window.zoom_window())
        .on_action(|_: &FullScreen, window: &mut Window, _| window.toggle_fullscreen())
}

/// Draws the menu bar again when what it lists changed.
pub fn refresh(was: &mut Option<MenuModel>, cx: &mut App) {
    let now = model_of(cx);
    if was.as_ref() != Some(&now) {
        cx.set_menus(build(&now));
        *was = Some(now);
    }
}
