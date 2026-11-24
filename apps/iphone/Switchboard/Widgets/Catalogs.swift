import A2UICore
import A2UIJSON
import A2UISwiftUI
import Combine
import JSONSchema
import OrderedJSON
import SwiftUI
import WebKit

private let common = "https://a2ui.org/specification/v1_0/common_types.json#/$defs"

/// A component's schema: its properties by their common type, which is what tells the renderer
/// to resolve a binding (`{"path": …}`) or build children.
func schema(_ name: String, _ properties: [String: String]) -> Schema {
  let props = properties.map { key, type in "\"\(key)\": {\"$ref\": \"\(common)/\(type)\"}" }.joined(separator: ", ")
  let text = "{\"type\": \"object\", \"properties\": {\"component\": {\"const\": \"\(name)\"}\(props.isEmpty ? "" : ", " + props)}}"
  return try! Schema(instance: text, remoteSchemas: A2UICommonSchema.allSchemas)
}

/// Switch's own catalog, as desktop's (apps/desktop/src/mainview/widgets/catalog.tsx): the house
/// components, drawn the way the board draws its lines.
enum SwitchCatalog {
  static let id = "https://switch.ax/catalogs/v1/catalog.json"

  /// One line: its mark, its name, and a time that runs while it does (`left` down, `elapsed` up).
  static let line = ComponentImplementation(
    name: "Line",
    schema: schema(
      "Line",
      ["label": "DynamicString", "running": "DynamicBoolean", "ringing": "DynamicBoolean", "left": "DynamicNumber", "elapsed": "DynamicNumber", "asOf": "DynamicNumber"])
  ) { node in
    LineView(
      label: node.string(for: "label") ?? "", running: node.bool(for: "running") == true, ringing: node.bool(for: "ringing") == true,
      left: node.double(for: "left"), elapsed: node.double(for: "elapsed"), asOf: node.double(for: "asOf"))
  }

  /// A line in time: when, its live marks, what.
  static let slot = ComponentImplementation(
    name: "Slot",
    schema: schema(
      "Slot",
      ["time": "DynamicString", "title": "DynamicString", "running": "DynamicBoolean", "needsYou": "DynamicBoolean", "conflict": "DynamicBoolean"])
  ) { node in
    SlotView(
      time: node.string(for: "time") ?? "", title: node.string(for: "title") ?? "", running: node.bool(for: "running") == true,
      needsYou: node.bool(for: "needsYou") == true, conflict: node.bool(for: "conflict") == true)
  }

  /// A line of label and value, with a red triangle when it's worth a look.
  static let field = ComponentImplementation(
    name: "Field", schema: schema("Field", ["label": "DynamicString", "value": "DynamicString", "alert": "DynamicBoolean"])
  ) { node in
    FieldView(label: node.string(for: "label") ?? "", value: node.string(for: "value") ?? "", alert: node.bool(for: "alert") == true)
  }

  /// What a card is about, in reading size, with a hand when it needs the user.
  static let title = ComponentImplementation(
    name: "Title", schema: schema("Title", ["label": "DynamicString", "needsYou": "DynamicBoolean"])
  ) { node in
    TitleView(label: node.string(for: "label") ?? "", needsYou: node.bool(for: "needsYou") == true)
  }

  /// Several pictures in a row that scrolls sideways, edge to edge, each opening in Quick Look.
  static let gallery = ComponentImplementation(name: "Gallery", schema: schema("Gallery", ["images": "DynamicValue"])) { pictures($0) }

  @ViewBuilder private static func pictures(_ node: Node) -> some View {
    let pictures = (node.jsonValue(for: "images")?.arrayValue ?? []).compactMap { i -> Picture? in
      guard let o = i.objectValue, let url = HouseBasic.media(o["url"]?.stringValue) else { return nil }
      return Picture(link: url.absoluteString, alt: o["description"]?.stringValue ?? "")
    }
    if !pictures.isEmpty { Gallery(pictures: pictures, cell: true) }
  }

  /// A line with its live mark, name, detail, data, progress and countdown; its children (Picks)
  /// under it.
  static let row = ComponentImplementation(
    name: "Row",
    schema: schema(
      "Row",
      [
        "label": "DynamicString", "mark": "DynamicString", "detail": "DynamicString", "alert": "DynamicBoolean", "values": "DynamicValue",
        "progress": "DynamicValue", "endsAt": "DynamicValue", "children": "ChildList", "url": "DynamicString",
      ])
  ) { RowView(node: $0) }

  /// A key in a Row: its swatch and label, opening choices that Set sends to the extension.
  static let pick = ComponentImplementation(
    name: "Pick",
    schema: schema(
      "Pick",
      [
        "label": "DynamicString", "swatch": "DynamicString", "strong": "DynamicBoolean", "title": "DynamicString", "groups": "DynamicValue",
        "current": "DynamicValue", "action": "DynamicString", "args": "DynamicValue",
      ])
  ) { PickView(node: $0) }

  /// A live picture, such as a camera's, from the extension's tool.
  static let feed = ComponentImplementation(
    name: "Feed",
    schema: schema("Feed", ["action": "DynamicString", "args": "DynamicValue", "every": "DynamicNumber", "ratio": "DynamicNumber"])
  ) { FeedView(node: $0) }

  /// A line that ticks off, its ring calling the extension.
  static let check = ComponentImplementation(
    name: "Check",
    schema: schema(
      "Check", ["label": "DynamicString", "detail": "DynamicString", "done": "DynamicBoolean", "action": "DynamicString", "args": "DynamicValue"])
  ) { CheckView(node: $0) }

  /// A line to write in; Return sends what was written to the extension.
  static let entry = ComponentImplementation(
    name: "Entry",
    schema: schema("Entry", ["placeholder": "DynamicString", "action": "DynamicString", "args": "DynamicValue", "field": "DynamicString"])
  ) { EntryView(node: $0) }

  /// What's playing: art, title, who by, back / play-pause / next keys, a rule running while it plays.
  static let playing = ComponentImplementation(
    name: "Playing",
    schema: schema(
      "Playing",
      ["title": "DynamicString", "by": "DynamicString", "art": "DynamicString", "playing": "DynamicBoolean", "at": "DynamicNumber",
       "length": "DynamicNumber", "asOf": "DynamicNumber", "back": "DynamicString", "toggle": "DynamicString", "next": "DynamicString"])
  ) { PlayingView(node: $0) }

  /// Every component desktop's catalog (catalog.tsx) has: a name missing here doesn't draw on the
  /// phone (`bun run check` compares them).
  static let catalog = Catalog(
    id: id, protocolVersion: .v10,
    components: ([line, row, pick, slot, field, feed, gallery, title, check, entry, playing] + Charts.components).map { $0.showing() },
    functions: HouseBasic.functions)
}

/// A line in time (desktop's Slot): the time in a column of its own, its live marks, what; a
/// hairline under it, as a line's.
private struct SlotView: View {
  let time: String
  let title: String
  let running: Bool
  let needsYou: Bool
  let conflict: Bool

  var body: some View {
    HStack(spacing: 10) {
      // Desktop's 68 px column, at the phone's figure size.
      Text(time).font(SIS.text(12)).foregroundStyle(SIS.ink2).lineLimit(1).frame(width: 74 * SIS.scale, alignment: .leading)
      if needsYou { Hand() }
      if running { Runner() }
      if conflict { Warn() }
      Text(title).font(SIS.text(15)).foregroundStyle(SIS.ink).lineLimit(1)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, SIS.inset)
    .frame(minHeight: SIS.row)
    .overlay(alignment: .bottom) { Hairline() }
  }
}

/// A line of label and value (desktop's Field), the value a figure at its end, whole: on the same
/// line when it fits, else on its own under the label. A red triangle when it's worth a look.
private struct FieldView: View {
  let label: String
  let value: String
  let alert: Bool

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 10) {
        named
        Spacer(minLength: 10)
        if !value.isEmpty { Figure(value) }
      }
      VStack(alignment: .trailing, spacing: 2) {
        named.frame(maxWidth: .infinity, alignment: .leading)
        if !value.isEmpty { Figure(value) }
      }
    }
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, 6)
    .frame(minHeight: SIS.row)
    .overlay(alignment: .bottom) { Hairline() }
  }

  private var named: some View {
    HStack(spacing: 10) {
      if alert { Warn() }
      Text(label).font(SIS.text(15)).foregroundStyle(SIS.ink).lineLimit(1)
    }
  }
}

/// What a card is about (desktop's Title): in reading size, semibold, with a hand when it needs
/// the user.
private struct TitleView: View {
  let label: String
  let needsYou: Bool

  var body: some View {
    HStack(spacing: 10) {
      if needsYou { Hand() }
      Text(label).font(SIS.text(SIS.Size.body, weight: .semibold)).foregroundStyle(SIS.ink)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, SIS.gap)
    .frame(minHeight: SIS.row)
  }
}

private struct LineView: View {
  let label: String
  let running: Bool
  let ringing: Bool
  let left: Double?
  let elapsed: Double?
  let asOf: Double?

  private func time(_ now: Date) -> String? {
    let nowMs = now.timeIntervalSince1970 * 1000
    let since = running ? max(0, nowMs - (asOf ?? nowMs)) : 0
    if let left { return Self.clock(left - since) }
    if let elapsed { return Self.clock(elapsed + since) }
    return nil
  }

  static func clock(_ ms: Double) -> String {
    let total = max(0, Int(ms / 1000))
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60)
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
  }

  var body: some View {
    TimelineView(.periodic(from: .now, by: running ? 1 : 3600)) { t in
      HStack(spacing: 10) {
        if ringing { Hand() }
        if running { Runner() }
        Text(label).font(SIS.text(15)).foregroundStyle(SIS.ink).lineLimit(1)
        Spacer(minLength: 8)
        if let time = time(t.date) { Figure(time) }
      }
      .padding(.horizontal, SIS.inset)
      .frame(minHeight: SIS.row)
      .overlay(alignment: .bottom) { Hairline() }
    }
  }
}

/// A2UI's MCP catalog: `McpApp`, an MCP App drawn in a WKWebView, as desktop draws it in A2UI's
/// sandboxed iframe.
enum McpCatalog {
  static let id = "https://a2ui.org/specification/v1_0/catalogs/mcp/catalog.json"

  static let app = ComponentImplementation(name: "McpApp", schema: schema("McpApp", ["htmlContent": "DynamicString", "title": "DynamicString"])) { node in
    McpAppCell(html: Self.decoded(node.string(for: "htmlContent") ?? ""), title: node.string(for: "title") ?? "", result: Self.resultPath(node))
  }

  static let catalog = Catalog(id: id, protocolVersion: .v10, components: [app.showing()])

  /// "A value prefixed with `url_encoded:` is decoded before rendering."
  static func decoded(_ html: String) -> String {
    html.hasPrefix("url_encoded:") ? (String(html.dropFirst("url_encoded:".count)).removingPercentEncoding ?? "") : html
  }

  /// Where in its widget's data the app's `data.paths.toolResult` points: what it's sent as MCP
  /// Apps' tool-result, as desktop's McpApp sends it.
  static func resultPath(_ node: Node) -> String? {
    (node.properties["data"] as? JSONValue)?.objectValue?["paths"]?.objectValue?["toolResult"]?.stringValue
  }
}

extension EnvironmentValues {
  /// The width over height an MCP App's widget keeps; without one it sits square.
  @Entry var mcpRatio: Double? = nil
  /// Its widget's data, which an MCP App's `toolResult` path reads.
  @Entry var mcpData: DataModel? = nil
}

/// An MCP App in its widget's cell: one whose widget keeps a ratio fills the cell's width at it, as
/// desktop's grid sizes it; any other sits square, at most 280 wide. A page the agent made (the
/// core's gateway/src/page.ts, its theme style marking it) is the full width, opening at the height
/// it was made at, then as tall as it draws.
private struct McpAppCell: View {
  let html: String
  let title: String
  let result: String?
  @Environment(\.mcpRatio) private var ratio
  @Environment(\.mcpData) private var data
  @State private var drawn: CGFloat?

  private static let opening = /<meta name="switch-height" content="(\d+)">/

  var body: some View {
    if html.contains("<style id=\"switch-theme\">") {
      McpAppView(html: html, title: title, data: data, result: result, onHeight: { drawn = $0 })
        .frame(maxWidth: .infinity)
        .frame(height: drawn ?? html.firstMatch(of: Self.opening).flatMap { Double($0.1) }.map { CGFloat($0) } ?? 200)
    } else if let ratio {
      McpAppView(html: html, title: title, data: data, result: result)
        .aspectRatio(ratio, contentMode: .fit).frame(maxWidth: .infinity)
    } else {
      McpAppView(html: html, title: title, data: data, result: result)
        .aspectRatio(1, contentMode: .fit).frame(maxWidth: 280).padding(.vertical, 12).frame(maxWidth: .infinity)
    }
  }
}

/// An MCP App in a web view with no network of its own. Its JSON-RPC to the host (`window.parent`,
/// which is the page itself here) comes over a message handler; the host answers `ui/initialize`
/// with what MCP Apps' hosts say, and once the app says it's initialized sends what its `toolResult`
/// path holds as `ui/notifications/tool-result`, again whenever that changes.
struct McpAppView: UIViewRepresentable {
  let html: String
  let title: String
  let data: DataModel?
  let result: String?
  /// Told the height the page draws at, whenever it changes.
  var onHeight: ((CGFloat) -> Void)? = nil

  /// The page's height, told as MCP Apps tell it (`ui/notifications/size-changed`): its content's,
  /// not the view's, so it can shrink. An app that tells its own height is taken at its word.
  private static let measure = """
    (() => {
      let last = 0;
      const report = () => {
        if (window.__mcpSized) return;
        const r = document.documentElement;
        const height = Math.ceil(r.scrollHeight > r.clientHeight ? r.scrollHeight : r.getBoundingClientRect().height);
        if (height === last) return;
        last = height;
        window.webkit.messageHandlers.mcp.postMessage(JSON.stringify({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height } }));
      };
      const observer = new ResizeObserver(report);
      observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
      addEventListener("load", report);
      report();
    })();
    """

  /// Takes the app's posts to its parent, and gives the host's answers back as message events.
  private static let bridge = """
    (() => {
      const post = window.postMessage.bind(window);
      window.parent.postMessage = window.postMessage = (data, origin) => {
        if (data && data.jsonrpc === "2.0" && !data.__host) {
          if (data.method === "ui/notifications/size-changed") window.__mcpSized = true;
          window.webkit.messageHandlers.mcp.postMessage(JSON.stringify(data));
        } else { post(data, origin); }
      };
      window.__mcpHost = (json) => {
        const data = JSON.parse(json); data.__host = true;
        window.dispatchEvent(new MessageEvent("message", { data, source: window }));
      };
    })();
    """

  /// The page at the phone's own scale, never zoomed: its width the view's.
  private static let viewport = """
    (() => {
      const meta = document.createElement("meta");
      meta.name = "viewport";
      meta.content = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no";
      (document.head || document.documentElement).prepend(meta);
    })();
    """

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: UIViewRepresentableContext<McpAppView>) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.userContentController.addUserScript(WKUserScript(source: Self.bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    config.userContentController.addUserScript(WKUserScript(source: Self.viewport, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    config.userContentController.addUserScript(WKUserScript(source: Self.measure, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    config.userContentController.add(context.coordinator, name: "mcp")
    let view = WKWebView(frame: .zero, configuration: config)
    view.isOpaque = false
    view.backgroundColor = .clear
    // Its frame never zooms or scrolls: it's as tall as the app says it draws.
    view.scrollView.isScrollEnabled = false
    view.scrollView.bounces = false
    view.scrollView.minimumZoomScale = 1
    view.scrollView.maximumZoomScale = 1
    view.scrollView.pinchGestureRecognizer?.isEnabled = false
    view.scrollView.delegate = context.coordinator
    view.accessibilityLabel = title
    view.navigationDelegate = context.coordinator
    context.coordinator.view = view
    context.coordinator.html = html
    context.coordinator.onHeight = onHeight
    context.coordinator.follow(data, result)
    view.loadHTMLString(html, baseURL: nil)
    return view
  }

  func updateUIView(_ view: WKWebView, context: UIViewRepresentableContext<McpAppView>) {
    context.coordinator.onHeight = onHeight
    guard context.coordinator.html != html else { return }
    context.coordinator.html = html
    context.coordinator.reloaded()
    view.loadHTMLString(html, baseURL: nil)
  }

  final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, UIScrollViewDelegate {
    weak var view: WKWebView?
    var html = ""
    var onHeight: ((CGFloat) -> Void)?
    /// What the app's `toolResult` path holds, as JSON, and what was last sent of it.
    private var result: String?
    private var sent: String?
    private var initialized = false
    private var watching: AnyCancellable?

    /// Keeps up with `path` in `data`.
    func follow(_ data: DataModel?, _ path: String?) {
      guard let data, let path else { return }
      watching = data.dataPublisher.sink { [weak self, weak data] _ in
        self?.result = data?.get(path).flatMap { try? $0.serialized() }
        self?.flush()
      }
    }

    /// A page loaded again is sent nothing until it's initialized again.
    func reloaded() {
      initialized = false
      sent = nil
    }

    private func flush() {
      guard initialized, let result, result != sent, let structured = JSON.parse(result) else { return }
      sent = result
      var params: [String: JSON] = ["content": [["type": "text", "text": .string(result)]]]
      if case .object = structured { params["structuredContent"] = structured }
      send(["jsonrpc": "2.0", "method": "ui/notifications/tool-result", "params": .object(params)])
    }

    private func send(_ message: JSON) {
      let quoted = String(decoding: (try? JSONEncoder().encode(message.text)) ?? Data(), as: UTF8.self)
      view?.evaluateJavaScript("window.__mcpHost(\(quoted))")
    }

    /// Nothing in it zooms.
    func viewForZooming(in scrollView: UIScrollView) -> UIView? { nil }

    /// A web link it follows opens in the browser, as the desktop's frame opens one (`ui/open-link`).
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
      guard action.navigationType == .linkActivated, let url = action.request.url, url.scheme == "https" || url.scheme == "http"
      else { return .allow }
      await UIApplication.shared.open(url)
      return .cancel
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
      guard let text = message.body as? String, let request = JSON.parse(text) else { return }
      switch request["method"].str {
      case "ui/notifications/size-changed":
        if let height = request["params"]["height"].number, height > 0 { onHeight?(CGFloat(height)) }
      case "ui/initialize":
        guard let id = request["id"].number else { return }
        send([
          "jsonrpc": "2.0", "id": .number(id),
          "result": [
            "protocolVersion": request["params"]["protocolVersion"],
            "hostInfo": ["name": "Switchboard", "version": "1"],
            "hostCapabilities": [:],
            "hostContext": ["theme": .string(UITraitCollection.current.userInterfaceStyle == .dark ? "dark" : "light"), "platform": "mobile"],
          ],
        ])
      case "ui/notifications/initialized":
        initialized = true
        // As desktop's McpApp does for a bound result: its input (none), then the result.
        if watching != nil { send(["jsonrpc": "2.0", "method": "ui/notifications/tool-input", "params": ["arguments": [:]]]) }
        flush()
      default:
        break
      }
    }
  }
}
