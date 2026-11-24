//! Writing images out, in the background: saving edits into files, exporting copies, and
//! copying to the clipboard. Agent calls wait for these to finish, and fail if they do.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use futures::future::join_all;
use gpui::{App, AppContext, Entity, Global, Task};
use image::RgbaImage;
use imaging::{
    codec::{self, Format},
    file,
};

use crate::{
    actions::CopyFormat,
    document::{self, Document, ExportSettings, Exported, file_name},
    edits::Edits,
    originals::Originals,
    render,
};

/// Where originals are kept, for the whole app.
pub struct KeptOriginals(pub Originals);

impl Global for KeptOriginals {}

/// Quality for saving over a file in a lossy format: high, since the file is the original.
fn saving_quality(format: Format) -> f32 {
    match format {
        Format::Heic | Format::Avif => 0.9,
        _ => 0.92,
    }
}

/// An image's pixels and format: the shown one's from memory, or read from its file in the
/// background.
fn pixels(document: &Document, path: &Path) -> Option<(Arc<RgbaImage>, Option<Format>)> {
    document
        .loaded()
        .filter(|loaded| loaded.path == path)
        .map(|loaded| (loaded.image.clone(), loaded.info.format))
}

/// Reads `path` unless its pixels are already at hand.
fn read_if_needed(
    path: &Path,
    known: Option<(Arc<RgbaImage>, Option<Format>)>,
) -> Result<(Arc<RgbaImage>, Option<Format>), String> {
    match known {
        Some(known) => Ok(known),
        None => document::read(path).map(|loaded| (loaded.image, loaded.info.format)),
    }
}

/// Saves the edits of each of `paths` into its file. The first save of a file keeps its
/// original. Images being saved can't be edited until they're written.
pub fn save(
    document: &Entity<Document>,
    paths: Vec<PathBuf>,
    cx: &mut App,
) -> Task<Result<(), String>> {
    let originals = cx.global::<KeptOriginals>().0.clone();
    let jobs: Vec<_> = document.update(cx, |document, cx| {
        let to_save: Vec<_> = paths
            .into_iter()
            .filter(|path| document.is_edited(path) && !document.is_saving(path))
            .collect();
        let jobs = to_save
            .into_iter()
            .map(|path| {
                document.start_saving(&path);
                let known = pixels(document, &path);
                let edits = document.edits_of(&path);
                (path, known, edits)
            })
            .collect();
        document.problem = None;
        cx.notify();
        jobs
    });
    let writes: Vec<_> = jobs
        .into_iter()
        .map(|(path, known, edits)| {
            let originals = originals.clone();
            let write = cx.background_spawn({
                let path = path.clone();
                async move { save_one(&path, known, &edits, &originals) }
            });
            (path, write)
        })
        .collect();
    let document = document.clone();
    cx.spawn(async move |cx| {
        let mut outcome = Ok(());
        for (path, write) in writes {
            let result = write.await;
            let reloaded = document.update(cx, |document, cx| {
                document.finish_saving(&path, result.is_ok());
                if let Err(error) = &result {
                    document.problem = Some(error.clone());
                }
                cx.notify();
                (result.is_ok() && document.current() == Some(path.as_path()))
                    .then(|| document.reload(cx))
                    .flatten()
            });
            // The reply shows the saved file, read again.
            if let Some(reloaded) = reloaded {
                reloaded.await.ok();
            }
            outcome = outcome.and(result);
        }
        outcome
    })
}

fn save_one(
    path: &Path,
    known: Option<(Arc<RgbaImage>, Option<Format>)>,
    edits: &Edits,
    originals: &Originals,
) -> Result<(), String> {
    let (image, format) = read_if_needed(path, known)?;
    let format = format.filter(|format| format.can_write()).ok_or_else(|| {
        format!(
            "Images can't save over {}, since macOS can't write its format. Export a copy instead",
            file_name(path)
        )
    })?;
    let edited = render::render(&image, edits);
    let bytes = codec::encode_keeping_metadata(&edited, format, saving_quality(format), path)?;
    originals.keep(path)?;
    file::replace(path, &bytes)
}

/// Puts the shown image's original back over its file, dropping its edits.
pub fn revert_to_original(document: &Entity<Document>, cx: &mut App) -> Result<(), String> {
    let path = document
        .read(cx)
        .current()
        .map(PathBuf::from)
        .ok_or("There's no image to revert")?;
    cx.global::<KeptOriginals>().0.restore(&path)?;
    document.update(cx, |document, cx| {
        document.revert();
        document.reload(cx);
        cx.notify();
    });
    Ok(())
}

/// Whether an image of `path` has an original kept.
pub fn has_original(path: &Path, cx: &App) -> bool {
    cx.global::<KeptOriginals>().0.has(path)
}

/// Exports `targets` as new files beside them, with their edits and `settings`.
pub fn export(
    document: &Entity<Document>,
    targets: Vec<PathBuf>,
    settings: ExportSettings,
    cx: &mut App,
) -> Task<Result<(), String>> {
    let jobs: Vec<_> = document.update(cx, |document, cx| {
        document.exported.clear();
        document.problem = None;
        cx.notify();
        targets
            .into_iter()
            .map(|path| {
                let known = pixels(document, &path);
                let edits = document.edits_of(&path);
                (path, known, edits)
            })
            .collect()
    });
    let writes: Vec<_> = jobs
        .into_iter()
        .map(|(path, known, edits)| {
            let write = cx.background_spawn({
                let path = path.clone();
                async move { export_one(&path, known, &edits, settings) }
            });
            (path, write)
        })
        .collect();
    let document = document.clone();
    cx.spawn(async move |cx| {
        let paths: Vec<_> = writes.iter().map(|(path, _)| path.clone()).collect();
        let results = join_all(writes.into_iter().map(|(_, write)| write)).await;
        let failure = results.iter().find_map(|result| result.clone().err());
        document.update(cx, |document, cx| {
            document.exported = paths.into_iter().zip(results).collect();
            document.problem = failure.clone();
            document.refresh(cx);
            cx.notify();
        });
        failure.map_or(Ok(()), Err)
    })
}

fn export_one(
    path: &Path,
    known: Option<(Arc<RgbaImage>, Option<Format>)>,
    edits: &Edits,
    settings: ExportSettings,
) -> Result<Exported, String> {
    let (image, original) = read_if_needed(path, known)?;
    let edited = render::render(&image, edits);
    let (width, height) = settings.size.apply(edited.width(), edited.height());
    let resized = render::render(
        &edited,
        &Edits {
            size: crate::size::Size::Fit { width, height },
            ..Edits::default()
        },
    );
    let format = settings
        .format
        .resolve(original, has_transparency(&resized));
    let bytes = codec::encode(&resized, format, f32::from(settings.quality) / 100.)?;
    let folder = path.parent().unwrap_or(Path::new("."));
    let stem = path.file_stem().map_or_else(
        || "image".into(),
        |stem| stem.to_string_lossy().into_owned(),
    );
    let written = file::write_new(folder, &stem, format.extension(), &bytes)?;
    Ok(Exported {
        path: written,
        width,
        height,
        bytes: bytes.len() as u64,
    })
}

fn has_transparency(image: &RgbaImage) -> bool {
    image.pixels().any(|pixel| pixel.0[3] < 255)
}

/// Copies the shown image, with its edits, to the clipboard: as a PNG, or with a format, also as
/// a file in that format, so it pastes into Finder or a chat as a file.
pub fn copy(
    document: &Entity<Document>,
    format: Option<CopyFormat>,
    cx: &mut App,
) -> Result<Task<Result<(), String>>, String> {
    let (loaded, edits) = {
        let document = document.read(cx);
        let loaded = document
            .loaded()
            .cloned()
            .ok_or("There's no image to copy")?;
        (loaded, document.edits())
    };
    let encode = cx.background_spawn(async move {
        let edited = render::render(&loaded.image, &edits);
        let png = codec::encode(&edited, Format::Png, 1.)?;
        let file = match format {
            None => None,
            Some(format) => {
                let (format, bytes) = match format {
                    CopyFormat::Png => (Format::Png, png.clone()),
                    CopyFormat::Jpeg => (Format::Jpeg, codec::encode(&edited, Format::Jpeg, 0.9)?),
                };
                let folder = std::env::temp_dir().join("plain-images-clipboard");
                let stem = loaded.path.file_stem().map_or_else(
                    || "image".into(),
                    |stem| stem.to_string_lossy().into_owned(),
                );
                let path = folder.join(format!("{stem}.{}", format.extension()));
                fs::create_dir_all(&folder)
                    .and_then(|()| fs::write(&path, &bytes))
                    .map_err(|error| format!("Couldn't make the file to copy: {error}"))?;
                Some((format, bytes, path))
            }
        };
        Ok::<_, String>((png, file))
    });
    let document = document.clone();
    Ok(cx.spawn(async move |cx| {
        let encoded = encode.await;
        let copied = encoded.and_then(|(png, file)| {
            let formats: Vec<(&str, &[u8])> = match &file {
                Some((format, bytes, _)) if *format != Format::Png => vec![
                    (format.type_identifier(), bytes.as_slice()),
                    (Format::Png.type_identifier(), png.as_slice()),
                ],
                _ => vec![(Format::Png.type_identifier(), png.as_slice())],
            };
            // The clipboard belongs to the main thread.
            cx.update(|_| {
                imaging::clipboard::copy(&formats, file.as_ref().map(|(_, _, path)| path.as_path()))
            })
        });
        document.update(cx, |document, cx| {
            document.problem = copied.clone().err();
            cx.notify();
        });
        copied
    }))
}
