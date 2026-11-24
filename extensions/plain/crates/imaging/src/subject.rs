//! Finding an image's subject with Vision, the way Photos lifts a subject off its background,
//! so the background can be removed.

use image::{GrayImage, RgbaImage};
use objc2::{AnyThread, available, rc::autoreleasepool};
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferGetHeight, CVPixelBufferGetPixelFormatType, CVPixelBufferGetWidth,
    CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
    kCVPixelFormatType_OneComponent32Float,
};
use objc2_foundation::{NSArray, NSDictionary};
use objc2_vision::{VNGenerateForegroundInstanceMaskRequest, VNImageRequestHandler, VNRequest};

use crate::bitmap;

/// Mask values at or below this count as background when finding the subject's bounds.
const BACKGROUND: u8 = 16;

/// Whether this Mac can find subjects. It takes macOS 14 or later.
pub fn is_available() -> bool {
    available!(macos = 14.0)
}

/// How much each pixel belongs to the image's foreground subjects, from 0 (background) to 255,
/// the same size as `image`, with soft edges. None when nothing stands out as a subject. Slow,
/// especially the first time, when the model loads, so call it off the main thread.
pub fn mask(image: &RgbaImage) -> Result<Option<GrayImage>, String> {
    if !is_available() {
        return Err("Removing backgrounds needs macOS 14 or later".into());
    }
    // Vision's objects must stay on the thread that made them, so everything happens here and
    // only plain pixels leave.
    autoreleasepool(|_| {
        let cg_image = bitmap::to_cg_image(image);
        let handler = unsafe {
            VNImageRequestHandler::initWithCGImage_options(
                VNImageRequestHandler::alloc(),
                &cg_image,
                &NSDictionary::new(),
            )
        };
        let request = unsafe { VNGenerateForegroundInstanceMaskRequest::new() };
        let requests = NSArray::<VNRequest>::from_slice(&[&request]);
        handler.performRequests_error(&requests).map_err(|error| {
            format!(
                "Couldn't find the subject: {}",
                error.localizedDescription()
            )
        })?;
        let Some(observation) =
            unsafe { request.results() }.and_then(|results| results.firstObject())
        else {
            return Ok(None);
        };
        let instances = unsafe { observation.allInstances() };
        let mask = unsafe {
            observation.generateScaledMaskForImageForInstances_fromRequestHandler_error(
                &instances, &handler,
            )
        }
        .map_err(|error| {
            format!(
                "Couldn't find the subject: {}",
                error.localizedDescription()
            )
        })?;
        read_mask(&mask).map(Some)
    })
}

/// Reads a mask of one float per pixel, from 0 to 1, into bytes.
fn read_mask(mask: &CVPixelBuffer) -> Result<GrayImage, String> {
    let format = CVPixelBufferGetPixelFormatType(mask);
    if format != kCVPixelFormatType_OneComponent32Float {
        return Err(format!(
            "Vision gave a mask in an unexpected format ({format:#x})"
        ));
    }
    let width = CVPixelBufferGetWidth(mask);
    let height = CVPixelBufferGetHeight(mask);
    let bytes_per_row = CVPixelBufferGetBytesPerRow(mask);
    if unsafe { CVPixelBufferLockBaseAddress(mask, CVPixelBufferLockFlags::ReadOnly) } != 0 {
        return Err("Couldn't read Vision's mask".into());
    }
    let base = CVPixelBufferGetBaseAddress(mask).cast::<u8>().cast_const();
    let values: Vec<u8> = (0..height)
        .flat_map(|row| {
            // Rows can be padded, so each starts bytes_per_row after the last.
            let start = unsafe { base.add(row * bytes_per_row) }.cast::<f32>();
            let row = unsafe { std::slice::from_raw_parts(start, width) };
            row.iter()
                .map(|&value| (value.clamp(0., 1.) * 255.).round() as u8)
        })
        .collect();
    unsafe { CVPixelBufferUnlockBaseAddress(mask, CVPixelBufferLockFlags::ReadOnly) };
    GrayImage::from_raw(width as u32, height as u32, values)
        .ok_or_else(|| "Vision's mask had the wrong size".into())
}

/// `image` with its alpha multiplied by `mask`, so the background becomes transparent.
pub fn cut_out(image: &RgbaImage, mask: &GrayImage) -> RgbaImage {
    RgbaImage::from_fn(image.width(), image.height(), |x, y| {
        let mut pixel = *image.get_pixel(x, y);
        let kept = mask.get_pixel_checked(x, y).map_or(0, |value| value.0[0]);
        pixel.0[3] = ((u16::from(pixel.0[3]) * u16::from(kept) + 127) / 255) as u8;
        pixel
    })
}

/// The smallest rectangle (x, y, width, height) holding every pixel of the mask that's more
/// than faintly part of the subject, for trimming a cut-out to its subject. None when the mask
/// is empty.
pub fn subject_bounds(mask: &GrayImage) -> Option<(u32, u32, u32, u32)> {
    let kept = mask
        .enumerate_pixels()
        .filter(|(_, _, value)| value.0[0] > BACKGROUND);
    let (left, top, right, bottom) =
        kept.fold(None, |bounds: Option<(u32, u32, u32, u32)>, (x, y, _)| {
            Some(match bounds {
                None => (x, y, x, y),
                Some((left, top, right, bottom)) => {
                    (left.min(x), top.min(y), right.max(x), bottom.max(y))
                }
            })
        })?;
    Some((left, top, right - left + 1, bottom - top + 1))
}
