//! The marks every screen shares (SIS rev D, the desktop's `ui/marks.tsx`; drawn as old
//! Switchboard's `mac/src/ui/marks.rs` drew them in gpui): needs you a yellow hand, live an orange
//! runner, stopped a red octagon, loading grey spokes; a space's ring a station on its line. Each
//! drawing is an SVG the app serves itself (`Assets`), painted in one color by gpui.

use std::borrow::Cow;

use gpui::{AssetSource, Div, FontWeight, Hsla, ParentElement, Pixels, SharedString, Styled, div, prelude::*, px, svg};

use crate::look::{Look, SANS};
use crate::step_icons;

const DRAWINGS: &[(&str, &str)] = &[
    ("hand", r#"<g fill="none" stroke="black" stroke-linecap="round" stroke-width="1.9"><path d="M4.75 4.4 V9"/><path d="M7.35 2.7 V9"/><path d="M9.95 2.95 V9"/><path d="M12.45 4.7 V9"/><path d="M5.1 11.1 L2.55 8.35" stroke-width="2.1"/></g><path d="M3.8 8 H13.4 V10.6 C13.4 13.1 11.6 14.9 9.1 14.9 H8.2 C5.7 14.9 3.8 13.1 3.8 10.6 Z" fill="black"/>"#),
    ("stop", r#"<path d="M14.42 10.66 L10.66 14.42 L5.34 14.42 L1.58 10.66 L1.58 5.34 L5.34 1.58 L10.66 1.58 L14.42 5.34 Z" fill="black" stroke="black" stroke-width="1.1" stroke-linejoin="round"/>"#),
    ("stop-glyph", r#"<path d="M5.1 8 H10.9" fill="none" stroke="black" stroke-width="1.75" stroke-linecap="round"/>"#),
    ("updown", r#"<path d="M11 10H5l3 3.5zm0-4H5l3-3.5z" fill="black"/>"#),
    ("check", r#"<path d="m2.5 8.5 4 4 7-9" fill="none" stroke="black" stroke-width="1.75"/>"#),
    ("back", r#"<path d="M10 3.33 L5.33 8 L10 12.67" fill="none" stroke="black" stroke-width="2.27" stroke-linecap="round" stroke-linejoin="round"/>"#),
    ("forward", r#"<path d="M6 3.33 L10.67 8 L6 12.67" fill="none" stroke="black" stroke-width="2.27" stroke-linecap="round" stroke-linejoin="round"/>"#),
    ("tick", r#"<path d="M3 8.6 L6.4 12 L13 4.6" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>"#),
    ("sent", r#"<path d="M14 2 L1.8 7.3 L6.9 9.1 Z M14 2 L8.7 14.2 L6.9 9.1" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>"#),
    ("declined", r#"<path d="M4 4 L12 12 M12 4 L4 12" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>"#),
    ("dismissed", r#"<path d="M3.5 8 H12.5" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>"#),
    ("warn", r#"<path d="M8 1.9 L14.6 13.9 H1.4 Z" fill="black" stroke="black" stroke-width="1.5" stroke-linejoin="round"/>"#),
    ("warn-glyph", r#"<path d="M8 6.1 V9.6" fill="none" stroke="black" stroke-width="1.75" stroke-linecap="round"/><circle cx="8" cy="11.85" r="1" fill="black"/>"#),
    ("check", r#"<path d="m2.5 8.5 4 4 7-9" fill="none" stroke="black" stroke-width="1.75"/>"#),
    ("house", r#"<g transform="translate(3 3) scale(0.625)" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 7.6 L8 2.9 L13.4 7.6"/><path d="M4.4 6.3 V13.1 H11.6 V6.3"/><path d="M6.6 13.1 V9.6 H9.4 V13.1"/></g>"#),
];

/// The tail on a bubble's bottom corner, on its own 24 × 18 grid.
const TAIL: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="18" viewBox="0 0 24 18"><path d="M18 0C18 9 19 14 24 18C19 18.5 15 17.5 12 15.5C10 17 6 18 0 18L0 0Z" fill="black"/></svg>"#;
const TAIL_LEFT: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="18" viewBox="0 0 24 18"><g transform="translate(24 0) scale(-1 1)"><path d="M18 0C18 9 19 14 24 18C19 18.5 15 17.5 12 15.5C10 17 6 18 0 18L0 0Z" fill="black"/></g></svg>"#;

/// The blips' marks, 12 px, one stroke.
const BLIPS: &[(&str, &str)] = &[("event", "M7 1.5L3 7h3l-1 3.5L9 5H6z"), ("learned", "M3 1.5h6v9L6 8.5 3 10.5z")];

fn svg_of(body: &str) -> String {
    format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">{body}</svg>"#)
}

// The run cycle, a leg's pose at each step: the thigh's swing from straight down (forward is
// positive) and how far the knee folds the shin back, in degrees.
const THIGH: [f32; 8] = [30., 4., -26., -40., -10., 30., 52., 44.];
const KNEE: [f32; 8] = [16., 40., 20., 95., 122., 100., 62., 26.];
const BOUNCE: [f32; 8] = [0., 0.45, 0.15, -0.35, 0., 0.45, 0.15, -0.35];
pub const RUN_STEPS: usize = 8;

/// The runner at `step` of the run cycle; `weight` its strokes (1.9 running, 1.6 at rest).
fn runner(step: usize, weight: f32, parted: bool) -> String {
    let at = |(x, y): (f32, f32), degrees: f32, length: f32| {
        let a = degrees.to_radians();
        (x + length * a.sin(), y + length * a.cos())
    };
    let step = step % RUN_STEPS;
    let hip = (7.2, 8.4 + BOUNCE[step]);
    let shoulder = at(hip, 166., 3.9);
    let head = at(shoulder, 158., 2.45);
    let leg = |k: usize| {
        let knee = at(hip, THIGH[k], 3.1);
        [hip, knee, at(knee, THIGH[k] - KNEE[k], 3.2)]
    };
    let arm = |k: usize| {
        let swing = 4. - 1.2 * THIGH[k];
        let elbow = at(shoulder, swing, 2.6);
        [shoulder, elbow, at(elbow, swing + 88., 2.2)]
    };
    let other = (step + RUN_STEPS / 2) % RUN_STEPS;
    let (near, far) = ([leg(step), arm(other)], [leg(other), arm(step)]);
    let line = |points: &[(f32, f32)], width: f32| {
        let d: Vec<String> = points.iter().map(|(x, y)| format!("{x:.2} {y:.2}")).collect();
        format!(r#"<path d="M{}" fill="none" stroke="black" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round"/>"#, d.join(" L"))
    };
    let gap: String = near.iter().map(|l| line(l, 3.)).collect();
    let behind: String = far.iter().map(|l| line(l, weight)).collect();
    let before: String = near.iter().map(|l| line(l, weight)).collect();
    let torso = line(&[shoulder, hip], weight);
    let r = if weight > 1.7 { 1.7 } else { 1.6 };
    let far_part = if parted {
        format!(r#"<mask id="part" maskUnits="userSpaceOnUse" x="-2" y="-2" width="20" height="20"><rect x="-2" y="-2" width="20" height="20" fill="white"/>{gap}</mask><g mask="url(#part)">{behind}</g>"#)
    } else {
        behind
    };
    svg_of(&format!(r#"{far_part}{torso}<circle cx="{:.2}" cy="{:.2}" r="{r}" fill="black"/>{before}"#, head.0, head.1))
}

/// Eight spokes, the latest darkest, turned to `step`.
fn spokes(step: usize) -> String {
    let body: String = (0..8)
        .map(|i| {
            let opacity = 0.25 + 0.75 * ((i + 8 - step) % 8) as f32 / 7.;
            format!(r#"<path d="M8 1.8 V4.6" transform="rotate({} 8 8)" stroke="black" stroke-width="1.8" stroke-linecap="round" opacity="{opacity:.2}"/>"#, i * 45)
        })
        .collect();
    svg_of(&body)
}

fn on_256(d: &str) -> String {
    format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 256 256"><path d="{d}" fill="black"/></svg>"#)
}

/// The app's own drawings, by path: `marks/<name>.svg`, `run/<step>.svg`, `rest.svg`,
/// `spin/<step>.svg`, `step/<icon>.svg`, `blip/<mark>.svg`, `tail/{left,right}.svg`, `media/<glyph>.svg`.
pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> gpui::Result<Option<Cow<'static, [u8]>>> {
        let owned = |s: String| Some(Cow::Owned(s.into_bytes()));
        let path = path.strip_suffix(".svg").unwrap_or(path);
        let found = if let Some(name) = path.strip_prefix("marks/") {
            DRAWINGS.iter().find(|(n, _)| *n == name).and_then(|(_, b)| owned(svg_of(b)))
        } else if let Some(step) = path.strip_prefix("run/") {
            owned(runner(step.parse().unwrap_or(0), 1.9, true))
        } else if path == "rest" {
            owned(runner(1, 1.6, false))
        } else if let Some(step) = path.strip_prefix("spin/") {
            owned(spokes(step.parse().unwrap_or(0)))
        } else if let Some(icon) = path.strip_prefix("step/") {
            step_icons::PATHS.iter().find(|(n, _)| *n == icon).or(step_icons::PATHS.iter().find(|(n, _)| *n == "lightning")).and_then(|(_, d)| owned(on_256(d)))
        } else if path == "caret/open" {
            owned(on_256(step_icons::CARET_OPEN))
        } else if path == "caret/shut" {
            owned(on_256(step_icons::CARET_SHUT))
        } else if let Some(mark) = path.strip_prefix("blip/") {
            BLIPS.iter().find(|(n, _)| *n == mark).and_then(|(_, d)| {
                owned(format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><path d="{d}" fill="none" stroke="black" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>"#))
            })
        } else if let Some(name) = path.strip_prefix("icon/") {
            // A widget's icon (widgets/basic/icons.rs), on Phosphor's 256 box.
            crate::widgets::basic::icons::icon(name).and_then(|d| owned(on_256(d)))
        } else if let Some(hex) = path.strip_prefix("path24/") {
            // A widget's own `svgPath`, on A2UI's 24 box, its path hex-coded in the asset's name.
            let bytes: Option<Vec<u8>> = (0..hex.len()).step_by(2).map(|i| hex.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok())).collect();
            bytes.and_then(|b| String::from_utf8(b).ok()).and_then(|d| {
                owned(format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><path d="{d}" fill="black"/></svg>"#))
            })
        } else if let Some(name) = path.strip_prefix("chat/") {
            crate::chat_marks::load(name).and_then(owned)
        } else if let Some(name) = path.strip_prefix("media/") {
            crate::media::glyph(name).and_then(|d| owned(on_256(d)))
        } else if path == "tail/right" {
            owned(TAIL.into())
        } else if path == "tail/left" {
            owned(TAIL_LEFT.into())
        } else {
            None
        };
        Ok(found)
    }

    fn list(&self, _path: &str) -> gpui::Result<Vec<SharedString>> {
        Ok(vec![])
    }
}

fn drawn(path: impl Into<SharedString>, size: Pixels, color: Hsla) -> gpui::Svg {
    svg().path(path).flex_none().size(size).text_color(color)
}

/// A select's ⌃⌄ and an option's check.
pub fn updown(size: Pixels, color: Hsla) -> gpui::Svg {
    drawn("marks/updown.svg", size, color)
}

pub fn check(size: Pixels, color: Hsla) -> gpui::Svg {
    drawn("marks/check.svg", size, color)
}

/// The band's ‹ and ›, 12 px.
pub fn arrow(back: bool, size: Pixels, color: Hsla) -> gpui::Svg {
    drawn(if back { "marks/back.svg" } else { "marks/forward.svg" }, size, color)
}

/// Needs you: a raised right hand, palm out.
pub fn hand(size: Pixels, l: &Look) -> gpui::Svg {
    drawn("marks/hand.svg", size, l.yellow)
}

/// Didn't finish, or can't: a red octagon.
pub fn stop(size: Pixels, l: &Look) -> Div {
    div()
        .relative()
        .flex_none()
        .size(size)
        .child(drawn("marks/stop.svg", size, l.red).absolute().top_0().left_0())
        .when(size > px(10.), |el| el.child(drawn("marks/stop-glyph.svg", size, l.white).absolute().top_0().left_0()))
}

/// Running: the orange runner, at the beat's step.
pub fn runner_mark(size: Pixels, step: usize, color: Hsla) -> gpui::Svg {
    drawn(format!("run/{}.svg", step % RUN_STEPS), size, color)
}

/// Done: the runner at rest, in grey.
pub fn rested(size: Pixels, l: &Look) -> gpui::Svg {
    drawn("rest.svg", size, l.ink3)
}

/// A reply not yet read: a small dot after the name.
pub fn unread(color: Hsla) -> Div {
    div().flex_none().size(px(7.)).rounded_full().bg(color)
}

/// A step's mark, 14 at the text's size (the page's zoom scales it, as the desktop's does).
pub fn step_icon(icon: &str, color: Hsla, size: Pixels) -> gpui::Svg {
    drawn(format!("step/{icon}.svg"), size, color)
}

/// A fold's caret, 10 at the text's size.
pub fn caret(open: bool, color: Hsla, size: Pixels) -> gpui::Svg {
    drawn(if open { "caret/open.svg" } else { "caret/shut.svg" }, size, color)
}

pub fn blip(mark: &str, color: Hsla) -> gpui::Svg {
    drawn(format!("blip/{mark}.svg"), px(12.), color)
}

/// A space's ring, `size` across: its code in its ink on `fill`, set in `type_ink`; Home's holds a
/// house.
pub fn ring(code: &str, ink: Hsla, size: Pixels, fill: Hsla, type_ink: Hsla, home: bool) -> Div {
    let split = code.find(|c: char| c.is_ascii_digit()).unwrap_or(code.len());
    let (letter, number) = code.split_at(split);
    let unit = size / 16.;
    let wide = letter.chars().count() > 1;
    // A line of type centred `center` units down, as SVG's central baseline sets it.
    let words = |center: f32, text_size: f32, text: &str| {
        let height = unit * text_size * 1.4;
        div()
            .absolute()
            .left_0()
            .right_0()
            .top(unit * center - height / 2.)
            .h(height)
            .flex()
            .items_center()
            .justify_center()
            .font_family(SANS)
            .text_size(unit * text_size)
            .line_height(height)
            .font_weight(FontWeight::BOLD)
            .child(SharedString::from(text.to_string()))
    };
    div()
        .relative()
        .flex_none()
        .size(size)
        .text_color(type_ink)
        .whitespace_nowrap()
        .child(div().absolute().size_full().rounded_full().bg(fill).border(unit * 2.3).border_color(ink))
        .when(home, |el| el.child(drawn("marks/house.svg", size, ink).absolute().top_0().left_0()))
        .map(|el| match (letter.is_empty(), number.is_empty()) {
            (true, _) => el,
            (false, true) => el.child(words(8.15, if wide { 5.6 } else { 7.4 }, letter)),
            (false, false) => el.child(words(5.75, if wide { 3.7 } else { 4.3 }, letter)).child(words(10.35, 5.3, number)),
        })
}

/// How a closed ask ended (ask-ending.tsx): sent a paper plane, approved or done a tick, declined a
/// cross, waved off a dash, in the supporting ink; what Approve ran failing is a stop.
pub fn ending(e: crate::items::Ending, size: Pixels, l: &Look) -> gpui::AnyElement {
    use crate::items::Ending;
    let name = match e {
        Ending::Sent => "sent",
        Ending::Approved | Ending::Done => "tick",
        Ending::Declined => "declined",
        Ending::Dismissed => "dismissed",
        Ending::Failed => return stop(size, l).into_any_element(),
    };
    drawn(format!("marks/{name}.svg"), size, l.ink2).into_any_element()
}

/// Didn't go as expected: a red triangle.
pub fn warn(size: Pixels, l: &Look) -> Div {
    div()
        .relative()
        .flex_none()
        .size(size)
        .child(drawn("marks/warn.svg", size, l.red).absolute().top_0().left_0())
        .when(size > px(10.), |el| el.child(drawn("marks/warn-glyph.svg", size, l.white).absolute().top_0().left_0()))
}
