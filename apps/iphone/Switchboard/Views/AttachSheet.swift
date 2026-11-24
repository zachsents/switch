import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// What the box's + opens: the latest photos and videos in a strip, a tap each to attach (numbered
/// in the order picked, a second tap takes it back), then Camera, the whole library, and Files.
/// Picks go into the box at once, so closing the sheet any way keeps them.
struct AttachSheet: View {
  let tray: Tray

  @State private var library = Library()
  @State private var camera = false
  @State private var choosingFiles = false
  @State private var chosen: [PhotosPickerItem] = []
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(spacing: 0) {
      strip
      Rule()
      if CameraShot.available {
        RowButton { camera = true } label: {
          Image(systemName: "camera").frame(width: 24)
          Text("Camera")
        }
      }
      PhotosPicker(selection: $chosen, maxSelectionCount: 10, matching: .any(of: [.images, .videos]), preferredItemEncoding: .current) {
        HStack(spacing: 10) {
          Image(systemName: "photo.on.rectangle").frame(width: 24)
          Text("All Photos")
        }
        .font(SIS.text(15))
        .foregroundStyle(SIS.ink)
        .padding(.horizontal, SIS.inset)
        .frame(maxWidth: .infinity, minHeight: SIS.row, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(Lit())
      .overlay(alignment: .bottom) { Hairline() }
      RowButton { choosingFiles = true } label: {
        Image(systemName: "folder").frame(width: 24)
        Text("Files")
      }
      Spacer(minLength: 0)
      if !tray.assets.isEmpty {
        HStack {
          Spacer()
          Button("Add \(tray.assets.count)") { dismiss() }.buttonStyle(KeyStyle(go: true))
        }
        .padding(.horizontal, SIS.inset)
        .padding(.vertical, 8)
      }
    }
    .padding(.top, 20)
    .background(SIS.paper)
    .presentationDetents([.height(380), .large])
    .presentationDragIndicator(.visible)
    .presentationBackground(SIS.paper)
    .task { await library.start() }
    .onDisappear { library.stop() }
    .fullScreenCover(isPresented: $camera) {
      CameraShot { taken in
        camera = false
        if let taken {
          tray.add(taken: taken.file, video: taken.video)
          dismiss()
        }
      }
      .ignoresSafeArea()
    }
    .fileImporter(isPresented: $choosingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
      if case .success(let urls) = result, !urls.isEmpty {
        for url in urls { tray.add(file: url) }
        dismiss()
      }
    }
    .onChange(of: chosen) { _, items in
      guard !items.isEmpty else { return }
      for item in items { tray.add(chosen: item) }
      chosen = []
      dismiss()
    }
  }

  @ViewBuilder private var strip: some View {
    switch library.access {
    case .full, .limited:
      ScrollView(.horizontal) {
        LazyHStack(spacing: 2) {
          ForEach(library.shots) { shot in
            Thumb(shot: shot, number: tray.assets.firstIndex(of: shot.id).map { $0 + 1 }) { image in
              tray.toggle(asset: shot.id, video: shot.video, thumbnail: image)
            }
          }
        }
      }
      .scrollIndicators(.hidden)
      .frame(height: Thumb.side)
    case .none:
      HStack(spacing: 10) {
        Text("No access to Photos").font(SIS.text(15)).foregroundStyle(SIS.ink2)
        Spacer(minLength: 8)
        Button("Settings") {
          if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        }
        .buttonStyle(KeyStyle())
      }
      .padding(.horizontal, SIS.inset)
      .frame(height: Thumb.side)
    case .unknown:
      Color.clear.frame(height: Thumb.side)
    }
  }
}

/// One of the latest photos or videos, square: its number once picked, a video's length in its corner.
private struct Thumb: View {
  static let side: CGFloat = 112

  let shot: Shot
  let number: Int?
  let toggle: (UIImage?) -> Void
  @State private var image: UIImage?
  @Environment(\.displayScale) private var scale

  var body: some View {
    Button {
      toggle(image)
    } label: {
      SIS.wash
        .frame(width: Self.side, height: Self.side)
        .overlay {
          if let image { Image(uiImage: image).resizable().scaledToFill() }
        }
        .clipped()
        .overlay {
          if number != nil { Color.white.opacity(0.3) }
        }
        .overlay(alignment: .bottomLeading) {
          if shot.video {
            Text(Duration.seconds(shot.duration.rounded()).formatted(.time(pattern: shot.duration >= 3600 ? .hourMinuteSecond : .minuteSecond)))
              .font(SIS.text(12, weight: .semibold))
              .foregroundStyle(SIS.ink)
              .padding(.horizontal, 4)
              .background(SIS.paper, in: RoundedRectangle(cornerRadius: SIS.boxRadius))
              .overlay(RoundedRectangle(cornerRadius: SIS.boxRadius).stroke(SIS.rule, lineWidth: SIS.line))
              .padding(6)
          }
        }
        .overlay(alignment: .topTrailing) { mark.padding(6) }
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(shot.video ? "Video" : "Photo")
    .accessibilityAddTraits(number != nil ? .isSelected : [])
    .task(id: shot.id) { image = await Library.thumbnail(shot.id, side: Self.side * scale) }
  }

  @ViewBuilder private var mark: some View {
    if let number {
      Text("\(number)")
        .font(SIS.text(12, weight: .bold))
        .foregroundStyle(.white)
        .frame(width: 24, height: 24)
        .background(Circle().fill(SIS.Key.goBottom))
        .overlay(Circle().strokeBorder(.white, lineWidth: 1.5))
    } else {
      Circle().strokeBorder(.white, lineWidth: 1.5)
        .padding(SIS.line)
        .overlay(Circle().strokeBorder(.black.opacity(0.4), lineWidth: SIS.line))
        .frame(width: 24, height: 24)
    }
  }
}

/// The camera, for a photo (as JPEG) or a video (as recorded) to attach.
struct CameraShot: UIViewControllerRepresentable {
  struct Taken {
    let file: URL
    let video: Bool
  }

  static var available: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

  let done: (Taken?) -> Void

  func makeUIViewController(context: Context) -> UIImagePickerController {
    let picker = UIImagePickerController()
    picker.sourceType = .camera
    picker.mediaTypes = [UTType.image.identifier, UTType.movie.identifier]
    picker.videoQuality = .typeHigh
    picker.delegate = context.coordinator
    return picker
  }

  func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator(done: done) }

  final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    let done: (Taken?) -> Void
    init(done: @escaping (Taken?) -> Void) { self.done = done }

    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
      // The recording goes when this returns: it's copied first.
      if let movie = info[.mediaURL] as? URL, let copy = try? Files.place(movie, named: movie.lastPathComponent) {
        done(Taken(file: copy, video: true))
      } else if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.85),
        let to = try? Files.folder().appending(path: "photo.jpg"), (try? data.write(to: to)) != nil
      {
        done(Taken(file: to, video: false))
      } else {
        done(nil)
      }
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { done(nil) }
  }
}
