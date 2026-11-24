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

  init(blob: String, name: String, type: String, size: Double) {
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
    guard let from = url(a) else { throw Failed(reason: "Can't reach the core") }
    return try await file(from, folder: String(a.blob.prefix(16)), name: a.fileName)
  }

  /// Any picture or file by URL (a reply's image), kept under `name`.
  static func file(_ from: URL, folder: String, name: String) async throws -> URL {
    let dir = URL.cachesDirectory.appending(path: "blobs/\(folder)")
    let to = dir.appending(path: name)
    if FileManager.default.fileExists(atPath: to.path) { return to }
    let (fetched, response) = try await URLSession.shared.download(from: from)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 404 { throw Failed(reason: "Gone") }
    guard status == 200 else { throw Failed(reason: "Didn't download") }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: to)
    try FileManager.default.moveItem(at: fetched, to: to)
    return to
  }
}
