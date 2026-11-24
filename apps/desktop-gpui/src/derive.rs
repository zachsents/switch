//! What a space's page shows, read from the brain: the desktop's `derive.ts` and `look.ts`
//! stations. What every frame reads (marks, work, asks, children) is worked out once per change of
//! the brain (`Derived::of`), so the rail redraws (the runner's beat) read it rather than walk every
//! thread; the rest are functions of the brain.
// The typed API the views use; parts not yet drawn are still the API.
#![allow(dead_code)]

use std::collections::{HashMap, HashSet};

use crate::brain::{Activity, ActivityState, Ask, Attachment, Brain, HOME, ItemKind, Line, PartReaction, Pending, Quiet, Reactions, Reply, Shown, SpaceRow, Status, ThreadRow, Who};
use crate::items::Placed;
use crate::steps::{OWN_APPS, describe};

/// A station on its line: "K", "K03"; empty for Home; and its line's ink, day and night.
#[derive(Clone, Debug, Default)]
pub struct Station {
    pub code: String,
    pub ink: Option<(u32, u32)>,
}

/// A space's live marks, for it and the spaces under it.
#[derive(Clone, Copy, Debug, Default)]
pub struct Marks {
    pub running: bool,
    pub needs: usize,
    pub unread: bool,
}

/// Work under way in a space itself.
#[derive(Clone, Debug)]
pub struct Work {
    pub thread: String,
    pub title: String,
    pub stage: String,
    pub since: f64,
    /// Its live step ("Deploying"), while it runs.
    pub step: String,
}

#[derive(Default)]
pub struct Derived {
    pub version: u64,
    pub stations: HashMap<String, Station>,
    pub marks: HashMap<String, Marks>,
    /// Each space's own: running tasks, open asks, oldest first.
    pub running: HashMap<String, Vec<Work>>,
    pub asks: HashMap<String, Vec<Ask>>,
    /// The spaces right inside each, warmest first.
    pub children: HashMap<String, Vec<String>>,
}

/// The lines' inks (Tokyo Metro), each day and night.
const LINES: [(u32, u32); 8] = [
    (0x009BBF, 0x009BBF),
    (0x9C5E31, 0xB9794A),
    (0x8F76D6, 0x8F76D6),
    (0x3A53A4, 0x6F86D6),
    (0x00A497, 0x00A497),
    (0x8E9BA6, 0x9AA7B2),
    (0x5B7C99, 0x7D9AB6),
    (0x9E6A86, 0x9E6A86),
];
const FALLBACK: (u32, u32) = (0x8E9BA6, 0x9AA7B2);

pub fn hex(s: &str) -> Option<u32> {
    // Any CSS color, as the desktop draws a space's ink (`#abc`, `#aabbcc`, `rgb(…)`, a name).
    let c = csscolorparser::parse(s.trim()).ok()?;
    let [r, g, b, _] = c.to_rgba8();
    Some(((r as u32) << 16) | ((g as u32) << 8) | b as u32)
}

/// A task the agent set going, as `task-…`; not a space's chat, nor the core's own threads (a
/// one-shot model call's `run-…`, a check's fix turn, a reflection), which aren't work of the user's.
pub fn is_task(t: &ThreadRow) -> bool {
    t.id.starts_with("task-")
}

/// Which space a thread works in: its own tag, else its parent's, else Home.
pub fn space_of<'a>(b: &'a Brain, t: &'a ThreadRow) -> &'a str {
    let mut seen = HashSet::new();
    let mut at = Some(t);
    while let Some(x) = at {
        if !seen.insert(&x.id) {
            break;
        }
        if let Some(h) = &x.home {
            return h;
        }
        at = x.parent.as_ref().and_then(|p| b.threads.get(p));
    }
    HOME
}

fn letter(name: &str, used: &mut HashSet<String>) -> String {
    let letters: Vec<char> = name.chars().filter(char::is_ascii_alphabetic).collect();
    let first = letters.first().copied().unwrap_or('S').to_ascii_uppercase().to_string();
    let code = if used.contains(&first) {
        format!("{first}{}", letters.get(1).map(|c| c.to_ascii_lowercase().to_string()).unwrap_or_default())
    } else {
        first
    };
    used.insert(code.clone());
    code
}

fn top<'a>(b: &'a Brain, x: &'a SpaceRow) -> &'a SpaceRow {
    let mut at = x;
    let mut seen = HashSet::new();
    while let Some(p) = &at.parent {
        if p == HOME || !seen.insert(&at.id) {
            break;
        }
        match b.spaces.get(p) {
            Some(up) => at = up,
            None => break,
        }
    }
    at
}

fn stations(b: &Brain) -> HashMap<String, Station> {
    let mut map = HashMap::new();
    let mut lines: Vec<&SpaceRow> = b.spaces.values().filter(|x| x.parent.as_deref() == Some(HOME)).collect();
    lines.sort_by(|a, b| a.made.total_cmp(&b.made));
    let mut taken = HashSet::new();
    let mut inks: HashMap<&str, (u32, u32)> = HashMap::new();
    for l in &lines {
        if let Some((d, n)) = &l.ink {
            let ink = (hex(d).unwrap_or(FALLBACK.0), hex(n).unwrap_or(FALLBACK.1));
            inks.insert(&l.id, ink);
            if let Some(i) = LINES.iter().position(|x| x.0 == ink.0) {
                taken.insert(i);
            }
        }
    }
    for l in &lines {
        if !inks.contains_key(l.id.as_str()) {
            let i = (0..LINES.len()).find(|i| !taken.contains(i)).unwrap_or(l.made as usize % LINES.len());
            taken.insert(i);
            inks.insert(&l.id, LINES[i]);
        }
    }
    let mut used = HashSet::new();
    for l in &lines {
        map.insert(l.id.clone(), Station { code: letter(&l.name, &mut used), ink: inks.get(l.id.as_str()).copied() });
    }
    let mut rest: Vec<&SpaceRow> = b.spaces.values().filter(|x| x.parent.as_ref().is_some_and(|p| p != HOME)).collect();
    rest.sort_by(|a, b| a.made.total_cmp(&b.made));
    let mut counts: HashMap<String, usize> = HashMap::new();
    for x in rest {
        let line = map.get(&top(b, x).id).cloned();
        let parent = x.parent.clone().unwrap_or_default();
        let count = counts.entry(parent).or_default();
        *count += 1;
        let code = line.as_ref().map(|l| l.code.chars().filter(|c| !c.is_ascii_digit()).collect::<String>()).unwrap_or_default();
        map.insert(x.id.clone(), Station { code: format!("{code}{:02}", count), ink: line.and_then(|l| l.ink) });
    }
    map
}

impl Derived {
    pub fn of(b: &Brain) -> Self {
        let mut d = Derived { version: b.version, stations: stations(b), ..Default::default() };
        let warmth = |x: &SpaceRow| b.warm.get(&x.id).map(|w| *w as f64).unwrap_or(x.made);
        let mut under: HashMap<String, Vec<String>> = HashMap::new();
        for x in b.spaces.values() {
            if let Some(p) = &x.parent
                && *p != x.id
            {
                under.entry(p.clone()).or_default().push(x.id.clone());
                if !x.archived {
                    d.children.entry(p.clone()).or_default().push(x.id.clone());
                }
            }
        }
        for kids in d.children.values_mut() {
            kids.sort_by(|a, c| warmth(&b.spaces[c]).total_cmp(&warmth(&b.spaces[a])));
        }
        // Tasks under way in a space itself, not a space's own chat turn (the chat shows it typing);
        // a turn the senses woke isn't work under way, nor one waiting (a watch or a script still
        // open): it isn't running.
        let apps = app_names(b);
        for t in b.threads.values() {
            if !is_task(t) {
                continue;
            }
            if t.status == Status::Running && !t.sensed {
                let work = Work { thread: t.id.clone(), title: t.title.clone(), stage: t.stage.clone(), since: t.since, step: live_step(t, &apps) };
                d.running.entry(space_of(b, t).to_string()).or_default().push(work);
            }
        }
        for list in d.running.values_mut() {
            list.sort_by(|a, b| a.since.total_cmp(&b.since));
        }
        for a in b.items.open.values() {
            d.asks.entry(a.space.clone()).or_default().push(a.clone());
        }
        for list in d.asks.values_mut() {
            list.sort_by(|a, b| a.at.total_cmp(&b.at));
        }
        let mut activities: HashSet<&str> = HashSet::new();
        for a in b.activities.values() {
            if !a.done {
                activities.insert(&a.space);
            }
        }
        // Each space's marks count every space under it (an archived one's running and asks too,
        // not its unread).
        let own = |id: &str| Marks {
            running: d.running.get(id).is_some_and(|w| !w.is_empty()) || activities.contains(id),
            needs: d.asks.get(id).map(Vec::len).unwrap_or(0),
            unread: !b.spaces.get(id).is_some_and(|s| s.archived) && unread_at(b, id).is_some(),
        };
        fn total(id: &str, under: &HashMap<String, Vec<String>>, own: &dyn Fn(&str) -> Marks, seen: &mut HashSet<String>) -> Marks {
            if !seen.insert(id.to_string()) {
                return Marks::default();
            }
            let mut m = own(id);
            for c in under.get(id).into_iter().flatten() {
                let k = total(c, under, own, seen);
                m.running |= k.running;
                m.needs += k.needs;
                m.unread |= k.unread;
            }
            m
        }
        // Every space's, an archived one's too (derive.ts `marks` answers for any space).
        let marks: HashMap<String, Marks> = b.spaces.keys().map(|id| (id.clone(), total(id, &under, &own, &mut HashSet::new()))).collect();
        d.marks = marks;
        d
    }

    pub fn station(&self, id: &str) -> Station {
        self.stations.get(id).cloned().unwrap_or_default()
    }
}

/// The spaces above, from Home down, without the space itself.
pub fn above(b: &Brain, id: &str) -> Vec<String> {
    let mut out = vec![];
    let mut seen = HashSet::new();
    let mut at = b.spaces.get(id).and_then(|s| s.parent.as_ref()).and_then(|p| b.spaces.get(p));
    while let Some(x) = at {
        if !seen.insert(&x.id) {
            break;
        }
        out.insert(0, x.id.clone());
        at = x.parent.as_ref().and_then(|p| b.spaces.get(p));
    }
    out
}

/// When the space's chat turn answering the user started, while it works: the chat shows typing.
pub fn typing_since(b: &Brain, id: &str) -> Option<f64> {
    let t = b.threads.get(&format!("space:{id}"))?;
    (t.status == Status::Running && !t.woken).then_some(t.since)
}

/// The spaces not archived.
pub fn live(b: &Brain) -> Vec<&SpaceRow> {
    b.spaces.values().filter(|x| !x.archived).collect()
}

/// The space and every space under it.
pub fn subtree(b: &Brain, id: &str) -> HashSet<String> {
    let mut out = HashSet::from([id.to_string()]);
    let mut grew = true;
    while grew {
        grew = false;
        for x in b.spaces.values() {
            if let Some(p) = &x.parent
                && out.contains(p)
                && !out.contains(&x.id)
            {
                out.insert(x.id.clone());
                grew = true;
            }
        }
    }
    out
}

/// The apps a turn's tools may come from: Switch's own and the installed extensions.
pub fn app_names(b: &Brain) -> Vec<String> {
    OWN_APPS.iter().map(|s| s.to_string()).chain(b.extensions.iter().cloned()).collect()
}

/// The live step of a running thread ("Deploying"), from its latest tool call not yet answered;
/// "Writing" while words stream.
pub fn live_step(t: &ThreadRow, apps: &[String]) -> String {
    let mut completed: HashSet<&str> = HashSet::new();
    for i in t.items.iter().rev() {
        if t.turn.as_deref() != Some(i.turn.as_str()) {
            break;
        }
        if i.kind == ItemKind::Result {
            completed.insert(&i.id);
        }
        if i.kind == ItemKind::Tool && !completed.contains(i.id.as_str()) {
            let step = describe(&i.name, &i.input, apps).text();
            if !step.is_empty() {
                return step;
            }
        }
    }
    if t.streaming.is_empty() { String::new() } else { "Writing".into() }
}

/// Extensions' long jobs under way in the space itself (their Live Activities), oldest first.
pub fn activities<'a>(b: &'a Brain, id: &str) -> Vec<&'a Activity> {
    let mut out: Vec<&Activity> = b.activities.values().filter(|a| a.space == id && a.state != ActivityState::Done).collect();
    out.sort_by(|a, c| a.started_at.total_cmp(&c.started_at));
    out
}

/// The widgets placed in a space, in order.
pub fn widgets<'a>(b: &'a Brain, id: &str) -> Vec<&'a Placed> {
    b.placed.iter().filter(|w| w.space == id).collect()
}

/// Every space, warmest first, for the palette.
pub fn warmest(b: &Brain) -> Vec<&SpaceRow> {
    let mut out = live(b);
    let warmth = |x: &SpaceRow| b.warm.get(&x.id).map(|w| *w as f64).unwrap_or(x.made);
    out.sort_by(|a, c| warmth(c).total_cmp(&warmth(a)));
    out
}

/// An item's title, open or lately closed.
pub fn title_of(b: &Brain, id: &str) -> String {
    b.items.find(id).map(|a| a.title.clone()).unwrap_or_default()
}

/// An item, open or lately closed.
pub fn ask_of<'a>(b: &'a Brain, id: &str) -> Option<&'a Ask> {
    b.items.find(id)
}

/// A line of a space's chat as its column shows it.
#[derive(Clone, Debug)]
pub struct ChatLine {
    /// Unique within a chat.
    pub key: String,
    /// The message's seq, once it's in the log, and the space it was said in.
    pub seq: Option<u64>,
    pub home: Option<String>,
    pub who: Who,
    pub text: String,
    /// The other spaces it bears on, besides this one.
    pub also: Vec<String>,
    pub pending: Option<Pending>,
    /// A widget instead of text, and the line's seq.
    pub widget: Option<(Shown, u64)>,
    /// When it was said; none until it's in the log.
    pub time: Option<f64>,
    pub quiet: Option<Quiet>,
    /// The title of the action item a reply was on.
    pub on: Option<String>,
    pub attachments: Vec<Attachment>,
    pub detail: Option<String>,
    pub edited: bool,
    pub reactions: Reactions,
    /// What a message of the user's replies to: words of a message, or an action item.
    pub reply_to: Vec<Reply>,
    pub parts: Vec<PartReaction>,
    pub model: Option<String>,
}

/// What a line replies to: its own refs, and the item an older reply was on (`item`).
fn replies_to(line: &Line) -> Vec<Reply> {
    let mut out = line.reply_to.clone();
    if let Some(item) = &line.item
        && !line.reply_to.iter().any(|r| matches!(r, Reply::Ask { id, .. } if id == item))
    {
        out.push(Reply::Ask { id: item.clone(), title: None, reply: None });
    }
    out
}

/// A line's general words: none when they only repeat its replies under what it replies to.
fn general_of(line: &Line) -> String {
    let replies: Vec<&str> = line.reply_to.iter().map(|r| r.reply().trim()).filter(|r| !r.is_empty()).collect();
    if !replies.is_empty() && line.text.trim() == replies.join("\n\n") { String::new() } else { line.text.clone() }
}

/// A space's chat: what's posted in it or mentions it, then what's sent but not yet in the log. A
/// turn's steps, and its words until they're posted, are its thread's, never the chat's.
pub fn chat(b: &Brain, id: &str) -> Vec<ChatLine> {
    let held = b.chats.get(id).map(|c| c.lines.as_slice()).unwrap_or_default();
    let mut out: Vec<ChatLine> = held
        .iter()
        .map(|line| {
            let on = line.item.as_deref().map(|i| title_of(b, i)).filter(|t| !t.is_empty());
            ChatLine {
                key: line.seq.to_string(),
                seq: Some(line.seq),
                home: Some(line.home.clone()),
                who: line.who,
                text: general_of(line),
                also: std::iter::once(&line.home).chain(line.mentions.iter()).filter(|x| x.as_str() != id && b.spaces.contains_key(*x)).cloned().collect(),
                pending: None,
                widget: line.widget.clone().map(|w| (w, line.seq)),
                time: Some(line.time),
                quiet: line.quiet.clone(),
                on,
                attachments: line.attachments.clone(),
                detail: line.detail.clone(),
                edited: line.edited,
                reactions: line.reactions.clone(),
                reply_to: replies_to(line),
                parts: line.parts.clone(),
                model: line.model.clone(),
            }
        })
        .collect();
    for p in b.pending.iter().filter(|p| p.space == id) {
        out.push(ChatLine {
            key: p.id.clone(),
            seq: None,
            home: None,
            who: Who::User,
            text: p.text.clone(),
            also: vec![],
            pending: Some(p.clone()),
            widget: None,
            time: None,
            quiet: None,
            on: None,
            attachments: vec![],
            detail: None,
            edited: false,
            reactions: Reactions::default(),
            reply_to: p.reply_to.clone(),
            parts: vec![],
            model: None,
        });
    }
    out
}

/// What the core ends a turn the user stopped on (agent turn.ts STOPPED).
const STOPPED: &str = "Stopped";
/// A turn the deploy paused (agent turn.ts PAUSED): the updated core carries it on.
const PAUSED: &str = "Paused for an update";

/// The space's chat turn answering the user, when it ended with no reply and the user didn't stop
/// it (it failed, hit a limit, or was cut off; not paused for an update): their last message there
/// shows Not Delivered, and Retry runs the turn again.
pub fn undelivered(b: &Brain, id: &str) -> Option<String> {
    let t = b.threads.get(&format!("space:{id}"))?;
    let unanswered = matches!(t.status, Status::Failed | Status::Limited) || (t.status == Status::Interrupted && t.result != STOPPED && t.result != PAUSED);
    (unanswered && !t.woken).then(|| t.id.clone())
}

/// The latest reply in the space's own chat, if the user hasn't read that far.
pub fn unread_at(b: &Brain, id: &str) -> Option<u64> {
    let reply = b.replies.get(id).copied().unwrap_or(0);
    (reply > b.reads.get(id).copied().unwrap_or(0)).then_some(reply)
}

/// Whether the space, or one under it, has a reply the user hasn't read.
pub fn unread(b: &Brain, id: &str) -> bool {
    subtree(b, id).iter().any(|x| !b.spaces.get(x).is_some_and(|s| s.archived) && unread_at(b, x).is_some())
}
