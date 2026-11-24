//! The chat's own drawings, served as `chat/<name>.svg` beside marks.rs's: Not Delivered's red
//! circle, Copy and its tick, the tapbacks' glyphs, the mic and its keys; and the spinner every
//! press under way shows (`Spin`, eight spokes stepping round on the beat).

use gpui::{Div, Hsla, Pixels, Styled, div, prelude::*, px, svg};

use crate::look::Look;

fn on_16(body: &str) -> String {
    format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">{body}</svg>"#)
}

fn on_256(d: &str) -> String {
    format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 256 256"><path d="{d}" fill="black"/></svg>"#)
}

fn stroked(d: &str, width: f32) -> String {
    on_16(&format!(r#"<path d="{d}" fill="none" stroke="black" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round"/>"#))
}

/// The tapbacks' glyphs that are drawings (the rest are words, drawn as type).
pub const LOVE: &str = "M8 13.6S2.4 10.3 2.4 6.5C2.4 4.4 3.9 3 5.7 3c1 0 1.8.5 2.3 1.3C8.5 3.5 9.3 3 10.3 3c1.8 0 3.3 1.4 3.3 3.5 0 3.8-5.6 7.1-5.6 7.1z";
pub const LIKE: &str = "M2.2 7.2h2.3v6.6H2.2zM5.6 13.8h5.6c.8 0 1.4-.5 1.6-1.3l1-4.1c.2-.9-.5-1.7-1.4-1.7H9.6l.5-2.4c.2-.9-.5-1.8-1.4-1.8L5.6 6.8z";

/// Phosphor's play and pause, bold, as the widgets' kit has them; and arrows-out-simple.
pub const PLAY: &str = "M234.49,111.07,90.41,22.94A20,20,0,0,0,60,39.87V216.13a20,20,0,0,0,30.41,16.93l144.08-88.13a19.82,19.82,0,0,0,0-33.86ZM84,208.85V47.15L216.16,128Z";
pub const FULL: &str = "M220,48V96a12,12,0,0,1-24,0V77l-39.51,39.52a12,12,0,0,1-17-17L179,60H160a12,12,0,0,1,0-24h48A12,12,0,0,1,220,48ZM99.51,139.51,60,179V160a12,12,0,0,0-24,0v48a12,12,0,0,0,12,12H96a12,12,0,0,0,0-24H77l39.52-39.51a12,12,0,0,0-17-17Z";

/// Figures of one width (`tabular-nums`), so sizes and times line up.
pub fn tabular() -> gpui::FontFeatures {
    gpui::FontFeatures(std::sync::Arc::new(vec![("tnum".into(), 1)]))
}

/// A drawing by name, for the app's asset source.
pub fn load(name: &str) -> Option<String> {
    Some(match name {
        "not-delivered" => on_16(r#"<circle cx="8" cy="8" r="7" fill="black"/>"#),
        "not-delivered-glyph" => on_16(r#"<path d="M8 4.2 V8.9" fill="none" stroke="black" stroke-width="1.75" stroke-linecap="round"/><circle cx="8" cy="11.5" r="1" fill="black"/>"#),
        "copy" => on_16(r#"<g fill="none" stroke="black" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 3.5v-1h-8v8h1"/></g>"#),
        "copied" => stroked("M3 8l3 3 7-7", 1.4),
        "love" => on_16(&format!(r#"<path d="{LOVE}" fill="black"/>"#)),
        "like" => on_16(&format!(r#"<path d="{LIKE}" fill="black"/>"#)),
        "dislike" => on_16(&format!(r#"<path transform="rotate(180 8 8)" d="{LIKE}" fill="black"/>"#)),
        "mic" => on_16(r#"<g fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25"/><path d="M3.25 7.5 a4.75 4.75 0 0 0 9.5 0 M8 12.25 V14.5"/></g>"#),
        "cancel" => stroked("M4 4 L12 12 M12 4 L4 12", 1.5),
        "done" => stroked("M3.5 8.5 L6.5 11.5 L12.5 4.5", 1.5),
        "play" => on_256(PLAY),
        "full" => on_256(FULL),
        _ => return None,
    })
}

pub fn drawn(name: &str, size: Pixels, color: Hsla) -> gpui::Svg {
    svg().path(format!("chat/{name}.svg")).flex_none().size(size).text_color(color)
}

/// Not delivered: iMessage's red circle with "!".
pub fn not_delivered(size: Pixels, l: &Look) -> Div {
    div()
        .relative()
        .flex_none()
        .size(size)
        .child(drawn("not-delivered", size, l.red).absolute().top_0().left_0())
        .child(drawn("not-delivered-glyph", size, l.white).absolute().top_0().left_0())
}

/// Loading, or a press under way: eight grey spokes stepping round, a turn a second.
pub fn spin(size: Pixels, color: Hsla, step: usize) -> gpui::Svg {
    svg().path(format!("spin/{}.svg", step % 8)).flex_none().size(size).text_color(color)
}

/// The spinner at the house's 12 px in ink3.
pub fn spin12(l: &Look, step: usize) -> gpui::Svg {
    spin(px(12.), l.ink3, step)
}
