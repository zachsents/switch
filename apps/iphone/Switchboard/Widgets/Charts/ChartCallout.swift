import SwiftUI

/// What a chart shows for the touch, floating as what floats does (desktop's tip-box.tsx): what the
/// values are at, then each value first and strong, keyed by a short line of its color, its name and
/// what else it is after it.
struct ChartCallout: View {
  struct Row: Identifiable {
    let value: String
    let name: String
    let color: Color
    var note = ""
    var id: String { "\(name)-\(value)-\(note)" }
  }

  let title: String
  let rows: [Row]

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      if !title.isEmpty {
        Text(title).font(SIS.text(SIS.Size.label)).foregroundStyle(SIS.ink3).lineLimit(1)
      }
      if !rows.isEmpty {
        Grid(alignment: .leading, horizontalSpacing: 6, verticalSpacing: 4) {
          ForEach(rows) { r in
            GridRow {
              ChartKey(kind: .line, color: r.color)
              Text(r.value).font(SIS.text(13, weight: .semibold)).foregroundStyle(SIS.ink).gridColumnAlignment(.trailing)
              Text(r.name).font(SIS.text(13)).foregroundStyle(SIS.ink2)
              Text(r.note).font(SIS.text(13)).foregroundStyle(SIS.ink3)
            }
          }
        }
        .lineLimit(1)
      }
    }
    .fixedSize()
    .padding(.horizontal, 8)
    .padding(.vertical, 5)
    .background(SIS.paper, in: RoundedRectangle(cornerRadius: SIS.controlRadiusLarge))
    .overlay(RoundedRectangle(cornerRadius: SIS.controlRadiusLarge).stroke(SIS.rule, lineWidth: SIS.line))
  }
}
