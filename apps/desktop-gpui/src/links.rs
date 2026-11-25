//! `switchboard://` links, to the page they name (the desktop's `ui/links.ts`): `space/<id>`,
//! `thread/<id>` and `item/<id>` (an action item, in its window while it's open, else its space),
//! `id/<id>` (whichever of those has the id: a link the agent wrote to a bare id), and the old
//! client's forms: `open/ws/<slug>`, `workspace/<slug>`, `work/<id>`, `ask/<id>`. An old
//! workspace's slug is its space's id (or its name, made a slug); an old task is thread `sb:<id>`.
//! What can't be found opens Home.

use gpui::App;

use crate::brain::{Brain, HOME};
use crate::commands::OpenItem;
use crate::derive::space_of;
use crate::model::model;
use crate::nav::{Nav, Page};

fn slug_of(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

fn space_named(b: &Brain, given: &str) -> Page {
    let want = given.strip_prefix("ws:").unwrap_or(given);
    let found = b
        .spaces
        .values()
        .find(|x| x.id == want)
        .or_else(|| b.spaces.values().find(|x| x.id.to_lowercase() == want.to_lowercase()))
        .or_else(|| b.spaces.values().find(|x| slug_of(&x.name) == slug_of(want)));
    Page::Space(found.map(|x| x.id.clone()).unwrap_or_else(|| HOME.into()))
}

fn thread_named(b: &Brain, given: &str) -> Page {
    [given.to_string(), format!("sb:{given}"), format!("space:{given}")]
        .into_iter()
        .find_map(|id| b.threads.get(&id).map(|t| Page::Thread(id.clone(), space_of(b, t).to_string())))
        .unwrap_or_else(|| Page::Space(HOME.into()))
}

fn decode(p: &str) -> String {
    let bytes = p.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Some(v) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What a link names: its kind (`space`, `thread`, `item`…) and id.
fn target_of(url: &str) -> (String, String) {
    // As URL parses it: `switchboard://space/x` has `space` as its host, `switchboard:space/x` as
    // its path's first part; either way the parts after the scheme.
    let Some((scheme, rest)) = url.split_once(':') else { return (String::new(), String::new()) };
    if scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) {
        return (String::new(), String::new());
    }
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let parts: Vec<String> = rest.split('/').filter(|p| !p.is_empty()).map(decode).collect();
    let parts = if parts.first().map(String::as_str) == Some("open") { &parts[1..] } else { &parts[..] };
    let first = parts.first().cloned().unwrap_or_default();
    let id = parts.get(1..).map(|r| r.join("/")).unwrap_or_default();
    (first, id)
}

fn item_space(b: &Brain, id: &str) -> Option<String> {
    b.items.open.get(id).or_else(|| b.items.revising.get(id)).map(|a| a.space.clone())
}

pub fn page_of_link(b: &Brain, url: &str) -> Page {
    let (first, id) = target_of(url);
    if id.is_empty() {
        return Page::Space(HOME.into());
    }
    match first.as_str() {
        "space" | "ws" | "workspace" => {
            if id == "home" || id == "ws:home" {
                Page::Space(HOME.into())
            } else {
                space_named(b, &id)
            }
        }
        "thread" | "work" => thread_named(b, &id),
        "ask" | "item" => Page::Space(item_space(b, &id).unwrap_or_else(|| HOME.into())),
        "id" => {
            if let Some(space) = item_space(b, &id) {
                return Page::Space(space);
            }
            match thread_named(b, &id) {
                t @ Page::Thread(..) => t,
                _ => space_named(b, &id),
            }
        }
        _ => Page::Space(HOME.into()),
    }
}

/// Opens a link here: an open action item in its window, any other page in this one.
pub fn open_link(url: &str, cx: &mut App) {
    let (first, id) = target_of(url);
    let b = &model(cx).read(cx).brain;
    if (first == "item" || first == "id") && b.items.open.contains_key(&id) {
        // After this dispatch: a link followed from inside the window's own update (a click in a
        // message, the menu's command) would find no window to go through, and be dropped.
        cx.defer(move |cx| cx.dispatch_action(&OpenItem(id)));
    } else {
        let page = page_of_link(b, url);
        Nav::open(page, cx);
    }
}

/// Opens a link once the first snapshot is in: a link the app was opened with names what it holds.
pub fn when_ready(url: String, cx: &mut App) {
    let m = model(cx);
    let (ready, live) = {
        let m = m.read(cx);
        (m.brain.ready, m.first_snapshot.is_some())
    };
    // The snapshot kept from the last run may not hold it yet: opened from it now, and again from
    // the core's own once that comes.
    if ready {
        open_link(&url, cx);
    }
    if live {
        return;
    }
    let mut url = Some(url);
    cx.observe(&m, move |m, cx| {
        if m.read(cx).first_snapshot.is_some()
            && let Some(u) = url.take()
        {
            open_link(&u, cx);
        }
    })
    .detach();
}

/// Opens a link in a message, once the brain is read.
pub fn follow_link(url: &str, cx: &mut App) {
    if model(cx).read(cx).brain.ready {
        open_link(url, cx);
    }
}
