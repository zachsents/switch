//! Files to and from the core's blobs, the desktop's `files.ts`: each dropped or pasted file is kept
//! on this Mac at once (outbox.rs) and uploads at once, so its chip shows how it's going and a send
//! waits on the uploads still out. A kept file uploads again from its bytes after a relaunch.
// The typed API the views use; parts not yet drawn are still the API.
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use crate::brain::{Attachment, hash_of};
use crate::outbox::{self, KeptFile};

/// A file's MIME type by its name, when it has none of its own (the brain's `typeOf`).
pub fn type_of(name: &str, given: &str) -> String {
    let plain = given.split(';').next().unwrap_or_default().trim();
    if !plain.is_empty() && plain != "application/octet-stream" {
        return plain.to_string();
    }
    let ext = name.rfind('.').map(|i| name[i + 1..].to_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "m4v" => "video/x-m4v",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "aac" => "audio/aac",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" => "text/html",
        "zip" => "application/zip",
        "stl" => "model/stl",
        "3mf" => "model/3mf",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "obj" => "model/obj",
        "usdz" => "model/vnd.usdz+zip",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// A file's size as the chat says it.
pub fn size_of(n: f64) -> String {
    if n < 1000. {
        format!("{n} B")
    } else if n < 1_000_000. {
        format!("{} KB", (n / 1000.).round())
    } else if n < 1_000_000_000. {
        format!("{:.1} MB", n / 1_000_000.)
    } else {
        format!("{:.1} GB", n / 1_000_000_000.)
    }
}

/// Where a file is served, under its name, the credential in the address (for a web view or the
/// system's player); `download` asks for it saved.
pub fn blob_url(core: &str, token: &str, a: &Attachment, download: bool) -> String {
    let mut url = url::Url::parse(&format!("{core}/blobs/{}", a.blob)).expect("core url");
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("type", &a.kind).append_pair("name", &a.name);
        if download {
            q.append_pair("download", "1");
        }
        q.append_pair("token", token);
    }
    url.to_string()
}

/// A Markdown image's address: a `/blobs/` path is the core's; its hash when it is one.
pub fn image_blob(src: &str) -> Option<String> {
    let rest = src.strip_prefix("/blobs/")?;
    hash_of(rest.split(['?', '#']).next().unwrap_or_default())
}

/// A file chosen for the box, before it's sent: its bytes kept under `id`.
#[derive(Clone, Debug, PartialEq)]
pub struct Chosen {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub size: f64,
}

impl Chosen {
    /// Where its bytes are kept, for an image chip's picture.
    pub fn path(&self) -> PathBuf {
        outbox::file_path(&self.id)
    }

    pub fn is_image(&self) -> bool {
        self.kind.starts_with("image/")
    }
}

/// Files still being kept (their bytes written beside the outbox off the main thread), by id:
/// what reads one waits until it's in.
fn keeping() -> &'static Mutex<HashMap<String, tokio::sync::watch::Receiver<bool>>> {
    base::kept! {
        static K: OnceLock<Mutex<HashMap<String, tokio::sync::watch::Receiver<bool>>>> = OnceLock::new();
    }
    K.get_or_init(Default::default)
}

/// Keeps a file's bytes under `id` on a thread of its own, written beside and moved in, so a
/// relaunch mid-way never finds half a file.
fn keep_later(id: &str, write: impl FnOnce(&std::path::Path) -> std::io::Result<()> + Send + 'static) {
    let (tx, rx) = tokio::sync::watch::channel(false);
    keeping().lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), rx);
    let (id, to) = (id.to_string(), outbox::file_path(id));
    std::thread::spawn(move || {
        if let Some(d) = to.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let part = to.with_extension("part");
        if write(&part).is_ok() {
            let _ = std::fs::rename(&part, &to);
        } else {
            let _ = std::fs::remove_file(&part);
        }
        keeping().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        let _ = tx.send(true);
    });
}

/// Copies files' bytes in, each `(id, from, to)`, one after another on a thread of its own, each
/// waited on as it's being kept (`kept`); `then` hears which didn't come in.
pub fn keep_all_later(jobs: Vec<(String, PathBuf, PathBuf)>, then: impl FnOnce(Vec<String>) + Send + 'static) {
    let senders: Vec<(String, tokio::sync::watch::Sender<bool>)> = jobs
        .iter()
        .map(|(id, _, _)| {
            let (tx, rx) = tokio::sync::watch::channel(false);
            keeping().lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), rx);
            (id.clone(), tx)
        })
        .collect();
    std::thread::spawn(move || {
        let mut failed = vec![];
        for ((id, from, to), (_, tx)) in jobs.into_iter().zip(senders) {
            if !to.is_file() {
                if let Some(d) = to.parent() {
                    let _ = std::fs::create_dir_all(d);
                }
                let part = to.with_extension("part");
                if std::fs::copy(&from, &part).and_then(|_| std::fs::rename(&part, &to)).is_err() {
                    let _ = std::fs::remove_file(&part);
                    log::warn!("cutover: a kept file didn't copy");
                    failed.push(id.clone());
                }
            }
            keeping().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            let _ = tx.send(true);
        }
        then(failed);
    });
}

/// Waits until file `id`'s bytes are kept, if they're being kept now.
pub async fn kept(id: &str) {
    let rx = keeping().lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned();
    if let Some(mut rx) = rx {
        let _ = rx.wait_for(|done| *done).await;
    }
}

/// Files as the box holds them, kept on this Mac as they come: (name, type as given, bytes).
pub fn choose(files: Vec<(String, String, Vec<u8>)>) -> Vec<Chosen> {
    files
        .into_iter()
        .map(|(name, given, bytes)| {
            let id = uuid::Uuid::new_v4().to_string();
            let kind = type_of(&name, &given);
            let size = bytes.len() as f64;
            keep_later(&id, move |to| std::fs::write(to, bytes));
            Chosen { id, name, kind, size }
        })
        .collect()
}

/// A file's type as the system names it by its extension (what a browser's `File.type` says).
pub fn system_type(name: &str) -> String {
    use objc2_foundation::NSString;
    use objc2_uniform_type_identifiers::UTType;
    let Some(ext) = name.rsplit_once('.').map(|(_, e)| e).filter(|e| !e.is_empty()) else { return String::new() };
    UTType::typeWithFilenameExtension(&NSString::from_str(ext)).and_then(|t| t.preferredMIMEType()).map(|m| m.to_string()).unwrap_or_default()
}

/// What a paste brings that the box takes as files, read from the pasteboard itself as a page's
/// `clipboardData.files` has it: a copied file (Finder's) as that file, and a picture's data (a
/// screenshot, one copied from a browser or Preview) as `image.png` and its kind, whatever words
/// come with it. gpui's own reading gives the words alone when there are any, and no TIFF.
pub fn pasted() -> Vec<Chosen> {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSString, NSURL};
    // The kinds a page takes a pasted picture as, best first; TIFF (the Mac's own) goes as PNG, as
    // WebKit hands it to a page.
    const PICTURES: [(&str, &str, &str); 5] = [
        ("public.png", "png", "image/png"),
        ("public.jpeg", "jpg", "image/jpeg"),
        ("com.compuserve.gif", "gif", "image/gif"),
        ("org.webmproject.webp", "webp", "image/webp"),
        ("public.heic", "heic", "image/heic"),
    ];
    let mut paths = vec![];
    let mut pictures = vec![];
    let items = NSPasteboard::generalPasteboard().pasteboardItems();
    for item in items.iter().flat_map(|a| a.iter()) {
        let types: Vec<String> = item.types().iter().map(|t| t.to_string()).collect();
        let has = |t: &str| types.iter().any(|x| x == t);
        if has("public.file-url") {
            let url = item.stringForType(&NSString::from_str("public.file-url"));
            if let Some(path) = url.and_then(|u| NSURL::URLWithString(&u)).and_then(|u| u.path()) {
                paths.push(PathBuf::from(path.to_string()));
            }
            continue;
        }
        let data = |t: &str| item.dataForType(&NSString::from_str(t)).map(|d| d.to_vec());
        if let Some((bytes, ext, kind)) = PICTURES.iter().find_map(|(t, ext, kind)| data(t).map(|b| (b, *ext, *kind))) {
            pictures.push((format!("image.{ext}"), kind.to_string(), bytes));
        } else if let Some(png) = data("public.tiff").and_then(|b| png_of(&b)) {
            pictures.push(("image.png".to_string(), "image/png".to_string(), png));
        }
    }
    let mut out = choose_paths(&paths);
    out.extend(choose(pictures));
    out
}

/// Whether the pasteboard holds words of its own (`text/plain`), not just files gpui would give as
/// their paths.
pub fn pasted_words() -> bool {
    use objc2_app_kit::NSPasteboard;
    NSPasteboard::generalPasteboard().types().is_some_and(|t| t.iter().any(|t| t.to_string() == "public.utf8-plain-text"))
}

/// A TIFF's picture as PNG.
fn png_of(tiff: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory_with_format(tiff, image::ImageFormat::Tiff).ok()?;
    let mut out = std::io::Cursor::new(vec![]);
    img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

/// Files dropped or picked from disk, as the box holds them: their size read now, their bytes
/// copied beside the outbox off the main thread (a clone on APFS), never read into memory.
pub fn choose_paths(paths: &[PathBuf]) -> Vec<Chosen> {
    paths
        .iter()
        .filter_map(|p| {
            let name = p.file_name()?.to_string_lossy().to_string();
            let size = std::fs::metadata(p).ok().filter(|m| m.is_file())?.len() as f64;
            let id = uuid::Uuid::new_v4().to_string();
            let kind = type_of(&name, &system_type(&name));
            let from = p.clone();
            keep_later(&id, move |to| std::fs::copy(&from, to).map(|_| ()));
            Some(Chosen { id, name, kind, size })
        })
        .collect()
}

/// How a chosen file's upload stands.
#[derive(Clone, Debug, PartialEq)]
pub enum Upload {
    Going,
    Up(Attachment),
    /// What went wrong; `refused` when the core won't take it however often it's tried.
    Failed { reason: String, refused: bool },
}

/// A chosen file as the outbox keeps it, up already if its upload here is done.
pub fn kept_of(c: &Chosen, uploads: &HashMap<String, Upload>) -> KeptFile {
    let blob = match uploads.get(&c.id) {
        Some(Upload::Up(a)) => Some(a.blob.clone()),
        _ => None,
    };
    KeptFile { id: c.id.clone(), name: c.name.clone(), kind: c.kind.clone(), size: c.size, blob }
}

/// A kept file as the box holds it again; none when its bytes are gone.
pub fn chosen_of(k: &KeptFile) -> Option<Chosen> {
    outbox::file_path(&k.id).exists().then(|| Chosen { id: k.id.clone(), name: k.name.clone(), kind: type_of(&k.name, &k.kind), size: k.size })
}

/// An upload the core won't take however often it's tried, or one that may go later.
#[derive(Debug)]
pub enum UploadError {
    Refused(String),
    Later(String),
}

impl UploadError {
    pub fn reason(&self) -> &str {
        match self {
            UploadError::Refused(r) | UploadError::Later(r) => r,
        }
    }
}

/// Uploads a kept file to the core's blobs, read from disk as it goes up.
pub async fn upload(http: &reqwest::Client, core: &str, token: &str, id: &str, name: &str, given: &str) -> Result<Attachment, UploadError> {
    kept(id).await;
    // A quiet copy uploads nothing; the file waits.
    if crate::outbox::quiet() {
        return Err(UploadError::Later("Quiet: not sent".into()));
    }
    let kind = type_of(name, given);
    let Ok(file) = tokio::fs::File::open(outbox::file_path(id)).await else { return Err(UploadError::Refused("File's gone".into())) };
    let size = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(file));
    let res = http
        .put(format!("{core}/blobs"))
        .bearer_auth(token)
        .header("content-type", kind.clone())
        .header("content-length", size)
        .body(body)
        .send()
        .await
        .map_err(|_| UploadError::Later("Can't reach the core".into()))?;
    let status = res.status().as_u16();
    let said: serde_json::Value = res.json().await.unwrap_or_default();
    let hash = said.get("hash").and_then(|h| h.as_str()).and_then(hash_of);
    match hash {
        Some(blob) if (200..300).contains(&status) => Ok(Attachment { blob, name: if name.is_empty() { "file".into() } else { name.into() }, kind, size: size as f64 }),
        _ => Err(match status {
            413 => UploadError::Refused("Too big".into()),
            507 => UploadError::Refused("Core's disk is full".into()),
            _ => UploadError::Later("Didn't upload".into()),
        }),
    }
}

/// A kept file uploaded from its bytes here.
pub async fn upload_kept(http: &reqwest::Client, core: &str, token: &str, k: &KeptFile) -> Result<Attachment, UploadError> {
    if let Some(blob) = k.blob.as_deref().and_then(hash_of) {
        return Ok(Attachment { blob, name: if k.name.is_empty() { "file".into() } else { k.name.clone() }, kind: type_of(&k.name, &k.kind), size: k.size });
    }
    upload(http, core, token, &k.id, &k.name, &k.kind).await
}
