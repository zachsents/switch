//! Web content in the window: a page (an extension's MCP App, a page the agent made, an ask's live
//! view) in a WKWebView laid over the gpui window where its element is. A clip view the size of
//! the element's clip (a chat's list, the widget column) holds it, so it's cut at their edges; each
//! frame the element's prepaint says where it is, and a frame it isn't drawn leaves it hidden.
//!
//! Two things the spike found are fixed here. AppKit commits a view's frame at once, while gpui's
//! Metal frame shows a vsync later, so the page led the chat by a frame while scrolling (about 16 px
//! at speed): where each page goes is worked out in a frame's prepaint and put on the view as the
//! next frame starts, the vsync gpui's frame shows on. And WKWebView took the wheel, so the page
//! scrolled nothing: a page laid at its own height has nothing to scroll up and down, so the wheel's
//! up and down go on to the window (the list under it), across stays the page's.
//!
//! The page talks to its host as a frame talks to its parent: `window.parent.postMessage` reaches
//! the host (`WebView::take`), and the host's answers arrive as `message` events from that parent.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use gpui::{AnyElement, App, Bounds, Global, IntoElement, ParentElement, Pixels, Styled, Window, canvas, div, prelude::*, px};
use objc2::rc::Retained;
use objc2::runtime::{NSObject, ProtocolObject};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_app_kit::{NSEvent, NSResponder, NSView};
use objc2_foundation::{NSNumber, NSObjectNSKeyValueCoding, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL, ns_string};
use objc2_web_kit::{
    WKContentRuleList, WKContentRuleListStore, WKWebsiteDataStore,
    WKFrameInfo, WKMediaCaptureType, WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKPermissionDecision, WKSecurityOrigin, WKUIDelegate,
    WKScriptMessage, WKScriptMessageHandler, WKUserContentController, WKUserScript, WKUserScriptInjectionTime, WKWebView, WKWebViewConfiguration,
};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

/// The name the page's messages come under.
const BRIDGE: &str = "switchHost";

pub struct WebIvars {
    /// The wheel's up and down go on to the window.
    forward_wheel: Cell<bool>,
    /// The pointer is over a region of the page that scrolls up and down itself: it takes the wheel.
    inner: Rc<Cell<bool>>,
    /// Clicks go through to the window under it (a picture that's a key).
    passthrough: Cell<bool>,
    /// Where something small drawn over it (Latest, a scroll thumb) cuts it away, in its clip's points:
    /// clicks there go to the window.
    holes: RefCell<Vec<NSRect>>,
    /// The app hands it the keys itself (a live screen opened, Copy sent): it may take them then.
    granted: Cell<bool>,
}

define_class!(
    // A WKWebView that hands the wheel's up and down to the window, and can let clicks through.
    #[unsafe(super(WKWebView, NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "SwitchGpuiWebView"]
    #[ivars = WebIvars]
    pub struct Web;

    impl Web {
        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, event: &NSEvent) {
            let (dx, dy) = (event.scrollingDeltaX(), event.scrollingDeltaY());
            if self.ivars().forward_wheel.get() && !self.ivars().inner.get() && dy.abs() >= dx.abs() {
                if let Some(next) = unsafe { self.nextResponder() } {
                    next.scrollWheel(event);
                    return;
                }
            }
            unsafe {
                let _: () = msg_send![super(self), scrollWheel: event];
            }
        }

        // The keys are the page's only when the user clicks into it (or the app hands them over):
        // a page's own `focus()` can't take them from the app's field.
        #[unsafe(method(becomeFirstResponder))]
        fn become_first_responder(&self) -> bool {
            let mtm = self.mtm();
            let clicked = objc2_app_kit::NSApplication::sharedApplication(mtm).currentEvent().is_some_and(|e| {
                use objc2_app_kit::NSEventType as T;
                let down = matches!(e.r#type(), T::LeftMouseDown | T::RightMouseDown | T::OtherMouseDown);
                let here = self.window().is_some_and(|w| e.windowNumber() == w.windowNumber());
                let p = self.convertPoint_fromView(e.locationInWindow(), None);
                let b = self.bounds();
                down && here && p.x >= 0. && p.y >= 0. && p.x < b.size.width && p.y < b.size.height
            });
            (clicked || self.ivars().granted.get()) && unsafe { msg_send![super(self), becomeFirstResponder] }
        }

        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            if self.ivars().passthrough.get() || self.ivars().holes.borrow().iter().any(|h| point.x >= h.origin.x && point.x < h.origin.x + h.size.width && point.y >= h.origin.y && point.y < h.origin.y + h.size.height) {
                return std::ptr::null_mut();
            }
            unsafe { msg_send![super(self), hitTest: point] }
        }
    }
);

pub struct BridgeIvars {
    tx: UnboundedSender<String>,
    inner: Rc<Cell<bool>>,
}

define_class!(
    // Hears what the page posts to its parent.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "SwitchGpuiWebBridge"]
    #[ivars = BridgeIvars]
    pub struct Bridge;

    unsafe impl NSObjectProtocol for Bridge {}

    unsafe impl WKScriptMessageHandler for Bridge {
        #[unsafe(method(userContentController:didReceiveScriptMessage:))]
        fn did_receive(&self, _controller: &WKUserContentController, message: &WKScriptMessage) {
            let body = unsafe { message.body() };
            if let Ok(text) = body.downcast::<NSString>() {
                let text = text.to_string();
                // Whether what's under the pointer scrolls itself: the view's to know, not the host's.
                if let Some(rest) = text.strip_prefix(r#"{"__switchScroll":"#) {
                    self.ivars().inner.set(rest.starts_with("true"));
                    return;
                }
                let _ = self.ivars().tx.unbounded_send(text);
            }
        }
    }
);

/// Stands in for the page's parent: what it posts there comes to the host, and the host's answers
/// come as `message` events from that parent, as a frame's do. A hidden frame is the parent, so an
/// app checking `event.source === window.parent` hears them as its host's.
fn parent_shim() -> String {
    format!(
        r#"(() => {{
const post = (m) => {{ try {{ window.webkit.messageHandlers.{BRIDGE}.postMessage(JSON.stringify(m)); }} catch (e) {{}} }};
let host = null;
try {{
  const f = document.createElement("iframe");
  f.style.display = "none";
  f.setAttribute("aria-hidden", "true");
  (document.documentElement || document).appendChild(f);
  host = f.contentWindow;
  host.postMessage = (m) => post(m);
}} catch (e) {{}}
if (!host) host = {{ postMessage: (m) => post(m) }};
try {{ window.parent = host; }} catch (e) {{}}
try {{ Object.defineProperty(window, "parent", {{ get: () => host, configurable: true }}); }} catch (e) {{}}
let over = false;
const scroller = (el) => {{
  for (let n = el; n && n !== document.documentElement && n !== document.body; n = n.parentElement) {{
    const s = getComputedStyle(n);
    if ((s.overflowY === "auto" || s.overflowY === "scroll") && n.scrollHeight > n.clientHeight + 1) return n;
  }}
  return null;
}};
const tell = (now) => {{
  if (now !== over) {{ over = now; try {{ window.webkit.messageHandlers.{BRIDGE}.postMessage(JSON.stringify({{ __switchScroll: now }})); }} catch (x) {{}} }}
}};
let pointer = "";
window.addEventListener("mousemove", (e) => {{
  const at = e.screenX + "," + e.screenY;
  if (at === pointer) return;
  pointer = at;
  tell(scroller(e.target) !== null);
}}, {{ passive: true, capture: true }});
// A scroller at its end in the wheel's way passes the wheel on, as a frame's does to its parent.
window.addEventListener("wheel", (e) => {{
  const n = scroller(e.target);
  if (n === null || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
  const end = e.deltaY > 0 ? n.scrollTop + n.clientHeight >= n.scrollHeight - 1 : n.scrollTop <= 0;
  tell(!end);
}}, {{ passive: true, capture: true }});
window.__switchHost = (m) => {{
  let ev;
  try {{ ev = new MessageEvent("message", {{ data: m, origin: "*", source: host.window === host ? host : null }}); }} catch (e) {{ ev = new MessageEvent("message", {{ data: m, origin: "*" }}); }}
  window.dispatchEvent(ev);
}};
}})();"#
    )
}

/// Where a page is put as the next frame starts: its clip and its own frame, in AppKit's points.
#[derive(Clone, Copy)]
struct Place {
    clip: NSRect,
    web: NSRect,
    /// What of it shows, in the window's coordinates: under an overlay, it hides.
    seen: Bounds<Pixels>,
    /// When it was laid out this frame: an overlay laid out after it is over it.
    order: u64,
    /// The clip's top in the window's coordinates.
    top: f64,
}

thread_local! {
    /// The order pages and overlays are laid out in, which is the order they're drawn in.
    static ORDER: Cell<u64> = const { Cell::new(0) };
}

fn next_order() -> u64 {
    ORDER.with(|o| {
        o.set(o.get() + 1);
        o.get()
    })
}

/// A page in a web view over a window.
pub struct WebView {
    clip: Retained<NSView>,
    web: Retained<Web>,
    controller: Retained<WKUserContentController>,
    window: gpui::WindowId,
    /// Where this frame's prepaint put it; put on the view as the next frame starts.
    want: Cell<Option<Place>>,
    shown: Cell<Option<(f64, f64, f64, f64, f64, f64, f64, f64)>>,
    inbox: RefCell<Option<UnboundedReceiver<String>>>,
    /// A sandboxed page's guard (WebKit holds its delegates weakly).
    _guard: Option<Retained<Guard>>,
}

impl Drop for WebView {
    fn drop(&mut self) {
        unsafe { self.controller.removeScriptMessageHandlerForName(&NSString::from_str(BRIDGE)) };
        self.clip.removeFromSuperview();
    }
}

thread_local! {
    static WATCHING: Cell<bool> = const { Cell::new(false) };
}

/// A click anywhere in a window but on the page that has its keys gives them back to the window,
/// as a click out of a frame takes its focus.
fn watch_clicks() {
    if WATCHING.with(|w| w.replace(true)) {
        return;
    }
    use objc2_app_kit::NSEventMask as M;
    let block = block2::RcBlock::new(|event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
        let e = unsafe { event.as_ref() };
        if let Some(w) = e.window(MainThreadMarker::new().expect("main thread"))
            && let Some(r) = w.firstResponder()
            && let Some(web) = r.downcast_ref::<Web>()
        {
            let p = web.convertPoint_fromView(e.locationInWindow(), None);
            let b = web.bounds();
            if !(p.x >= 0. && p.y >= 0. && p.x < b.size.width && p.y < b.size.height) {
                // Back to the app's own view: with no first responder the window keeps the keys
                // and each one beeps.
                // SAFETY: the page's clip and gpui's view over it, on the main thread.
                let app = unsafe { web.superview().and_then(|clip| clip.superview()) };
                w.makeFirstResponder(app.as_deref().map(|v| &**v as &objc2_app_kit::NSResponder));
            }
        }
        event.as_ptr()
    });
    let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(M::LeftMouseDown | M::RightMouseDown | M::OtherMouseDown, &block) };
    // It watches for as long as the app runs.
    std::mem::forget(monitor);
}

/// What a sandboxed page may do (an MCP App's `permissions`): use the camera, the microphone, where
/// this Mac is, or write the clipboard. Anything else it may not, and it can't navigate.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Sandbox {
    pub camera: bool,
    pub microphone: bool,
    pub geolocation: bool,
    pub clipboard_write: bool,
}

pub struct GuardIvars {
    sandbox: Sandbox,
    /// The one address it may load besides blank frames (a framed page's own).
    frame: Option<String>,
    /// The sources its frames may load from (its CSP's `frame-src` holds them to its frameDomains).
    frames: Vec<String>,
}

define_class!(
    // A sandboxed page's guard: it stays on the document it was given (no navigation, a link goes
    // through its host), and gets the camera or microphone only as its permissions say.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "SwitchGpuiWebGuard"]
    #[ivars = GuardIvars]
    pub struct Guard;

    unsafe impl NSObjectProtocol for Guard {}

    unsafe impl WKNavigationDelegate for Guard {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide(&self, _web: &WKWebView, action: &WKNavigationAction, decide: &block2::DynBlock<dyn Fn(WKNavigationActionPolicy)>) {
            // Only the document it was given, the blank frames it makes itself, a framed page's own
            // address, and a frame of its own from a source it may frame.
            let url = unsafe { action.request().URL() }.and_then(|u| u.absoluteString()).map(|u| u.to_string()).unwrap_or_default();
            let in_frame = unsafe { action.targetFrame() }.is_some_and(|f| unsafe { !f.isMainFrame() });
            let ok = url.starts_with("about:") || self.ivars().frame.as_deref().is_some_and(|f| url == f) || (in_frame && self.ivars().frames.iter().any(|d| source_matches(d, &url)));
            if !ok {
                // Where it tried to go, its scheme and host only (an address may hold a credential).
                let at = url::Url::parse(&url).map(|u| format!("{}:{}", u.scheme(), u.host_str().unwrap_or(""))).unwrap_or_default();
                log::info!("page navigation refused: {at}");
            }
            decide.call((if ok { WKNavigationActionPolicy::Allow } else { WKNavigationActionPolicy::Cancel },));
        }
    }

    unsafe impl WKUIDelegate for Guard {
        // Its alert, confirm and prompt, as a frame allowed modals shows them.
        #[unsafe(method(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:))]
        fn alert(&self, _web: &WKWebView, message: &NSString, _frame: &WKFrameInfo, done: &block2::DynBlock<dyn Fn()>) {
            modal(message, false, None);
            done.call(());
        }

        #[unsafe(method(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:))]
        fn confirm(&self, _web: &WKWebView, message: &NSString, _frame: &WKFrameInfo, done: &block2::DynBlock<dyn Fn(objc2::runtime::Bool)>) {
            let (ok, _) = modal(message, true, None);
            done.call((objc2::runtime::Bool::new(ok),));
        }

        #[unsafe(method(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:))]
        fn prompt(&self, _web: &WKWebView, message: &NSString, text: Option<&NSString>, _frame: &WKFrameInfo, done: &block2::DynBlock<dyn Fn(*mut NSString)>) {
            let (ok, said) = modal(message, true, Some(text.map(|t| t.to_string()).unwrap_or_default()));
            let said = said.filter(|_| ok).map(|t| NSString::from_str(&t));
            done.call((said.as_ref().map(|t| Retained::as_ptr(t).cast_mut()).unwrap_or(std::ptr::null_mut()),));
        }

        #[unsafe(method(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:))]
        fn media(&self, _web: &WKWebView, _origin: &WKSecurityOrigin, _frame: &WKFrameInfo, kind: WKMediaCaptureType, decide: &block2::DynBlock<dyn Fn(WKPermissionDecision)>) {
            let s = self.ivars().sandbox;
            let ok = match kind {
                WKMediaCaptureType::Camera => s.camera,
                WKMediaCaptureType::Microphone => s.microphone,
                _ => s.camera && s.microphone,
            };
            decide.call((if ok { WKPermissionDecision::Prompt } else { WKPermissionDecision::Deny },));
        }
    }
);

/// What a sandboxed page can't reach is taken away before it runs: where this Mac is, and writing
/// the clipboard, unless its permissions say.
fn sandbox_script(s: Sandbox) -> String {
    // Run in every frame as it starts, before the page: what it may not reach goes from the
    // prototypes themselves, so neither the page nor a frame it makes can find the original. Copying
    // what's selected (⌘C) is the user's and stays.
    let mut js = String::from("(() => {");
    if !s.geolocation {
        js.push_str(r#"try { const no = function (_, fail) { if (fail) fail({ code: 1, message: "Not allowed" }); return 0; }; for (const k of ["getCurrentPosition", "watchPosition"]) Object.defineProperty(Geolocation.prototype, k, { value: no, writable: false, configurable: false }); } catch (e) {}"#);
    }
    if !s.clipboard_write {
        js.push_str(r#"try { const no = function () { return Promise.reject(new DOMException("Not allowed", "NotAllowedError")); }; for (const k of ["write", "writeText"]) Object.defineProperty(Clipboard.prototype, k, { value: no, writable: false, configurable: false }); } catch (e) {}"#);
    }
    // A link to a new window or the top is a sandboxed frame's to refuse (no popups, no top
    // navigation): stopped as it's clicked, before WebKit reaches for its address.
    js.push_str(r#"window.addEventListener("click", (e) => { const a = e.target && e.target.closest ? e.target.closest("a[href], area[href]") : null; if (!a) return; const t = (a.getAttribute("target") || "").toLowerCase(); if (t !== "" && t !== "_self") e.preventDefault(); }, true);"#);
    js.push_str("})();");
    js
}

/// What a sandboxed page may load, as content rules WebKit enforces whatever the page does: nothing
/// but its own `data:`, `blob:` and blank frames, and the domains its CSP names.
/// A page's alert, confirm or prompt as AppKit's alert: OK (and Cancel), and a field for a prompt.
/// Whether OK was pressed, and what the field held.
fn modal(message: &NSString, cancel: bool, field: Option<String>) -> (bool, Option<String>) {
    let Some(mtm) = MainThreadMarker::new() else { return (false, None) };
    let Some(alert_class) = objc2::runtime::AnyClass::get(c"NSAlert") else { return (false, None) };
    unsafe {
        let alert: Retained<NSObject> = msg_send![alert_class, new];
        let _: () = msg_send![&*alert, setMessageText: message];
        let _: *mut NSObject = msg_send![&*alert, addButtonWithTitle: ns_string!("OK")];
        if cancel {
            let _: *mut NSObject = msg_send![&*alert, addButtonWithTitle: ns_string!("Cancel")];
        }
        let input: Option<Retained<NSView>> = field.as_ref().map(|t| {
            let f: Retained<NSView> = msg_send![objc2::runtime::AnyClass::get(c"NSTextField").expect("AppKit"), new];
            let _: () = msg_send![&*f, setStringValue: &*NSString::from_str(t)];
            f.setFrame(NSRect::new(NSPoint::new(0., 0.), NSSize::new(240., 24.)));
            f
        });
        if let Some(f) = &input {
            let _: () = msg_send![&*alert, setAccessoryView: &**f];
        }
        let _ = mtm;
        let answer: isize = msg_send![&*alert, runModal];
        // NSAlertFirstButtonReturn
        let ok = answer == 1000;
        let said = input.map(|f| {
            let v: Retained<NSString> = msg_send![&*f, stringValue];
            v.to_string()
        });
        (ok, said)
    }
}

/// Whether an address is one a CSP source names: a scheme (`https:`), or a host with its scheme or
/// not, `*.` for its subdomains; the host whole, not a prefix of a longer one.
fn source_matches(source: &str, url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else { return false };
    let (scheme, rest) = match source.split_once("://") {
        Some((sc, r)) => (Some(sc), r),
        None if source.ends_with(':') => return u.scheme() == source.trim_end_matches(':'),
        None => (None, source),
    };
    if scheme.is_some_and(|sc| sc != u.scheme()) {
        return false;
    }
    let host = rest.split(['/', ':']).next().unwrap_or_default();
    let Some(h) = u.host_str() else { return false };
    match host.strip_prefix("*.") {
        Some(sub) => h.ends_with(&format!(".{sub}")),
        None => h.eq_ignore_ascii_case(host),
    }
}

fn rules_of(allowed: &[String]) -> String {
    let mut rules = vec![serde_json::json!({ "trigger": { "url-filter": ".*" }, "action": { "type": "block" } })];
    for scheme in ["data", "blob", "about"] {
        rules.push(serde_json::json!({ "trigger": { "url-filter": format!("^{scheme}:") }, "action": { "type": "ignore-previous-rules" } }));
    }
    for d in allowed {
        // A CSP source: a scheme (`https:`), or a host with its scheme or not, `*.` for subdomains.
        let (scheme, rest) = match d.split_once("://") {
            Some((sc, r)) => (sc.to_string(), r.to_string()),
            None if d.ends_with(':') => (d.trim_end_matches(':').to_string(), String::new()),
            None => (String::new(), d.clone()),
        };
        let esc = |t: &str| t.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c.to_string() } else { format!("\\{c}") }).collect::<String>();
        let host = if let Some(sub) = rest.strip_prefix("*.") { format!("[^/]*\\.{}", esc(sub)) } else { esc(&rest) };
        let filter = match (scheme.is_empty(), rest.is_empty()) {
            (false, true) => format!("^{}:", esc(&scheme)),
            // The host whole: a port or a path after it, never more of a longer host.
            (false, false) => format!("^{}://{host}[:/]", esc(&scheme)),
            (true, _) => format!("^[a-z]+://{host}[:/]"),
        };
        rules.push(serde_json::json!({ "trigger": { "url-filter": filter }, "action": { "type": "ignore-previous-rules" } }));
    }
    serde_json::Value::Array(rules).to_string()
}

/// A page holding `url` in a sandboxed frame filling it (scripts only: no origin, no forms, no
/// top navigation), what the frame posts to it passed to the host, and the keyboard given to it.
fn framed_page(url: &str) -> String {
    let src = url.replace('&', "&amp;").replace('"', "&quot;");
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><style>html,body{{margin:0;height:100%;background:#000;overflow:hidden}}iframe{{border:0;width:100%;height:100%;display:block}}</style></head><body><iframe id="framed" sandbox="allow-scripts" src="{src}"></iframe><script>
const f = document.getElementById("framed");
window.addEventListener("message", (e) => {{ if (e.source === f.contentWindow) {{ try {{ window.webkit.messageHandlers.{BRIDGE}.postMessage(JSON.stringify(e.data)); }} catch (x) {{}} }} }});
f.addEventListener("load", () => f.focus());
</script></body></html>"#
    )
}

/// Every page over each window: hidden as a frame starts, shown again where its element is drawn.
/// The pages made, and this frame's overlays: their window, when each was laid out, where, and
/// whether it cuts the pages under it (else they hide).
struct Pages(RefCell<Vec<std::rc::Weak<WebView>>>, RefCell<Vec<(gpui::WindowId, u64, Bounds<Pixels>, bool)>>);
impl Global for Pages {}

/// What a page is made from.
pub enum Source<'a> {
    Html { html: &'a str, base: Option<&'a str> },
    /// HTML from an app or the agent: an opaque origin (no base), storage that's gone with it,
    /// held to its document, loading only what `allowed` (its CSP's domains) names, with what its
    /// permissions allow and nothing more.
    Sandboxed { html: &'a str, sandbox: Sandbox, allowed: &'a [String] },
    /// A page at an address shown as a sandboxed frame shows it (`sandbox="allow-scripts"`): in a
    /// frame of its own, at no origin, its storage gone with it, held to that address, given no
    /// permission. What it posts to its parent comes to the host.
    Framed(&'a str),
}

impl WebView {
    /// A page over `window`, with `scripts` run first in it (after the parent's stand-in).
    pub fn new(window: &Window, source: Source, scripts: &[String], cx: &mut App) -> Option<Rc<Self>> {
        let mtm = MainThreadMarker::new()?;
        let RawWindowHandle::AppKit(handle) = HasWindowHandle::window_handle(window).ok()?.as_raw() else { return None };
        // SAFETY: gpui's content view, alive as long as the window.
        let parent: &NSView = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
        let zero = NSRect::new(NSPoint::new(0., 0.), NSSize::new(0., 0.));
        let (tx, rx) = unbounded();
        let view = unsafe {
            let clip = NSView::initWithFrame(mtm.alloc(), zero);
            clip.setWantsLayer(true);
            clip.setClipsToBounds(true);
            clip.setHidden(true);
            let config = WKWebViewConfiguration::new(mtm);
            let controller = config.userContentController();
            let sandbox = match &source {
                Source::Sandboxed { sandbox, .. } => Some(*sandbox),
                Source::Framed(_) => Some(Sandbox::default()),
                _ => None,
            };
            // No WebRTC: its peer connections reach out past any CSP or content rule.
            let prefs = config.preferences();
            if prefs.respondsToSelector(objc2::sel!(_setPeerConnectionEnabled:)) {
                let _: () = msg_send![&*prefs, _setPeerConnectionEnabled: false];
            } else {
                log::warn!("webview: WebKit has no peer connection switch");
            }
            if sandbox.is_some() {
                // Nothing kept on disk: its storage goes with it.
                config.setWebsiteDataStore(&WKWebsiteDataStore::nonPersistentDataStore(mtm));
                // Scripts never reach the clipboard on their own.
                config.preferences().setValue_forKey(Some(&NSNumber::new_bool(false)), ns_string!("javaScriptCanAccessClipboard"));
            }
            // An app's page runs as a secure context, as A2UI's frame inside the desktop's page does,
            // so what its permissions grant (camera, microphone, the clipboard) works; the network
            // stays its CSP's and the content rules'.
            if matches!(source, Source::Sandboxed { .. }) {
                if prefs.respondsToSelector(objc2::sel!(_setSecureContextChecksEnabled:)) {
                    let _: () = msg_send![&*prefs, _setSecureContextChecksEnabled: false];
                }
                if prefs.respondsToSelector(objc2::sel!(_setMediaCaptureRequiresSecureConnection:)) {
                    let _: () = msg_send![&*prefs, _setMediaCaptureRequiresSecureConnection: false];
                }
            }
            let add = |js: &str, main_only: bool| {
                let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(WKUserScript::alloc(mtm), &NSString::from_str(js), WKUserScriptInjectionTime::AtDocumentStart, main_only);
                controller.addUserScript(&script);
            };
            add(&parent_shim(), true);
            // The guards, and a caller's own scripts, in every frame the page makes.
            for js in sandbox.map(sandbox_script).into_iter().chain(scripts.iter().cloned()) {
                add(&js, false);
            }
            let inner = Rc::new(Cell::new(false));
            let bridge = mtm.alloc::<Bridge>().set_ivars(BridgeIvars { tx, inner: inner.clone() });
            let bridge: Retained<Bridge> = msg_send![super(bridge), init];
            controller.addScriptMessageHandler_name(ProtocolObject::from_ref(&*bridge), &NSString::from_str(BRIDGE));
            let web = mtm.alloc::<Web>().set_ivars(WebIvars { forward_wheel: Cell::new(true), inner, passthrough: Cell::new(false), holes: RefCell::default(), granted: Cell::new(false) });
            let web: Retained<Web> = msg_send![super(web), initWithFrame: zero, configuration: &*config];
            web.setValue_forKey(Some(&NSNumber::new_bool(false)), ns_string!("drawsBackground"));
            // The frame's address as WebKit will write it, to know it when it loads.
            let frame = match &source {
                Source::Framed(u) => Some(NSURL::URLWithString(&NSString::from_str(u)).and_then(|n| n.absoluteString()).map(|a| a.to_string()).unwrap_or_else(|| u.to_string())),
                _ => None,
            };
            let frames: Vec<String> = match &source {
                Source::Sandboxed { allowed, .. } => allowed.to_vec(),
                _ => vec![],
            };
            let guard = sandbox.map(|sandbox| {
                let g = mtm.alloc::<Guard>().set_ivars(GuardIvars { sandbox, frame, frames: frames.clone() });
                let g: Retained<Guard> = msg_send![super(g), init];
                web.setNavigationDelegate(Some(ProtocolObject::from_ref(&*g)));
                web.setUIDelegate(Some(ProtocolObject::from_ref(&*g)));
                g
            });
            match source {
                Source::Sandboxed { html, allowed, .. } => {
                    // Loaded once WebKit holds its rules: nothing loads before they're in force.
                    let rules = rules_of(allowed);
                    let id = format!("switch-page-{:x}", {
                        use std::hash::{Hash, Hasher};
                        let mut h = std::collections::hash_map::DefaultHasher::new();
                        rules.hash(&mut h);
                        h.finish()
                    });
                    let (w, c, html) = (web.clone(), controller.clone(), html.to_string());
                    let done = block2::RcBlock::new(move |list: *mut WKContentRuleList, _err: *mut objc2_foundation::NSError| {
                        // A list that didn't compile leaves the page unloaded: blank, not unguarded.
                        if let Some(list) = list.as_ref() {
                            c.addContentRuleList(list);
                            w.loadHTMLString_baseURL(&NSString::from_str(&html), None);
                        }
                    });
                    if let Some(store) = WKContentRuleListStore::defaultStore(mtm) {
                        store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(Some(&NSString::from_str(&id)), Some(&NSString::from_str(&rules)), Some(&done));
                    }
                }
                Source::Framed(url) => {
                    let page = framed_page(url);
                    web.loadHTMLString_baseURL(&NSString::from_str(&page), None);
                }
                Source::Html { html, base } => {
                    let base = base.and_then(|b| NSURL::URLWithString(&NSString::from_str(b)));
                    web.loadHTMLString_baseURL(&NSString::from_str(html), base.as_deref());
                }
            }
            clip.addSubview(&web);
            parent.addSubview(&clip);
            WebView {
                clip,
                web,
                controller,
                window: gpui::Window::window_handle(window).window_id(),
                want: Cell::new(None),
                shown: Cell::new(None),
                inbox: RefCell::new(Some(rx)),
                _guard: guard,
            }
        };
        let view = Rc::new(view);
        watch_clicks();
        if !cx.has_global::<Pages>() {
            cx.set_global(Pages(RefCell::default(), RefCell::default()));
        }
        cx.global::<Pages>().0.borrow_mut().push(Rc::downgrade(&view));
        Some(view)
    }

    /// What the page posts to its parent, as JSON text, once (the host's to read).
    pub fn messages(&self) -> Option<UnboundedReceiver<String>> {
        self.inbox.borrow_mut().take()
    }

    /// Hands the page a message from its parent.
    pub fn post(&self, message: &serde_json::Value) {
        self.eval(&format!("window.__switchHost && window.__switchHost({message});"));
    }

    /// Runs a script in the page.
    pub fn eval(&self, js: &str) {
        unsafe { self.web.evaluateJavaScript_completionHandler(&NSString::from_str(js), None) };
    }

    /// Whether the wheel's up and down go on to the window (a page at its own height), or stay the
    /// page's (a page that fills a window, a remote screen).
    pub fn forward_wheel(&self, on: bool) {
        self.web.ivars().forward_wheel.set(on);
    }

    /// What VoiceOver calls it.
    pub fn set_title(&self, title: &str) {
        let view: &NSView = &self.web;
        objc2_app_kit::NSAccessibility::setAccessibilityLabel(view, Some(&NSString::from_str(title)));
    }

    /// Whether clicks go through to the window under it.
    pub fn passthrough(&self, on: bool) {
        self.web.ivars().passthrough.set(on);
    }

    /// Whether it's on screen now.
    pub fn is_shown(&self) -> bool {
        !self.clip.isHidden()
    }

    /// Takes the keyboard.
    /// Edit ▸ Copy as it reaches the page when it has the keys.
    #[cfg(feature = "shot")]
    pub fn copy(&self) {
        self.focus();
        unsafe {
            let _: () = msg_send![&*self.web, copy: std::ptr::null::<NSObject>()];
        }
    }

    pub fn focus(&self) {
        if let Some(w) = self.web.window() {
            self.web.ivars().granted.set(true);
            unsafe {
                let _: bool = msg_send![&*w, makeFirstResponder: &*self.web];
            }
            self.web.ivars().granted.set(false);
        }
    }

    /// Sets where the view goes: over `at`, clipped to `within`, both in the window's coordinates.
    /// It's put there as the next frame starts, the vsync this frame shows on.
    pub fn place(&self, at: Bounds<Pixels>, within: Bounds<Pixels>, window: &Window) {
        let h = f64::from(window.viewport_size().height);
        let within = within.intersect(&Bounds::new(gpui::point(px(0.), px(0.)), window.viewport_size()));
        let (vx, vy, vw, vh) = (f64::from(within.origin.x), f64::from(within.origin.y), f64::from(within.size.width), f64::from(within.size.height));
        let (rx, ry, rw, rh) = (f64::from(at.origin.x), f64::from(at.origin.y), f64::from(at.size.width), f64::from(at.size.height));
        // AppKit's views count up from the bottom.
        self.want.set(Some(Place {
            clip: NSRect::new(NSPoint::new(vx, h - (vy + vh)), NSSize::new(vw.max(0.), vh.max(0.))),
            web: NSRect::new(NSPoint::new(rx - vx, vh - (ry - vy + rh)), NSSize::new(rw, rh)),
            seen: at.intersect(&within),
            order: next_order(),
            top: vy,
        }));
    }

    /// The size it was last placed at, in points.
    pub fn size(&self) -> (f64, f64) {
        self.shown.get().map(|s| (s.6, s.7)).unwrap_or((0., 0.))
    }

    fn apply(&self, covers: &[(u64, Bounds<Pixels>, bool)]) {
        // Under something drawn over the window (⌘K, a menu, a popup, a tooltip), it hides: a view
        // over the window would otherwise draw over what's meant to be over it.
        let want = self.want.take().filter(|p| !covers.iter().any(|(o, c, cut)| !cut && *o > p.order && c.intersects(&p.seen)));
        match want {
            Some(p) => {
                // Something small over it (Latest, a scroll thumb) cuts it away there instead.
                let (top, bottom) = (p.top, p.clip.size.height);
                let within = |b: Bounds<Pixels>| b.intersect(&p.seen);
                let holes: Vec<NSRect> = covers
                    .iter()
                    .filter(|(o, c, cut)| *cut && *o > p.order && c.intersects(&p.seen))
                    .map(|(_, c, _)| within(*c))
                    .map(|c| {
                        let (x, y, w, h) = (f64::from(c.origin.x) - (p.clip.origin.x), f64::from(c.origin.y) - top, f64::from(c.size.width), f64::from(c.size.height));
                        NSRect::new(NSPoint::new(x, bottom - y - h), NSSize::new(w, h))
                    })
                    .collect();
                self.cut(p.clip.size, holes);
                let sig = (p.clip.origin.x, p.clip.origin.y, p.clip.size.width, p.clip.size.height, p.web.origin.x, p.web.origin.y, p.web.size.width, p.web.size.height);
                if self.shown.get() != Some(sig) {
                    self.clip.setFrame(p.clip);
                    self.web.setFrame(p.web);
                    self.shown.set(Some(sig));
                }
                if self.clip.isHidden() {
                    self.clip.setHidden(false);
                }
            }
            None => {
                if !self.clip.isHidden() {
                    self.clip.setHidden(true);
                }
                self.shown.set(None);
            }
        }
    }

    /// Cuts `holes` (in the clip's points) out of what shows: the clip's layer masked to the rest.
    fn cut(&self, size: NSSize, holes: Vec<NSRect>) {
        let same = *self.web.ivars().holes.borrow() == holes;
        if same {
            return;
        }
        let layer: Option<Retained<objc2_quartz_core::CALayer>> = unsafe { msg_send![&*self.clip, layer] };
        let Some(layer) = layer else { return };
        if holes.is_empty() {
            unsafe { layer.setMask(None) };
        } else {
            let mask = objc2_quartz_core::CALayer::new();
            let opaque = objc2_core_graphics::CGColor::new_generic_gray(0., 1.);
            for r in rest(size, &holes) {
                let part = objc2_quartz_core::CALayer::new();
                part.setFrame(r);
                part.setBackgroundColor(Some(&opaque));
                mask.addSublayer(&part);
            }
            mask.setFrame(NSRect::new(NSPoint::new(0., 0.), size));
            unsafe { layer.setMask(Some(&mask)) };
        }
        *self.web.ivars().holes.borrow_mut() = holes;
    }
}

/// What of a `size` box is left with `holes` taken out, as bands of boxes.
fn rest(size: NSSize, holes: &[NSRect]) -> Vec<NSRect> {
    let mut ys: Vec<f64> = vec![0., size.height];
    for h in holes {
        ys.push(h.origin.y.clamp(0., size.height));
        ys.push((h.origin.y + h.size.height).clamp(0., size.height));
    }
    ys.sort_by(f64::total_cmp);
    ys.dedup();
    let mut out = vec![];
    for band in ys.windows(2) {
        let (y0, y1) = (band[0], band[1]);
        if y1 <= y0 {
            continue;
        }
        let mut xs: Vec<(f64, f64)> = holes
            .iter()
            .filter(|h| h.origin.y < y1 && h.origin.y + h.size.height > y0)
            .map(|h| (h.origin.x.max(0.), (h.origin.x + h.size.width).min(size.width)))
            .collect();
        xs.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut x = 0.;
        for (a, b) in xs {
            if a > x {
                out.push(NSRect::new(NSPoint::new(x, y0), NSSize::new(a - x, y1 - y0)));
            }
            x = f64::max(x, b);
        }
        if x < size.width {
            out.push(NSRect::new(NSPoint::new(x, y0), NSSize::new(size.width - x, y1 - y0)));
        }
    }
    out
}

/// As a window's frame starts drawing: what the last frame placed is put on the views (a page the
/// last frame didn't draw is hidden) once this frame is up, and each page waits to be placed again.
/// Called from each window's root render.
pub fn start_frame(window: &mut Window, cx: &mut App) {
    let Some(pages) = cx.try_global::<Pages>() else { return };
    let id = gpui::Window::window_handle(window).window_id();
    let mut held = pages.0.borrow_mut();
    held.retain(|p| p.strong_count() > 0);
    let mine = held.iter().filter_map(std::rc::Weak::upgrade).any(|p| p.window == id);
    drop(held);
    // This frame's overlays say where they are as they're laid out.
    pages.1.borrow_mut().retain(|(w, ..)| *w != id);
    if !mine {
        return;
    }
    // What this frame's prepaint wants is put on as the next frame starts, clear of its overlays:
    // once, from the window's last render before then. A second render before the vsync (typing
    // draws more often than the screen shows) would find what the first took and hide every page
    // for a frame: the widgets flickered as keys came fast.
    if !PLACING.with(|p| p.borrow_mut().insert(id)) {
        return;
    }
    window.on_next_frame(move |_, cx| {
        PLACING.with(|p| p.borrow_mut().remove(&id));
        let covers: Vec<(u64, Bounds<Pixels>, bool)> = cx.try_global::<Pages>().map(|p| p.1.borrow().iter().filter(|(w, ..)| *w == id).map(|(_, o, b, cut)| (*o, *b, *cut)).collect()).unwrap_or_default();
        let held = cx.try_global::<Pages>().map(|p| p.0.borrow().iter().filter_map(std::rc::Weak::upgrade).filter(|p| p.window == id).collect::<Vec<_>>()).unwrap_or_default();
        for p in &held {
            p.apply(&covers);
        }
    });
}

thread_local! {
    /// The windows whose pages are to be placed as the next frame starts.
    static PLACING: RefCell<std::collections::HashSet<gpui::WindowId>> = RefCell::default();
}

/// The app's own view takes the keyboard back: gpui's focus moved to one of its own fields while a
/// page (or nothing) had AppKit's, so its keys would go to the page, or beep.
pub fn keys_to_app(window: &Window) {
    let Ok(handle) = HasWindowHandle::window_handle(window) else { return };
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else { return };
    // SAFETY: gpui's content view, alive as long as the window.
    let view: &NSView = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
    if let Some(w) = view.window()
        && w.firstResponder().is_none_or(|r| !std::ptr::eq(&*r as *const _ as *const NSView, view as *const NSView))
    {
        w.makeFirstResponder(Some(view));
    }
}

/// Says that something drawn over the window covers `bounds` this frame: a page under it hides.
pub fn cover(bounds: Bounds<Pixels>, window: &Window, cx: &App) {
    over(bounds, false, window, cx);
}

fn over(bounds: Bounds<Pixels>, cut: bool, window: &Window, cx: &App) {
    if let Some(pages) = cx.try_global::<Pages>() {
        pages.1.borrow_mut().push((gpui::Window::window_handle(window).window_id(), next_order(), bounds, cut));
    }
}

/// Put in anything drawn over the window (a popup, a menu, a sheet, a tooltip): its whole box
/// covers the pages under it.
pub fn covering() -> impl IntoElement {
    canvas(|bounds, window, cx| cover(bounds, window, cx), |_, _, _, _| {}).absolute().top_0().left_0().size_full()
}

/// Put in something small drawn over the pages (Latest, a scroll thumb): its box is cut out of the
/// pages under it, which stay.
pub fn cutting() -> impl IntoElement {
    canvas(|bounds, window, cx| over(bounds, true, window, cx), |_, _, _, _| {}).absolute().top_0().left_0().size_full()
}

/// A page's place in the layout: `height` tall (or all its parent's room), the full width; its view
/// goes over it, clipped to what clips the element (a list's edges).
pub fn slot(view: Rc<WebView>, height: Option<Pixels>) -> AnyElement {
    div()
        .w_full()
        .map(|d| match height {
            Some(h) => d.h(h),
            None => d.size_full(),
        })
        .child(
            canvas(
                move |bounds, window, _| {
                    let within = window.content_mask().bounds;
                    view.place(bounds, within, window);
                },
                |_, _, _, _| {},
            )
            .size_full(),
        )
        .into_any_element()
}
