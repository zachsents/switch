import SwiftUI

/// Home at the root, every other space and thread pushed over it. Back is the system's swipe.
/// Unpaired, the pair screen.
struct RootView: View {
  @Bindable var phone: Phone

  var body: some View {
    Group {
      if phone.credential == nil {
        PairView(phone: phone)
      } else {
        stack
      }
    }
    .onChange(of: phone.screen, initial: true) { _, screen in Trail.shared.screen(screen) }
  }

  private var stack: some View {
    NavigationStack(path: $phone.path) {
      SpaceView(phone: phone, id: HOME)
        .navigationDestination(for: Route.self) { route in
          switch route {
          case .space(let id): SpaceView(phone: phone, id: id)
          case .thread(let id): ThreadView(phone: phone, id: id)
          case .memory: MemoryView(phone: phone)
          case .system: SystemView(phone: phone)
          }
        }
    }
    .tint(SIS.ink)
    // A reply's citation of another space's exchange (switch://space/<id>?seq=…) opens that space,
    // and a link to a page here (switchboard://space/<id>, thread/<id>, item/<id>, or a bare id the
    // agent linked: `[the ask](i-…)`) opens it.
    .environment(\.openURL, OpenURLAction { url in
      if url.scheme == "switchboard" {
        phone.open(url: url)
        return .handled
      }
      if url.scheme == nil, !url.relativeString.isEmpty, !url.relativeString.contains("/"),
        let own = URL(string: "switchboard://id/\(url.relativeString)")
      {
        phone.open(url: own)
        return .handled
      }
      guard url.scheme == "switch", url.host() == "space" else { return .systemAction }
      let id = url.pathComponents.dropFirst().first ?? ""
      if id.isEmpty { return .discarded }
      phone.path.append(.space(id))
      return .handled
    })
    .sheet(isPresented: $phone.finding) {
      PaletteView(phone: phone)
        .presentationDetents([.large])
        .presentationCornerRadius(SIS.radius)
    }
    .sheet(item: Binding(get: { phone.asking.map(AskSheet.Asking.init) }, set: { phone.asking = $0?.id })) { asking in
      AskSheet(phone: phone, id: asking.id)
        .presentationDetents([.medium, .large])
        .presentationCornerRadius(SIS.radius)
    }
    .fullScreenCover(item: Binding(get: { phone.portal.map(PortalScreen.Showing.init) }, set: { phone.portal = $0?.id })) { showing in
      PortalScreen(phone: phone, id: showing.id) { phone.portal = nil }
    }
    .sheet(item: Binding(get: { phone.passToAdd.map(PassSheet.Serial.init) }, set: { phone.passToAdd = $0?.id })) { serial in
      PassSheet(phone: phone, serial: serial.id)
        .presentationDetents([.height(220)])
        .presentationCornerRadius(SIS.radius)
    }
  }
}

/// Reports a page as seen, and as backed out of or dwelled on when it goes.
struct Seen: ViewModifier {
  let phone: Phone
  let surface: String
  let item: String
  @State private var opened = Date()

  func body(content: Content) -> some View {
    content
      .onAppear {
        opened = Date()
        phone.viewed(surface, item)
      }
      .onDisappear { phone.left(surface, item, opened: opened) }
  }
}
