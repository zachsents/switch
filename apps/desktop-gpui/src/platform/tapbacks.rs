//! iMessage's own tapbacks, as Messages draws them now: the last frame of each one's animation in
//! ChatKit's asset catalog, read from this Mac's system, never shipped with the app. None where the
//! system has none; `tapback.rs` draws its own then.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use gpui::{Image, ImageFormat};
use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
use objc2_foundation::{NSDictionary, NSString};

const CHATKIT: &str = "/System/iOSSupport/System/Library/PrivateFrameworks/ChatKit.framework";

/// The share of a frame an emoji's size takes, centred: its glyphs then stand as tall as emoji do
/// (Apple Color Emoji draws a little past its font size).
pub const GLYPH: f32 = 0.55;

/// A tapback's animation, by its frames' name.
fn frames_of(t: &str) -> &'static str {
    match t {
        "love" => "heart",
        "like" => "thumbsup",
        "dislike" => "thumbsdown",
        "laugh" => "haha-ENG",
        "emphasize" => "exclamation",
        _ => "question",
    }
}

/// A tapback's glyph as Messages draws it, when this Mac has it.
pub fn glyph(t: &str) -> Option<Arc<Image>> {
    static HELD: OnceLock<HashMap<&'static str, Arc<Image>>> = OnceLock::new();
    HELD.get_or_init(load).get(t).cloned()
}

fn load() -> HashMap<&'static str, Arc<Image>> {
    let mut out = HashMap::new();
    let Some(bundle) = bundle() else { return out };
    for t in crate::tapback::REACTIONS {
        if let Some(png) = last_frame(&bundle, frames_of(t)) {
            out.insert(t, Arc::new(Image::from_bytes(ImageFormat::Png, png)));
        }
    }
    out
}

fn bundle() -> Option<Retained<AnyObject>> {
    let class = AnyClass::get(c"NSBundle")?;
    // SAFETY: `+[NSBundle bundleWithPath:]`, an NSString in, a bundle or nil out.
    unsafe { msg_send![class, bundleWithPath: &*NSString::from_str(CHATKIT)] }
}

fn image(bundle: &AnyObject, name: &str) -> Option<Retained<NSImage>> {
    // SAFETY: AppKit's `-[NSBundle imageForResource:]` on a bundle, an NSString in, an image or nil out.
    unsafe { msg_send![bundle, imageForResource: &*NSString::from_str(name)] }
}

/// The animation's last frame, as PNG: its frames run from `_000` up without a gap.
fn last_frame(bundle: &AnyObject, stem: &str) -> Option<Vec<u8>> {
    let frame = |n: usize| image(bundle, &format!("{stem}_{n:03}"));
    frame(0)?;
    // The first one missing: doubling past it, then halving down to it.
    let (mut have, mut missing) = (0, 1);
    while frame(missing).is_some() {
        have = missing;
        missing *= 2;
        if missing > 4096 {
            return None;
        }
    }
    while missing - have > 1 {
        let mid = (have + missing) / 2;
        if frame(mid).is_some() {
            have = mid;
        } else {
            missing = mid;
        }
    }
    png_of(&*frame(have)?)
}

/// Its largest picture, as PNG.
fn png_of(image: &NSImage) -> Option<Vec<u8>> {
    let tiff = image.TIFFRepresentation()?;
    let reps = NSBitmapImageRep::imageRepsWithData(&tiff);
    let best = reps.iter().max_by_key(|r| r.pixelsWide())?;
    let bitmap = best.downcast::<NSBitmapImageRep>().ok()?;
    // SAFETY: an empty properties dictionary, as AppKit takes for PNG.
    let png = unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }?;
    Some(png.to_vec())
}
