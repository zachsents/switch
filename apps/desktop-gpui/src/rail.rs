//! A space's rail, the same on every page (the desktop's `ui/rail.tsx` and its sections): the spaces
//! inside it, as banners or rows, then Needs you and Running; each
//! only this space's own rows, a space's marks counting the spaces inside it. It scrolls as a whole,
//! in UI SDK's scroll area.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, Context, ElementId, Entity, FontWeight, InteractiveElement, IntoElement, ObjectFit, ParentElement,
    Pixels, Render, SharedString, StatefulInteractiveElement, Styled, StyledImage, Window, canvas, div, img, prelude::*, px,
};
use ui_sdk::components::scroll_area::{ScrollArea, ScrollAreaOptions, ScrollAreaOrientation};
use ui_sdk::kernel::roles::Role;

use crate::brain::HOME;
use crate::derive::Work;
use crate::look::{Look, SIGN, u};
use crate::marks;
use crate::model::model;
use crate::nav::{Beat, Nav, Page};
use crate::pictures::Pictures;
use crate::time::{age_of, now_ms, span_of};

/// How many spaces show before the rest fold.
const SHOWN: usize = 9;

/// Where each row was last drawn, by its id: the keys bring the one they move to into view.
type Places = Rc<RefCell<HashMap<String, Bounds<Pixels>>>>;

/// A row's place, kept as it's drawn.
fn placed(id: String, places: &Places) -> impl IntoElement {
    let places = places.clone();
    canvas(move |bounds, _, _| { places.borrow_mut().insert(id, bounds); }, |_, _, _, _| {}).absolute().top_0().left_0().size_full()
}

pub struct Rail {
    /// Each space's rail keeps its own place.
    scrolls: std::collections::HashMap<String, Entity<ScrollArea>>,
    /// Spaces whose list of spaces inside is opened past the first few.
    more_open: HashSet<String>,
    /// A runner or a running time shows: the beat redraws it.
    live: bool,
    /// The work row under the pointer: its Stop shows at its end.
    hovered: Option<String>,
    /// Each work row's Stop's focus: Stop shows while it or its row has keyboard focus too.
    focus: std::collections::HashMap<String, gpui::FocusHandle>,
    /// Work a Stop is under way for, and work whose Stop didn't go through.
    stopping: HashSet<String>,
    stop_failed: HashSet<String>,
    /// Each row's focus, by its id, and the rows in the order drawn: ↑ and ↓ move through them.
    handles: std::collections::HashMap<String, gpui::FocusHandle>,
    order: Vec<String>,
    /// The row with the keyboard when last drawn, and its place in the order: gone (approved,
    /// dismissed, stopped, folded away), the row now in its place takes the keyboard.
    held: Option<(String, usize)>,
    places: Places,
    /// The space whose rail was last drawn: a thread's page draws none.
    drawn: Option<String>,
    /// The asks' ages again every 30 seconds (needs-you.tsx's `now`, `useNow`).
    _ticking: gpui::Task<()>,
}

impl Rail {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe(&model(cx), |_, _, cx| cx.notify()).detach();
        cx.observe(&Nav::entity(cx), |_, _, cx| cx.notify()).detach();
        cx.observe(&Pictures::entity(cx), |_, _, cx| cx.notify()).detach();
        cx.observe(&Beat::entity(cx), |this: &mut Rail, _, cx| {
            if this.live {
                cx.notify();
            }
        })
        .detach();
        let ticking = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(std::time::Duration::from_secs(30)).await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        });
        Rail { scrolls: Default::default(), more_open: HashSet::new(), live: false, hovered: None, focus: Default::default(), stopping: HashSet::new(), stop_failed: HashSet::new(), handles: Default::default(), order: vec![], held: None, places: Default::default(), drawn: None, _ticking: ticking }
    }

    /// A row's focus, made once, and its place in the keys' order.
    fn keyed(&mut self, id: &str, cx: &mut Context<Self>) -> gpui::FocusHandle {
        self.order.push(id.to_string());
        self.handles.entry(id.to_string()).or_insert_with(|| cx.focus_handle()).clone()
    }

    /// The row with the keyboard, by its id.
    fn focused(&self, window: &Window) -> Option<String> {
        self.order.iter().find(|id| self.handles.get(*id).is_some_and(|h| h.is_focused(window))).cloned()
    }

    /// ⌘J: the keyboard to the first row of `space`'s rail, unless a row has it already (it goes
    /// back to the box).
    pub fn focus_first(&mut self, space: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.focused(window).is_some() || self.drawn.as_deref() != Some(space) {
            return false;
        }
        self.go(0, window, cx)
    }

    /// ↑ ↓: the row before or after the one with the keyboard; none has it, the first.
    fn step(&mut self, by: isize, window: &mut Window, cx: &mut Context<Self>) {
        let at = self.focused(window).and_then(|id| self.order.iter().position(|x| *x == id));
        let to = match at {
            Some(i) => (i as isize + by).clamp(0, self.order.len() as isize - 1) as usize,
            None => 0,
        };
        self.go(to, window, cx);
    }

    /// The keyboard to the row at `to` in the order, scrolled into view.
    fn go(&mut self, to: usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(id) = self.order.get(to).cloned() else { return false };
        let Some(h) = self.handles.get(&id).cloned() else { return false };
        window.focus(&h, cx);
        self.reveal(id, window, cx);
        cx.notify();
        true
    }

    /// Scrolls the rail just enough to show a row, once it's drawn where it now is.
    fn reveal(&self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(scroll) = self.drawn.as_ref().and_then(|s| self.scrolls.get(s)) else { return };
        let handle = scroll.read(cx).scroll_handle().clone();
        let places = self.places.clone();
        window.on_next_frame(move |window, _| {
            let Some(row) = places.borrow().get(&id).copied() else { return };
            let seen = handle.bounds();
            let mut at = handle.offset();
            if row.bottom() > seen.bottom() {
                at.y -= row.bottom() - seen.bottom();
            }
            if row.top() < seen.top() {
                at.y += seen.top() - row.top();
            }
            if at != handle.offset() {
                handle.set_offset(at);
                window.refresh();
            }
        });
    }

    /// After the rows are laid out: the row that had the keyboard and is gone hands it to the one
    /// now in its place (or the box, with none left); rows gone forget their focus.
    fn settle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some((id, at)) = self.held.take()
            && !self.order.contains(&id)
            && self.handles.get(&id).is_some_and(|h| h.is_focused(window))
        {
            if self.order.is_empty() {
                cx.defer_in(window, |_, window, cx| window.dispatch_action(Box::new(crate::app::ToBox), cx));
            } else {
                let to = at.min(self.order.len() - 1);
                cx.defer_in(window, move |this, window, cx| {
                    this.go(to, window, cx);
                });
            }
        }
        let order: HashSet<&String> = self.order.iter().collect();
        self.handles.retain(|id, _| order.contains(id));
        self.focus.retain(|thread, _| order.contains(&format!("work-{thread}")));
        self.places.borrow_mut().retain(|id, _| order.contains(id));
        self.held = self.focused(window).and_then(|id| self.order.iter().position(|x| *x == id).map(|i| (id, i)));
    }

    /// ⌘↵ and ⌘⌫ on a row: an ask's Approve or Dismiss, in its window (where its Undo is); a running
    /// row's Stop.
    fn act(&mut self, approve: bool, window: &Window, cx: &mut Context<Self>) {
        let Some(id) = self.focused(window) else { return };
        if let Some(ask) = id.strip_prefix("ask-") {
            crate::asks::window::open_to(ask, if approve { crate::asks::window::Then::Approve } else { crate::asks::window::Then::Dismiss }, cx);
        } else if let Some(thread) = id.strip_prefix("work-")
            && !approve
        {
            self.stop(thread.to_string(), cx);
        }
    }

    fn stop(&mut self, thread: String, cx: &mut Context<Self>) {
        if self.stopping.contains(&thread) {
            return;
        }
        self.stopping.insert(thread.clone());
        self.stop_failed.remove(&thread);
        let task = model(cx).read(cx).stop(&thread, cx);
        cx.spawn(async move |this, cx| {
            let got = task.await;
            this.update(cx, |this, cx| {
                this.stopping.remove(&thread);
                if got.is_err() {
                    this.stop_failed.insert(thread);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
}

fn heading(mark: Option<AnyElement>, label: &'static str, count: usize, l: &Look) -> gpui::Stateful<gpui::Div> {
    div()
        .id(ElementId::Name(format!("heading-{label}").into()))
        .role(gpui::Role::Heading)
        .aria_level(2)
        .aria_label(label)
        .flex()
        .flex_none()
        .items_center()
        .gap(u(9.))
        .h(u(24.))
        .px(u(14.))
        .text_size(u(11.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(l.ink2)
        .child(div().flex().flex_none().w(u(18.)).justify_center().children(mark))
        .child(div().min_w_0().truncate().child(label.to_uppercase()))
        .when(count > 0, |d| d.child(div().ml_auto().font_weight(FontWeight::NORMAL).text_color(l.ink3).child(count.to_string())))
}

use crate::kit::focusable;

/// A row's whole width and height are its click; the pointer lights only its background. It takes
/// Tab, Enter and Space, and ↑ ↓ move from it to the next.
fn row(id: impl Into<SharedString>, focus: &gpui::FocusHandle, places: &Places, l: &Look) -> gpui::Stateful<gpui::Div> {
    let id: SharedString = id.into();
    focusable(bare_row(id.clone(), l).track_focus(focus).key_context("Row"), l).relative().child(placed(id.to_string(), places))
}

fn bare_row(id: impl Into<SharedString>, l: &Look) -> gpui::Stateful<gpui::Div> {
    div()
        .id(ElementId::Name(id.into()))
        .flex()
        .items_center()
        .w_full()
        .min_w_0()
        .border_t(px(l.w2))
        .border_color(l.line2)
        .hover(|s| s.bg(l.hover))
        .active(|s| s.bg(l.hover))
}

fn quiet(l: &Look) -> gpui::Div {
    div()
        .flex()
        .items_center()
        .h(u(36.))
        .px(u(14.))
        .text_size(u(13.))
        .text_color(l.ink3)
        .border_t(px(l.w2))
        .border_color(l.line2)
        .child("Nothing")
}

impl Rail {
    fn spaces(&mut self, here: &str, step: usize, l: &Look, window: &Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let model = model(cx);
        let m = model.read(cx);
        let d = &m.derived;
        let inside = d.children.get(here)?.clone();
        if inside.is_empty() {
            return None;
        }
        let banners = match m.brain.prefs.get(&format!("space.inside:{here}")).and_then(|v| v.as_str()) {
            Some("banners") => true,
            Some("rows") => false,
            _ => here == HOME,
        };
        // What each row shows, read out of the brain before any picture is asked for.
        let rows_of: Vec<(String, String, crate::derive::Station, crate::derive::Marks, Option<String>)> = inside
            .iter()
            .filter_map(|id| {
                let s = m.brain.spaces.get(id)?;
                Some((id.clone(), s.name.clone(), d.station(id), d.marks.get(id).copied().unwrap_or_default(), s.cover.clone()))
            })
            .collect();
        let folds = inside.len() > SHOWN + 1;
        let open = self.more_open.contains(here);
        let shown: Vec<String> = if folds && !open { inside[..SHOWN].to_vec() } else { inside.clone() };
        let mut rows: Vec<AnyElement> = vec![];
        for (id, space_name, st, mk, cover) in rows_of.iter().filter(|r| shown.contains(&r.0)) {
            let ink = l.ink_of(st);
            let mk = *mk;
            self.live |= mk.running;
            let go = {
                let id = id.clone();
                move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| Nav::open(Page::Space(id.clone()), cx)
            };
            let menu = {
                let id = id.clone();
                move |_: &gpui::MouseDownEvent, window: &mut Window, cx: &mut App| crate::band::space_menu(&id, window, cx)
            };
            let name = SharedString::from(space_name.clone());
            let focus = self.keyed(&format!("space-{id}"), cx);
            // A banner's cover would hide a ring drawn under it: its ring is drawn over it.
            let ringed = focus.is_focused(window) && window.last_input_was_keyboard();
            if banners {
                let cover = cover.as_ref().and_then(|c| Pictures::get(c, gpui::ImageFormat::Jpeg, cx).map(|i| (c, i)));
                rows.push(
                    // Its cover is its look under the pointer: it doesn't light.
                    focusable(div().id(ElementId::Name(format!("banner-{id}").into())).track_focus(&focus).key_context("Row"), l)
                        .role(gpui::Role::Button)
                        .aria_label(space_name.clone())
                        .flex()
                        .items_center()
                        .w_full()
                        .min_w_0()
                        .border_t(px(l.w2))
                        .border_color(l.line2)
                        .h(u(48.))
                        .relative()
                        .overflow_hidden()
                        .justify_between()
                        .on_click(go)
                        .on_mouse_down(gpui::MouseButton::Right, menu)
                        .children(cover.map(|(_, i)| img(i).absolute().top_0().left_0().size_full().object_fit(ObjectFit::Cover)))
                        .when(ringed, |d| d.child(div().absolute().top_0().left_0().size_full().border_2().border_color(l.ink2)))
                        .child(placed(format!("space-{id}"), &self.places))
                        .child(
                            div()
                                .relative()
                                .flex()
                                .min_w_0()
                                .items_center()
                                .gap(u(8.))
                                .rounded_r(u(6.))
                                .bg(l.black)
                                .py(u(6.))
                                .pr(u(10.))
                                .pl(u(14.))
                                .text_color(l.white)
                                .child(marks::ring(&st.code, ink, l.z(18.), l.black, l.white, false))
                                .child(div().min_w_0().truncate().font_family(SIGN).font_weight(FontWeight::BOLD).text_size(u(15.)).line_height(u(18.)).pt(u(2.)).child(name.to_uppercase()))
                                .when(mk.unread, |d| d.child(marks::unread(l.white))),
                        )
                        .when(mk.running || mk.needs > 0, |r| {
                            r.child(
                                div()
                                    .relative()
                                    .mr(u(8.))
                                    .flex()
                                    .flex_none()
                                    .items_center()
                                    .gap(u(10.))
                                    .rounded(u(6.))
                                    .bg(l.black)
                                    .px(u(8.))
                                    .py(u(5.))
                                    .text_color(l.white)
                                    .when(mk.running, |d| d.child(marks::runner_mark(l.z(14.), step, l.orange)))
                                    .when(mk.needs > 0, |d| {
                                        d.child(
                                            div()
                                                .flex()
                                                .items_center()
                                                .gap(u(4.))
                                                .child(marks::hand(l.z(14.), l))
                                                .child(div().text_size(u(12.)).child(mk.needs.to_string())),
                                        )
                                    }),
                            )
                        })
                        .into_any_element(),
                );
            } else {
                rows.push(
                    row(format!("space-{id}"), &focus, &self.places, l)
                        .aria_label(space_name.clone())
                        .h(u(36.))
                        .gap(u(9.))
                        .px(u(14.))
                        .on_click(go)
                        .on_mouse_down(gpui::MouseButton::Right, menu)
                        .child(marks::ring(&st.code, ink, l.z(18.), l.bg, l.ink, false))
                        .child(
                            div()
                                .flex()
                                .flex_1()
                                .min_w_0()
                                .items_center()
                                .gap(u(8.))
                                .child(div().min_w_0().truncate().font_weight(FontWeight::MEDIUM).child(name))
                                .when(mk.unread, |d| d.child(marks::unread(l.ink))),
                        )
                        .when(mk.running, |r| r.child(marks::runner_mark(l.z(14.), step, l.orange)))
                        .when(mk.needs > 0, |r| {
                            r.child(
                                div()
                                    .flex()
                                    .flex_none()
                                    .items_center()
                                    .gap(u(4.))
                                    .child(marks::hand(l.z(14.), l))
                                    .child(div().text_size(u(11.)).text_color(l.ink2).child(mk.needs.to_string())),
                            )
                        })
                        .into_any_element(),
                );
            }
        }
        if folds {
            let here = here.to_string();
            let focus = self.keyed("more", cx);
            rows.push(
                row("more", &focus, &self.places, l)
                    .aria_label(if open { "Fewer".to_string() } else { format!("{} more", inside.len() - SHOWN) })
                    .h(u(32.))
                    .px(u(14.))
                    .text_color(l.ink2)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.more_open.remove(&here) {
                            this.more_open.insert(here.clone());
                        }
                        cx.notify();
                    }))
                    .child(if open { "Fewer".to_string() } else { format!("{} more", inside.len() - SHOWN) })
                    .into_any_element(),
            );
        }
        Some(div().flex().flex_col().child(heading(None, "Spaces", inside.len(), l)).children(rows).into_any_element())
    }

    /// A row of running work: the runner, its title and under it its stage. Under the pointer Stop
    /// shows at its end, over the row.
    fn work_row(&mut self, w: &Work, space_name: &str, here: &str, step: usize, l: &Look, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let size = l.z(14.);
        let row_focus = self.keyed(&format!("work-{}", w.thread), cx);
        let stop_focus = self.focus.entry(w.thread.clone()).or_insert_with(|| cx.focus_handle()).clone();
        let focused = row_focus.is_focused(window) || stop_focus.is_focused(window);
        let under = w.stage.clone();
        let (thread, space) = (w.thread.clone(), here.to_string());
        let hovered = self.hovered.as_deref() == Some(w.thread.as_str()) || focused;
        let (hover_id, stop_id) = (w.thread.clone(), w.thread.clone());
        let stopping = self.stopping.contains(&w.thread);
        let failed = self.stop_failed.contains(&w.thread);
        div()
            .relative()
            .child(
                row(format!("work-{}", w.thread), &row_focus, &self.places, l)
                    .key_context("Row Work")
                    .aria_label(if w.title.is_empty() { space_name.to_string() } else { w.title.clone() })
                    .min_h(u(36.))
                    .gap(u(9.))
                    .px(u(14.))
                    .py(u(7.))
                    .on_hover(cx.listener(move |this, over: &bool, _, cx| {
                        if *over {
                            this.hovered = Some(hover_id.clone());
                        } else if this.hovered.as_deref() == Some(hover_id.as_str()) {
                            this.hovered = None;
                        }
                        cx.notify();
                    }))
                    .on_click(move |_, _, cx| Nav::open(Page::Thread(thread.clone(), space.clone()), cx))
                    .child(marks::runner_mark(size, step, l.orange))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .gap(u(5.))
                            .child(div().truncate().font_weight(FontWeight::MEDIUM).child(if w.title.is_empty() { space_name.to_string() } else { w.title.clone() }))
                            .when(!under.is_empty(), |d| d.child(div().truncate().text_size(u(12.)).line_height(u(16.)).text_color(l.ink2).child(under))),
                    )
                    .child(div().flex_none().text_size(u(11.)).text_color(l.ink3).child(span_of(now_ms() - w.since))),
            )
            .when(hovered, |d| {
                d.child(
                    div()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .right_0()
                        .flex()
                        .items_center()
                        .gap(u(6.))
                        .pr(u(4.))
                        .when(failed, |d| d.child(marks::warn(l.z(14.), l)))
                        .child(crate::kit::press(crate::kit::button(ElementId::Name(format!("stop-{}", w.thread).into()), crate::kit::Btn::Danger, !stopping, l).track_focus(&stop_focus), !stopping, cx.listener(move |this, _, _, cx| this.stop(stop_id.clone(), cx))).aria_label("Stop").child("Stop")),
                )
            })
            .into_any_element()
    }
}

impl Rail {
    fn body(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = Look::get(cx);
        // A space not yet known shows Home's, once the log has said so.
        let here = crate::commands::here(cx);
        let step = Beat::step(cx);
        let model = model(cx);
        self.live = false;
        self.order.clear();
        let size = l.z(14.);
        let mut sections: Vec<AnyElement> = vec![];
        if let Some(s) = self.spaces(&here, step, &l, window, cx) {
            sections.push(s);
        }
        let m = model.read(cx);
        let d = &m.derived;

        let asks = d.asks.get(&here).cloned().unwrap_or_default();
        let now = now_ms();
        let ask_focus: Vec<gpui::FocusHandle> = asks.iter().map(|a| self.keyed(&format!("ask-{}", a.id), cx)).collect();
        let m = model.read(cx);
        let d = &m.derived;
        let ask_rows: Vec<AnyElement> = asks
            .iter()
            .zip(&ask_focus)
            .map(|(a, focus)| {
                let st = d.station(&a.space);
                let id = a.id.clone();
                row(format!("ask-{}", a.id), focus, &self.places, &l)
                    .aria_label(a.title.clone())
                    .h(u(44.))
                    .gap(u(9.))
                    .px(u(14.))
                    .on_click(move |_, _, cx| crate::asks::window::open(&id, cx))
                    .child(marks::ring(&st.code, l.ink_of(&st), l.z(18.), l.bg, l.ink, a.space == HOME))
                    .child(div().flex_1().min_w_0().truncate().font_weight(FontWeight::SEMIBOLD).child(a.title.clone()))
                    .child(div().id(ElementId::Name(format!("ask-at-{}", a.id).into())).flex_none().text_size(u(11.)).text_color(l.ink3).tooltip(crate::band::tip(crate::time::when_of(a.at))).child(age_of(now - a.at)))
                    .into_any_element()
            })
            .collect();
        sections.push(
            div()
                .flex()
                .flex_col()
                .child(heading(Some(marks::hand(size, &l).into_any_element()), "Needs you", asks.len(), &l))
                .children(ask_rows)
                .when(asks.is_empty(), |d| d.child(quiet(&l)))
                .into_any_element(),
        );

        let space_name = m.brain.spaces.get(&here).map(|s| s.name.clone()).unwrap_or_default();
        let running = d.running.get(&here).cloned().unwrap_or_default();
        let activities: Vec<crate::brain::Activity> = crate::derive::activities(&m.brain, &here).into_iter().cloned().collect();
        let count = running.len() + activities.len();
        self.live |= count > 0;
        let mut run_rows: Vec<AnyElement> = running.iter().map(|w| self.work_row(w, &space_name, &here, step, &l, window, cx)).collect();
        for a in &activities {
            let focus = self.keyed(&format!("activity-{}", a.id), cx);
            run_rows.push(activity_row(a, &focus, &self.places, now, step, &l));
        }
        sections.push(
            div()
                .flex()
                .flex_col()
                .child(heading(
                    Some(if count > 0 { marks::runner_mark(size, step, l.orange).into_any_element() } else { marks::rested(size, &l).into_any_element() }),
                    "Running",
                    count,
                    &l,
                ))
                .children(run_rows)
                .when(count == 0, |d| d.child(quiet(&l)))
                .into_any_element(),
        );

        self.drawn = Some(here.clone());
        self.settle(window, cx);
        let count = sections.len();
        let body = div().flex().flex_col().children(sections.into_iter().enumerate().map(|(i, s)| {
            div().when(i > 0, |d| d.border_t(px(l.w_section)).border_color(l.line_section)).child(s)
        }));
        let _ = count;
        let scroll = match self.scrolls.get(&here) {
            Some(s) => s.clone(),
            None => {
                let s = cx.new(|cx| ScrollArea::new(ScrollAreaOptions::default(), window, cx));
                self.scrolls.insert(here.clone(), s.clone());
                s
            }
        };
        let thumb = ScrollArea::thumb(&scroll, ScrollAreaOrientation::Vertical, cx).w_full().rounded_full().bg(l.ink3.opacity(0.5));
        let bar = ScrollArea::scrollbar(&scroll, ScrollAreaOrientation::Vertical, cx)
            .w(px(8.))
            .p(px(2.))
            .with(|el, state| el.opacity(if state.visible { 1. } else { 0. }))
            .child(thumb);
        ScrollArea::root(&scroll, cx)
            .key_context("Rail")
            .on_action(cx.listener(|this, _: &crate::commands::NextRow, window, cx| this.step(1, window, cx)))
            .on_action(cx.listener(|this, _: &crate::commands::PreviousRow, window, cx| this.step(-1, window, cx)))
            .on_action(cx.listener(|this, _: &crate::commands::Approve, window, cx| this.act(true, window, cx)))
            .on_action(cx.listener(|this, _: &crate::commands::Dismiss, window, cx| this.act(false, window, cx)))
            // Esc from a row: back to the box.
            .on_action(cx.listener(|this, _: &crate::commands::Escape, window, cx| {
                if this.focused(window).is_some() {
                    window.dispatch_action(Box::new(crate::app::ToBox), cx);
                } else {
                    cx.propagate();
                }
            }))
            .size_full()
            .relative()
            .child(
                ScrollArea::viewport(&scroll, cx)
                    .aria_role(Role::Navigation)
                    .aria_label("Left sidebar")
                    .size_full()
                    .child(ScrollArea::content(&scroll, cx).w_full().child(body)),
            )
            .child(bar)
    }
}

impl Render for Rail {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        crate::boundary::guard("rail", window, cx, |window, cx| self.body(window, cx).into_any_element())
    }
}

/// An extension's long job on Running: its state's mark, its title, its line, when it ends or how far
/// along it is, and that as a bar along the row's foot. The row opens its space.
fn activity_row(a: &crate::brain::Activity, focus: &gpui::FocusHandle, places: &Places, now: f64, step: usize, l: &Look) -> AnyElement {
    use crate::brain::ActivityState;
    let size = l.z(14.);
    let space = a.space.clone();
    let mark = match a.state {
        ActivityState::Needs => marks::hand(size, l).into_any_element(),
        ActivityState::Failed => marks::stop(size, l).into_any_element(),
        _ => marks::runner_mark(size, step, l.orange).into_any_element(),
    };
    let data = match (a.ends_at, a.progress) {
        (Some(end), _) if end > now => Some(crate::time::span_to_minute(end - now)),
        (None, Some(p)) => Some(format!("{}%", (p * 100.).round() as i64)),
        _ => None,
    };
    row(format!("activity-{}", a.id), focus, places, l)
        .aria_label(a.title.clone())
        .h(u(36.))
        .gap(u(9.))
        .px(u(14.))
        .on_click(move |_, _, cx| Nav::open(Page::Space(space.clone()), cx))
        .child(mark)
        .child(div().flex_1().min_w_0().truncate().font_weight(FontWeight::MEDIUM).child(a.title.clone()))
        .when(!a.line.is_empty(), |d| d.child(div().flex_none().max_w(gpui::relative(0.4)).truncate().text_size(u(12.)).line_height(u(16.)).text_color(l.ink2).child(a.line.clone())))
        .when_some(data, |d, t| d.child(div().ml_auto().pl(u(12.)).flex_none().text_size(u(11.)).line_height(u(14.)).text_color(l.ink2).child(t)))
        .when_some(a.progress, |d, p| d.child(div().absolute().bottom_0().left_0().h(l.z(2.)).w(gpui::relative(p.clamp(0., 1.) as f32)).bg(l.orange)))
        .into_any_element()
}
