import CryptoKit
import Foundation

/// The vault's cryptography, as the extension's README and src/crypto.ts say it, byte for byte: the
/// vault key's subkeys (HKDF-SHA256, empty salt), items sealed with AES-256-GCM bound to the vault,
/// the item and the key version, proofs (HMAC-SHA256 under the approval key), and switch-ext-kit's
/// HPKE for what's sealed to this device's key.
nonisolated enum Crypto {
  struct Failure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
  }

  /// What the vault key opens: items, and proofs. Only in memory, only while unlocked.
  struct Keys: Sendable {
    let vault: String
    let version: Int
    let items: SymmetricKey
    let approve: SymmetricKey

    init(vault: String, version: Int, raw: Data) {
      self.vault = vault
      self.version = version
      let base = SymmetricKey(data: raw)
      items = Crypto.derive(base, "items")
      approve = Crypto.derive(base, "approve")
    }
  }

  static func derive(_ base: SymmetricKey, _ purpose: String) -> SymmetricKey {
    HKDF<SHA256>.deriveKey(inputKeyMaterial: base, salt: Data(), info: Data("switch-secrets-v1 \(purpose)".utf8), outputByteCount: 32)
  }

  /// NUL-joined words: what's bound into a seal or signed by a proof.
  static func statement(_ words: String...) -> String { words.joined(separator: "\0") }

  private static func aad(_ keys: Keys, _ id: String) -> Data {
    Data(statement("switch-secrets-v1", keys.vault, id, String(keys.version)).utf8)
  }

  /// An item's JSON, sealed under the item key, bound to its id: base64(nonce ‖ ct ‖ tag).
  static func sealItem(_ keys: Keys, id: String, json: String) throws -> String {
    let box = try AES.GCM.seal(Data(json.utf8), using: keys.items, nonce: AES.GCM.Nonce(), authenticating: aad(keys, id))
    guard let combined = box.combined else { throw Failure(message: "Can't seal") }
    return combined.base64EncodedString()
  }

  /// An item's JSON from its blob; throws if it isn't this item's under this key.
  static func openItem(_ keys: Keys, id: String, blob: String) throws -> String {
    guard let bytes = Data(base64Encoded: blob), bytes.count > 28 else { throw Failure(message: "A blob didn't read") }
    let box = try AES.GCM.SealedBox(combined: bytes)
    return String(decoding: try AES.GCM.open(box, using: keys.items, authenticating: aad(keys, id)), as: UTF8.self)
  }

  /// A proof over a statement, as an enrolled device makes it.
  static func prove(_ keys: Keys, _ words: String) -> String {
    Data(HMAC<SHA256>.authenticationCode(for: Data(words.utf8), using: keys.approve)).base64EncodedString()
  }

  // MARK: Sealing (switch-ext-kit's sealed.ts)

  static let sealedDomain = "switch-sealed-v1"
  /// DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM.
  static let suite = HPKE.Ciphersuite(kem: .Curve25519_HKDF_SHA256, kdf: .HKDF_SHA256, aead: .AES_GCM_256)

  static func sealedInfo(item: String, use: String) -> Data {
    var info = Data(sealedDomain.utf8)
    info.append(0)
    info.append(Data(item.utf8))
    info.append(0)
    info.append(Data(use.utf8))
    return info
  }

  /// A secret sealed to `key` (base64 raw X25519), bound to its item and use: base64 enc and ct.
  static func seal(_ secret: String, to key: String, item: String, use: String) throws -> (enc: String, ct: String) {
    guard let raw = Data(base64Encoded: key) else { throw Failure(message: "A key didn't read") }
    let recipient = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: raw)
    var sender = try HPKE.Sender(recipientKey: recipient, ciphersuite: suite, info: sealedInfo(item: item, use: use))
    let ct = try sender.seal(Data(secret.utf8), authenticating: Data())
    return (sender.encapsulatedKey.base64EncodedString(), ct.base64EncodedString())
  }

  /// Opens what was sealed to this device for exactly this item and use.
  static func open(_ enc: String, _ ct: String, with secret: Curve25519.KeyAgreement.PrivateKey, item: String, use: String) throws -> String {
    guard let encBytes = Data(base64Encoded: enc), let ctBytes = Data(base64Encoded: ct) else { throw Failure(message: "A seal didn't read") }
    var recipient = try HPKE.Recipient(privateKey: secret, ciphersuite: suite, info: sealedInfo(item: item, use: use), encapsulatedKey: encBytes)
    return String(decoding: try recipient.open(ctBytes, authenticating: Data()), as: UTF8.self)
  }

  /// The 6 digits a device or extension shows for its key, to match on the approving screen.
  static func code(of key: String) -> String {
    let hash = Array(SHA256.hash(data: Data(base64Encoded: key) ?? Data()))
    let n = (Int(hash[0]) * 65_536 + Int(hash[1]) * 256 + Int(hash[2])) % 1_000_000
    return String(format: "%06d", n)
  }
}
