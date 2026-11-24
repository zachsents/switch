//! Words to copy select as a page's do (`select-text` on a bubble, `.selectable` in index.css):
//! a press and drag selects across bubbles, a double-click a word, a triple-click its paragraph,
//! ⇧ extends; ⌘C copies what's selected. gpui draws text with no selection of its own, so each
//! selectable run of words is a `SelText`, which wraps gpui's `StyledText`, says where it was laid
//! out, and paints its part of the selection under its glyphs; a column's `Sel` holds the
//! selection and every run's words, in the column's order, so a drag finds the run under the
//! pointer and a copy joins the runs between its ends.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::ops::Range;
use std::rc::Rc;

use gpui::{
    App, Bounds, CursorStyle, DispatchPhase, Element, ElementId, GlobalElementId, Hitbox, HitboxBehavior, Hsla,
    InspectorElementId, LayoutId, MouseButton, MouseDownEvent, MouseUpEvent, Pixels,
    Point, SharedString, StyledText, TextLayout, TextRun, Window, fill, hsla, point,
};
use unicode_segmentation::UnicodeSegmentation;

/// A run's place in its column: its entry's order (a line's seq), then its place in the entry.
pub type Key = (u64, u32);

/// Where a bubble's own words start among its runs: what it replies to comes first, as it's drawn.
pub const WORDS: u32 = 1000;

/// A place in the words: a run and a byte offset in its text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Pos {
    pub key: Key,
    pub at: usize,
}

struct Run {
    text: SharedString,
    layout: TextLayout,
    bounds: Bounds<Pixels>,
    /// The frame it was last laid out in.
    drawn: u64,
    /// Its words ran past its clamp.
    clamped: bool,
}

/// A column's selection, and every run of its words it has drawn.
#[derive(Default)]
pub struct SelState {
    pub anchor: Option<Pos>,
    pub head: Option<Pos>,
    pub dragging: bool,
    /// A press on words is down: its release, anywhere, settles the selection.
    pub pressed: bool,
    runs: BTreeMap<Key, Run>,
    /// Bumped as the column lays out, so runs scrolled away aren't hit.
    frame: u64,
    /// A press on a link, kept to follow it if the pointer comes up there without a drag.
    pressed_link: Option<(Key, usize)>,
    /// Runs that are a block with room around it (a paragraph, a heading, code): copied a blank
    /// line after what's before them, as a page's copy puts them.
    apart: std::collections::HashSet<Key>,
    /// Runs that are a table's cell after another on its row: a tab before them, as a page's copy
    /// joins a row's cells.
    tabbed: std::collections::HashSet<Key>,
}

#[derive(Clone, Default)]
pub struct Sel(pub Rc<RefCell<SelState>>);

/// The selection's wash: the system's blue, see-through so it reads on any bubble.
pub fn wash() -> Hsla {
    hsla(211. / 360., 1., 0.5, 0.32)
}

impl Sel {
    pub fn new() -> Self {
        Self::default()
    }

    /// A new frame of the column: what's laid out from here is what's on screen.
    pub fn frame(&self) {
        self.0.borrow_mut().frame += 1;
    }

    /// The selection's ends in order, when there is one.
    pub fn range(&self) -> Option<(Pos, Pos)> {
        let s = self.0.borrow();
        let (a, h) = (s.anchor?, s.head?);
        if a == h {
            return None;
        }
        Some(if a <= h { (a, h) } else { (h, a) })
    }

    pub fn is_empty(&self) -> bool {
        self.range().is_none()
    }

    pub fn clear(&self) {
        let mut s = self.0.borrow_mut();
        s.anchor = None;
        s.head = None;
        s.dragging = false;
    }

    /// Selects every run of words it holds.
    pub fn select_all(&self) {
        let mut s = self.0.borrow_mut();
        let first = s.runs.keys().next().copied();
        let last = s.runs.iter().next_back().map(|(k, r)| (*k, r.text.len()));
        if let (Some(a), Some((b, len))) = (first, last) {
            s.anchor = Some(Pos { key: a, at: 0 });
            s.head = Some(Pos { key: b, at: len });
        }
    }

    /// Selects `range` of a run's words.
    pub fn select(&self, key: Key, range: Range<usize>) {
        let mut s = self.0.borrow_mut();
        s.anchor = Some(Pos { key, at: range.start });
        s.head = Some(Pos { key, at: range.end });
    }

    /// The words selected, the runs of one entry a line apart and entries a paragraph apart.
    pub fn text(&self) -> String {
        let Some((from, to)) = self.range() else { return String::new() };
        let s = self.0.borrow();
        let mut out = String::new();
        let mut last: Option<Key> = None;
        for (key, run) in s.runs.range(from.key..=to.key) {
            let start = if *key == from.key { from.at } else { 0 };
            let end = if *key == to.key { to.at } else { run.text.len() };
            let words = run.text.get(start.min(run.text.len())..end.min(run.text.len())).unwrap_or("");
            if let Some(l) = last {
                out.push_str(if l.0 != key.0 || s.apart.contains(key) {
                    "\n\n"
                } else if s.tabbed.contains(key) {
                    "\t"
                } else {
                    "\n"
                });
            }
            out.push_str(words);
            last = Some(*key);
        }
        out
    }

    /// Run `key` is a table's cell after another on its row.
    pub fn tabbed(&self, key: Key) {
        self.0.borrow_mut().tabbed.insert(key);
    }

    /// Run `key` is a block with room around it.
    pub fn apart(&self, key: Key) {
        self.0.borrow_mut().apart.insert(key);
    }

    /// The entry the whole selection is in, when it's all in one.
    pub fn entry(&self) -> Option<u64> {
        let (a, b) = self.range()?;
        (a.key.0 == b.key.0).then_some(a.key.0)
    }

    /// Where the selection starts on screen: the first line of it.
    pub fn first_rect(&self) -> Option<Bounds<Pixels>> {
        let (from, _) = self.range()?;
        let s = self.0.borrow();
        let run = s.runs.get(&from.key)?;
        let end = if to_key_is(&self.range(), from.key) { self.range()?.1.at } else { run.text.len() };
        rects(&run.layout, run.bounds, from.at.min(run.text.len())..end.min(run.text.len())).into_iter().next()
    }

    /// Where the pointer is in the words: the run under it, else the nearest drawn before it.
    pub fn hit(&self, at: Point<Pixels>) -> Option<Pos> {
        let s = self.0.borrow();
        let frame = s.frame;
        let drawn: Vec<(&Key, &Run)> = s.runs.iter().filter(|(_, r)| r.drawn == frame).collect();
        if drawn.is_empty() {
            return None;
        }
        // The last run whose top is above the pointer, in the column's order.
        let mut best: Option<(&Key, &Run)> = None;
        for (k, r) in &drawn {
            if r.bounds.contains(&at) {
                let ix = r.layout.index_for_position(at).unwrap_or_else(|e| e);
                return Some(Pos { key: **k, at: ix.min(r.text.len()) });
            }
            if r.bounds.top() <= at.y {
                best = Some((k, r));
            }
        }
        match best {
            Some((k, r)) => {
                let ix = if at.y > r.bounds.bottom() { r.text.len() } else { r.layout.index_for_position(at).unwrap_or_else(|e| e) };
                Some(Pos { key: *k, at: ix.min(r.text.len()) })
            }
            None => drawn.first().map(|(k, _)| Pos { key: **k, at: 0 }),
        }
    }

    /// A drag goes on to `at`.
    pub fn drag_to(&self, at: Point<Pixels>) -> bool {
        if !self.0.borrow().dragging {
            return false;
        }
        let Some(pos) = self.hit(at) else { return false };
        let mut s = self.0.borrow_mut();
        if s.head != Some(pos) {
            s.head = Some(pos);
            s.pressed_link = None;
            return true;
        }
        false
    }

    /// The press is let go: a drag ends; a press and release on a link follows it.
    pub fn release(&self) -> Option<(Key, usize)> {
        let mut s = self.0.borrow_mut();
        s.dragging = false;
        if s.anchor.is_some() && s.anchor == s.head {
            s.anchor = None;
            s.head = None;
            return s.pressed_link.take();
        }
        s.pressed_link = None;
        None
    }

    /// Notes where a run was laid out; answers whether its clamp changed.
    fn put(&self, key: Key, text: SharedString, layout: TextLayout, bounds: Bounds<Pixels>) -> bool {
        let clamped = layout.text() != text.as_ref();
        let mut s = self.0.borrow_mut();
        let frame = s.frame;
        let was = s.runs.get(&key).map(|r| r.clamped);
        s.runs.insert(key, Run { text, layout, bounds, drawn: frame, clamped });
        was.is_some_and(|w| w != clamped) || (was.is_none() && clamped)
    }

    /// This run's part of the selection, as a byte range of its words.
    fn part(&self, key: Key, len: usize) -> Option<Range<usize>> {
        let (from, to) = self.range()?;
        if key < from.key || key > to.key {
            return None;
        }
        let start = if key == from.key { from.at } else { 0 };
        let end = if key == to.key { to.at } else { len };
        (end > start).then_some(start.min(len)..end.min(len))
    }

    /// Where words of an entry are drawn: the lines they cover, and where they end (whitespace
    /// aside, as the words may be laid out in blocks). Empty when they don't show.
    pub fn find(&self, order: u64, text: &str) -> (Vec<Bounds<Pixels>>, Option<Point<Pixels>>) {
        let needle: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        if needle.is_empty() {
            return (vec![], None);
        }
        let s = self.0.borrow();
        // Its own words, not what it replies to.
        let runs: Vec<(&Key, &Run)> = s.runs.range((order, WORDS)..=(order, u32::MAX)).collect();
        let mut chars: Vec<(usize, usize, char)> = vec![];
        for (n, (_, r)) in runs.iter().enumerate() {
            for (i, c) in r.text.char_indices() {
                if !c.is_whitespace() {
                    chars.push((n, i, c));
                }
            }
        }
        let hay: String = chars.iter().map(|c| c.2).collect();
        let Some(byte_at) = hay.find(&needle) else { return (vec![], None) };
        let start = hay[..byte_at].chars().count();
        let len = needle.chars().count();
        let picked = &chars[start..start + len];
        let mut out = vec![];
        let mut seg: Option<(usize, usize, usize)> = None;
        let flush = |seg: Option<(usize, usize, usize)>, out: &mut Vec<Bounds<Pixels>>| {
            if let Some((n, a, b)) = seg {
                let r = runs[n].1;
                out.extend(rects(&r.layout, r.bounds, a..b));
            }
        };
        for &(n, i, c) in picked {
            let end = i + c.len_utf8();
            seg = match seg {
                Some((m, a, _)) if m == n => Some((m, a, end)),
                other => {
                    flush(other, &mut out);
                    Some((n, i, end))
                }
            };
        }
        flush(seg, &mut out);
        let end = out.last().map(|b| point(b.right(), b.top()));
        (out, end)
    }

    /// Whether a run's words ran past its clamp.
    pub fn clamped(&self, key: Key) -> bool {
        self.0.borrow().runs.get(&key).is_some_and(|r| r.clamped)
    }

    /// Forgets the runs of entries no longer in the column.
    pub fn keep(&self, entries: &std::collections::HashSet<u64>) {
        let mut s = self.0.borrow_mut();
        s.runs.retain(|k, _| entries.contains(&k.0));
        s.apart.retain(|k| entries.contains(&k.0));
        s.tabbed.retain(|k| entries.contains(&k.0));
    }
}

fn to_key_is(r: &Option<(Pos, Pos)>, key: Key) -> bool {
    r.as_ref().is_some_and(|(_, to)| to.key == key)
}

/// A word's bytes around `at`, as a double-click takes it.
fn word_at(text: &str, at: usize) -> Range<usize> {
    for (start, w) in text.split_word_bound_indices() {
        let end = start + w.len();
        if at >= start && at < end || at == end && end == text.len() {
            return start..end;
        }
    }
    at..at
}

/// A run of selectable words: gpui's `StyledText`, with its part of the selection painted under
/// it, and links (`links`: their ranges) followed on a click that didn't drag.
pub struct SelText {
    id: ElementId,
    key: Key,
    sel: Sel,
    text: StyledText,
    words: SharedString,
    links: Vec<Range<usize>>,
    on_link: Option<Rc<dyn Fn(usize, &mut Window, &mut App)>>,
    /// The cursor over all of it: the hand over words a click opens, the copy cursor over a code
    /// block.
    all: Option<CursorStyle>,
    /// Of `links`, those that are code (copied on a click: the copy cursor), and the wash under a
    /// link the pointer's on.
    copies: Vec<bool>,
    hover: Option<gpui::Hsla>,
}

impl SelText {
    pub fn new(id: impl Into<ElementId>, key: Key, sel: &Sel, words: impl Into<SharedString>, runs: Option<Vec<TextRun>>) -> Self {
        let words = words.into();
        let mut text = StyledText::new(words.clone());
        if let Some(r) = runs {
            text = text.with_runs(r);
        }
        SelText { id: id.into(), key, sel: sel.clone(), text, words, links: vec![], on_link: None, all: None, copies: vec![], hover: None }
    }

    /// The hand over it all: words a click opens.
    pub fn pointer(mut self, on: bool) -> Self {
        self.all = on.then_some(CursorStyle::PointingHand);
        self
    }

    /// The copy cursor over it all: a code block, copied on a click.
    pub fn copies_all(mut self) -> Self {
        self.all = Some(CursorStyle::DragCopy);
        self
    }

    /// Which of the links copy rather than open, and the wash under a link the pointer's on.
    pub fn looks(mut self, copies: Vec<bool>, hover: gpui::Hsla) -> Self {
        self.copies = copies;
        self.hover = Some(hover);
        self
    }

    /// Ranges that are links; `on_link` gets the link's number in `links`.
    pub fn links(mut self, links: Vec<Range<usize>>, on_link: impl Fn(usize, &mut Window, &mut App) + 'static) -> Self {
        self.links = links;
        self.on_link = Some(Rc::new(on_link));
        self
    }
}

impl Element for SelText {
    type RequestLayoutState = ();
    type PrepaintState = Hitbox;

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&GlobalElementId>, inspector: Option<&InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, ()) {
        self.text.request_layout(None, inspector, window, cx)
    }

    fn prepaint(&mut self, _: Option<&GlobalElementId>, inspector: Option<&InspectorElementId>, bounds: Bounds<Pixels>, state: &mut (), window: &mut Window, cx: &mut App) -> Hitbox {
        self.text.prepaint(None, inspector, bounds, state, window, cx);
        if self.sel.put(self.key, self.words.clone(), self.text.layout().clone(), bounds) {
            window.refresh();
        }
        window.insert_hitbox(bounds, HitboxBehavior::Normal)
    }

    fn paint(&mut self, _: Option<&GlobalElementId>, inspector: Option<&InspectorElementId>, bounds: Bounds<Pixels>, state: &mut (), hitbox: &mut Hitbox, window: &mut Window, cx: &mut App) {
        let layout = self.text.layout().clone();
        if let Some(part) = self.sel.part(self.key, self.words.len()) {
            for r in rects(&layout, bounds, part) {
                window.paint_quad(fill(r, wash()));
            }
        }
        let under = if hitbox.is_hovered(window) { layout.index_for_position(window.mouse_position()).ok().and_then(|ix| self.links.iter().position(|r| r.contains(&ix))) } else { None };
        let copies = under.is_some_and(|n| self.copies.get(n).copied().unwrap_or(false));
        if let (Some(n), Some(wash), false) = (under, self.hover, copies) {
            for r in rects(&layout, bounds, self.links[n].clone()) {
                window.paint_quad(fill(r, wash));
            }
        }
        let style = match (under, copies) {
            (Some(_), true) => CursorStyle::DragCopy,
            (Some(_), false) => CursorStyle::PointingHand,
            _ => self.all.unwrap_or(CursorStyle::IBeam),
        };
        window.set_cursor_style(style, hitbox);
        let (sel, key, words, links) = (self.sel.clone(), self.key, self.words.clone(), self.links.clone());
        let hit = hitbox.clone();
        let layout_down = layout.clone();
        window.on_mouse_event(move |e: &MouseDownEvent, phase, window, cx| {
            if phase != DispatchPhase::Bubble || e.button != MouseButton::Left || !hit.is_hovered(window) {
                return;
            }
            let exact = layout_down.index_for_position(e.position);
            let ix = exact.unwrap_or_else(|x| x).min(words.len());
            sel.0.borrow_mut().pressed = true;
            match e.click_count {
                1 => {
                    let mut s = sel.0.borrow_mut();
                    let pos = Pos { key, at: ix };
                    if e.modifiers.shift && s.anchor.is_some() {
                        s.head = Some(pos);
                    } else {
                        s.anchor = Some(pos);
                        s.head = Some(pos);
                    }
                    s.dragging = true;
                    s.pressed_link = links.iter().position(|r| r.contains(&ix)).map(|n| (key, n));
                }
                2 => {
                    // Off the letters, a double-click is the whole message's (its tapbacks).
                    if exact.is_err() {
                        return;
                    }
                    sel.select(key, word_at(&words, ix));
                    sel.0.borrow_mut().dragging = false;
                    cx.stop_propagation();
                }
                _ => {
                    sel.select(key, 0..words.len());
                    sel.0.borrow_mut().dragging = false;
                    cx.stop_propagation();
                }
            }
            window.refresh();
        });
        if let Some(on_link) = self.on_link.clone() {
            let (sel, hit) = (self.sel.clone(), hitbox.clone());
            window.on_mouse_event(move |e: &MouseUpEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble || e.button != MouseButton::Left || !hit.is_hovered(window) {
                    return;
                }
                let pressed = sel.0.borrow().pressed_link;
                if let Some((k, n)) = pressed
                    && k == key
                    && sel.is_empty()
                {
                    sel.0.borrow_mut().pressed_link = None;
                    on_link(n, window, cx);
                }
            });
        }
        self.text.paint(None, inspector, bounds, state, &mut (), window, cx);
    }
}

/// While words are dragged, as a page's are: the pointer followed anywhere in the window and the
/// press let go anywhere (`on_up`), and held past the top or bottom of the column (`viewport`) the
/// column moves on each frame (`scroll`), as a browser's autoscroll does. Drawn over the column.
pub fn drag_anywhere(
    sel: &Sel,
    viewport: impl Fn() -> Bounds<Pixels> + 'static,
    scroll: impl Fn(Pixels, &mut Window, &mut App) + 'static,
    on_up: impl Fn(&mut Window, &mut App) + 'static,
) -> impl gpui::IntoElement {
    use gpui::Styled;
    let (sel, on_up) = (sel.clone(), Rc::new(on_up));
    gpui::canvas(
        |_, _, _| {},
        move |_, _, window, cx| {
            if sel.0.borrow().dragging {
                let b = viewport();
                let at = window.mouse_position();
                let past = if at.y < b.top() { at.y - b.top() } else if at.y > b.bottom() { at.y - b.bottom() } else { Pixels::ZERO };
                if past != Pixels::ZERO {
                    // Faster the further past it is.
                    let by = if past < Pixels::ZERO { (past / 4.).min(gpui::px(-2.)) } else { (past / 4.).max(gpui::px(2.)) };
                    scroll(by, window, cx);
                    sel.drag_to(at);
                    window.request_animation_frame();
                }
            }
            let moved = sel.clone();
            window.on_mouse_event(move |e: &gpui::MouseMoveEvent, phase, window, _| {
                if phase == DispatchPhase::Bubble && moved.drag_to(e.position) {
                    window.refresh();
                }
            });
            let (up, on_up) = (sel.clone(), on_up.clone());
            window.on_mouse_event(move |e: &MouseUpEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble || e.button != MouseButton::Left || !std::mem::take(&mut up.0.borrow_mut().pressed) {
                    return;
                }
                // After the words under it have heard it (a link's press and release follows it).
                let (up, on_up) = (up.clone(), on_up.clone());
                window.defer(cx, move |window, cx| {
                    up.release();
                    on_up(window, cx);
                    window.refresh();
                });
            });
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// The rectangles a range of a laid out run covers, line by line.
fn rects(layout: &TextLayout, bounds: Bounds<Pixels>, part: Range<usize>) -> Vec<Bounds<Pixels>> {
    let (Some(a), Some(b)) = (layout.position_for_index(part.start), layout.position_for_index(part.end)) else {
        return vec![];
    };
    let h = layout.line_height();
    if a.y == b.y {
        return vec![Bounds::from_corners(a, point(b.x, b.y + h))];
    }
    let mut out = vec![Bounds::from_corners(a, point(bounds.right(), a.y + h))];
    let mut y = a.y + h;
    while y < b.y {
        out.push(Bounds::from_corners(point(bounds.left(), y), point(bounds.right(), y + h)));
        y += h;
    }
    out.push(Bounds::from_corners(point(bounds.left(), b.y), point(b.x, b.y + h)));
    out
}
