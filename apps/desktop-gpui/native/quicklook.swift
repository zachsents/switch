// The Quick Look helper: the system's Quick Look panel for a chat's pictures. build.rs builds it
// into the app, and the app runs one for as long as it runs (src/platform/quicklook.rs).
//
// Each line on its stdin is a JSON object, {"files":["/path/a.png",…],"at":2}: the panel shows
// those files in that order at the one numbered `at`, the arrow keys moving through them. A line
// while it's showing replaces what it shows. Space or Esc closes it. It's an accessory app, so it
// has no Dock icon and isn't in the app switcher, and it exits when its stdin closes, so it never
// outlives the app.

import AppKit
import Quartz

struct Show: Decodable {
  let files: [String]
  let at: Int
}

final class Look: NSObject, NSApplicationDelegate, QLPreviewPanelDataSource, QLPreviewPanelDelegate {
  var files: [URL] = []

  func show(_ s: Show) {
    guard let panel = QLPreviewPanel.shared() else { return }
    files = s.files.map { URL(fileURLWithPath: $0) }
    panel.dataSource = self
    panel.delegate = self
    panel.reloadData()
    panel.currentPreviewItemIndex = min(max(s.at, 0), max(files.count - 1, 0))
    // It takes the keys without the app coming to the front: macOS keeps a helper from activating.
    panel.styleMask.insert(.nonactivatingPanel)
    panel.makeKeyAndOrderFront(nil)
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // Closed (Space, Esc or its close button, all the panel's own) and its fade done: the app the
    // user was in has the keys again, not this one with no window.
    NotificationCenter.default.addObserver(
      forName: NSWindow.didChangeOcclusionStateNotification, object: nil, queue: .main
    ) { note in
      if let panel = note.object as? QLPreviewPanel, !panel.isVisible {
        NSApp.deactivate()
      }
    }
    Thread.detachNewThread {
      while let line = readLine() {
        guard let s = try? JSONDecoder().decode(Show.self, from: Data(line.utf8)) else { continue }
        DispatchQueue.main.async { self.show(s) }
      }
      exit(0)
    }
  }

  override func acceptsPreviewPanelControl(_ panel: QLPreviewPanel!) -> Bool { true }

  override func beginPreviewPanelControl(_ panel: QLPreviewPanel!) {
    panel.dataSource = self
    panel.delegate = self
  }

  // Without it the panel's close never finishes: it fades out but stays on screen, taking clicks.
  override func endPreviewPanelControl(_ panel: QLPreviewPanel!) {}

  func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int { files.count }

  func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> QLPreviewItem! {
    files[index] as NSURL
  }
}

let look = Look()
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.delegate = look
app.run()
