//! The picture: the shown image fitted to the window or zoomed, with its marks drawn over it,
//! and while cropping, the crop's frame and handles over the whole image.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};

use gpui::{
    BorderStyle, Bounds, ContentMask, Corners, CursorStyle, DispatchPhase, HitboxBehavior, ImageId,
    IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PinchEvent, Pixels,
    Point, RenderImage, ScrollWheelEvent, Styled, WeakEntity, Window, canvas, fill, point, px,
    quad, size, transparent_black,
};
use image::{Frame, RgbaImage};
use imaging::draw::{self, Mark};
use kit::Theme;

use crate::{
    crop::{Handle, Rect},
    document_window::DocumentWindow,
    markup::Tool,
    picture::render_image,
};

/// How far from a crop handle, in window points, a press still grabs it.
pub const GRAB: Pixels = px(8.);
/// The most an image pixel is enlarged, in points.
const MOST: f32 = 64.;
/// Room left around a fitted picture, so crop handles on its edges can be grabbed.
const MARGIN: f32 = 16.;

/// How the picture is zoomed.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Zoom {
    /// Points per image pixel. None fits the shown part in the window.
    pub scale: Option<f32>,
    /// The image point at the middle of the picture area, in the turned image's pixels. None
    /// centers the shown part.
    pub center: Option<(f32, f32)>,
}

/// Where the picture was drawn last, so commands without a pointer, like zooming in from the
/// keyboard, know where things are.
pub type LastPlacement = Rc<Cell<Option<Placement>>>;

/// The picture enlarged pixel by pixel, kept until the view changes. See [`enlarge`].
pub type Enlarged = Rc<RefCell<Option<(EnlargedView, Arc<RenderImage>)>>>;

/// What an enlarged picture shows: which texture, where on screen in screen pixels, and how
/// it's zoomed.
#[derive(Clone, Copy, PartialEq)]
pub struct EnlargedView {
    texture: ImageId,
    screen: (i64, i64, u32, u32),
    scale: u32,
    center: (u32, u32),
}

/// The marks drawn over the picture: the settled ones, kept until they or the view change, and
/// the ones changing under the pointer, drawn again every frame.
#[derive(Default)]
pub struct Overlays {
    settled: Option<(OverlayView, Arc<RenderImage>)>,
    live: Option<Arc<RenderImage>>,
}

pub type SharedOverlays = Rc<RefCell<Overlays>>;

/// What a settled overlay shows: which marks, where on screen in screen pixels, and how it's
/// zoomed.
#[derive(Clone, PartialEq)]
struct OverlayView {
    marks: Vec<Mark>,
    screen: (i64, i64, u32, u32),
    scale: u32,
    center: (u32, u32),
}

/// The crop being edited, as the picture draws it.
#[derive(Clone, Copy)]
pub struct Editing {
    /// What the arrow keys move.
    pub handle: Handle,
    pub dragging: Option<Handle>,
}

pub struct Picture {
    pub small: Arc<RenderImage>,
    pub full: Option<Arc<RenderImage>>,
    /// The turned image's size in pixels.
    pub image: (u32, u32),
    /// The part kept: the whole image when it isn't cropped.
    pub crop: Rect,
    pub editing: Option<Editing>,
    pub zoom: Zoom,
    /// Whether the picture is being dragged around.
    pub panning: bool,
    pub theme: Theme,
    pub view: WeakEntity<DocumentWindow>,
    pub placement: LastPlacement,
    pub enlarged: Enlarged,
    /// Marks drawn over the image, bottom to top. A mark being moved is left out, and drawn
    /// from `live` instead.
    pub marks: Vec<Mark>,
    /// Marks changing as the pointer moves: one being drawn, or one being moved.
    pub live: Vec<Mark>,
    /// The chosen mark's bounds, in the turned image's pixels.
    pub selection: Option<draw::Rect>,
    pub tool: Tool,
    pub overlays: SharedOverlays,
}

impl Picture {
    pub fn render(self) -> impl IntoElement {
        let Self {
            small,
            full,
            image,
            crop,
            editing,
            zoom,
            panning,
            theme,
            view,
            placement: last,
            enlarged,
            marks,
            live,
            selection,
            tool,
            overlays,
        } = self;
        canvas(
            move |bounds, window, _| {
                let placement = Placement::new(bounds, image, crop, editing.is_some(), zoom);
                // The toolbar shows the zoom, so it's drawn again when the zoom changes.
                if last.get().map(|last| last.scale) != Some(placement.scale) {
                    window.refresh();
                }
                last.set(Some(placement));
                let area = window.insert_hitbox(bounds, HitboxBehavior::Normal);
                // Corners last, so they win where they overlap an edge.
                let handles = editing.map(|_| {
                    Handle::ALL
                        .into_iter()
                        .filter(|handle| !is_corner(*handle))
                        .chain(Handle::ALL.into_iter().filter(|handle| is_corner(*handle)))
                        .map(|handle| {
                            let bounds = placement.grab_area(handle);
                            (handle, window.insert_hitbox(bounds, HitboxBehavior::Normal))
                        })
                        .collect::<Vec<_>>()
                });
                (placement, area, handles)
            },
            move |bounds, (placement, area, handles), window, _| {
                let scale_factor = window.scale_factor();
                let device_pixels = placement.scale * scale_factor;
                let shown = if editing.is_some() {
                    placement.image
                } else {
                    placement.crop
                };
                let visible = shown.intersect(&bounds);
                // Past one image pixel per screen pixel, each image pixel is drawn as a sharp
                // square. GPUI would smooth them, so it gets the picture already enlarged.
                let sharp = full
                    .as_ref()
                    .filter(|_| device_pixels > 1.001)
                    .and_then(|full| {
                        let view = EnlargedView {
                            texture: full.id,
                            screen: screen_pixels(visible, scale_factor),
                            scale: placement.scale.to_bits(),
                            center: (placement.center.0.to_bits(), placement.center.1.to_bits()),
                        };
                        let mut cache = enlarged.borrow_mut();
                        let reusable = cache
                            .as_ref()
                            .filter(|(cached, _)| *cached == view)
                            .map(|(_, picture)| picture.clone());
                        reusable.or_else(|| {
                            let picture =
                                enlarge(full, image, &placement, view.screen, scale_factor)?;
                            if let Some((_, old)) = cache.replace((view, picture.clone())) {
                                window.drop_image(old).ok();
                            }
                            Some(picture)
                        })
                    });
                let screen = screen_pixels(visible, scale_factor);
                let at = screen_bounds(screen, scale_factor);
                match sharp {
                    Some(picture) => {
                        window
                            .paint_image(at, at, Corners::default(), picture, 0, false)
                            .ok();
                    }
                    None => {
                        if let Some((_, old)) = enlarged.borrow_mut().take() {
                            window.drop_image(old).ok();
                        }
                        let texture = match &full {
                            Some(full) if device_pixels > detail(&small, image.0) => full.clone(),
                            _ => small.clone(),
                        };
                        // Clipping with a mask rather than paint_image's own bounds keeps
                        // panning smooth, where it would snap to whole pixels.
                        let mask = ContentMask { bounds: visible };
                        window.with_content_mask(Some(mask), |window| {
                            window
                                .paint_image(
                                    placement.image,
                                    placement.image,
                                    Corners::default(),
                                    texture,
                                    0,
                                    false,
                                )
                                .ok();
                        });
                    }
                }
                paint_overlays(
                    &mut overlays.borrow_mut(),
                    &marks,
                    &live,
                    &placement,
                    screen,
                    scale_factor,
                    window,
                );
                if let Some(rect) = selection {
                    let (x, y) = (rect.x, rect.y);
                    let corner = placement.screen_point((x, y));
                    let far = placement.screen_point((x + rect.width, y + rect.height));
                    let outline = Bounds::from_corners(corner, far).dilate(px(4.));
                    window.with_content_mask(Some(ContentMask { bounds }), |window| {
                        window.paint_quad(quad(
                            outline,
                            px(2.),
                            transparent_black(),
                            px(1.),
                            theme.text,
                            BorderStyle::Dashed,
                        ));
                    });
                }
                if let Some(editing) = editing {
                    window.with_content_mask(Some(ContentMask { bounds }), |window| {
                        placement.paint_marks(editing, theme, window);
                    });
                }

                let zoomed_in = placement.scale > placement.fit * 1.001;
                match (editing.and_then(|editing| editing.dragging), panning) {
                    (Some(handle), _) => window.set_window_cursor_style(cursor(handle, true)),
                    (None, true) => window.set_window_cursor_style(CursorStyle::ClosedHand),
                    (None, false) => {
                        match tool {
                            _ if editing.is_some() => {}
                            Tool::Select if zoomed_in => {
                                window.set_cursor_style(CursorStyle::OpenHand, &area);
                            }
                            Tool::Select => {}
                            Tool::Text => window.set_cursor_style(CursorStyle::IBeam, &area),
                            _ => window.set_cursor_style(CursorStyle::Crosshair, &area),
                        }
                        for (handle, hitbox) in handles.iter().flatten() {
                            window.set_cursor_style(cursor(*handle, false), hitbox);
                        }
                    }
                }

                window.on_mouse_event({
                    let (view, area) = (view.clone(), area.clone());
                    move |event: &ScrollWheelEvent, phase, window, cx| {
                        if phase != DispatchPhase::Bubble || !area.is_hovered(window) {
                            return;
                        }
                        let delta = event.delta.pixel_delta(px(16.));
                        view.update(cx, |this, cx| {
                            if event.modifiers.platform || event.modifiers.control {
                                let factor = (-f32::from(delta.y) / 200.).exp();
                                this.zoom_by(factor, event.position, placement, cx);
                            } else {
                                this.pan_by(delta, placement, cx);
                            }
                        })
                        .ok();
                        cx.stop_propagation();
                    }
                });
                window.on_mouse_event({
                    let (view, area) = (view.clone(), area.clone());
                    move |event: &PinchEvent, phase, window, cx| {
                        if phase != DispatchPhase::Bubble || !area.is_hovered(window) {
                            return;
                        }
                        view.update(cx, |this, cx| {
                            this.zoom_by(1. + event.delta, event.position, placement, cx);
                        })
                        .ok();
                        cx.stop_propagation();
                    }
                });
                window.on_mouse_event({
                    let (view, area) = (view.clone(), area.clone());
                    move |event: &MouseDownEvent, phase, window, cx| {
                        let pressed = phase == DispatchPhase::Bubble
                            && event.button == MouseButton::Left
                            && area.is_hovered(window);
                        if !pressed {
                            return;
                        }
                        let handle = editing.and_then(|_| placement.handle_at(event.position));
                        view.update(cx, |this, cx| {
                            this.press(
                                event.position,
                                event.click_count,
                                handle,
                                placement,
                                window,
                                cx,
                            );
                        })
                        .ok();
                        cx.stop_propagation();
                    }
                });
                // Registered whether or not a drag has started, since a quick click can be
                // released before the frame that starts the drag is drawn.
                window.on_mouse_event({
                    let view = view.clone();
                    move |event: &MouseMoveEvent, phase, window, cx| {
                        if phase != DispatchPhase::Bubble {
                            return;
                        }
                        view.update(cx, |this, cx| {
                            // Released somewhere we didn't hear about, like another app.
                            if event.pressed_button == Some(MouseButton::Left) {
                                this.drag_to(event.position, placement, cx);
                            } else {
                                this.end_drag(window, cx);
                            }
                        })
                        .ok();
                    }
                });
                window.on_mouse_event(move |event: &MouseUpEvent, phase, window, cx| {
                    if phase == DispatchPhase::Bubble && event.button == MouseButton::Left {
                        view.update(cx, |this, cx| this.end_drag(window, cx)).ok();
                    }
                });
            },
        )
        .flex_1()
        .min_h(px(0.))
        .w_full()
    }
}

/// Draws the settled marks, from the cache when nothing changed, and the live ones fresh, as
/// images covering `screen`, so they're drawn by the same code that writes them into files.
fn paint_overlays(
    overlays: &mut Overlays,
    marks: &[Mark],
    live: &[Mark],
    placement: &Placement,
    screen: (i64, i64, u32, u32),
    scale_factor: f32,
    window: &mut Window,
) {
    let at = screen_bounds(screen, scale_factor);
    let origin = placement.image_point(at.origin);
    let density = placement.scale * scale_factor;
    let render = |marks: &[Mark]| {
        (!marks.is_empty() && screen.2 > 0 && screen.3 > 0).then(|| {
            render_image(draw::render(
                marks,
                screen.2,
                screen.3,
                draw::Point {
                    x: origin.0,
                    y: origin.1,
                },
                density,
            ))
        })
    };
    let view = OverlayView {
        marks: marks.to_vec(),
        screen,
        scale: placement.scale.to_bits(),
        center: (placement.center.0.to_bits(), placement.center.1.to_bits()),
    };
    let cached = overlays
        .settled
        .as_ref()
        .filter(|(cached, _)| *cached == view)
        .map(|(_, image)| image.clone());
    let settled = cached.or_else(|| {
        if let Some((_, old)) = overlays.settled.take() {
            window.drop_image(old).ok();
        }
        let image = render(marks);
        overlays.settled = image.clone().map(|image| (view, image));
        image
    });
    if let Some(old) = overlays.live.take() {
        window.drop_image(old).ok();
    }
    overlays.live = render(live);
    for image in settled.into_iter().chain(overlays.live.clone()) {
        window
            .paint_image(at, at, Corners::default(), image, 0, false)
            .ok();
    }
}

/// Screen pixels as window points.
fn screen_bounds(screen: (i64, i64, u32, u32), scale_factor: f32) -> Bounds<Pixels> {
    let (left, top, width, height) = screen;
    Bounds::new(
        point(
            px(left as f32 / scale_factor),
            px(top as f32 / scale_factor),
        ),
        size(
            px(width as f32 / scale_factor),
            px(height as f32 / scale_factor),
        ),
    )
}

/// `bounds` in whole screen pixels: left, top, width and height.
fn screen_pixels(bounds: Bounds<Pixels>, scale_factor: f32) -> (i64, i64, u32, u32) {
    let device = |points: Pixels| (f32::from(points) * scale_factor).round() as i64;
    let (left, top) = (device(bounds.left()), device(bounds.top()));
    let (right, bottom) = (device(bounds.right()), device(bounds.bottom()));
    (
        left,
        top,
        (right - left).max(0) as u32,
        (bottom - top).max(0) as u32,
    )
}

/// The part of the picture covering `screen` (left, top, width and height in screen pixels),
/// with each image pixel copied into a square of screen pixels, so GPUI can draw it at its own
/// size without smoothing. None when there's nothing to show.
fn enlarge(
    texture: &RenderImage,
    image: (u32, u32),
    placement: &Placement,
    screen: (i64, i64, u32, u32),
    scale_factor: f32,
) -> Option<Arc<RenderImage>> {
    let (left, top, width, height) = screen;
    if width == 0 || height == 0 {
        return None;
    }
    let bytes = texture.as_bytes(0)?;
    let size = texture.size(0);
    let (texture_width, texture_height) = (size.width.0 as u32, size.height.0 as u32);
    let middle = placement.bounds.center();
    // The texture's column or row under each screen column or row. The texture can be smaller
    // than the image when the image is too big for one.
    let sources = |start: i64,
                   count: u32,
                   middle: Pixels,
                   center: f32,
                   image_length: u32,
                   texture_length: u32| {
        (0..count)
            .map(|offset| {
                let point = (start as f32 + offset as f32 + 0.5) / scale_factor;
                let at = center + (point - f32::from(middle)) / placement.scale;
                let pixel = (at.max(0.) as u32).min(image_length - 1);
                (u64::from(pixel) * u64::from(texture_length) / u64::from(image_length)) as usize
            })
            .collect::<Vec<_>>()
    };
    let columns = sources(
        left,
        width,
        middle.x,
        placement.center.0,
        image.0,
        texture_width,
    );
    let rows = sources(
        top,
        height,
        middle.y,
        placement.center.1,
        image.1,
        texture_height,
    );
    let stride = texture_width as usize * 4;
    // The texture's pixels are BGRA, which is what GPUI draws, so they're copied as they are.
    let pixels: Vec<u8> = rows
        .iter()
        .flat_map(|&row| {
            let line = &bytes[row * stride..(row + 1) * stride];
            columns
                .iter()
                .flat_map(move |&column| line[column * 4..column * 4 + 4].iter().copied())
        })
        .collect();
    let frame = Frame::new(RgbaImage::from_raw(width, height, pixels)?);
    Some(Arc::new(RenderImage::new([frame])))
}

/// Screen pixels per image pixel the small copy can show before it looks soft.
fn detail(small: &RenderImage, width: u32) -> f32 {
    small.size(0).width.0 as f32 / width as f32
}

fn is_corner(handle: Handle) -> bool {
    let (side_x, side_y) = handle.sides();
    side_x != 0 && side_y != 0
}

fn cursor(handle: Handle, dragging: bool) -> CursorStyle {
    match handle {
        Handle::Whole if dragging => CursorStyle::ClosedHand,
        Handle::Whole => CursorStyle::OpenHand,
        Handle::Left | Handle::Right => CursorStyle::ResizeLeftRight,
        Handle::Top | Handle::Bottom => CursorStyle::ResizeUpDown,
        Handle::TopLeft | Handle::BottomRight => CursorStyle::ResizeUpLeftDownRight,
        Handle::TopRight | Handle::BottomLeft => CursorStyle::ResizeUpRightDownLeft,
    }
}

/// Where the picture draws an image and its crop, in window points.
#[derive(Clone, Copy, Debug)]
pub struct Placement {
    /// The picture area.
    pub bounds: Bounds<Pixels>,
    /// The whole image. Zoomed in, most of it lies outside the area and isn't drawn.
    pub image: Bounds<Pixels>,
    pub crop: Bounds<Pixels>,
    /// Points per image pixel.
    pub scale: f32,
    /// The scale that fits the shown part in the area.
    pub fit: f32,
    /// The image point at the middle of the area.
    pub center: (f32, f32),
}

impl Placement {
    /// Places the image in `bounds`: the crop, or the whole image while cropping, fitted and
    /// centered, unless `zoom` says otherwise. Fitting never enlarges past one point per pixel.
    pub fn new(
        bounds: Bounds<Pixels>,
        image: (u32, u32),
        crop: Rect,
        whole: bool,
        zoom: Zoom,
    ) -> Self {
        let shown = if whole {
            Rect::whole(image.0, image.1)
        } else {
            crop
        };
        let (area_width, area_height) =
            (f32::from(bounds.size.width), f32::from(bounds.size.height));
        let fit = ((area_width - MARGIN * 2.) / shown.width as f32)
            .min((area_height - MARGIN * 2.) / shown.height as f32)
            .clamp(0.001, 1.);
        let scale = zoom.scale.unwrap_or(fit).clamp(fit.min(0.01), MOST);
        // Keep the shown part filling the area: no panning past its edges, and centered when
        // it's smaller than the area.
        let along = |wanted: Option<f32>, start: u32, length: u32, area: f32| {
            let (start, length) = (start as f32, length as f32);
            let half = area / 2. / scale;
            if length * scale <= area {
                start + length / 2.
            } else {
                wanted
                    .unwrap_or(start + length / 2.)
                    .clamp(start + half, start + length - half)
            }
        };
        let center = (
            along(
                zoom.center.map(|(x, _)| x),
                shown.x,
                shown.width,
                area_width,
            ),
            along(
                zoom.center.map(|(_, y)| y),
                shown.y,
                shown.height,
                area_height,
            ),
        );
        let origin = bounds.center() - point(px(center.0 * scale), px(center.1 * scale));
        let place = |rect: Rect| {
            Bounds::new(
                origin + point(px(rect.x as f32 * scale), px(rect.y as f32 * scale)),
                size(
                    px(rect.width as f32 * scale),
                    px(rect.height as f32 * scale),
                ),
            )
        };
        Self {
            bounds,
            image: place(Rect::whole(image.0, image.1)),
            crop: place(crop),
            scale,
            fit,
            center,
        }
    }

    /// The image point under `position`.
    pub fn image_point(&self, position: Point<Pixels>) -> (f32, f32) {
        let offset = position - self.bounds.center();
        (
            self.center.0 + f32::from(offset.x) / self.scale,
            self.center.1 + f32::from(offset.y) / self.scale,
        )
    }

    /// Where image point `at` is in the window.
    pub fn screen_point(&self, at: (f32, f32)) -> Point<Pixels> {
        self.image.origin + point(px(at.0 * self.scale), px(at.1 * self.scale))
    }

    /// The zoom that shows image point `at` under `position` at `scale`.
    pub fn zoom_keeping(&self, at: (f32, f32), position: Point<Pixels>, scale: f32) -> Zoom {
        let offset = position - self.bounds.center();
        Zoom {
            scale: Some(scale),
            center: Some((
                at.0 - f32::from(offset.x) / scale,
                at.1 - f32::from(offset.y) / scale,
            )),
        }
    }

    /// The largest scale an image may be zoomed to.
    pub fn most() -> f32 {
        MOST
    }

    /// Where a handle is drawn: a corner, the middle of an edge, or the crop's center.
    fn handle_point(&self, handle: Handle) -> Point<Pixels> {
        let (side_x, side_y) = handle.sides();
        let along = |start: Pixels, end: Pixels, side: i8| match side {
            -1 => start,
            1 => end,
            _ => (start + end) / 2.,
        };
        point(
            along(self.crop.left(), self.crop.right(), side_x),
            along(self.crop.top(), self.crop.bottom(), side_y),
        )
    }

    /// Where pressing grabs a handle: the inside of the crop for the whole crop, a band along an
    /// edge, or a square around a corner.
    fn grab_area(&self, handle: Handle) -> Bounds<Pixels> {
        let crop = self.crop;
        let at = self.handle_point(handle);
        match handle.sides() {
            (0, 0) => crop,
            (_, 0) => Bounds::from_corners(
                point(at.x - GRAB, crop.top()),
                point(at.x + GRAB, crop.bottom()),
            ),
            (0, _) => Bounds::from_corners(
                point(crop.left(), at.y - GRAB),
                point(crop.right(), at.y + GRAB),
            ),
            _ => Bounds::centered_at(at, size(GRAB * 2., GRAB * 2.)),
        }
    }

    /// The handle under `position`, matching `grab_area`: corners first, then edges, then the
    /// inside. When the crop is too small to tell apart its edges, the nearer one.
    fn handle_at(&self, position: Point<Pixels>) -> Option<Handle> {
        let side = |at: Pixels, start: Pixels, end: Pixels| {
            let (from_start, from_end) = ((at - start).abs(), (at - end).abs());
            if from_start <= GRAB && from_start <= from_end {
                Some(-1)
            } else if from_end <= GRAB {
                Some(1)
            } else {
                (at > start && at < end).then_some(0)
            }
        };
        let sides = (
            side(position.x, self.crop.left(), self.crop.right())?,
            side(position.y, self.crop.top(), self.crop.bottom())?,
        );
        Handle::ALL
            .into_iter()
            .find(|handle| handle.sides() == sides)
    }

    /// Darkens the image outside the crop and draws its border and handles, the chosen one
    /// filled in. Dragging shows thirds to line things up with. Choosing the whole crop
    /// thickens its border.
    fn paint_marks(&self, editing: Editing, theme: Theme, window: &mut Window) {
        let (image, crop) = (self.image, self.crop);
        let outside = [
            Bounds::from_corners(image.origin, point(image.right(), crop.top())),
            Bounds::from_corners(point(image.left(), crop.bottom()), image.bottom_right()),
            Bounds::from_corners(point(image.left(), crop.top()), crop.bottom_left()),
            Bounds::from_corners(crop.top_right(), point(image.right(), crop.bottom())),
        ];
        for band in outside {
            window.paint_quad(fill(band, theme.background.opacity(0.6)));
        }
        if editing.dragging.is_some() {
            for third in [1. / 3., 2. / 3.] {
                let x = crop.left() + crop.size.width * third;
                let y = crop.top() + crop.size.height * third;
                let line = theme.text.opacity(0.4);
                window.paint_quad(fill(
                    Bounds::new(point(x, crop.top()), size(px(1.), crop.size.height)),
                    line,
                ));
                window.paint_quad(fill(
                    Bounds::new(point(crop.left(), y), size(crop.size.width, px(1.))),
                    line,
                ));
            }
        }
        let border = if editing.handle == Handle::Whole {
            2.
        } else {
            1.
        };
        window.paint_quad(quad(
            crop,
            px(0.),
            transparent_black(),
            px(border),
            theme.text,
            BorderStyle::Solid,
        ));
        for handle in Handle::ALL
            .into_iter()
            .filter(|&handle| handle != Handle::Whole)
        {
            let chosen = editing.handle == handle;
            window.paint_quad(quad(
                Bounds::centered_at(self.handle_point(handle), size(px(8.), px(8.))),
                px(1.),
                if chosen { theme.text } else { theme.background },
                px(1.),
                theme.text,
                BorderStyle::Solid,
            ));
        }
    }
}
