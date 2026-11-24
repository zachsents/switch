//! Every command in the app. Each one has a keyboard shortcut and a menu item, and the ones in
//! the `images` namespace are MCP tools for agents: the doc comment is the tool's description
//! and the fields are its input.
//!
//! Each window holds a document: a folder's images, showing one. Commands act on the image a
//! document shows, in the frontmost window unless `document` says which.

use gpui::{Action, actions};
use schemars::JsonSchema;
use serde::Deserialize;

use imaging::draw::Mark;

use crate::{
    crop::Crop,
    document::ExportFormat,
    edits::{FlipDirection, Turn},
    markup::{Thickness, Tool},
};

/// Open images or folders, each in a window that lists the folder's images. A file shows that
/// image, and a folder its first image. An image or folder already open is brought forward
/// instead. Replies once the images have been read, with each window's document id.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct Open {
    /// Absolute paths of image files or folders.
    pub paths: Vec<String>,
}

/// Close a document's window. If any of its images has unsaved edits, say whether to save them
/// first.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct Close {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
    /// Save unsaved edits (true) or throw them away (false). Needed when there are any.
    #[serde(default)]
    pub save: Option<bool>,
}

/// Show another image from the document's folder.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct ShowImage {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
    /// The image's file name, like "IMG_0042.HEIC", or its path.
    pub name: String,
}

/// Show the next image in the folder.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct NextImage {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
}

/// Show the previous image in the folder.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct PreviousImage {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
}

/// Crop the shown image. Give `aspect` for the largest crop of that shape centered in the
/// image: "1:1", "4:3", "16:9", "3:2" or any other "width:height", or "original" for the
/// image's own shape. Ratios turn to match the image, so "16:9" on a portrait photo is 9 wide by
/// 16 tall; for a crop against the image's shape, give a rectangle. "free" keeps the current
/// crop and lets its shape change freely when it's edited in the window. Or give `x`, `y`,
/// `width` and `height` to crop exactly there, in the pixels of the image as it's turned now,
/// which the state's `turned_width` and `turned_height` are. With an `aspect` too, that
/// rectangle shrinks around its center to the shape. Replaces any crop the image had.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct SetCrop {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
    /// The crop's shape: "free", "original", "1:1", "4:3", "16:9", "3:2" or any "width:height".
    #[serde(default)]
    pub aspect: Option<String>,
    /// Pixels from the image's left edge to the crop's.
    #[serde(default)]
    pub x: Option<u32>,
    /// Pixels from the image's top edge to the crop's.
    #[serde(default)]
    pub y: Option<u32>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
}

impl SetCrop {
    /// Sets the shown image's crop to `crop`, exactly, keeping its shape.
    pub fn exactly(crop: Crop) -> Self {
        Self {
            aspect: Some(crop.aspect.as_input_on(crop.rect.width, crop.rect.height)),
            x: Some(crop.rect.x),
            y: Some(crop.rect.y),
            width: Some(crop.rect.width),
            height: Some(crop.rect.height),
            ..Self::default()
        }
    }

    /// The largest crop of `aspect` (like "16:9") centered in the shown image.
    pub fn aspect(aspect: &str) -> Self {
        Self {
            aspect: Some(aspect.into()),
            ..Self::default()
        }
    }
}

/// Crop the shown image to what plain words describe: "square", "16:9", "4:5 from the top",
/// "Instagram story", "1080x1080", "the left half", "the top two thirds", "trim 10% off every
/// side", "cut 5% off the bottom", "original" or "none". Ratios are width:height as written, so
/// "16:9" is wide and "9:16" tall, whichever way the image is. Crops are centered unless the
/// words say where, and are placed on the whole image as it's turned now, replacing any crop
/// it had. Words the app can't read itself go to a fast model, which takes about a second;
/// state's `crop` shows the result.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct CropTo {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
    /// The part of the image to keep, in plain words.
    pub to: String,
}

/// Remove the shown image's crop, so the whole image is kept.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct ClearCrop {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
}

/// Turn the shown image a quarter turn. Its crop turns with it.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct Rotate {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
    pub direction: Turn,
}

/// Mirror the shown image. Its crop mirrors with it.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct Flip {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
    pub direction: FlipDirection,
}

/// Set how big the shown image is, in plain words: "original", "1200" (the longer side),
/// "50%", "1200 wide", "800 tall" or "1200x800" (fit inside). Pixel sizes never enlarge an
/// image. It's resized after cropping.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct Resize {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
    pub size: String,
}

/// Draw on the shown image: a rectangle, ellipse, line, arrow, pen stroke, highlight, text or
/// redaction box. Coordinates are in the pixels of the image as it's turned now, like
/// `set_crop`'s, so marks can sit outside a crop and reappear if it's cleared. Marks are edits:
/// they can be undone, they turn and flip with the image, and saving or exporting draws them
/// into the file. A good line width is about a 250th of the image's longer side, and a good text
/// size about a 30th.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct AddMark {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
    pub mark: Mark,
}

/// Replace one of the shown image's marks, to move, restyle or reword it.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct UpdateMark {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
    /// The mark's place in the state's `marks` list, from 0.
    pub index: usize,
    pub mark: Mark,
}

/// Remove one of the shown image's marks.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct DeleteMark {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
    /// The mark's place in the state's `marks` list, from 0.
    pub index: usize,
}

/// Undo the shown image's last edit.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct Undo {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
}

/// Redo the shown image's last undone edit.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct Redo {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
}

/// Save the shown image's edits into its file, in its own format, keeping its metadata. The
/// first time Images saves over a file it keeps the original, so revert_to_original can always
/// bring it back. Formats that can't be written, like camera raw, can only be exported. Replies
/// once the file is written.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct Save {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
}

/// Throw away the shown image's unsaved edits.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct Revert {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
}

/// Put the shown image's file back the way it was before Images first saved over it, dropping
/// every saved and unsaved edit.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct RevertToOriginal {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
}

/// Export images as new files next to their originals, with their unsaved edits, never
/// overwriting a file: "photo.png", or "photo 2.png" if that's taken. Location and camera
/// details are always removed. Anything not given comes from the document's export settings.
/// Replies once the files are written, with their paths and sizes.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct Export {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
    /// File names of the images to export. Defaults to the images chosen in the list, or the
    /// shown one.
    #[serde(default)]
    pub images: Option<Vec<String>>,
    #[serde(default)]
    pub format: Option<ExportFormat>,
    /// From 1 (smallest) to 100 (best), for JPEG, HEIC, AVIF and WebP.
    #[serde(default)]
    pub quality: Option<u8>,
    /// A size in plain words, like "1200" or "50%", applied after the image's own edits.
    #[serde(default)]
    pub size: Option<String>,
}

/// Copy the shown image, with its edits, to the clipboard. With a format, a file in that format
/// is copied too, so pasting into Finder or a chat makes a real file.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct Copy {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
    #[serde(default)]
    pub format: Option<CopyFormat>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum CopyFormat {
    Png,
    Jpeg,
}

/// Zoom a document's window: to fit the window, to actual size (one image pixel per screen
/// pixel), a step in or out, or to a percentage of actual size.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct Zoom {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
    pub to: ZoomTo,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ZoomTo {
    Fit,
    ActualSize,
    In,
    Out,
    /// Like `{"percent": 200}`: 100 is actual size.
    Percent(f32),
}

/// Show or hide the list of the folder's images beside the image.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct ShowSidebar {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
    pub show: bool,
}

/// Show or hide the export panel, with its format, quality and size.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images)]
#[serde(deny_unknown_fields)]
pub struct ShowExportPanel {
    /// Which document. Defaults to the frontmost one.
    #[serde(default)]
    pub document: Option<u64>,
    pub show: bool,
}

// Actions that only drive the window live in their own namespace so they aren't offered to
// agents. Agents call the commands themselves.
actions!(
    images_window,
    [
        /// Choose images or folders to open with the Open dialog.
        OpenDialog,
        /// Show or hide the list of the folder's images.
        ToggleSidebar,
        ZoomIn,
        ZoomOut,
        /// Fit the whole image in the window.
        ZoomToFit,
        /// Show one image pixel per screen pixel.
        ActualSize,
        /// Edit the image's size in place.
        EditSize,
        /// Show the image in Finder.
        ShowInFinder,
        /// Show or hide the export settings.
        ToggleExport,
        /// Choose every image in the folder for exporting.
        ChooseAll,
        /// Edit the size exports are scaled to, in place.
        EditExportSize,
        /// Start cropping the image over its picture, or finish, keeping the crop.
        ToggleCrop,
        /// Finish cropping, keeping the crop.
        ApplyCrop,
        /// Finish cropping, putting back the crop from before.
        CancelCrop,
        /// Choose the next crop handle for the arrow keys to move.
        NextCropHandle,
        /// Choose the previous crop handle for the arrow keys to move.
        PreviousCropHandle,
        /// Type the crop in words, like "square" or "the left half", previewed as it's typed.
        DescribeCrop,
        /// Show or hide the markup tools.
        ToggleMarkup,
        /// Delete the chosen mark.
        DeleteSelectedMark,
        /// Let go of the chosen mark.
        DeselectMark,
        /// Edit the chosen text mark's words.
        EditMarkText,
    ]
);

/// Choose what dragging across the picture does.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images_window)]
#[serde(deny_unknown_fields)]
pub struct ChooseTool {
    pub tool: Tool,
}

/// Choose a palette color for new marks, and the chosen mark.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images_window)]
#[serde(deny_unknown_fields)]
pub struct SetMarkColor {
    /// The color's place in the palette, from 0.
    pub index: usize,
}

/// Choose how thick new marks are, and the chosen mark.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images_window)]
#[serde(deny_unknown_fields)]
pub struct SetThickness {
    pub thickness: Thickness,
}

/// Move the chosen mark a pixel, or when `fast` ten pixels.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images_window)]
#[serde(deny_unknown_fields)]
pub struct NudgeMark {
    pub direction: Direction,
    #[serde(default)]
    pub fast: bool,
}

/// Move the chosen crop edge or corner, or the whole crop, a pixel, or when `fast` a hundredth
/// of the image's longer side (at least ten pixels).
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images_window)]
#[serde(deny_unknown_fields)]
pub struct NudgeCrop {
    pub direction: Direction,
    #[serde(default)]
    pub fast: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Left,
    Right,
    Up,
    Down,
}

/// Choose an image in the list for exporting, or unchoose it, like ⌘-clicking in Finder.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images_window)]
#[serde(deny_unknown_fields)]
pub struct ToggleChosen {
    pub name: String,
}

/// Choose every image from the shown one to this one, like ⇧-clicking in Finder.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images_window)]
#[serde(deny_unknown_fields)]
pub struct ChooseThrough {
    pub name: String,
}

/// Set the format exports are written in.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images_window)]
#[serde(deny_unknown_fields)]
pub struct SetExportFormat {
    pub format: ExportFormat,
}

/// Set the quality of lossy exports, from 1 to 100.
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images_window)]
#[serde(deny_unknown_fields)]
pub struct SetExportQuality {
    pub quality: u8,
}

/// Set the size exports are scaled to, in plain words like "1200" or "50%".
#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Action)]
#[action(namespace = images_window)]
#[serde(deny_unknown_fields)]
pub struct SetExportSize {
    pub size: String,
}

/// Commands for one document, which they can name.
pub trait ForDocument {
    /// The document named, or None for the frontmost one.
    fn document(&self) -> Option<u64>;
}

macro_rules! for_document {
    ($($action:ty),* $(,)?) => {
        $(impl ForDocument for $action {
            fn document(&self) -> Option<u64> {
                self.document
            }
        })*
    };
}

for_document!(
    Close,
    ShowImage,
    NextImage,
    PreviousImage,
    SetCrop,
    CropTo,
    ClearCrop,
    Rotate,
    Flip,
    Resize,
    Undo,
    Redo,
    Save,
    Revert,
    RevertToOriginal,
    Export,
    Copy,
    AddMark,
    UpdateMark,
    DeleteMark,
    Zoom,
    ShowSidebar,
    ShowExportPanel,
);
