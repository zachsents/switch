import A2UICore
import A2UISwiftUI
import Foundation
import Observation

/// A widget an extension offers, as `/widgets` lists it.
struct Offered: Hashable {
  let app: String
  let name: String
  let title: String
  let refresh: [String]
  /// The width over height it keeps, when its shape is wide or tall.
  let ratio: Double?
  var key: String { "\(app)/\(name)" }
}

/// The iPhone as a widget host (apps/desktop/src/mainview/widgets/host.ts): each placed widget's
/// A2UI messages from the core's `/widgets`, rendered by Google's A2UISwiftUI with the basic
/// catalog in the house's drawing, Switch's catalog and the MCP catalog, whose `McpApp` runs in a WKWebView.
@MainActor @Observable
final class WidgetHost {
  private(set) var offered: [String: Offered] = [:]
  /// Moves on every load, so views re-read their surfaces.
  private(set) var version = 0

  let catalogs: [Catalog<ComponentImplementation>]
  @ObservationIgnored private let processor: MessageProcessor
  @ObservationIgnored private let parser = MessageParser()
  @ObservationIgnored private let actions = Actions()
  @ObservationIgnored private var fetch: (String) async -> Data? = { _ in nil }
  @ObservationIgnored private var send: (String, Data) async throws -> Data = { _, _ in throw Sync.Rejected(reason: "No core") }
  @ObservationIgnored private weak var brain: Brain?
  @ObservationIgnored private var loading: Set<String> = []
  @ObservationIgnored private var due: Set<String> = []
  /// Where each surface's messages come from, when it isn't `widgets/<key>`: a chat line's.
  @ObservationIgnored private var paths: [String: String] = [:]

  init() {
    // The basic catalog in the house's drawing (HouseBasic), never the SDK's: its List is a vertical
    // ScrollView, which inside the Widgets tab's own looped the layout against the navigation bar.
    catalogs = [SwitchCatalog.catalog, HouseBasic.catalog, McpCatalog.catalog]
    processor = MessageProcessor(catalogs: catalogs, actionHandler: actions)
  }

  @ObservationIgnored private var watch: ([String]) -> Void = { _ in }

  /// The core's HTTP, with the phone's token (Sync.get): nil when it isn't there or says no.
  func attach(
    brain: Brain, get: @escaping (String) async -> Data?, post: @escaping (String, Data) async throws -> Data,
    watch: @escaping ([String]) -> Void
  ) {
    self.brain = brain
    self.fetch = get
    self.send = post
    self.watch = watch
    brain.watchers.append { [weak self] e in self?.saw(e) }
    actions.call = { [weak self] surface, tool, args in
      Task { @MainActor in await self?.call(surface, tool, args) }
    }
  }

  /// The app whose widgets are the views the agent made (the core's brain app): there for as long as
  /// the brain is, offered or not (desktop's widgets/host.ts `MADE`).
  static let made = "brain"

  func surface(_ key: String) -> SurfaceViewModel? {
    _ = version
    if let s = processor.surfaceGroupModel.surfacesMap[key] { return s }
    if offered[key] != nil || key.hasPrefix("\(Self.made)/") { Task { await load(key) } }
    return nil
  }

  /// A widget shown in a chat line: a surface of its own (`<app>/<name>#<seq>`, as desktop keys it),
  /// its tool called with the line's input.
  func surface(_ shown: Shown, seq: Int) -> SurfaceViewModel? {
    _ = version
    let key = "\(shown.key)#\(seq)"
    if let s = processor.surfaceGroupModel.surfacesMap[key] { return s }
    if shown.app == Self.made || offered[shown.key] != nil {
      let input = shown.input.flatMap { $0.text.addingPercentEncoding(withAllowedCharacters: .alphanumerics) }
      Task { await load(key, from: "widgets/\(shown.key)" + (input.map { "?input=\($0)" } ?? "")) }
    }
    return nil
  }

  private func get(_ path: String) async -> JSON? {
    guard let data = await fetch(path) else { return nil }
    return await Self.parsed(data)
  }

  /// What the core sent, read away from the main thread: a camera's frame is a few hundred KB of
  /// base64, several a second.
  @concurrent nonisolated private static func parsed(_ data: Data) async -> JSON? { JSON.parse(data) }

  func list() async {
    if let all = await get("widgets") {
      let list = all.array.map {
        Offered(
          app: $0["app"].str, name: $0["name"].str, title: $0["title"].str, refresh: $0["refresh"].array.map(\.str),
          ratio: ["wide", "tall"].contains($0["size"]["aspect"].str) ? $0["size"]["ratio"].number : nil)
      }
      offered = Dictionary(list.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
      // High-rate streams come to clients only for the widgets that refresh on them.
      watch(Array(Set(list.flatMap(\.refresh))).sorted())
    }
    // A placed widget whose extension hasn't connected yet: look again.
    if let brain, brain.widgets.contains(where: { offered[$0.key] == nil }) {
      try? await Task.sleep(for: .seconds(3))
      await list()
    }
  }

  /// First load: every message, each surface given the widget's key as its id so two extensions'
  /// surfaces never collide. After that, only data: the surface and its frames stay.
  private func load(_ key: String, from path: String? = nil) async {
    if let path { paths[key] = path }
    guard loading.insert(key).inserted else { return }
    defer { loading.remove(key) }
    guard let raw = await get(paths[key] ?? "widgets/\(key)") else { return }
    let fresh = processor.surfaceGroupModel.surfacesMap[key] == nil
    for message in raw.array {
      var m = message.object
      for kind in ["createSurface", "updateComponents", "updateDataModel", "deleteSurface"] {
        if case .object(var inner) = m[kind] {
          inner["surfaceId"] = .string(key)
          if let components = inner["components"] { inner["components"] = .array(components.array.map(Self.current)) }
          m[kind] = .object(inner)
        }
      }
      guard fresh || m["updateDataModel"] != nil else { continue }
      // A page the agent made takes the phone's theme (PageTheme).
      if key.hasPrefix("\(Self.made)/"), case .object(var update) = m["updateDataModel"],
        case .object(var value) = update["value"], case .string(let page) = value["page"]
      {
        value["page"] = .string(PageTheme.themed(page))
        update["value"] = .object(value)
        m["updateDataModel"] = .object(update)
      }
      if let parsed = try? parser.parse(jsonString: JSON.object(m).text) {
        processor.process(message: parsed)
      }
    }
    version += 1
  }

  /// A component naming a part Switch's catalog dropped, read as the basic part that replaced it
  /// (switch-ext-kit's catalog): Picture an Image, Stack a Column, Lines a List, Head a heading's
  /// Text and Empty a caption.
  private static func current(_ component: JSON) -> JSON {
    var c = component.object
    switch component["component"].str {
    case "Picture":
      c["component"] = "Image"
      c["url"] = c.removeValue(forKey: "src") ?? ""
    case "Stack":
      c["component"] = "Column"
    case "Lines":
      c["component"] = "List"
    case "Head":
      let label = c.removeValue(forKey: "label") ?? ""
      c["component"] = "Text"
      if let path = label["@path"].string {
        c["text"] = ["@call": "formatString", "catalogId": .string(HouseBasic.catalog.id), "args": ["value": .string("# ${\(path)}")]]
      } else if let words = label.string {
        c["text"] = .string("# " + words)
      } else {
        c["text"] = label
      }
    case "Empty":
      c["component"] = "Text"
      c["text"] = c.removeValue(forKey: "label") ?? ""
      c["variant"] = "caption"
    default:
      return component
    }
    c["catalogId"] = .string(HouseBasic.catalog.id)
    return .object(c)
  }

  /// Calls one of a widget's extension's tools through the core's `/widgets/<app>/<tool>`, kept in
  /// the Outbox with an id so a retry never runs it twice, then loads the widget's data again so
  /// what the press changed shows.
  private func call(_ surface: String, _ tool: String, _ args: Data) async {
    guard let app = surface.split(separator: "/").first else { return }
    await Outbox.shared.call("\(app)/\(tool)", JSON.parse(args) ?? [:])
    await load(surface)
  }

  /// Calls one of an extension's tools for its widget, a swap or a camera frame (desktop's
  /// widgets/call.ts `callChecked`): its MCP result, or what it said went wrong, thrown.
  func call(_ app: String, _ tool: String, _ args: JSON) async throws -> JSON {
    let answer: JSON
    do {
      answer = await Self.parsed(try await send("widgets/\(app)/\(tool)", args.data)) ?? .null
    } catch {
      throw Sync.Rejected(reason: "Can't reach the core")
    }
    if answer["isError"].bool == true {
      throw Sync.Rejected(reason: answer["content"].array.first?["text"].string ?? "Didn't go through")
    }
    return answer
  }

  /// Calls a widget's tool from one of its parts (Check, Entry, Pick's Set), then loads the widget's
  /// data again so what it changed shows; what went wrong, thrown.
  func set(_ surface: String, _ tool: String, _ args: JSON) async throws {
    guard let app = surface.split(separator: "/").first.map(String.init) else { return }
    _ = try await call(app, tool, args)
    await load(surface)
  }

  /// A widget's data comes again when an event it names lands, at most once per 100 ms.
  private func saw(_ e: StoredEvent) {
    if e.type.hasPrefix("widget."), offered["\(e.payload["app"].str)/\(e.payload["name"].str)"] == nil {
      Task { await list() }
    }
    for w in offered.values where w.refresh.contains(e.type) && processor.surfaceGroupModel.surfacesMap[w.key] != nil {
      guard due.insert(w.key).inserted else { continue }
      let key = w.key
      Task {
        try? await Task.sleep(for: .milliseconds(100))
        due.remove(key)
        await load(key)
      }
    }
  }
}

/// A widget's action is one of its extension's tools by name, its resolved context the arguments;
/// the surface id says whose (`printers/overview`), as desktop's host does.
nonisolated private final class Actions: ActionHandling, @unchecked Sendable {
  /// Set once, when the host attaches: calls the tool, on the main actor.
  var call: @Sendable (_ surface: String, _ tool: String, _ args: Data) -> Void = { _, _, _ in }

  func handle(action: ResolvedAction, from surfaceID: String) {
    guard case .event(let name, let context, _) = action.identity,
      let args = try? JSONEncoder().encode(context ?? [:])
    else { return }
    call(surfaceID, name, args)
  }

  func handle(error: RendererError, from surfaceID: String) {}
}
