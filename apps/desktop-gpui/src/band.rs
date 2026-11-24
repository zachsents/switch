//! The band (the desktop's `ui/band.tsx` and `history-keys.tsx`): one plate across the top that's
//! also the titlebar, its window buttons centred on it. ‹ ›, then the page's line as a subway map:
//! Home's station, the spaces it sits within as stations joined by their ink, then the page's own
//! ring and its name in condensed capitals in its ink. A double-click on the name renames the space
//! in place (`rename-field.tsx`); a right-click on a station or the name is the space's menu.

use gpui::{
    AnyElement, AnyView, App, AppContext, Context, ElementId, Entity, FocusHandle, Focusable, FontWeight, InteractiveElement,
    IntoElement, KeyDownEvent, MouseButton, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Subscription,
    Window, div, prelude::*, px,
};
use ui_sdk::components::input::{Input, InputOptions, TextFieldStyle};

use crate::brain::{HOME, Link};
use crate::derive::above;
use crate::look::{Look, SIGN, u};
use crate::marks;
use crate::menu::space_items;
use crate::model::model;
use crate::nav::{Beat, Nav, Page};
use crate::shell::Shell;
use crate::spaces::space_menu_of;

/// A tooltip: under the pointer a moment, its words in a hairline.
pub struct Tip(pub SharedString);

impl Render for Tip {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = Look::get(cx);
        div()
            .relative()
            .child(crate::webview::covering())
            .max_w(u(280.))
            .rounded(u(4.))
            .border_1()
            .border_color(l.line1)
            .bg(l.bg)
            .px(u(8.))
            .py(u(4.))
            .text_size(u(12.))
            .line_height(u(16.))
            .text_color(l.ink)
            .font_family(crate::look::SANS)
            .child(self.0.clone())
    }
}

/// A tooltip's builder, for `.tooltip(…)`.
pub fn tip(label: impl Into<SharedString>) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let label: SharedString = label.into();
    move |_, cx| cx.new(|_| Tip(label.clone())).into()
}

/// The space's right-click menu, at the pointer.
pub fn space_menu(id: &str, window: &mut Window, cx: &mut App) {
    let m = space_menu_of(&model(cx).read(cx).brain, id);
    crate::native_menu::popup(space_items(&m), window, cx);
}

/// A space's name in edit on the band: Enter keeps it, Escape or leaving puts the old one back.
pub struct RenameField {
    id: String,
    input: Entity<Input>,
    focused: bool,
    _blur: Option<Subscription>,
}

impl RenameField {
    pub fn new(id: String, name: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let l = Look::get(cx);
        let input = cx.new(|cx| {
            Input::new(
                InputOptions::default().default_value(name).field_style(TextFieldStyle { text_color: Some(l.ink), caret_color: Some(l.ink), ..Default::default() }),
                window,
                cx,
            )
        });
        RenameField { id, input, focused: false, _blur: None }
    }

    /// Enter keeps the name; a blank one isn't taken, and the field stays open.
    fn keep(&mut self, cx: &mut Context<Self>) {
        let text = self.input.read(cx).get_value().to_string();
        if text.trim().is_empty() {
            return;
        }
        crate::spaces::rename(&self.id, &text, cx);
        Shell::stop_rename(cx);
    }
}

impl Focusable for RenameField {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.input.read(cx).focus_handle(cx)
    }
}

impl Render for RenameField {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.focused {
            self.focused = true;
            let handle = self.input.read(cx).focus_handle(cx);
            window.focus(&handle, cx);
            window.dispatch_action(Box::new(ui_sdk::native::text_field::SelectAll), cx);
            self._blur = Some(cx.on_blur(&handle, window, |_, _, cx| Shell::stop_rename(cx)));
        }
        // A press or drag in the field is the field's, not the band's (NO_DRAG).
        crate::kit::no_drag(div().id("rename"))
            .key_context("Rename")
            .ml(u(6.))
            .flex()
            .flex_1()
            .min_w_0()
            .font_family(SIGN)
            .font_weight(FontWeight::BOLD)
            .text_size(u(22.))
            .line_height(u(26.))
            .pt(u(3.))
            .capture_key_down(cx.listener(|this, e: &KeyDownEvent, _, cx| match e.keystroke.key.as_str() {
                "enter" => {
                    this.keep(cx);
                    cx.stop_propagation();
                }
                "escape" => {
                    Shell::stop_rename(cx);
                    cx.stop_propagation();
                }
                _ => {}
            }))
            .child(Input::root(&self.input, cx).aria_label("Name").w_full().min_w_0())
    }
}

/// The band, for the page open. `rename` is the field while the space's name is in edit.
pub fn band(page: &Page, space: &str, rename: Option<Entity<RenameField>>, l: &Look, window: &mut Window, cx: &mut App) -> AnyElement {
    let m = model(cx).read(cx);
    let space = space.to_string();
    let thread = match page {
        Page::Thread(t, _) => m.brain.threads.get(t),
        Page::Space(_) => None,
    };
    // An untitled page (a thread its pre-read gave no title) is its space's.
    let title: Option<String> = thread.map(|t| t.title.clone()).filter(|t| !t.is_empty());
    let live = thread.is_some_and(|t| t.status == crate::brain::Status::Running);
    let mut way = above(&m.brain, &space);
    if title.is_some() && m.brain.spaces.contains_key(&space) {
        way.push(space.clone());
    }
    let ring = l.z(18.);
    let home = space == HOME;
    let st = m.derived.station(&space);
    let ink = if home { l.ink } else { l.ink_of(&st) };
    let name = m.brain.spaces.get(&space).map(|s| s.name.clone()).unwrap_or_default();
    let own = title.clone().unwrap_or_else(|| if home { "Home".to_string() } else { name.clone() });
    let names: Vec<String> = way.iter().map(|id| m.brain.spaces.get(id).map(|s| s.name.clone()).unwrap_or_default()).collect();
    let nav = Nav::entity(cx).read(cx);
    let (can_back, can_forward) = (nav.can_back(), nav.can_forward());
    let down = m.link == Link::Down;
    let step = Beat::step(cx);
    let marks_of: Vec<(String, crate::derive::Station)> = way.iter().map(|id| (id.clone(), m.derived.station(id))).collect();
    // ‹ ›: a key each, quiet with nowhere to go (no tip, no tab stop).
    let key = |id: &'static str, back: bool, on: bool, label: &'static str, window: &mut Window, cx: &mut App| {
        let d = crate::kit::no_drag(div().id(id))
            .role(gpui::Role::Button)
            .aria_label(if back { "Back" } else { "Forward" })
            .w(u(24.))
            .h(u(22.))
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .rounded(u(4.))
            .when(on, |d| d.hover(|s| s.bg(l.hover)).active(|s| s.bg(l.hover)))
            .when(!on, |d| d.opacity(0.4))
            .child(marks::arrow(back, l.z(12.), l.ink2));
        if on { crate::kit::tip_under(crate::kit::focusable(d, l), id, label, window, cx) } else { d }
    };
    let back = key("back", true, can_back, "Back ⌘[", window, cx).when(can_back, |d| d.on_click(|_, _, cx| Nav::back(cx)));
    let forward = key("forward", false, can_forward, "Forward ⌘]", window, cx).when(can_forward, |d| d.on_click(|_, _, cx| Nav::forward(cx)));
    let mut stations: Vec<AnyElement> = vec![];
    for (i, (id, sst)) in marks_of.iter().enumerate() {
        let sink = if id == HOME { l.ink2 } else { l.ink_of(sst) };
        if i > 0 {
            stations.push(div().h(l.z(2.)).w(u(10.)).flex_none().bg(l.ink_of(sst)).into_any_element());
        }
        let (to, menu) = (id.clone(), id.clone());
        let d = crate::kit::no_drag(div().id(ElementId::Name(format!("station-{id}").into())))
            .role(gpui::Role::Button)
            .aria_label(if id == HOME { "Home".to_string() } else { names[i].clone() })
            .px(u(2.))
            .h(u(22.))
            .flex()
            .flex_none()
            .items_center()
            .rounded(u(4.))
            .hover(|s| s.bg(l.hover))
            .active(|s| s.bg(l.hover))
            .on_click(move |_, _, cx| Nav::open(Page::Space(to.clone()), cx))
            .on_mouse_down(MouseButton::Right, move |_, window, cx| {
                cx.stop_propagation();
                space_menu(&menu, window, cx);
            })
            .child(marks::ring(&sst.code, sink, ring, l.bg, l.ink, id == HOME));
        let label = if id == HOME { "Home ⇧⌘H".to_string() } else { names[i].clone() };
        stations.push(crate::kit::tip_under(crate::kit::focusable(d, l), &format!("station-{id}"), label, window, cx).into_any_element());
    }
    let renaming = title.is_none() && rename.is_some();
    let (rename_id, menu_id) = (space.clone(), space.clone());
    crate::kit::drags(div().id("band"), "band", window, cx)
        .flex()
        .flex_none()
        .items_center()
        .h(u(30.))
        .pl(l.z(72.))
        .pr(u(6.))
        .bg(l.bg)
        .border_b(px(l.w1))
        .border_color(l.line1)
        .child(
            div()
                .mr(u(8.))
                .flex()
                .items_center()
                .child(back)
                .child(forward),
        )
        .children(stations)
        .when(title.is_none(), |d| {
            d.when(!way.is_empty(), |d| d.child(div().h(l.z(2.)).w(u(10.)).flex_none().bg(ink)))
                .child(div().flex_none().px(u(2.)).child(marks::ring(&st.code, ink, ring, l.bg, l.ink, home)))
        })
        .map(|d| match rename.filter(|_| renaming) {
            Some(field) => d.child(field),
            None => d.child(
                div()
                    .id("title")
                    .role(gpui::Role::Heading)
                    .aria_level(1)
                    .aria_label(own.clone())
                    // A space's name is a key (a double-click renames it); a thread's title is words.
                    .when(title.is_none(), |d| {
                        let r = crate::kit::ring(l);
                        d.tab_index(0).focus_visible(move |s| s.shadow(r))
                    })
                    .ml(u(6.))
                    .min_w_0()
                    .truncate()
                    .font_family(SIGN)
                    .font_weight(FontWeight::BOLD)
                    .text_size(u(22.))
                    .line_height(u(26.))
                    .pt(u(3.))
                    .text_color(if title.is_none() { ink } else { l.ink })
                    .when(title.is_none(), |d| {
                        d.on_mouse_down(MouseButton::Left, move |e, _, cx| {
                            cx.stop_propagation();
                            if e.click_count == 2 {
                                Shell::start_rename(&rename_id, cx);
                            }
                        })
                        .on_mouse_down(MouseButton::Right, move |_, window, cx| {
                            cx.stop_propagation();
                            space_menu(&menu_id, window, cx);
                        })
                    })
                    .child(SharedString::from(own.to_uppercase())),
            ),
        })
        .when(live, |d| d.child(div().ml(u(8.)).flex().items_center().child(marks::runner_mark(l.z(20.), step, l.orange))))
        .child(div().ml_auto().flex().items_center().gap(u(4.)).pl(u(12.)).when(down, |d| {
            d.child(div().flex().items_center().gap(u(6.)).text_size(u(12.)).line_height(u(16.)).text_color(l.ink).child(marks::stop(l.z(12.), l)).child("Can't reach the brain"))
        }))
        .into_any_element()
}
