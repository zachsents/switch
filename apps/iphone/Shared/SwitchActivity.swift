import Foundation

#if !targetEnvironment(macCatalyst)
  import ActivityKit

  /// A Live Activity the agent started with the `iphone` tools (packages/gateway/src/iphone):
  /// one of three templates, drawn by the Activities extension. The core starts, updates and ends
  /// them with `liveactivity` pushes whose content state is this, keyed alike (times in ms); the
  /// app does the same from the `iphone.activity` events while it's open.
  nonisolated struct SwitchActivity: ActivityAttributes {
    nonisolated struct ContentState: Codable, Hashable {
      var title: String
      var line: String?
      /// 0 to 1.
      var progress: Double?
      var startedAt: Double
      var endsAt: Double?
      /// running, done, failed or needs.
      var state: String

      var started: Date { Date(timeIntervalSince1970: startedAt / 1000) }
      var ends: Date? { endsAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
    }

    var id: String
    /// progress, countdown or status.
    var template: String
    /// Its space's name, and its ink (on paper, and lifted for the dark).
    var space: String
    var spaceId: String?
    var ink: String?
    var night: String?
  }
#endif
