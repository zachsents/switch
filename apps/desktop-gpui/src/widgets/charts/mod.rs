//! Switch's charts (the desktop's `widgets/charts/`, switch-ext-kit's chart parts): plain data in,
//! drawn in the house look. Bar, line, area and scatter charts, a sparkline and a histogram on two
//! axes (cartesian.rs), a donut, a calendar heatmap and a meter; each draws nothing when nothing it
//! was given reads.

mod calendar;
mod cartesian;
mod data;
mod donut;
mod figures;
mod locale;
#[cfg(feature = "shot")]
pub mod gallery;
mod meter;
mod parts;
mod scale;

use gpui::{AnyElement, App, IntoElement, Window, div};
use serde_json::Value;

use crate::widgets::render::Ctx;

/// A chart drawn, or none when it isn't one of the charts. A chart with nothing to draw is empty.
pub fn draw(name: &str, c: &Value, ctx: &Ctx, window: &mut Window, cx: &mut App) -> Option<AnyElement> {
    let drawn = match name {
        "BarChart" => cartesian::bar_chart(c, ctx, window, cx),
        "LineChart" => cartesian::line_chart(c, ctx, window, cx),
        "AreaChart" => cartesian::area_chart(c, ctx, window, cx),
        "Sparkline" => cartesian::sparkline(c, ctx, window, cx),
        "DonutChart" => donut::donut_chart(c, ctx, window, cx),
        "ScatterChart" => cartesian::scatter_chart(c, ctx, window, cx),
        "Histogram" => cartesian::histogram(c, ctx, window, cx),
        "CalendarHeatmap" => calendar::calendar_heatmap(c, ctx, window, cx),
        "Meter" => meter::meter(c, ctx, window, cx),
        _ => return None,
    };
    Some(drawn.unwrap_or_else(|| div().into_any_element()))
}
