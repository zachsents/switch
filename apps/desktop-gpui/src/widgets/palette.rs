//! The colors a widget draws in beyond the look's own (index.css): the charts' series, in order and
//! never cycled, each appearance's own steps, and a magnitude's scale, least to most; and a color
//! as CSS, for a page's theme.

use gpui::{Hsla, Rgba, rgb};

use crate::look::Look;

const SERIES: [(u32, u32); 8] = [
    (0x2a78d6, 0x3987e5),
    (0xeb6834, 0xd95926),
    (0x1baf7a, 0x199e70),
    (0xeda100, 0xc98500),
    (0xe87ba4, 0xd55181),
    (0x008300, 0x008300),
    (0x6250d6, 0x9085e9),
    (0xe34948, 0xe66767),
];

const SCALE: [(u32, u32); 5] = [(0xcde2fb, 0x184f95), (0x9ec5f4, 0x256abf), (0x5598e7, 0x3987e5), (0x256abf, 0x6da7ec), (0x104281, 0xb7d3f6)];

/// The `n`th series' color (from 1), or none past the eighth.
pub fn series(l: &Look, n: usize) -> Option<Hsla> {
    let (day, night) = *SERIES.get(n.checked_sub(1)?)?;
    Some(rgb(if l.dark { night } else { day }).into())
}

/// The scale's `n`th step (from 1, least to most).
pub fn scale(l: &Look, n: usize) -> Hsla {
    let (day, night) = SCALE[n.clamp(1, 5) - 1];
    rgb(if l.dark { night } else { day }).into()
}

/// A color as CSS's `#rrggbb`.
pub fn css(c: Hsla) -> String {
    let r = Rgba::from(c);
    let b = |v: f32| (v * 255.).round().clamp(0., 255.) as u8;
    format!("#{:02x}{:02x}{:02x}", b(r.r), b(r.g), b(r.b))
}

/// This window's theme as a page's variables (page-theme.ts `themeCss`).
pub fn theme_css(l: &Look) -> String {
    let mut vars = vec![
        ("bg", css(l.bg)),
        ("line-1", css(l.line1)),
        ("line-2", css(l.line2)),
        ("ink", css(l.ink)),
        ("ink2", css(l.ink2)),
        ("ink3", css(l.ink3)),
        ("go", css(l.go)),
        ("yellow", css(l.yellow)),
        ("orange", css(l.orange)),
        ("red", css(l.red)),
    ];
    for n in 1..=8 {
        if let Some(c) = series(l, n) {
            vars.push((["series-1", "series-2", "series-3", "series-4", "series-5", "series-6", "series-7", "series-8"][n - 1], css(c)));
        }
    }
    let colors: String = vars.iter().map(|(k, v)| format!("--color-{k}:{v};")).collect();
    let fonts = r#"--font-sans:-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;--font-mono:ui-monospace, "SF Mono", Menlo, monospace;--font-sign:"DIN Condensed", "DINCondensed-Bold", "Barlow Condensed", sans-serif;"#;
    format!(r#"<style id="switch-theme">:root{{color-scheme:{};{colors}{fonts}}}</style>"#, if l.dark { "dark" } else { "light" })
}
