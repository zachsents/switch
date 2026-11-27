//! A terminal in a window of its own: the band to drag it by, with what's running and where, then
//! the screen filling the rest. 760 by 480 at the centre, its keys the terminal's from the start.
//! Its shell ending closes a window of its own; a pinned one's window closing puts it back in its
//! column, its shell going on.

use gpui::{
    AnyWindowHandle, App, AppContext, Bounds, Context, Entity, FocusHandle, Focusable, FontWeight, InteractiveElement, IntoElement, MouseButton, ParentElement, Render, SharedString, Styled,
    TitlebarOptions, Window, WindowBounds, WindowOptions, div, point, px, size,
};

use super::session::Ended;
use super::view::TerminalView;
use crate::look::{Look, SANS, u};

pub struct TerminalWindow {
    id: String,
    view: Entity<TerminalView>,
}

impl Focusable for TerminalWindow {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.view.read(cx).focus.clone()
    }
}

fn handle(id: &str, cx: &App) -> Option<AnyWindowHandle> {
    cx.windows().into_iter().find(|w| w.downcast::<TerminalWindow>().and_then(|h| h.read(cx).ok().map(|t| t.id == id)).unwrap_or(false))
}

/// Opens terminal `id`'s window, or brings it forward.
pub fn open(id: String, cx: &mut App) {
    if let Some(w) = handle(&id, cx) {
        let _ = w.update(cx, |_, window, _| window.activate_window());
        return;
    }
    let Some(session) = super::session(&id, cx) else { return };
    let bounds = crate::platform::windows::safe(Bounds::centered(None, size(px(760.), px(480.)), cx), cx);
    let title: SharedString = session.read(cx).name().into();
    let opened = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions { title: Some(title), appears_transparent: true, traffic_light_position: Some(point(px(10.), px(8.))) }),
            window_min_size: Some(size(px(240.), px(120.))),
            ..Default::default()
        },
        move |window, cx| {
            crate::platform::appkit::still(window);
            // A pinned one's window has a view of its own on the same shell.
            let view = cx.new(|cx| TerminalView::new(session.clone(), cx));
            let focus = view.read(cx).focus.clone();
            window.focus(&focus, cx);
            let closing = id.clone();
            window.on_window_should_close(cx, move |_, cx| {
                gone(&closing, cx);
                true
            });
            cx.new(|cx| {
                cx.subscribe_in(&session, window, |this: &mut TerminalWindow, s, _: &Ended, window, cx| {
                    // A window's own shell ending closes it; a pinned one's stays to be read.
                    if s.read(cx).start.space.is_none() {
                        super::close(&this.id, cx);
                        window.remove_window();
                    }
                })
                .detach();
                cx.observe(&session, |_, _, cx| cx.notify()).detach();
                TerminalWindow { id, view }
            })
        },
    );
    if let Ok(w) = opened {
        let _ = w.update(cx, |_, window, _| window.activate_window());
    }
}

/// Its window gone: a pinned one back in its column, a window's own shell ended.
fn gone(id: &str, cx: &mut App) {
    let pinned = super::session(id, cx).is_some_and(|s| s.read(cx).start.space.is_some());
    if pinned {
        cx.global_mut::<super::Terminals>().windowed.remove(id);
        crate::model::model(cx).update(cx, |_, cx| cx.notify());
    } else {
        let id = id.to_string();
        // After the window's own close, not inside it.
        cx.defer(move |cx| super::close(&id, cx));
    }
}

/// Closes terminal `id`'s window, if it has one.
pub fn close(id: &str, cx: &mut App) {
    if let Some(w) = handle(id, cx) {
        let _ = w.update(cx, |_, window, _| window.remove_window());
    }
}

impl Render for TerminalWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = Look::get(cx);
        let name = self.view.read(cx).session.read(cx).name();
        window.set_window_title(&name);
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(l.bg)
            .text_color(l.ink)
            .font_family(SANS)
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
                    .child(div().min_w_0().truncate().text_size(u(12.)).line_height(u(16.)).font_weight(FontWeight::MEDIUM).text_color(l.ink2).child(SharedString::from(name))),
            )
            .child(div().flex_1().min_h_0().child(self.view.clone()))
    }
}
