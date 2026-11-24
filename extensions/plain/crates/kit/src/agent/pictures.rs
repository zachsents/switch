//! Live pictures: what an app is watching right now, like a printer's camera, offered to hosts
//! as resources, `<app>://live/<name>`. Reading one answers its newest frame. Hosts read it
//! about once a second while they show it and stop when they don't, so an app can keep a camera
//! running only while something reads it. A widget shows one with a `Live` whose `source` is
//! the resource's URI; a host that keeps its own live slots (Switchboard) reads it into one.

use std::sync::Arc;

use gpui::{App, Global};
use serde_json::{Value, json};

use super::Reply;
use crate::AppInfo;

/// A live picture's newest frame.
#[derive(Clone)]
pub struct LiveFrame {
    pub bytes: Arc<Vec<u8>>,
    /// What the bytes are, like `image/jpeg`.
    pub mime_type: &'static str,
    /// When it was taken, in milliseconds since 1970.
    pub at: i64,
}

/// Reads a live picture's newest frame by its name.
type ReadFrame = dyn Fn(&str, &mut App) -> Option<LiveFrame>;

struct Pictures(Box<ReadFrame>);

impl Global for Pictures {}

/// Where an app's live picture `name` is read: a widget's `Live` shows it by this source.
pub fn live_uri(app: AppInfo, name: &str) -> String {
    format!("{}://live/{name}", app.id)
}

/// Offers the app's live pictures to hosts: reading `<app>://live/<name>` calls `read` with the
/// name, which answers the newest frame, or `None` when there's no picture now (it reads as no
/// contents). Each read says a host is showing the picture, so `read` is where an app notes it's
/// wanted.
pub fn live(cx: &mut App, read: impl Fn(&str, &mut App) -> Option<LiveFrame> + 'static) {
    cx.set_global(Pictures(Box::new(read)));
}

/// Reads a live picture, if `uri` names one of the app's.
pub(super) fn read(app: AppInfo, uri: &str, cx: &mut App) -> Option<Reply> {
    let name = uri.strip_prefix(&format!("{}://live/", app.id))?.to_string();
    if !cx.has_global::<Pictures>() {
        return Some(Err(format!("no resource `{uri}`")));
    }
    // Taken out while it reads, so the reader may use the app freely.
    let pictures = cx.remove_global::<Pictures>();
    let frame = (pictures.0)(&name, cx);
    cx.set_global(pictures);
    let contents: Vec<Value> = frame
        .map(|frame| {
            use base64::Engine as _;
            json!({
                "uri": uri,
                "mimeType": frame.mime_type,
                "blob": base64::engine::general_purpose::STANDARD.encode(frame.bytes.as_slice()),
                "_meta": { "plain/at": frame.at },
            })
        })
        .into_iter()
        .collect();
    Some(Ok(json!({ "contents": contents })))
}

/// The template live pictures are read through, when the app has any.
pub(super) fn template(app: AppInfo, cx: &App) -> Option<Value> {
    cx.has_global::<Pictures>().then(|| {
        json!({
            "uriTemplate": live_uri(app, "{name}"),
            "name": "live",
            "title": format!("{} live pictures", app.name),
            "description": "A live picture's newest frame, like a camera's. Read it about once a \
                            second while it's shown; each read keeps it coming.",
            "mimeType": "image/jpeg",
        })
    })
}
