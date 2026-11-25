//! iMessage's tapbacks (the desktop's `ui/tapback.tsx`, `said-bar.tsx`'s Tapbacks, `words-bar.tsx`,
//! `emoji-search.tsx`, `emoji-find.ts`): the six reactions, each in its own color as iMessage draws
//! them now, or any emoji; their badges on a bubble's top corner; and the menu to choose one from,
//! over the bubble (a double-click off its words or a right-click opens it, for the whole message)
//! or over words selected in it (with Reply first, and the reaction on those words alone). Under
//! the six, a search finds emoji by meaning; what it finds takes the six's place until it's cleared.
//! Arrows move through them, Enter picks the one lit; Esc clears what's typed, then closes it.

use std::sync::OnceLock;

use gpui::{
    AnyElement, Anchor, App, Bounds, Context, Entity, FontWeight, Hsla, InteractiveElement, IntoElement, KeyDownEvent,
    ParentElement, Pixels, Render, SharedString, StatefulInteractiveElement, Styled, Window, anchored, deferred, div,
    point, prelude::*, px,
};
use ui_sdk::components::input::{Input, InputOptions};
use ui_sdk::kernel::ChangeOptions;

use crate::brain::{Reactions, Reply};
use crate::chat_marks;
use crate::kit::{self, Btn};
use crate::look::{Look, SANS, u};
use crate::model::model;

/// The six tapbacks.
pub const REACTIONS: [&str; 6] = ["love", "like", "dislike", "laugh", "emphasize", "question"];

pub fn is_tapback(r: &str) -> bool {
    REACTIONS.contains(&r)
}

/// A reaction's name: a tapback's, or the emoji itself.
pub fn name_of(r: &str) -> String {
    match r {
        "love" => "Love",
        "like" => "Like",
        "dislike" => "Dislike",
        "laugh" => "Haha",
        "emphasize" => "Emphasize",
        "question" => "Question",
        other => other,
    }
    .to_string()
}

/// Each tapback's color, iMessage's: Apple's system colors.
pub fn color_of(t: &str, l: &Look) -> Hsla {
    let (day, night) = match t {
        "love" => (0xff2d55, 0xff375f),
        "like" => (0xff9500, 0xff9f0a),
        "dislike" => (0x5856d6, 0x5e5ce6),
        "laugh" => (0xaf52de, 0xbf5af2),
        "emphasize" => (0xff3b30, 0xff453a),
        _ => (0x007aff, 0x0a84ff),
    };
    gpui::rgb(if l.dark { night } else { day }).into()
}

/// A reaction drawn: a tapback's glyph in its color, or the emoji.
pub fn glyph(r: &str, size: f32, l: &Look) -> AnyElement {
    let s = px(size);
    if !is_tapback(r) {
        return div().flex_none().text_size(s).line_height(s).child(SharedString::from(r.to_string())).into_any_element();
    }
    let color = color_of(r, l);
    let word = |text: &'static str, at: f32| div().font_family(SANS).font_weight(FontWeight::EXTRA_BOLD).text_size(s * at).line_height(s * at).text_color(color).child(text);
    match r {
        "love" | "like" | "dislike" => chat_marks::drawn(r, s, color).into_any_element(),
        "laugh" => div().size(s).flex().flex_col().items_center().justify_center().child(word("HA", 0.4)).child(word("HA", 0.4)).into_any_element(),
        "emphasize" => div().size(s).flex().items_center().justify_center().child(word("!!", 0.75)).into_any_element(),
        _ => div().size(s).flex().items_center().justify_center().child(word("?", 0.75)).into_any_element(),
    }
}

/// A reaction on a bubble: a round badge ringed in the background (the user's in their ink).
pub fn badge(r: &str, mine: bool, ink: Hsla, small: bool, l: &Look) -> gpui::Stateful<gpui::Div> {
    let size = if small { 20. } else { 28. };
    div().id(SharedString::from(format!("badge-{r}-{mine}-{small}"))).tooltip(crate::band::tip(name_of(r)))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .relative()
        .size(px(size))
        // Its ring sits outside its size, as CSS's ring does: the user's in their ink, the agent's
        // in the background.
        .child(div().absolute().top(px(-2.)).left(px(-2.)).size(px(size + 4.)).rounded_full().bg(if mine { ink } else { l.bg }))
        .child(div().absolute().top_0().left_0().size(px(size)).rounded_full().bg(l.bubble).flex().items_center().justify_center().child(glyph(r, if small { 11. } else { 14. }, l)))
}

/// The reactions on a bubble, on its top corner away from its side.
pub fn badges(reactions: &Reactions, right: bool, ink: Hsla, l: &Look) -> gpui::Div {
    div()
        .absolute()
        .top(px(-16.))
        .flex()
        .gap(px(2.))
        .map(|d| if right { d.left(px(-14.)).flex_row_reverse() } else { d.right(px(-14.)) })
        .when_some(reactions.agent.as_ref(), |d, r| d.child(badge(r, false, ink, false, l)))
        .when_some(reactions.user.as_ref(), |d, r| d.child(badge(r, true, ink, false, l)))
}

struct Emoji {
    emoji: String,
    name: Vec<String>,
    tags: Vec<String>,
    order: i64,
}

fn words_of(s: &str) -> Vec<String> {
    s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_string).collect()
}

/// Emoji by what they mean: emojibase's data (CLDR's names and keywords), read once.
fn all() -> &'static [Emoji] {
    static ALL: OnceLock<Vec<Emoji>> = OnceLock::new();
    ALL.get_or_init(|| {
        let raw: Vec<(String, String, Vec<String>, i64)> = serde_json::from_str(include_str!("emoji.json")).unwrap_or_default();
        raw.into_iter().map(|(emoji, label, tags, order)| Emoji { emoji, name: words_of(&label), tags: tags.iter().flat_map(|t| words_of(t)).collect(), order }).collect()
    })
}

/// 2 when a word of the list is the word typed, 1 when one starts with it.
fn fit(list: &[String], w: &str) -> i64 {
    if list.iter().any(|x| x == w) {
        2
    } else if list.iter().any(|x| x.starts_with(w)) {
        1
    } else {
        0
    }
}

fn score_of(e: &Emoji, words: &[String]) -> i64 {
    let mut total = 0;
    for w in words {
        let best = (fit(&e.name, w) * 2).max(fit(&e.tags, w));
        if best == 0 {
            return 0;
        }
        total += best;
    }
    // Its whole name typed ("fire", "eyes") first.
    if e.name.iter().all(|n| words.contains(n)) { total + 6 } else { total }
}

/// The emoji that fit what's typed, the closest first, then in the standard order.
pub fn find_emoji(typed: &str, most: usize) -> Vec<String> {
    let words = words_of(typed);
    if words.is_empty() {
        return vec![];
    }
    let mut found: Vec<(i64, i64, &str)> = all().iter().filter_map(|e| {
        let s = score_of(e, &words);
        (s > 0).then_some((s, e.order, e.emoji.as_str()))
    }).collect();
    found.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    found.into_iter().take(most).map(|(_, _, e)| e.to_string()).collect()
}

/// As many as the six tapbacks' row holds.
const MOST: usize = 6;

/// What the menu is open on: a message (`quote` none) or words of it.
#[derive(Clone)]
pub struct Target {
    pub seq: u64,
    pub space: String,
    /// The words chosen, for the words' menu (it has Reply).
    pub quote: Option<String>,
    /// The user's reaction there now: choosing it again takes it off.
    pub mine: Option<String>,
    /// What it sits over.
    pub anchor: Bounds<Pixels>,
}

/// The menu closed: told after its own update, so the column can clear the words chosen.
pub struct Closed {
    /// A reaction or Reply was chosen: the words chosen go too, as the desktop's `done()` lets
    /// them go; shut otherwise (Esc, a press outside), they stay selected.
    pub chosen: bool,
}

impl gpui::EventEmitter<Closed> for ReactMenu {}

/// The reactions menu, over a bubble or words in it.
pub struct ReactMenu {
    pub target: Option<Target>,
    search: Entity<Input>,
    lit: usize,
    /// What was typed when it was last drawn: typing anew lights the first found.
    seen: String,
}

impl ReactMenu {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| {
            Input::new(
                InputOptions::default()
                    .placeholder("Search…")
                    .field_style(kit::field_style()),
                window,
                cx,
            )
        });
        // What's typed is read as it's drawn (the first found lit again when it changes), and the
        // menu is told of a change after the field's own update: never from inside it, where the
        // menu may be the one clearing the field.
        cx.observe(&search, |_, _, cx| cx.notify()).detach();
        ReactMenu { target: None, search, lit: 0, seen: String::new() }
    }

    /// What it's over moved.
    pub fn set_anchor(&mut self, b: Bounds<Pixels>, cx: &mut Context<Self>) {
        if let Some(t) = self.target.as_mut()
            && t.anchor != b
        {
            t.anchor = b;
            cx.notify();
        }
    }

    pub fn is_open(&self) -> bool {
        self.target.is_some()
    }

    /// Opens over a message (focusing the search) or over words of it (the first key typed goes
    /// to the search, so the words stay chosen till then).
    pub fn open(&mut self, target: Target, window: &mut Window, cx: &mut Context<Self>) {
        let words = target.quote.is_some();
        self.target = Some(target);
        self.lit = 0;
        self.search.update(cx, |s, cx| {
            s.clear(ChangeOptions::default(), window, cx);
        });
        if !words {
            let s = self.search.clone();
            s.update(cx, |s, cx| s.focus(window, cx));
        }
        cx.notify();
    }

    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.shut(false, window, cx);
    }

    fn shut(&mut self, chosen: bool, window: &mut Window, cx: &mut Context<Self>) {
        // Its search goes with it: the focus doesn't stay on a field no longer drawn, where keys
        // would go nowhere (a popover's own leaves it with the page).
        if self.search.read(cx).field().read(cx).is_focused(window) {
            window.blur(cx);
        }
        if self.target.take().is_some() {
            self.search.update(cx, |s, cx| {
                s.clear(ChangeOptions::default(), window, cx);
            });
            cx.emit(Closed { chosen });
            cx.notify();
        }
    }

    fn typed(&self, cx: &App) -> String {
        self.search.read(cx).get_value().to_string()
    }

    fn pick(&mut self, reaction: String, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(t) = self.target.clone() {
            model(cx).update(cx, |m, cx| m.react(t.seq, reaction, t.mine.clone(), t.quote.clone(), cx));
        }
        self.shut(true, window, cx);
    }

    /// Words chosen go to the box as what it replies to.
    fn reply(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(t) = self.target.clone()
            && let Some(q) = t.quote.clone()
        {
            crate::replying::attach(&t.space, Reply::Quote { seq: t.seq, text: q, reply: None }, cx);
            crate::chatbox::focus_box_of(&t.space, window, cx);
        }
        self.shut(true, window, cx);
    }

    /// Esc: clears what's typed, then closes it.
    pub fn escape(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.typed(cx).trim().is_empty() {
            self.close(window, cx);
        } else {
            self.search.update(cx, |s, cx| {
                s.clear(ChangeOptions::default(), window, cx);
            });
        }
    }

    /// A key while it's open: arrows move through what's found, Enter picks, Esc clears then closes;
    /// over words, the first letter typed goes to the search.
    pub fn key(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.target.is_none() {
            return false;
        }
        let typed = self.typed(cx);
        let found = find_emoji(&typed, MOST);
        let k = e.keystroke.key.as_str();
        let step: Option<isize> = match k {
            "right" | "down" => Some(1),
            "left" | "up" => Some(-1),
            _ => None,
        };
        if let Some(st) = step
            && !found.is_empty()
            && !typed.trim().is_empty()
        {
            let at = self.lit.min(found.len() - 1) as isize;
            self.lit = ((at + st + found.len() as isize) % found.len() as isize) as usize;
            cx.notify();
            return true;
        }
        let focused = self.search.read(cx).field().read(cx).is_focused(window);
        // Enter in the search picks what's lit; on a key, it presses that key, as Space does.
        if k == "enter" && focused {
            if let Some(p) = found.get(self.lit.min(found.len().saturating_sub(1))) {
                self.pick(p.clone(), window, cx);
            }
            return true;
        }
        if !focused && crate::chatbox::printable(e, window.focused(cx).is_some()).is_some() {
            let s = self.search.clone();
            s.update(cx, |s, cx| s.focus(window, cx));
            let ch = e.keystroke.key_char.clone().unwrap_or_default();
            s.update(cx, |s, cx| {
                let v = format!("{}{ch}", s.get_value());
                s.set_value(v, ChangeOptions::default(), window, cx);
            });
            return true;
        }
        false
    }
}

fn round_key(id: impl Into<gpui::ElementId>, pressed: bool, l: &Look) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id.into())
        .tab_index(0)
        .border_1()
        .border_color(gpui::transparent_black())
        .focus_visible(|s| s.border_color(l.ink3))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(32.))
        .rounded_full()
        .when(pressed, |d| d.bg(l.hover))
        .hover(|s| s.bg(l.hover))
}

impl Render for ReactMenu {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(t) = self.target.clone() else { return div().into_any_element() };
        let l = Look::get(cx);
        let typed = self.typed(cx);
        if typed != self.seen {
            self.seen = typed.clone();
            self.lit = 0;
        }
        let found = find_emoji(&typed, MOST);
        let lit = self.lit.min(found.len().saturating_sub(1));
        let words = t.quote.is_some();
        let row: Vec<AnyElement> = if typed.trim().is_empty() {
            let mut keys: Vec<AnyElement> = REACTIONS
                .iter()
                .map(|r| {
                    let r = r.to_string();
                    let pick = r.clone();
                    round_key(SharedString::from(format!("tapback-{r}")), t.mine.as_deref() == Some(r.as_str()), &l)
                        .aria_label(name_of(&r))
                        .on_click(cx.listener(move |m, _, window, cx| m.pick(pick.clone(), window, cx)))
                        .child(glyph(&r, 16., &l))
                        .into_any_element()
                })
                .collect();
            if !words && let Some(mine) = t.mine.clone().filter(|m| !is_tapback(m)) {
                let pick = mine.clone();
                keys.push(
                    round_key("tapback-mine", true, &l)
                        .aria_label(mine.clone())
                        .on_click(cx.listener(move |m, _, window, cx| m.pick(pick.clone(), window, cx)))
                        .child(glyph(&mine, 16., &l))
                        .into_any_element(),
                );
            }
            keys
        } else {
            found
                .iter()
                .enumerate()
                .map(|(i, e)| {
                    let pick = e.clone();
                    round_key(SharedString::from(format!("emoji-{i}")), i == lit, &l)
                        .aria_label(e.clone())
                        .text_size(px(18.))
                        .on_click(cx.listener(move |m, _, window, cx| m.pick(pick.clone(), window, cx)))
                        .child(SharedString::from(e.clone()))
                        .into_any_element()
                })
                .collect()
        };
        let field = Input::root(&self.search, cx)
            .text_color(l.ink)
            .aria_label("Emoji")
            .h(px(28.))
            .w_full()
            .min_w_0()
            .rounded(px(4.))
            .border_1()
            // `focus:border-ink3`.
            .border_color(if self.search.read(cx).field().read(cx).is_focused(window) { l.ink3 } else { l.line2 })
            .bg(l.bg)
            .px(px(8.))
            .text_size(u(13.))
            .flex()
            .items_center();
        let search = div().flex().flex_col().gap(px(4.)).min_w(px(202.)).child(div().flex().items_center().gap(px(2.)).h(px(32.)).children(row)).child(field);
        // Over what it's on, centred; under it when there's no room above.
        let h = 74.;
        let a = t.anchor;
        let above = a.top() - px(6. + h) > px(0.);
        let x = a.left() + a.size.width / 2.;
        let (corner, y) = if above { (Anchor::BottomCenter, a.top() - px(6.)) } else { (Anchor::TopCenter, a.bottom() + px(6.)) };
        let body = kit::float(&l)
            .id("react-menu")
            .flex()
            .items_start()
            .gap(px(2.))
            .p(px(4.))
            .occlude()
            .on_mouse_down_out(cx.listener(|m, _, window, cx| m.close(window, cx)))
            .when(words, |d| {
                d.child(
                    kit::button("words-reply", Btn::Flat, true, &l)
                        .h(px(32.))
                        .rounded_full()
                        .px(px(10.))
                        .text_color(l.ink)
                        .on_click(cx.listener(|m, _, window, cx| m.reply(window, cx)))
                        .aria_label("Reply").child("Reply"),
                )
            })
            .child(search);
        deferred(anchored().anchor(corner).position(point(x, y)).snap_to_window_with_margin(px(8.)).child(div().relative().child(body).child(crate::webview::covering()))).with_priority(2).into_any_element()
    }
}
