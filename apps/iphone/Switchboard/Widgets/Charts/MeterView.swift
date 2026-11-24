import SwiftUI

/// How full something is (desktop's meter.tsx): a line with its label, a track filled to the value of
/// its most, and the figure (with a prefix or suffix, else the share). The fill is the first series'
/// color, square where it starts and rounded at its end; the track the lightest step of its hue.
struct MeterView: View {
  let label: String
  let value: Double
  let most: Double
  let fig: Figures

  private static let track: CGFloat = 6

  var body: some View {
    let share = min(1, max(0, value / most))
    let end = UnevenRoundedRectangle(bottomTrailingRadius: Self.track / 2, topTrailingRadius: Self.track / 2)
    HStack(spacing: 10) {
      if !label.isEmpty {
        Text(label).font(SIS.text(SIS.Size.body)).foregroundStyle(SIS.ink).lineLimit(1)
          .containerRelativeFrame(.horizontal, alignment: .leading) { width, _ in width / 4 }
      }
      GeometryReader { geo in
        ZStack(alignment: .leading) {
          end.fill(SIS.magnitude[0])
          if share > 0 { end.fill(SIS.series[0]).frame(width: geo.size.width * share) }
        }
      }
      .frame(height: Self.track)
      Figure(fig.prefix.isEmpty && fig.suffix.isEmpty ? Figures.percent(value / most) : fig.figure(value))
    }
    .padding(.horizontal, SIS.inset)
    .frame(minHeight: SIS.row)
  }
}
