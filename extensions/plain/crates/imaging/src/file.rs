//! Writing image files without ever leaving one half-written or overwriting one by accident.

use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};

use objc2::rc::autoreleasepool;
use objc2_foundation::{
    NSFileManager, NSFileManagerItemReplacementOptions, NSSearchPathDirectory,
    NSSearchPathDomainMask, NSURL,
};

/// Replaces the file at `path` with `bytes` in one step, the way macOS apps save documents, so
/// it's never left half-written. The file keeps its creation date, permissions and Finder tags.
pub fn replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let failed = |error: &dyn std::fmt::Display| format!("Couldn't save {}: {error}", name(path));
    autoreleasepool(|_| {
        let manager = NSFileManager::defaultManager();
        let original = NSURL::from_file_path(path).ok_or_else(|| failed(&"it isn't a file"))?;
        // A folder on the same disk, so the new file can be moved into place.
        let folder = manager
            .URLForDirectory_inDomain_appropriateForURL_create_error(
                NSSearchPathDirectory::ItemReplacementDirectory,
                NSSearchPathDomainMask::UserDomainMask,
                Some(&original),
                true,
            )
            .map_err(|error| failed(&error.localizedDescription()))?;
        let folder_path = folder
            .to_file_path()
            .ok_or_else(|| failed(&"there's no room to write it"))?;
        let written = folder_path.join(name(path));
        let result = fs::write(&written, bytes)
            .map_err(|error| failed(&error))
            .and_then(|()| {
                let new = NSURL::from_file_path(&written)
                    .ok_or_else(|| failed(&"there's no room to write it"))?;
                manager
                    .replaceItemAtURL_withItemAtURL_backupItemName_options_resultingItemURL_error(
                        &original,
                        &new,
                        None,
                        NSFileManagerItemReplacementOptions::empty(),
                        None,
                    )
                    .map_err(|error| failed(&error.localizedDescription()))
            });
        fs::remove_dir_all(&folder_path).ok();
        result
    })
}

/// Writes `bytes` in `folder` as "<stem>.<extension>", or "<stem> 2.<extension>" and so on if
/// that's taken, the way Finder names copies. Never replaces an existing file. Returns the
/// path written.
pub fn write_new(
    folder: &Path,
    stem: &str,
    extension: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    for number in 1.. {
        let file_name = match number {
            1 => format!("{stem}.{extension}"),
            number => format!("{stem} {number}.{extension}"),
        };
        let path = folder.join(file_name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                return match file.write_all(bytes) {
                    Ok(()) => Ok(path),
                    Err(error) => Err(format!("Couldn't write {}: {error}", name(&path))),
                };
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Couldn't write {}: {error}", name(&path))),
        }
    }
    unreachable!("some number is free")
}

fn name(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    )
}
