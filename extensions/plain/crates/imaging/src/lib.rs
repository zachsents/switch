//! Image work for the suite's apps, done by macOS: reading and writing files with ImageIO,
//! replacing files safely, adjusting with Core Image, finding subjects with Vision and drawing
//! markup with CoreGraphics and CoreText. Pixels pass between functions as upright `RgbaImage`s
//! in sRGB with straight alpha.

pub mod adjust;
mod bitmap;
pub mod clipboard;
pub mod codec;
pub mod draw;
pub mod file;
pub mod subject;

pub use bitmap::from_cg_image;
pub use image::RgbaImage;
