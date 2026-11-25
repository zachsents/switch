//! Switch's desktop app in Rust, on gpui and UI SDK for gpui: a demo slice of the Electrobun
//! app (apps/desktop), reading the same core the same way. PORTING.md says what's in it and what
//! the full port still takes.

use base::{color_panel, native_menu, webview};

mod a2ui;
mod app;
mod asks;
mod smooth;
mod said;
mod reading;
mod remend;
mod quiet;
mod chat_platform;
mod attached;
mod auth;
mod band;
mod boundary;
mod brain;
mod chat;
mod checks;
mod chat_marks;
mod chatbox;
mod commands;
mod composer;
mod cutover;
mod derive;
mod files;
mod find;
mod follow;
mod items;
mod json;
mod kit;
mod links;
mod local;
mod look;
mod markdown;
mod math;
mod marks;
mod menu;
mod media;
mod model;
mod mutations;
mod model3d;
mod nav;
mod net;
mod outbox;
mod own;
mod palette;
mod pictures;
mod platform;
mod queries;
mod rail;
mod replying;
mod select;
mod settings;
mod shell;
mod shortcuts;
#[cfg(feature = "shot")]
mod shot;
mod spaces;
mod step_icons;
mod tapback;
mod steps;
mod theme;
mod thread;
mod time;
mod track;
mod viewer;
mod widgets;

use std::time::Instant;

use gpui::{App, AppContext, TitlebarOptions, WindowBounds, WindowOptions, point, px, size};

use crate::look::Look;
use crate::marks::Assets;
use crate::net::Net;

gpui::actions!(switch_app, [Quit]);

fn main() {
    let started = Instant::now();
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();
    let application = gpui_platform::application().with_assets(Assets);
    platform::before_run(&application);
    // `switchboard://` links the app is opened with, or sent while it runs.
    let (links_tx, mut links_rx) = futures::channel::mpsc::unbounded::<String>();
    application.on_open_urls(move |urls| {
        for u in urls {
            let _ = links_tx.unbounded_send(u);
        }
    });
    application.run(move |cx: &mut App| {
        ui_sdk::init("switch-gpui", cx);
        if let Ok(path) = std::env::var("SWITCH_GPUI_MODEL") {
            model3d::measure(path, cx);
            return;
        }
        let (tx, rx) = futures::channel::mpsc::unbounded();
        cx.set_global(Net::start(tx));
        theme::Held::init(cx);
        cx.set_global(Look::of(&theme::Held::theme(cx), true));
        pictures::Pictures::init(cx);
        own::sweep();
        queries::init(cx);
        nav::Nav::init(cx);
        nav::Beat::init(cx);
        shell::Shell::init(cx);
        model::new_model(rx, started, cx);
        track::init(cx);
        widgets::host::Host::init(cx);
        cx.bind_keys(commands::bindings());
        cx.on_action(|_: &Quit, cx| cx.quit());
        menu::init(cx);
        cx.set_menus(menu::build(&menu::model_of(cx)));
        cx.spawn(async move |cx| {
            use futures::StreamExt;
            while let Some(url) = links_rx.next().await {
                // The window comes back for it, and the link opens once the brain is read.
                cx.update(|cx| {
                    platform::lifecycle::show_main(cx);
                    links::when_ready(url, cx)
                });
            }
        })
        .detach();
        // Video tiles and a sound for files or addresses, to look at them alone.
        if let Ok(src) = std::env::var("SWITCH_GPUI_MEDIA") {
            media::LookAt::open(src, cx);
            cx.activate(true);
            return;
        }
        platform::start(cx);
        // The reading window registers with the platform's windows, so after them.
        reading::init(cx);
        let bounds = platform::lifecycle::first_frame(cx);
        let window = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some("Switchboard".into()),
                    appears_transparent: true,
                    traffic_light_position: Some(point(px(10.), px(8.))),
                }),
                window_min_size: Some(size(px(200.), px(200.))),
                ..Default::default()
            },
            |window, cx| {
                let dark = matches!(window.appearance(), gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark);
                cx.set_global(Look::of(&theme::Held::theme(cx), dark));
                platform::opened(window, cx);
                cx.new(|cx| app::Root::new(window, cx))
            },
        )
        .expect("window");
        #[cfg(feature = "shot")]
        shot::start(window.into(), cx);
        #[cfg(feature = "shot")]
        shot::tour(window.into(), cx);
        #[cfg(feature = "shot")]
        widgets::charts::gallery::shot(cx);
        #[cfg(feature = "shot")]
        widgets::basic::gallery::shot(cx);
        #[cfg(feature = "shot")]
        shot::wheel(window.into(), cx);
        #[cfg(feature = "shot")]
        shot::film(window.into(), cx);
        let _ = window;
        cx.activate(true);
    });
}
