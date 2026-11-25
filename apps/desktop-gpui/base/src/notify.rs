//! The delegate macOS's notification center tells about Switch's notifications (the app's
//! `platform::notify` shows them): it shows them while the app is in front too, and hands on the
//! space a click opens.

use futures::channel::mpsc::UnboundedSender;
use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{AnyThread as _, DefinedClass as _, define_class, msg_send};
use objc2_user_notifications::{UNNotification, UNNotificationPresentationOptions, UNNotificationResponse, UNUserNotificationCenter, UNUserNotificationCenterDelegate};

/// Where a click on one goes: the space it's about.
struct Ivars {
    opened: UnboundedSender<String>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "SwitchNotificationDelegate"]
    #[ivars = Ivars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        // Shown while the app is in front too: the extension has said it wants it.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(&self, _center: &UNUserNotificationCenter, _notification: &UNNotification, done: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
            done.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, done: &block2::DynBlock<dyn Fn()>) {
            let open = response.notification().request().content().targetContentIdentifier().map(|o| o.to_string()).unwrap_or_default();
            self.ivars().opened.unbounded_send(open).ok();
            done.call(());
        }
    }
);

/// Makes `center` tell `opened` the space of each notification clicked (empty when it has none),
/// for as long as the app runs.
pub fn take_clicks(center: &UNUserNotificationCenter, opened: UnboundedSender<String>) {
    let delegate: Retained<Delegate> = {
        let this = Delegate::alloc().set_ivars(Ivars { opened });
        // SAFETY: NSObject's init, on an object just allocated.
        unsafe { msg_send![super(this), init] }
    };
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // The center holds its delegate weakly, and this one lasts as long as the app.
    std::mem::forget(delegate);
}
