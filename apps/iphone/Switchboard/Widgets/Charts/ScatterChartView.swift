import Charts
import SwiftUI

/// Points by two measures (desktop's scatter-chart.tsx): an 8 pt dot each in a 2 pt ring of the
/// paper; three series at most. Each axis fits its values; the y axis's name over it, the x axis's
/// under its end. A tap shows the nearest point within reach, ringed.
struct ScatterChartView: View {
  let series: [ChartData.Points]
  let xLabel: String
  let yLabel: String
  let height: CGFloat

  @State private var chosen: (series: Int, point: Int)?

  /// How far from a point a tap still chooses it.
  private static let reach: CGFloat = 24

  var body: some View {
    let xs = ChartScale(series.flatMap { $0.points.map { Optional($0.x) } }, zero: false)
    let ys = ChartScale(series.flatMap { $0.points.map { Optional($0.y) } }, zero: false)
    VStack(alignment: .leading, spacing: 6) {
      ChartLegend(items: series.map { .init(name: $0.name, color: $0.color, id: $0.place) }, kind: .dot)
      if !yLabel.isEmpty {
        Text(yLabel).font(SIS.text(SIS.Size.label)).foregroundStyle(SIS.ink3)
      }
      Chart {
        ForEach(series) { s in
          ForEach(s.points) { p in
            PointMark(x: .value("X", p.x), y: .value("Y", p.y)).foregroundStyle(SIS.paper).symbolSize(144)
            PointMark(x: .value("X", p.x), y: .value("Y", p.y)).foregroundStyle(s.color).symbolSize(64)
          }
        }
        if let chosen, chosen.series < series.count, chosen.point < series[chosen.series].points.count {
          let s = series[chosen.series]
          let p = s.points[chosen.point]
          PointMark(x: .value("X", p.x), y: .value("Y", p.y))
            .symbol(Circle().strokeBorder(lineWidth: SIS.line))
            .foregroundStyle(SIS.ink2)
            .symbolSize(196)
            .annotation(position: .top, spacing: 6, overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
              ChartCallout(
                title: series.count > 1 ? s.name : "",
                rows: [
                  .init(value: Figures.bare.figure(p.x), name: xLabel.isEmpty ? "x" : xLabel, color: s.color),
                  .init(value: Figures.bare.figure(p.y), name: yLabel.isEmpty ? "y" : yLabel, color: s.color),
                ])
            }
        }
      }
      .chartXScale(domain: xs.lo...xs.hi)
      .chartYScale(domain: ys.lo...ys.hi)
      .chartXAxis { ChartAxes.values(xs, .bare, position: .bottom, across: true) }
      .chartYAxis { ChartAxes.values(ys, .bare) }
      .chartLegend(.hidden)
      .chartOverlay { proxy in
        GeometryReader { geo in
          Rectangle().fill(.clear).contentShape(Rectangle())
            .onTapGesture { location in
              chosen = nearest(location, proxy: proxy, plot: proxy.plotFrame.map { geo[$0] } ?? .zero)
            }
        }
      }
      .frame(height: height)
      if !xLabel.isEmpty {
        Text(xLabel).font(SIS.text(SIS.Size.label)).foregroundStyle(SIS.ink3).frame(maxWidth: .infinity, alignment: .trailing)
      }
    }
    .modifier(ChartInset())
  }

  /// The point nearest a tap, within reach; none past it.
  private func nearest(_ location: CGPoint, proxy: ChartProxy, plot: CGRect) -> (series: Int, point: Int)? {
    var best: (series: Int, point: Int, distance: CGFloat)?
    for (k, s) in series.enumerated() {
      for (i, p) in s.points.enumerated() {
        guard let px = proxy.position(forX: p.x), let py = proxy.position(forY: p.y) else { continue }
        let d = hypot(px + plot.minX - location.x, py + plot.minY - location.y)
        if d <= Self.reach && d < (best?.distance ?? .infinity) { best = (k, i, d) }
      }
    }
    return best.map { (series: $0.series, point: $0.point) }
  }
}
