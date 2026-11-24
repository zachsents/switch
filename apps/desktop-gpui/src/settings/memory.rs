//! Memory (the desktop's `ui/memory-page.tsx`, `memory-item.tsx`, and `brain/system.ts`'s
//! memories): what the agent remembers, by where it holds. Where (everywhere first, then each space
//! in the tree) is a list down the left; what's remembered there, rules and preferences before the
//! rest, beside it. Each opens to edit or forget. The page is the data layer's query
//! (`queries::memories`), read again after an edit or a forget.

use std::collections::{HashMap, HashSet};

use gpui::{AnyElement, App, ElementId, Focusable, InteractiveElement, IntoElement, KeyDownEvent, ParentElement, StatefulInteractiveElement, Styled, Window, div, prelude::*, px};
use ui_sdk::components::input::{Input, Textarea, TextareaOptions, TextFieldStyle};

use crate::band::tip;
use crate::brain::HOME;
use crate::kit::{self, Btn};
use crate::look::{Look, u};
use crate::marks;
use crate::model::model;
use crate::queries::{self, MemoryRow};
use crate::settings::calls::{act as run, land, mounted};
use crate::settings::parts::{data, notice};
use crate::spaces::warmest;

const GLOBAL: &str = "global";

/// Rules and preferences first, then what's known about work and where things are.
fn rank(kind: &str) -> u8 {
    match kind {
        "feedback" => 0,
        "user" => 1,
        "project" => 2,
        "reference" => 3,
        _ => 4,
    }
}

#[derive(Default)]
struct Page {
    chosen: Option<String>,
    /// The memories open to edit, and each one's acts while it's open.
    open: HashSet<String>,
    editing: HashMap<String, Acts>,
}

#[derive(Default, Clone)]
struct Acts {
    saving: bool,
    save_error: Option<String>,
    forgetting: bool,
    forget_error: Option<String>,
    focused: bool,
    /// The words a Save was refused for (one of them blank): Save is off until they change.
    refused: Option<(String, String)>,
}

fn set_open(page: &gpui::Entity<Page>, id: &str, open: bool, cx: &mut App) {
    page.update(cx, |p, cx| {
        if open {
            p.open.insert(id.to_string());
            p.editing.insert(id.to_string(), Acts::default());
        } else {
            p.open.remove(id);
            p.editing.remove(id);
        }
        cx.notify();
    });
}

fn act(page: &gpui::Entity<Page>, id: &str, cx: &mut App, f: impl FnOnce(&mut Acts)) {
    page.update(cx, |p, cx| {
        if let Some(a) = p.editing.get_mut(id) {
            f(a);
        }
        cx.notify();
    });
}

/// Where's row: its ring, its name, how many are remembered there.
fn where_row(id: &str, mark: Option<AnyElement>, name: String, count: usize, open: bool, page: &gpui::Entity<Page>, l: &Look) -> AnyElement {
    let (page, scope) = (page.clone(), id.to_string());
    kit::button(ElementId::Name(format!("where-{id}").into()), Btn::Bare, true, l)
        .h(u(24.))
        .w_full()
        .justify_start()
        .gap(u(10.))
        .px(u(8.))
        .text_size(u(13.))
        .line_height(u(16.))
        .text_color(l.ink)
        .hover(|s| s.bg(l.hover))
        .when(open, |d| d.bg(l.hover))
        .aria_selected(open)
        .on_click(move |_, _, cx| {
            page.update(cx, |p, cx| {
                // Another Where: the memories shown are new ones, every editor closed.
                if p.chosen.as_ref() != Some(&scope) {
                    p.open.clear();
                    p.editing.clear();
                }
                p.chosen = Some(scope.clone());
                cx.notify();
            })
        })
        .children(mark)
        .child(div().min_w_0().flex_1().truncate().child(name))
        .child(kit::caption(div()).flex_none().text_color(l.ink3).child(count.to_string()))
        .into_any_element()
}

/// A list's rows with a line-2 under each but the last.
fn rows(items: Vec<AnyElement>, l: &Look) -> impl IntoElement {
    let n = items.len();
    div().flex().flex_col().children(items.into_iter().enumerate().map(|(i, x)| div().when(i + 1 < n, |d| d.border_b(px(l.w2)).border_color(l.line2)).child(x)))
}

fn editor(m: &MemoryRow, acts: &Acts, page: &gpui::Entity<Page>, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let style = TextFieldStyle { text_color: Some(l.ink), placeholder_color: Some(l.ink3), caret_color: Some(l.ink), ..Default::default() };
    let line_field = kit::field(ElementId::Name(format!("memory-line-{}", m.id).into()), &m.description, "", window, cx);
    let body_start = m.body.clone();
    let body_field = window.use_keyed_state(ElementId::Name(format!("memory-body-{}", m.id).into()), cx, move |window, cx| Textarea::new(TextareaOptions::default().default_value(body_start).field_style(style), window, cx));
    if !acts.focused {
        let h = line_field.read(cx).focus_handle(cx);
        window.focus(&h, cx);
        act(page, &m.id, cx, |a| a.focused = true);
    }
    let body_now = body_field.read(cx).get_value().to_string();
    let lines = (body_now.split('\n').count() + 1).clamp(4, 14) as f32;
    let error = acts.save_error.clone().or_else(|| acts.forget_error.clone());
    let id = m.id.clone();
    let save = {
        let (page, id, line_field, body_field) = (page.clone(), id.clone(), line_field.clone(), body_field.clone());
        move |cx: &mut App| {
            let description = line_field.read(cx).get_value().to_string();
            let body = body_field.read(cx).get_value().to_string();
            if page.read(cx).editing.get(&id).is_some_and(|a| a.saving) {
                return;
            }
            if description.trim().is_empty() || body.trim().is_empty() {
                act(&page, &id, cx, |a| a.refused = Some((description, body)));
                return;
            }
            act(&page, &id, cx, |a| {
                a.saving = true;
                a.save_error = None;
            });
            let id2 = id.clone();
            let id3 = id.clone();
            run(&page, move |m, cx| m.edit_memory(&id3, &description, &body, cx), move |p, got, _| match got {
                Ok(_) => {
                    p.open.remove(&id2);
                    p.editing.remove(&id2);
                }
                Err(e) => {
                    if let Some(a) = p.editing.get_mut(&id2) {
                        a.saving = false;
                        a.save_error = Some(e);
                    }
                }
            }, cx);
        }
    };
    let enter = save.clone();
    let keys = |close_id: String, page: gpui::Entity<Page>, enter: Option<Box<dyn Fn(&mut App)>>| {
        move |e: &KeyDownEvent, _: &mut Window, cx: &mut App| match e.keystroke.key.as_str() {
            // As the desktop's: the editor closes, and Esc goes on to close Settings too.
            "escape" => set_open(&page, &close_id, false, cx),
            "enter" if enter.is_some() => {
                if let Some(f) = &enter {
                    f(cx);
                }
                cx.stop_propagation();
            }
            _ => {}
        }
    };
    let forget_on = !acts.forgetting;
    let now = (line_field.read(cx).get_value().to_string(), body_now.clone());
    let save_on = !acts.saving && acts.refused.as_ref() != Some(&now);
    div()
        .flex()
        .flex_col()
        .border_b(px(l.w1))
        .border_color(l.line1)
        .child(
            kit::ui(div())
                .flex()
                .h(u(24.))
                .items_center()
                .px(u(8.))
                .text_color(l.ink)
                .border_b(px(l.w2))
                .border_color(l.line2)
                .on_key_down(keys(id.clone(), page.clone(), Some(Box::new(enter))))
                .child(Input::root(&line_field, cx).aria_label("Line").w_full()),
        )
        .child(
            kit::read(div())
                .px(u(8.))
                .py(u(8.))
                .text_color(l.ink)
                .on_key_down(keys(id.clone(), page.clone(), None))
                .child(Textarea::root(&body_field, cx).aria_label("Body").w_full().h(u(20. * lines))),
        )
        .child(
            div()
                .flex()
                .h(u(24.))
                .items_center()
                .gap(u(10.))
                .px(u(8.))
                .when_some(error, |d, e| d.child(kit::small(div()).min_w_0().truncate().text_color(l.red).child(e)))
                .child(div().ml_auto())
                .child(kit::press(kit::button(ElementId::Name(format!("forget-{id}").into()), Btn::Key, forget_on, &l), forget_on, {
                    let (page, id) = (page.clone(), id.clone());
                    move |_, _, cx| {
                        act(&page, &id, cx, |a| {
                            a.forgetting = true;
                            a.forget_error = None;
                        });
                        let answer = model(cx).read(cx).forget(&id, &[], cx);
                        let got = async move { answer.await.unwrap_or_else(|_| Err("Can't reach the core".into())) };
                        let id2 = id.clone();
                        land(&page, got, move |p, got, _| {
                            if let Some(a) = p.editing.get_mut(&id2) {
                                a.forgetting = false;
                                a.forget_error = got.err();
                            }
                        }, cx);
                    }
                })
                .aria_label("Forget").child("Forget"))
                .child(kit::button(ElementId::Name(format!("cancel-{id}").into()), Btn::Key, true, &l).aria_label("Cancel").child("Cancel").on_click({
                    let (page, id) = (page.clone(), id.clone());
                    move |_, _, cx| set_open(&page, &id, false, cx)
                }))
                .child(kit::press(kit::button(ElementId::Name(format!("save-{id}").into()), Btn::Go, save_on, &l), save_on, move |_, _, cx| save(cx)).aria_label("Save").child("Save")),
        )
        .into_any_element()
}

pub fn render(window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let (pg, _) = mounted("memory-page", window, cx, |_| Page::default());
    let memories = queries::memories(cx);
    let all: Vec<MemoryRow> = memories.data.as_deref().cloned().unwrap_or_default();
    let (loaded, error) = (memories.data.is_some() && memories.error.is_none(), memories.error.clone());
    let mut scopes: Vec<String> = vec![];
    for m in &all {
        if !scopes.contains(&m.scope) {
            scopes.push(m.scope.clone());
        }
    }
    let mdl = model(cx);
    let md = mdl.read(cx);
    let mut order: Vec<String> = vec![HOME.to_string()];
    order.extend(warmest(&md.brain).into_iter().map(|x| x.id.clone()));
    let mut places: Vec<(String, String, usize, crate::derive::Station)> = scopes
        .iter()
        .filter(|x| *x != GLOBAL)
        .map(|x| {
            let name = md.brain.spaces.get(x).map(|s| s.name.clone()).unwrap_or_else(|| x.clone());
            let at = order.iter().position(|o| o == x).unwrap_or(order.len());
            (x.clone(), name, at, md.derived.station(x))
        })
        .collect();
    places.sort_by_key(|p| p.2);
    let count_of = |scope: &str| all.iter().filter(|m| m.scope == scope).count();
    let p = pg.read(cx);
    let chosen = p.chosen.clone().unwrap_or_else(|| GLOBAL.to_string());
    let scope = if scopes.contains(&chosen) { chosen } else { scopes.first().cloned().unwrap_or_else(|| GLOBAL.to_string()) };
    let open = p.open.clone();
    let editing = p.editing.clone();

    let mut wheres: Vec<AnyElement> = vec![];
    if scopes.iter().any(|s| s == GLOBAL) {
        wheres.push(where_row(GLOBAL, None, "Everywhere".into(), count_of(GLOBAL), scope == GLOBAL, &pg, &l));
    }
    for (id, name, _, st) in &places {
        let ring = marks::ring(&st.code, l.ink_of(st), l.z(18.), l.bg, l.ink, id == HOME).into_any_element();
        wheres.push(where_row(id, Some(ring), name.clone(), count_of(id), scope == *id, &pg, &l));
    }

    let mut here: Vec<&MemoryRow> = all.iter().filter(|m| m.scope == scope).collect();
    here.sort_by(|a, b| rank(&a.kind).cmp(&rank(&b.kind)).then_with(|| a.description.to_lowercase().cmp(&b.description.to_lowercase())));
    let items: Vec<AnyElement> = here
        .iter()
        .map(|m| {
            if open.contains(&m.id) {
                let acts = editing.get(&m.id).cloned().unwrap_or_default();
                editor(m, &acts, &pg, window, cx)
            } else {
                let (page, id) = (pg.clone(), m.id.clone());
                kit::button(ElementId::Name(format!("memory-{}", m.id).into()), Btn::Bare, true, &l)
                    .h(u(24.))
                    .w_full()
                    .justify_start()
                    .gap(u(10.))
                    .px(u(8.))
                    .text_size(u(13.))
                    .line_height(u(16.))
                    .text_color(l.ink)
                    .hover(|s| s.bg(l.hover))
                    .when(!m.body.is_empty(), |d| d.tooltip(tip(m.body.clone())))
                    .on_click(move |_, _, cx| set_open(&page, &id, true, cx))
                    .child(div().min_w_0().flex_1().truncate().child(if m.description.is_empty() { m.id.clone() } else { m.description.clone() }))
                    .when(m.uses > 0., |d| d.child(data(crate::settings::calls::num(m.uses), None, &l)))
                    .into_any_element()
            }
        })
        .collect();

    let left = kit::pane_scroll("memory-where", Some("Where"), rows(wheres, &l), window, cx);
    let right = kit::pane_scroll(
        "memory-remembered",
        Some("Remembered"),
        div()
            .flex()
            .flex_col()
            .when_some(error, |d, e| d.child(notice(e, &l)))
            .when(loaded && all.is_empty(), |d| d.child(kit::ui(div()).flex().h(u(24.)).items_center().px(u(8.)).text_color(l.ink3).child("Nothing yet")))
            .child(rows(items, &l)),
        window,
        cx,
    );
    div()
        .flex()
        .flex_1()
        .min_h_0()
        .size_full()
        .bg(l.bg)
        .child(div().w(u(180.)).flex_none().h_full().border_r(px(l.w1)).border_color(l.line1).child(left))
        .child(div().flex_1().min_w_0().h_full().child(right))
        .into_any_element()
}
