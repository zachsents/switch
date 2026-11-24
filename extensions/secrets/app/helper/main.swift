// The app's native half, beside its bun process: what Electrobun doesn't reach. One process for the
// app's life, speaking JSON lines: requests on stdin ({ id, op, … }), answers and events on stdout.
//   auth { reason }      the Mac's own check: Touch ID, else its password
//   copy { text }        onto the clipboard, marked concealed so clipboard managers skip it → { count }
//   clear { count }      empties the clipboard if it still holds that copy
// Events: { event: "lock" } (sleep, the screen locked, the user switched away), { event: "idle" }
// (5 min without input).
import AppKit
import LocalAuthentication

let output = FileHandle.standardOutput

func emit(_ object: [String: Any]) {
  guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
  data.append(0x0A)
  output.write(data)
}

func answer(_ id: Any, _ ok: Bool, _ more: [String: Any] = [:]) {
  emit(more.merging(["id": id, "ok": ok]) { a, _ in a })
}

let concealed = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")

func handle(_ request: [String: Any]) {
  let id = request["id"] ?? 0
  switch request["op"] as? String {
  case "auth":
    let context = LAContext()
    let reason = request["reason"] as? String ?? "unlock"
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, error in
      DispatchQueue.main.async {
        answer(id, ok, ok ? [:] : ["error": error?.localizedDescription ?? "Not confirmed"])
      }
    }
  case "copy":
    let board = NSPasteboard.general
    board.clearContents()
    board.declareTypes([.string, concealed], owner: nil)
    board.setString(request["text"] as? String ?? "", forType: .string)
    board.setData(Data(), forType: concealed)
    answer(id, true, ["count": board.changeCount])
  case "clear":
    let board = NSPasteboard.general
    let mine = board.changeCount == (request["count"] as? Int ?? -1)
    if mine { board.clearContents() }
    answer(id, true, ["cleared": mine])
  default:
    answer(id, false, ["error": "Unknown op"])
  }
}

// Requests, a line at a time, run on the main thread.
Thread.detachNewThread {
  while let line = readLine() {
    guard let data = line.data(using: .utf8),
      let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { continue }
    DispatchQueue.main.async { handle(request) }
  }
  // The bun process is gone: so is this.
  exit(0)
}

let workspace = NSWorkspace.shared.notificationCenter
for name in [
  NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification,
  NSWorkspace.sessionDidResignActiveNotification,
] {
  workspace.addObserver(forName: name, object: nil, queue: .main) { _ in emit(["event": "lock"]) }
}
DistributedNotificationCenter.default().addObserver(
  forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main
) { _ in emit(["event": "lock"]) }

// Idle: no key, click or move for five minutes; said once per stretch.
var idle = false
Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { _ in
  let seconds = CGEventSource.secondsSinceLastEventType(
    .combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
  if seconds >= 300, !idle { emit(["event": "idle"]) }
  idle = seconds >= 300
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
emit(["event": "ready"])
app.run()
