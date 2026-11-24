import Foundation

/// What the build gives the app and its extension alike: the app group they share (for the
/// encrypted cache and settings), and the core's address. Never in the source.
nonisolated enum Config {
  static let appGroup = Bundle.main.object(forInfoDictionaryKey: "SecretsAppGroup") as? String ?? ""

  /// Settings both processes read: the core set here, this device's name.
  nonisolated(unsafe) static let defaults = UserDefaults(suiteName: appGroup) ?? .standard

  /// The shared container, else this process's own (a build without the group).
  static var folder: URL {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
      ?? URL.applicationSupportDirectory
  }

  /// The core: a launch argument (`-core ws://…`), else one set in Settings, else the build's.
  static var core: String {
    let set = UserDefaults.standard.string(forKey: "core") ?? defaults.string(forKey: "core")
    if let set, !set.isEmpty { return set }
    return Bundle.main.object(forInfoDictionaryKey: "SwitchCore") as? String ?? ""
  }
}
