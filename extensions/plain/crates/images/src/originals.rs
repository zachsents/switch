//! Originals of files saved over. Saving writes edits into a person's file, so the first save
//! keeps a copy of the file as it was, and Revert to Original puts it back. Later saves keep the
//! first copy, so the original is never lost however many times a file is saved.

use std::{
    fs,
    path::{Path, PathBuf},
};

/// Where originals are kept: one file each, named for the path they came from.
#[derive(Clone)]
pub struct Originals {
    folder: PathBuf,
}

impl Originals {
    pub fn new(folder: PathBuf) -> Self {
        Self { folder }
    }

    /// Where the original of the file at `path` is kept. Named by a hash of the path, so the
    /// same file always finds its original, plus the file's name to tell them apart by eye.
    fn kept(&self, path: &Path) -> PathBuf {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.folder.join(format!(
            "{:016x} {name}",
            fnv1a(path.to_string_lossy().as_bytes())
        ))
    }

    /// Whether there's an original to go back to.
    pub fn has(&self, path: &Path) -> bool {
        self.kept(path).is_file()
    }

    /// Keeps a copy of the file at `path`, unless one is already kept.
    pub fn keep(&self, path: &Path) -> Result<(), String> {
        let kept = self.kept(path);
        if kept.is_file() {
            return Ok(());
        }
        fs::create_dir_all(&self.folder)
            .and_then(|()| fs::copy(path, &kept))
            .map(|_| ())
            .map_err(|error| format!("Couldn't keep the original, so nothing was saved: {error}"))
    }

    /// Puts the original back over the file at `path`. It's no longer kept afterwards, since
    /// the file is the original again.
    pub fn restore(&self, path: &Path) -> Result<(), String> {
        let kept = self.kept(path);
        let original =
            fs::read(&kept).map_err(|_| "There's no original kept for this image".to_string())?;
        imaging::file::replace(path, &original)?;
        fs::remove_file(kept).ok();
        Ok(())
    }
}

/// A stable 64-bit hash, so originals are found again by later versions of the app.
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, &byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    })
}
