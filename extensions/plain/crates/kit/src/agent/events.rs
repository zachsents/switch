//! Events, in MCP's events extension (`io.modelcontextprotocol/events`). Every app has
//! `action.performed`, heard after each action whoever did it: the person at the keyboard, a
//! click, the menu bar or an agent. Apps add their own event types with [`event_source`].
//!
//! Each event type is a log the app keeps: occurrences numbered from 1, so a cursor is the log's
//! epoch and a position in it (`<epoch>.<seq>`). A host that comes back after a while passes its
//! cursor and hears what it missed. A cursor from another epoch, such as one from a log that was
//! started over, reads as a gap (`truncated`) and starts from now.

use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};

use gpui::{Action, App, Entity, Global};
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::{Notice, Reply, broadcast, handling_agent_call, reject, tool_name};
use crate::{AppInfo, storage};

/// The event every app has.
pub(crate) const ACTION_PERFORMED: &str = "action.performed";

/// How many actions the app keeps for hosts catching up.
const KEPT_ACTIONS: usize = 1_000;

/// How often a host polling for events should ask again.
const NEXT_POLL_MS: u64 = 5_000;

/// One occurrence of an event, as an app's log holds it.
#[derive(Clone, Debug)]
pub struct Occurrence {
    /// Its position in its log, counting up from 1.
    pub seq: u64,
    /// When it happened, in milliseconds since the Unix epoch.
    pub at: i64,
    /// Identifies what happened, the same wherever it's reported, so hosts can drop repeats.
    pub id: String,
    /// What happened, matching the event type's payload schema.
    pub data: Value,
}

impl Occurrence {
    /// The occurrence as MCP's `EventOccurrence`.
    fn to_mcp(&self, name: &str, epoch: &str) -> Value {
        json!({
            "eventId": self.id,
            "name": name,
            "timestamp": timestamp(self.at),
            "data": self.data,
            "cursor": cursor(epoch, self.seq),
        })
    }
}

/// An event type an app offers, backed by a log it keeps.
pub struct EventSource {
    /// Its name, like `data.changed`.
    pub name: &'static str,
    /// What it means, written for agents deciding whether to watch it.
    pub description: &'static str,
    /// The JSON Schema of each occurrence's `data`.
    pub payload: Value,
    /// Identifies the log. When it changes, cursors from before count as a gap.
    pub epoch: Box<dyn Fn(&App) -> String>,
    /// The newest occurrence's position, or 0 for none yet.
    pub head: Box<dyn Fn(&App) -> u64>,
    /// Occurrences after a position, oldest first, at most `limit` of them. Positions may skip
    /// numbers, but a log holds all of its occurrences.
    pub read: Box<ReadOccurrences>,
}

/// Reads a log: the occurrences after a position, at most so many.
pub type ReadOccurrences = dyn Fn(u64, usize, &App) -> Vec<Occurrence>;

/// The event types the app added.
#[derive(Default)]
struct Sources(Vec<EventSource>);

impl Global for Sources {}

/// Adds an event type to what the app offers agents. The app calls [`emit`] as each occurrence
/// happens, and hosts catching up read the rest through `read`.
pub fn event_source(cx: &mut App, source: EventSource) {
    cx.default_global::<Sources>().0.push(source);
}

/// Tells watching hosts that an occurrence of one of the app's own event types just happened.
pub fn emit(cx: &mut App, name: &str, occurrence: &Occurrence) {
    let Some(epoch) = cx
        .try_global::<Sources>()
        .and_then(|Sources(sources)| sources.iter().find(|source| source.name == name))
        .map(|source| (source.epoch)(cx))
    else {
        return;
    };
    let occurrence = occurrence.to_mcp(name, &epoch);
    broadcast(
        cx,
        &Notice::Event {
            name: name.into(),
            occurrence,
        },
    );
}

/// Handles an action app-wide by updating `model`, so it works the same from the keyboard, a
/// click, the menu bar or an agent, with or without a window open. Afterwards the action is
/// heard by agents watching the app (an `action.performed` event), and if an agent made the
/// change, the app's windows come to the front so the person sees it. An error fails the agent
/// call that sent the action; from anywhere else there is nothing to report.
pub fn handle<M: 'static, A: Action + Serialize>(
    cx: &mut App,
    model: &Entity<M>,
    update: impl Fn(&mut M, &A) -> Result<(), String> + 'static,
) {
    let model = model.clone();
    cx.on_action(move |action: &A, cx| {
        let result = model.update(cx, |model, cx| {
            cx.notify();
            update(model, action)
        });
        match result {
            Ok(()) => {
                announce(cx, action);
                if handling_agent_call(cx) {
                    for window in cx.windows() {
                        window
                            .update(cx, |_, window, _| crate::present(window))
                            .ok();
                    }
                }
            }
            Err(error) => reject(cx, error),
        }
    });
}

/// Records that an action changed the app, for handlers that don't go through [`handle`].
/// Watching agents hear it as an `action.performed` event. A handler that finishes later uses
/// an [`Announcer`] instead.
pub fn announce<A: Action + Serialize>(cx: &mut App, action: &A) {
    announcer(cx).announce(cx, action);
}

/// Records an action whose handler finishes later, like one that first reads words with the
/// decision model. Made while the action is handled, it remembers who the action came from;
/// [`Announcer::announce`] records the action once it has changed the app. Until then nothing is
/// heard, and an action that fails isn't.
pub fn announcer(cx: &mut App) -> Announcer {
    // The call is heard through this, so not again as it finishes dispatching.
    if cx.has_global::<AgentCall>() {
        cx.global_mut::<AgentCall>().announced = true;
    }
    let by = if handling_agent_call(cx) {
        "agent"
    } else {
        "person"
    };
    Announcer { by }
}

/// Records an action once it has changed the app. See [`announcer`].
pub struct Announcer {
    by: &'static str,
}

impl Announcer {
    pub fn announce<A: Action + Serialize>(&self, cx: &mut App, action: &A) {
        // Actions without fields serialize as `null`.
        let arguments = match serde_json::to_value(action) {
            Ok(Value::Object(fields)) => Value::Object(fields),
            _ => json!({}),
        };
        record(cx, &tool_name(A::name_for_type()), arguments, self.by);
    }
}

/// Tells watching hosts that the app's state may have changed outside an action, such as edits
/// arriving from another device, so subscribed resources are read again. Changes in one moment
/// are told once.
pub fn changed(cx: &mut App) {
    let pending = cx.default_global::<ChangePending>();
    if pending.0 {
        return;
    }
    pending.0 = true;
    cx.defer(|cx| {
        cx.global_mut::<ChangePending>().0 = false;
        broadcast(cx, &Notice::Changed);
    });
}

#[derive(Default)]
struct ChangePending(bool);

impl Global for ChangePending {}

/// The agent call being handled, and whether its action announced itself.
struct AgentCall {
    announced: bool,
    /// Whether the person made it, through a widget.
    person: bool,
}

impl Global for AgentCall {}

pub(super) fn agent_call_starting(person: bool, cx: &mut App) {
    cx.set_global(AgentCall {
        announced: false,
        person,
    });
}

/// Whether the call being handled was made by the person, through a widget.
pub(super) fn person_calling(cx: &App) -> bool {
    cx.try_global::<AgentCall>().is_some_and(|call| call.person)
}

/// Ends an agent call. A call that went through, given its tool and arguments, is recorded as
/// the agent's action if the app's handler didn't announce it.
pub(super) fn agent_call_finished(went_through: Option<(&str, &Value)>, cx: &mut App) {
    let announced = cx
        .try_global::<AgentCall>()
        .is_some_and(|call| call.announced);
    let by = if person_calling(cx) {
        "person"
    } else {
        "agent"
    };
    if cx.has_global::<AgentCall>() {
        cx.remove_global::<AgentCall>();
    }
    if let Some((tool, arguments)) = went_through.filter(|_| !announced) {
        record(cx, tool, arguments.clone(), by);
    }
}

/// The actions the app has performed, kept in its data folder so hosts can catch up across
/// restarts: an epoch line, then one occurrence per line.
struct ActionLog {
    path: PathBuf,
    epoch: String,
    recent: VecDeque<Occurrence>,
    next: u64,
}

impl Global for ActionLog {}

impl ActionLog {
    fn open(app: AppInfo) -> Self {
        let path = storage::dir(app).join("actions.jsonl");
        let text = fs::read_to_string(&path).unwrap_or_default();
        let mut lines = text.lines();
        let epoch = lines
            .next()
            .and_then(|line| serde_json::from_str::<Value>(line).ok())
            .and_then(|header| header["epoch"].as_str().map(str::to_string));
        let Some(epoch) = epoch else {
            let log = Self {
                path,
                epoch: new_epoch(),
                recent: VecDeque::new(),
                next: 1,
            };
            log.rewrite();
            return log;
        };
        let read: Vec<Occurrence> = lines.filter_map(read_occurrence).collect();
        let next = read.last().map_or(1, |last| last.seq + 1);
        let overgrown = read.len() > 2 * KEPT_ACTIONS;
        let recent = read.into_iter().rev().take(KEPT_ACTIONS).rev().collect();
        let log = Self {
            path,
            epoch,
            recent,
            next,
        };
        if overgrown {
            log.rewrite();
        }
        log
    }

    /// Writes the whole log again, keeping only what's recent.
    fn rewrite(&self) {
        let header = json!({ "epoch": self.epoch }).to_string();
        let lines = self.recent.iter().map(write_occurrence);
        let text: String = std::iter::once(header)
            .chain(lines)
            .map(|line| line + "\n")
            .collect();
        fs::create_dir_all(self.path.parent().expect("data paths have a parent")).ok();
        if let Err(error) = fs::write(&self.path, text) {
            eprintln!("failed to save {}: {error}", self.path.display());
        }
    }

    fn append(&mut self, data: Value) -> Occurrence {
        let seq = self.next;
        self.next += 1;
        let occurrence = Occurrence {
            seq,
            at: jiff::Timestamp::now().as_millisecond(),
            id: format!("{}-{seq}", self.epoch),
            data,
        };
        let written = OpenOptions::new()
            .append(true)
            .open(&self.path)
            .and_then(|mut file| writeln!(file, "{}", write_occurrence(&occurrence)));
        if let Err(error) = written {
            eprintln!("failed to save {}: {error}", self.path.display());
        }
        self.recent.push_back(occurrence.clone());
        if self.recent.len() > KEPT_ACTIONS {
            self.recent.pop_front();
        }
        occurrence
    }

    fn read(&self, after: u64, limit: usize) -> Vec<Occurrence> {
        self.recent
            .iter()
            .filter(|occurrence| occurrence.seq > after)
            .take(limit)
            .cloned()
            .collect()
    }
}

fn read_occurrence(line: &str) -> Option<Occurrence> {
    let value: Value = serde_json::from_str(line).ok()?;
    Some(Occurrence {
        seq: value["seq"].as_u64()?,
        at: value["at"].as_i64()?,
        id: value["id"].as_str()?.to_string(),
        data: value["data"].clone(),
    })
}

fn write_occurrence(occurrence: &Occurrence) -> String {
    json!({
        "seq": occurrence.seq,
        "at": occurrence.at,
        "id": occurrence.id,
        "data": occurrence.data,
    })
    .to_string()
}

/// A fresh epoch: when the log started, in a form that sorts and never repeats on this machine.
fn new_epoch() -> String {
    let now = jiff::Timestamp::now();
    format!("{:x}", now.as_nanosecond())
}

/// Opens the action log. Called once by `listen`.
pub(super) fn start(app: AppInfo, cx: &mut App) {
    cx.set_global(ActionLog::open(app));
}

fn record(cx: &mut App, action: &str, arguments: Value, by: &str) {
    if !cx.has_global::<ActionLog>() {
        return;
    }
    let log = cx.global_mut::<ActionLog>();
    let occurrence = log.append(json!({ "action": action, "arguments": arguments, "by": by }));
    let occurrence = occurrence.to_mcp(ACTION_PERFORMED, &log.epoch);
    broadcast(
        cx,
        &Notice::Event {
            name: ACTION_PERFORMED.into(),
            occurrence,
        },
    );
    super::changed(cx);
}

fn action_payload() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": { "type": "string", "description": "The tool that does the same thing." },
            "arguments": { "type": "object", "description": "What it was given, as the tool takes it." },
            "by": {
                "type": "string",
                "enum": ["person", "agent"],
                "description": "Who did it: the person at the computer, or an agent through a tool.",
            },
        },
        "required": ["action", "arguments", "by"],
    })
}

/// What subscribers may pass: each top-level scalar field of the payload, which an occurrence
/// must equal to be delivered.
fn filter_schema(payload: &Value) -> Value {
    let properties: Map<String, Value> = payload["properties"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, schema)| {
            matches!(
                schema["type"].as_str(),
                Some("string" | "boolean" | "number" | "integer")
            )
        })
        .map(|(name, schema)| (name.clone(), schema.clone()))
        .collect();
    json!({ "type": "object", "properties": properties, "additionalProperties": false })
}

/// Whether an occurrence's data passes a subscriber's filter: every argument names a payload
/// field and the value it must have.
pub(super) fn matches(arguments: &Value, data: &Value) -> bool {
    arguments
        .as_object()
        .is_none_or(|filters| filters.iter().all(|(field, value)| &data[field] == value))
}

fn descriptor(name: &str, description: &str, payload: &Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "delivery": ["poll", "push"],
        "inputSchema": filter_schema(payload),
        "payloadSchema": payload,
    })
}

/// Every event type the app offers, for `events/list`.
pub(super) fn descriptors(cx: &App) -> Vec<Value> {
    let actions = descriptor(
        ACTION_PERFORMED,
        "After each action changes the app: what was done, with its arguments as the tool takes \
         them, and who did it. Pass `by: \"person\"` to hear only what the person did.",
        &action_payload(),
    );
    let sources = cx
        .try_global::<Sources>()
        .into_iter()
        .flat_map(|Sources(sources)| sources)
        .map(|source| descriptor(source.name, source.description, &source.payload));
    std::iter::once(actions).chain(sources).collect()
}

/// A position in a log, as hosts hold it.
pub(super) fn cursor(epoch: &str, seq: u64) -> String {
    format!("{epoch}.{seq}")
}

/// The epoch and position a cursor names.
pub(super) fn parse_cursor(cursor: &str) -> Option<(&str, u64)> {
    let (epoch, seq) = cursor.rsplit_once('.')?;
    Some((epoch, seq.parse().ok()?))
}

fn timestamp(millis: i64) -> String {
    jiff::Timestamp::from_millisecond(millis)
        .map(|at| at.to_string())
        .unwrap_or_default()
}

/// Where a log stands and how to read it.
struct Log<'a> {
    epoch: String,
    head: u64,
    /// The position before the oldest occurrence the log still holds. A host behind it missed
    /// some. App logs hold everything, so theirs is 0.
    floor: u64,
    read: Box<dyn Fn(u64, usize) -> Vec<Occurrence> + 'a>,
}

fn log<'a>(name: &str, cx: &'a App) -> Option<Log<'a>> {
    if name == ACTION_PERFORMED {
        let log = cx.try_global::<ActionLog>()?;
        return Some(Log {
            epoch: log.epoch.clone(),
            head: log.next - 1,
            floor: log
                .recent
                .front()
                .map_or(log.next - 1, |oldest| oldest.seq - 1),
            read: Box::new(|after, limit| log.read(after, limit)),
        });
    }
    let Sources(sources) = cx.try_global::<Sources>()?;
    let source = sources.iter().find(|source| source.name == name)?;
    Some(Log {
        epoch: (source.epoch)(cx),
        head: (source.head)(cx),
        floor: 0,
        read: Box::new(move |after, limit| (source.read)(after, limit, cx)),
    })
}

/// Answers `events/poll`: the occurrences after `cursor` that pass `arguments`, or none and the
/// current position for a host starting from now (`cursor` of `None`).
pub(super) fn poll(
    name: &str,
    arguments: &Value,
    cursor: Option<&str>,
    max_events: Option<usize>,
    max_age_ms: Option<u64>,
    cx: &App,
) -> Reply {
    let Some(log) = log(name, cx) else {
        return Err(format!("no event type `{name}`"));
    };
    let start = cursor.map(|cursor| match parse_cursor(cursor) {
        Some((epoch, seq)) if epoch == log.epoch && seq <= log.head => (seq, false),
        _ => (log.head, true),
    });
    let Some((after, truncated)) = start else {
        return Ok(json!({
            "events": [],
            "cursor": self::cursor(&log.epoch, log.head),
            "truncated": false,
            "hasMore": false,
            "nextPollMs": NEXT_POLL_MS,
        }));
    };
    let mut truncated = truncated || after < log.floor;
    let limit = max_events.unwrap_or(100).clamp(1, 1_000);
    let mut read = (log.read)(after, limit + 1);
    let has_more = read.len() > limit;
    read.truncate(limit);
    let reached = read.last().map_or(after, |last| last.seq);
    let floor = max_age_ms.map(|age| jiff::Timestamp::now().as_millisecond() - age as i64);
    let events: Vec<Value> = read
        .iter()
        .filter(|occurrence| {
            let recent = floor.is_none_or(|floor| occurrence.at >= floor);
            truncated |= !recent;
            recent && matches(arguments, &occurrence.data)
        })
        .map(|occurrence| occurrence.to_mcp(name, &log.epoch))
        .collect();
    Ok(json!({
        "events": events,
        "cursor": self::cursor(&log.epoch, reached),
        "truncated": truncated,
        "hasMore": has_more,
        "nextPollMs": NEXT_POLL_MS,
    }))
}
