import Foundation
import Observation

let HOME = "home"

struct Space: Identifiable, Hashable {
  let id: String
  var name: String
  var parent: String?
  var about: String
  var ephemeral: Bool
  var archived: Bool
  var ink: Ink?
  /// Where it was made, for stable order and station numbers.
  var made: Int
  /// Its cover's blob (at /blobs/<hash>), or none.
  var cover: String? = nil

  struct Ink: Hashable {
    let day: String
    let night: String
  }
}

/// One transcript entry of a thread, in log order.
struct Item: Identifiable, Hashable {
  enum Kind: String { case user, text, tool, result, steer, wake }
  let seq: Int
  let turn: String
  let kind: Kind
  let text: String
  var name: String = ""
  var input: JSON = .null
  var error = false
  /// A tool call's id, and the id of the call a result answers.
  var call = ""
  var id: Int { seq }
}

struct ThreadRow: Identifiable, Hashable {
  let id: String
  let parent: String?
  var title: String
  /// idle, running, done, interrupted, failed or limited.
  var status: String
  var turn: String?
  /// The seq it was opened at: its tag says its space.
  var opened: Int
  /// Its own tag; without one it works where its parent does.
  var home: String?
  /// When the running turn started, or the last ended, in ms.
  var since: Double
  var result: String
  /// Where a task's work stands, as it says ("building"); empty when it hasn't said.
  var stage = ""
  /// Its latest turn has none of the user's words in it (no steer of theirs joined it).
  var woken = false
  /// And the senses woke it: nothing shows it running.
  var sensed = false
  /// Text streaming into the running turn, until its block lands.
  var streaming = ""
  var items: [Item] = []
  /// Its transcript was paged in (it's been opened); else only the running turn's latest is held.
  var loaded = false
  var more = true
}

/// A line in a space's chat: where it was said, and the other spaces it mentions.
struct Line: Identifiable, Hashable {
  let seq: Int
  let time: Double
  /// On the agent's side: Switch's, or a peer's when `from` names it.
  let agent: Bool
  var text: String
  var home: String
  var mentions: [String]
  /// A peer's name, as it gave it: an outside agent posting into the space.
  var from: String? = nil
  /// A quiet line: an app's outcome (its words in `text`), or where an exchange went.
  var quiet: Quiet? = nil
  /// The turn a reply came from.
  var turn: String? = nil
  var attachments: [Attachment] = []
  /// A reply's long version, opened on demand.
  var detail: String? = nil
  /// A reply revised in place since it posted.
  var edited = false
  /// Each side's tapback.
  var reactions = Reactions()
  /// A widget shown in the chat in place of words: its text is then the widget's title.
  var widget: Shown? = nil
  /// What it replies to, in order: words of a message, an ask.
  var replyTo: [Reply] = []
  /// Each side's tapbacks on words of it.
  var parts: [PartReaction] = []
  /// The display name of the model that wrote it.
  var model: String? = nil
  var id: Int { seq }
  /// Its general words: none when they only repeat its replies under what it replies to (the
  /// pre-read once stored those as its words too).
  var general: String {
    let replies = replyTo.map { $0.said.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    return !replies.isEmpty && text.trimmingCharacters(in: .whitespacesAndNewlines) == replies.joined(separator: "\n\n") ? "" : text
  }
}

/// What a message replies to (packages/brain/src/messages.ts): words of message `seq` as they
/// stand in its text (`start`, `end`: UTF-16 offsets into it, when known), or an ask, with its title
/// when known; each with the user's words to it (`reply`), when it has its own.
enum Reply: Hashable {
  case quote(seq: Int, text: String, start: Int?, said: String)
  case ask(id: String, title: String?, said: String)

  init?(_ j: JSON) {
    switch j["kind"].str {
    case "quote":
      self = .quote(seq: Int(j["seq"].number ?? 0), text: j["text"].str, start: j["start"].number.map { Int($0) }, said: j["reply"].str)
    case "ask": self = .ask(id: j["id"].str, title: j["title"].string, said: j["reply"].str)
    default: return nil
    }
  }

  /// A line's refs, and the ask it was a reply on (`item`) when they don't name it.
  static func of(_ refs: JSON, item: JSON) -> [Reply] {
    var out = refs.array.compactMap(Reply.init)
    let on = item.str
    if !on.isEmpty, !out.contains(where: { if case .ask(let id, _, _) = $0 { id == on } else { false } }) {
      out.append(.ask(id: on, title: nil, said: ""))
    }
    return out
  }

  /// The user's own words to it.
  var said: String {
    switch self {
    case .quote(_, _, _, let said), .ask(_, _, let said): said
    }
  }
}

/// A side's tapback on words of a line (packages/brain/src/reactions.ts): one per side per stretch of
/// words, its text and where it starts (a UTF-16 offset into the line's text, when known).
struct PartReaction: Hashable {
  let agent: Bool
  let reaction: Reaction
  let text: String
  let start: Int?

  init(agent: Bool, reaction: Reaction, text: String, start: Int?) {
    self.agent = agent
    self.reaction = reaction
    self.text = text
    self.start = start
  }

  init?(_ j: JSON) {
    guard let reaction = Reaction(rawValue: j["reaction"].str), !j["text"].str.isEmpty else { return nil }
    self.init(agent: j["side"].str == "agent", reaction: reaction, text: j["text"].str, start: j["start"].number.map { Int($0) })
  }
}

/// A widget shown in a chat: an app's, or one the agent made (the brain's, `WidgetHost.made`), its
/// tool called with `input` (desktop's brain/store.ts `Shown`).
struct Shown: Hashable {
  let app: String
  let name: String
  let input: JSON?
  var key: String { "\(app)/\(name)" }

  init?(_ j: JSON) {
    guard !j["app"].str.isEmpty else { return nil }
    app = j["app"].str
    name = j["name"].str
    input = j["input"] == .null ? nil : j["input"]
  }
}

/// iMessage's six tapbacks (packages/brain/src/reactions.ts).
nonisolated enum Tapback: String, CaseIterable, Hashable {
  case love, like, dislike, laugh, emphasize, question
}

/// A reaction: one of the six tapbacks, or any one emoji (packages/brain/src/reactions.ts).
nonisolated struct Reaction: RawRepresentable, Hashable {
  let rawValue: String

  init?(rawValue: String) {
    guard Tapback(rawValue: rawValue) != nil || Self.isEmoji(rawValue) else { return nil }
    self.rawValue = rawValue
  }

  init(_ tapback: Tapback) { rawValue = tapback.rawValue }

  /// The six tapbacks, in the menu's order.
  static let allCases = Tapback.allCases.map(Reaction.init)

  /// The tapback it is; nil for an emoji.
  var tapback: Tapback? { Tapback(rawValue: rawValue) }

  /// One emoji, as one character drawn as one.
  static func isEmoji(_ s: String) -> Bool {
    guard s.count == 1, let first = s.unicodeScalars.first else { return false }
    return first.properties.isEmojiPresentation || (first.properties.isEmoji && s.unicodeScalars.count > 1)
  }
}

/// Each side's tapback on a line: one per side.
struct Reactions: Hashable {
  var user: Reaction?
  var agent: Reaction?

  init(user: Reaction? = nil, agent: Reaction? = nil) {
    self.user = user
    self.agent = agent
  }

  init(_ j: JSON) {
    user = Reaction(rawValue: j["user"].str)
    agent = Reaction(rawValue: j["agent"].str)
  }

  var isEmpty: Bool { user == nil && agent == nil }
}

enum Quiet: Hashable {
  case event
  /// A memory a turn learned here, and what it replaced: Undo forgets it and puts those back.
  case learned(id: String, restore: [String])
}

/// An extension's long job, as its Live Activity says: a print, a deploy.
struct Job: Identifiable, Hashable {
  let id: String
  let space: String
  let title: String
  let line: String
  /// 0 to 1, when known.
  let progress: Double?
  let startedAt: Double
  let endsAt: Double?
  /// running, needs, failed or done.
  let state: String

  init(_ j: JSON) {
    id = j["id"].str
    space = j["space"].string ?? HOME
    title = j["title"].str
    line = j["line"].str
    progress = j["progress"].number
    startedAt = j["startedAt"].number ?? 0
    endsAt = j["endsAt"].number
    state = j["state"].string ?? "running"
  }
}

/// A subscription the agent runs on, as `account.state` last said.
struct Account: Identifiable, Hashable {
  let host: String
  /// What it's shown as: the email its login reports, else its provider's name.
  let label: String
  let provider: String
  let up: Bool
  let problem: String
  let limitedUntil: Double
  /// Each usage window's name and share used.
  let windows: [Window]
  var id: String { host }

  struct Window: Hashable {
    let name: String
    let used: Double
  }

  /// `account.state` doesn't carry the label: `was` is the one the snapshot gave.
  init(_ j: JSON, was: String? = nil) {
    host = j["host"].str
    label = j["label"].str.isEmpty ? (was ?? j["host"].str) : j["label"].str
    provider = j["provider"].str
    up = j["up"].bool == true
    problem = j["problem"].str
    limitedUntil = j["limitedUntil"].number ?? 0
    windows = j["windows"].array.map { Window(name: $0["name"].str, used: $0["used"].number ?? 0) }
  }
}

/// A space's chat as held: its latest lines, and whether older ones are left to page in.
struct Chat {
  var lines: [Line] = []
  var more = false

  /// In seq order, once.
  mutating func insert(_ line: Line) {
    var at = lines.count
    while at > 0, lines[at - 1].seq > line.seq { at -= 1 }
    if at > 0, lines[at - 1].seq == line.seq { return }
    lines.insert(line, at: at)
  }
}

/// Sent, not yet in the log: kept in the Outbox, or taken by the core (`landed`, its seq) and not yet
/// folded in.
struct Pending: Identifiable, Hashable {
  let id: String
  let space: String
  let text: String
  var attachments: [Attachment] = []
  /// The names of its files still going up.
  var going: [String] = []
  let time: Double
  var failed = false
  var landed: Int?
}

extension Pending {
  /// A message from a box, as the Outbox keeps it.
  @MainActor init?(_ e: Outbox.Entry) {
    guard e.name == "message.post", let space = e.view?["space"].string else { return nil }
    let files = e.files ?? []
    self.init(
      id: e.id, space: space, text: e.payload["text"].str, attachments: files.compactMap(\.attachment),
      going: files.filter { $0.blob == nil }.map(\.name), time: e.time ?? 0, failed: e.rejected != nil)
  }
}

/// What needs the user (autonomy's action items, packages/autonomy/src/items.ts): a task (Done), a
/// question (options, a typed answer), an approval (drafts to edit, Approve sends `send` from the
/// core) or a sealed one (a secret sealed on this phone to the item's one-time key).
struct ActionItem: Identifiable, Hashable {
  enum Kind: String { case task, question, approval, sealed }

  struct Draft: Hashable {
    let name: String
    let label: String
    let text: String
  }

  /// A file on the card: a blob in the core's store, or a link; `option` puts it beside that option.
  struct File: Hashable {
    let name: String
    let type: String
    let size: Double?
    let blob: String?
    let url: String?
    let option: Int?
  }

  /// A closed one's answer (autonomy's `Answer`): Approve or Decline, the option picked, the words
  /// typed, each draft as approved.
  struct Answer: Hashable {
    let approved: Bool?
    let choice: String?
    let text: String?
    let drafts: [String: String]

    init(_ j: JSON) {
      approved = j["approved"].bool
      choice = j["choice"].string
      text = j["text"].string
      drafts = j["drafts"].object.compactMapValues(\.string)
    }
  }

  /// A key that helps, calling an app's tool from here.
  struct Assist: Hashable {
    let label: String
    let app: String
    let tool: String
    let args: JSON
  }

  let id: String
  let space: String
  let title: String
  let body: String
  let kind: Kind
  let options: [String]
  let drafts: [Draft]
  let files: [File]
  let assist: Assist?
  /// It carries a live view of a Mac's screen (PortalView.swift).
  let portal: Bool
  /// A sealed item's one-time key and what it's for.
  let sealedKey: String?
  let sealedUse: String
  /// Out of the user's queue while the agent reworks it.
  let revising: Bool
  /// The user's own version of drafts, by name, saved as he edits (not an approval).
  var edits: [String: String]
  let at: Double
  /// How it closed, once it has.
  var status = "open"
  /// What the user answered, once they have.
  var answer: Answer?
  /// Whether what Approve ran went through, once it has run.
  var ranOK: Bool?
  /// Who what Approve runs sends to, when its call says (a text's `to`).
  let sendTo: String?

  init(_ j: JSON, at: Double) {
    id = j["id"].str
    space = j["space"].string ?? HOME
    title = j["title"].str
    body = j["body"].str
    options = j["options"].array.map(\.str)
    drafts = j["drafts"].array.map { Draft(name: $0["name"].str, label: $0["label"].str, text: $0["text"].str) }
    files = j["attachments"].array.map {
      File(
        name: $0["name"].str, type: $0["type"].str, size: $0["size"].number, blob: $0["blob"].string, url: $0["url"].string,
        option: $0["option"].number.map { Int($0) })
    }
    let a = j["action"]
    assist = a.isNull ? nil : Assist(label: a["label"].str, app: a["app"].str, tool: a["tool"].str, args: a["args"])
    portal = !j["portal"].isNull
    sealedKey = j["sealed"]["key"].string
    sealedUse = j["sealed"]["use"].str
    revising = !j["revising"].isNull
    edits = j["edits"].object.compactMapValues(\.string)
    let given = Kind(rawValue: j["kind"].str)
    kind = given ?? (!j["send"].isNull || !drafts.isEmpty ? .approval : options.isEmpty ? .task : .question)
    self.at = j["seq"].number ?? at
    status = j["status"].string ?? "open"
    answer = j["answer"].isNull ? nil : Answer(j["answer"])
    ranOK = j["ran"]["ok"].bool
    sendTo = j["send"]["args"]["to"].string
  }

  /// A draft's words as the card shows them: the user's version, else the agent's.
  func shown(_ d: Draft) -> String { edits[d.name] ?? d.text }
}

/// "X by T, else wake."
struct Expectation: Identifiable, Hashable {
  let id: String
  let space: String
  let what: String
  /// When, in ms; none for a watch.
  let by: Double?
  var lapsed = false
}

/// A widget placed in a space; a space's widgets keep this list's order.
struct Placement: Hashable {
  let app: String
  let name: String
  let space: String
  var key: String { "\(app)/\(name)" }
}

/// What the brain's find matched (packages/core/src/find.ts): a chat line, an action item or a memory.
struct Found: Identifiable, Hashable {
  /// message, item or memory.
  let kind: String
  let ref: String
  let space: String
  /// A chat line's seq.
  let seq: Int?
  /// The line of it that matched.
  let line: String
  var id: String { "\(kind):\(ref)" }

  init(_ j: JSON) {
    kind = j["kind"].str
    ref = j["id"].str
    space = j["space"].str
    seq = j["seq"].number.map { Int($0) }
    line = j["line"].str
  }
}

/// A Wallet pass the agent issued, for its space's chat.
struct IssuedPass: Identifiable, Hashable {
  let serial: String
  let title: String
  let space: String
  let seq: Int
  var id: String { serial }
}

/// The brain as the app reads it: the snapshot's projections, then the log folded in, as the
/// desktop's store does (apps/desktop/src/mainview/brain/store.ts and adapter.ts).
@MainActor @Observable
final class Brain {
  var seq = 0
  var link: Sync.Link = .connecting
  /// Whether the first read has landed.
  var ready = false
  var spaces: [String: Space] = [
    HOME: Space(id: HOME, name: "Home", parent: nil, about: "", ephemeral: false, archived: false, ink: nil, made: 0)
  ]
  var threads: [String: ThreadRow] = [:]
  var chats: [String: Chat] = [:]
  /// The latest seq tagged to each space, for warmth.
  var warm: [String: Int] = [:]
  /// How far the user has read each space's chat, on any device.
  var reads: [String: Int] = [:]
  /// Each space's latest reply: unread while it's past the read mark.
  var replies: [String: Int] = [:]
  /// Messages the core took whose lines aren't in yet.
  var pending: [String: Pending] = [:]
  /// The ids of the user's messages whose lines came in.
  var arrived: Set<String> = []
  var actions: [String: ActionItem] = [:]
  /// Open, out of the queue while the agent reworks them: nothing to answer, links still find them.
  var revising: [String: ActionItem] = [:]
  /// The latest closed, newest first, to reopen.
  var closedActions: [ActionItem] = []
  var expectations: [String: Expectation] = [:]
  var widgets: [Placement] = []
  var passes: [IssuedPass] = []
  var activities: [String: Job] = [:]
  var accounts: [String: Account] = [:]
  /// The installed extensions' names, to tell a tool's app from its machine.
  var extensions: Set<String> = []
  /// The user's preferences (`pref.set`), by key.
  var prefs: [String: JSON] = [:]

  /// Told of each event as it's folded in: widgets, Live Activities.
  @ObservationIgnored var watchers: [(StoredEvent) -> Void] = []

  /// Nothing held: a new pairing, or none.
  func reset() {
    applySnapshot(0, .null)
    arrived = []
    passes = []
    link = .connecting
    ready = false
  }

  // MARK: Snapshot

  /// The core's client view (packages/core/src/view.ts), replacing what was held.
  func applySnapshot(_ seq: Int, _ state: JSON) {
    spaces = [HOME: Space(id: HOME, name: "Home", parent: nil, about: "", ephemeral: false, archived: false, ink: nil, made: 0)]
    for s in state["spaces"].array {
      let id = s["id"].str
      spaces[id] = Space(
        id: id, name: s["name"].str, parent: Self.parentOf(id, s["parent"]), about: s["about"].str,
        ephemeral: s["ephemeral"].bool == true, archived: s["archived"].bool == true, ink: Self.ink(s["ink"]),
        made: Int(s["made"].number ?? 0), cover: s["cover"].string)
    }
    prefs = state["prefs"].object
    threads = [:]
    for t in state["threads"].array {
      let id = t["id"].str
      threads[id] = ThreadRow(
        id: id, parent: t["parent"].string, title: t["title"].str, status: t["status"].string ?? "idle",
        turn: t["turn"].string, opened: Int(t["opened"].number ?? 0), home: t["home"].string,
        since: t["since"].number ?? 0, result: t["result"].str, stage: t["stage"].str,
        woken: t["woken"].bool == true, sensed: t["sensed"].bool == true, items: t["items"].array.compactMap(Self.item))
    }
    chats = [:]
    for c in state["chats"].array {
      chats[c["space"].str] = Chat(lines: c["lines"].array.map(Self.line), more: c["more"].bool == true)
    }
    // Mentioned lines show in the chats they mention too.
    for (id, chat) in chats {
      for line in chat.lines where line.home == id {
        for m in line.mentions { chats[m, default: Chat()].insert(line) }
      }
    }
    actions = [:]
    revising = [:]
    for a in state["actions"].array {
      let item = ActionItem(a, at: 0)
      if item.revising { revising[item.id] = item } else { actions[item.id] = item }
    }
    closedActions = state["closedActions"].array.map { ActionItem($0, at: 0) }
    expectations = [:]
    for e in state["expectations"].array {
      let id = e["id"].str
      expectations[id] = Expectation(id: id, space: e["space"].str, what: e["what"].str, by: e["by"].number, lapsed: e["lapsed"].bool == true)
    }
    activities = Dictionary(state["activities"].array.map { ($0["id"].str, Job($0)) }, uniquingKeysWith: { _, b in b })
    extensions = Set(state["extensions"].array.map { $0["extension"].str }.filter { !$0.isEmpty })
    accounts = Dictionary(state["accounts"].array.map { ($0["host"].str, Account($0)) }, uniquingKeysWith: { _, b in b })
    widgets = state["widgets"].array.map { Placement(app: $0["app"].str, name: $0["name"].str, space: $0["space"].str) }
    warm = [:]
    for w in state["warm"].array { warmUp(w["space"].str, Int(w["seq"].number ?? 0)) }
    reads = [:]
    for r in state["reads"].array { reads[r["space"].str] = Int(r["seq"].number ?? 0) }
    replies = [:]
    for r in state["replies"].array { replies[r["space"].str] = Int(r["seq"].number ?? 0) }
    self.seq = seq
    pending = [:]
    ready = true
  }

  static func line(_ j: JSON) -> Line {
    Line(
      seq: Int(j["seq"].number ?? 0), time: j["time"].number ?? 0, agent: j["who"].str == "agent" || j["who"].str == "peer", text: j["text"].str,
      home: j["home"].str, mentions: j["mentions"].array.map(\.str), from: j["from"].string, quiet: quiet(j), turn: j["turn"].string,
      attachments: j["attachments"].array.compactMap(Attachment.init),
      detail: j["detail"].string.flatMap { $0.isEmpty ? nil : $0 }, edited: j["edited"].bool == true,
      reactions: Reactions(j["reactions"]), widget: Shown(j["widget"]),
      replyTo: Reply.of(j["replyTo"], item: j["item"]), parts: j["parts"].array.compactMap(PartReaction.init),
      model: j["model"]["name"].string)
  }

  static func quiet(_ j: JSON) -> Quiet? {
    switch j["kind"].str {
    case "event": .event
    case "learned": .learned(id: j["memory"].str, restore: j["restore"].array.map(\.str))
    default: nil
    }
  }

  static func item(_ j: JSON) -> Item? {
    guard let kind = Item.Kind(rawValue: j["kind"].string ?? "text") else { return nil }
    return Item(
      seq: Int(j["seq"].number ?? 0), turn: j["turn"].str, kind: kind, text: kind == .result ? j["output"].str : j["text"].str,
      name: j["name"].str, input: j["input"], error: j["error"].bool == true, call: j["id"].str)
  }

  // MARK: Pages

  /// A space's chat lines before its oldest held.
  func addChatPage(_ space: String, _ page: JSON) {
    var chat = chats[space] ?? Chat()
    for l in page["lines"].array.map(Self.line) { chat.insert(l) }
    chat.more = page["more"].bool == true
    chats[space] = chat
  }

  /// A thread's transcript before its oldest held entry; from then on live entries add to it.
  func addThreadPage(_ thread: String, _ page: JSON) {
    guard var t = threads[thread] else { return }
    let older = page["items"].array.compactMap(Self.item)
    let oldest = t.loaded ? (t.items.first?.seq ?? .max) : .max
    let kept = t.loaded ? t.items : t.items.filter { $0.seq > (older.last?.seq ?? 0) }
    t.items = older.filter { $0.seq < oldest } + kept
    t.loaded = true
    t.more = page["more"].bool == true
    threads[thread] = t
  }

  // MARK: The log

  func apply(_ events: [StoredEvent]) {
    for e in events {
      fold(e)
      seq = e.seq
      for w in watchers { w(e) }
    }
    if pending.values.contains(where: { ($0.landed ?? .max) <= seq }) { pending = pending.filter { ($0.value.landed ?? .max) > seq } }
    ready = true
  }

  private func fold(_ e: StoredEvent) {
    let p = e.payload
    let id = p["id"].str
    switch e.type {
    case "space.created":
      spaces[id] = Space(
        id: id, name: p["name"].str, parent: Self.parentOf(id, p["parent"]), about: p["about"].str,
        ephemeral: p["ephemeral"].bool == true, archived: false, ink: nil, made: e.seq)
    case "space.inked": spaces[id]?.ink = Space.Ink(day: p["day"].str, night: p["night"].str)
    case "space.renamed": spaces[id]?.name = p["name"].str
    case "space.described": spaces[id]?.about = p["about"].str
    case "space.cover_set": spaces[id]?.cover = p["image"].string
    case "pref.set": prefs[p["key"].str] = p["value"]
    case "space.moved": spaces[id]?.parent = p["parent"].str
    case "space.archived": spaces[id]?.archived = true
    case "space.unarchived":
      spaces[id]?.archived = false
      // Its chat left the snapshot while archived: paged in again.
      if chats[id]?.lines.isEmpty != false { chats[id] = nil }
    case "space.promoted": spaces[id]?.ephemeral = false
    case "space.tagged":
      tagged(p)
    case "space.read":
      readTo(p["space"].str, Int(p["seq"].number ?? 0))
    case "message.posted":
      let home = p["space"].string ?? HOME
      let peer = e.source == "peer"
      chats[home, default: Chat()].insert(
        Line(
          seq: e.seq, time: e.time, agent: e.source == "agent" || peer, text: p["text"].str, home: home, mentions: [],
          from: peer ? p["from"].str : nil, turn: p["turn"].string, attachments: p["attachments"].array.compactMap(Attachment.init),
          detail: p["detail"].string.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 },
          widget: Shown(p["widget"]),
          // An ask's title, which the core gives only to its view's lines: the app's own, open or closed.
          replyTo: Reply.of(p["replyTo"], item: p["item"]).map { r in
            guard case .ask(let ask, nil, let said) = r else { return r }
            return .ask(id: ask, title: (actions[ask] ?? revising[ask])?.title ?? closedActions.first { $0.id == ask }?.title, said: said)
          }, model: p["model"]["name"].string))
      warmUp(home, e.seq)
      // A peer's words are neither the space's reply nor the user's reading of it.
      if e.source == "agent" { replies[home] = e.seq } else if !peer { readTo(home, e.seq) }
      if e.source != "agent" && !peer {
        let key = String(e.id.split(separator: ":").first ?? "")
        arrived.insert(key)
        pending[key] = nil
      }
    case "message.moved":
      moved(p)
    case "message.reacted":
      let reaction = Reaction(rawValue: p["reaction"].str)
      if p["quote"].isNull {
        react(Int(p["seq"].number ?? 0), agent: e.source == "agent", reaction)
      } else {
        react(Int(p["seq"].number ?? 0), agent: e.source == "agent", words: p["quote"], reaction)
      }
    case "extension.installed", "extension.updated", "spur.installed", "spur.updated":
      let name = p["extension"].string ?? p["spur"].str
      if !name.isEmpty { extensions.insert(name) }
    case "extension.removed", "spur.removed":
      extensions.remove(p["extension"].string ?? p["spur"].str)
    case "triage.sorted":
      for i in p["items"].array where i["line"].bool == true {
        let space = i["space"].str
        // A condition's line, revised in place as it continues.
        if let same = i["same"].number {
          if let at = chats[space]?.lines.firstIndex(where: { $0.seq == Int(same) }) {
            chats[space]?.lines[at].text = i["note"].str
          }
          continue
        }
        chats[space, default: Chat()].insert(
          Line(
            seq: Int(i["seq"].number ?? 0), time: i["time"].number ?? 0, agent: true, text: i["note"].str, home: space,
            mentions: [], quiet: .event))
      }
    case "message.edited":
      edited(e)
    case "message.revised":
      revised(e)
    case "item.edited":
      let edits = p["drafts"].object.compactMapValues(\.string)
      if actions[id] != nil { actions[id]?.edits.merge(edits) { $1 } }
      if revising[id] != nil { revising[id]?.edits.merge(edits) { $1 } }
    case "item.opened", "item.revised", "item.reopened":
      let was = actions[id] ?? revising[id]
      var item = ActionItem(p, at: was?.at ?? e.time)
      // The user's edits stay on the drafts a revision left as they were (autonomy's `rebased`).
      if let was {
        item.edits = was.edits.filter { name, _ in
          let before = was.drafts.first { $0.name == name }?.text
          return before != nil && item.drafts.first { $0.name == name }?.text == before
        }
      }
      actions[id] = item.revising ? nil : item
      revising[id] = item.revising ? item : nil
      closedActions.removeAll { $0.id == id }
    case "item.closed", "item.answered":
      if var a = actions.removeValue(forKey: id) ?? revising.removeValue(forKey: id) {
        a.status = e.type == "item.answered" ? "answered" : p["status"].str
        if e.type == "item.answered" { a.answer = ActionItem.Answer(p) }
        closedActions.insert(a, at: 0)
        closedActions = Array(closedActions.prefix(30))
      }
    case "item.ran":
      if let at = closedActions.firstIndex(where: { $0.id == id }) { closedActions[at].ranOK = p["ok"].bool == true }
    case "expectation.set":
      expectations[id] = Expectation(id: id, space: p["space"].str, what: p["what"].str, by: p["by"].number)
    case "expectation.met", "expectation.dropped": expectations[id] = nil
    case "expectation.lapsed", "expectation.broken": expectations[id]?.lapsed = true
    case "widget.placed", "widget.moved":
      place(Placement(app: p["app"].str, name: p["name"].str, space: p["space"].str), Int(p["index"].number ?? 0))
    case "widget.removed":
      widgets.removeAll { $0.app == p["app"].str && $0.name == p["name"].str }
    case "iphone.activity":
      activities[id] = p["phase"].str == "end" ? nil : Job(p)
    case "account.state":
      accounts[p["host"].str] = Account(p, was: accounts[p["host"].str]?.label)
    case "memory.written", "setting.set":
      let space = p["space"].str
      guard !space.isEmpty, !p["decision"].str.isEmpty || e.type == "setting.set" else { return }
      chats[space, default: Chat()].insert(
        Line(
          seq: e.seq, time: e.time, agent: true, text: p["description"].str, home: space, mentions: [],
          quiet: .learned(id: id, restore: p["replaces"].array.map(\.str))))
    case "memory.forgotten":
      let learned = { (l: Line) -> Bool in
        if case .learned(let memory, _) = l.quiet { return memory == id }
        return false
      }
      for (space, chat) in chats where chat.lines.contains(where: learned) {
        chats[space]?.lines.removeAll(where: learned)
      }
    case "iphone.pass_issued":
      passes.append(IssuedPass(serial: p["serial"].str, title: p["title"].str, space: p["space"].str, seq: e.seq))
    default:
      if e.type.hasPrefix("thread.") || e.type.hasPrefix("turn.") { turn(e) }
    }
  }

  /// A side's tapback on line `seq`, in every chat that holds it; nil takes it off.
  func react(_ seq: Int, agent: Bool, _ reaction: Reaction?) {
    for (space, chat) in chats {
      for i in chat.lines.indices where chat.lines[i].seq == seq && chat.lines[i].quiet == nil {
        if agent { chats[space]?.lines[i].reactions.agent = reaction } else { chats[space]?.lines[i].reactions.user = reaction }
      }
    }
  }

  /// A side's tapback on words of line `seq`, in every chat that holds it: one per side per stretch
  /// of words (their text and start), as the brain keeps them; nil takes it off.
  func react(_ seq: Int, agent: Bool, words: JSON, _ reaction: Reaction?) {
    let text = words["text"].str
    let start = words["start"].number.map { Int($0) }
    for (space, chat) in chats {
      for i in chat.lines.indices where chat.lines[i].seq == seq && chat.lines[i].quiet == nil {
        var parts = chat.lines[i].parts
        parts.removeAll { $0.agent == agent && $0.text == text && $0.start == start }
        if let reaction { parts.append(PartReaction(agent: agent, reaction: reaction, text: text, start: start)) }
        chats[space]?.lines[i].parts = parts
      }
    }
  }

  /// An exchange went to another chat: its lines leave the old one and show in the new.
  private func moved(_ p: JSON) {
    let from = p["from"].str
    let to = p["to"].str
    let seqs = Set(p["seqs"].array.compactMap { $0.number.map { Int($0) } })
    let taken = chats[from]?.lines.filter { seqs.contains($0.seq) && $0.quiet == nil } ?? []
    chats[from]?.lines.removeAll { seqs.contains($0.seq) && $0.quiet == nil }
    for var l in taken {
      l.home = to
      chats[to, default: Chat()].insert(l)
    }
  }

  /// A thread's opening, or a chat line, tagged with its home and the spaces it mentions.
  private func tagged(_ p: JSON) {
    let at = Int(p["seq"].number ?? 0)
    let home = p["home"].str
    let mentions = p["mentions"].array.map(\.str)
    for (id, t) in threads where t.opened == at { threads[id]?.home = home }
    for (id, chat) in chats {
      guard let i = chat.lines.firstIndex(where: { $0.seq == at }), chat.lines[i].home == id else { continue }
      var line = chat.lines[i]
      line.mentions = mentions
      // A retag moves the line to its new home.
      line.home = home
      if home == id {
        chats[id]?.lines[i] = line
      } else {
        chats[id]?.lines.remove(at: i)
        chats[home, default: Chat()].insert(line)
      }
      for m in mentions { chats[m, default: Chat()].insert(line) }
    }
  }

  /// The user's last message, changed: its new words, and the replies to the old ones gone.
  private func edited(_ e: StoredEvent) {
    let at = Int(e.payload["seq"].number ?? 0)
    guard let line = chats.values.lazy.compactMap({ $0.lines.first { $0.seq == at } }).first else { return }
    for space in [line.home] + line.mentions {
      chats[space]?.lines.removeAll { $0.agent && $0.from == nil && $0.quiet == nil && $0.home == line.home && $0.seq > at && $0.seq < e.seq }
      if let i = chats[space]?.lines.firstIndex(where: { $0.seq == at }) {
        chats[space]?.lines[i].text = e.payload["text"].str
      }
    }
  }

  /// A reply of the agent's, revised in place: its new words, marked edited; nothing else changes.
  /// The line is found first, as `edited` finds it: changing `chats` while iterating it is an
  /// access conflict that Swift stops the app for.
  private func revised(_ e: StoredEvent) {
    let at = Int(e.payload["seq"].number ?? 0)
    guard let line = chats.values.lazy.compactMap({ $0.lines.first { $0.seq == at } }).first else { return }
    for space in [line.home] + line.mentions {
      if let i = chats[space]?.lines.firstIndex(where: { $0.seq == at }) {
        chats[space]?.lines[i].text = e.payload["text"].str
        chats[space]?.lines[i].edited = true
      }
    }
  }

  /// A transcript entry lands while the thread is open, or is running (for its live step).
  private func addItem(_ e: StoredEvent, _ kind: Item.Kind, _ text: String, name: String = "", input: JSON = .null, error: Bool = false) {
    let id = e.payload["thread"].str
    guard let t = threads[id], t.loaded || t.turn == e.payload["turn"].str else { return }
    threads[id]?.items.append(
      Item(
        seq: e.seq, turn: e.payload["turn"].str, kind: kind, text: text, name: name, input: input, error: error,
        call: e.payload["id"].str))
  }

  private func turn(_ e: StoredEvent) {
    let p = e.payload
    let t = p["thread"].str
    switch e.type {
    case "thread.opened":
      threads[t] = ThreadRow(
        id: t, parent: p["parent"].string, title: p["title"].str, status: "idle", turn: nil, opened: e.seq,
        home: t.hasPrefix("space:") ? String(t.dropFirst("space:".count)) : nil, since: e.time, result: "", loaded: true, more: false)
    case "turn.started":
      threads[t]?.status = "running"
      threads[t]?.turn = p["turn"].str
      threads[t]?.since = e.time
      threads[t]?.streaming = ""
      threads[t]?.result = ""
      threads[t]?.stage = ""
      // Each value made first: `threads[t]?.x = …threads…` is an access conflict Swift stops the app for.
      let woken = p["text"].str.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      threads[t]?.woken = woken
      threads[t]?.sensed = woken && p["sensed"].bool == true
      // Not open: only the latest turn is kept.
      if threads[t]?.loaded == false { threads[t]?.items = [] }
      addItem(e, .user, p["text"].str)
    case "thread.staged":
      threads[t]?.stage = p["stage"].str.trimmingCharacters(in: .whitespacesAndNewlines)
    case "thread.settled":
      guard var row = threads[t], row.status == "waiting", row.turn == p["turn"].str else { return }
      row.status = "done"
      if row.parent == nil { row.result = "" }
      threads[t] = row
    case "turn.delta":
      threads[t]?.streaming += p["text"].str
    case "turn.text":
      threads[t]?.streaming = ""
      addItem(e, .text, p["text"].str)
    case "turn.tool":
      addItem(e, .tool, "", name: p["name"].str, input: p["input"])
    case "turn.result":
      addItem(e, .result, p["output"].str, error: p["error"].bool == true)
    case "turn.injected":
      if p["kind"].str == "steer", threads[t]?.turn == p["turn"].str {
        threads[t]?.woken = false
        threads[t]?.sensed = false
      } else if p["sensed"].bool == true, threads[t]?.turn == p["turn"].str {
        let woken = threads[t]?.woken == true
        threads[t]?.sensed = woken
      }
      addItem(e, p["kind"].str == "wake" ? .wake : .steer, p["text"].str)
    case "turn.ended":
      // Changed as a copy, stored once: `threads[t]?.x = …threads…` reads `threads` while it's
      // being written, which Swift's exclusivity check stops the app for.
      guard var row = threads[t], row.turn == p["turn"].str else { return }
      let s = p["status"].str
      // Done while its work goes on elsewhere (a watch, a script), it waits until `thread.settled`.
      if ["failed", "limited", "interrupted"].contains(s) {
        row.status = s
      } else {
        row.status = p["going"].bool == true ? "waiting" : "done"
      }
      // A task's report is kept for its card in chat; a space's reply is in its chat already.
      row.result = row.status == "done" && row.parent == nil ? "" : p["result"].str
      row.since = e.time
      row.streaming = ""
      threads[t] = row
    default:
      break
    }
  }

  /// Takes it out of wherever it was, then puts it `index`th among its space's widgets.
  private func place(_ w: Placement, _ index: Int) {
    widgets.removeAll { $0.app == w.app && $0.name == w.name }
    let there = widgets.indices.filter { widgets[$0].space == w.space }
    var to = widgets.count
    if index >= 0, index < there.count {
      to = there[index]
    } else if let last = there.last {
      to = last + 1
    }
    widgets.insert(w, at: to)
  }

  /// Read through `seq`: the read mark only moves forward.
  func readTo(_ space: String, _ seq: Int) {
    if seq > (reads[space] ?? 0) { reads[space] = seq }
  }

  /// The latest reply in the space's own chat, if the user hasn't read that far.
  func unreadAt(_ space: String) -> Int? {
    let reply = replies[space] ?? 0
    return reply > (reads[space] ?? 0) ? reply : nil
  }

  private func warmUp(_ space: String, _ seq: Int) {
    var at: String? = space
    var seen: Set<String> = []
    while let id = at, let s = spaces[id], seen.insert(id).inserted {
      warm[id] = max(warm[id] ?? 0, seq)
      at = s.parent
    }
  }

  /// Home has none; any other space without one sits in Home.
  private static func parentOf(_ id: String, _ raw: JSON) -> String? {
    if id == HOME { return nil }
    return raw.str.isEmpty ? HOME : raw.str
  }

  private static func ink(_ raw: JSON) -> Space.Ink? {
    guard let day = raw["day"].string, let night = raw["night"].string else { return nil }
    return Space.Ink(day: day, night: night)
  }
}
