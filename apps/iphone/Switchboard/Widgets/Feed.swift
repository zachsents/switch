import A2UICore
import A2UISwiftUI
import SwiftUI
import UIKit

/// What one of a widget's parts calls (desktop's set-mutation.ts `Call`): the extension's `action`
/// with `args`, the app being its surface's first part.
struct PartCall: Hashable {
  let app: String
  let tool: String
  let args: [String: JSON]

  init(_ node: Node, surface: String) {
    app = surface.split(separator: "/").first.map(String.init) ?? ""
    tool = node.string(for: "action") ?? ""
    args = partJSON(node, "args").object
  }

  /// Its tool's arguments: `args` and what the part adds.
  func with(_ values: [String: JSON]) -> JSON { .object(args.merging(values) { _, new in new }) }
}

/// A part's property as plain JSON, bound or not.
func partJSON(_ node: Node, _ key: String) -> JSON {
  guard let value = node.jsonValue(for: key), let data = try? JSONEncoder().encode(value) else { return .null }
  return JSON.parse(data) ?? .null
}

/// A live picture, such as a camera's (desktop's widgets/feed.tsx): a frame from the extension's
/// `action` with `args` every `every` ms (its structured result's base64 `data` and `at`), edge to
/// edge on black at `ratio`. Only a live frame is painted (so it needs no mark saying so): none older than ten seconds, none while
/// the source fails, whose words show in its place. It asks while it's drawn and the app is in
/// front, as desktop's asks while it's mounted and its window isn't hidden (TanStack's
/// refetchInterval). Nothing it sets hangs on where it is on screen: state from geometry, under the
/// widget cell's own sizing, looped the layout.
struct FeedView: View {
  let node: Node
  @Environment(\.widgetSurface) private var surface
  @Environment(\.scenePhase) private var phase
  @State private var frame: UIImage?
  @State private var cleared = false
  @State private var error: String?

  private struct Asking: Equatable {
    let call: PartCall
    let every: Double
    let on: Bool
  }

  var body: some View {
    let call = PartCall(node, surface: surface)
    let key = FeedFrames.key(call)
    let every = max(250, node.double(for: "every") ?? 1000)
    let shown = cleared || error != nil ? nil : frame ?? FeedFrames.last(key)
    Color.black
      .aspectRatio(node.double(for: "ratio") ?? 16.0 / 9.0, contentMode: .fit)
      .frame(maxWidth: .infinity)
      .overlay {
        if let shown { Image(uiImage: shown).resizable().scaledToFill() }
      }
      .clipped()
      .overlay {
        if let error {
          Text(error).font(SIS.text(SIS.Size.caption)).foregroundStyle(.white).multilineTextAlignment(.center)
            .padding(.horizontal, SIS.inset)
        }
      }
      .accessibilityHidden(true)
      .task(id: Asking(call: call, every: every, on: phase == .active)) {
        guard phase == .active else { return }
        await ask(call, key: key, every: every)
      }
  }

  /// A frame's picture from its base64 JPEG, decoded and drawn ready for the screen away from the
  /// main thread: five feeds' frames each second, decoded there, held up the whole Widgets tab.
  @concurrent nonisolated private static func picture(_ base64: String) async -> UIImage? {
    guard let bytes = Data(base64Encoded: base64) else { return nil }
    return UIImage(data: bytes)?.preparingForDisplay()
  }

  /// A frame every `every` ms, until it's gone or the app isn't in front.
  private func ask(_ call: PartCall, key: String, every: Double) async {
    while !Task.isCancelled {
      do {
        let result = try await Phone.shared.widgets.call(call.app, call.tool, call.with([:]))
        let content = result["structuredContent"]
        // When it was taken, if the extension says (ms): an old frame is no picture.
        let at = content["at"].number.map { Date(timeIntervalSince1970: $0 / 1000) } ?? .now
        let data = FeedFrames.isLive(at: at) ? content["data"].str : ""
        if !data.isEmpty, let image = await Self.picture(data) {
          FeedFrames.keep(key, image, at: at)
          frame = image
          cleared = false
        } else if data.isEmpty {
          cleared = true
        }
        error = nil
      } catch {
        if Task.isCancelled { return }
        self.error = error.localizedDescription
      }
      try? await Task.sleep(for: .milliseconds(every))
    }
  }
}

/// Each feed's last frame and when it was taken, in memory only: a feed shown again within ten
/// seconds paints it at once, then the live one as it comes; an older one is never painted.
@MainActor enum FeedFrames {
  private static var last: [String: (image: UIImage, at: Date)] = [:]
  /// A frame older than this is no longer live.
  private static let liveFor: TimeInterval = 10
  /// Frames kept on disk by an earlier version: old by definition.
  private static let folder = URL.cachesDirectory.appending(path: "feeds", directoryHint: .isDirectory)
  private static var swept = false

  static func key(_ call: PartCall) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    let args = (try? encoder.encode(JSON.object(call.args))).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    return "\(call.app)/\(call.tool)/\(args)"
  }

  static func isLive(at: Date) -> Bool { Date.now.timeIntervalSince(at) <= liveFor }

  static func last(_ key: String) -> UIImage? {
    if !swept {
      swept = true
      let folder = folder
      Task.detached(priority: .background) { try? FileManager.default.removeItem(at: folder) }
    }
    guard let held = last[key], isLive(at: held.at) else { return nil }
    return held.image
  }

  static func keep(_ key: String, _ image: UIImage, at: Date) {
    last[key] = (image, at)
  }
}
