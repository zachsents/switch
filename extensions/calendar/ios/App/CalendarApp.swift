import SwiftUI

@main
struct CalendarApp: App {
  @Environment(\.scenePhase) private var phase
  @State private var model = Model()

  var body: some Scene {
    WindowGroup {
      NavigationStack(path: $model.path) {
        AgendaView(model: model)
          .navigationDestination(for: Route.self) { route in
            switch route {
            case .event(let id): EventView(model: model, id: id)
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
  case event(String)
}

/// One event as `list` gives it.
struct Item: Identifiable, Hashable {
  let id: String
  let title: String
  let start: Date
  let end: Date
  let allDay: Bool
  let location: String
  let needsYou: Bool

  init?(_ j: JSON) {
    guard let start = Item.time(j["start"].str), let end = Item.time(j["end"].str) else { return nil }
    id = j["id"].str
    title = j["title"].str
    self.start = start
    self.end = end
    allDay = j["allDay"].bool == true
    location = j["location"].str
    needsYou = j["response"].str == "needsAction" && j["organizer"]["self"].bool != true && j["status"].str != "cancelled"
  }

  static func time(_ iso: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
  }
}

/// The app: the core, where the user is, and what changed (moved on each of Calendar's events).
@MainActor @Observable
final class Model {
  let core = Core(app: "calendar")
  var path: [Route] = []
  /// A new event's sheet is up.
  var making = false
  /// The event in front's Move sheet is up.
  var moving = false
  private(set) var changes = 0
  /// The last write made here, for its Undo.
  var done: Done?

  struct Done: Equatable {
    let text: String
    /// The write's id; empty when it's held for the user's approval.
    let write: String
  }

  init() {
    core.on(["calendar.event.created", "calendar.event.changed", "calendar.event.cancelled", "calendar.invite.received"]) { [weak self] _, _ in
      self?.changes += 1
    }
    core.start()
    // A page to open at launch (`-open switch-calendar://event/<id>`), as a link would.
    if let link = UserDefaults.standard.string(forKey: "open"), let url = URL(string: link) { open(url: url) }
  }

  /// `switch-calendar://event/<id>`, `switch-calendar://move/<id>`, `switch-calendar://new`; an id
  /// holds slashes, so it's the rest of the path.
  func open(url: URL) {
    let id = url.path().dropFirst().removingPercentEncoding ?? ""
    switch url.host() {
    case "event" where !id.isEmpty: path = [.event(id)]
    case "move" where !id.isEmpty:
      path = [.event(id)]
      moving = true
    case "new": making = true
    default: break
    }
  }

  /// A write's answer: done (with its Undo), or held until the user approves it.
  func wrote(_ r: JSON, _ text: String) {
    done = r["held"].isNull ? Done(text: text, write: r["write"].str) : Done(text: "Held", write: "")
    changes += 1
  }

  func undo(_ write: String) async throws {
    _ = try await core.call("undo", ["write": .string(write)])
    done = nil
    changes += 1
  }
}

extension Date {
  var ms: JSON { .number((timeIntervalSince1970 * 1000).rounded()) }
}
