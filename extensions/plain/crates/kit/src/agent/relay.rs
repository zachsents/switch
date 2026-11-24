//! `<app> mcp`: the app's MCP server on stdin and stdout. It relays to the running app through
//! its socket, launching the app in the background for anything that needs it. Listing tools,
//! resources and events doesn't, so an agent session starting never relaunches a quit app.
//!
//! It speaks both eras of MCP: the `initialize` handshake (2025-11-25 and earlier) and
//! per-request metadata with `server/discover` and `subscriptions/listen` (2026-07-28). Requests
//! are answered concurrently, so a long poll or an event stream never holds up a tool call.

use std::{
    collections::BTreeMap,
    io::{self, BufRead, BufReader, Write},
    os::unix::{net::UnixStream, process::CommandExt},
    process::{Command, Stdio},
    sync::{Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde_json::{Value, json};

use super::{
    Notice, Reply, Request,
    events::{matches, parse_cursor},
    saved_catalog, send, socket_path,
    widgets::{self, VERSION_KEY, WATCH_TOOL},
};
use crate::AppInfo;

/// Protocol versions this server speaks, newest first. The first is the per-request era.
const PROTOCOL_VERSIONS: &[&str] = &[
    "2026-07-28",
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
];

/// The newest version that starts with `initialize`.
const NEWEST_HANDSHAKE_VERSION: &str = "2025-11-25";

const EVENTS: &str = "io.modelcontextprotocol/events";
const APPS: &str = "io.modelcontextprotocol/ui";
const SUBSCRIPTION_ID: &str = "io.modelcontextprotocol/subscriptionId";

/// Where a host forwarding a tap on a widget puts the A2UI action it came from, in a tool
/// call's `_meta`, so the change counts as the person's.
const TAP: &str = "a2ui/action";

/// How long a view's `watch_widget` waits for a change before answering that nothing changed.
const WATCH_TIMEOUT: Duration = Duration::from_secs(25);

const DEFAULT_HEARTBEAT: Duration = Duration::from_secs(30);

/// A failed request, as JSON-RPC reports it.
struct Failure {
    code: i64,
    message: String,
    data: Option<Value>,
}

impl Failure {
    fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    fn with(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}

const INVALID_PARAMS: i64 = -32602;
const METHOD_NOT_FOUND: i64 = -32601;
const INTERNAL: i64 = -32603;
const NOT_FOUND: i64 = -32023;
const UNSUPPORTED: i64 = -32026;
const UNSUPPORTED_VERSION: i64 = -32022;

/// A long-lived request: an event stream or a `subscriptions/listen` stream.
struct Stream {
    /// The request's id, which is also the subscription's.
    id: Value,
    kind: Kind,
    /// When the stream last carried a message, for heartbeats.
    last_sent: Instant,
}

enum Kind {
    Events {
        name: String,
        arguments: Value,
        heartbeat: Duration,
        /// How far the host has heard, as a cursor and the position in it.
        cursor: Option<String>,
        reached: u64,
        /// Occurrences that arrived while the stream was still catching up.
        waiting: Option<Vec<Value>>,
    },
    Listen {
        /// Each subscribed resource and the version it last read as.
        versions: BTreeMap<String, String>,
        acknowledged: bool,
    },
}

/// Where the server's messages go: stdout, or an HTTP response.
pub(crate) type Output = Box<dyn Fn(Value) + Send + Sync>;

pub(crate) struct Server {
    app: AppInfo,
    out: Output,
    streams: Mutex<Vec<Stream>>,
    /// Resources subscribed with `resources/subscribe`, and the version each last read as.
    subscribed: Mutex<BTreeMap<String, String>>,
    /// Counts the changes the app has reported, for views waiting on one.
    changes: Mutex<u64>,
    changed: Condvar,
    /// Whether the app is being listened to.
    watch_started: Mutex<bool>,
    /// The connection the app's notices come in on, closed when the server goes away so the
    /// thread reading it ends too.
    watch_connection: Mutex<Option<UnixStream>>,
    /// Held while delivering events, so each stream hears them in order.
    delivering: Mutex<()>,
}

/// Runs `<app> mcp`: an MCP server on stdin and stdout that relays to the running app.
pub(crate) fn serve_stdio(app: AppInfo) {
    let stdout = Mutex::new(io::stdout());
    let server = Server::start(
        app,
        Box::new(move |message| {
            let mut out = stdout.lock().expect("stdout lock");
            writeln!(out, "{message}").and_then(|()| out.flush()).ok();
        }),
    );
    for line in io::stdin().lock().lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let message = match serde_json::from_str::<Value>(&line) {
            Ok(message) => message,
            Err(error) => {
                server.write(&json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32700, "message": error.to_string() },
                }));
                continue;
            }
        };
        server.receive(message);
    }
}

/// Runs `<app> screenshot`, for agents working from a shell: has the running app save PNGs of
/// its windows, then prints where they went.
pub(crate) fn print_screenshot(app: AppInfo) {
    let request = Request::Call {
        tool: "screenshot".into(),
        arguments: json!({}),
        person: false,
    };
    let saved = ask(app, &request).and_then(|result| {
        let text = result["content"][0]["text"].as_str().unwrap_or_default();
        serde_json::from_str::<Value>(text).map_err(|error| error.to_string())
    });
    match saved {
        Ok(saved) => println!("{saved:#}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

impl Server {
    /// A server that sends its messages to `out`, with its heartbeats running.
    pub(crate) fn start(app: AppInfo, out: Output) -> Arc<Self> {
        let server = Arc::new(Self {
            app,
            out,
            streams: Mutex::new(Vec::new()),
            subscribed: Mutex::new(BTreeMap::new()),
            changes: Mutex::new(0),
            changed: Condvar::new(),
            watch_started: Mutex::new(false),
            watch_connection: Mutex::new(None),
            delivering: Mutex::new(()),
        });
        // The thread lasts as long as the server, which an HTTP session may not.
        let weak = Arc::downgrade(&server);
        thread::spawn(move || {
            while let Some(server) = weak.upgrade() {
                server.send_heartbeats();
                drop(server);
                thread::sleep(Duration::from_secs(1));
            }
        });
        server
    }

    /// Acts on a message from the client: a request is answered on a thread of its own, and a
    /// notification at once. Responses to requests are ignored; this server sends none.
    pub(crate) fn receive(self: &Arc<Self>, message: Value) {
        let Some(method) = message["method"].as_str().map(str::to_string) else {
            return;
        };
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        match message.get("id").filter(|id| !id.is_null()).cloned() {
            None => self.notified(&method, &params),
            Some(id) => {
                let server = self.clone();
                thread::spawn(move || server.request(id, &method, params));
            }
        }
    }

    fn write(&self, message: &Value) {
        (self.out)(message.clone());
    }

    fn notify(&self, method: &str, params: Value) {
        self.write(&json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    pub(crate) fn notified(&self, method: &str, params: &Value) {
        if method == "notifications/cancelled" {
            let id = &params["requestId"];
            self.streams
                .lock()
                .expect("streams lock")
                .retain(|stream| &stream.id != id);
        }
    }

    fn request(self: &Arc<Self>, id: Value, method: &str, params: Value) {
        let answer = self.answer(&id, method, &params);
        let response = match answer {
            // Long-lived requests answer with notifications instead.
            Ok(None) => return,
            Ok(Some(mut result)) => {
                if let Some(fields) = result.as_object_mut() {
                    fields.insert("resultType".into(), json!("complete"));
                }
                json!({ "jsonrpc": "2.0", "id": id, "result": result })
            }
            Err(failure) => {
                let mut error = json!({ "code": failure.code, "message": failure.message });
                if let Some(data) = failure.data {
                    error["data"] = data;
                }
                json!({ "jsonrpc": "2.0", "id": id, "error": error })
            }
        };
        self.write(&response);
    }

    /// Answers one request, or `None` for one that stays open.
    fn answer(
        self: &Arc<Self>,
        id: &Value,
        method: &str,
        params: &Value,
    ) -> Result<Option<Value>, Failure> {
        let meta = &params["_meta"];
        if let Some(requested) = meta["io.modelcontextprotocol/protocolVersion"].as_str()
            && !PROTOCOL_VERSIONS.contains(&requested)
        {
            return Err(
                Failure::new(UNSUPPORTED_VERSION, "Unsupported protocol version")
                    .with(json!({ "supported": PROTOCOL_VERSIONS, "requested": requested })),
            );
        }
        let result = match method {
            "initialize" => {
                let requested = params["protocolVersion"].as_str();
                let version = PROTOCOL_VERSIONS[1..]
                    .iter()
                    .copied()
                    .find(|&version| Some(version) == requested)
                    .unwrap_or(NEWEST_HANDSHAKE_VERSION);
                json!({
                    "protocolVersion": version,
                    "capabilities": capabilities(),
                    "serverInfo": self.server_info(),
                    "instructions": self.instructions(),
                })
            }
            "server/discover" => json!({
                "supportedVersions": PROTOCOL_VERSIONS,
                "capabilities": capabilities(),
                "instructions": self.instructions(),
                "_meta": { "io.modelcontextprotocol/serverInfo": self.server_info() },
                "ttlMs": 3_600_000,
                "cacheScope": "public",
            }),
            "ping" | "logging/setLevel" => json!({}),
            // Tools only views call are listed for every client: hosts that draw MCP Apps don't
            // always say so, and they keep such tools from the model.
            "tools/list" => cacheable(json!({ "tools": self.catalog()?["tools"] })),
            "tools/call" => self.call(params)?,
            "resources/list" => cacheable(json!({ "resources": self.catalog()?["resources"] })),
            "resources/templates/list" => {
                cacheable(json!({ "resourceTemplates": self.catalog()?["templates"] }))
            }
            "resources/read" => self.read(params["uri"].as_str().unwrap_or_default())?,
            "resources/subscribe" => {
                let uri = required(params, "uri")?;
                self.watch();
                let version = self.version_of(uri);
                self.subscribed
                    .lock()
                    .expect("subscribed lock")
                    .insert(uri.to_string(), version);
                json!({})
            }
            "resources/unsubscribe" => {
                let uri = required(params, "uri")?;
                self.subscribed.lock().expect("subscribed lock").remove(uri);
                json!({})
            }
            "subscriptions/listen" => {
                self.listen(id, params);
                return Ok(None);
            }
            "events/list" => json!({ "events": self.catalog()?["events"] }),
            "events/poll" => {
                let name = self.event_type(params)?;
                let polled = ask(
                    self.app,
                    &Request::Poll {
                        name,
                        arguments: params["arguments"].clone(),
                        cursor: params["cursor"].as_str().map(str::to_string),
                        max_events: params["maxEvents"].as_u64().map(|max| max as usize),
                        max_age_ms: params["maxAgeMs"].as_u64(),
                    },
                );
                polled.map_err(|error| Failure::new(INTERNAL, error))?
            }
            "events/stream" => {
                let name = self.event_type(params)?;
                self.stream_events(id, name, params)?;
                return Ok(None);
            }
            "events/subscribe" | "events/unsubscribe" => {
                return Err(Failure::new(UNSUPPORTED, "Unsupported")
                    .with(json!({ "feature": "deliveryMode", "value": "webhook" })));
            }
            _ => {
                return Err(Failure::new(
                    METHOD_NOT_FOUND,
                    format!("unknown method `{method}`"),
                ));
            }
        };
        Ok(Some(result))
    }

    fn server_info(&self) -> Value {
        json!({ "name": self.app.id, "title": self.app.name, "version": env!("CARGO_PKG_VERSION") })
    }

    fn instructions(&self) -> String {
        format!(
            "Controls the {} app on this computer. Changes show up in the app immediately, and \
             it's launched in the background if it isn't running. Every tool returns the app's \
             state after the change. Tools named show_* return widgets \
             that hosts draw; their text says what they show. Events: action.performed is heard \
             after every action, whoever did it.",
            self.app.name
        )
    }

    /// What the app offers, from the copy this build saved, or from the app.
    fn catalog(&self) -> Result<Value, Failure> {
        saved_catalog(self.app)
            .map_or_else(|| ask(self.app, &Request::Catalog), Ok)
            .map_err(|error| Failure::new(INTERNAL, error))
    }

    /// The event type a request names, if the app offers it.
    fn event_type(&self, params: &Value) -> Result<String, Failure> {
        let name = required(params, "name")?;
        let catalog = self.catalog()?;
        let event = catalog["events"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|event| event["name"] == name)
            .ok_or_else(|| {
                Failure::new(NOT_FOUND, format!("no event type `{name}`"))
                    .with(json!({ "kind": "event" }))
            })?;
        let filters = &event["inputSchema"]["properties"];
        let arguments = params["arguments"].as_object().into_iter().flatten();
        if let Some((field, _)) = arguments
            .into_iter()
            .find(|(field, _)| filters[field].is_null())
        {
            return Err(Failure::new(
                INVALID_PARAMS,
                format!("`{name}` can't be filtered by `{field}`"),
            ));
        }
        Ok(name.to_string())
    }

    fn call(self: &Arc<Self>, params: &Value) -> Result<Value, Failure> {
        let tool = required(params, "name")?.to_string();
        let arguments = params
            .get("arguments")
            .filter(|arguments| !arguments.is_null())
            .cloned()
            .unwrap_or_else(|| json!({}));
        if tool == WATCH_TOOL {
            return Ok(self.watch_widget(&arguments));
        }
        // A host forwarding a tap on a widget passes the A2UI action it came from.
        let person = !params["_meta"][TAP].is_null();
        let call = Request::Call {
            tool,
            arguments,
            person,
        };
        Ok(ask(self.app, &call).unwrap_or_else(
            |error| json!({ "content": [{ "type": "text", "text": error }], "isError": true }),
        ))
    }

    fn read(&self, uri: &str) -> Result<Value, Failure> {
        if uri == widgets::renderer_uri(self.app) {
            return widgets::renderer(self.app)
                .ok_or_else(|| Failure::new(INTERNAL, "the widget renderer isn't built"));
        }
        let read = ask(self.app, &Request::Read { uri: uri.into() });
        read.map(cacheable_private)
            .map_err(|error| Failure::new(INVALID_PARAMS, error).with(json!({ "uri": uri })))
    }

    /// What a resource reads as, to tell when it changes. An unreadable one reads as nothing.
    fn version_of(&self, uri: &str) -> String {
        let read = ask(self.app, &Request::Read { uri: uri.into() });
        read.ok()
            .and_then(|read| read["contents"][0]["text"].as_str().map(widgets::version))
            .unwrap_or_default()
    }

    /// Answers a view's `watch_widget`: the widget's messages once they differ from the version
    /// it shows, or after a while, that nothing changed.
    fn watch_widget(self: &Arc<Self>, arguments: &Value) -> Value {
        let uri = arguments["uri"].as_str().unwrap_or_default();
        let shown = arguments["version"].as_str().map(str::to_string);
        self.watch();
        let deadline = Instant::now() + WATCH_TIMEOUT;
        loop {
            let seen = *self.changes.lock().expect("changes lock");
            let read = match ask(self.app, &Request::Read { uri: uri.into() }) {
                Ok(read) => read,
                Err(error) => {
                    return json!({ "content": [{ "type": "text", "text": error }], "isError": true });
                }
            };
            let text = read["contents"][0]["text"].as_str().unwrap_or_default();
            let version = widgets::version(text);
            if shown.as_deref() != Some(version.as_str()) {
                return json!({
                    "content": [widgets::embedded(uri, text.to_string())],
                    "isError": false,
                    "_meta": { VERSION_KEY: version },
                });
            }
            let changes = self.changes.lock().expect("changes lock");
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return json!({
                    "content": [{ "type": "text", "text": "unchanged" }],
                    "isError": false,
                    "_meta": { VERSION_KEY: version },
                });
            }
            let (_changes, _) = self
                .changed
                .wait_timeout_while(changes, remaining, |changes| *changes == seen)
                .expect("changes lock");
        }
    }

    /// Opens a `subscriptions/listen` stream. Of what it can ask for, resources are all that
    /// change here: the lists of tools, resources and prompts don't change while the app runs.
    fn listen(self: &Arc<Self>, id: &Value, params: &Value) {
        let uris: Vec<String> = params["notifications"]["resourceSubscriptions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|uri| uri.as_str().map(str::to_string))
            .collect();
        self.watch();
        let versions = uris
            .iter()
            .map(|uri| (uri.clone(), self.version_of(uri)))
            .collect();
        self.streams.lock().expect("streams lock").push(Stream {
            id: id.clone(),
            kind: Kind::Listen {
                versions,
                acknowledged: false,
            },
            last_sent: Instant::now(),
        });
        self.notify(
            "notifications/subscriptions/acknowledged",
            json!({ "notifications": { "resourceSubscriptions": uris }, "_meta": { SUBSCRIPTION_ID: id } }),
        );
        for stream in self.streams.lock().expect("streams lock").iter_mut() {
            if &stream.id == id
                && let Kind::Listen { acknowledged, .. } = &mut stream.kind
            {
                *acknowledged = true;
            }
        }
        // Anything that changed before the acknowledgment is told now.
        self.check_resources();
    }

    /// Opens an `events/stream`: confirms it, sends what the host missed since its cursor, then
    /// what happens as it happens.
    fn stream_events(
        self: &Arc<Self>,
        id: &Value,
        name: String,
        params: &Value,
    ) -> Result<(), Failure> {
        let heartbeat = params["heartbeatMs"]
            .as_u64()
            .map_or(DEFAULT_HEARTBEAT, |ms| {
                Duration::from_millis(ms).clamp(Duration::from_secs(5), Duration::from_secs(120))
            });
        let arguments = params["arguments"].clone();
        let poll = |cursor: Option<String>| {
            ask(
                self.app,
                &Request::Poll {
                    name: name.clone(),
                    arguments: arguments.clone(),
                    cursor,
                    max_events: Some(500),
                    max_age_ms: params["maxAgeMs"].as_u64(),
                },
            )
            .map_err(|error| Failure::new(INTERNAL, error))
        };
        // Registered first, so what happens while it catches up waits rather than being missed.
        self.streams.lock().expect("streams lock").push(Stream {
            id: id.clone(),
            kind: Kind::Events {
                name: name.clone(),
                arguments: arguments.clone(),
                heartbeat,
                cursor: None,
                reached: 0,
                waiting: Some(Vec::new()),
            },
            last_sent: Instant::now(),
        });
        self.watch();
        let first = poll(params["cursor"].as_str().map(str::to_string)).inspect_err(|_| {
            self.streams
                .lock()
                .expect("streams lock")
                .retain(|stream| &stream.id != id);
        })?;
        let subscription = json!({ SUBSCRIPTION_ID: id });
        self.notify(
            "notifications/events/active",
            json!({
                "cursor": first["cursor"],
                "truncated": first["truncated"],
                "heartbeatMs": heartbeat.as_millis() as u64,
                "_meta": subscription,
            }),
        );
        let mut batch = first;
        loop {
            for occurrence in batch["events"].as_array().into_iter().flatten() {
                self.deliver(id, occurrence.clone());
            }
            let cursor = batch["cursor"].as_str().map(str::to_string);
            self.reach(id, cursor.clone());
            if batch["hasMore"] != json!(true) {
                break;
            }
            batch = poll(cursor)?;
        }
        // Caught up: what arrived meanwhile goes out now, apart from what the replay covered.
        let _delivering = self.delivering.lock().expect("delivery lock");
        let waiting = self
            .streams
            .lock()
            .expect("streams lock")
            .iter_mut()
            .find(|stream| &stream.id == id)
            .and_then(|stream| match &mut stream.kind {
                Kind::Events { waiting, .. } => waiting.take(),
                Kind::Listen { .. } => None,
            })
            .unwrap_or_default();
        for occurrence in waiting {
            self.deliver(id, occurrence);
        }
        Ok(())
    }

    /// Records how far a stream's host has heard.
    fn reach(&self, id: &Value, position: Option<String>) {
        let Some(position) = position else {
            return;
        };
        let seq = parse_cursor(&position).map_or(0, |(_, seq)| seq);
        for stream in self.streams.lock().expect("streams lock").iter_mut() {
            if &stream.id == id
                && let Kind::Events {
                    cursor, reached, ..
                } = &mut stream.kind
                && seq >= *reached
            {
                *cursor = Some(position.clone());
                *reached = seq;
            }
        }
    }

    /// Sends an occurrence on a stream, unless the host has heard it already.
    fn deliver(&self, id: &Value, occurrence: Value) {
        let position = occurrence["cursor"].as_str().map(str::to_string);
        let seq = position
            .as_deref()
            .and_then(parse_cursor)
            .map_or(0, |(_, seq)| seq);
        let fresh = self
            .streams
            .lock()
            .expect("streams lock")
            .iter_mut()
            .find(|stream| &stream.id == id)
            .is_some_and(|stream| {
                stream.last_sent = Instant::now();
                matches!(&stream.kind, Kind::Events { reached, .. } if seq > *reached)
            });
        if !fresh {
            return;
        }
        let mut params = occurrence;
        params["_meta"] = json!({ SUBSCRIPTION_ID: id });
        self.notify("notifications/events/event", params);
        self.reach(id, position);
    }

    /// Starts listening to the app, once, for as long as this server runs, launching the app if
    /// it isn't running. It returns once the app is heard live, so nothing that happens after
    /// is missed. While the app isn't running there's nothing to hear, so it waits for the app to
    /// come back, catching up then.
    fn watch(self: &Arc<Self>) {
        let mut started = self.watch_started.lock().expect("watch lock");
        if *started {
            return;
        }
        *started = true;
        let first = connect(self.app)
            .ok()
            .and_then(|stream| self.start_watching(stream));
        // The thread lasts as long as the server: when the server goes, its connection is
        // closed, which ends the read the thread is waiting in.
        let weak = Arc::downgrade(self);
        thread::spawn(move || {
            if let Some(notices) = first {
                hear(&weak, notices);
            }
            loop {
                thread::sleep(Duration::from_secs(2));
                let Some(server) = weak.upgrade() else {
                    return;
                };
                let notices = UnixStream::connect(socket_path(server.app))
                    .ok()
                    .and_then(|stream| server.start_watching(stream));
                if let Some(notices) = notices {
                    // The app changed while nobody was watching.
                    server.app_changed();
                    server.catch_up();
                    drop(server);
                    hear(&weak, notices);
                }
            }
        });
    }

    /// Asks the app on `stream` to tell what happens, returning its notices once it has started.
    fn start_watching(&self, stream: UnixStream) -> Option<impl Iterator<Item = String> + use<>> {
        *self.watch_connection.lock().expect("watch lock") = stream.try_clone().ok();
        start_watching(stream)
    }

    fn app_changed(&self) {
        *self.changes.lock().expect("changes lock") += 1;
        self.changed.notify_all();
        self.check_resources();
    }

    /// Tells subscribers about each subscribed resource that now reads differently.
    fn check_resources(&self) {
        let mut uris: Vec<String> = self
            .subscribed
            .lock()
            .expect("subscribed lock")
            .keys()
            .cloned()
            .collect();
        for stream in self.streams.lock().expect("streams lock").iter() {
            if let Kind::Listen { versions, .. } = &stream.kind {
                uris.extend(versions.keys().cloned());
            }
        }
        uris.sort();
        uris.dedup();
        for uri in uris {
            let version = self.version_of(&uri);
            let subscribed = self
                .subscribed
                .lock()
                .expect("subscribed lock")
                .get_mut(&uri)
                .is_some_and(|shown| std::mem::replace(shown, version.clone()) != version);
            if subscribed {
                self.notify("notifications/resources/updated", json!({ "uri": uri }));
            }
            let listeners: Vec<Value> = self
                .streams
                .lock()
                .expect("streams lock")
                .iter_mut()
                .filter_map(|stream| match &mut stream.kind {
                    Kind::Listen {
                        versions,
                        acknowledged: true,
                    } => versions
                        .get_mut(&uri)
                        .is_some_and(|shown| std::mem::replace(shown, version.clone()) != version)
                        .then(|| stream.id.clone()),
                    _ => None,
                })
                .collect();
            for id in listeners {
                self.notify(
                    "notifications/resources/updated",
                    json!({ "uri": uri, "_meta": { SUBSCRIPTION_ID: id } }),
                );
            }
        }
    }

    /// Passes an occurrence to each stream of its type that wants it.
    fn occurred(&self, name: &str, occurrence: Value) {
        let _delivering = self.delivering.lock().expect("delivery lock");
        let mut ready = Vec::new();
        for stream in self.streams.lock().expect("streams lock").iter_mut() {
            let Kind::Events {
                name: wanted,
                arguments,
                waiting,
                ..
            } = &mut stream.kind
            else {
                continue;
            };
            if wanted != name || !matches(arguments, &occurrence["data"]) {
                continue;
            }
            match waiting {
                Some(waiting) => waiting.push(occurrence.clone()),
                None => ready.push(stream.id.clone()),
            }
        }
        for id in ready {
            self.deliver(&id, occurrence.clone());
        }
    }

    /// After the app comes back, sends each live stream what happened since its cursor.
    fn catch_up(&self) {
        let streams: Vec<(Value, String, Value, Option<String>)> = self
            .streams
            .lock()
            .expect("streams lock")
            .iter()
            .filter_map(|stream| match &stream.kind {
                Kind::Events {
                    name,
                    arguments,
                    cursor,
                    waiting: None,
                    ..
                } => Some((
                    stream.id.clone(),
                    name.clone(),
                    arguments.clone(),
                    cursor.clone(),
                )),
                _ => None,
            })
            .collect();
        for (id, name, arguments, mut cursor) in streams {
            loop {
                let request = Request::Poll {
                    name: name.clone(),
                    arguments: arguments.clone(),
                    cursor: cursor.clone(),
                    max_events: Some(500),
                    max_age_ms: None,
                };
                let Ok(batch) = ask(self.app, &request) else {
                    break;
                };
                if batch["truncated"] == json!(true) {
                    let mut params = json!({
                        "cursor": batch["cursor"],
                        "truncated": true,
                        "_meta": { SUBSCRIPTION_ID: id },
                    });
                    if let Some(Stream {
                        kind: Kind::Events { heartbeat, .. },
                        ..
                    }) = self
                        .streams
                        .lock()
                        .expect("streams lock")
                        .iter()
                        .find(|stream| stream.id == id)
                    {
                        params["heartbeatMs"] = json!(heartbeat.as_millis() as u64);
                    }
                    self.notify("notifications/events/active", params);
                }
                for occurrence in batch["events"].as_array().into_iter().flatten() {
                    self.deliver(&id, occurrence.clone());
                }
                cursor = batch["cursor"].as_str().map(str::to_string);
                self.reach(&id, cursor.clone());
                if batch["hasMore"] != json!(true) {
                    break;
                }
            }
        }
    }

    /// Keeps quiet streams alive and their hosts' cursors current: sends a heartbeat on each
    /// that has been quiet for its interval.
    fn send_heartbeats(&self) {
        let due: Vec<(Value, Option<String>)> = self
            .streams
            .lock()
            .expect("streams lock")
            .iter_mut()
            .filter_map(|stream| match &stream.kind {
                Kind::Events {
                    heartbeat,
                    cursor,
                    waiting: None,
                    ..
                } if stream.last_sent.elapsed() >= *heartbeat => {
                    stream.last_sent = Instant::now();
                    Some((stream.id.clone(), cursor.clone()))
                }
                _ => None,
            })
            .collect();
        for (id, cursor) in due {
            self.notify(
                "notifications/events/heartbeat",
                json!({ "cursor": cursor, "_meta": { SUBSCRIPTION_ID: id } }),
            );
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(connection) = self.watch_connection.lock().expect("watch lock").take() {
            connection.shutdown(std::net::Shutdown::Both).ok();
        }
    }
}

/// Acts on the app's notices until it goes away, or the server does.
fn hear(server: &std::sync::Weak<Server>, notices: impl Iterator<Item = String>) {
    for line in notices {
        let Some(server) = server.upgrade() else {
            return;
        };
        match serde_json::from_str(&line) {
            Ok(Notice::Changed) => server.app_changed(),
            Ok(Notice::Event { name, occurrence }) => server.occurred(&name, occurrence),
            Err(_) => {}
        }
    }
}

fn capabilities() -> Value {
    json!({
        "tools": {},
        "resources": { "subscribe": true },
        "extensions": { EVENTS: {}, APPS: {} },
    })
}

/// Marks a list result as safe to reuse for a minute.
fn cacheable(mut result: Value) -> Value {
    result["ttlMs"] = json!(60_000);
    result["cacheScope"] = json!("private");
    result
}

/// Marks a read as current only now.
fn cacheable_private(mut result: Value) -> Value {
    result["ttlMs"] = json!(0);
    result["cacheScope"] = json!("private");
    result
}

fn required<'a>(params: &'a Value, field: &str) -> Result<&'a str, Failure> {
    params[field]
        .as_str()
        .ok_or_else(|| Failure::new(INVALID_PARAMS, format!("missing `{field}`")))
}

/// Asks the app on `stream` to tell what happens, returning its notices once it has started.
fn start_watching(stream: UnixStream) -> Option<impl Iterator<Item = String>> {
    let mut writer = &stream;
    let watch = serde_json::to_string(&Request::Watch).expect("requests are plain JSON");
    writeln!(writer, "{watch}").ok()?;
    let mut lines = BufReader::new(stream).lines().map_while(Result::ok);
    // The first line says the watch has started.
    lines.next()?;
    Some(lines)
}

/// Sends a request to the running app on a connection of its own, launching the app first if
/// it isn't running.
fn ask(app: AppInfo, request: &Request) -> Reply {
    let stream = connect(app)?;
    send(&stream, request).map_err(|_| format!("lost the connection to {}", app.name))?
}

/// Connects to the running app, launching it in the background first if it isn't running.
fn connect(app: AppInfo) -> Result<UnixStream, String> {
    let path = socket_path(app);
    if let Ok(stream) = UnixStream::connect(&path) {
        return Ok(stream);
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    Command::new(executable)
        .arg("--background")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Its own process group, so the app keeps running after the MCP client stops this server.
        .process_group(0)
        .spawn()
        .map_err(|error| format!("couldn't launch {}: {error}", app.name))?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(stream) = UnixStream::connect(&path) {
            return Ok(stream);
        }
        if Instant::now() > deadline {
            return Err(format!("{} didn't start", app.name));
        }
        thread::sleep(Duration::from_millis(50));
    }
}
