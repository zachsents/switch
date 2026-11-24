import Photos
import UIKit

/// A photo or video in the library, as the attach sheet shows it.
nonisolated struct Shot: Identifiable, Hashable, Sendable {
  /// Its asset's local identifier.
  let id: String
  let video: Bool
  let duration: TimeInterval
}

/// The latest photos and videos, as far as the user lets the app see them, followed as they change.
@MainActor @Observable
final class Library {
  enum Access { case unknown, full, limited, none }
  private(set) var access: Access
  private(set) var shots: [Shot] = []
  @ObservationIgnored private var watching: Watcher?

  init() { access = Self.access(PHPhotoLibrary.authorizationStatus(for: .readWrite)) }

  private static func access(_ status: PHAuthorizationStatus) -> Access {
    switch status {
    case .authorized: .full
    case .limited: .limited
    case .notDetermined: .unknown
    default: .none
    }
  }

  /// Asks the first time, then reads the latest.
  func start() async {
    if PHPhotoLibrary.authorizationStatus(for: .readWrite) == .notDetermined {
      access = Self.access(await PHPhotoLibrary.requestAuthorization(for: .readWrite))
    }
    guard access == .full || access == .limited else { return }
    fetch()
    if watching == nil {
      let watcher = Watcher { [weak self] in Task { @MainActor in self?.fetch() } }
      PHPhotoLibrary.shared().register(watcher)
      watching = watcher
    }
  }

  func stop() {
    if let watching { PHPhotoLibrary.shared().unregisterChangeObserver(watching) }
    watching = nil
  }

  private func fetch() {
    access = Self.access(PHPhotoLibrary.authorizationStatus(for: .readWrite))
    let options = PHFetchOptions()
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    options.predicate = NSPredicate(
      format: "mediaType == %d || mediaType == %d", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
    options.fetchLimit = 200
    var shots: [Shot] = []
    PHAsset.fetchAssets(with: options).enumerateObjects { asset, _, _ in
      shots.append(Shot(id: asset.localIdentifier, video: asset.mediaType == .video, duration: asset.duration))
    }
    if shots != self.shots { self.shots = shots }
  }

  nonisolated private final class Watcher: NSObject, PHPhotoLibraryChangeObserver, Sendable {
    let changed: @Sendable () -> Void
    init(_ changed: @escaping @Sendable () -> Void) { self.changed = changed }
    func photoLibraryDidChange(_ change: PHChange) { changed() }
  }

  nonisolated private static func asset(_ id: String) -> PHAsset? {
    PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject
  }

  /// A square thumbnail, from iCloud when it isn't on the phone.
  @concurrent nonisolated static func thumbnail(_ id: String, side: CGFloat) async -> UIImage? {
    guard let asset = asset(id) else { return nil }
    let options = PHImageRequestOptions()
    options.deliveryMode = .highQualityFormat
    options.resizeMode = .fast
    options.isNetworkAccessAllowed = true
    return await withCheckedContinuation { done in
      PHImageManager.default().requestImage(
        for: asset, targetSize: CGSize(width: side, height: side), contentMode: .aspectFill, options: options
      ) { image, _ in done.resume(returning: image) }
    }
  }

  /// A photo as a file: JPEG, PNG and GIF as they are, anything else (HEIC) made a JPEG.
  @concurrent nonisolated static func photo(_ id: String) async throws -> URL {
    guard let asset = asset(id) else { throw Blobs.Failed(reason: "Can't read it") }
    let original = PHAssetResource.assetResources(for: asset).first { $0.type == .photo }?.originalFilename ?? "photo.jpg"
    let options = PHImageRequestOptions()
    options.deliveryMode = .highQualityFormat
    options.isNetworkAccessAllowed = true
    options.version = .current
    let data: Data? = await withCheckedContinuation { done in
      PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { data, _, _, _ in
        done.resume(returning: data)
      }
    }
    guard let data else { throw Blobs.Failed(reason: "Can't read it") }
    return try await Files.photo(data, named: original)
  }

  /// A video as the file it was recorded as (its edit, if it has one), never re-encoded.
  @concurrent nonisolated static func video(_ id: String) async throws -> URL {
    guard let asset = asset(id) else { throw Blobs.Failed(reason: "Can't read it") }
    let resources = PHAssetResource.assetResources(for: asset)
    guard let resource = resources.first(where: { $0.type == .fullSizeVideo }) ?? resources.first(where: { $0.type == .video }) else {
      throw Blobs.Failed(reason: "Can't read it")
    }
    let to = try Files.folder().appending(path: resource.originalFilename.isEmpty ? "video.mov" : resource.originalFilename)
    let options = PHAssetResourceRequestOptions()
    options.isNetworkAccessAllowed = true
    try await PHAssetResourceManager.default().writeData(for: resource, toFile: to, options: options)
    return to
  }
}
