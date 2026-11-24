import SwiftUI

/// What waits in the box, a strip of cells above the words, a hairline between each.
struct Chips: View {
  let tray: Tray

  var body: some View {
    ScrollView(.horizontal) {
      HStack(spacing: 0) {
        ForEach(tray.items) { item in
          Chip(item: item, retry: { tray.retry(item) }, remove: { tray.remove(item) })
          Rectangle().fill(SIS.hair).frame(width: SIS.hairWidth)
        }
      }
    }
    .scrollIndicators(.hidden)
    .frame(height: Chip.height)
    .overlay(alignment: .bottom) { Hairline() }
  }
}

/// One thing waiting in the box: its picture or kind, name and size; going up, or failed (a tap
/// tries again).
private struct Chip: View {
  static let height: CGFloat = 56

  let item: Picked
  let retry: () -> Void
  let remove: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      ZStack {
        SIS.wash
        if let thumbnail = item.thumbnail {
          Image(uiImage: thumbnail).resizable().scaledToFill()
        } else {
          Image(systemName: item.kind == .video ? "film" : item.kind == .photo ? "photo" : "doc").foregroundStyle(SIS.ink2)
        }
        if item.busy {
          Color.black.opacity(0.35)
          ProgressView().controlSize(.small).tint(.white)
        }
      }
      .frame(width: 40, height: 40)
      .clipped()
      VStack(alignment: .leading, spacing: 2) {
        Text(item.name).font(SIS.text(13)).foregroundStyle(SIS.ink).lineLimit(1).truncationMode(.middle)
        if case .failed(let why) = item.state {
          HStack(spacing: 4) {
            Stop(size: 10)
            Text(why)
          }
          .font(SIS.text(12))
          .foregroundStyle(SIS.ink)
        } else if let size = item.size {
          Text(size.formatted(.byteCount(style: .file))).font(SIS.text(12)).foregroundStyle(SIS.ink3)
        }
      }
      .frame(width: 104, alignment: .leading)
      Button(action: remove) {
        Image(systemName: "xmark").font(SIS.text(12, weight: .semibold)).foregroundStyle(SIS.ink3).frame(width: 28, height: 40)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Remove")
    }
    .padding(.leading, SIS.inset)
    .padding(.trailing, 4)
    .frame(height: Self.height)
    .background(item.failed ? SIS.wash : Color.clear)
    .contentShape(Rectangle())
    .onTapGesture(perform: retry)
  }
}
