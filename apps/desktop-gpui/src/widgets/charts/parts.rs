//! What every chart shares (`look.ts`, `key.tsx`, `legend.tsx`, `tip.tsx`, `tip-box.tsx`): thin
//! marks in the house's tokens; a series' key beside its name (a square for bars, areas and slices,
//! a short line for lines, a dot for points), the color on the key, never on the words; the legend
//! over a chart of two series or more; what floats over a chart under the pointer; and the pointer
//! itself, kept per chart so its tooltip follows it. Lengths are CSS pixels, scaled with the theme's
//! text size.

use gpui::{
    AnyElement, App, Bounds, Context, Corners, DispatchPhase, ElementId, Entity, FocusHandle, FontFeatures, FontWeight, Hitbox, HitboxBehavior, Hsla,
    InteractiveElement, IntoElement, StatefulInteractiveElement, KeyDownEvent, MouseMoveEvent, ParentElement, PathBuilder, Pixels, Point, ShapedLine, SharedString, Size,
    Styled, Subscription, TextAlign, TextRun, Window, div, fill, font, point, px, size,
};

use crate::look::{Look, SANS};

/// A chart's own height, its axes in it, unless it's given one.
pub const HEIGHT: f32 = 200.;
/// A bar's most thickness.
pub const BAR: f32 = 24.;
/// A bar's rounded data end.
pub const END: f32 = 4.;
/// The background between fills that touch.
pub const GAP: f32 = 2.;
/// A line's width.
pub const LINE: f32 = 2.;
/// A marker's radius, and the background's ring round it.
pub const DOT: f32 = 4.;
pub const RING: f32 = 2.;
/// An area's wash.
pub const WASH: f32 = 0.1;
/// A label beside its mark.
pub const BESIDE: f32 = 6.;
/// Axis and label words: small.
pub const SMALL: f32 = 11.;
/// An axis along the bottom.
pub const X_AXIS: f32 = 20.;
/// A tick's words stand off its axis by a tick's length and its margin (Recharts' 6 and 2).
pub const TICK_OFF: f32 = 8.;
/// The tooltip's offset from the pointer.
pub const TIP_OFF: f32 = 10.;

/// A tick's words measure a line's height down an axis (Recharts measures them in a block, the page's
/// 16 px line), and keep this far apart beside the next (`minTickGap`, Recharts' 5 unless given).
pub const TICK_LINE: f32 = 16.;
pub const TICK_GAP: f32 = 5.;
/// Recharts' tick words: along the bottom their baseline a cap's height (0.71 em) under where they
/// start, down the side half that under their tick.
const CAP: f32 = 0.71;

/// Figures in columns of the same width (`tabular-nums`, as the page sets everywhere).
pub fn tnum() -> FontFeatures {
    FontFeatures(std::sync::Arc::new(vec![("tnum".into(), 1)]))
}

/// Figures their own widths (`proportional-nums`).
pub fn pnum() -> FontFeatures {
    FontFeatures(std::sync::Arc::new(vec![("pnum".into(), 1)]))
}

/// The chart's scale: the theme's text size.
pub fn k(l: &Look) -> f32 {
    l.zoom
}

/// Words shaped for painting, `size` CSS px.
pub fn shape(text: &str, size: f32, color: Hsla, bold: bool, l: &Look, window: &Window) -> ShapedLine {
    let mut f = font(SANS);
    f.features = tnum();
    if bold {
        f.weight = FontWeight::SEMIBOLD;
    }
    let run = TextRun { len: text.len(), font: f, color, background_color: None, underline: None, strikethrough: None };
    window.text_system().shape_line(SharedString::from(text.to_string()), px(size * k(l)), &[run], None)
}

/// How wide words are drawn small, to keep room for them.
pub fn width_of(text: &str, l: &Look, window: &Window) -> f32 {
    f32::from(shape(text, SMALL, l.ink3, false, l, window).width)
}

/// Words set on a baseline, their box's left at `left`.
pub fn paint_on(line: &ShapedLine, left: f32, baseline: f32, window: &mut Window, cx: &mut App) {
    let h = line.ascent + line.descent;
    let _ = line.paint(point(px(left), px(baseline) - line.ascent), h, TextAlign::Left, None, window, cx);
}

/// SVG's `central` baseline for words set on `middle`.
pub fn central(line: &ShapedLine, middle: f32) -> f32 {
    middle + f32::from(line.ascent - line.descent) / 2.
}

/// Words a chart draws in its plot, where they go, and whether they lie over the marks (an axis's)
/// or among them (a value beside its mark). VoiceOver reads each as the page's SVG text is read.
pub struct Word {
    pub text: String,
    pub line: ShapedLine,
    pub left: f32,
    pub baseline: f32,
    pub over: bool,
}

impl Word {
    /// Words drawn small, their right edge at `right`.
    pub fn right(text: &str, color: Hsla, right: f32, baseline: f32, over: bool, l: &Look, window: &Window) -> Word {
        let line = shape(text, SMALL, color, false, l, window);
        Word { text: text.to_string(), left: right - f32::from(line.width), baseline, line, over }
    }

    /// Words drawn small, from `left`.
    pub fn at(text: &str, color: Hsla, left: f32, baseline: f32, l: &Look, window: &Window) -> Word {
        let line = shape(text, SMALL, color, false, l, window);
        Word { text: text.to_string(), left, baseline, line, over: true }
    }

    fn bounds(&self) -> Bounds<Pixels> {
        bounds(self.left, self.baseline - f32::from(self.line.ascent), f32::from(self.line.width), f32::from(self.line.ascent + self.line.descent))
    }
}

/// A chart's words of one kind drawn: those over the marks, or those among them.
pub fn paint_words(words: &[Word], over: bool, window: &mut Window, cx: &mut App) {
    for w in words.iter().filter(|w| w.over == over) {
        paint_on(&w.line, w.left, w.baseline, window, cx);
    }
}

/// A chart's drawing (gpui's `canvas`, filling its box): what it works out before painting, and its
/// words, which it names to VoiceOver as labels where they're drawn.
pub struct Drawn<T> {
    id: ElementId,
    prepaint: Option<DrawnPrepaint<T>>,
    paint: Option<DrawnPaint<T>>,
}

type DrawnPrepaint<T> = Box<dyn FnOnce(Bounds<Pixels>, &mut Window, &mut App) -> (T, Vec<Word>)>;
type DrawnPaint<T> = Box<dyn FnOnce(Bounds<Pixels>, T, &[Word], &mut Window, &mut App)>;

pub fn drawn<T: 'static>(
    id: ElementId,
    prepaint: impl 'static + FnOnce(Bounds<Pixels>, &mut Window, &mut App) -> (T, Vec<Word>),
    paint: impl 'static + FnOnce(Bounds<Pixels>, T, &[Word], &mut Window, &mut App),
) -> Drawn<T> {
    Drawn { id, prepaint: Some(Box::new(prepaint)), paint: Some(Box::new(paint)) }
}

impl<T: 'static> gpui::Element for Drawn<T> {
    type RequestLayoutState = ();
    type PrepaintState = Option<(T, Vec<Word>, f32)>;

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn a11y_role(&self) -> Option<gpui::Role> {
        Some(gpui::Role::Group)
    }

    fn request_layout(&mut self, _: Option<&gpui::GlobalElementId>, _: Option<&gpui::InspectorElementId>, window: &mut Window, cx: &mut App) -> (gpui::LayoutId, ()) {
        let mut style = gpui::Style::default();
        style.size = size(gpui::relative(1.).into(), gpui::relative(1.).into());
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(&mut self, _: Option<&gpui::GlobalElementId>, _: Option<&gpui::InspectorElementId>, b: Bounds<Pixels>, _: &mut (), window: &mut Window, cx: &mut App) -> Self::PrepaintState {
        let (t, words) = self.prepaint.take()?(b, window, cx);
        Some((t, words, window.scale_factor()))
    }

    fn paint(&mut self, _: Option<&gpui::GlobalElementId>, _: Option<&gpui::InspectorElementId>, b: Bounds<Pixels>, _: &mut (), state: &mut Self::PrepaintState, window: &mut Window, cx: &mut App) {
        if let (Some((t, words, _)), Some(paint)) = (state.take(), self.paint.take()) {
            paint(b, t, &words, window, cx);
        }
    }

    fn a11y_synthetic_children(&mut self, state: &mut Self::PrepaintState, builder: &mut gpui::A11ySubtreeBuilder) {
        let Some((_, words, scale)) = state else { return };
        for (i, w) in words.iter().enumerate() {
            let b = w.bounds();
            let mut node = gpui::accesskit::Node::new(gpui::Role::Label);
            node.set_value(w.text.clone());
            node.set_bounds(gpui::accesskit::Rect {
                x0: f64::from(f32::from(b.origin.x) * *scale),
                y0: f64::from(f32::from(b.origin.y) * *scale),
                x1: f64::from(f32::from(b.origin.x + b.size.width) * *scale),
                y1: f64::from(f32::from(b.origin.y + b.size.height) * *scale),
            });
            let id = builder.synthetic_node_id(i);
            builder.push_child(id, node);
        }
    }
}

/// Words VoiceOver reads (gpui's `Text`, named under its parent's id).
pub fn said(id: impl Into<ElementId>, words: impl Into<SharedString>) -> gpui::Text {
    gpui::Text::new(id.into(), words.into())
}

/// SVG's `hanging` baseline as WebKit sets it: four fifths of the ascent over the alphabetic one.
pub fn hanging(line: &ShapedLine) -> f32 {
    f32::from(line.ascent) * 0.8
}

/// The baseline of an axis's words along the bottom, from the plot's foot: a tick's length and its
/// margin, then a cap's height.
pub fn x_baseline(bottom: f32, l: &Look) -> f32 {
    bottom + (TICK_OFF + CAP * SMALL) * k(l)
}

/// The baseline of an axis's words down the side, from their tick.
pub fn y_baseline(at: f32, l: &Look) -> f32 {
    at + CAP / 2. * SMALL * k(l)
}

/// A filled rectangle, its corners rounded.
pub fn rect(window: &mut Window, b: Bounds<Pixels>, color: Hsla, corners: Corners<Pixels>) {
    window.paint_quad(fill(b, color).corner_radii(corners));
}

pub fn bounds(x: f32, y: f32, w: f32, h: f32) -> Bounds<Pixels> {
    Bounds::new(point(px(x), px(y)), size(px(w.max(0.)), px(h.max(0.))))
}

/// A hairline across or down, `w` thick.
pub fn hline(window: &mut Window, x0: f32, x1: f32, y: f32, w: f32, color: Hsla) {
    rect(window, bounds(x0.min(x1), y - w / 2., (x1 - x0).abs(), w), color, Corners::default());
}

pub fn vline(window: &mut Window, x: f32, y0: f32, y1: f32, w: f32, color: Hsla) {
    rect(window, bounds(x - w / 2., y0.min(y1), w, (y1 - y0).abs()), color, Corners::default());
}

/// A dot of radius `r` at a point.
pub fn dot(window: &mut Window, x: f32, y: f32, r: f32, color: Hsla) {
    rect(window, bounds(x - r, y - r, 2. * r, 2. * r), color, Corners::all(px(r)));
}

/// A line through points, round at its ends and joins (a Line's), else square-cut and mitred (an
/// Area's, as SVG strokes by default).
pub fn polyline(window: &mut Window, pts: &[(f32, f32)], width: f32, color: Hsla, round: bool) {
    if pts.len() < 2 {
        return;
    }
    let mut b = PathBuilder::stroke(px(width)).with_style(gpui::PathStyle::Stroke(gpui::StrokeOptions {
        line_width: width,
        line_cap: if round { gpui::LineCap::Round } else { gpui::LineCap::Butt },
        line_join: if round { gpui::LineJoin::Round } else { gpui::LineJoin::Miter },
        miter_limit: 4.,
    }));
    b.move_to(point(px(pts[0].0), px(pts[0].1)));
    for p in &pts[1..] {
        b.line_to(point(px(p.0), px(p.1)));
    }
    if let Ok(path) = b.build() {
        window.paint_path(path, color);
    }
}

/// A filled shape through points.
pub fn polygon(window: &mut Window, pts: &[(f32, f32)], color: Hsla) {
    if pts.len() < 3 {
        return;
    }
    let mut b = PathBuilder::fill();
    let ps: Vec<Point<Pixels>> = pts.iter().map(|p| point(px(p.0), px(p.1))).collect();
    b.add_polygon(&ps, true);
    if let Ok(path) = b.build() {
        window.paint_path(path, color);
    }
}

/// Which of an axis's tick words show (Recharts' `interval`).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Interval {
    /// Every one (`0`).
    All,
    /// From the first on, keeping the last (`preserveStartEnd`).
    StartEnd,
    /// From the last back (`preserveEnd`, an axis's default).
    End,
}

fn sign_of(v: f32) -> f32 {
    if v == 0. { 0. } else { v.signum() }
}

/// Whether words of `size` centred at `at` fit between `start` and `end` (Recharts' `isVisible`).
fn fits(sign: f32, at: f32, size: f32, start: f32, end: f32) -> bool {
    if sign * at < sign * start || sign * at > sign * end {
        return false;
    }
    sign * (at - sign * size / 2. - start) >= 0. && sign * (at + sign * size / 2. - end) <= 0.
}

/// Where each of a row of tick words is drawn, or none where it isn't (Recharts' `getTicks`): each at
/// its tick, within the chart's box from `lo` to `hi` and `gap` clear of the one shown before it; the
/// first and the last moved in where they'd leave the box. `sizes` are along the axis.
pub fn ticks_shown(coords: &[f32], sizes: &[f32], (lo, hi): (f32, f32), gap: f32, interval: Interval) -> Vec<Option<f32>> {
    let n = coords.len();
    if interval == Interval::All {
        return coords.iter().map(|c| Some(*c)).collect();
    }
    let mut out = vec![None; n];
    if n == 0 {
        return out;
    }
    let sign = if n >= 2 { sign_of(coords[1] - coords[0]) } else { 1. };
    let (mut start, mut end) = if sign == 1. { (lo, hi) } else { (hi, lo) };
    match interval {
        Interval::End => {
            for i in (0..n).rev() {
                let (c, size) = (coords[i], sizes[i]);
                let mut at = c;
                if i == n - 1 {
                    let over = sign * (c + sign * size / 2. - end);
                    if over > 0. {
                        at = c - over * sign;
                    }
                }
                if fits(sign, at, size, start, end) {
                    end = at - sign * (size / 2. + gap);
                    out[i] = Some(at);
                }
            }
        }
        _ => {
            let (c, size) = (coords[n - 1], sizes[n - 1]);
            let over = sign * (c + sign * size / 2. - end);
            let at = if over > 0. { c - over * sign } else { c };
            if fits(sign, at, size, start, end) {
                end = at - sign * (size / 2. + gap);
                out[n - 1] = Some(at);
            }
            for i in 0..n - 1 {
                let (c, size) = (coords[i], sizes[i]);
                let mut at = c;
                if i == 0 {
                    let under = sign * (c - sign * size / 2. - start);
                    if under < 0. {
                        at = c - under * sign;
                    }
                }
                if fits(sign, at, size, start, end) {
                    start = at + sign * (size / 2. + gap);
                    out[i] = Some(at);
                }
            }
        }
    }
    out
}

/// A value axis's width as Recharts' `width="auto"` takes it: its widest shown words, a tick's length
/// and its margin, to a whole CSS pixel.
pub fn axis_width(widest: f32, l: &Look) -> f32 {
    let s = k(l);
    (widest / s + TICK_OFF).round() * s
}

/// What `widthOf` in look.ts measures: words drawn small, to the CSS pixel above.
pub fn width_up(text: &str, l: &Look, window: &Window) -> f32 {
    let s = k(l);
    (width_of(text, l, window) / s).ceil() * s
}

/// The pointer over a chart, in the chart's own place, and the size it was last drawn at; and the
/// keys' place in it, as Recharts' accessibility layer keeps one: the chart takes Tab, focused it
/// shows its first label (unless it's shown one before), → and ← move along, Enter shows or hides it.
/// The pointer over a label shows that one instead.
pub struct Pointer {
    pub at: Option<Point<Pixels>>,
    pub size: Size<Pixels>,
    pub focus: FocusHandle,
    /// The label the keys are at, and whether it shows.
    pub key_at: Option<usize>,
    pub key_on: bool,
    _focus: [Subscription; 2],
}

impl Pointer {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        // A tab stop: Tab reaches it as the browser's does an SVG with `tabindex="0"`.
        let focus = cx.focus_handle().tab_stop(true);
        let me = cx.weak_entity();
        let gained = window.on_focus_in(&focus, cx, move |_, cx| {
            let _ = me.update(cx, |p, cx| {
                if !p.key_on && p.key_at.is_none() {
                    p.key_at = Some(0);
                    p.key_on = true;
                    cx.notify();
                }
            });
        });
        let me = cx.weak_entity();
        let lost = window.on_focus_out(&focus, cx, move |_, _, cx| {
            let _ = me.update(cx, |p, cx| {
                if p.key_on {
                    p.key_on = false;
                    cx.notify();
                }
            });
        });
        Pointer { at: None, size: Size::default(), focus, key_at: None, key_on: false, _focus: [gained, lost] }
    }

    pub fn local(&self) -> Option<(f32, f32)> {
        self.at.map(|p| (f32::from(p.x), f32::from(p.y)))
    }

    pub fn width(&self) -> Option<f32> {
        (self.size.width > px(0.)).then(|| f32::from(self.size.width))
    }

    /// The label the keys show, of `n`: their place held to the last (data that shrank), while it shows.
    pub fn keyed(&self, n: usize) -> Option<usize> {
        if !self.key_on || n == 0 {
            return None;
        }
        self.key_at.map(|i| i.min(n - 1))
    }

    /// A key pressed over `n` labels; whether it moved anything.
    fn press(&mut self, key: &str, n: usize) -> bool {
        let at = self.key_at.map(|i| i.min(n.saturating_sub(1)));
        match key {
            "enter" if at.is_some() => {
                self.key_on = !self.key_on;
                true
            }
            "right" | "left" => {
                let right = key == "right";
                let next = match at {
                    None if n == 0 => return false,
                    None => if right { 0 } else { n - 1 },
                    Some(i) => match if right { Some(i + 1) } else { i.checked_sub(1) } {
                        Some(j) if j < n => j,
                        _ => return false,
                    },
                };
                self.key_at = Some(next);
                self.key_on = true;
                true
            }
            _ => false,
        }
    }
}

/// A chart's own pointer and keys, kept under it.
pub fn pointer(ctx: &crate::widgets::render::Ctx, c: &serde_json::Value, window: &mut Window, cx: &mut App) -> Entity<Pointer> {
    ctx.state(c, "pointer", window, cx, Pointer::new)
}

/// The surface the keys reach (Recharts' `accessibilityLayer`): it takes Tab with the focus ring, and
/// → ← and Enter move and show its tooltip over `n` labels.
pub fn keyed(id: ElementId, pointer: &Entity<Pointer>, n: usize, l: &Look, cx: &App) -> gpui::Stateful<gpui::Div> {
    let ring = crate::kit::ring(l);
    let p = pointer.clone();
    div()
        .id(id)
        // What VoiceOver calls the chart's surface, as the page's (`role="application"`).
        .role(gpui::Role::Application)
        .track_focus(&pointer.read(cx).focus)
        .tab_index(0)
        .focus_visible(move |s| s.shadow(ring))
        .on_key_down(move |e: &KeyDownEvent, _, cx| {
            let key = e.keystroke.key.as_str();
            if matches!(key, "right" | "left" | "enter") {
                p.update(cx, |p, cx| {
                    if p.press(key, n) {
                        cx.notify();
                    }
                });
                cx.stop_propagation();
            }
        })
}

/// In a chart's prepaint: its hitbox, so the pointer is its only while it's over it.
pub fn hitbox(b: Bounds<Pixels>, window: &mut Window) -> Hitbox {
    window.insert_hitbox(b, HitboxBehavior::Normal)
}

/// In a chart's paint: follows the pointer over it, and keeps the size it's drawn at.
pub fn follow(pointer: &Entity<Pointer>, b: Bounds<Pixels>, hit: Hitbox, window: &mut Window, cx: &mut App) {
    if pointer.read(cx).size != b.size {
        let p = pointer.clone();
        let sz = b.size;
        cx.defer(move |cx| p.update(cx, |p, cx| {
            p.size = sz;
            cx.notify();
        }));
    }
    // The pointer leaving the window takes the tip with it.
    let gone = pointer.clone();
    window.on_mouse_event(move |_: &gpui::MouseExitEvent, _, _, cx| {
        gone.update(cx, |p, cx| {
            if p.at.is_some() {
                p.at = None;
                cx.notify();
            }
        });
    });
    let p = pointer.clone();
    window.on_mouse_event(move |e: &MouseMoveEvent, phase, window, cx| {
        if phase != DispatchPhase::Bubble {
            return;
        }
        let at = hit.is_hovered(window).then(|| point(e.position.x - b.origin.x, e.position.y - b.origin.y));
        p.update(cx, |p, cx| {
            if p.at != at {
                p.at = at;
                cx.notify();
            }
        });
    });
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    Square,
    Line,
    Dot,
}

/// A series' key, mirroring its mark.
pub fn key(kind: KeyKind, color: Hsla, l: &Look) -> AnyElement {
    let z = |v: f32| l.z(v);
    match kind {
        KeyKind::Line => div().flex_none().w(z(12.)).h(z(10.)).flex().items_center().child(div().w_full().h(z(2.)).rounded(z(1.)).bg(color)).into_any_element(),
        KeyKind::Dot => div().flex_none().w(z(8.)).h(z(10.)).flex().items_center().child(div().size(z(8.)).rounded_full().bg(color)).into_any_element(),
        KeyKind::Square => div().flex_none().size(z(10.)).rounded(z(2.)).bg(color).into_any_element(),
    }
}

/// A chart's legend, over it: each series' key and name, in the order they're drawn; a single series
/// has none (the widget's heading names it).
pub fn legend(id: ElementId, items: &[(String, Hsla)], kind: KeyKind, l: &Look) -> Option<AnyElement> {
    (items.len() >= 2).then(|| {
        div()
            .id(id)
            .flex()
            .flex_wrap()
            .gap_x(l.z(12.))
            .gap_y(l.z(4.))
            .pb(l.z(8.))
            .children(items.iter().enumerate().map(|(i, (name, color))| {
                div()
                    .flex()
                    .min_w_0()
                    .items_center()
                    .gap(l.z(6.))
                    .text_size(l.z(12.))
                    .line_height(l.z(16.))
                    .text_color(l.ink2)
                    .child(key(kind, *color, l))
                    .child(div().min_w_0().truncate().child(said(i, name.clone())))
            }))
            .into_any_element()
    })
}

#[derive(Clone, Debug)]
pub struct TipRow {
    pub value: String,
    pub name: String,
    pub color: Hsla,
    /// What else it is, after its name: a slice's share.
    pub note: String,
}

#[derive(Clone, Debug)]
pub struct TipRead {
    /// What the values are at: a label, a range, a day.
    pub title: String,
    pub rows: Vec<TipRow>,
}

/// What floats over a chart under the pointer: what the values are at, then each value first and
/// strong, keyed by a short line of its color, its name and what else it is after it.
pub fn tip_box(id: ElementId, t: &TipRead, l: &Look) -> AnyElement {
    let z = |v: f32| l.z(v);
    let column = |cells: Vec<AnyElement>| div().flex().flex_col().gap(z(4.)).children(cells);
    let cell = || div().h(z(16.)).flex().items_center().whitespace_nowrap().text_size(z(12.)).line_height(z(16.));
    let grid = div()
        .flex()
        .gap_x(z(6.))
        .child(column(t.rows.iter().map(|r| cell().child(key(KeyKind::Line, r.color, l))).map(IntoElement::into_any_element).collect()))
        .child(column(
            t.rows.iter().enumerate().map(|(i, r)| cell().justify_end().font_weight(FontWeight::SEMIBOLD).text_color(l.ink).child(said(("value", i), r.value.clone())).into_any_element()).collect(),
        ))
        .child(column(t.rows.iter().enumerate().map(|(i, r)| cell().text_color(l.ink2).child(said(("name", i), r.name.clone())).into_any_element()).collect()))
        // Its four columns are always there, the notes' empty but for the gap before it.
        .child(column(t.rows.iter().enumerate().map(|(i, r)| cell().text_color(l.ink3).child(said(("note", i), r.note.clone())).into_any_element()).collect()));
    crate::kit::float(l)
        .id(id)
        .font_features(tnum())
        .flex()
        .flex_col()
        .gap(z(4.))
        .px(z(8.))
        .py(z(4.))
        .when(!t.title.is_empty(), |d| d.child(div().whitespace_nowrap().text_size(z(11.)).line_height(z(14.)).text_color(l.ink3).child(said("title", t.title.clone()))))
        .when(!t.rows.is_empty(), |d| d.child(grid))
        .into_any_element()
}

/// About how big a tooltip draws, to keep it in its chart.
pub fn tip_size(t: &TipRead, l: &Look, window: &Window) -> (f32, f32) {
    let s = k(l);
    let w12 = |s2: &str| f32::from(shape(s2, 12., l.ink, false, l, window).width);
    let col = |f: &dyn Fn(&TipRow) -> f32| t.rows.iter().map(f).fold(0., f32::max);
    let rows_w = 12. * s
        + 6. * s
        + col(&|r| f32::from(shape(&r.value, 12., l.ink, true, l, window).width))
        + 6. * s
        + col(&|r| w12(&r.name))
        + 6. * s
        + col(&|r| w12(&r.note));
    let title_w = if t.title.is_empty() { 0. } else { width_of(&t.title, l, window) };
    let n = t.rows.len() as f32;
    let h = 8. * s + if t.title.is_empty() { 0. } else { 14. * s + if n > 0. { 4. * s } else { 0. } } + n * 16. * s + (n - 1.).max(0.) * 4. * s;
    (rows_w.max(title_w) + 16. * s + 2., h + 2.)
}

/// The box a chart's tooltip keeps in (Recharts' view box: the plot), in the chart's own place.
#[derive(Clone, Copy, Debug)]
pub struct Within {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Within {
    /// Free to leave its chart (`allowEscapeViewBox`).
    pub const ANYWHERE: Within = Within { x: f32::NEG_INFINITY, y: f32::NEG_INFINITY, w: f32::INFINITY, h: f32::INFINITY };
}

/// Where a tooltip goes from what it's at (Recharts' `getTooltipTranslate`): `TIP_OFF` right of and
/// below it, the other side where it would pass the box's right or foot, and never left of or over
/// the box.
pub fn tip_place(at: (f32, f32), size: (f32, f32), within: Within, l: &Look) -> (f32, f32) {
    let off = TIP_OFF * k(l);
    let along = |c: f32, dim: f32, lo: f32, len: f32| {
        let (before, after) = (c - dim - off, c + off);
        if lo == f32::NEG_INFINITY {
            return after;
        }
        if after + dim > lo + len { before.max(lo) } else { after.max(lo) }
    };
    (along(at.0, size.0, within.x, within.w), along(at.1, size.1, within.y, within.h))
}

/// A tooltip laid over its chart at a place in it.
pub fn tip_over(id: ElementId, t: &TipRead, at: (f32, f32), l: &Look) -> AnyElement {
    div().absolute().left(px(at.0)).top(px(at.1)).child(gpui::deferred(tip_box(id, t, l)).with_priority(1)).into_any_element()
}

use gpui::prelude::FluentBuilder;
