import Foundation
import UIKit
import UniformTypeIdentifiers

/// A file on a message (packages/brain/src/attachment.ts): its blob's sha256, name, MIME type and size.
nonisolated struct Attachment: Hashable, Sendable {
  enum Kind { case image, video, audio, model, file }

  let blob: String
  let name: String
  let type: String
  let size: Double
  /// Its bytes on this phone under its name, while it's being sent and has no blob yet.
  var local: URL? = nil

  init(blob: String, name: String, type: String, size: Double, local: URL? = nil) {
    self.local = local
    self.blob = blob
    self.name = name
    self.type = type
    self.size = size
  }

  init?(_ j: JSON) {
    guard let blob = j["blob"].string else { return nil }
    self.init(blob: blob.replacingOccurrences(of: "sha256:", with: ""), name: j["name"].str, type: j["type"].str, size: j["size"].number ?? 0)
  }

  var json: JSON { ["blob": .string(blob), "name": .string(name), "type": .string(type), "size": .number(size)] }

  var ext: String { (name as NSString).pathExtension.lowercased() }

  /// As the core's kindOf says, plus the models it draws here (usdz).
  var kind: Kind {
    if ["stl", "3mf", "glb", "gltf", "obj", "usdz"].contains(ext) || type.hasPrefix("model/") { return .model }
    if type.hasPrefix("image/") { return .image }
    if type.hasPrefix("video/") { return .video }
    if type.hasPrefix("audio/") { return .audio }
    return .file
  }

  /// "2.4 MB".
  var bytes: String { Int64(size).formatted(.byteCount(style: .file)) }

  /// Its name, safe as a file's, with an extension Quick Look and the share sheet go by.
  var fileName: String {
    var out = name.replacingOccurrences(of: "/", with: "-")
    if out.isEmpty { out = "file" }
    if (out as NSString).pathExtension.isEmpty, let e = UTType(mimeType: type)?.preferredFilenameExtension { out += ".\(e)" }
    return out
  }
}

/// The core's blob store over HTTP (packages/core/src/blobs.ts): PUT a file's bytes, GET them back
/// by hash, by range for video. Fetched files are kept in the caches folder under their own names.
enum Blobs {
  struct Failed: LocalizedError {
    let reason: String
    var errorDescription: String? { reason }
  }

  static var credential: Credential? { Phone.shared.sync?.credential }
  static var base: URL? { credential?.core }

  /// The phone's token in the address, since a player or an image can't send a header.
  private static func signed(_ url: URL?) -> URL? {
    guard let url, let token = credential?.token,
      var c = URLComponents(url: url, resolvingAgainstBaseURL: true)
    else { return url }
    c.queryItems = (c.queryItems ?? []) + [URLQueryItem(name: "token", value: token)]
    return c.url
  }

  /// Where a blob fetched once is kept, under its own name: where one sent from here is kept too.
  nonisolated static func held(_ a: Attachment) -> URL {
    URL.cachesDirectory.appending(path: "blobs/\(a.blob.prefix(16))/\(a.fileName)")
  }

  /// Where it's drawn and played from: its bytes here if it was sent from here, else the core.
  static func source(_ a: Attachment) -> URL? {
    if let local = a.local { return local }
    let held = held(a)
    return FileManager.default.fileExists(atPath: held.path) ? held : url(a)
  }

  /// A file sent from here, now `a` in the core's blobs: kept as the blob fetched once would be (a
  /// hard link of its bytes, no copy), so its message draws and opens it without the network.
  nonisolated static func keep(_ file: URL, as a: Attachment) {
    let to = held(a)
    guard !FileManager.default.fileExists(atPath: to.path) else { return }
    try? FileManager.default.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
    if (try? FileManager.default.linkItem(at: file, to: to)) == nil { try? FileManager.default.copyItem(at: file, to: to) }
  }

  /// A file of a message being sent, under its own name (a hard link of its bytes in the Outbox),
  /// so it's drawn, played and opened from here at once; none when its bytes are gone.
  static func sending(_ f: Outbox.File) -> URL? {
    let a = Attachment(blob: "", name: f.name, type: f.type, size: f.size)
    let to = URL.cachesDirectory.appending(path: "blobs/sending-\(f.id)/\(a.fileName)")
    if FileManager.default.fileExists(atPath: to.path) { return to }
    let from = Outbox.bytes(f.id)
    guard FileManager.default.fileExists(atPath: from.path) else { return nil }
    try? FileManager.default.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
    if (try? FileManager.default.linkItem(at: from, to: to)) == nil { try? FileManager.default.copyItem(at: from, to: to) }
    return FileManager.default.fileExists(atPath: to.path) ? to : nil
  }

  /// A sent file's link goes once its message is in.
  nonisolated static func sent(_ id: String) {
    try? FileManager.default.removeItem(at: URL.cachesDirectory.appending(path: "blobs/sending-\(id)"))
  }

  /// Where a blob is served, typed and named.
  static func url(_ a: Attachment) -> URL? {
    guard let base else { return nil }
    var c = URLComponents(url: base.appending(path: "blobs/\(a.blob)"), resolvingAgainstBaseURL: false)
    c?.queryItems = [URLQueryItem(name: "type", value: a.type), URLQueryItem(name: "name", value: a.fileName)]
    return signed(c?.url)
  }

  /// Where a model is served as a viewer draws it: a big STL's light copy, anything else itself.
  static func light(_ a: Attachment) -> URL? {
    guard let base else { return nil }
    var c = URLComponents(url: base.appending(path: "blobs/\(a.blob)/light"), resolvingAgainstBaseURL: false)
    c?.queryItems = [URLQueryItem(name: "type", value: a.type), URLQueryItem(name: "name", value: a.fileName)]
    return signed(c?.url)
  }

  /// A model to draw, as a file under its own name, fetched once: its light copy, a few MB however
  /// big the model is.
  static func model(_ a: Attachment) async throws -> URL {
    if let local = a.local { return local }
    guard let from = light(a) else { throw Failed(reason: "Can't reach the core") }
    return try await file(from, folder: "\(a.blob.prefix(16))-light", name: a.fileName)
  }

  /// A link in a reply: `/blobs/…` against the core, else as it is.
  static func resolve(_ link: String) -> URL? {
    if link.hasPrefix("/") { return signed(base.flatMap { URL(string: link, relativeTo: $0)?.absoluteURL }) }
    return URL(string: link)
  }

  /// Streams a file up from disk; the app keeps running a little if it goes to the background meanwhile.
  static func upload(_ file: URL, name: String, type: String) async throws -> Attachment {
    guard let base else { throw Failed(reason: "Can't reach the core") }
    let background = UIApplication.shared.beginBackgroundTask(withName: "Upload")
    defer { UIApplication.shared.endBackgroundTask(background) }
    var request = credential?.request("blobs") ?? URLRequest(url: base.appending(path: "blobs"))
    request.httpMethod = "PUT"
    request.setValue(type, forHTTPHeaderField: "Content-Type")
    request.timeoutInterval = 600
    let (data, response) = try await URLSession.shared.upload(for: request, fromFile: file)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 413 { throw Failed(reason: "Too big") }
    if status == 507 { throw Failed(reason: "Core's disk is full") }
    let stored = JSON.parse(data) ?? .null
    guard status == 200, let hash = stored["hash"].string else { throw Failed(reason: "Didn't upload") }
    return Attachment(blob: hash, name: name, type: type, size: stored["bytes"].number ?? 0)
  }

  /// A blob as a file under its own name, fetched once.
  static func file(_ a: Attachment) async throws -> URL {
    if let local = a.local { return local }
    guard let from = url(a) else { throw Failed(reason: "Can't reach the core") }
    return try await file(from, folder: String(a.blob.prefix(16)), name: a.fileName)
  }

  /// Any picture or file by URL (a reply's image), kept under `name` with the extension its bytes
  /// call for (`named`).
  static func file(_ from: URL, folder: String, name: String) async throws -> URL {
    let dir = URL.cachesDirectory.appending(path: "blobs/\(folder)")
    let stem = (name as NSString).deletingPathExtension
    let had = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
    if let kept = had.first(where: { $0 == name || ($0 as NSString).deletingPathExtension == stem }) { return dir.appending(path: kept) }
    let (fetched, response) = try await URLSession.shared.download(from: from)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 404 { throw Failed(reason: "Gone") }
    guard status == 200 else { throw Failed(reason: "Didn't download") }
    let head = (try? FileHandle(forReadingFrom: fetched)).flatMap { h in defer { try? h.close() }; return try? h.read(upToCount: 32) } ?? Data()
    let asked = URLComponents(url: from, resolvingAgainstBaseURL: true)?.queryItems?.first { $0.name == "type" }?.value
    let to = dir.appending(path: named(name, ext: sniffed(head) ?? ext(mime: asked) ?? ext(mime: response.mimeType)))
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: to)
    try FileManager.default.moveItem(at: fetched, to: to)
    return to
  }

  /// Extensions that name one type, the first its usual one.
  private static let same: [[String]] = [
    ["jpg", "jpeg", "jpe", "jfif"], ["tiff", "tif"], ["heic", "heif", "heics"],
    // ISO media: which of them a file is, beyond that, is its name's to say.
    ["mp4", "m4v", "mov", "m4a", "3gp", "qt"],
    ["html", "htm"], ["mpg", "mpeg"], ["yaml", "yml"], ["md", "markdown"], ["txt", "text"],
  ]

  /// What a MIME type's file ends in. A generic type says nothing.
  private static func ext(mime: String?) -> String? {
    guard let mime, mime != "application/octet-stream" else { return nil }
    return UTType(mimeType: mime)?.preferredFilenameExtension
  }

  /// What a file's first bytes say it is, when they say.
  private static func sniffed(_ head: Data) -> String? {
    let b = [UInt8](head)
    func at(_ i: Int, _ sig: [UInt8]) -> Bool { b.count >= i + sig.count && Array(b[i..<i + sig.count]) == sig }
    func at(_ i: Int, _ sig: String) -> Bool { at(i, Array(sig.utf8)) }
    if at(0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return "png" }
    if at(0, [0xFF, 0xD8, 0xFF]) { return "jpg" }
    if at(0, "GIF87a") || at(0, "GIF89a") { return "gif" }
    if at(0, "RIFF") && at(8, "WEBP") { return "webp" }
    if at(0, "RIFF") && at(8, "WAVE") { return "wav" }
    if at(0, "%PDF-") { return "pdf" }
    if at(0, [0x49, 0x49, 0x2A, 0x00]) || at(0, [0x4D, 0x4D, 0x00, 0x2A]) { return "tiff" }
    if at(0, [0x1A, 0x45, 0xDF, 0xA3]) { return "webm" }
    if at(0, [0x50, 0x4B, 0x03, 0x04]) { return "zip" }
    if at(4, "ftyp"), b.count >= 12 {
      switch String(decoding: b[8..<12], as: UTF8.self) {
      case "heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1": return "heic"
      case "avif", "avis": return "avif"
      case "qt  ": return "mov"
      case "M4A ": return "m4a"
      default: return "mp4"
      }
    }
    return nil
  }

  /// `name` with the extension its file calls for: kept when it has it already, or another name for
  /// it, or when its bytes are only a zip (a 3MF or a document is one underneath); one that names
  /// another type replaced; else added. With nothing to go on, it stays as it is.
  private static func named(_ name: String, ext: String?) -> String {
    guard let ext = ext?.lowercased() else { return name }
    let had = (name as NSString).pathExtension.lowercased()
    if had.isEmpty { return "\(name).\(ext)" }
    func usual(_ e: String) -> String { same.first { $0.contains(e) }?.first ?? e }
    if usual(had) == usual(ext) || ext == "zip" { return name }
    let typed = UTType(filenameExtension: had)?.isDynamic == false
    return typed ? "\((name as NSString).deletingPathExtension).\(ext)" : "\(name).\(ext)"
  }

  /// A fetched file on the pasteboard: a picture as itself, any other file as its contents under its
  /// type, so it pastes into Messages, Notes or Mail alike.
  @MainActor static func copy(_ file: URL) {
    let type = UTType(filenameExtension: file.pathExtension)
    guard let data = try? Data(contentsOf: file, options: .mappedIfSafe) else { return }
    if let type, type.conforms(to: .image), type != .gif, let image = UIImage(data: data) {
      // Its own bytes under its own type, and the image for apps that take only that.
      var item: [String: Any] = [type.identifier: data]
      if type != .png, let png = image.pngData() { item[UTType.png.identifier] = png }
      UIPasteboard.general.setItems([item])
    } else {
      UIPasteboard.general.setItems([[(type ?? .data).identifier: data]])
    }
  }
}
