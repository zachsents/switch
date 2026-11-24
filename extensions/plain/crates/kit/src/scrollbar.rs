//! A thin scroll thumb for lists and other scrolling areas: sized and placed from the area's
//! scroll handle, and dragged to scroll. It only shows when the content is longer than its space.

use gpui::{
    App, Bounds, ElementId, HitboxBehavior, IntoElement, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, RenderOnce, ScrollHandle, Styled,
    UniformListScrollHandle, Window, canvas, div, fill, point, px, size,
};

use crate::ActiveTheme;

/// The strip along the list's right edge that the thumb moves in and that takes clicks.
const TRACK: Pixels = px(10.);
const THUMB: Pixels = px(4.);
/// The space between the thumb and the list's right edge, and its top and bottom.
const INSET: Pixels = px(1.);
/// The thumb never gets shorter than this, so it stays easy to grab.
const LEAST: Pixels = px(24.);

/// A scroll thumb over the right edge of a `uniform_list` or a scrolling `div` that tracks
/// `handle`. It goes beside the list in a `relative` parent the list fills, and sits in the
/// list's right padding.
#[derive(IntoElement)]
pub struct Scrollbar {
    id: ElementId,
    handle: ScrollHandle,
}

/// Something that scrolls: a `uniform_list`'s handle or a scrolling `div`'s.
pub trait Scrolls {
    fn scroll_handle(&self) -> ScrollHandle;
}

impl Scrolls for UniformListScrollHandle {
    fn scroll_handle(&self) -> ScrollHandle {
        self.0.borrow().base_handle.clone()
    }
}

impl Scrolls for ScrollHandle {
    fn scroll_handle(&self) -> ScrollHandle {
        self.clone()
    }
}

/// A scroll thumb for the list that tracks `handle`. See [`Scrollbar`].
pub fn scrollbar(id: impl Into<ElementId>, handle: &impl Scrolls) -> Scrollbar {
    Scrollbar {
        id: id.into(),
        handle: handle.scroll_handle(),
    }
}

/// Where the thumb is held while it's dragged: how far below the thumb's top the pointer is.
#[derive(Clone, Copy, Default)]
struct Grip(Option<Pixels>);

/// Where the thumb is this frame.
#[derive(Clone, Copy)]
struct Geometry {
    /// The span the thumb's top can move through, from the top of the list to the bottom.
    track: Bounds<Pixels>,
    thumb: Bounds<Pixels>,
    /// How far the list can scroll.
    max: Pixels,
}

impl Geometry {
    /// The thumb for the list `handle` tracks, inside `bounds`, or nothing when the list fits.
    fn of(scroll: &ScrollHandle, bounds: Bounds<Pixels>) -> Option<Self> {
        let max = scroll.max_offset().y;
        if max <= px(0.) {
            return None;
        }
        let shown = scroll.bounds().size.height;
        let track = Bounds::new(
            bounds.origin + point(px(0.), INSET),
            size(bounds.size.width, bounds.size.height - INSET * 2.),
        );
        let length = (track.size.height * (shown / (shown + max)))
            .max(LEAST)
            .min(track.size.height);
        let scrolled = (-scroll.offset().y).clamp(px(0.), max);
        let top = track.top() + (track.size.height - length) * (scrolled / max);
        Some(Self {
            track,
            thumb: Bounds::new(
                point(bounds.right() - INSET - THUMB, top),
                size(THUMB, length),
            ),
            max,
        })
    }

    /// The scroll offset that puts the thumb's top at `top`.
    fn offset_for(&self, top: Pixels) -> Pixels {
        let room = self.track.size.height - self.thumb.size.height;
        let fraction = if room > px(0.) {
            ((top - self.track.top()) / room).clamp(0., 1.)
        } else {
            0.
        };
        -(self.max * fraction)
    }
}

impl RenderOnce for Scrollbar {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let grip = window.use_keyed_state(self.id, cx, |_, _| Grip::default());
        let theme = *cx.theme();
        let handle = self.handle;
        let thumb = canvas(
            {
                let handle = handle.clone();
                move |bounds, window, _| {
                    let geometry = Geometry::of(&handle, bounds)?;
                    let hitbox =
                        window.insert_hitbox(bounds, HitboxBehavior::BlockMouseExceptScroll);
                    Some((geometry, hitbox))
                }
            },
            move |_, prepainted, window, cx| {
                let Some((geometry, hitbox)) = prepainted else {
                    return;
                };
                let hovered = hitbox.is_hovered(window);
                let color = if grip.read(cx).0.is_some() || hovered {
                    theme.text_muted
                } else {
                    theme.text_faint
                };
                window.paint_quad(fill(geometry.thumb, color).corner_radii(THUMB / 2.));
                let scroll = handle.clone();
                window.on_mouse_event({
                    let grip = grip.clone();
                    let scroll = scroll.clone();
                    let hitbox = hitbox.clone();
                    move |event: &MouseDownEvent, phase, window, cx| {
                        if !phase.bubble()
                            || event.button != MouseButton::Left
                            || !hitbox.is_hovered(window)
                        {
                            return;
                        }
                        // Grabbing the track instead of the thumb jumps the thumb's middle there.
                        let pointer = event.position.y;
                        let grab = if geometry.thumb.contains(&event.position) {
                            pointer - geometry.thumb.top()
                        } else {
                            geometry.thumb.size.height / 2.
                        };
                        let offset = scroll.offset();
                        scroll.set_offset(point(offset.x, geometry.offset_for(pointer - grab)));
                        grip.update(cx, |grip, _| grip.0 = Some(grab));
                        cx.stop_propagation();
                        window.refresh();
                    }
                });
                window.on_mouse_event({
                    let grip = grip.clone();
                    move |event: &MouseMoveEvent, phase, window, cx| {
                        if !phase.bubble() {
                            return;
                        }
                        match (grip.read(cx).0, event.dragging()) {
                            (Some(grab), true) => {
                                let offset = scroll.offset();
                                let to = geometry.offset_for(event.position.y - grab);
                                scroll.set_offset(point(offset.x, to));
                                cx.stop_propagation();
                                window.refresh();
                            }
                            // Let go outside the window, where the release isn't seen.
                            (Some(_), false) => {
                                grip.update(cx, |grip, _| grip.0 = None);
                                window.refresh();
                            }
                            // The thumb darkens under the pointer.
                            (None, _) if hitbox.is_hovered(window) != hovered => window.refresh(),
                            _ => {}
                        }
                    }
                });
                window.on_mouse_event(move |_: &MouseUpEvent, phase, window, cx| {
                    if phase.bubble() && grip.read(cx).0.is_some() {
                        grip.update(cx, |grip, _| grip.0 = None);
                        window.refresh();
                    }
                });
            },
        )
        .size_full();
        div()
            .absolute()
            .top_0()
            .right_0()
            .h_full()
            .w(TRACK)
            .child(thumb)
    }
}
