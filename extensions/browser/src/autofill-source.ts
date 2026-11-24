// The autofill helper's Swift source (autofill.ts builds it): Chrome's own suggestions (saved
// passwords, cards, addresses) for the field in focus, opened and picked through Accessibility in
// the browser's own process, so the browser fills the field and nothing secret passes through the
// extension. Ported from Switchboard's autofill.rs.
//   autofill fill <json>       {pid, pick?}: {labels, chose?}
//   autofill match <json>      {pick, labels}: {index, chose}, how fill picks, without a browser
// Labels are what the suggestions say (a username, a card's last digits), never a password.
export const source = String.raw`
import Cocoa

func out(_ value: Any) {
  let data = try! JSONSerialization.data(withJSONObject: value)
  FileHandle.standardOutput.write(data)
}

func fail(_ message: String) -> Never {
  out(["error": message])
  exit(1)
}

func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
  var v: CFTypeRef?
  AXUIElementCopyAttributeValue(e, name as CFString, &v)
  return v
}

func text(_ e: AXUIElement, _ name: String) -> String? { attr(e, name) as? String }

func kids(_ e: AXUIElement, _ name: String = "AXChildren") -> [AXUIElement] {
  (attr(e, name) as? [AXUIElement]) ?? []
}

func locked() -> Bool {
  let session = CGSessionCopyCurrentDictionary() as? [String: Any]
  if let v = session?["CGSSessionScreenIsLocked"] as? Bool { return v }
  if let v = session?["CGSSessionScreenIsLocked"] as? Int { return v != 0 }
  return false
}

func key(_ code: CGKeyCode) {
  for down in [true, false] {
    CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)?.post(tap: .cghidEventTap)
  }
}

let DOWN: CGKeyCode = 125
let ESCAPE: CGKeyCode = 53

/** Opens a locked screen that takes no password: a key does it. */
func unlock() {
  if !locked() { return }
  key(ESCAPE)
  let until = Date().addingTimeInterval(3)
  while Date() < until {
    usleep(100_000)
    if !locked() { usleep(500_000); return }
  }
  fail("The screen is locked")
}

/** Presses a key in the browser: it's brought to the front first, since keys go to the app in front. */
func press(_ app: AXUIElement, _ code: CGKeyCode) {
  unlock()
  AXUIElementSetAttributeValue(app, "AXFrontmost" as CFString, kCFBooleanTrue)
  usleep(150_000)
  key(code)
}

/** Letters and digits, lowercased, one space between runs. */
func folded(_ s: String) -> String {
  s.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.joined(separator: " ")
}

/** A label as it reads: without invisible ordering marks, its dots together. */
func clean(_ s: String) -> String {
  let visible = String(s.unicodeScalars.filter { !((0x200B...0x200F).contains($0.value) || (0x202A...0x202E).contains($0.value) || (0x2060...0x2069).contains($0.value)) })
  return visible.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").replacingOccurrences(of: "\u{2022} \u{2022} ", with: "\u{2022}\u{2022}")
}

func rows(_ e: AXUIElement, _ found: inout [(AXUIElement, String)]) {
  for child in kids(e) {
    if found.count >= 50 { return }
    if text(child, "AXRole") != "AXStaticText" { rows(child, &found); continue }
    guard let raw = text(child, "AXValue") ?? text(child, "AXTitle") else { continue }
    let label = clean(raw)
    if !label.isEmpty && !label.hasPrefix("Manage ") && !found.contains(where: { $0.1 == label }) {
      found.append((child, label))
    }
  }
}

/** The rows of the browser's suggestions, if they're open: a window of their own holding a list. */
func suggestions(_ app: AXUIElement) -> [(AXUIElement, String)] {
  for window in kids(app, "AXWindows") {
    if text(window, "AXSubrole") == "AXStandardWindow" { continue }
    var queue = kids(window)
    var seen = 0
    while !queue.isEmpty {
      let e = queue.removeFirst()
      seen += 1
      if seen > 3000 { break }
      if text(e, "AXRole") == "AXList" {
        var found: [(AXUIElement, String)] = []
        rows(e, &found)
        if !found.isEmpty { return found }
        continue
      }
      queue.append(contentsOf: kids(e))
    }
  }
  return []
}

func waitFor(_ seconds: Double, _ done: () -> Bool) -> Bool {
  let until = Date().addingTimeInterval(seconds)
  while true {
    if done() { return true }
    if Date() >= until { return false }
    usleep(150_000)
  }
}

/** Presses a row, or the nearest of what holds it that takes a press. */
func choose(_ row: AXUIElement) -> Bool {
  var e: AXUIElement? = row
  for _ in 0..<6 {
    guard let current = e else { break }
    if AXUIElementPerformAction(current, "AXPress" as CFString) == .success { return true }
    e = attr(current, "AXParent").map { $0 as! AXUIElement }
  }
  return false
}

/** Runs of letters and runs of digits, lowercased, each once: "Visa ••5269" is visa, 5269. */
func words(_ s: String) -> Set<String> {
  var found = Set<String>()
  var run = ""
  var digits = false
  for ch in s.lowercased() {
    let digit = ch.isWholeNumber
    let part = digit || ch.isLetter
    if !run.isEmpty && (!part || digit != digits) {
      found.insert(run)
      run = ""
    }
    if part {
      run.append(ch)
      digits = digit
    }
  }
  if !run.isEmpty { found.insert(run) }
  return found
}

/**
 * Whether a label holds every word of a pick, in any order or case: a number as the end of one of
 * its numbers (a card's last four), a word as the start of one of its words; else the pick as a
 * part of it (a username's).
 */
func holds(_ label: String, _ pick: String) -> Bool {
  let wanted = words(pick)
  if wanted.isEmpty { return false }
  let has = words(label)
  let all = wanted.allSatisfy { w in
    has.contains { w.first?.isWholeNumber == true ? $0.hasSuffix(w) : $0.hasPrefix(w) }
  }
  return all || folded(label).contains(folded(pick))
}

/** The suggestions a pick names. */
func matching(_ pick: String, _ labels: [String]) -> [Int] {
  labels.indices.filter { holds(labels[$0], pick) }
}

/** Text as an error shows it: a card's whole number cut to its last four. */
func masked(_ text: String) -> String {
  let re = try! NSRegularExpression(pattern: "[0-9](?:[ -]?[0-9]){11,}")
  var out = text
  for m in re.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
    guard let r = Range(m.range, in: out) else { continue }
    let digits = out[r].filter { $0.isWholeNumber }
    out.replaceSubrange(r, with: "\u{2022}\u{2022}" + digits.suffix(4))
  }
  return out
}

func mismatch(_ pick: String, _ labels: [String], _ matches: [Int]) -> String {
  (matches.isEmpty ? "None" : "More than one") + " of the browser's suggestions match \"" + masked(pick) + "\"; it offers: " + labels.map(masked).joined(separator: "; ")
}

func fill(_ pid: pid_t, _ pick: String?) {
  if !AXIsProcessTrusted() { fail("Accessibility is off for the app this runs under") }
  let app = AXUIElementCreateApplication(pid)
  // A browser that refuses Accessibility shows no suggestions to find: say so, not "nothing offered".
  // Seen when Chrome was updated on disk while it ran (it answers every request API-disabled until
  // relaunched), so a fresh copy of the app answers and the running one doesn't.
  var role: CFTypeRef?
  let answer = AXUIElementCopyAttributeValue(app, "AXRole" as CFString, &role)
  if answer != .success {
    fail("The browser isn't answering Accessibility (error \(answer.rawValue)), so its suggestions can't be opened; if it was updated while running, relaunch it")
  }
  // Chromium shows its pages' accessibility only to clients that ask.
  AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  for _ in 0..<3 {
    if !suggestions(app).isEmpty { break }
    press(app, DOWN)
    _ = waitFor(1.5) { !suggestions(app).isEmpty }
  }
  let found = suggestions(app)
  let shown = Date()
  if found.isEmpty { fail("The browser offered nothing for that field") }
  let labels = found.map { $0.1 }
  guard let pick = pick else {
    press(app, ESCAPE)
    out(["labels": labels])
    return
  }
  let matches = matching(pick, labels)
  guard matches.count == 1, let i = matches.first else {
    press(app, ESCAPE)
    fail(mismatch(pick, labels, matches))
  }
  // The browser ignores a pick that comes too soon after its suggestions open.
  let wait = 0.8 + shown.timeIntervalSinceNow
  if wait > 0 { usleep(useconds_t(wait * 1_000_000)) }
  let taken = (0..<2).contains { _ in choose(found[i].0) && waitFor(1.5) { suggestions(app).isEmpty } }
  if !taken {
    press(app, ESCAPE)
    fail("The browser didn't take the suggestion")
  }
  out(["labels": labels, "chose": labels[i]])
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "fill":
  let raw = args.count > 2 ? args[2] : "{}"
  let given = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any] ?? [:]
  guard let pid = given["pid"] as? Int else { fail("No pid") }
  fill(pid_t(pid), given["pick"] as? String)
case "match":
  let raw = args.count > 2 ? args[2] : "{}"
  let given = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any] ?? [:]
  let pick = given["pick"] as? String ?? ""
  let labels = given["labels"] as? [String] ?? []
  let matches = matching(pick, labels)
  guard matches.count == 1, let i = matches.first else { fail(mismatch(pick, labels, matches)) }
  out(["index": i, "chose": labels[i]])
default:
  fail("No such op")
}
`
