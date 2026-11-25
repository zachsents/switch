import AVFoundation
import AVKit
import QuickLook
import SwiftUI

/// What's attached to something said: pictures and videos as a gallery (a lone picture as itself), videos and sound
/// playing in place, 3D models to turn, other files by name and size. A tap opens one in Quick Look; a long press offers Quick Look
/// and Share (the share sheet: Save Image, Save to Files, AirDrop).
struct Attached: View {
  let attachments: [Attachment]
  /// The user's, on the right.
  let right: Bool
  /// Kept off the far side, as in a conversation.
  var inset = true

  var body: some View {
    let media = attachments.filter { $0.kind == .image || $0.kind == .video }
    let row = media.count > 1 || media.contains { $0.kind == .video }
    let rest = row ? attachments.filter { $0.kind != .image && $0.kind != .video } : attachments
    VStack(alignment: right ? .trailing : .leading, spacing: 8) {
      if row {
        Gallery(pictures: media.map { Picture(attachment: $0) }, right: right)
      }
      ForEach(Array(rest.enumerated()), id: \.offset) { _, a in
        switch a.kind {
        case .image: BlobImage(attachment: a).modifier(Opens(attachment: a))
        case .video: VideoTile(attachment: a, height: Gallery.tall)
        case .audio: BlobAudio(attachment: a).modifier(Opens(attachment: a, taps: false))
        case .model: ModelView(attachment: a)
        case .file: BlobFile(attachment: a).modifier(Opens(attachment: a))
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: right ? .trailing : .leading)
    .padding(right ? .leading : .trailing, inset ? (right ? 52 : 36) : 0)
  }
}

/// Drawn in chat at most this wide or tall.
let mediaSide: CGFloat = 260

/// The rule round a picture on its own in a conversation's line.
extension View {
  @ViewBuilder func framed(_ on: Bool = true) -> some View {
    if on {
      clipShape(RoundedRectangle(cornerRadius: SIS.radius))
        .overlay(RoundedRectangle(cornerRadius: SIS.radius).strokeBorder(SIS.rule, lineWidth: SIS.line))
    } else {
      self
    }
  }
}

/// A size fitted into a square of `mediaSide`.
func fitted(_ size: CGSize) -> CGSize {
  let (w, h) = (max(size.width, 1), max(size.height, 1))
  return w >= h ? CGSize(width: mediaSide, height: mediaSide * h / w) : CGSize(width: mediaSide * w / h, height: mediaSide)
}

/// Pictures drawn once per blob and screen scale, and videos' first frames and shapes, so one drawn
/// again (a message once it's in, in place of its bubble while it was sent) shows at once.
enum Drawn {
  nonisolated(unsafe) fileprivate static let pictures = NSCache<NSString, UIImage>()
  nonisolated(unsafe) fileprivate static let frames = NSCache<NSString, Frame>()

  final class Frame {
    let still: UIImage
    let size: CGSize
    init(still: UIImage, size: CGSize) {
      self.still = still
      self.size = size
    }
  }

  /// What an attachment is drawn under: its blob, or its bytes here while it's being sent.
  static func key(_ a: Attachment) -> String { a.local?.path ?? a.blob }

  static func picture(_ key: String, _ scale: CGFloat) -> UIImage? { pictures.object(forKey: "\(key) \(scale)" as NSString) }

  static func frame(_ key: String) -> Frame? { frames.object(forKey: key as NSString) }

  /// What was drawn under `from` (a file being sent) is what `blob` draws, now that it's up.
  static func same(_ from: String, as blob: String) {
    for scale in [1.0, 2.0, 3.0] {
      if let p = picture(from, scale) { pictures.setObject(p, forKey: "\(blob) \(scale)" as NSString) }
    }
    if let f = frame(from) { frames.setObject(f, forKey: blob as NSString) }
  }

  /// A picture file drawn now under `key`, at this screen's scale, for a message to show at once.
  static func warm(_ file: URL, as key: String) async {
    let scale = UITraitCollection.current.displayScale
    guard picture(key, scale) == nil, let made = await shrunk(file, to: mediaSide * scale) else { return }
    pictures.setObject(made, forKey: "\(key) \(scale)" as NSString)
  }

  @concurrent nonisolated fileprivate static func shrunk(_ file: URL, to side: CGFloat) async -> UIImage? {
    Files.shrunk(file, to: side)
  }
}

/// A picture by URL (a blob, or a reply's image), drawn small enough for chat.
struct RemoteImage: View {
  let url: URL?
  /// What it's kept under once drawn, when not its URL: an attachment's blob.
  var key: String? = nil
  /// Drawn at this height and its own width (a gallery's), not fitted in a square.
  var height: CGFloat? = nil
  /// Without the rule round it: edge to edge in a widget's cell.
  var bare = false
  @State private var image: UIImage?
  @State private var failed = false
  @Environment(\.displayScale) private var scale

  var body: some View {
    // Drawn before under its key (its bubble while it was sent): at once, not after a load.
    let shown = image ?? Drawn.picture(key ?? url?.absoluteString ?? "", scale)
    Group {
      if let image = shown, let height {
        let wide = min(height * image.size.width / max(image.size.height, 1), mediaSide * 1.6)
        Image(uiImage: image).resizable().scaledToFill().frame(width: wide, height: height).clipped().framed(!bare)
      } else if let image = shown {
        let size = fitted(image.size)
        Image(uiImage: image).resizable().scaledToFit().frame(width: size.width, height: size.height).framed()
      } else {
        Group {
          if failed { Image(systemName: "photo").foregroundStyle(SIS.ink3) } else { ProgressView() }
        }
        .frame(width: height ?? 72, height: height ?? 72)
        .background(SIS.wash)
        .framed(!bare)
      }
    }
    .task(id: url) {
      guard let url else {
        failed = true
        return
      }
      let key = "\(key ?? url.absoluteString) \(scale)" as NSString
      if let made = Drawn.pictures.object(forKey: key) {
        image = made
        return
      }
      // One sent from here is read from its bytes on this phone.
      if url.isFileURL {
        guard let made = await Drawn.shrunk(url, to: mediaSide * scale) else {
          failed = true
          return
        }
        Drawn.pictures.setObject(made, forKey: key)
        image = made
        return
      }
      guard let (data, response) = try? await URLSession.shared.data(from: url), (response as? HTTPURLResponse)?.statusCode == 200,
        let made = await Self.shrink(data, to: mediaSide * scale)
      else {
        failed = true
        return
      }
      Drawn.pictures.setObject(made, forKey: key)
      image = made
    }
  }

  @concurrent nonisolated private static func shrink(_ data: Data, to side: CGFloat) async -> UIImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    return Files.shrunk(source, to: side)
  }
}

/// A gallery's picture: an attachment, or a link and what it shows.
struct Picture {
  var attachment: Attachment? = nil
  var link = ""
  var alt = ""

  var video: Bool { attachment?.kind == .video }

  /// The picture as a file, fetched once.
  func file() async throws -> URL {
    if let attachment { return try await Blobs.file(attachment) }
    return try await ReplyImage.file(alt: alt, link: link)
  }
}

/// Pictures and videos in a row at one height, each its own width; taller with a video in it, so a
/// 9:16 clip is big enough to see. A picture's tap opens Quick Look on the row's pictures at full
/// size, at the one tapped, to swipe through the rest; a video plays in place (VideoTile). When
/// they're more than the width shows, the row scrolls sideways and their count shows under it.
struct Gallery: View {
  let pictures: [Picture]
  var right = false
  /// Edge to edge in a widget's cell, a hairline between pictures, rather than each framed.
  var cell = false
  @State private var preview: URL?
  @State private var files: [URL] = []
  @State private var opening: Int?

  static let height: CGFloat = 160
  static let tall: CGFloat = 320

  private var high: CGFloat { pictures.contains(where: \.video) ? Self.tall : Self.height }

  /// "3 pictures · 2 videos", each only when there are any.
  private var count: String {
    let videos = pictures.count(where: \.video)
    let stills = pictures.count - videos
    return [
      stills > 0 ? "\(stills) picture\(stills == 1 ? "" : "s")" : "",
      videos > 0 ? "\(videos) video\(videos == 1 ? "" : "s")" : "",
    ].filter { !$0.isEmpty }.joined(separator: " · ")
  }

  var body: some View {
    ViewThatFits(in: .horizontal) {
      row
      VStack(alignment: right ? .trailing : .leading, spacing: 4) {
        ScrollView(.horizontal, showsIndicators: false) { row }
          .defaultScrollAnchor(right ? .trailing : .leading)
        Figure(count).padding(.horizontal, cell ? SIS.inset : 0)
      }
    }
  }

  private var row: some View {
    HStack(spacing: cell ? 0 : 6) {
      ForEach(Array(pictures.enumerated()), id: \.offset) { i, p in
        if cell && i > 0 { Rectangle().fill(SIS.rule).frame(width: SIS.line, height: high) }
        if let a = p.attachment, p.video {
          VideoTile(attachment: a, height: high, bare: cell)
        } else {
          Group {
            if let a = p.attachment {
              RemoteImage(url: Blobs.source(a), key: Drawn.key(a), height: high, bare: cell).modifier(Opens(attachment: a, taps: false))
            } else {
              ReplyImage(alt: p.alt, link: p.link, height: high, bare: cell, taps: false)
            }
          }
          .overlay {
            if opening == i { ProgressView().tint(SIS.ink) }
          }
          .onTapGesture { open(i) }
        }
      }
    }
    .fixedSize()
    .quickLookPreview($preview, in: files)
  }

  /// Every picture fetched, then Quick Look on them all at the one tapped. Videos aren't among them.
  private func open(_ at: Int) {
    guard opening == nil else { return }
    opening = at
    Task {
      let fetched = await withTaskGroup(of: (Int, URL?).self) { group in
        for (i, p) in pictures.enumerated() where !p.video { group.addTask { (i, try? await p.file()) } }
        var all = [URL?](repeating: nil, count: pictures.count)
        for await (i, url) in group { all[i] = url }
        return all
      }
      opening = nil
      guard let tapped = fetched[at] else { return }
      files = fetched.compactMap(\.self)
      preview = tapped
    }
  }
}

struct BlobImage: View {
  let attachment: Attachment
  var body: some View { RemoteImage(url: Blobs.source(attachment), key: Drawn.key(attachment)) }
}

/// A video in a gallery, at its height and its own shape: its first frame under a play mark until a tap, then
/// playing in place, streamed by range, with iOS's own controls (full screen among them). One plays at a
/// time: one starting pauses the rest. A long press offers Quick Look and Share.
struct VideoTile: View {
  let attachment: Attachment
  let height: CGFloat
  /// Without the rule round it: edge to edge in a widget's cell.
  var bare = false
  @State private var player: AVPlayer?
  @State private var still: UIImage?
  @State private var size = CGSize(width: 9, height: 16)

  var body: some View {
    // Drawn before (its bubble while it was sent): its shape and first frame at once.
    let kept = still == nil ? Drawn.frame(Drawn.key(attachment)) : nil
    let shape = kept?.size ?? size
    let first = still ?? kept?.still
    let wide = min(height * shape.width / max(shape.height, 1), mediaSide * 1.6)
    Group {
      if let player {
        VideoPlayer(player: player)
      } else {
        Button(action: play) {
          ZStack {
            Color.black
            if let first { Image(uiImage: first).resizable().scaledToFit() }
            Image(systemName: "play.fill").font(.system(size: 22)).foregroundStyle(.white)
              .frame(width: 52, height: 52).background(.black.opacity(0.5), in: Circle())
          }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Play")
        .modifier(Opens(attachment: attachment, taps: false))
      }
    }
    .frame(width: wide, height: height)
    .framed(!bare)
    .task(id: attachment) {
      guard Drawn.frame(Drawn.key(attachment)) == nil, let url = Blobs.source(attachment) else { return }
      let asset = AVURLAsset(url: url)
      if let track = try? await asset.loadTracks(withMediaType: .video).first,
        let (natural, transform) = try? await track.load(.naturalSize, .preferredTransform)
      {
        let turned = natural.applying(transform)
        size = CGSize(width: abs(turned.width), height: abs(turned.height))
      }
      let frames = AVAssetImageGenerator(asset: asset)
      frames.appliesPreferredTrackTransform = true
      frames.maximumSize = CGSize(width: height * 3, height: height * 3)
      if let first = try? await frames.image(at: .zero).image {
        let made = UIImage(cgImage: first)
        still = made
        Drawn.frames.setObject(Drawn.Frame(still: made, size: size), forKey: Drawn.key(attachment) as NSString)
      }
    }
    .onReceive(NotificationCenter.default.publisher(for: AVPlayer.rateDidChangeNotification)) { note in
      guard let other = note.object as? AVPlayer, other !== player, other.rate > 0 else { return }
      player?.pause()
    }
    .onDisappear { player?.pause() }
  }

  private func play() {
    guard let url = Blobs.source(attachment) else { return }
    try? AVAudioSession.sharedInstance().setCategory(.playback)
    let made = AVPlayer(url: url)
    player = made
    made.play()
  }
}

/// A sound: play or pause, its name, and how long it is.
struct BlobAudio: View {
  let attachment: Attachment
  @State private var player: AVPlayer?
  @State private var playing = false
  @State private var length: Double?

  var body: some View {
    HStack(spacing: 10) {
      Button {
        toggle()
      } label: {
        Image(systemName: playing ? "pause.fill" : "play.fill").frame(width: 20)
      }
      .buttonStyle(KeyStyle())
      .accessibilityLabel(playing ? "Pause" : "Play")
      Text(attachment.name).font(SIS.text(14)).foregroundStyle(SIS.ink).lineLimit(1).truncationMode(.middle)
      if let length {
        Figure(Duration.seconds(length.rounded()).formatted(.time(pattern: .minuteSecond)))
      }
    }
    .padding(.horizontal, 10)
    .frame(minHeight: SIS.row)
    .background(SIS.paper)
    .framed()
    .task(id: attachment) {
      guard let url = Blobs.source(attachment) else { return }
      let asset = AVURLAsset(url: url)
      if let d = try? await asset.load(.duration), d.seconds.isFinite { length = d.seconds }
    }
    .onReceive(NotificationCenter.default.publisher(for: AVPlayerItem.didPlayToEndTimeNotification)) { note in
      guard let item = note.object as? AVPlayerItem, item == player?.currentItem else { return }
      playing = false
      player?.seek(to: .zero)
    }
    .onDisappear {
      player?.pause()
      playing = false
    }
  }

  private func toggle() {
    if player == nil, let url = Blobs.source(attachment) {
      try? AVAudioSession.sharedInstance().setCategory(.playback)
      player = AVPlayer(url: url)
    }
    if playing { player?.pause() } else { player?.play() }
    playing.toggle()
  }
}

/// A file: its name, then what it is and how big.
struct BlobFile: View {
  let attachment: Attachment

  var body: some View {
    let ext = attachment.ext.uppercased()
    HStack(spacing: 8) {
      Image(systemName: "doc").foregroundStyle(SIS.ink3)
      Text(attachment.name).font(SIS.text(14)).foregroundStyle(SIS.ink).lineLimit(1).truncationMode(.middle)
      Figure(ext.isEmpty ? attachment.bytes : "\(ext) · \(attachment.bytes)")
    }
    .padding(.horizontal, 10)
    .frame(minHeight: SIS.row)
    .background(SIS.paper)
    .framed()
  }
}

/// An attachment opened: a tap (unless what it's on takes taps) and a long press's Quick Look bring
/// it down under its own name and show it; Share hands that file to the share sheet.
struct Opens: ViewModifier {
  let attachment: Attachment
  var taps = true
  @State private var preview: URL?
  @State private var shared: Shared?
  @State private var opening = false
  @State private var failure: String?

  func body(content: Content) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      content
        .overlay {
          if opening { ProgressView().tint(SIS.ink) }
        }
        .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: SIS.radius))
        .onTapGesture { if taps { fetch { preview = $0 } } }
        .contextMenu {
          Button("Copy", systemImage: "doc.on.doc") { fetch { Blobs.copy($0) } }
          Button("Share", systemImage: "square.and.arrow.up") { fetch { shared = Shared(url: $0) } }
          Button("Quick Look", systemImage: "eye") { fetch { preview = $0 } }
        }
      if let failure {
        HStack(spacing: 6) {
          Stop(size: 10)
          Text(failure)
        }
        .font(SIS.text(12))
        .foregroundStyle(SIS.ink)
      }
    }
    .quickLookPreview($preview)
    .sheet(item: $shared) { ShareSheet(url: $0.url).presentationDetents([.medium, .large]) }
  }

  private func fetch(_ then: @escaping (URL) -> Void) {
    guard !opening else { return }
    opening = true
    failure = nil
    Task {
      do {
        then(try await Blobs.file(attachment))
      } catch {
        failure = (error as? Blobs.Failed)?.reason ?? "Didn't download"
      }
      opening = false
    }
  }
}

struct Shared: Identifiable {
  let url: URL
  var id: URL { url }
}

/// iOS's share sheet for one file.
struct ShareSheet: UIViewControllerRepresentable {
  let url: URL

  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: [url], applicationActivities: nil)
  }

  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
