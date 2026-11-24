import AVFoundation
import SwiftUI
import VisionKit

/// Unpaired: the camera, for a Mac's pairing code (a `switchboard://pair` link), over a field for
/// the core's address, which asks the core for a code to approve on a Mac.
struct PairView: View {
  let phone: Phone
  @State private var address = ""

  private var flow: PairFlow { phone.pairing }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("SWITCHBOARD").font(SIS.sign(22)).tracking(0.5).foregroundStyle(SIS.bandInk)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, SIS.inset)
      .frame(height: 44)
      .background(SIS.band.ignoresSafeArea(edges: .top))
      Rectangle().fill(SIS.heavy).frame(height: SIS.heavyWidth)
      Camera { phone.open(url: $0) }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
      Rectangle().fill(SIS.heavy).frame(height: SIS.heavyWidth)
      HStack(spacing: 12) {
        TextField("Core address", text: $address)
          .font(SIS.text(16))
          .foregroundStyle(SIS.ink)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .keyboardType(.URL)
          .submitLabel(.go)
          .onSubmit(pair)
        Button("Pair", action: pair)
          .buttonStyle(KeyStyle(go: true))
          .disabled(Credential.coreURL(address) == nil)
      }
      .padding(.horizontal, SIS.inset)
      .frame(height: 56)
      Progress(flow: flow)
    }
    .background(SIS.paper)
    .onChange(of: flow.core, initial: true) { _, core in
      if let core { address = Self.shown(core) }
    }
  }

  private func pair() {
    guard let core = Credential.coreURL(address) else { return }
    flow.start(core)
  }

  /// `host:port` for the plain core it defaults to, else the whole URL.
  private static func shown(_ core: URL) -> String {
    guard core.scheme == "http", let host = core.host() else { return core.absoluteString }
    return core.port.map { "\(host):\($0)" } ?? host
  }
}

/// Where the pairing stands: the code to approve, or what went wrong.
private struct Progress: View {
  let flow: PairFlow

  var body: some View {
    switch flow.stage {
    case .idle:
      EmptyView()
    case .asking:
      cell { ProgressView().tint(SIS.ink2) }
    case .code(let code):
      cell {
        Hand()
        Text(code).font(SIS.number(40)).tracking(1).foregroundStyle(SIS.ink).textSelection(.enabled)
      }
    case .denied:
      cell {
        Stop(size: 12)
        Text("Denied").font(SIS.text(15)).foregroundStyle(SIS.ink)
        Spacer(minLength: 8)
        retry
      }
    case .failed(let why):
      cell {
        Stop(size: 12)
        Text(why).font(SIS.text(15)).foregroundStyle(SIS.ink).lineLimit(2)
        Spacer(minLength: 8)
        retry
      }
    }
  }

  private var retry: some View {
    Button("Retry") { if let core = flow.core { flow.start(core) } }
      .buttonStyle(KeyStyle())
      .disabled(flow.core == nil)
  }

  private func cell<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    VStack(spacing: 0) {
      Hairline()
      HStack(spacing: 12) { content() }
        .padding(.horizontal, SIS.inset)
        .frame(maxWidth: .infinity, minHeight: 72)
    }
  }
}

/// The camera, reading QR codes: a pairing link it sees is opened.
private struct Camera: View {
  let found: (URL) -> Void
  @State private var allowed = AVCaptureDevice.authorizationStatus(for: .video)

  var body: some View {
    ZStack {
      Color.black
      if DataScannerViewController.isSupported {
        switch allowed {
        case .authorized:
          Scanner(found: found)
        case .notDetermined:
          Color.clear.task {
            _ = await AVCaptureDevice.requestAccess(for: .video)
            allowed = AVCaptureDevice.authorizationStatus(for: .video)
          }
        default:
          Text("Camera off").font(SIS.text(15)).foregroundStyle(SIS.ink2)
        }
      }
    }
  }
}

private struct Scanner: UIViewControllerRepresentable {
  let found: (URL) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(found) }

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let scanner = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .fast, recognizesMultipleItems: false,
      isHighFrameRateTrackingEnabled: false, isHighlightingEnabled: true)
    scanner.delegate = context.coordinator
    // It scans once it's on screen.
    Task { try? scanner.startScanning() }
    return scanner
  }

  func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
    if !scanner.isScanning { try? scanner.startScanning() }
  }

  static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
    scanner.stopScanning()
  }

  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    let found: (URL) -> Void
    /// The code last opened: one held in view opens once.
    private var last: String?

    init(_ found: @escaping (URL) -> Void) { self.found = found }

    func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
      for item in addedItems {
        guard case .barcode(let code) = item, let text = code.payloadStringValue, text != last,
          let url = URL(string: text), url.scheme == "switchboard", url.host() == "pair"
        else { continue }
        last = text
        found(url)
      }
    }
  }
}
