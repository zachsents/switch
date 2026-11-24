import SwiftUI
import WebKit

// An ask's live view (Switchboard's portal, packages/core/src/portal.ts): the screen of the Mac
// that holds the tab, on the ask's card while it's on screen, and full screen to drive it. The view
// is the core's own page (packages/portal), in a web view: a tap clicks; hold, then drag, drags; a
// swipe scrolls (the zoomed-in view first, then the page); a pinch zooms the picture; the keyboard
// comes up from its key, with Tab and Shift-Tab beside it. Opening it brings the tab to the front
// on that Mac. It closes when the view ends (the ask closed, or nothing was done in it for a while).

/// The core's viewer page: the item and this phone's token in its fragment, which never leaves the phone.
struct PortalWeb: UIViewRepresentable {
  let credential: Credential
  let item: String
  /// Only shows it: a card's preview.
  let watch: Bool
  var onEnd: () -> Void = {}

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.userContentController.add(context.coordinator, name: "portal")
    let view = WKWebView(frame: .zero, configuration: config)
    view.isOpaque = false
    view.backgroundColor = .black
    view.scrollView.isScrollEnabled = false
    view.scrollView.bounces = false
    view.scrollView.contentInsetAdjustmentBehavior = .never
    view.scrollView.pinchGestureRecognizer?.isEnabled = false
    view.isUserInteractionEnabled = !watch
    view.accessibilityIdentifier = watch ? "portal.preview" : "portal.screen"
    context.coordinator.onEnd = onEnd
    var url = URLComponents(url: credential.core.appending(path: "portal"), resolvingAgainstBaseURL: false)
    var hash = URLComponents()
    hash.queryItems = [URLQueryItem(name: "item", value: item), URLQueryItem(name: "token", value: credential.token)]
      + (watch ? [URLQueryItem(name: "watch", value: "1")] : [])
    url?.percentEncodedFragment = hash.percentEncodedQuery
    if let page = url?.url { view.load(URLRequest(url: page)) }
    return view
  }

  func updateUIView(_ view: WKWebView, context: Context) {
    context.coordinator.onEnd = onEnd
  }

  static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
    view.configuration.userContentController.removeScriptMessageHandler(forName: "portal")
  }

  final class Coordinator: NSObject, WKScriptMessageHandler {
    var onEnd: () -> Void = {}

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
      guard let said = message.body as? [String: Any], said["ended"] != nil else { return }
      onEnd()
    }
  }
}

/// The card's picture of the screen: a tap opens it full screen.
struct PortalPreview: View {
  let phone: Phone
  let item: ActionItem
  @State private var open = false

  var body: some View {
    if let credential = phone.credential {
      Button { open = true } label: {
        ZStack {
          Color.black
          // Not while the full screen is open: it pauses, as Switchboard's did.
          if !open { PortalWeb(credential: credential, item: item.id, watch: true) }
        }
        .aspectRatio(16 / 9, contentMode: .fit)
        .frame(maxWidth: .infinity)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Screen")
      .fullScreenCover(isPresented: $open) {
        PortalScreen(phone: phone, id: item.id) { open = false }
      }
    }
  }
}

/// The screen full screen, driven: the ask's title and Close above it.
struct PortalScreen: View {
  struct Showing: Identifiable { let id: String }

  let phone: Phone
  let id: String
  let close: () -> Void

  private var item: ActionItem? { phone.brain.actions[id] }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Text(item?.title ?? "").font(SIS.text(15, weight: .semibold)).foregroundStyle(SIS.ink).lineLimit(1)
        Spacer(minLength: 8)
        Button("Close", action: close).buttonStyle(KeyStyle())
      }
      .padding(.horizontal, SIS.inset).frame(height: SIS.row)
      .background(SIS.paper)
      Hairline()
      if let credential = phone.credential, item?.status == "open" {
        PortalWeb(credential: credential, item: id, watch: false, onEnd: close)
          .ignoresSafeArea(.container, edges: .bottom)
      } else {
        Color.black.onAppear(perform: close)
      }
    }
    .background(Color.black)
  }
}
