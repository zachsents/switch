//! Crops said in words: "square", "16:9", "4:5 from the top", "Instagram story", "the left
//! half", "trim 10% off every side". A local parser reads the usual forms instantly and the
//! suite's decision model reads the rest. Either way the words become a [`Framing`], which is
//! placed on an image as a [`Crop`].

use ai::Provider;
use gpui::{App, Task};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::crop::{Aspect, Crop, Rect};

const HINT: &str = "Try square, 16:9, the left half or trim 10%";

/// Words that add nothing to where a crop goes, like "the" in "the left half".
const FILLER: &[&str] = &[
    "the", "a", "an", "to", "at", "on", "from", "in", "of", "into", "for", "with", "and", "crop",
    "keep", "just", "only", "make", "it", "image", "photo", "picture", "aligned", "against",
    "side", "edge", "corner", "part", "px", "pixels",
];

/// Which part of an image to keep, as words describe it, before it's placed on an image.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Framing {
    /// The whole image, uncropped.
    Whole,
    /// The whole image, held to its own shape while it's edited.
    Original,
    /// The largest crop of a shape that fits in the image.
    Shape {
        /// The shape's width, as one side of a ratio: 16 for 16:9 (wide), 9 for 9:16 (tall),
        /// 1 for a square.
        width: f64,
        /// The shape's height, as the other side of the ratio.
        height: f64,
        #[serde(default)]
        at: Place,
    },
    /// A crop of exactly this many pixels.
    Size {
        width: u32,
        height: u32,
        #[serde(default)]
        at: Place,
    },
    /// The image with a share of each side cut off, in percent: `left` and `right` of its
    /// width, `top` and `bottom` of its height. Keeping the left half is `right: 50`, keeping
    /// the top third is `bottom: 66.67`, and trimming 10% all round is 10 on every side.
    Trim {
        #[serde(default)]
        left: f64,
        #[serde(default)]
        top: f64,
        #[serde(default)]
        right: f64,
        #[serde(default)]
        bottom: f64,
    },
}

/// Where a crop smaller than the image sits in it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Place {
    #[default]
    Center,
    Top,
    Bottom,
    Left,
    Right,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl Place {
    /// How far along each axis the crop sits: 0 at the left or top, 0.5 in the middle, 1 at the
    /// right or bottom.
    fn along(self) -> (f64, f64) {
        match self {
            Self::Center => (0.5, 0.5),
            Self::Top => (0.5, 0.),
            Self::Bottom => (0.5, 1.),
            Self::Left => (0., 0.5),
            Self::Right => (1., 0.5),
            Self::TopLeft => (0., 0.),
            Self::TopRight => (1., 0.),
            Self::BottomLeft => (0., 1.),
            Self::BottomRight => (1., 1.),
        }
    }

    /// The place named by a horizontal side (-1 left, 0 neither, 1 right) and a vertical one
    /// (-1 top, 0 neither, 1 bottom).
    fn from_sides(horizontal: i8, vertical: i8) -> Self {
        match (horizontal, vertical) {
            (-1, -1) => Self::TopLeft,
            (1, -1) => Self::TopRight,
            (-1, 1) => Self::BottomLeft,
            (1, 1) => Self::BottomRight,
            (-1, _) => Self::Left,
            (1, _) => Self::Right,
            (_, -1) => Self::Top,
            (_, 1) => Self::Bottom,
            _ => Self::Center,
        }
    }
}

/// An edge of the image, or its middle, as words name them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Side {
    Left,
    Right,
    Top,
    Bottom,
    Middle,
}

impl Side {
    fn read(word: &str) -> Option<Self> {
        Some(match word {
            "left" => Self::Left,
            "right" => Self::Right,
            "top" | "upper" => Self::Top,
            "bottom" | "lower" => Self::Bottom,
            "center" | "centre" | "middle" | "centered" | "centred" => Self::Middle,
            _ => return None,
        })
    }
}

/// What each word of a crop said, gathered before deciding which kind of crop it is.
#[derive(Default)]
struct Words {
    whole: bool,
    original: bool,
    /// A ratio, width then height.
    shape: Option<(f64, f64)>,
    /// A size in pixels, width then height.
    size: Option<(u32, u32)>,
    /// Turned to be tall (true) or wide (false), whatever the ratio says.
    tall: Option<bool>,
    sides: Vec<Side>,
    /// A share of the image, like a half or two thirds.
    part: Option<f64>,
    percent: Option<f64>,
    /// "Trim", "cut", "off" and the like: the words say what to cut away, not what to keep.
    cut: bool,
    /// "Every", "all" or "each": every side.
    every: bool,
    /// "Sides" without "every": the left and right.
    both_sides: bool,
}

impl Framing {
    /// Reads a crop the way people type it: "square", "16:9", "4:5 tall", "16:9 from the top",
    /// "1080x1080", "original", "none", "the left half", "top two thirds", "top left quarter",
    /// "trim 10%", "10% off every side", "cut 5% off the top and bottom" or "remove the left
    /// third". Ratios are width:height as written, so 16:9 is wide and 9:16 tall.
    pub fn parse(input: &str) -> Result<Self, String> {
        let text = input
            .trim()
            .trim_end_matches(['.', '!'])
            .to_lowercase()
            .replace('×', "x")
            .replace(['-', ',', ';'], " ")
            .replace(" :", ":")
            .replace(": ", ":");
        let tokens: Vec<_> = text
            .split_whitespace()
            .filter(|word| !FILLER.contains(word))
            .collect();
        let words = Self::gather(&tokens).ok_or(HINT)?;
        Self::decide(words).ok_or_else(|| HINT.into())
    }

    /// What each word says. None when a word means nothing to the parser.
    fn gather(tokens: &[&str]) -> Option<Words> {
        let mut words = Words::default();
        let mut count = None;
        let mut index = 0;
        while index < tokens.len() {
            let word = tokens[index];
            let next = tokens.get(index + 1).copied();
            let after = tokens.get(index + 2).copied();
            index += 1;
            // "16 x 9", "1080 by 1350", "10 %" and "10 percent" span several words.
            if let (Some("x" | "by"), Some(height)) = (next, after)
                && let Some(pair) = pair(word, height)
            {
                words.read_pair(pair)?;
                index += 2;
                continue;
            }
            if let (Some("%" | "percent" | "pc"), Ok(percent)) = (next, word.parse::<f64>()) {
                words.percent = Some(percent);
                index += 1;
                continue;
            }
            if let Some(side) = Side::read(word) {
                words.sides.push(side);
                continue;
            }
            match word {
                "none" | "no" | "uncrop" | "uncropped" | "whole" | "full" | "everything"
                | "entire" => words.whole = true,
                "original" => words.original = true,
                "square" => words.read_pair(Pair::Ratio(1., 1.))?,
                "portrait" | "tall" | "vertical" | "upright" => words.tall = Some(true),
                "landscape" | "wide" | "horizontal" => words.tall = Some(false),
                "trim" | "trimmed" | "cut" | "remove" | "take" | "shave" | "off" | "lose"
                | "drop" | "chop" | "inset" => words.cut = true,
                "every" | "each" | "all" | "around" | "edges" => words.every = true,
                "sides" | "both" => words.both_sides = true,
                "one" | "1" => count = Some(1.),
                "two" | "2" => count = Some(2.),
                "three" | "3" => count = Some(3.),
                "half" | "third" | "thirds" | "quarter" | "quarters" => {
                    let whole: f64 = match word {
                        "half" => 2.,
                        "third" | "thirds" => 3.,
                        _ => 4.,
                    };
                    let share = count.take().unwrap_or(1.) / whole;
                    if share >= 1. || words.part.replace(share).is_some() {
                        return None;
                    }
                }
                _ if word.ends_with('%') => {
                    words.percent = Some(word.trim_end_matches('%').parse().ok()?);
                }
                _ => {
                    let (width, height) = word.split_once([':', '/', 'x'])?;
                    words.read_pair(pair(width, height)?)?;
                }
            }
        }
        count.is_none().then_some(words)
    }

    /// The crop the gathered words make, if they make one.
    fn decide(words: Words) -> Option<Self> {
        let Words {
            whole,
            original,
            shape,
            size,
            tall,
            sides,
            part,
            percent,
            cut,
            every,
            both_sides,
        } = words;
        let shaped = shape.is_some() || size.is_some();
        // A percentage alone, like "10%", could be a size as easily as a trim.
        if percent.is_some() && !cut {
            return None;
        }
        if whole || original {
            let alone = !(shaped || cut || part.is_some() || tall.is_some())
                && sides.is_empty()
                && !(whole && original);
            return alone.then_some(if whole { Self::Whole } else { Self::Original });
        }
        if cut {
            if shaped || tall.is_some() {
                return None;
            }
            return match (percent, part) {
                (Some(percent), None) => Self::trim_sides(&sides, percent, every, both_sides),
                // "Cut off the left half": a share off one side.
                (None, Some(part)) if !every && !both_sides => match sides[..] {
                    [side] => Self::trim_sides(&[side], part * 100., false, false),
                    _ => None,
                },
                _ => None,
            };
        }
        if every || both_sides {
            return None;
        }
        if let Some(part) = part {
            if shaped || tall.is_some() {
                return None;
            }
            return Self::keep_part(&sides, part);
        }
        let at = place(&sides)?;
        match (shape, size) {
            (Some((width, height)), None) => {
                let (width, height) = match tall {
                    Some(tall) if tall != (height > width) => (height, width),
                    _ => (width, height),
                };
                Some(Self::Shape { width, height, at })
            }
            (None, Some((width, height))) if tall.is_none() => {
                Some(Self::Size { width, height, at })
            }
            _ => None,
        }
    }

    /// `percent` cut off the named sides, or every side when none are named or `every`
    /// says so. Just "sides" means the left and right.
    fn trim_sides(sides: &[Side], percent: f64, every: bool, both_sides: bool) -> Option<Self> {
        if sides.contains(&Side::Middle) {
            return None;
        }
        let all = every || (sides.is_empty() && !both_sides);
        let cut = |side| {
            let named =
                sides.contains(&side) || (both_sides && matches!(side, Side::Left | Side::Right));
            if all || named { percent } else { 0. }
        };
        Some(Self::Trim {
            left: cut(Side::Left),
            top: cut(Side::Top),
            right: cut(Side::Right),
            bottom: cut(Side::Bottom),
        })
    }

    /// Keeps `part` of the image against one side, like the left half, or a quarter in a
    /// corner, like the top left quarter.
    fn keep_part(sides: &[Side], part: f64) -> Option<Self> {
        let cut = (1. - part) * 100.;
        let trim = |left, top, right, bottom| Self::Trim {
            left,
            top,
            right,
            bottom,
        };
        let framing = match sides {
            [Side::Left] => trim(0., 0., cut, 0.),
            [Side::Right] => trim(cut, 0., 0., 0.),
            [Side::Top] => trim(0., 0., 0., cut),
            [Side::Bottom] => trim(0., cut, 0., 0.),
            [first, second] if part == 0.25 => {
                let place = place(&[*first, *second])?;
                let (along_x, along_y) = place.along();
                if along_x == 0.5 || along_y == 0.5 {
                    return None;
                }
                let half = |along: f64| (along * 50., (1. - along) * 50.);
                let ((left, right), (top, bottom)) = (half(along_x), half(along_y));
                trim(left, top, right, bottom)
            }
            _ => return None,
        };
        Some(framing)
    }

    /// The crop this makes on a `width` × `height` image, or None for the whole image with a
    /// free shape, which is no crop at all.
    pub fn crop_on(self, width: u32, height: u32) -> Result<Option<Crop>, String> {
        let whole = Rect::whole(width, height);
        let (rect, aspect) = match self {
            Self::Whole => (whole, Aspect::Free),
            Self::Original => (whole, Aspect::Original),
            Self::Shape {
                width: shape_width,
                height: shape_height,
                at,
            } => {
                let fine = |side: f64| side.is_finite() && side > 0.;
                if !fine(shape_width) || !fine(shape_height) {
                    return Err("A shape needs a width and a height".into());
                }
                let ratio = shape_width / shape_height;
                let rect = placed(Rect::centered(Some(ratio), width, height), at, whole);
                (
                    rect,
                    held_shape(shape_width, shape_height, ratio, width, height),
                )
            }
            Self::Size {
                width: crop_width,
                height: crop_height,
                at,
            } => {
                if crop_width == 0 || crop_height == 0 {
                    return Err("A crop needs a width and a height".into());
                }
                if crop_width > width || crop_height > height {
                    return Err(format!(
                        "A {crop_width} × {crop_height} crop doesn't fit in the {width} × \
                         {height} image"
                    ));
                }
                let rect = Rect {
                    x: 0,
                    y: 0,
                    width: crop_width,
                    height: crop_height,
                };
                (placed(rect, at, whole), Aspect::Free)
            }
            Self::Trim {
                left,
                top,
                right,
                bottom,
            } => (
                trimmed(width, height, [left, top, right, bottom])?,
                Aspect::Free,
            ),
        };
        Ok((rect != whole || aspect != Aspect::Free).then_some(Crop { rect, aspect }))
    }
}

/// Two numbers from a ratio or size like "16:9" or "1080x1080". Small whole numbers are a
/// ratio and larger ones a size in pixels.
fn pair(width: &str, height: &str) -> Option<Pair> {
    let number = |side: &str| {
        side.trim()
            .trim_end_matches("px")
            .parse::<f64>()
            .ok()
            .filter(|side| side.is_finite() && *side > 0.)
    };
    let (width, height) = (number(width)?, number(height)?);
    let whole = |side: f64| side.fract() == 0.;
    Some(
        if whole(width) && whole(height) && width.max(height) > 32. {
            Pair::Pixels(width as u32, height as u32)
        } else {
            Pair::Ratio(width, height)
        },
    )
}

enum Pair {
    Ratio(f64, f64),
    Pixels(u32, u32),
}

impl Words {
    /// Takes a ratio or size, unless there's one already.
    fn read_pair(&mut self, pair: Pair) -> Option<()> {
        let taken = match pair {
            Pair::Ratio(width, height) => self.shape.replace((width, height)).is_some(),
            Pair::Pixels(width, height) => self.size.replace((width, height)).is_some(),
        };
        (!taken && !(self.shape.is_some() && self.size.is_some())).then_some(())
    }
}

/// Where the named sides put a crop: at most one of left and right and one of top and bottom,
/// and "middle" for neither.
fn place(sides: &[Side]) -> Option<Place> {
    let mut horizontal = None;
    let mut vertical = None;
    for &side in sides {
        let (axis, value) = match side {
            Side::Left => (&mut horizontal, -1),
            Side::Right => (&mut horizontal, 1),
            Side::Top => (&mut vertical, -1),
            Side::Bottom => (&mut vertical, 1),
            Side::Middle => continue,
        };
        if axis.replace(value).is_some_and(|before| before != value) {
            return None;
        }
    }
    Some(Place::from_sides(
        horizontal.unwrap_or(0),
        vertical.unwrap_or(0),
    ))
}

/// `rect` moved to `at` inside `whole`.
fn placed(rect: Rect, at: Place, whole: Rect) -> Rect {
    let (along_x, along_y) = at.along();
    let offset = |room: u32, along: f64| (f64::from(room) * along).floor() as u32;
    Rect {
        x: offset(whole.width - rect.width, along_x),
        y: offset(whole.height - rect.height, along_y),
        ..rect
    }
}

/// The shape a crop of `ratio` is held to as it's edited: the ratio itself when the window's
/// shapes can hold it on this image, which turn to match it, or free when they can't, like a
/// tall crop of a wide image.
fn held_shape(shape_width: f64, shape_height: f64, ratio: f64, width: u32, height: u32) -> Aspect {
    let whole = |side: f64| (side.fract() == 0. && side <= 1000.).then_some(side as u32);
    let (Some(long), Some(short)) = (
        whole(shape_width.max(shape_height)),
        whole(shape_width.min(shape_height)),
    ) else {
        return Aspect::Free;
    };
    let aspect = Aspect::ratio(long, short);
    let holds = aspect
        .ratio_on(width, height)
        .is_some_and(|held| (held - ratio).abs() < 1e-9);
    if holds { aspect } else { Aspect::Free }
}

/// A `width` × `height` image with a percentage cut off its left, top, right and bottom.
fn trimmed(width: u32, height: u32, [left, top, right, bottom]: [f64; 4]) -> Result<Rect, String> {
    let fine = |percent: f64| (0. ..100.).contains(&percent);
    if ![left, top, right, bottom].into_iter().all(fine)
        || left + right >= 100.
        || top + bottom >= 100.
    {
        return Err("That trims away the whole image".into());
    }
    let span = |length: u32, start: f64, end: f64| {
        let length = f64::from(length);
        let from = (length * start / 100.).round();
        let to = (length - (length * end / 100.).round()).max(from + 1.);
        (from as u32, (to - from) as u32)
    };
    let (x, crop_width) = span(width, left, right);
    let (y, crop_height) = span(height, top, bottom);
    Ok(Rect {
        x,
        y,
        width: crop_width,
        height: crop_height,
    })
}

/// Reads a crop however someone put it. The parser takes the usual forms instantly; anything
/// else, like "Instagram story" or "a passport photo", goes to the suite's decision model, told
/// the image is `width` × `height`. Without an AI key only the parser's forms work.
pub fn understand(
    input: String,
    width: u32,
    height: u32,
    cx: &App,
) -> Task<Result<Framing, String>> {
    if let Ok(framing) = Framing::parse(&input) {
        return Task::ready(Ok(framing));
    }
    cx.background_executor().spawn(async move {
        let key = ai::keys::find(Provider::Gateway).ok_or("Couldn't read that crop")?;
        let task = format!(
            "Someone is cropping an image that is {width} × {height} pixels and typed which part \
             to keep. Read it as one of the crops in the schema. Crops are centered unless the \
             words say where. Shapes are width:height as written, so 16:9 is wide and 9:16 \
             tall. For named targets use their usual shapes: an Instagram post 1:1, an \
             Instagram portrait post 4:5, a story or reel 9:16, a YouTube thumbnail 16:9, an X \
             header 3:1, a LinkedIn banner 4:1, a passport photo 35:45, A4 paper 210:297 tall, \
             a phone wallpaper 9:19.5. Cutting part of a side away is a trim."
        );
        let framing: Framing = ai::decide(&key, &task, &input)?;
        framing.crop_on(width, height)?;
        Ok(framing)
    })
}
