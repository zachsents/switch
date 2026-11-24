//! Reads that aren't the sync, cached as the desktop's TanStack queries are: each by its key, fresh
//! for its stale time, asked again on an interval while a view reads it, and read again when an
//! event says it changed. A view calls a query's function in its render (which asks for it when
//! it's missing or stale) and observes `entity` to redraw when it comes. The desktop's `models.ts`,
//! `accounts.ts`, `providers.ts` (the registry), `find.ts`, `system.ts` and `connections.ts`'s
//! needs. Each record that reads is kept; one that doesn't is left out, said in the log.
// The typed API the views use; parts not yet drawn are still the API.
#![allow(dead_code)]

use std::any::Any;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{App, AppContext, Entity, Global, Task};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::brain::Event;
use crate::net::Net;

pub const MODELS: &str = "models";
pub const ACCOUNTS: &str = "provider-accounts";
pub const REGISTRY: &str = "provider-registry";
pub const MEMORIES: &str = "memories";
pub const SYSTEM: &str = "system";
pub const NEEDS: &str = "connections.needs";

/// The query client's defaults: fresh for 30 s, one retry.
const STALE: Duration = Duration::from_secs(30);
/// A view that read it this lately is still showing it.
const SEEN: Duration = Duration::from_secs(2);

type Data = Arc<dyn Any + Send + Sync>;
type Fetch = Rc<dyn Fn(&mut App) -> Task<Result<Data, String>>>;

/// How a query is kept.
#[derive(Clone, Copy)]
pub struct Spec {
    pub stale: Duration,
    /// Asked again this often while a view reads it.
    pub every: Option<Duration>,
    /// Dropped once no view has read it this long.
    pub gc: Option<Duration>,
    pub retry: u32,
}

impl Default for Spec {
    fn default() -> Self {
        Spec { stale: STALE, every: None, gc: None, retry: 1 }
    }
}

struct Entry {
    data: Option<Data>,
    error: Option<String>,
    fetching: bool,
    at: Option<Instant>,
    /// When it was last asked for, answered or not: an interval runs from then, a failure too.
    tried: Option<Instant>,
    seen: Instant,
    invalid: bool,
    spec: Spec,
    fetch: Fetch,
}

/// What a view reads of a query.
pub struct QueryState<T> {
    pub data: Option<Arc<T>>,
    pub error: Option<String>,
    pub fetching: bool,
}

impl<T> QueryState<T> {
    fn none() -> Self {
        QueryState { data: None, error: None, fetching: false }
    }
}

pub struct Queries {
    entries: HashMap<String, Entry>,
}

struct QueriesHandle(Entity<Queries>);
impl Global for QueriesHandle {}

pub fn init(cx: &mut App) {
    let e = cx.new(|cx| {
        // Intervals and collection, once a second.
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                // Outside the entity's own update: a due query's start updates it.
                if this.upgrade().is_none() {
                    break;
                }
                cx.update(tick);
            }
        })
        .detach();
        Queries { entries: HashMap::new() }
    });
    cx.set_global(QueriesHandle(e));
}

/// What views observe to redraw as answers come.
pub fn entity(cx: &App) -> Entity<Queries> {
    cx.global::<QueriesHandle>().0.clone()
}

/// What the settings pages show, held from launch so each opens drawn (use-prefetch.ts): what
/// extensions need of each provider, read all along, and the memories, once.
fn prefetch(cx: &mut App) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static MEMORIES: AtomicBool = AtomicBool::new(false);
    if !cx.has_global::<crate::model::ModelHandle>() || !crate::model::model(cx).read(cx).authed {
        return;
    }
    let _ = needs(cx);
    if !MEMORIES.swap(true, Ordering::Relaxed) {
        let _ = memories(cx);
    }
}

fn tick(cx: &mut App) {
    prefetch(cx);
    let now = Instant::now();
    let mut due = vec![];
    let mut dropped = false;
    for (k, e) in entity(cx).read(cx).entries.iter() {
        let seen = now.duration_since(e.seen) < SEEN;
        if let (Some(every), Some(at)) = (e.spec.every, e.tried)
            && seen
            && !e.fetching
            && now.duration_since(at) >= every
        {
            due.push(k.clone());
        }
        if e.spec.gc.is_some_and(|gc| now.duration_since(e.seen) > gc.max(SEEN)) && e.data.is_some() {
            dropped = true;
        }
    }
    if dropped {
        entity(cx).update(cx, |q, cx| {
            for e in q.entries.values_mut() {
                if e.spec.gc.is_some_and(|gc| now.duration_since(e.seen) > gc.max(SEEN)) {
                    e.data = None;
                    e.at = None;
                }
            }
            cx.notify();
        });
    }
    for k in due {
        start(&k, cx);
    }
}

fn start(key: &str, cx: &mut App) {
    let q = entity(cx);
    let Some(fetch) = q.update(cx, |q, cx| {
        let e = q.entries.get_mut(key)?;
        e.fetching = true;
        e.tried = Some(Instant::now());
        cx.notify();
        Some((e.fetch.clone(), e.spec.retry))
    }) else {
        return;
    };
    let (fetch, retry) = fetch;
    let key = key.to_string();
    let first = fetch(cx);
    cx.spawn(async move |cx| {
        let mut got = first.await;
        let mut left = retry;
        while got.is_err() && left > 0 {
            left -= 1;
            cx.background_executor().timer(Duration::from_secs(1)).await;
            let again = cx.update(|cx| fetch(cx));
            got = again.await;
        }
        cx.update(|cx| {
            entity(cx).update(cx, |q, cx| {
                if let Some(e) = q.entries.get_mut(&key) {
                    e.fetching = false;
                    match got {
                        Ok(d) => {
                            e.data = Some(d);
                            e.error = None;
                            e.at = Some(Instant::now());
                            e.invalid = false;
                        }
                        Err(reason) => e.error = Some(reason),
                    }
                    cx.notify();
                }
            })
        });
    })
    .detach();
}

/// Reads query `key`, asking for it when it's missing, stale or said to have changed.
pub fn read<T: Send + Sync + 'static, F>(key: &str, spec: Spec, fetch: F, cx: &mut App) -> QueryState<T>
where
    F: Fn(&mut App) -> Task<Result<T, String>> + 'static,
{
    let q = entity(cx);
    let now = Instant::now();
    let fetch: Fetch = Rc::new(move |cx: &mut App| {
        let t = fetch(cx);
        cx.background_executor().spawn(async move { t.await.map(|d| Arc::new(d) as Data) })
    });
    let go = q.update(cx, |q, _| {
        let fresh = !q.entries.contains_key(key);
        let e = q.entries.entry(key.to_string()).or_insert_with(|| Entry { data: None, error: None, fetching: false, at: None, tried: None, seen: now, invalid: false, spec, fetch: fetch.clone() });
        // Shown again after a while (a view mounting): a stale or failed one is asked again, as a
        // query's new observer refetches it.
        let mounted = fresh || now.duration_since(e.seen) >= SEEN;
        e.seen = now;
        e.spec = spec;
        e.fetch = fetch;
        let stale = e.at.is_none_or(|at| now.duration_since(at) >= e.spec.stale);
        // Stale or failed, it's asked again as a view comes to it (TanStack refetches on mount, not
        // on every render); its interval and an event saying it changed ask too.
        !e.fetching && (e.tried.is_none() || stale && mounted || e.invalid)
    });
    if go {
        start(key, cx);
    }
    state(key, cx)
}

fn state<T: Send + Sync + 'static>(key: &str, cx: &App) -> QueryState<T> {
    let Some(e) = entity(cx).read(cx).entries.get(key) else { return QueryState::none() };
    QueryState { data: e.data.clone().and_then(|d| d.downcast::<T>().ok()), error: e.error.clone(), fetching: e.fetching }
}

/// What's held of query `key`, without asking.
pub fn data<T: Send + Sync + 'static>(key: &str, cx: &App) -> Option<Arc<T>> {
    state::<T>(key, cx).data
}

/// Puts `value` in as query `key`'s answer (a change shown before the core answers).
pub fn set<T: Send + Sync + 'static>(key: &str, value: T, cx: &mut App) {
    entity(cx).update(cx, |q, cx| {
        if let Some(e) = q.entries.get_mut(key) {
            e.data = Some(Arc::new(value));
            cx.notify();
        }
    });
}

/// Every query whose key starts with `prefix` is read again (now, if a view shows it).
pub fn invalidate(prefix: &str, cx: &mut App) {
    let now = Instant::now();
    let again: Vec<String> = entity(cx).update(cx, |q, _| {
        let mut again = vec![];
        for (k, e) in q.entries.iter_mut().filter(|(k, _)| k.starts_with(prefix)) {
            e.invalid = true;
            if now.duration_since(e.seen) < SEEN && !e.fetching {
                again.push(k.clone());
            }
        }
        again
    });
    for k in again {
        start(&k, cx);
    }
}

/// Every query that failed is asked again: a section's Retry (QueryErrorResetBoundary's reset).
pub fn retry_failed(cx: &mut App) {
    let again: Vec<String> = entity(cx).read(cx).entries.iter().filter(|(_, e)| e.error.is_some() && !e.fetching).map(|(k, _)| k.clone()).collect();
    for k in again {
        start(&k, cx);
    }
}

/// Reads `prefix`'s queries again, as `invalidate`, and answers once those under way have their
/// answers (invalidateQueries' promise).
pub fn refetch(prefix: &str, cx: &mut App) -> Task<()> {
    invalidate(prefix, cx);
    let prefix = prefix.to_string();
    cx.spawn(async move |cx| {
        loop {
            let busy = cx.update(|cx| entity(cx).read(cx).entries.iter().any(|(k, e)| k.starts_with(&prefix) && e.fetching));
            if !busy {
                break;
            }
            cx.background_executor().timer(Duration::from_millis(50)).await;
        }
    })
}

/// The events that change what a query read.
pub fn on_events(events: &[Event], cx: &mut App) {
    for e in events {
        let k = e.kind.as_str();
        if k.starts_with("profile.") {
            invalidate(MODELS, cx);
        }
        if matches!(k, "memory.written" | "setting.set" | "memory.forgotten") {
            invalidate(MEMORIES, cx);
        }
        if k.starts_with("connection.") {
            invalidate(NEEDS, cx);
        }
    }
}

/// Each record that reads; one that doesn't is left out, said in the log.
pub fn records_of<T: DeserializeOwned>(what: &str, raw: &Value) -> Vec<T> {
    raw.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|r| match serde_json::from_value(r.clone()) {
                    Ok(x) => Some(x),
                    Err(e) => {
                        log::warn!("a {what} didn't read: {e}");
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn page(name: &'static str, args: Value, cx: &mut App) -> Task<Result<Value, String>> {
    let rx = cx.global::<Net>().page(name, args);
    cx.background_executor().spawn(async move { rx.await.unwrap_or_else(|_| Err("Can't reach the core".into())) })
}

// The model profiles, from the core's /models (which asks every provider first, so it can take a
// while).

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelChoice {
    pub provider: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

fn image_default() -> ModelChoice {
    ModelChoice { provider: "gateway".into(), id: "openai/gpt-image-2.6-sunburst".into(), account: None }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Roles {
    pub turn: ModelChoice,
    pub triage: ModelChoice,
    pub gate: ModelChoice,
    pub decision: ModelChoice,
    pub browse: ModelChoice,
    /// Profiles saved before pictures had a role draw with the default.
    #[serde(default = "image_default")]
    pub image: ModelChoice,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NamedProfile {
    pub name: String,
    pub roles: Roles,
}

/// A provider account's models, as the catalog says.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Capability {
    pub host: String,
    pub provider: String,
    pub available: bool,
    #[serde(default)]
    pub completion: Option<bool>,
    pub models: Vec<String>,
    pub problem: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub same: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelsView {
    pub active: String,
    pub profiles: Vec<NamedProfile>,
    pub accounts: Vec<Capability>,
}

pub fn models(cx: &mut App) -> QueryState<ModelsView> {
    read(MODELS, Spec { stale: Duration::from_secs(60), ..Default::default() }, fetch_models, cx)
}

fn fetch_models(cx: &mut App) -> Task<Result<ModelsView, String>> {
    let net = cx.global::<Net>().clone();
    let job = net.get("/models");
    let timed = net.rt.spawn(async move { tokio::time::timeout(Duration::from_secs(60), job).await });
    cx.background_executor().spawn(async move {
        let a = match timed.await {
            Ok(Ok(Ok(Ok(a)))) => a,
            _ => return Err("Models connection failed".to_string()),
        };
        match a.status {
            401 => return Err("Models: Not paired".into()),
            403 => return Err("Models: Permission denied".into()),
            s if !(200..300).contains(&s) => return Err(format!("Models HTTP {s}")),
            _ => {}
        }
        let v = a.json();
        let active = v.get("active").and_then(Value::as_str).ok_or("Invalid models response")?.to_string();
        Ok(ModelsView { active, profiles: records_of("model profile", &v["profiles"]), accounts: records_of("provider account", &v["accounts"]) })
    })
}

// Provider accounts on the core's machine and their CLIs.

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountFlow {
    pub flow_id: String,
    pub url: String,
    /// What a device sign-in has the user type on the page; empty when the page gives a code back.
    pub code: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AccountView {
    pub id: String,
    pub provider: String,
    pub machine: String,
    pub added: bool,
    /// "signed-out", "pending", "connected", "limited".
    pub status: String,
    pub problem: String,
    pub used: f64,
    pub flow: Option<AccountFlow>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CliView {
    pub provider: String,
    pub machine: String,
    pub command: String,
    pub version: String,
    pub installable: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Accounts {
    pub accounts: Vec<AccountView>,
    pub clis: Vec<CliView>,
}

pub fn accounts(cx: &mut App) -> QueryState<Accounts> {
    read(ACCOUNTS, Spec { every: Some(Duration::from_secs(10)), gc: Some(Duration::ZERO), ..Default::default() }, fetch_accounts, cx)
}

fn fetch_accounts(cx: &mut App) -> Task<Result<Accounts, String>> {
    let job = cx.global::<Net>().get("/auth/accounts");
    cx.background_executor().spawn(async move {
        let a = job.await.unwrap_or_else(|_| Err(String::new())).map_err(|_| "Accounts connection failed".to_string())?;
        if !a.ok() {
            return Err(a.json().get("error").and_then(Value::as_str).unwrap_or("Account operation failed").to_string());
        }
        let v = a.json();
        Ok(Accounts { accounts: records_of("account", &v["accounts"]), clis: records_of("provider CLI", &v["clis"]) })
    })
}

// The ACP Registry's agents, as the core reads them from the web.

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RegistryAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    /// "binary", "npx", "uvx".
    pub distributions: Vec<String>,
}

pub fn registry(cx: &mut App) -> QueryState<Vec<RegistryAgent>> {
    read(
        REGISTRY,
        Spec { stale: Duration::from_secs(600), ..Default::default() },
        |cx| {
            let job = cx.global::<Net>().get("/providers/registry");
            cx.background_executor().spawn(async move {
                let a = job.await.ok().and_then(Result::ok).filter(|a| a.ok()).ok_or("ACP Registry unavailable")?;
                Ok(records_of("registry agent", &a.json()["agents"]))
            })
        },
        cx,
    )
}

// The brain's find (packages/core/src/find.ts): across every space for ⌘K, and the matching lines'
// seqs within one chat for ⌘F.

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Found {
    Message { id: String, space: String, seq: f64, time: f64, who: String, line: String },
    Item { id: String, space: String, title: String, time: f64, line: String },
    Memory { id: String, space: String, title: String, time: f64, line: String },
}

/// What was said and kept that holds the words, best first; none for no words.
pub fn find(query: &str, cx: &mut App) -> QueryState<Vec<Found>> {
    if query.trim().is_empty() {
        return QueryState::none();
    }
    let q = query.to_string();
    read(
        &format!("find:{query}"),
        Spec { stale: Duration::from_secs(15), ..Default::default() },
        move |cx| {
            let p = page("find", json!({ "query": q }), cx);
            cx.background_executor().spawn(async move { Ok(records_of("find result", &p.await?)) })
        },
        cx,
    )
}

/// The seqs of a space's chat lines that hold the words, oldest first.
pub fn find_in(space: &str, query: &str, cx: &mut App) -> QueryState<Vec<u64>> {
    if query.trim().is_empty() {
        return QueryState::none();
    }
    let (s, q) = (space.to_string(), query.to_string());
    read(
        &format!("find:{space}:{query}"),
        Spec { stale: Duration::from_secs(5), ..Default::default() },
        move |cx| {
            let p = page("find", json!({ "query": q, "space": s }), cx);
            cx.background_executor().spawn(async move {
                let v = p.await?;
                v.as_array().map(|a| a.iter().filter_map(Value::as_f64).map(|n| n as u64).collect()).ok_or_else(|| "Didn't read".to_string())
            })
        },
        cx,
    )
}

// The memory and system pages: pages of the brain's view (packages/core/src/system.ts).

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct MemoryRow {
    pub id: String,
    pub description: String,
    #[serde(rename = "type")]
    pub kind: String,
    /// "global" or a space.
    pub scope: String,
    pub body: String,
    pub triggered: bool,
    pub uses: f64,
}

pub fn memories(cx: &mut App) -> QueryState<Vec<MemoryRow>> {
    read(
        MEMORIES,
        Spec::default(),
        |cx| {
            let p = page("memories", json!({}), cx);
            cx.background_executor().spawn(async move { Ok(records_of("memory", &p.await?)) })
        },
        cx,
    )
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Spend {
    pub day: String,
    pub cost: f64,
    pub turns: f64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TurnRow {
    pub time: f64,
    pub thread: String,
    pub title: String,
    pub status: String,
    pub model: String,
    pub effort: String,
    pub cost: f64,
    pub ms: f64,
    pub host: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Granted {
    pub name: String,
    pub on: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Permissions {
    pub machine: String,
    pub time: f64,
    pub granted: Vec<Granted>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Projection {
    pub name: String,
    pub version: f64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TypeCount {
    #[serde(rename = "type")]
    pub kind: String,
    pub n: f64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Debug {
    pub seq: f64,
    pub bytes: f64,
    pub projections: Vec<Projection>,
    pub types: Vec<TypeCount>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct System {
    pub spend: Vec<Spend>,
    pub turns: Vec<TurnRow>,
    pub permissions: Vec<Permissions>,
    pub debug: Debug,
}

/// Refreshed only while a view shows it.
pub fn system(cx: &mut App) -> QueryState<System> {
    read(
        SYSTEM,
        Spec { every: Some(Duration::from_secs(30)), ..Default::default() },
        |cx| {
            let p = page("system", json!({}), cx);
            cx.background_executor().spawn(async move {
                let s = p.await?;
                Ok(System {
                    spend: records_of("day's spend", &s["spend"]),
                    turns: records_of("turn", &s["turns"]),
                    permissions: records_of("machine's permissions", &s["permissions"]),
                    debug: serde_json::from_value(s["debug"].clone()).map_err(|e| e.to_string())?,
                })
            })
        },
        cx,
    )
}

// What extensions need of each provider: asked again whenever a connection changes.

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ProviderNeed {
    pub provider: String,
    pub label: String,
    /// "oauth", "key", "session".
    pub kind: String,
    pub apps: Vec<String>,
    pub scopes: Vec<String>,
    pub multiple: bool,
}

pub fn needs(cx: &mut App) -> QueryState<Vec<ProviderNeed>> {
    read(
        NEEDS,
        Spec { every: Some(Duration::from_secs(30)), ..Default::default() },
        |cx| {
            let job = cx.global::<Net>().post("/widgets/connections/list", &json!({}));
            cx.background_executor().spawn(async move {
                let a = job.await.unwrap_or_else(|_| Err(String::new())).map_err(|_| "Can't reach the core".to_string())?;
                let v = a.json();
                if v.get("isError") == Some(&Value::Bool(true)) {
                    return Err(v.pointer("/content/0/text").and_then(Value::as_str).unwrap_or("Didn't go through").to_string());
                }
                Ok(records_of("provider need", v.pointer("/structuredContent/needs").unwrap_or(&Value::Null)))
            })
        },
        cx,
    )
}
