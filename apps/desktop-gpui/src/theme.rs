//! The theme (the desktop's `ui/theme.ts` and `use-theme-sync.ts`): the appearance, the one
//! background (a color per appearance), the three lines (a color per appearance and a thickness
//! each), what each state color means, and the text size. Kept in the brain (`pref theme`, for every
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pair {
    pub light: String,
    pub dark: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Line {
    pub light: String,
    pub dark: String,
    /// 0.5, 1 or 2.
    pub w: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Theme {
    pub appearance: Appearance,
    pub bg: Pair,
    /// Between the panes and under the band.
    pub line1: Line,
    /// Between a rail's sections and between widgets; a theme without it has it worked out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<Line>,
    /// Between rows, and between the chat and its box.
    pub line2: Line,
    pub go: String,
    pub needs: String,
    pub running: String,
    pub danger: String,
    pub size: Size,
}

fn pair(light: &str, dark: &str) -> Pair {
    Pair { light: light.into(), dark: dark.into() }
}

fn line(light: &str, dark: &str, w: f32) -> Line {
    Line { light: light.into(), dark: dark.into(), w }
}

pub const PRESET_KEYS: [&str; 5] = ["default", "light", "paper", "contrast", "slate"];

pub fn preset_name(key: &str) -> &'static str {
    match key {
        "light" => "Light",
        "paper" => "Paper",
        "contrast" => "Contrast",
        "slate" => "Slate",
        _ => "Default",
    }
}

pub fn preset(key: &str) -> Theme {
    let states = |appearance, bg, line1, line2| Theme {
        appearance,
        bg,
        line1,
        section: None,
        line2,
        go: "#1f8a5e".into(),
        needs: "#ffc000".into(),
        running: "#f26419".into(),
        danger: "#d42a1f".into(),
        size: Size::Default,
    };
    match key {
        "light" => states(Appearance::Light, pair("#fbfbfa", "#0d0d0d"), line("#bdbdbd", "#2c2c2c", 1.), line("#e6e6e4", "#1c1c1c", 0.5)),
        "paper" => Theme {
            go: "#2f7d4f".into(),
            needs: "#e0a100".into(),
            running: "#d1561c".into(),
            danger: "#b3261e".into(),
            ..states(Appearance::Light, pair("#f3eee3", "#1b1915"), line("#c9bfa9", "#3a352b", 1.), line("#e3dccc", "#27241e", 0.5))
        },
        "contrast" => Theme {
            go: "#00a86b".into(),
            needs: "#ffd400".into(),
            running: "#ff7a1a".into(),
            danger: "#ff3b30".into(),
            size: Size::Large,
            ..states(Appearance::Dark, pair("#ffffff", "#000000"), line("#000000", "#ffffff", 1.), line("#767676", "#8a8a8a", 1.))
        },
        "slate" => states(Appearance::Dark, pair("#f4f6f8", "#11161c"), line("#c3cbd3", "#2a3440", 1.), line("#e1e6eb", "#1b232c", 0.5)),
        _ => states(Appearance::System, pair("#ffffff", "#0d0d0d"), line("#c8c8c8", "#2c2c2c", 1.), line("#e8e8e8", "#1c1c1c", 0.5)),
    }
}

/// The preset the theme is, if it's one.
pub fn preset_of(t: &Theme) -> Option<&'static str> {
    PRESET_KEYS.into_iter().find(|k| preset(k) == *t)
}

fn hex_ok(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

impl Theme {
    /// Whether it holds to the theme's schema: every color `#rrggbb`, every width 0.5, 1 or 2.
    pub fn valid(&self) -> bool {
        let w = |x: f32| x == 0.5 || x == 1. || x == 2.;
        let l = |x: &Line| hex_ok(&x.light) && hex_ok(&x.dark) && w(x.w);
        hex_ok(&self.bg.light)
            && hex_ok(&self.bg.dark)
            && l(&self.line1)
            && l(&self.line2)
            && self.section.as_ref().is_none_or(l)
            && [&self.go, &self.needs, &self.running, &self.danger].iter().all(|c| hex_ok(c))
    }

    /// A theme as the brain holds it, if it's one.
    pub fn of(v: Option<&Value>) -> Option<Theme> {
        let t: Theme = serde_json::from_value(v?.clone()).ok()?;
        t.valid().then_some(t)
    }

    pub fn value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
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
    std::fs::read(path()).ok().and_then(|b| serde_json::from_slice::<Theme>(&b).ok()).filter(Theme::valid).unwrap_or_else(|| preset("default"))
}

fn keep(t: &Theme) {
    let p = path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(b) = serde_json::to_vec(t) {
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

/// The section line: the theme's own, else halfway between the other two in color, at most 1 wide.
pub fn section_of(t: &Theme) -> Line {
    t.section.clone().unwrap_or_else(|| Line {
        light: mix_hex(&t.line1.light, &t.line2.light, 0.5),
        dark: mix_hex(&t.line1.dark, &t.line2.dark, 0.5),
        w: if t.line1.w == 2. { 1. } else { t.line1.w },
    })
}

fn mix_hex(a: &str, b: &str, t: f32) -> String {
    let (x, y) = (crate::derive::hex(a).unwrap_or(0), crate::derive::hex(b).unwrap_or(0));
    format!("#{:06x}", crate::look::mix(x, y, t))
}
