//! Math in an agent's words, found as on every surface (packages/gateway/src/math/split.ts, the
//! iPhone's MathSplit.swift; all three checked against that folder's cases.json): `$$…$$` is a
//! formula on its own, `$…$` one in the words only when its dollars hug it (no space after the
//! opening one, none before the closing one, no digit right after it), so "$215" and "costs $5
//! and $10" stay money; `\$` is a dollar, and nothing in code is math.
//!
//! Each formula is held out of the Markdown as a character of the private use area (`tokened`),
//! so its `_` and `\` stay TeX's, and drawn in its place: laid out by RaTeX as KaTeX lays it out,
//! its glyphs outlined into an SVG and rasterized by gpui's SVG renderer, in the words' ink.
//! Each drawing is kept, so a reply that streams lays a formula out once; one RaTeX can't read
//! shows as its TeX.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use gpui::{App, DevicePixels, Hsla, RenderImage, SvgSize, size};

/// The private use area's characters stand in for formulas, the first for the first.
const FIRST: u32 = 0xE000;
const LAST: u32 = 0xF8FF;

/// A formula in the words beside them is drawn this much larger than they are, as KaTeX's
/// `.katex { font-size: 1.21em }`.
pub const INLINE_SCALE: f32 = 1.21;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Text,
    Inline,
    Display,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Segment {
    pub kind: Kind,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Formula {
    pub tex: String,
    pub display: bool,
}

impl Formula {
    /// As it was written.
    pub fn written(&self) -> String {
        if self.display { format!("$${}$$", self.tex) } else { format!("${}$", self.tex) }
    }
}

fn space(c: Option<char>) -> bool {
    matches!(c, Some(' ' | '\t' | '\n' | '\r'))
}

fn digit(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_digit())
}

/// The words, their formulas found.
pub fn split(text: &str) -> Vec<Segment> {
    let s: Vec<char> = text.chars().collect();
    let at = |i: usize| s.get(i).copied();
    let slice = |a: usize, b: usize| s[a.min(s.len())..b.min(s.len())].iter().collect::<String>();
    let line_end = |from: usize| (from..s.len()).find(|&i| s[i] == '\n');
    let fence_end = |start: usize| -> Option<usize> {
        let mut i = start;
        while i < start + 3 && at(i) == Some(' ') {
            i += 1;
        }
        let mark = at(i).filter(|c| *c == '`' || *c == '~')?;
        let mut run = 0;
        while at(i + run) == Some(mark) {
            run += 1;
        }
        if run < 3 {
            return None;
        }
        let mut line = line_end(i);
        while let Some(l) = line {
            let mut j = l + 1;
            while j < l + 4 && at(j) == Some(' ') {
                j += 1;
            }
            let mut close = 0;
            while at(j + close) == Some(mark) {
                close += 1;
            }
            if close >= run {
                return Some(line_end(j + close).unwrap_or(s.len()));
            }
            line = line_end(l + 1);
        }
        Some(s.len())
    };
    let code_end = |start: usize, run: usize| -> Option<usize> {
        let mut i = start + run;
        while i < s.len() {
            if s[i] == '`' {
                let mut n = 0;
                while at(i + n) == Some('`') {
                    n += 1;
                }
                if n == run {
                    return Some(i + n);
                }
                i += n;
            } else {
                i += 1;
            }
        }
        None
    };
    let display_end = |from: usize| -> Option<usize> {
        let mut i = from;
        while i + 1 < s.len() {
            if s[i] == '\\' {
                i += 2;
            } else if s[i] == '$' && s[i + 1] == '$' {
                return Some(i);
            } else {
                i += 1;
            }
        }
        None
    };
    let inline_end = |start: usize| -> Option<usize> {
        if space(at(start + 1)) || at(start + 1) == Some('$') || start + 1 >= s.len() {
            return None;
        }
        let mut i = start + 1;
        while i < s.len() {
            match s[i] {
                '\\' => i += 2,
                '\n' => {
                    let mut j = i + 1;
                    while matches!(at(j), Some(' ' | '\t' | '\r')) {
                        j += 1;
                    }
                    if at(j) == Some('\n') || j >= s.len() {
                        return None;
                    }
                    i += 1;
                }
                '$' => return if space(at(i - 1)) || digit(at(i + 1)) { None } else { Some(i) },
                _ => i += 1,
            }
        }
        None
    };

    let mut out = vec![];
    let mut words = String::new();
    let put = |out: &mut Vec<Segment>, words: &mut String, kind: Kind, math: String| {
        if !words.is_empty() {
            out.push(Segment { kind: Kind::Text, text: std::mem::take(words) });
        }
        out.push(Segment { kind, text: math });
    };
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        if (i == 0 || s[i - 1] == '\n')
            && let Some(end) = fence_end(i)
        {
            words.push_str(&slice(i, end));
            i = end;
            continue;
        }
        if c == '\\' {
            words.push_str(&slice(i, i + 2));
            i += 2;
        } else if c == '`' {
            let mut run = 0;
            while at(i + run) == Some('`') {
                run += 1;
            }
            let end = code_end(i, run).unwrap_or(i + run);
            words.push_str(&slice(i, end));
            i = end;
        } else if c == '$' && at(i + 1) == Some('$') {
            let end = display_end(i + 2);
            let math = end.map(|e| slice(i + 2, e).trim().to_string()).unwrap_or_default();
            match end {
                Some(e) if !math.is_empty() => {
                    put(&mut out, &mut words, Kind::Display, math);
                    i = e + 2;
                }
                _ => {
                    words.push_str("$$");
                    i += 2;
                }
            }
        } else if c == '$' {
            match inline_end(i) {
                Some(e) => {
                    put(&mut out, &mut words, Kind::Inline, slice(i + 1, e));
                    i = e + 1;
                }
                None => {
                    words.push('$');
                    i += 1;
                }
            }
        } else {
            words.push(c);
            i += 1;
        }
    }
    if !words.is_empty() {
        out.push(Segment { kind: Kind::Text, text: words });
    }
    out
}

/// The words with each formula a character standing in for it, and the formulas. A `$$` formula
/// on lines of its own is a paragraph of its own, which `alone` finds.
pub fn tokened(text: &str) -> (String, Vec<Formula>) {
    let segments = split(text);
    if segments.iter().all(|s| s.kind == Kind::Text) {
        return (text.to_string(), vec![]);
    }
    let mut formulas = vec![];
    let mut out = String::with_capacity(text.len());
    for (n, s) in segments.iter().enumerate() {
        if s.kind == Kind::Text {
            out.push_str(&s.text);
            continue;
        }
        let formula = Formula { tex: s.text.clone(), display: s.kind == Kind::Display };
        let Some(token) = char::from_u32(FIRST + formulas.len() as u32).filter(|c| (*c as u32) <= LAST) else {
            out.push_str(&formula.written());
            continue;
        };
        let before = n.checked_sub(1).and_then(|b| segments.get(b));
        let after = segments.get(n + 1);
        let own = formula.display && before.is_none_or(|b| b.text.ends_with('\n')) && after.is_none_or(|a| a.text.starts_with('\n'));
        formulas.push(formula);
        if own {
            out.push_str("\n\n");
            out.push(token);
            out.push_str("\n\n");
        } else {
            out.push(token);
        }
    }
    (out, formulas)
}

/// The formula `c` stands in for.
pub fn formula_of(c: char, formulas: &[Formula]) -> Option<&Formula> {
    let n = (c as u32).checked_sub(FIRST)? as usize;
    formulas.get(n)
}

/// The `$$` formula some words are, when they're that alone.
pub fn alone<'a>(words: &str, formulas: &'a [Formula]) -> Option<&'a Formula> {
    let mut chars = words.trim().chars();
    let c = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    formula_of(c, formulas).filter(|f| f.display)
}

/// A formula drawn: its picture, and its size in the window's pixels, from its baseline.
pub struct Drawn {
    pub image: Arc<RenderImage>,
    pub width: f32,
    /// Above the baseline.
    pub height: f32,
    /// Below it.
    pub depth: f32,
}

/// Room round a drawing so its edges aren't cut, in the window's pixels.
const PAD: f32 = 1.;

type DrawnKey = (String, bool, u32, u32, u32);

thread_local! {
    /// Every formula drawn, by its TeX, style, size, ink and the screen's scale; none when RaTeX
    /// can't read it. Kept for the app's life: a formula is drawn once however often it shows.
    static DRAWN: RefCell<HashMap<DrawnKey, Option<Rc<Drawn>>>> = RefCell::new(HashMap::new());
}

/// `tex` drawn at `font_size` (the window's pixels a em) in `color`, for a screen of `scale`.
pub fn draw(tex: &str, display: bool, font_size: f32, color: Hsla, scale: f32, cx: &App) -> Option<Rc<Drawn>> {
    let rgba = color.to_rgb();
    let ink = u32::from_be_bytes([rgba.r, rgba.g, rgba.b, rgba.a].map(|v| (v.clamp(0., 1.) * 255.).round() as u8));
    let key = (tex.to_string(), display, (font_size * 8.).round() as u32, ink, (scale * 8.).round() as u32);
    if let Some(d) = DRAWN.with(|d| d.borrow().get(&key).cloned()) {
        return d;
    }
    let made = render(tex, display, font_size, rgba, scale, cx).map(Rc::new);
    DRAWN.with(|d| d.borrow_mut().insert(key, made.clone()));
    made
}

fn render(tex: &str, display: bool, font_size: f32, rgba: gpui::Rgba, scale: f32, cx: &App) -> Option<Drawn> {
    use ratex_types::{Color, MathStyle};
    let nodes = ratex_parser::parse(tex).ok()?;
    let options = ratex_layout::LayoutOptions::default()
        .with_style(if display { MathStyle::Display } else { MathStyle::Text })
        .with_color(Color::new(rgba.r, rgba.g, rgba.b, rgba.a));
    let laid = ratex_layout::layout(&nodes, &options);
    ratex_layout::validate_layout(&laid).ok()?;
    let list = ratex_layout::to_display_list(&laid);
    let em = f64::from(font_size);
    let svg = ratex_svg::render_to_svg_with_color_syntax(
        &list,
        &ratex_svg::SvgOptions { font_size: em, padding: f64::from(PAD), stroke_width: em / 40. * 1.5, embed_glyphs: true, font_dir: String::new() },
        ratex_svg::SvgColorSyntax::Rgb,
    );
    let width = (list.width * em) as f32 + 2. * PAD;
    let height = (list.height * em) as f32 + PAD;
    let depth = (list.depth * em) as f32 + PAD;
    if !(width > 0. && height + depth > 0.) {
        return None;
    }
    let renderer = cx.svg_renderer();
    let parsed = renderer.parse_svg(svg.as_bytes()).ok()?;
    let pixels = size(DevicePixels((width * scale).ceil() as i32), DevicePixels(((height + depth) * scale).ceil() as i32));
    let image = renderer.render_parsed(&parsed, SvgSize::ExactSize(pixels)).ok()?;
    Some(Drawn { image, width, height, depth })
}

#[cfg(test)]
mod tests {
    use super::{Formula, Kind, alone, split, tokened};

    #[derive(serde::Deserialize)]
    struct Case {
        #[serde(rename = "in")]
        input: String,
        out: Vec<(String, String)>,
    }

    #[test]
    fn math_is_found_as_on_every_surface() {
        let cases: Vec<Case> = serde_json::from_str(include_str!("../../../packages/gateway/src/math/cases.json")).expect("cases");
        for c in cases {
            let got: Vec<(String, String)> = split(&c.input)
                .into_iter()
                .map(|s| {
                    let kind = match s.kind {
                        Kind::Text => "text",
                        Kind::Inline => "inline",
                        Kind::Display => "display",
                    };
                    (kind.to_string(), s.text)
                })
                .collect();
            assert_eq!(got, c.out, "{:?}", c.input);
        }
    }

    #[test]
    fn a_formula_on_its_own_lines_is_a_paragraph() {
        let (text, formulas) = tokened("a\n$$\nx^2\n$$\nb and $y$");
        assert_eq!(formulas, vec![Formula { tex: "x^2".into(), display: true }, Formula { tex: "y".into(), display: false }]);
        assert_eq!(text, "a\n\n\n\u{E000}\n\n\nb and \u{E001}");
        assert!(alone(" \u{E000} ", &formulas).is_some());
        assert!(alone("\u{E001}", &formulas).is_none());
    }
}
