import Foundation
import Security

/// Where the core is and the token it gave this phone when its pairing was approved. Kept in the
/// Keychain, readable by this app once the phone has been unlocked after a restart.
nonisolated struct Credential: Codable, Equatable, Sendable {
  /// The core's HTTP root, `http://host:4871`.
  let core: URL
  let token: String

  private static let service = "Switch"
  private static let account = "core"

  static func load() -> Credential? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
      kSecReturnData as String: true,
    ]
    var found: AnyObject?
    guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data else { return nil }
    return try? JSONDecoder().decode(Credential.self, from: data)
  }

  /// Changed in place, so there's never a moment without one.
  func save() {
    guard let data = try? JSONEncoder().encode(self) else { return }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Credential.service,
      kSecAttrAccount as String: Credential.account,
    ]
    let change: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock]
    guard SecItemUpdate(query as CFDictionary, change as CFDictionary) == errSecItemNotFound else { return }
    SecItemAdd(query.merging(change) { _, new in new } as CFDictionary, nil)
  }

  static func forget() {
    SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account] as CFDictionary)
  }

  /// A request to the core, with this phone's token.
  /// A request for one of the core's routes; a path may end in its query (`widgets/a/b?input=…`).
  func request(_ path: String) -> URLRequest {
    let parts = path.split(separator: "?", maxSplits: 1)
    var url = core.appending(path: String(parts.first ?? ""))
    if parts.count > 1, var c = URLComponents(url: url, resolvingAgainstBaseURL: false) {
      c.percentEncodedQuery = String(parts[1])
      url = c.url ?? url
    }
    var r = URLRequest(url: url)
    r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    r.cachePolicy = .reloadIgnoringLocalCacheData
    return r
  }

  /// The core's HTTP root from what was typed or given: `host`, `host:port`, or a URL (a `ws://`
  /// one too, as older builds were given). Plain HTTP on port 4871 unless it says otherwise.
  static func coreURL(_ said: String) -> URL? {
    let said = said.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !said.isEmpty else { return nil }
    let full = said.contains("://") ? said : "http://\(said)"
    guard var parts = URLComponents(string: full), let host = parts.host, !host.isEmpty else { return nil }
    switch parts.scheme {
    case "ws": parts.scheme = "http"
    case "wss": parts.scheme = "https"
    case "http", "https": break
    default: return nil
    }
    if parts.port == nil && parts.scheme == "http" { parts.port = 4871 }
    parts.path = ""
    parts.query = nil
    parts.fragment = nil
    return parts.url
  }

  /// Where an older build was told the core is (a setting, the `-core` launch argument, or the
  /// build's SwitchCore), for moving it over to a paired credential once.
  static var legacy: URL? {
    let given = UserDefaults.standard.string(forKey: "core") ?? (Bundle.main.object(forInfoDictionaryKey: "SwitchCore") as? String)
    return given.flatMap(coreURL)
  }
}

/// Getting a credential from the core: by a code the user approves on a Mac, or by a pairing
/// link's offer (`switchboard://pair?core=…&offer=…`, a Mac's QR code).
nonisolated enum Pairing {
  struct Started: Sendable {
    let pairing: String
    let token: String
    let code: String
  }

  enum Status: String, Sendable { case waiting, approved, denied, gone }

  struct Failed: LocalizedError {
    let reason: String
    var errorDescription: String? { reason }
  }

  private static func post(_ url: URL, _ body: JSON) async throws -> (JSON, Int) {
    var r = URLRequest(url: url)
    r.httpMethod = "POST"
    r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.httpBody = body.data
    r.timeoutInterval = 15
    let (data, response) = try await URLSession.shared.data(for: r)
    return (JSON.parse(data) ?? .null, (response as? HTTPURLResponse)?.statusCode ?? 0)
  }

  /// This phone, by an id of its own kept in the Keychain (made once, it outlasts a reinstall): pairing
  /// again under it replaces the phone's last credential.
  static var device: String {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "Switch", kSecAttrAccount as String: "device",
    ]
    var found: AnyObject?
    if SecItemCopyMatching(query.merging([kSecReturnData as String: true]) { _, new in new } as CFDictionary, &found) == errSecSuccess,
      let data = found as? Data, let id = String(data: data, encoding: .utf8), !id.isEmpty
    {
      return id
    }
    let id = UUID().uuidString
    let change: [String: Any] = [kSecValueData as String: Data(id.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock]
    SecItemAdd(query.merging(change) { _, new in new } as CFDictionary, nil)
    return id
  }

  static func start(_ core: URL, name: String) async throws -> Started {
    let (body, status) = try await post(
      core.appending(path: "pair"),
      ["name": .string(name), "kind": "device", "scopes": ["client"], "device": .string(device)])
    guard status == 200, let pairing = body["pairing"].string, let token = body["token"].string, let code = body["code"].string else {
      throw Failed(reason: "Core refused")
    }
    return Started(pairing: pairing, token: token, code: code)
  }

  /// Where a pairing stands; nil when the core can't be reached (ask again).
  static func status(_ core: URL, _ started: Started) async -> Status? {
    let credential = Credential(core: core, token: started.token)
    var r = credential.request("pair/\(started.pairing)")
    r.timeoutInterval = 10
    guard let (data, response) = try? await URLSession.shared.data(for: r) else { return nil }
    if (response as? HTTPURLResponse)?.statusCode == 404 { return .gone }
    return JSON.parse(data).flatMap { Status(rawValue: $0["status"].str) }
  }

  static func redeem(_ core: URL, offer: String, name: String) async throws -> Credential {
    let (body, status) = try await post(
      core.appending(path: "pair/redeem"), ["offer": .string(offer), "name": .string(name), "device": .string(device)])
    if status == 404 { throw Failed(reason: "Code expired") }
    guard status == 200, let token = body["token"].string else { throw Failed(reason: "Core refused") }
    return Credential(core: core, token: token)
  }
}
