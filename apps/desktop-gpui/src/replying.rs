//! What a space's box replies to (the desktop's `ui/replying.ts`): words quoted from its chat, and
//! asks, attached above what the user types, each with the user's own reply to it. Each comes off
//! with ✕, and they all go with the next message sent there. Kept in the space's draft, so a
//! relaunch keeps them.

use std::collections::HashMap;

use gpui::{App, AppContext, Entity, Global};

use crate::brain::Reply;
use crate::brain::replies_kept;
use crate::outbox;

#[derive(Default)]
pub struct Replying {
    held: HashMap<String, Vec<Reply>>,
    /// The reply field to put the cursor in next: the one just attached.
    focus: Option<(String, usize)>,
}

struct Handle(Entity<Replying>);
impl Global for Handle {}

pub fn entity(cx: &mut App) -> Entity<Replying> {
    if let Some(h) = cx.try_global::<Handle>() {
        return h.0.clone();
    }
    let e = cx.new(|_| Replying::default());
    cx.set_global(Handle(e.clone()));
    e
}

fn place(space: &str) -> String {
    format!("space:{space}")
}

/// What the box in `space` replies to now.
pub fn replying_to(space: &str, cx: &mut App) -> Vec<Reply> {
    let e = entity(cx);
    if let Some(had) = e.read(cx).held.get(space) {
        return had.clone();
    }
    let kept = outbox::draft(&place(space)).and_then(|d| d.reply_to).map(|v| replies_kept(&v)).unwrap_or_default();
    e.update(cx, |r, _| r.held.insert(space.to_string(), kept.clone()));
    kept
}

fn set(space: &str, next: Vec<Reply>, cx: &mut App) {
    let e = entity(cx);
    e.update(cx, |r, cx| {
        r.held.insert(space.to_string(), next.clone());
        cx.notify();
    });
    let mut d = outbox::draft(&place(space)).unwrap_or_default();
    d.reply_to = (!next.is_empty()).then(|| serde_json::Value::Array(next.iter().map(Reply::to_kept).collect()));
    outbox::set_draft(&place(space), d);
}

/// Attaches one to the box, unless it's there already, and puts the cursor in its reply.
pub fn attach(space: &str, r: Reply, cx: &mut App) {
    let mut now = replying_to(space, cx);
    let at = match now.iter().position(|x| x.same(&r)) {
        Some(at) => at,
        None => {
            now.push(r);
            let at = now.len() - 1;
            set(space, now, cx);
            at
        }
    };
    entity(cx).update(cx, |r, cx| {
        r.focus = Some((space.to_string(), at));
        cx.notify();
    });
}

pub fn detach(space: &str, at: usize, cx: &mut App) {
    let mut now = replying_to(space, cx);
    if at < now.len() {
        now.remove(at);
    }
    set(space, now, cx);
}

/// The user's reply to one of them, as it stands.
pub fn answer(space: &str, at: usize, reply: String, cx: &mut App) {
    let mut now = replying_to(space, cx);
    if let Some(r) = now.get_mut(at) {
        r.set_reply(reply);
    }
    set(space, now, cx);
}

/// Something of the user's own is in a reply.
pub fn answered(replies: &[Reply]) -> bool {
    replies.iter().any(|r| !r.reply().trim().is_empty())
}

pub fn clear(space: &str, cx: &mut App) {
    set(space, vec![], cx);
}

impl Replying {
    /// The reply field the cursor should go to, once: the one just attached.
    pub fn take_focus(&mut self, space: &str) -> Option<usize> {
        match &self.focus {
            Some((s, at)) if s == space => {
                let at = *at;
                self.focus = None;
                Some(at)
            }
            _ => None,
        }
    }
}
