import AVFoundation
import CoreTransferable
import Foundation
import ImageIO
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// What's attached in the message box, each going up as soon as it's picked: read into a file of its
/// own (a photo as JPEG, a video as recorded) kept where the Outbox keeps a file's bytes, then
/// streamed to the core's blobs.
@MainActor @Observable
final class Tray {
  private(set) var items: [Picked] = []
  /// Told when what's in it changes, to keep it with the box's draft.
  @ObservationIgnored var changed: () -> Void = {}

  var isEmpty: Bool { items.isEmpty }
  /// Any still being read into a file of its own.
  var reading: Bool { items.contains { $0.state == .reading } }
  var failed: Bool { items.contains(where: \.failed) }

  /// Each read, as the Outbox keeps it: up, or its bytes kept here.
  var files: [Outbox.File] { items.compactMap(\.kept) }

  /// The library's assets in the box, in the order picked.
  var assets: [String] { items.compactMap(\.asset) }

  /// Sent: each goes to the Outbox as it is (its bytes stay for it to send), and the tray empties.
  func handOver() -> [Outbox.File] {
    let out = files
    for item in items { item.stop() }
    items = []
    changed()
    return out
  }

  func remove(_ item: Picked) {
    item.drop()
    items.removeAll { $0.id == item.id }
    changed()
  }

  /// What a box's draft kept: those not in it yet come back, going up if they aren't.
  func restore(_ kept: [Outbox.File]) {
    let new = kept.filter { f in !items.contains { $0.id == f.id } }
    guard !new.isEmpty else { return }
    for f in new {
      let item = Picked(kept: f)
      item.done = { [weak self] in self?.changed() }
      items.append(item)
      if let file = item.file, item.kind != .file {
        Task { item.thumbnail = await Files.thumbnail(file, video: item.kind == .video) }
      }
      if f.blob == nil { item.start() }
    }
    changed()
  }

  func retry(_ item: Picked) {
    guard item.failed else { return }
    item.start()
  }

  /// A photo or video from the library: into the box, or out of it again.
  func toggle(asset: String, video: Bool, thumbnail: UIImage?) {
    if let there = items.first(where: { $0.asset == asset }) {
      remove(there)
      return
    }
    let item = Picked(kind: video ? .video : .photo, name: video ? "video.mov" : "photo.jpg", type: video ? "video/quicktime" : "image/jpeg")
    item.asset = asset
    item.thumbnail = thumbnail
    item.read = { video ? try await Library.video(asset) : try await Library.photo(asset) }
    add(item)
  }

  /// What the camera took, already a file of its own.
  func add(taken file: URL, video: Bool) {
    let item = Picked(kind: video ? .video : .photo, name: file.lastPathComponent, type: Files.type(of: file))
    item.read = { file }
    add(item)
  }

  /// A file from Files: copied while its security scope is open.
  func add(file url: URL) {
    let item = Picked(kind: .file, name: url.lastPathComponent, type: Files.type(of: url))
    item.read = { try await Files.copy(url) }
    add(item)
  }

  /// One chosen in the system's photo picker: a video as its file, a photo as JPEG unless it's one.
  func add(chosen: PhotosPickerItem) {
    let video = chosen.supportedContentTypes.contains { $0.conforms(to: .movie) }
    let item = Picked(kind: video ? .video : .photo, name: video ? "video.mov" : "photo.jpg", type: video ? "video/quicktime" : "image/jpeg")
    item.read = {
      if video {
        guard let movie = try await chosen.loadTransferable(type: Movie.self) else { throw Blobs.Failed(reason: "Can't read it") }
        return movie.url
      }
      guard let data = try await chosen.loadTransferable(type: Data.self) else { throw Blobs.Failed(reason: "Can't read it") }
      return try await Files.photo(data)
    }
    add(item)
  }

  private func add(_ item: Picked) {
    item.done = { [weak self] in self?.changed() }
    items.append(item)
    item.start()
  }
}

/// One thing in the box.
@MainActor @Observable
final class Picked: Identifiable {
  enum Kind { case photo, video, file }
  enum State: Equatable {
    case reading, uploading
    case stored(Attachment)
    case failed(String)
  }

  /// Its file's id in the Outbox.
  let id: String
  let kind: Kind
  private(set) var name: String
  private(set) var type: String
  private(set) var size: Int64?
  var thumbnail: UIImage?
  var asset: String?
  private(set) var state = State.reading
  /// The copy it uploads from, where the Outbox keeps its bytes.
  private(set) var file: URL?
  @ObservationIgnored var read: () async throws -> URL = { throw Blobs.Failed(reason: "Can't read it") }
  /// Told when it's read or up.
  @ObservationIgnored var done: () -> Void = {}
  @ObservationIgnored private var work: Task<Void, Never>?

  init(kind: Kind, name: String, type: String) {
    id = UUID().uuidString.lowercased()
    self.kind = kind
    self.name = name
    self.type = type
  }

  /// One a box's draft kept: up already, or its bytes still here.
  init(kept f: Outbox.File) {
    id = f.id
    name = f.name
    type = f.type
    size = Int64(f.size)
    kind = f.type.hasPrefix("video/") ? .video : f.type.hasPrefix("image/") ? .photo : .file
    if let a = f.attachment {
      state = .stored(a)
    } else if FileManager.default.fileExists(atPath: Outbox.bytes(f.id).path) {
      file = Outbox.bytes(f.id)
      state = .uploading
    } else {
      state = .failed("Can't read it")
    }
  }

  var busy: Bool { state == .reading || state == .uploading }
  var failed: Bool { if case .failed = state { true } else { false } }
  var stored: Attachment? { if case .stored(let a) = state { a } else { nil } }

  /// As the Outbox keeps it, once it's read.
  var kept: Outbox.File? {
    guard stored != nil || file != nil else { return nil }
    return Outbox.File(id: id, name: name, type: type, size: Double(size ?? 0), blob: stored?.blob)
  }

  /// Reads it (once) into the Outbox's keeping, then uploads it.
  func start() {
    work?.cancel()
    work = Task {
      do {
        if file == nil {
          state = .reading
          let at = try await read()
          name = at.lastPathComponent
          type = Files.type(of: at, else: type)
          size = (try? at.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init)
          if thumbnail == nil { thumbnail = await Files.thumbnail(at, video: kind == .video) }
          file = try Files.keep(at, as: id)
          done()
        }
        guard let file, !Task.isCancelled else { return }
        state = .uploading
        let stored = try await Blobs.upload(file, name: name, type: type)
        guard !Task.isCancelled else { return }
        state = .stored(stored)
        discard()
        done()
      } catch {
        guard !Task.isCancelled else { return }
        state = .failed(file == nil ? "Can't read it" : (error as? Blobs.Failed)?.reason ?? "Didn't upload")
      }
    }
  }

  /// Sent: stops, its bytes left for the Outbox.
  func stop() {
    work?.cancel()
  }

  /// Out of the box: stops it, and its bytes go.
  func drop() {
    work?.cancel()
    discard()
  }

  private func discard() {
    if let file { try? FileManager.default.removeItem(at: file) }
    file = nil
  }
}

/// Files on their way up: each a copy in a folder of its own, under its own name.
enum Files {
  nonisolated static func folder() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appending(path: "attaching/\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  /// A file read for the box, moved to where the Outbox keeps its bytes under `id`; its own folder goes.
  nonisolated static func keep(_ from: URL, as id: String) throws -> URL {
    let to = Outbox.bytes(id)
    try FileManager.default.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: to)
    try FileManager.default.moveItem(at: from, to: to)
    let folder = from.deletingLastPathComponent()
    if folder.path.contains("/attaching/") { try? FileManager.default.removeItem(at: folder) }
    return to
  }

  nonisolated static func place(_ from: URL, named name: String) throws -> URL {
    let to = try folder().appending(path: name.isEmpty ? "file" : name)
    try FileManager.default.copyItem(at: from, to: to)
    return to
  }

  /// Copies a file picked in Files off the main thread, while its scope is open and its provider has it whole.
  @concurrent nonisolated static func copy(_ url: URL) async throws -> URL {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    var failure: NSError?
    var result: Result<URL, Error> = .failure(Blobs.Failed(reason: "Can't read it"))
    NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &failure) { readable in
      result = Result { try place(readable, named: url.lastPathComponent) }
    }
    if let failure { throw failure }
    return try result.get()
  }

  nonisolated static func type(of url: URL, else fallback: String = "application/octet-stream") -> String {
    let type = (try? url.resourceValues(forKeys: [.contentTypeKey]).contentType) ?? UTType(filenameExtension: url.pathExtension)
    return type?.preferredMIMEType ?? fallback
  }

  /// A photo's or a video's first frame, small, for its chip.
  @concurrent nonisolated static func thumbnail(_ url: URL, video: Bool) async -> UIImage? {
    if video {
      let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
      generator.appliesPreferredTrackTransform = true
      generator.maximumSize = CGSize(width: 160, height: 160)
      guard let frame = try? await generator.image(at: .zero) else { return nil }
      return UIImage(cgImage: frame.image)
    }
    return shrunk(url, to: 160)
  }

  /// An image file drawn at most `side` pixels, turned upright.
  nonisolated static func shrunk(_ url: URL, to side: CGFloat) -> UIImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    return shrunk(source, to: side)
  }

  nonisolated static func shrunk(_ source: CGImageSource, to side: CGFloat) -> UIImage? {
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: side,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
    return UIImage(cgImage: image)
  }

  /// A photo's bytes as a file: JPEG, PNG and GIF as they are, anything else (HEIC) made a JPEG.
  @concurrent nonisolated static func photo(_ data: Data, named name: String = "photo") async throws -> URL {
    let base = (name as NSString).deletingPathExtension.isEmpty ? "photo" : (name as NSString).deletingPathExtension
    if let source = CGImageSourceCreateWithData(data as CFData, nil), let uti = CGImageSourceGetType(source),
      let type = UTType(uti as String), [UTType.jpeg, .png, .gif].contains(type), let ext = type.preferredFilenameExtension
    {
      let to = try folder().appending(path: "\(base).\(ext)")
      try data.write(to: to)
      return to
    }
    return try jpeg(data, named: base)
  }

  /// An image as a JPEG the model can read (HEIC it can't), its orientation and metadata kept.
  nonisolated static func jpeg(_ data: Data, named name: String) throws -> URL {
    let to = try folder().appending(path: "\(name).jpg")
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let out = CGImageDestinationCreateWithURL(to as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
    else { throw Blobs.Failed(reason: "Can't read it") }
    CGImageDestinationAddImageFromSource(out, source, 0, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    guard CGImageDestinationFinalize(out) else { throw Blobs.Failed(reason: "Can't read it") }
    return to
  }
}

/// A video from the photo picker as the file it is, copied out of the picker's, which goes when this returns.
nonisolated struct Movie: Transferable {
  let url: URL

  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(contentType: .movie) { movie in
      SentTransferredFile(movie.url)
    } importing: { received in
      Movie(url: try Files.place(received.file, named: received.file.lastPathComponent))
    }
  }
}
