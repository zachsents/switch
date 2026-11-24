//! Consent opens on this client (the desktop's `bun/oauth-relay.ts`). Only the core holds PKCE and
//! client secrets; callback codes never enter the brain, chat, logs, or a window. A loopback server
//! lives for one consent flow: the browser comes back to it, and it hands the code straight to the
//! core. Connections' views call `connect` (and `cancel` for a provider's flow under way).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use gpui::{App, Task};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::mutations::safe_error;
use crate::auth::Auth;
use crate::net::Net;

const TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// A connection's start: `tool` is `connect` or `oauth`.
#[derive(Clone, Debug)]
pub struct ConnectionStart {
    pub tool: String,
    pub provider: String,
    pub account: Option<String>,
    pub scopes: Option<Vec<String>>,
}

/// The core's answer, or what went wrong, safe to show.
pub type ConnectionResult = Result<Value, String>;

/// Each provider's flow under way, by how to cancel it.
/// Each window's flows under way, by provider, with how to cancel each: a window's close cancels its own
/// (the desktop kept a relay per window).
static PENDING: LazyLock<Mutex<HashMap<(Option<gpui::WindowId>, String), (u64, oneshot::Sender<()>)>>> = LazyLock::new(Default::default);
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn failure(message: &str) -> ConnectionResult {
    Err(safe_error(if message.is_empty() { "Connection failed. Try again." } else { message }))
}

async fn call(http: &reqwest::Client, auth: &Auth, tool: &str, input: &Value) -> Result<Value, String> {
    let response = http
        .post(format!("{}/widgets/connections/{tool}", auth.core))
        .bearer_auth(&auth.token)
        .json(input)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Connection request failed ({}). Try again.", response.status().as_u16()));
    }
    let raw: Value = response.json().await.map_err(|e| e.to_string())?;
    if raw.get("isError") == Some(&Value::Bool(true)) {
        let text = raw.get("content").and_then(Value::as_array).and_then(|c| c.iter().filter_map(|i| i.get("text").and_then(Value::as_str)).find(|t| !t.is_empty())).unwrap_or("Connection failed. Try again.");
        return Err(text.to_string());
    }
    Ok(raw)
}

/// The callback's input for the core: the code (or the provider's error) under the state expected.
fn callback_input(query: &str, expected: &str) -> Option<Value> {
    let pairs: Vec<(String, String)> = form_urlencoded(query);
    let all = |k: &str| pairs.iter().filter(|(n, _)| n == k).map(|(_, v)| v.clone()).collect::<Vec<_>>();
    let states = all("state");
    if expected.is_empty() || states.len() != 1 || states[0] != expected {
        return None;
    }
    let codes = all("code");
    let errors = all("error");
    let code = codes.first();
    let error = errors.first();
    if let Some(code) = code
        && !code.is_empty()
        && code.len() <= 8192
        && codes.len() == 1
        && error.is_none()
    {
        return Some(json!({ "state": expected, "code": code }));
    }
    if let Some(error) = error
        && code.is_none()
        && (1..=80).contains(&error.len())
        && error.chars().all(|c| c.is_ascii_lowercase() || c == '_')
    {
        return Some(json!({ "state": expected, "error": error }));
    }
    None
}

fn form_urlencoded(query: &str) -> Vec<(String, String)> {
    let decode = |s: &str| percent_encoding::percent_decode_str(&s.replace('+', " ")).decode_utf8_lossy().to_string();
    query.split('&').filter(|p| !p.is_empty()).map(|p| p.split_once('=').map(|(k, v)| (decode(k), decode(v))).unwrap_or_else(|| (decode(p), String::new()))).collect()
}

/// A consent link that's safe to open: HTTPS, or this machine's loopback, with no credentials in it.
fn external_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid sign-in link. Try connecting again.".to_string())?;
    let local = url.scheme() == "http" && url.host_str() == Some("127.0.0.1");
    if (url.scheme() != "https" && !local) || !url.username().is_empty() || url.password().is_some() {
        return Err("Invalid sign-in link. Try connecting again.".into());
    }
    Ok(url)
}

fn open_external(url: &str) {
    let _ = std::process::Command::new("/usr/bin/open").arg(url).spawn();
}

async fn run(net: Net, input: ConnectionStart, owner: Option<gpui::WindowId>) -> ConnectionResult {
    if input.tool != "connect" && input.tool != "oauth" {
        return failure("Invalid connection request.");
    }
    if crate::outbox::quiet() {
        return failure("Quiet: not sent");
    }
    let Some(auth) = net.auth() else { return failure("Pair with the server before connecting.") };
    let me = NEXT.fetch_add(1, Ordering::Relaxed);
    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    if let Ok(mut p) = PENDING.lock()
        && let Some((_, was)) = p.insert((owner, input.provider.clone()), (me, cancel_tx))
    {
        let _ = was.send(());
    }
    let http = reqwest::Client::new();
    let Ok(server) = tiny_http::Server::http("127.0.0.1:0") else { return failure("Connection failed. Try again.") };
    let server = Arc::new(server);
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    let expected = Arc::new(Mutex::new(String::new()));
    let (done_tx, done_rx) = oneshot::channel::<ConnectionResult>();
    // Set once the flow ends (cancelled, timed out, or done): a finish under way is aborted with it.
    let (ended_tx, ended_rx) = tokio::sync::watch::channel(false);
    {
        let (server, expected, auth, http) = (server.clone(), expected.clone(), auth.clone(), http.clone());
        let rt = tokio::runtime::Handle::current();
        std::thread::spawn(move || {
            let used = AtomicBool::new(false);
            let mut done_tx = Some(done_tx);
            for request in server.incoming_requests() {
                let url = request.url().to_string();
                let (path, query) = url.split_once('?').unwrap_or((&url, ""));
                if *request.method() != tiny_http::Method::Get || path != "/oauth/callback" {
                    let _ = request.respond(tiny_http::Response::from_string("Not found").with_status_code(404));
                    continue;
                }
                let want = expected.lock().map(|e| e.clone()).unwrap_or_default();
                let callback = callback_input(query, &want);
                let Some(callback) = callback.filter(|_| !used.swap(true, Ordering::SeqCst)) else {
                    let _ = request.respond(tiny_http::Response::from_string("Not connected").with_status_code(400));
                    continue;
                };
                let mut ended = ended_rx.clone();
                let finished = rt.block_on(async {
                    tokio::select! {
                        r = call(&http, &auth, "finish", &callback) => Some(r),
                        _ = ended.wait_for(|e| *e) => None,
                    }
                });
                let Some(finished) = finished else {
                    let _ = request.respond(tiny_http::Response::from_string("Not connected").with_status_code(400));
                    continue;
                };
                let answer = match finished {
                    Ok(value) if value.pointer("/structuredContent/connected") == Some(&Value::Bool(true)) && value.pointer("/structuredContent/id").is_some_and(Value::is_string) => Ok(value),
                    Ok(_) => failure("Connection not verified. Connect again."),
                    Err(e) => failure(&e),
                };
                let ok = answer.is_ok();
                let headers = [
                    tiny_http::Header::from_bytes("cache-control", "no-store").expect("header"),
                    tiny_http::Header::from_bytes("content-type", "text/plain; charset=utf-8").expect("header"),
                ];
                let mut response = tiny_http::Response::from_string(if ok { "Connected" } else { "Not connected" });
                for h in headers {
                    response = response.with_header(h);
                }
                // The fixed response reaches the browser before the flow ends and the listener closes.
                let _ = request.respond(response);
                if let Some(tx) = done_tx.take() {
                    let _ = tx.send(answer);
                }
            }
        });
    }
    let flow = async {
        let mut args = json!({ "provider": input.provider, "redirectUri": format!("http://127.0.0.1:{port}/oauth/callback") });
        if let Some(a) = &input.account {
            args["account"] = json!(a);
        }
        if let Some(s) = &input.scopes {
            args["scopes"] = json!(s);
        }
        let answer = call(&http, &auth, &input.tool, &args).await.map_err(|e| safe_error(&e))?;
        let Some(url) = answer.pointer("/structuredContent/url").and_then(Value::as_str) else { return Ok(answer) };
        let target = external_url(url)?;
        if answer.pointer("/structuredContent/kind").and_then(Value::as_str) != Some("oauth") {
            open_external(target.as_str());
            return Ok(json!({ "structuredContent": { "opened": true } }));
        }
        let states: Vec<String> = target.query_pairs().filter(|(k, _)| k == "state").map(|(_, v)| v.to_string()).collect();
        if states.len() != 1 || states[0].is_empty() {
            return Err("Invalid consent response. Try connecting again.".to_string());
        }
        if let Ok(mut e) = expected.lock() {
            *e = states[0].clone();
        }
        open_external(target.as_str());
        done_rx.await.unwrap_or_else(|_| failure("Connection failed. Try again."))
    };
    let result = tokio::select! {
        r = flow => r.map_err(|e| safe_error(&e)),
        _ = &mut cancel_rx => failure("Sign-in cancelled."),
        _ = tokio::time::sleep(TIMEOUT) => failure("Sign-in timed out. Connect again."),
    };
    let _ = ended_tx.send(true);
    server.unblock();
    if let Ok(mut p) = PENDING.lock()
        && p.get(&(owner, input.provider.clone())).is_some_and(|(id, _)| *id == me)
    {
        p.remove(&(owner, input.provider.clone()));
    }
    result
}

/// Starts a provider's connection; its answer once it's connected, or why it isn't.
pub fn connect(input: ConnectionStart, cx: &mut App) -> Task<ConnectionResult> {
    let net = cx.global::<Net>().clone();
    let owner = cx.active_window().map(|w| w.window_id());
    let job = net.rt.spawn(run(net.clone(), input, owner));
    cx.background_executor().spawn(async move { job.await.unwrap_or_else(|_| failure("Connection failed. Try again.")) })
}

/// Cancels a provider's flow under way, the one the window in front started.
pub fn cancel(provider: &str, cx: &App) {
    let owner = cx.active_window().map(|w| w.window_id());
    if let Ok(mut p) = PENDING.lock()
        && let Some((_, tx)) = p.remove(&(owner, provider.to_string()))
    {
        let _ = tx.send(());
    }
}

/// A window closed: its flows under way are cancelled ("Sign-in cancelled.").
pub fn close_window(id: gpui::WindowId) {
    if let Ok(mut p) = PENDING.lock() {
        let gone: Vec<_> = p.keys().filter(|(w, _)| *w == Some(id)).cloned().collect();
        for k in gone {
            if let Some((_, tx)) = p.remove(&k) {
                let _ = tx.send(());
            }
        }
    }
}

/// Cancels every flow under way.
pub fn close() {
    if let Ok(mut p) = PENDING.lock() {
        for (_, (_, tx)) in p.drain() {
            let _ = tx.send(());
        }
    }
}
