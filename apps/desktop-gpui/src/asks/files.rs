//! The files on an item, drawn as the chat draws them, small (the desktop's `ask-files.tsx`, through
//! `attached.rs`): pictures and videos as a row, the rest as they are; in an ask's own window its
//! videos bigger. A blob comes from the core's blob store; a file without one is its link. Each row
//! scrolls sideways on its own.

use gpui::{AnyElement, App, IntoElement, ParentElement, ScrollHandle, Styled, Window, div};

use crate::attached::{Shown, Size, files as drawn};
use crate::items::Attachment;
use crate::look::{Look, u};

fn hash_of(blob: &str) -> Option<String> {
    let h = blob.trim_start_matches("sha256:").trim_start_matches("blob:");
    (h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit())).then(|| h.to_lowercase())
}

/// Where a file is: its blob in the core's store, or its link.
fn shown_of(a: &Attachment) -> Shown {
    let q = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
    let blob = a.blob.as_deref().and_then(hash_of);
    let route = match &blob {
        Some(h) => format!("/blobs/{h}?type={}&name={}", q(&a.kind), q(&a.name)),
        None => a.url.clone().unwrap_or_default(),
    };
    Shown { route, name: a.name.clone(), kind: a.kind.clone(), size: a.size, blob, local: None }
}

/// One file, as an option's (beside its key); a video is a row of its own, its own scroll.
pub fn file(a: &Attachment, key: &str, scroll: &ScrollHandle, l: &Look, window: &mut Window, cx: &mut App) -> AnyElement {
    div().flex().items_center().children(drawn(&[shown_of(a)], Size::Ask, false, key, scroll, l, window, cx)).into_any_element()
}

/// The files that go with no option; in an ask's own window, its videos bigger.
pub fn files(list: &[Attachment], own: bool, key: &str, scroll: &ScrollHandle, l: &Look, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    let shown: Vec<Shown> = list.iter().filter(|a| a.option.is_none()).map(shown_of).collect();
    if shown.is_empty() {
        return None;
    }
    let size = if own { Size::Window } else { Size::Ask };
    Some(div().flex().flex_wrap().items_center().gap(u(8.)).children(drawn(&shown, size, false, key, scroll, l, window, cx)).into_any_element())
}
