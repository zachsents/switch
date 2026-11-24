import ActivityKit
import Foundation

/// The agent's Live Activities (Shared/SwitchActivity.swift). The core starts, updates and ends
/// them over APNs; while the app is open it does the same from the `iphone.activity` events, so they
/// move without a push too. One per id: a second (the app's and a push's at once) ends. Every
/// activity's push token and the token that starts one go to the core in `iphone.reported`.
@MainActor
final class LiveActivities {
  static let shared = LiveActivities()

  private(set) var startToken: String?
  private(set) var tokens: [String: String] = [:]
  private var following: Set<String> = []
  private weak var phone: Phone?

  func start(_ phone: Phone) {
    self.phone = phone
    Task {
      for await data in Activity<SwitchActivity>.pushToStartTokenUpdates {
        startToken = data.hex
        Push.shared.woke()
      }
    }
    for activity in Activity<SwitchActivity>.activities { follow(activity) }
    Task {
      for await activity in Activity<SwitchActivity>.activityUpdates { follow(activity) }
    }
    phone.brain.watchers.append { [weak self] e in
      guard e.type == "iphone.activity" else { return }
      self?.apply(e.payload, at: e.time)
    }
  }

  private func follow(_ activity: Activity<SwitchActivity>) {
    let id = activity.attributes.id
    let key = activity.id
    guard following.insert(key).inserted else { return }
    Task {
      guard let activity = Self.find(key) else { return }
      for await data in activity.pushTokenUpdates {
        tokens[id] = data.hex
        Push.shared.woke()
      }
    }
    Task {
      guard let activity = Self.find(key) else { return }
      for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
        tokens[id] = nil
        Push.shared.woke()
      }
    }
  }

  nonisolated private static func find(_ key: String) -> Activity<SwitchActivity>? {
    Activity<SwitchActivity>.activities.first { $0.id == key }
  }

  private func live(_ id: String) -> [Activity<SwitchActivity>] {
    Activity<SwitchActivity>.activities.filter {
      $0.attributes.id == id && $0.activityState != .ended && $0.activityState != .dismissed
    }
  }

  /// An `iphone.activity` event, applied here. Old ones (replayed after a long time away) are left to the pushes.
  private func apply(_ p: JSON, at time: Double) {
    guard ActivityAuthorizationInfo().areActivitiesEnabled, Date().timeIntervalSince1970 * 1000 - time < 10 * 60_000 else { return }
    let id = p["id"].str
    let state = SwitchActivity.ContentState(
      title: p["title"].str, line: p["line"].string, progress: p["progress"].number, startedAt: p["startedAt"].number ?? time,
      endsAt: p["endsAt"].number, state: p["state"].string ?? "running")
    let content = ActivityContent(state: state, staleDate: nil)
    var current = live(id)
    // One per id: a second goes at once.
    for extra in current.dropFirst() {
      let key = extra.id
      Task.detached { await Self.find(key)?.end(nil, dismissalPolicy: .immediate) }
    }
    current = Array(current.prefix(1))
    switch p["phase"].str {
    case "start" where current.isEmpty:
      guard let phone else { return }
      let space = p["space"].string ?? HOME
      let station = phone.brain.station(space)
      let attributes = SwitchActivity(
        id: id, template: p["template"].string ?? "status", space: phone.brain.spaces[space]?.name ?? "Home", spaceId: space,
        ink: station.day, night: station.night)
      if let made = (try? Activity.request(attributes: attributes, content: content, pushType: .token))
        ?? (try? Activity.request(attributes: attributes, content: content, pushType: nil))
      {
        follow(made)
      }
    case "end":
      for a in current {
        let key = a.id
        Task.detached { await Self.find(key)?.end(content, dismissalPolicy: .after(.now + 15 * 60)) }
      }
    default:
      for a in current where a.content.state != state {
        let key = a.id
        Task.detached { await Self.find(key)?.update(content) }
      }
    }
  }
}
