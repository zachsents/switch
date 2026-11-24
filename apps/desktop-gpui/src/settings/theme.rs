//! Theme (the desktop's `ui/settings/theme-section.tsx` and `color-field.tsx`): a preset, the
//! appearance, the background per appearance, the three lines (color per appearance, thickness),
//! the state colors, text size. Every change shows at once in every window; nothing to apply. The
//! fields start again from the theme when a preset is picked or the theme changes elsewhere.

use std::rc::Rc;

use gpui::{AnyElement, App, ElementId, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement, Styled, Window, div};
use ui_sdk::components::input::{Input, InputOptions, TextFieldStyle};

use crate::kit::{self, Btn, W40};
use crate::look::{Look, MONO, u};
use crate::theme::{Appearance, Held, PRESET_KEYS, Size, Theme, preset, preset_name, preset_of, section_of};

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

/// A field changed: the theme with it, its section line written out as the form holds it.
fn edit(f: impl FnOnce(&mut Theme), cx: &mut App) {
    let mut t = Held::theme(cx);
    t.section = Some(section_of(&t));
    f(&mut t);
    if t.valid() {
        Held::set(t, cx);
    }
}

type Set = Rc<dyn Fn(&mut Theme, String)>;

fn hex_ok(v: &str) -> bool {
    v.len() == 7 && v.starts_with('#') && v[1..].chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// A color: a swatch that opens the system's color panel, and its hex.
fn color_field(name: &str, label: &str, value: &str, set: Set, outside: u64, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let swatch_value = value.to_string();
    let swatch_set = set.clone();
    // Keyed by the value: a change from the panel or a preset starts it again.
    let id = ElementId::Name(format!("hex-{name}-{value}-{outside}").into());
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
                            cx.defer(move |cx| edit(move |t| s(t, v), cx));
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
                .id(ElementId::Name(format!("swatch-{name}").into()))
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
                        edit(move |t| set(t, hex), cx);
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

fn width_seg(name: &str, label: &str, w: f32, set: impl Fn(&mut Theme, f32) + 'static, l: &Look, window: &mut Window, cx: &mut App) -> AnyElement {
    let set = Rc::new(set);
    kit::segmented(format!("w-{name}"), label, &WIDTHS, width_key(w), l, move |v, _, cx| {
        let (set, w) = (set.clone(), width_of(v));
        edit(move |t| set(t, w), cx)
    }, window, cx)
}

pub fn render(window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let t = Held::theme(cx);
    let outside = Held::outside(cx);
    let section = section_of(&t);
    let preset_now = preset_of(&t);
    let mut presets: Vec<(&str, &str)> = PRESET_KEYS.iter().map(|k| (*k, preset_name(k))).collect();
    if preset_now.is_none() {
        presets.push(("custom", "Custom"));
    }
    macro_rules! color {
        ($name:expr, $label:expr, $value:expr, |$t:ident, $v:ident| $body:expr) => {
            color_field($name, $label, &$value, Rc::new(|$t: &mut Theme, $v: String| $body), outside, window, cx)
        };
    }
    let theme_rows = vec![
        kit::setting("Preset", W40, &l)
            .child(kit::controls().child(kit::segmented("preset", "Preset", &presets, preset_now.unwrap_or("custom"), &l, |v, _, cx| {
                if PRESET_KEYS.contains(&v) {
                    Held::set(preset(v), cx);
                    cx.global_mut::<Held>().outside += 1;
                }
            }, window, cx)))
            .into_any_element(),
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
                    edit(move |t| t.appearance = a, cx)
                },
                window,
                cx,
            )))
            .into_any_element(),
        kit::setting("Background", W40, &l)
            .child(kit::controls().child(color!("bg-light", "Light", t.bg.light, |t, v| t.bg.light = v)).child(color!("bg-dark", "Dark", t.bg.dark, |t, v| t.bg.dark = v)))
            .into_any_element(),
    ];
    let line_rows = vec![
        kit::setting("Between panes", W40, &l)
            .child(
                kit::controls()
                    .child(color!("line1-light", "Light", t.line1.light, |t, v| t.line1.light = v))
                    .child(color!("line1-dark", "Dark", t.line1.dark, |t, v| t.line1.dark = v))
                    .child(width_seg("line1", "Between panes", t.line1.w, |t, w| t.line1.w = w, &l, window, cx)),
            )
            .into_any_element(),
        kit::setting("Between sections", W40, &l)
            .child(
                kit::controls()
                    .child(color!("section-light", "Light", section.light, |t, v| if let Some(s) = t.section.as_mut() { s.light = v }))
                    .child(color!("section-dark", "Dark", section.dark, |t, v| if let Some(s) = t.section.as_mut() { s.dark = v }))
                    .child(width_seg("section", "Between sections", section.w, |t, w| if let Some(s) = t.section.as_mut() { s.w = w }, &l, window, cx)),
            )
            .into_any_element(),
        kit::setting("Between rows", W40, &l)
            .child(
                kit::controls()
                    .child(color!("line2-light", "Light", t.line2.light, |t, v| t.line2.light = v))
                    .child(color!("line2-dark", "Dark", t.line2.dark, |t, v| t.line2.dark = v))
                    .child(width_seg("line2", "Between rows", t.line2.w, |t, w| t.line2.w = w, &l, window, cx)),
            )
            .into_any_element(),
    ];
    let color_rows = vec![
        kit::setting("Go", W40, &l).child(kit::controls().child(color!("go", "Go", t.go, |t, v| t.go = v)).child(kit::button("sample-go", Btn::Go, true, &l).aria_label("Send").child("Send"))).into_any_element(),
        kit::setting("Needs you", W40, &l).child(kit::controls().child(color!("needs", "Needs you", t.needs, |t, v| t.needs = v))).into_any_element(),
        kit::setting("Running", W40, &l).child(kit::controls().child(color!("running", "Running", t.running, |t, v| t.running = v))).into_any_element(),
        kit::setting("Danger", W40, &l).child(kit::controls().child(color!("danger", "Danger", t.danger, |t, v| t.danger = v)).child(kit::button("sample-stop", Btn::Danger, true, &l).aria_label("Stop").child("Stop"))).into_any_element(),
        kit::setting("Neutral", W40, &l).child(kit::controls().child(kit::button("sample-reply", Btn::Key, true, &l).aria_label("Reply").child("Reply"))).into_any_element(),
        kit::setting("Text", W40, &l)
            .child(
                kit::controls()
                    .child(kit::ui(div()).text_color(l.ink).child("Read"))
                    .child(kit::ui(div()).text_color(l.ink2).child("Supporting"))
                    .child(kit::caption(div()).text_color(l.ink3).child("12:23")),
            )
            .into_any_element(),
    ];
    let size_rows = vec![kit::setting("Text size", W40, &l)
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
                edit(move |t| t.size = s, cx)
            },
            window,
            cx,
        )))
        .into_any_element()];
    kit::pane_scroll(
        "theme",
        None,
        div().flex().flex_col().child(kit::group("Theme", None, theme_rows, &l)).child(kit::group("Lines", None, line_rows, &l)).child(kit::group("Colors", None, color_rows, &l)).child(kit::group("Size", None, size_rows, &l)),
        window,
        cx,
    )
}
