import SwiftUI
import UIKit

extension Brain {
  /// Whether a space lists the spaces inside it as banner rows or plain ones: the user's, per space
  /// (`pref space.inside:<id>`); until set, Home's are banners and every other space's plain rows
  /// (the desktop's space-view.ts).
  func banners(_ id: String) -> Bool {
    switch prefs["space.inside:\(id)"]?.string {
    case "banners": true
    case "rows": false
    default: id == HOME
    }
  }
}

/// A space inside, as a banner row (the desktop's space-banner.tsx): a little taller than a plain
/// one, its cover behind it, and on black plates over the cover its ring and name at the left and its
/// live marks at the right, so they read on any cover.
struct SpaceBanner: View {
  let space: Space
  let station: Brain.Station?
  let marks: (running: Bool, needs: Int, unread: Bool)
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 0) {
        HStack(spacing: 8) {
          Ring(code: station?.code ?? "", ink: station?.ink ?? SIS.ink3, fill: .black, type: .white)
          Text(space.name.uppercased()).font(SIS.sign(17)).tracking(0.3).lineLimit(1)
            .padding(.top, 2)
          if marks.unread {
            Circle().fill(.white).frame(width: 7, height: 7).accessibilityHidden(true)
          }
        }
        .foregroundStyle(.white)
        .padding(.vertical, 7)
        .padding(.leading, SIS.inset)
        .padding(.trailing, 10)
        .background(.black, in: UnevenRoundedRectangle(bottomTrailingRadius: 6, topTrailingRadius: 6))
        Spacer(minLength: 8)
        if marks.running || marks.needs > 0 {
          HStack(spacing: 10) {
            if marks.running { Runner() }
            if marks.needs > 0 {
              HStack(spacing: 4) {
                Hand()
                Text("\(marks.needs)").font(SIS.text(12)).foregroundStyle(.white)
              }
            }
          }
          .padding(.horizontal, 8)
          .padding(.vertical, 5)
          .background(.black, in: RoundedRectangle(cornerRadius: 6))
          .padding(.trailing, 8)
        }
      }
      .frame(maxWidth: .infinity, minHeight: SIS.row + 12, maxHeight: SIS.row + 12)
      .background {
        if let cover = space.cover { Cover(hash: cover) }
      }
      .clipped()
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(space.name)
    .overlay(alignment: .bottom) { Hairline() }
  }
}

/// Covers drawn once per blob and width.
nonisolated(unsafe) private let covers = NSCache<NSString, UIImage>()

/// A space's cover, cropped to fill its frame.
private struct Cover: View {
  let hash: String
  @State private var image: UIImage?
  @Environment(\.displayScale) private var scale

  var body: some View {
    GeometryReader { g in
      ZStack {
        if let image {
          Image(uiImage: image).resizable().scaledToFill().frame(width: g.size.width, height: g.size.height).clipped()
        }
      }
      .frame(width: g.size.width, height: g.size.height)
      .task(id: hash) { await load(width: g.size.width) }
    }
    .background(SIS.paper)
  }

  private func load(width: CGFloat) async {
    let key = "\(hash) \(scale)" as NSString
    if let made = covers.object(forKey: key) {
      image = made
      return
    }
    guard let url = Blobs.resolve("/blobs/\(hash)"),
      let file = try? await Blobs.file(url, folder: String(hash.prefix(16)), name: "cover"),
      let made = await Self.shrink(file, to: width * scale)
    else { return }
    covers.setObject(made, forKey: key)
    image = made
  }

  @concurrent nonisolated private static func shrink(_ file: URL, to side: CGFloat) async -> UIImage? {
    Files.shrunk(file, to: side)
  }
}
