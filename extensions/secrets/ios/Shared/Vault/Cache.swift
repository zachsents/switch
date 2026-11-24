import Foundation

/// What this device keeps between launches, in the container it shares with its extension: who it
/// is in the vault, the vault key sealed to it, and every item's blob. Ciphertext only: no title,
/// URL, username or value is ever written here.
nonisolated struct Cache: Codable, Sendable {
  struct Sealed: Codable, Hashable, Sendable {
    let enc: String
    let ct: String
  }

  struct Entry: Codable, Hashable, Sendable {
    var seq: Int
    var blob: String
  }

  /// This device's id in the vault, its public key and the code it showed when it enrolled.
  var device = ""
  var key = ""
  var code = ""
  var vault = ""
  var keyVersion = 0
  var seq = 0
  /// The vault key, sealed to this device, for `keyVersion`.
  var sealed: Sealed?
  var items: [String: Entry] = [:]
  /// The vault's devices, extensions and grants, as sync last said them.
  var devices: JSON = .array([])
  /// Optional: a cache written before extensions were renamed has none, and must still load.
  var extensions: JSON?
  var grants: JSON = .array([])

  static var file: URL { Config.folder.appending(path: "vault.json") }

  static func load() -> Cache {
    guard let data = try? Data(contentsOf: file), let cache = try? JSONDecoder().decode(Cache.self, from: data) else { return Cache() }
    return cache
  }

  func save() {
    guard let data = try? JSONEncoder().encode(self) else { return }
    try? FileManager.default.createDirectory(at: Config.folder, withIntermediateDirectories: true)
    try? data.write(to: Self.file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }
}
