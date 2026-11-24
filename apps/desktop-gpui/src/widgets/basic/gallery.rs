//! The basic parts in the gallery (the desktop's `widgets/basic/gallery.tsx`, dev only): fixture
//! surfaces taken through the host's processor as an extension's widget is, drawn in a cell. With
//! `$SWITCH_GPUI_SHOT` set and `parts` among `$SWITCH_GPUI_PAGES`, a window shows them and is saved,
//! then driven by `$SWITCH_GPUI_STEPS` and saved as it says.

use std::time::Duration;

use gpui::{
    App, AppContext, Bounds, Context, IntoElement, ParentElement, Render, Styled, Window, WindowBounds, WindowOptions, div, point, px, size,
};
use serde_json::{Value, json};

use crate::a2ui::BASIC_CATALOG;
use crate::look::{Look, SANS};
use crate::widgets::host::Host;
use crate::widgets::render::{self, Ctx};

/// A surface of `components` in the basic catalog, its data model `data`, its root a column of them
/// (those not placed by another).
fn basic(components: Vec<Value>, data: Value) -> Vec<Value> {
    let inner: Vec<Value> = components.iter().flat_map(|c| ["child", "trigger", "content"].iter().filter_map(|k| c.get(*k).cloned()).chain(c.get("children").and_then(Value::as_array).cloned().unwrap_or_default()).chain(c.get("tabs").and_then(Value::as_array).into_iter().flatten().filter_map(|t| t.get("child").cloned()).collect::<Vec<_>>())).collect();
    let ids: Vec<Value> = components.iter().filter_map(|c| c.get("id").cloned()).filter(|id| !inner.contains(id)).collect();
    let mut all = vec![json!({ "id": "root", "component": "Column", "children": ids })];
    all.extend(components);
    vec![
        json!({ "version": "1.0", "createSurface": { "surfaceId": "fixture", "catalogId": BASIC_CATALOG } }),
        json!({ "version": "1.0", "updateComponents": { "surfaceId": "fixture", "components": all } }),
        json!({ "version": "1.0", "updateDataModel": { "surfaceId": "fixture", "path": "/", "value": data } }),
    ]
}

/// A surface of `components` in Switch's catalog, its root a column of them.
fn house(components: Vec<Value>, data: Value) -> Vec<Value> {
    let ids: Vec<Value> = components.iter().filter_map(|c| c.get("id").cloned()).collect();
    let mut all = vec![json!({ "id": "root", "component": "Column", "catalogId": BASIC_CATALOG, "children": ids })];
    all.extend(components);
    vec![
        json!({ "version": "1.0", "createSurface": { "surfaceId": "fixture", "catalogId": crate::a2ui::SWITCH_CATALOG } }),
        json!({ "version": "1.0", "updateComponents": { "surfaceId": "fixture", "components": all } }),
        json!({ "version": "1.0", "updateDataModel": { "surfaceId": "fixture", "path": "/", "value": data } }),
    ]
}

/// One part alone in Switch's catalog or the basic one, its root.
fn alone(catalog: &str, mut c: Value) -> Vec<Value> {
    c["id"] = json!("root");
    vec![
        json!({ "version": "1.0", "createSurface": { "surfaceId": "fixture", "catalogId": catalog } }),
        json!({ "version": "1.0", "updateComponents": { "surfaceId": "fixture", "components": [c] } }),
    ]
}

/// A moment of silence, as a WAV's data address.
const SILENCE: &str = "data:audio/wav;base64,UklGRkQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA";

/// A small picture, as a data address.
const DOT: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR4nGM4YaNBFcQwatCoQaMGjRo0atCoQQNvEAC6QaMfOyGMWwAAAABJRU5ErkJggg==";

/// The fixtures: a date, a time, both, and one unset.
/// A page that tries what a sandboxed page mustn't, and logs what it got (`$SWITCH_GPUI_PAGES`
/// with `sandbox`): `trick` is what comes before its document, to hide a `<head>` from a naive
/// insertion.
fn probe_page(name: &str, trick: &str) -> String {
    format!(
        r#"{trick}<!doctype html><html><head><title>t</title></head><body><script>
const say = (m) => window.parent.postMessage({{ jsonrpc: "2.0", method: "notifications/message", params: {{ level: "info", data: "{name} " + m }} }}, "*");
say("csp " + (document.querySelector('meta[http-equiv="Content-Security-Policy"]') ? "first in head: " + (document.head.firstElementChild && document.head.firstElementChild.getAttribute("http-equiv")) : "none"));
fetch("https://example.com/", {{ mode: "no-cors" }}).then(() => say("fetch went")).catch(() => say("fetch blocked"));
const i = new Image(); i.onload = () => say("image went"); i.onerror = () => say("image blocked"); i.src = "https://example.com/favicon.ico";
try {{ navigator.clipboard.writeText("x").then(() => say("clipboard written"), () => say("clipboard refused")); }} catch (e) {{ say("clipboard refused"); }}
try {{ Clipboard.prototype.writeText.call(navigator.clipboard, "y").then(() => say("prototype clipboard written"), () => say("prototype clipboard refused")); }} catch (e) {{ say("prototype clipboard refused"); }}
try {{ const f = document.createElement("iframe"); document.body.appendChild(f); f.contentWindow.navigator.clipboard.writeText("z").then(() => say("frame clipboard written"), () => say("frame clipboard refused")); }} catch (e) {{ say("frame clipboard refused: " + e.name); }}
try {{ localStorage.setItem("k", "v"); say("storage " + localStorage.getItem("k")); }} catch (e) {{ say("storage refused"); }}
say("origin " + location.origin);
setTimeout(() => {{ say("navigating"); location.href = "https://example.com/"; }}, 300);
setTimeout(() => say("still here"), 1500);
</script></body></html>"#
    )
}

fn sandbox_fixtures() -> Vec<(&'static str, Vec<Value>)> {
    let tricks = [("comment", "<!--<head>-->"), ("title", "<title><head></title>"), ("script", "<script>var s = '<head>';</script>"), ("attribute", "<div data-x=\"<head>\"></div>"), ("plain", "")];
    tricks
        .iter()
        .map(|(name, trick)| {
            let surface = vec![
                json!({ "version": "1.0", "createSurface": { "surfaceId": "fixture", "catalogId": crate::a2ui::MCP_CATALOG } }),
                json!({ "version": "1.0", "updateComponents": { "surfaceId": "fixture", "components": [{ "id": "root", "component": "McpApp", "htmlContent": probe_page(name, trick) }] } }),
            ];
            (*name, surface)
        })
        .chain(std::iter::once((
            "allowed",
            vec![
                json!({ "version": "1.0", "createSurface": { "surfaceId": "fixture", "catalogId": crate::a2ui::MCP_CATALOG } }),
                json!({ "version": "1.0", "updateComponents": { "surfaceId": "fixture", "components": [{ "id": "root", "component": "McpApp", "csp": { "connectDomains": ["https://example.com"], "resourceDomains": ["https://example.com"] }, "htmlContent": probe_page("allowed", "") }] } }),
            ],
        )))
        .collect()
}

/// A page that tries the bridge (`$SWITCH_GPUI_PAGES` with `bridge`) and logs what it got: the
/// version it's answered, the catalog's functions and one it hasn't, its own write and one made for
/// it, the sizes it asks for, a tool call.
const BRIDGE_PROBE: &str = r#"<!doctype html><html><body><script>
let n = 0; const wait = {};
const send = (method, params) => new Promise((r) => { const id = ++n; wait[id] = r; parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*"); });
const note = (method, params) => parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
const say = (m) => note("notifications/message", { level: "info", data: "bridge " + m });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
window.addEventListener("message", (e) => { const m = e.data; if (m && m.id && wait[m.id]) { wait[m.id](m); delete wait[m.id]; } else if (m && m.method) { say("heard " + m.method + " " + JSON.stringify(m.params)); } });
(async () => {
  const init = await send("ui/initialize", { protocolVersion: "1999-01-01", appInfo: { name: "probe", version: "1" }, appCapabilities: {} });
  say("initialize " + init.result.protocolVersion + " theme " + init.result.hostContext.theme + " locale " + init.result.hostContext.locale);
  note("ui/notifications/initialized", {});
  await pause(500);
  const calls = [["split", { value: "a,b", separator: "," }], ["split", { value: ["ab", 7], separator: "" }], ["regexCapture", { value: "x=12", pattern: "(\\w)=(\\d+)(z)?" }], ["regexCapture", { value: "a", pattern: "a(?=b)" }], ["regexCapture", { value: "a", pattern: "(a+)+$" }], ["transformData", { jmespath: "items[?n > `1`].n", data: { items: [{ n: 1 }, { n: 2 }, { n: 3 }] } }], ["transformData", { jmespath: "items[", data: {} }], ["callMcpTool", { name: "t" }], ["openUrl", { url: "https://example.com" }], ["split", { value: "a" }]];
  for (const [call, args] of calls) { const r = await send("ui/requests/function-call", { call, args }); say(call + " " + JSON.stringify(r.result || r.error)); }
  note("ui/notifications/data-model-change", { key: "v", subpath: "/a", value: 2 });
  await pause(500);
  say("own write done");
  const u = await send("ui/requests/function-call", { call: "updateDataModel", args: { updates: { "/v": { a: 3, b: 4 } } } });
  say("updateDataModel " + JSON.stringify(u.result || u.error));
  await pause(800);
  note("ui/notifications/size-changed", { height: 2500 }); await pause(800); say("height " + innerHeight);
  note("ui/notifications/size-changed", { height: 40 }); await pause(800); say("height " + innerHeight);
  const t = await send("tools/call", { name: "x_y", arguments: {} }); say("tools/call " + JSON.stringify(t.result || t.error));
})();
</script></body></html>"#;

/// A page that keeps trying to take the keys and says each key it hears, and tries WebRTC out to
/// this Mac's 3478 (STUN over UDP) and 3479 (TURN over TCP) (`$SWITCH_GPUI_PAGES` with `keys`).
const KEYS_PROBE: &str = r#"<!doctype html><html><body style="margin:0"><input id=i style="width:300px;height:200px"><script>
const say = (m) => parent.postMessage({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "keys " + m } }, "*");
const i = document.getElementById("i");
setInterval(() => i.focus(), 100);
document.addEventListener("keydown", (e) => say("heard " + e.key), true);
say("RTCPeerConnection " + typeof RTCPeerConnection);
try {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:3478" }, { urls: "turn:127.0.0.1:3479?transport=tcp", username: "u", credential: "p" }] });
  pc.createDataChannel("d");
  pc.onicecandidate = (e) => say("candidate " + (e.candidate ? e.candidate.type : "done"));
  pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => say("offer set"), (e) => say("offer failed " + e));
} catch (e) { say("peer connection refused: " + e.name); }
</script></body></html>"#;

/// A page with a frame from its `frameDomains` and one from elsewhere, a link to a new window, and
/// what its granted clipboard leaves it (`$SWITCH_GPUI_PAGES` with `web`).
const WEB_PROBE: &str = r#"<!doctype html><html><body style="margin:0"><a id=b href="http://127.0.0.1:3479/blank" target="_blank" style="display:block;width:300px;height:100px;background:#345">blank</a><iframe src="http://127.0.0.1:3479/frame" style="width:100px;height:40px"></iframe><iframe src="http://localhost:3479/elsewhere" style="width:100px;height:40px"></iframe><script>
const say = (m) => parent.postMessage({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "web " + m } }, "*");
say("secure " + isSecureContext + ", subtle " + typeof (crypto && crypto.subtle) + ", media " + typeof (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) + ", clipboard " + typeof (navigator.clipboard && navigator.clipboard.writeText));
</script></body></html>"#;

/// The keys probe, as an app's page, or inside a sandboxed frame as the desktop's are
/// (`framed-keys`).
fn keys_fixtures() -> Vec<(&'static str, Vec<Value>)> {
    let framed = format!("<!doctype html><html><body style=\"margin:0\"><iframe sandbox=\"allow-scripts\" style=\"border:0;width:340px;height:330px\" srcdoc=\"{}\"></iframe><script>window.addEventListener('message',(e)=>{{if(e.source!==window)parent.postMessage(e.data,'*')}})</script></body></html>", KEYS_PROBE.replace('&', "&amp;").replace('"', "&quot;"));
    let app = |html: &str| {
        vec![
            json!({ "version": "1.0", "createSurface": { "surfaceId": "fixture", "catalogId": crate::a2ui::MCP_CATALOG } }),
            json!({ "version": "1.0", "updateComponents": { "surfaceId": "fixture", "components": [{ "id": "root", "component": "McpApp", "htmlContent": html }] } }),
        ]
    };
    let pages = std::env::var("SWITCH_GPUI_PAGES").unwrap_or_default();
    if pages.split(',').any(|p| p == "web") {
        let mut m = app(WEB_PROBE);
        m[1]["updateComponents"]["components"][0]["csp"] = json!({ "frameDomains": ["http://127.0.0.1:3479"] });
        m[1]["updateComponents"]["components"][0]["permissions"] = json!({ "clipboardWrite": true });
        return vec![("web", m)];
    }
    if pages.split(',').any(|p| p == "framed-keys") { vec![("keys", app(&framed))] } else { vec![("keys", app(KEYS_PROBE))] }
}

/// What has the window's keys, by its class: a page's web view or gpui's own view.
fn keys_holder(window: &Window) -> String {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let Ok(h) = HasWindowHandle::window_handle(window) else { return "?".into() };
    let RawWindowHandle::AppKit(h) = h.as_raw() else { return "?".into() };
    let view: &objc2_app_kit::NSView = unsafe { h.ns_view.cast().as_ref() };
    view.window().and_then(|w| w.firstResponder()).map(|r| r.class().name().to_string_lossy().into_owned()).unwrap_or_default()
}

/// A real key, or a click at `at` (gpui's points), put in AppKit's queue as a person's would be.
fn send_native(window: &Window, key: Option<&str>, at: (f64, f64)) {
    use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let Ok(h) = HasWindowHandle::window_handle(window) else { return };
    let RawWindowHandle::AppKit(h) = h.as_raw() else { return };
    let view: &objc2_app_kit::NSView = unsafe { h.ns_view.cast().as_ref() };
    let Some(w) = view.window() else { return };
    let p = objc2_foundation::NSPoint::new(at.0, view.bounds().size.height - at.1);
    let n = w.windowNumber();
    let app = objc2_app_kit::NSApplication::sharedApplication(objc2::MainThreadMarker::new().expect("main thread"));
    match key {
        Some(k) => {
            let k = objc2_foundation::NSString::from_str(k);
            for t in [NSEventType::KeyDown, NSEventType::KeyUp] {
                let none: Option<&objc2::runtime::AnyObject> = None;
                let e: Option<objc2::rc::Retained<NSEvent>> = unsafe { objc2::msg_send![<NSEvent as objc2::ClassType>::class(), keyEventWithType: t, location: p, modifierFlags: NSEventModifierFlags::empty(), timestamp: 0f64, windowNumber: n, context: none, characters: &*k, charactersIgnoringModifiers: &*k, isARepeat: false, keyCode: 0u16] };
                if let Some(e) = e {
                    app.postEvent_atStart(&e, false);
                }
            }
        }
        None => {
            for t in [NSEventType::LeftMouseDown, NSEventType::LeftMouseUp] {
                let none: Option<&objc2::runtime::AnyObject> = None;
                let e: Option<objc2::rc::Retained<NSEvent>> = unsafe { objc2::msg_send![<NSEvent as objc2::ClassType>::class(), mouseEventWithType: t, location: p, modifierFlags: NSEventModifierFlags::empty(), timestamp: 0f64, windowNumber: n, context: none, eventNumber: 0isize, clickCount: 1isize, pressure: 1f32] };
                if let Some(e) = e {
                    app.postEvent_atStart(&e, false);
                }
            }
        }
    }
}

fn bridge_fixtures() -> Vec<(&'static str, Vec<Value>)> {
    let app = |extra: Value| {
        let mut c = json!({ "id": "root", "component": "McpApp", "htmlContent": BRIDGE_PROBE, "allowedTools": ["x_y"], "data": { "paths": { "v": "/v" } }, "allowedFunctions": { "split": null, "regexCapture": null, "transformData": null, "callMcpTool": null, "updateDataModel": null, "openUrl": null } });
        if let (Some(c), Some(e)) = (c.as_object_mut(), extra.as_object()) {
            c.extend(e.clone());
        }
        vec![
            json!({ "version": "1.0", "createSurface": { "surfaceId": "fixture", "catalogId": crate::a2ui::MCP_CATALOG } }),
            json!({ "version": "1.0", "updateComponents": { "surfaceId": "fixture", "components": [c] } }),
            json!({ "version": "1.0", "updateDataModel": { "surfaceId": "fixture", "path": "/", "value": { "v": { "a": 1 } } } }),
        ]
    };
    vec![("strict", app(json!({ "csp": { "scriptDomains": ["https://example.com"] } }))), ("empty", app(json!({ "htmlContent": "" }))), ("bridge", app(json!({})))]
}

fn fixtures() -> Vec<(&'static str, Vec<Value>)> {
    if std::env::var("SWITCH_GPUI_PAGES").unwrap_or_default().split(',').any(|p| p == "sandbox") {
        return sandbox_fixtures();
    }
    if std::env::var("SWITCH_GPUI_PAGES").unwrap_or_default().split(',').any(|p| p == "bridge") {
        return bridge_fixtures();
    }
    if std::env::var("SWITCH_GPUI_PAGES").unwrap_or_default().split(',').any(|p| p == "keys" || p == "framed-keys" || p == "web") {
        return keys_fixtures();
    }
    let sw = crate::a2ui::SWITCH_CATALOG;
    vec![
        (
            "more",
            basic(
                vec![
                    json!({ "id": "tabs", "component": "Tabs", "tabs": [{ "title": "One", "child": "one" }, { "title": "Two", "child": "two" }] }),
                    json!({ "id": "one", "component": "Text", "text": "First tab" }),
                    json!({ "id": "two", "component": "Text", "text": "Second tab" }),
                    json!({ "id": "st", "component": "Slider", "label": "Steps", "min": 0, "max": 100, "steps": 4, "value": { "@path": "/s" } }),
                    json!({ "id": "due", "component": "DateTimeInput", "label": "Due", "min": { "@path": "/min" }, "value": { "@path": "/d" } }),
                    json!({ "id": "lit", "component": "Button", "child": "litt", "action": { "name": "lit", "context": { "p": { "path": "/x" }, "here": { "@path": "." } } } }),
                    json!({ "id": "litt", "component": "Text", "text": "Literal" }),
                    json!({ "id": "chk", "component": "TextField", "label": "Code", "value": { "@path": "/code" }, "checks": [
                        { "condition": { "@call": "numeric", "args": { "value": { "@path": "/empty" } } } },
                        { "condition": { "@call": "regex", "args": { "value": { "@path": "/code" }, "pattern": "^(?=.*\\d).+$" } } },
                    ] }),
                    json!({ "id": "au", "component": "AudioPlayer", "url": SILENCE }),
                ],
                json!({ "s": 0, "min": "2026-11-01", "d": "2026-11-10", "x": 1, "code": "abc", "empty": "" }),
            ),
        ),
        ("entry2", house(vec![json!({ "id": "e", "component": "Entry", "placeholder": { "@path": "/ph" }, "action": "add", "field": "text" })], json!({ "ph": "First" }))),
        // What a cell with nothing to show is: each alone, its root.
        ("empty-row", alone(sw, json!({ "component": "Row", "label": "" }))),
        ("row", alone(sw, json!({ "component": "Row", "label": "Printer", "detail": "idle" }))),
        ("entry", alone(sw, json!({ "component": "Entry", "placeholder": "Add", "action": "add", "field": "text" }))),
        ("divider", alone(BASIC_CATALOG, json!({ "component": "Divider" }))),
        ("ftp-image", alone(BASIC_CATALOG, json!({ "component": "Image", "url": "ftp://example.com/a.png" }))),
        ("js-image", alone(BASIC_CATALOG, json!({ "component": "Image", "url": "javascript:alert(1)" }))),
        ("data-image", alone(BASIC_CATALOG, json!({ "component": "Image", "url": DOT }))),
        ("feed", alone(sw, json!({ "component": "Feed", "action": "camera" }))),
        ("unlabelled-date", alone(BASIC_CATALOG, json!({ "component": "DateTimeInput" }))),
        ("caption", alone(BASIC_CATALOG, json!({ "component": "Text", "text": "Nothing", "variant": "caption" }))),
        ("unknown-icon", alone(BASIC_CATALOG, json!({ "component": "Icon", "name": "nope" }))),
        ("icon", alone(BASIC_CATALOG, json!({ "component": "Icon", "name": "check" }))),
        // createSurface carrying its components and data model.
        (
            "made-whole",
            vec![json!({ "version": "1.0", "createSurface": { "surfaceId": "fixture", "catalogId": BASIC_CATALOG, "dataModel": { "said": "From createSurface" }, "components": [{ "id": "root", "component": "Text", "text": { "@path": "/said" } }] } })],
        ),
        (
            "pick",
            house(
                vec![
                    json!({ "id": "p", "component": "Pick", "title": "AMS 1", "label": "PLA green", "swatch": "00AA00", "action": "set", "current": { "color": "00AA00", "kind": "PLA" }, "groups": [
                        { "key": "color", "choices": ["FF0000", "00AA00", "0000FF", "111111"], "swatches": true, "custom": true },
                        { "key": "kind", "choices": ["PLA", "PETG", "TPU"] },
                    ] }),
                    json!({ "id": "k", "component": "Check", "label": "Water the plants", "action": "tick" }),
                    json!({ "id": "r", "component": "Row", "label": "Order 1042", "detail": "jam", "note": "Filament jam at the extruder", "url": "https://example.com/" }),
                    json!({ "id": "g", "component": "Gallery", "images": [{ "url": DOT, "description": "dot one" }, { "url": DOT }, { "url": DOT, "description": 3 }] }),
                ],
                json!({}),
            ),
        ),
        (
            "controls",
            basic(
                vec![
                    json!({ "id": "cb", "component": "CheckBox", "label": "Agree", "value": { "@path": "/agree" } }),
                    json!({ "id": "one", "component": "ChoicePicker", "label": "Size", "options": [{ "label": "Small", "value": "s" }, { "label": "Large", "value": "l" }], "value": { "@path": "/size" } }),
                    json!({ "id": "many", "component": "ChoicePicker", "variant": "multipleSelection", "options": [{ "label": "Red", "value": "r" }, { "label": "Blue", "value": "b" }], "value": { "@path": "/colors" } }),
                    json!({ "id": "chips", "component": "ChoicePicker", "displayStyle": "chips", "options": [{ "label": "A", "value": "a" }, { "label": "B", "value": "b" }], "value": { "@path": "/chip" } }),
                    json!({ "id": "sl", "component": "Slider", "label": "Volume", "min": 0, "max": 10, "value": { "@path": "/vol" } }),
                    json!({ "id": "m", "component": "Modal", "trigger": "mt", "content": "mc" }),
                    json!({ "id": "mt", "component": "Text", "text": "Open the modal" }),
                    json!({ "id": "mc", "component": "Column", "children": ["mx", "mb"] }),
                    json!({ "id": "mx", "component": "Text", "text": "Inside" }),
                    json!({ "id": "mb", "component": "Button", "child": "mbt", "action": { "name": "inModal" } }),
                    json!({ "id": "mbt", "component": "Text", "text": "Act" }),
                ],
                json!({ "agree": false, "size": ["s"], "colors": [], "chip": [], "vol": 3 }),
            ),
        ),
        (
            "actions",
            basic(
                vec![
                    json!({ "id": "a1", "component": "Button", "child": "t1", "action": { "name": "flat", "context": { "x": { "@path": "/x" } } } }),
                    json!({ "id": "t1", "component": "Text", "text": "Flat" }),
                    json!({ "id": "a2", "component": "Button", "child": "t2", "action": { "event": { "name": "" } } }),
                    json!({ "id": "t2", "component": "Text", "text": "No name" }),
                    json!({ "id": "a3", "component": "Button", "child": "t3", "action": { "@call": "formatString", "args": { "value": "x" } } }),
                    json!({ "id": "t3", "component": "Text", "text": "Call" }),
                    json!({ "id": "a4", "component": "Button", "child": "t4", "action": { "event": { "name": "warned" } }, "checks": [{ "condition": { "@call": "required", "args": { "value": "" } }, "message": "Own message" }, { "condition": { "@path": "/warn" } }] }),
                    json!({ "id": "t4", "component": "Text", "text": "Checked" }),
                    json!({ "id": "tf", "component": "TextField", "label": "Name", "value": { "@path": "/name" }, "checks": [{ "condition": { "@call": "required", "args": { "value": { "@path": "/name" } } } }, { "condition": { "@path": "/finding" }, "message": "Fallback" }, { "condition": false }] }),
                ],
                json!({ "x": 7, "warn": { "valid": false, "message": "Only a warning", "severity": "warning" }, "finding": { "valid": false, "message": "The finding's own" }, "name": "" }),
            ),
        ),
        (
        "dates",
        basic(
            vec![
                json!({ "id": "a", "component": "DateTimeInput", "label": "Due", "value": { "@path": "/due" }, "min": "2026-11-02", "max": "2026-12-20" }),
                json!({ "id": "b", "component": "DateTimeInput", "label": "At", "enableTime": true, "value": { "@path": "/at" } }),
                json!({ "id": "c", "component": "DateTimeInput", "label": "Starts", "enableDate": true, "enableTime": true, "value": { "@path": "/starts" } }),
                json!({ "id": "d", "component": "DateTimeInput", "label": "Ends", "value": { "@path": "/ends" } }),
            ],
            json!({ "due": "2026-11-24", "at": "14:30", "starts": "2026-11-24T09:00:00", "ends": "" }),
        ),
        ),
    ]
}

struct Parts;

thread_local! {
    /// Whether each fixture had nothing to show as last drawn.
    static NOTHING: std::cell::RefCell<std::collections::BTreeMap<String, bool>> = Default::default();
}

impl Render for Parts {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        crate::webview::start_frame(window, cx);
        let l = Look::get(cx);
        let host = Host::entity(cx);
        let cells: Vec<_> = fixtures()
            .into_iter()
            .map(|(name, messages)| {
                let key = format!("parts/{name}");
                let surface = host.update(cx, |h, _| h.surface(&key).unwrap_or_else(|| h.hold(&key, &messages)));
                let ctx = Ctx::new(&key, surface, l);
                let hidden = render::nothing(&ctx, window, cx);
                NOTHING.with(|n| {
                    let mut n = n.borrow_mut();
                    n.entry(format!("{name} first")).or_insert(hidden);
                    n.insert(name.to_string(), hidden);
                });
                div().w(px(300.)).border(px(l.w1)).border_color(l.line1).child(div().px(px(4.)).text_size(px(10.)).text_color(l.ink3).child(format!("{name}{}", if hidden { " (nothing)" } else { "" }))).child(render::surface(&ctx, window, cx))
            })
            .collect();
        div().size_full().bg(l.bg).text_color(l.ink).font_family(SANS).p(px(12.)).flex().flex_wrap().items_start().gap(px(12.)).children(cells)
    }
}

pub fn shot(cx: &mut App) {
    let Ok(dir) = std::env::var("SWITCH_GPUI_SHOT") else { return };
    if !std::env::var("SWITCH_GPUI_PAGES").unwrap_or_default().split(',').any(|p| p == "parts" || p == "sandbox" || p == "framed" || p == "copy" || p == "bridge" || p == "keys" || p == "framed-keys" || p == "web") {
        return;
    }
    let bounds = Bounds::centered(None, size(px(1280.), px(900.)), cx);
    let Ok(window) = cx.open_window(WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() }, |_, cx| cx.new(|_| Parts)) else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    cx.spawn(async move |cx| {
        let save = |cx: &mut gpui::AsyncApp, n: &str| {
            if let Ok(Ok(img)) = cx.update_window(window.into(), |_, window, _| window.render_to_image()) {
                let path = format!("{dir}/parts-{n}.png");
                let _ = img.save(&path);
                eprintln!("shot: {path}");
            }
        };
        // In front, so it draws frames (a covered window gets none, and a popup shows on its second).
        let _ = cx.update_window(window.into(), |_, window, cx| {
            cx.activate(true);
            window.activate_window();
        });
        // With `framed` among the pages: a page in the portal's sandboxed frame says what it can reach.
        if std::env::var("SWITCH_GPUI_PAGES").unwrap_or_default().split(',').any(|p| p == "framed") {
            let probe = "<script>const say=(m)=>parent.postMessage({framed:m},'*');say('origin '+location.origin);try{document.cookie='a=1';say('cookie '+document.cookie)}catch(e){say('cookie refused')}try{localStorage.setItem('k','v');say('storage '+localStorage.getItem('k'))}catch(e){say('storage refused')}fetch(location.href).then(()=>say('fetch went'),()=>say('fetch refused'));setTimeout(()=>{say('navigating');top.location.href='https://example.com/'},300);setTimeout(()=>say('still here'),1500)</script>";
            let probe = format!("data:text/html,{}", crate::widgets::host::urlencode(probe));
            let probe = probe.as_str();
            let _ = cx.update_window(window.into(), |_, window, cx| {
                if let Some(v) = crate::webview::WebView::new(window, crate::webview::Source::Framed(probe), &[], cx) {
                    if let Some(mut inbox) = v.messages() {
                        cx.spawn(async move |_| {
                            use futures::StreamExt;
                            while let Some(m) = inbox.next().await {
                                log::info!("framed probe: {m}");
                            }
                        })
                        .detach();
                    }
                    std::mem::forget(v);
                }
            });
        }
        // With `copy` among the pages: words selected in a sandboxed page, Edit ▸ Copy sent to it.
        if std::env::var("SWITCH_GPUI_PAGES").unwrap_or_default().split(',').any(|p| p == "copy") {
            let html = "<!doctype html><html><body><p id=w>copied from a page</p><script>const say=(m)=>parent.postMessage({copy:m},'*');document.addEventListener('copy',(e)=>setTimeout(()=>say('copy event, cancelled '+e.defaultPrevented),0));const r=document.createRange();r.selectNodeContents(document.getElementById('w'));getSelection().removeAllRanges();getSelection().addRange(r);say('selected '+getSelection().toString())</script></body></html>";
            let page = cx.update_window(window.into(), |_, window, cx| {
                let v = crate::webview::WebView::new(window, crate::webview::Source::Sandboxed { html, sandbox: Default::default(), allowed: &[] }, &[], cx)?;
                if let Some(mut inbox) = v.messages() {
                    cx.spawn(async move |_| {
                        use futures::StreamExt;
                        while let Some(m) = inbox.next().await {
                            log::info!("copy probe: {m}");
                        }
                    })
                    .detach();
                }
                Some(v)
            });
            if let Ok(Some(v)) = page {
                cx.background_executor().timer(Duration::from_millis(1500)).await;
                let _ = cx.update(|_| v.copy());
                log::info!("copy probe: copy sent");
                std::mem::forget(v);
            }
        }
        // With `keys`: a key with the app's keys, a click into the page and a key, a click on the
        // app and a key; what holds the keys each time.
        if std::env::var("SWITCH_GPUI_PAGES").unwrap_or_default().split(',').any(|p| p == "keys" || p == "framed-keys") {
            cx.background_executor().timer(Duration::from_millis(3000)).await;
            for (step, click, key) in [("untouched", None, "a"), ("clicked into the page", Some((120., 100.)), "b"), ("clicked on the app", Some((800., 600.)), "c")] {
                let _ = cx.update_window(window.into(), |_, window, _| {
                    if let Some(at) = click {
                        send_native(window, None, at);
                    }
                });
                cx.background_executor().timer(Duration::from_millis(300)).await;
                let _ = cx.update_window(window.into(), |_, window, _| {
                    log::info!("keys probe: {step}: the keys are {}'s", keys_holder(window));
                    send_native(window, Some(key), (0., 0.));
                });
                cx.background_executor().timer(Duration::from_millis(1000)).await;
            }
        }
        // With `web`: a click on its link to a new window.
        if std::env::var("SWITCH_GPUI_PAGES").unwrap_or_default().split(',').any(|p| p == "web") {
            cx.background_executor().timer(Duration::from_millis(3000)).await;
            let _ = cx.update_window(window.into(), |_, window, _| send_native(window, None, (120., 60.)));
            log::info!("web probe: clicked the link");
        }
        cx.background_executor().timer(Duration::from_millis(1500)).await;
        // `$SWITCH_GPUI_STEPS`: what's done to it, in turn (`click:x,y`, `key:tab`, `type:words`,
        // `wait:ms`, `shot:name`, `log`: each fixture's data model and whether it has nothing to show).
        log::debug!("widget_set_r3_marker");
        let steps = std::env::var("SWITCH_GPUI_STEPS").unwrap_or_else(|_| "shot:00".into());
        for step in steps.split(';').filter(|s| !s.is_empty()) {
            let (verb, arg) = step.split_once(':').unwrap_or((step, ""));
            match verb {
                "shot" => {
                    let _ = cx.update_window(window.into(), |_, window, _| window.refresh());
                    cx.background_executor().timer(Duration::from_millis(400)).await;
                    save(cx, arg);
                }
                "wait" => cx.background_executor().timer(Duration::from_millis(arg.parse().unwrap_or(500))).await,
                "click" => {
                    let xy: Vec<f32> = arg.split(',').filter_map(|x| x.trim().parse().ok()).collect();
                    if let [x, y] = xy[..] {
                        let at = point(px(x), px(y));
                        let _ = cx.update_window(window.into(), |_, window, cx| {
                            window.dispatch_event(gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent { position: at, pressed_button: None, modifiers: Default::default() }), cx);
                            let down = gpui::MouseDownEvent { button: gpui::MouseButton::Left, position: at, modifiers: Default::default(), click_count: 1, first_mouse: false };
                            window.dispatch_event(gpui::PlatformInput::MouseDown(down), cx);
                            let up = gpui::MouseUpEvent { button: gpui::MouseButton::Left, position: at, modifiers: Default::default(), click_count: 1 };
                            window.dispatch_event(gpui::PlatformInput::MouseUp(up), cx);
                        });
                    }
                }
                "hover" => {
                    let xy: Vec<f32> = arg.split(',').filter_map(|x| x.trim().parse().ok()).collect();
                    if let [x, y] = xy[..] {
                        let _ = cx.update_window(window.into(), |_, window, cx| {
                            window.dispatch_event(gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent { position: point(px(x), px(y)), pressed_button: None, modifiers: Default::default() }), cx);
                        });
                    }
                }
                "key" => {
                    let k = gpui::Keystroke::parse(Box::leak(arg.to_string().into_boxed_str())).ok();
                    if let Some(k) = k {
                        // A key, as AppKit sends one: its down and up, no words typed (Tab's is a
                        // command, `insertTab:`, not text).
                        let _ = cx.update_window(window.into(), |_, window, cx| {
                            window.dispatch_event(gpui::PlatformInput::KeyDown(gpui::KeyDownEvent { keystroke: k.clone(), is_held: false, prefer_character_input: false }), cx);
                            window.dispatch_event(gpui::PlatformInput::KeyUp(gpui::KeyUpEvent { keystroke: k }), cx);
                        });
                    }
                }
                "type" => {
                    for ch in arg.chars() {
                        let k = gpui::Keystroke::parse(Box::leak(ch.to_string().into_boxed_str())).ok();
                        if let Some(k) = k {
                            let _ = cx.update_window(window.into(), |_, window, cx| window.dispatch_keystroke(k, cx));
                        }
                    }
                }
                // AppKit asks the window for its accessibility (as VoiceOver would), so gpui builds
                // its tree; `ax:name` saves it.
                "a11y" => {
                    let _ = cx.update_window(window.into(), |_, window, _| {
                        if let Some(w) = crate::platform::appkit::ns_window(window)
                            && let Some(v) = w.contentView()
                        {
                            // SAFETY: the window's live content view, on the main thread.
                            let _: *mut objc2::runtime::AnyObject = unsafe { objc2::msg_send![&*v, accessibilityChildren] };
                        }
                        window.refresh();
                    });
                }
                "ax" => {
                    let _ = cx.update_window(window.into(), |_, window, _| {
                        let tree = window.debug_a11y_tree_json().unwrap_or_default();
                        let _ = std::fs::write(format!("{dir}/ax-{arg}.json"), tree);
                    });
                }
                // `set:fixture,/path,json`: the model changed under it, as an extension's new data.
                "set" => {
                    let mut parts = arg.splitn(3, ',');
                    if let (Some(f), Some(path), Some(v)) = (parts.next(), parts.next(), parts.next())
                        && let Ok(v) = serde_json::from_str::<Value>(v)
                    {
                        let key = format!("parts/{f}");
                        let (path, v) = (path.to_string(), v.clone());
                        let _ = cx.update(|cx| Host::entity(cx).update(cx, |h, cx| h.write(&key, &path, v, cx)));
                    }
                }
                "log" => {
                    let _ = cx.update(|cx| {
                        let host = Host::entity(cx).read(cx);
                        for (name, _) in fixtures() {
                            if let Some(s) = host.surface(&format!("parts/{name}")) {
                                eprintln!("data {name}: {}", s.data);
                            }
                        }
                    });
                }
                _ => {}
            }
            cx.background_executor().timer(Duration::from_millis(150)).await;
        }
        NOTHING.with(|n| {
            for (name, hidden) in n.borrow().iter() {
                eprintln!("nothing {name}: {hidden}");
            }
        });
    })
    .detach();
}
