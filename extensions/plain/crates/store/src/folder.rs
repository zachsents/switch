//! Sharing changes through a folder that a file-syncing service keeps the same on every device.
//! Each device writes only files of its own there, one change per line, and only ever adds to
//! them, so syncing never has two versions of a file to reconcile.
//!
//! iCloud Drive may keep only a placeholder of a file on a device short of space, downloading it
//! when it's read. A device never adds to its own file once that has happened: it starts the
//! next one (`<device>.jsonl`, `<device>.2.jsonl`, ...), so writing never waits on a download.
//! Reading the other devices' files may wait, which is why this all runs off the main thread.

use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::macos::fs::MetadataExt,
    path::{Path, PathBuf},
};

use crate::Change;

/// The flag a placeholder of a file whose contents are only in the cloud has (`SF_DATALESS`).
const DATALESS: u32 = 0x4000_0000;

/// The folder an app's devices share changes through: one named for the app in the suite's
/// folder in iCloud Drive, or in `$PLAIN_SYNC_DIR` when that's set. None without iCloud Drive.
pub fn sync_folder(app_name: &str) -> Option<PathBuf> {
    if let Some(folder) = std::env::var_os("PLAIN_SYNC_DIR") {
        return Some(PathBuf::from(folder).join(app_name));
    }
    let drive = dirs::home_dir()?.join("Library/Mobile Documents/com~apple~CloudDocs");
    drive.is_dir().then(|| drive.join("Plain").join(app_name))
}

/// Gets this process ready to share through `folder`: creates it, asks iCloud Drive to keep its
/// files downloaded, and lets the process download files iCloud keeps only a placeholder of,
/// which processes started for agents may not be allowed to do.
pub fn prepare(folder: &Path) -> Result<(), String> {
    fs::create_dir_all(folder).map_err(|error| error.to_string())?;
    allow_downloads();
    keep_downloaded(folder);
    Ok(())
}

unsafe extern "C" {
    fn setiopolicy_np(iotype: i32, scope: i32, policy: i32) -> i32;
    fn setxattr(
        path: *const std::ffi::c_char,
        name: *const std::ffi::c_char,
        value: *const std::ffi::c_void,
        size: usize,
        position: u32,
        options: i32,
    ) -> i32;
}

/// Lets this process read files iCloud Drive keeps only a placeholder of, downloading them
/// (`IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES`, `IOPOL_SCOPE_PROCESS`, `..._ON`). Without it,
/// reading one fails with "Resource deadlock avoided".
fn allow_downloads() {
    // SAFETY: setiopolicy_np takes plain integers and only changes this process's I/O policy.
    unsafe { setiopolicy_np(3, 0, 2) };
}

/// Marks `folder` the way Finder's Keep Downloaded does, so iCloud Drive keeps what's in it on
/// this device. There's no API for it, so this may not take; reading then waits for downloads.
fn keep_downloaded(folder: &Path) {
    let Ok(path) = std::ffi::CString::new(folder.as_os_str().as_encoded_bytes()) else {
        return;
    };
    let name = c"com.apple.fileprovider.pinned#PX";
    let value = b"1";
    // SAFETY: both strings are NUL-terminated and outlive the call; the value is 1 byte.
    unsafe { setxattr(path.as_ptr(), name.as_ptr(), value.as_ptr().cast(), 1, 0, 0) };
}

/// This device's files in `folder`, in the order they were started: `<device>.jsonl`, then
/// `<device>.2.jsonl` and so on.
fn own_files(folder: &Path, device: &str) -> Vec<(u32, PathBuf)> {
    let mut files: Vec<(u32, PathBuf)> = fs::read_dir(folder)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let rest = name.strip_prefix(device)?.strip_suffix(".jsonl")?;
            let number = match rest {
                "" => 1,
                rest => rest.strip_prefix('.')?.parse().ok()?,
            };
            Some((number, entry.path()))
        })
        .collect();
    files.sort();
    files
}

/// Adds changes this device made to its newest file, or to a new one if iCloud Drive has made
/// the newest a placeholder.
pub fn export(folder: &Path, device: &str, changes: &[Change]) -> Result<(), String> {
    if changes.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(folder).map_err(|error| error.to_string())?;
    let files = own_files(folder, device);
    let newest = files.last();
    let usable = newest.filter(|(_, path)| {
        fs::metadata(path).is_ok_and(|metadata| metadata.st_flags() & DATALESS == 0)
    });
    let path = match (usable, newest) {
        (Some((_, path)), _) => path.clone(),
        (None, Some((number, _))) => folder.join(format!("{device}.{}.jsonl", number + 1)),
        (None, None) => folder.join(format!("{device}.jsonl")),
    };
    let lines: String = changes
        .iter()
        .map(|change| serde_json::to_string(change).expect("changes are plain JSON") + "\n")
        .collect();
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| file.write_all(lines.as_bytes()))
        .map_err(|error| format!("{}: {error}", path.display()))
}

/// What was read from another device's file.
#[derive(Debug)]
pub struct PeerRead {
    /// The file's name.
    pub file: String,
    /// How far the file has been read, in bytes.
    pub position: u64,
    pub changes: Vec<Change>,
}

/// Reads what the other devices added to their files since `positions`, which this device's
/// store keeps (`Store::read_positions`). Only whole lines are read, so a file that's still
/// arriving is read the rest of the way next time, and a file that got shorter was replaced, so
/// it's read again from the start. Reading a file iCloud Drive keeps only a placeholder of waits
/// for it to download, so call this off the main thread.
pub fn read_peers(folder: &Path, device: &str, positions: &BTreeMap<String, u64>) -> Vec<PeerRead> {
    let own = format!("{device}.");
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let file = entry.file_name().to_string_lossy().into_owned();
            if file.starts_with(&own) || !file.ends_with(".jsonl") || file.starts_with('.') {
                return None;
            }
            let length = entry.metadata().ok()?.len();
            let read = positions.get(&file).copied().unwrap_or(0);
            let start = if length < read { 0 } else { read };
            if length == start {
                return None;
            }
            let mut bytes = Vec::new();
            let mut handle = fs::File::open(entry.path()).ok()?;
            handle.seek(SeekFrom::Start(start)).ok()?;
            handle.take(length - start).read_to_end(&mut bytes).ok()?;
            let whole = bytes.iter().rposition(|&byte| byte == b'\n')? + 1;
            let changes = String::from_utf8_lossy(&bytes[..whole])
                .lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect();
            Some(PeerRead {
                file,
                position: start + whole as u64,
                changes,
            })
        })
        .collect()
}
