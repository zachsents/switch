//! The house's Pick (the desktop's `widgets/pick.tsx`, `choices.tsx`, `swatch.tsx`): a cell that's a
//! key, its swatch, its name (a slot's, dim) and its label (what it holds). It opens choices under it
//! in groups, a row of keys per group (words, or colors as swatches), one chosen in each; a `custom`
//! group of swatches takes any RRGGBB typed beside Set. Set calls the extension's `action` with
//! `args` and what was chosen, and the choices close when the extension takes it; pending, Set keeps
//! its strength and its spinner says so; what went wrong takes the Hex field's place.

use std::collections::BTreeMap;

use gpui::{
    AnyElement, App, Div, Entity, FocusHandle, FontWeight, Hsla, InteractiveElement, IntoElement, KeyDownEvent, MouseButton, ParentElement,
    StatefulInteractiveElement, Styled, Window, anchored, deferred, div, prelude::*, px, relative, rgb,
};
use serde_json::{Map, Value};
use ui_sdk::components::input::{Input, InputOptions};

use crate::kit::{self, Btn};
use crate::look::{Look, MONO, u};
use crate::marks;
use crate::widgets::house::lines::{Calling, run};
use crate::widgets::house::record;
use crate::widgets::render::Ctx;

/// A group of choices.
#[derive(Clone)]
struct Group {
    key: String,
    choices: Vec<String>,
    swatches: bool,
    custom: bool,
}

fn is_hex(v: &str) -> bool {
    v.len() == 6 && v.bytes().all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
}

/// A value the group takes: one of its choices, or for a custom group any RRGGBB.
fn takes(g: &Group, v: &str) -> bool {
    g.choices.iter().any(|c| c == v) || (g.custom && is_hex(v))
}

fn dark(color: &str) -> bool {
    if color.len() != 6 || !color.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    let ch = |i: usize| u8::from_str_radix(&color[i..i + 2], 16).unwrap_or(0) as f32;
    0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4) < 40.
}

/// A color as a dot, hairlined so it shows on any ground, ringed when it's the one chosen. A very
/// dark one carries a soft highlight, so on a black band it still reads as filled.
pub fn swatch(color: &str, size: f32, chosen: bool, l: &Look) -> Div {
    let fill: Option<Hsla> = u32::from_str_radix(color, 16).ok().filter(|_| !color.is_empty()).map(|c| rgb(c).into());
    div()
        .relative()
        .flex_none()
        .size(px(size))
        .child(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .rounded_full()
                .border_1()
                .border_color(l.ink3)
                .when_some(fill, |d, f| d.bg(f))
                .when(dark(color), |d| d.child(div().absolute().top(relative(0.12)).left(relative(0.18)).size(relative(0.4)).rounded_full().bg(l.white.opacity(0.35)))),
        )
        .when(chosen, |d| d.child(div().absolute().top(px(-3.)).left(px(-3.)).size(px(size + 6.)).rounded_full().border_2().border_color(l.ink)))
}

/// The choices open, and what's chosen in them.
pub struct Choosing {
    open: bool,
    /// When a press outside last put the choices away: that press on the trigger doesn't open them
    /// again.
    shut: Option<std::time::Instant>,
    focus: FocusHandle,
    /// The trigger's, where focus goes back to as the choices close.
    trigger: FocusHandle,
    values: BTreeMap<String, String>,
    hex: Option<Entity<Input>>,
    calling: Entity<Calling>,
    /// What `current` said as the choices last took it: a new one starts them again (choices
    /// keyed by `current`, as pick.tsx keys them).
    current: String,
}

pub fn pick(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = ctx.look;
    let groups: Vec<Group> = c
        .get("groups")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|g| Group {
            key: g.get("key").and_then(Value::as_str).unwrap_or_default().to_string(),
            choices: g.get("choices").and_then(Value::as_array).into_iter().flatten().filter_map(|x| x.as_str().map(str::to_string)).collect(),
            swatches: g.get("swatches").and_then(Value::as_bool) == Some(true),
            custom: g.get("custom").and_then(Value::as_bool) == Some(true),
        })
        .collect();
    let current = record(&ctx.scope.prop(c, "current"));
    let current_sig = Value::Object(current.clone()).to_string();
    let state = ctx.state(c, "pick", window, cx, |_, cx| Choosing { open: false, shut: None, focus: cx.focus_handle(), trigger: cx.focus_handle(), values: BTreeMap::new(), hex: None, calling: cx.new(|_| Calling::default()), current: String::new() });
    let title = ctx.scope.text(c, "title");
    let label = ctx.scope.text(c, "label");
    let sw = ctx.scope.text(c, "swatch");
    let strong = ctx.scope.flag(c, "strong");
    let open = state.read(cx).open;
    // Open while what it holds changes: the choices start again from the new.
    let stale = open && state.read(cx).current != current_sig;
    let custom = groups.iter().find(|g| g.custom).cloned();
    // What the choices start from: what each group holds now (its first choice otherwise), and
    // the custom color's field.
    let fresh = {
        let (groups, current, custom, state) = (groups.clone(), current.clone(), custom.clone(), state.clone());
        move |window: &mut Window, cx: &mut App| -> (BTreeMap<String, String>, Option<Entity<Input>>) {
            let values: BTreeMap<String, String> = groups
                .iter()
                .map(|g| {
                    let now = current.get(&g.key).and_then(Value::as_str).map(str::to_uppercase);
                    (g.key.clone(), now.filter(|n| takes(g, n)).unwrap_or_else(|| g.choices.first().cloned().unwrap_or_default()))
                })
                .collect();
            let hex_start = custom.as_ref().and_then(|g| values.get(&g.key).filter(|v| !g.choices.contains(v)).cloned()).unwrap_or_default();
            let hex = custom.as_ref().map(|g| {
                // What's typed is the custom group's value, as RRGGBB: no "#", no spaces, capitals.
                let (state, key) = (state.clone(), g.key.clone());
                cx.new(|cx| {
                    let me: gpui::WeakEntity<Input> = cx.entity().downgrade();
                    Input::new(
                        InputOptions::default()
                            .default_value(hex_start)
                            .placeholder("Hex")
                            .max_length(7)
                            .on_value_change(move |typed, _, window, cx| {
                                let value = typed.strip_prefix('#').unwrap_or(typed).trim().to_uppercase();
                                state.update(cx, |s, cx| {
                                    s.values.insert(key.clone(), value.clone());
                                    cx.notify();
                                });
                                if value != typed.as_ref()
                                    && let Some(me) = me.upgrade()
                                {
                                    me.update(cx, |h, cx| h.set_value(value, Default::default(), window, cx));
                                }
                            })
                            .field_style(kit::field_style()),
                        window,
                        cx,
                    )
                })
            });
            (values, hex)
        }
    };
    if stale {
        let (values, hex) = fresh(window, cx);
        let sig = current_sig.clone();
        state.update(cx, |s, cx| {
            s.values = values;
            s.hex = hex;
            s.current = sig;
            cx.notify();
        });
    }
    let opener = {
        let (state, current_sig, fresh) = (state.clone(), current_sig.clone(), fresh.clone());
        move |window: &mut Window, cx: &mut App| {
            let focus = state.read(cx).focus.clone();
            let shut = {
                let s0 = state.read(cx);
                s0.open || s0.shut.is_some_and(|t| t.elapsed() < std::time::Duration::from_millis(400))
            };
            if shut {
                state.update(cx, |s, cx| {
                    s.open = false;
                    s.shut = None;
                    cx.notify();
                });
                return;
            }
            let (values, hex) = fresh(window, cx);
            state.update(cx, |s, cx| {
                s.open = true;
                s.values = values;
                s.current = current_sig.clone();
                s.hex = hex;
                s.calling.update(cx, |c, _| c.error = None);
                cx.notify();
            });
            window.focus(&focus, cx);
        }
    };
    let named = format!("{title} {label}").trim().to_string();
    let trigger_focus = state.read(cx).trigger.clone();
    // Base UI's Popover.Trigger: a button, Tab, Space and Enter open it.
    let trigger = div()
        .id(ctx.id(c, "trigger"))
        .role(gpui::Role::Button)
        .aria_label(named)
        .aria_expanded(open)
        .track_focus(&trigger_focus.clone().tab_index(0).tab_stop(true))
        .flex()
        .h(u(24.))
        .min_w_0()
        .items_center()
        .gap(u(6.))
        .px(u(8.))
        .when(!ctx.last, |d| d.border_r(px(l.w1)).border_color(l.line1))
        .hover(|s| s.bg(l.hover))
        .when(open, |d| d.bg(l.hover))
        .on_click(move |_, window, cx| opener(window, cx))
        .when(!sw.is_empty(), |d| d.child(swatch(&sw, 12., false, &l)))
        .when(!title.is_empty(), |d| d.child(div().flex_none().text_size(u(11.)).line_height(u(14.)).font_weight(FontWeight::SEMIBOLD).text_color(l.ink3).child(title)))
        .child(
            div()
                .min_w_0()
                .truncate()
                .text_size(u(11.))
                .line_height(u(14.))
                .map(|d| if strong { d.font_weight(FontWeight::SEMIBOLD).text_color(l.ink) } else { d.text_color(l.ink2) })
                .child(label),
        );
    let mut out = div().relative().min_w_0().child(trigger);
    if open {
        let call = (ctx.surface_key(), c.get("action").and_then(Value::as_str).unwrap_or_default().to_string(), record(&ctx.scope.prop(c, "args")));
        let popup = choices(c, ctx, &groups, custom, call, state.clone(), window, cx);
        out = out.child(div().absolute().top(relative(1.)).left_0().child(deferred(anchored().snap_to_window_with_margin(px(8.)).child(div().mt(px(4.)).child(popup))).with_priority(1)));
    }
    out.into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn choices(c: &Value, ctx: &Ctx, groups: &[Group], custom: Option<Group>, call: (String, String, Map<String, Value>), state: Entity<Choosing>, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let (values, hex, calling, focus) = {
        let s = state.read(cx);
        (s.values.clone(), s.hex.clone(), s.calling.clone(), s.focus.clone())
    };
    let ready = groups.iter().all(|g| takes(g, values.get(&g.key).map(String::as_str).unwrap_or("")));
    let (pending, error) = {
        let s = calling.read(cx);
        (s.pending, s.error.clone())
    };
    const WIDTH: f32 = 244.;
    let rows: Vec<AnyElement> = groups
        .iter()
        .map(|g| {
            let cols = if g.swatches { 8 } else { ((WIDTH / if g.choices.len() > 5 { 60. } else { 44. }).floor() as usize).max(1) };
            let w = WIDTH / cols as f32;
            div()
                .flex()
                .flex_wrap()
                .border_b(px(l.w1))
                .border_color(l.line1)
                .children(g.choices.iter().map(|choice| {
                    let on = values.get(&g.key) == Some(choice);
                    let (state, key, v) = (state.clone(), g.key.clone(), choice.clone());
                    // A choice of the custom group empties what was typed.
                    let hex = hex.clone().filter(|_| g.custom);
                    let k = kit::focusable(div().id(ctx.id(c, &format!("choice:{}:{choice}", g.key))).role(gpui::Role::Button).aria_label(if g.swatches { format!("#{choice}") } else { choice.clone() }), &l)
                        .flex()
                        .w(px(w))
                        .items_center()
                        .justify_center()
                        .text_size(u(12.))
                        .whitespace_nowrap()
                        .text_color(l.ink)
                        .hover(|s| s.bg(l.hover))
                        .on_click(move |_, window, cx| {
                            if let Some(h) = &hex {
                                h.update(cx, |h, cx| h.clear(Default::default(), window, cx));
                            }
                            state.update(cx, |s, cx| {
                                s.values.insert(key.clone(), v.clone());
                                cx.notify();
                            });
                        });
                    if g.swatches {
                        let tip_key = format!("{:?}", ctx.id(c, &format!("tip:{}:{choice}", g.key)));
                        kit::tip_under(k.h(px(30.)), &tip_key, format!("#{choice}"), window, cx).child(swatch(choice, 16., on, &l)).into_any_element()
                    } else {
                        k.h(u(24.)).border_2().border_color(if on { l.ink } else { gpui::transparent_black() }).when(on, |d| d.bg(l.hover)).child(choice.clone()).into_any_element()
                    }
                }))
                .into_any_element()
        })
        .collect();
    let close = {
        let state = state.clone();
        move |cx: &mut App| {
            state.update(cx, |s, cx| {
                s.open = false;
                cx.notify();
            })
        }
    };
    let trigger = state.read(cx).trigger.clone();
    let set = {
        let (state, values, calling) = (state.clone(), values.clone(), calling.clone());
        let close = close.clone();
        move |cx: &mut App| {
            let _ = &state;
            let v: Map<String, Value> = values.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
            let close = close.clone();
            run(&call.0, &call.1, call.2.clone(), v, calling.clone(), close, cx);
        }
    };
    let foot = div()
        .flex()
        .h(u(24.))
        .items_center()
        .gap(u(8.))
        .pr(u(6.))
        .pl(u(12.))
        .map(|d| match (&error, &hex, &custom) {
            (Some(e), _, _) => d.child(marks::stop(px(12.), &l)).child(div().flex_1().min_w_0().truncate().text_size(u(12.)).text_color(l.ink).child(e.clone())),
            (None, Some(h), Some(g)) => {
                let t = values.get(&g.key).cloned().unwrap_or_default();
                d.child(
                    div()
                        .flex()
                        .flex_1()
                        .min_w_0()
                        .h_full()
                        .items_center()
                        .gap(u(8.))
                        .cursor_text()
                        .when(is_hex(&t) && !g.choices.contains(&t), |d| d.child(swatch(&t, 12., false, &l)))
                        .child(Input::root(h, cx).text_color(l.ink).aria_label("Hex").flex_1().min_w_0().h_full().font_family(MONO).text_size(u(11.))),
                )
            }
            _ => d.child(div().flex_1()),
        })
        .child({
            let k = kit::button(ctx.id(c, "set"), Btn::Go, ready, &l).role(gpui::Role::Button).aria_label("Set").when(pending, |d| d.child(kit::spin(crate::nav::Beat::step(cx), &Look { ink3: l.white, ..l }))).child("Set");
            if ready && !pending { k.on_click(move |_, _, cx| set(cx)) } else { k }
        });
    if pending {
        crate::widgets::basic::tick(c, ctx, 125, window, cx);
    }
    let outside = {
        let state = state.clone();
        move |cx: &mut App| {
            state.update(cx, |s, cx| {
                s.open = false;
                s.shut = Some(std::time::Instant::now());
                cx.notify();
            })
        }
    };
    let (c1, c2) = (outside, close);
    kit::float(&l)
        .id(ctx.id(c, "choices"))
        .track_focus(&focus)
        .w(px(WIDTH))
        .flex()
        .flex_col()
        .occlude()
        .on_mouse_down_out(move |_, _, cx| c1(cx))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_key_down(move |e: &KeyDownEvent, window, cx| {
            if e.keystroke.key == "escape" {
                cx.stop_propagation();
                c2(cx);
                window.focus(&trigger, cx);
            }
        })
        .children(rows)
        .child(foot)
        .into_any_element()
}
