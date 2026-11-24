import SwiftUI

@main
struct ContactsApp: App {
  @Environment(\.scenePhase) private var phase
  @State private var model = Model()

  var body: some Scene {
    WindowGroup {
      NavigationStack(path: $model.path) {
        SearchView(model: model)
          .navigationDestination(for: Route.self) { route in
            switch route {
            case .person(let id): PersonView(model: model, id: id)
            case .history: HistoryView(model: model)
            }
          }
      }
      .tint(SIS.ink)
      .preferredColorScheme(.dark)
      .onOpenURL { model.open(url: $0) }
    }
    .onChange(of: phase) { _, now in
      if now == .active { model.core.wake() }
    }
  }
}

enum Route: Hashable {
  case person(String)
  case history
}

/// One person as `search` lists them.
struct Hit: Identifiable, Hashable {
  let id: String
  let name: String
  /// What's under the name: their phone, else email, else company.
  let detail: String
  /// person, company or system; nil when unset (or from an extension that doesn't say).
  let type: String?
  let labels: [String]

  init(_ j: JSON) {
    id = j["id"].str
    name = Pretty.name(j["name"].str)
    let phone = j["phone"].str
    detail = [phone.isEmpty ? "" : Pretty.phone(phone), j["email"].str, j["company"].str].first { !$0.isEmpty } ?? ""
    type = j["type"].string
    labels = j["labels"].array.map(\.str).filter { !$0.isEmpty }
  }
}

/// The app: the core, where the user is, and what changed (moved on each of Contacts' events, so
/// what's on screen reads again).
@MainActor @Observable
final class Model {
  let core = Core(app: "contacts")
  var path: [Route] = []
  /// Moves on every change the extension logs.
  private(set) var changes = 0
  /// The last change made here, for its Undo.
  var done: Done?
  /// Every label anyone's under (from `people`), for the filters and a person's labels.
  var labels: [String] = []

  struct Done: Equatable {
    let text: String
    let batch: String
  }

  init() {
    core.on(
      [
        "contacts.person_created", "contacts.person_updated", "contacts.person_merged", "contacts.person_split",
        "contacts.person_retired", "contacts.undone",
      ]
    ) { [weak self] _, _ in self?.changes += 1 }
    core.start()
    // A page to open at launch (`-open switch-contacts://person/<id>`), as a link would.
    if let link = UserDefaults.standard.string(forKey: "open"), let url = URL(string: link) { open(url: url) }
  }

  /// `switch-contacts://person/<id>`.
  func open(url: URL) {
    let id = url.pathComponents.dropFirst().first ?? ""
    if url.host() == "person", !id.isEmpty { path = [.person(id)] }
    if url.host() == "history" { path = [.history] }
  }

  /// Reads every label anyone's under; an older extension without `people` leaves them be.
  func loadLabels() async {
    guard let r = try? await core.call("people") else { return }
    let all = r["people"].array.flatMap { $0["labels"].array.map(\.str) }.filter { !$0.isEmpty }
    var seen = Set<String>()
    labels = all.filter { seen.insert($0.lowercased()).inserted }.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
  }

  /// Notes a label just added here, so the filters have it before the next read.
  func know(_ label: String) {
    guard !labels.contains(where: { $0.caseInsensitiveCompare(label) == .orderedSame }) else { return }
    labels = (labels + [label]).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
  }

  func undo(_ batch: String) async throws {
    _ = try await core.call("undo", ["batch": .string(batch)])
    if done?.batch == batch { done = nil }
    changes += 1
  }
}
