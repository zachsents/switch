//! Switch's look (DESIGN.md, `index.css`, `ui/theme.ts`): one background, the three
//! lines, the words' three inks worked out from the background, the lamps, the green key, and the
//! text size. The theme (`theme.rs`: the brain's `pref theme`, this Mac's copy until it comes) sets
//! it, its side for the appearance shown (the system's when the theme follows the system).

use gpui::{App, Global, Hsla, Rems, rems, rgb};

use crate::derive::{Station, hex};
use crate::theme::{Appearance, Theme, zoom_of};

#[derive(Clone, Copy)]
pub struct Look {
    pub dark: bool,
    pub bg: Hsla,
    pub hover: Hsla,
    pub line1: Hsla,
    pub line_section: Hsla,
    pub line2: Hsla,
    pub w1: f32,
    pub w_section: f32,
    pub w2: f32,
    pub ink: Hsla,
    pub ink2: Hsla,
    pub ink3: Hsla,
    pub home: Hsla,
    pub bubble: Hsla,
    pub key_border: Hsla,
    /// A raised key's light along its top and the drop under it.
    pub key_light: Hsla,
    pub key_drop: Hsla,
    pub go: Hsla,
    pub go_press: Hsla,
    pub go_border: Hsla,
    pub go_drop: Hsla,
    pub yellow: Hsla,
    pub orange: Hsla,
    pub red: Hsla,
    pub white: Hsla,
    pub black: Hsla,
    /// How much text and everything with it are scaled.
    pub zoom: f32,
}

impl Global for Look {}

pub const SIGN: &str = "DIN Condensed";
pub const SANS: &str = ".SystemUIFont";
pub const MONO: &str = "Menlo";

/// A length on the 16 px rem, so the theme's text size scales everything.
pub fn u(px: f32) -> Rems {
    rems(px / 16.)
}

fn rgb_of(h: u32) -> [f32; 3] {
    [((h >> 16) & 0xff) as f32, ((h >> 8) & 0xff) as f32, (h & 0xff) as f32]
}

fn of_rgb(c: [f32; 3]) -> u32 {
    let b = |v: f32| v.round().clamp(0., 255.) as u32;
    (b(c[0]) << 16) | (b(c[1]) << 8) | b(c[2])
}

/// `a` moved `t` of the way to `b`.
pub fn mix(a: u32, b: u32, t: f32) -> u32 {
    let (x, y) = (rgb_of(a), rgb_of(b));
    of_rgb([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t])
}

fn luminance(h: u32) -> f32 {
    let c = rgb_of(h).map(|v| {
        let s = v / 255.;
        if s <= 0.03928 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
    });
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

pub fn contrast(a: u32, b: u32) -> f32 {
    let (la, lb) = (luminance(a), luminance(b));
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

/// The words' three inks on a background: full (the theme's own, else near black or white),
/// supporting and meta, each at least its contrast.
pub fn inks(bg: u32, own: Option<u32>) -> (u32, u32, u32) {
    let ink = own.unwrap_or(if luminance(bg) > 0.18 { 0x0a0a0a } else { 0xededed });
    let toward = |least: f32| {
        let mut best = ink;
        let mut t = 0.;
        while t <= 0.9 {
            let c = mix(ink, bg, t);
            if contrast(c, bg) >= least {
                best = c;
            }
            t += 0.02;
        }
        best
    };
    (ink, toward(7.), toward(4.5))
}

fn h(c: u32) -> Hsla {
    rgb(c).into()
}

impl Look {
    /// The theme in the window's appearance when the theme follows the system.
    pub fn of(t: &Theme, system_dark: bool) -> Self {
        let dark = match t.appearance {
            Appearance::Dark => true,
            Appearance::Light => false,
            Appearance::System => system_dark,
        };
        Look::of_side(t, dark)
    }

    /// The theme in an appearance, its side for it.
    pub fn of_side(t: &Theme, dark: bool) -> Self {
        let s = t.side(dark);
        let bg = hex(&s.bg).unwrap_or(0);
        let line1 = hex(&s.line1.color).unwrap_or(0);
        let line2 = hex(&s.line2.color).unwrap_or(0);
        let section = s.section_line();
        let (ink, ink2, ink3) = inks(bg, s.ink.as_deref().and_then(hex));
        let go = hex(&s.go).unwrap_or(0x1f8a5e);
        let on_dark = luminance(bg) <= 0.18;
        Look {
            dark,
            bg: h(bg),
            hover: h(mix(bg, ink, 0.08)),
            line1: h(line1),
            line_section: h(hex(&section.color).unwrap_or(0)),
            line2: h(line2),
            w1: s.line1.w,
            w_section: section.w,
            w2: s.line2.w,
            ink: h(ink),
            ink2: h(ink2),
            ink3: h(ink3),
            home: h(if dark { 0x3d3d3d } else { 0x4a4a4a }),
            bubble: h(mix(bg, ink, if dark { 0.12 } else { 0.09 })),
            key_border: h(if on_dark { mix(bg, 0xffffff, 0.22) } else { mix(bg, 0x000000, 0.42) }),
            key_light: h(mix(bg, 0xffffff, if on_dark { 0.16 } else { 1. })),
            key_drop: h(mix(bg, 0x000000, if on_dark { 1. } else { 0.32 })),
            go: h(go),
            go_press: h(mix(go, 0, 0.2)),
            go_border: h(mix(go, 0, 0.45)),
            go_drop: h(mix(go, 0, 0.6)),
            yellow: h(hex(&s.needs).unwrap_or(0xffc000)),
            orange: h(hex(&s.running).unwrap_or(0xf26419)),
            red: h(hex(&s.danger).unwrap_or(0xd42a1f)),
            white: h(0xffffff),
            black: h(0x000000),
            zoom: zoom_of(t.size),
        }
    }

    pub fn get(cx: &App) -> Self {
        *cx.global::<Look>()
    }

    /// A station's ink in this appearance; grey for a space on no line.
    pub fn ink_of(&self, st: &Station) -> Hsla {
        match st.ink {
            Some((day, night)) => h(if self.dark { night } else { day }),
            None => self.ink3,
        }
    }

    /// A length scaled with the text size, in px.
    pub fn z(&self, v: f32) -> gpui::Pixels {
        gpui::px(v * self.zoom)
    }
}

/// Tabular figures (`font-variant-numeric: tabular-nums`, the page's default).
pub fn tabular() -> gpui::FontFeatures {
    gpui::FontFeatures(std::sync::Arc::new(vec![("tnum".into(), 1)]))
}
