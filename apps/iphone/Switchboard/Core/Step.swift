import Foundation

/// A tool call as a step a person can read: "Searched Google for “costco orders”", "Ran `ls ~/code`
/// on studio", "Read `Views/List.swift`". Known tools get their own wording; an app's tool reads
/// from its verb and its first argument; anything else falls back to its name. Desktop's
/// brain/step.ts.
enum Step {
  /// A piece of a step's wording: words, or a command, path, query or address shown as code.
  struct Part: Hashable {
    let text: String
    var code = false
  }

  private typealias Input = [String: JSON]

  private static func words(_ text: String) -> Part { Part(text: text) }

  /// One line of at most `max` characters, home folders as `~`.
  private static func short(_ value: String, _ max: Int) -> String {
    let line = value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
      .replacingOccurrences(of: #"/Users/[^/\s]+"#, with: "~", options: .regularExpression)
    return line.count > max ? String(line.prefix(max)) + "…" : line
  }

  private static func code(_ value: String) -> Part { Part(text: short(value, 90), code: true) }

  /// A file as a step names it: its folder and its name (`~/code/app/Views/List.swift` is
  /// `Views/List.swift`); a short path stays whole.
  private static func file(_ path: String) -> Part {
    var trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
    while trimmed.hasSuffix("/") { trimmed.removeLast() }
    let parts = trimmed.components(separatedBy: "/")
    return parts.count > 2 ? code(parts.suffix(2).joined(separator: "/")) : code(path)
  }

  /// Quoted words, cut to `max`.
  private static func quoted(_ value: String, _ max: Int = 100) -> String { "“\(short(value, max))”" }

  /// The first of `keys` the input has as words.
  private static func field(_ input: Input, _ keys: String...) -> String {
    for key in keys {
      let v = (input[key] ?? .null).str.trimmingCharacters(in: .whitespacesAndNewlines)
      if !v.isEmpty { return v }
    }
    return ""
  }

  private static func rec(_ j: JSON?) -> Input { (j ?? .null).object }

  /// A web address as a person says it: its host, and its path when there's one.
  private static func site(_ url: String) -> String {
    guard let u = URL(string: url), let host = u.host() else { return url }
    let bare = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    let port = u.port.map { ":\($0)" } ?? ""
    let path = u.path()
    return path.isEmpty || path == "/" ? bare + port : bare + port + path
  }

  /// An app's name as a person says it: "uber-courier" is "Uber courier".
  private static func named(_ app: String) -> String {
    let spaced = app.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
    return spaced.prefix(1).uppercased() + spaced.dropFirst()
  }

  /// The longest of `apps` that `name` starts with, then one of `after`.
  private static func appIn(_ name: String, _ apps: [String], _ after: String...) -> String? {
    apps.filter { a in after.contains { name.hasPrefix(a + $0) } }.max { $0.count < $1.count }
  }

  /// Where a tool ran: an app, and the machine its instance is on ("macos-studio" is macos on
  /// studio) when `apps` knows the app.
  private struct At {
    let app: String
    let machine: String
  }

  private static func atOf(_ instance: String, _ apps: [String]) -> At {
    guard let app = appIn(instance, apps, "-") else { return At(app: instance, machine: "") }
    return At(app: app, machine: String(instance.dropFirst(app.count + 1)))
  }

  private static func on(_ at: At) -> [Part] { at.machine.isEmpty ? [] : [words(" on \(at.machine)")] }

  private static func target(_ s: Input) -> String { field(s, "match", "text", "selector", "label") }

  /// A browser step (`op`), with what it acted on; nil when it says nothing.
  private static let browser: [String: @MainActor (Input) -> [Part]?] = [
    "open": { s in field(s, "url").isEmpty ? nil : [words("Opened "), code(site(field(s, "url")))] },
    "click": { s in target(s).isEmpty ? nil : [words("Clicked \(quoted(target(s), 60))")] },
    "fill": { s in [words(target(s).isEmpty ? "Filled in a field" : "Filled in \(quoted(target(s), 60))")] },
    "read": { _ in [words("Read the page")] },
    "js": { _ in [words("Ran a script on the page")] },
    "screenshot": { _ in [words("Took a screenshot")] },
  ]
  private static let browserAlso = [
    "goto": "open", "navigate": "open", "type": "fill", "text": "read", "snapshot": "read", "eval": "js", "shot": "screenshot",
  ]

  /// What an app's verb did, given its input.
  private typealias Verb = @MainActor (Input, At) -> [Part]

  private static let searched: Verb = { input, at in
    let query = field(input, "query", "q", "text", "term", "pattern", "search")
    let app = named(at.app)
    return [words(query.isEmpty ? "Searched \(app)" : "Searched \(app) for \(quoted(query))")] + on(at)
  }
  private static let ran: Verb = { input, at in
    let argv = (input["argv"] ?? .null).array.map(\.str).joined(separator: " ")
    let given = field(input, "command", "cmd")
    let command = given.isEmpty ? argv : given
    return [words("Ran "), command.isEmpty ? words("a command") : code(command)] + on(at)
  }
  private static let readIt: Verb = { input, at in
    let path = field(input, "path", "file_path", "file")
    return path.isEmpty ? [words("Read \(named(at.app))")] : [words("Read "), file(path)] + on(at)
  }
  private static let listed: Verb = { input, at in
    let path = field(input, "path")
    return (path.isEmpty ? [words("Listed \(named(at.app))")] : [words("Listed "), code(path)]) + on(at)
  }
  private static let checked: Verb = { _, at in [words("Checked \(named(at.app))")] + on(at) }
  private static let pictured: Verb = { _, at in [words("Took a picture with \(named(at.app))")] + on(at) }

  private static let verbs: [String: Verb] = [
    "exec": ran, "run": ran, "shell": ran,
    "search": searched, "find": searched, "lookup": searched, "query": searched,
    "read": readIt, "read_file": readIt,
    "write_file": { input, at in
      let path = field(input, "path", "file_path")
      return [words("Wrote "), file(path.isEmpty ? "a file" : path)] + on(at)
    },
    "list": listed, "list_files": listed,
    "open": { input, at in
      let url = field(input, "url", "link")
      return [words("Opened "), url.isEmpty ? words(named(at.app)) : code(site(url))] + on(at)
    },
    "screenshot": pictured, "shot": pictured, "snap": pictured, "camera": pictured,
    "status": checked, "health": checked, "check": checked, "state": checked, "get_state": checked,
  ]

  /// Verbs whose step is the verb done to the app, or to what it was given.
  private static let past = [
    "install": "Installed", "update": "Updated", "remove": "Removed", "start": "Started", "stop": "Stopped",
    "restart": "Restarted", "send": "Sent", "print": "Printed", "order": "Ordered", "cancel": "Cancelled",
    "approve": "Approved", "merge": "Merged", "deploy": "Deployed", "render": "Rendered", "slice": "Sliced",
    "label": "Labeled", "book": "Booked", "quote": "Got a quote from", "checkout": "Checked out on", "call": "Called",
    "notify": "Notified", "connect": "Connected", "disconnect": "Disconnected", "show": "Showed",
  ]

  /// A browser-like action's first step (`op`, or the first of its `steps`), and how many more.
  private static func browsed(_ verb: String, _ input: Input, _ at: At) -> [Part]? {
    let steps = (input["steps"] ?? .null).array.map(\.object)
    let first = steps.first ?? input
    let given = field(input, "op", "action")
    let op = given.isEmpty ? (first["op"] ?? .null).str : given
    guard !op.isEmpty, op != verb, let done = browser[browserAlso[op] ?? op]?(first) else { return nil }
    let more = steps.count > 1 ? [words(" and \(steps.count - 1) more")] : []
    return done + more + on(at)
  }

  /// An app's action by its verb, with what it was given; nil when the verb says nothing known.
  private static func action(_ verb: String, _ input: Input, _ at: At) -> [Part]? {
    if let b = browsed(verb, input, at) { return b }
    if let known = verbs[verb] { return known(input, at) }
    guard let did = past[verb] else { return nil }
    let what = field(input, "query", "title", "name", "id")
    let app = named(at.app)
    return [words("\(did) \(what.isEmpty ? app : "\(app) \(quoted(what, 60))")")] + on(at)
  }

  /// A tool nobody wrote wording for: its name, and its first argument.
  private static func fallback(_ name: String, _ input: Input, _ at: At? = nil) -> [Part] {
    let first = input.keys.sorted().compactMap { input[$0]?.string }.first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    return [words(named(name.trimmingCharacters(in: .whitespaces)))] + (first.map { [words(" "), code($0)] } ?? [])
      + (at.map(on) ?? [])
  }

  private static func gist(_ input: Input, _ max: Int = 100) -> String {
    short(field(input, "text", "what", "lesson", "title", "summary"), max)
  }

  private static func or(_ value: String, _ instead: String) -> String { value.isEmpty ? instead : value }

  /// A space as a tool was given it, by id or name.
  private static func spaceIn(_ input: Input, _ key: String = "space") -> String { quoted(or(field(input, key), "a space"), 40) }

  /// A tapback as iMessage says it: "Loved your message"; none takes one back.
  private static let tapback = [
    "love": "Loved", "like": "Liked", "dislike": "Disliked", "laugh": "Laughed at", "emphasize": "Emphasized",
    "question": "Questioned",
  ]

  /// An extension as a tool was given it, as code.
  private static func extensionIn(_ input: Input) -> Part { code(or(field(input, "extension", "source", "name"), "?")) }

  /// Switch's own apps' tools (the gateway's), by name: old Switchboard's wording where it had the
  /// tool (its brain tool's say, ask, follow, dismiss), else the same way: what it did, past tense,
  /// with what it was given. `output` is what came back, where it names the step. Desktop's own.
  private static let own: [String: @MainActor (Input, String) -> [Part]] = [
    "brain_query": { i, _ in [words("Looked through the brain's \(or(field(i, "from"), "events"))")] },
    "brain_post": { i, _ in [words("Said in \(or(field(i, "space"), "a space")): \(gist(i, 80))")] },
    "brain_react": { i, _ in
      let emoji = field(i, "emoji")
      if !emoji.isEmpty { return [words("Reacted \(emoji) to your message")] }
      return [words(tapback[field(i, "reaction")].map { "\($0) your message" } ?? "Took back a reaction")]
    },
    "brain_user": { _, _ in [words("Read who you are")] },
    "brain_describe_user": { _, _ in [words("Updated who you are")] },
    "brain_spaces": { _, _ in [words("Listed the spaces")] },
    "brain_create_space": { i, _ in [words("Made the space \(quoted(field(i, "name"), 40))")] },
    "brain_rename_space": { i, _ in [words("Renamed \(spaceIn(i)) to \(quoted(field(i, "name"), 40))")] },
    "brain_move_space": { i, _ in
      [words(field(i, "parent").isEmpty ? "Moved \(spaceIn(i)) to the top" : "Moved \(spaceIn(i)) into \(spaceIn(i, "parent"))")]
    },
    "brain_archive_space": { i, _ in [words(i["undo"]?.bool == true ? "Opened \(spaceIn(i)) again" : "Archived \(spaceIn(i))")] },
    "brain_move_exchange": { i, _ in [words("Moved an exchange to \(spaceIn(i))")] },
    "brain_remove_message": { i, _ in
      [words(i["undo"]?.bool == true ? "Put a message back in \(spaceIn(i))" : "Removed a message from \(spaceIn(i))")]
    },
    "brain_widgets": { _, _ in [words("Listed the widgets")] },
    "brain_show_widget": { i, _ in
      [words("Showed \(field(i, "title").isEmpty ? named(or(field(i, "app"), "a widget")) : quoted(field(i, "title"), 40))")]
    },
    "brain_preview_html": { _, _ in [words("Previewed a page")] },
    "brain_publish": { i, _ in
      [words(i["retired"]?.bool == true ? "Took down a page" : "Published \(field(i, "title").isEmpty ? "a page" : quoted(field(i, "title"), 40))")]
    },
    "brain_pages": { _, _ in [words("Listed the pages")] },
    "brain_place_widget": { i, _ in [words("Placed \(named(or(field(i, "app"), "a widget")))")] },
    "brain_remove_widget": { i, _ in [words("Took down \(named(or(field(i, "app"), "a widget")))")] },
    "brain_folder": { i, _ in
      field(i, "path").isEmpty
        ? [words("Cleared the folder of \(spaceIn(i))")]
        : [words("Set the folder of \(spaceIn(i)) to "), code(field(i, "path"))]
    },
    "brain_folders": { _, _ in [words("Listed the folders")] },
    "autonomy_say": { i, output in
      let repeated = output.range(of: #""said":\s*false"#, options: .regularExpression) != nil
      return [words((repeated ? "Didn't repeat: " : "Said: ") + short(field(i, "text"), 120))]
    },
    "autonomy_nothing": { i, _ in
      [words(field(i, "note").isEmpty ? "Said nothing" : "Said nothing: \(short(field(i, "note"), 120))")]
    },
    "autonomy_expect": { i, _ in [words("\(i["drop"]?.bool == true ? "Stopped expecting" : "Will look again"): \(gist(i))")] },
    "autonomy_wait": { _, _ in [words("Waited")] },
    "autonomy_surprise": { i, _ in [words(i["dismiss"]?.bool == true ? "Took down a surprise" : "Flagged: \(gist(i))")] },
    "autonomy_remember": { i, _ in [words("Remembered: \(gist(i))")] },
    "autonomy_action_item": { i, _ in
      let asking = or(gist(i, 140), short(field(rec(i["ask"]), "title"), 140))
      return [words((asked[field(i, "kind")] ?? "Asked you: ") + asking)]
    },
    "autonomy_close_item": { i, _ in
      let why = field(i, "why").isEmpty ? "" : ": \(short(field(i, "why"), 120))"
      return [words((field(i, "status") == "done" ? "Closed an ask" : "Dismissed an ask") + why)]
    },
    "autonomy_follow_item": { i, _ in
      [words(i["follow"]?.bool == false ? "Stopped waiting on an ask" : "Waiting on an item in your queue")]
    },
    "autonomy_wake_rule": { i, _ in
      [words(i["retired"]?.bool == true ? "Retired the wake rule " : "Set the wake rule "), code(or(field(i, "name"), "?"))]
    },
    "autonomy_setting": { i, _ in
      guard !field(i, "key").isEmpty else { return [words("Read the dials")] }
      let given = i["value"] ?? .null
      return [words("Set "), code(field(i, "key")), words(" to \(given.number == nil ? quoted(given.str, 40) : given.str)")]
    },
    "autonomy_cover": { i, _ in [words("\(field(i, "image").isEmpty ? "Cleared" : "Set") the cover of \(spaceIn(i))")] },
    "autonomy_image": { i, _ in [words("Drew \(quoted(field(i, "prompt"), 40))")] },
    "inbox_inbox": { _, _ in [words("Read the inbox")] },
    "inbox_thread": { i, _ in
      [words(field(i, "with").isEmpty ? "Read a conversation" : "Read the conversation with \(quoted(field(i, "with"), 40))")]
    },
    "iphone_notify": { i, _ in [words("Notified your iPhone: \(short(field(i, "title", "body"), 80))")] },
    "iphone_live_activity_start": { i, _ in [words("Started a Live Activity: \(quoted(field(i, "title"), 60))")] },
    "iphone_live_activity_update": { i, _ in
      [words(field(i, "title").isEmpty ? "Updated a Live Activity" : "Updated a Live Activity: \(quoted(field(i, "title"), 60))")]
    },
    "iphone_live_activity_end": { _, _ in [words("Ended a Live Activity")] },
    "iphone_wallet_issue_pass": { i, _ in [words("Issued a Wallet pass: \(quoted(field(i, "title"), 60))")] },
    "iphone_wallet_bundle": { i, _ in
      let serials = (i["serials"] ?? .null).array
      return [words("Bundled \(serials.isEmpty ? "the" : String(serials.count)) Wallet passes")]
    },
    "iphone_wallet_check": { i, _ in [words("Checked the Wallet pass "), file(or(field(i, "pass"), "?"))] },
    "iphone_wallet_check_link": { i, _ in [words("Checked the Wallet passes at "), code(site(or(field(i, "link"), "?")))] },
    "desktop_screenshot": { _, _ in [words("Took a screenshot of Switchboard")] },
    "desktop_notify": { i, _ in [words("Notified your Mac: \(short(field(i, "title", "body"), 80))")] },
    "skills_read": { i, _ in [words("Read the \(or(field(i, "name"), "a")) skill")] },
    "extensions_list": { _, _ in [words("Listed the extensions")] },
    "extensions_install": { i, _ in
      [words("Installed the extension "), extensionIn(i)] + (field(i, "machine").isEmpty ? [] : [words(" on \(field(i, "machine"))")])
    },
    "extensions_update": { i, _ in [words("Updated the extension "), extensionIn(i)] },
    "extensions_remove": { i, _ in [words("Removed the extension "), extensionIn(i)] },
    "extensions_place": { i, _ in
      [words("Moved the extension "), extensionIn(i), words(" to \(or(field(i, "machine"), "another machine"))")]
    },
    "accounts_list": { _, _ in [words("Listed the accounts")] },
    "accounts_add": { i, _ in [words("Added the \(or(field(i, "provider"), "provider")) account "), code(or(field(i, "id"), "?"))] },
    "accounts_sign_in": { i, _ in [words("Started signing in "), code(or(field(i, "id"), "an account"))] },
    "accounts_remove": { i, _ in [words("Removed the account "), code(or(field(i, "id"), "?"))] },
    "connections_list": { _, _ in [words("Listed the connections")] },
    "connections_request": { i, _ in [words("Asked to connect \(or(field(i, "kind", "provider", "name"), "an account"))")] },
    "connections_save": { i, _ in
      [words("Saved a \(or(field(i, "provider"), "provider")) key from "), file(or(field(i, "file"), "a file"))]
    },
    "connections_connect": { i, _ in [words("Opened \(or(field(i, "provider"), "a provider"))'s sign-in")] },
    "connections_recover": { i, _ in [words("Refreshed the \(or(field(i, "provider"), "provider")) connection")] },
    "connections_verify": { i, _ in [words("Checked the \(or(field(i, "provider"), "provider")) sign-in")] },
    "connections_readiness": { i, _ in [words("Checked how \(or(field(i, "provider"), "a provider")) connects")] },
    "connections_client": { i, _ in [words("Kept the \(or(field(i, "provider"), "provider")) OAuth client")] },
    "connections_disconnect": { _, _ in [words("Disconnected an account")] },
  ]

  /// A string field from pretty-printed JSON that may be cut short, `depth` levels in (0 is the
  /// record itself, 1 its body): old Switchboard's `json_text`.
  private static func jsonText(_ text: String, _ key: String, _ depth: Int) -> String {
    let needle = "\n" + String(repeating: "  ", count: depth + 1) + "\"\(key)\": \""
    guard let at = text.range(of: needle) else { return "" }
    var value = ""
    var escaped = false
    for c in text[at.upperBound...] {
      if escaped {
        value.append(c)
        escaped = false
      } else if c == "\\" {
        escaped = true
      } else if c == "\"" {
        return value
      } else {
        value.append(c)
      }
    }
    return ""
  }

  /// What a record read back is called: its kind and its title or gist.
  private static func readBack(_ output: String) -> String {
    let kind = jsonText(output, "kind", 0)
    let name = ["title", "summary", "statement", "text"].map { jsonText(output, $0, 1) }.first { !$0.isEmpty }
    if !kind.isEmpty, let name { return "Read the \(kind) \(quoted(name, 80))" }
    return kind.isEmpty ? "Read a record" : "Read a \(kind)"
  }

  /// How an ask's step leads, by its kind.
  private static let asked = ["approval": "Asked for your approval: ", "task": "Asked you to "]

  /// What was done to something to look at: taken down, changed, published or made.
  private static func made(_ i: Input) -> String {
    if i["retired"]?.bool == true { return "Took down" }
    if i["id"] != nil { return "Updated" }
    return i["link"]?.bool == true ? "Published" : "Made"
  }

  /// Old Switchboard's brain tool, by its op; `output` is what came back, where it names the step.
  private static let legacy: [String: @MainActor (Input, String) -> [Part]] = [
    "task": { i, _ in
      i["work"] == nil
        ? [words("Started: \(short(or(field(i, "title"), "a task"), 120))")]
        : [words("Steered a task: \(short(field(i, "text"), 120))")]
    },
    "ask": { i, _ in
      let first = field(i, "text").components(separatedBy: "\n").first ?? ""
      return [words((asked[field(i, "type")] ?? "Asked you: ") + short(first, 140))]
    },
    "follow": { i, _ in
      [words(field(i, "text").isEmpty ? "Waiting on an item in your queue" : "Waiting on your queue: \(short(field(i, "text"), 120))")]
    },
    "dismiss": { i, _ in
      [words((i["entirely"]?.bool == true ? "Dismissed an ask: " : "Stopped waiting on an ask: ") + short(field(i, "why"), 120))]
    },
    "report": { i, _ in [words("Reported: \(short(field(i, "takeaway"), 120))")] },
    "say": { i, output in [words((output.hasPrefix("Not said") ? "Didn't repeat: " : "Said: ") + short(field(i, "text"), 120))] },
    "object": { i, output in
      let title = or(field(i, "title"), output.components(separatedBy: "\"").dropFirst().first ?? "")
      return [words("\(made(i)) \(title.isEmpty ? "an object" : quoted(title, 100))")]
    },
    "search": { i, _ in [words("Searched the brain for "), code(field(i, "text"))] },
    "query": { i, _ in [words("Queried "), code(field(i, "query"))] },
    "recent": { i, _ in [words("Read the latest in "), code(or(field(i, "stream"), "a stream"))] },
    "read": { i, output in
      let id = field(i, "id")
      if id.hasPrefix("work/") { return [words("Read a work")] }
      if id.contains(":") { return [words("Looked up "), code(id)] }
      return [words(readBack(output))]
    },
    "zoom": { _, _ in [words("Opened a summary")] },
    "expect": { i, _ in
      i["retired"]?.bool == true ? fallback("brain", i) : [words("Will look again: \(short(field(i, "statement"), 100))")]
    },
    "wait": { _, _ in [words("Waited")] },
    "record": { i, _ in
      let body = rec(i["body"])
      switch field(i, "kind") {
      case "observation": return [words("Noted: \(short(or(field(body, "summary", "entity"), "something"), 120))")]
      case "note": return [words("Noted: \(short(or(field(body, "text"), "something"), 120))")]
      case let kind: return [words("Recorded a \(or(kind, "record")) in "), code(or(field(i, "stream"), "the brain"))]
      }
    },
    "request": { i, _ in
      let target = field(i, "target").components(separatedBy: "@")
      let app = target.first ?? ""
      let machine = target.count > 1 ? target[1] : ""
      let at = app == "macos" ? At(app: machine, machine: "") : At(app: app, machine: machine)
      let verb = field(i, "action")
      let args = rec(i["args"])
      return action(verb, args, at) ?? fallback(verb, args, at)
    },
  ]

  private static func ranShell(_ i: Input) -> [Part] {
    let said = field(i, "description")
    return said.isEmpty ? [words("Ran "), code(or(field(i, "command", "cmd"), "a command"))] : [words(short(said, 140))]
  }
  private static func pathOf(_ i: Input) -> String { or(field(i, "file_path", "path", "notebook_path"), "a file") }
  private static func edited(_ i: Input) -> [Part] { [words("Edited "), file(pathOf(i))] }
  private static func plan(_ i: Input) -> [Part] {
    let doing = (i["todos"] ?? .null).array.first { $0["status"].str == "in_progress" }
    return [words(doing.map { short(or($0["activeForm"].str, $0["content"].str), 120) } ?? "Updated the plan")]
  }
  private static func helper(_ i: Input) -> [Part] { [words("Asked a helper to \(short(or(field(i, "description"), "help"), 120))")] }
  private static func toolsFor(_ i: Input) -> [Part] { [words("Looked for tools: \(short(field(i, "query"), 80))")] }

  /// The agent's own tools: Claude Code's, Codex's, the gateway's.
  private static let agent: [String: @MainActor (Input) -> [Part]] = [
    "Bash": ranShell, "exec_command": ranShell, "shell": ranShell, "run_shell_command": ranShell,
    "Read": { i in [words("Read "), file(pathOf(i))] },
    "Write": { i in [words("Wrote "), file(pathOf(i))] },
    "Edit": edited, "MultiEdit": edited, "NotebookEdit": edited,
    "Glob": { i in [words("Found files matching "), code(or(field(i, "pattern"), "*"))] },
    "Grep": { i in [words("Searched for "), code(field(i, "pattern"))] },
    "LS": { i in [words("Listed "), code(or(field(i, "path"), "."))] },
    "WebSearch": { i in [words("Searched the web for \(quoted(field(i, "query")))")] },
    "WebFetch": { i in [words("Read "), code(site(or(field(i, "url"), "a page")))] },
    "TodoWrite": plan,
    "Task": helper, "Agent": helper,
    "ToolSearch": toolsFor, "search_tools": toolsFor,
    "delegate_task": { i in [words("Started: \(short(field(i, "title", "task"), 120))")] },
    "task_steer": { i in [words("Steered a task: \(short(field(i, "text"), 120))")] },
    "task_status": { _ in [words("Checked on a task")] },
    "task_cancel": { _ in [words("Stopped a task")] },
    "task_stage": { i in [words("Stage: \(short(field(i, "stage"), 40))")] },
    "Skill": { i in [words("Read the \(or(field(i, "skill", "name"), "a")) skill")] },
  ]

  /// An app's tool, `<app>_<verb>` (the app's instance may name its machine).
  private static func appTool(_ tool: String, _ input: Input, _ apps: [String], _ output: String) -> [Part] {
    if let known = own[tool] { return known(input, output) }
    let app = appIn(tool, apps, "_", "-")
    let from = tool.index(tool.startIndex, offsetBy: app?.count ?? 0)
    guard let cut = tool[from...].firstIndex(of: "_"), cut > tool.startIndex else { return fallback(tool, input) }
    let at = atOf(String(tool[..<cut]), apps)
    let verb = String(tool[tool.index(after: cut)...])
    return action(verb, input, at) ?? fallback("\(at.app) \(verb)", input, at)
  }

  /// A tool call, as a step. `name` is the tool as the host recorded it: the agent's own, the
  /// gateway's (`mcp__<server>__<tool>`, an app's through `call_tool`), or old Switchboard's
  /// (`brain`, `<appendage>__<action>`). `apps` are the installed apps' names (`Brain.appNames`),
  /// to tell an app from the machine its instance runs on.
  static func describe(_ name: String, _ input: JSON, apps: [String], output: String = "") -> [Part] {
    let given = input.object
    if name.hasPrefix("mcp__") {
      let tool = name.components(separatedBy: "__").dropFirst(2).joined(separator: "__")
      if tool == "call_tool" { return appTool(field(given, "name"), rec(given["arguments"]), apps, output) }
      return agent[tool]?(given) ?? appTool(tool, given, apps, output)
    }
    if name == "brain" { return legacy[field(given, "op")]?(given, output) ?? fallback("brain", given) }
    if let own = agent[name] { return own(given) }
    let split = name.components(separatedBy: "__")
    if split.count > 1 {
      let at = atOf(split[0], apps)
      return action(split[1], given, at) ?? fallback(split[1], given, at)
    }
    return fallback(name, given)
  }

  /// Each verb's icon, as old Switchboard's iPhone app drew its steps (SF Symbols).
  private static let verbIcons = [
    "exec": "terminal", "run": "terminal", "shell": "terminal",
    "search": "magnifyingglass", "find": "magnifyingglass", "lookup": "magnifyingglass", "query": "magnifyingglass",
    "read": "doc.text", "read_file": "doc.text", "write_file": "square.and.pencil",
    "list": "folder", "list_files": "folder", "transfer_file": "paperplane", "open": "globe", "ui": "cursorarrow.click",
    "moment": "eye", "screenshot": "camera", "shot": "camera", "snap": "camera", "camera": "camera",
    "status": "eye", "health": "eye", "check": "eye", "state": "eye", "get_state": "eye",
    "install": "person.2", "update": "person.2", "remove": "person.2", "start": "person.2", "stop": "person.2",
    "restart": "person.2",
  ]
  private static let browserIcons = [
    "open": "globe", "goto": "globe", "navigate": "globe", "click": "cursorarrow.click", "fill": "cursorarrow.click",
    "type": "cursorarrow.click", "read": "globe", "text": "globe", "snapshot": "globe", "js": "terminal", "eval": "terminal",
    "screenshot": "camera", "shot": "camera",
  ]
  private static let ownIcons = [
    "brain_query": "cylinder", "brain_post": "text.bubble", "brain_react": "text.bubble", "brain_user": "book",
    "brain_describe_user": "square.and.pencil", "brain_spaces": "square.grid.2x2", "brain_create_space": "square.grid.2x2",
    "brain_rename_space": "square.grid.2x2", "brain_move_space": "square.grid.2x2", "brain_archive_space": "square.grid.2x2",
    "brain_move_exchange": "square.grid.2x2", "brain_remove_message": "square.grid.2x2", "brain_widgets": "square.grid.2x2", "brain_show_widget": "square.grid.2x2",
    "brain_publish": "square.grid.2x2", "brain_pages": "square.grid.2x2", "brain_place_widget": "square.grid.2x2", "brain_remove_widget": "square.grid.2x2", "brain_folder": "folder",
    "brain_folders": "folder", "autonomy_say": "text.bubble", "autonomy_nothing": "text.bubble", "autonomy_expect": "eye",
    "autonomy_wait": "eye", "autonomy_surprise": "bolt", "autonomy_remember": "brain", "autonomy_action_item": "tray",
    "autonomy_close_item": "tray", "autonomy_follow_item": "eye", "autonomy_wake_rule": "eye", "autonomy_setting": "gearshape",
    "autonomy_cover": "camera", "autonomy_image": "camera", "inbox_inbox": "tray", "inbox_thread": "text.bubble", "iphone_notify": "bell",
    "iphone_live_activity_start": "bell", "iphone_live_activity_update": "bell", "iphone_live_activity_end": "bell",
    "iphone_wallet_issue_pass": "paperplane", "iphone_wallet_bundle": "paperplane", "iphone_wallet_check": "eye",
    "iphone_wallet_check_link": "eye", "desktop_screenshot": "camera", "desktop_notify": "bell", "skills_read": "book",
    "extensions_list": "person.2", "extensions_install": "person.2", "extensions_update": "person.2",
    "extensions_remove": "person.2", "extensions_place": "person.2", "accounts_list": "gearshape", "accounts_add": "gearshape",
    "accounts_sign_in": "gearshape", "accounts_remove": "gearshape", "connections_list": "gearshape",
    "connections_request": "gearshape", "connections_save": "gearshape", "connections_connect": "gearshape",
    "connections_recover": "gearshape", "connections_verify": "gearshape", "connections_readiness": "gearshape",
    "connections_client": "gearshape", "connections_disconnect": "gearshape",
  ]
  private static let legacyIcons = [
    "ask": "tray", "follow": "eye", "dismiss": "tray", "report": "doc.text", "say": "text.bubble", "object": "square.grid.2x2",
    "search": "magnifyingglass", "query": "cylinder", "recent": "book", "read": "book", "zoom": "book", "expect": "eye",
    "wait": "eye", "record": "note.text",
  ]
  private static let agentIcons = [
    "Bash": "terminal", "exec_command": "terminal", "shell": "terminal", "run_shell_command": "terminal",
    "Read": "doc.text", "Write": "square.and.pencil", "Edit": "square.and.pencil", "MultiEdit": "square.and.pencil",
    "NotebookEdit": "square.and.pencil", "Glob": "folder", "Grep": "magnifyingglass", "LS": "folder",
    "WebSearch": "globe", "WebFetch": "globe", "TodoWrite": "checklist", "Task": "person.2", "Agent": "person.2",
    "ToolSearch": "magnifyingglass", "search_tools": "magnifyingglass", "delegate_task": "wrench.and.screwdriver",
    "task_steer": "arrow.turn.down.right", "task_status": "eye", "task_cancel": "stop", "task_stage": "checklist",
    "Skill": "book",
  ]

  /// An app's verb's icon: its browser step's, its own, or a bolt.
  private static func verbIcon(_ verb: String, _ input: Input) -> String {
    let steps = (input["steps"] ?? .null).array.map(\.object)
    let given = field(input, "op", "action")
    let op = given.isEmpty ? ((steps.first ?? input)["op"] ?? .null).str : given
    if !op.isEmpty, op != verb, let icon = browserIcons[op] { return icon }
    return verbIcons[verb] ?? "bolt"
  }

  /// A step's icon, as old Switchboard drew it: by the tool, the brain's op or the app's verb.
  static func icon(_ name: String, _ input: JSON) -> String {
    let given = input.object
    if name.hasPrefix("mcp__") {
      let tool = name.components(separatedBy: "__").dropFirst(2).joined(separator: "__")
      let called = tool == "call_tool" ? field(given, "name") : tool
      if let icon = agentIcons[called] ?? ownIcons[called] { return icon }
      let args = tool == "call_tool" ? rec(given["arguments"]) : given
      // The app's verb: the longest that ends its tool's name.
      let verb = verbIcons.keys.filter { called.hasSuffix("_" + $0) }.max { $0.count < $1.count } ?? ""
      return verbIcon(verb, args)
    }
    if name == "brain" {
      let op = field(given, "op")
      if op == "task" { return given["work"] == nil ? "wrench.and.screwdriver" : "arrow.turn.down.right" }
      if op == "request" { return verbIcon(field(given, "action"), rec(given["args"])) }
      return legacyIcons[op] ?? "bolt"
    }
    if let icon = agentIcons[name] { return icon }
    let split = name.components(separatedBy: "__")
    return split.count > 1 ? verbIcon(split[1], given) : "bolt"
  }

  /// A step's words, as one line.
  static func text(_ parts: [Part]) -> String { parts.map(\.text).joined() }

  /// The live step of a running thread, from its latest call still under way.
  static func live(_ t: ThreadRow, apps: [String]) -> String {
    var completed: Set<String> = []
    for item in t.items.reversed() {
      guard item.turn == t.turn else { break }
      if item.kind == .result { completed.insert(item.call) }
      if item.kind == .tool, !completed.contains(item.call) {
        let step = text(describe(item.name, item.input, apps: apps))
        if !step.isEmpty { return step }
      }
    }
    return t.streaming.isEmpty ? "" : "Writing"
  }
}
