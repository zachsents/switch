use std::{fs, io, path::PathBuf};

use gpui::App;
use serde::{Serialize, de::DeserializeOwned};

use crate::AppInfo;

/// The suite's folder inside the platform data directory.
const SUITE: &str = "plain";

/// Where an app keeps its files: `~/Library/Application Support/plain/<app id>` on macOS.
pub(crate) fn dir(app: AppInfo) -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(SUITE)
        .join(app.id)
}

/// The app's own folder for files it keeps, like `~/Library/Application Support/plain/images`.
/// It may not exist yet.
pub fn data_dir(cx: &App) -> PathBuf {
    dir(*cx.global::<AppInfo>())
}

fn path(app: AppInfo, name: &str) -> PathBuf {
    dir(app).join(format!("{name}.json"))
}

/// Loads a value the app saved under `name`. Returns `None` if nothing was saved yet, or if the
/// file can't be read, which is logged.
pub fn load<T: DeserializeOwned>(cx: &App, name: &str) -> Option<T> {
    let path = path(*cx.global::<AppInfo>(), name);
    let data = fs::read(&path).ok()?;
    serde_json::from_slice(&data)
        .inspect_err(|error| eprintln!("ignoring unreadable {}: {error}", path.display()))
        .ok()
}

/// Saves a value under `name`, replacing the file atomically so a crash never leaves it half
/// written. Failures are logged; the app keeps running on its in-memory state.
pub fn save<T: Serialize>(cx: &App, name: &str, value: &T) {
    let path = path(*cx.global::<AppInfo>(), name);
    let write = || -> io::Result<()> {
        fs::create_dir_all(path.parent().expect("app data paths have a parent"))?;
        let temporary = path.with_extension("json.tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(value)?)?;
        fs::rename(temporary, &path)
    };
    if let Err(error) = write() {
        eprintln!("failed to save {}: {error}", path.display());
    }
}
