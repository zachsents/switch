//! The shared kit every app in the suite is built on: theme, type scale, icons, controls, the
//! app shell, saved state and agent access. Apps compose these pieces; they don't style raw
//! elements or talk to agents themselves.

mod agent;
mod button;
mod grid;
mod icon;
mod input;
mod keys;
mod overlay;
mod presence;
mod present;
mod row;
mod screenshot;
mod scrollbar;
mod selectable;
mod sound;
mod storage;
mod text_field;
mod theme;
mod tick;
mod time_input;

use std::{borrow::Cow, path::PathBuf, rc::Rc, sync::Arc, time::Instant};

use futures::{StreamExt, channel::mpsc};

use gpui::{
    App, AppContext, AssetSource, Bounds, Context, Div, FontFeatures, Global, InteractiveElement,
    KeyBinding, Menu, MenuItem, ParentElement, Pixels, Render, Result, SharedString, Size, Styled,
    TitlebarOptions, Window, WindowBounds, WindowHandle, WindowOptions, WindowingRequest, actions,
    deferred, div, px,
};
use rust_embed::RustEmbed;
use url::Url;

pub use agent::{
    Announcer, EventSource, LiveFrame, Occurrence, Surface, announce, announcer, changed, emit,
    event_source, finish_before_replying, handle, image_content, live, live_uri, reject, reply_with,
    report_state, svg_icon, widget,
};
pub use button::{Button, ButtonVariant, Segmented};
pub use grid::{Grid, GridCell};
pub use icon::{Icon, icon};
pub use input::{Input, InputEvent};
pub use overlay::{Tipped, WithTooltip, reveal_shortcut, tipped, tooltip};
pub use present::{from_agent, present};
pub use row::row;
pub use scrollbar::{Scrollbar, Scrolls, scrollbar};
pub use selectable::SelectableText;
pub use sound::Sound;
pub use storage::{data_dir, load, save};
pub use text_field::{TEXT_FIELD_CONTEXT, TextField, TextFieldEvent};

/// The actions text fields and inputs answer to, for an app's Edit menu and for hosts that
/// handle one first (`capture_action`), like a message box that takes pasted images.
pub mod editing {
    pub use crate::text_field::{
        Backspace, Cancel, Confirm, Copy, Cut, Delete, DeleteToHome, DeleteWordLeft,
        DeleteWordRight, End, Home, Left, Newline, Paste, Redo, Right, SelectAll, SelectEnd,
        SelectHome, SelectLeft, SelectRight, SelectTextEnd, SelectTextStart, SelectWordLeft,
        SelectWordRight, ShowCharacterPalette, TextEnd, TextStart, Undo, WordLeft, WordRight,
    };
}
pub use theme::{ActiveTheme, ButtonColors, Theme, text};
pub use tick::Tick;
pub use time_input::{TimeInput, local_clock_time};

actions!(kit, [Quit, Hide, CloseWindow]);

/// Height of the native macOS titlebar. Windows draw their own strip of this height at the top,
/// under the transparent system titlebar, which still handles dragging and double-click zoom.
pub const TITLEBAR_HEIGHT: Pixels = px(28.);

/// The kit's own assets: its icons. An app with assets of its own looks here for what it
/// doesn't have.
#[derive(RustEmbed)]
#[folder = "assets"]
pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Ok(Self::get(path).map(|file| file.data))
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        Ok(Self::iter()
            .filter(|file| file.starts_with(path))
            .map(|file| SharedString::from(file.into_owned()))
            .collect())
    }
}

/// Opens the app's main window. Set by the app, used when it is reopened from the Dock.
pub(crate) struct MainWindow(pub(crate) Rc<dyn Fn(&mut App)>);

impl Global for MainWindow {}

/// Identifies an app in the suite. `id` is the namespace of its actions and names its data
/// folder; `name` is what people see.
#[derive(Clone, Copy)]
pub struct AppInfo {
    pub id: &'static str,
    pub name: &'static str,
}

impl Global for AppInfo {}

/// Every app's entry point. Launches the app with the kit's assets, theme, standard shortcuts
/// (⌘Q, ⌘H, ⌘W) and agent access, then opens its main window.
///
/// - `<app> mcp` runs the app's MCP server on stdin and stdout instead. With `--http <address>`
///   (and optionally `--path <path>`, `/mcp` by default) it serves it over Streamable HTTP.
/// - `<app> screenshot` has the running app save PNGs of its windows and prints where.
/// - `<app> --background` starts without opening a window.
/// - Launching a second copy brings the running one to the front and exits.
/// - Files people open in the app go to the handler set with [`on_open_files`]. When the app is
///   launched to open files, that takes the place of opening its main window.
pub fn main(app: AppInfo, on_launch: impl FnOnce(&mut App) + 'static) {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    if arguments.first().is_some_and(|argument| argument == "mcp") {
        let option = |name: &str| {
            arguments
                .iter()
                .position(|argument| argument == name)
                .and_then(|index| arguments.get(index + 1))
        };
        return match option("--http") {
            Some(address) => agent::serve_http(
                app,
                address,
                option("--path").map_or("/mcp", String::as_str),
            ),
            None => agent::serve_stdio(app),
        };
    }
    if arguments
        .first()
        .is_some_and(|argument| argument == "screenshot")
    {
        return agent::print_screenshot(app);
    }
    if agent::show_running_instance(app) {
        return;
    }
    let background = arguments.iter().any(|argument| argument == "--background");

    let application = gpui_platform::application().with_assets(Assets);
    // Started for an agent, the app stays out of the Dock and switcher from the first moment.
    let application = if background {
        application.with_windowing(WindowingRequest::Headless)
    } else {
        application
    };
    application.on_reopen(show_main_window);
    // macOS can hand over files before the app has finished launching, so they wait here until
    // its handler is set.
    let (opened, mut to_open) = mpsc::unbounded();
    application.on_open_urls(move |urls| {
        opened.unbounded_send(urls).ok();
    });
    application.run(move |cx| {
        cx.set_global(app);
        presence::start(background, cx);
        init(cx);
        cx.on_action(|_: &Quit, cx| quit(cx));
        cx.on_action(|_: &Hide, cx| cx.hide());
        cx.on_action(|_: &CloseWindow, cx| {
            if let Some(window) = cx.active_window() {
                window
                    .update(cx, |_, window, _| window.remove_window())
                    .ok();
            }
        });
        cx.bind_keys([
            KeyBinding::new("cmd-q", Quit, None),
            KeyBinding::new("cmd-h", Hide, None),
            KeyBinding::new("cmd-w", CloseWindow, None),
        ]);
        on_launch(cx);
        agent::listen(app, cx);
        // Files a launch was for arrive before this runs.
        let mut launched_with_files = false;
        while let Ok(urls) = to_open.try_recv() {
            open_files(&urls, cx);
            launched_with_files = true;
        }
        if !background && !launched_with_files {
            show_main_window(cx);
        }
        cx.spawn(async move |cx| {
            while let Some(urls) = to_open.next().await {
                cx.update(|cx| open_files(&urls, cx));
            }
        })
        .detach();
    });
}

/// Readies the kit in an app that runs its own `Application`, with windows, menus and a
/// lifecycle of its own, instead of [`main`]: the theme matching the system appearance (unless
/// the app set one), the text editing keys, buttons that show their shortcut's press, and the
/// tooltips and revealed shortcuts each window's [`root`] draws. [`main`] calls it itself.
pub fn init(cx: &mut App) {
    if cx.try_global::<Theme>().is_none() {
        Theme::init(cx);
    }
    follow_shortcuts(cx);
    text_field::bind_keys(cx);
    // Outside a text field, ⌘C copies what's selected on the page (see `SelectableText`).
    cx.bind_keys([KeyBinding::new("cmd-c", text_field::Copy, None)]);
}

/// What the app does with files people open in it.
struct OpenFiles(Rc<OpenHandler>);

type OpenHandler = dyn Fn(Vec<PathBuf>, &mut App);

impl Global for OpenFiles {}

/// Sets what the app does with files people open in it: from Finder's Open With menu, by
/// dropping them on its Dock icon, or with `open -a`. The handler shows them, bringing a window
/// forward. Which files Finder offers the app for is set by `opens` in its
/// `[package.metadata.bundle]`.
pub fn on_open_files(cx: &mut App, open: impl Fn(Vec<PathBuf>, &mut App) + 'static) {
    cx.set_global(OpenFiles(Rc::new(open)));
}

/// Hands the files macOS asked the app to open to its handler, or shows the main window if it
/// has none.
fn open_files(urls: &[String], cx: &mut App) {
    presence::opened_by_person(cx);
    let paths: Vec<_> = urls
        .iter()
        .filter_map(|url| Url::parse(url).ok()?.to_file_path().ok())
        .collect();
    match cx.try_global::<OpenFiles>() {
        Some(OpenFiles(open)) if !paths.is_empty() => open.clone()(paths, cx),
        _ => show_main_window(cx),
    }
}

/// Decides whether quitting goes ahead.
struct QuitGuard(Rc<dyn Fn(&mut App) -> bool>);

impl Global for QuitGuard {}

/// Sets what runs when someone quits. Returning false keeps the app open, for example to ask
/// about unsaved work first; the app then quits with `cx.quit()` once it's settled.
pub fn on_quit(cx: &mut App, guard: impl Fn(&mut App) -> bool + 'static) {
    cx.set_global(QuitGuard(Rc::new(guard)));
}

fn quit(cx: &mut App) {
    let proceed = match cx.try_global::<QuitGuard>() {
        Some(QuitGuard(guard)) => guard.clone()(cx),
        None => true,
    };
    if proceed {
        cx.quit();
    }
}

/// Registers how to open the app's main window.
pub fn set_main_window(cx: &mut App, open: impl Fn(&mut App) + 'static) {
    cx.set_global(MainWindow(Rc::new(open)));
}

/// Brings an existing window to the front, or opens the main window if none is open.
pub fn show_main_window(cx: &mut App) {
    presence::opened_by_person(cx);
    match cx.windows().first() {
        Some(window) => {
            window
                .update(cx, |_, window, _| window.activate_window())
                .ok();
        }
        None => {
            if let Some(MainWindow(open)) = cx.try_global::<MainWindow>() {
                open.clone()(cx);
            }
        }
    }
    cx.activate(true);
}

/// Sets the menu bar, prepending the standard app menu.
pub fn set_menus(cx: &mut App, app_name: &str, menus: impl IntoIterator<Item = Menu>) {
    cx.set_menus(
        [Menu::new(app_name.to_string()).items([
            MenuItem::action(format!("Hide {app_name}"), Hide),
            MenuItem::separator(),
            MenuItem::action(format!("Quit {app_name}"), Quit),
        ])]
        .into_iter()
        .chain(menus),
    );
}

/// Opens a centered window with a transparent titlebar, no smaller than `size`. The theme follows
/// the system appearance.
pub fn open_window<V: Render>(
    cx: &mut App,
    title: &str,
    size: Size<Pixels>,
    build: impl FnOnce(&mut Window, &mut Context<V>) -> V,
) -> WindowHandle<V> {
    open_window_with(
        cx,
        WindowSetup {
            title,
            size,
            min_size: size,
            focus: true,
        },
        build,
    )
}

/// How a window opens.
pub struct WindowSetup<'a> {
    pub title: &'a str,
    pub size: Size<Pixels>,
    pub min_size: Size<Pixels>,
    /// Whether it comes to the front and takes the keyboard. Windows opened for agents don't,
    /// so they never interrupt typing.
    pub focus: bool,
}

/// Opens a window with a transparent titlebar. A window opened while others are open sits a
/// little below and to the right of the front one, the way document windows cascade.
pub fn open_window_with<V: Render>(
    cx: &mut App,
    setup: WindowSetup,
    build: impl FnOnce(&mut Window, &mut Context<V>) -> V,
) -> WindowHandle<V> {
    let front = cx
        .window_stack()
        .and_then(|stack| stack.into_iter().next())
        .or_else(|| cx.windows().into_iter().next())
        .and_then(|window| window.update(cx, |_, window, _| window.bounds()).ok());
    let bounds = match front {
        Some(front) => Bounds::new(front.origin + gpui::point(px(24.), px(24.)), setup.size),
        None => Bounds::centered(None, setup.size, cx),
    };
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        window_min_size: Some(setup.min_size),
        focus: setup.focus,
        titlebar: Some(TitlebarOptions {
            title: Some(setup.title.to_string().into()),
            appears_transparent: true,
            ..Default::default()
        }),
        ..Default::default()
    };
    presence::window_opening(cx);
    cx.open_window(options, |window, cx| {
        window
            .observe_window_appearance(|window, cx| {
                cx.set_global(Theme::for_appearance(window.appearance()));
                window.refresh();
            })
            .detach();
        cx.new(|cx| build(window, cx))
    })
    .expect("failed to open window")
}

/// The root element for a window: fills it and applies the base background, text color and font.
/// It also draws the kit's tooltips and, while ⌘ is held, the shortcuts of controls that don't
/// show their own, and copies what's selected on the page with ⌘C.
pub fn root(cx: &App) -> Div {
    let theme = cx.theme();
    layer(
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(theme.background)
            .text_color(theme.text)
            .text_size(text::BODY)
            .font_family(text::FONT),
    )
}

/// What [`root`] adds to a window's root element, for a window that styles its own (a panel with
/// rounded corners on a clear window, say): the tooltips, revealed shortcuts and ⌘C for what's
/// selected on the page.
pub fn layer(root: Div) -> Div {
    root.on_modifiers_changed(overlay::modifiers_changed)
        .on_action(|_: &text_field::Copy, window, cx| {
            if !selectable::copy_selection(window, cx) {
                cx.propagate();
            }
        })
        .child(deferred(overlay::Overlay).with_priority(1))
}

/// The strip at the top of a window or pane that sits under the system titlebar. It can only
/// hold static content like a title, since the system titlebar receives the clicks.
pub fn titlebar() -> Div {
    div().h(TITLEBAR_HEIGHT).flex_none().flex().items_center()
}

pub trait StyledExt: Styled + Sized {
    /// Fixed-width digits, so changing numbers don't shift the layout.
    fn tabular_nums(self) -> Self {
        self.font_features(FontFeatures(Arc::new(vec![("tnum".into(), 1)])))
    }
}

impl<T: Styled> StyledExt for T {}

/// When a shortcut triggers an action, briefly shows the buttons for that action as pressed. Any
/// key pressed also hides shortcuts that holding ⌘ revealed.
fn follow_shortcuts(cx: &mut App) {
    cx.observe_keystrokes(|event, window, cx| {
        overlay::key_pressed(window, cx);
        let Some(action) = &event.action else {
            return;
        };
        cx.set_global(button::KeyPress {
            action: action.name(),
            at: Instant::now(),
        });
        window.refresh();
        let window = window.window_handle();
        cx.spawn(async move |cx| {
            cx.background_executor()
                .timer(button::KEY_PRESS_DURATION)
                .await;
            window.update(cx, |_, window, _| window.refresh()).ok();
        })
        .detach();
    })
    .detach();
}
