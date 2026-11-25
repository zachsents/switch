//! A chat's file handed on from this Mac: to the pasteboard (Copy, Copy Image) or to the share
//! picker. A picture goes on the pasteboard as itself, in its own format and as PNG and TIFF beside
//! it, so it pastes into Messages, Slack, Preview or a browser alike; any other file goes as the
//! file, as Finder's Copy puts it.

use std::path::Path;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{AnyThread as _, MainThreadMarker};
use objc2_app_kit::{
    NSApplication, NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSPasteboard, NSPasteboardItem, NSPasteboardTypePNG, NSPasteboardTypeTIFF, NSPasteboardWriting,
    NSSharingServicePicker,
};
use objc2::runtime::AnyObject;
use objc2_foundation::{NSArray, NSData, NSDictionary, NSPoint, NSRect, NSRectEdge, NSSize, NSString, NSURL};
use objc2_uniform_type_identifiers::{UTType, UTTypeImage};

/// The file's type, by its extension.
fn type_of(at: &Path) -> Option<Retained<UTType>> {
    let ext = at.extension()?.to_string_lossy().to_string();
    UTType::typeWithFilenameExtension(&NSString::from_str(&ext))
}

fn url_of(at: &Path) -> Retained<NSURL> {
    NSURL::fileURLWithPath(&NSString::from_str(&at.to_string_lossy()))
}

/// A picture as a pasteboard item: its own bytes under its own type, and PNG and TIFF of it.
fn picture_item(at: &Path, kind: &UTType) -> Option<Retained<NSPasteboardItem>> {
    let bytes = std::fs::read(at).ok()?;
    let image = NSImage::initWithContentsOfURL(NSImage::alloc(), &url_of(at))?;
    let tiff = image.TIFFRepresentation()?;
    let item = NSPasteboardItem::new();
    let own = kind.identifier();
    // SAFETY: AppKit's own constants, set before any code of the app runs and never changed.
    let (png_type, tiff_type) = unsafe { (NSPasteboardTypePNG, NSPasteboardTypeTIFF) };
    let data = NSData::with_bytes(&bytes);
    item.setData_forType(&data, &own);
    if *own != *png_type {
        let png = NSBitmapImageRep::imageRepWithData(&tiff).and_then(|rep| unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) });
        if let Some(png) = png {
            item.setData_forType(&png, png_type);
        }
    }
    if *own != *tiff_type {
        item.setData_forType(&tiff, tiff_type);
    }
    Some(item)
}

/// Puts the file on the general pasteboard: a picture as itself, anything else as the file. True
/// once it's there.
pub fn copy(at: &Path) -> bool {
    let board = NSPasteboard::generalPasteboard();
    let picture = type_of(at).filter(|t| t.conformsToType(unsafe { UTTypeImage })).and_then(|t| picture_item(at, &t));
    board.clearContents();
    let written = match picture {
        Some(item) => board.writeObjects(&NSArray::from_retained_slice(&[ProtocolObject::<dyn NSPasteboardWriting>::from_retained(item)])),
        None => board.writeObjects(&NSArray::from_retained_slice(&[ProtocolObject::<dyn NSPasteboardWriting>::from_retained(url_of(at))])),
    };
    if !written {
        log::warn!("Copy {}: the pasteboard took nothing", at.display());
    }
    written
}

/// Where the pointer is in the key window, in its content view's terms.
pub fn pointer() -> Option<NSPoint> {
    let mtm = MainThreadMarker::new()?;
    let window = NSApplication::sharedApplication(mtm).keyWindow()?;
    let view = window.contentView()?;
    Some(view.convertPoint_fromView(window.mouseLocationOutsideOfEventStream(), None))
}

/// The share picker for the file, at `at_point` in the key window (its middle without one). True
/// once it shows.
pub fn share(at: &Path, at_point: Option<NSPoint>) -> bool {
    let Some(mtm) = MainThreadMarker::new() else { return false };
    let Some(window) = NSApplication::sharedApplication(mtm).keyWindow() else { return false };
    let Some(view) = window.contentView() else { return false };
    let bounds = view.bounds();
    let point = at_point.unwrap_or(NSPoint::new(bounds.size.width / 2., bounds.size.height / 2.));
    // SAFETY: an NSURL is an object, as the picker's items are.
    let items: Retained<NSArray<AnyObject>> = NSArray::from_retained_slice(&[unsafe { Retained::cast_unchecked::<AnyObject>(url_of(at)) }]);
    let picker = unsafe { NSSharingServicePicker::initWithItems(NSSharingServicePicker::alloc(), &items) };
    picker.showRelativeToRect_ofView_preferredEdge(NSRect::new(point, NSSize::new(1., 1.)), &view, NSRectEdge::MinY);
    true
}
