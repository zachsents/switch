//! A chat's files on this Mac (the desktop's `bun/files.ts`): fetched from the core into Downloads
//! (Open, Download, Show in Finder) or a cache (Quick Look, Copy, Share), once each, never over a
//! file already there, named with the extension their bytes call for. Right-click gives them as a
//! native menu. A 3D file opens in Preview, a 3MF as an STL of its build, as Preview opens no 3MF.
//!
//! Views call `file` with what to do (a click's Open, a right-click's menu).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use gpui::{App, Task, Window};
use sha2::{Digest, Sha256};

use super::helpers::home;
use super::{pasteboard, quicklook};
use crate::net::Net;

/// What to do with a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Do {
    Open,
    Look,
    Show,
    Download,
    /// To the pasteboard: a picture as itself, any other file as the file.
    Copy,
    /// The share picker, at the pointer.
    Share,
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

/// Extensions that name one type, the first its usual one.
const SAME: [&[&str]; 9] = [
    &["jpg", "jpeg", "jpe", "jfif"],
    &["tiff", "tif"],
    &["heic", "heif", "heics"],
    // ISO media: which of them a file is, beyond that, is its name's to say.
    &["mp4", "m4v", "mov", "m4a", "3gp", "qt"],
    &["html", "htm"],
    &["mpg", "mpeg"],
    &["yaml", "yml"],
    &["md", "markdown"],
    &["txt", "text"],
];

/// Extensions of a type of their own, which a file of another type is renamed from.
const KNOWN: [&str; 13] = ["png", "gif", "webp", "avif", "bmp", "svg", "webm", "mp3", "wav", "pdf", "json", "csv", "stl"];

/// What a MIME type's file ends in.
fn ext_of_mime(mime: &str) -> Option<&'static str> {
    let m = mime.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    Some(match m.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" | "image/pjpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/heic" | "image/heic-sequence" => "heic",
        "image/heif" | "image/heif-sequence" => "heif",
        "image/avif" => "avif",
        "image/tiff" => "tiff",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "audio/mpeg" => "mp3",
        "audio/mp4" | "audio/x-m4a" => "m4a",
        "audio/wav" | "audio/x-wav" => "wav",
        "application/pdf" => "pdf",
        "application/zip" => "zip",
        "application/json" => "json",
        "text/plain" => "txt",
        "text/markdown" => "md",
        "text/html" => "html",
        "text/csv" => "csv",
        "model/stl" => "stl",
        "model/3mf" => "3mf",
        _ => return None,
    })
}

/// What a file's first bytes say it is, when they say.
fn sniffed(head: &[u8]) -> Option<&'static str> {
    let at = |i: usize, sig: &[u8]| head.get(i..i + sig.len()) == Some(sig);
    if at(0, b"\x89PNG\r\n\x1a\n") {
        return Some("png");
    }
    if at(0, &[0xff, 0xd8, 0xff]) {
        return Some("jpg");
    }
    if at(0, b"GIF87a") || at(0, b"GIF89a") {
        return Some("gif");
    }
    if at(0, b"RIFF") && at(8, b"WEBP") {
        return Some("webp");
    }
    if at(0, b"RIFF") && at(8, b"WAVE") {
        return Some("wav");
    }
    if at(0, b"%PDF-") {
        return Some("pdf");
    }
    if at(0, b"II*\0") || at(0, b"MM\0*") {
        return Some("tiff");
    }
    if at(0, &[0x1a, 0x45, 0xdf, 0xa3]) {
        return Some("webm");
    }
    if at(0, b"PK\x03\x04") {
        return Some("zip");
    }
    if at(4, b"ftyp") {
        return Some(match head.get(8..12)? {
            b"heic" | b"heix" | b"heim" | b"heis" | b"hevc" | b"hevx" | b"mif1" | b"msf1" => "heic",
            b"avif" | b"avis" => "avif",
            b"qt  " => "mov",
            b"M4A " => "m4a",
            _ => "mp4",
        });
    }
    None
}

/// `name` with the extension its file calls for: kept when it has it already, or another name for
/// it, or when its bytes are only a zip (a 3MF or a document is one underneath); one that names
/// another type replaced; else added. With nothing to go on, it stays as it is.
fn named(name: &str, ext: Option<&str>) -> String {
    let Some(ext) = ext else { return name.to_string() };
    let p = Path::new(name);
    let Some(had) = p.extension().map(|e| e.to_string_lossy().to_lowercase()) else { return format!("{name}.{ext}") };
    let usual = |e: &str| SAME.iter().find(|g| g.contains(&e)).map_or(e.to_string(), |g| g[0].to_string());
    if usual(&had) == usual(ext) || ext == "zip" {
        return name.to_string();
    }
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let typed = KNOWN.contains(&had.as_str()) || SAME.iter().any(|g| g.contains(&had.as_str()));
    if typed { format!("{stem}.{ext}") } else { format!("{name}.{ext}") }
}

/// The type a file's address asks for (`?type=`), as the core's blobs carry it.
fn asked_type(url: &str) -> Option<String> {
    url::Url::parse(url)
        .or_else(|_| url::Url::parse(&format!("http://x{url}")))
        .ok()
        .and_then(|u| u.query_pairs().find(|(k, _)| k == "type").map(|(_, v)| v.to_string()))
}

/// The extension a fetched file calls for: its bytes' first, then the type its address asks for,
/// then the one it was served as.
fn ext_for(head: &[u8], url: &str, served: Option<&str>) -> Option<&'static str> {
    sniffed(head).or_else(|| asked_type(url).as_deref().and_then(ext_of_mime)).or_else(|| served.and_then(ext_of_mime))
}

/// Whether a file is a picture, as far as its address and name tell before it's fetched.
fn looks_like_picture(url: &str, name: &str) -> bool {
    if let Some(t) = asked_type(url) {
        return t.starts_with("image/");
    }
    let ext = Path::new(name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "avif", "tiff", "tif", "bmp"].contains(&ext.as_str())
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

base::kept! {
    /// Where each file went, and each fetch under way, by folder and address.
    static SAVED: Mutex<HashMap<String, PathBuf>> = Mutex::default();
    static FETCHING: Mutex<HashMap<String, Fetch>> = Mutex::default();
}

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
        let served = res.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_string);
        // Enough of it to tell what it is, before it's named.
        let mut head = vec![];
        while head.len() < 32
            && let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())?
        {
            head.extend_from_slice(&chunk);
        }
        let called = named(&plain(&name), ext_for(&head, &url, served.as_deref()));
        let at = if dir == cache() {
            let sub = dir.join(hash36(&url));
            std::fs::create_dir_all(&sub).map_err(|e| e.to_string())?;
            sub.join(&called)
        } else {
            free(&dir, &called)
        };
        // Written beside itself and moved in whole, so no half a file is ever opened or kept.
        let part = PathBuf::from(format!("{}.part", at.display()));
        let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut file, &head).map_err(|e| e.to_string())?;
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
        let copy = if looks_like_picture(&ask.url, &ask.name) { "Copy Image" } else { "Copy" };
        let mut items = vec![with("Open", Do::Open), with("Quick Look", Do::Look), gpui::MenuItem::separator(), with(copy, Do::Copy), with("Download", Do::Download)];
        // Once it's on this Mac: before, there's nothing in Finder to show.
        if downloaded(&ask.url).is_some() {
            items.push(with("Show in Finder", Do::Show));
        }
        items.extend([gpui::MenuItem::separator(), with("Share…", Do::Share)]);
        crate::native_menu::popup(items, window, cx);
        return Task::ready(true);
    }
    act(ask, cx)
}

/// Where a file went in Downloads, while it's still there.
fn downloaded(url: &str) -> Option<PathBuf> {
    let key = format!("{}\n{url}", downloads().display());
    SAVED.lock().ok().and_then(|s| s.get(&key).cloned()).filter(|p| p.exists())
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
        Do::Look | Do::Copy | Do::Share => {
            let f = fetch_to(&net, &url, &ask.name, cache());
            // The picker shows where the pointer is now, by the menu it was chosen from.
            let pointer = if ask.r#do == Do::Share { pasteboard::pointer() } else { None };
            cx.spawn(async move |cx| match f.await {
                Ok(at) => match ask.r#do {
                    Do::Copy => cx.update(|_| pasteboard::copy(&at)),
                    Do::Share => cx.update(|_| pasteboard::share(&at, pointer)),
                    _ => quicklook::show(&[at], 0).map_err(|e| log::warn!("File {}: {e}", ask.name)).is_ok(),
                },
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
