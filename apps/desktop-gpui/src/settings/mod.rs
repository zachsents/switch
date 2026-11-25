//! Settings, a window of its own (the desktop's `ui/settings/settings-window.tsx`): its sections
//! down the left, the one open beside it. ⌘, (or a section asked for from the app) brings it forward
//! at that section; Esc and ⌘W close it.

mod accounts;
mod act;
mod calls;
pub mod connection_actions;
mod connections;
mod devices;
mod extensions;
mod general;
mod memory;
mod notifications;
pub(crate) mod parts;
mod profiles;
mod providers;
mod qr;
mod role_choices;
mod spaces;
mod system;
mod theme;

use gpui::{
    AnyElement, App, AppContext, Bounds, Context, ElementId, FocusHandle, Focusable, FontWeight, Global, InteractiveElement, IntoElement,
    KeyDownEvent, ParentElement, Render, StatefulInteractiveElement, Styled, TitlebarOptions, Window, WindowBounds,
    WindowHandle, WindowOptions, div, point, prelude::*, px, size,
};

pub use general::{UpdateNow, Updates};

use crate::kit::{self, Btn};
use crate::look::{Look, SANS, SIGN, u};
use crate::model::model;
use crate::nav::Beat;

pub const SECTIONS: [(&str, &str); 11] = [
    ("general", "General"),
    ("providers", "Providers"),
    ("profiles", "Profiles"),
    ("theme", "Theme"),
    ("spaces", "Spaces"),
    ("connections", "Connections"),
    ("extensions", "Extensions"),
    ("devices", "Devices"),
    ("notifications", "Notifications"),
    ("memory", "Memory"),
    ("system", "System"),
];

fn section_of(s: &str) -> &'static str {
    SECTIONS.iter().find(|(k, _)| *k == s).map(|(k, _)| *k).unwrap_or("general")
}

struct Open(Option<WindowHandle<SettingsWindow>>);
impl Global for Open {}

/// Opens Settings at a section: its window, made once; open already, it comes to the front there.
pub fn open(section: &str, cx: &mut App) {
    let section = section_of(section);
    if let Some(h) = cx.try_global::<Open>().and_then(|o| o.0)
        && h.update(cx, |w, window, cx| {
            w.section = section;
            window.activate_window();
            cx.notify();
        })
        .is_ok()
    {
        return;
    }
    // Centred over the main window, 60 px down from its top.
    let near = crate::platform::lifecycle::main_window(cx).and_then(|w| w.update(cx, |_, window, _| window.bounds()).ok());
    let sz = size(px(760.), px(560.));
    let bounds = match near {
        Some(b) => Bounds { origin: point(b.origin.x + (b.size.width - sz.width) / 2., b.origin.y + px(60.)), size: sz },
        None => Bounds { origin: point(px(160.) + (px(1240.) - sz.width) / 2., px(180.)), size: sz },
    };
    let bounds = crate::platform::windows::safe(bounds, cx);
    // Timed from the ask to its first frame, in the desktop log.
    let opened_at = std::time::Instant::now();
    let handle = cx
        .open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions { title: Some("Settings".into()), appears_transparent: true, traffic_light_position: Some(point(px(10.), px(8.))) }),
                ..Default::default()
            },
            |window, cx| {
                crate::platform::timing::opened("settings", opened_at, window);
                crate::platform::appkit::still(window);
                window.set_rem_size(px(16. * Look::get(cx).zoom));
                cx.new(|cx| SettingsWindow::new(section, window, cx))
            },
        )
        .ok();
    cx.set_global(Open(handle));
}

/// The Settings window, while it's open.
#[allow(dead_code)]
pub fn window(cx: &App) -> Option<gpui::AnyWindowHandle> {
    cx.try_global::<Open>().and_then(|o| o.0).map(Into::into)
}

pub struct SettingsWindow {
    pub section: &'static str,
    /// The section last drawn: General's settings are read again as it opens.
    read_general: Option<&'static str>,
    /// A spin showed in the last frame.
    spinning: bool,
    focus: FocusHandle,
}

impl SettingsWindow {
    fn new(section: &'static str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe(&model(cx), |_, _, cx| cx.notify()).detach();
        // The beat redraws it only while a spin shows (a pending act), not eight times a second.
        cx.observe(&Beat::entity(cx), |this: &mut SettingsWindow, _, cx| {
            if this.spinning {
                cx.notify();
            }
        })
        .detach();
        cx.observe(&crate::queries::entity(cx), |_, _, cx| cx.notify()).detach();
        cx.on_release(|_, cx| cx.set_global(Open(None))).detach();
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        SettingsWindow { section, read_general: None, spinning: false, focus }
    }
}

impl Focusable for SettingsWindow {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

fn open_section(section: &str, window: &mut Window, cx: &mut App) -> AnyElement {
    match section {
        "providers" => providers::render(window, cx),
        "profiles" => profiles::render(window, cx),
        "theme" => theme::render(window, cx),
        "spaces" => spaces::render(window, cx),
        "connections" => connections::render(window, cx),
        "extensions" => extensions::render(window, cx),
        "devices" => devices::render(window, cx),
        "notifications" => notifications::render(window, cx),
        "memory" => memory::render(window, cx),
        "system" => system::render(window, cx),
        _ => general::render(window, cx),
    }
}

impl SettingsWindow {
    /// ⌃⇥ and ⌃⇧⇥: the next section or the one before, round.
    fn step(&mut self, by: isize, cx: &mut Context<Self>) {
        let n = SECTIONS.len() as isize;
        let at = SECTIONS.iter().position(|(k, _)| *k == self.section).unwrap_or(0) as isize;
        self.section = SECTIONS[((at + by + n) % n) as usize].0;
        cx.notify();
    }

    fn body(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = Look::get(cx);
        if window.rem_size() != px(16. * l.zoom) {
            window.set_rem_size(px(16. * l.zoom));
        }
        let open = self.section;
        if open == "general" && self.read_general != Some(open) {
            general::reread(cx);
        }
        self.read_general = Some(open);
        // The section open is a section of its own: it fails alone.
        let _ = crate::kit::spun();
        let main = crate::boundary::guard_in(format!("settings:{open}"), window, cx, |window, cx| open_section(open, window, cx));
        self.spinning = crate::kit::spun();
        crate::menu::window_roles(div(), false)
            .track_focus(&self.focus)
            .key_context("Settings")
            .on_action(cx.listener(|this, _: &crate::commands::NextSection, _, cx| this.step(1, cx)))
            .on_action(cx.listener(|this, _: &crate::commands::PreviousSection, _, cx| this.step(-1, cx)))
            .on_key_down(|e: &KeyDownEvent, window, _| {
                if e.keystroke.key == "escape" {
                    window.remove_window();
                }
            })
            .size_full()
            .flex()
            .flex_col()
            .bg(l.bg)
            .text_color(l.ink)
            .font_family(SANS)
            // Figures line up: times and counts in tabular digits (`tabular-nums`).
            .font_features(crate::look::tabular())
            .text_size(u(13.))
            .line_height(u(16.))
            .child(
                crate::kit::drags(div().id("settings-band"), "settings-band", window, cx)
                    .flex()
                    .flex_none()
                    .h(u(30.))
                    .items_center()
                    .pl(l.z(72.))
                    .border_b(px(l.w1))
                    .border_color(l.line1)
                    .child(div().id("settings-title").role(gpui::Role::Heading).aria_level(1).aria_label("Settings").font_family(SIGN).font_weight(FontWeight::BOLD).text_size(u(15.)).line_height(u(18.)).pt(u(2.)).child("SETTINGS")),
            )
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .child(
                        div().id("settings-nav").role(gpui::Role::Navigation).aria_label("Settings").w(u(180.)).flex_none().h_full().border_r(px(l.w1)).border_color(l.line1).children(SECTIONS.iter().enumerate().map(|(i, (key, label))| {
                            let current = *key == open;
                            let key = *key;
                            kit::button(ElementId::Name(format!("section-{key}").into()), Btn::Row, true, &l)
                                .aria_selected(current)
                                .when(current, |d| d.bg(l.hover).font_weight(FontWeight::SEMIBOLD))
                                .when(i + 1 < SECTIONS.len(), |d| d.border_b(px(l.w2)).border_color(l.line2))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.section = key;
                                    cx.notify();
                                }))
                                .aria_label(*label).child(*label)
                        })),
                    )
                    .child(div().flex().flex_col().flex_1().min_w_0().min_h_0().child(main)),
            )
            .child(ui_sdk::foundation::platform::live_regions(window))
    }
}

impl Render for SettingsWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.body(window, cx)
    }
}
