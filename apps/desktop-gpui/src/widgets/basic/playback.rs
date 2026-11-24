//! A2UI's Video and AudioPlayer as old Switchboard drew them (the desktop's `video.tsx`,
//! `audio-player.tsx`, `transport.tsx`, `use-media.ts`): a video's picture edge to edge at its own
//! ratio, black until a frame or its poster is in, and its transport under it; a sound's words on a
//! line of their own when it says, then its transport. The transport is the house's: Play or Pause on
//! a key, where it's at on a track to press or drag, its time and length as figures ("0:12 / 3:04").
//! One plays at a time: one starting pauses every other. Nothing without an address A2UI's own would
//! play. gpui plays no media, so WebKit does: the picture (or, for a sound, nothing to see) is a web
//! view holding the `<video>` or `<audio>` element (webview.rs), driven from the transport and telling
//! it where it's at.

use std::cell::RefCell;
use std::rc::{Rc, Weak};

use futures::StreamExt;
use gpui::{AnyElement, App, Context, IntoElement, ParentElement, Styled, Window, div, prelude::*, px};
use serde_json::{Value, json};

use crate::kit::{self, Btn};
use crate::look::u;
use crate::webview::{self, Source, WebView};
use crate::widgets::basic::controls::{Drag, track};
use crate::widgets::basic::{data, glyph, nothing, share, span_of};
use crate::widgets::render::Ctx;

thread_local! {
    /// Every player made, so one starting pauses the rest.
    static PLAYERS: RefCell<Vec<Weak<WebView>>> = const { RefCell::new(vec![]) };
}

/// A player's state, as its element tells it.
pub struct Media {
    view: Option<Rc<WebView>>,
    at: f64,
    length: f64,
    playing: bool,
    ratio: f32,
}

fn attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;")
}

fn page(video: bool, url: &str, poster: Option<&str>) -> String {
    let element = if video {
        format!(r#"<video id="m" src="{}"{} preload="metadata" playsinline></video>"#, attr(url), poster.map(|p| format!(r#" poster="{}""#, attr(p))).unwrap_or_default())
    } else {
        format!(r#"<audio id="m" src="{}" preload="metadata"></audio>"#, attr(url))
    };
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><style>html,body{{margin:0;height:100%;background:#000;overflow:hidden}}video{{display:block;width:100%;height:100%;object-fit:contain;background:#000}}</style></head><body>{element}<script>
const m = document.getElementById("m");
const say = () => window.parent.postMessage({{ media: 1, at: m.currentTime || 0, length: isFinite(m.duration) ? m.duration : 0, playing: !m.paused, w: m.videoWidth || 0, h: m.videoHeight || 0 }}, "*");
["timeupdate", "durationchange", "play", "pause", "loadedmetadata", "ended"].forEach((e) => m.addEventListener(e, say));
window.addEventListener("message", (e) => {{ const d = e.data || {{}}; if (d.cmd === "play") m.play(); else if (d.cmd === "pause") m.pause(); else if (d.cmd === "seek") m.currentTime = d.to; }});
</script></body></html>"#
    )
}

fn player(c: &Value, ctx: &Ctx, video: bool, url: &str, poster: Option<&str>, window: &mut Window, cx: &mut App) -> gpui::Entity<Media> {
    let html = page(video, url, poster);
    ctx.state(c, &format!("media:{url}"), window, cx, move |window, cx: &mut Context<Media>| {
        let view = WebView::new(window, Source::Html { html: &html, base: None }, &[], cx);
        if let Some(v) = &view {
            PLAYERS.with(|p| {
                let mut p = p.borrow_mut();
                p.retain(|w| w.strong_count() > 0);
                p.push(Rc::downgrade(v));
            });
            if let Some(mut inbox) = v.messages() {
                cx.spawn(async move |this, cx| {
                    while let Some(text) = inbox.next().await {
                        let Ok(m) = serde_json::from_str::<Value>(&text) else { continue };
                        let ok = this.update(cx, |me, cx| {
                            let was = me.playing;
                            me.at = m.get("at").and_then(Value::as_f64).unwrap_or(0.);
                            me.length = m.get("length").and_then(Value::as_f64).unwrap_or(0.);
                            me.playing = m.get("playing").and_then(Value::as_bool).unwrap_or(false);
                            let (w, h) = (m.get("w").and_then(Value::as_f64).unwrap_or(0.), m.get("h").and_then(Value::as_f64).unwrap_or(0.));
                            if w > 0. && h > 0. {
                                me.ratio = (w / h) as f32;
                            }
                            // One starting pauses every other.
                            if me.playing && !was
                                && let Some(mine) = &me.view
                            {
                                crate::media::pause_playing(cx);
                                PLAYERS.with(|p| {
                                    for other in p.borrow().iter().filter_map(Weak::upgrade) {
                                        if !Rc::ptr_eq(&other, mine) {
                                            other.post(&json!({ "cmd": "pause" }));
                                        }
                                    }
                                });
                            }
                            cx.notify();
                        });
                        if ok.is_err() {
                            break;
                        }
                    }
                })
                .detach();
            }
        }
        Media { view, at: 0., length: 0., playing: false, ratio: 16. / 9. }
    })
}

/// The house's transport for a player.
fn transport(c: &Value, ctx: &Ctx, media: &gpui::Entity<Media>, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = ctx.look;
    let (at, length, playing, view) = {
        let m = media.read(cx);
        (m.at, m.length, m.playing, m.view.clone())
    };
    let known = length.is_finite() && length > 0.;
    let drag = ctx.state(c, "transport-drag", window, cx, |_, cx| Drag(false, cx.focus_handle()));
    let focus = drag.read(cx).1.clone();
    // The key plays and pauses with Space or Return too: a key's own press, as a click.
    let key_focus = ctx.state(c, "toggle-focus", window, cx, |_, cx| cx.focus_handle()).read(cx).clone();
    let (v1, v2) = (view.clone(), view);
    let seek: Rc<dyn Fn(f64, &mut App)> = Rc::new(move |to, _| {
        if let Some(v) = &v2 {
            v.post(&json!({ "cmd": "seek", "to": to }));
        }
    });
    div()
        .flex()
        .h(u(24.))
        .items_center()
        .gap(u(10.))
        .px(u(8.))
        .child(
            kit::button(ctx.id(c, "toggle"), Btn::Key, true, &l)
                .role(gpui::Role::Button)
                .aria_label(if playing { "Pause" } else { "Play" })
                .px(u(6.))
                .child(glyph(if playing { "pause" } else { "play" }, l.ink))
                .track_focus(&key_focus.clone().tab_index(0).tab_stop(true))
                .on_click(move |_, _, _| {
                    #[cfg(feature = "shot")]
                    eprintln!("pressed play key: {}", if playing { "pause" } else { "play" });
                    if let Some(v) = &v1 {
                        v.post(&json!({ "cmd": if playing { "pause" } else { "play" } }));
                    }
                }),
        )
        .child(track(ctx.id(c, "position"), "Position", drag, focus, at, 0., if known { length } else { 1. }, 1., known, &l, seek))
        .child(data(format!("{} / {}", span_of(at * 1000., false), if known { span_of(length * 1000., false) } else { "–:––".into() }), &l))
        .into_any_element()
}

/// An address A2UI's own would play: http, https or data.
pub fn playable(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://") || url.starts_with("data:")
}

pub fn video(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let url = ctx.scope.text(c, "url");
    if !playable(&url) {
        return nothing();
    }
    let poster = Some(ctx.scope.text(c, "posterUrl")).filter(|p| playable(p));
    let media = player(c, ctx, true, &url, poster.as_deref(), window, cx);
    let (view, ratio) = {
        let m = media.read(cx);
        (m.view.clone(), m.ratio)
    };
    let mut picture = div().w_full().bg(ctx.look.black);
    picture.style().aspect_ratio = Some(ratio);
    let picture = match view {
        Some(v) => picture.child(webview::slot(v, None)),
        None => picture,
    };
    share(div(), c, ctx).child(picture).child(transport(c, ctx, &media, window, cx)).into_any_element()
}

pub fn audio(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = ctx.look;
    let url = ctx.scope.text(c, "url");
    if !playable(&url) {
        return nothing();
    }
    let media = player(c, ctx, false, &url, None, window, cx);
    let about = ctx.scope.words(c, "description");
    let view = media.read(cx).view.clone();
    share(div(), c, ctx)
        .when(!about.is_empty(), |d| d.child(div().px(u(8.)).py(u(4.)).text_size(u(13.)).line_height(u(16.)).text_color(l.ink).child(about)))
        .children(view.map(|v| webview::slot(v, Some(px(0.)))))
        .child(transport(c, ctx, &media, window, cx))
        .into_any_element()
}

/// Pauses every widget's video and sound (the chat's starting: one plays at a time).
pub fn pause_all() {
    PLAYERS.with(|p| {
        for v in p.borrow().iter().filter_map(Weak::upgrade) {
            v.post(&json!({ "cmd": "pause" }));
        }
    });
}
