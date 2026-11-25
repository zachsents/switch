//! The house's Feed (the desktop's `widgets/feed.tsx`): a live picture, such as a camera's, a frame
//! from the extension's `action` with `args` every `every` ms (at least 250), edge to edge at `ratio`
//! (16 / 9 unless it says). The core answers the picture itself (`?as=picture`), and nothing (204)
//! when it's the frame this one has (`have`, the core's name for it: when it was taken, `X-Picture-At`).
//! Only a live frame is painted, so it needs no mark saying so: none older than ten seconds, none
//! while the source fails, whose words show in its place. Each feed's last frame is kept in memory,
//! so a feed shown again within ten seconds paints it on its first frame, then the live one as it
//! comes.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use gpui::{AnyElement, App, Context, Image, IntoElement, ObjectFit, ParentElement, Styled, StyledImage, Window, div, img};
use serde_json::{Map, Value};

use crate::look::u;
use crate::net::Net;
use crate::time::now_ms;
use crate::widgets::house::record;
use crate::widgets::media::sniff;
use crate::widgets::render::Ctx;

/// A frame older than this is no longer live: the picture shows nothing rather than it.
const LIVE_MS: f64 = 10_000.;

#[derive(Clone)]
struct Frame {
    image: Arc<Image>,
    at: f64,
    tag: String,
}

base::kept_local! {
    /// Each feed's last frame, in memory only.
    static LAST: RefCell<HashMap<String, Frame>> = RefCell::new(HashMap::new());
}

fn live(at: f64) -> bool {
    now_ms() - at <= LIVE_MS
}

pub struct Feeding {
    frame: Option<Frame>,
    error: Option<String>,
}

/// The feed's frame now; none when there's no live one.
async fn frame_now(net: Net, app: String, tool: String, args: Map<String, Value>, held: Option<Frame>) -> Result<Option<Frame>, String> {
    let mut route = format!("/widgets/{app}/{tool}?as=picture");
    if let Some(h) = &held {
        route.push_str(&format!("&have={}", crate::widgets::host::urlencode(&h.tag)));
    }
    let answer = net.http("POST", route, Some(Value::Object(args).to_string().into_bytes())).await.map_err(|_| "Can't reach the core".to_string())??;
    if answer.status >= 300 {
        let said = String::from_utf8_lossy(&answer.body).trim().to_string();
        return Err(if said.is_empty() { "Didn't go through".into() } else { said });
    }
    if answer.status == 204 {
        return Ok(held.filter(|h| live(h.at)));
    }
    let Some(tag) = answer.headers.get("x-picture-at").cloned() else { return Ok(None) };
    let said: f64 = tag.parse().unwrap_or(0.);
    let at = if said.is_finite() && said > 0. { said } else { now_ms() };
    if answer.body.is_empty() || !live(at) {
        return Ok(None);
    }
    let Some(format) = sniff(&answer.body) else { return Ok(None) };
    Ok(Some(Frame { image: Arc::new(Image::from_bytes(format, answer.body)), at, tag }))
}

/// A feed's frames, asked for from when it's first drawn (or first looked at to see whether its cell
/// has anything to show) for as long as it's there.
fn feeding(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> gpui::Entity<Feeding> {
    let app = ctx.app().to_string();
    let tool = c.get("action").and_then(Value::as_str).unwrap_or_default().to_string();
    let args = record(&ctx.scope.prop(c, "args"));
    let every = c.get("every").and_then(Value::as_f64).unwrap_or(1000.).max(250.);
    let key = format!("{app}/{tool}/{}", Value::Object(args.clone()));
    ctx.state(c, &format!("feed:{key}"), window, cx, move |_, cx: &mut Context<Feeding>| {
        let first = LAST.with(|m| m.borrow().get(&key).cloned()).filter(|f| live(f.at));
        let net = cx.global::<Net>().clone();
        cx.spawn(async move |this, cx| {
            loop {
                let held = this.read_with(cx, |f, _| f.frame.clone()).ok().flatten().or_else(|| LAST.with(|m| m.borrow().get(&key).cloned()));
                let got = frame_now(net.clone(), app.clone(), tool.clone(), args.clone(), held).await;
                if let Ok(Some(f)) = &got {
                    LAST.with(|m| m.borrow_mut().insert(key.clone(), f.clone()));
                } else if let Ok(None) = &got {
                    LAST.with(|m| m.borrow_mut().remove(&key));
                }
                let alive = this.update(cx, |me, cx| {
                    match got {
                        Ok(f) => {
                            me.frame = f;
                            me.error = None;
                        }
                        Err(e) => me.error = Some(e),
                    }
                    cx.notify();
                });
                if alive.is_err() {
                    break;
                }
                cx.background_executor().timer(Duration::from_millis(every as u64)).await;
            }
        })
        .detach();
        Feeding { frame: first, error: None }
    })
}

/// What it shows now: its live frame, or what went wrong in its place.
fn now(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> (Option<Frame>, Option<String>) {
    let state = feeding(c, ctx, window, cx);
    let s = state.read(cx);
    (s.frame.clone().filter(|f| live(f.at) && s.error.is_none()), s.error.clone())
}

/// Whether it has anything to show: a live frame, or what went wrong.
pub fn shows(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> bool {
    let (frame, error) = now(c, ctx, window, cx);
    frame.is_some() || error.is_some()
}

pub fn feed(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = ctx.look;
    let ratio = c.get("ratio").and_then(Value::as_f64).unwrap_or(16. / 9.) as f32;
    let (frame, error) = now(c, ctx, window, cx);
    let mut d = div().relative().w_full().overflow_hidden().bg(l.black);
    d.style().aspect_ratio = Some(ratio);
    d.children(frame.map(|f| img(f.image).absolute().top_0().left_0().size_full().object_fit(ObjectFit::Cover)))
        .children(error.map(|e| {
            div().absolute().top_0().left_0().size_full().flex().items_center().justify_center().px(u(8.)).text_size(u(12.)).line_height(u(16.)).text_color(l.white).child(e)
        }))
        .into_any_element()
}
