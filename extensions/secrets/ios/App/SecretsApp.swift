import SwiftUI
import UIKit
import UniformTypeIdentifiers

@main
struct SecretsApp: App {
  @Environment(\.scenePhase) private var phase
  @State private var model = Model()

  var body: some Scene {
    WindowGroup {
      RootView(model: model)
        .tint(SIS.ink)
        .preferredColorScheme(.dark)
        // Nothing of the vault shows in the app switcher.
        .overlay {
          if phase != .active && model.vault.phase == .open {
            SIS.paper.ignoresSafeArea()
          }
        }
    }
    .onChange(of: phase) { _, now in model.moved(to: now) }
  }
}

enum Route: Hashable {
  case item(String)
  case history(String)
  case devices
  case settings
}

/// What's being made or changed: a new item of a kind, or one that's there.
struct Draft: Identifiable {
  let id = UUID()
  let item: Item
  let new: Bool
}

/// The app: the core, the vault, where the user is, and locking when it's put away.
@MainActor @Observable
final class Model {
  let core = Core(app: "secrets")
  let vault: Vault
  var path: [Route] = []
  var editing: Draft?
  @ObservationIgnored private var away: Date?
  @ObservationIgnored private var background: UIBackgroundTaskIdentifier = .invalid
  @ObservationIgnored private var locking: Task<Void, Never>?

  /// How long the vault stays open once the app is put away.
  static let grace: Duration = .seconds(30)

  init() {
    vault = Vault(core: core)
    core.on(["secrets.changed"]) { [weak self] _, _ in
      Task { await self?.vault.sync() }
    }
    core.start()
    Task { await vault.sync() }
    pair()
  }

  /// A credential for the core, if this app has none yet.
  func pair() {
    Task { await core.pair(name: "Secrets on \(UIDevice.current.name)") }
  }

  func moved(to phase: ScenePhase) {
    switch phase {
    case .background:
      away = Date()
      guard vault.phase == .open else { return }
      background = UIApplication.shared.beginBackgroundTask { [weak self] in self?.lockNow() }
      locking = Task { [weak self] in
        try? await Task.sleep(for: Self.grace)
        guard !Task.isCancelled else { return }
        self?.lockNow()
      }
    case .active:
      locking?.cancel()
      locking = nil
      if let away, Date().timeIntervalSince(away) > 30 { lockNow() }
      away = nil
      endBackground()
      core.wake()
      Task { await vault.sync() }
    default:
      break
    }
  }

  private func lockNow() {
    vault.lock()
    path = []
    editing = nil
    endBackground()
  }

  private func endBackground() {
    guard background != .invalid else { return }
    UIApplication.shared.endBackgroundTask(background)
    background = .invalid
  }

  /// Onto the pasteboard, this device only, gone after 90 seconds.
  func copy(_ value: String) {
    UIPasteboard.general.setItems(
      [[UTType.utf8PlainText.identifier: value]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(90)])
  }

  /// Face ID again, for a reveal or a copy.
  func confirm(_ reason: String) async -> Bool {
    await Auth.confirm(reason) != nil
  }
}

/// Where the vault stands: enrolling, waiting to be approved, locked, or open.
struct RootView: View {
  let model: Model

  var body: some View {
    switch model.vault.phase {
    case .fresh, .waiting, .revoked:
      NavigationStack { EnrollView(model: model) }
    case .locked:
      NavigationStack { LockView(model: model) }
    case .open:
      @Bindable var model = model
      NavigationStack(path: $model.path) {
        ListView(model: model)
          .navigationDestination(for: Route.self) { route in
            switch route {
            case .item(let id): ItemView(model: model, id: id)
            case .history(let id): HistoryView(model: model, id: id)
            case .devices: DevicesView(model: model)
            case .settings: SettingsView(model: model)
            }
          }
      }
      .onDisappear {
        model.path = []
        model.editing = nil
      }
      .sheet(item: $model.editing) { draft in
        EditView(model: model, original: draft.item, new: draft.new)
          .presentationCornerRadius(SIS.radius)
      }
    }
  }
}
