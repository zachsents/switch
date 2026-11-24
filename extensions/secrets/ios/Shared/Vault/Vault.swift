import CryptoKit
import Foundation

/// A device or extension of the vault, as sync lists them.
nonisolated struct Member: Identifiable, Hashable, Sendable {
  let id: String
  let name: String
  let kind: String
  /// Its public key: what an approval's proof covers, and what its code is made from.
  let key: String
  let status: String

  init(device j: JSON) {
    id = j["id"].str
    name = j["name"].str
    kind = j["kind"].str
    key = j["key"].str
    status = j["status"].str
  }

  init(extension j: JSON) {
    id = j["name"].str
    name = id
    kind = "extension"
    key = j["key"].str
    status = j["status"].str
  }

  var pending: Bool { status == "pending" }
  var active: Bool { status == "active" }
  /// The code it shows, made here from the key the proof will cover, so a match means that key.
  var code: String { key.isEmpty ? "" : Crypto.code(of: key) }
}

/// One past version of an item (`history`): as it was until `at`.
nonisolated struct Version: Identifiable, Hashable, Sendable {
  let id: Int
  let at: Double
  let item: Item
}

/// The vault on this device: enrolling, syncing blobs, unlocking with Face ID, and every read and
/// write. The vault key and the items opened with it are only in memory, and only while unlocked.
@MainActor @Observable
final class Vault {
  enum Phase: Equatable { case fresh, waiting, locked, open, revoked }

  let core: Core
  private(set) var cache = Cache.load()
  /// Every item, opened: only while unlocked.
  private(set) var items: [Item] = []
  /// What the last sync said went wrong.
  private(set) var problem: String?
  private(set) var syncing = false
  /// The vault no longer knows this device.
  private(set) var revoked = false
  private var keys: Crypto.Keys?
  @ObservationIgnored private var secret: Curve25519.KeyAgreement.PrivateKey?
  @ObservationIgnored private var pendingSync = false

  init(core: Core) {
    self.core = core
  }

  var phase: Phase {
    if cache.device.isEmpty { return .fresh }
    if revoked { return .revoked }
    if cache.sealed == nil { return .waiting }
    return keys == nil ? .locked : .open
  }

  var devices: [Member] { cache.devices.array.map(Member.init(device:)) }
  var extensions: [Member] { (cache.extensions ?? .array([])).array.map(Member.init(extension:)) }

  // MARK: Enrolling

  func enroll(name: String) async throws {
    let secret = Curve25519.KeyAgreement.PrivateKey()
    try Keychain.save(secret)
    let key = secret.publicKey.rawRepresentation.base64EncodedString()
    let r = try await core.call("device_enroll", ["name": .string(name), "kind": "iphone", "key": .string(key)])
    var fresh = Cache()
    fresh.device = r["device"].string ?? r["device"]["id"].str
    fresh.key = key
    fresh.code = r["code"].string ?? Crypto.code(of: key)
    guard !fresh.device.isEmpty else { throw Failure(message: "The vault gave no device") }
    cache = fresh
    cache.save()
  }

  /// Leaves the vault on this device: revoked there while it can prove it, then its key, its
  /// cache and what AutoFill knew gone here.
  func forget() async {
    if let keys, !revoked {
      let proof = Crypto.prove(keys, Crypto.statement("revoke-device", cache.device))
      do {
        _ = try await core.call("device_revoke", ["device": .string(cache.device), "proof": .string(proof)])
      } catch {
        NSLog("Secrets: revoking this device failed: %@", error.localizedDescription)
      }
    }
    lock()
    Keychain.delete()
    cache = Cache()
    cache.save()
    revoked = false
    await Identities.clear()
  }

  // MARK: Sync

  /// Everything changed since the last sync: blobs kept, the vault key when it comes, and, while
  /// unlocked, every item opened again.
  func sync() async {
    guard !cache.device.isEmpty else { return }
    if syncing {
      pendingSync = true
      return
    }
    syncing = true
    defer { syncing = false }
    repeat {
      pendingSync = false
      await syncOnce()
    } while pendingSync
  }

  private func syncOnce() async {
    let since = cache.sealed == nil || cache.vault.isEmpty ? 0 : cache.seq
    let r: JSON
    do {
      var args: JSON = ["device": .string(cache.device), "since": .number(Double(since))]
      if cache.sealed != nil { args = merge(args, ["version": .number(Double(cache.keyVersion))]) }
      r = try await core.call("sync", args)
      problem = nil
    } catch {
      if error.localizedDescription == "Not a device of this vault" {
        revoked = true
        lock()
        return
      }
      // Waiting to be approved isn't a problem to show.
      if cache.sealed != nil { problem = error.localizedDescription }
      return
    }
    var next = cache
    next.vault = r["vault"].string ?? next.vault
    let version = Int(r["keyVersion"].number ?? Double(next.keyVersion))
    let moved = version != next.keyVersion
    next.keyVersion = version
    next.seq = Int(r["seq"].number ?? Double(next.seq))
    if case .object = r["key"], !r["key"]["enc"].str.isEmpty {
      next.sealed = Cache.Sealed(enc: r["key"]["enc"].str, ct: r["key"]["ct"].str)
    }
    // A new key version brings every item again, sealed under it.
    if since == 0 || moved { next.items = [:] }
    for e in r["items"].array {
      let id = e["id"].str
      if e["deleted"].bool == true || e["blob"].str.isEmpty {
        next.items[id] = nil
      } else {
        next.items[id] = Cache.Entry(seq: Int(e["seq"].number ?? 0), blob: e["blob"].str)
      }
    }
    for key in ["devices", "extensions", "grants"] where !r[key].isNull {
      switch key {
      case "devices": next.devices = r[key]
      case "extensions": next.extensions = r[key]
      default: next.grants = r[key]
      }
    }
    cache = next
    cache.save()
    if let secret, keys == nil || keys?.version != cache.keyVersion || moved {
      try? open(secret)
    } else if keys != nil {
      openItems()
    }
  }

  // MARK: Unlocking

  /// Face ID, then the vault key opened from its seal.
  func unlock() async throws {
    guard let context = await Auth.confirm("Unlock") else { throw Failure(message: "Not unlocked") }
    let secret = try Keychain.load(context)
    try open(secret)
    self.secret = secret
  }

  private func open(_ secret: Curve25519.KeyAgreement.PrivateKey) throws {
    guard let sealed = cache.sealed else { throw Failure(message: "Not approved yet") }
    let text = try Crypto.open(
      sealed.enc, sealed.ct, with: secret, item: "device:\(cache.device)", use: "vault-key:\(cache.vault):\(cache.keyVersion)")
    guard let raw = Data(base64Encoded: text), raw.count == 32 else { throw Failure(message: "The vault key didn't read") }
    keys = Crypto.Keys(vault: cache.vault, version: cache.keyVersion, raw: raw)
    openItems()
  }

  private func openItems() {
    guard let keys else { return }
    items = cache.items.compactMap { id, entry in
      (try? Crypto.openItem(keys, id: id, blob: entry.blob)).flatMap(Item.from)
    }
    .sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    Task { await Identities.replace(items) }
  }

  func lock() {
    keys = nil
    secret = nil
    items = []
  }

  func item(_ id: String) -> Item? { items.first { $0.id == id } }

  // MARK: Writing

  /// Seals the whole item and puts it.
  func put(_ item: Item) async throws {
    guard let keys else { throw Failure(message: "Locked") }
    var item = item
    item.updated = Date().timeIntervalSince1970 * 1000
    let blob = try Crypto.sealItem(keys, id: item.id, json: item.json)
    let r = try await core.call("put", ["device": .string(cache.device), "id": .string(item.id), "blob": .string(blob)])
    cache.items[item.id] = Cache.Entry(seq: Int(r["seq"].number ?? 0), blob: blob)
    cache.save()
    if let at = items.firstIndex(where: { $0.id == item.id }) { items[at] = item } else { items.append(item) }
    await sync()
  }

  /// Every version it was before, newest first.
  func history(_ id: String) async throws -> [Version] {
    guard let keys else { throw Failure(message: "Locked") }
    let r = try await core.call("history", ["device": .string(cache.device), "id": .string(id)])
    return r["history"].array.enumerated().compactMap { n, row in
      guard let json = try? Crypto.openItem(keys, id: id, blob: row["blob"].str), let item = Item.from(json) else { return nil }
      return Version(id: n, at: row["at"].number ?? item.updated, item: item)
    }
    .sorted { $0.at > $1.at }
  }

  /// To the trash, or back: the item sealed again with when it was trashed.
  func trash(_ item: Item, _ on: Bool) async throws {
    var item = item
    item.trashed = on ? Date().timeIntervalSince1970 * 1000 : 0
    try await put(item)
  }

  /// Gone, with its history: that takes a proof.
  func purge(_ id: String) async throws {
    guard let keys else { throw Failure(message: "Locked") }
    let proof = Crypto.prove(keys, Crypto.statement("purge", id))
    _ = try await core.call("remove", ["device": .string(cache.device), "id": .string(id), "proof": .string(proof)])
    items.removeAll { $0.id == id }
    await sync()
  }

  // MARK: Devices and extensions

  func approve(_ member: Member) async throws {
    guard let keys else { throw Failure(message: "Locked") }
    guard !member.key.isEmpty else { throw Failure(message: "The vault sent no key for \(member.name)") }
    if member.kind == "extension" {
      let proof = Crypto.prove(keys, Crypto.statement("approve-extension", member.id, member.key))
      _ = try await core.call("extension_approve", ["extension": .string(member.id), "proof": .string(proof)])
    } else {
      let proof = Crypto.prove(keys, Crypto.statement("approve-device", member.id, member.key))
      _ = try await core.call("device_approve", ["device": .string(member.id), "proof": .string(proof)])
    }
    await sync()
  }

  func revoke(_ member: Member) async throws {
    guard let keys else { throw Failure(message: "Locked") }
    if member.kind == "extension" {
      let proof = Crypto.prove(keys, Crypto.statement("revoke-extension", member.id))
      _ = try await core.call("extension_revoke", ["extension": .string(member.id), "proof": .string(proof)])
    } else {
      let proof = Crypto.prove(keys, Crypto.statement("revoke-device", member.id))
      _ = try await core.call("device_revoke", ["device": .string(member.id), "proof": .string(proof)])
    }
    await sync()
  }

  /// What the user did with a secret here, for the audit: best effort.
  func used(_ item: Item, _ field: String, _ use: String) {
    let args: JSON = ["device": .string(cache.device), "item": .string(item.id), "field": .string(field), "use": .string(use)]
    Task { _ = try? await core.call("used", args) }
  }

  private func merge(_ a: JSON, _ b: JSON) -> JSON {
    .object(a.object.merging(b.object) { _, new in new })
  }
}
