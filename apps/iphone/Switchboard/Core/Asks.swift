import CryptoKit
import Foundation

/// What the user does with an action item: answer it, mark it done or dismiss it, reopen a closed
/// one, reply on it, press its assist, or answer a sealed one (packages/autonomy/src/items.ts,
/// packages/core/src/asks.ts).
extension Phone {
  /// The user's own version of an item's drafts kept in the Outbox and not yet taken by the core, the
  /// newest, by draft name.
  func keptEdit(_ id: String) -> [String: String] {
    Outbox.shared.latest("item.edit") { $0["id"].str == id }?.payload["drafts"].object.compactMapValues(\.string) ?? [:]
  }

  /// Its card opened: the core brings each draft's copy (an email draft) and the card to one version.
  func openDrafts(_ id: String) async throws {
    guard let sync else { throw Sync.Rejected(reason: "No core") }
    _ = try await sync.post("items/\(id)/drafts", Data("{}".utf8))
  }

  func reopen(_ id: String) async throws {
    try await command("item.reopen", ["id": .string(id)])
  }

  /// Words on an item, to the work that raised it: a message in its space that names the item.
  func reply(_ item: ActionItem, _ text: String) async throws {
    try await command("message.post", ["space": .string(item.space), "text": .string(text), "item": .string(item.id)])
  }

  /// An assist key: the app's tool, called through the core's widget route.
  func assist(_ a: ActionItem.Assist) async throws {
    guard let sync else { throw Sync.Rejected(reason: "No core") }
    let data = try await sync.post("widgets/\(a.app)/\(a.tool)", a.args.isNull ? Data("{}".utf8) : a.args.data)
    let result = JSON.parse(data) ?? .null
    if result["isError"].bool == true {
      throw Sync.Rejected(reason: result["content"].array.first?["text"].str ?? "Didn't go through")
    }
  }

  /// A sealed answer: sealed here to the item's one-time key; only the sealed bytes leave, to the
  /// core, which hands them to the extension that asked. Nothing of the secret is kept.
  func answerSealed(_ item: ActionItem, _ secret: String) async throws {
    guard let sync else { throw Sync.Rejected(reason: "No core") }
    guard let key = item.sealedKey else { throw Sync.Rejected(reason: "It isn't sealed") }
    let sealed = try Sealing.seal(Data(secret.utf8), to: key, item: item.id, use: item.sealedUse)
    var request = sync.credential.request("items/\(item.id)/sealed")
    request.httpMethod = "POST"
    request.setValue("text/plain", forHTTPHeaderField: "Content-Type")
    request.httpBody = JSON.object(["enc": .string(sealed.enc), "ct": .string(sealed.ct)]).data
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
      let said = String(decoding: data, as: UTF8.self)
      throw Sync.Rejected(reason: said.isEmpty ? "Didn't go through" : said)
    }
  }

  /// A file on an item, fetched with this phone's token: its blob in the core's store, or its link.
  func fileData(_ f: ActionItem.File) async throws -> Data {
    if let blob = f.blob {
      guard let sync else { throw Sync.Rejected(reason: "No core") }
      return try await sync.get("blobs/\(blob)")
    }
    guard let url = f.url.flatMap(URL.init(string:)) else { throw Sync.Rejected(reason: "No file") }
    return try await URLSession.shared.data(from: url).0
  }
}

/// Sealed answers (switch-ext-kit's sealed.ts): HPKE base mode, RFC 9180, single shot, with
/// DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM, an empty aad, and the item's id and use
/// bound in through `info`. The TypeScript side opens what this seals.
nonisolated enum Sealing {
  static let domain = "switch-sealed-v1"
  static let suite = HPKE.Ciphersuite(kem: .Curve25519_HKDF_SHA256, kdf: .HKDF_SHA256, aead: .AES_GCM_256)

  struct Sealed {
    let enc: String
    let ct: String
  }

  /// "switch-sealed-v1", the item's id and the use, NUL-separated.
  static func info(item: String, use: String) -> Data {
    var d = Data(domain.utf8)
    d.append(0)
    d.append(Data(item.utf8))
    d.append(0)
    d.append(Data(use.utf8))
    return d
  }

  static func seal(_ secret: Data, to key: String, item: String, use: String) throws -> Sealed {
    guard let raw = Data(base64Encoded: key) else { throw Sync.Rejected(reason: "Not a key") }
    let recipient = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: raw)
    var sender = try HPKE.Sender(recipientKey: recipient, ciphersuite: suite, info: info(item: item, use: use))
    let ct = try sender.seal(secret)
    return Sealed(enc: sender.encapsulatedKey.base64EncodedString(), ct: ct.base64EncodedString())
  }
}
