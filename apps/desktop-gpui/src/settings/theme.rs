//! Theme (the desktop's `ui/settings/theme-section.tsx` and `color-field.tsx`): the appearance and
//! text size, then one appearance's theme at a time, the one shown unless the other's picked: its
//! preset, background, three lines (color, thickness) and state colors, its samples in its own
//! look. Every change shows at once in every window; nothing to apply. The fields start again from
//! the theme when a preset is picked or the theme changes elsewhere.

use std::rc::Rc;

use gpui::{AnyElement, App, ElementId, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement, Styled, Window, div};
use ui_sdk::components::input::{Input, InputOptions, TextFieldStyle};

use crate::kit::{self, Btn, W40};
use crate::look::{Look, MONO, u};
use crate::theme::{Appearance, Held, PRESET_KEYS, Side, Size, Theme, preset, preset_name, preset_of};

const WIDTHS: [(&str, &str); 3] = [("0.5", "Hairline"), ("1", "1 pt"), ("2", "2 pt")];

fn width_of(v: &str) -> f32 {
    match v {
        "0.5" => 0.5,
        "2" => 2.,
        _ => 1.,
    }
}

fn width_key(w: f32) -> &'static str {
    if w == 0.5 {
        "0.5"
    } else if w == 2. {
        "2"
    } else {
        "1"
    }
}

/// A field of one side changed: the theme with it, the side's section line written out as the form
/// holds it.
fn edit(dark: bool, f: impl FnOnce(&mut Side), cx: &mut App) {
    let mut t = Held::theme(cx);
    let side = t.side_mut(dark);
    side.section = Some(side.section_line());
    f(side);
    if t.valid() {
        Held::set(t, cx);
    }
}

/// The theme as a whole changed (its appearance, its text size).
fn edit_theme(f: impl FnOnce(&mut Theme), cx: &mut App) {
    let mut t = Held::theme(cx);
    f(&mut t);
    Held::set(t, cx);
}

/// Which side the page edits: the one picked, else the one shown.
struct Editing(Option<bool>);

type Set = Rc<dyn Fn(&mut Side, String)>;

fn hex_ok(v: &str) -> bool {
    v.len() == 7 && v.starts_with('#') && v[1..].chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// A color: a swatch that opens the system's color panel, and its hex.
fn color_field(dark: bool, name: &str, label: &str, value: &str, set: Set, outside: u64, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let swatch_value = value.to_string();
    let swatch_set = set.clone();
    // Keyed by the value: a change from the panel or a preset starts it again; and by the ink it
    // was made in, so another appearance's starts it again too.
    let id = ElementId::Name(format!("hex-{dark}-{name}-{value}-{outside}-{}", l.dark).into());
    let s = set.clone();
    let input = window.use_keyed_state(id, cx, {
        let value = value.to_string();
        move |window, cx| {
            Input::new(
                InputOptions::default()
                    .default_value(value)
                    .field_style(TextFieldStyle { text_color: Some(l.ink), caret_color: Some(l.ink), ..Default::default() })
                    .on_value_change(move |v, _, _, cx| {
                        let v = v.trim().to_lowercase();
                        if hex_ok(&v) {
                            let s = s.clone();
                            edit(dark, move |t| s(t, v), cx);
                        }
                    }),
                window,
                cx,
            )
        }
    });
    let bg = crate::derive::hex(value).map(|h| gpui::Hsla::from(gpui::rgb(h))).unwrap_or(l.bg);
    div()
        .flex()
        .items_center()
        .gap(u(6.))
        .child(
            div()
                .id(ElementId::Name(format!("swatch-{dark}-{name}").into()))
                .aria_label(format!("{label} color"))
                .tab_index(0)
                .focus_visible(|s| s.border_color(l.ink3))
                .size(u(22.))
                .rounded(u(4.))
                .border_1()
                .border_color(l.line1)
                .bg(bg)
                .on_click(move |_, _, cx| {
                    let set = swatch_set.clone();
                    crate::color_panel::open(&swatch_value, move |hex, cx| {
                        let set = set.clone();
                        edit(dark, move |t| set(t, hex), cx);
                    }, cx);
                }),
        )
        .child(
            div()
                .flex()
                .h(u(22.))
                .w(u(80.))
                .items_center()
                .rounded(u(4.))
                .px(u(6.))
                .border_1()
                .border_color(l.line2)
                .font_family(MONO)
                .text_size(u(11.))
                .line_height(u(14.))
                .child(Input::root(&input, cx).aria_label(label.to_string()).w_full()),
        )
        .into_any_element()
}

fn width_seg(dark: bool, name: &str, label: &str, w: f32, set: impl Fn(&mut Side, f32) + 'static, l: &Look, window: &mut Window, cx: &mut App) -> AnyElement {
    let set = Rc::new(set);
    kit::segmented(format!("w-{dark}-{name}"), label, &WIDTHS, width_key(w), l, move |v, _, cx| {
        let (set, w) = (set.clone(), width_of(v));
        edit(dark, move |t| set(t, w), cx)
    }, window, cx)
}

pub fn render(window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let t = Held::theme(cx);
    let outside = Held::outside(cx);
    let editing = window.use_keyed_state(ElementId::Name("theme-editing".into()), cx, |_, _| Editing(None));
    let dark = editing.read(cx).0.unwrap_or(l.dark);
    let side = t.side(dark).clone();
    // The side's own look, for its samples.
    let sl = Look::of_side(&t, dark);
    let section = side.section_line();
    let preset_now = preset_of(&side, dark);
    let mut presets: Vec<(&str, &str)> = PRESET_KEYS.iter().map(|k| (*k, preset_name(k))).collect();
    if preset_now.is_none() {
        presets.push(("custom", "Custom"));
    }
    macro_rules! color {
        ($name:expr, $label:expr, $value:expr, |$t:ident, $v:ident| $body:expr) => {
            color_field(dark, $name, $label, &$value, Rc::new(|$t: &mut Side, $v: String| $body), outside, window, cx)
        };
    }
    let sample = || div().flex().items_center().gap(u(8.)).px(u(8.)).py(u(4.)).rounded(u(4.)).bg(sl.bg);
    let theme_rows = vec![
        kit::setting("Appearance", W40, &l)
            .child(kit::controls().child(kit::segmented(
                "appearance", "Appearance",
                &[("system", "System"), ("light", "Light"), ("dark", "Dark")],
                match t.appearance {
                    Appearance::System => "system",
                    Appearance::Light => "light",
                    Appearance::Dark => "dark",
                },
                &l,
                |v, _, cx| {
                    let a = match v {
                        "light" => Appearance::Light,
                        "dark" => Appearance::Dark,
                        _ => Appearance::System,
                    };
                    edit_theme(move |t| t.appearance = a, cx)
                },
                window,
                cx,
            )))
            .into_any_element(),
        kit::setting("Text size", W40, &l)
            .child(kit::controls().child(kit::segmented(
                "size", "Text size",
                &[("small", "Small"), ("default", "Default"), ("large", "Large")],
                match t.size {
                    Size::Small => "small",
                    Size::Default => "default",
                    Size::Large => "large",
                },
                &l,
                |v, _, cx| {
                    let s = match v {
                        "small" => Size::Small,
                        "large" => Size::Large,
                        _ => Size::Default,
                    };
                    edit_theme(move |t| t.size = s, cx)
                },
                window,
                cx,
            )))
            .into_any_element(),
    ];
    let pick = {
        let editing = editing.clone();
        kit::segmented("theme-side", "Theme", &[("light", "Light"), ("dark", "Dark")], if dark { "dark" } else { "light" }, &l, move |v, _, cx| {
            editing.update(cx, |e, cx| {
                e.0 = Some(v == "dark");
                cx.notify();
            })
        }, window, cx)
    };
    let side_rows = vec![
        kit::setting("Preset", W40, &l)
            .child(kit::controls().child(kit::segmented(format!("preset-{dark}"), "Preset", &presets, preset_now.unwrap_or("custom"), &l, move |v, _, cx| {
                if PRESET_KEYS.contains(&v) {
                    let mut t = Held::theme(cx);
                    *t.side_mut(dark) = preset(v, dark);
                    Held::set(t, cx);
                    cx.global_mut::<Held>().outside += 1;
                }
            }, window, cx)))
            .into_any_element(),
        kit::setting("Background", W40, &l).child(kit::controls().child(color!("bg", "Background", side.bg, |t, v| t.bg = v))).into_any_element(),
        kit::setting("Between panes", W40, &l)
            .child(
                kit::controls()
                    .child(color!("line1", "Between panes", side.line1.color, |t, v| t.line1.color = v))
                    .child(width_seg(dark, "line1", "Between panes", side.line1.w, |t, w| t.line1.w = w, &l, window, cx)),
            )
            .into_any_element(),
        kit::setting("Between sections", W40, &l)
            .child(
                kit::controls()
                    .child(color!("section", "Between sections", section.color, |t, v| if let Some(s) = t.section.as_mut() { s.color = v }))
                    .child(width_seg(dark, "section", "Between sections", section.w, |t, w| if let Some(s) = t.section.as_mut() { s.w = w }, &l, window, cx)),
            )
            .into_any_element(),
        kit::setting("Between rows", W40, &l)
            .child(
                kit::controls()
                    .child(color!("line2", "Between rows", side.line2.color, |t, v| t.line2.color = v))
                    .child(width_seg(dark, "line2", "Between rows", side.line2.w, |t, w| t.line2.w = w, &l, window, cx)),
            )
            .into_any_element(),
        kit::setting("Go", W40, &l).child(kit::controls().child(color!("go", "Go", side.go, |t, v| t.go = v)).child(sample().child(kit::button("sample-go", Btn::Go, true, &sl).aria_label("Send").child("Send")))).into_any_element(),
        kit::setting("Needs you", W40, &l).child(kit::controls().child(color!("needs", "Needs you", side.needs, |t, v| t.needs = v))).into_any_element(),
        kit::setting("Running", W40, &l).child(kit::controls().child(color!("running", "Running", side.running, |t, v| t.running = v))).into_any_element(),
        kit::setting("Danger", W40, &l).child(kit::controls().child(color!("danger", "Danger", side.danger, |t, v| t.danger = v)).child(sample().child(kit::button("sample-stop", Btn::Danger, true, &sl).aria_label("Stop").child("Stop")))).into_any_element(),
        kit::setting("Neutral", W40, &l).child(kit::controls().child(sample().child(kit::button("sample-reply", Btn::Key, true, &sl).aria_label("Reply").child("Reply")))).into_any_element(),
        kit::setting("Text", W40, &l)
            .child(
                kit::controls().child(
                    sample()
                        .child(kit::ui(div()).text_color(sl.ink).child("Read"))
                        .child(kit::ui(div()).text_color(sl.ink2).child("Supporting"))
                        .child(kit::caption(div()).text_color(sl.ink3).child("12:23")),
                ),
            )
            .into_any_element(),
    ];
    kit::pane_scroll(
        "theme",
        None,
        div().flex().flex_col().child(kit::group("Theme", None, theme_rows, &l)).child(kit::group(if dark { "Dark theme" } else { "Light theme" }, Some(pick), side_rows, &l)),
        window,
        cx,
    )
}
