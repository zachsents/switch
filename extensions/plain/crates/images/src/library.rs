//! The open documents and their windows.

use std::path::PathBuf;

use gpui::{App, AppContext, Entity, Global, WindowHandle};
use serde_json::{Value, json};

use crate::{
    document::{Document, file_name},
    document_window::DocumentWindow,
};

#[derive(Default)]
pub struct Library {
    entries: Vec<Entry>,
    created: u64,
    /// The document whose window was active last, for when none is in front, as while the app
    /// runs in the background for agents.
    last_active: Option<u64>,
}

struct Entry {
    document: Entity<Document>,
    window: WindowHandle<DocumentWindow>,
}

impl Global for Library {}

/// Opens image files and folders. Each folder gets a window; files from the same folder share
/// one, showing the first and choosing the rest. An image or folder already showing is brought
/// forward instead. `focus` brings windows to the front and takes the keyboard, which windows
/// opened for agents don't. Returns the documents shown.
pub fn open(paths: Vec<PathBuf>, focus: bool, cx: &mut App) -> Result<Vec<u64>, String> {
    if let Some(missing) = paths.iter().find(|path| !path.exists()) {
        return Err(format!("There's nothing at {}", missing.display()));
    }
    let (folders, files): (Vec<_>, Vec<_>) = paths.into_iter().partition(|path| path.is_dir());
    let mut groups: Vec<(PathBuf, Vec<PathBuf>)> = Vec::new();
    for file in files {
        let folder = file.parent().map(PathBuf::from).unwrap_or_default();
        match groups.iter_mut().find(|(existing, _)| *existing == folder) {
            Some((_, group)) => group.push(file),
            None => groups.push((folder, vec![file])),
        }
    }
    let shown = folders
        .into_iter()
        .map(|folder| (folder, Vec::new()))
        .chain(groups)
        .map(|(folder, files)| open_folder(folder, files, focus, cx))
        .collect();
    Ok(shown)
}

/// Shows `folder` with `files` from it, the first shown and the rest chosen, in the window
/// already showing it if there is one, or a new one.
fn open_folder(folder: PathBuf, files: Vec<PathBuf>, focus: bool, cx: &mut App) -> u64 {
    let first = files.first().cloned();
    let existing = cx.global::<Library>().entries.iter().find(|entry| {
        let document = entry.document.read(cx);
        match &first {
            Some(file) => document.current() == Some(file.as_path()),
            None => document.folder() == folder,
        }
    });
    if let Some(entry) = existing {
        let (id, window) = (entry.document.read(cx).id(), entry.window);
        if focus {
            bring_forward(window, cx);
        }
        return id;
    }
    let id = {
        let library = cx.global_mut::<Library>();
        library.created += 1;
        library.created
    };
    let document = cx.new(|cx| Document::new(id, folder, first, cx));
    document.update(cx, |document, _| {
        for file in files.iter().skip(1) {
            document.toggle_chosen(file);
        }
    });
    let window = DocumentWindow::open(document.clone(), focus, cx);
    let library = cx.global_mut::<Library>();
    library.entries.push(Entry { document, window });
    library.last_active = Some(id);
    id
}

fn bring_forward(window: WindowHandle<DocumentWindow>, cx: &mut App) {
    window
        .update(cx, |_, window, _| window.activate_window())
        .ok();
    cx.activate(true);
}

/// The document `id`, or the frontmost one when None.
pub fn find(id: Option<u64>, cx: &App) -> Result<Entity<Document>, String> {
    let id = match id {
        Some(id) => id,
        None => frontmost(cx).ok_or("No images are open. Open some first")?,
    };
    cx.global::<Library>()
        .entries
        .iter()
        .find(|entry| entry.document.read(cx).id() == id)
        .map(|entry| entry.document.clone())
        .ok_or_else(|| format!("There's no document {id}"))
}

/// The document `id` names, or the frontmost one, like [`find`]. When an agent is asking, its
/// window comes forward so the person sees what the agent does.
pub fn target(id: Option<u64>, cx: &mut App) -> Result<Entity<Document>, String> {
    let document = find(id, cx)?;
    if kit::from_agent(cx) {
        present(document.read(cx).id(), cx);
    }
    Ok(document)
}

/// Brings document `id`'s window in front of other apps' windows, without taking the keyboard.
pub fn present(id: u64, cx: &mut App) {
    if let Some(window) = window(id, cx) {
        window.update(cx, |_, window, _| kit::present(window)).ok();
    }
}

/// The window showing document `id`.
pub fn window(id: u64, cx: &App) -> Option<WindowHandle<DocumentWindow>> {
    cx.global::<Library>()
        .entries
        .iter()
        .find(|entry| entry.document.read(cx).id() == id)
        .map(|entry| entry.window)
}

/// The document in the frontmost window, or the one active last.
pub fn frontmost(cx: &App) -> Option<u64> {
    let library = cx.global::<Library>();
    let in_front = cx.window_stack().and_then(|stack| {
        stack.into_iter().find_map(|window| {
            library
                .entries
                .iter()
                .find(|entry| entry.window.window_id() == window.window_id())
        })
    });
    in_front
        .map(|entry| entry.document.read(cx).id())
        .or(library.last_active)
        .or_else(|| {
            library
                .entries
                .first()
                .map(|entry| entry.document.read(cx).id())
        })
}

/// Notes that document `id`'s window became active.
pub fn activated(id: u64, cx: &mut App) {
    cx.global_mut::<Library>().last_active = Some(id);
}

/// Forgets document `id`, once its window has closed.
pub fn remove(id: u64, cx: &mut App) {
    let entries = std::mem::take(&mut cx.global_mut::<Library>().entries);
    let kept = entries
        .into_iter()
        .filter(|entry| entry.document.read(cx).id() != id)
        .collect();
    let library = cx.global_mut::<Library>();
    library.entries = kept;
    if library.last_active == Some(id) {
        library.last_active = None;
    }
}

/// Every open document.
pub fn documents(cx: &App) -> Vec<Entity<Document>> {
    cx.global::<Library>()
        .entries
        .iter()
        .map(|entry| entry.document.clone())
        .collect()
}

/// What agents see: every open document.
pub fn report(cx: &App) -> Value {
    let frontmost = frontmost(cx);
    let documents: Vec<_> = documents(cx)
        .iter()
        .map(|document| {
            let document = document.read(cx);
            let kept = document
                .current()
                .is_some_and(|path| crate::writing::has_original(path, cx));
            let mut report = document.report(Some(document.id()) == frontmost, kept);
            report["window"] = window(document.id(), cx)
                .and_then(|window| window.read(cx).ok())
                .map(|view| view.report())
                .into();
            report
        })
        .collect();
    json!({
        "documents": documents,
        "frontmost": frontmost,
        "hint": if documents.is_empty() {
            "No images are open. Use open with image files or folders."
        } else {
            "Commands act on the frontmost document unless given one."
        },
        "unsaved_anywhere": documents_with_unsaved(cx)
            .iter()
            .map(|document| file_name(document.read(cx).folder()))
            .collect::<Vec<_>>(),
    })
}

/// Documents with an image whose edits haven't been saved.
pub fn documents_with_unsaved(cx: &App) -> Vec<Entity<Document>> {
    documents(cx)
        .into_iter()
        .filter(|document| !document.read(cx).unsaved().is_empty())
        .collect()
}
