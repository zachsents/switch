//! A tool call as a step a person can read, the desktop's `brain/step.ts`: "Searched Google for
//! “costco orders”", "Ran `ls ~/code` on studio", "Read `Views/List.swift`", each with its icon.
//! Known tools get their own wording (the agent's own, Switch's own apps', old Switchboard's brain
//! tool); an app's tool reads from its verb and its first argument; anything else falls back to its
//! name.

// The typed API the views use; parts not yet drawn are still the API.
#![allow(dead_code)]

use serde_json::Value;

use crate::json::{get, gs, list};

/// A piece of a step's words: words, or a command, path or address shown as code.
#[derive(Clone, Debug)]
pub struct Part {
    pub text: String,
    pub code: bool,
}

#[derive(Clone, Debug)]
pub struct Step {
    pub icon: &'static str,
    pub parts: Vec<Part>,
}

impl Step {
    /// A step's words, as one line.
    pub fn text(&self) -> String {
        self.parts.iter().map(|p| p.text.as_str()).collect()
    }
}

/// Switch's own apps, whose tools a turn calls through the gateway.
pub const OWN_APPS: &[&str] = &["brain", "autonomy", "skills", "connections", "extensions", "accounts", "inbox", "iphone"];

fn words(t: impl Into<String>) -> Part {
    Part { text: t.into(), code: false }
}

fn step(icon: &'static str, parts: Vec<Part>) -> Step {
    Step { icon, parts }
}

/// Home folders as `~`, every one.
fn home(line: &str) -> String {
    let mut out = String::new();
    let mut rest = line;
    while let Some(at) = rest.find("/Users/") {
        let after = &rest[at + 7..];
        let end = after.find(|c: char| c == '/' || c.is_whitespace()).unwrap_or(after.len());
        if end == 0 {
            out.push_str(&rest[..at + 7]);
            rest = after;
            continue;
        }
        out.push_str(&rest[..at]);
        out.push('~');
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// One line of at most `max` characters, home folders as `~`.
fn short(value: &str, max: usize) -> String {
    let line = home(&value.split_whitespace().collect::<Vec<_>>().join(" "));
    // Counted and cut in UTF-16 units, as JavaScript's `length` and `slice` count.
    let units: Vec<u16> = line.encode_utf16().collect();
    if units.len() > max { format!("{}…", String::from_utf16_lossy(&units[..max])) } else { line }
}

fn code(v: &str) -> Part {
    Part { text: short(v, 90), code: true }
}

/// A file as a step names it: its folder and its name (`~/code/app/Views/List.swift` is
/// `Views/List.swift`); a short path stays whole.
fn file(path: &str) -> Part {
    let parts: Vec<&str> = path.trim().trim_end_matches('/').split('/').collect();
    if parts.len() > 2 { code(&parts[parts.len() - 2..].join("/")) } else { code(path) }
}

/// Quoted words, cut to `max`.
fn quoted(v: &str, max: usize) -> String {
    format!("“{}”", short(v, max))
}

/// The first of `keys` the input has as words.
fn field(input: &Value, keys: &[&str]) -> String {
    keys.iter().map(|k| gs(input, k).trim().to_string()).find(|v| !v.is_empty()).unwrap_or_default()
}

fn or(v: String, fallback: &str) -> String {
    if v.is_empty() { fallback.into() } else { v }
}

/// A web address as a person says it: its host, and its path when there's one.
fn site(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(u) if u.host_str().is_some() => {
            let mut host = u.host_str().unwrap_or_default().to_string();
            if let Some(p) = u.port() {
                host = format!("{host}:{p}");
            }
            let host = host.strip_prefix("www.").map(str::to_string).unwrap_or(host);
            if u.path() == "/" { host } else { format!("{host}{}", u.path()) }
        }
        _ => url.to_string(),
    }
}

/// An app's name as a person says it: "uber-courier" is "Uber courier".
fn named(app: &str) -> String {
    let spaced = app.replace(['-', '_'], " ");
    let mut c = spaced.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => spaced,
    }
}

/// The longest of `apps` that `name` starts with, then one of `after`.
fn app_in(name: &str, apps: &[String], after: &[char]) -> Option<String> {
    let mut found: Vec<&String> = apps.iter().filter(|a| after.iter().any(|c| name.starts_with(&format!("{a}{c}")))).collect();
    found.sort_by_key(|a| std::cmp::Reverse(a.len()));
    found.first().map(|a| a.to_string())
}

/// Where a tool ran: an app, and the machine its instance is on ("macos-studio" is macos on
/// studio) when `apps` knows the app.
#[derive(Clone)]
struct At {
    app: String,
    machine: String,
}

fn at_of(instance: &str, apps: &[String]) -> At {
    match app_in(instance, apps, &['-']) {
        Some(app) => At { machine: instance[app.len() + 1..].to_string(), app },
        None => At { app: instance.into(), machine: String::new() },
    }
}

fn on(at: &At) -> Vec<Part> {
    if at.machine.is_empty() { vec![] } else { vec![words(format!(" on {}", at.machine))] }
}

fn with(mut parts: Vec<Part>, more: Vec<Part>) -> Vec<Part> {
    parts.extend(more);
    parts
}

fn target(s: &Value) -> String {
    field(s, &["match", "text", "selector", "label"])
}

/// A browser step (`op`), with what it acted on; none when it says nothing.
fn browser(op: &str, s: &Value) -> Option<Step> {
    let op = match op {
        "goto" | "navigate" => "open",
        "type" => "fill",
        "text" | "snapshot" => "read",
        "eval" => "js",
        "shot" => "screenshot",
        o => o,
    };
    match op {
        "open" => {
            let url = field(s, &["url"]);
            (!url.is_empty()).then(|| step("globe", vec![words("Opened "), code(&site(&url))]))
        }
        "click" => {
            let t = target(s);
            (!t.is_empty()).then(|| step("cursor-click", vec![words(format!("Clicked {}", quoted(&t, 60)))]))
        }
        "fill" => {
            let t = target(s);
            Some(step("cursor-click", vec![words(if t.is_empty() { "Filled in a field".into() } else { format!("Filled in {}", quoted(&t, 60)) })]))
        }
        "read" => Some(step("globe", vec![words("Read the page")])),
        "js" => Some(step("terminal-window", vec![words("Ran a script on the page")])),
        "screenshot" => Some(step("camera", vec![words("Took a screenshot")])),
        _ => None,
    }
}

fn searched(i: &Value, at: &At) -> Step {
    let query = field(i, &["query", "q", "text", "term", "pattern", "search"]);
    let app = named(&at.app);
    step("magnifying-glass", with(vec![words(if query.is_empty() { format!("Searched {app}") } else { format!("Searched {app} for {}", quoted(&query, 100)) })], on(at)))
}

fn ran(i: &Value, at: &At) -> Step {
    let argv = list(get(i, "argv")).iter().map(|v| v.as_str().unwrap_or_default().to_string()).collect::<Vec<_>>().join(" ");
    let command = Some(field(i, &["command", "cmd"])).filter(|c| !c.is_empty()).unwrap_or(argv);
    step("terminal-window", with(vec![words("Ran "), if command.is_empty() { words("a command") } else { code(&command) }], on(at)))
}

fn read_it(i: &Value, at: &At) -> Step {
    let path = field(i, &["path", "file_path", "file"]);
    step("file-text", if path.is_empty() { vec![words(format!("Read {}", named(&at.app)))] } else { with(vec![words("Read "), file(&path)], on(at)) })
}

fn listed(i: &Value, at: &At) -> Step {
    let path = field(i, &["path"]);
    let what = if path.is_empty() { vec![words(format!("Listed {}", named(&at.app)))] } else { vec![words("Listed "), code(&path)] };
    step("folder-open", with(what, on(at)))
}

fn checked(at: &At) -> Step {
    step("eye", with(vec![words(format!("Checked {}", named(&at.app)))], on(at)))
}

fn pictured(at: &At) -> Step {
    step("camera", with(vec![words(format!("Took a picture with {}", named(&at.app)))], on(at)))
}

/// What an app's verb did, given its input.
fn verb(name: &str, i: &Value, at: &At) -> Option<Step> {
    Some(match name {
        "exec" | "run" | "shell" => ran(i, at),
        "search" | "find" | "lookup" | "query" => searched(i, at),
        "read" | "read_file" => read_it(i, at),
        "write_file" => step("note-pencil", with(vec![words("Wrote "), file(&or(field(i, &["path", "file_path"]), "a file"))], on(at))),
        "list" | "list_files" => listed(i, at),
        "transfer_file" => step(
            "paper-plane-tilt",
            vec![words("Sent "), code(&or(field(i, &["path"]), "a file")), words(format!(" to {}", or(field(i, &["to"]), "another Mac")))],
        ),
        "open" => {
            let url = field(i, &["url", "link"]);
            step("globe", with(vec![words("Opened "), if url.is_empty() { words(named(&at.app)) } else { code(&site(&url)) }], on(at)))
        }
        "ui" => step("cursor-click", with(vec![words(format!("Drove {}", or(field(i, &["app"]), "the app in front")))], on(at))),
        "moment" => step("eye", vec![words(format!("Looked at what you had open{}", if at.machine.is_empty() { String::new() } else { format!(" on {}", at.machine) }))]),
        "screenshot" | "shot" | "snap" | "camera" => pictured(at),
        "status" | "health" | "check" | "state" | "get_state" => checked(at),
        _ => return None,
    })
}

/// Verbs whose step is the verb done to the app, or to what it was given.
fn past(verb: &str) -> Option<&'static str> {
    Some(match verb {
        "install" => "Installed",
        "update" => "Updated",
        "remove" => "Removed",
        "start" => "Started",
        "stop" => "Stopped",
        "restart" => "Restarted",
        "send" => "Sent",
        "print" => "Printed",
        "order" => "Ordered",
        "cancel" => "Cancelled",
        "approve" => "Approved",
        "merge" => "Merged",
        "deploy" => "Deployed",
        "render" => "Rendered",
        "slice" => "Sliced",
        "label" => "Labeled",
        "book" => "Booked",
        "quote" => "Got a quote from",
        "checkout" => "Checked out on",
        "call" => "Called",
        "notify" => "Notified",
        "connect" => "Connected",
        "disconnect" => "Disconnected",
        "show" => "Showed",
        _ => return None,
    })
}

/// Verbs that run an app itself: old Switchboard's appendage's own icon.
const RUNS: &[&str] = &["install", "update", "remove", "start", "stop", "restart"];

/// A browser-like action's first step (`op`, or the first of its `steps`), and how many more.
fn browsed(verb: &str, i: &Value, at: &At) -> Option<Step> {
    let steps = list(get(i, "steps"));
    let first = steps.first().unwrap_or(i);
    let op = Some(field(i, &["op", "action"])).filter(|o| !o.is_empty()).unwrap_or_else(|| gs(first, "op"));
    if op.is_empty() || op == verb {
        return None;
    }
    let done = browser(&op, first)?;
    let more = if steps.len() > 1 { vec![words(format!(" and {} more", steps.len() - 1))] } else { vec![] };
    Some(step(done.icon, with(with(done.parts, more), on(at))))
}

/// An app's action by its verb, with what it was given; none when the verb says nothing known.
fn action(name: &str, i: &Value, at: &At) -> Option<Step> {
    if let Some(b) = browsed(name, i, at) {
        return Some(b);
    }
    if let Some(s) = verb(name, i, at) {
        return Some(s);
    }
    let past = past(name)?;
    let what = field(i, &["query", "title", "name", "id"]);
    let app = named(&at.app);
    let said = if what.is_empty() { format!("{past} {app}") } else { format!("{past} {app} {}", quoted(&what, 60)) };
    Some(step(if RUNS.contains(&name) { "robot" } else { "lightning" }, with(vec![words(said)], on(at))))
}

/// A tool nobody wrote wording for: its name, and its first argument.
fn fallback(name: &str, i: &Value, at: Option<&At>) -> Step {
    let first = i.as_object().and_then(|o| o.values().find_map(|v| v.as_str().filter(|s| !s.trim().is_empty())));
    let mut parts = vec![words(named(name.trim()))];
    if let Some(f) = first {
        parts.push(words(" "));
        parts.push(code(f));
    }
    if let Some(at) = at {
        parts.extend(on(at));
    }
    step("lightning", parts)
}

fn gist(i: &Value, max: usize) -> String {
    short(&field(i, &["text", "what", "lesson", "title", "summary"]), max)
}

/// A space as a tool was given it, by id or name.
fn space_in(i: &Value, key: &str) -> String {
    quoted(&or(field(i, &[key]), "a space"), 40)
}

/// How an ask's step leads, by its kind.
fn asked(kind: &str) -> &'static str {
    match kind {
        "approval" => "Asked for your approval: ",
        "task" => "Asked you to ",
        _ => "Asked you: ",
    }
}

/// A tapback as iMessage says it: "Loved your message".
fn tapback(r: &str) -> Option<&'static str> {
    Some(match r {
        "love" => "Loved",
        "like" => "Liked",
        "dislike" => "Disliked",
        "laugh" => "Laughed at",
        "emphasize" => "Emphasized",
        "question" => "Questioned",
        _ => return None,
    })
}

/// An extension as a tool was given it, as code.
fn extension_in(i: &Value) -> Part {
    code(&or(field(i, &["extension", "source", "name"]), "?"))
}

fn yes(i: &Value, key: &str) -> bool {
    get(i, key).as_bool() == Some(true)
}

fn quoted_or(i: &Value, key: &str, max: usize, fallback: &str) -> String {
    let v = field(i, &[key]);
    if v.is_empty() { fallback.into() } else { quoted(&v, max) }
}

/// Switch's own apps' tools (the gateway's), by name: old Switchboard's wording where it had the
/// tool, else the same way: what it did, past tense, with what it was given. `output` is what came
/// back, where it names the step.
fn own(tool: &str, i: &Value, output: &str) -> Option<Step> {
    let f = |keys: &[&str]| field(i, keys);
    Some(match tool {
        "brain_query" => step("database", vec![words(format!("Looked through the brain's {}", or(f(&["from"]), "events")))]),
        "brain_post" => step("chat-text", vec![words(format!("Said in {}: {}", or(f(&["space"]), "a space"), gist(i, 80)))]),
        "brain_react" => {
            let emoji = f(&["emoji"]);
            if !emoji.is_empty() {
                step("chat-text", vec![words(format!("Reacted {emoji} to your message"))])
            } else {
                step("chat-text", vec![words(match tapback(&f(&["reaction"])) {
                    Some(t) => format!("{t} your message"),
                    None => "Took back a reaction".into(),
                })])
            }
        }
        "brain_user" => step("book-open", vec![words("Read who you are")]),
        "brain_describe_user" => step("note-pencil", vec![words("Updated who you are")]),
        "brain_spaces" => step("squares-four", vec![words("Listed the spaces")]),
        "brain_create_space" => step("squares-four", vec![words(format!("Made the space {}", quoted(&f(&["name"]), 40)))]),
        "brain_rename_space" => step("squares-four", vec![words(format!("Renamed {} to {}", space_in(i, "space"), quoted(&f(&["name"]), 40)))]),
        "brain_move_space" => step(
            "squares-four",
            vec![words(if f(&["parent"]).is_empty() {
                format!("Moved {} to the top", space_in(i, "space"))
            } else {
                format!("Moved {} into {}", space_in(i, "space"), space_in(i, "parent"))
            })],
        ),
        "brain_archive_space" => step(
            "squares-four",
            vec![words(if yes(i, "undo") { format!("Opened {} again", space_in(i, "space")) } else { format!("Archived {}", space_in(i, "space")) })],
        ),
        "brain_move_exchange" => step("squares-four", vec![words(format!("Moved an exchange to {}", space_in(i, "space")))]),
        "brain_remove_message" => step(
            "squares-four",
            vec![words(if yes(i, "undo") { format!("Put a message back in {}", space_in(i, "space")) } else { format!("Removed a message from {}", space_in(i, "space")) })],
        ),
        "brain_widgets" => step("squares-four", vec![words("Listed the widgets")]),
        "brain_show_widget" => {
            let title = f(&["title"]);
            let what = if title.is_empty() { named(&or(f(&["app"]), "a widget")) } else { quoted(&title, 40) };
            step("squares-four", vec![words(format!("Showed {what}"))])
        }
        "brain_preview_html" => step("squares-four", vec![words("Previewed a page")]),
        "brain_publish" => step(
            "squares-four",
            vec![words(if yes(i, "retired") { "Took down a page".into() } else { format!("Published {}", quoted_or(i, "title", 40, "a page")) })],
        ),
        "brain_pages" => step("squares-four", vec![words("Listed the pages")]),
        "brain_place_widget" => step("squares-four", vec![words(format!("Placed {}", named(&or(f(&["app"]), "a widget"))))]),
        "brain_remove_widget" => step("squares-four", vec![words(format!("Took down {}", named(&or(f(&["app"]), "a widget"))))]),
        "brain_folder" => step(
            "folder-open",
            if f(&["path"]).is_empty() {
                vec![words(format!("Cleared the folder of {}", space_in(i, "space")))]
            } else {
                vec![words(format!("Set the folder of {} to ", space_in(i, "space"))), code(&f(&["path"]))]
            },
        ),
        "brain_folders" => step("folder-open", vec![words("Listed the folders")]),
        "autonomy_say" => {
            let unsaid = output.match_indices("\"said\":").any(|(at, m)| output[at + m.len()..].trim_start().starts_with("false"));
            step("chat-text", vec![words(format!("{}{}", if unsaid { "Didn't repeat: " } else { "Said: " }, short(&f(&["text"]), 120)))])
        }
        "autonomy_nothing" => {
            let note = f(&["note"]);
            step("chat-text", vec![words(if note.is_empty() { "Said nothing".into() } else { format!("Said nothing: {}", short(&note, 120)) })])
        }
        "autonomy_expect" => step("eye", vec![words(format!("{}: {}", if yes(i, "drop") { "Stopped expecting" } else { "Will look again" }, gist(i, 100)))]),
        "autonomy_wait" => step("eye", vec![words("Waited")]),
        "autonomy_surprise" => step("lightning", vec![words(if yes(i, "dismiss") { "Took down a surprise".into() } else { format!("Flagged: {}", gist(i, 100)) })]),
        "autonomy_remember" => step("brain", vec![words(format!("Remembered: {}", gist(i, 100)))]),
        "autonomy_action_item" => {
            let g = gist(i, 140);
            let what = if g.is_empty() { short(&field(get(i, "ask"), &["title"]), 140) } else { g };
            step("tray", vec![words(format!("{}{what}", asked(&f(&["kind"]))))])
        }
        "autonomy_close_item" => {
            let why = f(&["why"]);
            step(
                "tray",
                vec![words(format!(
                    "{}{}",
                    if f(&["status"]) == "done" { "Closed an ask" } else { "Dismissed an ask" },
                    if why.is_empty() { String::new() } else { format!(": {}", short(&why, 120)) }
                ))],
            )
        }
        "autonomy_follow_item" => step(
            "eye",
            vec![words(if get(i, "follow").as_bool() == Some(false) { "Stopped waiting on an ask" } else { "Waiting on an item in your queue" })],
        ),
        "autonomy_wake_rule" => step(
            "eye",
            vec![words(if yes(i, "retired") { "Retired the wake rule " } else { "Set the wake rule " }), code(&or(f(&["name"]), "?"))],
        ),
        "autonomy_setting" => {
            let key = f(&["key"]);
            if key.is_empty() {
                step("gear", vec![words("Read the dials")])
            } else {
                let value = match get(i, "value") {
                    Value::Number(n) => js_number(n),
                    v => quoted(v.as_str().unwrap_or_default(), 40),
                };
                step("gear", vec![words("Set "), code(&key), words(format!(" to {value}"))])
            }
        }
        "autonomy_cover" => step("camera", vec![words(format!("{} the cover of {}", if f(&["image"]).is_empty() { "Cleared" } else { "Set" }, space_in(i, "space")))]),
        "autonomy_image" => step("camera", vec![words(format!("Drew {}", quoted(&f(&["prompt"]), 40)))]),
        "inbox_inbox" => step("tray", vec![words("Read the inbox")]),
        "inbox_thread" => {
            let who = f(&["with"]);
            step("chat-text", vec![words(if who.is_empty() { "Read a conversation".into() } else { format!("Read the conversation with {}", quoted(&who, 40)) })])
        }
        "iphone_notify" => step("bell", vec![words(format!("Notified your iPhone: {}", short(&f(&["title", "body"]), 80)))]),
        "iphone_live_activity_start" => step("bell", vec![words(format!("Started a Live Activity: {}", quoted(&f(&["title"]), 60)))]),
        "iphone_live_activity_update" => {
            let title = f(&["title"]);
            step("bell", vec![words(if title.is_empty() { "Updated a Live Activity".into() } else { format!("Updated a Live Activity: {}", quoted(&title, 60)) })])
        }
        "iphone_live_activity_end" => step("bell", vec![words("Ended a Live Activity")]),
        "iphone_wallet_issue_pass" => step("paper-plane-tilt", vec![words(format!("Issued a Wallet pass: {}", quoted(&f(&["title"]), 60)))]),
        "iphone_wallet_bundle" => {
            let n = get(i, "serials").as_array().map(|a| a.len().to_string()).unwrap_or_else(|| "the".into());
            step("paper-plane-tilt", vec![words(format!("Bundled {n} Wallet passes"))])
        }
        "iphone_wallet_check" => step("eye", vec![words("Checked the Wallet pass "), file(&or(f(&["pass"]), "?"))]),
        "iphone_wallet_check_link" => step("eye", vec![words("Checked the Wallet passes at "), code(&site(&or(f(&["link"]), "?")))]),
        "desktop_screenshot" => step("camera", vec![words("Took a screenshot of Switchboard")]),
        "desktop_notify" => step("bell", vec![words(format!("Notified your Mac: {}", short(&f(&["title", "body"]), 80)))]),
        "skills_read" => step("book-open", vec![words(format!("Read the {} skill", or(f(&["name"]), "a")))]),
        "extensions_list" => step("robot", vec![words("Listed the extensions")]),
        "extensions_install" => {
            let machine = f(&["machine"]);
            let mut parts = vec![words("Installed the extension "), extension_in(i)];
            if !machine.is_empty() {
                parts.push(words(format!(" on {machine}")));
            }
            step("robot", parts)
        }
        "extensions_update" => step("robot", vec![words("Updated the extension "), extension_in(i)]),
        "extensions_remove" => step("robot", vec![words("Removed the extension "), extension_in(i)]),
        "extensions_place" => step("robot", vec![words("Moved the extension "), extension_in(i), words(format!(" to {}", or(f(&["machine"]), "another machine")))]),
        "accounts_list" => step("gear", vec![words("Listed the accounts")]),
        "accounts_add" => step("gear", vec![words(format!("Added a {} account", or(f(&["provider"]), "provider")))]),
        "accounts_sign_in" => step("gear", vec![words("Started signing in "), code(&or(f(&["id"]), "an account"))]),
        "accounts_remove" => step("gear", vec![words("Removed the account "), code(&or(f(&["id"]), "?"))]),
        "connections_list" => step("gear", vec![words("Listed the connections")]),
        "connections_request" => step("gear", vec![words(format!("Asked to connect {}", or(f(&["kind", "provider", "name"]), "an account")))]),
        "connections_save" => step("gear", vec![words(format!("Saved a {} key from ", or(f(&["provider"]), "provider"))), file(&or(f(&["file"]), "a file"))]),
        "connections_connect" => step("gear", vec![words(format!("Opened {}'s sign-in", or(f(&["provider"]), "a provider")))]),
        "connections_recover" => step("gear", vec![words(format!("Refreshed the {} connection", or(f(&["provider"]), "provider")))]),
        "connections_verify" => step("gear", vec![words(format!("Checked the {} sign-in", or(f(&["provider"]), "provider")))]),
        "connections_readiness" => step("gear", vec![words(format!("Checked how {} connects", or(f(&["provider"]), "a provider")))]),
        "connections_client" => step("gear", vec![words(format!("Kept the {} OAuth client", or(f(&["provider"]), "provider")))]),
        "connections_disconnect" => step("gear", vec![words("Disconnected an account")]),
        _ => return None,
    })
}

/// A string field from pretty-printed JSON that may be cut short, `depth` levels in (0 is the
/// record itself, 1 its body): old Switchboard's `json_text`.
fn json_text(text: &str, key: &str, depth: usize) -> String {
    let needle = format!("\n{}\"{key}\": \"", "  ".repeat(depth + 1));
    let Some(at) = text.find(&needle) else { return String::new() };
    let mut value = String::new();
    let mut escaped = false;
    for c in text[at + needle.len()..].chars() {
        if escaped {
            value.push(c);
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '"' {
            return value;
        } else {
            value.push(c);
        }
    }
    String::new()
}

/// What a record read back is called: its kind and its title or gist.
fn read_back(output: &str) -> String {
    let kind = json_text(output, "kind", 0);
    let name = ["title", "summary", "statement", "text"].iter().map(|k| json_text(output, k, 1)).find(|v| !v.is_empty());
    match (kind.is_empty(), name) {
        (false, Some(n)) => format!("Read the {kind} {}", quoted(&n, 80)),
        (true, _) => "Read a record".into(),
        (false, None) => format!("Read a {kind}"),
    }
}

/// What was done to something to look at: taken down, changed, published or made.
fn made(i: &Value) -> &'static str {
    if yes(i, "retired") {
        "Took down"
    } else if i.get("id").is_some() {
        "Updated"
    } else if yes(i, "link") {
        "Published"
    } else {
        "Made"
    }
}

/// Old Switchboard's brain tool, by its op; `output` is what came back, where it names the step.
fn legacy(op: &str, i: &Value, output: &str) -> Option<Step> {
    let f = |keys: &[&str]| field(i, keys);
    Some(match op {
        "task" => {
            if i.get("work").is_none() {
                step("wrench", vec![words(format!("Started: {}", short(&or(f(&["title"]), "a task"), 120)))])
            } else {
                step("arrow-elbow-down-right", vec![words(format!("Steered a task: {}", short(&f(&["text"]), 120)))])
            }
        }
        "ask" => {
            let text = f(&["text"]);
            let first = text.split('\n').next().unwrap_or_default();
            step("tray", vec![words(format!("{}{}", asked(&f(&["type"])), short(first, 140)))])
        }
        "follow" => {
            let text = f(&["text"]);
            step("eye", vec![words(if text.is_empty() { "Waiting on an item in your queue".into() } else { format!("Waiting on your queue: {}", short(&text, 120)) })])
        }
        "dismiss" => step(
            "tray",
            vec![words(format!("{}{}", if yes(i, "entirely") { "Dismissed an ask: " } else { "Stopped waiting on an ask: " }, short(&f(&["why"]), 120)))],
        ),
        "report" => step("file-text", vec![words(format!("Reported: {}", short(&f(&["takeaway"]), 120)))]),
        "say" => step("chat-text", vec![words(format!("{}{}", if output.starts_with("Not said") { "Didn't repeat: " } else { "Said: " }, short(&f(&["text"]), 120)))]),
        "object" => {
            let title = Some(f(&["title"])).filter(|t| !t.is_empty()).unwrap_or_else(|| output.split('"').nth(1).unwrap_or_default().to_string());
            let what = if title.is_empty() { "an object".into() } else { quoted(&title, 100) };
            step("squares-four", vec![words(format!("{} {what}", made(i)))])
        }
        "search" => step("magnifying-glass", vec![words("Searched the brain for "), code(&f(&["text"]))]),
        "query" => step("database", vec![words("Queried "), code(&f(&["query"]))]),
        "recent" => step("book-open", vec![words("Read the latest in "), code(&or(f(&["stream"]), "a stream"))]),
        "read" => {
            let id = f(&["id"]);
            if id.starts_with("work/") {
                step("book-open", vec![words("Read a work")])
            } else if id.contains(':') {
                step("book-open", vec![words("Looked up "), code(&id)])
            } else {
                step("book-open", vec![words(read_back(output))])
            }
        }
        "zoom" => step("book-open", vec![words("Opened a summary")]),
        "expect" => {
            if yes(i, "retired") {
                fallback("brain", i, None)
            } else {
                step("eye", vec![words(format!("Will look again: {}", short(&f(&["statement"]), 100)))])
            }
        }
        "wait" => step("eye", vec![words("Waited")]),
        "record" => {
            let body = get(i, "body");
            let kind = f(&["kind"]);
            match kind.as_str() {
                "observation" => step("notebook", vec![words(format!("Noted: {}", short(&or(field(body, &["summary", "entity"]), "something"), 120)))]),
                "note" => step("notebook", vec![words(format!("Noted: {}", short(&or(field(body, &["text"]), "something"), 120)))]),
                _ => step("notebook", vec![words(format!("Recorded a {} in ", or(kind, "record"))), code(&or(f(&["stream"]), "the brain"))]),
            }
        }
        "request" => {
            let t = f(&["target"]);
            let mut parts = t.splitn(2, '@');
            let (app, machine) = (parts.next().unwrap_or_default().to_string(), parts.next().unwrap_or_default().to_string());
            let at = if app == "macos" { At { app: machine, machine: String::new() } } else { At { app, machine } };
            let verb = f(&["action"]);
            let args = get(i, "args");
            let args = if args.is_object() { args.clone() } else { Value::Object(Default::default()) };
            action(&verb, &args, &at).unwrap_or_else(|| fallback(&verb, &args, Some(&at)))
        }
        _ => return None,
    })
}

fn ran_shell(i: &Value) -> Step {
    let said = field(i, &["description"]);
    if said.is_empty() {
        step("terminal-window", vec![words("Ran "), code(&or(field(i, &["command", "cmd"]), "a command"))])
    } else {
        step("terminal-window", vec![words(short(&said, 140))])
    }
}

fn path_of(i: &Value) -> String {
    or(field(i, &["file_path", "path", "notebook_path"]), "a file")
}

fn plan(i: &Value) -> Step {
    let doing = list(get(i, "todos")).iter().find(|t| gs(t, "status") == "in_progress").cloned();
    let said = match doing {
        Some(t) => short(&Some(gs(&t, "activeForm")).filter(|a| !a.is_empty()).unwrap_or_else(|| gs(&t, "content")), 120),
        None => "Updated the plan".into(),
    };
    step("list-checks", vec![words(said)])
}

/// The agent's own tools: Claude Code's, Codex's, the gateway's.
fn agent(name: &str, i: &Value) -> Option<Step> {
    Some(match name {
        "Bash" | "exec_command" | "shell" | "run_shell_command" => ran_shell(i),
        "Read" => step("file-text", vec![words("Read "), file(&path_of(i))]),
        "Write" => step("note-pencil", vec![words("Wrote "), file(&path_of(i))]),
        "Edit" | "MultiEdit" | "NotebookEdit" => step("note-pencil", vec![words("Edited "), file(&path_of(i))]),
        "Glob" => step("folder-open", vec![words("Found files matching "), code(&or(field(i, &["pattern"]), "*"))]),
        "Grep" => step("magnifying-glass", vec![words("Searched for "), code(&field(i, &["pattern"]))]),
        "LS" => step("folder-open", vec![words("Listed "), code(&or(field(i, &["path"]), "."))]),
        "WebSearch" => step("globe", vec![words(format!("Searched the web for {}", quoted(&field(i, &["query"]), 100)))]),
        "WebFetch" => step("globe", vec![words("Read "), code(&site(&or(field(i, &["url"]), "a page")))]),
        "TodoWrite" => plan(i),
        "Task" | "Agent" => step("robot", vec![words(format!("Asked a helper to {}", short(&or(field(i, &["description"]), "help"), 120)))]),
        "ToolSearch" | "search_tools" => step("magnifying-glass", vec![words(format!("Looked for tools: {}", short(&field(i, &["query"]), 80)))]),
        "delegate_task" => step("wrench", vec![words(format!("Started: {}", short(&field(i, &["title", "task"]), 120)))]),
        "task_steer" => step("arrow-elbow-down-right", vec![words(format!("Steered a task: {}", short(&field(i, &["text"]), 120)))]),
        "task_status" => step("eye", vec![words("Checked on a task")]),
        "task_cancel" => step("stop", vec![words("Stopped a task")]),
        "task_stage" => step("list-checks", vec![words(format!("Stage: {}", short(&field(i, &["stage"]), 40)))]),
        "Skill" => step("book-open", vec![words(format!("Read the {} skill", or(field(i, &["skill", "name"]), "a")))]),
        _ => return None,
    })
}

/// An app's tool, `<app>_<verb>` (the app's instance may name its machine).
fn app_tool(tool: &str, i: &Value, apps: &[String], output: &str) -> Step {
    if let Some(s) = own(tool, i, output) {
        return s;
    }
    let cut = match app_in(tool, apps, &['_', '-']) {
        Some(app) => tool[app.len()..].find('_').map(|c| c + app.len()),
        None => tool.find('_'),
    };
    let Some(cut) = cut.filter(|&c| c > 0) else { return fallback(tool, i, None) };
    let at = at_of(&tool[..cut], apps);
    let verb = &tool[cut + 1..];
    action(verb, i, &at).unwrap_or_else(|| fallback(&format!("{} {verb}", at.app), i, Some(&at)))
}

/// An object or empty, as the desktop's `rec`: an array is an object there too.
fn rec(v: &Value) -> Value {
    if v.is_object() || v.is_array() { v.clone() } else { Value::Object(Default::default()) }
}

/// A number as JavaScript's `String(n)` writes it: a whole one without `.0`.
fn js_number(n: &serde_json::Number) -> String {
    match n.as_f64() {
        Some(f) if n.is_f64() && f.fract() == 0. && f.abs() < 1e21 => format!("{}", f as i64),
        _ => n.to_string(),
    }
}

/// A tool call, as a step. `name` is the tool as the host recorded it: the agent's own, the
/// gateway's (`mcp__<server>__<tool>`, an app's through `call_tool`), or old Switchboard's
/// (`brain`, `<appendage>__<action>`). `apps` are the installed apps' names, to tell an app from the
/// machine its instance runs on.
pub fn describe(name: &str, input: &Value, apps: &[String]) -> Step {
    describe_with(name, input, apps, "")
}

/// `describe`, with what came back (`output`), which names a few of old Switchboard's steps.
pub fn describe_with(name: &str, input: &Value, apps: &[String], output: &str) -> Step {
    let given = rec(input);
    if let Some(rest) = name.strip_prefix("mcp__") {
        let tool = rest.split("__").skip(1).collect::<Vec<_>>().join("__");
        if tool == "call_tool" {
            return app_tool(&field(&given, &["name"]), &rec(get(&given, "arguments")), apps, output);
        }
        return agent(&tool, &given).unwrap_or_else(|| app_tool(&tool, &given, apps, output));
    }
    if name == "brain" {
        return legacy(&field(&given, &["op"]), &given, output).unwrap_or_else(|| fallback("brain", &given, None));
    }
    if let Some(s) = agent(name, &given) {
        return s;
    }
    let mut parts = name.splitn(3, "__");
    let instance = parts.next().unwrap_or_default();
    if let Some(act) = parts.next() {
        let at = at_of(instance, apps);
        return action(act, &given, &at).unwrap_or_else(|| fallback(act, &given, Some(&at)));
    }
    fallback(name, &given, None)
}

/// A step's words, as one line.
pub fn step_text(s: &Step) -> String {
    s.text()
}

/// `macos-studio__exec` is "exec · macos-studio": an app's action reads action first.
pub fn tool_label(name: &str) -> String {
    let mut parts = name.split("__");
    let app = parts.next().unwrap_or_default();
    match parts.next() {
        Some(act) => format!("{act} · {app}"),
        None => name.to_string(),
    }
}
