import A2UICore
import A2UISwiftUI
import SwiftUI

/// A space's widgets, down the board: each fills its cell, rules between. An MCP App whose widget
/// keeps a ratio fills its cell's width at it; any other sits square.
struct WidgetsView: View {
  let phone: Phone
  let placed: [Placement]
  var first = false

  var body: some View {
    let host = phone.widgets
    let shown = placed.compactMap { w in host.surface(w).map { (w, $0) } }
    if !shown.isEmpty {
      VStack(spacing: 0) {
        if !first { Rectangle().fill(SIS.heavy).frame(height: SIS.heavyWidth) }
        ForEach(Array(shown.enumerated()), id: \.element.0.key) { i, item in
          WidgetCell(surface: item.1, catalogs: host.catalogs, ratio: host.offered[item.0.widget]?.ratio, ruled: i > 0)
            .modifier(Seen(phone: phone, surface: "widget", item: item.0.key))
        }
      }
    }
  }
}

/// A widget in the column. What draws only headings and captions (an empty state) is nothing to
/// show: it's out of the column until it has something (desktop's widget-cell.tsx).
private struct WidgetCell: View {
  @ObservedObject var surface: SurfaceViewModel
  let catalogs: [Catalog<ComponentImplementation>]
  let ratio: Double?
  /// A rule above it, when it shows.
  let ruled: Bool
  @State private var shows = false

  var body: some View {
    VStack(spacing: 0) {
      if ruled && shows { Rule() }
      Surface(viewModel: surface, catalogs: catalogs)
        .environment(\.mcpRatio, ratio)
        .environment(\.mcpData, surface.dataModel)
        .environment(\.widgetColumn, true)
        .environment(\.widgetSurface, surface.surfaceID)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onPreferenceChange(ShowsSomething.self) { shows = $0 }
        .frame(height: shows ? nil : 0, alignment: .top)
        .clipped()
    }
  }
}

/// Whether a widget drew something to show: words besides headings and captions, a picture, a
/// chart, a control or an app.
nonisolated struct ShowsSomething: PreferenceKey {
  static let defaultValue = false
  static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}

extension View {
  /// Says it's something to show, in a widget.
  func shows() -> some View { preference(key: ShowsSomething.self, value: true) }
}

extension ComponentImplementation {
  /// The component, saying it's something to show wherever it draws.
  func showing() -> ComponentImplementation {
    let build = builder
    return ComponentImplementation(api: self) { node in AnyView(build(node).shows()) }
  }
}

extension EnvironmentValues {
  /// Drawn in a space's widget column.
  @Entry var widgetColumn = false
  /// The surface a part draws in (`<app>/<name>`, a chat's `#<seq>` after): its first part is the
  /// app whose tools its parts call, as desktop's do.
  @Entry var widgetSurface = ""
}
