import Charts
import SwiftUI

extension View {
  /// Taps on a chart, told where in its plot they land. A tap, not a drag, so a board of charts still
  /// scrolls under the finger.
  func chartTap(_ action: @escaping (ChartProxy, CGPoint) -> Void) -> some View {
    chartOverlay { proxy in
      GeometryReader { geo in
        Rectangle().fill(.clear).contentShape(Rectangle())
          .onTapGesture { location in
            let origin = proxy.plotFrame.map { geo[$0].origin } ?? .zero
            action(proxy, CGPoint(x: location.x - origin.x, y: location.y - origin.y))
          }
      }
    }
  }
}
