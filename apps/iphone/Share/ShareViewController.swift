import ImageIO
import UIKit
import UniformTypeIdentifiers

/// Switchboard in the share sheet: what's shared (photos, videos, files) goes up to the core's blobs
/// and into the draft on the Mac the user is at (the core's draft.ts), with the app's own pairing
/// (Credential.swift, in the Keychain group they share). One tap: it goes as it opens, and closes
/// once it's in.
final class ShareViewController: UIViewController {
  private let spinner = UIActivityIndicatorView(style: .large)
  private let said = UILabel()

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    overrideUserInterfaceStyle = .dark
    spinner.color = .white
    spinner.translatesAutoresizingMaskIntoConstraints = false
    said.textColor = .white
    said.font = .preferredFont(forTextStyle: .headline)
    said.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(spinner)
    view.addSubview(said)
    NSLayoutConstraint.activate([
      spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor), spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      said.centerXAnchor.constraint(equalTo: view.centerXAnchor), said.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])
    spinner.startAnimating()
    let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
    Task { await send(providers) }
  }

  private func send(_ providers: [NSItemProvider]) async {
    do {
      guard let credential = Credential.load() else { throw Shared.Failed(reason: "Not paired") }
      var shared: [Shared.File] = []
      for (n, p) in providers.enumerated() { shared.append(try await Shared.file(p, n)) }
      defer { for f in shared { try? FileManager.default.removeItem(at: f.url.deletingLastPathComponent()) } }
      let files = try await Shared.upload(shared, credential)
      guard !files.isEmpty else { throw Shared.Failed(reason: "Nothing to send") }
      try await Shared.draft(files, credential)
      extensionContext?.completeRequest(returningItems: nil)
    } catch {
      spinner.stopAnimating()
      said.text = (error as? Shared.Failed)?.reason ?? "Can't reach the core"
      try? await Task.sleep(for: .seconds(1.5))
      extensionContext?.cancelRequest(withError: error)
    }
  }
}

nonisolated enum Shared {
  struct Failed: LocalizedError {
    let reason: String
    var errorDescription: String? { reason }
  }

  struct File: Sendable {
    let url: URL
    let name: String
    let type: String
  }

  /// A shared item as a file of its own here: a video or file as it is, a photo too when it's a
  /// JPEG, PNG or GIF, any other picture (HEIC) made a JPEG, as the app sends photos.
  /// On the main actor, where the share sheet's providers are.
  @MainActor static func file(_ p: NSItemProvider, _ n: Int) async throws -> File {
    let kinds: [UTType] = [.movie, .image, .data]
    guard let kind = kinds.first(where: { p.hasItemConformingToTypeIdentifier($0.identifier) }),
      let id = p.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: kind) == true })
    else { throw Failed(reason: "Can't read it") }
    let dir = FileManager.default.temporaryDirectory.appending(path: "share-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let given = UTType(id)
    let fallback = kind == .image ? "photo" : kind == .movie ? "video" : "file"
    let stem = p.suggestedName.flatMap { ($0 as NSString).deletingPathExtension }.flatMap { $0.isEmpty ? nil : $0 } ?? "\(fallback)\(n == 0 ? "" : "-\(n + 1)")"
    let url: URL = try await withCheckedThrowingContinuation { done in
      _ = p.loadFileRepresentation(forTypeIdentifier: id) { from, error in
        guard let from else { return done.resume(throwing: error ?? Failed(reason: "Can't read it")) }
        // The provider's file goes when this returns.
        let ext = from.pathExtension.isEmpty ? (given?.preferredFilenameExtension ?? "") : from.pathExtension
        let to = dir.appending(path: ext.isEmpty ? stem : "\(stem).\(ext)")
        do {
          try FileManager.default.copyItem(at: from, to: to)
          done.resume(returning: to)
        } catch {
          done.resume(throwing: error)
        }
      }
    }
    if kind == .image, let t = given, ![UTType.jpeg, .png, .gif].contains(where: { t.conforms(to: $0) }) {
      let to = dir.appending(path: "\(stem).jpg")
      if let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let out = CGImageDestinationCreateWithURL(to as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
      {
        CGImageDestinationAddImageFromSource(out, source, 0, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        if CGImageDestinationFinalize(out) { return File(url: to, name: to.lastPathComponent, type: "image/jpeg") }
      }
    }
    let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? given?.preferredMIMEType ?? "application/octet-stream"
    return File(url: url, name: url.lastPathComponent, type: type)
  }

  /// The files up to the core's blobs at once, as attachments in the order shared.
  @concurrent static func upload(_ files: [File], _ credential: Credential) async throws -> [JSON] {
    try await withThrowingTaskGroup(of: (Int, JSON).self) { group in
      for (n, f) in files.enumerated() {
        group.addTask { (n, try await upload(f, credential)) }
      }
      var out: [(Int, JSON)] = []
      for try await f in group { out.append(f) }
      return out.sorted { $0.0 < $1.0 }.map(\.1)
    }
  }

  /// Streams it up to the core's blobs: the attachment it is there.
  static func upload(_ f: File, _ c: Credential) async throws -> JSON {
    var r = c.request("blobs")
    r.httpMethod = "PUT"
    r.setValue(f.type, forHTTPHeaderField: "Content-Type")
    r.timeoutInterval = 600
    let (data, response) = try await URLSession.shared.upload(for: r, fromFile: f.url)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 413 { throw Failed(reason: "Too big") }
    if status == 507 { throw Failed(reason: "Core's disk is full") }
    let stored = JSON.parse(data) ?? .null
    guard status == 200, let hash = stored["hash"].string else { throw Failed(reason: "Didn't upload") }
    return ["blob": .string(hash.replacingOccurrences(of: "sha256:", with: "")), "name": .string(f.name), "type": .string(f.type), "size": .number(stored["bytes"].number ?? 0)]
  }

  /// Into the draft on the Mac the user is at.
  static func draft(_ files: [JSON], _ c: Credential) async throws {
    var r = c.request("draft/files")
    r.httpMethod = "POST"
    r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.httpBody = JSON.object(["files": .array(files)]).data
    r.timeoutInterval = 30
    let (_, response) = try await URLSession.shared.data(for: r)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw Failed(reason: "Didn't go through") }
  }
}
