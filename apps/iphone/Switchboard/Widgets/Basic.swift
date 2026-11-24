import A2UICore
import A2UISwiftUI
import BasicCatalog
import SwiftUI
import UIKit

/// A2UI's basic catalog (v1.0), drawn in Switch's look (desktop's widgets/basic), as old
/// Switchboard's iPhone app drew it (Widgets/Basic): the parts' schemas and the catalog's
/// functions (formatString, required, openUrl, …) are Google's SDK's, as A2UI defines them; only
/// the drawing is the house's.
enum HouseBasic {
  static let catalog: Catalog<ComponentImplementation> = {
    let parts: [String: ComponentViewBuilder] = [
      "Text": { AnyView(BasicText(node: $0)) },
      "Image": { AnyView(BasicImage(node: $0).shows()) },
      "Icon": { AnyView(BasicIcon(node: $0).shows()) },
      "Video": { AnyView(BasicVideo(node: $0).shows()) },
      "AudioPlayer": { AnyView(BasicAudio(node: $0).shows()) },
      "Row": { AnyView(BasicRow(node: $0)) },
      "Column": { AnyView(BasicColumn(node: $0)) },
      "List": { AnyView(BasicList(node: $0)) },
      "Card": { AnyView(BasicCard(node: $0)) },
      "Tabs": { AnyView(BasicTabs(node: $0)) },
      "Modal": { AnyView(BasicModal(node: $0)) },
      "Divider": { AnyView(BasicDivider(node: $0)) },
      "Button": { AnyView(BasicButton(node: $0).shows()) },
      "TextField": { AnyView(BasicTextField(node: $0).shows()) },
      "CheckBox": { AnyView(BasicCheckBox(node: $0).shows()) },
      "ChoicePicker": { AnyView(BasicChoicePicker(node: $0).shows()) },
      "Slider": { AnyView(BasicSlider(node: $0).shows()) },
      "DateTimeInput": { AnyView(BasicDateTimeInput(node: $0).shows()) },
    ]
    return Catalog(
      id: V10BasicCatalog.catalogURI,
      protocolVersion: .v10,
      components: V10BasicCatalog.components.compactMap { api in
        parts[api.name].map { ComponentImplementation(api: api, builder: $0) }
      },
      functions: functions,
      themeSchema: nil)
  }()

  /// The basic catalog's functions (formatString, required, openUrl, …), Switch's catalog's too:
  /// a call that names no catalog runs in its surface's.
  static let functions = V10BasicFunctions.makeFunctions(locale: .current, openURLHandler: MediaLinks.shared)

  /// What a key leaves above and below it on a row, so a row of keys is a row tall.
  static let keyRoom = (SIS.row - SIS.key) / 2

  /// A media link (`Image`, `Video`, `AudioPlayer`) as A2UI allows it, a `/blobs/…` one against the
  /// core, as a reply's.
  static func media(_ link: String?) -> URL? {
    guard let url = BasicCatalog.sanitizeMediaURL(link) else { return nil }
    return url.scheme == nil ? Blobs.resolve(url.relativeString) : url
  }
}

/// Opens the links a widget's `openUrl` asks for. The catalog holds it weakly, so it lives here.
nonisolated final class MediaLinks: OpenURLHandler {
  static let shared = MediaLinks()

  func open(_ url: URL) {
    Task { @MainActor in UIApplication.shared.open(url) }
  }
}

/// Where a part is laid: down a cell, a line of its own with its words inset from the cell's edges;
/// across a line, bare, the line holding the inset (a Row's children); or on a key, in the key's
/// own face and colors (a Button's child).
nonisolated enum Laid: Sendable {
  case down, across, key
}

nonisolated private struct LaidKey: EnvironmentKey {
  static let defaultValue = Laid.down
}

nonisolated private struct LineUpKey: EnvironmentKey {
  static let defaultValue = HorizontalAlignment.leading
}

nonisolated private struct OpenModalKey: EnvironmentKey {
  static let defaultValue: (@MainActor () -> Void)? = nil
}

extension EnvironmentValues {
  var laid: Laid {
    get { self[LaidKey.self] }
    set { self[LaidKey.self] = newValue }
  }

  /// How a column lines up what's in it (its `align`).
  var lineUp: HorizontalAlignment {
    get { self[LineUpKey.self] }
    set { self[LineUpKey.self] = newValue }
  }

  /// Opens the Modal a trigger is in: its Button calls it as well as its action.
  var openModal: (@MainActor () -> Void)? {
    get { self[OpenModalKey.self] }
    set { self[OpenModalKey.self] = newValue }
  }
}

extension View {
  /// A part on a line of its own down a cell: inset from the cell's edges, `room` above and below,
  /// at least a row tall, lined up as its column says.
  func onLine(_ lineUp: HorizontalAlignment, room: CGFloat) -> some View {
    padding(.horizontal, SIS.inset)
      .padding(.vertical, room)
      .frame(maxWidth: .infinity, minHeight: SIS.row, alignment: Alignment(horizontal: lineUp, vertical: .center))
  }

  /// Its label for VoiceOver, when it has one.
  @ViewBuilder func spoken(_ label: String?) -> some View {
    if let label, !label.isEmpty {
      accessibilityLabel(label)
    } else {
      self
    }
  }

  /// On a line of its own when laid down a cell, else as it is.
  @ViewBuilder func placed(_ laid: Laid, _ lineUp: HorizontalAlignment, room: CGFloat) -> some View {
    if laid == .down {
      onLine(lineUp, room: room)
    } else {
      self
    }
  }
}

/// A container's `justify`, as space round its children.
struct Justify {
  let value: String

  var spread: Bool { ["spaceBetween", "spaceAround", "spaceEvenly"].contains(value) }
  var leads: Bool { ["end", "center", "spaceAround", "spaceEvenly"].contains(value) }
  var trails: Bool { ["center", "spaceAround", "spaceEvenly"].contains(value) }
}

/// A column's `align`, across it.
func lined(_ align: String?) -> HorizontalAlignment {
  switch align {
  case "center": .center
  case "end": .trailing
  default: .leading
  }
}

/// Words lined up as their column says.
func textAlignment(_ lineUp: HorizontalAlignment) -> TextAlignment {
  switch lineUp {
  case .center: .center
  case .trailing: .trailing
  default: .leading
  }
}
