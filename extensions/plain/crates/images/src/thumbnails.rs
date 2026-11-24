//! Small pictures of images for the folder lists, shared by every window. Each is read once,
//! when its row first shows, and again only if its file changes.

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use gpui::{AppContext, Context, RenderImage};

use crate::picture::render_image;

/// Pixels on a thumbnail's longer side: twice the list's 28-point pictures, for Retina screens.
const SIZE: u32 = 64;

#[derive(Default)]
pub struct Thumbnails {
    /// Each file's thumbnail, with the modification time it was read at.
    ready: HashMap<PathBuf, (Option<SystemTime>, Arc<RenderImage>)>,
    loading: HashSet<PathBuf>,
    /// Files that couldn't be read, so they aren't tried on every frame.
    failed: HashSet<PathBuf>,
}

impl Thumbnails {
    /// The thumbnail of the file at `path`, starting to read it if it hasn't been, or if the
    /// file changed since.
    pub fn get(&mut self, path: &Path, cx: &mut Context<Self>) -> Option<Arc<RenderImage>> {
        let modified = fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok();
        let ready = self.ready.get(path).cloned();
        if let Some((read_at, thumbnail)) = &ready
            && *read_at == modified
        {
            return Some(thumbnail.clone());
        }
        if !self.loading.contains(path) && !self.failed.contains(path) {
            self.load(path.to_path_buf(), modified, cx);
        }
        // An older thumbnail is better than none while the new one is read.
        ready.map(|(_, thumbnail)| thumbnail)
    }

    fn load(&mut self, path: PathBuf, modified: Option<SystemTime>, cx: &mut Context<Self>) {
        self.loading.insert(path.clone());
        let read = cx.background_spawn({
            let path = path.clone();
            async move { imaging::codec::thumbnail(&path, SIZE).map(render_image) }
        });
        cx.spawn(async move |this, cx| {
            let thumbnail = read.await;
            this.update(cx, |this, cx| {
                this.loading.remove(&path);
                match thumbnail {
                    Ok(thumbnail) => {
                        this.ready.insert(path, (modified, thumbnail));
                    }
                    Err(_) => {
                        this.failed.insert(path);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}
