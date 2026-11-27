//! A widget in a window of its own (the desktop's `widget-window.tsx`, bun's `openWidget`): an
//! extension's view a connection action returned, 1000 by 740 centred. The band to drag it by with
//! the widget's name, then its surface filling the window and scrolling in it ("Loading…" until it
//! comes; "Can't show this" and Retry if it fails); a page in it is the window's size. Esc closes it.

use gpui::{
    App, AppContext, Bounds, Context, FocusHandle, Focusable, FontWeight, InteractiveElement, IntoElement, KeyDownEvent, MouseButton, ParentElement, Render,
    SharedString, Styled, TitlebarOptions, Window, WindowBounds, WindowOptions, div, point, px, size,
};
use serde_json::Value;

use crate::look::{Look, SANS, SIGN, u};
use crate::widgets::host::{Host, Source};
use crate::widgets::media::WebPictures;
use crate::widgets::render::{self, Ctx};

/// The view a window shows: an app's widget and the input its tool is called with.
#[derive(Clone, Debug, PartialEq)]
pub struct View {
    pub app: String,
    pub name: String,
    pub input: Option<Value>,
}

pub struct WidgetWindow {
    view: View,
    key: String,
    focus: FocusHandle,
    /// Made roomier for a document, once.
    grown: bool,
}

/// Opens a widget's window.
pub fn open(view: View, cx: &mut App) -> Option<gpui::AnyWindowHandle> {
    let bounds = crate::platform::windows::safe(Bounds::centered(None, size(px(1000.), px(740.)), cx), cx);
    let title: SharedString = view.name.clone().into();
    // Timed from the ask to its first frame, in the desktop log.
    let opened_at = std::time::Instant::now();
    cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions { title: Some(title), appears_transparent: true, traffic_light_position: Some(point(px(10.), px(8.))) }),
            ..Default::default()
        },
        move |window, cx| {
            crate::platform::timing::opened("widget", opened_at, window);
            crate::platform::appkit::still(window);
            let w = cx.new(|cx| WidgetWindow::new(view, cx));
            let focus = w.read(cx).focus.clone();
            window.focus(&focus, cx);
            w
        },
    )
    .ok()
    .map(Into::into)
}

impl WidgetWindow {
    fn new(view: View, cx: &mut Context<Self>) -> Self {
        let input = view.input.as_ref().map(|i| i.to_string()).unwrap_or_else(|| "{}".into());
        let key = format!("{}/{}:window:{input}", view.app, view.name);
        cx.observe(&Host::entity(cx), |_, _, cx| cx.notify()).detach();
        let pictures = WebPictures::entity(cx);
        cx.observe(&pictures, |_, _, cx| cx.notify()).detach();
        WidgetWindow { view, key, focus: cx.focus_handle(), grown: false }
    }
}

impl Focusable for WidgetWindow {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl WidgetWindow {
    fn body(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        crate::webview::start_frame(window, cx);
        let l = Look::get(cx);
        let host = Host::entity(cx);
        let key = self.key.clone();
        let source = Source { app: self.view.app.clone(), name: self.view.name.clone(), input: Some(self.view.input.clone().unwrap_or_else(|| serde_json::json!({}))), placement: None };
        // A window's view isn't placed: it's shown whether its extension is listed or not.
        host.update(cx, |h, cx| h.want_any(&key, source, cx));
        let surface = host.read(cx).surface(&self.key);
        let failure = host.read(cx).failure(&self.key).map(str::to_string);
        // A document fills the window, under its own title, and scrolls itself; it's given room to
        // read beside its threads once, as it first shows.
        let mut fills: Option<String> = None;
        let content = match surface {
            Some(s) => {
                let mut ctx = Ctx::new(&self.key, s, l);
                ctx.in_window = true;
                fills = render::fills(&ctx);
                match fills {
                    Some(_) => render::build(&crate::a2ui::Child { id: "root".into(), base: String::new() }, &ctx, window, cx),
                    None => render::surface(&ctx, window, cx),
                }
            }
            // A failed load throws into the window's boundary (widget-window.tsx): its fallback,
            // the failure reported, and Retry asks again.
            None if failure.is_some() => {
                let (key, reason) = (self.key.clone(), failure.clone().unwrap_or_default());
                crate::boundary::failed_read(&key.clone(), &reason, move |cx| Host::entity(cx).update(cx, |h, cx| h.retry(&key, cx)), cx)
            }
            None => div().px(u(8.)).py(u(8.)).text_size(u(12.)).text_color(l.ink2).child("Loading…").into_any_element(),
        };
        if fills.is_some() && !self.grown {
            self.grown = true;
            let screen = window.display(cx).map(|d| d.visible_bounds().size);
            let want = size(px(1240.), px(880.));
            let to = screen.map(|s| size(want.width.min(s.width - px(40.)), want.height.min(s.height - px(40.)))).unwrap_or(want);
            if to.width > window.bounds().size.width {
                window.resize(to);
            }
        }
        div()
            .track_focus(&self.focus)
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
            .text_size(u(13.))
            .line_height(u(16.))
            .child(
                div()
                    .id("band")
                    .flex()
                    .flex_none()
                    .items_center()
                    .h(u(30.))
                    .pl(px(84.))
                    .pr(u(12.))
                    .border_b(px(l.w1))
                    .border_color(l.line1)
                    .on_mouse_down(MouseButton::Left, |e, window, _| {
                        if e.click_count == 2 {
                            window.titlebar_double_click();
                        } else {
                            window.start_window_move();
                        }
                    })
                    .child(div().min_w_0().truncate().font_family(SIGN).font_weight(FontWeight::BOLD).text_size(u(15.)).line_height(u(15.)).child(SharedString::from(fills.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| self.view.name.clone()).to_uppercase()))),
            )
            .child(match fills {
                Some(_) => div().flex_1().min_h_0().child(content),
                None => div().flex_1().min_h_0().child(crate::kit::pane_scroll("cell", None, content, window, cx)),
            })
            .child(ui_sdk::foundation::platform::live_regions(window))
    }
}

impl Render for WidgetWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        crate::boundary::guard("widget-window", window, cx, |window, cx| self.body(window, cx).into_any_element())
    }
}
