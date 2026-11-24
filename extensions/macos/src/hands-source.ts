// The Swift helper's source, compiled on the Mac that runs it (hands.ts). A raw string keeps its
// backslashes; it holds no backtick and no dollar-brace.
export const source = String.raw`// The macOS extension's hands: what needs Accessibility, CoreGraphics or AppKit, one call per run.
// "hands <op> [json]" prints one JSON value, or {"error": ...} and exits 1. Ported from Switchboard's
// sb-macos (ax.rs, ui.rs, screen.rs). Accessibility and Screen Recording are the signed host app's,
// which this runs under.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct Failure: Error { let message: String }

func fail(_ message: String) -> Failure { Failure(message: message) }

func emit(_ value: Any) {
  let data = (try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])) ?? Data("null".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

// MARK: Accessibility

func attribute(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(e, name as CFString, &value) == .success ? value : nil
}

func text(_ e: AXUIElement, _ name: String) -> String? {
  guard let s = attribute(e, name) as? String, !s.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
  return s
}

func valueText(_ e: AXUIElement) -> String? {
  guard let v = attribute(e, "AXValue") else { return nil }
  if let s = v as? String { return s.trimmingCharacters(in: .whitespaces).isEmpty ? nil : s }
  if CFGetTypeID(v) == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) ? "true" : "false" }
  if let n = v as? NSNumber { return n.stringValue }
  return nil
}

func children(_ e: AXUIElement) -> [AXUIElement] {
  guard let list = attribute(e, "AXChildren") as? [AnyObject] else { return [] }
  return list.compactMap { item in
    CFGetTypeID(item) == AXUIElementGetTypeID() ? (item as! AXUIElement) : nil
  }
}

func clip(_ s: String?, _ max: Int) -> String? {
  guard let s else { return nil }
  return s.count > max ? String(s.prefix(max)) + "\u{2026}" : s
}

func describe(_ e: AXUIElement, value: Bool = true) -> String {
  var line = text(e, "AXRole") ?? "?"
  if let t = text(e, "AXTitle") { line += " \"\(t.prefix(80))\"" }
  if let d = text(e, "AXDescription") { line += " desc=\"\(d.prefix(80))\"" }
  if value, let v = valueText(e) { line += " value=\"\(v.prefix(80))\"" }
  if let i = text(e, "AXIdentifier") { line += " id=\"\(i.prefix(80))\"" }
  if let enabled = attribute(e, "AXEnabled"), CFGetTypeID(enabled) == CFBooleanGetTypeID(),
    !CFBooleanGetValue((enabled as! CFBoolean))
  {
    line += " (disabled)"
  }
  return line
}

struct Match {
  let role: String?
  let needle: String?
  init(_ raw: Any?) {
    let m = raw as? [String: Any] ?? [:]
    role = m["role"] as? String
    needle = m["text"] as? String
  }
  var empty: Bool { role == nil && needle == nil }
  func matches(_ e: AXUIElement) -> Bool {
    if let role, text(e, "AXRole") != role { return false }
    guard let wanted = needle?.lowercased() else { return role != nil }
    let texts = ["AXTitle", "AXDescription", "AXIdentifier", "AXHelp"].compactMap { text(e, $0) } + [valueText(e)].compactMap { $0 }
    return texts.contains { $0.lowercased().contains(wanted) }
  }
}

func search(_ root: AXUIElement, _ m: Match) -> [AXUIElement] {
  var found: [AXUIElement] = []
  var queue = children(root)
  var seen = 0
  while !queue.isEmpty, seen < 4000 {
    let e = queue.removeFirst()
    seen += 1
    if m.matches(e) { found.append(e) }
    queue.append(contentsOf: children(e))
  }
  return found
}

func outline(_ root: AXUIElement, _ depth: Int) -> String {
  var lines: [String] = []
  func walk(_ e: AXUIElement, _ level: Int) {
    if lines.count >= 600 || level > depth { return }
    lines.append(String(repeating: "  ", count: level) + describe(e))
    for c in children(e) { walk(c, level + 1) }
  }
  for c in children(root) { walk(c, 0) }
  return lines.joined(separator: "\n")
}

func setAttribute(_ e: AXUIElement, _ name: String, _ value: Any) throws {
  let v: CFTypeRef
  if let b = value as? Bool { v = b as CFBoolean } else if let s = value as? String { v = s as CFString } else {
    throw fail("set takes a string or a boolean")
  }
  let err = AXUIElementSetAttributeValue(e, name as CFString, v)
  if err != .success { throw fail("setting \(name) failed (\(err.rawValue))") }
}

// MARK: Apps, screen, input

func front() -> NSRunningApplication? { NSWorkspace.shared.frontmostApplication }

/// An app by name or bundle id; of several copies, the first a tool didn't start.
func app(_ name: String) -> NSRunningApplication? {
  let wanted = name.lowercased()
  let copies = NSWorkspace.shared.runningApplications.filter {
    $0.localizedName?.lowercased() == wanted || $0.bundleIdentifier?.lowercased() == wanted
  }
  return copies.first
}

func windowTitle(_ pid: pid_t) -> String? {
  let root = AXUIElementCreateApplication(pid)
  guard let w = attribute(root, "AXFocusedWindow") else { return nil }
  return text(w as! AXUIElement, "AXTitle")
}

func idleSeconds() -> Double {
  CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
}

func locked() -> Bool {
  guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
  if let b = session["CGSSessionScreenIsLocked"] as? Bool { return b }
  if let n = session["CGSSessionScreenIsLocked"] as? Int { return n != 0 }
  return false
}

/// When opening a locked screen takes the password: "never", "immediately" or seconds.
func passwordSetting() -> Any? {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/sbin/sysadminctl")
  p.arguments = ["-screenLock", "status"]
  let pipe = Pipe()
  p.standardError = pipe
  p.standardOutput = pipe
  guard (try? p.run()) != nil else { return nil }
  p.waitUntilExit()
  let said = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
  if said.contains("screenLock is off") { return "never" }
  guard let rest = said.components(separatedBy: "screenLock delay is ").dropFirst().first,
    let word = rest.split(separator: " ").first
  else { return nil }
  return word == "immediate" ? "immediately" : Int(word)
}

func post(_ code: CGKeyCode, flags: CGEventFlags = []) {
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
    e?.flags = flags
    e?.post(tap: .cghidEventTap)
    usleep(15000)
  }
}

/// Opens a locked screen that takes no password (Escape takes the shield down); fails otherwise.
func openScreen() throws {
  if !locked() { return }
  let setting = passwordSetting()
  if setting as? String == "immediately" { throw fail("The screen is locked behind the user's password") }
  post(53)
  for _ in 0..<30 {
    usleep(100_000)
    if !locked() {
      usleep(500_000)
      return
    }
  }
  throw fail("The screen is locked behind the user's password")
}

let keycodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
  "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
  "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
  "p": 35, "return": 36, "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
  "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "\u{60}": 50, "delete": 51, "backspace": 51,
  "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
]

func pressKeys(_ combo: String) throws {
  let parts = combo.split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
  guard let key = parts.last, let code = keycodes[key] else { throw fail("no key in \(combo)") }
  var flags: CGEventFlags = []
  for m in parts.dropLast() {
    switch m {
    case "cmd", "command": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "option", "alt": flags.insert(.maskAlternate)
    case "ctrl", "control": flags.insert(.maskControl)
    default: throw fail("no modifier \(m); use cmd, shift, option or ctrl")
    }
  }
  post(code, flags: flags)
}

func typeText(_ s: String) {
  let units = Array(s.utf16)
  var i = 0
  while i < units.count {
    let chunk = Array(units[i..<min(i + 16, units.count)])
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
      e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
      e?.post(tap: .cghidEventTap)
    }
    usleep(20000)
    i += 16
  }
}

// MARK: Ops

func glance() -> [String: Any] {
  var out: [String: Any] = [
    "idle": idleSeconds(), "locked": locked(), "trusted": AXIsProcessTrusted(),
  ]
  if let f = front() {
    out["app"] = f.localizedName ?? ""
    out["bundle"] = f.bundleIdentifier ?? ""
    out["pid"] = Int(f.processIdentifier)
    if AXIsProcessTrusted(), let w = windowTitle(f.processIdentifier) { out["window"] = w }
  }
  return out
}

func focused(_ pid: pid_t) -> Any {
  let root = AXUIElementCreateApplication(pid)
  guard let raw = attribute(root, "AXFocusedUIElement") else { return NSNull() }
  let e = raw as! AXUIElement
  let secure = text(e, "AXSubrole") == "AXSecureTextField"
  var out: [String: Any] = ["role": text(e, "AXRole") ?? "", "secure": secure]
  if !secure {
    if let v = clip(text(e, "AXValue"), 3000) { out["text"] = v }
    if let s = clip(text(e, "AXSelectedText"), 3000) { out["selection"] = s }
  }
  if let d = text(e, "AXDescription") { out["description"] = d }
  return out
}

func windows(_ pid: Int) -> [[String: Any]] {
  let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  return list.compactMap { w in
    guard (w[kCGWindowOwnerPID as String] as? Int) == pid, (w[kCGWindowLayer as String] as? Int) == 0 else { return nil }
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    return [
      "id": w[kCGWindowNumber as String] as? Int ?? 0, "name": w[kCGWindowName as String] as? String ?? "",
      "onScreen": w[kCGWindowIsOnscreen as String] as? Bool ?? false,
      "width": b["Width"] as? Double ?? 0, "height": b["Height"] as? Double ?? 0,
    ]
  }
}

// macOS asking the person something on screen: privacy and network prompts, the Accessibility
// warning. The same process shows "<app> quit unexpectedly", which asks nobody anything.
let prompters = ["UserNotificationCenter", "universalAccessAuthWarn"]

func words(_ e: AXUIElement, _ depth: Int, _ out: inout [String], _ buttons: inout [AXUIElement]) {
  let role = text(e, "AXRole") ?? ""
  if role == "AXStaticText", let v = valueText(e), !v.isEmpty { out.append(v) }
  if role == "AXButton" { buttons.append(e) }
  if depth > 0 { for c in children(e) { words(c, depth - 1, &out, &buttons) } }
}

func crashed(_ lines: [String]) -> String? {
  for line in lines {
    for tail in [" quit unexpectedly", " quit while reopening windows"] {
      if let r = line.range(of: tail) {
        let name = line[..<r.lowerBound].trimmingCharacters(in: CharacterSet(charactersIn: " \u{201C}\u{201D}\""))
        if !name.isEmpty { return name }
      }
    }
  }
  return nil
}

/// The prompts waiting on screen, each with its words; crash dialogs answered with Ignore when
/// dismiss, and the apps that crashed.
func prompts(_ dismiss: Bool) -> [String: Any] {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
  var pids = Set<Int>()
  var windows = 0
  for w in list {
    if let o = w[kCGWindowOwnerName as String] as? String, prompters.contains(o) {
      windows += 1
      if let p = w[kCGWindowOwnerPID as String] as? Int { pids.insert(p) }
    }
  }
  var waiting: [[String: Any]] = []
  var dismissed: [String] = []
  if !AXIsProcessTrusted() { return ["windows": windows, "waiting": waiting, "dismissed": dismissed, "trusted": false] }
  for pid in pids {
    let root = AXUIElementCreateApplication(pid_t(pid))
    let owner = NSRunningApplication(processIdentifier: pid_t(pid))?.localizedName ?? ""
    let wins = (attribute(root, "AXWindows") as? [AXUIElement]) ?? []
    for win in wins {
      var lines: [String] = []
      var buttons: [AXUIElement] = []
      words(win, 8, &lines, &buttons)
      let names = buttons.map { text($0, "AXTitle") ?? "" }
      if dismiss, let app = crashed(lines),
         let i = ["Ignore", "OK", "Close", "Cancel"].lazy.compactMap({ want in names.firstIndex { $0.caseInsensitiveCompare(want) == .orderedSame } }).first {
        if AXUIElementPerformAction(buttons[i], "AXPress" as CFString) == .success {
          dismissed.append(app)
          continue
        }
      }
      waiting.append(["owner": owner, "words": Array(lines.prefix(6)), "buttons": names])
    }
  }
  return ["windows": windows, "waiting": waiting, "dismissed": dismissed, "trusted": true]
}

func step(_ s: [String: Any], _ defaultApp: String?) throws -> Any {
  guard let op = s["op"] as? String else { throw fail("a step needs op: tree, find, press, set, focus, keys, type, wait") }
  if !AXIsProcessTrusted() { throw fail("No Accessibility permission") }
  let keyed = ["keys", "type", "focus"].contains(op)
  if keyed { try openScreen() }
  let named = s["app"] as? String ?? defaultApp
  guard let target = named.map(app) ?? front() else { throw fail("\(named ?? "No app") isn't running") }
  let name = target.localizedName ?? named ?? ""
  let root = AXUIElementCreateApplication(target.processIdentifier)
  let m = Match(s["match"])
  let index = s["index"] as? Int ?? 0
  func nth() throws -> AXUIElement {
    let found = search(root, m)
    guard index < found.count else { throw fail("\(found.count) elements in \(name) match; none at index \(index)") }
    return found[index]
  }
  if keyed && named != nil {
    target.activate()
    usleep(150_000)
  }
  switch op {
  case "tree": return ["app": name, "tree": outline(root, s["depth"] as? Int ?? 12)]
  case "find": return ["app": name, "found": search(root, m).prefix(50).map { describe($0) }]
  case "press":
    let e = try nth()
    let err = AXUIElementPerformAction(e, "AXPress" as CFString)
    if err != .success { throw fail("pressing it failed (\(err.rawValue))") }
    return ["pressed": describe(e)]
  case "set" where s["secret"] is String:
    let e: AXUIElement
    if m.empty {
      guard let raw = attribute(root, "AXFocusedUIElement") else { throw fail("Nothing has focus in \(name)") }
      e = raw as! AXUIElement
    } else {
      e = try nth()
    }
    let value = try secret(s)
    try setAttribute(e, "AXValue", value)
    // A secure field reads back as dots, one for each character, or as nothing at all.
    let held = (text(e, "AXValue") ?? "").count
    let secure = text(e, "AXSubrole") == "AXSecureTextField"
    if held != value.count && !(secure && held == 0) {
      try? setAttribute(e, "AXValue", "")
      throw fail("\(describe(e, value: false)) held \(held) characters after setting it, not its \(value.count), so I emptied it: try type")
    }
    return ["set": "AXValue", "on": describe(e, value: false), "secret": s["secret"] as! String, "characters": value.count]
  case "set":
    guard let value = s["value"] else { throw fail("set needs value") }
    let attr = s["attribute"] as? String ?? "AXValue"
    if m.empty {
      try setAttribute(root, attr, value)
      return ["set": attr, "on": name]
    }
    let e = try nth()
    try setAttribute(e, attr, value)
    return ["set": attr, "on": describe(e)]
  case "focus": return ["focused": name]
  case "keys":
    guard let keys = s["keys"] as? String else { throw fail("keys needs keys, like cmd+shift+g") }
    try pressKeys(keys)
    return ["pressed": keys]
  case "type" where s["secret"] is String:
    let value = try secret(s)
    typeText(value)
    return ["typed": value.count, "secret": s["secret"] as! String]
  case "type":
    guard let t = s["text"] as? String else { throw fail("type needs text") }
    typeText(t)
    return ["typed": t.count]
  case "wait":
    let gone = s["gone"] as? Bool ?? false
    let deadline = Date().addingTimeInterval(Double(min(s["timeout_ms"] as? Int ?? 10000, 600_000)) / 1000)
    while true {
      let found = search(AXUIElementCreateApplication(target.processIdentifier), m)
      if !gone, index < found.count { return ["found": describe(found[index])] }
      if gone, index >= found.count { return ["gone": true] }
      if Date() > deadline { throw fail(gone ? "It didn't go away in \(name) in time" : "Nothing matched in \(name) in time") }
      usleep(250_000)
    }
  default: throw fail("no ui op \(op)")
  }
}

/// The vault's secrets a ui call puts in, by reference, read from standard input (never the command line).
var secrets: [String: String] = [:]

func secret(_ s: [String: Any]) throws -> String {
  let ref = s["secret"] as? String ?? ""
  guard let value = secrets[ref] else { throw fail("\(ref) didn't come from the vault") }
  return value
}

func ui(_ args: [String: Any]) throws -> Any {
  if args["secrets"] as? Bool == true {
    let given = FileHandle.standardInput.readDataToEndOfFile()
    secrets = (try? JSONSerialization.jsonObject(with: given)) as? [String: String] ?? [:]
  }
  let defaultApp = args["app"] as? String
  let steps = args["steps"] as? [[String: Any]] ?? [args]
  var done: [Any] = []
  for (i, s) in steps.enumerated() {
    do {
      done.append(try step(s, defaultApp))
    } catch let e as Failure where steps.count > 1 {
      throw fail("step \(i + 1) (\(s["op"] as? String ?? "?")) failed: \(e.message). Done before it: \(done.count)")
    }
  }
  return done.count == 1 ? done[0] : ["done": done]
}

let argv = CommandLine.arguments
let op = argv.count > 1 ? argv[1] : ""
let args = argv.count > 2 ? (try? JSONSerialization.jsonObject(with: Data(argv[2].utf8))) as? [String: Any] ?? [:] : [:]
do {
  switch op {
  case "glance": emit(glance())
  case "focused": emit(focused(pid_t(args["pid"] as? Int ?? 0)))
  case "ui": emit(try ui(args))
  case "windows": emit(windows(args["pid"] as? Int ?? 0))
  case "prompts": emit(prompts(args["dismiss"] as? Bool ?? false))
  case "open-screen":
    try openScreen()
    emit(["locked": locked()])
  case "lock":
    emit(["locked": locked(), "password": passwordSetting() ?? NSNull()])
  case "access":
    emit(["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()])
  default: throw fail("ops: glance, focused, ui, windows, prompts, open-screen, lock, access")
  }
} catch let e as Failure {
  emit(["error": e.message])
  exit(1)
}
`
