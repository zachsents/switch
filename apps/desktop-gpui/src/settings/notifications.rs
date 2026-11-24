//! Notifications (the desktop's `ui/settings/notifications.tsx` and `notify-prefs.ts`): where they
//! go (this Mac or the iPhone) and whether they're quiet while the app is open. The user's, in the
//! brain (`pref notifications`).

use gpui::{AnyElement, App, ParentElement, Window, div, prelude::*};
use serde_json::{Value, json};

use crate::kit::{self, W40};
use crate::look::Look;
use crate::model::model;
use crate::spaces::set_pref;

/// Where notifications go and whether they're quiet while the app is open.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NotifyPrefs {
    pub here: bool,
    pub quiet_open: bool,
}

pub fn notify_prefs_of(v: Option<&Value>) -> NotifyPrefs {
    NotifyPrefs { here: v.and_then(|v| v.get("here")) != Some(&Value::Bool(false)), quiet_open: v.and_then(|v| v.get("quietOpen")) == Some(&Value::Bool(true)) }
}

fn set(p: NotifyPrefs, cx: &mut App) {
    set_pref("notifications", json!({ "here": p.here, "quietOpen": p.quiet_open }), cx);
}

pub fn render(window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let p = notify_prefs_of(model(cx).read(cx).brain.prefs.get("notifications"));
    let rows = vec![
        kit::setting("Send to", W40, &l)
            .child(kit::controls().child(kit::segmented("send-to", "Send to", &[("here", "This Mac"), ("iphone", "iPhone")], if p.here { "here" } else { "iphone" }, &l, move |v, _, cx| set(NotifyPrefs { here: v == "here", ..p }, cx), window, cx)))
            .into_any_element(),
        kit::setting("While the app is open", W40, &l)
            .child(kit::controls().child(kit::segmented("quiet-open", "While the app is open", &[("show", "Show"), ("quiet", "Quiet")], if p.quiet_open { "quiet" } else { "show" }, &l, move |v, _, cx| set(NotifyPrefs { quiet_open: v == "quiet", ..p }, cx), window, cx)))
            .into_any_element(),
    ];
    kit::pane_scroll("notifications", None, div().child(kit::group("Notifications", None, rows, &l)), window, cx)
}
