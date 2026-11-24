import SwiftUI

/// A value per day as weeks of squares, darker for more (desktop's calendar.tsx): weeks as columns of
/// seven days, Sunday on top, each square the one-hue scale's step from zero to the most; a day with
/// nothing, or none, a hairline's gray. Each month over the week it starts in; under the weeks the
/// scale, zero to the most. A tap shows a day, its square ringed.
struct CalendarHeatmapView: View {
  let days: [Date: Double]
  let fig: Figures

  @State private var chosen: Date?

  private struct Cell: Identifiable {
    let day: Date
    let value: Double?
    let col: Int
    let row: Int
    var id: Date { day }
  }

  /// A day's square at most, and the gap of the paper between squares.
  private static let most: CGFloat = 14
  private static let gap: CGFloat = 2
  /// Months named at least this many weeks apart.
  private static let apart = 4

  private var calendar: Calendar { ChartData.calendar }

  /// A day in words, as its date says (days are kept at midnight UTC).
  private func text(_ day: Date, _ style: Date.FormatStyle) -> String {
    var style = style
    style.timeZone = calendar.timeZone
    return day.formatted(style)
  }

  private var cells: [Cell] {
    guard let first = days.keys.min(), let last = days.keys.max() else { return [] }
    let weekday = calendar.component(.weekday, from: first) - 1
    guard let start = calendar.date(byAdding: .day, value: -weekday, to: first) else { return [] }
    let from = weekday
    let to = (calendar.dateComponents([.day], from: start, to: last).day ?? 0)
    return (from...to).compactMap { i in
      calendar.date(byAdding: .day, value: i, to: start).map { Cell(day: $0, value: days[$0], col: i / 7, row: i % 7) }
    }
  }

  private func color(_ value: Double?, most: Double) -> Color {
    guard let value, value > 0, most > 0 else { return SIS.hair }
    let step = min(SIS.magnitude.count - 1, Int(ceil(value / most * Double(SIS.magnitude.count))) - 1)
    return SIS.magnitude[max(0, step)]
  }

  private func months(_ cells: [Cell], weeks: Int) -> [(col: Int, text: String)] {
    let starts = cells.enumerated().filter { $0.offset == 0 || calendar.component(.day, from: $0.element.day) == 1 }.map(\.element)
    var out: [(col: Int, text: String)] = []
    for (i, c) in starts.enumerated() {
      let crowdedFirst = i == 0 && i + 1 < starts.count && starts[i + 1].col - c.col < Self.apart
      let crowded = (out.last.map { c.col - $0.col < Self.apart }) ?? false
      if !crowdedFirst && !crowded && c.col <= weeks - 2 {
        out.append((c.col, text(c.day, .dateTime.month(.abbreviated))))
      }
    }
    return out
  }

  var body: some View {
    let cells = cells
    let most = days.values.max() ?? 0
    let weeks = (cells.last?.col ?? 0) + 1
    VStack(alignment: .leading, spacing: 6) {
      GeometryReader { geo in
        let side = min(Self.most, (geo.size.width - Self.gap * CGFloat(weeks - 1)) / CGFloat(weeks))
        let pitch = side + Self.gap
        ZStack(alignment: .topLeading) {
          ForEach(months(cells, weeks: weeks), id: \.col) { m in
            Text(m.text).font(SIS.text(SIS.Size.label)).foregroundStyle(SIS.ink3).fixedSize()
              .offset(x: CGFloat(m.col) * pitch)
          }
          ForEach(cells) { c in
            RoundedRectangle(cornerRadius: 2)
              .fill(color(c.value, most: most))
              .overlay {
                if chosen == c.day { RoundedRectangle(cornerRadius: 2).strokeBorder(SIS.ink2, lineWidth: SIS.line) }
              }
              .frame(width: side, height: side)
              .offset(x: CGFloat(c.col) * pitch, y: 18 + CGFloat(c.row) * pitch)
          }
          if let chosen, let c = cells.first(where: { $0.day == chosen }) {
            let x = CGFloat(c.col) * pitch + side / 2
            // Half a callout's width, about: kept inside the chart's width.
            let shift = max(0, 64 - x) + min(0, geo.size.width - 64 - x)
            Color.clear
              .frame(width: side, height: side)
              .overlay(alignment: c.row < 3 ? .top : .bottom) {
                ChartCallout(
                  title: text(c.day, .dateTime.weekday(.abbreviated).month(.abbreviated).day().year()),
                  rows: c.value.map { [.init(value: fig.figure($0), name: "", color: color($0, most: most))] } ?? []
                )
                .offset(x: shift, y: c.row < 3 ? side + 4 : -(side + 4))
              }
              .offset(x: CGFloat(c.col) * pitch, y: 18 + CGFloat(c.row) * pitch)
          }
        }
        .frame(width: geo.size.width, height: 18 + pitch * 7, alignment: .topLeading)
        .contentShape(Rectangle())
        .onTapGesture { location in
          let col = Int(location.x / pitch)
          let row = Int((location.y - 18) / pitch)
          let day = cells.first { $0.col == col && $0.row == row }?.day
          chosen = day == chosen ? nil : day
        }
      }
      .frame(height: 18 + (min(Self.most, 360 / CGFloat(max(weeks, 1))) + Self.gap) * 7)
      if most > 0 {
        HStack(spacing: 4) {
          Text(fig.figure(0))
          ChartKey(kind: .square, color: SIS.hair)
          ForEach(Array(SIS.magnitude.enumerated()), id: \.offset) { _, c in ChartKey(kind: .square, color: c) }
          Text(fig.figure(most))
        }
        .font(SIS.text(SIS.Size.label))
        .foregroundStyle(SIS.ink3)
        .frame(maxWidth: .infinity, alignment: .trailing)
      }
    }
    .modifier(ChartInset())
  }
}
