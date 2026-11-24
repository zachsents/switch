//! Applying edits to pixels. No UI, so it runs on background threads for saving, exporting,
//! copying and the window's picture alike.

use fast_image_resize::{FilterType, ResizeAlg, ResizeOptions, Resizer};
use image::{RgbaImage, imageops};
use imaging::draw::{self, Point};

use crate::{
    edits::{Edits, Orientation},
    size::Size,
};

/// The finished image: `original` turned, mirrored and cropped, with its marks drawn on, then
/// resized, as `edits` say.
pub fn render(original: &RgbaImage, edits: &Edits) -> RgbaImage {
    let turned = orient(original, edits.orientation());
    let (mut cropped, origin) = match edits.crop {
        Some(crop) => {
            let rect = crop.rect;
            let cropped =
                imageops::crop_imm(&turned, rect.x, rect.y, rect.width, rect.height).to_image();
            (
                cropped,
                Point {
                    x: rect.x as f32,
                    y: rect.y as f32,
                },
            )
        }
        None => (turned, Point::default()),
    };
    if !edits.marks.is_empty() {
        draw::draw(&mut cropped, &edits.marks, origin, 1.);
    }
    let (width, height) = edits.size.apply(cropped.width(), cropped.height());
    resize(&cropped, width, height)
}

/// `image` turned and mirrored, without cropping or resizing: what the window shows while
/// cropping.
pub fn orient(image: &RgbaImage, orientation: Orientation) -> RgbaImage {
    let turned = match orientation.turns % 4 {
        1 => imageops::rotate90(image),
        2 => imageops::rotate180(image),
        3 => imageops::rotate270(image),
        _ => image.clone(),
    };
    if orientation.mirrored {
        imageops::flip_horizontal(&turned)
    } else {
        turned
    }
}

/// A copy at most `longest` pixels on its longer side, for showing on screen. Never enlarges.
pub fn shrink(image: &RgbaImage, longest: u32) -> RgbaImage {
    let (width, height) = Size::Longest { pixels: longest }.apply(image.width(), image.height());
    resize(image, width, height)
}

/// Resizes to exactly `width` × `height` with a high-quality filter. Transparent edges stay
/// clean, since colors are weighted by their alpha.
fn resize(image: &RgbaImage, width: u32, height: u32) -> RgbaImage {
    if (width, height) == image.dimensions() {
        return image.clone();
    }
    let mut resized = RgbaImage::new(width, height);
    let options = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3));
    Resizer::new()
        .resize(image, &mut resized, &options)
        .expect("RGBA8 resizes into RGBA8 of any nonzero size");
    resized
}
