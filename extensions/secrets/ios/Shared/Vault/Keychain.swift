import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// This device's private key: in the Keychain, in the group the app shares with its extension (the
/// entitlements' first, so no group is named here), only on this device, and readable only once the
/// user has shown their face (or passcode).
nonisolated enum Keychain {
  static let service = "Switch secrets"
  static let account = "device-key"

  static func save(_ key: Curve25519.KeyAgreement.PrivateKey) throws {
    delete()
    var error: Unmanaged<CFError>?
    guard
      let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .userPresence, &error)
    else { throw Crypto.Failure(message: "Can't protect the key") }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrAccessControl as String: access,
      kSecValueData as String: key.rawRepresentation,
    ]
    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else { throw Crypto.Failure(message: "Can't keep the key (\(status))") }
  }

  /// The key, with a context the user has already authenticated (so there's no second prompt).
  /// `interactive: false` fails rather than asking.
  static func load(_ context: LAContext, interactive: Bool = true) throws -> Curve25519.KeyAgreement.PrivateKey {
    if !interactive { context.interactionNotAllowed = true }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecUseAuthenticationContext as String: context,
    ]
    var out: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &out)
    guard status == errSecSuccess, let data = out as? Data else {
      throw Crypto.Failure(message: status == errSecItemNotFound ? "This iPhone's key is gone" : "Can't open the key (\(status))")
    }
    return try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: data)
  }

  static func delete() {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(query as CFDictionary)
  }
}

/// Face ID (else the passcode), for unlocking and for each reveal and copy.
nonisolated enum Auth {
  /// A context the user has just authenticated, or nil if they didn't.
  static func confirm(_ reason: String) async -> LAContext? {
    let context = LAContext()
    let ok: Bool = await withCheckedContinuation { done in
      context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in done.resume(returning: ok) }
    }
    return ok ? context : nil
  }
}
