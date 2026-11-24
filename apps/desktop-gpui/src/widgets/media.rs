//! Pictures a widget shows by address (A2UI's Image, the Gallery, what's playing's art): `https:`
//! and `http:` fetched once and kept by address, `data:` read in place; the core's own addresses go
//! with the credential. Views that draw them observe this entity, so a picture shows as it comes.
//! Only an address A2UI's own would show is one (`sanitizeMediaUrl`: http, https or data).

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine;
use gpui::{App, AppContext, Context, Entity, Global, Image, ImageFormat};

use crate::net::Net;

enum Held {
    Loading,
    Ready(Arc<Image>),
    Failed,
}

pub struct WebPictures {
    held: HashMap<String, Held>,
}

struct Handle(Entity<WebPictures>);
impl Global for Handle {}

/// An address A2UI's own would show: http, https or data; a path is on the core.
pub fn safe_url(url: &str, cx: &App) -> Option<String> {
    let u = url.trim();
    if u.starts_with("https://") || u.starts_with("http://") || u.starts_with("data:") {
        return Some(u.to_string());
    }
    if u.starts_with('/') {
        return cx.global::<Net>().auth().map(|a| format!("{}{u}", a.core));
    }
    None
}

/// A picture's format by its first bytes.
pub fn sniff(b: &[u8]) -> Option<ImageFormat> {
    Some(match b {
        [0x89, b'P', b'N', b'G', ..] => ImageFormat::Png,
        [0xff, 0xd8, ..] => ImageFormat::Jpeg,
        [b'G', b'I', b'F', b'8', ..] => ImageFormat::Gif,
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => ImageFormat::Webp,
        [b'B', b'M', ..] => ImageFormat::Bmp,
        [b'I', b'I', 42, 0, ..] | [b'M', b'M', 0, 42, ..] => ImageFormat::Tiff,
        _ if b.iter().take(256).any(|&c| c == b'<') && String::from_utf8_lossy(&b[..b.len().min(512)]).contains("<svg") => ImageFormat::Svg,
        _ => return None,
    })
}

/// A `data:` address's bytes.
fn data_bytes(url: &str) -> Option<Vec<u8>> {
    let (head, body) = url.strip_prefix("data:")?.split_once(',')?;
    if head.ends_with(";base64") {
        base64::engine::general_purpose::STANDARD.decode(body.trim()).ok()
    } else {
        Some(percent_decode(body).into_bytes())
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
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

impl WebPictures {
    pub fn entity(cx: &mut App) -> Entity<WebPictures> {
        if let Some(h) = cx.try_global::<Handle>() {
            return h.0.clone();
        }
        let e = cx.new(|_| WebPictures { held: HashMap::new() });
        cx.set_global(Handle(e.clone()));
        e
    }

    /// Whether the picture at `url` couldn't be had.
    pub fn failed(url: &str, cx: &mut App) -> bool {
        matches!(Self::entity(cx).read(cx).held.get(url), Some(Held::Failed))
    }

    /// The picture at `url`, once it's in; asked for the first time, it's fetched.
    pub fn get(url: &str, cx: &mut App) -> Option<Arc<Image>> {
        let this = Self::entity(cx);
        match this.read(cx).held.get(url) {
            Some(Held::Ready(img)) => return Some(img.clone()),
            Some(_) => return None,
            None => {}
        }
        if let Some(bytes) = url.starts_with("data:").then(|| data_bytes(url)).flatten() {
            let held = sniff(&bytes).map(|f| Held::Ready(Arc::new(Image::from_bytes(f, bytes)))).unwrap_or(Held::Failed);
            let ready = if let Held::Ready(i) = &held { Some(i.clone()) } else { None };
            this.update(cx, |p, _| p.held.insert(url.to_string(), held));
            return ready;
        }
        this.update(cx, |p, cx| p.fetch(url.to_string(), cx));
        None
    }

    fn fetch(&mut self, url: String, cx: &mut Context<Self>) {
        self.held.insert(url.clone(), Held::Loading);
        let job = cx.global::<Net>().fetch_url(url.clone());
        cx.spawn(async move |this, cx| {
            let bytes = job.await.ok().flatten();
            this.update(cx, |p, cx| {
                let held = bytes.and_then(|b| Some(Held::Ready(Arc::new(Image::from_bytes(sniff(&b)?, b))))).unwrap_or(Held::Failed);
                p.held.insert(url, held);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}
