//! A2UI's controls as the house's fields (the desktop's `widgets/basic/`): TextField
//! (`text-field.tsx`), CheckBox (`check-box.tsx`), ChoicePicker (`choice-picker.tsx`), Slider
//! (`slider.tsx`, `track.tsx`) and DateTimeInput (`date-time-input.tsx`). Each is a line with its
//! label in ink2 and a line-2 under the cell, the whole cell the field's; what's typed or chosen
//! goes to the data model as it changes (two-way binding, `held.ts`), and what its checks find
//! wrong shows under it.

use std::cell::RefCell;
use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, Context, Entity, InteractiveElement, IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement,
    Pixels, SharedString, StatefulInteractiveElement, Styled, Window, canvas, div, prelude::*, px, relative,
};
use serde_json::{Value, json};
use ui_sdk::components::date_input::{DateInputSegmentType, HourCycle, TextFieldAlign, TimeInput, TimeInputOptions};
use ui_sdk::components::date_picker::{CalendarValue, DatePicker, DatePickerContentProps, DatePickerOptions, DatePickerValue};
use ui_sdk::components::input::{Input, InputOptions, TextFieldKind, TextFieldStyle, Textarea, TextareaOptions};

use crate::kit::{self, Btn};
use crate::look::{Look, u};
use crate::widgets::basic::{check_mark, data, held, line2_b, problems, share};
use crate::widgets::render::Ctx;

fn style(l: &Look) -> TextFieldStyle {
    TextFieldStyle { text_color: Some(l.ink), placeholder_color: Some(l.ink3), caret_color: Some(l.ink), ..Default::default() }
}

/// A field's words, the model's shown at once when it changes, what's typed written back.
pub struct Field {
    pub one: Option<Entity<Input>>,
    pub many: Option<Entity<Textarea>>,
    seen: String,
}

impl Field {
    fn text(&self, cx: &App) -> String {
        match (&self.one, &self.many) {
            (Some(i), _) => i.read(cx).get_value().to_string(),
            (_, Some(t)) => t.read(cx).get_value().to_string(),
            _ => String::new(),
        }
    }
}

/// A field keyed to a part, kept in step with the model's value; `on_type` hears what's typed.
fn field(
    c: &Value,
    ctx: &Ctx,
    tag: &str,
    value: &str,
    kind: Option<TextFieldKind>,
    placeholder: &str,
    on_type: Rc<dyn Fn(String, &mut Window, &mut App)>,
    window: &mut Window,
    cx: &mut App,
) -> Entity<Field> {
    let l = ctx.look;
    let (start, placeholder) = (value.to_string(), placeholder.to_string());
    let state = ctx.state(c, tag, window, cx, move |window, cx: &mut Context<Field>| {
        let f = on_type.clone();
        let (one, many) = match kind {
            Some(kind) => {
                let opts = InputOptions::default()
                    .default_value(start.clone())
                    .placeholder(placeholder.clone())
                    .kind(kind)
                    .field_style(style(&l))
                    .on_value_change(move |v, _, window, cx| f(v.to_string(), window, cx));
                (Some(cx.new(|cx| Input::new(opts, window, cx))), None)
            }
            None => {
                let opts = TextareaOptions::default()
                    .default_value(start.clone())
                    .placeholder(placeholder.clone())
                    .rows(3)
                    .field_style(style(&l))
                    .on_value_change(move |v, _, window, cx| f(v.to_string(), window, cx));
                (None, Some(cx.new(|cx| Textarea::new(opts, window, cx))))
            }
        };
        Field { one, many, seen: start }
    });
    // Whatever the model holds next shows at once.
    let (seen, now) = {
        let s = state.read(cx);
        (s.seen.clone(), s.text(cx))
    };
    if seen != value {
        if now != value {
            let s = state.read(cx);
            let v = value.to_string();
            if let Some(i) = s.one.clone() {
                i.update(cx, |i, cx| i.set_value(v, Default::default(), window, cx));
            } else if let Some(t) = s.many.clone() {
                t.update(cx, |t, cx| t.set_value(v, Default::default(), window, cx));
            }
        }
        state.update(cx, |s, _| s.seen = value.to_string());
    }
    state
}

fn field_part(f: &Entity<Field>, label: &str, cx: &App) -> AnyElement {
    let s = f.read(cx);
    let label = SharedString::from(label.to_string());
    match (&s.one, &s.many) {
        (Some(i), _) => Input::root(i, cx).when(!label.is_empty(), |d| d.aria_label(label.clone())).flex_1().min_w_0().h(u(24.)).text_size(u(13.)).line_height(u(16.)).into_any_element(),
        (_, Some(t)) => Textarea::root(t, cx).when(!label.is_empty(), |d| d.aria_label(label.clone())).w_full().min_w_0().text_size(u(13.)).line_height(u(16.)).into_any_element(),
        _ => div().into_any_element(),
    }
}

/// The words of a value a field takes: a figure or a flag as written.
fn words(v: &Value) -> String {
    crate::a2ui::words_of(v)
}

pub fn text_field(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = ctx.look;
    let value = words(&ctx.scope.prop(c, "value"));
    let label = ctx.scope.words(c, "label");
    let placeholder = ctx.scope.words(c, "placeholder");
    let variant = ctx.scope.text(c, "variant");
    let long = variant == "longText";
    let kind = match variant.as_str() {
        "number" => Some(TextFieldKind::Number),
        "obscured" => Some(TextFieldKind::Password),
        "longText" => None,
        _ => Some(TextFieldKind::Text),
    };
    let writer = ctx.writer(c, "value").map(Rc::new);
    let on_type: Rc<dyn Fn(String, &mut Window, &mut App)> = Rc::new(move |v, _, cx| {
        if let Some(w) = &writer {
            w(Value::String(v), cx);
        }
    });
    let f = field(c, ctx, "text", &value, kind, &placeholder, on_type, window, cx);
    let focus = f.clone();
    let part = field_part(&f, &label, cx);
    let line = div()
        .id(ctx.id(c, "line"))
        .flex()
        .px(u(8.))
        .text_size(u(13.))
        .line_height(u(16.))
        .cursor_text()
        .on_click(move |_, window, cx| {
            let s = focus.read(cx);
            if let Some(i) = s.one.clone() {
                i.update(cx, |i, cx| i.focus(window, cx));
            } else if let Some(t) = s.many.clone() {
                t.update(cx, |t, cx| t.focus(window, cx));
            }
        })
        .map(|d| if long { d.flex_col().pb(u(4.)) } else { d.min_h(u(24.)).items_center().gap(u(10.)) })
        .when(!label.is_empty(), |d| d.child(div().flex_none().text_color(l.ink2).when(long, |d| d.flex().h(u(24.)).items_center()).child(label)))
        .child(part);
    share(line2_b(div().flex().flex_col(), &l), c, ctx).child(line).children(problems(c, ctx)).into_any_element()
}

/// A box to tick, a small raised key; ticked, solid ink with a check; lit under the pointer while
/// it isn't.
pub fn tick_box(id: gpui::ElementId, on: bool, l: &Look) -> gpui::Stateful<gpui::Div> {
    let l = *l;
    kit::focusable(div().id(id), &l)
        .flex()
        .flex_none()
        .size(px(14.))
        .items_center()
        .justify_center()
        .rounded(u(4.))
        .border_1()
        .border_color(if on { l.ink } else { l.key_border })
        .bg(if on { l.ink } else { l.bg })
        .when(!on, |d| d.hover(move |s| s.bg(l.hover)))
        .when(on, |d| d.child(check_mark(l.bg)))
}

/// A round box to choose; chosen, solid ink with a dot; lit under the pointer while it isn't.
fn ring_box(id: gpui::ElementId, on: bool, l: &Look) -> gpui::Stateful<gpui::Div> {
    let l = *l;
    div()
        .id(id)
        .focus_visible(move |s| s.shadow(kit::ring(&l)))
        .flex()
        .flex_none()
        .size(px(14.))
        .items_center()
        .justify_center()
        .rounded_full()
        .border_1()
        .border_color(if on { l.ink } else { l.key_border })
        .bg(if on { l.ink } else { l.bg })
        .when(!on, |d| d.hover(move |s| s.bg(l.hover)))
        .when(on, |d| d.child(div().size(px(5.)).rounded_full().bg(l.bg)))
}

pub fn check_box(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = ctx.look;
    let (on, set) = held(c, ctx, "value", Value::Bool(ctx.flag_of(c, "value")), window, cx);
    let on = on.as_bool() == Some(true);
    let label = ctx.scope.words(c, "label");
    let flip = set.clone();
    // Base UI's Checkbox: the box a checkbox, Tab and Space; the whole line ticks it.
    let tick = tick_box(ctx.id(c, "tick"), on, &l)
        .role(gpui::Role::CheckBox)
        .aria_label(label.clone())
        .aria_toggled(if on { gpui::Toggled::True } else { gpui::Toggled::False })
        .on_click(move |_, _, cx| {
            cx.stop_propagation();
            flip(Value::Bool(!on), cx)
        });
    let line = div()
        .id(ctx.id(c, "box"))
        .flex()
        .min_h(u(24.))
        .items_center()
        .gap(u(10.))
        .px(u(8.))
        .text_size(u(13.))
        .line_height(u(16.))
        .text_color(l.ink)
        .on_click(move |_, _, cx| set(Value::Bool(!on), cx))
        .child(tick)
        .child(div().flex_1().min_w_0().child(label));
    share(line2_b(div().flex().flex_col(), &l), c, ctx).child(line).children(problems(c, ctx)).into_any_element()
}

/// What's chosen, as A2UI's own reads it: a list of values, or one.
fn chosen_of(v: &Value) -> Vec<String> {
    match v {
        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        Value::String(s) => vec![s.clone()],
        _ => vec![],
    }
}

pub fn choice_picker(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = ctx.look;
    let (chosen, set) = held(c, ctx, "value", ctx.scope.prop(c, "value"), window, cx);
    let chosen = chosen_of(&chosen);
    let several = ctx.scope.text(c, "variant") == "multipleSelection";
    let filterable = ctx.scope.flag(c, "filterable");
    let find = filterable.then(|| {
        let none: Rc<dyn Fn(String, &mut Window, &mut App)> = Rc::new(|_, _, _| {});
        field(c, ctx, "find", "", Some(TextFieldKind::Text), "Find…", none, window, cx)
    });
    let needle = find.as_ref().map(|f| f.read(cx).text(cx).to_lowercase()).unwrap_or_default();
    let options: Vec<(String, String)> = c
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|o| (crate::a2ui::words_of(o.get("value").unwrap_or(&Value::Null)), words(&ctx.scope.resolve(o.get("label").unwrap_or(&Value::Null)))))
        .filter(|(_, label)| !filterable || label.to_lowercase().contains(&needle))
        .collect();
    let choose = {
        let chosen = chosen.clone();
        Rc::new(move |value: String, cx: &mut App| {
            let next: Vec<String> = if !several {
                vec![value]
            } else if chosen.contains(&value) {
                chosen.iter().filter(|v| **v != value).cloned().collect()
            } else {
                chosen.iter().cloned().chain(std::iter::once(value)).collect()
            };
            set(json!(next), cx);
        })
    };
    let label = ctx.scope.words(c, "label");
    let option_line = |d: gpui::Stateful<gpui::Div>| {
        d.flex().h(u(24.)).items_center().gap(u(10.)).px(u(8.)).text_size(u(13.)).line_height(u(16.)).text_color(l.ink).border_b(px(l.w2)).border_color(l.line2)
    };
    let choices: Vec<AnyElement> = if ctx.scope.text(c, "displayStyle") == "chips" {
        // Base UI's Toggle: a key pressed in while chosen.
        vec![line2_b(div().flex().flex_wrap().gap(u(6.)).px(u(8.)).py(u(4.)), &l)
            .children(options.iter().map(|(v, label)| {
                let on = chosen.contains(v);
                let (choose, v) = (choose.clone(), v.clone());
                kit::button(ctx.id(c, &format!("chip:{v}")), Btn::Key, true, &l)
                    .role(gpui::Role::Button)
                    .aria_label(label.clone())
                    .aria_toggled(if on { gpui::Toggled::True } else { gpui::Toggled::False })
                    .when(on, |d| d.bg(l.hover))
                    .child(label.clone())
                    .on_click(move |_, _, cx| choose(v.clone(), cx))
            }))
            .into_any_element()]
    } else if several {
        // Base UI's Checkbox each: the box a checkbox, Tab and Space; the whole line ticks it.
        options
            .iter()
            .map(|(v, label)| {
                let on = chosen.contains(v);
                let (choose, val, flip, again) = (choose.clone(), v.clone(), choose.clone(), v.clone());
                let tick = tick_box(ctx.id(c, &format!("tick:{v}")), on, &l)
                    .role(gpui::Role::CheckBox)
                    .aria_label(label.clone())
                    .aria_toggled(if on { gpui::Toggled::True } else { gpui::Toggled::False })
                    .on_click(move |_, _, cx| {
                        cx.stop_propagation();
                        flip(again.clone(), cx)
                    });
                option_line(div().id(ctx.id(c, &format!("opt:{v}"))))
                    .on_click(move |_, _, cx| choose(val.clone(), cx))
                    .child(tick)
                    .child(div().flex_1().min_w_0().truncate().child(label.clone()))
                    .into_any_element()
            })
            .collect()
    } else {
        // Base UI's RadioGroup: one stop for Tab, the chosen one (else the first); the arrows move to
        // the next or the one before and choose it.
        let values: Vec<String> = options.iter().map(|(v, _)| v.clone()).collect();
        let focuses: Vec<gpui::FocusHandle> = values.iter().map(|v| ctx.state(c, &format!("radio:{v}"), window, cx, |_, cx| cx.focus_handle()).read(cx).clone()).collect();
        let stop = values.iter().position(|v| chosen.first() == Some(v)).unwrap_or(0);
        let (values, focuses) = (Rc::new(values), Rc::new(focuses));
        options
            .iter()
            .enumerate()
            .map(|(i, (v, label))| {
                let on = chosen.first() == Some(v);
                let (choose, val, pick, again) = (choose.clone(), v.clone(), choose.clone(), v.clone());
                let (vs, fs, step) = (values.clone(), focuses.clone(), choose.clone());
                let radio = ring_box(ctx.id(c, &format!("radio:{v}")), on, &l)
                    .role(gpui::Role::RadioButton)
                    .aria_label(label.clone())
                    .aria_toggled(if on { gpui::Toggled::True } else { gpui::Toggled::False })
                    .track_focus(&focuses[i].clone().tab_index(0).tab_stop(i == stop))
                    .on_key_down(move |e: &gpui::KeyDownEvent, window, cx| {
                        let n = vs.len();
                        let to = match e.keystroke.key.as_str() {
                            "down" | "right" => (i + 1) % n,
                            "up" | "left" => (i + n - 1) % n,
                            _ => return,
                        };
                        cx.stop_propagation();
                        step(vs[to].clone(), cx);
                        window.focus(&fs[to], cx);
                    })
                    .on_click(move |_, _, cx| {
                        cx.stop_propagation();
                        pick(again.clone(), cx)
                    });
                option_line(div().id(ctx.id(c, &format!("opt:{v}"))))
                    .on_click(move |_, _, cx| choose(val.clone(), cx))
                    .child(radio)
                    .child(div().flex_1().min_w_0().truncate().child(label.clone()))
                    .into_any_element()
            })
            .collect()
    };
    share(div().flex().flex_col(), c, ctx)
        .when(!label.is_empty(), |d| d.child(div().flex().h(u(24.)).items_center().px(u(8.)).text_size(u(13.)).text_color(l.ink2).child(label)))
        .children(find.map(|f| line2_b(div().flex().h(u(24.)).items_center().px(u(8.)), &l).child(field_part(&f, "Find", cx))))
        .children(choices)
        .children(problems(c, ctx))
        .into_any_element()
}

/// A track being dragged.
/// Whether a track is being dragged, and its focus (the arrows, Page Up and Down, Home and End move it).
pub struct Drag(pub bool, pub gpui::FocusHandle);

/// A value along a line, pressed or dragged to, as old Switchboard drew a slider: a 3 px track in the
/// line color, filled in ink to the value, under a round raised knob that stays within the track.
/// Its knob takes Tab, with the focus ring, named `label` (Base UI's Slider thumb).
#[allow(clippy::too_many_arguments)]
pub fn track(id: gpui::ElementId, label: &str, drag: Entity<Drag>, focus: gpui::FocusHandle, value: f64, min: f64, max: f64, step: f64, on: bool, l: &Look, change: Rc<dyn Fn(f64, &mut App)>) -> AnyElement {
    // The keys Base UI's slider takes: a step each way, ten with Shift or Page Up and Down, the
    // ends with Home and End.
    let keys = {
        let change = change.clone();
        move |e: &gpui::KeyDownEvent, _: &mut Window, cx: &mut App| {
            // Base UI's slider: a step, and its large step (10) with Shift or Page Up and Down.
            let unit = if step > 0. { step } else { (max - min) / 100. };
            let big = 10.;
            let shift = e.keystroke.modifiers.shift;
            // From where it is, on a step from its least (Base UI's roundValueToStep).
            let at = if step > 0. { min + ((value - min) / step).round() * step } else { value };
            let to = match e.keystroke.key.as_str() {
                "right" | "up" => at + if shift { big } else { unit },
                "left" | "down" => at - if shift { big } else { unit },
                "pageup" => at + big,
                "pagedown" => at - big,
                "home" => min,
                "end" => max,
                _ => return,
            };
            cx.stop_propagation();
            change(to.clamp(min, max), cx);
        }
    };
    let frac = if max > min { ((value - min) / (max - min)).clamp(0., 1.) } else { 0. } as f32;
    let at = move |x: Pixels, b: Bounds<Pixels>| {
        let w = f32::from(b.size.width) - 14.;
        let f = if w > 0. { ((f32::from(x - b.origin.x) - 7.) / w).clamp(0., 1.) } else { 0. } as f64;
        let v = min + f * (max - min);
        let v = if step > 0. { min + ((v - min) / step).round() * step } else { v };
        v.clamp(min, max)
    };
    div()
        .relative()
        .flex_1()
        .min_w_0()
        .h(u(24.))
        .flex()
        .items_center()
        .when(!on, |d| d.opacity(0.4))
        .child(div().relative().w_full().h(px(3.)).rounded_full().bg(l.line1).child(div().absolute().left_0().top_0().h_full().w(relative(frac)).rounded_full().bg(l.ink)))
        .child({
            let lk = *l;
            div()
                .id(id)
                .role(gpui::Role::Slider)
                .aria_label(SharedString::from(label.to_string()))
                .aria_numeric_value(value)
                .aria_min_numeric_value(min)
                .aria_max_numeric_value(max)
                .aria_numeric_value_step(step)
                .absolute()
                .left(relative(frac))
                .ml(px(-14. * frac))
                .size(px(14.))
                .rounded_full()
                .border_1()
                .border_color(l.key_border)
                .bg(l.bg)
                .hover(move |s| s.bg(lk.hover))
                .when(on, |d| d.track_focus(&focus.clone().tab_index(0).tab_stop(true)).focus_visible(move |s| s.shadow(kit::ring(&lk))).on_key_down(keys))
        })
        .when(on, |d| {
            d.child(
                canvas(
                    |b, _, _| b,
                    move |b, _, window, _| {
                        let (d1, d2, d3) = (drag.clone(), drag.clone(), drag.clone());
                        let knob = focus.clone();
                        let (c1, c2) = (change.clone(), change.clone());
                        window.on_mouse_event(move |e: &MouseDownEvent, phase, window, cx| {
                            if phase.bubble() && e.button == MouseButton::Left && b.contains(&e.position) {
                                // A press on the track puts focus on its knob, as Base UI's does.
                                window.focus(&knob, cx);
                                d1.update(cx, |d, _| d.0 = true);
                                c1(at(e.position.x, b), cx);
                            }
                        });
                        window.on_mouse_event(move |e: &MouseMoveEvent, phase, _, cx| {
                            if phase.bubble() && d2.read(cx).0 {
                                if e.pressed_button == Some(MouseButton::Left) {
                                    c2(at(e.position.x, b), cx);
                                } else {
                                    d2.update(cx, |d, _| d.0 = false);
                                }
                            }
                        });
                        window.on_mouse_event(move |_: &MouseUpEvent, _, _, cx| {
                            if d3.read(cx).0 {
                                d3.update(cx, |d, _| d.0 = false);
                            }
                        });
                    },
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
        })
        .into_any_element()
}

/// A figure as the slider shows it: whole with steps or when whole, else to a tenth, grouped.
fn figure(v: f64, whole: bool) -> String {
    crate::a2ui::expr::format_number(v, Some(if whole || v.fract() == 0. { 0 } else { 1 }), true)
}

pub fn slider(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = ctx.look;
    let min = ctx.scope.number(c, "min").unwrap_or(0.);
    let max = ctx.scope.number(c, "max").unwrap_or(min).max(min);
    let within = ctx.scope.prop(c, "value").as_f64().map(|v| v.clamp(min, max)).unwrap_or(min);
    let (value, set) = held(c, ctx, "value", json!(within), window, cx);
    let value = value.as_f64().unwrap_or(within);
    let label = ctx.scope.words(c, "label");
    let divisions = ctx.scope.number(c, "steps").filter(|s| *s > 0. && max > min);
    let step = divisions.map(|d| (max - min) / d).unwrap_or(1.);
    let drag = ctx.state(c, "drag", window, cx, |_, cx| Drag(false, cx.focus_handle()));
    let focus = drag.read(cx).1.clone();
    // A whole value is written as one ("2", not "2.0"), as JavaScript writes a number.
    let change: Rc<dyn Fn(f64, &mut App)> = Rc::new(move |v, cx| set(if v.fract() == 0. && v.abs() < 9e15 { json!(v as i64) } else { json!(v) }, cx));
    let line = div()
        .flex()
        .h(u(24.))
        .items_center()
        .gap(u(10.))
        .px(u(8.))
        .text_size(u(13.))
        .when(!label.is_empty(), |d| d.child(div().flex_none().text_color(l.ink2).child(label.clone())))
        .child(track(ctx.id(c, "thumb"), if label.is_empty() { "Value" } else { &label }, drag, focus, value, min, max, step, true, &l, change))
        .child(data(figure(value, divisions.is_some()), &l));
    share(line2_b(div().flex().flex_col(), &l), c, ctx).child(line).children(problems(c, ctx)).into_any_element()
}

/// A value's date or time as its field takes one: no zone, no seconds.
fn part(value: &str, date: bool) -> String {
    if let Some((d, t)) = value.split_once('T') {
        return if date { d.chars().take(10).collect() } else { t.chars().take(5).collect() };
    }
    if date {
        if value.contains('-') { value.chars().take(10).collect() } else { String::new() }
    } else if value.contains(':') {
        value.chars().take(5).collect()
    } else {
        String::new()
    }
}

fn time_kept(value: &str) -> String {
    match value.split_once('T') {
        Some((_, t)) => t.to_string(),
        None if value.contains(':') => value.to_string(),
        None => "00:00:00".into(),
    }
}

fn date_kept(value: &str) -> String {
    match value.split_once('T') {
        Some((d, _)) => d.to_string(),
        None if value.contains('-') => value.to_string(),
        None => chrono::Local::now().format("%Y-%m-%d").to_string(),
    }
}

/// A DateTimeInput's two halves, made once: the date picker (its words, and a calendar under them)
/// and the time's segments; and what each change is written into, the value as last drawn.
pub struct When {
    date: Option<Entity<DatePicker>>,
    time: Option<Entity<TimeInput>>,
    /// The value as last drawn, and where a change goes.
    sink: Rc<RefCell<(String, Option<Rc<dyn Fn(Value, &mut App)>>)>>,
    /// The model's value the halves were last given.
    given: Option<String>,
    /// Whether the calendar is open, and when a press opened it.
    opened: Rc<std::cell::Cell<(bool, Option<std::time::Instant>)>>,
}

/// A date (or none) as the picker holds it.
fn picked(d: &str) -> DatePickerValue {
    if d.is_empty() { CalendarValue::Empty } else { CalendarValue::single(SharedString::from(d.to_string())) }
}

/// A day in the calendar: the house's key, the chosen one held in ink, today ringed, what can't be
/// picked dimmed.
fn day(picker: &Entity<DatePicker>, date: SharedString, l: &Look, cx: &App) -> AnyElement {
    let l = *l;
    DatePicker::day(picker, date, 0, cx)
        .with(move |el, st| {
            el.when(st.selected, |el| el.bg(l.ink).text_color(l.bg))
                .when(!st.selected, |el| el.text_color(if st.disabled || st.outside { l.ink3 } else { l.ink }).hover(|s| s.bg(l.hover)))
                .when(st.today && !st.selected, |el| el.border_1().border_color(l.ink3))
                .when(st.unavailable, |el| el.line_through())
                .child(st.label.clone())
        })
        .size(u(28.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(u(4.))
        .text_size(u(12.))
        .focus(move |s| s.border_1().border_color(l.ink))
        .into_any_element()
}

/// The calendar that floats under the date: ‹, the month, ›, then its weeks.
fn calendar(picker: &Entity<DatePicker>, l: &Look, cx: &App) -> Option<AnyElement> {
    let l = *l;
    let step = |part: ui_sdk::kernel::Part<ui_sdk::components::date_picker::CalendarStepState>, glyph: &'static str| {
        part.with(move |el, st| el.text_color(if st.disabled { l.ink3 } else { l.ink2 }))
            .h(u(22.))
            .px(u(6.))
            .flex()
            .items_center()
            .rounded(u(4.))
            .hover(|s| s.bg(l.hover))
            .focus(move |s| s.bg(l.hover))
            .child(glyph)
    };
    let grid = DatePicker::grid(picker, 0, cx);
    let weeks = grid.state().weeks.clone();
    let grid = grid
        .flex()
        .flex_col()
        .gap(u(2.))
        .child(DatePicker::weekdays(picker, 0, cx).flex().gap(u(2.)).children((0..7).map(|i| {
            DatePicker::weekday(picker, 0, i, cx)
                .with(|el, st| el.child(st.label.clone()))
                .w(u(28.))
                .flex()
                .justify_center()
                .text_size(u(11.))
                .text_color(l.ink3)
        })))
        .children(weeks.into_iter().enumerate().map(|(i, week)| {
            DatePicker::week(picker, 0, i, cx).flex().gap(u(2.)).children(week.into_iter().map(|cell| {
                if cell.hidden { div().size(u(28.)).into_any_element() } else { day(picker, cell.date, &l, cx) }
            }))
        }));
    let content = DatePicker::content(picker, DatePickerContentProps::default(), cx)?;
    Some(
        content
            .flex()
            .flex_col()
            .gap(u(6.))
            .p(u(8.))
            .bg(l.bg)
            .text_color(l.ink)
            .border(px(l.w1))
            .border_color(l.line1)
            .rounded(u(6.))
            .relative()
            .child(crate::webview::covering())
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(step(DatePicker::previous_part(picker, cx), "‹"))
                    .child(DatePicker::heading(picker, cx).with(|el, st| el.child(st.label.clone())).text_size(u(13.)).font_weight(gpui::FontWeight::MEDIUM))
                    .child(step(DatePicker::next_part(picker, cx), "›")),
            )
            .child(grid)
            .into_any_element(),
    )
}

/// A2UI's DateTimeInput as a field's line (`date-time-input.tsx`): its label in ink2, then a date
/// (its words in the system's form, mm/dd/yyyy, typed or picked from the calendar that floats under
/// them, with Calendar's keys) and a time (hours, minutes and AM/PM, each typed or stepped with the
/// arrows), as `<input type="date">` and `type="time"` are on a Mac. A date unless it asks for only
/// a time; an unset half in a placeholder's ink. `min` and `max` bound both. What's picked goes to
/// the data model in ISO 8601 as A2UI's own writes it: a date, a time, or both, keeping the other
/// half of what was there (today's date, midnight).
pub fn date_time(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = ctx.look;
    let time = ctx.scope.flag(c, "enableTime");
    let date = ctx.scope.prop(c, "enableDate").as_bool().unwrap_or(!time);
    let (value, set) = held(c, ctx, "value", Value::String(ctx.scope.text(c, "value")), window, cx);
    let value = value.as_str().unwrap_or_default().to_string();
    let (min, max) = (ctx.scope.text(c, "min"), ctx.scope.text(c, "max"));
    let label = ctx.scope.words(c, "label");
    let field = TextFieldStyle { text_color: Some(l.ink), placeholder_color: Some(l.ink3), caret_color: Some(l.ink), ..Default::default() };
    let segment = move |kind: DateInputSegmentType| {
        let s = TextFieldStyle { text_color: Some(l.ink), placeholder_color: Some(l.ink3), ..Default::default() }
            .text_align(TextFieldAlign::Center)
            .caret_color(gpui::transparent_black())
            .selection_color(gpui::transparent_black());
        if kind == DateInputSegmentType::DayPeriod { s.width_ch(2.6) } else { s.width_ch(2.) }
    };
    let (dmin, dmax, tmin, tmax) = (part(&min, true), part(&max, true), part(&min, false), part(&max, false));
    let fields_focus = ctx.state(c, "fields", window, cx, |_, cx| cx.focus_handle()).read(cx).clone();
    // Its halves are made for what it's given: a new `min` or `max`, or another half, makes them
    // again, so the bounds are always the model's.
    let state = ctx.state(c, &format!("when:{date}:{time}:{min}:{max}"), window, cx, |window, cx| {
        let sink: Rc<RefCell<(String, Option<Rc<dyn Fn(Value, &mut App)>>)>> = Rc::default();
        // Whether the calendar is open, and when a press opened it; the picker, to tell it.
        let opened: Rc<std::cell::Cell<(bool, Option<std::time::Instant>)>> = Rc::new(std::cell::Cell::new((false, None)));
        let held_picker: Rc<RefCell<Option<gpui::WeakEntity<DatePicker>>>> = Rc::default();
        let date_picker = date.then(|| {
            let sink = sink.clone();
            let mut o = DatePickerOptions::default()
                .placeholder("mm/dd/yyyy")
                .on_open_change({
                    let opened = opened.clone();
                    let held_picker = held_picker.clone();
                    move |open, details, _, cx| {
                        // The press that opened it settles focus in the date's words a moment
                        // after: that isn't leaving it. Anything else closes it.
                        let (was, at) = opened.get();
                        let settling = matches!(details.reason, ui_sdk::kernel::Reason::FocusOut) && at.is_some_and(|t| t.elapsed() < std::time::Duration::from_millis(400));
                        if !*open && was && settling {
                            return;
                        }
                        opened.set((*open, None));
                        if let Some(p) = held_picker.borrow().as_ref().and_then(|w| w.upgrade()) {
                            p.update(cx, |p, cx| p.set_controlled_open(Some(*open), cx));
                        }
                    }
                })
                .field_style(field.clone())
                .on_value_change(move |v, _, _, cx| {
                    let (was, write) = sink.borrow().clone();
                    let Some(write) = write else { return };
                    // Cleared, its words are empty, written as A2UI's own writes them.
                    let d = v.as_single().map(|d| d.to_string()).unwrap_or_default();
                    write(Value::String(if time { format!("{d}T{}", time_kept(&was)) } else { d }), cx);
                });
            if !dmin.is_empty() {
                o = o.min(SharedString::from(dmin.clone()));
            }
            if !dmax.is_empty() {
                o = o.max(SharedString::from(dmax.clone()));
            }
            let made = cx.new(|cx| {
                let mut p = DatePicker::new(o, window, cx);
                p.set_controlled_open(Some(false), cx);
                p
            });
            *held_picker.borrow_mut() = Some(made.downgrade());
            made
        });
        let time_input = time.then(|| {
            let sink = sink.clone();
            let mut o = TimeInputOptions::default().hour_cycle(HourCycle::H12).field_style(segment).on_value_change(move |v, _, _, cx| {
                let (was, write) = sink.borrow().clone();
                let Some(write) = write else { return };
                // Cleared, its words are empty, written as A2UI's own writes them.
                let t: String = v.as_ref().map(|t| t.chars().take(5).collect()).unwrap_or_default();
                write(Value::String(if date { format!("{}T{t}:00", date_kept(&was)) } else { t }), cx);
            });
            if !tmin.is_empty() {
                o = o.min(SharedString::from(tmin.clone()));
            }
            if !tmax.is_empty() {
                o = o.max(SharedString::from(tmax.clone()));
            }
            cx.new(|cx| TimeInput::new(o, window, cx))
        });
        // The part draws again as either half changes (its words, its calendar opening and placed).
        if let Some(p) = &date_picker {
            cx.observe(p, |_, _, cx| cx.notify()).detach();
        }
        if let Some(t) = &time_input {
            cx.observe(t, |_, _, cx| cx.notify()).detach();
        }
        When { date: date_picker, time: time_input, sink, given: None, opened }
    });
    let (picker, clock, given) = {
        let w = state.read(cx);
        *w.sink.borrow_mut() = (value.clone(), Some(Rc::new(set.clone())));
        (w.date.clone(), w.time.clone(), w.given.clone())
    };
    // The model's value shows in both halves as it changes (one each half sent is already there).
    if given.as_deref() != Some(value.as_str()) {
        state.update(cx, |w, _| w.given = Some(value.clone()));
        if let Some(p) = &picker {
            let now = picked(&part(&value, true));
            if p.read(cx).get_value() != &now {
                p.update(cx, |p, cx| p.set_value(now, Default::default(), window, cx));
            }
        }
        if let Some(t) = &clock {
            let now = Some(part(&value, false)).filter(|t| !t.is_empty()).map(SharedString::from);
            let held: Option<String> = t.read(cx).get_value().map(|v| v.chars().take(5).collect());
            if held != now.as_ref().map(|s| s.to_string()) {
                t.update(cx, |t, cx| t.set_value(now, Default::default(), window, cx));
            }
        }
    }
    let mut fields: Vec<AnyElement> = vec![];
    if let Some(p) = &picker {
        let input = DatePicker::input(p, false, cx).when(!label.is_empty(), |d| d.aria_label(label.clone())).w(px(92.));
        // A press on the date opens its calendar, as a Mac's date field does (⌥↓ too).
        let opener = p.clone();
        let opened = state.read(cx).opened.clone();
        fields.push(
            DatePicker::root(p, cx)
                .child(div().capture_any_mouse_up(move |e, window, cx| {
                    if e.button != gpui::MouseButton::Left {
                        return;
                    }
                    // Once the click is over, so the popup doesn't take its own press as one outside.
                    let (opener, opened) = (opener.clone(), opened.clone());
                    window.defer(cx, move |_, cx| {
                        if opened.get().0 {
                            return;
                        }
                        opened.set((true, Some(std::time::Instant::now())));
                        opener.update(cx, |p, cx| p.set_controlled_open(Some(true), cx));
                    });
                }).child(input))
                .children(calendar(p, &l, cx))
                .into_any_element(),
        );
    }
    if let Some(t) = &clock {
        let root = TimeInput::root(t, cx);
        let segments = root.state().segments.clone();
        let t2 = t.clone();
        fields.push(
            root.flex()
                .items_center()
                .h(u(24.))
                .children(segments.iter().map(|seg| {
                    TimeInput::segment(&t2, seg, cx)
                        .with(move |el, st| if st.editable { el.h(u(20.)).px(px(1.)).rounded(u(3.)) } else { el.child(st.text.clone()).text_color(l.ink3) })
                        .focus(move |s| s.bg(l.ink).text_color(l.bg))
                        .into_any_element()
                }))
                .into_any_element(),
        );
    }
    let line = div()
        .flex()
        .h(u(24.))
        .items_center()
        .gap(u(10.))
        .px(u(8.))
        .text_size(u(13.))
        .when(!label.is_empty(), |d| {
            // A `<label>` round the fields: a press on its words puts focus in the first.
            let to = fields_focus.clone();
            d.child(
                div()
                    .id(ctx.id(c, "label"))
                    .flex_none()
                    .text_color(l.ink2)
                    .on_click(move |_, window, cx| {
                        window.focus(&to, cx);
                        window.focus_next(cx);
                    })
                    .child(SharedString::from(label)),
            )
        })
        .child(div().flex().items_center().gap(u(10.)).track_focus(&fields_focus.clone().tab_stop(false)).children(fields));
    share(line2_b(div().flex().flex_col(), &l), c, ctx).child(line).children(problems(c, ctx)).into_any_element()
}

trait FlagOf {
    fn flag_of(&self, c: &Value, key: &str) -> bool;
}

impl FlagOf for Ctx {
    fn flag_of(&self, c: &Value, key: &str) -> bool {
        self.scope.flag(c, key)
    }
}
