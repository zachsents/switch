import Foundation
import Security

/// The token the core gave this app when its pairing was approved: in the Keychain group the app
/// shares with its extension, so both send it (`Authorization: Bearer`, or `?token=` on the socket).
nonisolated enum CoreToken {
  private static let service = "Switch secrets"
  private static let account = "core-token"

  static func load() -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
      kSecReturnData as String: true,
    ]
    var found: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func save(_ token: String) {
    delete()
    let item: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, kSecValueData as String: Data(token.utf8),
    ]
    SecItemAdd(item as CFDictionary, nil)
  }

  static func delete() {
    SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account] as CFDictionary)
  }
}

extension Core {
  /// Pairs with the core when there's no token yet: `POST /pair` for a code the user approves on a
  /// Mac (`pairCode` shows it meanwhile), polled until it's settled; an expired code is replaced.
  /// A core without pairing, or a refusal, ends it quietly: calls go without a token.
  func pair(name: String) async {
    guard token == nil, let http else { return }
    while !Task.isCancelled {
      var r = URLRequest(url: http.appending(path: "pair"))
      r.httpMethod = "POST"
      r.setValue("application/json", forHTTPHeaderField: "Content-Type")
      r.httpBody = (["name": .string(name), "kind": "device", "scopes": ["client"]] as JSON).data
      r.timeoutInterval = 15
      guard let (data, response) = try? await URLSession.shared.data(for: r) else {
        try? await Task.sleep(for: .seconds(30))
        continue
      }
      let body = JSON.parse(data) ?? .null
      guard (response as? HTTPURLResponse)?.statusCode == 200, let id = body["pairing"].string, let token = body["token"].string else {
        return
      }
      pairCode = body["code"].string
      var status = "waiting"
      while !Task.isCancelled && status == "waiting" {
        var poll = URLRequest(url: http.appending(path: "pair/\(id)"))
        poll.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        poll.cachePolicy = .reloadIgnoringLocalCacheData
        poll.timeoutInterval = 10
        if let (data, response) = try? await URLSession.shared.data(for: poll) {
          status = (response as? HTTPURLResponse)?.statusCode == 404 ? "gone" : JSON.parse(data)?["status"].string ?? "waiting"
        }
        if status == "waiting" { try? await Task.sleep(for: .seconds(2)) }
      }
      pairCode = nil
      switch status {
      case "approved":
        CoreToken.save(token)
        self.token = token
        reconnect()
        return
      case "denied":
        return
      default:
        continue
      }
    }
  }
}
