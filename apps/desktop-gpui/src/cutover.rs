//! The Electrobun app's outbox, carried over on this app's first launch: what it kept in its
//! webview's localStorage (`switch.outbox`: commands not yet answered, Not sent messages, held
//! Undos, each box's draft and reply rows) and the files' bytes it kept in IndexedDB
//! (`switch.outbox`'s `files` store, by file id). They're read from the installed app's own WebKit
//! store (by the identifier `/Applications/Switchboard.app` names) for the view's origin
//! (`http://127.0.0.1:4879`), each copied aside first so the live app's files are only ever
//! read, and merged into this app's outbox: an entry or a draft this app already has stays as it is.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// Where the live app is installed. At cutover the Rust app is installed there in its place, and
/// that copy alone carries over what Electrobun kept. `$SWITCH_GPUI_CUTOVER_APP` stands another
/// path in for it (checking the cutover on a Mac with its own live app).
fn live_app() -> PathBuf {
    std::env::var("SWITCH_GPUI_CUTOVER_APP").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/Applications/Switchboard.app"))
}

/// Whether this copy is the one installed as the live app: a side-by-side build, a test build or
/// a quiet copy never is.
pub fn is_live() -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).ok();
    !crate::outbox::quiet() && crate::platform::helpers::bundle().and_then(|b| canon(&b)).is_some_and(|b| Some(b) == canon(&live_app()))
}

/// The live app's identifier: its `version.json`'s, else its Info.plist's CFBundleIdentifier.
pub fn identifier() -> Option<String> {
    let app = live_app().join("Contents");
    let said = std::fs::read(app.join("Resources/version.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    if let Some(id) = said.as_ref().and_then(|v| v.get("identifier")).and_then(Value::as_str).filter(|s| !s.is_empty()) {
        return Some(id.to_string());
    }
    let plist = std::fs::read_to_string(app.join("Info.plist")).ok()?;
    let after = &plist[plist.find("<key>CFBundleIdentifier</key>")?..];
    let start = after.find("<string>")? + "<string>".len();
    let end = after[start..].find("</string>")? + start;
    Some(after[start..end].trim().to_string()).filter(|s| !s.is_empty())
}

/// Whether an app with bundle id `id` runs, besides this one: Electrobun still open (its held
/// answers may yet be undone there).
fn running(id: &str) -> bool {
    use objc2_app_kit::NSRunningApplication;
    use objc2_foundation::NSString;
    let me = NSRunningApplication::currentApplication();
    let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(id));
    apps.iter().any(|a| *a != *me)
}

/// What WebKit's `origin` file says: scheme, host, port (twice: the top frame's and the frame's).
fn origin_of(path: &Path) -> Option<(String, String, Option<u16>)> {
    let b = std::fs::read(path).ok()?;
    let mut at = 0;
    let mut string = |b: &[u8]| -> Option<String> {
        let len = u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?) as usize;
        let latin = *b.get(at + 4)? == 1;
        at += 5;
        let s = if latin {
            let s = b.get(at..at + len)?.iter().map(|&c| c as char).collect();
            at += len;
            s
        } else {
            let u: Vec<u16> = b.get(at..at + len * 2)?.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            at += len * 2;
            String::from_utf16_lossy(&u)
        };
        Some(s)
    };
    let scheme = string(&b)?;
    let host = string(&b)?;
    let port = match b.get(at) {
        Some(1) => Some(u16::from_le_bytes([*b.get(at + 1)?, *b.get(at + 2)?])),
        _ => None,
    };
    Some((scheme, host, port))
}

/// Each origin folder of an app's WebKit data that served a view from this Mac's loopback over
/// http (the port is whatever the app had, 4879 unless it was taken): a named store's
/// (`WebsiteDataStore/<id>/Origins/<top>/<frame>`) or the default one's
/// (`WebsiteData/Default/<top>/<frame>`).
fn view_origins(bundle: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    let mut roots: Vec<PathBuf> = std::fs::read_dir(bundle.join("WebsiteDataStore")).into_iter().flatten().flatten().map(|s| s.path().join("Origins")).collect();
    roots.push(bundle.join("WebsiteData/Default"));
    for root in roots {
        let Ok(tops) = std::fs::read_dir(root) else { continue };
        for top in tops.flatten() {
            let Ok(frames) = std::fs::read_dir(top.path()) else { continue };
            for frame in frames.flatten() {
                let o = frame.path().join("origin");
                if origin_of(&o).is_some_and(|(s, h, p)| s == "http" && h == "127.0.0.1" && p.is_some()) {
                    out.push(frame.path());
                }
            }
        }
    }
    out
}

/// The live app's view: of its origins that kept an outbox, the one written last.
fn find(bundle: &Path) -> Option<PathBuf> {
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = view_origins(bundle)
        .into_iter()
        .filter_map(|o| {
            let db = o.join("LocalStorage/localstorage.sqlite3");
            let when = std::fs::metadata(&db).and_then(|m| m.modified()).ok()?;
            matches!(local_storage(&o, "switch.outbox"), Ok(Some(_))).then_some((when, o))
        })
        .collect();
    found.sort();
    found.pop().map(|(_, o)| o)
}

/// An SQLite database copied aside (with its write-ahead log), opened read-only.
fn open_copy(db: &Path, aside: &Path) -> Option<rusqlite::Connection> {
    let go = || -> Result<rusqlite::Connection, String> {
        std::fs::create_dir_all(aside).map_err(|e| e.to_string())?;
        let name = db.file_name().ok_or("no name")?.to_string_lossy().to_string();
        for ext in ["", "-wal", "-shm"] {
            let from = db.with_file_name(format!("{name}{ext}"));
            if from.exists() {
                std::fs::copy(&from, aside.join(format!("{name}{ext}"))).map_err(|e| e.to_string())?;
            }
        }
        let c = rusqlite::Connection::open_with_flags(aside.join(&name), rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|e| e.to_string())?;
        // WebKit's IndexedDB keys sort with a collation of its own; a byte order reads them.
        c.create_collation("IDBKEY", |a: &str, b: &str| a.as_bytes().cmp(b.as_bytes())).map_err(|e| e.to_string())?;
        Ok(c)
    };
    go().map_err(|e| log::warn!("cutover: {} didn't open: {e}", db.display())).ok()
}

fn aside() -> PathBuf {
    std::env::temp_dir().join(format!("switch-gpui-cutover-{}", std::process::id()))
}

/// A localStorage value of the view's (UTF-16 as WebKit keeps it).
fn local_storage(origin: &Path, key: &str) -> Result<Option<String>, ()> {
    let dir = aside().join("ls");
    let c = open_copy(&origin.join("LocalStorage/localstorage.sqlite3"), &dir).ok_or(())?;
    let got = c.query_row("SELECT CAST(value AS BLOB) FROM ItemTable WHERE key = ?1", [key], |r| r.get::<_, Vec<u8>>(0));
    drop(c);
    let _ = std::fs::remove_dir_all(&dir);
    match got {
        Ok(raw) => {
            let u: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            Ok(Some(String::from_utf16_lossy(&u)))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => {
            log::warn!("cutover: {key} didn't read: {e}");
            Err(())
        }
    }
}

/// A string IndexedDB key as WebKit serializes it: a header, its length, its UTF-16 code units.
fn key_string(key: &[u8]) -> Option<String> {
    (0..key.len().min(12)).find_map(|at| {
        let len = u32::from_le_bytes(key.get(at..at + 4)?.try_into().ok()?) as usize;
        let rest = key.get(at + 4..)?;
        (len > 0 && rest.len() == len * 2).then(|| String::from_utf16_lossy(&rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>()))
    })
}

/// The files' bytes the view kept, by file id: where each is in WebKit's blob folder.
fn kept_files(origin: &Path) -> Vec<(String, PathBuf)> {
    let Ok(dbs) = std::fs::read_dir(origin.join("IndexedDB")) else { return vec![] };
    let mut out = vec![];
    for db in dbs.flatten() {
        let file = db.path().join("IndexedDB.sqlite3");
        let dir = aside().join(db.file_name());
        let Some(c) = open_copy(&file, &dir) else { continue };
        // Its name, as WebKit keeps it: UTF-16.
        let named: Vec<u8> = c.query_row("SELECT CAST(value AS BLOB) FROM IDBDatabaseInfo WHERE key = 'DatabaseName'", [], |r| r.get(0)).unwrap_or_default();
        let named = String::from_utf16_lossy(&named.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>());
        if named != "switch.outbox" {
            let _ = std::fs::remove_dir_all(&dir);
            continue;
        }
        let rows: Vec<(Vec<u8>, String)> = c
            .prepare(
                "SELECT CAST(r.key AS BLOB), f.fileName FROM Records r JOIN ObjectStoreInfo s ON s.id = r.objectStoreID \
                 JOIN BlobRecords b ON b.objectStoreRow = r.recordID JOIN BlobFiles f ON f.blobURL = b.blobURL WHERE s.name = 'files'",
            )
            .and_then(|mut q| q.query_map([], |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, String>(1)?))).map(|it| it.flatten().collect()))
            .unwrap_or_default();
        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
        for (key, file) in rows {
            if let Some(id) = key_string(&key) {
                out.push((id, db.path().join(file)));
            }
        }
    }
    out
}

/// What reading the live app's store came to.
pub enum Read {
    /// Not this copy's to carry over (it isn't installed as the live app), or nothing's there.
    Nothing,
    /// The app that kept it still runs: nothing is carried over until it's quit.
    Running,
    /// Its store couldn't be read this time: tried again on the next launch.
    Failed,
    /// What it kept (as this app's outbox document reads it: `{ v: 2, cores }`, none when it kept
    /// nothing) and each kept file's bytes by id. `store` names it, for the mark that it's carried
    /// over; a test store (`$SWITCH_GPUI_CUTOVER_FROM`) has none and is never marked.
    Kept { store: Option<String>, doc: Option<Value>, files: Vec<(String, PathBuf)> },
}

/// The store's app id, for a mark: the live app's, or a test store's folder name.
pub fn store_id() -> Option<String> {
    match std::env::var("SWITCH_GPUI_CUTOVER_FROM") {
        Ok(dir) => Path::new(&dir).file_name().map(|n| n.to_string_lossy().to_string()),
        Err(_) => identifier(),
    }
}

/// What the Electrobun app kept, read by the copy installed as the live app alone (or from a test
/// store, `$SWITCH_GPUI_CUTOVER_FROM`), and only once that app has quit.
pub fn read() -> Read {
    let test = std::env::var("SWITCH_GPUI_CUTOVER_FROM").ok().map(PathBuf::from);
    if test.is_none() && !is_live() {
        return Read::Nothing;
    }
    let Some(id) = store_id() else { return Read::Nothing };
    if running(&id) {
        log::warn!("cutover: {id} still runs; nothing is carried over until it's quit");
        return Read::Running;
    }
    let bundle = match &test {
        Some(dir) => dir.clone(),
        None => match dirs::home_dir() {
            Some(h) => h.join("Library/WebKit").join(&id),
            None => return Read::Nothing,
        },
    };
    let store = test.is_none().then(|| id.clone());
    let Some(origin) = find(&bundle) else {
        log::info!("cutover: {id} kept no outbox here");
        return Read::Kept { store, doc: None, files: vec![] };
    };
    let raw = match local_storage(&origin, "switch.outbox") {
        Ok(Some(raw)) => raw,
        Ok(None) => return Read::Kept { store, doc: None, files: vec![] },
        Err(()) => return Read::Failed,
    };
    let doc: Value = match serde_json::from_str(&raw) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("cutover: its outbox isn't JSON: {e}");
            return Read::Kept { store, doc: None, files: vec![] };
        }
    };
    let doc = if doc.get("v").and_then(Value::as_u64) == Some(2) {
        Some(doc)
    } else if let Some(legacy) = doc.as_array() {
        // An older build's list: commands alone, for whichever core.
        let entries: Vec<Value> = legacy
            .iter()
            .map(|k| {
                let mut e = serde_json::json!({ "id": k["id"], "kind": "command", "name": k["command"], "payload": k["payload"] });
                if let Some(due) = k.get("due").filter(|d| d.is_number()) {
                    e["due"] = due.clone();
                }
                e
            })
            .collect();
        Some(serde_json::json!({ "v": 2, "cores": { "": { "entries": entries, "drafts": {} } } }))
    } else {
        log::warn!("cutover: its outbox is neither a document nor a list");
        None
    };
    let files = kept_files(&origin);
    let _ = std::fs::remove_dir_all(aside());
    Read::Kept { store, doc, files }
}
