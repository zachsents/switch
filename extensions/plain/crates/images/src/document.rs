//! One window's images: a folder, the image it shows, the images chosen for exporting, and each
//! image's unsaved edits. The window only displays a document; every change to it goes through
//! an action, which agents can call too.

use std::{
    cmp::Ordering,
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

use futures::{FutureExt, channel::oneshot, future::Shared};
use gpui::{AppContext, Context};
use image::RgbaImage;
use imaging::codec::{self, Format};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    edits::Edits,
    session::{Change, Session},
    size::Size,
};

/// Files the folder list shows. Camera raw and Photoshop files can be viewed and exported, but
/// not saved over.
const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "heic", "heif", "avif", "gif", "tif", "tiff", "bmp", "dng",
    "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "psd",
];

pub struct Document {
    id: u64,
    folder: PathBuf,
    /// The folder's images, sorted the way Finder sorts names.
    files: Vec<PathBuf>,
    current: Option<PathBuf>,
    /// Images chosen in the list for exporting together, besides the one shown.
    chosen: Vec<PathBuf>,
    sessions: HashMap<PathBuf, Session>,
    picture: Picture,
    pub export: ExportSettings,
    /// Files being written, which can't be edited until they're done.
    saving: Vec<PathBuf>,
    /// What the last export wrote, or why it failed, for each image.
    pub exported: Vec<(PathBuf, Result<Exported, String>)>,
    /// What went wrong with the last save, export or copy, shown until the next one.
    pub problem: Option<String>,
}

/// The shown image's pixels.
#[derive(Clone)]
pub enum Picture {
    /// The folder has no images.
    Empty,
    Loading,
    Ready(Arc<Loaded>),
    Unreadable(String),
}

/// An image read from its file, upright.
pub struct Loaded {
    pub path: PathBuf,
    pub image: Arc<RgbaImage>,
    pub info: Info,
}

/// What an image file is.
#[derive(Clone, Debug)]
pub struct Info {
    pub width: u32,
    pub height: u32,
    /// How people know its format, like "JPEG".
    pub kind: String,
    /// The format it's saved in, when it can be written. Camera raw can't.
    pub format: Option<Format>,
    pub bytes: u64,
    pub location: bool,
    pub camera: bool,
}

/// How images are exported.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ExportSettings {
    pub format: ExportFormat,
    /// 1 (smallest) to 100 (best), for lossy formats.
    pub quality: u8,
    pub size: Size,
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self {
            format: ExportFormat::Same,
            quality: 80,
            size: Size::Original,
        }
    }
}

/// The format exported images are written in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    /// The image's own format. Formats that can't be written, like camera raw, become JPEG, or
    /// PNG when there's transparency.
    #[default]
    Same,
    Jpeg,
    Png,
    Heic,
    Avif,
    Webp,
}

impl ExportFormat {
    pub const ALL: [Self; 6] = [
        Self::Same,
        Self::Jpeg,
        Self::Png,
        Self::Heic,
        Self::Avif,
        Self::Webp,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::Same => "Same",
            Self::Jpeg => "JPEG",
            Self::Png => "PNG",
            Self::Heic => "HEIC",
            Self::Avif => "AVIF",
            Self::Webp => "WebP",
        }
    }

    /// The format to write an image of `original` format in, `transparent` or not.
    pub fn resolve(self, original: Option<Format>, transparent: bool) -> Format {
        match self {
            Self::Same => original
                .filter(|format| format.can_write())
                .unwrap_or(if transparent {
                    Format::Png
                } else {
                    Format::Jpeg
                }),
            Self::Jpeg => Format::Jpeg,
            Self::Png => Format::Png,
            Self::Heic => Format::Heic,
            Self::Avif => Format::Avif,
            Self::Webp => Format::Webp,
        }
    }
}

/// A file written by an export.
#[derive(Clone, Debug)]
pub struct Exported {
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

impl Document {
    /// A document for `folder`, showing `current`, or its first image when None.
    pub fn new(id: u64, folder: PathBuf, current: Option<PathBuf>, cx: &mut Context<Self>) -> Self {
        let files = list_images(&folder);
        let current = current.or_else(|| files.first().cloned());
        let mut document = Self {
            id,
            folder,
            files,
            current: None,
            chosen: Vec::new(),
            sessions: HashMap::new(),
            picture: Picture::Empty,
            export: ExportSettings::default(),
            saving: Vec::new(),
            exported: Vec::new(),
            problem: None,
        };
        if let Some(current) = current {
            document.show(current, cx);
        }
        document
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn folder(&self) -> &Path {
        &self.folder
    }

    /// The folder's name, as the window shows it.
    pub fn folder_name(&self) -> String {
        file_name(&self.folder)
    }

    pub fn files(&self) -> &[PathBuf] {
        &self.files
    }

    pub fn current(&self) -> Option<&Path> {
        self.current.as_deref()
    }

    pub fn picture(&self) -> &Picture {
        &self.picture
    }

    /// The shown image, once it's been read.
    /// The shown image's size after cropping, which a new size applies to.
    pub fn shown_size(&self) -> Option<(u32, u32)> {
        let info = &self.loaded()?.info;
        Some(self.edits().cropped_size(info.width, info.height))
    }

    pub fn loaded(&self) -> Option<&Arc<Loaded>> {
        match &self.picture {
            Picture::Ready(loaded) => Some(loaded),
            _ => None,
        }
    }

    pub fn chosen(&self) -> &[PathBuf] {
        &self.chosen
    }

    /// Whether `path` is chosen for exporting, or is the image shown.
    pub fn is_chosen(&self, path: &Path) -> bool {
        self.current.as_deref() == Some(path) || self.chosen.iter().any(|chosen| chosen == path)
    }

    /// The images an export writes: the chosen ones with the shown one, in folder order.
    pub fn export_targets(&self) -> Vec<PathBuf> {
        self.files
            .iter()
            .filter(|path| self.is_chosen(path))
            .cloned()
            .collect()
    }

    /// The shown image's edits.
    pub fn edits(&self) -> Edits {
        self.current
            .as_ref()
            .and_then(|path| self.sessions.get(path))
            .map(|session| session.edits().clone())
            .unwrap_or_default()
    }

    /// An image's unsaved edits.
    pub fn edits_of(&self, path: &Path) -> Edits {
        self.sessions
            .get(path)
            .map(|session| session.edits().clone())
            .unwrap_or_default()
    }

    pub fn is_edited(&self, path: &Path) -> bool {
        self.sessions.get(path).is_some_and(Session::is_edited)
    }

    /// Images with edits that haven't been saved.
    pub fn unsaved(&self) -> Vec<PathBuf> {
        self.files
            .iter()
            .filter(|path| self.is_edited(path))
            .cloned()
            .collect()
    }

    pub fn is_saving(&self, path: &Path) -> bool {
        self.saving.iter().any(|saving| saving == path)
    }

    /// The image in the folder called `name`, or at that path.
    pub fn find(&self, name: &str) -> Option<&PathBuf> {
        self.files.iter().find(|path| {
            path.as_os_str() == name || file_name(path).eq_ignore_ascii_case(name.trim())
        })
    }

    /// Reads the folder again, keeping what's shown and chosen if it's still there.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        let files = list_images(&self.folder);
        if files == self.files {
            return;
        }
        self.chosen.retain(|path| files.contains(path));
        self.files = files;
        let gone = self
            .current
            .as_ref()
            .is_some_and(|current| !self.files.contains(current));
        if gone || self.current.is_none() {
            self.current = None;
            match self.files.first().cloned() {
                Some(first) => self.show(first, cx),
                None => self.picture = Picture::Empty,
            }
        }
        cx.notify();
    }

    /// Shows `path`, reading it in the background. An agent call waits until it's read.
    pub fn show(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        if self.current.as_ref() == Some(&path) && !matches!(self.picture, Picture::Empty) {
            return;
        }
        if !self.files.contains(&path) {
            // Opened directly, though its type isn't one the list shows.
            self.files.push(path.clone());
            self.files.sort_by(|a, b| name_order(a, b));
        }
        self.current = Some(path.clone());
        self.chosen.retain(|chosen| *chosen != path);
        // An agent call waits for the read by itself; nothing else here needs to.
        drop(self.load(path, cx));
    }

    /// Reads the shown image's file again, as after it was saved. Returns when it's read.
    pub fn reload(&mut self, cx: &mut Context<Self>) -> Option<Shared<oneshot::Receiver<()>>> {
        let path = self.current.clone()?;
        Some(self.load(path, cx))
    }

    /// Reads `path` in the background to show it. An agent call waits until it's read, and so
    /// can whoever holds what this returns.
    fn load(&mut self, path: PathBuf, cx: &mut Context<Self>) -> Shared<oneshot::Receiver<()>> {
        self.picture = Picture::Loading;
        cx.notify();
        let (done, finished) = oneshot::channel();
        let finished = finished.shared();
        let read = cx.background_spawn({
            let path = path.clone();
            async move { read(&path) }
        });
        cx.spawn(async move |this, cx| {
            let result = read.await;
            this.update(cx, |this, cx| {
                // Another image may have been chosen while this one was read.
                if this.current.as_ref() == Some(&path) {
                    this.picture = match result {
                        Ok(loaded) => Picture::Ready(Arc::new(loaded)),
                        Err(error) => Picture::Unreadable(error),
                    };
                    cx.notify();
                }
            })
            .ok();
            done.send(()).ok();
        })
        .detach();
        kit::finish_before_replying(cx, {
            let finished = finished.clone();
            async move {
                finished.await.ok();
                Ok(())
            }
        });
        finished
    }

    /// Shows the image `offset` places from the shown one, stopping at either end.
    pub fn show_by_offset(&mut self, offset: isize, cx: &mut Context<Self>) {
        let index = self
            .current
            .as_ref()
            .and_then(|current| self.files.iter().position(|path| path == current))
            .map_or(0, |index| index as isize + offset);
        let index = index.clamp(0, self.files.len() as isize - 1);
        if let Some(path) = self.files.get(index as usize).cloned() {
            self.show(path, cx);
        }
    }

    /// Chooses or unchooses `path` for exporting, like ⌘-clicking in Finder.
    pub fn toggle_chosen(&mut self, path: &Path) {
        if self.current.as_deref() == Some(path) {
            return;
        }
        match self.chosen.iter().position(|chosen| chosen == path) {
            Some(index) => {
                self.chosen.remove(index);
            }
            None => self.chosen.push(path.to_path_buf()),
        }
    }

    /// Chooses every image from the shown one to `path`, like ⇧-clicking in Finder.
    pub fn choose_through(&mut self, path: &Path) {
        let position = |target: &Path| self.files.iter().position(|file| file == target);
        let (Some(from), Some(to)) = (self.current.as_deref().and_then(position), position(path))
        else {
            return;
        };
        let range = from.min(to)..=from.max(to);
        self.chosen = self.files[range].to_vec();
    }

    /// Chooses every image in the folder.
    pub fn choose_all(&mut self) {
        self.chosen = self
            .files
            .iter()
            .filter(|path| self.current.as_ref() != Some(path))
            .cloned()
            .collect();
    }

    /// Changes the shown image's edits. Returns an error when there's no image to edit, or it's
    /// being saved.
    pub fn edit(
        &mut self,
        change: Change,
        edit: impl FnOnce(Edits, &Info) -> Result<Edits, String>,
    ) -> Result<(), String> {
        let loaded = self.loaded().ok_or("There's no image to edit")?.clone();
        if self.is_saving(&loaded.path) {
            return Err("The image is still being saved".into());
        }
        let session = self.sessions.entry(loaded.path.clone()).or_default();
        let edits = edit(session.edits().clone(), &loaded.info)?;
        session.change(change, edits, Instant::now());
        Ok(())
    }

    /// Undoes the shown image's last change. Returns false when there's nothing to undo.
    pub fn undo(&mut self) -> bool {
        self.current_session_mut().is_some_and(Session::undo)
    }

    pub fn redo(&mut self) -> bool {
        self.current_session_mut().is_some_and(Session::redo)
    }

    pub fn can_undo(&self) -> bool {
        self.current_session().is_some_and(Session::can_undo)
    }

    pub fn can_redo(&self) -> bool {
        self.current_session().is_some_and(Session::can_redo)
    }

    /// Drops the shown image's unsaved edits.
    pub fn revert(&mut self) {
        if let Some(session) = self.current_session_mut() {
            session.clear();
        }
    }

    fn current_session(&self) -> Option<&Session> {
        self.sessions.get(self.current.as_ref()?)
    }

    fn current_session_mut(&mut self) -> Option<&mut Session> {
        self.sessions.get_mut(self.current.as_ref()?)
    }

    pub fn start_saving(&mut self, path: &Path) {
        self.saving.push(path.to_path_buf());
    }

    /// Ends saving `path`. When it worked, its edits are now in the file, so they're dropped.
    pub fn finish_saving(&mut self, path: &Path, saved: bool) {
        self.saving.retain(|saving| saving != path);
        if saved {
            self.sessions.remove(path);
        }
    }

    /// What agents see of the document. `original_kept` says whether the shown image's
    /// original is kept, so it can be reverted to.
    pub fn report(&self, frontmost: bool, original_kept: bool) -> Value {
        let edits = self.edits();
        let current = self.current.as_ref().map(|path| {
            let picture = match &self.picture {
                Picture::Ready(loaded) => {
                    let Info {
                        width,
                        height,
                        kind,
                        format,
                        bytes,
                        location,
                        camera,
                    } = &loaded.info;
                    let (result_width, result_height) = edits.output_size(*width, *height);
                    json!({
                        "state": if self.is_saving(path) { "saving" } else { "ready" },
                        "width": width,
                        "height": height,
                        "format": kind,
                        "can_save": format.is_some_and(Format::can_write),
                        "bytes": bytes,
                        "has_location": location,
                        "has_camera_details": camera,
                        "result": { "width": result_width, "height": result_height },
                    })
                }
                Picture::Unreadable(error) => json!({ "state": "unreadable", "error": error }),
                _ => json!({ "state": "reading" }),
            };
            json!({
                "name": file_name(path),
                "path": path,
                "file": picture,
                "edits": {
                    "quarter_turns_clockwise": edits.turns,
                    "mirrored": edits.mirrored,
                    "crop": edits.crop.map(|crop| json!({
                        "x": crop.rect.x,
                        "y": crop.rect.y,
                        "width": crop.rect.width,
                        "height": crop.rect.height,
                    })),
                    "size": edits.size.describe(),
                    "marks": edits.marks,
                },
                "unsaved": !edits.is_unchanged(),
                "original_kept": original_kept,
                "can_undo": self.can_undo(),
                "can_redo": self.can_redo(),
            })
        });
        json!({
            "document": self.id,
            "frontmost": frontmost,
            "folder": self.folder,
            "image_count": self.files.len(),
            "images": self.files.iter().take(500).map(|path| file_name(path)).collect::<Vec<_>>(),
            "current": current,
            "chosen": self.chosen.iter().map(|path| file_name(path)).collect::<Vec<_>>(),
            "unsaved": self.unsaved().iter().map(|path| file_name(path)).collect::<Vec<_>>(),
            "export": {
                "format": self.export.format.label(),
                "quality": self.export.quality,
                "size": self.export.size.describe(),
            },
            "problem": self.problem,
            "exported": self.exported.iter().map(|(path, result)| match result {
                Ok(exported) => json!({
                    "image": file_name(path),
                    "path": exported.path,
                    "width": exported.width,
                    "height": exported.height,
                    "bytes": exported.bytes,
                }),
                Err(error) => json!({ "image": file_name(path), "error": error }),
            }).collect::<Vec<_>>(),
        })
    }
}

/// Reads an image file, upright, with what it is.
pub fn read(path: &Path) -> Result<Loaded, String> {
    let decoded = codec::decode(path)?;
    let bytes = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let (width, height) = decoded.image.dimensions();
    Ok(Loaded {
        path: path.to_path_buf(),
        info: Info {
            width,
            height,
            kind: decoded.kind,
            format: decoded.format,
            bytes,
            location: decoded.location,
            camera: decoded.camera,
        },
        image: Arc::new(decoded.image),
    })
}

/// The images directly in `folder`, sorted the way Finder sorts names. Hidden files are left
/// out.
pub fn list_images(folder: &Path) -> Vec<PathBuf> {
    let mut images: Vec<PathBuf> = fs::read_dir(folder)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| is_image_file(path) && !file_name(path).starts_with('.'))
                .collect()
        })
        .unwrap_or_default();
    images.sort_by(|a, b| name_order(a, b));
    images
}

pub fn is_image_file(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .map(|extension| extension.to_string_lossy().to_lowercase())
            .is_some_and(|extension| IMAGE_EXTENSIONS.contains(&extension.as_str()))
}

pub fn file_name(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// Orders files the way Finder does: by name, then extension, so "photo.jpg" comes before
/// "photo 2.jpg".
fn name_order(a: &Path, b: &Path) -> Ordering {
    let part = |path: &Path, part: fn(&Path) -> Option<&std::ffi::OsStr>| {
        part(path)
            .map(|part| part.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    natural_order(&part(a, Path::file_stem), &part(b, Path::file_stem))
        .then_with(|| natural_order(&part(a, Path::extension), &part(b, Path::extension)))
}

/// Orders names the way Finder does: ignoring case, with runs of digits compared as numbers, so
/// "photo 2" comes before "photo 10".
fn natural_order(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let number = |chars: &mut std::iter::Peekable<std::str::Chars>| {
                    let digits: String =
                        std::iter::from_fn(|| chars.next_if(char::is_ascii_digit)).collect();
                    let trimmed = digits.trim_start_matches('0').to_string();
                    (trimmed.len(), trimmed)
                };
                let order = number(&mut a).cmp(&number(&mut b));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(x), Some(y)) => {
                let order = x.to_lowercase().cmp(y.to_lowercase());
                if order != Ordering::Equal {
                    return order;
                }
                a.next();
                b.next();
            }
        }
    }
}
