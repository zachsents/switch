//! `<app> mcp --http <address>`: the app's MCP server over Streamable HTTP, for hosts that only
//! connect to servers by URL, like a browser-based host or a remote connector reached through a
//! tunnel. It's the same server as on stdio. Requests are POSTed to the endpoint; long-lived
//! ones (`events/stream`, `subscriptions/listen`) answer with a stream of server-sent events, as
//! does a GET for a session's other notifications.
//!
//! A host that sends `initialize` gets a session (`Mcp-Session-Id`), with a server of its own; a
//! host that doesn't shares one. Browsers may only connect from this computer.

use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
    },
    thread,
    time::Duration,
};

use serde_json::{Value, json};
use tiny_http::{Header, Method, Request, Response};

use super::relay::Server;
use crate::AppInfo;

const SESSION: &str = "Mcp-Session-Id";
const SUBSCRIPTION_ID: &str = "io.modelcontextprotocol/subscriptionId";

/// How long an ordinary request may take before the host is told it failed.
const LONGEST_REQUEST: Duration = Duration::from_secs(120);

/// How often a quiet stream says it's still there.
const KEEPALIVE: Duration = Duration::from_secs(15);

/// Where a server's messages go: each waiting request's, by its id, and the session's stream.
#[derive(Default)]
struct Routes {
    requests: Mutex<HashMap<String, Sender<Value>>>,
    stream: Mutex<Option<Sender<Value>>>,
}

impl Routes {
    /// Sends a message to whoever is waiting for it: a response to its request, a notification
    /// to the stream it belongs to, or else to the session's stream.
    fn route(&self, message: Value) {
        let is_response = message.get("result").is_some() || message.get("error").is_some();
        let owner = if is_response {
            message.get("id")
        } else {
            message["params"]["_meta"].get(SUBSCRIPTION_ID)
        };
        let waiting = owner.and_then(|owner| {
            self.requests
                .lock()
                .expect("routes lock")
                .get(&owner.to_string())
                .cloned()
        });
        let sender = waiting.or_else(|| self.stream.lock().expect("routes lock").clone());
        if let Some(sender) = sender {
            sender.send(message).ok();
        }
    }
}

struct Session {
    server: Arc<Server>,
    routes: Arc<Routes>,
    /// When a request last came, to forget sessions their hosts have left.
    used: Mutex<std::time::Instant>,
}

impl Session {
    fn new(app: AppInfo) -> Arc<Self> {
        let routes = Arc::new(Routes::default());
        let server = Server::start(app, {
            let routes = routes.clone();
            Box::new(move |message| routes.route(message))
        });
        Arc::new(Self {
            server,
            routes,
            used: Mutex::new(std::time::Instant::now()),
        })
    }

    /// Whether its host seems to have gone: nothing waiting on it and no request for a while.
    fn abandoned(&self) -> bool {
        let waiting = !self.routes.requests.lock().expect("routes lock").is_empty()
            || self.routes.stream.lock().expect("routes lock").is_some();
        !waiting && self.used.lock().expect("session lock").elapsed() > ABANDONED
    }
}

/// How long a session without requests or streams is kept for a host that may come back.
const ABANDONED: Duration = Duration::from_secs(30 * 60);

/// Serves the app's MCP server over HTTP at `address` (like `127.0.0.1:3001`), on `path`.
pub(crate) fn serve(app: AppInfo, address: &str, path: &str) {
    let listener = match tiny_http::Server::http(address) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("can't serve on {address}: {error}");
            std::process::exit(1);
        }
    };
    eprintln!("{} is serving MCP at http://{address}{path}", app.name);
    let shared = Session::new(app);
    let sessions: Arc<Mutex<HashMap<String, Arc<Session>>>> = Arc::default();
    for request in listener.incoming_requests() {
        let (shared, sessions, path) = (shared.clone(), sessions.clone(), path.to_string());
        thread::spawn(move || handle(app, request, &path, &shared, &sessions));
    }
}

fn handle(
    app: AppInfo,
    mut request: Request,
    path: &str,
    shared: &Arc<Session>,
    sessions: &Mutex<HashMap<String, Arc<Session>>>,
) {
    let origin = header(&request, "Origin");
    // A web page elsewhere may not drive the app through someone's browser.
    if origin.as_deref().is_some_and(|origin| !local(origin)) {
        respond(
            request,
            Response::from_string("forbidden origin").with_status_code(403),
            None,
        );
        return;
    }
    let endpoint = request.url().split('?').next().unwrap_or_default() == path;
    if !endpoint {
        respond(
            request,
            Response::from_string("not found").with_status_code(404),
            origin,
        );
        return;
    }
    let session_id = header(&request, SESSION);
    let session = match &session_id {
        Some(id) => sessions.lock().expect("sessions lock").get(id).cloned(),
        None => Some(shared.clone()),
    };
    if let Some(session) = &session {
        *session.used.lock().expect("session lock") = std::time::Instant::now();
    }
    match request.method() {
        Method::Options => respond(request, Response::empty(204), origin),
        Method::Delete => {
            if let Some(id) = session_id {
                sessions.lock().expect("sessions lock").remove(&id);
            }
            respond(request, Response::empty(200), origin);
        }
        Method::Get => match session {
            Some(session) if session_id.is_some() => {
                let (sender, messages) = mpsc::channel();
                *session.routes.stream.lock().expect("routes lock") = Some(sender);
                stream(request, origin, None, messages);
                *session.routes.stream.lock().expect("routes lock") = None;
            }
            _ => respond(request, Response::empty(405), origin),
        },
        Method::Post => {
            let Some(session) = session else {
                respond(
                    request,
                    Response::from_string("unknown session").with_status_code(404),
                    origin,
                );
                return;
            };
            let mut body = String::new();
            if request.as_reader().read_to_string(&mut body).is_err() {
                respond(request, Response::empty(400), origin);
                return;
            }
            let Ok(message) = serde_json::from_str::<Value>(&body) else {
                let error = json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } });
                respond(request, json_response(&error), origin);
                return;
            };
            post(
                app,
                request,
                origin,
                message,
                session,
                session_id.is_none(),
                sessions,
            );
        }
        _ => respond(request, Response::empty(405), origin),
    }
}

fn post(
    app: AppInfo,
    request: Request,
    origin: Option<String>,
    message: Value,
    session: Arc<Session>,
    sessionless: bool,
    sessions: &Mutex<HashMap<String, Arc<Session>>>,
) {
    let method = message["method"].as_str().unwrap_or_default().to_string();
    let Some(id) = message.get("id").filter(|id| !id.is_null()).cloned() else {
        // A notification, or a response to a request this server never sends.
        session.server.receive(message);
        respond(request, Response::empty(202), origin);
        return;
    };
    // `initialize` starts a session of its own.
    let (session, new_session) = if method == "initialize" && sessionless {
        let id = super::widgets::version(&format!("{:?}{}", std::time::SystemTime::now(), id));
        let session = Session::new(app);
        let mut sessions = sessions.lock().expect("sessions lock");
        sessions.retain(|_, session| !session.abandoned());
        sessions.insert(id.clone(), session.clone());
        (session, Some(id))
    } else {
        (session, None)
    };
    let key = id.to_string();
    let (sender, messages) = mpsc::channel();
    session
        .routes
        .requests
        .lock()
        .expect("routes lock")
        .insert(key.clone(), sender);
    session.server.receive(message);
    let long_lived = matches!(method.as_str(), "events/stream" | "subscriptions/listen");
    let first = messages.recv_timeout(LONGEST_REQUEST);
    match first {
        // An answer, which is all an ordinary request gets, and all a long-lived one that
        // failed gets.
        Ok(message)
            if message.get("id") == Some(&id)
                && (!long_lived || message.get("error").is_some()) =>
        {
            session
                .routes
                .requests
                .lock()
                .expect("routes lock")
                .remove(&key);
            let mut response = json_response(&message);
            if let Some(session_id) = new_session {
                response.add_header(header_line(SESSION, &session_id));
            }
            respond(request, response, origin);
        }
        Ok(first) => {
            stream(request, origin, Some(first), messages);
            session
                .routes
                .requests
                .lock()
                .expect("routes lock")
                .remove(&key);
            session
                .server
                .notified("notifications/cancelled", &json!({ "requestId": id }));
        }
        Err(_) => {
            session
                .routes
                .requests
                .lock()
                .expect("routes lock")
                .remove(&key);
            let error = json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": "no answer in time" } });
            respond(request, json_response(&error), origin);
        }
    }
}

/// Answers with server-sent events: `first`, then each message as it comes, until the host
/// goes away. Quiet streams send a comment now and then, which also finds out when it has.
fn stream(
    request: Request,
    origin: Option<String>,
    first: Option<Value>,
    messages: Receiver<Value>,
) {
    let mut writer = request.into_writer();
    let mut head = String::from(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n",
    );
    for (name, value) in cors(origin.as_deref()) {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    if writer
        .write_all(head.as_bytes())
        .and_then(|()| writer.flush())
        .is_err()
    {
        return;
    }
    let mut next = first;
    loop {
        let frame = match next.take() {
            Some(message) => format!("event: message\ndata: {message}\n\n"),
            None => match messages.recv_timeout(KEEPALIVE) {
                Ok(message) => format!("event: message\ndata: {message}\n\n"),
                Err(RecvTimeoutError::Timeout) => ": keepalive\n\n".to_string(),
                Err(RecvTimeoutError::Disconnected) => return,
            },
        };
        if writer
            .write_all(frame.as_bytes())
            .and_then(|()| writer.flush())
            .is_err()
        {
            return;
        }
    }
}

fn json_response(message: &Value) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(message.to_string())
        .with_header(header_line("Content-Type", "application/json"))
}

fn respond<R: Read>(request: Request, mut response: Response<R>, origin: Option<String>) {
    for (name, value) in cors(origin.as_deref()) {
        response.add_header(header_line(name, &value));
    }
    request.respond(response).ok();
}

/// What lets a page on this computer use the server from a browser.
fn cors(origin: Option<&str>) -> Vec<(&'static str, String)> {
    let Some(origin) = origin else {
        return Vec::new();
    };
    vec![
        ("Access-Control-Allow-Origin", origin.to_string()),
        ("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS".into()),
        (
            "Access-Control-Allow-Headers",
            "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID".into(),
        ),
        ("Access-Control-Expose-Headers", "Mcp-Session-Id".into()),
        ("Vary", "Origin".into()),
    ]
}

/// Whether a page's origin is on this computer.
fn local(origin: &str) -> bool {
    let host = origin
        .split("://")
        .nth(1)
        .unwrap_or_default()
        .rsplit_once(':')
        .map_or_else(
            || origin.split("://").nth(1).unwrap_or_default(),
            |(host, _)| host,
        );
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

fn header(request: &Request, name: &str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str().to_string())
}

fn header_line(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("headers are plain ASCII")
}
