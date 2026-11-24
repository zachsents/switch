//! What the user did or typed that must reach the core even if the app goes first (an update
//! relaunching it, a crash, its window closed), kept on this Mac per core: each command until the
//! core answers it, sent again by the next start, and each box's draft as it's typed. One held for
//! Undo is kept with when it's due. Each keeps its id, so one sent twice is a no-op in the brain;
//! one the core said no to stays, to show "Not sent" and give its words back. The desktop's
//! `outbox.ts` and `outbox-files.ts`: the same document (v2, by core), in a file instead of
//! localStorage, and a file's bytes in a folder beside it instead of IndexedDB, until they're up.
// The typed API the views use; parts not yet drawn are still the API.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A file on a message or a draft: its bytes kept here under `id` until `blob` says it's up.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct KeptFile {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub size: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Command,
    Emit,
    /// A widget's tool: the iPhone's to make.
    Call,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub kind: EntryKind,
    pub name: String,
    pub payload: Value,
    /// Held until then (ms): not sent before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<f64>,
    /// Still to upload before it goes, as its payload's attachments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<KeptFile>>,
    /// What the core said when it said no: never sent again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rejected: Option<String>,
    /// When it was given (ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<f64>,
    /// What this client shows of it while it waits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<Value>,
}

impl Entry {
    pub fn command(id: impl Into<String>, name: impl Into<String>, payload: Value) -> Self {
        Entry { id: id.into(), kind: EntryKind::Command, name: name.into(), payload, due: None, files: None, rejected: None, time: Some(now_ms()), view: None }
    }
}

/// A box's draft.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Draft {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dictated: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<KeptFile>>,
    #[serde(default, rename = "replyTo", skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Core {
    #[serde(default)]
    entries: Vec<Entry>,
    #[serde(default)]
    drafts: BTreeMap<String, Draft>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Doc {
    v: u8,
    cores: BTreeMap<String, Core>,
}

/// What changed: what's kept, or words given back to a box from outside it.
#[derive(Clone, Debug)]
pub enum Change {
    Kept,
    Restored(String),
}

struct Outbox {
    path: PathBuf,
    files: PathBuf,
    core: String,
    doc: Doc,
    listeners: Vec<Box<dyn Fn(&Change) + Send>>,
}

/// What's kept before a core is known goes under "", then to the first core reached.
const UNKNOWN: &str = "";

static OUTBOX: OnceLock<Mutex<Outbox>> = OnceLock::new();

pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.)
}

/// A test copy run beside the live app (`SWITCH_GPUI_QUIET=1`, or the desktop's `SWITCH_QUIET=1`):
/// it keeps what it does, and sends none of it.
pub fn quiet() -> bool {
    static Q: OnceLock<bool> = OnceLock::new();
    *Q.get_or_init(|| ["SWITCH_GPUI_QUIET", "SWITCH_QUIET"].iter().any(|k| std::env::var(k).is_ok_and(|v| v == "1")))
}

/// This app's data: `$SWITCH_GPUI_DATA` for a test copy's run of its own; else a quiet copy's own,
/// apart from the live app's and every other copy's; else its bundle's own (`gpui` in its
/// Application Support folder), so a side-by-side build, a test build and the live one never share
/// an outbox, a mark or a credential.
pub fn dir() -> PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        if let Some(d) = std::env::var_os("SWITCH_GPUI_DATA") {
            return PathBuf::from(d);
        }
        let base = dirs::data_dir().unwrap_or_default();
        if quiet() {
            return base.join(format!("switch-gpui-quiet-{}", std::process::id()));
        }
        let own = crate::platform::helpers::support().join("gpui");
        // What every build once shared goes to the first that isn't the live app (the side-by-side
        // one), without its old mark: the live app's comes from its own cutover.
        let shared = base.join("switch-gpui");
        if !own.exists() && shared.is_dir() && !crate::cutover::is_live() {
            let _ = std::fs::create_dir_all(own.parent().unwrap_or(&base));
            if std::fs::rename(&shared, &own).is_ok() {
                let _ = std::fs::remove_dir_all(own.join("carried"));
                log::info!("data: the shared folder is this build's now");
            }
        }
        own
    })
    .clone()
}

fn outbox() -> MutexGuard<'static, Outbox> {
    OUTBOX
        .get_or_init(|| {
            let path = dir().join(if quiet() { "outbox-quiet.json" } else { "outbox.json" });
            let mut doc = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Doc>(&t).ok()).filter(|d| d.v == 2).unwrap_or(Doc { v: 2, cores: BTreeMap::new() });
            let files = dir().join("outbox-files");
            // The core is known from the start (this Mac's config), so the first draft and the last
            // run's Not sent show on the first frame.
            let core = crate::auth::core();
            carry_over(&path, &files, &mut doc);
            let mut o = Outbox { path, files, core: UNKNOWN.into(), doc, listeners: vec![] };
            move_waiting(&mut o, &core);
            Mutex::new(o)
        })
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// The core this app reaches: what waited for one moves under it.
pub fn set_core(core: &str) {
    let mut o = outbox();
    if move_waiting(&mut o, core) {
        write(&mut o, Change::Kept);
    }
}

fn move_waiting(o: &mut Outbox, core: &str) -> bool {
    o.core = core.into();
    let Some(waited) = (core != UNKNOWN).then(|| o.doc.cores.remove(UNKNOWN)).flatten() else { return false };
    let had = o.doc.cores.entry(core.into()).or_default();
    had.entries.extend(waited.entries);
    for (k, d) in waited.drafts {
        had.drafts.entry(k).or_insert(d);
    }
    true
}

/// How far the cutover got: its document merged (once, never again), and the kept files still to
/// copy (from where, to where).
#[derive(Default, Serialize, Deserialize)]
struct Carried {
    merged: bool,
    #[serde(default)]
    pending: Vec<(String, PathBuf, PathBuf)>,
}

/// What the live Electrobun app kept (cutover.rs), carried over by the copy installed as the live
/// app, once Electrobun has quit: an entry or a draft already here stays as it is, one that doesn't
/// read is left out (said in the log), and its files' bytes are copied beside this outbox off the
/// main thread. The document is merged once and marked so before any file is copied; a file that
/// didn't copy is tried again on the next launch, the document never merged again. A test store is
/// never marked. Whether the document changed (and was written).
fn carry_over(path: &std::path::Path, files: &std::path::Path, doc: &mut Doc) -> bool {
    let test = std::env::var("SWITCH_GPUI_CUTOVER_FROM").is_ok();
    let mark = crate::cutover::store_id().map(|id| dir().join("carried").join(format!("{id}.json")));
    let keep_mark = move |m: &std::path::Path, c: &Carried| {
        if let Some(d) = m.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let tmp = m.with_extension("json.tmp");
        if std::fs::write(&tmp, serde_json::to_vec(c).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, m);
        }
    };
    let held: Option<Carried> = mark.as_ref().filter(|_| !test).and_then(|m| std::fs::read(m).ok()).and_then(|b| serde_json::from_slice(&b).ok());
    if let Some(c) = held.filter(|c| c.merged) {
        // Merged before: only files still owed are copied, if this is the live copy.
        if !c.pending.is_empty() && crate::cutover::is_live() && let Some(m) = mark {
            let jobs = c.pending.clone();
            crate::files::keep_all_later(jobs.clone(), move |failed| keep_mark(&m, &Carried { merged: true, pending: jobs.into_iter().filter(|(id, _, _)| failed.contains(id)).collect() }));
        }
        return false;
    }
    let crate::cutover::Read::Kept { store, doc: theirs, files: bytes } = crate::cutover::read() else { return false };
    let mut changed = false;
    let cores = theirs.as_ref().and_then(|t| t.get("cores")).and_then(Value::as_object).cloned().unwrap_or_default();
    for (core, c) in cores {
        let mine = doc.cores.entry(core).or_default();
        for raw in c.get("entries").and_then(Value::as_array).into_iter().flatten() {
            match serde_json::from_value::<Entry>(raw.clone()) {
                Ok(e) if !mine.entries.iter().any(|m| m.id == e.id) => {
                    mine.entries.push(e);
                    changed = true;
                }
                Ok(_) => {}
                Err(e) => log::warn!("cutover: an outbox entry didn't read: {e}"),
            }
        }
        for (place, raw) in c.get("drafts").and_then(Value::as_object).into_iter().flatten() {
            match serde_json::from_value::<Draft>(raw.clone()) {
                Ok(d) if !mine.drafts.contains_key(place) => {
                    mine.drafts.insert(place.clone(), d);
                    changed = true;
                }
                Ok(_) => {}
                Err(e) => log::warn!("cutover: a draft didn't read: {e}"),
            }
        }
    }
    if changed {
        let _ = std::fs::create_dir_all(dir());
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, serde_json::to_vec(doc).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
    let jobs: Vec<(String, PathBuf, PathBuf)> = bytes.into_iter().map(|(id, from)| (id.clone(), from, files.join(id.replace(['/', '\\'], "_")))).collect();
    let mark = store.and(mark);
    if let Some(m) = &mark {
        keep_mark(m, &Carried { merged: true, pending: jobs.clone() });
    }
    let all = jobs.clone();
    crate::files::keep_all_later(jobs, move |failed| {
        if let Some(m) = mark {
            keep_mark(&m, &Carried { merged: true, pending: all.into_iter().filter(|(id, _, _)| failed.contains(id)).collect() });
        }
    });
    changed
}

/// Told of every change.
pub fn subscribe(l: impl Fn(&Change) + Send + 'static) {
    outbox().listeners.push(Box::new(l));
}

fn write(o: &mut MutexGuard<'static, Outbox>, change: Change) {
    if let Some(d) = o.path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let tmp = o.path.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_vec(&o.doc).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &o.path);
    }
    for l in &o.listeners {
        l(&change);
    }
}

fn change(f: impl FnOnce(&mut Core)) {
    let mut o = outbox();
    let core = o.core.clone();
    let c = o.doc.cores.entry(core.clone()).or_default();
    f(c);
    if c.entries.is_empty() && c.drafts.is_empty() {
        o.doc.cores.remove(&core);
    }
    write(&mut o, Change::Kept);
}

fn here<T>(f: impl FnOnce(&Core) -> T) -> T {
    let o = outbox();
    let empty = Core::default();
    f(o.doc.cores.get(&o.core).unwrap_or(&empty))
}

/// What's kept for the core this app reaches.
pub fn kept() -> Vec<Entry> {
    here(|c| c.entries.clone())
}

pub fn find(id: &str) -> Option<Entry> {
    here(|c| c.entries.iter().find(|e| e.id == id).cloned())
}

pub fn is_kept(id: &str) -> bool {
    find(id).is_some()
}

/// Keeps it, in place of one under its id.
pub fn keep(e: Entry) {
    change(|c| {
        c.entries.retain(|o| o.id != e.id);
        c.entries.push(e);
    });
}

/// Changes a kept one in place, if it's still kept.
pub fn update(id: &str, f: impl FnOnce(&mut Entry)) {
    if !is_kept(id) {
        return;
    }
    change(|c| {
        if let Some(e) = c.entries.iter_mut().find(|e| e.id == id) {
            f(e);
        }
    });
}

/// Drops it, and its files' bytes unless they go on elsewhere (`keep_files`).
pub fn drop(id: &str, keep_files: bool) {
    let Some(e) = find(id) else { return };
    change(|c| c.entries.retain(|o| o.id != id));
    if !keep_files {
        for f in e.files.unwrap_or_default() {
            drop_file(&f.id);
        }
    }
}

/// The newest kept `name` whose payload `matches`.
pub fn latest(name: &str, matches: impl Fn(&Value) -> bool) -> Option<Entry> {
    here(|c| c.entries.iter().rev().find(|o| o.name == name && matches(&o.payload)).cloned())
}

/// A box's draft: `space:<id>` or `thread:<id>`.
pub fn draft(place: &str) -> Option<Draft> {
    here(|c| c.drafts.get(place).cloned())
}

/// Keeps a box's draft, or drops it when there's nothing in it.
pub fn set_draft(place: &str, d: Draft) {
    let empty = d.text.is_empty() && d.files.as_ref().is_none_or(Vec::is_empty) && d.reply_to.as_ref().and_then(Value::as_array).is_none_or(Vec::is_empty);
    if empty && draft(place).is_none() {
        return;
    }
    if draft(place).as_ref() == Some(&d) {
        return;
    }
    change(|c| {
        if empty {
            c.drafts.remove(place);
        } else {
            c.drafts.insert(place.into(), d);
        }
    });
}

/// A message the core said no to, back in its box (after what's there) and out of the chat.
pub fn restore(id: &str, place: &str) {
    let Some(e) = find(id) else { return };
    let text = e.payload.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
    let had = draft(place).unwrap_or_default();
    let mut files = had.files.clone().unwrap_or_default();
    files.extend(e.files.clone().unwrap_or_default());
    set_draft(place, Draft { text: if had.text.is_empty() { text } else { format!("{}\n{text}", had.text) }, files: Some(files), ..had });
    drop(id, true);
    let o = outbox();
    let change = Change::Restored(place.into());
    for l in &o.listeners {
        l(&change);
    }
}

/// Where a kept file's bytes are.
pub fn file_path(id: &str) -> PathBuf {
    let files = outbox().files.clone();
    files.join(id.replace(['/', '\\'], "_"))
}

pub fn put_file(id: &str, bytes: &[u8]) -> std::io::Result<()> {
    let path = file_path(id);
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    std::fs::write(path, bytes)
}

/// A kept file's bytes, or none when they're gone.
pub fn get_file(id: &str) -> Option<Vec<u8>> {
    std::fs::read(file_path(id)).ok()
}

pub fn drop_file(id: &str) {
    let _ = std::fs::remove_file(file_path(id));
}
