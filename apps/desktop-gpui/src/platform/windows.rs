//! Windows of one thing (the desktop's `bun/reading.ts` and `frame.ts`). Settings (settings/), a
//! widget's (widgets/window.rs) and an ask's (`OpenItem`) are their pages' own; here is a long
//! reply's words, whole, in a window of its own (640 by 720, down and right of the last one opened,
//! titled with the reply's title), drawn by the view its page registers (`register("read", …)`),
//! the words as they are until one has; and what every window of one thing shares: where it sits
//! (on a display, at least 200 a side), fitting its height (`fit`, up to most of the screen, its
//! bottom edge where it was), and its open timed in the desktop log. gpui draws a window whole on
//! its first frame, so none is ever seen blank and none needs making ready ahead of time. Esc and ⌘W
//! close one. Every window takes the theme and text size as they change (Look).

use std::collections::HashMap;
use std::time::Instant;

use gpui::{
    AnyView, AnyWindowHandle, App, AppContext, Bounds, Context, FocusHandle, Focusable, Global, InteractiveElement, IntoElement, ParentElement, Pixels, Render, Styled,
    TitlebarOptions, Window, WindowBounds, WindowOptions, actions, div, point, px, size,
};

use super::appkit;
use super::timing;
use crate::look::{Look, SANS, u};

actions!(switch, [CloseOne]);

/// What a window of one thing shows here.
#[derive(Clone, Debug)]
pub enum Shows {
    /// A long reply, whole.
    Read { title: String, text: String },
}

impl Shows {
    fn kind(&self) -> &'static str {
        match self {
            Shows::Read { .. } => "read",
        }
    }
}

/// How a kind's view is made.
pub type Build = std::rc::Rc<dyn Fn(&Shows, &mut Window, &mut App) -> AnyView>;

#[derive(Default)]
struct Windows {
    builders: HashMap<&'static str, Build>,
    /// How many have opened, for where the next sits.
    opened: u32,
}
impl Global for Windows {}

/// Says how a kind's view is made: `read`.
pub fn register(kind: &'static str, build: impl Fn(&Shows, &mut Window, &mut App) -> AnyView + 'static, cx: &mut App) {
    cx.global_mut::<Windows>().builders.insert(kind, std::rc::Rc::new(build));
}

pub fn init(cx: &mut App) {
    cx.set_global(Windows::default());
    // The windows the desktop steps the next one's place for (reading.ts): an ask's and a widget's
    // each move it on, as a reading window does; the settings window moves it back one.
    cx.observe_new(|_: &mut crate::asks::window::AskWindow, _, cx| step(1, cx)).detach();
    cx.observe_new(|_: &mut crate::widgets::window::WidgetWindow, _, cx| step(1, cx)).detach();
    cx.observe_new(|_: &mut crate::settings::SettingsWindow, _, cx| step(7, cx)).detach();
}

/// A window of one thing: its view, or its title until its kind has one.
pub struct OneThing {
    pub shows: Shows,
    view: Option<AnyView>,
    focus: FocusHandle,
}

impl Focusable for OneThing {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for OneThing {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = Look::get(cx);
        let inner = match &self.view {
            Some(v) => v.clone().into_any_element(),
            None => {
                let Shows::Read { text, .. } = &self.shows;
                let title = text.clone();
                div().pt(u(38.)).px(u(16.)).child(title).into_any_element()
            }
        };
        div()
            .key_context("OneThing")
            .track_focus(&self.focus)
            .on_action(cx.listener(|_, _: &CloseOne, window, _| window.remove_window()))
            .on_action(cx.listener(|_, _: &crate::menu::CloseWindow, window, _| window.remove_window()))
            .size_full()
            .bg(l.bg)
            .text_color(l.ink)
            .font_family(SANS)
            .text_size(u(13.))
            .child(inner)
            .child(ui_sdk::foundation::platform::live_regions(window))
    }
}

fn title_of(shows: &Shows) -> String {
    match shows {
        Shows::Read { title, .. } => title.clone(),
    }
}

/// The work area of the display under `b`'s centre, else the primary's.
fn area_of(b: Bounds<Pixels>, cx: &App) -> Option<Bounds<Pixels>> {
    let c = b.center();
    let displays = cx.displays();
    displays.iter().map(|d| d.visible_bounds()).find(|a| a.contains(&c)).or_else(|| cx.primary_display().map(|d| d.visible_bounds()))
}

/// `b` as a frame on a display (`frame.ts`'s safeFrame): at least 200 a side, within the work
/// area of the display under its centre. Every window's frame goes through it.
pub fn safe(b: Bounds<Pixels>, cx: &App) -> Bounds<Pixels> {
    let least = px(200.);
    let (w, h) = (b.size.width.max(least), b.size.height.max(least));
    let Some(a) = area_of(Bounds { origin: b.origin, size: size(w, h) }, cx) else { return Bounds { origin: b.origin, size: size(w, h) } };
    let (w, h) = (w.min(a.size.width), h.min(a.size.height));
    let x = b.origin.x.max(a.origin.x).min(a.origin.x + a.size.width - w);
    let y = b.origin.y.max(a.origin.y).min(a.origin.y + a.size.height - h);
    Bounds { origin: point(x, y), size: size(w, h) }
}

fn open(shows: Shows, bounds: Bounds<Pixels>, cx: &mut App) -> Option<AnyWindowHandle> {
    let start = Instant::now();
    let title = title_of(&shows);
    let kind = shows.kind();
    let bounds = safe(bounds, cx);
    let handle = cx
        .open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions { title: Some(title.into()), appears_transparent: true, traffic_light_position: Some(point(px(10.), px(8.))) }),
                window_min_size: Some(size(px(200.), px(200.))),
                ..Default::default()
            },
            move |window, cx| {
                appkit::still(window);
                timing::opened(kind, start, window);
                let build = cx.try_global::<Windows>().and_then(|w| w.builders.get(kind)).cloned();
                let view = build.map(|b| b(&shows, window, cx));
                let one = cx.new(|cx| OneThing { shows, view, focus: cx.focus_handle() });
                // A view that took the focus as it was made (a reading window's words, for ⌘A, ⌘C
                // and the scroll keys) keeps it.
                if window.focused(cx).is_none() {
                    let focus = one.read(cx).focus.clone();
                    window.focus(&focus, cx);
                }
                one
            },
        )
        .ok()?;
    Some(handle.into())
}

fn step(by: u32, cx: &mut App) {
    let w = cx.global_mut::<Windows>();
    w.opened = (w.opened + by) % 8;
}

/// A long reply's words, whole, in a window of their own.
pub fn open_reading(title: &str, text: &str, cx: &mut App) {
    let n = {
        let w = cx.global_mut::<Windows>();
        w.opened = (w.opened + 1) % 8;
        w.opened
    };
    let at = point(px(240. + n as f32 * 24.), px(140. + n as f32 * 24.));
    open(Shows::Read { title: title.into(), text: text.into() }, Bounds { origin: at, size: size(px(640.), px(720.)) }, cx);
}

/// The view's height once laid out: the window fits it, up to most of the screen (720), its bottom
/// edge where it was.
pub fn fit(window: &mut Window, height: f32) {
    let bottom = appkit::bottom(window);
    let width = window.bounds().size.width;
    // gpui keeps the top edge as it resizes; once it has, the window goes back down to its bottom.
    window.resize(size(width, px(height.min(720.))));
    if let Some(y) = bottom {
        window.on_next_frame(move |window, _| {
            appkit::set_bottom(window, y);
        });
    }
}

/// Closes a window of one thing (an ask's, once its item closes).
pub fn close(window: &mut Window) {
    window.remove_window();
}
