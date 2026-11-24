import Foundation

/// What happened lately in the app, for crash and hang reports: pages opened, commands sent, the
/// app going to the background and back. MetricKit hands a report over on a later launch, so each
/// launch's steps are kept on disk with its process id, and a report finds the launch it was in.
/// A step is noted only when something happens, and written on a background queue.
@MainActor
final class Trail {
  static let shared = Trail()

  nonisolated struct Launch: Codable, Sendable {
    let pid: Int32
    var steps: [String]
    /// What was on screen last: the page and its space.
    var screen: String
  }

  private static let keepSteps = 30
  private static let keepLaunches = 4
  private static let file = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(path: "trail.json")

  private var launch: Launch
  private var earlier: [Launch]
  private let queue = DispatchQueue(label: "trail", qos: .utility)
  private let time: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "HH:mm:ss"
    return f
  }()

  private init() {
    let pid = ProcessInfo.processInfo.processIdentifier
    let kept = (try? Data(contentsOf: Self.file)).flatMap { try? JSONDecoder().decode([Launch].self, from: $0) } ?? []
    earlier = Array(kept.filter { $0.pid != pid }.suffix(Self.keepLaunches - 1))
    launch = Launch(pid: pid, steps: [], screen: "")
    note("launched")
  }

  func note(_ what: String) {
    let step = "\(time.string(from: Date())) \(what)"
    // The same thing again (a page redrawn) is one step.
    if let last = launch.steps.last, last.dropFirst(9) == step.dropFirst(9) { return }
    launch.steps.append(step)
    if launch.steps.count > Self.keepSteps { launch.steps.removeFirst(launch.steps.count - Self.keepSteps) }
    save()
  }

  /// A page came to the front.
  func screen(_ what: String) {
    guard what != launch.screen else { return }
    launch.screen = what
    note("open \(what)")
  }

  /// The launch a report's process was, this one or one before.
  func launch(pid: Int32?) -> Launch? {
    guard let pid else { return nil }
    return pid == launch.pid ? launch : earlier.last { $0.pid == pid }
  }

  private func save() {
    let launches = earlier + [launch]
    let file = Self.file
    queue.async {
      guard let data = try? JSONEncoder().encode(launches) else { return }
      try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? data.write(to: file, options: .atomic)
    }
  }
}
