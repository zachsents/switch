import Charts
import SwiftUI

/// The charts' axes in the house look (desktop's look.ts): tick words small in ink3, gridlines
/// hairlines; no axis lines or tick marks but the baseline, which each chart draws at zero.
enum ChartAxes {
  /// A value axis, ticked at its scale's round steps.
  static func values(_ scale: ChartScale, _ fig: Figures, position: AxisMarkPosition = .leading, across: Bool = false) -> some AxisContent {
    AxisMarks(position: position, values: scale.ticks) { value in
      AxisGridLine(stroke: StrokeStyle(lineWidth: SIS.hairWidth)).foregroundStyle(SIS.hair)
      AxisValueLabel(anchor: across ? anchor(value.index, of: scale.ticks.count) : nil) {
        if let v = value.as(Double.self) {
          Text(fig.tick(v)).font(SIS.text(SIS.Size.label)).foregroundStyle(SIS.ink3)
        }
      }
    }
  }

  /// The labels to show of `count`, every so many so they don't run together.
  static func shown(_ count: Int, most: Int = 8) -> [Int] {
    let every = max(1, Int((Double(count) / Double(most)).rounded(.up)))
    return Array(stride(from: 0, to: count, by: every))
  }

  /// A category axis of labels, keyed by their index as words (so labels may repeat).
  static func categories(_ labels: [String], position: AxisMarkPosition = .automatic, most: Int = 8) -> some AxisContent {
    AxisMarks(preset: .extended, position: position, values: shown(labels.count, most: most).map(String.init)) { value in
      AxisValueLabel {
        if let key = value.as(String.self), let i = Int(key), i < labels.count {
          Text(labels[i]).font(SIS.text(SIS.Size.label)).foregroundStyle(SIS.ink3)
        }
      }
    }
  }

  /// Where a label hangs from its place: the first and last kept inside the plot.
  static func anchor(_ i: Int, of count: Int) -> UnitPoint {
    if i == 0 { return .topLeading }
    return i == count - 1 ? .topTrailing : .top
  }

  /// Labels along an axis of places (0, 1, 2…), a line's points edge to edge.
  static func places(_ labels: [String]) -> some AxisContent {
    // Given words with gaps between ("" for none), each that has words; else every so many.
    let some = labels.indices.filter { !labels[$0].isEmpty }
    return AxisMarks(values: some.count < labels.count ? some : shown(labels.count)) { value in
      AxisValueLabel(anchor: anchor(value.as(Int.self) ?? 0, of: labels.count)) {
        if let i = value.as(Int.self), i < labels.count {
          Text(labels[i]).font(SIS.text(SIS.Size.label)).foregroundStyle(SIS.ink3)
        }
      }
    }
  }
}

/// A chart's outer frame: inset from its cell's edges as words are.
struct ChartInset: ViewModifier {
  func body(content: Content) -> some View {
    content.padding(.horizontal, SIS.inset).padding(.vertical, SIS.cellInset)
  }
}
