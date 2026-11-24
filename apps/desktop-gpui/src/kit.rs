//! The kit (the desktop's `ui/kit/`): the one button in its few looks, a segmented choice, a select
//! and a pick (a select with Find), a confirm, what floats, a setting's row and a group, a pane that
//! scrolls, a text field. Every press is instant: no transition, and hover never changes a line or
//! the layout. Each takes the look and is styled from it; one with state of its own keeps it keyed
//! to its element (`use_keyed_state`).

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, Div, ElementId, Entity, FontWeight, InteractiveElement, IntoElement, ParentElement,
    SharedString, Stateful, StatefulInteractiveElement, Styled, Window, anchored, deferred, div, point, prelude::*, px,
};
use ui_sdk::components::input::{Input, InputOptions, TextFieldStyle};
use ui_sdk::components::scroll_area::{ScrollArea, ScrollAreaOptions, ScrollAreaOrientation};

use crate::look::{Look, MONO, u};

/// A button's look.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Btn {
    /// A key in its hairline, sinking a point when pressed: a choice, a secondary act.
    Key,
    /// The go key: the one act that goes ahead (Send, Approve, Done, Connect).
    Go,
    /// A key in the danger color: what stops or takes away (Stop, Decline, Remove).
    Danger,
    /// Bare words or a glyph, lit under the pointer (Edit, ‹ ›, ✕).
    Flat,
    /// Bare, on the band.
    Plate,
    /// A whole list row: its full width and height are the click.
    Row,
    /// No look of its own: a picture, a link-like word, a swatch.
    Bare,
}

/// Text sizes and their line heights (`index.css`).
pub fn caption(d: Div) -> Div {
    d.text_size(u(11.)).line_height(u(14.))
}
pub fn small(d: Div) -> Div {
    d.text_size(u(12.)).line_height(u(16.))
}
pub fn ui(d: Div) -> Div {
    d.text_size(u(13.)).line_height(u(16.))
}
pub fn read(d: Div) -> Div {
    d.text_size(u(14.)).line_height(u(20.))
}
pub fn data(d: Div) -> Div {
    d.font_family(MONO).text_size(u(11.)).line_height(u(14.))
}

/// A button in a look. `on` false is disabled: dimmed, and it takes no press.
pub fn button(id: impl Into<ElementId>, look: Btn, on: bool, l: &Look) -> Stateful<Div> {
    let d = div().id(id.into()).role(gpui::Role::Button).flex().flex_none().items_center().justify_center().gap(u(6.)).whitespace_nowrap();
    let key = |d: Stateful<Div>| d.h(u(22.)).rounded(u(4.)).px(u(8.)).text_size(u(12.)).line_height(u(16.)).font_weight(FontWeight::MEDIUM);
    let d = match look {
        Btn::Key => key(d).border_1().border_color(l.key_border).bg(l.bg).text_color(l.ink).when(on, |d| d.hover(|s| s.bg(l.hover)).active(|s| s.mt(px(1.)).mb(px(-1.)))),
        Btn::Go => key(d).border_1().border_color(l.go_border).bg(l.go).text_color(l.white).when(on, |d| d.hover(|s| s.bg(l.go_press)).active(|s| s.mt(px(1.)).mb(px(-1.)))),
        Btn::Danger => key(d).border_1().border_color(l.key_border).bg(l.bg).text_color(l.red).when(on, |d| d.hover(|s| s.bg(l.hover)).active(|s| s.mt(px(1.)).mb(px(-1.)))),
        Btn::Flat | Btn::Plate => d.h(u(22.)).rounded(u(4.)).px(u(6.)).text_size(u(12.)).line_height(u(16.)).font_weight(FontWeight::MEDIUM).text_color(l.ink2).when(on, |d| d.hover(|s| s.bg(l.hover)).active(|s| s.bg(l.hover))),
        Btn::Row => d.relative().h(u(24.)).w_full().justify_start().gap(u(8.)).px(u(8.)).text_size(u(13.)).line_height(u(16.)).text_color(l.ink).when(on, |d| d.hover(|s| s.bg(l.hover)).active(|s| s.bg(l.hover))),
        Btn::Bare => d,
    };
    // Each takes Tab, Space and Enter, and shows its focus as a ring that moves nothing; focused,
    // one shown only under the pointer shows too.
    let d = d.focus_visible(|s| s.shadow(ring(l)).opacity(1.));
    d.when(on, |d| d.tab_index(0)).when(!on, |d| d.opacity(0.4))
}

/// Keyboard focus (`focused`): a hairline in ink3 just inside the edge, an outline that moves
/// nothing.
pub fn ring(l: &Look) -> Vec<gpui::BoxShadow> {
    vec![gpui::BoxShadow { color: l.ink3, offset: point(px(0.), px(0.)), blur_radius: px(0.), spread_radius: px(1.), inset: true }]
}

/// Takes Tab, Enter and Space (its click), with the focus ring.
/// It's a button to assistive technology unless it says what else it is (gpui reports nothing
/// without a role).
pub fn focusable(d: Stateful<Div>, l: &Look) -> Stateful<Div> {
    let r = ring(l);
    d.role(gpui::Role::Button).tab_index(0).focus_visible(move |s| s.shadow(r))
}

/// Runs `f` on a click, when the button is on.
pub fn press(d: Stateful<Div>, on: bool, f: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Stateful<Div> {
    if on { d.on_click(f) } else { d }
}

/// One choice of a few, side by side (a toggle group): equal heights, one line-1 around them and
/// between; the chosen one is pressed in. Choosing never moves anything. It's one tab stop, the
/// chosen one; ← → move between them, Space and Enter choose.
pub fn segmented(id: impl Into<SharedString>, label: impl Into<SharedString>, options: &[(&str, &str)], value: &str, l: &Look, on_change: impl Fn(&str, &mut Window, &mut App) + 'static, window: &mut Window, cx: &mut App) -> AnyElement {
    strip(id, label, options, value, false, l, on_change, window, cx)
}

/// The same strip as a widget's tabs: a tab list, each choice a tab, the open one selected.
pub fn tabs(id: impl Into<SharedString>, label: impl Into<SharedString>, options: &[(&str, &str)], value: &str, l: &Look, on_change: impl Fn(&str, &mut Window, &mut App) + 'static, window: &mut Window, cx: &mut App) -> AnyElement {
    strip(id, label, options, value, true, l, on_change, window, cx)
}

#[allow(clippy::too_many_arguments)]
fn strip(id: impl Into<SharedString>, label: impl Into<SharedString>, options: &[(&str, &str)], value: &str, tabs: bool, l: &Look, on_change: impl Fn(&str, &mut Window, &mut App) + 'static, window: &mut Window, cx: &mut App) -> AnyElement {
    let id: SharedString = id.into();
    let f = Rc::new(on_change);
    let handles = window.use_keyed_state(ElementId::Name(format!("{id}-focus").into()), cx, |_, _| Vec::<gpui::FocusHandle>::new());
    if handles.read(cx).len() < options.len() {
        let more: Vec<gpui::FocusHandle> = (handles.read(cx).len()..options.len()).map(|_| cx.focus_handle()).collect();
        handles.update(cx, |h, _| h.extend(more));
    }
    let hs = handles.read(cx).clone();
    let stop = options.iter().position(|(v, _)| *v == value).unwrap_or(0);
    let n = options.len();
    let group_label: SharedString = label.into();
    div()
        .id(ElementId::Name(format!("{id}-group").into()))
        .role(if tabs { gpui::Role::TabList } else { gpui::Role::Group })
        .aria_label(group_label)
        .flex()
        .flex_none()
        .h(u(22.))
        .overflow_hidden()
        .rounded(u(4.))
        .border_1()
        .border_color(l.line1)
        .children(options.iter().enumerate().map(|(i, (v, label))| {
            let picked = *v == value;
            let (f, v) = (f.clone(), v.to_string());
            let hs2 = hs.clone();
            let r = ring(l);
            div()
                .id(ElementId::Name(format!("{id}-{v}").into()))
                // A tracked handle carries its own place in the tab order (gpui ignores the
                // element's then).
                .track_focus(&hs[i].clone().tab_index(0).tab_stop(i == stop))
                .aria_label(label.to_string())
                .map(|d| {
                    if tabs {
                        d.role(gpui::Role::Tab).aria_selected(picked)
                    } else {
                        d.role(gpui::Role::Button).aria_toggled(if picked { gpui::Toggled::True } else { gpui::Toggled::False })
                    }
                })
                .flex()
                .h_full()
                .items_center()
                .px(u(10.))
                .text_size(u(12.))
                .line_height(u(16.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(if picked { l.ink } else { l.ink2 })
                .when(picked, |d| d.bg(l.hover))
                .hover(|s| s.bg(l.hover))
                .when(i > 0, |d| d.border_l_1().border_color(l.line1))
                .focus_visible(move |s| s.shadow(r))
                .on_key_down(move |e: &gpui::KeyDownEvent, window, cx| {
                    let to = match e.keystroke.key.as_str() {
                        "right" | "down" => (i + 1) % n,
                        "left" | "up" => (i + n - 1) % n,
                        _ => return,
                    };
                    window.focus(&hs2[to], cx);
                    cx.stop_propagation();
                })
                .on_click(move |_, window, cx| {
                    if !picked {
                        f(&v, window, cx)
                    }
                })
                .child(label.to_string())
        }))
        .into_any_element()
}

/// A setting's row: its label at a fixed width, its controls beside it, on a line-2.
pub fn setting(label: impl Into<SharedString>, w: f32, l: &Look) -> Div {
    let label: SharedString = label.into();
    div()
        .flex()
        .min_h(u(36.))
        .items_center()
        .gap(u(12.))
        .px(u(8.))
        .py(u(6.))
        .border_b(px(l.w2))
        .border_color(l.line2)
        // Under the pointer, the whole label, should it be cut short.
        .child(ui(div()).id(ElementId::Name(format!("setting-{label}").into())).w(u(w)).flex_none().truncate().text_color(l.ink2).when(!label.is_empty(), |d| d.tooltip(crate::band::tip(label.clone()))).child(label))
}

/// A setting row's controls: wrapping, beside its label.
pub fn controls() -> Div {
    div().flex().flex_1().min_w_0().flex_wrap().items_center().gap(u(8.))
}

/// The labels' widths: `w-40`, `w-48`.
pub const W40: f32 = 160.;
pub const W48: f32 = 192.;

/// A group's heading, and what acts on the group at its end.
pub fn group_head(label: impl Into<SharedString>, action: Option<AnyElement>, l: &Look) -> Div {
    let label: SharedString = label.into();
    div()
        .flex()
        .flex_none()
        .h(u(24.))
        .items_center()
        .gap(u(4.))
        .px(u(8.))
        .border_b(px(l.w2))
        .border_color(l.line2)
        .child(ui(div()).flex_1().min_w_0().truncate().font_weight(FontWeight::SEMIBOLD).text_color(l.ink).child(label))
        .children(action)
}

/// A group of settings under its heading.
pub fn group(label: impl Into<SharedString>, action: Option<AnyElement>, rows: impl IntoIterator<Item = AnyElement>, l: &Look) -> AnyElement {
    div().flex().flex_col().child(group_head(label, action, l)).children(rows).into_any_element()
}

/// What floats (a popover, a menu, the palette): the one background inside a line-1 hairline, a
/// little rounded, never a shadow. It appears at once.
pub fn float(l: &Look) -> Div {
    // Drawn over the window: a page (a web view) under it hides.
    div().relative().overflow_hidden().rounded(u(6.)).border_1().border_color(l.line1).bg(l.bg).text_color(l.ink).child(crate::webview::covering())
}

/// A dialog's place: over the window, its top 72 px down, centred, at most the window less 32.
pub fn sheet(width: f32, window: &Window, l: &Look) -> Div {
    let vw = window.viewport_size().width;
    let w = l.z(width).min(vw - l.z(32.));
    float(l).absolute().top(l.z(72.)).left((vw - w) / 2.).w(w)
}

/// A pane that scrolls, with the Mac's overlay thumb: there only when the pane has more than it
/// shows, then shown while it moves or under the pointer, over the content.
pub fn pane_scroll(id: impl Into<ElementId>, label: Option<&'static str>, child: impl IntoElement, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let scroll: Entity<ScrollArea> = window.use_keyed_state(id, cx, |window, cx| ScrollArea::new(ScrollAreaOptions::default(), window, cx));
    let thumb = ScrollArea::thumb(&scroll, ScrollAreaOrientation::Vertical, cx).w_full().rounded_full().bg(l.ink3.opacity(0.5));
    let bar = ScrollArea::scrollbar(&scroll, ScrollAreaOrientation::Vertical, cx)
        .w(px(8.))
        .p(px(2.))
        .with(|el, state| el.opacity(if state.visible { 1. } else { 0. }).when(state.visible, |el| el.child(crate::webview::cutting())))
        .child(thumb);
    let viewport = ScrollArea::viewport(&scroll, cx).size_full();
    let viewport = match label {
        Some(label) => viewport.aria_label(label),
        None => viewport,
    };
    ScrollArea::root(&scroll, cx)
        .size_full()
        .relative()
        .child(viewport.child(ScrollArea::content(&scroll, cx).w_full().child(child)))
        .child(bar)
        .into_any_element()
}

/// The ⌃⌄ on a select's trigger.
pub fn updown(l: &Look) -> impl IntoElement {
    crate::marks::updown(l.z(10.), l.ink3)
}

/// A check beside the chosen option.
pub fn check(l: &Look) -> impl IntoElement {
    crate::marks::check(l.z(12.), l.ink)
}

/// An option of a select or a pick: its value, its words, its heading in the list.
#[derive(Clone, Debug, PartialEq)]
pub struct Opt {
    pub value: String,
    pub label: String,
    pub group: Option<String>,
    pub disabled: bool,
}

impl Opt {
    pub fn new(value: impl Into<String>, label: impl Into<String>) -> Self {
        Opt { value: value.into(), label: label.into(), group: None, disabled: false }
    }

    pub fn in_group(mut self, g: impl Into<String>) -> Self {
        self.group = Some(g.into());
        self
    }
}

/// A float's open state: what's highlighted, what's been typed toward an option (typeahead), the
/// trigger's focus (it keeps it while its list is open), and the scroll of its list.
struct Popup {
    open: bool,
    highlight: usize,
    typed: String,
    typed_at: std::time::Instant,
    focus: gpui::FocusHandle,
    scroll: gpui::ScrollHandle,
    reveal: bool,
    /// Pick: the words its list was last narrowed by, and that it was just opened (its Find
    /// starts empty).
    query: String,
    fresh: bool,
    /// Confirm: what had focus before it opened.
    restore: Option<gpui::FocusHandle>,
    cancel: gpui::FocusHandle,
    go: gpui::FocusHandle,
    /// Where its trigger was last drawn: its list is at least as wide, and a press on it while
    /// the list is open closes the list (not open it again).
    trigger: Rc<std::cell::Cell<Option<gpui::Bounds<gpui::Pixels>>>>,
}

impl Popup {
    fn on_trigger(&self, at: gpui::Point<gpui::Pixels>) -> bool {
        self.trigger.get().is_some_and(|b| b.contains(&at))
    }

    fn trigger_w(&self) -> gpui::Pixels {
        self.trigger.get().map(|b| b.size.width).unwrap_or_default()
    }

    fn new(cx: &mut App) -> Self {
        Popup {
            open: false,
            highlight: 0,
            typed: String::new(),
            typed_at: std::time::Instant::now(),
            focus: cx.focus_handle(),
            scroll: gpui::ScrollHandle::new(),
            reveal: false,
            query: String::new(),
            fresh: false,
            restore: None,
            cancel: cx.focus_handle(),
            go: cx.focus_handle(),
            trigger: Rc::default(),
        }
    }
}

gpui::actions!(kit, [Dismiss]);

/// Esc closes what floats (a select's list, a pick's, a confirm) before anything under it hears it.
pub fn bindings() -> Vec<gpui::KeyBinding> {
    vec![gpui::KeyBinding::new("escape", Dismiss, Some("KitFloat"))]
}

fn option_row(id: ElementId, o: &Opt, chosen: bool, lit: bool, l: &Look) -> Stateful<Div> {
    div()
        .id(id)
        .flex()
        .h(u(24.))
        .items_center()
        .gap(u(6.))
        .pr(u(8.))
        .pl(u(8.))
        .text_size(u(13.))
        .line_height(u(16.))
        .text_color(l.ink)
        .when(o.disabled, |d| d.opacity(0.4))
        .when(lit, |d| d.bg(l.hover))
        .child(div().flex().w(u(12.)).flex_none().justify_center().when(chosen, |d| d.child(check(l))))
        .child(div().min_w_0().truncate().child(o.label.clone()))
}

fn heading(g: &str, l: &Look) -> Div {
    caption(div()).flex().h(u(24.)).items_center().px(u(8.)).font_weight(FontWeight::SEMIBOLD).text_color(l.ink3).child(g.to_string())
}

/// The trigger's words: the chosen option's label, its group after it ("opus Claude").
fn chosen_words(options: &[Opt], value: &str, l: &Look) -> Vec<AnyElement> {
    let o = options.iter().find(|o| o.value == value);
    let mut out = vec![div().min_w_0().truncate().child(o.map(|o| o.label.clone()).unwrap_or_else(|| value.to_string())).into_any_element()];
    if let Some(g) = o.and_then(|o| o.group.clone()) {
        out.push(div().flex_none().text_color(l.ink2).child(g).into_any_element());
    }
    out
}

fn trigger(id: ElementId, open: bool, on: bool, focus: &gpui::FocusHandle, l: &Look) -> Stateful<Div> {
    div()
        .id(id)
        .flex()
        .h(u(22.))
        .max_w_full()
        .min_w_0()
        .items_center()
        .gap(u(6.))
        .rounded(u(4.))
        .px(u(6.))
        .text_size(u(13.))
        .line_height(u(16.))
        .text_color(l.ink)
        .when(on, |d| {
            let r = ring(l);
            d.track_focus(focus).tab_index(0).focus_visible(move |s| s.shadow(r))
        })
        .when(open, |d| d.bg(l.hover))
        .when(on, |d| d.hover(|s| s.bg(l.hover)))
        .when(!on, |d| d.opacity(0.4))
}

fn set(st: &Entity<Popup>, cx: &mut App, f: impl FnOnce(&mut Popup)) {
    st.update(cx, |p, cx| {
        f(p);
        cx.notify();
    });
}

/// The options in their list's order: those in no group, then each group's.
fn ordered(options: &[Opt]) -> Vec<Opt> {
    let mut groups: Vec<String> = vec![];
    for o in options {
        if let Some(g) = &o.group
            && !groups.contains(g)
        {
            groups.push(g.clone());
        }
    }
    let mut out: Vec<Opt> = options.iter().filter(|o| o.group.is_none()).cloned().collect();
    for g in &groups {
        out.extend(options.iter().filter(|o| o.group.as_ref() == Some(g)).cloned());
    }
    out
}

/// The next option from `at` that can be chosen, `by` one way, wrapping.
fn step_to(list: &[Opt], at: usize, by: isize) -> usize {
    let n = list.len() as isize;
    let mut i = at as isize;
    for _ in 0..n {
        i = (i + by + n) % n;
        if !list[i as usize].disabled {
            return i as usize;
        }
    }
    at
}

/// The list's rows, with each group's heading, and the row (as a child of the list) the highlight is.
fn list_rows(id: &SharedString, list: &[Opt], lit: usize, value: &str, headings: bool, st: &Entity<Popup>, f: &Rc<dyn Fn(&str, &mut Window, &mut App)>, l: &Look) -> (Vec<AnyElement>, usize) {
    let mut rows: Vec<AnyElement> = vec![];
    let mut group: Option<Option<String>> = None;
    let mut lit_row = 0;
    for (i, o) in list.iter().enumerate() {
        if headings && group.as_ref() != Some(&o.group) {
            group = Some(o.group.clone());
            if let Some(g) = &o.group {
                rows.push(heading(g, l).into_any_element());
            }
        }
        if i == lit {
            lit_row = rows.len();
        }
        let (pick_st, hover_st, f, v, cur, disabled) = (st.clone(), st.clone(), f.clone(), o.value.clone(), value.to_string(), o.disabled);
        rows.push(
            option_row(ElementId::Name(format!("{id}-o{i}").into()), o, o.value == value, i == lit, l)
                .on_mouse_move(move |_, _, cx| {
                    if hover_st.read(cx).highlight != i {
                        set(&hover_st, cx, |p| p.highlight = i);
                    }
                })
                .on_click(move |_, window, cx| {
                    if disabled {
                        return;
                    }
                    let focus = pick_st.read(cx).focus.clone();
                    set(&pick_st, cx, |p| p.open = false);
                    window.focus(&focus, cx);
                    if v != cur {
                        f(&v, window, cx);
                    }
                })
                .into_any_element(),
        );
    }
    (rows, lit_row)
}

/// Chooses the highlighted option and closes the list, its trigger keeping focus.
fn choose(st: &Entity<Popup>, list: &[Opt], value: &str, f: &Rc<dyn Fn(&str, &mut Window, &mut App)>, window: &mut Window, cx: &mut App) {
    let lit = st.read(cx).highlight;
    let focus = st.read(cx).focus.clone();
    set(st, cx, |p| p.open = false);
    window.focus(&focus, cx);
    if let Some(o) = list.get(lit).filter(|o| !o.disabled)
        && o.value != value
    {
        f(&o.value, window, cx);
    }
}

/// One choice of a short list: its words and a ⌃⌄, lit under the pointer; its list floats at once
/// under it, grouped under small headings, the chosen one checked and highlighted as it opens.
/// ↑ ↓ move, Enter chooses, Esc closes, and typing goes to the option it starts.
pub fn select(id: impl Into<SharedString>, label: impl Into<SharedString>, options: Vec<Opt>, value: &str, on: bool, on_change: impl Fn(&str, &mut Window, &mut App) + 'static, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let id: SharedString = id.into();
    let label: SharedString = label.into();
    let st = window.use_keyed_state(ElementId::Name(format!("{id}-select").into()), cx, |_, cx| Popup::new(cx));
    let (open, lit, focus) = {
        let p = st.read(cx);
        (p.open, p.highlight, p.focus.clone())
    };
    let f: Rc<dyn Fn(&str, &mut Window, &mut App)> = Rc::new(on_change);
    let value = value.to_string();
    let list = ordered(&options);
    let at = list.iter().position(|o| o.value == value).unwrap_or(0);
    let open_at = {
        let st = st.clone();
        move |cx: &mut App| set(&st, cx, |p| {
            p.open = true;
            p.highlight = at;
            p.reveal = true;
            p.typed.clear();
        })
    };
    let (keys_st, keys_list, keys_value, keys_f, keys_open) = (st.clone(), list.clone(), value.clone(), f.clone(), open_at.clone());
    let mouse_st = st.clone();
    let dismiss_st = st.clone();
    let at = st.read(cx).trigger.clone();
    let mut el = div().relative().min_w_0().on_children_prepainted(move |b, _, _| at.set(b.first().copied())).child(
        trigger(ElementId::Name(format!("{id}-trigger").into()), open, on, &focus, &l)
            .role(gpui::Role::ComboBox)
            .aria_label(label.clone())
            .aria_expanded(open)
            .when(open, |d| d.key_context("KitFloat"))
            .children(chosen_words(&options, &value, &l))
            .child(updown(&l))
            .when(on, |d| {
                d.on_mouse_down(gpui::MouseButton::Left, move |_, window, cx| {
                    let (was, focus) = {
                        let p = mouse_st.read(cx);
                        (p.open, p.focus.clone())
                    };
                    window.focus(&focus, cx);
                    if was {
                        set(&mouse_st, cx, |p| p.open = false);
                    } else {
                        open_at(cx);
                    }
                    cx.stop_propagation();
                })
                .on_action(move |_: &Dismiss, _, cx| set(&dismiss_st, cx, |p| p.open = false))
                .on_key_down(move |e: &gpui::KeyDownEvent, window, cx| {
                    let open = keys_st.read(cx).open;
                    let key = e.keystroke.key.as_str();
                    if !open {
                        if matches!(key, "enter" | "space" | "down" | "up") {
                            keys_open(cx);
                            cx.stop_propagation();
                        }
                        return;
                    }
                    match key {
                        "down" | "up" => {
                            let lit = keys_st.read(cx).highlight;
                            let to = step_to(&keys_list, lit, if key == "down" { 1 } else { -1 });
                            set(&keys_st, cx, |p| {
                                p.highlight = to;
                                p.reveal = true;
                            });
                        }
                        "enter" | "space" => choose(&keys_st, &keys_list, &keys_value, &keys_f, window, cx),
                        "tab" => set(&keys_st, cx, |p| p.open = false),
                        _ => {
                            // Typeahead: what's typed within a moment goes to the option it starts.
                            let Some(ch) = e.keystroke.key_char.clone().filter(|c| !c.trim().is_empty()) else { return };
                            let now = std::time::Instant::now();
                            let typed = {
                                let p = keys_st.read(cx);
                                if now.duration_since(p.typed_at).as_millis() > 500 { ch.to_lowercase() } else { format!("{}{}", p.typed, ch.to_lowercase()) }
                            };
                            let hit = keys_list.iter().position(|o| !o.disabled && o.label.to_lowercase().starts_with(&typed));
                            set(&keys_st, cx, |p| {
                                p.typed = typed;
                                p.typed_at = now;
                                if let Some(i) = hit {
                                    p.highlight = i;
                                    p.reveal = true;
                                }
                            });
                        }
                    }
                    cx.stop_propagation();
                })
            }),
    );
    if open {
        let (rows, lit_row) = list_rows(&id, &list, lit.min(list.len().saturating_sub(1)), &value, true, &st, &f, &l);
        let scroll = st.read(cx).scroll.clone();
        if st.read(cx).reveal {
            st.update(cx, |p, _| p.reveal = false);
            scroll.scroll_to_item(lit_row);
        }
        let close = st.clone();
        el = el.child(deferred(
            anchored().snap_to_window_with_margin(px(8.)).offset(point(px(0.), l.z(26.))).child(
                float(&l)
                    .id(ElementId::Name(format!("{id}-list").into()))
                    .min_w(st.read(cx).trigger_w())
                    .max_h(u(360.))
                    .overflow_y_scroll()
                    .track_scroll(&scroll)
                    .py(u(4.))
                    .on_mouse_down_out(move |e, _, cx| {
                        if !close.read(cx).on_trigger(e.position) {
                            set(&close, cx, |p| p.open = false)
                        }
                    })
                    .children(rows),
            ),
        ));
    }
    el.into_any_element()
}

/// A text field: the box-less input the app uses everywhere (no border, the background's), its
/// value read through the entity. `id` keys it to its place; `start` is its first value.
pub fn field(id: impl Into<ElementId>, start: &str, placeholder: &str, window: &mut Window, cx: &mut App) -> Entity<Input> {
    let l = Look::get(cx);
    let (start, placeholder) = (start.to_string(), placeholder.to_string());
    window.use_keyed_state(id, cx, move |window, cx| {
        Input::new(
            InputOptions::default()
                .default_value(start)
                .placeholder(placeholder)
                .field_style(TextFieldStyle { text_color: Some(l.ink), placeholder_color: Some(l.ink3), caret_color: Some(l.ink), ..Default::default() }),
            window,
            cx,
        )
    })
}

/// Pick: a select for a long list, Find on top of its list, typing narrowing it; the first match
/// is highlighted, ↑ ↓ move, Enter chooses, Esc closes.
pub fn pick(id: impl Into<SharedString>, label: impl Into<SharedString>, options: Vec<Opt>, value: &str, on: bool, on_change: impl Fn(&str, &mut Window, &mut App) + 'static, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let id: SharedString = id.into();
    let label: SharedString = label.into();
    let st = window.use_keyed_state(ElementId::Name(format!("{id}-pick").into()), cx, |_, cx| Popup::new(cx));
    let (open, focus) = {
        let p = st.read(cx);
        (p.open, p.focus.clone())
    };
    let f: Rc<dyn Fn(&str, &mut Window, &mut App)> = Rc::new(on_change);
    let value = value.to_string();
    let mouse_st = st.clone();
    let key_st = st.clone();
    let opener = |st: &Entity<Popup>, cx: &mut App| set(st, cx, |p| {
        p.open = true;
        p.highlight = 0;
        p.query.clear();
        p.fresh = true;
        p.reveal = true;
    });
    let at = st.read(cx).trigger.clone();
    let mut el = div().relative().min_w_0().on_children_prepainted(move |b, _, _| at.set(b.first().copied())).child(
        trigger(ElementId::Name(format!("{id}-trigger").into()), open, on, &focus, &l)
            .role(gpui::Role::ComboBox)
            .aria_label(label.clone())
            .aria_expanded(open)
            .children(chosen_words(&options, &value, &l))
            .child(updown(&l))
            .when(on, |d| {
                d.on_mouse_down(gpui::MouseButton::Left, move |_, _, cx| {
                    if mouse_st.read(cx).open {
                        set(&mouse_st, cx, |p| p.open = false);
                    } else {
                        opener(&mouse_st, cx);
                    }
                    cx.stop_propagation();
                })
                .on_key_down(move |e: &gpui::KeyDownEvent, _, cx| {
                    if !key_st.read(cx).open && matches!(e.keystroke.key.as_str(), "enter" | "space" | "down" | "up") {
                        opener(&key_st, cx);
                        cx.stop_propagation();
                    }
                })
            }),
    );
    if open {
        let find = field(ElementId::Name(format!("{id}-find").into()), "", "Find…", window, cx);
        if st.update(cx, |p, _| std::mem::take(&mut p.fresh)) {
            // Just opened: its Find is empty and has the cursor.
            let clear = find.clone();
            window.defer(cx, move |window, cx| {
                clear.update(cx, |i, cx| {
                    i.clear(ui_sdk::kernel::ChangeOptions::default(), window, cx);
                });
            });
            let h = gpui::Focusable::focus_handle(find.read(cx), cx);
            window.focus(&h, cx);
        }
        let q = crate::palette::fold(find.read(cx).get_value().trim());
        if st.read(cx).query != q {
            // New words: the first match is highlighted again.
            let q2 = q.clone();
            set(&st, cx, |p| {
                p.query = q2;
                p.highlight = 0;
                p.reveal = true;
            });
        }
        // Its groups in the order they first come, case and accents set aside in the matching.
        let mut groups: Vec<Option<String>> = vec![];
        for o in &options {
            if !groups.contains(&o.group) {
                groups.push(o.group.clone());
            }
        }
        let shown: Vec<Opt> = groups.iter().flat_map(|g| options.iter().filter(move |o| &o.group == g)).filter(|o| q.is_empty() || crate::palette::fold(&o.label).contains(&q)).cloned().collect();
        let lit = st.read(cx).highlight.min(shown.len().saturating_sub(1));
        let (rows, lit_row) = list_rows(&id, &shown, lit, &value, true, &st, &f, &l);
        let scroll = st.read(cx).scroll.clone();
        if st.read(cx).reveal {
            st.update(cx, |p, _| p.reveal = false);
            scroll.scroll_to_item(lit_row);
        }
        let (close, keys, dismiss) = (st.clone(), st.clone(), st.clone());
        let (keys_list, keys_value, keys_f) = (shown.clone(), value.clone(), f.clone());
        let clear = find.clone();
        el = el.child(deferred(
            anchored().snap_to_window_with_margin(px(8.)).offset(point(px(0.), l.z(26.))).child(
                float(&l)
                    .id(ElementId::Name(format!("{id}-list").into()))
                    .key_context("KitFloat")
                    .min_w(st.read(cx).trigger_w().max(l.z(240.)))
                    .on_mouse_down_out(move |e, window, cx| {
                        if close.read(cx).on_trigger(e.position) {
                            return;
                        }
                        set(&close, cx, |p| p.open = false);
                        let clear = clear.clone();
                        window.defer(cx, move |window, cx| {
                            clear.update(cx, |i, cx| {
                                i.clear(ui_sdk::kernel::ChangeOptions::default(), window, cx);
                            });
                        });
                    })
                    .on_action(move |_: &Dismiss, window, cx| {
                        let focus = dismiss.read(cx).focus.clone();
                        set(&dismiss, cx, |p| p.open = false);
                        window.focus(&focus, cx);
                    })
                    .capture_key_down(move |e: &gpui::KeyDownEvent, window, cx| match e.keystroke.key.as_str() {
                        "down" | "up" if !keys_list.is_empty() => {
                            let lit = keys.read(cx).highlight;
                            let to = step_to(&keys_list, lit.min(keys_list.len() - 1), if e.keystroke.key == "down" { 1 } else { -1 });
                            set(&keys, cx, |p| {
                                p.highlight = to;
                                p.reveal = true;
                            });
                            cx.stop_propagation();
                        }
                        "enter" => {
                            choose(&keys, &keys_list, &keys_value, &keys_f, window, cx);
                            cx.stop_propagation();
                        }
                        // Tab closes it and moves on from its trigger.
                        "tab" => {
                            let focus = keys.read(cx).focus.clone();
                            set(&keys, cx, |p| p.open = false);
                            window.focus(&focus, cx);
                            if e.keystroke.modifiers.shift {
                                window.focus_prev(cx);
                            } else {
                                window.focus_next(cx);
                            }
                            cx.stop_propagation();
                        }
                        _ => {}
                    })
                    .child(div().flex().h(u(36.)).items_center().px(u(8.)).border_b(px(l.w2)).border_color(l.line2).text_size(u(13.)).child(Input::root(&find, cx).aria_label("Find").w_full()))
                    .when(shown.is_empty(), |d| d.child(ui(div()).flex().h(u(24.)).items_center().px(u(8.)).text_color(l.ink2).child("Nothing")))
                    .when(!shown.is_empty(), |d| d.child(div().id(ElementId::Name(format!("{id}-rows").into())).max_h(u(360.)).overflow_y_scroll().track_scroll(&scroll).py(u(4.)).children(rows))),
            ),
        ));
    }
    el.into_any_element()
}

/// What takes something away asks first: its key opens the question over the window, 72 down and
/// centred; Cancel, first and focused, or Esc keeps everything (a press outside does nothing); the act's own key, in the danger
/// color, goes ahead. Focus stays in it while it's open and goes back after.
pub fn confirm(id: impl Into<SharedString>, act: &str, question: &str, on: bool, on_confirm: impl Fn(&mut Window, &mut App) + 'static, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let id: SharedString = id.into();
    let st = window.use_keyed_state(ElementId::Name(format!("{id}-confirm").into()), cx, |_, cx| Popup::new(cx));
    let open = st.read(cx).open;
    let opener = st.clone();
    let mut el = div().child(press(button(ElementId::Name(format!("{id}-act").into()), Btn::Danger, on, &l), on, move |_, window, cx| {
        let cancel = opener.read(cx).cancel.clone();
        let was = window.focused(cx);
        set(&opener, cx, |p| {
            p.open = true;
            p.restore = was;
        });
        window.focus(&cancel, cx);
    }).aria_label(act.to_string()).child(act.to_string()));
    if open {
        let shut = {
            let st = st.clone();
            move |window: &mut Window, cx: &mut App| {
                let back = st.read(cx).restore.clone();
                set(&st, cx, |p| {
                    p.open = false;
                    p.restore = None;
                });
                if let Some(h) = back {
                    window.focus(&h, cx);
                }
            }
        };
        let shut = Rc::new(shut);
        let (cancel_h, go_h) = {
            let p = st.read(cx);
            (p.cancel.clone(), p.go.clone())
        };
        let (s2, s3, s4) = (shut.clone(), shut.clone(), shut.clone());
        let f = Rc::new(on_confirm);
        let (tab_cancel, tab_go) = (cancel_h.clone(), go_h.clone());
        let vs = window.viewport_size();
        el = el.child(deferred(
            anchored().position(point(px(0.), px(0.))).child(
                div()
                    .id(ElementId::Name(format!("{id}-backdrop").into()))
                    .role(gpui::Role::AlertDialog)
                    .aria_label(question.to_string())
                    .key_context("KitFloat")
                    .occlude()
                    .relative()
                    .child(crate::webview::covering())
                    .w(vs.width)
                    .h(vs.height)
                    .on_action(move |_: &Dismiss, window, cx| s2(window, cx))
                    .capture_key_down(move |e: &gpui::KeyDownEvent, window, cx| {
                        if e.keystroke.key == "tab" {
                            // Focus stays between its two keys.
                            let to = if tab_cancel.is_focused(window) { &tab_go } else { &tab_cancel };
                            window.focus(to, cx);
                            cx.stop_propagation();
                        }
                    })
                    .child(
                        sheet(320., window, &l)
                            .id(ElementId::Name(format!("{id}-sheet").into()))
                            .occlude()
                            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .child(ui(div()).flex().h(u(24.)).items_center().px(u(12.)).font_weight(FontWeight::SEMIBOLD).border_b(px(l.w1)).border_color(l.line1).child(div().min_w_0().truncate().child(question.to_string())))
                            .child(
                                div()
                                    .flex()
                                    .h(u(36.))
                                    .items_center()
                                    .justify_end()
                                    .gap(u(8.))
                                    .px(u(12.))
                                    .child(button(ElementId::Name(format!("{id}-cancel").into()), Btn::Key, true, &l).track_focus(&cancel_h).aria_label("Cancel").child("Cancel").on_click(move |_, window, cx| s3(window, cx)))
                                    .child(button(ElementId::Name(format!("{id}-go").into()), Btn::Danger, true, &l).track_focus(&go_h).aria_label(act.to_string()).child(act.to_string()).on_click(move |_, window, cx| {
                                        s4(window, cx);
                                        f(window, cx);
                                    })),
                            ),
                    ),
            ),
        ));
    }
    el.into_any_element()
}

thread_local! {
    /// A spin was drawn this frame: the beat redraws what holds it (else nothing moves).
    static SPUN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Whether a spin was drawn since the last ask, which clears it.
pub fn spun() -> bool {
    SPUN.with(|s| s.replace(false))
}

/// Loading: grey spokes on the beat (`marks.tsx`'s Spin), 12 px.
pub fn spin(step: usize, l: &Look) -> impl IntoElement {
    SPUN.with(|s| s.set(true));
    gpui::svg().path(format!("spin/{}.svg", step % 8)).flex_none().size(l.z(12.)).text_color(l.ink3)
}

thread_local! {
    /// A press landed on a control inside a strip that drags the window.
    static ON_CONTROL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// A control inside a strip that drags the window (`NO_DRAG`): a press on it is its own.
pub fn no_drag(el: Stateful<Div>) -> Stateful<Div> {
    el.on_mouse_down(gpui::MouseButton::Left, |_, _, _| ON_CONTROL.with(|c| c.set(true)))
}

/// What drags the window (the band, a window's strip, `DRAG`): a press and a move drags it, as
/// Zed's titlebar does, so a click on a control in it is still a click; a double-click zooms it.
pub fn drags(el: Stateful<Div>, key: &str, window: &mut Window, cx: &mut App) -> Stateful<Div> {
    let held = window.use_keyed_state(ElementId::Name(format!("{key}-drag").into()), cx, |_, _| false);
    let (down, moved, up) = (held.clone(), held.clone(), held);
    el.on_mouse_down(gpui::MouseButton::Left, move |e, window, cx| {
        if ON_CONTROL.with(|c| c.replace(false)) {
            return;
        }
        if e.click_count == 2 {
            window.titlebar_double_click();
        } else {
            #[cfg(feature = "shot")]
            eprintln!("drag: a press the window may be dragged by");
            down.update(cx, |h, _| *h = true);
        }
    })
    .on_mouse_move(move |e: &gpui::MouseMoveEvent, window, cx| {
        if *moved.read(cx) {
            moved.update(cx, |h, _| *h = false);
            // Only on a real drag of this press: AppKit drags the window by the event it's handling.
            if e.pressed_button == Some(gpui::MouseButton::Left) && crate::platform::appkit::left_dragging() {
                window.start_window_move();
            }
        }
    })
    .on_mouse_up(gpui::MouseButton::Left, move |_, _, cx| up.update(cx, |h, _| *h = false))
}

/// Words to copy (`select-all`, `.selectable`): a press and drag selects them, a double-click a
/// word, a triple-click all; ⌘C copies what's selected.
pub fn selectable(id: impl Into<SharedString>, text: impl Into<SharedString>, window: &mut Window, cx: &mut App) -> AnyElement {
    let id: SharedString = id.into();
    let text: SharedString = text.into();
    let key = id.clone();
    selecting(id, window, cx, move |sel, _, _| crate::select::SelText::new(ElementId::Name(format!("{key}-text").into()), (0, 0), sel, text, None).into_any_element())
}

/// Words a click selects whole (`select-all`): the pairing code.
pub fn selectable_all(id: impl Into<SharedString>, text: impl Into<SharedString>, window: &mut Window, cx: &mut App) -> AnyElement {
    let id: SharedString = id.into();
    let text: SharedString = text.into();
    let (key, len) = (id.clone(), text.len());
    let el = selecting(id.clone(), window, cx, move |sel, _, _| crate::select::SelText::new(ElementId::Name(format!("{key}-text").into()), (0, 0), sel, text, None).into_any_element());
    let sel = window.use_keyed_state(ElementId::Name(format!("{id}-sel").into()), cx, |_, cx| (crate::select::Sel::new(), cx.focus_handle())).read(cx).0.clone();
    div()
        .on_mouse_up(gpui::MouseButton::Left, move |_, window, _| {
            sel.select((0, 0), 0..len);
            window.refresh();
        })
        .child(el)
        .into_any_element()
}

/// What `build` draws (selectable words, Markdown), selectable as one: a press and drag selects,
/// ⌘C copies.
pub fn selecting(id: impl Into<SharedString>, window: &mut Window, cx: &mut App, build: impl FnOnce(&crate::select::Sel, &mut Window, &mut App) -> AnyElement) -> AnyElement {
    let id: SharedString = id.into();
    let (sel, focus) = window
        .use_keyed_state(ElementId::Name(format!("{id}-sel").into()), cx, |_, cx| (crate::select::Sel::new(), cx.focus_handle()))
        .read(cx)
        .clone();
    sel.frame();
    let (down, moved, up, copy, f) = (sel.clone(), sel.clone(), sel.clone(), sel.clone(), focus.clone());
    div()
        .id(ElementId::Name(format!("{id}-words").into()))
        .key_context("Selectable")
        .track_focus(&focus)
        .capture_any_mouse_down(move |e: &gpui::MouseDownEvent, window, cx| {
            if e.button == gpui::MouseButton::Left && !e.modifiers.shift && e.click_count == 1 {
                down.clear();
            }
            window.focus(&f, cx);
        })
        .on_mouse_move(move |e: &gpui::MouseMoveEvent, window, _| {
            if moved.drag_to(e.position) {
                window.refresh();
            }
        })
        .on_mouse_up(gpui::MouseButton::Left, move |_, window, _| {
            up.release();
            window.refresh();
        })
        .on_action(move |_: &ui_sdk::native::text_field::Copy, _, cx| {
            let t = copy.text();
            if !t.is_empty() {
                cx.write_to_clipboard(gpui::ClipboardItem::new_string(t));
            }
        })
        .child(build(&sel, window, cx))
        .into_any_element()
}

/// A tip (`parts.tsx`'s Tip): a moment (100 ms) after the pointer is over `el`, its words in a
/// hairline, centred 6 under it.
pub fn tip_under(el: Stateful<Div>, key: &str, label: impl Into<SharedString>, window: &mut Window, cx: &mut App) -> Stateful<Div> {
    tip_under_at(el, key, label, 6., window, cx)
}

/// A tip `offset` px under `el` (one inside a plate taller than itself sits lower).
pub fn tip_under_at(el: Stateful<Div>, key: &str, label: impl Into<SharedString>, offset: f32, window: &mut Window, cx: &mut App) -> Stateful<Div> {
    let l = Look::get(cx);
    let label: SharedString = label.into();
    let st = window.use_keyed_state(ElementId::Name(format!("{key}-tip").into()), cx, |_, _| (false, 0u64));
    let shown = st.read(cx).0 && !label.is_empty();
    let hover = st.clone();
    el.relative()
        .on_hover(move |over: &bool, _, cx| {
            let turn = hover.update(cx, |s, cx| {
                s.1 += 1;
                if !*over && s.0 {
                    s.0 = false;
                    cx.notify();
                }
                s.1
            });
            if *over {
                let st = hover.clone();
                cx.spawn(async move |cx| {
                    cx.background_executor().timer(std::time::Duration::from_millis(100)).await;
                    st.update(cx, |s, cx| {
                        if s.1 == turn {
                            s.0 = true;
                            cx.notify();
                        }
                    });
                })
                .detach();
            }
        })
        .when(shown, |d| {
            d.child(deferred(
                div().absolute().top_full().left_0().right_0().mt(l.z(offset)).flex().justify_center().child(
                    div()
                        .relative()
                        .child(crate::webview::covering())
                        .flex_none()
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
                        .font_weight(FontWeight::NORMAL)
                        .child(label),
                ),
            ))
        })
}
