//! The markup tools: which one is in use, how new marks look, and the mark a drag across the
//! picture makes. Plain data with no UI; the window holds the choices.

use imaging::draw::{Color, Mark, Point, Rect};
use kit::Icon;
use schemars::JsonSchema;
use serde::Deserialize;

/// What dragging across the picture does.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Tool {
    /// Pick marks to move, restyle or delete.
    #[default]
    Select,
    Pen,
    Highlight,
    Line,
    Arrow,
    Rectangle,
    Ellipse,
    Text,
    Redact,
}

impl Tool {
    pub const ALL: [Self; 9] = [
        Self::Select,
        Self::Pen,
        Self::Highlight,
        Self::Line,
        Self::Arrow,
        Self::Rectangle,
        Self::Ellipse,
        Self::Text,
        Self::Redact,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::Select => "Select",
            Self::Pen => "Pen",
            Self::Highlight => "Highlighter",
            Self::Line => "Line",
            Self::Arrow => "Arrow",
            Self::Rectangle => "Rectangle",
            Self::Ellipse => "Ellipse",
            Self::Text => "Text",
            Self::Redact => "Redact",
        }
    }

    pub fn icon(self) -> Icon {
        match self {
            Self::Select => Icon::Pointer,
            Self::Pen => Icon::Pen,
            Self::Highlight => Icon::Highlighter,
            Self::Line => Icon::Line,
            Self::Arrow => Icon::Arrow,
            Self::Rectangle => Icon::Rectangle,
            Self::Ellipse => Icon::Ellipse,
            Self::Text => Icon::Text,
            Self::Redact => Icon::Redact,
        }
    }

    /// The key that picks it.
    pub fn key(self) -> &'static str {
        match self {
            Self::Select => "v",
            Self::Pen => "p",
            Self::Highlight => "h",
            Self::Line => "l",
            Self::Arrow => "a",
            Self::Rectangle => "r",
            Self::Ellipse => "o",
            Self::Text => "t",
            Self::Redact => "x",
        }
    }
}

/// How thick new lines are and how big new text is, in proportion to the image, so marks look
/// the same on a phone photo and a small screenshot.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Thickness {
    Thin,
    #[default]
    Medium,
    Thick,
}

impl Thickness {
    pub const ALL: [Self; 3] = [Self::Thin, Self::Medium, Self::Thick];

    pub fn label(self) -> &'static str {
        match self {
            Self::Thin => "Thin",
            Self::Medium => "Medium",
            Self::Thick => "Thick",
        }
    }

    fn scale(self) -> f32 {
        match self {
            Self::Thin => 0.5,
            Self::Medium => 1.,
            Self::Thick => 2.,
        }
    }

    /// A line's width in pixels, on an image whose longer side is `longest` pixels.
    pub fn line(self, longest: u32) -> f32 {
        (longest as f32 * 0.004 * self.scale()).max(2. * self.scale())
    }

    /// A highlighter stroke's width in pixels: fat, like a marker.
    pub fn highlight(self, longest: u32) -> f32 {
        self.line(longest) * 5.
    }

    /// A text size in pixels.
    pub fn text(self, longest: u32) -> f32 {
        let scale = match self {
            Self::Thin => 0.7,
            Self::Medium => 1.,
            Self::Thick => 1.6,
        };
        (longest as f32 * 0.03 * scale).max(14. * scale)
    }
}

/// How new marks look.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Style {
    /// The color of lines, shapes and text.
    pub ink: Color,
    /// The highlighter's color, kept apart so it stays a highlighter yellow while lines are red.
    pub highlight: Color,
    pub thickness: Thickness,
}

impl Default for Style {
    fn default() -> Self {
        Self {
            ink: Color::RED,
            highlight: Color::HIGHLIGHT,
            thickness: Thickness::Medium,
        }
    }
}

/// A palette color as a highlighter uses it: translucent, so what's under it shows through.
pub fn translucent(color: Color) -> Color {
    Color { a: 0x66, ..color }
}

/// The text a new text mark starts with, all selected so typing replaces it.
pub const NEW_TEXT: &str = "Text";

/// The mark dragging `tool` through `points` makes, in the image's pixels, on an image whose
/// longer side is `longest` pixels. None for a drag shorter than `least` pixels, which is a
/// click, or for tools that don't drag.
pub fn dragged(
    tool: Tool,
    points: &[Point],
    style: &Style,
    longest: u32,
    least: f32,
) -> Option<Mark> {
    let (&first, &last) = (points.first()?, points.last()?);
    let travelled = points
        .iter()
        .map(|point| (point.x - first.x).hypot(point.y - first.y))
        .fold(0., f32::max);
    if travelled < least {
        return None;
    }
    let width = style.thickness.line(longest);
    let rect = Rect::from_corners(first, last);
    let mark = match tool {
        Tool::Pen => Mark::Pen {
            points: points.to_vec(),
            color: style.ink,
            width,
        },
        Tool::Highlight => Mark::Highlight {
            points: points.to_vec(),
            color: style.highlight,
            width: style.thickness.highlight(longest),
        },
        Tool::Line => Mark::Line {
            from: first,
            to: last,
            color: style.ink,
            width,
        },
        Tool::Arrow => Mark::Arrow {
            from: first,
            to: last,
            color: style.ink,
            width,
        },
        Tool::Rectangle => Mark::Rectangle {
            rect,
            color: style.ink,
            width,
            fill: None,
        },
        Tool::Ellipse => Mark::Ellipse {
            rect,
            color: style.ink,
            width,
            fill: None,
        },
        Tool::Redact => Mark::Redact {
            rect,
            color: Color::BLACK,
        },
        Tool::Select | Tool::Text => return None,
    };
    Some(mark)
}

/// A new text mark at `at`, in the style.
pub fn text_at(at: Point, style: &Style, longest: u32) -> Mark {
    Mark::Text {
        at,
        text: NEW_TEXT.into(),
        size: style.thickness.text(longest),
        color: style.ink,
        bold: false,
        background: None,
    }
}

/// The topmost mark under `at`, within `tolerance` pixels. Later marks are drawn over earlier
/// ones, so they're found first.
pub fn mark_at(marks: &[Mark], at: Point, tolerance: f32) -> Option<usize> {
    marks.iter().rposition(|mark| mark.hit(at, tolerance))
}
