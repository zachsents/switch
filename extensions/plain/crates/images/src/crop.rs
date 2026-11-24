//! Crops: a rectangle in an image's upright pixels, optionally held to a shape. Plain geometry
//! with no UI, shared by the window (dragging and nudging) and agents (`set_crop`).

use serde::{Deserialize, Serialize};

const HINT: &str = "Try free, original, 1:1, 4:3, 16:9 or 3:2";

/// The shape a crop is held to while it's edited.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Aspect {
    /// Any shape.
    #[default]
    Free,
    /// The image's own shape.
    Original,
    /// A ratio, kept in lowest terms with the longer side first. It turns to match the image, so
    /// 16:9 on a portrait photo is 9 wide by 16 tall.
    Ratio { long: u32, short: u32 },
}

impl Aspect {
    /// Reads a shape the way people write it: "free", "original", "square", "16:9", "16x9" or
    /// "9:16" (the same as 16:9, since ratios turn to match the image).
    pub fn parse(input: &str) -> Result<Self, String> {
        let text = input.trim().to_lowercase();
        let aspect = match text.as_str() {
            "free" | "any" => Self::Free,
            "original" | "same" => Self::Original,
            "square" => Self::ratio(1, 1),
            _ => {
                let (width, height) = text.split_once([':', 'x', '×', '/']).ok_or(HINT)?;
                let side = |side: &str| {
                    side.trim()
                        .parse::<u32>()
                        .ok()
                        .filter(|side| (1..=1000).contains(side))
                        .ok_or(HINT)
                };
                Self::ratio(side(width)?, side(height)?)
            }
        };
        Ok(aspect)
    }

    /// A ratio of `width` to `height`, in lowest terms, longer side first.
    pub fn ratio(width: u32, height: u32) -> Self {
        let divisor = gcd(width, height);
        let (width, height) = (width / divisor, height / divisor);
        Self::Ratio {
            long: width.max(height),
            short: width.min(height),
        }
    }

    /// Width over height on a `width` × `height` image, or None when the shape is free.
    pub fn ratio_on(self, width: u32, height: u32) -> Option<f64> {
        match self {
            Self::Free => None,
            Self::Original => Some(f64::from(width) / f64::from(height)),
            Self::Ratio { long, short } => {
                let ratio = f64::from(long) / f64::from(short);
                Some(if height > width { 1. / ratio } else { ratio })
            }
        }
    }

    /// The words that set this shape again, turned to match a `width` × `height` image: "free",
    /// "original", "16:9" or "9:16".
    pub fn as_input_on(self, width: u32, height: u32) -> String {
        match self {
            Self::Free => "free".into(),
            Self::Original => "original".into(),
            Self::Ratio { long, short } if height > width => format!("{short}:{long}"),
            Self::Ratio { long, short } => format!("{long}:{short}"),
        }
    }
}

/// `value` limited to `low..=high`, or `low` when the range is empty. Unlike `f64::clamp`, it
/// never panics on a crop too big for its image.
fn within(value: f64, low: f64, high: f64) -> f64 {
    value.min(high).max(low)
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// A rectangle in an image's upright pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// What a drag or an arrow key moves: one edge, one corner, or the whole crop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Handle {
    Whole,
    TopLeft,
    Top,
    TopRight,
    Right,
    BottomRight,
    Bottom,
    BottomLeft,
    Left,
}

impl Handle {
    /// In the order Tab steps through them: the whole crop, then clockwise from the top left.
    pub const ALL: [Self; 9] = [
        Self::Whole,
        Self::TopLeft,
        Self::Top,
        Self::TopRight,
        Self::Right,
        Self::BottomRight,
        Self::Bottom,
        Self::BottomLeft,
        Self::Left,
    ];

    /// Which vertical edge it moves (-1 left, 1 right, 0 neither) and which horizontal edge
    /// (-1 top, 1 bottom, 0 neither).
    pub fn sides(self) -> (i8, i8) {
        match self {
            Self::Whole => (0, 0),
            Self::TopLeft => (-1, -1),
            Self::Top => (0, -1),
            Self::TopRight => (1, -1),
            Self::Right => (1, 0),
            Self::BottomRight => (1, 1),
            Self::Bottom => (0, 1),
            Self::BottomLeft => (-1, 1),
            Self::Left => (-1, 0),
        }
    }

    /// The handle `offset` steps along in Tab order, wrapping around.
    pub fn step(self, offset: isize) -> Self {
        let count = Self::ALL.len() as isize;
        let index = Self::ALL
            .iter()
            .position(|&handle| handle == self)
            .unwrap_or(0) as isize;
        Self::ALL[(index + offset).rem_euclid(count) as usize]
    }
}

impl Rect {
    pub fn whole(width: u32, height: u32) -> Self {
        Self {
            x: 0,
            y: 0,
            width,
            height,
        }
    }

    /// Whether it's at least a pixel each way and lies inside a `width` × `height` image.
    pub fn fits(self, width: u32, height: u32) -> bool {
        let inside = |start: u32, length: u32, limit: u32| {
            length > 0 && u64::from(start) + u64::from(length) <= u64::from(limit)
        };
        inside(self.x, self.width, width) && inside(self.y, self.height, height)
    }

    /// The largest rectangle of `ratio` (width over height) centered in a `width` × `height`
    /// image, or the whole image when there's no ratio.
    pub fn centered(ratio: Option<f64>, width: u32, height: u32) -> Self {
        let whole = Self::whole(width, height);
        whole.fitted(ratio).unwrap_or(whole)
    }

    /// Shrunk around its center to `ratio`. None if it's already within a pixel of it, so
    /// fitting a fitted rectangle again never moves it.
    fn fitted(self, ratio: Option<f64>) -> Option<Self> {
        let ratio = ratio?;
        let (width, height) = (f64::from(self.width), f64::from(self.height));
        let close = (width - height * ratio).abs() <= 1. || (height - width / ratio).abs() <= 1.;
        if close {
            return None;
        }
        let (fitted_width, fitted_height) = if width / height > ratio {
            ((height * ratio).round().max(1.) as u32, self.height)
        } else {
            (self.width, (width / ratio).round().max(1.) as u32)
        };
        Some(Self {
            x: self.x + (self.width - fitted_width) / 2,
            y: self.y + (self.height - fitted_height) / 2,
            width: fitted_width,
            height: fitted_height,
        })
    }

    /// Shrunk around its center to `ratio`, unless it's already within a pixel of it.
    pub fn held_to(self, ratio: Option<f64>) -> Self {
        self.fitted(ratio).unwrap_or(self)
    }

    /// This rectangle with `handle` moved by `dx`, `dy` image pixels, inside a `width` × `height`
    /// image and at least a pixel each way. Free of a ratio, edges move on their own. Held to
    /// one, a corner keeps the opposite corner still, and an edge keeps the opposite edge still
    /// while the crop grows or shrinks evenly to both sides.
    pub fn dragged(
        self,
        handle: Handle,
        dx: f64,
        dy: f64,
        ratio: Option<f64>,
        width: u32,
        height: u32,
    ) -> Self {
        let (image_width, image_height) = (f64::from(width), f64::from(height));
        let (left, top) = (f64::from(self.x), f64::from(self.y));
        let (right, bottom) = (left + f64::from(self.width), top + f64::from(self.height));
        let (side_x, side_y) = handle.sides();

        if handle == Handle::Whole {
            let x = within((left + dx).round(), 0., image_width - f64::from(self.width));
            let y = within(
                (top + dy).round(),
                0.,
                image_height - f64::from(self.height),
            );
            return Self {
                x: x as u32,
                y: y as u32,
                ..self
            };
        }

        let Some(ratio) = ratio else {
            // Each moving edge stops a pixel short of the opposite one.
            let edge = |start: f64, end: f64, side: i8, delta: f64, limit: f64| match side {
                -1 => (within((start + delta).round(), 0., end - 1.), end),
                1 => (start, within((end + delta).round(), start + 1., limit)),
                _ => (start, end),
            };
            let (left, right) = edge(left, right, side_x, dx, image_width);
            let (top, bottom) = edge(top, bottom, side_y, dy, image_height);
            return Self {
                x: left as u32,
                y: top as u32,
                width: (right - left) as u32,
                height: (bottom - top) as u32,
            };
        };

        // How far the crop can reach along one axis: from the still edge to the image's edge,
        // or, when neither edge moves, twice the distance from its center to the nearer side.
        let room = |start: f64, end: f64, side: i8, limit: f64| match side {
            -1 => end,
            1 => limit - start,
            _ => 2. * ((start + end) / 2.).min(limit - (start + end) / 2.),
        };
        let (old_width, old_height) = (right - left, bottom - top);
        let proposed_width = old_width + f64::from(side_x) * dx;
        let proposed_height = old_height + f64::from(side_y) * dy;
        // A corner follows whichever axis the pointer moved further, relative to the crop.
        let wanted_width = match (side_x, side_y) {
            (0, _) => proposed_height * ratio,
            (_, 0) => proposed_width,
            _ if (proposed_width / old_width - 1.).abs()
                >= (proposed_height / old_height - 1.).abs() =>
            {
                proposed_width
            }
            _ => proposed_height * ratio,
        };
        let widest = room(left, right, side_x, image_width)
            .min(room(top, bottom, side_y, image_height) * ratio);
        // Whole pixels that never pass the room available, so the crop stays inside the image.
        let new_width =
            within(wanted_width.min(widest.floor()), ratio.max(1.), image_width).round();
        let new_height = within((new_width / ratio).round(), 1., image_height);
        let place = |start: f64, end: f64, side: i8, length: f64, limit: f64| match side {
            -1 => end - length,
            1 => start,
            _ => within(((start + end - length) / 2.).round(), 0., limit - length),
        };
        Self {
            x: place(left, right, side_x, new_width, image_width) as u32,
            y: place(top, bottom, side_y, new_height, image_height) as u32,
            width: new_width as u32,
            height: new_height as u32,
        }
    }
}

/// A crop and the shape it's held to.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Crop {
    pub rect: Rect,
    pub aspect: Aspect,
}
