//! The shown image as a window draws it, turned and mirrored the way its edits say, at two
//! resolutions: a small copy that looks clean when the whole image fits the window, and the
//! full image for zooming in. GPUI draws without mipmaps, so shrinking the full image on screen
//! would shimmer.

use std::{path::PathBuf, sync::Arc};

use gpui::RenderImage;
use image::{Frame, RgbaImage};

use crate::{edits::Orientation, render};

/// Pixels on the small copy's longer side.
const SMALL: u32 = 2048;
/// The largest texture GPUI can hold.
const LARGEST: u32 = 16384;

pub struct Textures {
    pub path: PathBuf,
    /// The small copy before turning, so turning again is instant.
    pub base: Arc<RgbaImage>,
    /// The way round these were made.
    pub orientation: Orientation,
    /// The turned image's size, in its own pixels.
    pub width: u32,
    pub height: u32,
    pub small: Arc<RenderImage>,
    /// Made after the small copy, since it takes longer.
    pub full: Option<Arc<RenderImage>>,
}

impl Textures {
    /// Whether these show `path` the way round given.
    pub fn matches(&self, path: &std::path::Path, orientation: Orientation) -> bool {
        self.path == path && self.orientation == orientation
    }
}

/// The small copy of `original`, before turning.
pub fn base(original: &RgbaImage) -> RgbaImage {
    render::shrink(original, SMALL)
}

/// The full image, turned and mirrored, shrunk only if it's too big for a texture.
pub fn full(original: &RgbaImage, orientation: Orientation) -> RgbaImage {
    render::orient(&render::shrink(original, LARGEST), orientation)
}

/// Pixels as GPUI draws them, which is BGRA.
pub fn render_image(mut pixels: RgbaImage) -> Arc<RenderImage> {
    for pixel in pixels.pixels_mut() {
        pixel.0.swap(0, 2);
    }
    Arc::new(RenderImage::new([Frame::new(pixels)]))
}
