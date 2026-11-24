//! Where the window is (a space's page or a piece of work opened), with back and forward, as the
//! desktop's `ui/nav.ts`; and the beat every live mark steps on.

use std::time::Duration;

use gpui::{App, AppContext, Context, Entity, Global};

use crate::brain::HOME;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Page {
    Space(String),
    /// A thread, and the space it's in.
    Thread(String, String),
}

impl Page {
    /// The space the page is in.
    pub fn space(&self) -> &str {
        match self {
            Page::Space(s) | Page::Thread(_, s) => s,
        }
    }
}

pub struct Nav {
    pub page: Page,
    /// A line of the open space's chat to bring into view and ring, by seq (a find, a link).
    pub at: Option<u64>,
    /// Counts each move: a line brought back by Back is brought into view again.
    pub turn: u64,
    /// Each page with the line it was at.
    back: Vec<(Page, Option<u64>)>,
    forward: Vec<(Page, Option<u64>)>,
}

struct NavHandle(Entity<Nav>);
impl Global for NavHandle {}

impl Nav {
    pub fn init(cx: &mut App) -> Entity<Nav> {
        let nav = cx.new(|_| Nav { page: Page::Space(HOME.into()), at: None, turn: 0, back: vec![], forward: vec![] });
        cx.set_global(NavHandle(nav.clone()));
        nav
    }

    pub fn entity(cx: &App) -> Entity<Nav> {
        cx.global::<NavHandle>().0.clone()
    }

    pub fn open(page: Page, cx: &mut App) {
        Self::entity(cx).update(cx, |nav, cx| {
            if nav.page != page {
                let was = std::mem::replace(&mut nav.page, page);
                let at = nav.at.take();
                nav.back.push((was, at));
                nav.forward.clear();
                nav.turn += 1;
                cx.notify();
            } else if nav.at.is_some() {
                nav.at = None;
                nav.turn += 1;
                cx.notify();
            }
        });
    }

    /// A space, at a line of its chat: the same space at another line is no step in history.
    pub fn open_at(space: String, at: Option<u64>, cx: &mut App) {
        Self::open(Page::Space(space), cx);
        Self::entity(cx).update(cx, |nav, cx| {
            if nav.at != at {
                nav.at = at;
                nav.turn += 1;
                cx.notify();
            }
        });
    }

    pub fn back(cx: &mut App) {
        Self::entity(cx).update(cx, |nav, cx| {
            if let Some((p, at)) = nav.back.pop() {
                let was = std::mem::replace(&mut nav.page, p);
                let was_at = std::mem::replace(&mut nav.at, at);
                nav.forward.push((was, was_at));
                nav.turn += 1;
                cx.notify();
            }
        });
    }

    pub fn forward(cx: &mut App) {
        Self::entity(cx).update(cx, |nav, cx| {
            if let Some((p, at)) = nav.forward.pop() {
                let was = std::mem::replace(&mut nav.page, p);
                let was_at = std::mem::replace(&mut nav.at, at);
                nav.back.push((was, was_at));
                nav.turn += 1;
                cx.notify();
            }
        });
    }

    pub fn can_back(&self) -> bool {
        !self.back.is_empty()
    }

    pub fn can_forward(&self) -> bool {
        !self.forward.is_empty()
    }
}

/// Every runner and spinner on one beat, eight steps a second.
pub struct Beat {
    pub step: usize,
}

struct BeatHandle(Entity<Beat>);
impl Global for BeatHandle {}

impl Beat {
    pub fn init(cx: &mut App) -> Entity<Beat> {
        let beat = cx.new(|cx: &mut Context<Beat>| {
            cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_millis(125)).await;
                    if this.update(cx, |b, cx| {
                        b.step = b.step.wrapping_add(1);
                        cx.notify();
                    })
                    .is_err()
                    {
                        break;
                    }
                }
            })
            .detach();
            Beat { step: 0 }
        });
        cx.set_global(BeatHandle(beat.clone()));
        beat
    }

    pub fn entity(cx: &App) -> Entity<Beat> {
        cx.global::<BeatHandle>().0.clone()
    }

    pub fn step(cx: &App) -> usize {
        Self::entity(cx).read(cx).step
    }
}
