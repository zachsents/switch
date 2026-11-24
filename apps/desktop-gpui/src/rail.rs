//! A space's rail, the same on every page (the desktop's `ui/rail.tsx` and its sections): the spaces
//! inside it, as banners or rows, then Needs you and Running; each
//! only this space's own rows, a space's marks counting the spaces inside it. It scrolls as a whole,
//! in UI SDK's scroll area.

use std::collections::HashSet;

use gpui::{
    AnyElement, App, Context, ElementId, Entity, FontWeight, InteractiveElement, IntoElement, ObjectFit, ParentElement,
    Render, SharedString, StatefulInteractiveElement, Styled, StyledImage, Window, div, img, prelude::*, px,
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

pub struct Rail {
    /// Each space's rail keeps its own place.
    scrolls: std::collections::HashMap<String, Entity<ScrollArea>>,
    /// Spaces whose list of spaces inside is opened past the first few.
    more_open: HashSet<String>,
    /// A runner or a running time shows: the beat redraws it.
    live: bool,
    /// The work row under the pointer: its Stop shows at its end.
    hovered: Option<String>,
    /// Each work row's focus and its Stop's: Stop shows while either has keyboard focus too.
    focus: std::collections::HashMap<String, (gpui::FocusHandle, gpui::FocusHandle)>,
    /// Work a Stop is under way for, and work whose Stop didn't go through.
    stopping: HashSet<String>,
    stop_failed: HashSet<String>,
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
        Rail { scrolls: Default::default(), more_open: HashSet::new(), live: false, hovered: None, focus: Default::default(), stopping: HashSet::new(), stop_failed: HashSet::new(), _ticking: ticking }
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
/// Tab, Enter and Space.
fn row(id: impl Into<SharedString>, l: &Look) -> gpui::Stateful<gpui::Div> {
    focusable(bare_row(id, l), l)
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
    fn spaces(&mut self, here: &str, step: usize, l: &Look, cx: &mut Context<Self>) -> Option<AnyElement> {
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
            if banners {
                let cover = cover.as_ref().and_then(|c| Pictures::get(c, gpui::ImageFormat::Jpeg, cx).map(|i| (c, i)));
                rows.push(
                    // Its cover is its look under the pointer: it doesn't light.
                    focusable(div().id(ElementId::Name(format!("banner-{id}").into())), l)
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
                    row(format!("space-{id}"), l)
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
            rows.push(
                row("more", l)
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
        let (row_focus, stop_focus) = self.focus.entry(w.thread.clone()).or_insert_with(|| (cx.focus_handle(), cx.focus_handle())).clone();
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
                focusable(row(format!("work-{}", w.thread), l).track_focus(&row_focus), l)
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
                        .child(crate::kit::press(crate::kit::button(ElementId::Name(format!("stop-{}", w.thread).into()), crate::kit::Btn::Danger, !stopping, l).track_focus(&stop_focus), !stopping, cx.listener(move |this, _, _, cx| {
                            let thread = stop_id.clone();
                            this.stopping.insert(thread.clone());
                            this.stop_failed.remove(&thread);
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
                        })).aria_label("Stop").child("Stop")),
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
        let size = l.z(14.);
        let mut sections: Vec<AnyElement> = vec![];
        if let Some(s) = self.spaces(&here, step, &l, cx) {
            sections.push(s);
        }
        let m = model.read(cx);
        let d = &m.derived;

        let asks = d.asks.get(&here).cloned().unwrap_or_default();
        let now = now_ms();
        let ask_rows: Vec<AnyElement> = asks
            .iter()
            .map(|a| {
                let st = d.station(&a.space);
                let id = a.id.clone();
                row(format!("ask-{}", a.id), &l)
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
            run_rows.push(activity_row(a, now, step, &l));
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
fn activity_row(a: &crate::brain::Activity, now: f64, step: usize, l: &Look) -> AnyElement {
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
    row(format!("activity-{}", a.id), l)
        .aria_label(a.title.clone())
        .relative()
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
