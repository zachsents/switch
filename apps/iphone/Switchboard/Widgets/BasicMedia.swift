import A2UICore
import A2UISwiftUI
import AVKit
import BasicCatalogSwiftUI
import SwiftUI

/// A picture from a link. As it comes (`mediumFeature`, `largeFeature`) it's desktop's Picture: the
/// cell's whole width, edge to edge, at its own ratio. A `header` is the width at the header's
/// height, cropped; an `icon`, `avatar` (round) and `smallFeature` keep their small sizes, as old
/// Switchboard's iPhone app drew them. Nothing without a link.
struct BasicImage: View {
  let node: Node
  @Environment(\.laid) private var laid
  @Environment(\.lineUp) private var lineUp

  var body: some View {
    if let url = HouseBasic.media(node.string(for: "url")) {
      let variant = node.string(for: "variant") ?? "mediumFeature"
      Group {
        switch variant {
        case "icon", "avatar", "smallFeature":
          small(url, variant).placed(laid, lineUp, room: HouseBasic.keyRoom)
        case "header":
          Color.clear
            .frame(maxWidth: .infinity)
            .frame(height: SIS.header)
            .overlay {
              AsyncImage(url: url) { phase in
                if let image = phase.image { fitted(image, variant) }
              }
            }
            .clipped()
        default:
          AsyncImage(url: url) { phase in
            if let image = phase.image {
              image.resizable().aspectRatio(contentMode: .fit)
                .frame(maxWidth: .infinity, maxHeight: laid == .down ? nil : SIS.feature)
            }
          }
        }
      }
      .accessibilityIdentifier("a2ui-\(node.id)")
      .spoken(node.explicitAccessibilityAttributes?.label ?? node.string(for: "description"))
    }
  }

  private func small(_ url: URL, _ variant: String) -> some View {
    let side =
      switch variant {
      case "icon": SIS.icon
      case "avatar": SIS.avatar
      default: SIS.smallFeature
      }
    return AsyncImage(url: url) { phase in
      if let image = phase.image {
        fitted(image, variant)
      } else {
        SIS.wash.overlay {
          if phase.error != nil { Image(systemName: "photo").foregroundStyle(SIS.ink3) }
        }
      }
    }
    .frame(width: side, height: side)
    .clipShape(variant == "avatar" ? AnyShape(Circle()) : AnyShape(Rectangle()))
  }

  /// Its `fit`, as CSS's object-fit; an avatar and a header cover their frame, the rest fit in it.
  @ViewBuilder private func fitted(_ image: Image, _ variant: String) -> some View {
    switch node.string(for: "fit") ?? (variant == "avatar" || variant == "header" ? "cover" : "contain") {
    case "cover": image.resizable().scaledToFill()
    case "fill": image.resizable()
    case "none": image
    default: image.resizable().scaledToFit()
    }
  }
}

/// One of A2UI's named icons as its SF Symbol (any other name as an SF Symbol's own), or an SVG
/// path; in ink, or a key's own colors on a key.
struct BasicIcon: View {
  let node: Node
  @Environment(\.laid) private var laid
  @Environment(\.lineUp) private var lineUp

  var body: some View {
    Group {
      if let path = svgPath {
        SVGPathShape(pathData: path).fill(.foreground)
      } else {
        Image(systemName: symbol).font(SIS.text(SIS.Size.heading + 1))
      }
    }
    .frame(width: SIS.icon, height: SIS.icon)
    .foregroundStyle(laid == .key ? AnyShapeStyle(.foreground) : AnyShapeStyle(SIS.ink))
    .spoken(node.explicitAccessibilityAttributes?.label ?? node.string(for: "name"))
    .accessibilityIdentifier("a2ui-\(node.id)")
    .placed(laid, lineUp, room: HouseBasic.keyRoom)
  }

  /// `{"svgPath": …}`, resolved or as written, or a path given as the name.
  private var svgPath: String? {
    if let shape = node.dictionary(for: "name") {
      let path = (shape["svgPath"] as? String) ?? (shape["svgPath"] as? DataBinding<String>)?.value
      if let path, !path.isEmpty { return path }
    }
    if let path = node.jsonValue(for: "name")?["svgPath"]?.stringValue, !path.isEmpty { return path }
    let name = (node.string(for: "name") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    return name.hasPrefix("M") || name.hasPrefix("m") ? name : nil
  }

  private var symbol: String {
    let name = node.string(for: "name") ?? ""
    if let known = Self.symbols[name] { return known }
    return UIImage(systemName: name) == nil ? "questionmark.circle" : name
  }

  /// A2UI's icon names as SF Symbols (old Switchboard's iPhone app).
  static let symbols = [
    "accountCircle": "person.crop.circle", "add": "plus", "arrowBack": "arrow.backward", "arrowForward": "arrow.forward",
    "attachFile": "paperclip", "calendarToday": "calendar", "call": "phone", "camera": "camera", "check": "checkmark",
    "close": "xmark", "delete": "trash", "download": "arrow.down.to.line", "edit": "pencil", "event": "calendar.badge.clock",
    "error": "exclamationmark.octagon.fill", "fastForward": "forward.fill", "favorite": "heart.fill", "favoriteOff": "heart",
    "folder": "folder", "help": "questionmark.circle", "home": "house", "info": "info.circle", "locationOn": "mappin.and.ellipse",
    "lock": "lock", "lockOpen": "lock.open", "mail": "envelope", "menu": "line.3.horizontal", "moreVert": "ellipsis.vertical",
    "moreHoriz": "ellipsis", "notificationsOff": "bell.slash", "notifications": "bell", "pause": "pause.fill",
    "payment": "creditcard", "person": "person", "phone": "phone", "photo": "photo", "play": "play.fill", "print": "printer",
    "refresh": "arrow.clockwise", "rewind": "backward.fill", "search": "magnifyingglass", "send": "paperplane",
    "settings": "gearshape", "share": "square.and.arrow.up", "shoppingCart": "cart", "skipNext": "forward.end.fill",
    "skipPrevious": "backward.end.fill", "star": "star.fill", "starHalf": "star.leadinghalf.filled", "starOff": "star",
    "stop": "stop.fill", "upload": "arrow.up.to.line", "visibility": "eye", "visibilityOff": "eye.slash",
    "volumeDown": "speaker.wave.1", "volumeMute": "speaker", "volumeOff": "speaker.slash", "volumeUp": "speaker.wave.3",
    "warning": "exclamationmark.triangle.fill",
  ]
}

/// A video, edge to edge at the video's height: its poster (if any) with a Play key, then the
/// system's player. Nothing without a link.
struct BasicVideo: View {
  let node: Node
  @State private var player: AVPlayer?

  var body: some View {
    if let url = HouseBasic.media(node.string(for: "url")) {
      ZStack {
        if let player {
          VideoPlayer(player: player)
        } else {
          SIS.desk
          if let poster = HouseBasic.media(node.string(for: "posterUrl")) {
            AsyncImage(url: poster) { $0.resizable().scaledToFill() } placeholder: { SIS.desk }
              .frame(maxWidth: .infinity, maxHeight: .infinity)
          }
          Button {
            let playing = AVPlayer(url: url)
            player = playing
            playing.play()
          } label: {
            Label("Play", systemImage: "play.fill")
          }
          .buttonStyle(KeyStyle())
        }
      }
      .frame(maxWidth: .infinity)
      .frame(height: SIS.video)
      .clipped()
      .onChange(of: url) { player = nil }
      .onDisappear { player?.pause() }
      .accessibilityIdentifier("a2ui-\(node.id)")
    }
  }
}

/// A sound: its description, then a play key, how far it's got along a track, and the time.
struct BasicAudio: View {
  let node: Node
  @State private var model = AudioModel()
  @Environment(\.laid) private var laid
  @Environment(\.lineUp) private var lineUp

  var body: some View {
    VStack(alignment: .leading, spacing: SIS.gap) {
      if let about = node.string(for: "description"), !about.isEmpty {
        Text(about).font(SIS.text(SIS.Size.caption)).foregroundStyle(SIS.ink2)
      }
      HStack(spacing: 10) {
        Button {
          model.toggle(HouseBasic.media(node.string(for: "url")))
        } label: {
          Image(systemName: model.playing ? "pause.fill" : "play.fill").frame(width: SIS.icon)
        }
        .buttonStyle(KeyStyle())
        .accessibilityLabel(model.playing ? "Pause" : "Play")
        Slider(value: Binding(get: { model.at }, set: { model.seek($0) }), in: 0...max(model.length, 0.1))
          .tint(SIS.ink)
        Figure("\(Self.clock(model.at)) / \(Self.clock(model.length))")
      }
    }
    .placed(laid, lineUp, room: SIS.gap)
    .onDisappear { model.stop() }
    .a2uiAccessibilityElement(for: node, children: .contain)
    .accessibilityIdentifier("a2ui-\(node.id)")
  }

  static func clock(_ seconds: Double) -> String {
    let whole = Int(seconds.isFinite ? seconds : 0)
    return String(format: "%d:%02d", whole / 60, whole % 60)
  }
}

/// What an AudioPlayer plays (old Switchboard's iPhone app).
@Observable final class AudioModel {
  private(set) var playing = false
  private(set) var at: Double = 0
  private(set) var length: Double = 0
  @ObservationIgnored private var player: AVPlayer?
  @ObservationIgnored private var watch: Any?

  func toggle(_ url: URL?) {
    if player == nil, let url {
      let player = AVPlayer(url: url)
      watch = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] time in
        MainActor.assumeIsolated {
          guard let self, let player = self.player else { return }
          self.at = time.seconds
          let length = player.currentItem?.duration.seconds ?? 0
          if length.isFinite { self.length = length }
          self.playing = player.rate > 0
        }
      }
      self.player = player
    }
    guard let player else { return }
    if player.rate > 0 { player.pause() } else { player.play() }
    playing = player.rate > 0
  }

  func seek(_ seconds: Double) {
    at = seconds
    player?.seek(to: CMTime(seconds: seconds, preferredTimescale: 600))
  }

  func stop() {
    player?.pause()
    playing = false
  }
}
