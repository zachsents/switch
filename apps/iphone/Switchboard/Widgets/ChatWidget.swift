import A2UICore
import A2UISwiftUI
import SwiftUI

/// A widget shown in a chat, an app's or one the agent made: the chat's whole width, a rule above
/// and below (desktop's widgets/chat-widget.tsx).
struct ChatWidget: View {
  let phone: Phone
  let shown: Shown
  let seq: Int

  var body: some View {
    let host = phone.widgets
    if let surface = host.surface(shown, seq: seq) {
      VStack(spacing: 0) {
        Rule()
        ChatSurface(surface: surface, catalogs: host.catalogs)
        Rule()
      }
      .padding(.horizontal, -SIS.inset)
    }
  }
}

private struct ChatSurface: View {
  @ObservedObject var surface: SurfaceViewModel
  let catalogs: [Catalog<ComponentImplementation>]

  var body: some View {
    Surface(viewModel: surface, catalogs: catalogs)
      .environment(\.widgetSurface, surface.surfaceID)
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}
