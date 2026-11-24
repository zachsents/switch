mod actions;
mod canvas;
mod crop;
mod document;
mod document_window;
mod edits;
mod framing;
mod library;
mod markup;
mod originals;
mod picture;
mod render;
mod session;
mod size;
mod thumbnails;
mod writing;

use std::path::PathBuf;

use gpui::{
    Action, App, AppContext, Context, KeyBinding, Menu, MenuItem, OsAction, PathPromptOptions,
    PromptLevel, Task, Window,
};
use imaging::draw::Mark;
use kit::{AppInfo, CloseWindow};

use crate::{
    actions::{
        ActualSize, AddMark, ApplyCrop, CancelCrop, ChooseAll, ChooseTool, ClearCrop, Close, Copy,
        CopyFormat, CropTo, DeleteMark, DeleteSelectedMark, DescribeCrop, DeselectMark, Direction,
        EditExportSize, EditMarkText, EditSize, Export, Flip, ForDocument, NextCropHandle,
        NextImage, NudgeCrop, NudgeMark, Open, OpenDialog, PreviousCropHandle, PreviousImage, Redo,
        Resize, Revert, RevertToOriginal, Rotate, Save, SetCrop, SetExportFormat, SetExportQuality,
        SetMarkColor, SetThickness, ShowExportPanel, ShowImage, ShowInFinder, ShowSidebar,
        ToggleCrop, ToggleExport, ToggleMarkup, ToggleSidebar, Undo, UpdateMark, Zoom, ZoomIn,
        ZoomOut, ZoomToFit,
    },
    crop::{Aspect, Crop, Rect},
    document::{Document, ExportFormat, ExportSettings},
    document_window::{DocumentWindow, SharedThumbnails},
    edits::{Edits, FlipDirection, Turn},
    library::Library,
    markup::{Thickness, Tool},
    originals::Originals,
    session::Change,
    thumbnails::Thumbnails,
    writing::KeptOriginals,
};

const APP: AppInfo = AppInfo {
    id: "images",
    name: "Images",
};

/// The quality presets offered in the window. Agents can give any value from 1 to 100. The
/// default, 80, is "High".
pub const QUALITIES: [(&str, u8); 4] = [("Low", 50), ("Medium", 70), ("High", 80), ("Best", 95)];

/// The crop shapes offered in the window, as labels and the words that set them. Agents can
/// give any ratio.
pub const ASPECTS: [(&str, &str); 6] = [
    ("Free", "free"),
    ("Original", "original"),
    ("1:1", "1:1"),
    ("4:3", "4:3"),
    ("16:9", "16:9"),
    ("3:2", "3:2"),
];

const NUDGES: [(&str, Direction); 4] = [
    ("left", Direction::Left),
    ("right", Direction::Right),
    ("up", Direction::Up),
    ("down", Direction::Down),
];

fn main() {
    kit::main(APP, |cx| {
        cx.set_global(Library::default());
        cx.set_global(KeptOriginals(Originals::new(
            kit::data_dir(cx).join("originals"),
        )));
        let thumbnails = cx.new(|_| Thumbnails::default());
        cx.set_global(SharedThumbnails(thumbnails));
        kit::report_state(cx, library::report);
        kit::set_main_window(cx, open_dialog);
        kit::on_open_files(cx, |paths, cx| {
            library::open(paths, true, cx).ok();
        });
        kit::on_quit(cx, ask_before_quitting);

        cx.on_action(|action: &Open, cx| {
            let paths = action.paths.iter().map(PathBuf::from).collect();
            match library::open(paths, false, cx) {
                Ok(shown) => shown
                    .into_iter()
                    .for_each(|document| library::present(document, cx)),
                Err(error) => kit::reject(cx, error),
            }
        });
        view(cx, |view, action: &Zoom, window, cx| {
            view.zoom_to(action.to, window, cx)
        });
        view(cx, |view, action: &ShowSidebar, _, cx| {
            view.show_sidebar(action.show, cx)
        });
        view(cx, |view, action: &ShowExportPanel, _, cx| {
            view.show_export_panel(action.show, cx)
        });
        cx.on_action(|_: &OpenDialog, cx| open_dialog(cx));
        cx.on_action(close);
        handle(cx, |document, action: &ShowImage, cx| {
            let path = document
                .find(&action.name)
                .cloned()
                .ok_or_else(|| format!("There's no image called {} here", action.name))?;
            document.show(path, cx);
            Ok(())
        });
        handle(cx, |document, _: &NextImage, cx| {
            document.show_by_offset(1, cx);
            Ok(())
        });
        handle(cx, |document, _: &PreviousImage, cx| {
            document.show_by_offset(-1, cx);
            Ok(())
        });
        handle(cx, |document, action: &SetCrop, _| {
            document.edit(Change::Crop, |edits, info| set_crop(action, edits, info))
        });
        cx.on_action(crop_to);
        handle(cx, |document, _: &ClearCrop, _| {
            document.edit(Change::Crop, |edits, _| {
                Ok(Edits {
                    crop: None,
                    ..edits
                })
            })
        });
        handle(cx, |document, action: &Rotate, _| {
            document.edit(Change::Turn, |edits, info| {
                Ok(edits.turned(action.direction, info.width, info.height))
            })
        });
        handle(cx, |document, action: &Flip, _| {
            document.edit(Change::Flip, |edits, info| {
                Ok(edits.flipped(action.direction, info.width, info.height))
            })
        });
        cx.on_action(resize);
        handle(cx, |document, action: &AddMark, _| {
            document.edit(Change::AddMark, |edits, _| {
                Ok(Edits {
                    marks: edits
                        .marks
                        .iter()
                        .cloned()
                        .chain([action.mark.clone()])
                        .collect(),
                    ..edits
                })
            })
        });
        handle(cx, |document, action: &UpdateMark, _| {
            document.edit(Change::EditMark, |edits, _| {
                let marks = replace_mark(&edits.marks, action.index, Some(&action.mark))?;
                Ok(Edits { marks, ..edits })
            })
        });
        handle(cx, |document, action: &DeleteMark, _| {
            document.edit(Change::DeleteMark, |edits, _| {
                let marks = replace_mark(&edits.marks, action.index, None)?;
                Ok(Edits { marks, ..edits })
            })
        });
        handle(cx, |document, _: &Undo, _| {
            document
                .undo()
                .then_some(())
                .ok_or_else(|| "There's nothing to undo".into())
        });
        handle(cx, |document, _: &Redo, _| {
            document
                .redo()
                .then_some(())
                .ok_or_else(|| "There's nothing to redo".into())
        });
        handle(cx, |document, _: &Revert, _| {
            document.revert();
            Ok(())
        });
        cx.on_action(|action: &Save, cx| {
            let saved = library::target(action.document, cx).and_then(|document| {
                let path = document
                    .read(cx)
                    .current()
                    .map(PathBuf::from)
                    .ok_or("There's no image to save")?;
                Ok(writing::save(&document, vec![path], cx))
            });
            match saved {
                Ok(task) => kit::finish_before_replying(cx, task),
                Err(error) => kit::reject(cx, error),
            }
        });
        cx.on_action(|action: &RevertToOriginal, cx| {
            let reverted = library::target(action.document, cx)
                .and_then(|document| writing::revert_to_original(&document, cx));
            if let Err(error) = reverted {
                kit::reject(cx, error);
            }
        });
        cx.on_action(export);
        cx.on_action(|action: &Copy, cx| {
            let copied = library::target(action.document, cx)
                .and_then(|document| writing::copy(&document, action.format, cx));
            match copied {
                Ok(task) => kit::finish_before_replying(cx, task),
                Err(error) => kit::reject(cx, error),
            }
        });

        cx.bind_keys(key_bindings());
        set_menus(cx);
    });
}

/// The edits with the crop `action` asks for.
fn set_crop(action: &SetCrop, edits: Edits, info: &document::Info) -> Result<Edits, String> {
    let (width, height) = edits.turned_size(info.width, info.height);
    let current = edits.crop.unwrap_or(Crop {
        rect: Rect::whole(width, height),
        aspect: Aspect::Free,
    });
    let aspect = action
        .aspect
        .as_deref()
        .map(Aspect::parse)
        .transpose()?
        .unwrap_or(current.aspect);
    let rect = match (action.x, action.y, action.width, action.height) {
        (Some(x), Some(y), Some(width), Some(height)) => Some(Rect {
            x,
            y,
            width,
            height,
        }),
        (None, None, None, None) => None,
        _ => return Err("Give all of x, y, width and height, or none of them".into()),
    };
    let ratio = aspect.ratio_on(width, height);
    let rect = match rect {
        Some(rect) if !rect.fits(width, height) => {
            return Err(format!(
                "That crop goes past the edge of the {width} × {height} image"
            ));
        }
        Some(rect) => rect.held_to(ratio),
        None if aspect == Aspect::Free => current.rect,
        None => Rect::centered(ratio, width, height),
    };
    // The whole image with a free shape is no crop at all.
    let crop = (rect != Rect::whole(width, height) || aspect != Aspect::Free)
        .then_some(Crop { rect, aspect });
    Ok(Edits { crop, ..edits })
}

/// Crops once the words are understood, which takes a moment when the parser doesn't know
/// them.
fn crop_to(action: &CropTo, cx: &mut App) {
    let cropped = library::target(action.document, cx).and_then(|document| {
        let (width, height) = {
            let document = document.read(cx);
            let info = &document.loaded().ok_or("There's no image to crop")?.info;
            document.edits().turned_size(info.width, info.height)
        };
        let understood = framing::understand(action.to.clone(), width, height, cx);
        Ok(cx.spawn(async move |cx| {
            let framing = understood.await;
            document.update(cx, |document, cx| {
                cx.notify();
                let cropped = framing.and_then(|framing| {
                    document.edit(Change::Crop, |edits, info| {
                        let (width, height) = edits.turned_size(info.width, info.height);
                        let crop = framing.crop_on(width, height)?;
                        Ok(Edits { crop, ..edits })
                    })
                });
                document.problem = cropped.as_ref().err().cloned();
                cropped
            })
        }))
    });
    match cropped {
        Ok(task) => kit::finish_before_replying(cx, task),
        Err(error) => kit::reject(cx, error),
    }
}

/// `marks` with mark `index` replaced by `with`, or removed when it's None.
fn replace_mark(marks: &[Mark], index: usize, with: Option<&Mark>) -> Result<Vec<Mark>, String> {
    if index >= marks.len() {
        return Err(match marks.len() {
            0 => "The image has no marks".into(),
            count => format!(
                "There's no mark {index}. The image's marks go from 0 to {}",
                count - 1
            ),
        });
    }
    Ok(marks
        .iter()
        .enumerate()
        .filter_map(|(at, mark)| {
            if at == index {
                with.cloned()
            } else {
                Some(mark.clone())
            }
        })
        .collect())
}

/// Chooses images or folders to open, each in its own window.
fn open_dialog(cx: &mut App) {
    let chosen = cx.prompt_for_paths(PathPromptOptions {
        files: true,
        directories: true,
        multiple: true,
        prompt: Some("Open".into()),
    });
    cx.spawn(async move |cx| {
        if let Ok(Ok(Some(paths))) = chosen.await {
            cx.update(|cx| library::open(paths, true, cx).ok());
        }
    })
    .detach();
}

/// Closes a document's window, saving or dropping its unsaved edits as told.
fn close(action: &Close, cx: &mut App) {
    let document = match library::find(action.document, cx) {
        Ok(document) => document,
        Err(error) => return kit::reject(cx, error),
    };
    let (id, unsaved) = {
        let document = document.read(cx);
        (document.id(), document.unsaved())
    };
    let Some(window) = library::window(id, cx) else {
        return;
    };
    // Forgotten right away, so the reply no longer lists it.
    let remove = move |cx: &mut App| {
        library::remove(id, cx);
        window
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    };
    match (unsaved.is_empty(), action.save) {
        (true, _) | (false, Some(false)) => remove(cx),
        (false, Some(true)) => {
            let saved = writing::save(&document, unsaved, cx);
            let closed = cx.spawn(async move |cx| {
                let result = saved.await;
                if result.is_ok() {
                    cx.update(remove);
                }
                result
            });
            kit::finish_before_replying(cx, closed);
        }
        (false, None) => kit::reject(
            cx,
            format!(
                "{} images have unsaved edits. Pass save: true to save them or false to throw \
                 them away",
                unsaved.len()
            ),
        ),
    }
}

/// Resizes once the size is understood, which takes a moment when it's in words the parser
/// doesn't know.
fn resize(action: &Resize, cx: &mut App) {
    let resized = library::target(action.document, cx).and_then(|document| {
        let (width, height) = document
            .read(cx)
            .shown_size()
            .ok_or("There's no image to resize")?;
        let understood = size::understand(action.size.clone(), width, height, cx);
        Ok(cx.spawn(async move |cx| {
            let size = understood.await;
            document.update(cx, |document, cx| {
                cx.notify();
                let resized = size.and_then(|size| {
                    document.edit(Change::Resize, |edits, _| Ok(Edits { size, ..edits }))
                });
                document.problem = resized.as_ref().err().cloned();
                resized
            })
        }))
    });
    match resized {
        Ok(task) => kit::finish_before_replying(cx, task),
        Err(error) => kit::reject(cx, error),
    }
}

fn export(action: &Export, cx: &mut App) {
    let exported = library::target(action.document, cx).and_then(|document| {
        let (width, height) = document.read(cx).shown_size().unwrap_or((1, 1));
        let (targets, settings) = {
            let document = document.read(cx);
            let targets = match &action.images {
                Some(names) => names
                    .iter()
                    .map(|name| {
                        document
                            .find(name)
                            .cloned()
                            .ok_or_else(|| format!("There's no image called {name} here"))
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                None => document.export_targets(),
            };
            let settings = ExportSettings {
                format: action.format.unwrap_or(document.export.format),
                quality: action
                    .quality
                    .unwrap_or(document.export.quality)
                    .clamp(1, 100),
                size: document.export.size,
            };
            (targets, settings)
        };
        if targets.is_empty() {
            return Err("There's no image to export".into());
        }
        let size = match action.size.clone() {
            Some(size) => size::understand(size, width, height, cx),
            None => Task::ready(Ok(settings.size)),
        };
        Ok(cx.spawn(async move |cx| {
            let settings = ExportSettings {
                size: size.await?,
                ..settings
            };
            cx.update(|cx| writing::export(&document, targets, settings, cx))
                .await
        }))
    });
    match exported {
        Ok(task) => kit::finish_before_replying(cx, task),
        Err(error) => kit::reject(cx, error),
    }
}

/// Quitting with unsaved edits asks first, in the front window that has them.
fn ask_before_quitting(cx: &mut App) -> bool {
    let unsaved = library::documents_with_unsaved(cx);
    let Some(first) = unsaved.first() else {
        return true;
    };
    let count: usize = unsaved
        .iter()
        .map(|document| document.read(cx).unsaved().len())
        .sum();
    let Some(window) = library::window(first.read(cx).id(), cx) else {
        return true;
    };
    let answer = window.update(cx, |_, window, cx| {
        window.prompt(
            PromptLevel::Warning,
            &format!("Save your changes to {count} images before quitting?"),
            Some("Your changes are lost if you don't save them."),
            &["Save All", "Don't Save", "Cancel"],
            cx,
        )
    });
    let Ok(answer) = answer else {
        return true;
    };
    cx.spawn(async move |cx| match answer.await {
        Ok(0) => {
            let saves = cx.update(|cx| {
                unsaved
                    .iter()
                    .map(|document| {
                        let paths = document.read(cx).unsaved();
                        writing::save(document, paths, cx)
                    })
                    .collect::<Vec<_>>()
            });
            let saved = futures::future::join_all(saves).await;
            if saved.iter().all(Result::is_ok) {
                cx.update(|cx| cx.quit());
            }
        }
        Ok(1) => cx.update(|cx| cx.quit()),
        _ => {}
    })
    .detach();
    false
}

/// Handles an action app-wide by updating a document: the one it names, or the frontmost. It
/// works the same from the keyboard, a click, the menus or an agent. An error fails the agent
/// call that sent the action; from anywhere else there's nothing to report.
fn handle<A: Action + ForDocument>(
    cx: &mut App,
    update: impl Fn(&mut Document, &A, &mut Context<Document>) -> Result<(), String> + 'static,
) {
    cx.on_action(move |action: &A, cx| {
        let result = library::target(action.document(), cx).and_then(|document| {
            document.update(cx, |document, cx| {
                let result = update(document, action, cx);
                cx.notify();
                result
            })
        });
        if let Err(error) = result {
            kit::reject(cx, error);
        }
    });
}

/// Handles an action that changes how a document's window shows it, like its zoom. The
/// window comes forward for an agent like any other change.
fn view<A: Action + ForDocument>(
    cx: &mut App,
    change: impl Fn(&mut DocumentWindow, &A, &mut Window, &mut Context<DocumentWindow>) + 'static,
) {
    cx.on_action(move |action: &A, cx| {
        let changed = library::target(action.document(), cx).and_then(|document| {
            let id = document.read(cx).id();
            library::window(id, cx)
                .ok_or_else(|| format!("Document {id} has no window"))?
                .update(cx, |view, window, cx| change(view, action, window, cx))
                .map_err(|error| error.to_string())
        });
        if let Err(error) = changed {
            kit::reject(cx, error);
        }
    });
}

/// Single keys only work outside text fields, so typing never triggers them. The arrows and
/// crop keys are bound whether or not cropping: the window only handles the crop actions while
/// cropping, so otherwise their keys fall through to the next binding. Binding them only in a
/// cropping context instead would leave buttons without their shortcut for a frame, since
/// buttons read shortcuts from the last frame's contexts.
fn key_bindings() -> Vec<KeyBinding> {
    let list = Some("Images && !TextField");
    let window = Some("Images");
    let format = |index: usize| SetExportFormat {
        format: ExportFormat::ALL[index],
    };
    let quality = |index: usize| SetExportQuality {
        quality: QUALITIES[index].1,
    };
    let aspect = |index: usize| SetCrop::aspect(ASPECTS[index].1);
    let rotate = |direction| Rotate {
        document: None,
        direction,
    };
    let flip = |direction| Flip {
        document: None,
        direction,
    };
    let copy_as = |format| Copy {
        document: None,
        format: Some(format),
    };
    // After the arrows below, so they take precedence while cropping, and a chosen mark's
    // nudges over the crop's.
    let nudges = NUDGES.into_iter().flat_map(|(key, direction)| {
        [false, true].into_iter().flat_map(move |fast| {
            let key = if fast {
                format!("shift-{key}")
            } else {
                key.to_string()
            };
            [
                KeyBinding::new(&key, NudgeCrop { direction, fast }, list),
                KeyBinding::new(&key, NudgeMark { direction, fast }, list),
            ]
        })
    });
    let tools = Tool::ALL.map(|tool| KeyBinding::new(tool.key(), ChooseTool { tool }, list));
    let colors = (0..imaging::draw::Color::PALETTE.len()).map(|index| {
        KeyBinding::new(
            &format!("alt-{}", index + 1),
            SetMarkColor { index },
            window,
        )
    });
    let thicknesses = Thickness::ALL
        .iter()
        .enumerate()
        .map(|(index, &thickness)| {
            KeyBinding::new(
                &format!("alt-shift-{}", index + 1),
                SetThickness { thickness },
                window,
            )
        });
    vec![
        KeyBinding::new("cmd-o", OpenDialog, None),
        KeyBinding::new("cmd-s", Save::default(), window),
        KeyBinding::new("cmd-z", Undo::default(), list),
        KeyBinding::new("cmd-shift-z", Redo::default(), list),
        KeyBinding::new("cmd-c", Copy::default(), list),
        KeyBinding::new("cmd-shift-c", copy_as(CopyFormat::Png), list),
        KeyBinding::new("cmd-alt-c", copy_as(CopyFormat::Jpeg), list),
        KeyBinding::new("cmd-a", ChooseAll, list),
        KeyBinding::new("cmd-l", rotate(Turn::Left), window),
        KeyBinding::new("cmd-r", rotate(Turn::Right), window),
        KeyBinding::new("f", flip(FlipDirection::Horizontal), list),
        KeyBinding::new("shift-f", flip(FlipDirection::Vertical), list),
        KeyBinding::new("s", EditSize, list),
        KeyBinding::new("cmd-=", ZoomIn, window),
        KeyBinding::new("cmd-+", ZoomIn, window),
        KeyBinding::new("cmd--", ZoomOut, window),
        KeyBinding::new("cmd-9", ZoomToFit, window),
        KeyBinding::new("cmd-0", ActualSize, window),
        KeyBinding::new("ctrl-cmd-s", ToggleSidebar, window),
        KeyBinding::new("cmd-alt-r", ShowInFinder, window),
        KeyBinding::new("cmd-e", ToggleExport, window),
        KeyBinding::new("cmd-enter", Export::default(), window),
        KeyBinding::new("shift-s", EditExportSize, list),
        KeyBinding::new("cmd-1", format(0), window),
        KeyBinding::new("cmd-2", format(1), window),
        KeyBinding::new("cmd-3", format(2), window),
        KeyBinding::new("cmd-4", format(3), window),
        KeyBinding::new("cmd-5", format(4), window),
        KeyBinding::new("cmd-6", format(5), window),
        KeyBinding::new("cmd-alt-1", quality(0), window),
        KeyBinding::new("cmd-alt-2", quality(1), window),
        KeyBinding::new("cmd-alt-3", quality(2), window),
        KeyBinding::new("cmd-alt-4", quality(3), window),
        KeyBinding::new("left", PreviousImage::default(), list),
        KeyBinding::new("up", PreviousImage::default(), list),
        KeyBinding::new("right", NextImage::default(), list),
        KeyBinding::new("down", NextImage::default(), list),
        KeyBinding::new("c", ToggleCrop, list),
        KeyBinding::new("shift-c", ClearCrop::default(), list),
        KeyBinding::new("w", DescribeCrop, list),
        KeyBinding::new("1", aspect(0), list),
        KeyBinding::new("2", aspect(1), list),
        KeyBinding::new("3", aspect(2), list),
        KeyBinding::new("4", aspect(3), list),
        KeyBinding::new("5", aspect(4), list),
        KeyBinding::new("6", aspect(5), list),
        // Before the crop's, so finishing or cancelling a crop wins while cropping.
        KeyBinding::new("enter", EditMarkText, list),
        KeyBinding::new("escape", DeselectMark, list),
        KeyBinding::new("enter", ApplyCrop, list),
        KeyBinding::new("escape", CancelCrop, list),
        KeyBinding::new("backspace", DeleteSelectedMark, list),
        KeyBinding::new("delete", DeleteSelectedMark, list),
        KeyBinding::new("cmd-shift-a", ToggleMarkup, window),
        KeyBinding::new("tab", NextCropHandle, list),
        KeyBinding::new("shift-tab", PreviousCropHandle, list),
    ]
    .into_iter()
    .chain(tools)
    .chain(colors)
    .chain(thicknesses)
    .chain(nudges)
    .collect()
}

fn set_menus(cx: &mut App) {
    let rotate = |direction| Rotate {
        document: None,
        direction,
    };
    let flip = |direction| Flip {
        document: None,
        direction,
    };
    let copy_as = |format| Copy {
        document: None,
        format: Some(format),
    };
    kit::set_menus(
        cx,
        APP.name,
        [
            Menu::new("File").items([
                MenuItem::action("Open…", OpenDialog),
                MenuItem::action("Close", CloseWindow),
                MenuItem::separator(),
                MenuItem::action("Save", Save::default()),
                MenuItem::action("Revert to Saved", Revert::default()),
                MenuItem::action("Revert to Original", RevertToOriginal::default()),
                MenuItem::separator(),
                MenuItem::action("Show Export Settings", ToggleExport),
                MenuItem::action("Export", Export::default()),
                MenuItem::separator(),
                MenuItem::action("Show in Finder", ShowInFinder),
            ]),
            Menu::new("Edit").items([
                MenuItem::os_action("Undo", Undo::default(), OsAction::Undo),
                MenuItem::os_action("Redo", Redo::default(), OsAction::Redo),
                MenuItem::separator(),
                MenuItem::os_action("Copy", Copy::default(), OsAction::Copy),
                MenuItem::action("Copy as PNG File", copy_as(CopyFormat::Png)),
                MenuItem::action("Copy as JPEG File", copy_as(CopyFormat::Jpeg)),
                MenuItem::separator(),
                MenuItem::os_action("Choose All", ChooseAll, OsAction::SelectAll),
            ]),
            Menu::new("Image").items([
                MenuItem::action("Rotate Left", rotate(Turn::Left)),
                MenuItem::action("Rotate Right", rotate(Turn::Right)),
                MenuItem::action("Flip Horizontal", flip(FlipDirection::Horizontal)),
                MenuItem::action("Flip Vertical", flip(FlipDirection::Vertical)),
                MenuItem::separator(),
                MenuItem::action("Crop", ToggleCrop),
                MenuItem::action("Crop To…", DescribeCrop),
                MenuItem::action("Clear Crop", ClearCrop::default()),
                MenuItem::submenu(
                    Menu::new("Crop Shape").items(
                        ASPECTS
                            .iter()
                            .map(|&(label, input)| MenuItem::action(label, SetCrop::aspect(input))),
                    ),
                ),
                MenuItem::submenu(Menu::new("Move Crop Handle").items([
                    MenuItem::action("Next Handle", NextCropHandle),
                    MenuItem::action("Previous Handle", PreviousCropHandle),
                ])),
                MenuItem::action("Finish Cropping", ApplyCrop),
                MenuItem::action("Cancel Cropping", CancelCrop),
                MenuItem::separator(),
                MenuItem::action("Resize…", EditSize),
            ]),
            Menu::new("Markup").items(
                [
                    MenuItem::action("Show Markup Tools", ToggleMarkup),
                    MenuItem::separator(),
                ]
                .into_iter()
                .chain(Tool::ALL.map(|tool| MenuItem::action(tool.label(), ChooseTool { tool })))
                .chain([
                    MenuItem::separator(),
                    MenuItem::submenu(Menu::new("Color").items(
                        imaging::draw::Color::PALETTE.iter().enumerate().map(
                            |(index, (name, _))| {
                                MenuItem::action(capitalized(name), SetMarkColor { index })
                            },
                        ),
                    )),
                    MenuItem::submenu(Menu::new("Thickness").items(Thickness::ALL.map(
                        |thickness| MenuItem::action(thickness.label(), SetThickness { thickness }),
                    ))),
                    MenuItem::separator(),
                    MenuItem::action("Edit Text", EditMarkText),
                    MenuItem::action("Delete Mark", DeleteSelectedMark),
                    MenuItem::action("Stop Marking Up", DeselectMark),
                ]),
            ),
            Menu::new("View").items([
                MenuItem::action("Zoom In", ZoomIn),
                MenuItem::action("Zoom Out", ZoomOut),
                MenuItem::action("Zoom to Fit", ZoomToFit),
                MenuItem::action("Actual Size", ActualSize),
                MenuItem::separator(),
                MenuItem::action("Show or Hide Images", ToggleSidebar),
            ]),
            Menu::new("Go").items([
                MenuItem::action("Previous Image", PreviousImage::default()),
                MenuItem::action("Next Image", NextImage::default()),
            ]),
        ],
    );
}

/// "Red" for "red".
fn capitalized(word: &str) -> String {
    let mut chars = word.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}
