import SwiftUI

/// Items along a line, wrapping onto the next when the line is full: a legend's names.
struct ChartFlow: Layout {
  var spacing: CGFloat = 12
  var lineSpacing: CGFloat = 4

  private func lines(_ sizes: [CGSize], width: CGFloat) -> [[Int]] {
    var lines: [[Int]] = [[]]
    var x: CGFloat = 0
    for (i, size) in sizes.enumerated() {
      if x > 0 && x + size.width > width {
        lines.append([])
        x = 0
      }
      lines[lines.count - 1].append(i)
      x += size.width + spacing
    }
    return lines
  }

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
    let width = proposal.width ?? .infinity
    let rows = lines(sizes, width: width)
    var height: CGFloat = 0
    var widest: CGFloat = 0
    for row in rows {
      let tallest: CGFloat = row.map { sizes[$0].height }.max() ?? 0
      let gaps: CGFloat = spacing * CGFloat(max(0, row.count - 1))
      let rowWidth: CGFloat = row.map { sizes[$0].width }.reduce(0, +) + gaps
      height += tallest
      widest = max(widest, rowWidth)
    }
    return CGSize(width: min(width, widest), height: height + lineSpacing * CGFloat(max(0, rows.count - 1)))
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
    var y = bounds.minY
    for row in lines(sizes, width: bounds.width) {
      var x = bounds.minX
      let height = row.map { sizes[$0].height }.max() ?? 0
      for i in row {
        subviews[i].place(at: CGPoint(x: x, y: y + (height - sizes[i].height) / 2), proposal: ProposedViewSize(sizes[i]))
        x += sizes[i].width + spacing
      }
      y += height + lineSpacing
    }
  }
}
