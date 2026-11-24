//! The brain's sync socket, as the desktop's `connection.ts` keeps it (T3 Code's way): a snapshot,
//! then live events, older history a page at a time on request, and commands back out. It
//! reconnects on its own and picks up where it left off with `?since=`; the brain sends a fresh
//! snapshot instead when that's too far back. Commands are kept on this Mac until the brain answers
//! (outbox.rs), so one survives the app going too: what's kept and not yet answered goes from here,
//! what a run before this one left included; one held for Undo goes when it's due, unless it was
//! undone by then; a message's files go up first. Network work runs on a Tokio runtime of its own;
//! the window hears it over a channel and awaits answers on one-shot channels, which any executor
//! can poll. The credential goes only in headers, never in a log.
// The typed API the views use; parts not yet drawn are still the API.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use futures::channel::mpsc::UnboundedSender as UiSender;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use crate::auth::{self, Auth};
use crate::brain::{Event, Link, Snapshot};
use crate::files::{UploadError, upload_kept};
use crate::json::{get, gs, gu, list};
use crate::outbox::{self, EntryKind};

const BACKOFF_MIN: Duration = Duration::from_millis(250);
const BACKOFF_MAX: Duration = Duration::from_secs(5);
/// How long a drop may last before it shows.
pub const DOWN: Duration = Duration::from_secs(2);

/// What the window hears from the network.
pub enum Incoming {
    /// The code the core waits on while this app pairs.
    Pairing(String),
    /// The core and the credential, once there is one.
    Authed,
    Snapshot(Box<Snapshot>),
    Events(Vec<Event>),
    Link(Link),
    /// The socket closed, or an attempt at it failed: down once that lasts, unless it opens.
    Closed,
    /// The core took a command, as of `seq`.
    Receipt(String, u64),
    /// What's kept changed.
    Outbox,
    /// Words came back to a box from outside it (a message the core said no to).
    Restored(String),
}

enum Reply {
    Command(oneshot::Sender<Result<u64, String>>),
    Page(oneshot::Sender<Result<Value, String>>),
    None,
}

enum Out {
    /// Sent now, or once the socket is back.
    Send { id: String, message: Value, reply: Reply },
    /// A kept one, ready: its files up.
    Fire { id: String, message: Value },
    /// A kept one isn't going now (gone, said no to, or waiting to go again).
    Unscheduled(String),
    /// What's kept changed: what's due goes.
    Kick,
    Watch(Vec<String>),
    /// The socket dialed again: the credential may have been refused (auth.rs checks it each minute).
    Redial,
}

/// An HTTP answer from the core: its status, its headers (lowercase), its body.
#[derive(Clone, Debug)]
pub struct Answer {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl Answer {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }
}

#[derive(Clone)]
pub struct Net {
    tx: mpsc::UnboundedSender<Out>,
    pub rt: Arc<tokio::runtime::Runtime>,
    auth: Arc<RwLock<Option<Auth>>>,
    http: reqwest::Client,
    /// Who waits on a kept command's answer.
    callers: Arc<Mutex<HashMap<String, oneshot::Sender<Result<u64, String>>>>>,
}

impl gpui::Global for Net {}

impl Net {
    pub fn start(ui: UiSender<Incoming>) -> Self {
        let rt = Arc::new(tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio"));
        let (tx, rx) = mpsc::unbounded_channel();
        let auth = Arc::new(RwLock::new(None));
        let http = reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).build().expect("http");
        let callers = Arc::new(Mutex::new(HashMap::new()));
        {
            let (ui, tx) = (ui.clone(), tx.clone());
            outbox::subscribe(move |c| {
                let _ = ui.unbounded_send(match c {
                    outbox::Change::Kept => Incoming::Outbox,
                    outbox::Change::Restored(place) => Incoming::Restored(place.clone()),
                });
                let _ = tx.send(Out::Kick);
            });
        }
        let net = Net { tx, rt: rt.clone(), auth, http, callers };
        rt.spawn(run(rx, ui, net.clone()));
        net
    }

    /// The core and credential, once paired.
    pub fn auth(&self) -> Option<Auth> {
        self.auth.read().ok().and_then(|a| a.clone())
    }

    /// Sends a command, kept on this Mac until the brain answers; resolves with the seq it landed
    /// at, or the brain's reason. A retry with the same id is a no-op in the brain.
    pub fn command(&self, id: String, command: &str, payload: Value) -> oneshot::Receiver<Result<u64, String>> {
        let (reply, rx) = oneshot::channel();
        if outbox::quiet() {
            let _ = reply.send(Ok(0));
            return rx;
        }
        // Checked against its schema first: what fails never leaves.
        if let Err(why) = crate::checks::checked(command, &payload) {
            let _ = reply.send(Err(why));
            return rx;
        }
        self.callers.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), reply);
        outbox::keep(outbox::Entry::command(id, command, payload));
        rx
    }

    /// An event of the client's own (analytics, a crash report); `id` makes a resend a no-op.
    pub fn emit(&self, event: &str, payload: Value, id: Option<String>) -> oneshot::Receiver<Result<u64, String>> {
        let (reply, rx) = oneshot::channel();
        if outbox::quiet() {
            let _ = reply.send(Ok(0));
            return rx;
        }
        let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let message = json!({ "type": "emit", "id": id, "event": event, "payload": payload });
        let _ = self.tx.send(Out::Send { id, message, reply: Reply::Command(reply) });
        rx
    }

    /// Older history (a space's chat, a thread's transcript), find, the memory and system pages.
    pub fn page(&self, name: &str, args: Value) -> oneshot::Receiver<Result<Value, String>> {
        let (reply, rx) = oneshot::channel();
        let id = uuid::Uuid::new_v4().to_string();
        let message = json!({ "type": "page", "id": id, "name": name, "args": args });
        let _ = self.tx.send(Out::Send { id, message, reply: Reply::Page(reply) });
        rx
    }

    /// The event types widgets on screen refresh on, kept across reconnects: high-rate streams come
    /// to the desktop only for them.
    pub fn watch(&self, types: Vec<String>) {
        let _ = self.tx.send(Out::Watch(types));
    }

    /// Dials the socket again; a credential the core refuses then is dropped and paired again.
    pub fn redial(&self) {
        let _ = self.tx.send(Out::Redial);
    }

    /// A route on the core (`/blobs/…`), its bytes; the credential goes in a header.
    pub fn fetch(&self, route: String) -> tokio::task::JoinHandle<Option<Vec<u8>>> {
        let job = self.send_http(reqwest::Method::GET, route, None);
        self.rt.spawn(async move {
            let a = job.await.ok()?.ok()?;
            a.ok().then_some(a.body)
        })
    }

    /// A route on the core, its bytes, or the status it answered with (0 when none came).
    pub fn fetch_status(&self, route: String) -> tokio::task::JoinHandle<Result<Vec<u8>, u16>> {
        let job = self.send_http(reqwest::Method::GET, route, None);
        self.rt.spawn(async move {
            let a = job.await.map_err(|_| 0u16)?.map_err(|_| 0u16)?;
            if a.ok() { Ok(a.body) } else { Err(a.status) }
        })
    }

    /// A route on the core, with a body (`Some((content type, bytes))`); "Can't reach the core"
    /// when it can't be reached.
    pub fn send_http(&self, method: reqwest::Method, route: String, body: Option<(String, Vec<u8>)>) -> tokio::task::JoinHandle<Result<Answer, String>> {
        let auth = self.auth();
        let http = self.http.clone();
        self.rt.spawn(async move {
            // A quiet copy reads, and writes nothing to the core.
            if crate::outbox::quiet() && method != reqwest::Method::GET && method != reqwest::Method::HEAD {
                return Err("Quiet: not sent".to_string());
            }
            let auth = auth.ok_or("Can't reach the core")?;
            let mut req = http.request(method, format!("{}{route}", auth.core)).bearer_auth(&auth.token);
            if let Some((kind, bytes)) = body {
                req = req.header("content-type", kind).body(bytes);
            }
            let res = req.send().await.map_err(|_| "Can't reach the core".to_string())?;
            let status = res.status().as_u16();
            let headers = res.headers().iter().filter_map(|(k, v)| Some((k.as_str().to_lowercase(), v.to_str().ok()?.to_string()))).collect();
            let body = res.bytes().await.map_err(|_| "Can't reach the core".to_string())?.to_vec();
            Ok(Answer { status, headers, body })
        })
    }

    /// A request to a route on the core (`/widgets/…`, `/items/…`) by method name; a body goes as
    /// plain text, as the desktop sends it.
    pub fn http(&self, method: &str, route: String, body: Option<Vec<u8>>) -> tokio::task::JoinHandle<Result<Answer, String>> {
        let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET);
        self.send_http(method, route, body.map(|b| ("text/plain".to_string(), b)))
    }

    /// A request on the core's private HTTP (`/auth/accounts`, …): a GET without a body, else a
    /// POST of it; its JSON answer, or what the core says went wrong.
    pub fn request(&self, route: String, body: Option<Value>) -> futures::channel::oneshot::Receiver<Result<Value, String>> {
        let (tx, rx) = futures::channel::oneshot::channel();
        let job = match &body {
            None => self.get(route),
            Some(b) => self.post(route, b),
        };
        self.rt.spawn(async move {
            let got = match job.await {
                Ok(Ok(a)) if a.ok() => Ok(a.json()),
                Ok(Ok(a)) => Err(a.json().get("error").and_then(Value::as_str).unwrap_or("Account operation failed").to_string()),
                _ => Err("Accounts connection failed".to_string()),
            };
            let _ = tx.send(got);
        });
        rx
    }

    /// A picture or a page off the web (a widget's `https:` image), its bytes; the core's own
    /// addresses go with the credential in a header.
    pub fn fetch_url(&self, url: String) -> tokio::task::JoinHandle<Option<Vec<u8>>> {
        let auth = self.auth();
        let http = self.http.clone();
        self.rt.spawn(async move {
            let mut req = http.get(&url);
            if let Some(a) = auth.filter(|a| url.starts_with(&a.core)) {
                req = req.bearer_auth(&a.token);
            }
            let res = req.send().await.ok()?;
            if !res.status().is_success() {
                return None;
            }
            res.bytes().await.ok().map(|b| b.to_vec())
        })
    }

    /// The core's address, once it's known.
    pub fn core(&self) -> Option<String> {
        self.auth().map(|a| a.core)
    }

    /// A GET on the core.
    pub fn get(&self, route: impl Into<String>) -> tokio::task::JoinHandle<Result<Answer, String>> {
        self.send_http(reqwest::Method::GET, route.into(), None)
    }

    /// A POST of JSON on the core.
    pub fn post(&self, route: impl Into<String>, body: &Value) -> tokio::task::JoinHandle<Result<Answer, String>> {
        self.send_http(reqwest::Method::POST, route.into(), Some(("text/plain".into(), body.to_string().into_bytes())))
    }

    /// A route on the core as an address with the credential in it, for what can't send a header
    /// (a web view, the system's player).
    pub fn core_url(&self, route: &str, params: &[(&str, &str)]) -> String {
        let Some(a) = self.auth() else { return String::new() };
        let Ok(mut url) = url::Url::parse(&a.core).and_then(|base| base.join(route)) else { return String::new() };
        {
            let mut q = url.query_pairs_mut();
            for (k, v) in params {
                q.append_pair(k, v);
            }
            q.append_pair("token", &a.token);
        }
        url.to_string()
    }

    /// An ask's live view, the core's own page (core/portal.ts): the item and the credential ride
    /// in its fragment, which never leaves this machine; `watch` only shows it.
    pub fn portal_url(&self, item: &str, watch: bool) -> String {
        let Some(a) = self.auth() else { return String::new() };
        let mut hash = url::form_urlencoded::Serializer::new(String::new());
        hash.append_pair("item", item).append_pair("token", &a.token);
        if watch {
            hash.append_pair("watch", "1");
        }
        format!("{}/portal#{}", a.core, hash.finish())
    }

    pub fn client(&self) -> reqwest::Client {
        self.http.clone()
    }

    /// A route on the core as a whole address with its query, the credential as `token` among it,
    /// as the desktop's `coreUrl` makes one: for a player that fetches it itself. None until the
    /// credential's in. The address is a secret; it's never printed.
    pub fn address(&self, route: &str, params: &[(&str, &str)]) -> Option<String> {
        let auth = self.auth.read().ok().and_then(|a| a.clone())?;
        let mut query: Vec<String> = params.iter().map(|(k, v)| format!("{k}={}", encode(v))).collect();
        query.push(format!("token={}", encode(&auth.token)));
        Some(format!("{}{route}?{}", auth.core, query.join("&")))
    }
}

/// A query value, percent-encoded.
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

async fn run(mut rx: mpsc::UnboundedReceiver<Out>, ui: UiSender<Incoming>, net: Net) {
    let core = auth::core();
    outbox::set_core(&core);
    let send = |m: Incoming| {
        let _ = ui.unbounded_send(m);
    };
    let pair = |ui: UiSender<Incoming>| {
        move |code| {
            let _ = ui.unbounded_send(Incoming::Pairing(code));
        }
    };
    let mut token = auth::credential(&net.http, &core, pair(ui.clone())).await;
    if let Ok(mut a) = net.auth.write() {
        *a = Some(Auth { core: core.clone(), token: token.clone() });
    }
    send(Incoming::Authed);
    let ws_base = core.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1);
    let mut cursor: Option<u64> = None;
    let mut waiting: HashMap<String, (Value, Reply)> = HashMap::new();
    // Each kept command waiting for its time, and how to wake it when that time changes.
    let mut scheduled: HashMap<String, Arc<tokio::sync::Notify>> = HashMap::new();
    let mut watched: Vec<String> = vec![];
    let mut backoff = BACKOFF_MIN;
    pick_up(&net, &mut scheduled, &waiting, Duration::ZERO);
    loop {
        send(Incoming::Link(Link::Connecting));
        let mut url = format!("{ws_base}/?source=desktop");
        if let Some(c) = cursor {
            url.push_str(&format!("&since={c}"));
        }
        let mut request = url.into_client_request().expect("request");
        request.headers_mut().insert("authorization", format!("Bearer {token}").parse().expect("header"));
        let connected = tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(request)).await;
        let ws = match connected {
            Ok(Ok((ws, _))) => ws,
            Ok(Err(WsError::Http(res))) if res.status() == 401 && !auth::good(&net.http, &core, &token).await => {
                // The core no longer takes this credential: find or pair another.
                auth::forget(&core);
                token = auth::credential(&net.http, &core, pair(ui.clone())).await;
                if let Ok(mut a) = net.auth.write() {
                    *a = Some(Auth { core: core.clone(), token: token.clone() });
                }
                send(Incoming::Authed);
                continue;
            }
            other => {
                if let Ok(Err(e)) = &other {
                    log::info!("sync socket didn't open: {e}");
                }
                send(Incoming::Closed);
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(BACKOFF_MAX);
                continue;
            }
        };
        backoff = BACKOFF_MIN;
        send(Incoming::Link(Link::Open));
        let (mut sink, mut stream) = ws.split();
        if !watched.is_empty() {
            let _ = sink.send(Message::text(json!({ "type": "watch", "types": watched }).to_string())).await;
        }
        for (message, _) in waiting.values() {
            let _ = sink.send(Message::text(message.to_string())).await;
        }
        loop {
            tokio::select! {
                out = rx.recv() => {
                    let Some(out) = out else { return };
                    match out {
                        Out::Send { id, message, reply } => {
                            let _ = sink.send(Message::text(message.to_string())).await;
                            waiting.insert(id, (message, reply));
                        }
                        Out::Fire { id, message } => {
                            scheduled.remove(&id);
                            if !waiting.contains_key(&id) {
                                let _ = sink.send(Message::text(message.to_string())).await;
                                waiting.insert(id, (message, Reply::None));
                            }
                        }
                        Out::Unscheduled(id) => { scheduled.remove(&id); }
                        Out::Kick => pick_up(&net, &mut scheduled, &waiting, Duration::ZERO),
                        Out::Watch(types) => {
                            watched = types;
                            let _ = sink.send(Message::text(json!({ "type": "watch", "types": watched }).to_string())).await;
                        }
                        Out::Redial => break,
                    }
                }
                frame = stream.next() => {
                    let Some(Ok(frame)) = frame else { break };
                    let Message::Text(text) = frame else { continue };
                    let Ok(m) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                    match get(&m, "type").as_str().unwrap_or_default() {
                        "snapshot" => {
                            keep_snapshot(&core, text.as_str());
                            let seq = gu(&m, "seq");
                            cursor = Some(seq);
                            send(Incoming::Snapshot(Box::new(Snapshot::of(seq, get(&m, "state")))));
                        }
                        "events" => {
                            let after = cursor.unwrap_or(0);
                            let fresh: Vec<Event> = list(get(&m, "events")).iter().map(Event::of).filter(|e| e.seq > after).collect();
                            if let Some(last) = fresh.last() {
                                cursor = Some(last.seq);
                                send(Incoming::Events(fresh));
                            }
                        }
                        kind => answered(&net, &send, &mut waiting, kind, &m),
                    }
                }
            }
        }
        // Whatever comes meanwhile waits in the channel, and goes once the socket is back.
        send(Incoming::Closed);
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// The brain answered something asked: a receipt, a page, or no.
fn answered(net: &Net, send: &impl Fn(Incoming), waiting: &mut HashMap<String, (Value, Reply)>, kind: &str, m: &Value) {
    let id = gs(m, "id");
    let reply = waiting.remove(&id).map(|(_, r)| r);
    let caller = net.callers.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    match kind {
        "receipt" => {
            let seq = gu(m, "seq");
            send(Incoming::Receipt(id.clone(), seq));
            outbox::drop(&id, false);
            if let Some(Reply::Command(r)) = reply {
                let _ = r.send(Ok(seq));
            }
            if let Some(c) = caller {
                let _ = c.send(Ok(seq));
            }
        }
        "page" => {
            if let Some(Reply::Page(r)) = reply {
                let _ = r.send(Ok(get(m, "value").clone()));
            }
        }
        _ => {
            let reason = gs(m, "reason");
            if kind == "rejected" {
                // A message stays, with what was said, for its "Not sent"; nothing goes again.
                if outbox::find(&id).is_some_and(|e| e.name == "message.post") {
                    outbox::update(&id, |e| e.rejected = Some(reason.clone()));
                } else {
                    outbox::drop(&id, false);
                }
            }
            match reply {
                Some(Reply::Command(r)) => {
                    let _ = r.send(Err(reason.clone()));
                }
                Some(Reply::Page(r)) => {
                    let _ = r.send(Err(reason.clone()));
                }
                _ => {}
            }
            if let Some(c) = caller {
                let _ = c.send(Err(reason));
            }
        }
    }
}

/// What's kept and not yet answered, each scheduled for when it's due (`after` from now at the
/// soonest). A widget's call is the iPhone's to make.
fn pick_up(net: &Net, scheduled: &mut HashMap<String, Arc<tokio::sync::Notify>>, waiting: &HashMap<String, (Value, Reply)>, after: Duration) {
    if outbox::quiet() {
        return;
    }
    for k in outbox::kept() {
        let ready = k.rejected.is_none() && k.kind != EntryKind::Call;
        if !ready || waiting.contains_key(&k.id) {
            continue;
        }
        match scheduled.get(&k.id) {
            // Kept again (sent now, held longer): it looks at its time again.
            Some(wake) => wake.notify_one(),
            None => {
                let wake = Arc::new(tokio::sync::Notify::new());
                scheduled.insert(k.id.clone(), wake.clone());
                net.rt.spawn(fire(net.clone(), k.id, after, wake));
            }
        }
    }
}

/// One kept command, when it's due: its files up one at a time (each kept as up, so a relaunch goes
/// on from the next), then sent.
async fn fire(net: Net, id: String, after: Duration, wake: Arc<tokio::sync::Notify>) {
    tokio::time::sleep(after).await;
    let k = loop {
        let Some(k) = outbox::find(&id).filter(|k| k.rejected.is_none()) else {
            let _ = net.tx.send(Out::Unscheduled(id));
            return;
        };
        // Held longer since (typing on): when it's due now.
        let wait = k.due.unwrap_or(0.) - outbox::now_ms();
        if wait <= 0. {
            break k;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(wait as u64)) => {}
            _ = wake.notified() => {}
        }
    };
    let mut payload = k.payload.clone();
    let files = k.files.clone().unwrap_or_default();
    if !files.is_empty() && payload.is_object() {
        let Some(a) = net.auth() else {
            let _ = net.tx.send(Out::Unscheduled(id));
            return;
        };
        let mut done = vec![];
        for f in &files {
            match upload_kept(&net.http, &a.core, &a.token, f).await {
                Ok(up) => {
                    outbox::update(&id, |e| {
                        if let Some(fs) = e.files.as_mut() {
                            for g in fs.iter_mut().filter(|g| g.id == f.id) {
                                g.blob = Some(up.blob.clone());
                            }
                        }
                    });
                    done.push(up.to_json());
                }
                Err(UploadError::Refused(reason)) => {
                    outbox::update(&id, |e| e.rejected = Some(reason));
                    let _ = net.tx.send(Out::Unscheduled(id));
                    return;
                }
                Err(UploadError::Later(_)) => {
                    // Couldn't upload yet: again in a while.
                    let _ = net.tx.send(Out::Unscheduled(id));
                    tokio::time::sleep(BACKOFF_MAX).await;
                    let _ = net.tx.send(Out::Kick);
                    return;
                }
            }
        }
        payload["attachments"] = Value::Array(done);
    }
    let message = match k.kind {
        EntryKind::Emit => json!({ "type": "emit", "id": id, "event": k.name, "payload": payload }),
        _ => json!({ "type": "command", "id": id, "command": k.name, "payload": payload }),
    };
    let _ = net.tx.send(Out::Fire { id, message });
}

/// The last snapshot, kept on disk by core so the next start draws its first frame in its final
/// layout (the rail never empty) before the core answers.
fn snapshot_path(core: &str) -> std::path::PathBuf {
    let name: String = core.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    // The bundle's own, like its outbox.
    crate::outbox::dir().join(format!("gpui-snapshot-{name}.json"))
}

fn keep_snapshot(core: &str, frame: &str) {
    let p = snapshot_path(core);
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = p.with_extension("tmp");
    if std::fs::write(&tmp, frame).is_ok() {
        let _ = std::fs::rename(tmp, p);
    }
}

/// The snapshot kept by the last run for this core, if there is one.
pub fn held_snapshot() -> Option<Snapshot> {
    let b = std::fs::read(snapshot_path(&auth::core())).ok()?;
    let m: Value = serde_json::from_slice(&b).ok()?;
    Some(Snapshot::of(gu(&m, "seq"), get(&m, "state")))
}
