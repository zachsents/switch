import SwiftUI

/// What a space's page shows, read from the brain (apps/desktop/src/mainview/brain/derive.ts).
extension Brain {
  var live: [Space] { spaces.values.filter { !$0.archived } }

  /// The space and every space under it.
  func subtree(_ id: String) -> Set<String> {
    var out: Set<String> = [id]
    var grew = true
    while grew {
      grew = false
      for x in spaces.values where x.parent.map(out.contains) == true && !out.contains(x.id) {
        out.insert(x.id)
        grew = true
      }
    }
    return out
  }

  /// The spaces above, from Home down, without the space itself.
  func above(_ id: String) -> [Space] {
    var out: [Space] = []
    var seen: Set<String> = []
    var at = spaces[id]?.parent.flatMap { spaces[$0] }
    while let x = at, seen.insert(x.id).inserted {
      out.insert(x, at: 0)
      at = x.parent.flatMap { spaces[$0] }
    }
    return out
  }

  /// Which space a thread works in: its own tag, else its parent's, else Home.
  func spaceOf(_ thread: ThreadRow) -> String {
    var seen: Set<String> = []
    var at: ThreadRow? = thread
    while let t = at, seen.insert(t.id).inserted {
      if let home = t.home { return home }
      at = t.parent.flatMap { threads[$0] }
    }
    return HOME
  }

  /// Switch's own apps, whose tools a turn calls through the gateway.
  private static let ownApps = ["brain", "autonomy", "skills", "connections", "extensions", "accounts", "inbox", "iphone"]

  /// The apps a turn's tools may come from: Switch's own and the installed extensions.
  var appNames: [String] { Self.ownApps + extensions.sorted() }

  struct Work: Identifiable {
    let thread: ThreadRow
    let space: String
    let step: String
    var id: String { thread.id }
  }

  /// A task the agent set going, as `task-…`; not a space's chat, nor the core's own threads (a
  /// one-shot model call's `run-…` "Completion", a check's fix turn, a reflection), which aren't
  /// work of the user's (the user, Nov 23: "idk what 'completion' is").
  static func isTask(_ t: ThreadRow) -> Bool { t.id.hasPrefix("task-") }

  /// Tasks under way in the space itself, not the spaces under it, oldest first. A space's own
  /// chat turn isn't one: the chat shows it typing instead (DESIGN.md, Running), unlike
  /// Switchboard's Running, which counted chat work too (core/src/places.rs:370-372). A turn the
  /// senses woke isn't work under way for them (core/src/places.rs:93). Work that stopped short
  /// isn't shown: its end wakes the work that started it, which fixes it or asks (the user, Nov 23:
  /// "i wanna be messaged or shown what i'm actually needed for as a human being").
  func work(_ id: String) -> [Work] {
    let apps = appNames
    return threads.values
      // Only a turn under way now; waiting work (a watch or a script still open) isn't running.
      .filter { spaceOf($0) == id && Self.isTask($0) && $0.status == "running" && !$0.sensed }
      .map { Work(thread: $0, space: id, step: Step.live($0, apps: apps)) }
      .sorted { $0.thread.since < $1.thread.since }
  }

  /// When the space's chat turn answering the user started, while it works: the chat shows it
  /// typing until its reply lands. A turn with none of their words in it isn't answering them.
  func typingSince(_ id: String) -> Double? {
    guard let t = threads["space:\(id)"], t.status == "running", !t.woken else { return nil }
    return t.since
  }

  /// The space's chat turn answering the user, when it ended with no reply and the user didn't stop
  /// it (it failed, hit a limit, or was cut off; not paused for an update): their last message there
  /// shows Not Delivered, and a tap runs the turn again. "Stopped" is what only their own Stop ends a
  /// turn on; "Paused for an update" is a deploy's pause, which the updated core carries on.
  func undelivered(_ id: String) -> String? {
    guard let t = threads["space:\(id)"], !t.woken else { return nil }
    let unanswered = t.status == "failed" || t.status == "limited"
      || (t.status == "interrupted" && t.result != "Stopped" && t.result != "Paused for an update")
    return unanswered ? t.id : nil
  }

  /// The space's own open asks, not the spaces' under it.
  func actionItems(_ id: String) -> [ActionItem] {
    actions.values.filter { $0.space == id }.sorted { $0.at < $1.at }
  }

  func expectationsIn(_ id: String) -> [Expectation] {
    expectations.values.filter { $0.space == id }.sorted { ($0.by ?? .infinity) < ($1.by ?? .infinity) }
  }

  /// Extensions' long jobs under way in the space itself (their Live Activities), oldest first.
  func activitiesIn(_ id: String) -> [Job] {
    activities.values.filter { $0.space == id && $0.state != "done" }.sorted { $0.startedAt < $1.startedAt }
  }

  func widgetsIn(_ id: String) -> [Placement] { widgets.filter { $0.space == id } }

  private func warmth(_ s: Space) -> Int { warm[s.id] ?? s.made }

  /// The spaces right inside, warmest first.
  func children(_ id: String) -> [Space] {
    live.filter { $0.parent == id && $0.id != id }.sorted { warmth($0) > warmth($1) }
  }

  /// Every space, warmest first, for the palette.
  var warmest: [Space] { live.sorted { warmth($0) > warmth($1) } }

  struct ChatLine: Identifiable {
    let line: Line
    /// The other spaces it bears on, besides this one.
    let also: [String]
    var pending: Pending?
    var id: String { pending?.id ?? String(line.seq) }
  }

  /// A space's chat: what's posted in it or mentions it; then what's sent, unanswered. A turn's
  /// steps, and its words until they're posted, are its thread's, never the chat's.
  func chat(_ id: String) -> [ChatLine] {
    var out = (chats[id]?.lines ?? []).map { line in
      ChatLine(line: line, also: ([line.home] + line.mentions).filter { $0 != id && spaces[$0] != nil })
    }
    let kept = Outbox.shared.posts.compactMap(Pending.init).filter { pending[$0.id] == nil && !arrived.contains($0.id) }
    for p in (kept + pending.values).sorted(by: { $0.time < $1.time }) where p.space == id {
      out.append(ChatLine(line: Line(seq: .max, time: p.time, agent: false, text: p.text, home: id, mentions: [], attachments: p.attachments), also: [], pending: p))
    }
    return out
  }

  /// Whether the space, or one under it, has a reply the user hasn't read.
  func unread(_ id: String) -> Bool {
    subtree(id).contains { spaces[$0]?.archived != true && unreadAt($0) != nil }
  }

  /// A space's live marks, as its row shows them, for it and the spaces under it: running, how many
  /// need the user, unread.
  func marks(_ id: String, now: Double) -> (running: Bool, needs: Int, unread: Bool) {
    let inside = subtree(id)
    return (
      inside.contains { !work($0).isEmpty || !activitiesIn($0).isEmpty },
      inside.reduce(0) { $0 + actionItems($1).count }, unread(id))
  }

  struct Board {
    let running: [Work]
    let activities: [Job]
    let expectations: [Expectation]
    let actions: [ActionItem]
    let children: [Space]
    let widgets: [Placement]

    var isEmpty: Bool {
      running.isEmpty && activities.isEmpty && expectations.isEmpty && actions.isEmpty && children.isEmpty && widgets.isEmpty
    }
  }

  func board(_ id: String, now: Double) -> Board {
    Board(
      running: work(id), activities: activitiesIn(id), expectations: expectationsIn(id), actions: actionItems(id),
      children: children(id), widgets: widgetsIn(id))
  }

  // MARK: Stations: ink means who

  struct Station {
    /// "K", "K03"; empty for Home.
    let code: String
    let ink: Color
    let day: String?
    let night: String?
  }

  /// SIS rev D's line inks (on paper, lifted for the dark), handed out in order.
  private static let lines: [(day: UInt32, night: UInt32)] = [
    (0x009BBF, 0x009BBF), (0x9C5E31, 0xB9794A), (0x8F76D6, 0x8F76D6), (0x3A53A4, 0x6F86D6),
    (0x00A497, 0x00A497), (0x8E9BA6, 0x9AA7B2), (0x5B7C99, 0x7D9AB6), (0x9E6A86, 0x9E6A86),
  ]

  private func top(_ x: Space) -> Space {
    var at = x
    var seen: Set<String> = []
    while let p = at.parent, p != HOME, seen.insert(at.id).inserted, let up = spaces[p] { at = up }
    return at
  }

  /// Each space's station: a top-level space is a line with its own ink (its own, else the next free one); spaces under it are numbered stations on it.
  var stations: [String: Station] {
    var map: [String: Station] = [:]
    let lineSpaces = spaces.values.filter { $0.parent == HOME }.sorted { $0.made < $1.made }
    var taken: Set<Int> = []
    var inks: [String: (String, String)] = [:]
    let hex = { (v: UInt32) in String(format: "#%06X", v) }
    for l in lineSpaces {
      if let ink = l.ink {
        inks[l.id] = (ink.day, ink.night)
        if let i = Self.lines.firstIndex(where: { hex($0.day).lowercased() == ink.day.lowercased() }) { taken.insert(i) }
      }
    }
    for l in lineSpaces where inks[l.id] == nil {
      let i = Self.lines.indices.first { !taken.contains($0) } ?? (l.made % Self.lines.count)
      taken.insert(i)
      inks[l.id] = (hex(Self.lines[i].day), hex(Self.lines[i].night))
    }
    var used: Set<String> = []
    for l in lineSpaces {
      let letters = l.name.filter { $0.isLetter && $0.isASCII }
      let first = String(letters.prefix(1)).uppercased().isEmpty ? "S" : String(letters.prefix(1)).uppercased()
      let code = used.contains(first) ? first + String(letters.dropFirst().prefix(1)).lowercased() : first
      used.insert(code)
      let ink = inks[l.id]
      map[l.id] = Station(code: code, ink: SIS.ink(day: ink?.0, night: ink?.1) ?? SIS.ink3, day: ink?.0, night: ink?.1)
    }
    var counts: [String: Int] = [:]
    for x in spaces.values.filter({ $0.parent != nil && $0.parent != HOME }).sorted(by: { $0.made < $1.made }) {
      let line = map[top(x).id]
      let parent = x.parent ?? ""
      let n = (counts[parent] ?? 0) + 1
      counts[parent] = n
      map[x.id] = Station(
        code: (line?.code ?? "").filter { !$0.isNumber } + String(format: "%02d", n), ink: line?.ink ?? SIS.ink3,
        day: line?.day, night: line?.night)
    }
    return map
  }

  func station(_ id: String) -> Station {
    stations[id] ?? Station(code: "", ink: SIS.ink3, day: nil, night: nil)
  }
}
