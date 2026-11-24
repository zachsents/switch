//! The desktop as an extension (the desktop's `bun/extension.ts`): tools the agent drives this
//! window with. It dials the core's /extensions as `desktop-<machine>` and speaks MCP over that
//! socket (rmcp, the official Rust SDK), again a few seconds after it drops.
//!
//! - `screenshot`: a picture of Switch's window as it is now, even behind other windows, drawn by
//!   the app (snapshot.rs), so it asks for no Screen Recording.
//! - `notify`: a macOS notification about a space, held back while that space is in front, and
//!   shown here only if the user sends them to this Mac and, while the app is in front, only if they
//!   aren't quiet then (the brain's `pref notifications`).

use std::sync::Arc;
use std::time::Duration;

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
        ServerConfig::new(caps).with_server_info(Implementation::new("desktop", "1")).with_instructions("Switch's window on this Mac: look at it, or notify the user.")
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
            _ => return Err(McpError::method_not_found::<rmcp::model::CallToolRequestMethod>()),
        };
        Ok(result.into())
    }

    async fn on_custom_request(&self, request: CustomRequest, _: RequestContext<RoleServer>) -> Result<CustomResult, McpError> {
        // A plain extension's events: none.
        if request.method == "events/list" {
            return Ok(CustomResult::new(json!({ "events": [] })));
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
    if super::helpers::quiet() {
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
    let machine = crate::auth::machine_name();
    let desktop = Desktop { ui };
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
