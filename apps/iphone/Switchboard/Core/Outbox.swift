import Foundation

/// What must reach the core even if iOS ends the app first: every command the user gives, answers
/// given from a notification, widget presses, crash reports, and what's half-written in each box.
/// Kept in a small file until the core takes them, each under the core it's for, so a re-pair to
/// another core never sends it there; each keeps its id, so one sent twice is a no-op. The file is
/// the desktop's outbox.ts format: `{ v, cores: { <core>: { entries, drafts } } }`.
@MainActor @Observable
final class Outbox {
  static let shared = Outbox()

  /// A file on a message or in a box: its bytes kept here until they're up, then its blob.
  nonisolated struct File: Codable, Hashable, Sendable {
    let id: String
    let name: String
    let type: String
    let size: Double
    var blob: String?

    var attachment: Attachment? { blob.map { Attachment(blob: $0, name: name, type: type, size: size) } }
  }

  nonisolated struct Entry: Codable, Hashable, Sendable {
    /// A widget's tool is a `call`: POST `widgets/<name>?id=<id>`.
    enum Kind: String, Codable, Sendable { case command, emit, call }
    let id: String
    let kind: Kind
    let name: String
    var payload: JSON
    /// Held until then (ms): for Undo, or while typing rests.
    var due: Double?
    /// A message's files still to go up first.
    var files: [File]?
    /// The core said no: kept for "Not sent", never sent again.
    var rejected: String?
    var time: Double?
    /// What its bubble shows: a message posted from a box has one (its space).
    var view: JSON?
  }

  /// What's in a box and not sent.
  nonisolated struct Draft: Codable, Hashable, Sendable {
    var text: String
    var dictated: JSON?
    var files: [File]?
    var replyTo: JSON?

    var isEmpty: Bool { text.isEmpty && (files ?? []).isEmpty && replyTo == nil }
  }

  nonisolated struct Core: Codable, Sendable {
    var entries: [Entry] = []
    var drafts: [String: Draft] = [:]

    init() {}

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      entries = try c.decodeIfPresent([Entry].self, forKey: .entries) ?? []
      drafts = try c.decodeIfPresent([String: Draft].self, forKey: .drafts) ?? [:]
    }
  }

  nonisolated struct Doc: Codable, Sendable {
    var v = 2
    var cores: [String: Core] = [:]
  }

  /// Kept before a core was paired (or by an older build, which kept no core): the next core's.
  private static let unpaired = ""
  nonisolated private static let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
  private static let file = dir.appending(path: "outbox.json")
  nonisolated private static let folder = dir.appending(path: "outbox-files")
  /// How long a send that couldn't go (an upload, a widget's call) waits to try again.
  private static let retryAfter: Duration = .seconds(5)

  /// Where a file's bytes are kept until they're up.
  nonisolated static func bytes(_ id: String) -> URL { folder.appending(path: id) }

  @ObservationIgnored private var doc: Doc
  @ObservationIgnored private var sending: Set<String> = []
  @ObservationIgnored private var timers: [String: Task<Void, Never>] = [:]
  @ObservationIgnored private weak var sync: Sync?
  /// The core whose entries go now.
  @ObservationIgnored private var core = unpaired
  /// The messages from a box not yet taken by the core, for their bubbles.
  private(set) var posts: [Entry] = []
  /// Bumped when something comes to a box from outside it, by place: a message back (its "Not
  /// sent" tapped), or what it replies to.
  private(set) var retaken: [String: Int] = [:]
  /// Told when the core took a message with a bubble, and its seq.
  @ObservationIgnored var landed: (Entry, Int) -> Void = { _, _ in }

  private init() {
    let data = try? Data(contentsOf: Self.file)
    if let doc = data.flatMap({ try? JSONDecoder().decode(Doc.self, from: $0) }) {
      self.doc = doc
    } else {
      // An older build's: a list, for whichever core is paired next.
      var doc = Doc()
      if let old = data.flatMap({ try? JSONDecoder().decode([Entry].self, from: $0) }), !old.isEmpty {
        doc.cores[Self.unpaired] = Core()
        doc.cores[Self.unpaired]?.entries = old
      }
      self.doc = doc
    }
    sweep()
  }

  /// A core's key: its HTTP origin, as the desktop keys it.
  nonisolated static func key(_ core: URL) -> String {
    guard let c = URLComponents(url: core, resolvingAgainstBaseURL: false), let scheme = c.scheme, let host = c.host else {
      return core.absoluteString
    }
    let h = host.contains(":") ? "[\(host)]" : host.lowercased()
    return "\(scheme)://\(h)\(c.port.map { ":\($0)" } ?? "")"
  }

  private var here: Core {
    get { doc.cores[core] ?? Core() }
    set { doc.cores[core] = newValue }
  }

  func has(_ id: String) -> Bool { here.entries.contains { $0.id == id } }

  /// Keeps it, and sends it if there's a socket.
  func add(
    _ kind: Entry.Kind, _ name: String, _ payload: JSON, id: String = UUID().uuidString, files: [File]? = nil, view: JSON? = nil
  ) {
    guard !has(id) else { return }
    here.entries.append(
      Entry(id: id, kind: kind, name: name, payload: payload, files: files, time: Date().timeIntervalSince1970 * 1000, view: view))
    save()
    flush()
  }

  /// Keeps a command at once, due at `due` (ms), in place of what it kept under `replacing` if that
  /// hasn't gone yet; the id it's kept under. If iOS ends the app first, the next run sends it.
  @discardableResult
  func hold(_ name: String, _ payload: JSON, replacing: String? = nil, due: Double) -> String {
    let id = replacing.flatMap { id in !sending.contains(id) && has(id) ? id : nil } ?? UUID().uuidString
    here.entries.removeAll { $0.id == id }
    here.entries.append(Entry(id: id, kind: .command, name: name, payload: payload, due: due, time: Date().timeIntervalSince1970 * 1000))
    save()
    flush()
    return id
  }

  /// Sends what's held now.
  func release(_ id: String) {
    guard let i = here.entries.firstIndex(where: { $0.id == id }), here.entries[i].due != nil else { return }
    here.entries[i].due = nil
    save()
    flush()
  }

  /// Drops what's kept unsent; false if it's already going.
  @discardableResult
  func drop(_ id: String) -> Bool {
    guard !sending.contains(id), has(id) else { return false }
    done(id)
    return true
  }

  /// The newest kept command of `name` whose payload `matches`, and its id.
  func latest(_ name: String, _ matches: (JSON) -> Bool) -> (id: String, payload: JSON)? {
    here.entries.last { $0.name == name && matches($0.payload) }.map { ($0.id, $0.payload) }
  }

  /// A command given in the app: kept like the rest, and the core's answer told to the caller, so a
  /// "no" shows where it was given. Not answered before the socket goes, the next one sends it.
  @discardableResult
  func send(_ name: String, _ payload: JSON, id: String = UUID().uuidString) async throws -> Int {
    if !has(id) {
      here.entries.append(Entry(id: id, kind: .command, name: name, payload: payload, time: Date().timeIntervalSince1970 * 1000))
      save()
    }
    return try await now(id)
  }

  /// Sends what's kept under `id` now, held or not, with the core's answer.
  @discardableResult
  func now(_ id: String) async throws -> Int {
    guard let sync else { throw Sync.Rejected(reason: "No core") }
    // Going already: its end.
    while sending.contains(id) { try await Task.sleep(for: .milliseconds(100)) }
    guard let e = here.entries.first(where: { $0.id == id }) else { return 0 }
    sending.insert(id)
    do {
      let seq = try await deliver(e, sync)
      done(id, seq: seq)
      return seq
    } catch let rejected as Sync.Rejected {
      done(id)
      throw rejected
    } catch {
      if self.sync === sync { sending.remove(id) }
      throw error
    }
  }

  /// One of a widget's extension's tools, with an id so a retry never runs it twice; returns once
  /// it's been called, or kept to try again.
  func call(_ name: String, _ payload: JSON) async {
    let id = UUID().uuidString
    let e = Entry(id: id, kind: .call, name: name, payload: payload, time: Date().timeIntervalSince1970 * 1000)
    here.entries.append(e)
    save()
    guard let sync else { return }
    sending.insert(id)
    do {
      _ = try await deliver(e, sync)
      done(id)
    } catch is Sync.Rejected {
      done(id)
    } catch {
      if self.sync === sync { sending.remove(id) }
      retry(id)
    }
  }

  /// Sends what's kept through a new socket and its core; what's kept for another core stays.
  func use(_ sync: Sync?) {
    self.sync = sync
    sending = []
    for t in timers.values { t.cancel() }
    timers = [:]
    core = sync.map { Self.key($0.credential.core) } ?? Self.unpaired
    if core != Self.unpaired, let old = doc.cores.removeValue(forKey: Self.unpaired) {
      here.entries += old.entries.filter { e in !here.entries.contains { $0.id == e.id } }
      here.drafts.merge(old.drafts) { kept, _ in kept }
    }
    save()
    flush()
  }

  // MARK: Boxes

  func draft(_ place: String) -> Draft? { here.drafts[place] }

  /// What's in a box, kept at each change; an empty one goes.
  func keep(_ draft: Draft, at place: String) {
    guard here.drafts[place] != draft else { return }
    if draft.isEmpty { here.drafts[place] = nil } else { here.drafts[place] = draft }
    save()
  }

  /// A message the core said no to, back in its box (after what's there) and out of the outbox.
  func retake(_ id: String, into place: String) {
    guard let e = here.entries.first(where: { $0.id == id }), e.rejected != nil else { return }
    here.entries.removeAll { $0.id == id }
    var d = here.drafts[place] ?? Draft(text: "")
    let text = e.payload["text"].str
    let at = d.text.isEmpty ? 0 : d.text.unicodeScalars.count + 1
    let moved = e.payload["dictated"].array.map { s in
      JSON.object(["start": .number((s["start"].number ?? 0) + Double(at)), "text": s["text"]])
    }
    if !text.isEmpty { d.text = d.text.isEmpty ? text : d.text + "\n" + text }
    let dictated = (d.dictated?.array ?? []) + moved
    d.dictated = dictated.isEmpty ? nil : .array(dictated)
    let files = (d.files ?? []) + (e.files ?? [])
    d.files = files.isEmpty ? nil : files
    let replies = (d.replyTo?.array ?? []) + e.payload["replyTo"].array
    d.replyTo = replies.isEmpty ? nil : .array(replies)
    here.drafts[place] = d
    retaken[place, default: 0] += 1
    save()
  }

  /// What a box replies to, attached to it, unless it's there already.
  func reply(_ r: Reply, at place: String) {
    var d = here.drafts[place] ?? Draft(text: "")
    let now = d.replyTo?.array ?? []
    guard !now.contains(r.json) else { return }
    d.replyTo = .array(now + [r.json])
    here.drafts[place] = d
    retaken[place, default: 0] += 1
    save()
  }

  // MARK: Sending

  private func flush() {
    guard let sync else { return }
    let now = Date().timeIntervalSince1970 * 1000
    for e in here.entries where !sending.contains(e.id) && e.rejected == nil {
      if let due = e.due, due > now {
        timers[e.id]?.cancel()
        timers[e.id] = Task { [weak self] in
          try? await Task.sleep(for: .milliseconds(Int(due - now) + 1))
          guard !Task.isCancelled else { return }
          self?.timers[e.id] = nil
          self?.flush()
        }
        continue
      }
      sending.insert(e.id)
      Task {
        do {
          let seq = try await deliver(e, sync)
          done(e.id, seq: seq)
        } catch let rejected as Sync.Rejected {
          // The core read it and said no: sending it again won't change that.
          if e.view != nil { reject(e.id, rejected.reason) } else { done(e.id) }
        } catch let failed as Blobs.Failed where failed.permanent {
          reject(e.id, failed.reason)
        } catch {
          // The socket went (unpaired), or a file didn't go up: later.
          if self.sync === sync {
            sending.remove(e.id)
            retry(e.id)
          }
        }
      }
    }
  }

  private func retry(_ id: String) {
    guard timers[id] == nil else { return }
    timers[id] = Task { [weak self] in
      try? await Task.sleep(for: Self.retryAfter)
      guard !Task.isCancelled else { return }
      self?.timers[id] = nil
      self?.flush()
    }
  }

  /// Its files up first (each blob kept as it lands), then it goes; the core's seq for a command.
  private func deliver(_ e: Entry, _ sync: Sync) async throws -> Int {
    var payload = e.payload
    if let files = e.files, !files.isEmpty {
      var up: [Attachment] = []
      for f in files {
        if let a = f.attachment {
          up.append(a)
          continue
        }
        guard FileManager.default.fileExists(atPath: Self.bytes(f.id).path) else { throw Blobs.Failed(reason: "Can't read it") }
        let a = try await Blobs.upload(Self.bytes(f.id), name: f.name, type: f.type)
        up.append(a)
        stored(f.id, blob: a.blob, in: e.id)
      }
      var fields = payload.object
      fields["attachments"] = .array(up.map(\.json))
      payload = .object(fields)
    }
    switch e.kind {
    case .command: return try await sync.command(e.name, payload, id: e.id)
    case .emit:
      try await sync.emit(e.name, payload, id: e.id)
      return 0
    case .call:
      _ = try await sync.post("widgets/\(e.name)?id=\(e.id)", payload.data)
      return 0
    }
  }

  /// A file of an entry is up: its blob is kept, its bytes go.
  private func stored(_ file: String, blob: String, in entry: String) {
    guard let i = here.entries.firstIndex(where: { $0.id == entry }), let j = here.entries[i].files?.firstIndex(where: { $0.id == file })
    else { return }
    here.entries[i].files?[j].blob = blob
    // Its message draws it from here once it's in, as its bubble did while it went up.
    if let f = here.entries[i].files?[j], let a = f.attachment {
      Blobs.keep(Self.bytes(file), as: a)
      if let was = Blobs.sending(f) { Drawn.same(was.path, as: a.blob) }
    }
    save()
    try? FileManager.default.removeItem(at: Self.bytes(file))
  }

  private func reject(_ id: String, _ reason: String) {
    sending.remove(id)
    guard let i = here.entries.firstIndex(where: { $0.id == id }) else { return }
    here.entries[i].rejected = reason
    save()
  }

  private func done(_ id: String, seq: Int = 0) {
    sending.remove(id)
    timers.removeValue(forKey: id)?.cancel()
    guard let e = here.entries.first(where: { $0.id == id }) else { return }
    here.entries.removeAll { $0.id == id }
    if e.view != nil { landed(e, seq) }
    for f in e.files ?? [] {
      try? FileManager.default.removeItem(at: Self.bytes(f.id))
      Blobs.sent(f.id)
    }
    save()
  }

  private func save() {
    let now = here.entries.filter { $0.view != nil && $0.name == "message.post" }
    if now != posts { posts = now }
    try? FileManager.default.createDirectory(at: Self.dir, withIntermediateDirectories: true)
    try? JSONEncoder().encode(doc).write(to: Self.file, options: .atomic)
  }

  /// Bytes no entry or box holds any more (one sent, a box emptied) go, at launch.
  private func sweep() {
    let held = Set(doc.cores.values.flatMap { c in c.entries.flatMap { $0.files ?? [] } + c.drafts.values.flatMap { $0.files ?? [] } }.map(\.id))
    guard let all = try? FileManager.default.contentsOfDirectory(atPath: Self.folder.path) else { return }
    for name in all where !held.contains(name) { try? FileManager.default.removeItem(at: Self.folder.appending(path: name)) }
  }
}

extension Blobs.Failed {
  /// Trying again won't help.
  var permanent: Bool { ["Too big", "Core's disk is full", "Can't read it"].contains(reason) }
}
