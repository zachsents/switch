//! The system's color panel (what an `<input type="color">` opens on the Mac): opened for one
//! color, each change it makes comes back as `#rrggbb` to the one who opened it.

use std::cell::RefCell;

use gpui::App;
use objc2::rc::Retained;
use objc2::runtime::{NSObject, Sel};
use objc2::{MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{NSColor, NSColorPanel, NSColorSpace};

type Heard = Box<dyn Fn(String, &mut App)>;

thread_local! {
    static TARGET: RefCell<Option<Retained<Target>>> = const { RefCell::new(None) };
    static TX: RefCell<Option<futures::channel::mpsc::UnboundedSender<String>>> = const { RefCell::new(None) };
    static HEARD: RefCell<Option<Heard>> = const { RefCell::new(None) };
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "SwitchColorTarget"]
    struct Target;

    impl Target {
        #[unsafe(method(changed:))]
        fn changed(&self, panel: &NSColorPanel) {
            let c = panel.color();
            let Some(c) = c.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace()) else { return };
            let b = |v: f64| (v.clamp(0., 1.) * 255.).round() as u8;
            let hex = format!("#{:02x}{:02x}{:02x}", b(c.redComponent()), b(c.greenComponent()), b(c.blueComponent()));
            TX.with(|t| {
                if let Some(t) = t.borrow().as_ref() {
                    let _ = t.unbounded_send(hex);
                }
            });
        }
    }
);

fn color_of(hex: &str) -> Retained<NSColor> {
    let v = u32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap_or(0);
    let c = |s: u32| ((v >> s) & 0xff) as f64 / 255.;
    NSColor::colorWithSRGBRed_green_blue_alpha(c(16), c(8), c(0), 1.)
}

/// Opens the panel at `hex`; what it's changed to goes to `heard` until another opens it.
pub fn open(hex: &str, heard: impl Fn(String, &mut App) + 'static, cx: &mut App) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    HEARD.with(|h| *h.borrow_mut() = Some(Box::new(heard)));
    let fresh = TX.with(|t| t.borrow().is_none());
    if fresh {
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<String>();
        TX.with(|t| *t.borrow_mut() = Some(tx));
        cx.spawn(async move |cx| {
            use futures::StreamExt;
            while let Some(hex) = rx.next().await {
                cx.update(|cx| {
                    let f = HEARD.with(|h| h.borrow_mut().take());
                    if let Some(f) = f {
                        f(hex, cx);
                        HEARD.with(|h| {
                            if h.borrow().is_none() {
                                *h.borrow_mut() = Some(f);
                            }
                        });
                    }
                });
            }
        })
        .detach();
    }
    let target = TARGET.with(|t| t.borrow_mut().get_or_insert_with(|| unsafe { msg_send![Target::alloc(mtm), init] }).clone());
    let panel = NSColorPanel::sharedColorPanel(mtm);
    let action: Sel = sel!(changed:);
    unsafe {
        panel.setTarget(None);
        panel.setColor(&color_of(hex));
        panel.setTarget(Some(&target));
        panel.setAction(Some(action));
        panel.setContinuous(true);
        panel.orderFront(None);
    }
}
