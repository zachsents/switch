//! ⌘K (the desktop's `ui/palette.tsx` and `palette-choices.tsx`), as old Switchboard's search did:
//! spaces (archived ones too, once looked for), what was said or kept that holds the words (the
//! brain's find), and a new space by that name. ↑ ↓ move, Enter chooses, Tab on a space opens the
//! composer aimed at it, Esc closes. A new space is shown at once; if the brain says no, the
//! palette stays open with its reason.

use std::time::Duration;

use gpui::{
    AnyElement, App, AppContext, Context, ElementId, Entity, FocusHandle, Focusable, FontWeight, InteractiveElement, IntoElement,
    KeyDownEvent, MouseButton, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Task, Window,
    div, prelude::*, px,
};
use serde_json::{Value, json};
use ui_sdk::components::input::{Input, InputOptions};
use ui_sdk::kernel::ChangeOptions;

use crate::brain::{Brain, HOME};
use crate::derive::{Derived, above};
use crate::json::{gs, gu, list};
use crate::kit;
use crate::look::{Look, u};
use crate::marks;
use crate::model::model;
use crate::nav::{Nav, Page};
use crate::net::Net;
use crate::shell::Shell;
use crate::spaces::{new_space_id, warmest};

/// What the brain found that holds the words: a line, an item or a memory.
#[derive(Clone, Debug)]
pub struct Found {
    pub kind: String,
    pub id: String,
    pub space: String,
    pub seq: u64,
    pub line: String,
}

fn found_of(v: &Value) -> Vec<Found> {
    list(v)
        .iter()
        .filter(|f| matches!(gs(f, "kind").as_str(), "message" | "item" | "memory") && !gs(f, "space").is_empty())
        .map(|f| Found { kind: gs(f, "kind"), id: gs(f, "id"), space: gs(f, "space"), seq: gu(f, "seq"), line: gs(f, "line") })
        .collect()
}

#[derive(Clone)]
enum Icon {
    Ring(String),
    Hand,
    New,
}

#[derive(Clone)]
enum Go {
    Space(String, Option<u64>),
    Memory,
    /// A new space: its id, name and parent.
    Make(String, String, Option<String>),
}

#[derive(Clone)]
struct Choice {
    key: String,
    label: String,
    /// Matched too, but not shown: where it is.
    also: String,
    icon: Icon,
    go: Go,
    /// Found by the brain in what was said or kept: shown whatever the words.
    found: bool,
}

fn groups(b: &Brain, here: &str, query: &str, hits: &[Found], made: &str) -> Vec<(&'static str, Vec<Choice>)> {
    let words = query.trim();
    let space = |id: &str, name: &str| Choice {
        key: format!("s:{id}"),
        label: if id == HOME { "Home".into() } else { name.to_string() },
        also: above(b, id).iter().filter(|y| *y != HOME).filter_map(|y| b.spaces.get(y).map(|s| s.name.clone())).collect::<Vec<_>>().join(" "),
        icon: Icon::Ring(id.to_string()),
        go: Go::Space(id.to_string(), None),
        found: false,
    };
    let mut spaces: Vec<Choice> = warmest(b).into_iter().map(|x| space(&x.id, &x.name)).collect();
    if !words.is_empty() {
        spaces.extend(b.spaces.values().filter(|x| x.archived).map(|x| space(&x.id, &x.name)));
    }
    // A line goes to its place in the chat, an item to its space, a memory to Memory.
    let found: Vec<Choice> = hits
        .iter()
        .filter(|h| b.spaces.contains_key(&h.space))
        .map(|h| Choice {
            key: format!("f:{}:{}", h.kind, h.id),
            label: h.line.clone(),
            also: b.spaces.get(&h.space).map(|s| s.name.clone()).unwrap_or_default(),
            icon: if h.kind == "item" { Icon::Hand } else { Icon::Ring(h.space.clone()) },
            go: if h.kind == "memory" { Go::Memory } else { Go::Space(h.space.clone(), (h.kind == "message").then_some(h.seq)) },
            found: true,
        })
        .collect();
    let make: Vec<Choice> = if words.is_empty() {
        vec![]
    } else {
        vec![Choice {
            key: "c:new".into(),
            label: format!("New space “{words}”"),
            also: words.to_string(),
            icon: Icon::New,
            go: Go::Make(made.to_string(), words.to_string(), (here != HOME).then(|| here.to_string())),
            found: false,
        }]
    };
    let q = words.to_lowercase();
    let q = fold(&q);
    let keep = |c: &Choice| c.found || q.is_empty() || fold(&format!("{} {}", c.label, c.also)).contains(&q);
    [("Spaces", spaces), ("Found", found), ("New", make)]
        .into_iter()
        .map(|(g, items)| (g, items.into_iter().filter(keep).collect::<Vec<_>>()))
        .filter(|(_, items)| !items.is_empty())
        .collect()
}

/// Words as the find compares them: case and accents set aside (the collator's `base`).
pub fn fold(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    s.nfd().filter(|c| !unicode_normalization::char::is_combining_mark(*c)).collect::<String>().to_lowercase()
}

pub struct Palette {
    /// What had focus before it opened: it gets it back as it closes.
    restore: Option<FocusHandle>,
    /// Its list, kept scrolled to the highlight as the keys move it.
    scroll: gpui::ScrollHandle,
    reveal: bool,
    /// What the brain found for each of the words asked, and when.
    found: std::collections::HashMap<String, (std::time::Instant, Vec<Found>)>,
    input: Entity<Input>,
    /// The words the brain was last asked about, and what it found.
    settled: String,
    hits: Vec<Found>,
    asking: Task<()>,
    highlight: usize,
    error: Option<String>,
    /// The id a new space by these words takes.
    made: String,
    focus: FocusHandle,
    was_open: bool,
}

impl Palette {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let weak = cx.entity().downgrade();
        let input = cx.new(|cx| {
            Input::new(
                InputOptions::default()
                    .placeholder("Find…")
                    .field_style(kit::field_style())
                    .on_value_change(move |_, _, _, cx| {
                        weak.update(cx, |this, cx| this.typed(cx)).ok();
                    }),
                window,
                cx,
            )
        });
        // However it closes (Esc, a choice, ⌘K, a click outside), its words, finds and reason go as it
        // does, and focus goes back.
        cx.observe_in(&Shell::entity(cx), window, |this: &mut Palette, shell, window, cx| {
            if !shell.read(cx).finding && this.was_open {
                this.shut(window, cx);
            }
            cx.notify();
        })
        .detach();
        cx.observe(&model(cx), |this: &mut Palette, _, cx| {
            if this.was_open {
                cx.notify();
            }
        })
        .detach();
        Palette { restore: None, scroll: gpui::ScrollHandle::new(), reveal: false, found: Default::default(), input, settled: String::new(), hits: vec![], asking: Task::ready(()), highlight: 0, error: None, made: new_space_id(""), focus: cx.focus_handle(), was_open: false }
    }

    fn query(&self, cx: &App) -> String {
        self.input.read(cx).get_value().to_string()
    }

    /// The words changed: the highlight goes back to the first, and the brain is asked a moment
    /// after the last key.
    fn typed(&mut self, cx: &mut Context<Self>) {
        let q = self.query(cx).trim().to_string();
        self.highlight = 0;
        self.made = new_space_id(&q);
        if q == self.settled {
            cx.notify();
            return;
        }
        if q.is_empty() {
            self.settled.clear();
            self.hits.clear();
            self.asking = Task::ready(());
            cx.notify();
            return;
        }
        self.asking = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(150)).await;
            // The words settled: what was found for the last ones goes; what was found for these
            // in the last 15 s shows until the brain answers again.
            let Ok(answer) = this.update(cx, |this, cx| {
                this.settled = q.clone();
                this.hits = this.found.get(&q).filter(|(at, _)| at.elapsed() < Duration::from_secs(15)).map(|(_, h)| h.clone()).unwrap_or_default();
                cx.notify();
                cx.global::<Net>().page("find", json!({ "query": q }))
            }) else {
                return;
            };
            let got = answer.await;
            this.update(cx, |this, cx| {
                if let Ok(Ok(v)) = got {
                    let hits = found_of(&v);
                    this.found.insert(q.clone(), (std::time::Instant::now(), hits.clone()));
                    if this.settled == q {
                        this.hits = hits;
                    }
                }
                cx.notify();
            })
            .ok();
        });
        cx.notify();
    }

    fn shut(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.was_open = false;
        self.error = None;
        self.settled.clear();
        self.hits.clear();
        self.asking = Task::ready(());
        let input = self.input.clone();
        window.defer(cx, move |window, cx| {
            input.update(cx, |i, cx| {
                i.clear(ChangeOptions::default(), window, cx);
            });
        });
        if let Some(h) = self.restore.take() {
            window.focus(&h, cx);
        }
    }

    /// Closes it: however it closes (Esc, a choice, ⌘K, a click outside), its words and reason are
    /// cleared as it goes (`body`).
    fn close(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        Shell::update(cx, |s| s.finding = false);
    }

    fn choices(&self, cx: &App) -> Vec<(&'static str, Vec<Choice>)> {
        let here = crate::commands::here(cx);
        groups(&model(cx).read(cx).brain, &here, &self.query(cx), if self.query(cx).trim().is_empty() { &[] } else { &self.hits }, &self.made)
    }

    fn choose(&mut self, c: Choice, window: &mut Window, cx: &mut Context<Self>) {
        match c.go {
            Go::Space(id, at) => {
                Nav::open_at(id, at, cx);
                self.close(window, cx);
            }
            Go::Memory => {
                crate::settings::open("memory", cx);
                self.close(window, cx);
            }
            Go::Make(id, name, parent) => {
                Nav::open(Page::Space(id.clone()), cx);
                let this = cx.entity().downgrade();
                let this2 = this.clone();
                crate::spaces::create(
                    &id,
                    &name,
                    parent.as_deref(),
                    Box::new(move |cx| {
                        if let Some(p) = this.upgrade() {
                            p.update(cx, |p, cx| {
                                p.error = None;
                                Shell::update(cx, |s| s.finding = false);
                                cx.notify();
                            });
                        }
                    }),
                    Box::new(move |reason, cx| {
                        if let Some(p) = this2.upgrade() {
                            p.update(cx, |p, cx| {
                                p.error = Some(if reason.is_empty() { "Didn't go through".into() } else { reason });
                                cx.notify();
                            });
                        }
                    }),
                    cx,
                );
            }
        }
    }

    fn on_key(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let flat: Vec<Choice> = self.choices(cx).into_iter().flat_map(|(_, c)| c).collect();
        match e.keystroke.key.as_str() {
            // Tab on a space: the composer, aimed there, over wherever the window is.
            "tab" => {
                cx.stop_propagation();
                if let Some(Choice { go: Go::Space(id, None), .. }) = flat.get(self.highlight.min(flat.len().saturating_sub(1))).filter(|c| c.key.starts_with("s:")).cloned() {
                    self.close(window, cx);
                    cx.defer(move |cx| crate::composer::toggle(Some(id), cx));
                }
            }
            "down" if !flat.is_empty() => {
                self.reveal = true;
                self.highlight = (self.highlight + 1) % flat.len();
                cx.stop_propagation();
                cx.notify();
            }
            "up" if !flat.is_empty() => {
                self.reveal = true;
                self.highlight = (self.highlight + flat.len() - 1) % flat.len();
                cx.stop_propagation();
                cx.notify();
            }
            "enter" => {
                cx.stop_propagation();
                if let Some(c) = flat.get(self.highlight.min(flat.len().saturating_sub(1))).cloned() {
                    self.choose(c, window, cx);
                }
            }
            "escape" => {
                cx.stop_propagation();
                self.close(window, cx);
            }
            _ => {}
        }
    }
}

impl Focusable for Palette {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

fn icon(i: &Icon, b: &Derived, l: &Look) -> AnyElement {
    match i {
        Icon::Ring(id) => {
            let st = b.station(id);
            marks::ring(&st.code, l.ink_of(&st), l.z(18.), l.bg, l.ink, id == HOME).into_any_element()
        }
        Icon::Hand => marks::hand(l.z(14.), l).into_any_element(),
        Icon::New => div().size(l.z(18.)).rounded_full().border(l.z(2.3)).border_dashed().border_color(l.ink3).into_any_element(),
    }
}

impl Palette {
    fn body(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let open = Shell::entity(cx).read(cx).finding;
        if !open {
            if self.was_open {
                self.shut(window, cx);
            }
            return div().into_any_element();
        }
        if !self.was_open {
            self.was_open = true;
            self.highlight = 0;
            self.made = new_space_id("");
            self.restore = window.focused(cx);
            let h = self.input.read(cx).focus_handle(cx);
            window.focus(&h, cx);
        }
        let l = Look::get(cx);
        let groups = self.choices(cx);
        let total: usize = groups.iter().map(|(_, c)| c.len()).sum();
        let lit = self.highlight.min(total.saturating_sub(1));
        let derived = &model(cx).read(cx).derived;
        let mut rows: Vec<AnyElement> = vec![];
        let mut i = 0;
        let mut lit_row = 0;
        for (g, items) in &groups {
            rows.push(kit::small(div()).flex().h(u(24.)).items_center().px(u(12.)).font_weight(FontWeight::SEMIBOLD).text_color(l.ink2).child(*g).into_any_element());
            for c in items {
                let n = i;
                if n == lit {
                    lit_row = rows.len();
                }
                let chosen = c.clone();
                rows.push(
                    div()
                        .id(ElementId::Name(c.key.clone().into()))
                        .flex()
                        .h(u(24.))
                        .items_center()
                        .gap(u(8.))
                        .px(u(12.))
                        .text_size(u(13.))
                        .line_height(u(16.))
                        .when(n == lit, |d| d.bg(l.hover))
                        .on_mouse_move(cx.listener(move |this, _, _, cx| {
                            if this.highlight != n {
                                this.highlight = n;
                                cx.notify();
                            }
                        }))
                        .on_click(cx.listener(move |this, _, window, cx| this.choose(chosen.clone(), window, cx)))
                        .child(div().flex().w(u(18.)).flex_none().justify_center().child(icon(&c.icon, derived, &l)))
                        .child(div().min_w_0().truncate().child(SharedString::from(c.label.clone())))
                        .into_any_element(),
                );
                i += 1;
            }
        }
        let vh = window.viewport_size().height;
        if std::mem::take(&mut self.reveal) {
            self.scroll.scroll_to_item(lit_row);
        }
        div()
            .id("palette-backdrop")
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .occlude()
            // The backdrop covers every page: a press on one is the backdrop's.
            .child(crate::webview::covering())
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| this.close(window, cx)))
            .child(
                kit::sheet(560., window, &l)
                    .id("palette")
                    .key_context("Palette")
                    .occlude()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .capture_key_down(cx.listener(|this, e: &KeyDownEvent, window, cx| this.on_key(e, window, cx)))
                    .child(div().flex().h(u(44.)).items_center().px(u(12.)).border_b(px(l.w1)).border_color(l.line1).text_size(u(14.)).line_height(u(20.)).child(Input::root(&self.input, cx).text_color(l.ink).aria_label("Find").w_full()))
                    .when_some(self.error.clone(), |d, e| {
                        d.child(kit::small(div()).flex().h(u(24.)).items_center().px(u(12.)).text_color(l.red).border_b(px(l.w2)).border_color(l.line2).child(e))
                    })
                    .when(total == 0, |d| d.child(kit::ui(div()).flex().h(u(24.)).items_center().px(u(12.)).text_color(l.ink2).child("Nothing")))
                    .when(total > 0, |d| d.child(div().id("palette-list").max_h(l.z(420.).min(vh * 0.6)).overflow_y_scroll().track_scroll(&self.scroll).children(rows))),
            )
            .into_any_element()
    }
}

impl Render for Palette {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        crate::boundary::guard("palette", window, cx, |window, cx| self.body(window, cx).into_any_element())
    }
}
