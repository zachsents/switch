//! One said thing, as iMessage's (the desktop's `ui/chat.tsx`'s Said, `said-replies.tsx`,
//! `said-bar.tsx`'s bar, `use-bubble.ts`, `use-copy.ts`): a bubble, the user's on the right in their
//! ink and the agent's on the left in gray, the last of a run with its tail. Over its words what it
//! replies to, inset, each with the user's reply under it (a click goes to it); on its words the
//! reactions to words of it, each underlined in its badge's color with the badge at their end; on
//! its corner its tapbacks. The user's words are plain and clamped to six lines (a click reads them
//! whole); the agent's are Markdown, clamped to a screen's worth, with More for the rest or its
//! detail, both in a reading window. Beside it under the pointer: when it was said, by which model,
//! and Copy. Over its words the I-beam, off them the arrow; a double-click off them, or a
//! right-click anywhere on it, opens its tapbacks.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, App, Bounds, ClipboardItem, Hsla, InteractiveElement, IntoElement, MouseButton, ParentElement,
    Pixels, Point, SharedString, StatefulInteractiveElement, Styled, Visibility, WeakEntity, Window, div, prelude::*,
    px, relative, svg,
};

use crate::brain::{PartReaction, Reactions, Reply, Who};
use crate::chat_marks;
use crate::kit::{self, Btn};
use crate::look::{Look, u};
use crate::markdown::{self, Ctx, Doc, OnLink, OnPicture};
use crate::marks;
use crate::model::model;
use crate::nav::Nav;
use crate::select::Sel;
use crate::tapback::{self, ReactMenu, Target};
use crate::time::{stamp_of, when_of};

/// How long Copy's tick holds after a copy.
const COPIED_MS: u64 = 1200;

/// A reaction badge's place at the end of words reacted to, and the lines it underlines, all from
/// the bubble's corner.
#[derive(Clone, Debug, PartialEq)]
pub struct Mark {
    pub part: PartReaction,
    pub lines: Vec<Bounds<Pixels>>,
    pub end: Point<Pixels>,
}

/// What every bubble in a column shares: its selection, where each bubble was laid out (its
/// tapbacks open over it), which words ran past their clamp, where reactions to words sit, Copy's
/// tick, the links' and pictures' handlers, and the reactions menu.
#[derive(Clone)]
pub struct Shared {
    pub sel: Sel,
    pub bubbles: Rc<RefCell<HashMap<u64, Bounds<Pixels>>>>,
    pub clamped: Rc<RefCell<HashMap<String, bool>>>,
    pub marks: Rc<RefCell<HashMap<u64, Vec<Mark>>>>,
    pub copied: Rc<RefCell<Option<(String, Instant)>>>,
    /// What's under the pointer, by line: its bubble or the bar beside it (the bar shows for either).
    pub hovered: Rc<RefCell<std::collections::HashSet<(String, bool)>>>,
    /// Where each line and its bar were last drawn: one the column scrolled from under a still
    /// pointer isn't under it any more, though no move said so.
    pub drawn: Rc<RefCell<HashMap<(String, bool), Bounds<Pixels>>>>,
    /// Each bar's Copy, by line: the bar stays while it has the keyboard.
    pub focus: Rc<RefCell<HashMap<String, gpui::FocusHandle>>>,
    /// Where each blip was last drawn, for its popover.
    pub blips: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    pub on_link: OnLink,
    pub on_picture: OnPicture,
    pub menu: Option<WeakEntity<ReactMenu>>,
    /// The chat it's in, and its name (a reading window's title).
    pub space: String,
    pub title: String,
}

impl Shared {
    /// A line's Copy focus, made once.
    pub fn focus_of(&self, key: &str, cx: &App) -> gpui::FocusHandle {
        self.focus.borrow_mut().entry(key.to_string()).or_insert_with(|| cx.focus_handle().tab_stop(true)).clone()
    }

    /// The focus of one of a line's other keys (a reply over it, its clamped words), made once.
    pub fn focus_in(&self, key: &str, part: &str, cx: &App) -> gpui::FocusHandle {
        self.focus_of(&format!("{key}#{part}"), cx)
    }

    /// Whether one of a line's keys has the focus: its bar shows, as `focus-within` shows it.
    pub fn within(&self, key: &str, window: &Window) -> bool {
        let inner = format!("{key}#");
        self.focus.borrow().iter().any(|(k, f)| (k == key || k.starts_with(&inner)) && f.is_focused(window))
    }

    pub fn new(space: String, title: String, menu: Option<WeakEntity<ReactMenu>>) -> Self {
        Shared {
            sel: Sel::new(),
            bubbles: Default::default(),
            clamped: Default::default(),
            marks: Default::default(),
            copied: Default::default(),
            hovered: Default::default(),
            drawn: Default::default(),
            blips: Default::default(),
            focus: Default::default(),
            on_link: crate::chat::on_link(),
            on_picture: crate::chat::on_picture(),
            menu,
            space,
            title,
        }
    }
}

/// One said thing.
pub struct Said<'a> {
    pub who: Who,
    pub ink: Hsla,
    pub text: &'a str,
    /// A reply's longer version, opened from More.
    pub detail: Option<&'a str>,
    pub dim: bool,
    pub streaming: bool,
    /// When it was said, with its seq once it's in the log: the bar beside it under the pointer.
    pub time: Option<f64>,
    pub seq: Option<u64>,
    /// The last of its run: it has the tail.
    pub tail: bool,
    pub reactions: Option<&'a Reactions>,
    /// What it replies to, inset at its top; `here` is the chat it's in.
    pub reply_to: &'a [Reply],
    pub here: Option<&'a str>,
    /// Reactions to words of it.
    pub parts: &'a [PartReaction],
    /// The display name of the model that wrote it, beside its time.
    pub model: Option<&'a str>,
    /// Its entry's key, and its place in the column's order.
    pub key: &'a str,
    pub order: u64,
    /// The agent's words, read once.
    pub doc: Option<Rc<Doc>>,
    /// The column's width, for the room the bar beside it takes.
    pub width: Option<Pixels>,
}

/// The tail, on a bubble's bottom corner: it fills the corner and curls out past the edge.
pub fn tail(right: bool, color: Hsla) -> gpui::Svg {
    let s = svg().path(if right { "tail/right.svg" } else { "tail/left.svg" }).absolute().bottom_0().w(px(24.)).h(px(18.)).text_color(color);
    if right { s.right(px(-6.)) } else { s.left(px(-6.)) }
}

/// A line whole: its words, then its detail when it has one.
pub fn whole_of(text: &str, detail: Option<&str>) -> String {
    match detail {
        Some(d) if !d.is_empty() => format!("{text}\n\n{d}"),
        _ => text.to_string(),
    }
}

/// Copy, and its tick a moment after.
fn copy_mark(copied: bool, l: &Look) -> gpui::Svg {
    chat_marks::drawn(if copied { "copied" } else { "copy" }, px(14.), l.ink2)
}

/// What a bubble replies to, inset at its top in order, each with the user's reply to it under it.
fn reply_insets(replies: &[Reply], right: bool, here: &str, words: bool, key: &str, order: u64, sh: &Shared, l: &Look, window: &Window, cx: &App) -> AnyElement {
    let m = model(cx).read(cx);
    let mut n = 0u32;
    div()
        .mt(px(2.))
        .flex()
        .flex_col()
        .gap(u(6.))
        .when(words, |d| d.mb(u(6.)))
        .children(replies.iter().enumerate().map(|(i, r)| {
            let inset_bg = if right { l.black.opacity(0.2) } else { l.ink.opacity(0.08) };
            let inset_ink = if right { l.white.opacity(0.9) } else { l.ink2 };
            let here = here.to_string();
            let body: AnyElement = match r {
                Reply::Quote { text, .. } => {
                    n += 1;
                    div()
                        .border_l_2()
                        .border_color(if right { l.white.opacity(0.6) } else { l.ink3 })
                        .pl(u(8.))
                        .line_clamp(3)
                        .text_ellipsis()
                        .child(markdown::plain(text, format!("{key}.q{i}"), (order, n), &sh.sel))
                        .into_any_element()
                }
                Reply::Ask { id, title, .. } => {
                    let item = m.brain.items.find(id);
                    let name = item.map(|it| it.title.clone()).or_else(|| title.clone()).unwrap_or_default();
                    let space = item.map(|it| m.brain.spaces.get(&it.space).map(|s| s.name.clone()).unwrap_or_default()).unwrap_or_default();
                    div()
                        .flex()
                        .min_w_0()
                        .items_center()
                        .gap(u(6.))
                        .child(marks::hand(px(12.), l))
                        .child(div().min_w_0().truncate().child(name))
                        .when(!space.is_empty(), |d| d.child(div().flex_none().opacity(0.7).child(space)))
                        .into_any_element()
                }
            };
            let go = r.clone();
            let reply = r.reply().trim().to_string();
            n += 1;
            let reply_key = (order, n);
            div()
                .flex()
                .flex_col()
                .min_w_0()
                .gap(u(4.))
                .child(
                    keyed(div().id(SharedString::from(format!("{key}.inset{i}"))), &sh.focus_in(key, &format!("inset{i}"), cx), px(10.), l, window)
                        .mx(u(-6.))
                        .min_w_0()
                        .rounded(px(10.))
                        .px(u(8.))
                        .py(u(4.))
                        .text_size(u(12.))
                        .line_height(u(16.))
                        .bg(inset_bg)
                        .text_color(inset_ink)
                        .cursor_pointer()
                        .on_click(move |_, window, cx| match &go {
                            Reply::Quote { seq, .. } => Nav::open_at(here.clone(), Some(*seq), cx),
                            Reply::Ask { id, .. } => window.dispatch_action(Box::new(crate::commands::OpenItem(id.clone())), cx),
                        })
                        .child(body),
                )
                .when(!reply.is_empty(), |d| d.child(div().whitespace_normal().child(markdown::plain(&reply, format!("{key}.r{i}"), reply_key, &sh.sel))))
        }))
        .into_any_element()
}

/// The reactions on a bubble's words: each underlined in its badge's color, the badge at their end.
fn part_marks(seq: u64, right: bool, ink: Hsla, sh: &Shared, l: &Look) -> Vec<AnyElement> {
    let held = sh.marks.borrow().get(&seq).cloned().unwrap_or_default();
    let color = |p: &PartReaction| match (right, p.user) {
        (true, true) => l.white,
        (true, false) => l.bubble,
        (false, true) => ink,
        (false, false) => l.ink3,
    };
    held.iter()
        .flat_map(|m| {
            let c = color(&m.part);
            let mut out: Vec<AnyElement> = m.lines.iter().map(|b| div().absolute().left(b.left()).top(b.bottom() - px(1.)).w(b.size.width).h(px(2.)).bg(c).into_any_element()).collect();
            out.push(div().absolute().left(m.end.x - px(4.)).top(m.end.y - px(12.)).child(tapback::badge(&m.part.reaction, m.part.user, ink, true, l)).into_any_element());
            out
        })
        .collect()
}

/// Measures where each reaction to words sits, after the words are laid out: a change draws again.
fn measure_parts(seq: u64, order: u64, parts: Vec<PartReaction>, sh: Shared) -> impl IntoElement {
    gpui::canvas(
        move |bounds, window, _| {
            let marks: Vec<Mark> = parts
                .iter()
                .filter_map(|p| {
                    let (lines, end) = sh.sel.find(order, &p.text);
                    let end = end?;
                    let off = |b: Bounds<Pixels>| Bounds::new(b.origin - bounds.origin, b.size);
                    Some(Mark { part: p.clone(), lines: lines.into_iter().map(off).collect(), end: end - bounds.origin })
                })
                .collect();
            let mut held = sh.marks.borrow_mut();
            if held.get(&seq) != Some(&marks) {
                held.insert(seq, marks);
                window.refresh();
            }
        },
        |_, _, _, _| {},
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// The bar beside a bubble: when it was said, by which model, and Copy. Only under the pointer.
/// Notes the pointer over a line's bubble (`bar` false) or its bar, and draws again.
fn hover(sh: &Shared, key: &str, bar: bool) -> impl Fn(&bool, &mut Window, &mut App) + 'static {
    let (held, key) = (sh.hovered.clone(), key.to_string());
    move |over: &bool, window: &mut Window, _: &mut App| {
        let mut h = held.borrow_mut();
        if *over {
            h.insert((key.clone(), bar));
        } else {
            h.remove(&(key.clone(), bar));
        }
        window.refresh();
    }
}

/// Records where a line (or its bar) is drawn, each frame.
fn drawn_at(sh: &Shared, key: &str, bar: bool) -> impl IntoElement {
    let (drawn, hovered, k) = (sh.drawn.clone(), sh.hovered.clone(), (key.to_string(), bar));
    gpui::canvas(
        move |b, window, _| {
            // Moved while it's held under the pointer: drawn again, to say whether it still is.
            if drawn.borrow_mut().insert(k.clone(), b).is_some_and(|was| was != b) && hovered.borrow().contains(&k) {
                window.refresh();
            }
        },
        |_, _, _, _| {},
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

fn said_bar(time: f64, model: Option<&str>, text: String, right: bool, key: &str, sh: &Shared, l: &Look, window: &Window, cx: &mut App) -> AnyElement {
    let copied = sh.copied.borrow().as_ref().is_some_and(|(k, at)| k == key && at.elapsed() < Duration::from_millis(COPIED_MS));
    let (who_copied, k) = (sh.copied.clone(), key.to_string());
    let stamp = div().id(SharedString::from(format!("{key}.stamp"))).px(u(4.)).child(stamp_of(time)).tooltip(crate::band::tip(when_of(time)));
    let focus = sh.focus_of(key, cx);
    let focused = sh.within(key, window);
    let copy = kit::button(SharedString::from(format!("{key}.copy")), Btn::Flat, true, l).track_focus(&focus).aria_label("Copy").size(u(28.)).p(u(6.)).tooltip(crate::band::tip(if copied { "Copied" } else { "Copy" }))
        .on_click(move |_, window, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
            *who_copied.borrow_mut() = Some((k.clone(), Instant::now()));
            window.refresh();
            let w = window.window_handle();
            cx.spawn(async move |cx| {
                cx.background_executor().timer(Duration::from_millis(COPIED_MS)).await;
                w.update(cx, |_, window, _| window.refresh()).ok();
            })
            .detach();
        })
        .child(copy_mark(copied, l));
    let mut row = div()
        .flex()
        .h(u(28.))
        .items_center()
        .gap(u(4.))
        .text_size(u(11.))
        .line_height(u(14.))
        .whitespace_nowrap()
        .text_color(l.ink2)
        .child(stamp)
        .when_some(model, |d, m| d.child(div().px(u(4.)).child(m.to_string())))
        .child(copy);
    if right {
        row = row.flex_row_reverse();
    }
    // The bubble's whole height, the gap beside it and a margin past Copy: the pointer crossing from
    // the bubble to Copy, straight or slanting, or overshooting it, never leaves it.
    let at = window.mouse_position();
    let drawn = sh.drawn.borrow();
    let shown = focused || sh.hovered.borrow().iter().any(|h| h.0 == key && drawn.get(h).is_none_or(|b| b.contains(&at)));
    drop(drawn);
    let mut bar = div()
        .id(SharedString::from(format!("{key}.bar")))
        .absolute()
        .top_0()
        .bottom_0()
        .flex()
        .items_end()
        .map(|d| if right { d.right(relative(1.)).pr(u(6.)).pl(u(28.)) } else { d.left(relative(1.)).pl(u(6.)).pr(u(28.)) })
        .on_hover(hover(sh, key, true))
        .child(row)
        .child(drawn_at(sh, key, true));
    if !shown {
        bar.style().visibility = Some(Visibility::Hidden);
    }
    bar.into_any_element()
}

/// Opens the reactions menu over a bubble.
fn open_menu(sh: &Shared, seq: u64, mine: Option<String>, window: &mut Window, cx: &mut App) {
    let Some(menu) = sh.menu.as_ref().and_then(|m| m.upgrade()) else { return };
    let Some(anchor) = sh.bubbles.borrow().get(&seq).copied() else { return };
    let space = sh.space.clone();
    menu.update(cx, |m, cx| m.open(Target { seq, space, quote: None, mine, anchor }, window, cx));
    // The search keeps the focus it took: the column's press doesn't take it back.
    window.prevent_default();
}

/// A press that takes Tab, Enter and Space, as the desktop's buttons do; its ring, drawn over it,
/// changes no layout.
pub fn keyed(d: gpui::Stateful<gpui::Div>, focus: &gpui::FocusHandle, radius: Pixels, l: &Look, window: &Window) -> gpui::Stateful<gpui::Div> {
    let ring = focus.is_focused(window) && window.last_input_was_keyboard();
    d.track_focus(focus).relative().when(ring, |d| d.child(div().absolute().inset_0().rounded(radius).border_1().border_color(l.ink3)))
}

/// A focus kept for the element `id` names, for `keyed`.
pub fn focus_for(id: impl Into<gpui::ElementId>, window: &mut Window, cx: &mut App) -> gpui::FocusHandle {
    window.use_keyed_state(id, cx, |_, cx| cx.focus_handle().tab_stop(true)).read(cx).clone()
}

pub fn said(p: Said, sh: &Shared, l: &Look, window: &mut Window, cx: &mut App) -> AnyElement {
    let right = p.who == Who::User;
    let key = p.key.to_string();
    // Drawn anew (scrolled back to): the pointer it had when it went is gone with it.
    let held = sh.hovered.clone();
    let k = key.clone();
    window.use_keyed_state(SharedString::from(format!("{key}.mounted")), cx, move |_, _| held.borrow_mut().retain(|(h, _)| *h != k));
    let reacted = p.reactions.is_some_and(Reactions::any);
    let has_words = !p.text.is_empty();
    // The user's words: plain, clamped to a few lines; a click reads them whole.
    let words: AnyElement = if right {
        let clamped = sh.sel.clamped((p.order, crate::select::WORDS));
        let (title, text, sel) = (sh.title.clone(), p.text.to_string(), sh.sel.clone());
        let words = div().id(SharedString::from(format!("{key}.words")));
        let words = if clamped { keyed(words, &sh.focus_in(&key, "words", cx), px(4.), l, window) } else { words };
        words
            .whitespace_normal()
            .line_clamp(6)
            .text_ellipsis()
            .when(clamped, |d| {
                d.cursor_pointer().on_click(move |_, _, cx| {
                    if sel.is_empty() {
                        crate::chat_platform::read(&title, &text, cx);
                    }
                })
            })
            .child(markdown::plain(p.text, format!("{key}.u"), (p.order, crate::select::WORDS), &sh.sel).pointer(clamped))
            .into_any_element()
    } else {
        // The agent's words as Markdown: its detail, or past a screen's worth, opens from More.
        let doc = p.doc.clone().unwrap_or_else(|| Rc::new(Doc::of(p.text)));
        let ctx = Ctx { id: key.clone(), order: p.order, sel: sh.sel.clone(), on_link: sh.on_link.clone(), on_picture: sh.on_picture.clone(), ink: None, cell: false, pictures: Default::default() };
        let md = markdown::render(&doc, &ctx, l, window, cx);
        let max = l.z(24. * 20.);
        let clamped = sh.clamped.borrow().get(&key).copied().unwrap_or(false);
        let more = p.detail.is_some_and(|d| !d.is_empty()) || clamped;
        let (record, k) = (sh.clamped.clone(), key.clone());
        let (title, whole) = (sh.title.clone(), whole_of(p.text, p.detail));
        div()
            .flex()
            .flex_col()
            .min_w_0()
            .child(
                div()
                    .min_w_0()
                    .when(!p.streaming, |d| d.max_h(max).overflow_hidden())
                    .on_children_prepainted(move |bounds, window, _| {
                        let over = bounds.first().is_some_and(|b| b.size.height > max + px(1.));
                        let mut held = record.borrow_mut();
                        if held.get(&k) != Some(&over) {
                            held.insert(k.clone(), over);
                            window.refresh();
                        }
                    })
                    .child(md),
            )
            .when(more && !p.streaming, |d| {
                d.child(
                    kit::button(SharedString::from(format!("{key}.more")), Btn::Flat, true, l)
                        .mt(px(2.))
                        .ml(u(-6.))
                        .self_start()
                        .text_color(l.ink)
                        .on_click(move |_, _, cx| crate::chat_platform::read(&title, &whole, cx))
                        .aria_label("More").child("More"),
                )
            })
            .into_any_element()
    };
    let color = if right { p.ink } else { l.bubble };
    let seq = p.seq;
    let bubbles = sh.bubbles.clone();
    let mut bubble = div()
        .id(SharedString::from(format!("{key}.bubble")))
        .relative()
        .max_w_full()
        .min_w_0()
        .rounded(u(18.))
        .px(u(12.))
        .py(u(6.))
        .text_size(u(14.))
        .line_height(u(20.))
        .bg(color)
        .text_color(if right { l.white } else { l.ink })
        .when(p.dim, |d| d.opacity(0.6))
        .when(p.tail, |d| d.child(tail(right, color)))
        .when(!p.reply_to.is_empty() && p.here.is_some(), |d| d.child(reply_insets(p.reply_to, right, p.here.unwrap_or_default(), has_words, &key, p.order, sh, l, window, cx)))
        .when(has_words, |d| d.child(words))
        .child(gpui::canvas(
            move |b, _, _| {
                if let Some(s) = seq {
                    bubbles.borrow_mut().insert(s, b);
                }
            },
            |_, _, _, _| {},
        ).absolute().top_0().left_0().size_full());
    if let Some(s) = seq {
        if !p.parts.is_empty() {
            bubble = bubble.child(measure_parts(s, p.order, p.parts.to_vec(), sh.clone())).children(part_marks(s, right, p.ink, sh, l));
        }
        let mine = p.reactions.and_then(|r| r.user.clone());
        let (sh1, sh2, mine1, mine2) = (sh.clone(), sh.clone(), mine.clone(), mine);
        bubble = bubble
            .on_mouse_down(MouseButton::Right, move |_, window, cx| open_menu(&sh1, s, mine1.clone(), window, cx))
            .on_mouse_down(MouseButton::Left, move |e, window, cx| {
                // A second press off the words is the whole message's; a Control-click is a
                // right-click.
                if e.modifiers.control || e.click_count == 2 && sh2.sel.is_empty() {
                    open_menu(&sh2, s, mine2.clone(), window, cx);
                }
            });
    }
    if reacted && let Some(r) = p.reactions {
        bubble = bubble.child(tapback::badges(r, right, p.ink, l));
    }
    // Three quarters of the column, less the room its time, model and buttons take beside it.
    // In points, on the bubble too: a share of the column (`75%`, `max-w-full`) isn't resolved yet
    // when Taffy takes a bubble's height, which it then takes at the column's whole width, and the
    // next line overlaps a bubble whose code, table or list is wider than it.
    let room = if p.model.is_some() { 192. } else { 120. };
    let most = p.width.map(|w| (w * 0.75).min(w - l.z(room)));
    div()
        .id(SharedString::from(format!("{key}.said")))
        .on_hover(hover(sh, &key, false))
        .relative()
        .flex()
        .flex_col()
        .min_w_0()
        .map(|d| match most {
            Some(m) => d.max_w(m),
            None => d.max_w(relative(0.75)),
        })
        .map(|d| if right { d.items_end().self_end() } else { d.items_start().self_start() })
        .when(reacted, |d| d.mt(u(14.)))
        .child(drawn_at(sh, &key, false))
        .child(div().map(|d| match most { Some(m) => d.max_w(m), None => d.max_w_full() }).min_w_0().child(bubble))
        .when_some(p.time, |d, t| d.child(said_bar(t, p.model, whole_of(p.text, p.detail), right, &key, sh, l, window, cx)))
        .into_any_element()
}

/// The agent at work on its answer, as iMessage's typing bubble: three dots, lit in turn.
pub fn typing(l: &Look) -> AnyElement {
    let lit = ((crate::time::now_ms() / 400.) as u64 % 3) as usize;
    div()
        .pt(u(12.))
        .flex()
        .child(
            div()
                .relative()
                .flex()
                .items_center()
                .gap(u(4.))
                .rounded(u(18.))
                .bg(l.bubble)
                .px(u(14.))
                .py(u(12.))
                .child(tail(false, l.bubble))
                .children((0..3).map(|i| div().size(u(8.)).rounded_full().bg(if i == lit { l.ink2 } else { l.ink3 }))),
        )
        .into_any_element()
}
