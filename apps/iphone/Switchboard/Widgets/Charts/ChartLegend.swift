import SwiftUI

/// A chart's legend, over it (desktop's legend.tsx): each series' key and name, in the order they're
/// drawn. Two series or more always have one; a single series has none, its heading names it.
struct ChartLegend: View {
  struct Item: Identifiable {
    let name: String
    let color: Color
    let id: Int
  }

  let items: [Item]
  let kind: ChartKey.Kind

  var body: some View {
    if items.count > 1 {
      ChartFlow {
        ForEach(items) { item in
          HStack(spacing: 6) {
            ChartKey(kind: kind, color: item.color)
            Text(item.name).font(SIS.text(SIS.Size.caption)).foregroundStyle(SIS.ink2).lineLimit(1)
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}
