//! macOS notifications from Switch (the desktop extension's `notify` tool), as old Switchboard's
//! `notifications.rs` showed them: macOS's own, and a click on one opens its space in the app. macOS
//! keeps the user's say over them (the switch, Focus, how they show); the app asks for it once, with
//! macOS's prompt, as the first one comes. Whether one is shown at all (where the user sends them,
//! quiet while the app is open) is the extension's to say.

use block2::RcBlock;
use futures::StreamExt;
use futures::channel::mpsc::unbounded;
use gpui::App;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2_foundation::{NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotificationRequest, UNNotificationSettings, UNNotificationSound,
    UNUserNotificationCenter,
};

use crate::nav::{Nav, Page};

/// Whether this runs as the app (from its bundle): macOS's notification center won't serve a bare
/// binary, and throws when asked to.
fn bundled() -> bool {
    std::env::current_exe().is_ok_and(|exe| exe.to_string_lossy().contains(".app/Contents/MacOS/"))
}

fn center() -> Option<Retained<UNUserNotificationCenter>> {
    bundled().then(UNUserNotificationCenter::currentNotificationCenter)
}

/// Takes clicks on Switch's notifications from now on, even the one that launched the app: each
/// brings the window forward at its space. Set before the app finishes launching, as macOS wants.
pub fn start(cx: &mut App) {
    let (opened, mut clicks) = unbounded::<String>();
    if let Some(center) = center() {
        base::notify::take_clicks(&center, opened);
    }
    cx.spawn(async move |cx| {
        while let Some(space) = clicks.next().await {
            let _ = cx.update(|cx| {
                super::lifecycle::show_main(cx);
                if !space.is_empty() {
                    Nav::open(Page::Space(space), cx);
                }
            });
        }
    })
    .detach();
}

/// A notification: its title, body and subtitle, about `space` (a click opens it).
pub struct Notice {
    pub title: String,
    pub body: Option<String>,
    pub subtitle: Option<String>,
    pub space: Option<String>,
}

fn add(center: &UNUserNotificationCenter, n: &Notice) {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&n.title));
    if let Some(subtitle) = &n.subtitle {
        content.setSubtitle(&NSString::from_str(subtitle));
    }
    if let Some(body) = &n.body {
        content.setBody(&NSString::from_str(body));
    }
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    if let Some(space) = &n.space {
        content.setThreadIdentifier(&NSString::from_str(space));
        content.setTargetContentIdentifier(Some(&NSString::from_str(space)));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&id), &content, None);
    let done = RcBlock::new(|error: *mut NSError| {
        // SAFETY: when it isn't null, macOS hands the handler a live error.
        if let Some(error) = unsafe { error.as_ref() } {
            log::warn!("macOS didn't show a notification: {}", error.localizedDescription());
        }
    });
    center.addNotificationRequest_withCompletionHandler(&request, Some(&done));
}

/// Shows a notification, asking macOS's say first if it hasn't been asked.
pub fn post(n: Notice) {
    let Some(center) = center() else { return };
    let n = std::sync::Arc::new(n);
    let settled = RcBlock::new(move |settings: std::ptr::NonNull<UNNotificationSettings>| {
        // SAFETY: macOS hands the handler the center's live settings.
        let status = unsafe { settings.as_ref() }.authorizationStatus();
        let center = UNUserNotificationCenter::currentNotificationCenter();
        if status != UNAuthorizationStatus::NotDetermined {
            add(&center, &n);
            return;
        }
        let n = n.clone();
        let answered = RcBlock::new(move |granted: Bool, _: *mut NSError| {
            if granted.as_bool() {
                add(&UNUserNotificationCenter::currentNotificationCenter(), &n);
            }
        });
        center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge, &answered);
    });
    center.getNotificationSettingsWithCompletionHandler(&settled);
}
