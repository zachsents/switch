//! A column that keeps to its end (the desktop's `use-timeline-follow.ts`, `timeline-viewport.ts`,
//! `scrollbar.tsx`), for a chat and a task's page: it follows its end until the user moves it away
//! (a wheel or key up, a drag, a line brought into view), shows Latest once it's left the end, and
//! follows again when it's brought back within 40 px of it; Latest waits 150 ms before it shows, and
//! goes at once. The scroll keys move it (PageUp, PageDown, Home, End, the arrows, Space) with no
//! field taking them. Its bar is the Mac's overlay thumb: there when the column has more than it
//! shows, under the pointer or while it moves, and dragged to scroll.

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{
    Styled,
    Bounds, DispatchPhase, FollowMode, KeyDownEvent, ListOffset, ListState, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, Pixels, Window, canvas, fill, point, px,
};

use crate::look::Look;

/// How near the end, px, counts as at it: following comes back there.
const REARM_PX: f32 = 40.;
/// Latest waits this long before it shows, so it doesn't flash while the list settles.
pub const SHOW_LATEST: Duration = Duration::from_millis(150);
/// How long the thumb stays after the column last moved.
pub const THUMB_STAYS: Duration = Duration::from_millis(900);

/// Where the column stands: following its end, or let go (and whether it's still at the end).
pub struct Follow {
    pub list: ListState,
    following: bool,
    at_end: bool,
    /// When Latest may show: once it's left the end, after the wait.
    left: Option<Instant>,
    /// When it last moved, for the thumb.
    moved: Option<Instant>,
    last_offset: Pixels,
}

impl Follow {
    pub fn new(list: ListState) -> Self {
        list.set_follow_mode(FollowMode::Tail);
        Follow { list, following: true, at_end: true, left: None, moved: None, last_offset: px(0.) }
    }

    /// Whether it keeps to its end.
    pub fn is_following(&self) -> bool {
        self.following
    }

    /// Back to the end, following it again: the user sent something, pressed Latest or End.
    pub fn follow(&mut self) {
        self.following = true;
        self.at_end = true;
        self.left = None;
        self.list.set_follow_mode(FollowMode::Tail);
        self.list.scroll_to_end();
    }

    /// The user moved it away from the end, or something brought a line into view.
    pub fn release(&mut self) {
        if self.following {
            self.following = false;
            self.at_end = true;
        }
        self.list.set_follow_mode(FollowMode::Normal);
    }

    fn to_end(&self) -> Pixels {
        let max = self.list.max_offset_for_scrollbar().y;
        (max + self.list.scroll_px_offset_for_scrollbar().y).max(px(0.))
    }

    /// Reads where it is now, as it's drawn: a wheel or drag up lets it go, leaving the end shows
    /// Latest (after the wait), coming back within 40 px follows again.
    pub fn settle(&mut self, window: &mut Window) {
        let offset = self.list.scroll_px_offset_for_scrollbar().y;
        if offset != self.last_offset {
            self.last_offset = offset;
            self.moved = Some(Instant::now());
        }
        // The list stops following by itself as the wheel moves it up; a drag of the thumb too.
        if self.following && (!self.list.is_following_tail() || self.list.is_scrollbar_dragging()) {
            self.release();
        }
        let at_end = self.to_end() <= px(REARM_PX);
        if self.following {
            return;
        }
        if self.at_end && !at_end {
            self.at_end = false;
            self.left = Some(Instant::now());
            window.request_animation_frame();
        } else if !self.at_end && at_end && !self.list.is_scrollbar_dragging() {
            self.following = true;
            self.at_end = true;
            self.left = None;
            self.list.set_follow_mode(FollowMode::Tail);
        }
    }

    /// Whether Latest shows: let go and away from the end, a moment after it left.
    pub fn latest(&self, window: &mut Window) -> bool {
        match self.left {
            Some(at) if !self.following && !self.at_end => {
                let shown = at.elapsed() >= SHOW_LATEST;
                if !shown {
                    window.request_animation_frame();
                }
                shown
            }
            _ => false,
        }
    }

    /// The scroll keys, with no field taking them; answers whether one moved it.
    pub fn key(&mut self, e: &KeyDownEvent) -> bool {
        let k = &e.keystroke;
        let m = &k.modifiers;
        // ⇧Space pages up, as a page's does; ⇧ with any other is not a scroll key.
        let back = m.shift && k.key == "space";
        if m.platform || m.control || m.alt || (m.shift && !back) {
            return false;
        }
        let page = self.list.viewport_bounds().size.height * 0.9;
        let by = match k.key.as_str() {
            "space" if back => -page,
            "pageup" => -page,
            "pagedown" | "space" => page,
            "up" => px(-40.),
            "down" => px(40.),
            "home" => {
                if self.list.max_offset_for_scrollbar().y > px(0.) {
                    self.release();
                }
                self.list.scroll_to(ListOffset::default());
                return true;
            }
            "end" => {
                self.follow();
                return true;
            }
            _ => return false,
        };
        // A short column has nowhere to go: it keeps following.
        if by < px(0.) && self.list.max_offset_for_scrollbar().y > px(0.) {
            self.release();
        }
        scroll_by(&self.list, by);
        true
    }

    /// Whether the thumb shows: the column has more than it shows, and it's under the pointer or
    /// just moved.
    pub fn thumb_shown(&self, hovered: bool) -> bool {
        self.list.max_offset_for_scrollbar().y > px(0.) && (hovered || self.list.is_scrollbar_dragging() || self.moved.is_some_and(|m| m.elapsed() < THUMB_STAYS))
    }
}

/// Whether the focus is in a text field, which takes its own keys.
pub fn in_field(window: &Window) -> bool {
    window.context_stack().iter().any(|c| c.contains("TextField"))
}

/// Moves a list by `by` from where it's drawn. At its end the list's own top is past its last line,
/// so its `scroll_by` from there lands back at the end.
pub fn scroll_by(list: &ListState, by: Pixels) {
    let max = list.max_offset_for_scrollbar().y;
    let top = (-list.scroll_px_offset_for_scrollbar().y).min(max);
    let to = (top + by).max(px(0.)).min(max);
    list.set_offset_from_scrollbar(point(px(0.), -to));
}

/// Where the overlay thumb lies, cut out of the pages under it.
pub fn thumb_cut() -> impl gpui::IntoElement {
    use gpui::ParentElement;
    gpui::div().absolute().top_0().right_0().h_full().w(px(10.)).child(crate::webview::cutting())
}

/// The overlay thumb over a column's right edge, dragged to scroll it.
pub fn thumb(list: &ListState, l: &Look) -> impl gpui::IntoElement {
    let list = list.clone();
    let color = l.ink3.opacity(0.5);
    let grab: Rc<Cell<Option<(Pixels, Pixels)>>> = Rc::default();
    canvas(
        |_, _, _| {},
        move |bounds: Bounds<Pixels>, _, window, _| {
            // The bar's `p-0.5`: the thumb 2 px in from the edge and the track's ends.
            let pad = px(2.);
            let view = bounds.size.height;
            let track = view - pad * 2.;
            let max = list.max_offset_for_scrollbar().y;
            if max <= px(0.) {
                return;
            }
            let at = (-list.scroll_px_offset_for_scrollbar().y).min(max);
            let h = (track * (view / (view + max))).max(px(24.));
            let top = pad + (track - h) * (at / max).clamp(0., 1.);
            let w = px(6.);
            let thumb = Bounds::new(point(bounds.right() - w - pad, bounds.top() + top), gpui::size(w, h));
            window.paint_quad(fill(thumb, color).corner_radii(w / 2.));
            let hit = Bounds::new(point(bounds.right() - px(10.), bounds.top()), gpui::size(px(10.), view));
            let (l1, g1) = (list.clone(), grab.clone());
            window.on_mouse_event(move |e: &MouseDownEvent, phase, window, cx| {
                if phase == DispatchPhase::Capture && e.button == MouseButton::Left && hit.contains(&e.position) {
                    // A press off the thumb jumps the thumb's middle there first.
                    let at = if thumb.contains(&e.position) { at } else { ((e.position.y - bounds.top() - pad - h / 2.) / (track - h)).clamp(0., 1.) * max };
                    l1.scrollbar_drag_started();
                    l1.set_follow_mode(FollowMode::Normal);
                    l1.set_offset_from_scrollbar(point(px(0.), -at));
                    g1.set(Some((e.position.y, at)));
                    cx.stop_propagation();
                    window.refresh();
                }
            });
            let (l2, g2) = (list.clone(), grab.clone());
            window.on_mouse_event(move |e: &MouseMoveEvent, phase, window, cx| {
                if phase == DispatchPhase::Capture
                    && let Some((y0, at0)) = g2.get()
                {
                    let to = (at0 + (e.position.y - y0) * (max / (track - h).max(px(1.)))).clamp(px(0.), max);
                    l2.set_offset_from_scrollbar(point(px(0.), -to));
                    cx.stop_propagation();
                    window.refresh();
                }
            });
            let (l3, g3) = (list.clone(), grab.clone());
            window.on_mouse_event(move |_: &MouseUpEvent, phase, window, _| {
                if phase == DispatchPhase::Capture && g3.take().is_some() {
                    l3.scrollbar_drag_ended();
                    window.refresh();
                }
            });
        },
    )
    .size_full()
}

/// The same overlay thumb for a column that isn't a list (the reading window): over its right edge,
/// 2 px in, dragged to scroll it; drawn while it's under the pointer.
pub fn handle_thumb(handle: &gpui::ScrollHandle, l: &Look) -> impl gpui::IntoElement {
    let h0 = handle.clone();
    let color = l.ink3.opacity(0.5);
    let grab: Rc<Cell<Option<(Pixels, Pixels)>>> = Rc::default();
    canvas(
        |_, _, _| {},
        move |bounds: Bounds<Pixels>, _, window, _| {
            let pad = px(2.);
            let view = bounds.size.height;
            let track = view - pad * 2.;
            let max = h0.max_offset().y;
            if max <= px(0.) {
                return;
            }
            let at = (-h0.offset().y).clamp(px(0.), max);
            let h = (track * (view / (view + max))).max(px(24.));
            let top = pad + (track - h) * (at / max);
            let w = px(6.);
            let thumb = Bounds::new(point(bounds.right() - w - pad, bounds.top() + top), gpui::size(w, h));
            window.paint_quad(fill(thumb, color).corner_radii(w / 2.));
            let hit = Bounds::new(point(bounds.right() - px(10.), bounds.top()), gpui::size(px(10.), view));
            let (h1, g1) = (h0.clone(), grab.clone());
            window.on_mouse_event(move |e: &MouseDownEvent, phase, window, cx| {
                if phase == DispatchPhase::Capture && e.button == MouseButton::Left && hit.contains(&e.position) {
                    let at = if thumb.contains(&e.position) { at } else { ((e.position.y - bounds.top() - pad - h / 2.) / (track - h)).clamp(0., 1.) * max };
                    h1.set_offset(point(px(0.), -at));
                    g1.set(Some((e.position.y, at)));
                    cx.stop_propagation();
                    window.refresh();
                }
            });
            let (h2, g2) = (h0.clone(), grab.clone());
            window.on_mouse_event(move |e: &MouseMoveEvent, phase, window, cx| {
                if phase == DispatchPhase::Capture
                    && let Some((y0, at0)) = g2.get()
                {
                    let to = (at0 + (e.position.y - y0) * (max / (track - h).max(px(1.)))).clamp(px(0.), max);
                    h2.set_offset(point(px(0.), -to));
                    cx.stop_propagation();
                    window.refresh();
                }
            });
            let g3 = grab.clone();
            window.on_mouse_event(move |_: &MouseUpEvent, phase, window, _| {
                if phase == DispatchPhase::Capture && g3.take().is_some() {
                    window.refresh();
                }
            });
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// For a field-free key over a column that isn't a list (the reading window): the same keys on a
/// scroll handle.
pub fn scroll_key(handle: &gpui::ScrollHandle, e: &KeyDownEvent) -> bool {
    let k = &e.keystroke;
    let m = &k.modifiers;
    let back = m.shift && k.key == "space";
    if m.platform || m.control || m.alt || (m.shift && !back) {
        return false;
    }
    let page = handle.bounds().size.height * 0.9;
    let max = handle.max_offset().y;
    let now = handle.offset().y;
    let to = match k.key.as_str() {
        "space" if back => now + page,
        "pageup" => now + page,
        "pagedown" | "space" => now - page,
        "up" => now + px(40.),
        "down" => now - px(40.),
        "home" => px(0.),
        "end" => -max,
        _ => return false,
    };
    handle.set_offset(point(px(0.), to.clamp(-max, px(0.))));
    true
}

/// What scrolls sideways inside the column (a picture row, a code block, a wide table): only a
/// wheel's or a swipe's sideways part moves it; up and down go on to the column, as a page's
/// `overflow-x-auto` row leaves them.
pub fn across(d: gpui::Stateful<gpui::Div>, handle: &gpui::ScrollHandle) -> gpui::Stateful<gpui::Div> {
    use gpui::{InteractiveElement, StatefulInteractiveElement};
    let h = handle.clone();
    d.overflow_x_hidden().track_scroll(handle).on_scroll(move |e, window, cx| {
        let delta = e.delta.pixel_delta(window.line_height());
        if delta.x.abs() > delta.y.abs() && h.max_offset().x > px(0.) {
            let o = h.offset();
            h.set_offset(point((o.x + delta.x).clamp(-h.max_offset().x, px(0.)), o.y));
            cx.stop_propagation();
            window.refresh();
        }
    })
}
