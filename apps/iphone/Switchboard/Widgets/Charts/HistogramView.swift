import Charts
import SwiftUI

/// How raw values spread (desktop's histogram.tsx): a column per bin at round edges, a 2 pt gap of
/// the paper between them, the edges along the bottom, the fullest bin's count on its cap. A tap
/// shows a bin's range and count over its column.
struct HistogramView: View {
  struct Bin: Identifiable {
    let lo: Double
    let hi: Double
    let count: Int
    let id: Int
  }

  let bins: [Bin]
  let fig: Figures
  let height: CGFloat

  @State private var chosen: Int?

  /// Raw values counted into bins of equal width at round edges: `given` of them, else Sturges'.
  static func bins(_ values: [Double], given: Int?) -> [Bin] {
    guard let min = values.min(), let max = values.max() else { return [] }
    if min == max { return [Bin(lo: min - 0.5, hi: max + 0.5, count: values.count, id: 0)] }
    let count = given ?? Int(ceil(log2(Double(values.count)))) + 1
    var step = ChartScale.step((max - min) / Double(count))
    var lo = floor(min / step) * step
    if let given {
      while lo + Double(given) * step < max {
        step = ChartScale.step(step * (1 + 1e-6))
        lo = floor(min / step) * step
      }
    }
    let n = given ?? Swift.max(1, Int(ceil((max - lo) / step)))
    var counts = Array(repeating: 0, count: n)
    for v in values { counts[Swift.min(n - 1, Int(floor((v - lo) / step)))] += 1 }
    return counts.enumerated().map { k, c in Bin(lo: lo + Double(k) * step, hi: lo + Double(k + 1) * step, count: c, id: k) }
  }

  /// The bins' edges along the bottom, so many they don't run together.
  private var edges: [Double] {
    guard let first = bins.first else { return [] }
    let step = first.hi - first.lo
    return ChartAxes.shown(bins.count + 1).map { first.lo + Double($0) * step }
  }

  @ChartContentBuilder private func column(_ b: Bin, peak: Bin?, color: Color) -> some ChartContent {
    RectangleMark(
      xStart: .value("Value", b.lo), xEnd: .value("Value", b.hi), yStart: .value("Count", 0.0), yEnd: .value("Count", Double(b.count))
    )
    .foregroundStyle(color)
    .cornerRadius(4)
    .annotation(position: .top, spacing: 4) {
      if b.id == peak?.id {
        Text("\(b.count)").font(SIS.text(SIS.Size.label)).foregroundStyle(SIS.ink2)
      }
    }
    // Square where it starts: the rounding is only at its data end.
    RectangleMark(
      xStart: .value("Value", b.lo), xEnd: .value("Value", b.hi), yStart: .value("Count", 0.0), yEnd: .value("Count", Double(b.count) / 2)
    )
    .foregroundStyle(color)
  }

  /// A gap of the paper where two columns meet, as tall as the taller.
  @ChartContentBuilder private func gap(_ b: Bin) -> some ChartContent {
    let before = b.id > 0 ? bins[b.id - 1].count : 0
    RuleMark(x: .value("Value", b.lo), yStart: .value("Count", 0.0), yEnd: .value("Count", Double(Swift.max(b.count, before))))
      .foregroundStyle(SIS.paper)
      .lineStyle(StrokeStyle(lineWidth: 2))
  }

  @ChartContentBuilder private func band(_ chosen: Bin, _ counts: ChartScale, color: Color) -> some ChartContent {
    RectangleMark(
      xStart: .value("Value", chosen.lo), xEnd: .value("Value", chosen.hi), yStart: .value("Count", counts.lo),
      yEnd: .value("Count", counts.hi)
    )
    .foregroundStyle(SIS.selected)
    .annotation(position: .top, spacing: 0, overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
      ChartCallout(title: "\(fig.figure(chosen.lo))–\(fig.figure(chosen.hi))", rows: [.init(value: "\(chosen.count)", name: "", color: color)])
    }
  }

  var body: some View {
    let counts = ChartScale(bins.map { Optional(Double($0.count)) }, zero: true, whole: true)
    let peak = bins.filter { $0.count > 0 }.max { $0.count < $1.count }
    let chosen = chosen.flatMap { i in i < bins.count ? bins[i] : nil }
    let color = SIS.series[0]
    let lo = bins.first?.lo ?? 0
    let hi = bins.last?.hi ?? 1
    Chart {
      if let chosen { band(chosen, counts, color: color) }
      ForEach(bins) { b in column(b, peak: peak, color: color) }
      ForEach(bins.dropFirst()) { b in gap(b) }
      RuleMark(y: .value("Count", 0.0)).foregroundStyle(SIS.rule).lineStyle(StrokeStyle(lineWidth: SIS.line))
    }
    .chartXScale(domain: lo...hi)
    .chartYScale(domain: counts.lo...counts.hi, range: .plotDimension(startPadding: 0, endPadding: 16))
    .chartXAxis {
      AxisMarks(values: edges) { value in
        AxisValueLabel(anchor: ChartAxes.anchor(value.index, of: edges.count)) {
          if let v = value.as(Double.self) {
            Text(fig.tick(v)).font(SIS.text(SIS.Size.label)).foregroundStyle(SIS.ink3)
          }
        }
      }
    }
    .chartYAxis { ChartAxes.values(counts, .bare) }
    .chartLegend(.hidden)
    .chartTap { proxy, at in
      let bin = proxy.value(atX: at.x, as: Double.self).flatMap { t in bins.first { t >= $0.lo && t <= $0.hi } }
      self.chosen = bin?.id == self.chosen ? nil : bin?.id
    }
    .frame(height: height)
    .modifier(ChartInset())
  }
}
