//! Putting images on the clipboard in several formats at once, which GPUI's clipboard can't.

use std::path::Path;

use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};
use objc2_foundation::{NSData, NSString, NSURL};

/// Replaces what's on the clipboard with an image: its bytes in each format given, as
/// (uniform type, bytes) like ("public.png", png), and when `file` is given, that file too, so
/// pasting into Finder or a chat makes a real file. Call it from the main thread.
pub fn copy(formats: &[(&str, &[u8])], file: Option<&Path>) -> Result<(), String> {
    autoreleasepool(|_| {
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        let written = formats.iter().all(|(type_identifier, bytes)| {
            pasteboard.setData_forType(
                Some(&NSData::with_bytes(bytes)),
                &NSString::from_str(type_identifier),
            )
        });
        let file_written = file.is_none_or(|file| {
            NSURL::from_file_path(file).is_some_and(|url| {
                url.absoluteString().is_some_and(|url| {
                    pasteboard.setString_forType(&url, unsafe { NSPasteboardTypeFileURL })
                })
            })
        });
        if written && file_written {
            Ok(())
        } else {
            Err("Couldn't put the image on the clipboard".into())
        }
    })
}
