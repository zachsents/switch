//! System (the desktop's `ui/system-page.tsx` and `brain/system.ts`'s system page): what the agent
//! runs on and spends, its recent turns with model and effort, what each Mac lets extensions do, and
//! the brain's own counts. The page is the data layer's query (`queries::system`), read again every
//! 30 s while shown.

use chrono::NaiveDate;
use gpui::{AnyElement, App, ElementId, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement, Styled, Window, div, prelude::*};

use crate::band::tip;
use crate::kit;
use crate::look::{Look, MONO, u};
use crate::model::model;
use crate::queries;
use crate::settings::calls::num;
use crate::settings::parts::{data, line, notice, section, warn};
use crate::time::{now_ms, span_of, time_of};

fn dollars(n: f64) -> String {
    format!("${n:.2}")
}

fn percent(n: f64) -> String {
    format!("{}%", (n * 100. + 0.5).floor())
}

/// A usage window's name, "seven_day", as "7 day".
fn window_name(name: &str) -> String {
    const NUMBERS: [(&str, &str); 10] = [("one", "1"), ("two", "2"), ("three", "3"), ("four", "4"), ("five", "5"), ("six", "6"), ("seven", "7"), ("eight", "8"), ("nine", "9"), ("ten", "10")];
    name.split('_').map(|w| NUMBERS.iter().find(|(k, _)| *k == w).map(|(_, v)| *v).unwrap_or(w)).collect::<Vec<_>>().join(" ")
}

/// "screenRecording" as "Screen Recording".
fn words(name: &str) -> String {
    let mut out = String::new();
    let mut last: Option<char> = None;
    for c in name.chars() {
        if c.is_ascii_uppercase() && last.is_some_and(|p| p.is_ascii_lowercase()) {
            out.push(' ');
        }
        out.push(c);
        last = Some(c);
    }
    let mut cs = out.chars();
    match cs.next() {
        Some(f) => f.to_uppercase().collect::<String>() + cs.as_str(),
        None => out,
    }
}

/// A local date ("2026-11-20") as its day, in the Mac's locale: "Friday, Nov 20".
fn day_name(date: &str) -> String {
    use chrono::TimeZone;
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(12, 0, 0))
        .and_then(|t| chrono::Local.from_local_datetime(&t).single())
        .map(|t| crate::time::day_of(t.timestamp_millis() as f64))
        .unwrap_or_else(|| date.to_string())
}

/// A span to the minute: "1:05".
fn span_minutes(ms: f64) -> String {
    let minutes = (ms.max(0.).trunc() / 60_000.).round() as u64;
    format!("{}:{:02}", minutes / 60, minutes % 60)
}

fn agent_section(now: f64, l: &Look, cx: &App) -> Option<AnyElement> {
    let subscriptions: Vec<crate::brain::Subscription> = model(cx).read(cx).brain.subscriptions.values().cloned().collect();
    if subscriptions.is_empty() {
        return None;
    }
    let figure = |d: gpui::Div| kit::caption(d).flex_none().text_color(l.ink3);
    let rows: Vec<AnyElement> = subscriptions
        .iter()
        .map(|a| {
            line(l)
                .id(ElementId::Name(format!("agent-{}", a.host).into()))
                .when(!a.problem.is_empty(), |d| d.tooltip(tip(a.problem.clone())))
                .child(div().min_w_0().truncate().child(a.label.clone()))
                .when(!a.up, |d| d.child(warn(l)))
                .when(!a.problem.is_empty(), |d| d.child(kit::small(div()).truncate().text_color(l.red).child(a.problem.clone())))
                // Columns of their own, so each figure sits under the one above it.
                .child(figure(div()).ml_auto().w(u(224.)).flex().justify_end().gap(u(12.)).children(a.windows.iter().map(|w| div().child(format!("{} {}", window_name(&w.name), percent(w.used))))))
                .child(figure(div()).w(u(64.)).flex().justify_end().when(a.limited_until > now, |d| d.child(span_minutes(a.limited_until - now))))
                .child(figure(div()).w(u(64.)).flex().justify_end().child(a.provider.clone()))
                .into_any_element()
        })
        .collect();
    Some(section("Agent", Some(subscriptions.len()), rows, l))
}

pub fn render(window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let now = now_ms();
    let q = queries::system(cx);
    let (s, error) = (q.data, q.error);
    let mut body = div().flex().flex_col();
    if let Some(e) = error {
        body = body.child(notice(e, &l));
    }
    if let Some(a) = agent_section(now, &l, cx) {
        body = body.child(a);
    }
    if let Some(s) = s {
        if !s.spend.is_empty() {
            let rows = s.spend.iter().map(|d| line(&l).child(div().min_w_0().flex_1().truncate().child(day_name(&d.day))).child(data(num(d.turns), Some(64.), &l)).child(data(dollars(d.cost), Some(96.), &l)).into_any_element());
            body = body.child(section("Spend", None, rows, &l));
        }
        if !s.turns.is_empty() {
            let rows = s.turns.iter().enumerate().map(|(i, t)| {
                let what = [t.model.as_str(), t.effort.as_str()].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" · ");
                line(&l)
                    .id(ElementId::Name(format!("turn-{i}").into()))
                    .when(!t.host.is_empty(), |d| d.tooltip(tip(t.host.clone())))
                    .child(div().min_w_0().flex_1().truncate().child(if t.title.is_empty() { t.thread.clone() } else { t.title.clone() }))
                    .when(t.status != "done", |d| d.child(warn(&l)))
                    .child(data(what, Some(160.), &l))
                    .child(data(span_of(t.ms), Some(64.), &l))
                    .child(data(dollars(t.cost), Some(96.), &l))
                    .child(data(time_of(t.time), Some(80.), &l))
                    .into_any_element()
            });
            body = body.child(section("Turns", None, rows, &l));
        }
        if !s.permissions.is_empty() {
            let rows = s.permissions.iter().flat_map(|m| {
                let l = &l;
                m.granted.iter().map(move |g| line(l).child(div().min_w_0().flex_1().truncate().child(words(&g.name))).when(!g.on, |d| d.child(warn(l))).child(data(m.machine.clone(), None, l)).into_any_element())
            });
            body = body.child(section("Permissions", None, rows.collect::<Vec<_>>(), &l));
        }
        let mono = |t: String| kit::data(div()).min_w_0().flex_1().truncate().font_family(MONO).child(t);
        let mut rows: Vec<AnyElement> = vec![
            line(&l).child(div().min_w_0().flex_1().truncate().child("Seq")).child(data(num(s.debug.seq), None, &l)).into_any_element(),
            line(&l).child(div().min_w_0().flex_1().truncate().child("Brain")).child(data(format!("{:.1} MB", s.debug.bytes / 1e6), None, &l)).into_any_element(),
        ];
        rows.extend(s.debug.types.iter().map(|t| line(&l).child(mono(t.kind.clone())).child(data(num(t.n), None, &l)).into_any_element()));
        rows.extend(s.debug.projections.iter().map(|p| line(&l).child(mono(p.name.clone())).child(data(format!("v{}", num(p.version)), None, &l)).into_any_element()));
        body = body.child(section("Debug", None, rows, &l));
    }
    kit::pane_scroll("system", None, body, window, cx)
}
