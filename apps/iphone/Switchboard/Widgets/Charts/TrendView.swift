import Charts
import SwiftUI

/// A line per series over labels evenly spaced along the bottom (desktop's trend.tsx), or each filled
/// under its line (a wash), or stacked. A value with none either side is a dot; up to four lines end
/// in a dot and their latest value. A line's scale fits its values; an area's starts at zero. A
/// tap shows every series at a label, along a hairline.
struct TrendView: View {
  let labels: [String]
  let series: [ChartData.Series]
  let area: Bool
  let stacked: Bool
  let fig: Figures
  let height: CGFloat

  @State private var selected: Int?

  /// Lines ending in their value, at most.
  private static let labelled = 4

  private struct Point: Identifiable {
    let at: Int
    let series: Int
    /// Which stretch of the line it's in: a value of none breaks it.
    let run: Int
    let base: Double
    let value: Double
    let lone: Bool
    var id: String { "\(series)-\(at)" }
  }

  private var points: [Point] {
    var out: [Point] = []
    var bases = Array(repeating: 0.0, count: labels.count)
    for (k, s) in series.enumerated() {
      var run = 0
      for j in labels.indices {
        guard let v = s.values[j] else {
          run += 1
          continue
        }
        let base = stacked ? bases[j] : 0
        let lone = (j == 0 || s.values[j - 1] == nil) && (j == labels.count - 1 || s.values[j + 1] == nil)
        out.append(Point(at: j, series: k, run: run, base: base, value: base + v, lone: lone))
        if stacked { bases[j] += v }
      }
    }
    return out
  }

  private var scale: ChartScale {
    ChartScale(points.flatMap { stacked ? [$0.value, $0.base] : [$0.value] }.map { Optional($0) }, zero: area)
  }

  /// Each line's end, and whether there's room to label them all.
  private func ends(_ points: [Point], _ scale: ChartScale) -> (points: [Point], labelled: Bool) {
    guard !stacked, series.count <= Self.labelled else { return ([], false) }
    let ends = series.indices.compactMap { k in points.last { $0.series == k } }
    let perPoint = (height - 24) / CGFloat(max(scale.hi - scale.lo, 1e-9))
    let ys = ends.map { CGFloat($0.value) * perPoint }.sorted()
    let apart = zip(ys, ys.dropFirst()).allSatisfy { $1 - $0 >= 13 }
    return (ends, apart)
  }

  private var callout: ChartCallout? {
    guard let selected, selected >= 0, selected < labels.count else { return nil }
    let rows = series.compactMap { s in s.values[selected].map { ChartCallout.Row(value: fig.figure($0), name: s.name, color: s.color) } }
    return rows.isEmpty ? nil : ChartCallout(title: labels[selected], rows: rows)
  }

  var body: some View {
    let all = points
    let axis = scale
    let (ends, labelled) = ends(all, axis)
    let room = labelled ? (ends.map { ChartText.width(fig.figure($0.value - $0.base)) }.max() ?? 0) + 18 : 8
    VStack(alignment: .leading, spacing: 8) {
      ChartLegend(items: series.map { .init(name: $0.name, color: $0.color, id: $0.place) }, kind: area ? .square : .line)
      Chart {
        ForEach(all) { p in
          let color = series[p.series].color
          if area {
            AreaMark(x: .value("Label", p.at), yStart: .value("Value", p.base), yEnd: .value("Value", p.value), series: .value("Series", "\(p.series)-\(p.run)"))
              .foregroundStyle(color.opacity(0.1))
              .interpolationMethod(.linear)
          }
          LineMark(x: .value("Label", p.at), y: .value("Value", p.value), series: .value("Series", "\(p.series)-\(p.run)"))
            .foregroundStyle(color)
            .lineStyle(StrokeStyle(lineWidth: SIS.stroke, lineCap: .round, lineJoin: .round))
            .interpolationMethod(.linear)
          if p.lone && !area {
            PointMark(x: .value("Label", p.at), y: .value("Value", p.value)).foregroundStyle(color).symbolSize(25)
          }
        }
        RuleMark(y: .value("Value", 0)).foregroundStyle(SIS.rule).lineStyle(StrokeStyle(lineWidth: SIS.line))
        ForEach(ends) { e in
          PointMark(x: .value("Label", e.at), y: .value("Value", e.value)).foregroundStyle(SIS.paper).symbolSize(144)
          PointMark(x: .value("Label", e.at), y: .value("Value", e.value))
            .foregroundStyle(series[e.series].color)
            .symbolSize(64)
            .annotation(position: .trailing, spacing: 6) {
              if labelled {
                Text(fig.figure(e.value - e.base)).font(SIS.text(SIS.Size.label)).foregroundStyle(SIS.ink2)
              }
            }
        }
        if let selected {
          RuleMark(x: .value("Label", selected))
            .foregroundStyle(SIS.rule)
            .lineStyle(StrokeStyle(lineWidth: SIS.line))
            .annotation(position: .top, spacing: 0, overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) { callout }
          ForEach(all.filter { $0.at == selected }) { p in
            PointMark(x: .value("Label", p.at), y: .value("Value", p.value)).foregroundStyle(SIS.paper).symbolSize(144)
            PointMark(x: .value("Label", p.at), y: .value("Value", p.value)).foregroundStyle(series[p.series].color).symbolSize(64)
          }
        }
      }
      .chartXScale(domain: 0...max(1, labels.count - 1), range: .plotDimension(startPadding: 0, endPadding: room))
      .chartYScale(domain: axis.lo...axis.hi, range: .plotDimension(startPadding: 0, endPadding: 8))
      .chartXAxis { ChartAxes.places(labels) }
      .chartYAxis { ChartAxes.values(axis, fig) }
      .chartLegend(.hidden)
      .chartTap { proxy, at in
        let i = proxy.value(atX: at.x, as: Double.self).map { min(max(0, Int($0.rounded())), labels.count - 1) }
        selected = i == selected ? nil : i
      }
      .frame(height: height)
    }
    .modifier(ChartInset())
  }
}
