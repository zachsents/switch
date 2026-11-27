//! The charts in the gallery (`charts/gallery.tsx`, `held.tsx`, `fixtures.ts`; dev builds, here under
//! `--features shot`): each chart in its states, from the messages a widget would send, its data in
//! the components or bound to the surface's data model, drawn in a cell at its width through the same
//! host as an extension's widget. With `$SWITCH_GPUI_SHOT` set and `charts` among
//! `$SWITCH_GPUI_PAGES`, a window shows each chart's section in turn and saves it; with
//! `$SWITCH_GPUI_DRIVE` too, each section's first chart again under the pointer (`-hover`) and from
//! the keys (`-keys`: Tab onto it, then → twice), and what VoiceOver is told of the section
//! (`-ax.json`, gpui's accessibility tree, asked for as VoiceOver asks).

use std::time::Duration;

use gpui::{
    App, AppContext, Bounds, Context, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Window, WindowBounds, WindowOptions, div, px, size,
};
use serde_json::{Value, json};

use crate::a2ui::SWITCH_CATALOG;
use crate::look::{Look, SANS};
use crate::widgets::host::Host;
use crate::widgets::render::{self, Ctx};

pub struct Fixture {
    pub id: String,
    pub name: String,
    pub width: f32,
    pub messages: Vec<Value>,
}

/// JavaScript's `Math.round`: halves up.
fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn fixture(id: &str, name: &str, chart: Value, data: Option<Value>, width: f32) -> Fixture {
    let mut root = chart;
    root["id"] = json!("root");
    let mut messages = vec![
        json!({ "version": "1.0", "createSurface": { "surfaceId": id, "catalogId": SWITCH_CATALOG } }),
        json!({ "version": "1.0", "updateComponents": { "surfaceId": id, "components": [root] } }),
    ];
    if let Some(d) = data {
        messages.push(json!({ "version": "1.0", "updateDataModel": { "surfaceId": id, "path": "/", "value": d } }));
    }
    Fixture { id: id.into(), name: name.into(), width, messages }
}

fn f(id: &str, name: &str, chart: Value) -> Fixture {
    fixture(id, name, chart, None, 420.)
}

/// Numbers that look measured, the same every time.
fn wave(n: usize, base: f64, swing: f64, seed: f64) -> Vec<f64> {
    (0..n).map(|i| round(base + swing * (i as f64 * 0.7 + seed).sin() + (swing / 3.) * (i as f64 * 2.3 + seed * 3.).sin())).collect()
}

const WEEK: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NAMES: [&str; 10] = ["North", "South", "East", "West", "Central", "Coast", "Hills", "Lakes", "Plains", "Ridge"];

fn many(n: usize, count: usize) -> Vec<Value> {
    NAMES[..n].iter().enumerate().map(|(k, name)| json!({ "name": name, "values": wave(count, 20. + k as f64 * 3., 6., k as f64) })).collect()
}

/// A bell of `n` values round `mid`.
fn spread(n: usize, mid: f64, width: f64) -> Vec<f64> {
    (0..n)
        .map(|i| {
            let i = i as f64;
            let a = (i * 12.9898).sin() * 43_758.5453;
            let b = (i * 78.233).sin() * 12_345.6789;
            let c = (i * 39.425).sin() * 24_634.6345;
            let u = (a - a.floor() + (b - b.floor()) + (c - c.floor())) / 3.;
            round((mid + (u - 0.5) * 2. * width) * 10.) / 10.
        })
        .collect()
}

/// A value for each day of `days` up to `to`, some days with none.
fn daily(to: &str, days: i64, gaps: bool) -> Vec<Value> {
    let last = chrono::NaiveDate::parse_from_str(to, "%Y-%m-%d").unwrap_or_default();
    (0..days)
        .filter_map(|i| {
            let day = last - chrono::Duration::days(days - 1 - i);
            let x = i as f64;
            let v = round(4. + 4. * (x * 0.31).sin() + 3. * (x * 1.7).sin()).max(0.);
            (!(gaps && i % 9 == 4)).then(|| json!({ "date": day.format("%Y-%m-%d").to_string(), "value": v }))
        })
        .collect()
}

fn points(n: usize, seed: f64, slope: f64) -> Vec<Value> {
    (0..n)
        .map(|i| {
            let x = round((10. + ((i as f64 * 37. + seed * 11.) % 60.)) * 10.) / 10.;
            let y = round((slope * x + 8. * (i as f64 * 1.3 + seed).sin() + seed * 6.) * 10.) / 10.;
            json!([x, y])
        })
        .collect()
}

pub fn fixtures() -> Vec<(&'static str, Vec<Fixture>)> {
    let stacked: Vec<Value> = many(4, 6)
        .into_iter()
        .map(|mut s| {
            let v: Vec<f64> = s["values"].as_array().into_iter().flatten().filter_map(Value::as_f64).map(|v| v * 120.).collect();
            s["values"] = json!(v);
            s
        })
        .collect();
    vec![
        (
            "Bar chart",
            vec![
                f("bar-columns", "Columns", json!({ "component": "BarChart", "labels": WEEK, "series": [{ "name": "Orders", "values": [12, 18, 9, 22, 30, 14, 7] }] })),
                f("bar-grouped", "Grouped", json!({ "component": "BarChart", "labels": ["Q1", "Q2", "Q3", "Q4"], "series": many(3, 4) })),
                f("bar-stacked", "Stacked", json!({ "component": "BarChart", "labels": &MONTHS[..6], "series": stacked, "stacked": true, "prefix": "$" })),
                f(
                    "bar-rows",
                    "Horizontal",
                    json!({ "component": "BarChart", "labels": ["Search", "Direct", "Email", "Social", "Referral"], "series": [{ "name": "Visits", "values": [4820, 3110, 1460, 980, 410] }], "horizontal": true }),
                ),
                f(
                    "bar-rows-stacked",
                    "Horizontal stacked",
                    json!({ "component": "BarChart", "labels": ["Kitchen", "Office", "Garage", "Porch"], "series": [{ "name": "Done", "values": [6, 3, 8, 2] }, { "name": "Open", "values": [2, 5, 1, 4] }], "horizontal": true, "stacked": true }),
                ),
                f("bar-folded", "Ten stacked", json!({ "component": "BarChart", "labels": &MONTHS[..6], "series": many(10, 6), "stacked": true })),
                f(
                    "bar-negative",
                    "Below zero",
                    json!({ "component": "BarChart", "labels": &MONTHS[..8], "series": [{ "name": "Margin", "values": [4.2, 2.8, -1.5, -3.1, 0.6, 3.9, 5.4, -0.8] }], "suffix": "%" }),
                ),
                fixture(
                    "bar-bound",
                    "Bound",
                    json!({ "component": "BarChart", "labels": { "@path": "/labels" }, "series": { "@path": "/series" }, "height": 140 }),
                    Some(json!({ "labels": ["A", "B", "C", "D", "E"], "series": [{ "name": "Count", "values": [3, null, 5, 2, 4] }] })),
                    420.,
                ),
                f("bar-empty", "Unreadable", json!({ "component": "BarChart", "labels": { "@path": "/missing" }, "series": [{ "name": "None", "values": [] }] })),
            ],
        ),
        (
            "Line chart",
            vec![
                f("line-one", "One", json!({ "component": "LineChart", "labels": MONTHS, "series": [{ "name": "Visits", "values": wave(12, 1800., 600., 1.) }] })),
                f(
                    "line-three",
                    "Three",
                    json!({ "component": "LineChart", "labels": MONTHS, "series": [
                        { "name": "North", "values": wave(12, 62., 9., 0.) },
                        { "name": "South", "values": wave(12, 41., 7., 2.) },
                        { "name": "West", "values": wave(12, 20., 5., 4.) },
                    ], "suffix": "°" }),
                ),
                f(
                    "line-gaps",
                    "Gaps",
                    json!({ "component": "LineChart", "labels": WEEK, "series": [
                        { "name": "Morning", "values": [71.2, 71, null, 70.6, 70.9, null, 70.4] },
                        { "name": "Evening", "values": [72, 71.8, 71.5, null, 71.6, 71.2, 71.1] },
                    ], "suffix": " kg" }),
                ),
                f("line-folded", "Ten", json!({ "component": "LineChart", "labels": MONTHS, "series": many(10, 12) })),
            ],
        ),
        (
            "Area chart",
            vec![
                f(
                    "area-overlaid",
                    "Overlaid",
                    json!({ "component": "AreaChart", "labels": MONTHS, "series": [{ "name": "Sent", "values": wave(12, 40., 12., 1.) }, { "name": "Opened", "values": wave(12, 22., 8., 1.4) }] }),
                ),
                f("area-stacked", "Stacked", json!({ "component": "AreaChart", "labels": MONTHS, "series": many(3, 12), "stacked": true })),
                f("area-folded", "Ten stacked", json!({ "component": "AreaChart", "labels": MONTHS, "series": many(10, 12), "stacked": true })),
                f(
                    "area-limit",
                    "Up to a limit",
                    json!({
                        "component": "AreaChart",
                        "labels": (0..=24).map(|h| format!("{h}:00")).collect::<Vec<_>>(),
                        "ticks": (0..=24).map(|h| if h % 6 == 0 && h > 0 { format!("{h}:00") } else { String::new() }).collect::<Vec<_>>(),
                        "series": [{ "name": "Used", "values": (0..=24).map(|h| if h > 16 { Value::Null } else { json!(((h % 8) as f64 * 11.).min(100.)) }).collect::<Vec<_>>() }],
                        "suffix": "%",
                        "max": 100,
                        "limit": 100,
                    }),
                ),
            ],
        ),
        (
            "Sparkline",
            vec![
                f("spark-line", "A line's height", json!({ "component": "Sparkline", "values": wave(24, 50., 15., 2.) })),
                f("spark-tall", "48 px", json!({ "component": "Sparkline", "values": wave(30, 120., 40., 5.), "height": 48 })),
                f("spark-one", "One value", json!({ "component": "Sparkline", "values": [3] })),
                fixture("spark-bound", "Bound", json!({ "component": "Sparkline", "values": { "@path": "/trend" } }), Some(json!({ "trend": wave(16, 10., 4., 3.) })), 420.),
            ],
        ),
        (
            "Donut chart",
            vec![
                f(
                    "donut-four",
                    "Four",
                    json!({ "component": "DonutChart", "slices": [
                        { "label": "Photos", "value": 182 }, { "label": "Apps", "value": 96 }, { "label": "Mail", "value": 41 }, { "label": "System", "value": 28 },
                    ], "suffix": " GB" }),
                ),
                f(
                    "donut-folded",
                    "Nine",
                    json!({ "component": "DonutChart", "slices": NAMES[..9].iter().enumerate().map(|(i, l)| json!({ "label": l, "value": 90 - i as i64 * 9 })).collect::<Vec<_>>() }),
                ),
                f("donut-one", "One", json!({ "component": "DonutChart", "slices": [{ "label": "Paid", "value": 14_250 }], "prefix": "$" })),
            ],
        ),
        (
            "Scatter chart",
            vec![
                f("scatter-one", "One", json!({ "component": "ScatterChart", "series": [{ "name": "Builds", "points": points(40, 1., 0.8) }], "xLabel": "Files", "yLabel": "Seconds" })),
                f(
                    "scatter-three",
                    "Three",
                    json!({ "component": "ScatterChart", "series": [
                        { "name": "Small", "points": points(20, 1., 0.6) },
                        { "name": "Medium", "points": points(20, 2., 0.9) },
                        { "name": "Large", "points": points(20, 3., 1.2) },
                    ] }),
                ),
                f(
                    "scatter-five",
                    "Five",
                    json!({ "component": "ScatterChart", "series": (1..=5).map(|k| json!({ "name": NAMES[k], "points": points(12, k as f64, 0.5) })).collect::<Vec<_>>() }),
                ),
            ],
        ),
        (
            "Histogram",
            vec![
                f("hist-own", "Its own bins", json!({ "component": "Histogram", "values": spread(240, 38., 30.), "suffix": " ms" })),
                f("hist-six", "Six bins", json!({ "component": "Histogram", "values": spread(80, 120., 60.), "bins": 6, "prefix": "$" })),
            ],
        ),
        (
            "Calendar heatmap",
            vec![
                fixture("cal-year", "A year", json!({ "component": "CalendarHeatmap", "days": daily("2026-11-21", 365, false) }), None, 860.),
                f("cal-weeks", "Six weeks, some days none", json!({ "component": "CalendarHeatmap", "days": daily("2026-11-21", 42, true) })),
                fixture("cal-bound", "Bound, narrow", json!({ "component": "CalendarHeatmap", "days": { "@path": "/days" } }), Some(json!({ "days": daily("2026-11-21", 120, false) })), 240.),
            ],
        ),
        (
            "Meter",
            vec![
                f("meter-share", "Share", json!({ "component": "Meter", "label": "Disk", "value": 62 })),
                f("meter-suffix", "Suffix", json!({ "component": "Meter", "label": "Memory", "value": 11.2, "max": 16, "suffix": " GB" })),
                f("meter-over", "Over", json!({ "component": "Meter", "label": "Battery", "value": 120 })),
                f("meter-bare", "No label", json!({ "component": "Meter", "value": 35 })),
                fixture("meter-bound", "Bound", json!({ "component": "Meter", "label": { "@path": "/name" }, "value": { "@path": "/used" } }), Some(json!({ "name": "Storage", "used": 8 })), 420.),
            ],
        ),
    ]
}

/// The gallery: one section of fixtures at a time.
pub struct Gallery {
    sections: Vec<(&'static str, Vec<Fixture>)>,
    pub at: usize,
}

impl Render for Gallery {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = Look::get(cx);
        let (name, fixtures) = &self.sections[self.at.min(self.sections.len() - 1)];
        let host = Host::entity(cx);
        let mut held = vec![];
        for fx in fixtures {
            let key = format!("gallery/{}", fx.id);
            let surface = host.update(cx, |h, _| h.surface(&key).unwrap_or_else(|| h.hold(&key, &fx.messages)));
            let mut ctx = Ctx::new(&key, surface, l);
            ctx.width = Some(fx.width * l.zoom);
            let drawn = render::surface(&ctx, window, cx);
            held.push(
                div()
                    .flex()
                    .flex_col()
                    .gap(l.z(6.))
                    .child(div().text_size(l.z(12.)).line_height(l.z(16.)).text_color(l.ink3).child(SharedString::from(fx.name.clone())))
                    .child(div().w(px(fx.width * l.zoom)).min_h(l.z(24.)).border(px(l.w1)).border_color(l.line1).child(drawn)),
            );
        }
        div()
            .size_full()
            .bg(l.bg)
            .text_color(l.ink)
            .font_family(SANS)
            .flex()
            .flex_col()
            .pt(l.z(30.))
            .child(div().flex().items_center().h(l.z(24.)).px(l.z(8.)).text_size(l.z(12.)).font_weight(FontWeight::SEMIBOLD).text_color(l.ink2).child(*name))
            .child(div().flex().flex_wrap().items_start().gap(l.z(16.)).px(l.z(8.)).pb(l.z(16.)).children(held))
    }
}

/// Where the pointer goes over each section's first chart, from the chart's top left (CSS px).
const HOVER: [Option<(f32, f32)>; 9] = [
    Some((230., 110.)),
    Some((230., 110.)),
    Some((230., 130.)),
    Some((230., 12.)),
    Some((139., 78.)),
    Some((230., 110.)),
    Some((230., 110.)),
    Some((430., 70.)),
    None,
];

/// Under `$SWITCH_GPUI_SHOT` with `charts` among the pages: each section drawn and saved.
pub fn shot(cx: &mut App) {
    let Ok(dir) = std::env::var("SWITCH_GPUI_SHOT") else { return };
    if !std::env::var("SWITCH_GPUI_PAGES").unwrap_or_default().split(',').any(|p| p == "charts") {
        return;
    }
    let drive = std::env::var("SWITCH_GPUI_DRIVE").is_ok();
    let bounds = Bounds::centered(None, size(px(1200.), px(900.)), cx);
    let Ok(window) = cx.open_window(WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() }, |_, cx| {
        cx.new(|_| Gallery { sections: fixtures(), at: 0 })
    }) else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    cx.spawn(async move |cx| {
        let count = fixtures().len();
        let save = |cx: &mut gpui::AsyncApp, name: String| {
            let shot = cx.update_window(window.into(), |_, window, _| window.render_to_image());
            if let Ok(Ok(img)) = shot {
                let path = format!("{dir}/{name}.png");
                let _ = img.save(&path);
                eprintln!("shot: {path}");
            }
        };
        let input = |cx: &mut gpui::AsyncApp, e: gpui::PlatformInput| {
            let _ = cx.update_window(window.into(), |_, window, cx| {
                window.dispatch_event(e, cx);
            });
        };
        let moved = |x: f32, y: f32| gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent { position: gpui::point(px(x), px(y)), pressed_button: None, modifiers: Default::default() });
        let key = |k: &'static str| {
            gpui::PlatformInput::KeyDown(gpui::KeyDownEvent { keystroke: gpui::Keystroke::parse(k).unwrap_or_default(), is_held: false, prefer_character_input: false })
        };
        for i in 0..count {
            let _ = window.update(cx, |g, window, cx| {
                g.at = i;
                window.blur(cx);
                cx.notify();
            });
            // Drawn once, then again once each chart knows its width.
            cx.background_executor().timer(Duration::from_millis(1200)).await;
            save(cx, format!("charts-{i:02}"));
            if !drive {
                continue;
            }
            // AppKit asks the window for its accessibility, as VoiceOver would: gpui builds its tree.
            let _ = cx.update_window(window.into(), |_, window, _| {
                if let Some(w) = crate::platform::appkit::ns_window(window)
                    && let Some(v) = w.contentView()
                {
                    // SAFETY: the window's live content view, on the main thread.
                    let _: *mut objc2::runtime::AnyObject = unsafe { objc2::msg_send![&*v, accessibilityChildren] };
                }
                window.refresh();
            });
            cx.background_executor().timer(Duration::from_millis(400)).await;
            let _ = cx.update_window(window.into(), |_, window, _| {
                let _ = std::fs::write(format!("{dir}/charts-{i:02}-ax.json"), window.debug_a11y_tree_json().unwrap_or_default());
            });
            let z = cx.update(|cx| Look::get(cx).zoom);
            // The first chart's top left: the section's heading, its name over it, inside its line.
            let (x0, y0) = (9. * z, (30. + 24. + 16. + 6. + 1.) * z);
            if let Some((x, y)) = HOVER.get(i).copied().flatten() {
                input(cx, moved(x0 + x * z, y0 + y * z));
                cx.background_executor().timer(Duration::from_millis(600)).await;
                save(cx, format!("charts-{i:02}-hover"));
            }
            if fixtures()[i].0 == "Calendar heatmap" {
                // The bound calendar's last day held, then its days cut to their first twenty under it:
                // the tooltip keeps the day as it was.
                input(cx, moved(771., 434.));
                cx.background_executor().timer(Duration::from_millis(600)).await;
                save(cx, format!("charts-{i:02}-held"));
                let _ = window.update(cx, |_, _, cx| {
                    let host = Host::entity(cx);
                    host.update(cx, |h, cx| h.write("gallery/cal-bound", "/days", json!(daily("2026-08-13", 20, false)), cx));
                    cx.notify();
                });
                cx.background_executor().timer(Duration::from_millis(600)).await;
                save(cx, format!("charts-{i:02}-shrunk"));
            }
            input(cx, moved(2., 2.));
            input(cx, key("tab"));
            // A frame, which tells the chart it has the focus.
            let _ = cx.update_window(window.into(), |_, window, _| window.render_to_image());
            cx.background_executor().timer(Duration::from_millis(600)).await;
            input(cx, key("right"));
            input(cx, key("right"));
            cx.background_executor().timer(Duration::from_millis(600)).await;
            save(cx, format!("charts-{i:02}-keys"));
        }
    })
    .detach();
}
