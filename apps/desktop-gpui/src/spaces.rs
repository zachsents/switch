//! What can be done to a space from the window (the desktop's `ui/spaces.ts`): rename it in place
//! on the band, split off its latest exchange, move, archive or unarchive it, make one, copy its
//! link, and its right-click menu. Every change shows at once and is put back if the brain says no.

use std::collections::HashSet;

use gpui::{App, ClipboardItem};
use serde_json::Value;

use crate::brain::{Brain, HOME, SpaceRow};
use crate::model::model;
use crate::mutations::Act;
use crate::nav::Nav;

/// A space's link, as Copy Link gives it and the iPhone opens it.
pub fn space_link(id: &str) -> String {
    format!("switchboard://space/{}", urlencoding(id))
}

fn urlencoding(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Every live space, warmest first.
pub fn warmest(b: &Brain) -> Vec<&SpaceRow> {
    let warmth = |x: &SpaceRow| b.warm.get(&x.id).map(|w| *w as f64).unwrap_or(x.made);
    let mut out: Vec<&SpaceRow> = b.spaces.values().filter(|x| !x.archived).collect();
    out.sort_by(|a, c| warmth(c).total_cmp(&warmth(a)));
    out
}

/// The space and every space under it.
pub fn subtree(b: &Brain, id: &str) -> HashSet<String> {
    let mut out = HashSet::from([id.to_string()]);
    let mut grew = true;
    while grew {
        grew = false;
        for x in b.spaces.values() {
            if let Some(p) = &x.parent
                && out.contains(p)
                && !out.contains(&x.id)
            {
                out.insert(x.id.clone());
                grew = true;
            }
        }
    }
    out
}

/// A space's menu: what can be done to it, and where it can move (every live space outside it).
#[derive(Clone, Debug, PartialEq)]
pub struct SpaceMenu {
    pub id: String,
    pub home: bool,
    pub archived: bool,
    pub move_to: Vec<(String, String)>,
}

pub fn space_menu_of(b: &Brain, id: &str) -> SpaceMenu {
    let inside = subtree(b, id);
    let space = b.spaces.get(id);
    let parent = space.and_then(|s| s.parent.clone());
    SpaceMenu {
        id: id.to_string(),
        home: id == HOME,
        archived: space.is_some_and(|s| s.archived),
        move_to: warmest(b)
            .into_iter()
            .filter(|x| !inside.contains(&x.id) && x.id != HOME && Some(&x.id) != parent.as_ref())
            .map(|x| (x.id.clone(), x.name.clone()))
            .collect(),
    }
}

fn slug(name: &str) -> String {
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

/// A new space's id: unique, and readable in a link.
pub fn new_space_id(name: &str) -> String {
    format!("{}-{}", slug(name), &uuid::Uuid::new_v4().to_string()[..4])
}

pub fn copy_link(id: &str, cx: &mut App) {
    cx.write_to_clipboard(ClipboardItem::new_string(space_link(id)));
}

/// A palette command, shown at once (and put back if the brain says no); `done` runs once it lands,
/// `refused` hears the brain's reason.
fn act(a: Act, done: Option<Box<dyn FnOnce(&mut App)>>, refused: Option<Box<dyn FnOnce(String, &mut App)>>, cx: &mut App) {
    let task = model(cx).update(cx, |m, cx| m.act(a, cx));
    cx.spawn(async move |cx| {
        let got = task.await;
        cx.update(|cx| match got {
            Ok(_) => {
                if let Some(d) = done {
                    d(cx);
                }
            }
            Err(reason) => {
                if let Some(r) = refused {
                    r(reason, cx);
                }
            }
        });
    })
    .detach();
}

pub fn rename(id: &str, name: &str, cx: &mut App) {
    act(Act::Rename { id: id.into(), name: name.into() }, None, None, cx);
}

/// Split Off: the latest exchange in `from` becomes a new space inside it, opened once it's made.
pub fn split(from: &str, cx: &mut App) {
    let id = new_space_id("split");
    let open = id.clone();
    act(Act::Split { id, from: from.into(), name: None }, Some(Box::new(move |cx| Nav::open(crate::nav::Page::Space(open), cx))), None, cx);
}

/// `to` None is the top level.
pub fn move_to(id: &str, to: Option<&str>, cx: &mut App) {
    act(Act::Move { id: id.into(), parent: to.map(str::to_string) }, None, None, cx);
}

pub fn archive(id: &str, archived: bool, cx: &mut App) {
    act(if archived { Act::Archive { id: id.into() } } else { Act::Unarchive { id: id.into() } }, None, None, cx);
}

/// A new space by that name, inside `parent` (None: the top level).
pub fn create(id: &str, name: &str, parent: Option<&str>, done: Box<dyn FnOnce(&mut App)>, refused: Box<dyn FnOnce(String, &mut App)>, cx: &mut App) {
    act(Act::Create { id: id.into(), name: name.into(), parent: parent.map(str::to_string), about: None }, Some(done), Some(refused), cx);
}

/// How a space lists the spaces inside it: banner rows or plain rows. The user's, per space, in the
/// brain (`pref space.inside:<id>`); until set, Home's are banners and every other space's rows.
pub fn inside_key(id: &str) -> String {
    format!("space.inside:{id}")
}

pub fn inside_banners(b: &Brain, id: &str) -> bool {
    match b.prefs.get(&inside_key(id)).and_then(|v| v.as_str()) {
        Some("banners") => true,
        Some("rows") => false,
        _ => id == HOME,
    }
}

/// A preference set in the brain, for every client, shown at once.
pub fn set_pref(key: &str, value: Value, cx: &mut App) {
    let _ = model(cx).update(cx, |m, cx| m.set_pref(key, value, cx));
}
