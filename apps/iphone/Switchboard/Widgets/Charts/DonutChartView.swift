import Charts
import SwiftUI

/// Parts of a whole round a ring, the total in it (desktop's donut-chart.tsx); beside it each part's
/// key, name and figure, in order. A 2 pt gap of the paper between slices. A tap on a slice shows
/// its value and share in the ring, the others stepping back.
struct DonutChartView: View {
  let slices: [ChartData.Slice]
  let fig: Figures

  @State private var chosen: Int?

  private static let size: CGFloat = 140

  private var total: Double { slices.reduce(0) { $0 + $1.value } }

  /// The slice under a point of the ring's box, clockwise from twelve; none off the ring.
  private func slice(at point: CGPoint) -> Int? {
    let dx = point.x - Self.size / 2
    let dy = point.y - Self.size / 2
    let r = hypot(dx, dy)
    guard r >= Self.size / 2 * 0.7, r <= Self.size / 2 else { return nil }
    let turn = (atan2(dx, -dy) / (2 * .pi) + 1).truncatingRemainder(dividingBy: 1)
    var sum = 0.0
    for s in slices {
      sum += s.value
      if turn * total <= sum { return s.id }
    }
    return nil
  }

  var body: some View {
    let chosen = chosen.flatMap { i in slices.first { $0.id == i } }
    HStack(alignment: .center, spacing: 20) {
      Chart(slices) { s in
        SectorMark(angle: .value("Value", s.value), innerRadius: .ratio(0.76), angularInset: slices.count > 1 ? 1 : 0)
          .foregroundStyle(s.color)
          .opacity(chosen == nil || chosen?.id == s.id ? 1 : 0.4)
      }
      .chartLegend(.hidden)
      .frame(width: Self.size, height: Self.size)
      .contentShape(Rectangle())
      .onTapGesture { point in
        let i = slice(at: point)
        self.chosen = i == self.chosen ? nil : i
      }
      .overlay {
        VStack(spacing: 2) {
          Text(fig.headline(chosen?.value ?? total)).font(SIS.number(SIS.Size.readout)).foregroundStyle(SIS.ink)
          if let chosen {
            Text("\(chosen.label) \(Figures.percent(chosen.value / total))").font(SIS.text(SIS.Size.label)).foregroundStyle(SIS.ink2)
              .lineLimit(1)
          }
        }
        .frame(width: Self.size * 0.66)
        .minimumScaleFactor(0.6)
      }
      Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 6) {
        ForEach(slices) { s in
          GridRow {
            ChartKey(kind: .square, color: s.color)
            Text(s.label).font(SIS.text(SIS.Size.caption)).foregroundStyle(SIS.ink2).lineLimit(1)
            Text(fig.figure(s.value)).font(SIS.text(SIS.Size.caption)).foregroundStyle(SIS.ink).gridColumnAlignment(.trailing)
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .modifier(ChartInset())
  }
}
