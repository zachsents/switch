//! Agent access. Every app is its own MCP server: `<app> mcp` speaks MCP over stdin and stdout
//! and relays each request to the running app through a local socket, launching the app in the
//! background first if it isn't open. So an agent and the person at the keyboard always share
//! one live state.
//!
//! Everything an app offers agents is generated, so it can't drift from the app:
//!
//! - **Tools** from the app's actions: the tool name from the action's name, the description from
//!   its doc comment, and the input schema from its fields. `get_state` returns what the app
//!   reports through [`report_state`], and `screenshot` saves PNGs of its windows.
//! - **Widgets**: interactive views of the app written once in A2UI ([`widget`]). Each has a
//!   `show_<name>` tool whose result carries the widget's A2UI messages, which hosts that speak
//!   A2UI draw natively. Hosts that only draw MCP Apps draw them with the kit's own renderer, the
//!   `ui://<app>/widget` resource. A tap on a widget calls the action tool it names.
//! - **Resources**: the app's state (`<app>://state`) and each widget as it's shown
//!   (`<app>://widget/<name>?<arguments>`), which hosts can subscribe to.
//! - **Events** (MCP's `io.modelcontextprotocol/events` extension): `action.performed` after
//!   every action, whoever did it, plus any event types the app adds with [`event_source`].

mod events;
mod http;
mod pictures;
mod relay;
mod widgets;

use std::{
    fs,
    io::{self, BufRead, BufReader, Write},
    os::unix::net::{UnixListener, UnixStream},
    path::PathBuf,
    thread,
};

use futures::{
    FutureExt, StreamExt,
    channel::{mpsc, oneshot},
    future::LocalBoxFuture,
};
use gpui::{Action, App, Global};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{AppInfo, screenshot, show_main_window, storage};

pub use events::{
    Announcer, EventSource, Occurrence, announce, announcer, changed, emit, event_source, handle,
};
pub(crate) use http::serve as serve_http;
pub(crate) use relay::{print_screenshot, serve_stdio};
pub use pictures::{LiveFrame, live, live_uri};
pub use widgets::{Surface, svg_icon, widget};

/// A request from the MCP relay to the running app, sent as one JSON object per line. The app
/// answers each with one line holding a `Reply`, except `Watch`, which turns the connection into
/// a stream of [`Notice`]s.
#[derive(Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
enum Request {
    /// Everything the app offers: tools, resources, resource templates and event types.
    Catalog,
    /// Calls a tool. The reply is an MCP `CallToolResult`. A call made by the person, like a
    /// tap on a widget a host forwards, is the person's own action rather than an agent's.
    Call {
        tool: String,
        arguments: Value,
        #[serde(default)]
        person: bool,
    },
    /// Reads a resource. The reply is an MCP `ReadResourceResult`.
    Read { uri: String },
    /// Reads events after a cursor. The reply is an MCP Events poll result.
    Poll {
        name: String,
        #[serde(default)]
        arguments: Value,
        #[serde(default)]
        cursor: Option<String>,
        #[serde(default)]
        max_events: Option<usize>,
        #[serde(default)]
        max_age_ms: Option<u64>,
    },
    /// Streams what happens in the app from now on.
    Watch,
    /// Brings the app to the front.
    Show,
}

/// What a watching relay hears, one JSON object per line.
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "snake_case")]
enum Notice {
    /// The app's state may have changed, so resources may read differently.
    Changed,
    /// An event occurred.
    Event { name: String, occurrence: Value },
}

type Reply = Result<Value, String>;

struct StateReport(Box<dyn Fn(&App) -> Value>);

impl Global for StateReport {}

/// Sets what the `get_state` tool returns. Every action tool returns it too, so an agent sees
/// the effect of each call.
pub fn report_state(cx: &mut App, report: impl Fn(&App) -> Value + 'static) {
    cx.set_global(StateReport(Box::new(report)));
}

/// An error raised by an action handler for the agent call that dispatched the action.
struct Rejection(Option<String>);

impl Global for Rejection {}

/// Fails the agent call that dispatched the current action, for example when it names something
/// that doesn't exist. The agent gets `message` as the error. Outside agent calls it has no effect.
pub fn reject(cx: &mut App, message: impl Into<String>) {
    cx.set_global(Rejection(Some(message.into())));
}

/// Work started by the action an agent call dispatched, which the call waits for, each piece
/// answering with what the reply carries besides the app's state.
struct AwaitedWork(Vec<LocalBoxFuture<'static, Result<Vec<Value>, String>>>);

impl Global for AwaitedWork {}

/// Makes the agent call that dispatched the current action wait for `work` before replying, so
/// its reply shows the finished result, like files that have been written. If the work fails,
/// the call fails with its error. Outside agent calls the work just runs, so passing a `Task`
/// here keeps it going rather than cancelling it.
pub fn finish_before_replying(
    cx: &mut App,
    work: impl Future<Output = Result<(), String>> + 'static,
) {
    reply_with(cx, async move { work.await.map(|()| Vec::new()) });
}

/// Like [`finish_before_replying`], and the reply also carries what `work` answers with, after
/// the app's state: MCP content, like a picture an action took ([`image_content`]).
pub fn reply_with(cx: &mut App, work: impl Future<Output = Result<Vec<Value>, String>> + 'static) {
    if cx.has_global::<AwaitedWork>() {
        cx.global_mut::<AwaitedWork>().0.push(work.boxed_local());
    } else {
        cx.spawn(async move |_| {
            work.await.ok();
        })
        .detach();
    }
}

/// A picture as MCP content, for [`reply_with`]: its bytes and their type, like `image/jpeg`.
pub fn image_content(bytes: &[u8], mime_type: &str) -> Value {
    use base64::Engine as _;
    json!({
        "type": "image",
        "data": base64::engine::general_purpose::STANDARD.encode(bytes),
        "mimeType": mime_type,
    })
}

/// Whether an agent call is being handled right now. A call the person made through a widget
/// doesn't count, so it isn't shown off as an agent's work.
pub(crate) fn handling_agent_call(cx: &App) -> bool {
    cx.has_global::<AwaitedWork>() && !events::person_calling(cx)
}

fn state(cx: &App) -> Value {
    cx.try_global::<StateReport>()
        .map_or(Value::Null, |StateReport(report)| report(cx))
}

fn socket_path(app: AppInfo) -> PathBuf {
    storage::dir(app).join("agent.sock")
}

/// If the app is already running, brings it to the front and returns true.
pub(crate) fn show_running_instance(app: AppInfo) -> bool {
    UnixStream::connect(socket_path(app)).is_ok_and(|stream| send(&stream, &Request::Show).is_ok())
}

/// Sends one request over a connection and waits for the reply.
fn send(stream: &UnixStream, request: &Request) -> io::Result<Reply> {
    let mut writer = stream;
    writeln!(writer, "{}", serde_json::to_string(request)?)?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line)?;
    Ok(serde_json::from_str(&line)?)
}

/// What a connection hands to the main thread, where the app's state lives.
enum Incoming {
    Request(Request, oneshot::Sender<Reply>),
    Watch(mpsc::UnboundedSender<String>),
}

/// Connections streaming [`Notice`]s, as lines to write.
#[derive(Default)]
struct Watchers(Vec<mpsc::UnboundedSender<String>>);

impl Global for Watchers {}

/// Sends a notice to every watching relay, forgetting those that have gone.
fn broadcast(cx: &mut App, notice: &Notice) {
    let line = serde_json::to_string(notice).expect("notices are plain JSON");
    cx.default_global::<Watchers>()
        .0
        .retain(|watcher| watcher.unbounded_send(line.clone()).is_ok());
}

/// Starts answering relay requests on the app's socket. Connections are read on background
/// threads; requests are handled on the main thread, where the app's state lives.
pub(crate) fn listen(app: AppInfo, cx: &mut App) {
    let path = socket_path(app);
    // A second copy of the app never gets this far (see `show_running_instance`), so a socket
    // file already here was left by a run that didn't exit cleanly.
    let listener = fs::create_dir_all(storage::dir(app)).and_then(|()| {
        fs::remove_file(&path).ok();
        UnixListener::bind(&path)
    });
    let listener = match listener {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("agents can't connect, {}: {error}", path.display());
            return;
        }
    };
    events::start(app, cx);
    save_catalog(app, cx);

    let (incoming, mut received) = mpsc::unbounded::<Incoming>();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let incoming = incoming.clone();
            thread::spawn(move || serve_connection(stream, incoming));
        }
    });
    cx.spawn(async move |cx| {
        while let Some(incoming) = received.next().await {
            cx.update(|cx| match incoming {
                Incoming::Request(request, reply) => answer(app, request, reply, cx),
                Incoming::Watch(watcher) => cx.default_global::<Watchers>().0.push(watcher),
            });
        }
    })
    .detach();
}

fn serve_connection(stream: UnixStream, incoming: mpsc::UnboundedSender<Incoming>) {
    let mut writer = &stream;
    for line in BufReader::new(&stream).lines().map_while(Result::ok) {
        let reply = match serde_json::from_str(&line) {
            Ok(Request::Watch) => return stream_notices(&stream, &incoming),
            Ok(request) => {
                let (sender, receiver) = oneshot::channel();
                if incoming
                    .unbounded_send(Incoming::Request(request, sender))
                    .is_err()
                {
                    return;
                }
                futures::executor::block_on(receiver)
                    .unwrap_or_else(|_| Err("the app stopped before replying".into()))
            }
            Err(error) => Err(format!("invalid request: {error}")),
        };
        let reply = serde_json::to_string(&reply).expect("replies are plain JSON");
        if writeln!(writer, "{reply}").is_err() {
            return;
        }
    }
}

/// Writes notices to a watching relay until it hangs up. The first line, an empty object, says
/// the watch has started.
fn stream_notices(stream: &UnixStream, incoming: &mpsc::UnboundedSender<Incoming>) {
    let (watcher, mut notices) = mpsc::unbounded();
    if incoming.unbounded_send(Incoming::Watch(watcher)).is_err() {
        return;
    }
    let mut writer = stream;
    if writeln!(writer, "{{}}").is_err() {
        return;
    }
    while let Some(line) = futures::executor::block_on(notices.next()) {
        if writeln!(writer, "{line}").is_err() {
            return;
        }
    }
}

/// Answers one request. A dropped `reply` means the client disconnected, so send results are
/// ignored.
fn answer(app: AppInfo, request: Request, reply: oneshot::Sender<Reply>, cx: &mut App) {
    match request {
        Request::Catalog => {
            reply.send(Ok(catalog(app, cx))).ok();
        }
        Request::Show => {
            show_main_window(cx);
            reply.send(Ok(Value::Null)).ok();
        }
        Request::Read { uri } => {
            reply.send(read(app, &uri, cx)).ok();
        }
        Request::Poll {
            name,
            arguments,
            cursor,
            max_events,
            max_age_ms,
        } => {
            let polled = events::poll(
                &name,
                &arguments,
                cursor.as_deref(),
                max_events,
                max_age_ms,
                cx,
            );
            reply.send(polled).ok();
        }
        // Connections handle watches themselves (see `serve_connection`).
        Request::Watch => {}
        Request::Call {
            tool,
            arguments,
            person,
        } => call(app, tool, arguments, person, reply, cx),
    }
}

/// A tool's result that's only text, like the app's state.
fn text_result(text: String) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": false })
}

fn call(
    app: AppInfo,
    tool: String,
    arguments: Value,
    person: bool,
    reply: oneshot::Sender<Reply>,
    cx: &mut App,
) {
    match tool.as_str() {
        "get_state" => {
            reply.send(Ok(text_result(state(cx).to_string()))).ok();
        }
        "screenshot" => {
            let screenshot = screenshot::capture(app, cx);
            cx.spawn(async move |_| {
                let shot = screenshot.await.map(|saved| text_result(saved.to_string()));
                reply.send(shot).ok()
            })
            .detach();
        }
        _ if widgets::is_widget_tool(&tool, cx) => {
            reply.send(widgets::show(app, &tool, &arguments, cx)).ok();
        }
        _ => match build_action(app, &tool, arguments.clone(), cx) {
            Ok(action) => dispatch(tool, arguments, person, action, reply, cx),
            Err(error) => {
                reply.send(Err(error)).ok();
            }
        },
    }
}

/// Dispatches an action for an agent and replies with the app's state once it has been handled,
/// and any work it started has finished.
fn dispatch(
    tool: String,
    arguments: Value,
    person: bool,
    action: Box<dyn Action>,
    reply: oneshot::Sender<Reply>,
    cx: &mut App,
) {
    cx.set_global(Rejection(None));
    cx.set_global(AwaitedWork(Vec::new()));
    events::agent_call_starting(person, cx);
    cx.dispatch_action(action.as_ref());
    // Dispatching through a window is deferred, so read the outcome after it.
    cx.defer(move |cx| {
        let rejected = cx.global_mut::<Rejection>().0.take();
        let AwaitedWork(pending) = cx.remove_global::<AwaitedWork>();
        if let Some(error) = rejected {
            events::agent_call_finished(None, cx);
            reply.send(Err(error)).ok();
            return;
        }
        // An app whose handler didn't announce the action still has it heard, as the agent asked.
        events::agent_call_finished(Some((&tool, &arguments)), cx);
        cx.spawn(async move |cx| {
            let outcome = futures::future::join_all(pending)
                .await
                .into_iter()
                .collect::<Result<Vec<Vec<Value>>, String>>();
            let state = cx.update(|cx| {
                changed(cx);
                state(cx)
            });
            let result = outcome.map(|carried| {
                let mut result = text_result(state.to_string());
                if let Some(content) = result["content"].as_array_mut() {
                    content.extend(carried.into_iter().flatten());
                }
                result
            });
            reply.send(result).ok();
        })
        .detach();
    });
}

/// Reads one of the app's resources.
fn read(app: AppInfo, uri: &str, cx: &mut App) -> Reply {
    if let Some(read) = pictures::read(app, uri, cx) {
        return read;
    }
    if uri == state_uri(app) {
        let text = state(cx).to_string();
        return Ok(json!({
            "contents": [{ "uri": uri, "mimeType": "application/json", "text": text }],
        }));
    }
    widgets::read(app, uri, cx).unwrap_or_else(|| Err(format!("no resource `{uri}`")))
}

fn state_uri(app: AppInfo) -> String {
    format!("{}://state", app.id)
}

/// The app's own actions, leaving out the kit's and GPUI's.
fn app_actions(app: AppInfo, cx: &App) -> impl Iterator<Item = &'static str> + '_ {
    cx.all_action_names().iter().copied().filter(move |name| {
        name.strip_prefix(app.id)
            .is_some_and(|rest| rest.starts_with("::"))
    })
}

/// `stopwatch::NewStopwatch` becomes `new_stopwatch`.
fn tool_name(action: &str) -> String {
    let short = action.rsplit("::").next().unwrap_or(action);
    short
        .chars()
        .enumerate()
        .flat_map(|(index, character)| {
            let separator = (index > 0 && character.is_uppercase()).then_some('_');
            separator.into_iter().chain(character.to_lowercase())
        })
        .collect()
}

/// `new_stopwatch` becomes "New Stopwatch", the name hosts show for a tool.
fn tool_title(name: &str) -> String {
    name.split('_')
        .map(|word| {
            let mut characters = word.chars();
            characters.next().map_or_else(String::new, |first| {
                first.to_uppercase().chain(characters).collect()
            })
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn empty_schema() -> Value {
    json!({ "type": "object", "properties": {} })
}

fn tools(app: AppInfo, cx: &App) -> Vec<Value> {
    let mut generator = schemars::SchemaGenerator::default();
    let actions = app_actions(app, cx).map(|name| {
        let schema = cx
            .action_schema_by_name(name, &mut generator)
            .flatten()
            .map_or_else(empty_schema, Value::from);
        let tool = tool_name(name);
        json!({
            "name": tool,
            "title": tool_title(&tool),
            "description": cx.action_documentation().get(name).copied().unwrap_or_default(),
            "inputSchema": schema,
        })
    });
    let get_state = json!({
        "name": "get_state",
        "title": "Get State",
        "description": format!("Read {}'s current state. Every other tool returns it too.", app.name),
        "inputSchema": empty_schema(),
        "annotations": { "readOnlyHint": true },
    });
    let screenshot = json!({
        "name": "screenshot",
        "title": "Screenshot",
        "description": format!(
            "Save a PNG of each of {}'s open windows, as they look right now, without bringing \
             anything forward or interrupting anyone at the computer. Returns each window's \
             title and the image's path.",
            app.name
        ),
        "inputSchema": empty_schema(),
        "annotations": { "readOnlyHint": true },
    });
    actions
        .chain([get_state, screenshot])
        .chain(widgets::tools(app, cx))
        .collect()
}

/// The app's fixed resources. Widgets add theirs as templates.
fn resources(app: AppInfo) -> Vec<Value> {
    let state = json!({
        "uri": state_uri(app),
        "name": "state",
        "title": format!("{} state", app.name),
        "description": format!(
            "{}'s current state, as get_state returns it. Subscribe to hear when it changes.",
            app.name
        ),
        "mimeType": "application/json",
    });
    std::iter::once(state)
        .chain(widgets::renderer_resource(app))
        .collect()
}

fn catalog(app: AppInfo, cx: &App) -> Value {
    let mut catalog = json!({
        "tools": tools(app, cx),
        "resources": resources(app),
        "templates": widgets::templates(app, cx)
            .into_iter()
            .chain(pictures::template(app, cx))
            .collect::<Vec<_>>(),
        "events": events::descriptors(cx),
    });
    unwrap_descriptions(&mut catalog);
    catalog
}

/// Joins the lines doc comments wrap at into the sentences they are, keeping paragraphs, in
/// every description, schemas' included, so hosts show them as prose.
fn unwrap_descriptions(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            for (field, value) in fields.iter_mut() {
                match value {
                    Value::String(text) if field == "description" => {
                        *text = text
                            .split("\n\n")
                            .map(|paragraph| {
                                paragraph.split_whitespace().collect::<Vec<_>>().join(" ")
                            })
                            .collect::<Vec<_>>()
                            .join("\n\n");
                    }
                    value => unwrap_descriptions(value),
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(unwrap_descriptions),
        _ => {}
    }
}

fn build_action(
    app: AppInfo,
    tool: &str,
    arguments: Value,
    cx: &App,
) -> Result<Box<dyn Action>, String> {
    let name = app_actions(app, cx)
        .find(|name| tool_name(name) == tool)
        .ok_or_else(|| format!("unknown tool `{tool}`"))?;
    cx.build_action(name, Some(arguments))
        .map_err(|error| error.to_string())
}

fn catalog_path(app: AppInfo) -> PathBuf {
    storage::dir(app).join("catalog.json")
}

/// Identifies this build of the app: when its executable was written.
fn build() -> Option<String> {
    let written = fs::metadata(std::env::current_exe().ok()?)
        .ok()?
        .modified()
        .ok()?;
    let since = written.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(since.as_nanos().to_string())
}

/// Saves what the app offers for its MCP server to list without launching the app.
fn save_catalog(app: AppInfo, cx: &App) {
    let saved = json!({ "build": build(), "catalog": catalog(app, cx) });
    fs::write(catalog_path(app), saved.to_string()).ok();
    // Older builds saved only their tools here.
    fs::remove_file(storage::dir(app).join("tools.json")).ok();
}

/// What this build of the app saved, if it has run since it was installed.
fn saved_catalog(app: AppInfo) -> Option<Value> {
    let saved: Value = serde_json::from_slice(&fs::read(catalog_path(app)).ok()?).ok()?;
    let current = build()?;
    (saved["build"].as_str() == Some(current.as_str())).then(|| saved["catalog"].clone())
}
