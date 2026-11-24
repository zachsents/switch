import SwiftUI

/// A series' key beside its name, mirroring its mark (desktop's key.tsx): a square for bars, areas
/// and slices, a short line for lines, a dot for points. The color is on the key, never the words.
struct ChartKey: View {
  enum Kind { case square, line, dot }

  let kind: Kind
  let color: Color

  var body: some View {
    switch kind {
    case .square: RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 10, height: 10)
    case .line: Capsule().fill(color).frame(width: 12, height: 2).frame(height: 10)
    case .dot: Circle().fill(color).frame(width: 8, height: 8)
    }
  }
}
