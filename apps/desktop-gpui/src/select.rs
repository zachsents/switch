//! Words to copy select as a page's do (`select-text` on a bubble, `.selectable` in index.css),
//! through the UI SDK's selectable text (`ui_sdk::native::selectable_text`): a press and drag
//! selects across bubbles, a double-click a word and a triple-click its paragraph, a drag after
//! them extends by words or paragraphs, ⇧ extends by the same unit; ⌘C copies what's selected.
//! A column's `Sel` is its selection over every run of words it draws, keyed by the entry's order
//! and the run's place in it; a `SelText` is a run, with its formulas (`math.rs`) drawn over the
//! room the words leave them.

use std::collections::HashSet;
use std::ops::Range;
use std::rc::Rc;

use gpui::{
    App, Bounds, CursorStyle, Element, ElementId, GlobalElementId, Hitbox, Hsla, InspectorElementId, IntoElement,
    LayoutId, Pixels, SharedString, TextRun, Window, point,
};
use ui_sdk::native::selectable_text::{Join, LinkLook, SelectableText, TextSelection};

/// A run's place in its column: its entry's order (a line's seq), then its place in the entry.
pub type Key = (u64, u32);

/// Where a bubble's own words start among its runs: what it replies to comes first, as it's drawn.
pub const WORDS: u32 = 1000;

/// A column's selection: entries copy a paragraph apart, and a double-click past a run's letters
/// is the whole message's (its tapbacks).
#[derive(Clone)]
pub struct Sel(TextSelection<Key>);

impl Default for Sel {
    fn default() -> Self {
        Sel(TextSelection::<Key>::new().joiner(|a, b| if a.0 != b.0 { Join::Paragraph } else { Join::Line }).multi_click_off_glyphs(false))
    }
}

impl std::ops::Deref for Sel {
    type Target = TextSelection<Key>;
    fn deref(&self) -> &TextSelection<Key> {
        &self.0
    }
}

impl Sel {
    pub fn new() -> Self {
        Self::default()
    }

    /// Run `key` is a table's cell after another on its row.
    pub fn tabbed(&self, key: Key) {
        self.join(key, Join::Tab);
    }

    /// Run `key` is a block with room around it.
    pub fn apart(&self, key: Key) {
        self.join(key, Join::Paragraph);
    }

    /// The entry the whole selection is in, when it's all in one.
    pub fn entry(&self) -> Option<u64> {
        let (a, b) = self.range()?;
        (a.key.0 == b.key.0).then_some(a.key.0)
    }

    /// Whether a run's words ran past its clamp.
    pub fn clamped(&self, key: Key) -> bool {
        self.is_clamped(key)
    }

    /// Forgets the runs of entries no longer in the column.
    pub fn keep(&self, entries: &HashSet<u64>) {
        self.retain(|k| entries.contains(&k.0));
    }

    /// Where words of an entry are drawn: the lines they cover, and where they end (whitespace
    /// aside, as the words may be laid out in blocks). Empty when they don't show.
    pub fn find(&self, order: u64, text: &str) -> (Vec<Bounds<Pixels>>, Option<gpui::Point<Pixels>>) {
        let needle: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        if needle.is_empty() {
            return (vec![], None);
        }
        // Its own words, not what it replies to.
        let runs = self.runs((order, WORDS)..=(order, u32::MAX));
        let mut chars: Vec<(usize, usize, char)> = vec![];
        for (n, (_, words)) in runs.iter().enumerate() {
            for (i, c) in words.char_indices() {
                if !c.is_whitespace() {
                    chars.push((n, i, c));
                }
            }
        }
        let hay: String = chars.iter().map(|c| c.2).collect();
        let Some(byte_at) = hay.find(&needle) else { return (vec![], None) };
        let start = hay[..byte_at].chars().count();
        let len = needle.chars().count();
        let mut out = vec![];
        let mut seg: Option<(usize, usize, usize)> = None;
        let flush = |seg: Option<(usize, usize, usize)>, out: &mut Vec<Bounds<Pixels>>| {
            if let Some((n, a, b)) = seg {
                out.extend(self.rects(runs[n].0, a..b));
            }
        };
        for &(n, i, c) in &chars[start..start + len] {
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
}

/// While words are dragged, as a page's are: the pointer followed anywhere in the window and the
/// press let go anywhere (`on_up`), and held past the top or bottom of the column (`viewport`) the
/// column moves on each frame (`scroll`), as a browser's autoscroll does. Drawn over the column.
pub fn drag_anywhere(
    sel: &Sel,
    viewport: impl Fn() -> Bounds<Pixels> + 'static,
    scroll: impl Fn(Pixels, &mut Window, &mut App) + 'static,
    on_up: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
    sel.drag_layer(move |_| viewport(), scroll, on_up)
}

/// A run of selectable words (the UI SDK's `SelectableText`), with its formulas drawn in their
/// places and links (`links`: their ranges) followed on a click that didn't drag.
pub struct SelText {
    id: ElementId,
    key: Key,
    sel: Sel,
    words: SharedString,
    runs: Option<Vec<TextRun>>,
    /// Formulas in the words (`math.rs`): where each one's stand-in is, and its ink.
    math: Vec<(usize, crate::math::Formula, Hsla)>,
    /// The runs the formulas' words are styled by.
    math_runs: Option<Vec<TextRun>>,
    /// Laid out (`request_layout`): where each formula stands in the words drawn, and its drawing.
    drawn: Vec<Drawn>,
    links: Vec<Range<usize>>,
    on_link: Option<Rc<dyn Fn(usize, &mut Window, &mut App)>>,
    /// The cursor over all of it: the hand over words a click opens, the copy cursor over a code
    /// block.
    all: Option<CursorStyle>,
    /// Of `links`, those that are code (copied on a click: the copy cursor), and the wash under a
    /// link the pointer's on.
    copies: Vec<bool>,
    hover: Option<Hsla>,
    /// Each formula's place and TeX, for a copy.
    copy: Vec<(Range<usize>, String)>,
    inner: Option<SelectableText<Key>>,
}

/// What a formula's room is made of: U+202F, a narrow space no line breaks at.
const ROOM: char = '\u{202F}';

/// A formula in a run, laid out: where its room is in the words, how wide that is, the words'
/// ascent and descent there (to find their baseline), and its drawing.
struct Drawn {
    range: Range<usize>,
    room: f32,
    ascent: f32,
    descent: f32,
    drawing: Rc<crate::math::Drawn>,
}

impl SelText {
    pub fn new(id: impl Into<ElementId>, key: Key, sel: &Sel, words: impl Into<SharedString>, runs: Option<Vec<TextRun>>) -> Self {
        SelText {
            id: id.into(),
            key,
            sel: sel.clone(),
            words: words.into(),
            runs,
            math: vec![],
            math_runs: None,
            drawn: vec![],
            links: vec![],
            on_link: None,
            all: None,
            copies: vec![],
            hover: None,
            copy: vec![],
            inner: None,
        }
    }

    /// The formulas whose stand-ins are in the words (`math::tokened`), at their byte offsets, each
    /// drawn in its ink in its place. Its runs are what `new` was given.
    pub fn math(mut self, math: Vec<(usize, crate::math::Formula, Hsla)>, runs: Option<Vec<TextRun>>) -> Self {
        self.math = math;
        self.math_runs = runs;
        self
    }

    /// Each formula's stand-in made room enough for it: narrow spaces that don't break, as many as
    /// its drawing is wide, the runs and links round it moved on. A formula that can't be drawn
    /// shows as its TeX.
    fn lay_math(&mut self, window: &mut Window, cx: &mut App) {
        let style = window.text_style();
        let font_size = style.font_size.to_pixels(window.rem_size());
        let scale = window.scale_factor();
        let old = self.words.clone();
        let runs = self.math_runs.clone().unwrap_or_else(|| vec![style.to_run(old.len())]);
        // The run each byte is in.
        let run_at = |at: usize| {
            let mut end = 0;
            for r in &runs {
                end += r.len;
                if at < end {
                    return r.clone();
                }
            }
            runs.last().cloned().unwrap_or_else(|| style.to_run(0))
        };
        let mut words = String::with_capacity(old.len());
        // Where in the old words each stand-in was, and how much longer the words grew there.
        let mut grown: Vec<(usize, isize)> = vec![];
        let mut drawn = vec![];
        let mut copy = vec![];
        let mut last = 0;
        for (at, formula, ink) in &self.math {
            let at = *at;
            if at < last {
                continue;
            }
            let Some(c) = old.get(at..).and_then(|r| r.chars().next()) else { continue };
            words.push_str(&old[last..at]);
            let run = run_at(at);
            let size = f32::from(font_size) * crate::math::INLINE_SCALE;
            let start = words.len();
            match crate::math::draw(&formula.tex, false, size, *ink, scale, cx) {
                Some(d) => {
                    let probe = TextRun { len: ROOM.len_utf8(), ..run.clone() };
                    let unit = window.text_system().layout_line(ROOM.encode_utf8(&mut [0; 4]), font_size, &[probe], None);
                    let w = f32::from(unit.width).max(0.5);
                    let n = (d.width / w).ceil().max(1.) as usize;
                    for _ in 0..n {
                        words.push(ROOM);
                    }
                    drawn.push(Drawn { range: start..words.len(), room: w * n as f32, ascent: f32::from(unit.ascent), descent: f32::from(unit.descent), drawing: d });
                }
                None => words.push_str(&formula.written()),
            }
            copy.push((start..words.len(), formula.written()));
            grown.push((at, (words.len() - start) as isize - c.len_utf8() as isize));
            last = at + c.len_utf8();
        }
        words.push_str(&old[last..]);
        let moved = |x: usize| (x as isize + grown.iter().filter(|(at, _)| *at < x).map(|(_, d)| d).sum::<isize>()) as usize;
        let mut new_runs = Vec::with_capacity(runs.len());
        let mut at = 0;
        for r in &runs {
            let (a, b) = (moved(at), moved(at + r.len));
            new_runs.push(TextRun { len: b - a, ..r.clone() });
            at += r.len;
        }
        for l in &mut self.links {
            *l = moved(l.start)..moved(l.end);
        }
        self.words = SharedString::from(words);
        self.runs = Some(new_runs);
        self.drawn = drawn;
        self.copy = copy;
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
    pub fn looks(mut self, copies: Vec<bool>, hover: Hsla) -> Self {
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

    /// The SDK's run for these words, as laid out.
    fn build(&mut self) -> SelectableText<Key> {
        let mut text = SelectableText::new(self.id.clone(), self.key, &self.sel, self.words.clone())
            .copy_as(std::mem::take(&mut self.copy))
            .cursor(self.all.unwrap_or(CursorStyle::IBeam));
        if let Some(runs) = self.runs.take() {
            text = text.with_runs(runs);
        }
        if let Some(on_link) = self.on_link.clone() {
            let looks = (0..self.links.len())
                .map(|n| match (self.copies.get(n).copied().unwrap_or(false), self.hover) {
                    (true, _) => LinkLook { cursor: CursorStyle::DragCopy, hover: None },
                    (false, hover) => LinkLook { cursor: CursorStyle::PointingHand, hover },
                })
                .collect();
            text = text.links(std::mem::take(&mut self.links), move |n, window, cx| on_link(n, window, cx)).link_looks(looks);
        }
        text
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

    fn request_layout(&mut self, id: Option<&GlobalElementId>, inspector: Option<&InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, ()) {
        if !self.math.is_empty() {
            self.lay_math(window, cx);
            self.math.clear();
        }
        let mut inner = self.build();
        let out = inner.request_layout(id, inspector, window, cx);
        self.inner = Some(inner);
        out
    }

    fn prepaint(&mut self, id: Option<&GlobalElementId>, inspector: Option<&InspectorElementId>, bounds: Bounds<Pixels>, state: &mut (), window: &mut Window, cx: &mut App) -> Hitbox {
        let inner = self.inner.as_mut().expect("laid out before prepaint");
        inner.prepaint(id, inspector, bounds, state, window, cx)
    }

    fn paint(&mut self, id: Option<&GlobalElementId>, inspector: Option<&InspectorElementId>, bounds: Bounds<Pixels>, state: &mut (), hitbox: &mut Hitbox, window: &mut Window, cx: &mut App) {
        let inner = self.inner.as_mut().expect("laid out before paint");
        inner.paint(id, inspector, bounds, state, hitbox, window, cx);
        // Each formula over its room, on the words' baseline.
        let layout = inner.layout().clone();
        let line = layout.line_height();
        for d in &self.drawn {
            let Some(p) = layout.position_for_index(d.range.start) else { continue };
            let baseline = p.y + (line - gpui::px(d.ascent + d.descent)) / 2. + gpui::px(d.ascent);
            let at = point(p.x + gpui::px((d.room - d.drawing.width) / 2.), baseline - gpui::px(d.drawing.height));
            let b = Bounds::new(at, gpui::size(gpui::px(d.drawing.width), gpui::px(d.drawing.height + d.drawing.depth)));
            let _ = window.paint_image(b, b, gpui::Corners::default(), d.drawing.image.clone(), 0, false);
        }
    }
}
