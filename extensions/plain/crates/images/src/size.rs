use ai::Provider;
use gpui::{App, Task};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

const HINT: &str = "Try original, 1200, 50%, 1200 wide or 1200x800";
const LARGEST: u32 = 20_000;

/// How big an image comes out. Pixel sizes only ever shrink an image; a percentage can also
/// enlarge it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Size {
    /// The image's own size.
    Original,
    /// Scaled by a percentage: 50 is half, 200 is double. From 1 to 400.
    Percent { percent: f32 },
    /// The longer side at most this many pixels.
    Longest { pixels: u32 },
    /// This many pixels wide.
    Width { pixels: u32 },
    /// This many pixels tall.
    Height { pixels: u32 },
    /// Inside a box, keeping proportions.
    Fit { width: u32, height: u32 },
}

impl Size {
    /// Reads a size the way people type it: "original", "50%", "half", "1200" (the longer side),
    /// "1200px", "1200 wide", "800 tall", "1200x800" or "1200 by 800".
    pub fn parse(input: &str) -> Result<Self, String> {
        let text = input.trim().to_lowercase().replace('×', "x");
        let words: Vec<_> = text.split_whitespace().collect();
        let pixels = |word: &str| -> Option<u32> {
            let number: u32 = word.strip_suffix("px").unwrap_or(word).parse().ok()?;
            (1..=LARGEST).contains(&number).then_some(number)
        };
        let size = match words[..] {
            [] | ["original"] | ["same"] | ["full"] | ["full", "size"] | ["100%"] => Self::Original,
            ["half"] => Self::Percent { percent: 50. },
            ["quarter"] => Self::Percent { percent: 25. },
            [word] if word.ends_with('%') => {
                let percent: f32 = word.trim_end_matches('%').parse().map_err(|_| HINT)?;
                if !(1. ..=400.).contains(&percent) {
                    return Err("A percentage has to be between 1% and 400%".into());
                }
                Self::Percent { percent }
            }
            [number, "%"] => return Self::parse(&format!("{number}%")),
            [word] if word.contains('x') && !word.ends_with("px") => {
                let (width, height) = word.split_once('x').ok_or(HINT)?;
                Self::Fit {
                    width: pixels(width).ok_or(HINT)?,
                    height: pixels(height).ok_or(HINT)?,
                }
            }
            [width, "x" | "by", height] => Self::Fit {
                width: pixels(width).ok_or(HINT)?,
                height: pixels(height).ok_or(HINT)?,
            },
            [word] => match word.strip_suffix('w').or(word.strip_suffix('h')) {
                Some(number) if word.ends_with('w') => Self::Width {
                    pixels: pixels(number).ok_or(HINT)?,
                },
                Some(number) => Self::Height {
                    pixels: pixels(number).ok_or(HINT)?,
                },
                None => Self::Longest {
                    pixels: pixels(word).ok_or(HINT)?,
                },
            },
            [number, "wide" | "width" | "w"] | ["width" | "w", number] => Self::Width {
                pixels: pixels(number).ok_or(HINT)?,
            },
            [number, "tall" | "high" | "height" | "h"] | ["height" | "h", number] => Self::Height {
                pixels: pixels(number).ok_or(HINT)?,
            },
            [number, "max" | "longest"] | ["max" | "longest", number] => Self::Longest {
                pixels: pixels(number).ok_or(HINT)?,
            },
            _ => return Err(HINT.into()),
        };
        Ok(size)
    }

    /// The same size, if it's one the app can make.
    fn checked(self) -> Result<Self, String> {
        let pixels_fit = |pixels: u32| (1..=LARGEST).contains(&pixels);
        let fine = match self {
            Self::Original => true,
            Self::Percent { percent } => (1. ..=400.).contains(&percent),
            Self::Longest { pixels } | Self::Width { pixels } | Self::Height { pixels } => {
                pixels_fit(pixels)
            }
            Self::Fit { width, height } => pixels_fit(width) && pixels_fit(height),
        };
        fine.then_some(self)
            .ok_or_else(|| "That size is out of range".to_string())
    }

    /// The exported dimensions of a `width` × `height` image.
    pub fn apply(self, width: u32, height: u32) -> (u32, u32) {
        let (w, h) = (width as f64, height as f64);
        let scale = match self {
            Self::Original => 1.,
            Self::Percent { percent } => percent as f64 / 100.,
            Self::Longest { pixels } => (pixels as f64 / w.max(h)).min(1.),
            Self::Width { pixels } => (pixels as f64 / w).min(1.),
            Self::Height { pixels } => (pixels as f64 / h).min(1.),
            Self::Fit { width, height } => (width as f64 / w).min(height as f64 / h).min(1.),
        };
        let round = |side: f64| ((side * scale).round() as u32).max(1);
        (round(w), round(h))
    }

    /// How the size reads in the window, like "1200 px on the longer side".
    pub fn describe(self) -> String {
        match self {
            Self::Original => "Original size".into(),
            Self::Percent { percent } => format!("{percent}%"),
            Self::Longest { pixels } => format!("{pixels} px on the longer side"),
            Self::Width { pixels } => format!("{pixels} px wide"),
            Self::Height { pixels } => format!("{pixels} px tall"),
            Self::Fit { width, height } => format!("Fits in {width} × {height}"),
        }
    }

    /// The text that edits back to this size.
    pub fn as_input(self) -> String {
        match self {
            Self::Original => "original".into(),
            Self::Percent { percent } => format!("{percent}%"),
            Self::Longest { pixels } => pixels.to_string(),
            Self::Width { pixels } => format!("{pixels} wide"),
            Self::Height { pixels } => format!("{pixels} tall"),
            Self::Fit { width, height } => format!("{width}x{height}"),
        }
    }
}

/// Reads a size however someone put it. The parser takes the usual forms instantly; anything
/// else, like "small enough to email" or "fit a 4K screen", goes to the suite's decision model,
/// told the image is `width` × `height`. Without an AI key only the parser's forms work.
pub fn understand(input: String, width: u32, height: u32, cx: &App) -> Task<Result<Size, String>> {
    if let Ok(size) = Size::parse(&input) {
        return Task::ready(Ok(size));
    }
    cx.background_executor().spawn(async move {
        let key = ai::keys::find(Provider::Gateway).ok_or("Couldn't read that size")?;
        let task = format!(
            "Someone is resizing an image that is {width} × {height} pixels and typed how big \
             it should be. Read it as one of the sizes in the schema. Pixel sizes only ever \
             shrink an image, so to enlarge it answer with a percentage. For named targets use \
             their usual sizes: an email attachment about 1600 pixels on the longer side, an \
             Instagram post 1080 wide, 1080p 1920 × 1080, 4K 3840 × 2160."
        );
        ai::decide::<Size>(&key, &task, &input)?.checked()
    })
}
