// rec: records one app's window (or a screen rect) at 60 fps with ScreenCaptureKit, and drives the
// app: keys posted to its process only; the pointer as a real mouse, at the window's place on screen. Run it where it holds Screen Recording and Accessibility (the macOS spur's
// exec, record/mx.sh).
//
//   rec window <bundle-id>                         the window's id and frame, as JSON
//   rec size <bundle-id> <w> <h> [<x> <y>]         sets the window's frame, in points
//   rec record <bundle-id | x,y,w,h> <out.mov> [seconds]   until seconds pass, or SIGINT/SIGTERM
//   rec run <bundle-id> <steps.json> <out.mov> [screen]     records while it plays the steps; writes out.json
//   rec selftest <out.mov>                         a window that changes every frame, recorded 2 s
//
// Steps (JSON array), each waiting `wait` ms first (default 0); points are window-relative:
//   {"do":"click","x":..,"y":..,"button":1..5,"mods":"cmd"}   {"do":"move","x":..,"y":..}
//   {"do":"drag","x":..,"y":..,"x2":..,"y2":..,"ms":400,"hold":150}
//   {"do":"key","keys":"cmd+e"}   {"do":"type","text":"..."}   {"do":"scroll","x":..,"y":..,"dy":-300}
//   {"do":"open","url":"switchboard://space/<id>"}   {"do":"size","w":..,"h":..}   {"do":"mark","label":".."}
//   {"do":"menu","item":"Settings…"}  a menu bar item, pressed through Accessibility
//   {"do":"settle","ms":1500}   records on with nothing done (the last step's settle ends the run)
import AppKit
import AVFoundation
import CoreMedia
import ScreenCaptureKit

func fail(_ s: String) -> Never {
  FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
  exit(1)
}

func hostMs() -> Double {
  CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())) * 1000
}

/** A locked screen paints no app window (WebKit stops drawing) and takes no input. */
func requireUnlocked() {
  let d = CGSessionCopyCurrentDictionary() as? [String: Any]
  if d?["CGSSessionScreenIsLocked"] as? Bool == true {
    fail("screen locked: app windows don't paint or take input until it's unlocked")
  }
}

func printJSON(_ v: Any) {
  let d = try! JSONSerialization.data(withJSONObject: v, options: [.sortedKeys])
  print(String(data: d, encoding: .utf8)!)
}

// MARK: The window

func appWindow(_ id: String) async -> SCWindow {
  for _ in 0..<40 {
    if let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) {
      let ws = content.windows.filter {
        $0.owningApplication?.bundleIdentifier == id && $0.windowLayer == 0 && $0.frame.width > 200 && $0.frame.height > 200
      }
      if let w = ws.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) {
        return w
      }
    }
    try? await Task.sleep(nanoseconds: 250_000_000)
  }
  fail("no window for \(id)")
}

func axWindow(_ pid: pid_t) -> AXUIElement? {
  let app = AXUIElementCreateApplication(pid)
  var v: CFTypeRef?
  AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &v)
  for w in (v as? [AXUIElement]) ?? [] {
    var role: CFTypeRef?
    AXUIElementCopyAttributeValue(w, kAXRoleAttribute as CFString, &role)
    if role as? String == kAXWindowRole {
      return w
    }
  }
  return nil
}

/** Sets the window's frame through Accessibility, else by dragging its title bar and its corner. */
func setFrame(_ id: String, _ x: Double, _ y: Double, _ w: Double, _ h: Double) async {
  let pid = runningPid(id)
  if let win = axWindow(pid) {
    var p = CGPoint(x: x, y: y)
    var s = CGSize(width: w, height: h)
    AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &p)!)
    AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &s)!)
    try? await Task.sleep(nanoseconds: 300_000_000)
    return
  }
  // Electrobun's window answers Accessibility as the app, not as a window.
  var f = await appWindow(id).frame
  let d = Driver(pid: pid, windowNumber: Int(await appWindow(id).windowID), origin: f.origin)
  if f.minX != x || f.minY != y {
    d.drag(f.width / 2, 12, f.width / 2 + x - f.minX, 12 + y - f.minY, ms: 200, hold: 60)
    try? await Task.sleep(nanoseconds: 300_000_000)
    f = await appWindow(id).frame
  }
  let c = Driver(pid: pid, windowNumber: d.windowNumber, origin: f.origin)
  if f.width != w || f.height != h {
    c.drag(f.width - 1, f.height - 1, w - 1, h - 1, ms: 200, hold: 60)
    try? await Task.sleep(nanoseconds: 300_000_000)
  }
}

// MARK: The menu bar

func children(_ e: AXUIElement) -> [AXUIElement] {
  var v: CFTypeRef?
  AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &v)
  return (v as? [AXUIElement]) ?? []
}

func title(_ e: AXUIElement) -> String {
  var v: CFTypeRef?
  AXUIElementCopyAttributeValue(e, kAXTitleAttribute as CFString, &v)
  return (v as? String) ?? ""
}

/** Presses the first menu bar item titled `name`, anywhere in the app's menus. */
func pressMenu(_ pid: pid_t, _ name: String) {
  let app = AXUIElementCreateApplication(pid)
  var bar: CFTypeRef?
  AXUIElementCopyAttributeValue(app, kAXMenuBarAttribute as CFString, &bar)
  guard let root = bar else { fail("no menu bar") }
  var queue = [root as! AXUIElement]
  while !queue.isEmpty {
    let e = queue.removeFirst()
    if title(e) == name, children(e).isEmpty {
      AXUIElementPerformAction(e, kAXPressAction as CFString)
      return
    }
    queue.append(contentsOf: children(e))
  }
  fail("no menu item \(name)")
}

// MARK: Events, posted to the app's process only

let keyCodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
  "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
  "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
  "p": 35, "return": 36, "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
  "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50, "delete": 51, "backspace": 51,
  "esc": 53, "escape": 53, "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119,
  "pageup": 116, "pagedown": 121, "f1": 122, "f2": 120,
]

func flags(_ mods: [String]) -> CGEventFlags {
  var f: CGEventFlags = []
  for m in mods {
    switch m {
    case "cmd", "command": f.insert(.maskCommand)
    case "shift": f.insert(.maskShift)
    case "alt", "option", "opt": f.insert(.maskAlternate)
    case "ctrl", "control": f.insert(.maskControl)
    default: fail("unknown modifier \(m)")
    }
  }
  return f
}

let source = CGEventSource(stateID: .hidSystemState)

struct Driver {
  let pid: pid_t
  let windowNumber: Int
  var origin: CGPoint

  // The pointer's events go through the HID tap, as a real mouse's: WebKit takes a click posted to
  // its process only when its window is already key, and a background process can't make it so.
  // The test window is in front on the mini's screen, so they land on it.
  func post(_ e: CGEvent) {
    e.post(tap: .cghidEventTap)
  }

  func at(_ x: Double, _ y: Double) -> CGPoint {
    CGPoint(x: origin.x + x, y: origin.y + y)
  }

  func mouse(_ type: CGEventType, _ p: CGPoint, button: Int, f: CGEventFlags = [], clicks: Int64 = 1) {
    let b = CGMouseButton(rawValue: UInt32(min(button - 1, 2)))!
    let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: b)!
    e.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button - 1))
    e.setIntegerValueField(.mouseEventClickState, value: clicks)
    e.flags = f
    post(e)
  }

  func types(_ button: Int) -> (CGEventType, CGEventType, CGEventType) {
    switch button {
    case 1: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged)
    case 2: return (.rightMouseDown, .rightMouseUp, .rightMouseDragged)
    default: return (.otherMouseDown, .otherMouseUp, .otherMouseDragged)
    }
  }

  func click(_ x: Double, _ y: Double, button: Int, mods: [String]) {
    let p = at(x, y)
    let (down, up, _) = types(button)
    mouse(.mouseMoved, p, button: 1)
    mouse(down, p, button: button, f: flags(mods))
    usleep(30_000)
    mouse(up, p, button: button, f: flags(mods))
  }

  func move(_ x: Double, _ y: Double) {
    mouse(.mouseMoved, at(x, y), button: 1)
  }

  func drag(_ x: Double, _ y: Double, _ x2: Double, _ y2: Double, ms: Double, hold: Double) {
    let a = at(x, y)
    let b = at(x2, y2)
    mouse(.mouseMoved, a, button: 1)
    mouse(.leftMouseDown, a, button: 1)
    usleep(useconds_t(hold * 1000))
    let n = max(Int(ms / 16.7), 1)
    for i in 1...n {
      let t = Double(i) / Double(n)
      mouse(.leftMouseDragged, CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t), button: 1)
      usleep(16_700)
    }
    usleep(useconds_t(hold * 1000))
    mouse(.leftMouseUp, b, button: 1)
  }

  func key(_ combo: String) {
    let parts = combo.lowercased().split(separator: "+").map(String.init)
    guard let name = parts.last, let code = keyCodes[name] else {
      fail("unknown key \(combo)")
    }
    let f = flags(Array(parts.dropLast()))
    let d = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)!
    d.flags = f
    let u = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)!
    u.flags = f
    d.postToPid(pid)
    usleep(20_000)
    u.postToPid(pid)
  }

  func type(_ text: String) {
    for ch in text.utf16 {
      var c = ch
      for down in [true, false] {
        let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)!
        e.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)
        e.postToPid(pid)
      }
      usleep(25_000)
    }
  }

  func scroll(_ x: Double, _ y: Double, dy: Int32) {
    move(x, y)
    let steps = max(abs(Int(dy)) / 40, 1)
    for _ in 0..<steps {
      let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: dy / Int32(steps), wheel2: 0, wheel3: 0)!
      e.location = at(x, y)
      post(e)
      usleep(16_700)
    }
  }
}

// MARK: Recording

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  let writer: AVAssetWriter
  let input: AVAssetWriterInput
  let queue = DispatchQueue(label: "rec")
  var stream: SCStream?
  var start: CMTime?
  /** Host-clock ms of time zero: when capture began. Frame and event times count from it. */
  var zeroMs = 0.0
  var frames: [Double] = []
  let firstFrame = DispatchSemaphore(value: 0)

  init(out: URL, width: Int, height: Int) {
    try? FileManager.default.removeItem(at: out)
    writer = try! AVAssetWriter(outputURL: out, fileType: out.pathExtension == "mp4" ? .mp4 : .mov)
    input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 60_000_000,
        AVVideoExpectedSourceFrameRateKey: 60,
        AVVideoMaxKeyFrameIntervalKey: 60,
        AVVideoAllowFrameReorderingKey: false,
      ],
    ])
    input.expectsMediaDataInRealTime = true
    writer.add(input)
    super.init()
  }

  func begin(filter: SCContentFilter, width: Int, height: Int, rect: CGRect?) async {
    let c = SCStreamConfiguration()
    c.width = width
    c.height = height
    c.minimumFrameInterval = CMTime(value: 1, timescale: 60)
    c.queueDepth = 8
    c.showsCursor = false
    c.pixelFormat = kCVPixelFormatType_32BGRA
    c.colorSpaceName = CGColorSpace.sRGB
    if let rect {
      c.sourceRect = rect
    }
    let s = SCStream(filter: filter, configuration: c, delegate: self)
    try! s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
    stream = s
    zeroMs = hostMs()
    do {
      try await s.startCapture()
    } catch {
      fail("can't capture: \(error.localizedDescription) (Screen Recording off?)")
    }
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sb.isValid,
      let att = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let raw = att.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete
    else {
      return
    }
    let pts = CMSampleBufferGetPresentationTimeStamp(sb)
    if start == nil {
      start = pts
      writer.startWriting()
      writer.startSession(atSourceTime: pts)
      firstFrame.signal()
    }
    if input.isReadyForMoreMediaData {
      input.append(sb)
      frames.append(CMTimeGetSeconds(pts) * 1000 - zeroMs)
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fail("capture stopped: \(error.localizedDescription)")
  }

  func finish() async {
    try? await stream?.stopCapture()
    queue.sync {}
    if start == nil {
      return
    }
    input.markAsFinished()
    await writer.finishWriting()
  }
}

func even(_ v: Double) -> Int {
  Int(v / 2) * 2
}

func windowFilter(_ w: SCWindow) -> (SCContentFilter, Int, Int) {
  let f = SCContentFilter(desktopIndependentWindow: w)
  let scale = Double(f.pointPixelScale)
  return (f, even(w.frame.width * scale), even(w.frame.height * scale))
}

func runningPid(_ id: String) -> pid_t {
  // The process that owns the window: Electrobun's bun process carries the bundle's id.
  let apps = NSRunningApplication.runningApplications(withBundleIdentifier: id)
  guard !apps.isEmpty else {
    fail("\(id) isn't running")
  }
  return apps.map(\.processIdentifier).max()!
}

// MARK: Self test: a window whose color changes every display frame

@MainActor func selftest(_ out: String) async {
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  let win = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
  win.title = "rec selftest"
  let view = NSView()
  view.wantsLayer = true
  win.contentView = view
  win.orderFrontRegardless()
  var n = 0
  let timer = Timer(timeInterval: 1.0 / 120, repeats: true) { _ in
    n += 1
    MainActor.assumeIsolated {
      view.layer?.backgroundColor = CGColor(red: Double(n % 255) / 255, green: Double((n * 7) % 255) / 255, blue: 0.5, alpha: 1)
    }
  }
  RunLoop.main.add(timer, forMode: .common)
  try? await Task.sleep(nanoseconds: 500_000_000)
  let content = try! await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
  guard let w = content.windows.first(where: { $0.windowID == CGWindowID(win.windowNumber) }) else {
    fail("selftest window not shareable")
  }
  let (filter, width, height) = windowFilter(w)
  let r = Recorder(out: URL(fileURLWithPath: out), width: width, height: height)
  await r.begin(filter: filter, width: width, height: height, rect: nil)
  try? await Task.sleep(nanoseconds: 2_000_000_000)
  await r.finish()
  timer.invalidate()
  // Ticks were 120 a second; fewer frames than 60 a second is the window server's doing.
  FileHandle.standardError.write("ticks \(n), visible \(win.occlusionState.contains(.visible))\n".data(using: .utf8)!)
  report(r)
}

func report(_ r: Recorder) {
  let gaps = zip(r.frames.dropFirst(), r.frames).map { $0 - $1 }
  let span = (r.frames.last ?? 0) - (r.frames.first ?? 0)
  printJSON([
    "frames": r.frames.count,
    "span_ms": span,
    "fps": span > 0 ? Double(r.frames.count - 1) / span * 1000 : 0,
    "max_gap_ms": gaps.max() ?? 0,
  ])
}

// MARK: Main

@main struct Main {
  static func main() async {
    // No App Nap: timers and capture keep full rate in the background.
    let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical], reason: "recording")
    defer { ProcessInfo.processInfo.endActivity(activity) }
    // A window server connection, which posting events needs.
    _ = NSApplication.shared
    let a = CommandLine.arguments
    guard a.count >= 2 else {
      fail("usage: rec window|size|record|run|selftest ...")
    }
    switch a[1] {
    case "window":
      let w = await appWindow(a[2])
      printJSON(["id": w.windowID, "x": w.frame.minX, "y": w.frame.minY, "w": w.frame.width, "h": w.frame.height, "pid": runningPid(a[2])])

    case "size":
      requireUnlocked()
      let x = a.count > 6 ? Double(a[5])! : 0
      let y = a.count > 6 ? Double(a[6])! : 0
      await setFrame(a[2], x, y, Double(a[3])!, Double(a[4])!)
      let w = await appWindow(a[2])
      printJSON(["x": w.frame.minX, "y": w.frame.minY, "w": w.frame.width, "h": w.frame.height])

    case "record":
      let out = URL(fileURLWithPath: a[3])
      let r: Recorder
      if a[2].contains(",") {
        let v = a[2].split(separator: ",").map { Double($0)! }
        let content = try! await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let display = content.displays.first!
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let scale = Double(filter.pointPixelScale)
        let width = even(v[2] * scale)
        let height = even(v[3] * scale)
        r = Recorder(out: out, width: width, height: height)
        await r.begin(filter: filter, width: width, height: height, rect: CGRect(x: v[0], y: v[1], width: v[2], height: v[3]))
      } else {
        let (filter, width, height) = windowFilter(await appWindow(a[2]))
        r = Recorder(out: out, width: width, height: height)
        await r.begin(filter: filter, width: width, height: height, rect: nil)
      }
      let stop = DispatchSemaphore(value: 0)
      signal(SIGINT, SIG_IGN)
      signal(SIGTERM, SIG_IGN)
      let sources = [SIGINT, SIGTERM].map { sig in
        let s = DispatchSource.makeSignalSource(signal: sig, queue: .global())
        s.setEventHandler { stop.signal() }
        s.resume()
        return s
      }
      let seconds = a.count > 4 ? Double(a[4])! : 3600
      _ = await withCheckedContinuation { (c: CheckedContinuation<Int, Never>) in
        DispatchQueue.global().async {
          _ = stop.wait(timeout: .now() + seconds)
          c.resume(returning: 0)
        }
      }
      _ = sources
      await r.finish()
      report(r)

    case "run":
      requireUnlocked()
      let id = a[2]
      let steps = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: a[3]))) as! [[String: Any]]
      let out = URL(fileURLWithPath: a[4])
      if out.deletingPathExtension().appendingPathExtension("json").path == URL(fileURLWithPath: a[3]).path {
        fail("the steps file would be overwritten by the recording's json; name it otherwise")
      }
      let pid = runningPid(id)
      var w = await appWindow(id)
      var d = Driver(pid: pid, windowNumber: Int(w.windowID), origin: w.frame.origin)
      // Steps before the first mark set the scene, unrecorded; a size step changes the window.
      var i = 0
      while i < steps.count, steps[i]["do"] as? String != "mark" {
        try? await Task.sleep(nanoseconds: UInt64(((steps[i]["wait"] as? Double) ?? 0) * 1e6))
        await play(steps[i], &d, id: id)
        i += 1
      }
      w = await appWindow(id)
      d.origin = w.frame.origin
      let screen = a.count > 5 && a[5] == "screen"
      let filter: SCContentFilter
      let rect: CGRect?
      if screen {
        let content = try! await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let display = content.displays.first!
        filter = SCContentFilter(display: display, excludingWindows: [])
        rect = w.frame
      } else {
        filter = SCContentFilter(desktopIndependentWindow: w)
        rect = nil
      }
      let scale = Double(filter.pointPixelScale)
      let width = even(w.frame.width * scale)
      let height = even(w.frame.height * scale)
      let r = Recorder(out: out, width: width, height: height)
      await r.begin(filter: filter, width: width, height: height, rect: rect)
      // A hidden window gives no frame until it shows; otherwise the steps wait for the first.
      _ = await withCheckedContinuation { (c: CheckedContinuation<Int, Never>) in
        DispatchQueue.global().async {
          _ = r.firstFrame.wait(timeout: .now() + 1.5)
          c.resume(returning: 0)
        }
      }
      try? await Task.sleep(nanoseconds: 300_000_000)
      var events: [[String: Any]] = []
      while i < steps.count {
        let s = steps[i]
        try? await Task.sleep(nanoseconds: UInt64(((s["wait"] as? Double) ?? 0) * 1e6))
        let t = hostMs() - r.zeroMs
        await play(s, &d, id: id)
        // When it was done: a drag's let go, a scroll's last step.
        var e: [String: Any] = ["t": t, "end": hostMs() - r.zeroMs, "do": s["do"] as? String ?? ""]
        for k in ["label", "keys", "url", "x", "y", "x2", "y2", "ms"] where s[k] != nil {
          e[k] = s[k]
        }
        events.append(e)
        i += 1
      }
      await r.finish()
      let meta: [String: Any] = [
        "events": events,
        "frames": r.frames,
        "window": ["w": w.frame.width, "h": w.frame.height, "px_w": width, "px_h": height],
      ]
      let json = try! JSONSerialization.data(withJSONObject: meta, options: [.sortedKeys])
      try! json.write(to: out.deletingPathExtension().appendingPathExtension("json"))
      report(r)

    case "selftest":
      await selftest(a[2])

    default:
      fail("unknown command \(a[1])")
    }
  }

  static func play(_ s: [String: Any], _ d: inout Driver, id: String) async {
    let n = { (k: String) in (s[k] as? Double) ?? 0 }
    switch s["do"] as? String ?? "" {
    case "click":
      let mods = (s["mods"] as? String).map { $0.split(separator: "+").map(String.init) } ?? []
      d.click(n("x"), n("y"), button: Int((s["button"] as? Double) ?? 1), mods: mods)
    case "move": d.move(n("x"), n("y"))
    case "drag": d.drag(n("x"), n("y"), n("x2"), n("y2"), ms: (s["ms"] as? Double) ?? 400, hold: (s["hold"] as? Double) ?? 150)
    case "key": d.key(s["keys"] as! String)
    case "type": d.type(s["text"] as! String)
    case "scroll": d.scroll(n("x"), n("y"), dy: Int32(n("dy")))
    case "open":
      let p = Process()
      p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
      p.arguments = ["-g", "-b", id, s["url"] as! String]
      try! p.run()
    case "size":
      requireUnlocked()
      await setFrame(id, (s["x"] as? Double) ?? 0, (s["y"] as? Double) ?? 0, n("w"), n("h"))
      d.origin = await appWindow(id).frame.origin
    case "menu":
      // A menu bar item by its title, pressed through Accessibility, as a person choosing it: what a
      // key equivalent does, whether or not the app is in front.
      pressMenu(d.pid, s["item"] as! String)
    case "activate":
      // In front and key, as a person would have it: a click on a window not in front only brings it
      // forward. A background process can't take the front itself, so `open` asks for it.
      let p = Process()
      p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
      p.arguments = ["-b", id]
      try! p.run()
      p.waitUntilExit()
      try? await Task.sleep(nanoseconds: 400_000_000)
    case "mark", "settle": break
    default: fail("unknown step \(s["do"] ?? "")")
    }
    if s["do"] as? String == "settle" {
      try? await Task.sleep(nanoseconds: UInt64(n("ms") * 1e6))
    }
  }
}
