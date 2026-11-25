//! A chat's files on this Mac (the desktop's `bun/files.ts`): fetched from the core into Downloads
//! (Open, Download, Show in Finder) or a cache (Quick Look), once each, never over a file already
//! there. Right-click gives them as a native menu. A 3D file opens in Preview, a 3MF as an STL of its
//! build, as Preview opens no 3MF.
//!
//! Views call `file` with what to do (a click's Open, a right-click's menu).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{LazyLock, Mutex};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use gpui::{App, Task, Window};
use sha2::{Digest, Sha256};

use super::helpers::home;
use super::quicklook;
use crate::net::Net;

/// What to do with a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Do {
    Open,
    Look,
    Show,
    Download,
    /// Choose which from its menu.
    Menu,
}

/// A file in a chat: where it's served (a core route like `/blobs/…`, or an address), its name, and
/// what to do with it. As an action, it's what a file's menu runs.
#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(namespace = switch, no_json)]
pub struct FileAsk {
    pub url: String,
    pub name: String,
    pub r#do: Do,
}

fn downloads() -> PathBuf {
    home().join("Downloads")
}

fn cache() -> PathBuf {
    std::env::temp_dir().join("switch-files")
}

fn hash36(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// `name` in `dir`, or `name 2`, `name 3`… when it's taken.
fn free(dir: &Path, name: &str) -> PathBuf {
    let p = Path::new(name);
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| name.to_string());
    let mut at = dir.join(name);
    let mut n = 1;
    while at.exists() {
        n += 1;
        at = dir.join(format!("{stem} {n}{ext}"));
    }
    at
}

fn plain(name: &str) -> String {
    let base = Path::new(name).file_name().map(|b| b.to_string_lossy().to_string()).unwrap_or_default();
    let trimmed = base.trim_start_matches('.');
    if trimmed.is_empty() { "file".into() } else { trimmed.to_string() }
}

/// A GET of a core route or an address, as it streams in; the core's with the credential in a header.
async fn get(net: &Net, url: &str) -> Option<reqwest::Response> {
    let auth = net.auth();
    let core = auth.as_ref().map(|a| a.core.clone()).unwrap_or_default();
    let full = if url.starts_with('/') { format!("{core}{url}") } else { url.to_string() };
    let mut req = net.client().get(&full);
    if let Some(a) = auth.filter(|a| full.starts_with(&a.core)) {
        req = req.bearer_auth(&a.token);
    }
    let res = req.send().await.ok()?;
    res.status().is_success().then_some(res)
}

type Fetch = Shared<BoxFuture<'static, Result<PathBuf, String>>>;

/// Where each file went, and each fetch under way, by folder and address.
static SAVED: LazyLock<Mutex<HashMap<String, PathBuf>>> = LazyLock::new(Default::default);
static FETCHING: LazyLock<Mutex<HashMap<String, Fetch>>> = LazyLock::new(Default::default);

/// Fetched into `dir` once; the same file asked again is where it went, or, while it's still coming,
/// the fetch under way: a model of 100 MB can take minutes, and each click again is the same one.
fn fetch_to(net: &Net, url: &str, name: &str, dir: PathBuf) -> Fetch {
    let key = format!("{}\n{url}", dir.display());
    if let Some(had) = SAVED.lock().ok().and_then(|s| s.get(&key).cloned())
        && had.exists()
    {
        return futures::future::ready(Ok(had)).boxed().shared();
    }
    if let Some(coming) = FETCHING.lock().ok().and_then(|f| f.get(&key).cloned()) {
        return coming;
    }
    let (net, url, name, k) = (net.clone(), url.to_string(), name.to_string(), key.clone());
    let job = net.rt.clone().spawn(async move {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut res = get(&net, &url).await.ok_or_else(|| format!("Can't fetch {name}"))?;
        let at = if dir == cache() {
            let sub = dir.join(hash36(&url));
            std::fs::create_dir_all(&sub).map_err(|e| e.to_string())?;
            sub.join(plain(&name))
        } else {
            free(&dir, &plain(&name))
        };
        // Written beside itself and moved in whole, so no half a file is ever opened or kept.
        let part = PathBuf::from(format!("{}.part", at.display()));
        let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
            std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
        }
        drop(file);
        std::fs::rename(&part, &at).map_err(|e| e.to_string())?;
        Ok::<_, String>(at)
    });
    let fetched = async move {
        let got = job.await.unwrap_or_else(|e| Err(e.to_string()));
        if let Ok(at) = &got
            && let Ok(mut s) = SAVED.lock()
        {
            s.insert(k.clone(), at.clone());
        }
        if let Ok(mut f) = FETCHING.lock() {
            f.remove(&k);
        }
        got
    }
    .boxed()
    .shared();
    if let Ok(mut f) = FETCHING.lock() {
        f.insert(key, fetched.clone());
    }
    fetched
}

/// What Preview opens of 3D files (tried on macOS 26: STL and OBJ, not 3MF).
const PREVIEW_OPENS: [&str; 2] = ["stl", "obj"];

fn open_path(at: &Path, url: &str) {
    let ext = at.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if ext == "3mf"
        && let Ok(bytes) = std::fs::read(at)
        && let Some(stl) = super::mesh::three_mf_to_stl(&bytes)
    {
        let stem = at.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let dir = cache().join(hash36(url));
        let out = dir.join(format!("{stem}.stl"));
        if std::fs::create_dir_all(&dir).is_ok() && std::fs::write(&out, stl).is_ok() {
            let _ = Command::new("/usr/bin/open").args(["-a", "Preview"]).arg(&out).spawn();
            return;
        }
    }
    if PREVIEW_OPENS.contains(&ext.as_str()) {
        let _ = Command::new("/usr/bin/open").args(["-a", "Preview"]).arg(at).spawn();
    } else {
        let _ = Command::new("/usr/bin/open").arg(at).spawn();
    }
}

/// Runs a file's ask; true once it's done (an Open, once the file is fetched and opened), false when
/// it couldn't be. A menu shows at the pointer in `window`, natively; what's chosen from it runs as
/// the same ask.
pub fn file(ask: FileAsk, window: &mut Window, cx: &mut App) -> Task<bool> {
    if ask.r#do == Do::Menu {
        let with = |label: &str, d: Do| gpui::MenuItem::action(label.to_string(), FileAsk { r#do: d, ..ask.clone() });
        crate::native_menu::popup(vec![with("Open", Do::Open), with("Quick Look", Do::Look), with("Show in Finder", Do::Show), with("Download", Do::Download)], window, cx);
        return Task::ready(true);
    }
    act(ask, cx)
}

/// What a file's menu chose.
pub fn init(cx: &mut App) {
    cx.on_action(|ask: &FileAsk, cx| act(ask.clone(), cx).detach());
}

/// Runs a file's ask that needs no window (all but its menu).
pub fn act(ask: FileAsk, cx: &mut App) -> Task<bool> {
    let net = cx.global::<Net>().clone();
    let url = ask.url.clone();
    match ask.r#do {
        Do::Menu => Task::ready(false),
        Do::Look => {
            let f = fetch_to(&net, &url, &ask.name, cache());
            cx.spawn(async move |_| match f.await {
                Ok(at) => quicklook::show(&[at], 0).map_err(|e| log::warn!("File {}: {e}", ask.name)).is_ok(),
                Err(e) => {
                    log::warn!("File {}: {e}", ask.name);
                    false
                }
            })
        }
        d => {
            let f = fetch_to(&net, &url, &ask.name, downloads());
            cx.spawn(async move |cx| match f.await {
                Ok(at) => {
                    match d {
                        Do::Open => open_path(&at, &url),
                        Do::Show => {
                            let _ = cx.update(|cx| cx.reveal_path(&at));
                        }
                        _ => {}
                    }
                    true
                }
                Err(e) => {
                    log::warn!("File {}: {e}", ask.name);
                    false
                }
            })
        }
    }
}
