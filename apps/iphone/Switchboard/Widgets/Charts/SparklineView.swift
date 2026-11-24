import Charts
import SwiftUI

/// A trend as one small line, its latest point marked (desktop's sparkline.tsx): a line's height
/// unless given one, its scale fitting its values. A tap shows the value under it.
struct SparklineView: View {
  let values: [Double]
  let height: CGFloat

  @State private var selected: Int?

  var body: some View {
    let color = SIS.series[0]
    let lo = values.min() ?? 0
    let hi = values.max() ?? 0
    let flat = hi - lo <= 0
    Chart {
      ForEach(Array(values.enumerated()), id: \.offset) { i, v in
        LineMark(x: .value("Place", i), y: .value("Value", v))
          .foregroundStyle(color)
          .lineStyle(StrokeStyle(lineWidth: SIS.stroke, lineCap: .round, lineJoin: .round))
          .interpolationMethod(.linear)
      }
      if let last = values.last {
        PointMark(x: .value("Place", values.count - 1), y: .value("Value", last)).foregroundStyle(SIS.paper).symbolSize(144)
        PointMark(x: .value("Place", values.count - 1), y: .value("Value", last)).foregroundStyle(color).symbolSize(64)
      }
      if let selected {
        RuleMark(x: .value("Place", selected))
          .foregroundStyle(SIS.rule)
          .lineStyle(StrokeStyle(lineWidth: SIS.line))
          .annotation(position: .overlay, spacing: 0, overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
            ChartCallout(title: "", rows: [.init(value: Figures.bare.figure(values[selected]), name: "", color: color)])
          }
      }
    }
    .chartXScale(domain: values.count > 1 ? 0...(values.count - 1) : -1...1, range: .plotDimension(padding: 6))
    .chartYScale(domain: flat ? (lo - 1)...(hi + 1) : lo...hi, range: .plotDimension(padding: 6))
    .chartXAxis(.hidden)
    .chartYAxis(.hidden)
    .chartLegend(.hidden)
    .chartTap { proxy, at in
      let i = proxy.value(atX: at.x, as: Double.self).map { min(max(0, Int($0.rounded())), values.count - 1) }
      selected = i == selected ? nil : i
    }
    .frame(height: height)
    .padding(.horizontal, SIS.inset)
  }
}
