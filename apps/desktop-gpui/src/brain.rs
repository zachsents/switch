//! The brain as the window reads it, the desktop's `store.ts`, `adapter.ts` and `history.ts` in one:
//! the snapshot (spaces, threads, the board's extras), live events folded on top, and each space's
//! chat and each opened thread's transcript, paged in. `derive.rs` reads what a page shows from it.
//! Every change bumps `version`, and a chat's or transcript's own counter, so a view redraws exactly
//! where something changed.
// The typed API the views use; parts not yet drawn are still the API.
#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use indexmap::IndexMap;
use serde_json::Value;

use crate::items::{ActionItem, Items, Placed};

/// What needs the user: an action item (items.rs).
pub type Ask = ActionItem;
use crate::json::{gb, get, gn, gs, gu, list, opt, s};

pub const HOME: &str = "home";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Link {
    Connecting,
    Open,
    Down,
}

#[derive(Clone, Debug)]
pub struct SpaceRow {
    pub id: String,
    pub name: String,
    pub parent: Option<String>,
    pub archived: bool,
    /// Its own ink, day and night.
    pub ink: Option<(String, String)>,
    /// Its place in the order spaces were made, for stable order and station numbers.
    pub made: f64,
    /// Its cover's blob (at /blobs/<hash>).
    pub cover: Option<String>,
    pub about: String,
    pub ephemeral: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemKind {
    User,
    Text,
    Tool,
    Result,
    Steer,
    Wake,
}

/// One transcript entry of a thread, in log order.
#[derive(Clone, Debug)]
pub struct Item {
    pub seq: u64,
    pub turn: String,
    pub kind: ItemKind,
    pub text: String,
    /// A tool call's id, and the id of the call a result answers.
    pub id: String,
    /// A tool's name.
    pub name: String,
    pub input: Value,
    pub error: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Idle,
    Running,
    Waiting,
    Done,
    Interrupted,
    Failed,
    Limited,
}

impl Status {
    pub fn of(v: &str) -> Self {
        match v {
            "running" => Self::Running,
            "waiting" => Self::Waiting,
            "done" => Self::Done,
            "interrupted" => Self::Interrupted,
            "failed" => Self::Failed,
            "limited" => Self::Limited,
            _ => Self::Idle,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ThreadRow {
    pub id: String,
    pub parent: Option<String>,
    pub title: String,
    pub status: Status,
    pub turn: Option<String>,
    /// The seq it was opened at: a tag of it says its space.
    pub opened: u64,
    /// Its own space; none takes its parent's.
    pub home: Option<String>,
    /// When the running turn started, or the last ended.
    pub since: f64,
    pub result: String,
    /// Text streaming into the running turn, until its block lands.
    pub streaming: String,
    /// Its latest turn's entries, for its live step; the whole transcript is paged.
    pub items: Vec<Item>,
    /// Drafts the reply gate sent back: never shown.
    pub rejected: HashSet<String>,
    /// Where a task's work stands, as it says ("building"); empty when it hasn't said.
    pub stage: String,
    /// Its latest turn has none of the user's words in it.
    pub woken: bool,
    /// And the senses woke it: nothing shows it running.
    pub sensed: bool,
}

/// A file on a message.
#[derive(Clone, Debug, PartialEq)]
pub struct Attachment {
    pub blob: String,
    pub name: String,
    /// Its MIME type.
    pub kind: String,
    pub size: f64,
}

impl Attachment {
    /// As the brain takes it on a message.
    pub fn to_json(&self) -> Value {
        serde_json::json!({ "blob": self.blob, "name": self.name, "type": self.kind, "size": self.size })
    }
}

/// An app's widget shown in a chat, its tool called with `input`.
#[derive(Clone, Debug)]
pub struct Shown {
    pub app: String,
    pub name: String,
    pub input: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Who {
    User,
    Agent,
    /// An outside agent posting into the space: its name is the line's `from`.
    Peer,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Quiet {
    /// An app's outcome, or a condition's line revised through `until`.
    Event { until: f64 },
    /// A memory a turn learned here, and what it replaced: Undo forgets it and puts those back.
    Learned { id: String, restore: Vec<String> },
}

/// Each side's tapback on a message: a tapback's name ("love") or an emoji.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Reactions {
    pub user: Option<String>,
    pub agent: Option<String>,
}

impl Reactions {
    pub fn any(&self) -> bool {
        self.user.is_some() || self.agent.is_some()
    }
}

/// What a message of the user's replies to: words of a message (by its seq), or an action item;
/// each with the user's own reply to it, when there is one.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Reply {
    Quote { seq: u64, text: String, reply: Option<String> },
    Ask { id: String, title: Option<String>, reply: Option<String> },
}

impl Reply {
    pub fn reply(&self) -> &str {
        match self {
            Reply::Quote { reply, .. } | Reply::Ask { reply, .. } => reply.as_deref().unwrap_or(""),
        }
    }

    pub fn set_reply(&mut self, to: String) {
        match self {
            Reply::Quote { reply, .. } | Reply::Ask { reply, .. } => *reply = Some(to),
        }
    }

    /// The same quote (seq and words) or the same ask.
    pub fn same(&self, other: &Reply) -> bool {
        match (self, other) {
            (Reply::Quote { seq: a, text: x, .. }, Reply::Quote { seq: b, text: y, .. }) => a == b && x == y,
            (Reply::Ask { id: a, .. }, Reply::Ask { id: b, .. }) => a == b,
            _ => false,
        }
    }

    /// As the brain takes it in `replyTo`, with the user's reply when there is one.
    pub fn to_json(&self) -> Value {
        let reply = self.reply().trim();
        let mut v = match self {
            Reply::Quote { seq, text, .. } => serde_json::json!({ "kind": "quote", "seq": seq, "text": text }),
            Reply::Ask { id, .. } => serde_json::json!({ "kind": "ask", "id": id }),
        };
        if !reply.is_empty() {
            v["reply"] = Value::String(reply.to_string());
        }
        v
    }

    /// As kept on this Mac (a draft's), its title too.
    pub fn to_kept(&self) -> Value {
        let mut v = match self {
            Reply::Quote { seq, text, .. } => serde_json::json!({ "kind": "quote", "seq": seq, "text": text }),
            Reply::Ask { id, title, .. } => {
                let mut a = serde_json::json!({ "kind": "ask", "id": id });
                if let Some(t) = title {
                    a["title"] = Value::String(t.clone());
                }
                a
            }
        };
        if let Some(r) = match self {
            Reply::Quote { reply, .. } | Reply::Ask { reply, .. } => reply,
        } {
            v["reply"] = Value::String(r.clone());
        }
        v
    }
}

/// A side's reaction to words of a message.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PartReaction {
    pub user: bool,
    pub reaction: String,
    pub text: String,
}

/// What a line replies to, as far as it reads.
pub fn replies_of(raw: &Value) -> Vec<Reply> {
    list(raw)
        .iter()
        .filter_map(|r| {
            let reply = Some(gs(r, "reply")).filter(|x| !x.trim().is_empty());
            match gs(r, "kind").as_str() {
                "quote" if !gs(r, "text").is_empty() => Some(Reply::Quote { seq: gu(r, "seq"), text: gs(r, "text"), reply }),
                "ask" if !gs(r, "id").is_empty() => Some(Reply::Ask { id: gs(r, "id"), title: opt(r, "title").filter(|t| !t.is_empty()), reply }),
                _ => None,
            }
        })
        .collect()
}

/// What a box replies to as its draft keeps it (`replying.ts`'s `Replies`): each reply's words as
/// typed, spaces and all, so a row with only spaces in it comes back after a relaunch.
pub fn replies_kept(raw: &Value) -> Vec<Reply> {
    list(raw)
        .iter()
        .filter_map(|r| {
            let reply = r.get("reply").and_then(Value::as_str).map(str::to_string);
            match gs(r, "kind").as_str() {
                "quote" => Some(Reply::Quote { seq: gu(r, "seq"), text: gs(r, "text"), reply }),
                "ask" => Some(Reply::Ask { id: gs(r, "id"), title: opt(r, "title"), reply }),
                _ => None,
            }
        })
        .collect()
}

/// A reaction as the brain says it: one of the six tapbacks, or an emoji.
pub fn reaction_of(v: &Value) -> Option<String> {
    let r = v.as_str()?;
    (TAPBACKS.contains(&r) || is_emoji(r)).then(|| r.to_string())
}

/// The six tapbacks.
pub const TAPBACKS: [&str; 6] = ["love", "like", "dislike", "laugh", "emphasize", "question"];

/// One emoji as a reaction (its modifiers and joiners with it), as the brain's `Emoji` checks it.
pub fn is_emoji(r: &str) -> bool {
    use std::sync::OnceLock;
    static RE: OnceLock<(regex::Regex, regex::Regex)> = OnceLock::new();
    let (all, one) = RE.get_or_init(|| {
        (
            regex::Regex::new(r"^[\p{Extended_Pictographic}\p{Emoji_Component}]{1,16}$").expect("re"),
            regex::Regex::new(r"\p{Extended_Pictographic}").expect("re"),
        )
    });
    all.is_match(r) && one.is_match(r)
}

fn reactions_of(raw: &Value) -> Reactions {
    Reactions { user: reaction_of(get(raw, "user")), agent: reaction_of(get(raw, "agent")) }
}

fn parts_of(raw: &Value) -> Vec<PartReaction> {
    list(raw)
        .iter()
        .filter_map(|p| {
            let reaction = reaction_of(get(p, "reaction"))?;
            let text = gs(p, "text");
            (!text.is_empty()).then(|| PartReaction { user: gs(p, "side") != "agent", reaction, text })
        })
        .collect()
}

/// The display name of the model a line records, when it does.
fn model_of(raw: &Value) -> Option<String> {
    Some(gs(raw, "name")).filter(|n| !n.is_empty())
}

fn strings(v: &Value) -> Vec<String> {
    list(v).iter().map(s).collect()
}

/// A line in a space's chat.
#[derive(Clone, Debug)]
pub struct Line {
    pub seq: u64,
    pub time: f64,
    pub who: Who,
    pub text: String,
    /// The space it was said in.
    pub home: String,
    /// The other spaces it bears on.
    pub mentions: Vec<String>,
    pub widget: Option<Shown>,
    pub quiet: Option<Quiet>,
    pub attachments: Vec<Attachment>,
    pub detail: Option<String>,
    pub edited: bool,
    /// The turn a reply came from.
    pub turn: Option<String>,
    /// The action item a reply of the user's was on.
    pub item: Option<String>,
    pub reactions: Reactions,
    /// What a message of the user's replies to.
    pub reply_to: Vec<Reply>,
    /// Reactions to words of it.
    pub parts: Vec<PartReaction>,
    /// The display name of the model that wrote it.
    pub model: Option<String>,
    /// A peer's name, as it gave it.
    pub from: Option<String>,
}

impl Line {
    /// A line with nothing but its place, side and words.
    pub fn bare(seq: u64, time: f64, who: Who, text: String, home: String) -> Self {
        Line {
            seq,
            time,
            who,
            text,
            home,
            mentions: vec![],
            widget: None,
            quiet: None,
            attachments: vec![],
            detail: None,
            edited: false,
            turn: None,
            item: None,
            reactions: Reactions::default(),
            reply_to: vec![],
            parts: vec![],
            model: None,
            from: None,
        }
    }
}

/// Sent, not yet in the log: a message kept in the outbox, or one the core took as of `landed`
/// whose line hasn't come yet.
#[derive(Clone, Debug, PartialEq)]
pub struct Pending {
    pub id: String,
    pub space: String,
    pub text: String,
    /// The core said no.
    pub failed: bool,
    pub landed: Option<u64>,
    /// The files' names, still going up.
    pub files: Vec<String>,
    /// What it replies to.
    pub reply_to: Vec<Reply>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActivityState {
    Running,
    Needs,
    Failed,
    Done,
}

/// An extension's long job, as its Live Activity says: a print, a deploy.
#[derive(Clone, Debug)]
pub struct Activity {
    pub id: String,
    pub space: String,
    pub title: String,
    pub line: String,
    /// 0 to 1, when known.
    pub progress: Option<f64>,
    pub started_at: f64,
    pub ends_at: Option<f64>,
    pub state: ActivityState,
    /// `state` is done.
    pub done: bool,
}

/// An account the user connected for extensions.
#[derive(Clone, Debug)]
pub struct Connection {
    pub id: String,
    pub provider: String,
    pub account: String,
    pub scopes: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialStatus {
    Pending,
    Active,
    Revoked,
}

/// A device, host or extension that may reach the core, or one asking to.
#[derive(Clone, Debug)]
pub struct Credential {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub scopes: Vec<String>,
    pub status: CredentialStatus,
    /// The code it shows while pending.
    pub code: Option<String>,
    /// When it was made, in ms.
    pub at: f64,
    /// Good until then, in ms.
    pub until: Option<f64>,
}

/// An installed extension.
#[derive(Clone, Debug)]
pub struct Extension {
    pub name: String,
    pub from: String,
    pub version: String,
}

#[derive(Clone, Debug)]
pub struct UsageWindow {
    pub name: String,
    /// A share used, 0 to 1.
    pub used: f64,
    pub resets_at: f64,
}

/// A provider subscription the agent runs on, as `account.state` last said.
#[derive(Clone, Debug)]
pub struct Subscription {
    pub host: String,
    /// The email its login reports, else its provider's name.
    pub label: String,
    pub provider: String,
    pub up: bool,
    /// Why it's down besides a limit: "Signed out".
    pub problem: String,
    /// ms; 0 when not limited.
    pub limited_until: f64,
    pub windows: Vec<UsageWindow>,
    pub running: f64,
}

/// A space's chat, newest page last; `more` while older pages are left.
#[derive(Clone, Debug, Default)]
pub struct Chat {
    pub lines: Vec<Arc<Line>>,
    pub more: bool,
    /// Its first page is in.
    pub loaded: bool,
    /// A page is on its way.
    pub fetching: bool,
    /// The brain moved lines in or out of it: paged again.
    pub stale: bool,
    /// How many pages are in: a refetch asks for as many again.
    pub pages: usize,
    /// Where the next older page starts: the last page's first line, while it says there's more
    /// (pages.ts `getNextPageParam`); none when that page was empty.
    pub next: Option<u64>,
    /// Its latest page was refused this many times running, and isn't asked again before then.
    pub failures: u32,
    pub retry_at: Option<std::time::Instant>,
}

impl Chat {
    /// A refused latest page: not asked again for a while, longer each time (5 s, doubling to a
    /// minute), rather than on every frame.
    pub fn backoff(&mut self) {
        self.failures += 1;
        let secs = (5u64 << (self.failures - 1).min(4)).min(60);
        self.retry_at = Some(std::time::Instant::now() + std::time::Duration::from_secs(secs));
    }
}

/// What a kept message replies to, read as the desktop's `Replies` schema reads it: every ref
/// whole, or none at all.
pub fn replies_strict(raw: &Value) -> Option<Vec<Reply>> {
    let opt_str = |r: &Value, k: &str| r.get(k).is_none_or(Value::is_string);
    raw.as_array()?
        .iter()
        .map(|r| match r.get("kind").and_then(Value::as_str) {
            Some("quote") if r.get("seq").is_some_and(Value::is_number) && r.get("text").is_some_and(Value::is_string) && opt_str(r, "reply") => {
                Some(Reply::Quote { seq: gu(r, "seq"), text: gs(r, "text"), reply: opt(r, "reply") })
            }
            Some("ask") if r.get("id").is_some_and(Value::is_string) && opt_str(r, "title") && opt_str(r, "reply") => {
                Some(Reply::Ask { id: gs(r, "id"), title: opt(r, "title"), reply: opt(r, "reply") })
            }
            _ => None,
        })
        .collect()
}

/// Where a page's next older one starts, as pages.ts says it.
fn next_of(page: &Value, key: &str) -> Option<u64> {
    gb(page, "more").then(|| list(get(page, key)).first().map(|l| gu(l, "seq"))).flatten()
}

/// A thread's transcript, oldest first.
#[derive(Clone, Debug, Default)]
pub struct Transcript {
    pub items: Vec<Item>,
    pub more: bool,
    pub loaded: bool,
    pub fetching: bool,
    pub rejected: HashSet<String>,
    /// Its first page failed: the page says so.
    pub failed: Option<String>,
    /// How many pages are in: a refetch asks for as many again.
    pub pages: usize,
    /// Where the next older page starts (the last page's first entry, while there's more).
    pub next: Option<u64>,
}

/// One row of the log.
#[derive(Clone, Debug)]
pub struct Event {
    pub seq: u64,
    pub id: String,
    pub time: f64,
    pub kind: String,
    pub source: String,
    pub payload: Value,
}

impl Event {
    pub fn of(v: &Value) -> Self {
        Self {
            seq: gu(v, "seq"),
            id: gs(v, "id"),
            time: gn(v, "time"),
            kind: gs(v, "type"),
            source: gs(v, "source"),
            payload: get(v, "payload").clone(),
        }
    }
}

/// The snapshot, read off the main thread; also what's kept on disk for the first frame.
#[derive(Default)]
pub struct Snapshot {
    pub seq: u64,
    pub spaces: HashMap<String, SpaceRow>,
    pub threads: HashMap<String, ThreadRow>,
    pub warm: Vec<(String, u64)>,
    pub reads: HashMap<String, u64>,
    pub replies: HashMap<String, u64>,
    /// Action items in full, open and lately closed.
    pub items: Items,
    pub placed: Vec<Placed>,
    pub prefs: HashMap<String, Value>,
    pub connections: IndexMap<String, Connection>,
    pub subscriptions: IndexMap<String, Subscription>,
    pub extensions: Vec<Extension>,
    pub credentials: IndexMap<String, Credential>,
    pub activities: IndexMap<String, Activity>,
    pub chats: Vec<(String, Vec<Line>, bool)>,
}

fn home_row() -> SpaceRow {
    SpaceRow { id: HOME.into(), name: "Home".into(), parent: None, archived: false, ink: None, made: 0., cover: None, about: String::new(), ephemeral: false }
}

/// Home has none; any other space without one sits in Home.
fn parent_of(id: &str, raw: &Value) -> Option<String> {
    if id == HOME {
        return None;
    }
    Some(raw.as_str().filter(|x| !x.is_empty()).unwrap_or(HOME).to_string())
}

fn ink_of(raw: &Value) -> Option<(String, String)> {
    match (get(raw, "day").as_str(), get(raw, "night").as_str()) {
        (Some(d), Some(n)) => Some((d.into(), n.into())),
        _ => None,
    }
}

fn space_of(v: &Value) -> SpaceRow {
    let id = gs(v, "id");
    SpaceRow {
        parent: parent_of(&id, get(v, "parent")),
        name: gs(v, "name"),
        archived: gb(v, "archived"),
        ink: ink_of(get(v, "ink")),
        made: gn(v, "made"),
        cover: get(v, "cover").as_str().map(str::to_string),
        about: gs(v, "about"),
        ephemeral: gb(v, "ephemeral"),
        id,
    }
}

pub fn item_of(raw: &Value) -> Item {
    let kind = match raw.get("kind").and_then(Value::as_str) {
        Some("user") => ItemKind::User,
        Some("tool") => ItemKind::Tool,
        Some("result") => ItemKind::Result,
        Some("steer") => ItemKind::Steer,
        Some("wake") => ItemKind::Wake,
        _ => ItemKind::Text,
    };
    Item {
        seq: gu(raw, "seq"),
        turn: gs(raw, "turn"),
        text: if kind == ItemKind::Result { gs(raw, "output") } else { gs(raw, "text") },
        id: if matches!(kind, ItemKind::Tool | ItemKind::Result) { gs(raw, "id") } else { String::new() },
        name: if kind == ItemKind::Tool { gs(raw, "name") } else { String::new() },
        // None given is no words (the desktop's `undefined`); a given `null` is `null`.
        input: if kind == ItemKind::Tool { raw.get("input").cloned().unwrap_or_else(|| Value::String(String::new())) } else { Value::String(String::new()) },
        error: kind == ItemKind::Result && gb(raw, "error"),
        kind,
    }
}

fn thread_of(t: &Value) -> ThreadRow {
    ThreadRow {
        id: gs(t, "id"),
        parent: get(t, "parent").as_str().map(str::to_string),
        title: gs(t, "title"),
        status: Status::of(&gs(t, "status")),
        turn: get(t, "turn").as_str().map(str::to_string),
        opened: gu(t, "opened"),
        home: get(t, "home").as_str().map(str::to_string),
        since: gn(t, "since"),
        result: gs(t, "result"),
        streaming: String::new(),
        items: list(get(t, "items")).iter().map(item_of).collect(),
        rejected: HashSet::new(),
        stage: gs(t, "stage"),
        woken: gb(t, "woken"),
        sensed: gb(t, "sensed"),
    }
}

/// An attachment's blob as the brain names it: a sha256 hash, lowercase hex.
pub fn hash_of(said: &str) -> Option<String> {
    let h = said.strip_prefix("sha256:").or_else(|| said.strip_prefix("blob:")).unwrap_or(said);
    (h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).then(|| h.to_string())
}

fn attachments_of(raw: &Value) -> Vec<Attachment> {
    list(raw)
        .iter()
        .filter_map(|a| Some(Attachment { blob: hash_of(&gs(a, "blob"))?, name: gs(a, "name"), kind: gs(a, "type"), size: gn(a, "size") }))
        .collect()
}

fn shown_of(raw: &Value) -> Option<Shown> {
    let app = gs(raw, "app");
    (!app.is_empty()).then(|| Shown {
        app,
        name: gs(raw, "name"),
        input: if get(raw, "input").is_object() { get(raw, "input").clone() } else { Value::Object(Default::default()) },
    })
}

/// A line as a page or the snapshot gives it.
pub fn line_of(raw: &Value) -> Line {
    let quiet = match raw.get("kind").and_then(Value::as_str) {
        Some("event") => Some(Quiet::Event { until: gn(raw, "until") }),
        Some("learned") => Some(Quiet::Learned { id: gs(raw, "memory"), restore: strings(get(raw, "restore")) }),
        _ => None,
    };
    Line {
        seq: gu(raw, "seq"),
        time: gn(raw, "time"),
        who: who_of(&gs(raw, "who")),
        text: gs(raw, "text"),
        home: gs(raw, "home"),
        mentions: list(get(raw, "mentions")).iter().map(s).collect(),
        turn: get(raw, "turn").as_str().map(str::to_string),
        widget: shown_of(get(raw, "widget")),
        quiet,
        item: opt(raw, "item"),
        attachments: attachments_of(get(raw, "attachments")),
        detail: opt(raw, "detail"),
        edited: gb(raw, "edited"),
        reactions: reactions_of(get(raw, "reactions")),
        reply_to: replies_of(get(raw, "replyTo")),
        parts: parts_of(get(raw, "parts")),
        model: model_of(get(raw, "model")),
        from: opt(raw, "from"),
    }
}

/// A line's side, from its `who` or its event's `source`.
fn who_of(s: &str) -> Who {
    match s {
        "agent" => Who::Agent,
        "peer" => Who::Peer,
        _ => Who::User,
    }
}

/// The line a `message.posted` event is.
pub fn posted_line(e: &Event) -> Line {
    let p = &e.payload;
    Line {
        turn: opt(p, "turn"),
        widget: shown_of(get(p, "widget")),
        item: opt(p, "item"),
        attachments: attachments_of(get(p, "attachments")),
        detail: opt(p, "detail").filter(|d| !d.trim().is_empty()),
        reply_to: replies_of(get(p, "replyTo")),
        model: model_of(get(p, "model")),
        from: opt(p, "from"),
        ..Line::bare(e.seq, e.time, who_of(&e.source), gs(p, "text"), opt(p, "space").unwrap_or_else(|| HOME.into()))
    }
}

/// A `memory.written` from a turn's work, or a dial it moved (`setting.set`), as its "Remembered"
/// line in that space.
pub fn learned_line(e: &Event) -> Option<Line> {
    let p = &e.payload;
    let space = opt(p, "space")?;
    if opt(p, "decision").is_none() && e.kind != "setting.set" {
        return None;
    }
    Some(Line {
        quiet: Some(Quiet::Learned { id: gs(p, "id"), restore: strings(get(p, "replaces")) }),
        ..Line::bare(e.seq, e.time, Who::Agent, gs(p, "description"), space)
    })
}

fn activity_of(a: &Value) -> Activity {
    let state = match get(a, "state").as_str() {
        Some("needs") => ActivityState::Needs,
        Some("failed") => ActivityState::Failed,
        Some("done") => ActivityState::Done,
        _ => ActivityState::Running,
    };
    Activity {
        id: gs(a, "id"),
        space: gs(a, "space"),
        title: gs(a, "title"),
        line: gs(a, "line"),
        progress: get(a, "progress").as_f64(),
        started_at: gn(a, "startedAt"),
        ends_at: get(a, "endsAt").as_f64(),
        state,
        done: state == ActivityState::Done,
    }
}

fn connection_of(c: &Value) -> Connection {
    Connection { id: gs(c, "id"), provider: gs(c, "provider"), account: gs(c, "account"), scopes: strings(get(c, "scopes")) }
}

/// Its name: under `spur` in events from before extensions were renamed.
fn name_of(p: &Value) -> String {
    if p.get("extension").is_some_and(|v| !v.is_null()) { gs(p, "extension") } else { gs(p, "spur") }
}

fn extension_of(p: &Value) -> Extension {
    Extension { name: name_of(p), from: gs(p, "from"), version: gs(p, "version") }
}

fn credential_of(c: &Value, status: Option<CredentialStatus>, at: f64) -> Credential {
    let status = status.unwrap_or(match get(c, "status").as_str() {
        Some("pending") => CredentialStatus::Pending,
        Some("revoked") => CredentialStatus::Revoked,
        _ => CredentialStatus::Active,
    });
    Credential {
        id: gs(c, "id"),
        name: gs(c, "name"),
        kind: gs(c, "kind"),
        scopes: strings(get(c, "scopes")),
        status,
        code: get(c, "code").as_str().map(str::to_string),
        at: get(c, "at").as_f64().unwrap_or(at),
        until: get(c, "until").as_f64(),
    }
}

fn subscription_of(a: &Value, label: Option<String>) -> Subscription {
    let host = gs(a, "host");
    Subscription {
        label: opt(a, "label").or(label).unwrap_or_else(|| host.clone()),
        provider: gs(a, "provider"),
        up: gb(a, "up"),
        problem: gs(a, "problem"),
        limited_until: gn(a, "limitedUntil"),
        windows: list(get(a, "windows"))
            .iter()
            .map(|w| UsageWindow { name: gs(w, "name"), used: gn(w, "used"), resets_at: gn(w, "resetsAt") })
            .collect(),
        running: gn(a, "running"),
        host,
    }
}

impl Snapshot {
    pub fn of(seq: u64, st: &Value) -> Self {
        let mut spaces: HashMap<String, SpaceRow> = list(get(st, "spaces")).iter().map(|x| (gs(x, "id"), space_of(x))).collect();
        spaces.insert(HOME.into(), home_row());
        let pairs = |key: &str| -> HashMap<String, u64> { list(get(st, key)).iter().map(|r| (gs(r, "space"), gu(r, "seq"))).collect() };
        Self {
            seq,
            threads: list(get(st, "threads")).iter().map(|t| (gs(t, "id"), thread_of(t))).collect(),
            warm: list(get(st, "warm")).iter().map(|w| (gs(w, "space"), gu(w, "seq"))).collect(),
            reads: pairs("reads"),
            replies: pairs("replies"),
            items: Items::of_snapshot(st),
            placed: crate::items::placed_of_snapshot(st),
            prefs: get(st, "prefs").as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default(),
            connections: list(get(st, "connections")).iter().map(|c| (gs(c, "id"), connection_of(c))).collect(),
            subscriptions: list(get(st, "accounts")).iter().map(|a| (gs(a, "host"), subscription_of(a, None))).collect(),
            extensions: list(get(st, "extensions")).iter().map(extension_of).collect(),
            credentials: list(get(st, "credentials")).iter().map(|c| (gs(c, "id"), credential_of(c, None, 0.))).collect(),
            activities: list(get(st, "activities")).iter().map(|a| (gs(a, "id"), activity_of(a))).collect(),
            chats: list(get(st, "chats"))
                .iter()
                .map(|c| (gs(c, "space"), list(get(c, "lines")).iter().map(line_of).collect(), gb(c, "more")))
                .collect(),
            spaces,
        }
    }
}

/// A page of a chat or a transcript, as asked for.
#[derive(Clone, Debug)]
pub enum PageOf {
    Chat(String),
    Thread(String),
}

#[derive(Default)]
pub struct Brain {
    pub seq: u64,
    /// Whether the first snapshot has landed (or the one kept on disk, until it does).
    pub ready: bool,
    /// What's shown is the snapshot kept on disk; the live one hasn't come yet.
    pub kept: bool,
    pub spaces: HashMap<String, SpaceRow>,
    pub threads: HashMap<String, ThreadRow>,
    /// The latest chat line in each space, carried up to the spaces above, for warmth.
    pub warm: HashMap<String, u64>,
    /// How far the user has read each space's chat, on any device.
    pub reads: HashMap<String, u64>,
    /// Each space's latest reply: unread while it's past the read mark.
    pub replies: HashMap<String, u64>,
    /// In the order they were sent.
    pub pending: Vec<Pending>,
    /// Action items: open, open while the agent reworks them (nothing to answer, links still find
    /// them), and the latest closed.
    pub items: Items,
    /// The widgets placed in spaces, in order.
    pub placed: Vec<Placed>,
    /// The user's preferences that follow them across clients, by key.
    pub prefs: HashMap<String, Value>,
    pub connections: IndexMap<String, Connection>,
    pub subscriptions: IndexMap<String, Subscription>,
    /// The installed extensions' names, in order, and each one's source and version.
    pub extensions: Vec<String>,
    pub extension_info: HashMap<String, Extension>,
    pub credentials: IndexMap<String, Credential>,
    pub activities: IndexMap<String, Activity>,
    pub chats: HashMap<String, Chat>,
    pub transcripts: HashMap<String, Transcript>,
    /// Bumped on every change, and per chat and transcript on theirs.
    pub version: u64,
    pub chat_versions: HashMap<String, u64>,
    pub thread_versions: HashMap<String, u64>,
}

impl Brain {
    pub fn new() -> Self {
        let mut b = Self::default();
        b.spaces.insert(HOME.into(), home_row());
        b
    }

    fn touch_chat(&mut self, space: &str) {
        *self.chat_versions.entry(space.to_string()).or_default() += 1;
    }

    fn touch_thread(&mut self, thread: &str) {
        *self.thread_versions.entry(thread.to_string()).or_default() += 1;
    }

    pub fn chat_version(&self, space: &str) -> u64 {
        self.chat_versions.get(space).copied().unwrap_or(0)
    }

    pub fn thread_version(&self, thread: &str) -> u64 {
        self.thread_versions.get(thread).copied().unwrap_or(0)
    }

    /// The snapshot: everything the board shows, replacing what was held but what's still unsent.
    pub fn take_snapshot(&mut self, snap: Snapshot) {
        self.seq = snap.seq;
        self.ready = true;
        self.kept = false;
        self.spaces = snap.spaces;
        self.spaces.entry(HOME.into()).or_insert_with(home_row);
        self.threads = snap.threads;
        self.reads = snap.reads;
        self.replies = snap.replies;
        self.items = snap.items;
        self.placed = snap.placed;
        self.prefs = snap.prefs;
        self.connections = snap.connections;
        self.subscriptions = snap.subscriptions;
        self.extensions = snap.extensions.iter().map(|e| e.name.clone()).collect();
        self.extension_info = snap.extensions.into_iter().map(|e| (e.name.clone(), e)).collect();
        self.credentials = snap.credentials;
        self.activities = snap.activities;
        // What landed is in it (or gone with a restore): only what's still kept stays.
        self.pending.retain(|p| p.landed.is_none());
        self.warm.clear();
        for (space, seq) in &snap.warm {
            self.warm_up(space, *seq);
        }
        // A chat held but not in the snapshot has no lines now.
        let given: HashSet<String> = snap.chats.iter().map(|(s, _, _)| s.clone()).collect();
        let held: Vec<String> = self.chats.keys().filter(|s| !given.contains(*s)).cloned().collect();
        for space in held {
            self.chats.insert(space.clone(), Chat { loaded: true, ..Default::default() });
            self.touch_chat(&space);
        }
        let mut mentioned: Vec<(String, Arc<Line>)> = vec![];
        for (space, lines, more) in snap.chats {
            let lines: Vec<Arc<Line>> = lines.into_iter().map(Arc::new).collect();
            for l in &lines {
                if l.home == space {
                    for m in &l.mentions {
                        mentioned.push((m.clone(), l.clone()));
                    }
                }
            }
            let next = if more { lines.first().map(|l| l.seq) } else { None };
            self.chats.insert(space.clone(), Chat { lines, more, loaded: true, pages: 1, next, ..Default::default() });
            self.touch_chat(&space);
        }
        for (space, line) in mentioned {
            self.insert_line(&space, line);
        }
        // Transcripts were paged against the log before the snapshot: page them again.
        for t in self.transcripts.values_mut() {
            t.loaded = false;
        }
        let threads: Vec<String> = self.transcripts.keys().cloned().collect();
        for t in threads {
            self.touch_thread(&t);
        }
        self.version += 1;
    }

    /// Live events, folded in order.
    pub fn apply(&mut self, events: &[Event]) {
        for e in events {
            self.fold(e);
            self.seq = e.seq;
        }
        let seq = self.seq;
        let gone: Vec<String> = self.pending.iter().filter(|p| p.landed.is_some_and(|l| l <= seq)).map(|p| p.space.clone()).collect();
        self.pending.retain(|p| !p.landed.is_some_and(|l| l <= seq));
        for space in gone {
            self.touch_chat(&space);
        }
        self.version += 1;
    }

    fn warm_up(&mut self, space: &str, seq: u64) {
        let mut seen = HashSet::new();
        let mut at = self.spaces.get(space).map(|s| (s.id.clone(), s.parent.clone()));
        while let Some((id, parent)) = at {
            if !seen.insert(id.clone()) {
                break;
            }
            let w = self.warm.entry(id).or_default();
            *w = (*w).max(seq);
            at = parent.and_then(|p| self.spaces.get(&p)).map(|s| (s.id.clone(), s.parent.clone()));
        }
    }

    /// Read through `seq`: the read mark only moves forward.
    pub fn read_to(&mut self, space: &str, seq: u64) {
        let r = self.reads.entry(space.to_string()).or_default();
        if seq > *r {
            *r = seq;
            self.version += 1;
        }
    }

    /// A space made by the user, shown before the brain says so.
    pub fn made_space(&mut self, id: &str, name: &str, parent: Option<&str>) {
        let made = self.spaces.len() as f64 + 1.;
        let parent = if id == HOME { None } else { Some(parent.filter(|p| !p.is_empty()).unwrap_or(HOME).to_string()) };
        self.spaces.insert(
            id.to_string(),
            SpaceRow { id: id.into(), name: name.into(), parent, archived: false, ink: None, made, cover: None, about: String::new(), ephemeral: false },
        );
        self.version += 1;
    }

    fn fold(&mut self, e: &Event) {
        let p = &e.payload;
        let kind = e.kind.as_str();
        if kind == "space.read" {
            self.read_to(&gs(p, "space"), gu(p, "seq"));
        } else if kind.starts_with("space.") {
            self.fold_space(e);
        } else if kind.starts_with("thread.") || kind.starts_with("turn.") {
            self.fold_turn(e);
        } else if kind == "gate.decided" {
            // A reply the gate bounced: its draft goes, and the revision takes its place.
            if gs(p, "exit") == "reply" && get(p, "pass").as_bool() == Some(false) {
                let turn = gs(p, "turn");
                let text = gs(p, "text").trim().to_string();
                for t in self.threads.values_mut() {
                    if t.turn.as_deref() == Some(turn.as_str()) || t.items.iter().any(|i| i.turn == turn) {
                        t.rejected.insert(text.clone());
                    }
                }
            }
        } else if kind == "message.posted" {
            let line = posted_line(e);
            let at = line.home.clone();
            self.warm_up(&at, e.seq);
            // A peer's words are neither the space's reply nor the user's reading of it.
            if e.source == "agent" {
                self.replies.insert(at.clone(), e.seq);
            } else if e.source != "peer" {
                self.read_to(&at, e.seq);
            }
            let before = self.pending.len();
            self.pending.retain(|p| !e.id.starts_with(&format!("{}:", p.id)));
            if self.pending.len() != before {
                self.touch_chat(&at);
            }
            self.insert_line(&at, Arc::new(line));
        } else if kind.starts_with("item.") {
            self.items.fold(kind, e.time, p);
        } else if kind.starts_with("widget.") {
            crate::items::fold_placed(&mut self.placed, kind, p);
        } else if kind.starts_with("credential.") {
            self.fold_credential(e);
        } else if kind == "iphone.activity" {
            let id = gs(p, "id");
            if gs(p, "phase") == "end" {
                self.activities.shift_remove(&id);
            } else {
                self.activities.insert(id, activity_of(p));
            }
        } else if kind == "memory.written" || kind == "setting.set" {
            if let Some(line) = learned_line(e) {
                let at = line.home.clone();
                self.insert_line(&at, Arc::new(line));
            }
        } else if kind == "memory.forgotten" {
            self.forgotten(&gs(p, "id"));
        } else if kind == "message.moved" {
            // Both chats as the brain now has them: the lines gone from one, in the other.
            for key in ["from", "to"] {
                self.stale_chat(&gs(p, key));
            }
        } else if kind == "message.edited" {
            self.edited(e);
        } else if kind == "message.revised" {
            self.revised(e);
        } else if kind == "message.reacted" {
            self.reacted(e);
        } else if kind == "triage.sorted" {
            for i in list(get(p, "items")) {
                if !gb(i, "line") {
                    continue;
                }
                let space = gs(i, "space");
                let (text, time) = (gs(i, "note"), gn(i, "time"));
                if let Some(same) = get(i, "same").as_f64() {
                    // A condition's line, revised in place as it continues.
                    self.edit_line_in(&space, same as u64, |l| {
                        l.text = text.clone();
                        l.quiet = Some(Quiet::Event { until: time });
                    });
                } else {
                    let line = Line { quiet: Some(Quiet::Event { until: time }), ..Line::bare(gu(i, "seq"), time, Who::Agent, text, space.clone()) };
                    self.insert_line(&space, Arc::new(line));
                }
            }
        } else {
            self.fold_board(e);
        }
    }

    fn stale_chat(&mut self, space: &str) {
        if let Some(c) = self.chats.get_mut(space) {
            c.stale = true;
            self.touch_chat(space);
        }
    }

    fn fold_space(&mut self, e: &Event) {
        let p = &e.payload;
        let id = gs(p, "id");
        match e.kind.as_str() {
            "space.created" => {
                self.made_space(&id, &gs(p, "name"), opt(p, "parent").as_deref());
                if let Some(made) = self.spaces.get_mut(&id) {
                    made.about = gs(p, "about");
                    made.ephemeral = gb(p, "ephemeral");
                }
                self.chats.entry(id.clone()).or_insert_with(|| Chat { loaded: true, ..Default::default() });
                self.touch_chat(&id);
            }
            "space.tagged" => {
                let seq = gu(p, "seq");
                let home = gs(p, "home");
                // The tag of a thread's opening says its space.
                for t in self.threads.values_mut() {
                    if t.opened == seq {
                        t.home = Some(home.clone());
                    }
                }
                self.tagged(seq, home, list(get(p, "mentions")).iter().map(s).collect());
            }
            kind => {
                let Some(sp) = self.spaces.get_mut(&id) else { return };
                match kind {
                    "space.inked" => sp.ink = Some((gs(p, "day"), gs(p, "night"))),
                    "space.renamed" => sp.name = gs(p, "name"),
                    "space.described" => sp.about = gs(p, "about"),
                    "space.cover_set" => sp.cover = get(p, "image").as_str().map(str::to_string),
                    "space.moved" => sp.parent = Some(gs(p, "parent")),
                    "space.archived" => sp.archived = true,
                    "space.promoted" => sp.ephemeral = false,
                    "space.unarchived" => {
                        sp.archived = false;
                        // Its chat left the snapshot while archived.
                        self.stale_chat(&id);
                    }
                    _ => {}
                }
            }
        }
    }

    fn fold_turn(&mut self, e: &Event) {
        let p = &e.payload;
        let thread = gs(p, "thread");
        let turn = gs(p, "turn");
        if e.kind == "thread.opened" {
            self.threads.insert(
                thread.clone(),
                ThreadRow {
                    id: thread.clone(),
                    parent: get(p, "parent").as_str().map(str::to_string),
                    title: gs(p, "title"),
                    status: Status::Idle,
                    turn: None,
                    opened: e.seq,
                    home: thread.strip_prefix("space:").map(str::to_string),
                    since: e.time,
                    result: String::new(),
                    streaming: String::new(),
                    items: vec![],
                    rejected: HashSet::new(),
                    stage: String::new(),
                    woken: false,
                    sensed: false,
                },
            );
            self.touch_thread(&thread);
            return;
        }
        let item = item_of_event(e);
        if let Some(t) = self.threads.get_mut(&thread) {
            let same = t.turn.as_deref() == Some(turn.as_str());
            match e.kind.as_str() {
                // A turn starting: none of the user's words in it is a wake; the senses' one says so.
                "turn.started" => {
                    t.status = Status::Running;
                    t.turn = Some(turn.clone());
                    t.since = e.time;
                    t.streaming.clear();
                    t.result.clear();
                    t.items.clear();
                    t.stage.clear();
                    t.woken = gs(p, "text").trim().is_empty();
                    t.sensed = t.woken && gb(p, "sensed");
                }
                // A steer of theirs joining its turn makes it theirs; the senses' wake, sensed.
                "turn.injected" if same => {
                    if gs(p, "kind") == "steer" {
                        t.woken = false;
                        t.sensed = false;
                    } else if gb(p, "sensed") {
                        t.sensed = t.woken;
                    }
                }
                // What its turn left going has stopped: it's done.
                "thread.settled" if same && t.status == Status::Waiting => {
                    t.status = Status::Done;
                    t.result.clear();
                }
                "thread.staged" => t.stage = gs(p, "stage").trim().to_string(),
                "turn.delta" => t.streaming.push_str(&gs(p, "text")),
                "turn.text" => t.streaming.clear(),
                // Done while its work goes on elsewhere (a watch, a script), it waits until `thread.settled`.
                "turn.ended" if same => {
                    t.status = match gs(p, "status").as_str() {
                        "failed" => Status::Failed,
                        "limited" => Status::Limited,
                        "interrupted" => Status::Interrupted,
                        _ if gb(p, "going") => Status::Waiting,
                        _ => Status::Done,
                    };
                    t.result = if t.status == Status::Done { String::new() } else { gs(p, "result") };
                    t.since = e.time;
                    t.streaming.clear();
                }
                _ => {}
            }
            if let Some(item) = &item
                && t.turn.as_deref() == Some(item.turn.as_str())
            {
                t.items.push(item.clone());
            }
        }
        // An entry lands in an opened thread's transcript.
        if let Some(item) = item
            && let Some(tr) = self.transcripts.get_mut(&thread)
            && tr.loaded
            && !tr.items.iter().any(|i| i.seq == item.seq)
        {
            tr.items.push(item);
        }
        self.touch_thread(&thread);
    }

    /// A credential's events: requested, issued, approved, denied, revoked.
    fn fold_credential(&mut self, e: &Event) {
        let p = &e.payload;
        let id = gs(p, "id");
        match e.kind.as_str() {
            "credential.requested" => {
                self.credentials.insert(id, credential_of(p, Some(CredentialStatus::Pending), e.time));
            }
            "credential.issued" => {
                self.credentials.insert(id, credential_of(p, Some(CredentialStatus::Active), e.time));
            }
            "credential.approved" => {
                if let Some(c) = self.credentials.get_mut(&id) {
                    c.status = CredentialStatus::Active;
                    c.code = None;
                }
            }
            "credential.denied" => {
                self.credentials.shift_remove(&id);
            }
            "credential.revoked" => {
                if let Some(c) = self.credentials.get_mut(&id) {
                    c.status = CredentialStatus::Revoked;
                    c.code = None;
                } else {
                    // `spur:<name>` before extensions were renamed.
                    let name = id.strip_prefix("extension:").or_else(|| id.strip_prefix("spur:")).unwrap_or(&id).to_string();
                    let raw = serde_json::json!({ "id": id, "name": name, "kind": "extension" });
                    self.credentials.insert(id, credential_of(&raw, Some(CredentialStatus::Revoked), e.time));
                }
            }
            _ => {}
        }
    }

    /// Connections, prefs, widget placements, extensions and the subscriptions the agent runs on.
    fn fold_board(&mut self, e: &Event) {
        let p = &e.payload;
        let id = gs(p, "id");
        match e.kind.as_str() {
            "connection.added" => {
                self.connections.insert(id, connection_of(p));
            }
            "connection.scopes_changed" => {
                if let Some(c) = self.connections.get_mut(&id) {
                    c.scopes = strings(get(p, "scopes"));
                }
            }
            "connection.removed" => {
                self.connections.shift_remove(&id);
            }
            "pref.set" => {
                self.prefs.insert(gs(p, "key"), get(p, "value").clone());
            }
            // `spur.*` as the log has them from before extensions were renamed.
            "extension.installed" | "extension.updated" | "spur.installed" | "spur.updated" => {
                let x = extension_of(p);
                if !self.extensions.contains(&x.name) {
                    self.extensions.push(x.name.clone());
                }
                self.extension_info.insert(x.name.clone(), x);
            }
            "extension.removed" | "spur.removed" => {
                let name = name_of(p);
                self.extensions.retain(|x| *x != name);
                self.extension_info.remove(&name);
            }
            "account.state" => {
                // `account.state` doesn't carry the label: the one the snapshot gave stays.
                let host = gs(p, "host");
                let label = self.subscriptions.get(&host).map(|s| s.label.clone());
                self.subscriptions.insert(host, subscription_of(p, label));
            }
            "account.removed" => {
                self.subscriptions.shift_remove(&gs(p, "host"));
            }
            // A login found to be another's account is that account's now.
            "model.catalog" => {
                for a in list(get(p, "accounts")) {
                    for from in list(get(a, "same")) {
                        self.subscriptions.shift_remove(&s(from));
                    }
                }
            }
            _ => {}
        }
    }

    /// Puts a line in a held chat, in seq order, once.
    fn insert_line(&mut self, space: &str, line: Arc<Line>) {
        let Some(chat) = self.chats.get_mut(space) else { return };
        let at = chat.lines.partition_point(|l| l.seq <= line.seq);
        if at > 0 && chat.lines[at - 1].seq == line.seq {
            return;
        }
        chat.lines.insert(at, line);
        self.touch_chat(space);
    }

    /// A line held in a chat, by seq.
    pub fn find_line(&self, seq: u64) -> Option<Arc<Line>> {
        self.chats.values().flat_map(|c| c.lines.iter()).find(|l| l.seq == seq).cloned()
    }

    /// Changes line `seq` in every chat that holds it.
    fn edit_line(&mut self, seq: u64, change: impl Fn(&mut Line)) {
        let mut touched = vec![];
        for (space, chat) in &mut self.chats {
            for l in &mut chat.lines {
                if l.seq == seq {
                    change(Arc::make_mut(l));
                    touched.push(space.clone());
                }
            }
        }
        for space in touched {
            self.touch_chat(&space);
        }
        self.version += 1;
    }

    /// Changes line `seq` in one space's chat.
    fn edit_line_in(&mut self, space: &str, seq: u64, change: impl Fn(&mut Line)) {
        let Some(chat) = self.chats.get_mut(space) else { return };
        let mut hit = false;
        for l in &mut chat.lines {
            if l.seq == seq {
                change(Arc::make_mut(l));
                hit = true;
            }
        }
        if hit {
            self.touch_chat(space);
        }
    }

    /// A retag moves the line to its new home and the chats it bears on.
    fn tagged(&mut self, seq: u64, home: String, mentions: Vec<String>) {
        let Some(line) = self.find_line(seq) else { return };
        let mut named = (*line).clone();
        named.home = home.clone();
        named.mentions = mentions.clone();
        let named = Arc::new(named);
        let mut touched = vec![];
        for (space, chat) in &mut self.chats {
            let keep = *space == home || mentions.contains(space);
            let before = chat.lines.len();
            if keep {
                for l in &mut chat.lines {
                    if l.seq == seq {
                        *l = named.clone();
                    }
                }
            } else {
                chat.lines.retain(|l| l.seq != seq);
            }
            if keep || chat.lines.len() != before {
                touched.push(space.clone());
            }
        }
        for space in touched {
            self.touch_chat(&space);
        }
        let mut to = mentions;
        if line.home != home {
            to.insert(0, home);
        }
        for m in to {
            self.insert_line(&m, named.clone());
        }
    }

    /// A memory forgotten: its "Remembered" lines go.
    fn forgotten(&mut self, id: &str) {
        let mut touched = vec![];
        for (space, chat) in &mut self.chats {
            let before = chat.lines.len();
            chat.lines.retain(|l| !matches!(&l.quiet, Some(Quiet::Learned { id: x, .. }) if x == id));
            if chat.lines.len() != before {
                touched.push(space.clone());
            }
        }
        for space in touched {
            self.touch_chat(&space);
        }
    }

    /// The user's last message, changed: its new words, and the replies to the old ones gone.
    fn edited(&mut self, e: &Event) {
        let seq = gu(&e.payload, "seq");
        let text = gs(&e.payload, "text");
        let Some(line) = self.find_line(seq) else { return };
        for space in std::iter::once(&line.home).chain(line.mentions.iter()) {
            if let Some(chat) = self.chats.get_mut(space) {
                chat.lines.retain(|l| !(l.who == Who::Agent && l.quiet.is_none() && l.home == line.home && l.seq > seq && l.seq < e.seq));
            }
            self.edit_line_in(space, seq, |l| l.text = text.clone());
        }
    }

    /// A reply of the agent's, revised in place: its new words, marked edited; nothing else changes.
    fn revised(&mut self, e: &Event) {
        let seq = gu(&e.payload, "seq");
        let text = gs(&e.payload, "text");
        let Some(line) = self.find_line(seq) else { return };
        for space in std::iter::once(&line.home).chain(line.mentions.iter()) {
            self.edit_line_in(space, seq, |l| {
                l.text = text.clone();
                l.edited = true;
            });
        }
    }

    /// A reaction lands: one on words of the message is theirs alone; without, it's on the whole message.
    fn reacted(&mut self, e: &Event) {
        let p = &e.payload;
        let words = gs(get(p, "quote"), "text");
        let user = e.source != "agent";
        let reaction = reaction_of(get(p, "reaction"));
        if words.is_empty() {
            self.set_reaction(gu(p, "seq"), user, reaction);
        } else {
            self.set_part(gu(p, "seq"), user, &words, reaction);
        }
    }

    /// A side's tapback on line `seq`, in every chat that holds it; none takes it off.
    pub fn set_reaction(&mut self, seq: u64, user: bool, reaction: Option<String>) {
        self.edit_line(seq, |l| {
            if user {
                l.reactions.user = reaction.clone();
            } else {
                l.reactions.agent = reaction.clone();
            }
        });
    }

    /// A side's reaction to words of line `seq`, in every chat that holds it; none takes it off.
    pub fn set_part(&mut self, seq: u64, user: bool, text: &str, reaction: Option<String>) {
        self.edit_line(seq, |l| {
            l.parts.retain(|x| x.user != user || x.text != text);
            if let Some(r) = &reaction {
                l.parts.push(PartReaction { user, reaction: r.clone(), text: text.to_string() });
            }
        });
    }

    /// The user's reaction to these words of line `seq`, if they've made one.
    pub fn part_of(&self, seq: u64, text: &str) -> Option<String> {
        self.find_line(seq)?.parts.iter().find(|x| x.user && x.text == text).map(|x| x.reaction.clone())
    }

    /// Read through `seq`: the read mark only moves forward.
    pub fn read_mark(&mut self, space: &str, seq: u64) {
        self.read_to(space, seq);
    }

    /// The latest reply in the space's own chat, if the user hasn't read that far.
    pub fn unread_at(&self, space: &str) -> Option<u64> {
        let reply = self.replies.get(space).copied().unwrap_or(0);
        (reply > self.reads.get(space).copied().unwrap_or(0)).then_some(reply)
    }

    /// A chat's page came: the first puts the chat in (with any lines that came live meanwhile),
    /// an older one goes before what's held.
    pub fn take_chat_page(&mut self, space: &str, value: &Value, first: bool) {
        let lines: Vec<Arc<Line>> = list(get(value, "lines")).iter().map(|l| Arc::new(line_of(l))).collect();
        let more = gb(value, "more");
        let next = next_of(value, "lines");
        let chat = self.chats.entry(space.to_string()).or_default();
        chat.fetching = false;
        if first {
            let newest = lines.last().map(|l| l.seq).unwrap_or(0);
            let live: Vec<Arc<Line>> = chat.lines.iter().filter(|l| l.seq > newest).cloned().collect();
            chat.lines = lines;
            chat.lines.extend(live);
            chat.more = more;
            chat.loaded = true;
            chat.stale = false;
            chat.pages = 1;
            chat.failures = 0;
            chat.retry_at = None;
        } else {
            let oldest = chat.lines.first().map(|l| l.seq).unwrap_or(u64::MAX);
            let mut older: Vec<Arc<Line>> = lines.into_iter().filter(|l| l.seq < oldest).collect();
            older.append(&mut chat.lines);
            chat.lines = older;
            chat.more = more;
            chat.pages += 1;
        }
        chat.next = next;
        self.touch_chat(space);
        self.version += 1;
    }

    /// A chat refetched whole, its pages newest first, as an infinite query refetches each page it
    /// held: they replace what's held, with lines that came live meanwhile.
    pub fn take_chat_pages(&mut self, space: &str, pages: &[Value]) {
        let Some((last, _)) = pages.split_last() else { return };
        let mut lines: Vec<Arc<Line>> = vec![];
        for p in pages.iter().rev() {
            lines.extend(list(get(p, "lines")).iter().map(|l| Arc::new(line_of(l))));
        }
        let chat = self.chats.entry(space.to_string()).or_default();
        let newest = lines.last().map(|l| l.seq).unwrap_or(0);
        let live: Vec<Arc<Line>> = chat.lines.iter().filter(|l| l.seq > newest).cloned().collect();
        lines.extend(live);
        chat.lines = lines;
        chat.more = gb(last, "more");
        chat.loaded = true;
        chat.stale = false;
        chat.fetching = false;
        chat.pages = pages.len();
        chat.next = next_of(last, "lines");
        chat.failures = 0;
        chat.retry_at = None;
        self.touch_chat(space);
        self.version += 1;
    }

    pub fn take_thread_page(&mut self, thread: &str, value: &Value, first: bool) {
        let items: Vec<Item> = list(get(value, "items")).iter().map(item_of).collect();
        let more = gb(value, "more");
        let rejected: Vec<String> = list(get(value, "rejected")).iter().map(|r| s(r).trim().to_string()).collect();
        let tr = self.transcripts.entry(thread.to_string()).or_default();
        tr.fetching = false;
        tr.failed = None;
        if first {
            let newest = items.last().map(|i| i.seq).unwrap_or(0);
            let live: Vec<Item> = tr.items.iter().filter(|i| i.seq > newest).cloned().collect();
            tr.items = items;
            tr.items.extend(live);
            tr.loaded = true;
            tr.pages = 1;
        } else {
            let oldest = tr.items.first().map(|i| i.seq).unwrap_or(u64::MAX);
            let mut older: Vec<Item> = items.into_iter().filter(|i| i.seq < oldest).collect();
            older.append(&mut tr.items);
            tr.items = older;
            tr.pages += 1;
        }
        tr.more = more;
        tr.next = next_of(value, "items");
        tr.rejected.extend(rejected);
        self.touch_thread(thread);
        self.version += 1;
    }

    /// A transcript refetched whole, its pages newest first (an infinite query refetching each page
    /// it held): they replace what's held, with entries that came live meanwhile.
    pub fn take_thread_pages(&mut self, thread: &str, pages: &[Value]) {
        let Some((last, _)) = pages.split_last() else { return };
        let mut items: Vec<Item> = vec![];
        let mut rejected: HashSet<String> = HashSet::new();
        for p in pages.iter().rev() {
            items.extend(list(get(p, "items")).iter().map(item_of));
            rejected.extend(list(get(p, "rejected")).iter().map(|r| s(r).trim().to_string()));
        }
        let tr = self.transcripts.entry(thread.to_string()).or_default();
        let newest = items.last().map(|i| i.seq).unwrap_or(0);
        let live: Vec<Item> = tr.items.iter().filter(|i| i.seq > newest).cloned().collect();
        items.extend(live);
        tr.items = items;
        tr.rejected = rejected;
        tr.more = gb(last, "more");
        tr.loaded = true;
        tr.fetching = false;
        tr.failed = None;
        tr.pages = pages.len();
        tr.next = next_of(last, "items");
        self.touch_thread(thread);
        self.version += 1;
    }

    /// A thread's transcript as its page shows it: the pages, then its latest turn's entries the
    /// snapshot and live events brought that the pages don't have yet; and the drafts the gate
    /// sent back.
    pub fn transcript(&self, thread: &str) -> (Vec<Item>, HashSet<String>) {
        let mut items = self.transcripts.get(thread).map(|t| t.items.clone()).unwrap_or_default();
        let mut rejected = self.transcripts.get(thread).map(|t| t.rejected.clone()).unwrap_or_default();
        if let Some(t) = self.threads.get(thread) {
            let last = items.last().map(|i| i.seq).unwrap_or(0);
            items.extend(t.items.iter().filter(|i| i.seq > last).cloned());
            rejected.extend(t.rejected.iter().cloned());
        }
        (items, rejected)
    }

    /// The chat's pending messages follow the outbox: kept, sent, said no to, or given back.
    pub fn follow_outbox(&mut self, now: Vec<Pending>) -> bool {
        let held: Vec<&Pending> = self.pending.iter().filter(|p| p.landed.is_none()).collect();
        if held.len() == now.len() && held.iter().zip(&now).all(|(a, b)| **a == *b) {
            return false;
        }
        let ids: HashSet<&str> = now.iter().map(|p| p.id.as_str()).collect();
        let mut touched: HashSet<String> = HashSet::new();
        self.pending.retain(|p| {
            let keep = ids.contains(p.id.as_str()) || p.landed.is_some();
            if !keep {
                touched.insert(p.space.clone());
            }
            keep
        });
        for p in now {
            touched.insert(p.space.clone());
            match self.pending.iter_mut().find(|x| x.id == p.id) {
                Some(x) => *x = Pending { landed: x.landed, ..p },
                None => self.pending.push(p),
            }
        }
        for space in touched {
            self.touch_chat(&space);
        }
        self.version += 1;
        true
    }

    /// The core took a message as of `seq`: it shows as sent until the log reaches it.
    pub fn landed(&mut self, id: &str, seq: u64) {
        let now = self.seq;
        let Some(at) = self.pending.iter().position(|p| p.id == id) else { return };
        let space = self.pending[at].space.clone();
        if now >= seq {
            self.pending.remove(at);
        } else {
            self.pending[at].landed = Some(seq);
        }
        self.touch_chat(&space);
        self.version += 1;
    }
}

/// A turn event as a transcript entry, or none for one that isn't.
pub fn item_of_event(e: &Event) -> Option<Item> {
    let p = &e.payload;
    let base = |kind: ItemKind, text: String| Item { seq: e.seq, turn: gs(p, "turn"), kind, text, id: String::new(), name: String::new(), input: Value::String(String::new()), error: false };
    Some(match e.kind.as_str() {
        "turn.started" => base(ItemKind::User, gs(p, "text")),
        "turn.text" => base(ItemKind::Text, gs(p, "text")),
        // None given is no words (`undefined`), as the transcript's own.
        "turn.tool" => Item { id: gs(p, "id"), name: gs(p, "name"), input: p.get("input").cloned().unwrap_or_else(|| Value::String(String::new())), ..base(ItemKind::Tool, String::new()) },
        "turn.result" => Item { id: gs(p, "id"), error: gb(p, "error"), ..base(ItemKind::Result, gs(p, "output")) },
        "turn.injected" => base(if gs(p, "kind") == "wake" { ItemKind::Wake } else { ItemKind::Steer }, gs(p, "text")),
        _ => return None,
    })
}
