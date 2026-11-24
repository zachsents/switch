//! A right-click menu drawn natively at the pointer (Electrobun's `ContextMenu`): an NSMenu of the
//! same items as the menu bar's, its choice run as the window's action. It's tracked outside
//! gpui's turn (a task of its own), since AppKit runs the menu's own loop until it closes.

use std::cell::Cell;

use gpui::{Action, App, AsyncWindowContext, Menu, MenuItem, Window};
use objc2::rc::Retained;
use objc2::runtime::{NSObject, Sel};
use objc2::{MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{NSApplication, NSEvent, NSMenu, NSMenuItem};
use objc2_foundation::{NSPoint, NSString};

thread_local! {
    static CHOSEN: Cell<isize> = const { Cell::new(-1) };
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "SwitchMenuTarget"]
    struct Target;

    impl Target {
        #[unsafe(method(chosen:))]
        fn chosen(&self, item: &NSMenuItem) {
            CHOSEN.with(|c| c.set(item.tag()));
        }
    }
);

impl Target {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        unsafe { msg_send![Self::alloc(mtm), init] }
    }
}

fn fill(menu: &NSMenu, items: &[MenuItem], actions: &mut Vec<Box<dyn Action>>, target: &Target, mtm: MainThreadMarker) {
    let action: Sel = sel!(chosen:);
    for i in items {
        match i {
            MenuItem::Separator => menu.addItem(&NSMenuItem::separatorItem(mtm)),
            MenuItem::Submenu(Menu { name, items, .. }) => {
                let title = NSString::from_str(name);
                let item = NSMenuItem::new(mtm);
                item.setTitle(&title);
                let sub = NSMenu::initWithTitle(NSMenu::alloc(mtm), &title);
                sub.setAutoenablesItems(false);
                fill(&sub, items, actions, target, mtm);
                item.setSubmenu(Some(&sub));
                menu.addItem(&item);
            }
            MenuItem::Action { name, action: a, disabled, .. } => {
                let item = unsafe { NSMenuItem::initWithTitle_action_keyEquivalent(NSMenuItem::alloc(mtm), &NSString::from_str(name), Some(action), &NSString::from_str("")) };
                unsafe { item.setTarget(Some(target)) };
                item.setTag(actions.len() as isize);
                item.setEnabled(!disabled);
                actions.push(a.boxed_clone());
                menu.addItem(&item);
            }
            MenuItem::SystemMenu(_) => {}
        }
    }
}

/// Shows `items` at the pointer; what's chosen runs as an action on the window.
pub fn popup(items: Vec<MenuItem>, window: &mut Window, cx: &mut App) {
    window
        .spawn(cx, async move |cx: &mut AsyncWindowContext| {
            let Some(mtm) = MainThreadMarker::new() else { return };
            let menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str(""));
            menu.setAutoenablesItems(false);
            let target = Target::new(mtm);
            let mut actions = vec![];
            fill(&menu, &items, &mut actions, &target, mtm);
            CHOSEN.with(|c| c.set(-1));
            let at: NSPoint = NSEvent::mouseLocation();
            menu.popUpMenuPositioningItem_atLocation_inView(None, at, None);
            let chosen = CHOSEN.with(Cell::get);
            if let Some(a) = usize::try_from(chosen).ok().and_then(|i| actions.get(i)) {
                let a = a.boxed_clone();
                cx.update(|window, cx| window.dispatch_action(a, cx)).ok();
            }
        })
        .detach();
}

/// The standard About panel.
pub fn about() {
    if let Some(mtm) = MainThreadMarker::new() {
        NSApplication::sharedApplication(mtm).orderFrontStandardAboutPanel(None);
    }
}
