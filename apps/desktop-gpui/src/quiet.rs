//! A chat's blips (the desktop's `ui/quiet-line.tsx` and `blip.tsx`): what happened rather than
//! what was said, one centred line, a mark and a few words — an app's outcome, or a memory a turn
//! learned here. A click opens the whole of it, when, and what can be done about it (Undo forgets a
//! memory, putting back what it replaced). A condition's blip spans from its first event to its
//! latest ("Until 4:10 PM").

use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, InteractiveElement, IntoElement, ParentElement, Pixels, SharedString, StatefulInteractiveElement,
    Styled, Window, anchored, deferred, div, point, prelude::*, px,
};

use crate::brain::Quiet;
use crate::kit::{self, Btn};
use crate::look::{Look, u};
use crate::markdown;
use crate::marks;
use crate::select::Sel;
use crate::time::{time_of, when_of};

/// A blip's few words: its text's first clause, up to about forty characters.
static CLAUSE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"[.;:]\s|\s[–—]\s").expect("gist"));

pub fn gist(text: &str) -> String {
    let first = match CLAUSE.find(text) {
        Some(m) => {
            let cut = &text[..m.start()];
            let sep = &text[m.start()..m.end()];
            // `(?<=[.;:])\s` keeps the mark with the clause.
            if sep.starts_with(['.', ';', ':']) { format!("{cut}{}", &sep[..1]) } else { cut.to_string() }
        }
        None => text.to_string(),
    };
    let clause = first.strip_suffix(['.', ';', ':', ',']).unwrap_or(&first).to_string();
    if clause.chars().count() > 44 {
        let cut: String = clause.chars().take(42).collect();
        let cut = match cut.rfind(char::is_whitespace) {
            Some(i) => cut[..i].to_string(),
            None => cut,
        };
        format!("{cut}…")
    } else {
        clause
    }
}

/// The blip itself: its mark and few words, centred.
pub fn blip(key: &str, quiet: &Quiet, text: &str, order: u64, sel: &Sel, at: Rc<std::cell::RefCell<std::collections::HashMap<String, Bounds<Pixels>>>>, on_open: Rc<dyn Fn(Bounds<Pixels>, &mut Window, &mut App)>, l: &Look) -> AnyElement {
    let mark = match quiet {
        Quiet::Learned { .. } => "learned",
        Quiet::Event { .. } => "event",
    };
    // Where it's drawn, each frame: its popover keeps to it as the column scrolls.
    let (k1, k2, at2) = (key.to_string(), key.to_string(), at.clone());
    div()
        .flex()
        .justify_center()
        .child(
            // `max-w-[min(100%,360px)]`: it gives way in a narrow column.
            kit::button(SharedString::from(format!("{key}.blip")), Btn::Flat, true, l)
                .flex_shrink(1.)
                .min_w_0()
                .max_w(u(360.))
                .rounded_full()
                .px(u(10.))
                .text_color(l.ink2)
                .on_click(move |_, window, cx| {
                    let b = at2.borrow().get(&k1).copied().unwrap_or_default();
                    on_open(b, window, cx)
                })
                .child(marks::blip(mark, l.ink2))
                // Its words are the page's, as ⌘A takes them; a press on them is the blip's.
                .child(div().min_w_0().truncate().child(markdown::plain(&gist(text), format!("{key}.gist"), (order, crate::select::WORDS), sel).pointer(true)))
                .child(gpui::canvas(move |b, _, _| {
                    at.borrow_mut().insert(k2.clone(), b);
                }, |_, _, _, _| {}).absolute().top_0().left_0().size_full()),
        )
        .into_any_element()
}

/// What an open blip shows: the whole of it, when, and Undo for a memory.
pub struct Open {
    pub key: String,
    pub anchor: Bounds<Pixels>,
    pub text: String,
    pub time: Option<f64>,
    pub quiet: Quiet,
    pub forgetting: bool,
    pub error: Option<String>,
}

/// The blip's popover, under it.
pub fn popover(o: &Open, sel: &Sel, on_close: Rc<dyn Fn(&mut Window, &mut App)>, on_undo: Rc<dyn Fn(&mut Window, &mut App)>, l: &Look) -> AnyElement {
    let until = match (&o.quiet, o.time) {
        (Quiet::Event { until }, Some(t)) if time_of(*until) != time_of(t) => Some(format!("Until {}", time_of(*until))),
        _ => None,
    };
    let learned = matches!(o.quiet, Quiet::Learned { .. });
    let x = o.anchor.left() + o.anchor.size.width / 2.;
    let y = o.anchor.bottom() + px(4.);
    let body = kit::float(l)
        .id("blip-open")
        .occlude()
        .flex()
        .flex_col()
        .w(px(320.))
        .gap(u(8.))
        .p(u(8.))
        .text_size(u(12.))
        .line_height(u(16.))
        // A press on its own blip is the blip's: its click shuts it, rather than this shutting it
        // and the click opening it again.
        .on_mouse_down_out({
            let blip = o.anchor;
            move |e, window, cx| {
                if !blip.contains(&e.position) {
                    on_close(window, cx);
                }
            }
        })
        .child(
            div()
                .whitespace_normal()
                .child(markdown::plain(&o.text, format!("{}.whole", o.key), (u64::MAX - 1, 0), sel))
                .when_some(until, |d, u_| d.child(div().mt(u(4.)).text_color(l.ink2).child(u_))),
        )
        .when(o.time.is_some() || learned, |d| {
            d.child(
                div()
                    .flex()
                    .items_center()
                    .gap(u(8.))
                    .text_color(l.ink2)
                    .when_some(o.time, |d, t| d.child(when_of(t)))
                    .child(
                        div()
                            .ml_auto()
                            .flex()
                            .items_center()
                            .gap(u(4.))
                            .when_some(o.error.clone(), |d, e| d.child(div().text_color(l.red).child(e)))
                            .when(learned, |d| d.child(kit::button("blip-undo", Btn::Flat, !o.forgetting, l).when(!o.forgetting, |b| b.on_click(move |_, window, cx| on_undo(window, cx))).aria_label("Undo").child("Undo"))),
                    ),
            )
        });
    deferred(anchored().anchor(gpui::Anchor::TopCenter).position(point(x, y)).snap_to_window_with_margin(px(8.)).child(div().relative().child(body).child(crate::webview::covering()))).with_priority(2).into_any_element()
}
