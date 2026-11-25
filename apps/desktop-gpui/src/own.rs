//! Files this Mac sent, linked under their own names beside the outbox (`own/<id>/<name>`, a hard
//! link of the kept bytes, never a copy), so a message draws its files from here: at once while
//! they go up, and under their blobs once they're up, without the network. The links go a day on.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// How long a sent file's link stays.
const KEEP: Duration = Duration::from_secs(24 * 3600);

/// Each blob sent from here, as the kept file it was: (id, name).
static UP: LazyLock<Mutex<HashMap<String, (String, String)>>> = LazyLock::new(Default::default);

fn dir() -> PathBuf {
    crate::outbox::dir().join("own")
}

fn named(name: &str) -> String {
    let n = name.replace(['/', '\\', ':'], "_");
    if n.is_empty() || n.starts_with('.') { format!("file{n}") } else { n }
}

/// Kept file `id` under its name, linked now if its bytes are kept; none while they aren't.
pub fn link(id: &str, name: &str) -> Option<PathBuf> {
    let at = dir().join(id.replace(['/', '\\'], "_")).join(named(name));
    if at.is_file() {
        return Some(at);
    }
    let from = crate::outbox::file_path(id);
    if !from.is_file() {
        return None;
    }
    std::fs::create_dir_all(at.parent()?).ok()?;
    std::fs::hard_link(&from, &at).or_else(|_| std::fs::copy(&from, &at).map(|_| ())).ok()?;
    Some(at)
}

/// Kept file `id` went up as `blob`: its link stays for the blob's message.
pub fn up(blob: &str, id: &str, name: &str) {
    let mut up = UP.lock().unwrap_or_else(|e| e.into_inner());
    if up.contains_key(blob) {
        return;
    }
    up.insert(blob.into(), (id.into(), name.into()));
    drop(up);
    link(id, name);
}

/// The kept file a blob was sent as from here: its id.
pub fn sent_as(blob: &str) -> Option<String> {
    UP.lock().unwrap_or_else(|e| e.into_inner()).get(blob).map(|(id, _)| id.clone())
}

/// A blob sent from here, as its file on this Mac while it's linked.
pub fn of_blob(blob: &str) -> Option<PathBuf> {
    let (id, name) = UP.lock().unwrap_or_else(|e| e.into_inner()).get(blob).cloned()?;
    let at = dir().join(id.replace(['/', '\\'], "_")).join(named(&name));
    at.is_file().then_some(at)
}

/// Whether a path is a sent file's link here.
pub fn holds(path: &str) -> bool {
    std::path::Path::new(path).starts_with(dir())
}

/// At launch, off the main thread: links older than a day go.
pub fn sweep() {
    std::thread::spawn(|| {
        let Ok(all) = std::fs::read_dir(dir()) else { return };
        for e in all.flatten() {
            let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > KEEP);
            if old {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    });
}
