import A2UICore
import A2UISwiftUI
import SwiftUI

/// Switch's charts (switch-ext-kit's `SwitchParts`, desktop's widgets/charts): plain data in, drawn
/// in the house look with Swift Charts. Data may be bound to the surface's data model; what can't be
/// read is left out, and with nothing left a chart draws nothing.
enum Charts {
  /// A chart's own height, its axes in it, unless it's given one.
  private static func height(_ node: Node, else own: CGFloat = SIS.chart) -> CGFloat {
    node.double(for: "height").flatMap { $0 > 0 ? CGFloat($0) : nil } ?? own
  }

  @ViewBuilder private static func bars(_ node: Node) -> some View {
    let labels = ChartData.labels(node.jsonValue(for: "labels"))
    let stacked = node.bool(for: "stacked") == true
    let series = ChartData.series(node.jsonValue(for: "series"), count: labels.count, sum: stacked)
    if !labels.isEmpty && ChartData.anyValue(series) {
      BarChartView(
        labels: labels, series: series, stacked: stacked, horizontal: node.bool(for: "horizontal") == true, fig: Figures(node),
        height: height(node))
    }
  }

  @ViewBuilder private static func trend(_ node: Node, area: Bool) -> some View {
    let labels = ChartData.labels(node.jsonValue(for: "labels"))
    let stacked = area && node.bool(for: "stacked") == true
    let series = ChartData.series(node.jsonValue(for: "series"), count: labels.count, sum: stacked)
    if !labels.isEmpty && ChartData.anyValue(series) {
      let ticks = ChartData.labels(node.jsonValue(for: "ticks"))
      TrendView(
        labels: labels, ticks: ticks.count == labels.count ? ticks : labels, series: series, area: area, stacked: stacked, fig: Figures(node),
        top: node.double(for: "max"), limit: node.double(for: "limit"), height: height(node))
    }
  }

  @ViewBuilder private static func sparkline(_ node: Node) -> some View {
    let values = ChartData.numbers(node.jsonValue(for: "values"))
    if !values.isEmpty {
      SparklineView(values: values, height: height(node, else: SIS.row))
    }
  }

  @ViewBuilder private static func donut(_ node: Node) -> some View {
    let slices = ChartData.slices(node.jsonValue(for: "slices"))
    if !slices.isEmpty {
      DonutChartView(slices: slices, fig: Figures(node))
    }
  }

  @ViewBuilder private static func scatter(_ node: Node) -> some View {
    let series = ChartData.points(node.jsonValue(for: "series"))
    if !series.isEmpty {
      ScatterChartView(
        series: series, xLabel: node.string(for: "xLabel") ?? "", yLabel: node.string(for: "yLabel") ?? "", height: height(node))
    }
  }

  @ViewBuilder private static func histogram(_ node: Node) -> some View {
    let given = node.int(for: "bins").flatMap { $0 > 0 ? $0 : nil }
    let bins = HistogramView.bins(ChartData.numbers(node.jsonValue(for: "values")), given: given)
    if !bins.isEmpty {
      HistogramView(bins: bins, fig: Figures(node), height: height(node))
    }
  }

  @ViewBuilder private static func calendar(_ node: Node) -> some View {
    let days = ChartData.days(node.jsonValue(for: "days"))
    if !days.isEmpty {
      CalendarHeatmapView(days: days, fig: Figures(node))
    }
  }

  @ViewBuilder private static func meter(_ node: Node) -> some View {
    if let value = ChartData.number(node.jsonValue(for: "value")) {
      let most = node.double(for: "max").flatMap { $0 > 0 ? $0 : nil } ?? 100
      MeterView(label: node.string(for: "label") ?? "", value: value, most: most, fig: Figures(node))
    }
  }

  private static let data = ["labels": "DynamicValue", "series": "DynamicValue"]
  private static let trends = ["labels": "DynamicValue", "series": "DynamicValue", "ticks": "DynamicValue"]

  static let components: [ComponentImplementation] = [
    ComponentImplementation(name: "BarChart", schema: schema("BarChart", data)) { bars($0) },
    ComponentImplementation(name: "LineChart", schema: schema("LineChart", trends)) { trend($0, area: false) },
    ComponentImplementation(name: "AreaChart", schema: schema("AreaChart", trends)) { trend($0, area: true) },
    ComponentImplementation(name: "Sparkline", schema: schema("Sparkline", ["values": "DynamicValue"])) { sparkline($0) },
    ComponentImplementation(name: "DonutChart", schema: schema("DonutChart", ["slices": "DynamicValue"])) { donut($0) },
    ComponentImplementation(name: "ScatterChart", schema: schema("ScatterChart", ["series": "DynamicValue"])) { scatter($0) },
    ComponentImplementation(name: "Histogram", schema: schema("Histogram", ["values": "DynamicValue"])) { histogram($0) },
    ComponentImplementation(name: "CalendarHeatmap", schema: schema("CalendarHeatmap", ["days": "DynamicValue"])) { calendar($0) },
    ComponentImplementation(name: "Meter", schema: schema("Meter", ["label": "DynamicString", "value": "DynamicValue"])) { meter($0) },
  ]
}
