//! Action items as the window reads them (the desktop's `brain/items.ts` and the items part of
//! `brain/adapter.ts`): the snapshot's `actions` are the open ones, oldest first, and
//! `closedActions` the latest closed, newest first; `item.opened`, `.revised` and `.reopened` carry
//! the whole item, `item.closed` and `.answered` close it, `.edited` keeps the user's own version of
//! its drafts, `.ran` says whether what Approve ran went through. How a closed one ended, and what
//! came of it, are `ask-outcome.ts`.

use std::collections::{BTreeMap, HashMap};

use serde_json::Value;

use crate::json::{get, gn, gs, list, opt};

/// How many closed items are kept, to reopen.
const CLOSED: usize = 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Task,
    Question,
    Approval,
    Sealed,
}

impl Kind {
    /// What the card's head calls it.
    pub fn label(self) -> &'static str {
        match self {
            Kind::Task => "To do",
            Kind::Question => "Question",
            Kind::Approval => "Approval",
            Kind::Sealed => "Secret",
        }
    }
}

/// An extension's tool, called with `args`.
#[derive(Clone, Debug, PartialEq)]
pub struct Call {
    pub app: String,
    pub tool: String,
    pub args: Value,
}

/// An assist key: an app's tool, called from the card.
#[derive(Clone, Debug, PartialEq)]
pub struct Action {
    pub label: String,
    pub call: Call,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Draft {
    pub name: String,
    pub label: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Attachment {
    pub name: String,
    pub kind: String,
    pub size: Option<f64>,
    pub blob: Option<String>,
    pub url: Option<String>,
    /// The option it goes with, on a question: its index, as the item says it (a number).
    pub option: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WebLink {
    pub label: String,
    pub url: String,
}

/// A closed one's answer: Approve or Decline, the option picked, the words typed, each draft as
/// approved.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Answer {
    pub approved: Option<bool>,
    pub choice: Option<String>,
    pub text: Option<String>,
    pub drafts: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Sealed {
    pub key: String,
    pub usage: String,
}

/// A live view on the card: the Mac's screen, about an app's session (core/portal.ts).
#[derive(Clone, Debug, PartialEq)]
pub struct Portal {
    pub app: String,
    pub session: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ActionItem {
    pub id: String,
    pub space: String,
    pub title: String,
    pub body: String,
    pub action: Option<Action>,
    pub kind: Kind,
    /// Only its owner (the extension) closes it: nothing to answer here.
    pub owner_completes: bool,
    pub options: Vec<String>,
    pub drafts: Vec<Draft>,
    pub links: Vec<WebLink>,
    pub attachments: Vec<Attachment>,
    pub send: Option<Call>,
    pub app: Option<String>,
    pub sealed: Option<Sealed>,
    pub portal: Option<Portal>,
    /// Out of the user's queue while the agent reworks it.
    pub revising: bool,
    /// The user's own version of drafts, by name, saved as he edits (not an approval).
    pub edits: BTreeMap<String, String>,
    /// The model that wrote it: its name.
    pub model: Option<String>,
    pub answer: Option<Answer>,
    /// Whether what Approve ran went through.
    pub ran: Option<bool>,
    /// When it opened, for order.
    pub at: f64,
    /// How it closed, once it has: "open" until then.
    pub status: String,
    pub closed_at: Option<f64>,
}

fn texts_of(v: &Value) -> BTreeMap<String, String> {
    v.as_object().map(|o| o.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect()).unwrap_or_default()
}

fn call_of(v: &Value) -> Option<Call> {
    let app = v.get("app")?.as_str()?.to_string();
    let tool = v.get("tool")?.as_str()?.to_string();
    Some(Call { app, tool, args: v.get("args").cloned().filter(Value::is_object).unwrap_or(Value::Object(Default::default())) })
}

/// An answer's fields, as far as they read.
pub fn answer_of(p: &Value) -> Answer {
    Answer {
        approved: get(p, "approved").as_bool(),
        choice: get(p, "choice").as_str().map(str::to_string),
        text: get(p, "text").as_str().map(str::to_string),
        drafts: p.get("drafts").map(texts_of),
    }
}

impl ActionItem {
    /// An item from the snapshot or an event; none when it isn't one.
    pub fn of(raw: &Value, at: f64) -> Option<Self> {
        // Its fields as items.ts checks them (autonomy's schema): one that doesn't read is left out,
        // said in the log, and the rest still show.
        if let Err(e) = serde_json::from_value::<check::Fields>(raw.clone()) {
            log::warn!("an action item didn't read: {e}");
            return None;
        }
        let id = gs(raw, "id");
        if id.is_empty() || !raw.is_object() {
            return None;
        }
        let options: Vec<String> = list(get(raw, "options")).iter().filter_map(|o| o.as_str().map(str::to_string)).collect();
        let drafts: Vec<Draft> = list(get(raw, "drafts"))
            .iter()
            .map(|d| Draft { name: gs(d, "name"), label: gs(d, "label"), text: gs(d, "text") })
            .collect();
        let send = raw.get("send").and_then(call_of);
        let has_drafts = raw.get("drafts").is_some_and(Value::is_array);
        let kind = match gs(raw, "kind").as_str() {
            "task" => Kind::Task,
            "question" => Kind::Question,
            "approval" => Kind::Approval,
            "sealed" => Kind::Sealed,
            // An approval's when it has words to send or a call to make, a question's when it has options.
            _ if send.is_some() || has_drafts => Kind::Approval,
            _ if !options.is_empty() => Kind::Question,
            _ => Kind::Task,
        };
        let action = raw.get("action").and_then(|a| Some(Action { label: a.get("label")?.as_str()?.to_string(), call: call_of(a)? }));
        let seq = raw.get("seq").and_then(Value::as_f64);
        Some(ActionItem {
            space: gs(raw, "space"),
            title: gs(raw, "title"),
            body: gs(raw, "body"),
            action,
            kind,
            owner_completes: gs(raw, "completion") == "owner",
            options,
            drafts,
            links: list(get(raw, "links"))
                .iter()
                .filter_map(|l| {
                    let url = gs(l, "url");
                    (url.starts_with("http://") || url.starts_with("https://")).then(|| WebLink { label: gs(l, "label"), url })
                })
                .collect(),
            attachments: list(get(raw, "attachments"))
                .iter()
                .map(|a| Attachment {
                    name: gs(a, "name"),
                    kind: gs(a, "type"),
                    size: get(a, "size").as_f64(),
                    blob: opt(a, "blob"),
                    url: opt(a, "url"),
                    option: get(a, "option").as_f64(),
                })
                .collect(),
            send,
            app: opt(raw, "app"),
            sealed: raw.get("sealed").and_then(|s| Some(Sealed { key: s.get("key")?.as_str()?.to_string(), usage: gs(s, "use") })),
            portal: raw.get("portal").and_then(|p| Some(Portal { app: p.get("app")?.as_str()?.to_string(), session: gs(p, "session") })),
            revising: raw.get("revising").is_some_and(|r| !r.is_null()),
            edits: texts_of(get(raw, "edits")),
            model: raw.get("model").and_then(|m| m.get("name").and_then(Value::as_str).or(m.as_str())).map(str::to_string),
            answer: raw.get("answer").filter(|a| a.is_object()).map(answer_of),
            ran: raw.get("ran").and_then(|r| r.get("ok")).and_then(Value::as_bool),
            at: seq.unwrap_or(at),
            status: opt(raw, "status").unwrap_or_else(|| "open".into()),
            closed_at: get(raw, "closedAt").as_f64(),
            id,
        })
    }

    pub fn is_open(&self) -> bool {
        self.status == "open"
    }

    /// A draft's words as the card shows them: the user's version, else the agent's.
    pub fn shown_text(&self, d: &Draft) -> String {
        self.edits.get(&d.name).cloned().unwrap_or_else(|| d.text.clone())
    }
}

/// How a closed ask ended (ask-outcome.ts `endingOf`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ending {
    Sent,
    Approved,
    Failed,
    Declined,
    Dismissed,
    Done,
}

pub fn ending_of(item: &ActionItem) -> Ending {
    let a = item.answer.as_ref();
    if item.status == "dismissed" {
        return Ending::Dismissed;
    }
    if a.and_then(|a| a.approved) == Some(false) {
        return Ending::Declined;
    }
    if item.ran == Some(false) {
        return Ending::Failed;
    }
    if a.and_then(|a| a.approved) == Some(true) {
        return if item.ran == Some(true) && !item.drafts.is_empty() { Ending::Sent } else { Ending::Approved };
    }
    Ending::Done
}

/// Who a draft goes to, from its label ("To Ann Lee <ann@x.com> · Re: …", "Email to ann@x.com"):
/// the name it gives, else the address; none when it names no one.
pub fn recipient_of(label: &str, to: Option<&str>) -> Option<String> {
    let head = label.split(" · ").next().unwrap_or("");
    let from_to = || to.filter(|t| !t.is_empty()).map(str::to_string);
    // `^(?:\p{L}+\s+)?to\s+(.+)$`, case-insensitive.
    let named = {
        let lower = head.to_lowercase();
        let words: Vec<&str> = head.split_whitespace().collect();
        let lw: Vec<String> = lower.split_whitespace().map(str::to_string).collect();
        let at = if lw.first().map(String::as_str) == Some("to") {
            Some(1)
        } else if lw.get(1).map(String::as_str) == Some("to") && words.first().is_some_and(|w| w.chars().all(char::is_alphabetic)) {
            Some(2)
        } else {
            None
        };
        at.filter(|&i| words.len() > i).map(|i| {
            // The rest of the head after "to", as written.
            let mut rest = head;
            for _ in 0..i {
                rest = rest.trim_start();
                rest = &rest[rest.find(char::is_whitespace).unwrap_or(rest.len())..];
            }
            rest.trim().to_string()
        })
    };
    let Some(named) = named.filter(|n| !n.is_empty()) else { return from_to() };
    let name = named.split(['<', '(']).next().unwrap_or("").trim();
    if !name.is_empty() {
        return Some(name.to_string());
    }
    let inner = named.find(['<', '(']).and_then(|s| {
        let rest = &named[s + 1..];
        rest.find(['>', ')']).map(|e| rest[..e].to_string())
    });
    Some(inner.unwrap_or(named))
}

/// What came of it, as data: an approved send's recipient and words as sent (his edit included), the
/// option picked or the words typed; none when nothing more than how it ended.
pub struct Detail {
    pub who: Option<String>,
    pub words: String,
}

pub fn detail_of(item: &ActionItem) -> Option<Detail> {
    let a = item.answer.as_ref();
    if let Some(choice) = a.and_then(|a| a.choice.clone()) {
        return Some(Detail { who: None, words: choice });
    }
    if let Some(text) = a.and_then(|a| a.text.clone()) {
        return Some(Detail { who: None, words: text });
    }
    let draft = item.drafts.first()?;
    if a.and_then(|a| a.approved) != Some(true) {
        return None;
    }
    let to = item.send.as_ref().and_then(|s| s.args.get("to")).and_then(Value::as_str);
    Some(Detail {
        who: recipient_of(&draft.label, to),
        words: a.and_then(|a| a.drafts.as_ref()).and_then(|d| d.get(&draft.name).cloned()).unwrap_or_else(|| item.shown_text(draft)),
    })
}

/// The items the brain holds: open, open while reworked, and the latest closed.
#[derive(Clone, Debug, Default)]
pub struct Items {
    pub open: HashMap<String, ActionItem>,
    pub revising: HashMap<String, ActionItem>,
    /// Newest first.
    pub closed: Vec<ActionItem>,
}

fn items_of(v: &Value) -> Vec<ActionItem> {
    list(v).iter().filter_map(|a| ActionItem::of(a, gn(a, "seq"))).collect()
}

impl Items {
    pub fn of_snapshot(st: &Value) -> Self {
        let mut open = HashMap::new();
        let mut revising = HashMap::new();
        for i in items_of(get(st, "actions")) {
            if i.revising { revising.insert(i.id.clone(), i) } else { open.insert(i.id.clone(), i) };
        }
        Items { open, revising, closed: items_of(get(st, "closedActions")) }
    }

    /// An item, open or lately closed.
    pub fn find(&self, id: &str) -> Option<&ActionItem> {
        self.open.get(id).or_else(|| self.revising.get(id)).or_else(|| self.closed.iter().find(|c| c.id == id))
    }

    /// A space's own open asks, oldest first.
    pub fn open_in(&self, space: &str) -> Vec<ActionItem> {
        let mut v: Vec<ActionItem> = self.open.values().filter(|a| a.space == space).cloned().collect();
        v.sort_by(|a, b| a.at.total_cmp(&b.at));
        v
    }

    /// A space's lately closed asks.
    pub fn closed_in(&self, space: &str) -> Vec<ActionItem> {
        self.closed.iter().filter(|a| a.space == space).cloned().collect()
    }

    fn close(&mut self, id: &str, status: String, time: f64, answer: Option<Answer>) {
        let Some(mut i) = self.open.remove(id).or_else(|| self.revising.remove(id)) else { return };
        self.open.remove(id);
        self.revising.remove(id);
        i.status = status;
        i.closed_at = Some(time);
        if answer.is_some() {
            i.answer = answer;
        }
        self.closed.insert(0, i);
        self.closed.truncate(CLOSED);
    }

    /// An item opened, revised, reopened, edited, closed or run.
    pub fn fold(&mut self, kind: &str, time: f64, p: &Value) {
        let id = gs(p, "id");
        match kind {
            "item.closed" => self.close(&id, gs(p, "status"), time, None),
            "item.answered" => self.close(&id, "answered".into(), time, Some(answer_of(p))),
            "item.ran" => {
                if let Some(c) = self.closed.iter_mut().find(|c| c.id == id) {
                    c.ran = Some(get(p, "ok").as_bool() == Some(true));
                }
            }
            "item.edited" => {
                let edits = texts_of(get(p, "drafts"));
                if let Some(was) = self.open.get_mut(&id).or(self.revising.get_mut(&id)) {
                    was.edits.extend(edits);
                }
            }
            "item.opened" | "item.revised" | "item.reopened" => {
                let was = self.open.get(&id).or_else(|| self.revising.get(&id)).cloned();
                let Some(mut i) = ActionItem::of(p, was.as_ref().map(|w| w.at).unwrap_or(time)) else { return };
                // The user's edits stay on the drafts a revision left as they were.
                if let Some(was) = was {
                    i.edits = was
                        .edits
                        .iter()
                        .filter(|(name, _)| {
                            let before = was.drafts.iter().find(|d| &d.name == *name).map(|d| &d.text);
                            before.is_some() && i.drafts.iter().find(|d| &d.name == *name).map(|d| &d.text) == before
                        })
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                }
                self.open.remove(&id);
                self.revising.remove(&id);
                self.closed.retain(|c| c.id != id);
                if i.revising { self.revising.insert(id, i) } else { self.open.insert(id, i) };
            }
            _ => {}
        }
    }
}

/// A widget placed in a space; a space's widgets keep the order of this list (adapter.ts `Widget`).
/// A widget may be placed more than once, each placement by its id (`<app>/<name>` its first,
/// `<app>/<name>#<n>` each other) with its own input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Placed {
    pub id: String,
    pub app: String,
    pub name: String,
    pub space: String,
    /// What its widget's tool is called with.
    pub input: Option<Value>,
}

impl Placed {
    /// Its surface's key: the placement's id.
    pub fn key(&self) -> String {
        self.id.clone()
    }

    /// Its widget's, as `/widgets` lists what extensions offer.
    pub fn widget(&self) -> String {
        format!("{}/{}", self.app, self.name)
    }
}

/// A placement's id in a `widget.*` event or the snapshot: the one it names, else its widget's first.
pub fn placement_id(w: &Value) -> String {
    let id = gs(w, "id");
    if id.is_empty() { format!("{}/{}", gs(w, "app"), gs(w, "name")) } else { id }
}

fn placed_of(w: &Value) -> Placed {
    let space = gs(w, "space");
    // One with no space shows in none, as adapter.ts reads it.
    Placed { id: placement_id(w), app: gs(w, "app"), name: gs(w, "name"), space, input: w.get("input").filter(|i| i.is_object()).cloned() }
}

pub fn placed_of_snapshot(st: &Value) -> Vec<Placed> {
    list(get(st, "widgets")).iter().map(placed_of).collect()
}

/// `widget.placed`, `.moved` and `.removed`, folded into the placements.
pub fn fold_placed(placed: &mut Vec<Placed>, kind: &str, p: &Value) {
    let w = placed_of(p);
    match kind {
        "widget.placed" | "widget.moved" => {
            if let Some(at) = placed.iter().position(|x| x.id == w.id) {
                placed.remove(at);
            }
            let there: Vec<usize> = placed.iter().enumerate().filter(|(_, x)| x.space == w.space).map(|(i, _)| i).collect();
            let index = gn(p, "index").max(0.).trunc() as usize;
            let to = match (there.get(index), there.last()) {
                (Some(&before), _) => before,
                (None, Some(&after)) => after + 1,
                _ => placed.len(),
            };
            placed.insert(to, w);
        }
        "widget.removed" => {
            if let Some(at) = placed.iter().position(|x| x.id == w.id) {
                placed.remove(at);
            }
        }
        _ => {}
    }
}

/// items.ts's schema, field by field: what an item must be to read.
mod check {
    use std::collections::HashMap;

    use serde::Deserialize;
    use serde_json::Value;

    #[derive(Deserialize)]
    struct Call {
        #[allow(dead_code)]
        app: String,
        #[allow(dead_code)]
        tool: String,
        #[allow(dead_code)]
        args: serde_json::Map<String, Value>,
    }

    #[derive(Deserialize)]
    #[allow(dead_code)]
    struct Action {
        label: String,
        app: String,
        tool: String,
        args: serde_json::Map<String, Value>,
    }

    #[derive(Deserialize)]
    #[allow(dead_code)]
    struct Draft {
        name: String,
        label: String,
        text: String,
    }

    #[derive(Deserialize)]
    #[allow(dead_code)]
    struct Link {
        label: String,
        #[serde(deserialize_with = "web")]
        url: String,
    }

    fn web<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
        let s = String::deserialize(d)?;
        if s.starts_with("http://") || s.starts_with("https://") { Ok(s) } else { Err(serde::de::Error::custom("a link isn't http(s)")) }
    }

    /// An optional key (`Schema.optionalKey`): absent is none, and present it must read; `null`
    /// doesn't, so an item with one is left out, as items.ts leaves it.
    fn some<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
        T::deserialize(d).map(Some)
    }
    fn finite<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
        let x = f64::deserialize(d)?;
        if x.is_finite() { Ok(Some(x)) } else { Err(serde::de::Error::custom("not finite")) }
    }

    #[derive(Deserialize)]
    #[allow(dead_code)]
    struct Attachment {
        name: String,
        #[serde(rename = "type")]
        kind: String,
        #[serde(default, deserialize_with = "finite")]
        size: Option<f64>,
        #[serde(default, deserialize_with = "some")]
        blob: Option<String>,
        #[serde(default, deserialize_with = "some")]
        url: Option<String>,
        #[serde(default, deserialize_with = "finite")]
        option: Option<f64>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "lowercase")]
    enum Kind {
        Task,
        Question,
        Approval,
        Sealed,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "lowercase")]
    enum Completion {
        Owner,
    }

    #[derive(Deserialize)]
    #[allow(dead_code)]
    struct Sealed {
        key: String,
        #[serde(rename = "use")]
        use_: String,
    }

    #[derive(Deserialize)]
    #[allow(dead_code)]
    struct Portal {
        app: String,
        session: String,
    }

    #[derive(Deserialize)]
    #[allow(dead_code)]
    struct Revising {
        #[serde(default, deserialize_with = "some")]
        thread: Option<String>,
    }

    #[derive(Deserialize)]
    #[allow(dead_code)]
    struct ModelTag {
        id: String,
        name: String,
        provider: String,
        account: String,
    }

    #[derive(Deserialize)]
    #[allow(dead_code)]
    struct Answer {
        #[serde(default, deserialize_with = "some")]
        approved: Option<bool>,
        #[serde(default, deserialize_with = "some")]
        choice: Option<String>,
        #[serde(default, deserialize_with = "some")]
        text: Option<String>,
        #[serde(default, deserialize_with = "some")]
        drafts: Option<HashMap<String, String>>,
    }

    #[derive(Deserialize)]
    #[allow(dead_code)]
    struct Ran {
        ok: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    #[allow(dead_code)]
    pub struct Fields {
        id: String,
        space: String,
        title: String,
        body: String,
        #[serde(default, deserialize_with = "some")]
        action: Option<Action>,
        #[serde(default, deserialize_with = "some")]
        kind: Option<Kind>,
        #[serde(default, deserialize_with = "some")]
        completion: Option<Completion>,
        #[serde(default, deserialize_with = "some")]
        options: Option<Vec<String>>,
        #[serde(default, deserialize_with = "some")]
        drafts: Option<Vec<Draft>>,
        #[serde(default, deserialize_with = "some")]
        links: Option<Vec<Link>>,
        #[serde(default, deserialize_with = "some")]
        attachments: Option<Vec<Attachment>>,
        #[serde(default, deserialize_with = "some")]
        send: Option<Call>,
        #[serde(default, deserialize_with = "some")]
        app: Option<String>,
        #[serde(default, deserialize_with = "some")]
        sealed: Option<Sealed>,
        #[serde(default, deserialize_with = "some")]
        portal: Option<Portal>,
        #[serde(default, deserialize_with = "some")]
        revising: Option<Revising>,
        #[serde(default, deserialize_with = "some")]
        edits: Option<HashMap<String, String>>,
        #[serde(default, deserialize_with = "some")]
        model: Option<ModelTag>,
        #[serde(default, deserialize_with = "some")]
        answer: Option<Answer>,
        #[serde(default, deserialize_with = "some")]
        ran: Option<Ran>,
        #[serde(default, deserialize_with = "finite")]
        seq: Option<f64>,
        #[serde(default, deserialize_with = "some")]
        status: Option<String>,
        #[serde(default)]
        closed_at: Option<Option<f64>>,
    }
}
