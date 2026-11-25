//! The theme (the desktop's `ui/theme.ts` and `use-theme-sync.ts`): the appearance, a theme for
//! each (its one background, its three lines with their thicknesses, what each state color means),
//! and the text size they share. Kept in the brain (`pref theme`, for every
//! client) and on this Mac (so the window paints it on its first frame); a change shows in every
//! window at once and goes to the brain a moment after the last edit.

use std::path::PathBuf;

use gpui::{App, Global};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::model;
use crate::outbox;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    System,
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Size {
    Small,
    Default,
    Large,
}

/// A line in one appearance: its color and its thickness, 0.5, 1 or 2.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Edge {
    pub color: String,
    pub w: f32,
}

/// One appearance's theme: its background, its three lines and its state colors.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Side {
    pub bg: String,
    /// Between the panes and under the band.
    pub line1: Edge,
    /// Between a rail's sections and between widgets; none has it worked out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<Edge>,
    /// Between rows, and between the chat and its box.
    pub line2: Edge,
    pub go: String,
    pub needs: String,
    pub running: String,
    pub danger: String,
}

/// The appearance, a theme for each, and the text size they share.
#[derive(Clone, Debug, PartialEq)]
pub struct Theme {
    pub appearance: Appearance,
    pub light: Side,
    pub dark: Side,
    pub size: Size,
}

/// A color in each appearance, as the theme was before it had one per appearance.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Pair {
    light: String,
    dark: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Line {
    light: String,
    dark: String,
    w: f32,
}

/// The theme as the brain holds it: each appearance's own, and beside them the one theme it was
/// before (the rollback app's `ui/theme.ts` reads only that), in the colors of the appearance it
/// shows.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Stored {
    appearance: Appearance,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    light: Option<Side>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dark: Option<Side>,
    bg: Pair,
    line1: Line,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    section: Option<Line>,
    line2: Line,
    go: String,
    needs: String,
    running: String,
    danger: String,
    size: Size,
}

pub const PRESET_KEYS: [&str; 4] = ["default", "paper", "contrast", "slate"];

pub fn preset_name(key: &str) -> &'static str {
    match key {
        "paper" => "Paper",
        "contrast" => "Contrast",
        "slate" => "Slate",
        _ => "Default",
    }
}

/// A preset's side for one appearance.
pub fn preset(key: &str, dark: bool) -> Side {
    let edge = |color: &str, w| Edge { color: color.into(), w };
    let side = |(bg, line1, line2): (&str, &str, &str), w2, states: [&str; 4]| Side {
        bg: bg.into(),
        line1: edge(line1, 1.),
        section: None,
        line2: edge(line2, w2),
        go: states[0].into(),
        needs: states[1].into(),
        running: states[2].into(),
        danger: states[3].into(),
    };
    let pick = |light, night| if dark { night } else { light };
    const STATES: [&str; 4] = ["#1f8a5e", "#ffc000", "#f26419", "#d42a1f"];
    match key {
        "paper" => side(pick(("#f3eee3", "#c9bfa9", "#e3dccc"), ("#1b1915", "#3a352b", "#27241e")), 0.5, ["#2f7d4f", "#e0a100", "#d1561c", "#b3261e"]),
        "contrast" => side(pick(("#ffffff", "#000000", "#767676"), ("#000000", "#ffffff", "#8a8a8a")), 1., ["#00a86b", "#ffd400", "#ff7a1a", "#ff3b30"]),
        "slate" => side(pick(("#f4f6f8", "#c3cbd3", "#e1e6eb"), ("#11161c", "#2a3440", "#1b232c")), 0.5, STATES),
        _ => side(pick(("#ffffff", "#c8c8c8", "#e8e8e8"), ("#0d0d0d", "#2c2c2c", "#1c1c1c")), 0.5, STATES),
    }
}

/// The preset a side is, if it's one.
pub fn preset_of(s: &Side, dark: bool) -> Option<&'static str> {
    let whole = |s: &Side| Side { section: Some(s.section_line()), ..s.clone() };
    PRESET_KEYS.into_iter().find(|k| whole(&preset(k, dark)) == whole(s))
}

/// The theme with no pref: Default's, following the system.
pub fn first() -> Theme {
    Theme { appearance: Appearance::System, light: preset("default", false), dark: preset("default", true), size: Size::Default }
}

fn hex_ok(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

impl Side {
    /// The section line: its own, else halfway between the other two in color, at most 1 wide.
    pub fn section_line(&self) -> Edge {
        self.section.clone().unwrap_or_else(|| Edge {
            color: mix_hex(&self.line1.color, &self.line2.color, 0.5),
            w: if self.line1.w == 2. { 1. } else { self.line1.w },
        })
    }

    /// Whether it holds to the theme's schema: every color `#rrggbb`, every width 0.5, 1 or 2.
    fn valid(&self) -> bool {
        let e = |x: &Edge| hex_ok(&x.color) && [0.5, 1., 2.].contains(&x.w);
        hex_ok(&self.bg) && e(&self.line1) && e(&self.line2) && self.section.as_ref().is_none_or(e) && [&self.go, &self.needs, &self.running, &self.danger].iter().all(|c| hex_ok(c))
    }

    /// One appearance's side of a theme from before each had its own; its section line kept only
    /// if it isn't the one worked out.
    fn of_one(h: &Stored, dark: bool) -> Side {
        let pick = |p: &str, q: &str| if dark { q.to_string() } else { p.to_string() };
        let mut s = Side {
            bg: pick(&h.bg.light, &h.bg.dark),
            line1: Edge { color: pick(&h.line1.light, &h.line1.dark), w: h.line1.w },
            section: None,
            line2: Edge { color: pick(&h.line2.light, &h.line2.dark), w: h.line2.w },
            go: h.go.clone(),
            needs: h.needs.clone(),
            running: h.running.clone(),
            danger: h.danger.clone(),
        };
        let own = h.section.as_ref().map(|l| Edge { color: pick(&l.light, &l.dark), w: l.w });
        if own.as_ref().is_some_and(|o| *o != s.section_line()) {
            s.section = own;
        }
        s
    }
}

impl Theme {
    /// The side in an appearance.
    pub fn side(&self, dark: bool) -> &Side {
        if dark { &self.dark } else { &self.light }
    }

    pub fn side_mut(&mut self, dark: bool) -> &mut Side {
        if dark { &mut self.dark } else { &mut self.light }
    }

    pub fn valid(&self) -> bool {
        self.light.valid() && self.dark.valid()
    }

    /// A theme as the brain holds it, if it's one. One from before each appearance had its own is
    /// both sides of it.
    pub fn of(v: Option<&Value>) -> Option<Theme> {
        let h: Stored = serde_json::from_value(v?.clone()).ok()?;
        let t = Theme {
            appearance: h.appearance,
            light: h.light.clone().unwrap_or_else(|| Side::of_one(&h, false)),
            dark: h.dark.clone().unwrap_or_else(|| Side::of_one(&h, true)),
            size: h.size,
        };
        t.valid().then_some(t)
    }

    pub fn value(&self) -> Value {
        // The rollback app's one theme: the colors each side has, the widths and state colors of
        // the side it shows (dark when it follows the system).
        let s = self.side(self.appearance != Appearance::Light);
        let line = |l: &Edge, d: &Edge, w| Line { light: l.color.clone(), dark: d.color.clone(), w };
        let h = Stored {
            appearance: self.appearance,
            light: Some(self.light.clone()),
            dark: Some(self.dark.clone()),
            bg: Pair { light: self.light.bg.clone(), dark: self.dark.bg.clone() },
            line1: line(&self.light.line1, &self.dark.line1, s.line1.w),
            section: Some(line(&self.light.section_line(), &self.dark.section_line(), s.section_line().w)),
            line2: line(&self.light.line2, &self.dark.line2, s.line2.w),
            go: s.go.clone(),
            needs: s.needs.clone(),
            running: s.running.clone(),
            danger: s.danger.clone(),
            size: self.size,
        };
        serde_json::to_value(h).unwrap_or(Value::Null)
    }
}

pub fn zoom_of(size: Size) -> f32 {
    match size {
        Size::Small => 0.9,
        Size::Default => 1.,
        Size::Large => 1.15,
    }
}

/// The theme on this Mac: what the window shows now.
pub struct Held {
    pub theme: Theme,
    /// Counts changes that came from elsewhere (the brain, set on another Mac or the iPhone): a form
    /// showing the theme starts again from them.
    pub outside: u64,
}

impl Global for Held {}

/// A copy of the brain's theme, to paint the first frame before the brain's comes.
fn path() -> PathBuf {
    // The bundle's own, like its outbox.
    crate::outbox::dir().join("gpui-theme.json")
}

fn load() -> Theme {
    std::fs::read(path()).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| Theme::of(Some(&v))).unwrap_or_else(first)
}

fn keep(t: &Theme) {
    let p = path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(b) = serde_json::to_vec(&t.value()) {
        let _ = std::fs::write(p, b);
    }
}

/// How long after the last edit the theme goes to the brain, ms.
const SAVE_MS: f64 = 600.;

/// The theme kept in the outbox and not yet taken by the brain, the newest.
fn kept_theme() -> Option<outbox::Entry> {
    outbox::latest("pref.set", |p| p.get("key").and_then(Value::as_str) == Some("theme"))
}

impl Held {
    pub fn init(cx: &mut App) {
        cx.set_global(Held { theme: load(), outside: 0 });
    }

    pub fn theme(cx: &App) -> Theme {
        cx.global::<Held>().theme.clone()
    }

    pub fn outside(cx: &App) -> u64 {
        cx.global::<Held>().outside
    }

    /// The brain's theme came (or changed): shown here, unless one kept here and not yet taken is
    /// newer than what the brain says.
    pub fn from_brain(v: Option<&Value>, cx: &mut App) {
        let Some(t) = Theme::of(v) else { return };
        if cx.global::<Held>().theme == t || kept_theme().is_some() {
            return;
        }
        keep(&t);
        let h = cx.global_mut::<Held>();
        h.theme = t;
        h.outside += 1;
    }

    /// Shows a theme now in every window and keeps it for the brain, due a moment after the last
    /// edit, so quitting mid-edit loses nothing.
    pub fn set(t: Theme, cx: &mut App) {
        if cx.global::<Held>().theme == t {
            return;
        }
        keep(&t);
        let value = t.value();
        cx.global_mut::<Held>().theme = t;
        model(cx).update(cx, |m, cx| {
            let v = value.clone();
            m.change(move |b| {
                b.prefs.insert("theme".into(), v);
            }, cx);
        });
        // The same one while it waits; one that may be on its way already isn't changed under it.
        let now = outbox::now_ms();
        let had = kept_theme();
        let waiting = had.as_ref().and_then(|h| h.due).is_some_and(|d| d > now + 100.);
        let id = match had {
            Some(h) if waiting => h.id,
            _ => uuid::Uuid::new_v4().to_string(),
        };
        let mut e = outbox::Entry::command(id, "pref.set", serde_json::json!({ "key": "theme", "value": value }));
        e.due = Some(now + SAVE_MS);
        outbox::keep(e);
        cx.refresh_windows();
    }
}

fn mix_hex(a: &str, b: &str, t: f32) -> String {
    let (x, y) = (crate::derive::hex(a).unwrap_or(0), crate::derive::hex(b).unwrap_or(0));
    format!("#{:06x}", crate::look::mix(x, y, t))
}
