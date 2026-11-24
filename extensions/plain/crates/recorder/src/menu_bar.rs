use std::time::Duration;

use futures::{StreamExt, channel::mpsc};
use gpui::{App, AppContext, Context, Entity, Global, Task};
use kit::Icon;
use tray_icon::{
    Icon as TrayImage, TrayIcon, TrayIconBuilder,
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
};

use crate::{actions::ToggleRecording, recorder::Recorder, transcript};

/// The menu bar item. It shows how long the recording has run while recording, and its menu
/// starts and stops recording with the window closed.
pub struct MenuBar {
    recorder: Entity<Recorder>,
    tray: TrayIcon,
    toggle: MenuItem,
    /// Whether it's showing a recording, so the icon only changes when that does.
    recording: bool,
    /// Refreshes the time each second. Only exists while recording.
    ticker: Option<Task<()>>,
}

struct MenuBarHandle {
    _menu_bar: Entity<MenuBar>,
}

impl Global for MenuBarHandle {}

/// Adds the menu bar item and keeps it for the life of the app.
pub fn install(recorder: Entity<Recorder>, cx: &mut App) {
    let menu_bar = cx.new(|cx| MenuBar::new(recorder, cx));
    cx.set_global(MenuBarHandle {
        _menu_bar: menu_bar,
    });
}

/// 36px is the 18pt menu bar icon at 2x.
fn tray_image(icon: Icon) -> TrayImage {
    TrayImage::from_rgba(icon.rgba(36), 36, 36).expect("icon is 36x36 RGBA")
}

impl MenuBar {
    fn new(recorder: Entity<Recorder>, cx: &mut Context<Self>) -> Self {
        let toggle = MenuItem::with_id("toggle", "Start Recording", true, None);
        let menu = Menu::new();
        menu.append_items(&[
            &toggle,
            &MenuItem::with_id("show", "Show Recorder", true, None),
            &PredefinedMenuItem::separator(),
            &MenuItem::with_id("quit", "Quit Recorder", true, None),
        ])
        .expect("menu accepts items");
        // A template icon is tinted to match the menu bar.
        let tray = TrayIconBuilder::new()
            .with_icon_templated(tray_image(Icon::Record))
            .with_menu(Box::new(menu))
            .build()
            .expect("failed to create the menu bar item");

        cx.observe(&recorder, |this, _, cx| this.sync(cx)).detach();

        // Menu clicks arrive on another thread; they're handled on the main thread.
        let (sender, mut receiver) = mpsc::unbounded();
        MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
            sender.unbounded_send(event.id.0).ok();
        }));
        cx.spawn(async move |_, cx| {
            while let Some(id) = receiver.next().await {
                cx.update(|cx| match id.as_str() {
                    "toggle" => cx.dispatch_action(&ToggleRecording),
                    "show" => kit::show_main_window(cx),
                    "quit" => cx.quit(),
                    _ => {}
                });
            }
        })
        .detach();

        let mut menu_bar = Self {
            recorder,
            tray,
            toggle,
            recording: false,
            ticker: None,
        };
        menu_bar.sync(cx);
        menu_bar
    }

    fn sync(&mut self, cx: &mut Context<Self>) {
        let recorder = self.recorder.read(cx);
        let recording = recorder.active().is_some();
        self.toggle.set_enabled(recorder.is_idle() || recording);
        self.toggle.set_text(if recording {
            "Stop Recording"
        } else {
            "Start Recording"
        });
        if recording != self.recording {
            self.recording = recording;
            let icon = if recording {
                Icon::Recording
            } else {
                Icon::Record
            };
            self.tray.set_icon_templated(Some(tray_image(icon))).ok();
        }
        self.refresh(cx);
        if !recording {
            self.ticker = None;
        } else if self.ticker.is_none() {
            self.ticker = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_secs(1)).await;
                    if this.update(cx, |this, cx| this.refresh(cx)).is_err() {
                        break;
                    }
                }
            }));
        }
    }

    /// Shows the recording's length beside the icon while recording.
    fn refresh(&self, cx: &App) {
        let elapsed = self
            .recorder
            .read(cx)
            .active()
            .map(|active| transcript::timestamp(active.started.elapsed().as_secs_f64()));
        self.tray.set_title(elapsed);
    }
}
