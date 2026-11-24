//! What's been done to an image, kept apart from its file so every step can be undone and the
//! file is only written on Save. Plain data with no UI, shared by the window and agents.

use imaging::draw::{Mark, Point};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::{
    crop::{Crop, Rect},
    size::Size,
};

/// Every change made to an image since it was opened or saved.
#[derive(Clone, Debug, PartialEq)]
pub struct Edits {
    /// Quarter turns clockwise, 0 to 3, applied to the image first.
    pub turns: u8,
    /// Mirrored left to right after turning. With turns, this covers every rotation and flip.
    pub mirrored: bool,
    /// The part kept, in the pixels of the turned image. None keeps all of it.
    pub crop: Option<Crop>,
    /// How big the result is.
    pub size: Size,
    /// Markup drawn over the image, in the pixels of the turned image, from bottom to top.
    pub marks: Vec<Mark>,
}

impl Default for Edits {
    fn default() -> Self {
        Self {
            turns: 0,
            mirrored: false,
            crop: None,
            size: Size::Original,
            marks: Vec::new(),
        }
    }
}

/// Which way round an image is: its turns and mirroring, without the rest of its edits.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Orientation {
    /// Quarter turns clockwise, 0 to 3.
    pub turns: u8,
    /// Mirrored left to right after turning.
    pub mirrored: bool,
}

/// Which way to turn an image.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Turn {
    /// A quarter turn counterclockwise.
    Left,
    /// A quarter turn clockwise.
    Right,
}

/// Which way to mirror an image.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum FlipDirection {
    /// Left becomes right.
    Horizontal,
    /// Top becomes bottom.
    Vertical,
}

impl Edits {
    pub fn is_unchanged(&self) -> bool {
        *self == Self::default()
    }

    pub fn orientation(&self) -> Orientation {
        Orientation {
            turns: self.turns,
            mirrored: self.mirrored,
        }
    }

    /// The size of a `width` × `height` image once turned.
    pub fn turned_size(&self, width: u32, height: u32) -> (u32, u32) {
        if self.turns % 2 == 1 {
            (height, width)
        } else {
            (width, height)
        }
    }

    /// The size of a `width` × `height` image once turned and cropped.
    pub fn cropped_size(&self, width: u32, height: u32) -> (u32, u32) {
        self.crop.map_or_else(
            || self.turned_size(width, height),
            |crop| (crop.rect.width, crop.rect.height),
        )
    }

    /// The size of the finished image.
    pub fn output_size(&self, width: u32, height: u32) -> (u32, u32) {
        let (width, height) = self.cropped_size(width, height);
        self.size.apply(width, height)
    }

    /// These edits with the image turned a quarter turn. The crop and marks turn with it.
    /// `width` and `height` are the original image's.
    pub fn turned(self, turn: Turn, width: u32, height: u32) -> Self {
        // Turning a mirrored image clockwise is the same as mirroring an image turned the other
        // way, so mirrored images count their turns backwards.
        let clockwise = (turn == Turn::Right) != self.mirrored;
        let (turned_width, turned_height) = self.turned_size(width, height);
        let crop = self.crop.map(|crop| Crop {
            rect: match turn {
                Turn::Right => Rect {
                    x: turned_height - crop.rect.y - crop.rect.height,
                    y: crop.rect.x,
                    width: crop.rect.height,
                    height: crop.rect.width,
                },
                Turn::Left => Rect {
                    x: crop.rect.y,
                    y: turned_width - crop.rect.x - crop.rect.width,
                    width: crop.rect.height,
                    height: crop.rect.width,
                },
            },
            ..crop
        });
        let (turned_width, turned_height) = (turned_width as f32, turned_height as f32);
        let marks = map_marks(&self.marks, |point| match turn {
            Turn::Right => Point {
                x: turned_height - point.y,
                y: point.x,
            },
            Turn::Left => Point {
                x: point.y,
                y: turned_width - point.x,
            },
        });
        Self {
            turns: (self.turns + if clockwise { 1 } else { 3 }) % 4,
            crop,
            marks,
            ..self
        }
    }

    /// These edits with the image mirrored. The crop and marks mirror with it; text still reads
    /// left to right.
    pub fn flipped(self, flip: FlipDirection, width: u32, height: u32) -> Self {
        let (turned_width, turned_height) = self.turned_size(width, height);
        let crop = self.crop.map(|crop| Crop {
            rect: match flip {
                FlipDirection::Horizontal => Rect {
                    x: turned_width - crop.rect.x - crop.rect.width,
                    ..crop.rect
                },
                FlipDirection::Vertical => Rect {
                    y: turned_height - crop.rect.y - crop.rect.height,
                    ..crop.rect
                },
            },
            ..crop
        });
        // Mirroring top to bottom is turning halfway round and mirroring left to right.
        let turns = match flip {
            FlipDirection::Horizontal => self.turns,
            FlipDirection::Vertical => (self.turns + 2) % 4,
        };
        let (turned_width, turned_height) = (turned_width as f32, turned_height as f32);
        let marks = map_marks(&self.marks, |point| match flip {
            FlipDirection::Horizontal => Point {
                x: turned_width - point.x,
                ..point
            },
            FlipDirection::Vertical => Point {
                y: turned_height - point.y,
                ..point
            },
        });
        Self {
            turns,
            mirrored: !self.mirrored,
            crop,
            marks,
            ..self
        }
    }
}

fn map_marks(marks: &[Mark], map: impl Fn(Point) -> Point) -> Vec<Mark> {
    marks.iter().map(|mark| mark.mapped(&map)).collect()
}
