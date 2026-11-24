//! Moving pixels between `RgbaImage`s and CoreGraphics, which every macOS framework here works
//! in.

use std::{ffi::c_void, ptr};

use image::RgbaImage;
use objc2_core_foundation::{CFData, CFRetained, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapInfo, CGColorRenderingIntent, CGColorSpace, CGContext,
    CGDataProvider, CGImage, CGImageAlphaInfo, kCGColorSpaceSRGB,
};

/// sRGB, the color space every image here is in.
pub(crate) fn srgb() -> CFRetained<CGColorSpace> {
    CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB })).expect("macOS has sRGB")
}

/// A CGImage of a copy of `image`.
pub(crate) fn to_cg_image(image: &RgbaImage) -> CFRetained<CGImage> {
    let data = CFData::from_bytes(image.as_raw());
    let provider = CGDataProvider::with_cf_data(Some(&data)).expect("CoreGraphics takes any data");
    let width = image.width() as usize;
    unsafe {
        CGImage::new(
            width,
            image.height() as usize,
            8,
            32,
            width * 4,
            Some(&srgb()),
            CGBitmapInfo(CGImageAlphaInfo::Last.0),
            Some(&provider),
            ptr::null(),
            true,
            CGColorRenderingIntent::RenderingIntentDefault,
        )
    }
    .expect("RGBA8 images are valid CGImages")
}

/// `image` drawn into sRGB, converting from its own color space, like Display P3.
pub fn from_cg_image(image: &CGImage) -> RgbaImage {
    let canvas = Canvas::new(
        CGImage::width(Some(image)) as u32,
        CGImage::height(Some(image)) as u32,
    );
    CGContext::draw_image(Some(canvas.context()), canvas.bounds(), Some(image));
    canvas.into_image()
}

/// Pixels CoreGraphics draws into. CoreGraphics only draws into premultiplied alpha, so the
/// pixels are converted back to straight alpha when taken out.
pub(crate) struct Canvas {
    // Declared before `pixels` so it's dropped first: it draws into them.
    context: CFRetained<CGContext>,
    pixels: Vec<u8>,
    width: u32,
    height: u32,
}

impl Canvas {
    /// A transparent canvas. Its coordinates are CoreGraphics', with the origin at the bottom
    /// left.
    pub(crate) fn new(width: u32, height: u32) -> Self {
        let mut pixels = vec![0; width as usize * height as usize * 4];
        let context = unsafe {
            CGBitmapContextCreate(
                pixels.as_mut_ptr().cast::<c_void>(),
                width as usize,
                height as usize,
                8,
                width as usize * 4,
                Some(&srgb()),
                CGImageAlphaInfo::PremultipliedLast.0,
            )
        }
        .expect("CoreGraphics draws into RGBA8");
        Self {
            context,
            pixels,
            width,
            height,
        }
    }

    pub(crate) fn context(&self) -> &CGContext {
        &self.context
    }

    pub(crate) fn bounds(&self) -> CGRect {
        CGRect::new(
            CGPoint::new(0., 0.),
            CGSize::new(f64::from(self.width), f64::from(self.height)),
        )
    }

    pub(crate) fn into_image(self) -> RgbaImage {
        let Self {
            context,
            mut pixels,
            width,
            height,
        } = self;
        drop(context);
        unpremultiply(&mut pixels);
        RgbaImage::from_raw(width, height, pixels).expect("the canvas holds width × height pixels")
    }
}

fn unpremultiply(pixels: &mut [u8]) {
    for pixel in pixels.as_chunks_mut::<4>().0 {
        let alpha = u16::from(pixel[3]);
        if alpha != 0 && alpha != 255 {
            for channel in &mut pixel[..3] {
                *channel = ((u16::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8;
            }
        }
    }
}
