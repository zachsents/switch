//! The composer's key from any app (`KEY`, ⌘/): a system hotkey, Carbon's `RegisterEventHotKey`
//! (global-hotkey's), which needs no permission. macOS gives it to the app that holds it before any
//! app sees it, this one too, so in the app it comes here as well; the window's own binding of the
//! same key (`commands.rs`) answers when another app holds it. A quiet copy leaves it to the live
//! app unless `$SWITCH_GPUI_HOTKEY` is 1: one app on the Mac holds a key.

use futures::StreamExt as _;
use global_hotkey::hotkey::HotKey;
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use gpui::{App, Global};

/// The composer's key, as the app's key bindings write it. The one place it's set.
pub const KEY: &str = "cmd-/";

/// The manager holding the key: dropped, it lets it go.
struct Held(#[allow(dead_code)] GlobalHotKeyManager);
impl Global for Held {}

/// Takes the key: each press opens the composer, or closes it.
pub fn start(cx: &mut App) {
    if super::helpers::quiet() && std::env::var("SWITCH_GPUI_HOTKEY").as_deref() != Ok("1") {
        return;
    }
    let Ok(key) = KEY.replace('-', "+").parse::<HotKey>() else { return };
    let Ok(manager) = GlobalHotKeyManager::new() else { return };
    if let Err(e) = manager.register(key) {
        log::warn!("the composer's key: {e}");
        return;
    }
    let (tx, mut rx) = futures::channel::mpsc::unbounded();
    GlobalHotKeyEvent::set_event_handler(Some(move |e: GlobalHotKeyEvent| {
        if e.state == HotKeyState::Pressed {
            let _ = tx.unbounded_send(());
        }
    }));
    cx.set_global(Held(manager));
    cx.spawn(async move |cx| {
        while rx.next().await.is_some() {
            cx.update(|cx| crate::composer::toggle(None, cx));
        }
    })
    .detach();
}
