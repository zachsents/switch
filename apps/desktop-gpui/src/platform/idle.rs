//! How long since the last keyboard or pointer input on this Mac (the desktop's `update.ts` read
//! IOKit's HIDIdleTime; old Switchboard's `native.rs` asked Core Graphics, as here).

use objc2_core_graphics::{CGEventSource, CGEventSourceStateID, CGEventType};

pub fn idle_ms() -> f64 {
    // kCGAnyInputEventType: every kind of input.
    CGEventSource::seconds_since_last_event_type(CGEventSourceStateID::CombinedSessionState, CGEventType(u32::MAX)) * 1000.
}
