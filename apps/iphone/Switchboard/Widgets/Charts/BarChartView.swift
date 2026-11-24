import Charts
import SwiftUI

/// Bars for each label (desktop's bar-chart.tsx): a series each, side by side or stacked; columns, or
/// rows when horizontal. Bars at most 24 pt thick, their data end rounded and square at the
/// baseline; a 2 pt gap of the paper between stacked segments and side-by-side bars. A single
/// series, or a stack, labels its extreme; a tap shows every series at a label over its band.
struct BarChartView: View {
  let labels: [String]
  let series: [ChartData.Series]
  let stacked: Bool
  let horizontal: Bool
  let fig: Figures
  let height: CGFloat

  @State private var selected: String?

  private struct Segment: Identifiable {
    let key: String
    let series: Int
    let start: Double
    let end: Double
    /// It takes the bar's rounded data end.
    let top: Bool
    var id: String { "\(series)-\(key)" }
  }

  private struct Edge: Identifiable {
    let key: String
    let value: Double
    let id: Int
  }

  /// Every bar or stacked segment, from where it starts to where it ends.
  private var segments: [Segment] {
    var out: [Segment] = []
    for j in labels.indices {
      let key = String(j)
      var up = 0.0
      var down = 0.0
      let top = series.lastIndex { ($0.values[j] ?? 0) > 0 }
      for (k, s) in series.enumerated() {
        guard let v = s.values[j] else { continue }
        if !stacked {
          out.append(Segment(key: key, series: k, start: 0, end: v, top: true))
        } else if v > 0 {
          out.append(Segment(key: key, series: k, start: up, end: up + v, top: k == top))
          up += v
        } else {
          out.append(Segment(key: key, series: k, start: down, end: down + v, top: false))
          down += v
        }
      }
    }
    return out
  }

  /// Where stacked segments meet above zero: a gap of the paper there.
  private func edges(_ segments: [Segment]) -> [Edge] {
    guard stacked else { return [] }
    return segments.filter { !$0.top && $0.end > 0 }.enumerated().map { i, s in Edge(key: s.key, value: s.end, id: i) }
  }

  /// Each label's stack above zero and below.
  private var stacks: [(up: Double, down: Double)] {
    labels.indices.map { j in
      let values = series.compactMap { $0.values[j] }
      return (values.filter { $0 > 0 }.reduce(0, +), values.filter { $0 < 0 }.reduce(0, +))
    }
  }

  /// The segment its extreme is labelled on, and the extreme: a single series' bar or a stack's end.
  private func peak(_ segments: [Segment]) -> (id: String, value: Double)? {
    guard stacked || series.count == 1 else { return nil }
    let reach = stacks.enumerated().map { j, s in (key: String(j), value: s.up > 0 ? s.up : s.down) }.filter { $0.value != 0 }
    guard let most = reach.max(by: { abs($0.value) < abs($1.value) }) else { return nil }
    let at = segments.filter { $0.key == most.key && ($0.end > 0) == (most.value > 0) }
    let end = most.value > 0 ? at.max { $0.end < $1.end } : at.min { $0.end < $1.end }
    return end.map { (id: $0.id, value: most.value) }
  }

  private var scale: ChartScale {
    stacked ? ChartScale(stacks.flatMap { [$0.up, $0.down] }, zero: true) : ChartScale(series.flatMap(\.values), zero: true)
  }

  /// A bar's thickness: what its band holds, at most 24 pt.
  private func thickness(_ length: CGFloat) -> CGFloat {
    let band = max(1, length - 40) / CGFloat(max(1, labels.count))
    let across = stacked ? 1 : CGFloat(series.count)
    return max(2, min(24, (band * 0.7 - 2 * (across - 1)) / across))
  }

  private var callout: ChartCallout? {
    guard let selected, let j = Int(selected), j < labels.count else { return nil }
    let rows = series.compactMap { s in s.values[j].map { ChartCallout.Row(value: fig.figure($0), name: s.name, color: s.color) } }
    return rows.isEmpty ? nil : ChartCallout(title: labels[j], rows: rows)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ChartLegend(items: series.map { .init(name: $0.name, color: $0.color, id: $0.place) }, kind: .square)
      GeometryReader { geo in
        if horizontal { rows(thickness(geo.size.height)) } else { columns(thickness(geo.size.width)) }
      }
      .frame(height: height)
    }
    .modifier(ChartInset())
  }

  private func slot(_ s: Segment) -> String { stacked ? "0" : String(s.series) }

  private func columns(_ w: CGFloat) -> some View {
    let axis = scale
    let all = segments
    let peak = peak(all)
    let span = MarkDimension.fixed(stacked ? w : (w + 2) * CGFloat(series.count))
    return Chart {
      if let selected {
        RectangleMark(x: .value("Label", selected), yStart: .value("Value", axis.lo), yEnd: .value("Value", axis.hi), width: .ratio(1))
          .foregroundStyle(SIS.selected)
          .annotation(position: .top, spacing: 0, overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) { callout }
      }
      ForEach(all) { s in
        let color = series[s.series].color
        BarMark(x: .value("Label", s.key), yStart: .value("Value", s.start), yEnd: .value("Value", s.end), width: .fixed(w))
          .foregroundStyle(color)
          .cornerRadius(s.top ? 4 : 0)
          .position(by: .value("Series", slot(s)), axis: .horizontal, span: span)
          .annotation(position: s.end < 0 ? .bottom : .top, spacing: 4) {
            if let peak, peak.id == s.id {
              Text(fig.figure(peak.value)).font(SIS.text(SIS.Size.label)).foregroundStyle(SIS.ink2)
            }
          }
        if s.top {
          // Square where it starts: the rounding is only at its data end.
          BarMark(x: .value("Label", s.key), yStart: .value("Value", s.start), yEnd: .value("Value", (s.start + s.end) / 2), width: .fixed(w))
            .foregroundStyle(color)
            .position(by: .value("Series", slot(s)), axis: .horizontal, span: span)
        }
      }
      ForEach(edges(all)) { e in
        RectangleMark(x: .value("Label", e.key), y: .value("Value", e.value), width: .fixed(w), height: .fixed(2))
          .foregroundStyle(SIS.paper)
      }
      RuleMark(y: .value("Value", 0)).foregroundStyle(SIS.rule).lineStyle(StrokeStyle(lineWidth: SIS.line))
    }
    .chartXScale(domain: labels.indices.map(String.init))
    .chartYScale(domain: axis.lo...axis.hi, range: .plotDimension(startPadding: 0, endPadding: peak == nil ? 0 : 16))
    .chartXAxis { ChartAxes.categories(labels) }
    .chartYAxis { ChartAxes.values(axis, fig) }
    .chartLegend(.hidden)
    .chartTap { proxy, at in
      let key = proxy.value(atX: at.x, as: String.self)
      selected = key == selected ? nil : key
    }
  }

  private func rows(_ w: CGFloat) -> some View {
    let axis = scale
    let all = segments
    let peak = peak(all)
    let span = MarkDimension.fixed(stacked ? w : (w + 2) * CGFloat(series.count))
    return Chart {
      if let selected {
        RectangleMark(xStart: .value("Value", axis.lo), xEnd: .value("Value", axis.hi), y: .value("Label", selected), height: .ratio(1))
          .foregroundStyle(SIS.selected)
          .annotation(position: .overlay, spacing: 0, overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) { callout }
      }
      ForEach(all) { s in
        let color = series[s.series].color
        BarMark(xStart: .value("Value", s.start), xEnd: .value("Value", s.end), y: .value("Label", s.key), height: .fixed(w))
          .foregroundStyle(color)
          .cornerRadius(s.top ? 4 : 0)
          .position(by: .value("Series", slot(s)), axis: .vertical, span: span)
          .annotation(position: s.end < 0 ? .leading : .trailing, spacing: 6) {
            if let peak, peak.id == s.id {
              Text(fig.figure(peak.value)).font(SIS.text(SIS.Size.label)).foregroundStyle(SIS.ink2)
            }
          }
        if s.top {
          BarMark(xStart: .value("Value", s.start), xEnd: .value("Value", (s.start + s.end) / 2), y: .value("Label", s.key), height: .fixed(w))
            .foregroundStyle(color)
            .position(by: .value("Series", slot(s)), axis: .vertical, span: span)
        }
      }
      ForEach(edges(all)) { e in
        RectangleMark(x: .value("Value", e.value), y: .value("Label", e.key), width: .fixed(2), height: .fixed(w))
          .foregroundStyle(SIS.paper)
      }
      RuleMark(x: .value("Value", 0)).foregroundStyle(SIS.rule).lineStyle(StrokeStyle(lineWidth: SIS.line))
    }
    .chartYScale(domain: labels.indices.map(String.init))
    .chartXScale(domain: axis.lo...axis.hi, range: .plotDimension(startPadding: 0, endPadding: peak.map { ChartText.width(fig.figure($0.value)) + 8 } ?? 0))
    .chartYAxis { ChartAxes.categories(labels, position: .leading, most: max(1, Int(height / 16))) }
    .chartXAxis { ChartAxes.values(axis, fig, position: .bottom, across: true) }
    .chartLegend(.hidden)
    .chartTap { proxy, at in
      let key = proxy.value(atY: at.y, as: String.self)
      selected = key == selected ? nil : key
    }
  }
}
