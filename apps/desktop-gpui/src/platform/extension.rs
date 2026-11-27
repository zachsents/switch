//! The desktop as an extension (the desktop's `bun/extension.ts`): tools the agent drives this
//! window with. It dials the core's /extensions as `desktop-<machine>` and speaks MCP over that
//! socket (rmcp, the official Rust SDK), again a few seconds after it drops.
//!
//! - `screenshot`: a picture of Switch's window as it is now, even behind other windows, drawn by
//!   the app (snapshot.rs), so it asks for no Screen Recording.
//! - `open_view`: an extension's widget in a window of its own (a document in the reader).
//! - `notify`: a macOS notification about a space, held back while that space is in front, and
//!   shown here only if the user sends them to this Mac and, while the app is in front, only if they
//!   aren't quiet then (the brain's `pref notifications`).
//! - `terminal_open`, `terminal_list`, `terminal_read`, `terminal_send`, `terminal_close`: the
//!   terminals on this Mac (`crate::terminal`), and their events `terminal.opened` and
//!   `terminal.exited`.
//!
//! A quiet copy dials no core; with `SWITCH_GPUI_MCP=<socket>` it serves the same tools on a Unix
//! socket of its own (a JSON-RPC message a line), to try them without the core.

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::channel::mpsc::{UnboundedSender, unbounded};
use futures::{SinkExt, StreamExt};
use gpui::App;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, CustomRequest, CustomResult, Implementation, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig,
    Tool, ToolAnnotations,
};
use rmcp::service::{RequestContext, RoleServer, RxJsonRpcMessage, TxJsonRpcMessage};
use rmcp::{ErrorData as McpError, ServerHandler};
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use super::notify::{Notice, post};
use crate::model::model;
use crate::net::Net;

const EVENTS: &str = "io.modelcontextprotocol/events";

/// What a tool asks of the window, on the main thread.
enum Ask {
    Screenshot(oneshot::Sender<Result<String, String>>),
    Notify(Notice, oneshot::Sender<bool>),
    /// An extension's widget, in a window of its own.
    OpenView(crate::widgets::window::View, oneshot::Sender<bool>),
    /// A terminal tool's call, by its name.
    Terminal(String, Map<String, Value>, oneshot::Sender<Result<Value, String>>),
}

/// The core's subscriptions to this extension's events.
#[derive(Default)]
struct Events {
    streams: Vec<(String, rmcp::service::Peer<RoleServer>)>,
    rt: Option<tokio::runtime::Handle>,
}

static EVENTS_OUT: std::sync::LazyLock<std::sync::Mutex<Events>> = std::sync::LazyLock::new(Default::default);

/// Emits one of this extension's events to the core's subscription to it, if it has one now.
pub fn emit(name: &str, data: Value) {
    let events = EVENTS_OUT.lock().unwrap_or_else(|e| e.into_inner());
    let Some(rt) = events.rt.clone() else { return };
    let occurrence = json!({
        "eventId": uuid::Uuid::new_v4().to_string(),
        "name": name,
        "timestamp": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "data": data,
        "cursor": Value::Null,
    });
    for (n, peer) in &events.streams {
        if n != name {
            continue;
        }
        let peer = peer.clone();
        let note = rmcp::model::ServerNotification::CustomNotification(rmcp::model::CustomNotification::new("notifications/events/event", Some(occurrence.clone())));
        rt.spawn(async move {
            let _ = peer.send_notification(note).await;
        });
    }
}

fn event_list() -> Value {
    let s = |props: Value| json!({ "type": "object", "properties": props, "required": ["id", "mac"] });
    let text = json!({ "type": "string" });
    json!({ "events": [
        { "name": "terminal.opened", "description": "A terminal's shell started on this Mac.", "delivery": ["push"], "inputSchema": { "type": "object", "properties": {} },
          "payloadSchema": s(json!({ "id": text, "mac": text, "cwd": text, "command": text, "space": text })), "_meta": { "ax.switch/version": 1 } },
        { "name": "terminal.exited", "description": "A terminal's shell ended, with its exit code.", "delivery": ["push"], "inputSchema": { "type": "object", "properties": {} },
          "payloadSchema": s(json!({ "id": text, "mac": text, "code": { "type": "number" }, "space": text })), "_meta": { "ax.switch/version": 1 } },
    ] })
}

#[derive(Clone)]
struct Desktop {
    ui: UnboundedSender<Ask>,
}

fn object(v: Value) -> Arc<Map<String, Value>> {
    Arc::new(v.as_object().cloned().unwrap_or_default())
}

fn tools() -> Vec<Tool> {
    vec![
        Tool::new("screenshot", "A picture of Switch's window as it is now, even behind other windows.", object(json!({ "type": "object", "properties": {} })))
            .with_annotations(ToolAnnotations::new().read_only(true)),
        Tool::new(
            "notify",
            "A macOS notification from Switch, about a space. Held back while that space is in front.",
            object(json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "body": { "type": "string" },
                    "subtitle": { "type": "string" },
                    "space": { "type": "string" },
                    "item": { "type": "string" }
                },
                "required": ["title"],
                "additionalProperties": false
            })),
        )
        .with_annotations(ToolAnnotations::new().read_only(false)),
        Tool::new(
            "open_view",
            "Opens an extension's widget in a window of its own on this Mac, in front: `app` and `name` as a tool's `view` gives them, with its `input`.",
            object(json!({
                "type": "object",
                "properties": {
                    "app": { "type": "string" },
                    "name": { "type": "string" },
                    "input": { "type": "object" }
                },
                "required": ["app", "name"],
                "additionalProperties": false
            })),
        )
        .with_annotations(ToolAnnotations::new().read_only(false)),
        Tool::new(
            "terminal_open",
            "Opens a terminal on this Mac: the user's login shell in `cwd` (home by default), `command` typed into it once it starts. With `space`, it's pinned in that space's widgets (`rows` tall, 18 by default); else in a window of its own. Its `id` is what the other terminal tools take.",
            object(json!({
                "type": "object",
                "properties": {
                    "cwd": { "type": "string" },
                    "command": { "type": "string" },
                    "space": { "type": "string" },
                    "rows": { "type": "number" }
                },
                "additionalProperties": false
            })),
        )
        .with_annotations(ToolAnnotations::new().read_only(false)),
        Tool::new("terminal_list", "The terminals on this Mac: each one's id, what's running in front, its folder, its space, and its exit code once its shell has ended.", object(json!({ "type": "object", "properties": {} })))
            .with_annotations(ToolAnnotations::new().read_only(true)),
        Tool::new(
            "terminal_read",
            "A terminal's screen as text, the cursor, and up to `history` lines above the screen (40 by default).",
            object(json!({
                "type": "object",
                "properties": { "id": { "type": "string" }, "history": { "type": "number" } },
                "required": ["id"],
                "additionalProperties": false
            })),
        )
        .with_annotations(ToolAnnotations::new().read_only(true)),
        Tool::new(
            "terminal_send",
            "Types into a terminal, as the user would: `text` as typed (end a line with \\r to run it), then `keys` pressed in order (`enter`, `escape`, `tab`, `up`, `ctrl-c`, `ctrl-d`, `alt-b`, `f1`, …). Answers with its screen once its output has been quiet for 300 ms (at most `wait_ms`, 3000 by default; 0 answers at once). A terminal whose shell has ended starts a new one first.",
            object(json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "text": { "type": "string" },
                    "keys": { "type": "array", "items": { "type": "string" } },
                    "wait_ms": { "type": "number" }
                },
                "required": ["id"],
                "additionalProperties": false
            })),
        )
        .with_annotations(ToolAnnotations::new().read_only(false)),
        Tool::new(
            "terminal_close",
            "Ends a terminal's shell and closes it: its window, or its place in its space.",
            object(json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"],
                "additionalProperties": false
            })),
        )
        .with_annotations(ToolAnnotations::new().read_only(false)),
    ]
}

fn failed(text: &str) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(text)])
}

fn answer(value: Value, content: Vec<ContentBlock>) -> CallToolResult {
    let mut r = CallToolResult::success(content);
    r.structured_content = Some(value);
    r
}

impl ServerHandler for Desktop {
    fn get_info(&self) -> ServerConfig {
        let mut extensions = std::collections::BTreeMap::new();
        extensions.insert(EVENTS.to_string(), json!({ "listChanged": false }).as_object().cloned().unwrap_or_default());
        let caps = ServerCapabilities::builder().enable_tools().enable_resources().enable_extensions_with(extensions).build();
        ServerConfig::new(caps).with_server_info(Implementation::new("desktop", "1")).with_instructions("Switch's window on this Mac: look at it, open a widget in a window of its own, or notify the user.")
    }

    async fn list_tools(&self, _: Option<PaginatedRequestParams>, _: RequestContext<RoleServer>) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(tools()))
    }

    async fn call_tool(&self, request: CallToolRequestParams, _: RequestContext<RoleServer>) -> Result<CallToolResponse, McpError> {
        let input = request.arguments.unwrap_or_default();
        let s = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
        let result = match request.name.as_ref() {
            "screenshot" => {
                let (tx, rx) = oneshot::channel();
                let _ = self.ui.unbounded_send(Ask::Screenshot(tx));
                match rx.await {
                    Ok(Ok(data)) => answer(json!({ "window": "Switch" }), vec![ContentBlock::image(data, "image/jpeg")]),
                    Ok(Err(e)) => failed(&e),
                    Err(_) => failed("No Switch window"),
                }
            }
            "notify" => {
                let Some(title) = s("title") else { return Err(McpError::invalid_params("title is required", None)) };
                let (tx, rx) = oneshot::channel();
                let _ = self.ui.unbounded_send(Ask::Notify(Notice { title, body: s("body"), subtitle: s("subtitle"), space: s("space") }, tx));
                let shown = rx.await.unwrap_or(false);
                let v = json!({ "shown": shown });
                answer(v.clone(), vec![ContentBlock::text(v.to_string())])
            }
            "open_view" => {
                let (Some(app), Some(name)) = (s("app"), s("name")) else { return Err(McpError::invalid_params("app and name are required", None)) };
                let view = crate::widgets::window::View { app, name, input: input.get("input").filter(|i| i.is_object()).cloned() };
                let (tx, rx) = oneshot::channel();
                let _ = self.ui.unbounded_send(Ask::OpenView(view, tx));
                let v = json!({ "opened": rx.await.unwrap_or(false) });
                answer(v.clone(), vec![ContentBlock::text(v.to_string())])
            }
            name if name.starts_with("terminal_") => {
                let (tx, rx) = oneshot::channel();
                let _ = self.ui.unbounded_send(Ask::Terminal(name.to_string(), input.clone(), tx));
                match rx.await {
                    Ok(Ok(v)) => answer(v.clone(), vec![ContentBlock::text(v.to_string())]),
                    Ok(Err(e)) => failed(&e),
                    Err(_) => failed("No Switch window"),
                }
            }
            _ => return Err(McpError::method_not_found::<rmcp::model::CallToolRequestMethod>()),
        };
        Ok(result.into())
    }

    async fn on_custom_request(&self, request: CustomRequest, ctx: RequestContext<RoleServer>) -> Result<CustomResult, McpError> {
        if request.method == "events/list" {
            return Ok(CustomResult::new(event_list()));
        }
        // A push subscription to one of its events: confirmed, then each one as it's emitted, a
        // heartbeat when quiet, until the core cancels it or the socket closes.
        if request.method == "events/stream" {
            let name = request.params.as_ref().and_then(|p| p.get("name")).and_then(Value::as_str).unwrap_or_default().to_string();
            if !event_list()["events"].as_array().is_some_and(|l| l.iter().any(|e| e["name"] == name.as_str())) {
                return Err(McpError::new(rmcp::model::ErrorCode(-32_023), "NotFound", None));
            }
            let active = rmcp::model::CustomNotification::new("notifications/events/active", Some(json!({ "cursor": null, "truncated": false, "heartbeatMs": 30_000 })));
            let _ = ctx.peer.send_notification(rmcp::model::ServerNotification::CustomNotification(active)).await;
            {
                let mut ev = EVENTS_OUT.lock().unwrap_or_else(|e| e.into_inner());
                ev.rt = Some(tokio::runtime::Handle::current());
                ev.streams.retain(|(_, p)| !p.is_transport_closed());
                ev.streams.push((name.clone(), ctx.peer.clone()));
            }
            let mut beat = tokio::time::interval(Duration::from_secs(30));
            beat.tick().await;
            loop {
                tokio::select! {
                    () = ctx.ct.cancelled() => break,
                    _ = beat.tick() => {
                        let note = rmcp::model::CustomNotification::new("notifications/events/heartbeat", Some(json!({ "cursor": null })));
                        if ctx.peer.send_notification(rmcp::model::ServerNotification::CustomNotification(note)).await.is_err() {
                            break;
                        }
                    }
                }
            }
            EVENTS_OUT.lock().unwrap_or_else(|e| e.into_inner()).streams.retain(|(_, p)| !p.is_transport_closed());
            return Ok(CustomResult::new(json!({})));
        }
        Err(McpError::new(rmcp::model::ErrorCode::METHOD_NOT_FOUND, request.method, None))
    }
}

/// Where notifications go and whether they're quiet while the app is open (`pref notifications`).
fn wanted(cx: &App) -> bool {
    let pref = model(cx).read(cx).brain.prefs.get("notifications").cloned().unwrap_or(Value::Null);
    let here = pref.get("here") != Some(&Value::Bool(false));
    let quiet_open = pref.get("quietOpen") == Some(&Value::Bool(true));
    here && !(quiet_open && super::watch::focused())
}

fn heard(ask: Ask, cx: &mut App) {
    match ask {
        Ask::Screenshot(tx) => {
            let shot = super::snapshot::window_shot(cx);
            cx.spawn(async move |_| {
                let _ = tx.send(shot.await);
            })
            .detach();
        }
        Ask::Notify(n, tx) => {
            if !wanted(cx) || n.space.as_ref().is_some_and(|s| super::watch::in_front().as_ref() == Some(s)) {
                let _ = tx.send(false);
                return;
            }
            post(n);
            let _ = tx.send(true);
        }
        Ask::OpenView(view, tx) => {
            crate::widgets::window::open(view, cx);
            cx.activate(true);
            let _ = tx.send(true);
        }
        Ask::Terminal(name, input, tx) => terminal_tool(&name, &input, tx, cx),
    }
}

/// A terminal tool's call, on the main thread.
fn terminal_tool(name: &str, input: &Map<String, Value>, tx: oneshot::Sender<Result<Value, String>>, cx: &mut App) {
    use crate::terminal::{self, session};
    let s = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string).filter(|v| !v.trim().is_empty());
    let n = |k: &str| input.get(k).and_then(Value::as_f64);
    if name == "terminal_list" {
        let _ = tx.send(Ok(json!({ "mac": terminal::mac(), "terminals": terminal::list(cx) })));
        return;
    }
    if name == "terminal_open" {
        let start = session::Start { cwd: s("cwd").map(|c| session::folder(&c)), command: s("command"), space: None };
        if let Some(c) = &start.cwd
            && !c.is_dir()
        {
            let _ = tx.send(Err(format!("No folder {}", c.display())));
            return;
        }
        let id = match s("space") {
            Some(space) => {
                let found = crate::model::model(cx).read(cx).brain.spaces.values().find(|sp| sp.id == space || sp.name.eq_ignore_ascii_case(&space)).map(|sp| sp.id.clone());
                let Some(space) = found else {
                    let _ = tx.send(Err(format!("No space {space}")));
                    return;
                };
                terminal::pin(&space, start, n("rows").map(|r| r as usize), cx)
            }
            None => terminal::open(start, cx),
        };
        let _ = tx.send(Ok(json!({ "id": id, "mac": terminal::mac() })));
        return;
    }
    let Some(id) = s("id") else {
        let _ = tx.send(Err("id is required".into()));
        return;
    };
    let Some(session) = terminal::session(&id, cx) else {
        let _ = tx.send(Err(format!("No terminal {id}")));
        return;
    };
    match name {
        "terminal_read" => {
            let history = n("history").map_or(40, |h| h.max(0.) as usize);
            let _ = tx.send(Ok(session.read(cx).read(history)));
        }
        "terminal_close" => {
            terminal::close(&id, cx);
            let _ = tx.send(Ok(json!({ "closed": id })));
        }
        "terminal_send" => {
            let mut keys = vec![];
            for k in input.get("keys").and_then(Value::as_array).into_iter().flatten() {
                let Some(k) = k.as_str() else { continue };
                let Ok(ks) = gpui::Keystroke::parse_with_os(k, gpui::OperatingSystem::Mac) else {
                    let _ = tx.send(Err(format!("No key {k}")));
                    return;
                };
                keys.push(ks);
            }
            session.update(cx, |s, cx| {
                if s.exited.is_some() {
                    s.restart(cx);
                }
                if let Some(t) = input.get("text").and_then(Value::as_str) {
                    s.typed(t.as_bytes().to_vec());
                }
                for ks in &keys {
                    // A key that isn't one of the terminal's own is its letter.
                    let bytes = terminal::keys::bytes(ks, s.mode()).or_else(|| ks.key_char.clone().map(String::into_bytes)).unwrap_or_else(|| ks.key.clone().into_bytes());
                    s.typed(bytes);
                }
            });
            // Its screen once its output has been quiet a moment: each word it draws starts the
            // quiet again, up to the wait.
            let wait = Duration::from_millis(n("wait_ms").map_or(3000, |w| w.clamp(0., 30_000.) as u64));
            let (ping, mut pings) = unbounded::<()>();
            let heard = cx.observe(&session, move |_, _| {
                let _ = ping.unbounded_send(());
            });
            cx.spawn(async move |cx| {
                let _heard = heard;
                let until = Instant::now() + wait;
                loop {
                    let left = until.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        break;
                    }
                    let quiet = cx.background_executor().timer(Duration::from_millis(300).min(left));
                    match futures::future::select(pings.next(), quiet).await {
                        futures::future::Either::Left((Some(()), _)) => {}
                        // Quiet, but its words are still held for the shell's first prompt: on.
                        futures::future::Either::Right(_) if cx.update(|cx| session.read(cx).holding()) => {}
                        _ => break,
                    }
                }
                let screen = cx.update(|cx| session.read(cx).read(40));
                let _ = tx.send(Ok(screen));
            })
            .detach();
        }
        other => {
            let _ = tx.send(Err(format!("No tool {other}")));
        }
    }
}

/// One MCP session over the socket, until it closes.
async fn session(desktop: Desktop, url: String, token: String) -> Result<(), String> {
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    request.headers_mut().insert("authorization", format!("Bearer {token}").parse().map_err(|_| "header")?);
    let (ws, _) = tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(request)).await.map_err(|_| "Can't reach the core")?.map_err(|_| "Can't reach the core")?;
    let (sink, stream) = ws.split();
    let sink = Box::pin(sink.with(|m: TxJsonRpcMessage<RoleServer>| async move { Ok::<_, tokio_tungstenite::tungstenite::Error>(Message::text(serde_json::to_string(&m).unwrap_or_default())) }));
    let stream = Box::pin(stream.take_while(|f| futures::future::ready(f.is_ok())).filter_map(|f| async move {
        match f {
            Ok(Message::Text(t)) => serde_json::from_str::<RxJsonRpcMessage<RoleServer>>(t.as_str()).ok(),
            _ => None,
        }
    }));
    let running = rmcp::serve_server(desktop, (sink, stream)).await.map_err(|e| e.to_string())?;
    let _ = running.waiting().await;
    Ok(())
}

/// Keeps the desktop extension dialed in to its core as `desktop-<machine>`, again a few seconds
/// after it drops, once the app is paired. A test copy beside the live app ($SWITCH_QUIET) doesn't.
pub fn start(cx: &mut App) {
    let test = std::env::var("SWITCH_GPUI_MCP").ok().filter(|_| super::helpers::quiet());
    if super::helpers::quiet() && test.is_none() {
        return;
    }
    let (ui, mut asks) = unbounded::<Ask>();
    cx.spawn(async move |cx| {
        while let Some(ask) = asks.next().await {
            let _ = cx.update(|cx| heard(ask, cx));
        }
    })
    .detach();
    let net = cx.global::<Net>().clone();
    let desktop = Desktop { ui };
    if let Some(path) = test {
        net.rt.clone().spawn(serve_socket(desktop, path));
        return;
    }
    let machine = crate::terminal::mac().to_string();
    net.rt.clone().spawn(async move {
        loop {
            if let Some(a) = net.auth() {
                let base = a.core.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1);
                let url = format!("{base}/extensions?name=desktop-{machine}");
                if let Err(e) = session(desktop.clone(), url, a.token.clone()).await {
                    log::debug!("desktop extension: {e}");
                }
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

/// A quiet copy's own socket: each connection one MCP session, a JSON-RPC message a line.
async fn serve_socket(desktop: Desktop, path: String) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let _ = std::fs::remove_file(&path);
    let listener = match tokio::net::UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            log::warn!("desktop extension socket {path}: {e}");
            return;
        }
    };
    while let Ok((stream, _)) = listener.accept().await {
        let desktop = desktop.clone();
        tokio::spawn(async move {
            let (read, write) = stream.into_split();
            let lines = futures::stream::unfold(BufReader::new(read).lines(), |mut l| async move { l.next_line().await.ok().flatten().map(|line| (line, l)) });
            let stream = Box::pin(lines.filter_map(|l| async move { serde_json::from_str::<RxJsonRpcMessage<RoleServer>>(&l).ok() }));
            let sink = Box::pin(futures::sink::unfold(write, |mut w, m: TxJsonRpcMessage<RoleServer>| async move {
                let mut line = serde_json::to_string(&m).unwrap_or_default();
                line.push('\n');
                w.write_all(line.as_bytes()).await?;
                Ok::<_, std::io::Error>(w)
            }));
            if let Ok(running) = rmcp::serve_server(desktop, (sink, stream)).await {
                let _ = running.waiting().await;
            }
        });
    }
}
