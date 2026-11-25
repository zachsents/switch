//! The house's lines (the desktop's `widgets/catalog.tsx`, `check.tsx`, `entry.tsx`,
//! `set-mutation.ts`): Line, its mark, its name and a time that runs while it does (`left` down,
//! `elapsed` up); Slot, a line in time; Field, a label and its value with a red triangle when it's
//! worth a look; Title, what a card is about; Check, a line that ticks off, its ring calling the
//! extension; Entry, a line to write in, Enter sending what's written to the extension. A part's call
//! to its extension goes through the core's `/widgets`, and its surface's data comes again after.

use std::rc::Rc;

use gpui::{AnyElement, App, Entity, FontWeight, InteractiveElement, IntoElement, KeyDownEvent, ParentElement, StatefulInteractiveElement, Styled, Window, div, prelude::*, px};
use serde_json::{Map, Value};

use crate::look::u;
use crate::marks;
use crate::time::now_ms;
use crate::widgets::basic::{data, span_of, warn};
use crate::widgets::house::{record, runner};
use crate::widgets::render::Ctx;

/// A call to a part's extension under way, and what it said went wrong.
#[derive(Default)]
pub struct Calling {
    pub pending: bool,
    pub error: Option<String>,
}

/// Calls the extension's `tool` with `args` and `values` over them (a Pick's Set, a Check's ring, an
/// Entry's words); `done` runs once it takes it.
pub fn run(key: &str, tool: &str, args: Map<String, Value>, values: Map<String, Value>, state: Entity<Calling>, done: impl FnOnce(&mut App) + 'static, cx: &mut App) {
    if state.read(cx).pending {
        return;
    }
    state.update(cx, |s, cx| {
        s.pending = true;
        s.error = None;
        cx.notify();
    });
    #[cfg(feature = "shot")]
    eprintln!("call {key} {tool} {} {}", Value::Object(args.clone()), Value::Object(values.clone()));
    // The set mutation (set-mutation.ts): its call, what it's always given and what was chosen.
    let call = crate::items::Call { app: key.split('/').next().unwrap_or_default().to_string(), tool: tool.to_string(), args: Value::Object(args) };
    let chosen: std::collections::HashMap<String, String> = values.into_iter().filter_map(|(k, v)| v.as_str().map(|v| (k, v.to_string()))).collect();
    let task = crate::model::model(cx).update(cx, |m, cx| m.widget_set(&call, chosen, cx));
    cx.spawn(async move |cx| {
        let got = task.await;
        let ok = got.is_ok();
        state.update(cx, |s, cx| {
            s.pending = false;
            s.error = got.err();
            cx.notify();
        });
        if ok {
            cx.update(done);
        }
    })
    .detach();
}

/// Whether a Check's or an Entry's call to its extension failed: what it said shows on its line.
pub fn failed(name: &str, c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> bool {
    let calling = if name == "Check" { ctx.state(c, "check", window, cx, |_, _| Calling::default()) } else { writing(c, ctx, window, cx).read(cx).calling.clone() };
    calling.read(cx).error.is_some()
}

/// Words as React draws a value: a string or a figure; a flag or nothing draws none.
fn drawn(v: &Value) -> String {
    match v {
        Value::String(_) | Value::Number(_) => crate::a2ui::words_of(v),
        _ => String::new(),
    }
}

fn line_base() -> gpui::Div {
    div().flex().h(u(24.)).items_center().gap(u(10.)).px(u(8.)).text_size(u(13.)).line_height(u(16.))
}

pub fn line(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = ctx.look;
    let running = ctx.scope.flag(c, "running");
    let now = now_ms();
    let since = if running { (now - ctx.scope.number(c, "asOf").unwrap_or(now)).max(0.) } else { 0. };
    let time = match (ctx.scope.number(c, "left"), ctx.scope.number(c, "elapsed")) {
        (Some(left), _) => Some(span_of(left - since, false)),
        (None, Some(e)) => Some(span_of(e + since, false)),
        _ => None,
    };
    line_base()
        .text_color(l.ink)
        .when(ctx.scope.flag(c, "ringing"), |d| d.child(marks::hand(px(14.), &l)))
        .when(running, |d| d.child(runner(c, ctx, window, cx)))
        .child(div().flex_1().min_w_0().truncate().child(drawn(&ctx.scope.prop(c, "label"))))
        .children(time.map(|t| data(t, &l)))
        .into_any_element()
}

pub fn slot(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = ctx.look;
    line_base()
        .text_color(l.ink)
        .child(div().w(px(68.)).flex_none().text_size(u(11.)).line_height(u(14.)).text_color(l.ink2).child(drawn(&ctx.scope.prop(c, "time"))))
        .when(ctx.scope.flag(c, "needsYou"), |d| d.child(marks::hand(px(14.), &l)))
        .when(ctx.scope.flag(c, "running"), |d| d.child(runner(c, ctx, window, cx)))
        .when(ctx.scope.flag(c, "conflict"), |d| d.child(warn(px(14.), &l)))
        .child(div().flex_1().min_w_0().truncate().child(drawn(&ctx.scope.prop(c, "title"))))
        .into_any_element()
}

/// A line of label and value: its value whole, on the same line when it fits, else on its own under
/// the label.
pub fn field(c: &Value, ctx: &Ctx) -> AnyElement {
    let l = ctx.look;
    let value = drawn(&ctx.scope.prop(c, "value"));
    div()
        .flex()
        .flex_wrap()
        .min_h(u(24.))
        .items_center()
        .gap_x(u(10.))
        .px(u(8.))
        .py(u(6.))
        .text_size(u(13.))
        .line_height(u(16.))
        .text_color(l.ink)
        .when(ctx.scope.flag(c, "alert"), |d| d.child(warn(px(14.), &l)))
        .child(div().min_w_0().truncate().child(drawn(&ctx.scope.prop(c, "label"))))
        .when(!value.is_empty(), |d| d.child(div().ml_auto().text_size(u(11.)).line_height(u(14.)).whitespace_nowrap().text_color(l.ink3).child(value)))
        .into_any_element()
}

/// What a card is about, in reading size, with a hand when it needs the user.
pub fn title(c: &Value, ctx: &Ctx) -> AnyElement {
    let l = ctx.look;
    div()
        .flex()
        .min_h(u(24.))
        .items_center()
        .gap(u(10.))
        .px(u(8.))
        .py(u(8.))
        .text_size(u(14.))
        .line_height(u(20.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(l.ink)
        .when(ctx.scope.flag(c, "needsYou"), |d| d.child(marks::hand(px(14.), &l)))
        .child(div().flex_1().min_w_0().child(drawn(&ctx.scope.prop(c, "label"))))
        .into_any_element()
}

/// A line that ticks off: its ring, its name and its data. The ring calls the extension's `action`
/// with `args`; a done one's ring is filled and its name dimmed. A hairline under each.
pub fn check(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    let l = ctx.look;
    let state = ctx.state(c, "check", window, cx, |_, _| Calling::default());
    let (pending, error) = {
        let s = state.read(cx);
        (s.pending, s.error.clone())
    };
    let done = ctx.scope.flag(c, "done");
    let detail = error.unwrap_or_else(|| ctx.scope.text(c, "detail"));
    let (key, tool, args) = (ctx.surface_key(), c.get("action").and_then(Value::as_str).unwrap_or_default().to_string(), record(&ctx.scope.prop(c, "args")));
    // A key (Base UI's Button): Tab, Space and Enter, its focus ring; off while its call is out.
    let ring = div()
        .id(ctx.id(c, "ring"))
        .role(gpui::Role::Button)
        .aria_label(if done { "Not done" } else { "Done" })
        .flex_none()
        .size(px(14.))
        .rounded_full()
        .border(px(1.5))
        .map(|d| if done { d.border_color(l.ink3).bg(l.ink3) } else { d.border_color(l.ink2).hover(|s| s.bg(l.hover)) })
        .when(pending, |d| d.opacity(0.4))
        .when(!pending, |d| crate::kit::focusable(d, &l).on_click(move |_, _, cx| run(&key, &tool, args.clone(), Map::new(), state.clone(), |_| {}, cx)));
    line_base()
        .border_b(px(l.w2))
        .border_color(l.line2)
        .child(ring)
        .child(div().flex_1().min_w_0().truncate().text_color(if done { l.ink3 } else { l.ink }).child(ctx.scope.text(c, "label")))
        .when(!detail.is_empty(), |d| d.child(data(detail, &l)))
        .into_any_element()
}

/// The words an Entry is writing, and its call.
pub struct Writing {
    input: Entity<ui_sdk::components::input::Input>,
    calling: Entity<Calling>,
    /// Off while its call is out, and the placeholder it was given.
    off: bool,
    placeholder: String,
}

/// A line to write in: no border, its placeholder a word or two. Enter calls the extension's
/// `action` with `args` and what was written under `field`, and clears it once the extension takes it.
/// An Entry's field and its call, made once.
fn writing(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> Entity<Writing> {
    let placeholder = ctx.scope.text(c, "placeholder");
    let first = entry_options(&placeholder, false);
    ctx.state(c, "entry", window, cx, move |window, cx| Writing {
        input: cx.new(|cx| ui_sdk::components::input::Input::new(first, window, cx)),
        calling: cx.new(|_| Calling::default()),
        off: false,
        placeholder,
    })
}

fn entry_options(placeholder: &str, off: bool) -> ui_sdk::components::input::InputOptions {
    ui_sdk::components::input::InputOptions::default().placeholder(placeholder.to_string()).disabled(off).field_style(crate::kit::field_style())
}

pub fn entry(c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> AnyElement {
    use ui_sdk::components::input::Input;
    let l = ctx.look;
    let placeholder = ctx.scope.text(c, "placeholder");
    let options = {
        let p = placeholder.clone();
        move |off: bool| entry_options(&p, off)
    };
    let state = writing(c, ctx, window, cx);
    let (input, calling) = {
        let s = state.read(cx);
        (s.input.clone(), s.calling.clone())
    };
    let (pending, error) = {
        let s = calling.read(cx);
        (s.pending, s.error.clone())
    };
    // Not to be written in while its call is out (entry.tsx's `disabled`).
    // Its placeholder as the model says now.
    if state.read(cx).off != pending || state.read(cx).placeholder != placeholder {
        let p = placeholder.clone();
        state.update(cx, |s, _| {
            s.off = pending;
            s.placeholder = p;
        });
        input.update(cx, |i, cx| i.set_options(options(pending), window, cx));
    }
    let (key, tool, args, name) = (
        ctx.surface_key(),
        c.get("action").and_then(Value::as_str).unwrap_or_default().to_string(),
        record(&ctx.scope.prop(c, "args")),
        c.get("field").and_then(Value::as_str).unwrap_or_default().to_string(),
    );
    let submit = {
        let input = input.clone();
        Rc::new(move |window: &mut Window, cx: &mut App| {
            let text = input.read(cx).get_value().trim().to_string();
            if text.is_empty() {
                return;
            }
            let mut values = Map::new();
            values.insert(name.clone(), Value::String(text));
            let clear = input.clone();
            let handle = window.window_handle();
            run(&key, &tool, args.clone(), values, calling.clone(), move |cx| {
                handle.update(cx, |_, window, cx| clear.update(cx, |i, cx| i.clear(Default::default(), window, cx))).ok();
            }, cx);
        })
    };
    div()
        .flex()
        .h(u(24.))
        .items_center()
        .gap(u(10.))
        .pr(u(8.))
        .on_key_down(move |e: &KeyDownEvent, window, cx| {
            // A form's Enter: not with Control or Command, nor while an input method composes.
            let m = e.keystroke.modifiers;
            if e.keystroke.key == "enter" && !m.control && !m.platform && !ui_sdk::kernel::events::is_composing(window, cx) && !pending {
                submit(window, cx);
            }
        })
        .child(Input::root(&input, cx).text_color(l.ink).aria_label(placeholder.clone()).h_full().flex_1().min_w_0().pl(u(8.)).text_size(u(13.)).when(pending, |d| d.opacity(0.4)))
        .children(error.map(|e| div().min_w_0().flex_shrink(1.).truncate().text_size(u(12.)).text_color(l.red).child(e)))
        .into_any_element()
}
