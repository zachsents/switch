//! What the window holds open over its pages (the desktop's `app.tsx` state): ⌘K's palette, the
//! chat ⌘F's bar is open on, the ⇧⌘/ sheet, and the space whose name is in edit on the band.

use gpui::{App, AppContext, Entity, Global};

use crate::brain::HOME;

#[derive(Default)]
pub struct Shell {
    /// ⌘K is open.
    pub finding: bool,
    /// The space whose chat ⌘F's bar is open on.
    pub searching_in: Option<String>,
    /// Asked to put the cursor back in ⌘F's open bar, its words selected: counts each ask.
    pub find_focus: u64,
    /// ⌘F's current match, by seq.
    pub find_seq: Option<u64>,
    /// ⇧⌘/ is open.
    pub shortcuts: bool,
    /// The space whose name is being edited on the band.
    pub renaming: Option<String>,
}

struct ShellHandle(Entity<Shell>);
impl Global for ShellHandle {}

impl Shell {
    pub fn init(cx: &mut App) {
        let e = cx.new(|_| Shell::default());
        cx.set_global(ShellHandle(e));
    }

    pub fn entity(cx: &App) -> Entity<Shell> {
        cx.global::<ShellHandle>().0.clone()
    }

    pub fn update(cx: &mut App, f: impl FnOnce(&mut Shell)) {
        Self::entity(cx).update(cx, |s, cx| {
            f(s);
            cx.notify();
        });
    }

    /// Something of its own (⌘K, ⌘F's bar on the chat shown, a sheet, a rename) takes Escape.
    /// `shown` is the space whose chat is on screen, if one is.
    pub fn busy(&self, shown: Option<&str>) -> bool {
        self.finding || (shown.is_some() && self.searching_in.as_deref() == shown) || self.shortcuts || self.renaming.is_some()
    }

    /// Puts the band's title in edit, for the space open.
    pub fn start_rename(id: &str, cx: &mut App) {
        if id != HOME {
            let id = id.to_string();
            Self::update(cx, |s| s.renaming = Some(id));
        }
    }

    pub fn stop_rename(cx: &mut App) {
        Self::update(cx, |s| s.renaming = None);
    }
}
