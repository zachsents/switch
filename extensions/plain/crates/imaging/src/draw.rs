//! Markup drawn onto images with CoreGraphics and CoreText: shapes, lines, arrows, pen strokes,
//! highlighter, text and redaction boxes. Text uses the system font, as the rest of the app does.
//! The same code draws the overlay a window shows and the pixels written to a file, so what's
//! saved matches what's seen.

use std::borrow::Cow;

use image::RgbaImage;
use objc2_core_foundation::{
    CFAttributedString, CFBoolean, CFDictionary, CFRetained, CFString, CFType, CGAffineTransform,
    CGFloat, CGPoint, CGRect, CGSize,
};
use objc2_core_graphics::{CGBlendMode, CGContext, CGLineCap, CGLineJoin};
use objc2_core_text::{
    CTFont, CTFontUIFontType, CTLine, kCTFontAttributeName,
    kCTForegroundColorFromContextAttributeName,
};
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::bitmap::{self, Canvas};

/// A point in image pixels, from the top left.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Point {
    /// Pixels from the left edge.
    pub x: f32,
    /// Pixels from the top edge.
    pub y: f32,
}

/// A rectangle in image pixels, from the top left.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Rect {
    /// Pixels from the left edge to the rectangle's.
    pub x: f32,
    /// Pixels from the top edge to the rectangle's.
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// An sRGB color with alpha, written "#rrggbb", "#rrggbbaa", or a palette name like "red".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

/// Something drawn over an image.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Mark {
    /// A rectangle's outline, optionally filled.
    Rectangle {
        rect: Rect,
        /// The outline's color.
        color: Color,
        /// The outline's thickness in pixels. 0 draws no outline.
        width: f32,
        /// The color inside, if it's filled.
        #[serde(default)]
        fill: Option<Color>,
    },
    /// An ellipse filling a rectangle, as an outline, optionally filled.
    Ellipse {
        rect: Rect,
        /// The outline's color.
        color: Color,
        /// The outline's thickness in pixels. 0 draws no outline.
        width: f32,
        /// The color inside, if it's filled.
        #[serde(default)]
        fill: Option<Color>,
    },
    /// A straight line.
    Line {
        from: Point,
        to: Point,
        color: Color,
        /// Thickness in pixels.
        width: f32,
    },
    /// A line with a filled head at `to`, sized from the width.
    Arrow {
        from: Point,
        /// Where the head points.
        to: Point,
        color: Color,
        /// The line's thickness in pixels.
        width: f32,
    },
    /// A freehand stroke, smoothed through its points.
    Pen {
        points: Vec<Point>,
        color: Color,
        /// Thickness in pixels.
        width: f32,
    },
    /// A translucent marker stroke, blended so that text under it stays readable.
    Highlight {
        points: Vec<Point>,
        /// Usually translucent, like "#ffcc0066".
        color: Color,
        /// Thickness in pixels.
        width: f32,
    },
    /// Text in the system font. Lines break at "\n".
    Text {
        /// Where the top left of the first line goes.
        at: Point,
        text: String,
        /// The font size in pixels.
        size: f32,
        color: Color,
        #[serde(default)]
        bold: bool,
        /// A color behind the text, if any.
        #[serde(default)]
        background: Option<Color>,
    },
    /// A solid box hiding what's under it.
    Redact { rect: Rect, color: Color },
}

impl Point {
    fn offset(self, dx: f32, dy: f32) -> Self {
        Self {
            x: self.x + dx,
            y: self.y + dy,
        }
    }

    fn distance_to(self, other: Point) -> f32 {
        (self.x - other.x).hypot(self.y - other.y)
    }

    /// How far this is from the segment between `a` and `b`.
    fn distance_to_segment(self, a: Point, b: Point) -> f32 {
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let length = dx * dx + dy * dy;
        if length == 0. {
            return self.distance_to(a);
        }
        let along = (((self.x - a.x) * dx + (self.y - a.y) * dy) / length).clamp(0., 1.);
        self.distance_to(Point {
            x: a.x + along * dx,
            y: a.y + along * dy,
        })
    }
}

impl Rect {
    /// The rectangle with corners at `a` and `b`, whichever way round they are.
    pub fn from_corners(a: Point, b: Point) -> Self {
        Self {
            x: a.x.min(b.x),
            y: a.y.min(b.y),
            width: (a.x - b.x).abs(),
            height: (a.y - b.y).abs(),
        }
    }

    /// The smallest rectangle around `points`, or None when there are none.
    fn around(points: &[Point]) -> Option<Self> {
        let first = *points.first()?;
        Some(
            points
                .iter()
                .fold(Self::from_corners(first, first), |bounds, &point| {
                    bounds.union(Self::from_corners(point, point))
                }),
        )
    }

    pub fn contains(self, point: Point) -> bool {
        point.x >= self.x
            && point.x <= self.x + self.width
            && point.y >= self.y
            && point.y <= self.y + self.height
    }

    /// Grown by `by` on every side, or shrunk when it's negative.
    fn inflate(self, by: f32) -> Self {
        Self {
            x: self.x - by,
            y: self.y - by,
            width: self.width + by * 2.,
            height: self.height + by * 2.,
        }
    }

    fn union(self, other: Self) -> Self {
        let right = (self.x + self.width).max(other.x + other.width);
        let bottom = (self.y + self.height).max(other.y + other.height);
        let (x, y) = (self.x.min(other.x), self.y.min(other.y));
        Self {
            x,
            y,
            width: right - x,
            height: bottom - y,
        }
    }

    fn center(self) -> Point {
        Point {
            x: self.x + self.width / 2.,
            y: self.y + self.height / 2.,
        }
    }

    fn corners(self) -> (Point, Point) {
        (
            Point {
                x: self.x,
                y: self.y,
            },
            Point {
                x: self.x + self.width,
                y: self.y + self.height,
            },
        )
    }

    fn mapped(self, map: &impl Fn(Point) -> Point) -> Self {
        let (a, b) = self.corners();
        Self::from_corners(map(a), map(b))
    }

    fn cg(self) -> CGRect {
        CGRect::new(
            CGPoint::new(f64::from(self.x), f64::from(self.y)),
            CGSize::new(f64::from(self.width), f64::from(self.height)),
        )
    }
}

impl Color {
    pub const BLACK: Self = Self::opaque(0x00, 0x00, 0x00);
    pub const WHITE: Self = Self::opaque(0xff, 0xff, 0xff);
    pub const RED: Self = Self::opaque(0xff, 0x3b, 0x30);
    pub const ORANGE: Self = Self::opaque(0xff, 0x95, 0x00);
    pub const YELLOW: Self = Self::opaque(0xff, 0xcc, 0x00);
    pub const GREEN: Self = Self::opaque(0x34, 0xc7, 0x59);
    pub const BLUE: Self = Self::opaque(0x00, 0x7a, 0xff);
    pub const PURPLE: Self = Self::opaque(0xaf, 0x52, 0xde);
    /// The highlighter's yellow, translucent so what's under it shows through.
    pub const HIGHLIGHT: Self = Self {
        a: 0x66,
        ..Self::YELLOW
    };

    /// The palette the editor offers, with the names agents can use.
    pub const PALETTE: [(&'static str, Self); 8] = [
        ("black", Self::BLACK),
        ("white", Self::WHITE),
        ("red", Self::RED),
        ("orange", Self::ORANGE),
        ("yellow", Self::YELLOW),
        ("green", Self::GREEN),
        ("blue", Self::BLUE),
        ("purple", Self::PURPLE),
    ];

    pub const fn opaque(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b, a: 255 }
    }

    /// Reads "#rrggbb", "#rrggbbaa" (the "#" is optional) or a palette name like "red".
    pub fn parse(text: &str) -> Result<Self, String> {
        let text = text.trim().to_lowercase();
        if let Some((_, color)) = Self::PALETTE.iter().find(|(name, _)| *name == text) {
            return Ok(*color);
        }
        let hex = text.strip_prefix('#').unwrap_or(&text);
        let channel = |index: usize| {
            hex.get(index * 2..index * 2 + 2)
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
        };
        let problem = || format!("{text} isn't a color. Try \"#ff3b30\" or a name like \"red\"");
        match hex.len() {
            6 | 8 => Ok(Self {
                r: channel(0).ok_or_else(problem)?,
                g: channel(1).ok_or_else(problem)?,
                b: channel(2).ok_or_else(problem)?,
                a: if hex.len() == 8 {
                    channel(3).ok_or_else(problem)?
                } else {
                    255
                },
            }),
            _ => Err(problem()),
        }
    }

    /// "#rrggbb", with alpha "#rrggbbaa" when it isn't opaque.
    pub fn to_hex(self) -> String {
        let Self { r, g, b, a } = self;
        if a == 255 {
            format!("#{r:02x}{g:02x}{b:02x}")
        } else {
            format!("#{r:02x}{g:02x}{b:02x}{a:02x}")
        }
    }

    fn channels(self) -> [CGFloat; 4] {
        [self.r, self.g, self.b, self.a].map(|channel| CGFloat::from(channel) / 255.)
    }
}

impl Serialize for Color {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for Color {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::parse(&text).map_err(serde::de::Error::custom)
    }
}

impl JsonSchema for Color {
    fn schema_name() -> Cow<'static, str> {
        "Color".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "description": "\"#rrggbb\", \"#rrggbbaa\" with alpha, or one of black, white, red, orange, yellow, green, blue, purple",
            "pattern": "^(#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|black|white|red|orange|yellow|green|blue|purple)$",
        })
    }
}

/// An arrow head's length and half its width, for a line `width` thick.
fn arrow_head(width: f32) -> (f32, f32) {
    (width * 3. + 8., width * 1.5 + 5.)
}

/// Room around text with a background, for a font `size` pixels big.
fn text_padding(size: f32) -> f32 {
    size * 0.25
}

impl Mark {
    /// The area the mark covers, including its stroke, arrow head or text.
    pub fn bounds(&self) -> Rect {
        match self {
            Self::Rectangle { rect, width, .. } | Self::Ellipse { rect, width, .. } => {
                rect.inflate(width / 2.)
            }
            Self::Line {
                from, to, width, ..
            } => Rect::from_corners(*from, *to).inflate(width / 2.),
            Self::Arrow {
                from, to, width, ..
            } => Rect::from_corners(*from, *to).inflate(arrow_head(*width).1.max(width / 2.)),
            Self::Pen { points, width, .. } | Self::Highlight { points, width, .. } => {
                Rect::around(points).unwrap_or_default().inflate(width / 2.)
            }
            Self::Text {
                at,
                text,
                size,
                bold,
                background,
                ..
            } => {
                let (width, height) = text_size(text, *size, *bold);
                let rect = Rect {
                    x: at.x,
                    y: at.y,
                    width,
                    height,
                };
                match background {
                    Some(_) => rect.inflate(text_padding(*size)),
                    None => rect,
                }
            }
            Self::Redact { rect, .. } => *rect,
        }
    }

    /// Whether `at` is on the mark: within `tolerance` pixels of a stroke, or inside a filled
    /// shape, text or redaction.
    pub fn hit(&self, at: Point, tolerance: f32) -> bool {
        match self {
            Self::Rectangle {
                rect, width, fill, ..
            } => {
                let reach = width / 2. + tolerance;
                let outer = rect.inflate(reach).contains(at);
                let inner = rect.inflate(-reach);
                let inside = inner.width > 0. && inner.height > 0. && inner.contains(at);
                outer && (fill.is_some() || !inside)
            }
            Self::Ellipse {
                rect, width, fill, ..
            } => {
                let (radius_x, radius_y) = (rect.width / 2., rect.height / 2.);
                let center = rect.center();
                if radius_x <= 0. || radius_y <= 0. {
                    return at.distance_to_segment(rect.corners().0, rect.corners().1)
                        <= width / 2. + tolerance;
                }
                let distance = ((at.x - center.x) / radius_x).hypot((at.y - center.y) / radius_y);
                let reach = (width / 2. + tolerance) / radius_x.min(radius_y);
                match fill {
                    Some(_) => distance <= 1. + reach,
                    None => (distance - 1.).abs() <= reach,
                }
            }
            Self::Line {
                from, to, width, ..
            } => at.distance_to_segment(*from, *to) <= width / 2. + tolerance,
            Self::Arrow {
                from, to, width, ..
            } => {
                at.distance_to_segment(*from, *to) <= width / 2. + tolerance
                    || at.distance_to(*to) <= arrow_head(*width).0 + tolerance
            }
            Self::Pen { points, width, .. } | Self::Highlight { points, width, .. } => {
                let reach = width / 2. + tolerance;
                match points.as_slice() {
                    [] => false,
                    [only] => at.distance_to(*only) <= reach,
                    points => points
                        .windows(2)
                        .any(|pair| at.distance_to_segment(pair[0], pair[1]) <= reach),
                }
            }
            Self::Text { .. } | Self::Redact { .. } => {
                self.bounds().inflate(tolerance).contains(at)
            }
        }
    }

    /// The mark moved by `dx` and `dy` pixels.
    pub fn moved(&self, dx: f32, dy: f32) -> Mark {
        self.mapped(|point| point.offset(dx, dy))
    }

    /// Every point mapped through `map`, for rotating, flipping and scaling the image under the
    /// marks. Rectangles map by their corners. Text keeps reading left to right, centered where
    /// its center maps to.
    pub fn mapped(&self, map: impl Fn(Point) -> Point) -> Mark {
        let mut mark = self.clone();
        match &mut mark {
            Self::Rectangle { rect, .. }
            | Self::Ellipse { rect, .. }
            | Self::Redact { rect, .. } => {
                *rect = rect.mapped(&map);
            }
            Self::Line { from, to, .. } | Self::Arrow { from, to, .. } => {
                *from = map(*from);
                *to = map(*to);
            }
            Self::Pen { points, .. } | Self::Highlight { points, .. } => {
                for point in points.iter_mut() {
                    *point = map(*point);
                }
            }
            Self::Text {
                at,
                text,
                size,
                bold,
                ..
            } => {
                let (width, height) = text_size(text, *size, *bold);
                let center = map(at.offset(width / 2., height / 2.));
                *at = center.offset(-width / 2., -height / 2.);
            }
        }
        mark
    }

    pub fn with_color(&self, color: Color) -> Mark {
        let mut mark = self.clone();
        match &mut mark {
            Self::Rectangle { color: old, .. }
            | Self::Ellipse { color: old, .. }
            | Self::Line { color: old, .. }
            | Self::Arrow { color: old, .. }
            | Self::Pen { color: old, .. }
            | Self::Highlight { color: old, .. }
            | Self::Text { color: old, .. }
            | Self::Redact { color: old, .. } => *old = color,
        }
        mark
    }

    /// The mark with strokes `width` pixels thick, or for text, `width` pixels big. Redactions
    /// have no stroke, so they stay as they are.
    pub fn with_width(&self, width: f32) -> Mark {
        let mut mark = self.clone();
        match &mut mark {
            Self::Rectangle { width: old, .. }
            | Self::Ellipse { width: old, .. }
            | Self::Line { width: old, .. }
            | Self::Arrow { width: old, .. }
            | Self::Pen { width: old, .. }
            | Self::Highlight { width: old, .. }
            | Self::Text { size: old, .. } => *old = width.max(0.),
            Self::Redact { .. } => {}
        }
        mark
    }
}

/// The system font at `size` pixels, bold or not.
fn font(size: f32, bold: bool) -> CFRetained<CTFont> {
    let kind = if bold {
        CTFontUIFontType::EmphasizedSystem
    } else {
        CTFontUIFontType::System
    };
    unsafe { CTFont::new_ui_font_for_language(kind, CGFloat::from(size.max(1.)), None) }
        .expect("macOS has a system font")
}

/// Text laid out a line at a time, in the color the drawing context is set to.
struct Lines {
    lines: Vec<(CFRetained<CTLine>, f32)>,
    ascent: f32,
    line_height: f32,
}

fn lay_out(text: &str, size: f32, bold: bool) -> Lines {
    let font = font(size, bold);
    let keys: [&CFString; 2] = unsafe {
        [
            kCTFontAttributeName,
            kCTForegroundColorFromContextAttributeName,
        ]
    };
    let values: [&CFType; 2] = [&font, CFBoolean::new(true)];
    let attributes = CFDictionary::<CFString, CFType>::from_slices(&keys, &values);
    let lines = text
        .split('\n')
        .map(|line| {
            let string = CFString::from_str(line);
            let attributed =
                unsafe { CFAttributedString::new(None, Some(&string), Some(attributes.as_ref())) }
                    .expect("any text can be attributed");
            let line = unsafe { CTLine::with_attributed_string(&attributed) };
            let width = unsafe {
                line.typographic_bounds(
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            (line, width as f32)
        })
        .collect();
    let (ascent, descent, leading) = unsafe { (font.ascent(), font.descent(), font.leading()) };
    Lines {
        lines,
        ascent: ascent as f32,
        line_height: (ascent + descent + leading) as f32,
    }
}

/// The width and height text takes when drawn, for laying it out and hit testing.
pub fn text_size(text: &str, size: f32, bold: bool) -> (f32, f32) {
    let laid_out = lay_out(text, size, bold);
    let width = laid_out
        .lines
        .iter()
        .map(|(_, width)| *width)
        .fold(0., f32::max);
    (width, laid_out.line_height * laid_out.lines.len() as f32)
}

/// Draws `marks` onto `image`, over what's there. The image's top-left pixel is at `origin` in
/// mark coordinates, and each image pixel is `1 / scale` mark pixels.
pub fn draw(image: &mut RgbaImage, marks: &[Mark], origin: Point, scale: f32) {
    let canvas = Canvas::new(image.width(), image.height());
    CGContext::draw_image(
        Some(canvas.context()),
        canvas.bounds(),
        Some(&bitmap::to_cg_image(image)),
    );
    paint(&canvas, marks, origin, scale, false);
    *image = canvas.into_image();
}

/// A transparent `width` × `height` image of the marks, placed as `draw` would place them: the
/// overlay a window shows over the picture. With nothing under it, the highlighter can't
/// multiply, so it's drawn plainly, a little lighter than on the image.
pub fn render(marks: &[Mark], width: u32, height: u32, origin: Point, scale: f32) -> RgbaImage {
    let canvas = Canvas::new(width, height);
    paint(&canvas, marks, origin, scale, true);
    canvas.into_image()
}

/// Paints marks with the coordinates turned to run from the top left, like the image's.
fn paint(canvas: &Canvas, marks: &[Mark], origin: Point, scale: f32, overlay: bool) {
    let context = Some(canvas.context());
    let height = canvas.bounds().size.height;
    CGContext::save_g_state(context);
    CGContext::translate_ctm(context, 0., height);
    CGContext::scale_ctm(context, 1., -1.);
    CGContext::scale_ctm(context, CGFloat::from(scale), CGFloat::from(scale));
    CGContext::translate_ctm(context, -CGFloat::from(origin.x), -CGFloat::from(origin.y));
    // Text would come out upside down in the flipped coordinates otherwise.
    CGContext::set_text_matrix(
        context,
        CGAffineTransform {
            a: 1.,
            b: 0.,
            c: 0.,
            d: -1.,
            tx: 0.,
            ty: 0.,
        },
    );
    for mark in marks {
        paint_mark(canvas.context(), mark, overlay);
    }
    CGContext::restore_g_state(context);
}

fn set_fill(context: &CGContext, color: Color) {
    let [r, g, b, a] = color.channels();
    CGContext::set_rgb_fill_color(Some(context), r, g, b, a);
}

fn set_stroke(context: &CGContext, color: Color, width: f32) {
    let [r, g, b, a] = color.channels();
    CGContext::set_rgb_stroke_color(Some(context), r, g, b, a);
    CGContext::set_line_width(Some(context), CGFloat::from(width));
}

/// Adds a path through `points`, smoothed by curving through the midpoints between them.
fn add_smooth_path(context: &CGContext, points: &[Point]) {
    let context = Some(context);
    let Some((first, rest)) = points.split_first() else {
        return;
    };
    CGContext::begin_path(context);
    CGContext::move_to_point(context, first.x.into(), first.y.into());
    match rest {
        [] => CGContext::add_line_to_point(context, first.x.into(), first.y.into()),
        [only] => CGContext::add_line_to_point(context, only.x.into(), only.y.into()),
        _ => {
            for pair in points[1..].windows(2) {
                let (control, next) = (pair[0], pair[1]);
                let middle = Point {
                    x: (control.x + next.x) / 2.,
                    y: (control.y + next.y) / 2.,
                };
                CGContext::add_quad_curve_to_point(
                    context,
                    control.x.into(),
                    control.y.into(),
                    middle.x.into(),
                    middle.y.into(),
                );
            }
            let last = points[points.len() - 1];
            CGContext::add_line_to_point(context, last.x.into(), last.y.into());
        }
    }
}

fn paint_mark(context: &CGContext, mark: &Mark, overlay: bool) {
    let some = Some(context);
    CGContext::save_g_state(some);
    CGContext::set_line_cap(some, CGLineCap::Round);
    CGContext::set_line_join(some, CGLineJoin::Round);
    match mark {
        Mark::Rectangle {
            rect,
            color,
            width,
            fill,
        } => {
            if let Some(fill) = fill {
                set_fill(context, *fill);
                CGContext::fill_rect(some, rect.cg());
            }
            if *width > 0. {
                set_stroke(context, *color, *width);
                CGContext::set_line_join(some, CGLineJoin::Miter);
                CGContext::stroke_rect_with_width(some, rect.cg(), CGFloat::from(*width));
            }
        }
        Mark::Ellipse {
            rect,
            color,
            width,
            fill,
        } => {
            if let Some(fill) = fill {
                set_fill(context, *fill);
                CGContext::fill_ellipse_in_rect(some, rect.cg());
            }
            if *width > 0. {
                set_stroke(context, *color, *width);
                CGContext::stroke_ellipse_in_rect(some, rect.cg());
            }
        }
        Mark::Line {
            from,
            to,
            color,
            width,
        } => {
            set_stroke(context, *color, *width);
            add_smooth_path(context, &[*from, *to]);
            CGContext::stroke_path(some);
        }
        Mark::Arrow {
            from,
            to,
            color,
            width,
        } => {
            let (length, half) = arrow_head(*width);
            let distance = from.distance_to(*to).max(0.001);
            let (dx, dy) = ((to.x - from.x) / distance, (to.y - from.y) / distance);
            // The shaft stops where the head starts, so its round end doesn't poke through.
            let base = Point {
                x: to.x - dx * length.min(distance),
                y: to.y - dy * length.min(distance),
            };
            set_stroke(context, *color, *width);
            add_smooth_path(context, &[*from, base]);
            CGContext::stroke_path(some);
            set_fill(context, *color);
            CGContext::begin_path(some);
            CGContext::move_to_point(some, to.x.into(), to.y.into());
            CGContext::add_line_to_point(
                some,
                (base.x - dy * half).into(),
                (base.y + dx * half).into(),
            );
            CGContext::add_line_to_point(
                some,
                (base.x + dy * half).into(),
                (base.y - dx * half).into(),
            );
            CGContext::close_path(some);
            CGContext::fill_path(some);
        }
        Mark::Pen {
            points,
            color,
            width,
        } => {
            set_stroke(context, *color, *width);
            add_smooth_path(context, points);
            CGContext::stroke_path(some);
        }
        Mark::Highlight {
            points,
            color,
            width,
        } => {
            if !overlay {
                CGContext::set_blend_mode(some, CGBlendMode::Multiply);
            }
            CGContext::set_line_cap(some, CGLineCap::Square);
            set_stroke(context, *color, *width);
            add_smooth_path(context, points);
            CGContext::stroke_path(some);
        }
        Mark::Text {
            at,
            text,
            size,
            color,
            bold,
            background,
        } => {
            let laid_out = lay_out(text, *size, *bold);
            if let Some(background) = background {
                set_fill(context, *background);
                CGContext::fill_rect(some, mark.bounds().cg());
            }
            set_fill(context, *color);
            for (index, (line, _)) in laid_out.lines.iter().enumerate() {
                let baseline = at.y + laid_out.ascent + laid_out.line_height * index as f32;
                CGContext::set_text_position(some, at.x.into(), baseline.into());
                unsafe { line.draw(context) };
            }
        }
        Mark::Redact { rect, color } => {
            set_fill(context, *color);
            CGContext::fill_rect(some, rect.cg());
        }
    }
    CGContext::restore_g_state(some);
}
