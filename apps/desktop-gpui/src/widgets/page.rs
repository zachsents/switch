//! The MCP catalog's McpApp (the desktop's host.ts `McpAppElement`, `@a2ui/catalog-mcp`'s bridge)
//! and the agent's pages it shows (page-theme.ts): an HTML app in a web view (webview.rs) where its
//! part is drawn, the host's side of the MCP Apps bridge answered here: `ui/initialize` with this
//! window's theme, then its data (tool input and result, its bound data) once it says it's ready;
//! its tool calls go to its extension's tools (`<app>_<tool>`, through the core's `/widgets`); its
//! links open in the browser; its height (`size-changed`) is its part's, at least 100, except in a
//! widget's own window, where the window decides. A page the agent made opens at the height it was
//! made at (its `switch-height`), and carries this window's theme in place of the one it was made
//! with.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::rc::Rc;
use std::time::Duration;

use futures::StreamExt;
use gpui::{AnyElement, App, Context, IntoElement, ParentElement, Styled, Window, div, prelude::*, px};
use serde_json::{Map, Value, json};

use crate::a2ui::Pressed;
use crate::look::Look;
use crate::webview::{self, Sandbox, Source, WebView};
use crate::widgets::functions;
use crate::widgets::host::{self, Host};
use crate::widgets::palette;
use crate::widgets::render::Ctx;

/// A cell's page height until the page says (`--a2ui-sandboxed-frame-height`: the board, less its line).
const DEFAULT_HEIGHT: f32 = 339.;

/// A page with this window's theme in place of the one it carries; anything else as it is.
pub fn themed(page: &str, look: &Look) -> String {
    let Some(start) = page.find(r#"<style id="switch-theme">"#) else { return page.to_string() };
    let Some(len) = page[start..].find("</style>") else { return page.to_string() };
    let end = start + len + "</style>".len();
    format!("{}{}{}", &page[..start], palette::theme_css(look), &page[end..])
}

/// A CSP source list's entries as the catalog takes them: strings without `;`, quotes or spaces.
fn domains(v: &Value) -> Vec<String> {
    v.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::trim).filter(|d| !d.is_empty() && !d.contains([';', '"', '\'']) && !d.contains(char::is_whitespace)).map(str::to_string).collect()
}

/// The catalog's CSP for a sandboxed app (`buildInnerCspContent`): nothing by default, its own
/// inline scripts and styles, and what `csp` names.
fn csp_of(csp: &Value) -> String {
    let (connect, resource, frame, base) = (domains(&csp["connectDomains"]), domains(&csp["resourceDomains"]), domains(&csp["frameDomains"]), domains(&csp["baseUriDomains"]));
    let suffix = if resource.is_empty() { String::new() } else { format!(" {}", resource.join(" ")) };
    let or_none = |v: &Vec<String>| if v.is_empty() { "'none'".to_string() } else { v.join(" ") };
    let base = if base.is_empty() { "'self'".to_string() } else { format!("'self' {}", base.join(" ")) };
    [
        "default-src 'none'".to_string(),
        format!("script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:{suffix}"),
        format!("style-src 'self' 'unsafe-inline' blob: data:{suffix}"),
        format!("img-src 'self' data: blob:{suffix}"),
        format!("font-src 'self' data: blob:{suffix}"),
        format!("media-src 'self' data: blob:{suffix}"),
        format!("connect-src {}", or_none(&connect)),
        format!("frame-src {}", or_none(&frame)),
        format!("base-uri {base}"),
        "form-action 'none'".to_string(),
    ]
    .join("; ")
        + ";"
}

/// The page with its CSP first in its head, as the catalog's `injectCspMeta` does: the page parsed
/// as a browser parses it (so a `<head>` in a comment, a script, a title or an attribute is only
/// words), the meta the real head's first child, the document written out again.
fn with_csp(html: &str, csp: &Value) -> String {
    use html5ever::{LocalName, QualName, ns};
    use scraper::{Html, Node, Selector};
    let mut doc = Html::parse_document(html);
    let head = Selector::parse("head").ok().and_then(|s| doc.select(&s).next().map(|h| h.id()));
    let attr = |name: &str, value: &str| html5ever::Attribute { name: QualName::new(None, ns!(), LocalName::from(name)), value: value.into() };
    let meta = scraper::node::Element::new(QualName::new(None, ns!(html), LocalName::from("meta")), vec![attr("http-equiv", "Content-Security-Policy"), attr("content", &csp_of(csp))]);
    if let Some(id) = head
        && let Some(mut h) = doc.tree.get_mut(id)
    {
        h.prepend(Node::Element(meta));
    }
    doc.html()
}

/// An app's `permissions` prop.
fn sandbox_of(p: &Value) -> Sandbox {
    let on = |k: &str| p.get(k).is_some_and(|v| v.as_bool() == Some(true) || v.is_object());
    Sandbox { camera: on("camera"), microphone: on("microphone"), geolocation: on("geolocation"), clipboard_write: on("clipboardWrite") }
}

/// The height a page opens at (the core's `withHeight`).
fn made_height(html: &str) -> Option<f32> {
    let at = html.find(r#"<meta name="switch-height" content=""#)? + r#"<meta name="switch-height" content=""#.len();
    let end = html[at..].find('"')?;
    html[at..at + end].parse().ok()
}

/// A value `url_encoded:` for transport, read back.
fn decoded(html: &str) -> String {
    match html.strip_prefix("url_encoded:") {
        Some(rest) => {
            let b = rest.as_bytes();
            let mut out = Vec::with_capacity(b.len());
            let mut i = 0;
            while i < b.len() {
                if b[i] == b'%' && i + 3 <= b.len() {
                    if let Ok(v) = u8::from_str_radix(&rest[i + 1..i + 3], 16) {
                        out.push(v);
                        i += 3;
                        continue;
                    }
                }
                out.push(b[i]);
                i += 1;
            }
            String::from_utf8_lossy(&out).into_owned()
        }
        None => html.to_string(),
    }
}

/// The most a message from a page may hold (the catalog's payload checks): 64 KB, ten levels deep,
/// and no key that would reach an object's prototype.
const MAX_BYTES: usize = 64 * 1024;
const MAX_DEPTH: usize = 10;
const FORBIDDEN: [&str; 3] = ["__proto__", "constructor", "prototype"];

/// Whether a payload from a page may be taken: what's wrong with it, if anything.
fn checked(v: &Value) -> Result<(), String> {
    let size = v.to_string().len();
    if size > MAX_BYTES {
        return Err(format!("Message payload exceeds maximum allowed size of {MAX_BYTES} bytes ({size} bytes)"));
    }
    fn walk(v: &Value, depth: usize) -> Result<(), String> {
        if depth > MAX_DEPTH {
            return Err(format!("Exceeded maximum allowed nesting depth of {MAX_DEPTH} levels"));
        }
        match v {
            Value::Array(a) => a.iter().try_for_each(|x| walk(x, depth + 1)),
            Value::Object(o) => o.iter().try_for_each(|(k, x)| {
                if FORBIDDEN.contains(&k.as_str()) {
                    return Err(format!("Detected forbidden prototype pollution property key: \"{k}\""));
                }
                walk(x, depth + 1)
            }),
            _ => Ok(()),
        }
    }
    walk(v, 0)
}

/// The keywords a schema may use, as Ajv's strict mode knows them: any other refuses it.
const KEYWORDS: &[&str] = &[
    "type", "enum", "const", "properties", "required", "additionalProperties", "patternProperties", "propertyNames", "items", "prefixItems",
    "additionalItems", "contains", "minContains", "maxContains", "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern",
    "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minProperties", "maxProperties", "dependencies",
    "dependentRequired", "dependentSchemas", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "unevaluatedProperties",
    "unevaluatedItems", "$id", "$schema", "$ref", "$defs", "definitions", "$comment", "$anchor", "$dynamicRef", "$dynamicAnchor", "title",
    "description", "default", "examples", "readOnly", "writeOnly", "deprecated", "contentMediaType", "contentEncoding", "contentSchema",
];

/// Whether a schema uses only keywords Ajv strict knows, down through its subschemas.
fn strict(schema: &Value) -> Result<(), String> {
    let Value::Object(o) = schema else { return Ok(()) };
    for (k, v) in o {
        if !KEYWORDS.contains(&k.as_str()) {
            return Err(format!("strict mode: unknown keyword: \"{k}\""));
        }
        match k.as_str() {
            "properties" | "patternProperties" | "$defs" | "definitions" | "dependentSchemas" => {
                for sub in v.as_object().into_iter().flat_map(|m| m.values()) {
                    strict(sub)?;
                }
            }
            "allOf" | "anyOf" | "oneOf" | "prefixItems" => {
                for sub in v.as_array().into_iter().flatten() {
                    strict(sub)?;
                }
            }
            "items" | "additionalProperties" | "additionalItems" | "contains" | "not" | "if" | "then" | "else" | "propertyNames"
            | "unevaluatedProperties" | "unevaluatedItems" | "contentSchema" => match v {
                Value::Array(a) => a.iter().try_for_each(strict)?,
                other => strict(other)?,
            },
            "dependencies" => {
                for sub in v.as_object().into_iter().flat_map(|m| m.values()).filter(|x| x.is_object()) {
                    strict(sub)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// A subpath reaching a prototype.
fn forbidden_subpath(sub: &str) -> bool {
    sub.split('/').any(|s| FORBIDDEN.contains(&s.replace("~1", "/").replace("~0", "~").as_str()))
}

/// How big a page may ask to be: at least 100 tall, as host.ts's element takes it at once; 200 to
/// 3000 wide as A2UI's FrameSizing takes it, a change of less than 5 left alone, at most one every
/// 100 ms.
const MIN_HEIGHT: f32 = 100.;
const MAX_FRAME_HEIGHT: f32 = 2000.;
const WIDTHS: (f32, f32) = (200., 3000.);
/// The MCP Apps protocol versions this host speaks, its latest first.
const PROTOCOL_VERSIONS: [&str; 1] = ["2026-01-26"];
const DEAD_BAND: f32 = 5.;
const THROTTLE: Duration = Duration::from_millis(100);

/// One app's page and the host's side of its bridge.
pub struct PageHost {
    view: Option<Rc<WebView>>,
    sig: u64,
    /// The height and width it asked for and was given; none until it asks.
    asked: (Option<f32>, Option<f32>),
    /// What it asked for since, waiting out the throttle.
    pending: Option<(Option<f32>, Option<f32>)>,
    opens_at: f32,
    key: String,
    /// Its data's keys and where they're bound in the data model.
    paths: Map<String, Value>,
    allowed: Vec<String>,
    /// Its `allowedFunctions`: each function's name and the schema its arguments must meet.
    functions: Map<String, Value>,
    /// Its `csp` prop: the domains it may reach.
    csp: Value,
    /// Its `permissions` prop.
    sandbox: Sandbox,
    surface: Option<Rc<crate::a2ui::Surface>>,
    ready: bool,
    in_window: bool,
    /// Each bound key's value as the page last knew it (sent it, or wrote it itself).
    last: HashMap<String, Value>,
    /// What it was last sent: its tool input and result, its host context.
    sent_input: Option<String>,
    sent_result: Option<String>,
    sent_context: Option<Map<String, Value>>,
    /// This Mac's appearance (the theme it's told is the system's, as a browser's media query says).
    system_dark: bool,
}

fn sig_of(html: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    html.hash(&mut h);
    h.finish()
}

impl PageHost {
    fn new(key: &str) -> Self {
        PageHost {
            view: None,
            sig: 0,
            asked: (None, None),
            pending: None,
            opens_at: DEFAULT_HEIGHT,
            key: key.into(),
            paths: Map::new(),
            allowed: vec![],
            functions: Map::new(),
            csp: Value::Null,
            sandbox: Sandbox::default(),
            surface: None,
            ready: false,
            in_window: false,
            last: HashMap::new(),
            sent_input: None,
            sent_result: None,
            sent_context: None,
            system_dark: false,
        }
    }

    /// No page: what it showed goes, and its bridge with it.
    fn clear(&mut self) {
        self.view = None;
        self.sig = 0;
        self.ready = false;
        self.sent_context = None;
    }

    /// The page made again when its HTML changed (a new theme), else kept.
    fn show(&mut self, html: &str, window: &mut Window, cx: &mut Context<Self>) {
        let sig = sig_of(html);
        if self.view.is_some() && sig == self.sig {
            return;
        }
        self.sig = sig;
        self.ready = false;
        self.asked = (None, None);
        self.pending = None;
        // What it starts knowing: its bound values as they are now.
        self.last = self.bound().into_iter().map(|(k, p)| (k, self.data(&p))).collect();
        self.sent_input = None;
        self.sent_result = None;
        self.sent_context = None;
        // A page the agent made opens in a chat at the height it was made at.
        self.opens_at = made_height(html).filter(|_| self.key.contains('#')).unwrap_or(DEFAULT_HEIGHT);
        // In a sandbox as A2UI's frame is: an opaque origin, its CSP (no network, frames or forms
        // unless `csp` names them), its document only, and what `permissions` allow.
        let sandboxed = with_csp(html, &self.csp);
        // What WebKit lets it load, whatever the page does: the domains its CSP names.
        let allowed: Vec<String> = ["connectDomains", "resourceDomains", "frameDomains"].iter().flat_map(|k| domains(&self.csp[*k])).collect();
        let Some(view) = WebView::new(window, Source::Sandboxed { html: &sandboxed, sandbox: self.sandbox, allowed: &allowed }, &[], cx) else { return };
        view.forward_wheel(!self.in_window);
        if let Some(mut inbox) = view.messages() {
            cx.spawn(async move |this, cx| {
                while let Some(text) = inbox.next().await {
                    let Ok(m) = serde_json::from_str::<Value>(&text) else { continue };
                    if this.update(cx, |h, cx| h.heard(m, cx)).is_err() {
                        break;
                    }
                }
            })
            .detach();
        }
        self.view = Some(view);
    }

    fn post(&self, m: Value) {
        if let Some(v) = &self.view {
            v.post(&m);
        }
    }

    fn answer(&self, id: &Value, result: Value) {
        self.post(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }

    /// A request it isn't allowed, or whose arguments don't hold: JSON-RPC's invalid params.
    fn reject(&self, id: &Value, message: &str) {
        self.post(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": message } }));
    }

    fn fail(&self, id: &Value, code: i64, message: &str) {
        self.post(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }));
    }

    fn notify_page(&self, method: &str, params: Value) {
        self.post(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    fn data(&self, path: &str) -> Value {
        self.surface.as_ref().map(|s| s.get(path)).unwrap_or(Value::Null)
    }

    /// The host context it's told: this window's appearance, inline, this Mac's locale and time
    /// zone, and the size it's drawn at.
    fn context(&self) -> Map<String, Value> {
        let (w, h) = self.view.as_ref().map(|v| v.size()).unwrap_or((0., 0.));
        let v = json!({
            "theme": if self.system_dark { "dark" } else { "light" },
            "displayMode": "inline",
            "availableDisplayModes": ["inline"],
            "locale": sys_locale::get_locale().unwrap_or_else(|| "en-US".into()),
            "timeZone": iana_zone(),
            "platform": "web",
            "containerDimensions": { "width": w, "height": h },
        });
        v.as_object().cloned().unwrap_or_default()
    }

    /// What of its host context changed since it was last told, only that (the bridge's
    /// `setHostContext`): its size, the appearance.
    fn send_context(&mut self) {
        let Some(was) = self.sent_context.clone() else { return };
        let now = self.context();
        let changed: Map<String, Value> = now.iter().filter(|(k, v)| was.get(*k) != Some(*v)).map(|(k, v)| (k.clone(), v.clone())).collect();
        if !changed.is_empty() {
            self.sent_context = Some(now);
            self.notify_page("ui/notifications/host-context-changed", Value::Object(changed));
        }
    }

    /// Its data's keys and the paths they're bound to.
    fn bound(&self) -> Vec<(String, String)> {
        self.paths.iter().filter_map(|(k, p)| Some((k.clone(), p.as_str()?.to_string()))).collect()
    }

    /// Everything it's bound to, as it says it's ready: each value whole, its tool input and result.
    fn send_all(&mut self) {
        for (key, path) in self.bound() {
            let value = self.data(&path);
            self.notify_page("ui/notifications/data-model-update", json!({ "key": key, "value": value }));
        }
        self.send_tools(true, true);
    }

    /// A bound value that changed in the data model, not by the page's own write: what changed of
    /// it, field by field for an object or list, then its tool input or result again (the
    /// catalog's DataModelSync).
    fn watch(&mut self) {
        let mut input = false;
        let mut result = false;
        for (key, path) in self.bound() {
            let now = self.data(&path);
            let was = self.last.insert(key.clone(), now.clone());
            if was.as_ref() == Some(&now) {
                continue;
            }
            if !self.ready {
                continue;
            }
            let field = |f: &str| format!("/{}", f.replace('~', "~0").replace('/', "~1"));
            let mut sent = false;
            // An object's or a list's fields: its keys, or its items' places.
            let fields = |v: &Value| -> Option<Vec<(String, Value)>> {
                match v {
                    Value::Object(o) => Some(o.iter().map(|(k, x)| (k.clone(), x.clone())).collect()),
                    Value::Array(a) => Some(a.iter().enumerate().map(|(i, x)| (i.to_string(), x.clone())).collect()),
                    _ => None,
                }
            };
            match fields(&now) {
                Some(now_fields) => {
                    let before: Vec<(String, Value)> = was.as_ref().and_then(fields).unwrap_or_default();
                    let had = |f: &str| before.iter().find(|(k, _)| k == f).map(|(_, v)| v);
                    for (f, v) in &now_fields {
                        if had(f) != Some(v) {
                            self.notify_page("ui/notifications/data-model-update", json!({ "key": key, "subpath": field(f), "value": v }));
                            sent = true;
                        }
                    }
                    for (f, _) in before.iter().filter(|(f, _)| !now_fields.iter().any(|(k, _)| k == f)) {
                        self.notify_page("ui/notifications/data-model-update", json!({ "key": key, "subpath": field(f) }));
                        sent = true;
                    }
                }
                None => {
                    self.notify_page("ui/notifications/data-model-update", json!({ "key": key, "value": now }));
                    sent = true;
                }
            }
            if sent {
                match key.as_str() {
                    "toolResult" => result = true,
                    "modelContext" => {}
                    _ => input = true,
                }
            }
        }
        self.send_tools(input, result);
    }

    /// Its tool input and result, each sent only when it's not what was last sent.
    fn send_tools(&mut self, input_too: bool, result_too: bool) {
        let paths = self.bound();
        let input = match self.paths.get("toolInput").and_then(Value::as_str) {
            Some(p) => {
                let raw = self.data(p);
                (!raw.is_null()).then(|| if raw.is_object() { raw } else { json!({ "value": raw }) })
            }
            None => {
                let rest: Map<String, Value> = paths.iter().filter(|(k, _)| k != "toolResult" && k != "modelContext").map(|(k, p)| (k.clone(), self.data(p))).collect();
                (!rest.is_empty()).then_some(Value::Object(rest))
            }
        };
        let input = input.or_else(|| self.paths.contains_key("toolResult").then(|| json!({}))).filter(|_| input_too);
        if let Some(args) = input {
            let text = args.to_string();
            if self.sent_input.as_deref() != Some(text.as_str()) {
                self.sent_input = Some(text);
                self.notify_page("ui/notifications/tool-input", json!({ "arguments": args }));
            }
        }
        if let Some(p) = self.paths.get("toolResult").and_then(Value::as_str).filter(|_| result_too) {
            let v = self.data(p);
            let text = v.to_string();
            if !v.is_null() && self.sent_result.as_deref() != Some(text.as_str()) {
                self.sent_result = Some(text);
                let result = if v.get("content").is_some_and(Value::is_array) {
                    v
                } else {
                    let words = v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string());
                    let mut r = json!({ "content": [{ "type": "text", "text": words }] });
                    if v.is_object() {
                        r["structuredContent"] = v;
                    }
                    r
                };
                self.notify_page("ui/notifications/tool-result", result);
            }
        }
    }

    /// A value it wrote to one of its bound keys, into the data model (checked first).
    fn write(&mut self, key: &str, sub: Option<&str>, value: Value, cx: &mut Context<Self>) {
        if checked(&value).is_err() || sub.is_some_and(forbidden_subpath) {
            return;
        }
        let Some(path) = self.paths.get(key).and_then(Value::as_str) else { return };
        let full = match sub.filter(|s| !s.is_empty()) {
            Some(s) => format!("{}/{}", path.trim_end_matches('/'), s.trim_start_matches('/')),
            None => path.to_string(),
        };
        // The same as it holds: nothing to write.
        if self.data(&full) == value {
            return;
        }
        let surface = self.key.clone();
        let host = Host::entity(cx);
        host.update(cx, |h, cx| h.write(&surface, &full, value, cx));
        // What the page wrote it knows: not sent back to it.
        let now = host.read(cx).surface(&surface).map(|s| s.get(path)).unwrap_or(Value::Null);
        self.last.insert(key.to_string(), now);
    }

    /// The size it asked for, clamped, once the throttle's waited, unless it's within the dead band.
    fn resize(&mut self, cx: &mut Context<Self>) {
        let Some((w, _)) = self.pending.take() else { return };
        let mut changed = false;
        if let Some(w) = w.map(|w| w.clamp(WIDTHS.0, WIDTHS.1))
            && self.asked.1.is_none_or(|was| (w - was).abs() >= DEAD_BAND)
        {
            self.asked.1 = Some(w);
            changed = true;
        }
        if changed {
            cx.notify();
        }
    }

    fn heard(&mut self, m: Value, cx: &mut Context<Self>) {
        let id = m.get("id").cloned().unwrap_or(Value::Null);
        let params = m.get("params").cloned().unwrap_or(Value::Null);
        // An answer to something the host asked: nothing waits on one.
        if m.get("method").is_none() {
            return;
        }
        match m.get("method").and_then(Value::as_str).unwrap_or_default() {
            "ui/initialize" => {
                let context = self.context();
                self.sent_context = Some(context.clone());
                // The version it asks for when the host speaks it, else the host's latest.
                let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or_default();
                let version = if PROTOCOL_VERSIONS.contains(&asked) { asked } else { PROTOCOL_VERSIONS[0] };
                self.answer(
                    &id,
                    json!({
                        "protocolVersion": version,
                        "hostInfo": { "name": "A2UI McpApp", "version": "1.0.0" },
                        "hostCapabilities": { "openLinks": {}, "logging": {}, "serverTools": {} },
                        "hostContext": context,
                    }),
                );
            }
            "ui/notifications/initialized" => {
                self.ready = true;
                self.send_all();
            }
            "ui/notifications/size-changed" => {
                // In a widget's own window, the window decides its size.
                if self.in_window {
                    return;
                }
                let at = |k: &str| params.get(k).and_then(Value::as_f64).map(|x| x as f32);
                // Its height at once, at least 100 (host.ts's element); its width through the
                // frame's throttle.
                if let Some(h) = at("height").filter(|h| *h > 0.) {
                    let h = h.round().max(MIN_HEIGHT);
                    if self.asked.0 != Some(h) {
                        self.asked.0 = Some(h);
                        cx.notify();
                    }
                }
                let Some(w) = at("width") else { return };
                let first = self.pending.is_none();
                self.pending = Some((Some(w), None));
                if first {
                    cx.spawn(async move |this, cx| {
                        cx.background_executor().timer(THROTTLE).await;
                        this.update(cx, |h, cx| h.resize(cx)).ok();
                    })
                    .detach();
                }
            }
            "ui/open-link" => {
                // The address as the URL parser reads it, opened as that, only on the web.
                let parsed = url::Url::parse(params.get("url").and_then(Value::as_str).unwrap_or_default()).ok().filter(|u| u.scheme() == "http" || u.scheme() == "https");
                match parsed {
                    Some(u) => {
                        cx.open_url(u.as_str());
                        self.answer(&id, json!({}));
                    }
                    None => self.answer(&id, json!({ "isError": true })),
                }
            }
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                if let Err(why) = checked(&args) {
                    self.reject(&id, &format!("Tool '{name}' arguments rejected: {why}"));
                    return;
                }
                // Only the tools its `allowedTools` names: with none listed (an agent's page), none.
                if !self.allowed.contains(&name) {
                    self.reject(&id, &format!("Tool '{name}' is not allowed"));
                    return;
                }
                // An extension's app calls its own tools by their gateway names: `printers_camera`.
                let (app, tool) = name.split_once('_').map(|(a, t)| (a.to_string(), t.to_string())).unwrap_or((name.clone(), String::new()));
                let job = host::call_tool(&app, &tool, &args, cx);
                cx.spawn(async move |this, cx| {
                    // Its answer as the extension gave it, whatever its status (call.ts's
                    // `res.json()`); a body that isn't JSON, or no answer, as the tool's failure,
                    // in WebKit's words.
                    let got = job.await.map_err(|_| "Load failed".to_string()).and_then(|r| r.map_err(|_| "Load failed".to_string()));
                    this.update(cx, |h, _| match got.map(|a| serde_json::from_slice::<Value>(&a.body)) {
                        Ok(Ok(answer)) => h.answer(&id, answer),
                        Ok(Err(_)) => h.answer(&id, json!({ "content": [{ "type": "text", "text": "The string did not match the expected pattern." }], "isError": true })),
                        Err(e) => h.answer(&id, json!({ "content": [{ "type": "text", "text": e }], "isError": true })),
                    })
                    .ok();
                })
                .detach();
            }
            "ui/notifications/data-model-change" => {
                let key = params.get("key").and_then(Value::as_str).unwrap_or_default().to_string();
                let sub = params.get("subpath").and_then(Value::as_str).map(str::to_string);
                self.write(&key, sub.as_deref(), params.get("value").cloned().unwrap_or(Value::Null), cx);
            }
            "ui/update-model-context" => {
                let structured = params.get("structuredContent").cloned();
                let content = params.get("content").cloned();
                if structured.is_some() || content.is_some() {
                    if self.paths.contains_key("modelContext") {
                        let value = match (&structured, &content) {
                            (Some(s), Some(c)) => json!({ "content": c, "structuredContent": s }),
                            (Some(s), None) => s.clone(),
                            (None, Some(c)) => c.clone(),
                            (None, None) => Value::Null,
                        };
                        self.write("modelContext", None, value, cx);
                    }
                    if let Some(Value::Object(o)) = structured {
                        for (k, v) in o {
                            if k != "modelContext" && self.paths.contains_key(&k) {
                                self.write(&k, None, v, cx);
                            }
                        }
                    }
                }
                self.answer(&id, json!({}));
            }
            "ui/message" => {
                let payload = json!({ "role": params.get("role").cloned().unwrap_or(Value::Null), "content": params.get("content").cloned().unwrap_or(Value::Null) });
                if let Err(why) = checked(&payload) {
                    self.reject(&id, &format!("Message payload rejected: {why}"));
                    return;
                }
                // Its message goes to its extension as the catalog's action.
                Host::press(&self.key, Pressed::Event { name: "a2ui.mcpAppMessage".into(), context: payload }, cx);
                self.answer(&id, json!({}));
            }
            "ui/requests/function-call" => {
                let call = params.get("call").and_then(Value::as_str).unwrap_or_default().to_string();
                let args = params.get("args").cloned().unwrap_or(json!({}));
                if let Err(why) = checked(&args) {
                    self.reject(&id, &format!("Function '{call}' arguments rejected: {why}"));
                    return;
                }
                let Some(schema) = self.functions.get(&call).cloned() else {
                    self.reject(&id, &format!("Function '{call}' is not allowed"));
                    return;
                };
                // Checked as the catalog's Ajv checks, strict: a keyword it doesn't know refuses the
                // call; a schema that's no object (null) holds nothing to check.
                let errors: Vec<String> = if !schema.is_object() && !schema.is_boolean() {
                    vec![]
                } else if let Err(why) = strict(&schema) {
                    vec![why]
                } else {
                    match jsonschema::validator_for(&schema) {
                        Ok(v) => v.iter_errors(&args).map(|e| e.to_string()).collect(),
                        Err(e) => vec![e.to_string()],
                    }
                };
                if !errors.is_empty() {
                    self.post(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": format!("Function '{call}' arguments failed schema validation"), "data": { "errors": errors } } }));
                    return;
                }
                // The catalog's own function, run here on what it was given; one it doesn't have
                // isn't found.
                let args = args.as_object().cloned().unwrap_or_default();
                match functions::call(&call, &args) {
                    Ok(done) => {
                        for (path, value) in done.writes {
                            let surface = self.key.clone();
                            Host::entity(cx).update(cx, |h, cx| h.write(&surface, &path, value, cx));
                        }
                        let mut answer = json!({ "status": "success" });
                        if let Some(v) = done.result {
                            answer["result"] = v;
                        }
                        self.answer(&id, answer);
                    }
                    // Not the catalog's: the surface's own catalog's, as A2UI's frame host falls back.
                    Err(_) if !functions::has(&call) && self.surface.as_ref().is_some_and(|s| s.catalog != crate::a2ui::MCP_CATALOG) => {
                        let surface = self.surface.clone().expect("checked");
                        if call == "openUrl" {
                            Host::press(&self.key, Pressed::Function { name: call.clone(), args: Value::Object(args.clone()) }, cx);
                            self.answer(&id, json!({ "status": "success" }));
                        } else if crate::a2ui::expr::BASIC_FUNCTIONS.contains(&call.as_str()) {
                            let v = crate::a2ui::expr::call(&call, &Value::Object(args.clone()), &crate::a2ui::Scope::new(surface));
                            self.answer(&id, json!({ "status": "success", "result": v }));
                        } else {
                            self.fail(&id, -32603, &format!("Function '{call}' failed: Function not found in catalog '{}': {call}", surface.catalog));
                        }
                    }
                    Err(e) => self.fail(&id, -32603, &format!("Function '{call}' failed: {e}")),
                }
            }
            "ui/request-display-mode" => self.answer(&id, json!({ "mode": "inline" })),
            "ping" => self.answer(&id, json!({})),
            // An app's log, as the catalog writes it to the console.
            "notifications/message" => {
                let level = params.get("level").and_then(Value::as_str).unwrap_or("info");
                let data = params.get("data").cloned().unwrap_or(Value::Null);
                match level {
                    "error" | "critical" | "alert" | "emergency" => log::error!("[McpApp] App log ({level}): {data}"),
                    "warning" => log::warn!("[McpApp] App log ({level}): {data}"),
                    _ => log::info!("[McpApp] App log ({level}): {data}"),
                }
            }
            _ => {
                if !id.is_null() {
                    self.fail(&id, -32601, "Method not found");
                }
            }
        }
    }
}

/// This Mac's time zone, as IANA names it.
fn iana_zone() -> String {
    std::fs::read_link("/etc/localtime")
        .ok()
        .and_then(|p| p.to_str().and_then(|s| s.split("zoneinfo/").nth(1)).map(str::to_string))
        .unwrap_or_else(|| "UTC".into())
}

/// A part of the MCP catalog drawn: McpApp.
/// Whether its `csp` and `permissions` hold only what the catalog's schema has (it's strict): the
/// four domain lists, each of words; the four permissions, each a yes or no or an object.
fn props_hold(csp: &Value, permissions: &Value) -> bool {
    let csp_ok = match csp {
        Value::Null => true,
        Value::Object(o) => o.iter().all(|(k, v)| ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"].contains(&k.as_str()) && v.as_array().is_some_and(|a| a.iter().all(Value::is_string))),
        _ => false,
    };
    let permissions_ok = match permissions {
        Value::Null => true,
        Value::Object(o) => o.iter().all(|(k, v)| ["camera", "microphone", "geolocation", "clipboardWrite"].contains(&k.as_str()) && (v.is_boolean() || v.is_object())),
        _ => false,
    };
    csp_ok && permissions_ok
}

/// A part of the MCP catalog drawn: McpApp.
pub fn draw(name: &str, c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    if name != "McpApp" {
        return None;
    }
    let csp = ctx.scope.prop(c, "csp");
    let permissions = ctx.scope.prop(c, "permissions");
    // A `csp` or `permissions` the schema doesn't have refuses the part.
    if !props_hold(&csp, &permissions) {
        return Some(div().into_any_element());
    }
    let html = decoded(&ctx.scope.words(c, "htmlContent"));
    let paths = c.pointer("/data/paths").and_then(Value::as_object).cloned().unwrap_or_default();
    // Both read through their bindings, as the element's props are.
    let allowed: Vec<String> = ctx.scope.prop(c, "allowedTools").as_array().into_iter().flatten().filter_map(|t| t.as_str().map(str::to_string)).collect();
    let functions = ctx.scope.prop(c, "allowedFunctions").as_object().cloned().unwrap_or_default();
    // The frame's title for VoiceOver: its accessibility label, else its title, else "MCP App".
    let label = ctx.scope.prop(c, "accessibility").get("label").and_then(Value::as_str).filter(|t| !t.trim().is_empty()).map(str::to_string);
    let title = label.or_else(|| Some(ctx.scope.words(c, "title")).filter(|t| !t.trim().is_empty())).unwrap_or_else(|| "MCP App".into());
    let sandbox = sandbox_of(&permissions);
    let key = ctx.surface_key();
    let host = ctx.state(c, "page", window, cx, |_, _| PageHost::new(&key));
    let surface = ctx.scope.surface.clone();
    let in_window = ctx.in_window;
    let system_dark = matches!(window.appearance(), gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark);
    let (height, width) = host.update(cx, |h, cx| {
        h.surface = Some(surface);
        h.paths = paths;
        h.allowed = allowed;
        h.functions = functions;
        h.csp = csp;
        h.sandbox = sandbox;
        h.in_window = in_window;
        h.system_dark = system_dark;
        if html.is_empty() {
            // No page to show: its frame stays, empty.
            h.clear();
        } else {
            h.show(&html, window, cx);
            if let Some(v) = &h.view {
                v.set_title(&title);
            }
            h.watch();
            h.send_context();
        }
        (h.asked.0.unwrap_or(h.opens_at), h.asked.1)
    });
    // In a widget's own window it keeps the cell's height; elsewhere what it asked for.
    let height = if in_window { DEFAULT_HEIGHT } else { height };
    let frame = div().w_full().when_some(width, |d, w| d.w(px(w)));
    // The part is as tall as it asked; its frame at most 2000 of that (A2UI's FrameSizing).
    Some(match host.read(cx).view.clone() {
        Some(view) => frame.h(px(height)).child(webview::slot(view, Some(px(height.min(MAX_FRAME_HEIGHT))))).into_any_element(),
        None => frame.h(px(height)).into_any_element(),
    })
}
