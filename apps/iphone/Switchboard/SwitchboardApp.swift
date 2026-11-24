import SwiftUI

@main
struct SwitchboardApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @Environment(\.scenePhase) private var phase
  @State private var backgrounded: Date?

  var body: some Scene {
    WindowGroup {
      RootView(phone: Phone.shared)
        .preferredColorScheme(.dark)
        .onOpenURL { Phone.shared.open(url: $0) }
    }
    .onChange(of: phase) { _, now in
      switch now {
      case .active:
        Trail.shared.note("active")
        // T3 Code's mobile wakeups: back within 10 s probes the socket; longer, the page is stale.
        let away = backgrounded.map { Date().timeIntervalSince($0) } ?? 0
        Phone.shared.active(long: away >= 10)
        backgrounded = nil
      case .background:
        Trail.shared.note("background")
        backgrounded = Date()
      case .inactive:
        Trail.shared.note("inactive")
      @unknown default:
        break
      }
    }
  }
}

/// Where a page is: a space, or a thread opened from one.
enum Route: Hashable {
  case space(String)
  case thread(String)
  case memory
  case system
}

/// The app: one brain, its socket, the widget host, and what the phone tells the core.
@MainActor @Observable
final class Phone {
  static let shared = Phone()

  let brain = Brain()
  /// Where the core is and this phone's token there; nil until paired.
  private(set) var credential: Credential?
  private(set) var sync: Sync?
  let pairing = PairFlow()
  let widgets = WidgetHost()
  var path: [Route] = []
  /// The palette's open.
  var finding = false
  /// A pass a notification asked to add.
  var passToAdd: String?
  /// The action item whose sheet is open.
  var asking: String?
  /// The action item whose live view a notification opened, full screen.
  var portal: String?
  /// An action item a notification or link pointed at, scrolled to on its space's board.
  var lit: String?
  /// An item asked for before the brain was read: opened once it is.
  @ObservationIgnored private var wanted: String?
  @ObservationIgnored private var started = false
  /// A line of each space's chat to bring into view and ring, by seq: what find opened.
  var chatAt: [String: Int] = [:]
  /// The space whose chat the find bar is open on.
  var findingIn: String?

  /// This install's id, for the core's record of it.
  let device: String = {
    let key = "device"
    if let id = UserDefaults.standard.string(forKey: key) { return id }
    let id = UUID().uuidString.lowercased()
    UserDefaults.standard.set(id, forKey: key)
    return id
  }()

  /// Set once this phone has paired: an older build's core address is moved over only before then.
  private static let pairedKey = "paired"

  private init() {
    pairing.paired = { [weak self] credential in self?.paired(credential) }
    Outbox.shared.landed = { [weak self] e, seq in self?.landed(e, seq) }
    widgets.attach(
      brain: brain,
      get: { [weak self] path in try? await self?.sync?.get(path) },
      post: { [weak self] path, body in
        guard let sync = self?.sync else { throw Sync.Rejected(reason: "No core") }
        return try await sync.post(path, body)
      }
    ) { [weak self] types in
      self?.sync?.watch(types)
    }
    brain.watchers.append { [weak self] e in
      // A card taken out of the queue to be reworked, or put back, counts as closed or open does.
      if e.type == "item.closed" || e.type == "item.revised", let self { Push.shared.tidy(open: Set(self.brain.actions.keys)) }
    }
    if let credential = Credential.load() {
      connect(credential)
    } else if !UserDefaults.standard.bool(forKey: Self.pairedKey), let legacy = Credential.legacy {
      // An older build's core: the code flow, which the core approves by itself while it migrates.
      pairing.start(legacy)
    }
    // A link to open at launch (`-open switchboard://space/<id>`), as a tapped one would.
    if let link = UserDefaults.standard.string(forKey: "open"), let url = URL(string: link) { open(url: url) }
  }

  func active(long: Bool) {
    sync?.wake(long ? .activeLong : .activeProbe)
    guard sync != nil else { return }
    emit("iphone.opened", ["device": .string(device)])
    Push.shared.woke()
    Places.shared.look()
    if brain.ready { Push.shared.tidy(open: Set(brain.actions.keys)) }
  }

  // MARK: Pairing

  private func paired(_ new: Credential) {
    if let old = credential, old != new { forget(old) }
    new.save()
    UserDefaults.standard.set(true, forKey: Self.pairedKey)
    Trail.shared.note("paired")
    connect(new)
  }

  private func connect(_ credential: Credential) {
    sync?.stop()
    brain.reset()
    self.credential = credential
    let sync = Sync(credential: credential, source: "iphone")
    sync.onSnapshot = { [weak self] seq, state in self?.snapshot(seq, state) }
    sync.onEvents = { [brain] events in brain.apply(events) }
    sync.onLink = { [brain] link in brain.link = link }
    sync.onUnauthorized = { [weak self] in self?.unpaired() }
    self.sync = sync
    sync.start()
    Outbox.shared.use(sync)
    Task { await widgets.list() }
    if started {
      Push.shared.connected()
    } else {
      started = true
      LiveActivities.shared.start(self)
      Push.shared.start(self)
      Places.shared.start(self)
    }
    emit("iphone.opened", ["device": .string(device)])
  }

  private func snapshot(_ seq: Int, _ state: JSON) {
    brain.applySnapshot(seq, state)
    Push.shared.tidy(open: Set(brain.actions.keys))
    if let wanted {
      self.wanted = nil
      openItem(wanted, in: nil)
    }
  }

  /// Unpair: the core's told (if it can be reached), and the pair screen shows.
  func unpair() {
    guard let credential else { return }
    forget(credential)
    unpaired()
  }

  /// Revokes a credential at its core, best effort.
  private func forget(_ credential: Credential) {
    var r = credential.request("auth/self")
    r.httpMethod = "DELETE"
    r.timeoutInterval = 5
    Task { _ = try? await URLSession.shared.data(for: r) }
  }

  /// The credential is gone (unpaired here, or revoked: the core said 401).
  private func unpaired() {
    Trail.shared.note("unpaired")
    Credential.forget()
    sync?.stop()
    sync = nil
    credential = nil
    Outbox.shared.use(nil)
    brain.reset()
    path = []
    finding = false
    pairing.cancel()
  }

  // MARK: Saying things to the brain

  /// Kept in the Outbox at once, its files still to go up, and shown from there until the core has
  /// it; one the brain says no to stays, marked "Not sent". It says which words were dictated.
  func post(_ space: String, _ words: Words, _ files: [Outbox.File] = []) {
    var payload = words.payload
    payload["space"] = .string(space)
    Trail.shared.note("sent message.post")
    Outbox.shared.add(.command, "message.post", .object(payload), files: files.isEmpty ? nil : files, view: ["space": .string(space)])
  }

  /// A message the brain said no to, back in its space's box.
  func retake(_ id: String, space: String) {
    Outbox.shared.retake(id, into: "space:\(space)")
  }

  /// The core took a message: its bubble stays until its line is in.
  private func landed(_ e: Outbox.Entry, _ seq: Int) {
    guard brain.seq < seq, !brain.arrived.contains(e.id), var p = Pending(e) else { return }
    p.landed = seq
    brain.pending[e.id] = p
  }

  /// Kept until the core has it, even if iOS ends the app first (Outbox).
  @discardableResult
  func command(_ type: String, _ payload: JSON) async throws -> Int {
    Trail.shared.note("sent \(type)")
    return try await Outbox.shared.send(type, payload)
  }

  /// An answer given from a notification: kept until the core has it, even if iOS ends the app.
  func answer(_ type: String, _ payload: JSON, id: String) {
    Trail.shared.note("answered \(type)")
    Outbox.shared.add(.command, type, payload, id: id)
  }

  func steer(_ thread: String, _ words: Words) async throws {
    try await command("thread.steer", .object(words.payload.merging(["thread": .string(thread)]) { _, given in given }))
  }

  /// A space's chat on screen is read to its latest reply: the mark clears here and everywhere.
  func read(_ space: String) {
    guard let at = brain.unreadAt(space) else { return }
    brain.readTo(space, at)
    Task { try? await command("space.read", ["space": .string(space), "seq": .number(Double(at))]) }
  }

  /// What was said and kept that holds the words, across every space, best first.
  func find(_ query: String) async -> [Found] {
    guard let sync, let page = try? await sync.page("find", ["query": .string(query)]) else { return [] }
    return page.array.map(Found.init)
  }

  /// The seqs of a space's chat lines that hold the words, oldest first.
  func find(_ query: String, in space: String) async -> [Int] {
    guard let sync, let page = try? await sync.page("find", ["query": .string(query), "space": .string(space)]) else { return [] }
    return page.array.compactMap { $0.number.map { Int($0) } }
  }

  /// Opens a space at a line of its chat, brought into view.
  func open(_ space: String, at seq: Int) {
    chatAt[space] = seq
    open(.space(space))
  }

  /// Stops a thread's running turn.
  func stop(_ thread: String) async throws {
    try await command("thread.stop", ["thread": .string(thread)])
  }

  /// Runs a turn that didn't finish again.
  func retry(_ thread: String) async throws {
    try await command("thread.retry", ["thread": .string(thread)])
  }

  /// The user's last message, changed: the brain runs it again, or sends it new once what it
  /// started reached outside.
  func edit(_ seq: Int, _ text: String) async throws {
    try await command("message.edit", ["seq": .number(Double(seq)), "text": .string(text)])
  }

  /// The user's tapback on a line, as iMessage's: the one they have again takes it off, another
  /// replaces it. Shows at once; put back if the brain says no.
  func react(_ seq: Int, _ reaction: Reaction, was: Reaction?) {
    let chosen = reaction == was ? nil : reaction
    brain.react(seq, agent: false, chosen)
    Task {
      do {
        try await command("message.react", ["seq": .number(Double(seq)), "reaction": chosen.map { JSON.string($0.rawValue) } ?? .null])
      } catch {
        brain.react(seq, agent: false, was)
      }
    }
  }

  /// Best effort: a dropped one isn't worth a word on screen.
  func emit(_ event: String, _ payload: JSON) {
    Task { try? await sync?.emit(event, payload) }
  }

  // MARK: Older history, a page at a time

  @ObservationIgnored private var paging: Set<String> = []

  private func pageOnce(_ key: String, _ name: String, _ args: JSON, _ done: @escaping (JSON) -> Void) {
    guard let sync, paging.insert(key).inserted else { return }
    Task {
      defer { paging.remove(key) }
      if let page = try? await sync.page(name, args) { done(page) }
    }
  }

  /// A page of the brain's view by name: the memories, the system page.
  func page(_ name: String) async throws -> JSON {
    guard let sync else { throw Sync.Rejected(reason: "No core") }
    return try await sync.page(name, [:])
  }

  /// Forgets a memory, putting back what it replaced: the memory page's Forget, a line's Undo.
  func forget(_ id: String, restore: [String] = []) async throws {
    try await command("memory.forget", ["id": .string(id), "restore": .array(restore.map(JSON.string))])
  }

  /// Pages in a space's older chat.
  func olderChat(_ space: String) {
    // A chat not held (an archived space's) pages in from the latest.
    let chat = brain.chats[space] ?? Chat(more: true)
    guard chat.more else { return }
    let before = chat.lines.first?.seq ?? Int.max
    pageOnce("chat:\(space)", "chat", ["space": .string(space), "before": .number(Double(before))]) { [brain] in
      brain.addChatPage(space, $0)
    }
  }

  /// Pages in a thread's transcript: the latest when it opens, then older as the user scrolls up.
  func olderItems(_ thread: String) {
    guard let t = brain.threads[thread], !t.loaded || t.more else { return }
    let before = t.loaded ? Double(t.items.first?.seq ?? Int.max) : Double(Int.max)
    pageOnce("thread:\(thread)", "thread", ["thread": .string(thread), "before": .number(before)]) { [brain] in
      brain.addThreadPage(thread, $0)
    }
  }

  // MARK: Going places

  /// The space the page in front is in.
  var here: String {
    for r in path.reversed() {
      switch r {
      case .space(let id): return id
      case .thread(let id): return brain.threads[id].map(brain.spaceOf) ?? HOME
      case .memory, .system: continue
      }
    }
    return HOME
  }

  /// What's on screen, for the crash reports' trail: the page and its space.
  var screen: String {
    guard credential != nil else { return "pair" }
    let name = { (id: String) in self.brain.spaces[id]?.name ?? id }
    switch path.last {
    case .thread(let id): return "thread \(brain.threads[id]?.title ?? id) in \(name(here))"
    default: return "space \(name(here))"
    }
  }

  func open(_ route: Route) {
    if case .space(let to) = route {
      if to != here { switched("space", from: here, to: to) }
      Push.shared.seen(to)
    }
    if case .space(HOME) = route {
      path = []
      return
    }
    if let at = path.lastIndex(of: route) {
      path = Array(path[...at])
      return
    }
    path.append(route)
  }

  /// An action item's space, scrolled to the item. Before the brain's read, once it is.
  func openItem(_ item: String, in space: String?) {
    guard let to = (brain.actions[item] ?? brain.revising[item])?.space ?? space else {
      if !brain.ready { wanted = item }
      return
    }
    lit = item
    open(.space(to))
  }

  /// A space, scrolled to a chat line if given.
  func openSpace(_ space: String, at seq: Int?) {
    if let seq { open(space, at: seq) } else { open(.space(space)) }
  }

  /// `switchboard://space/<id>[?seq=<n>]`, `switchboard://thread/<id>`, `switchboard://item/<id>` (its sheet),
  /// `switchboard://pass/<serial>`, `switchboard://pair?core=<url>&offer=<offer>`, and the old app's
  /// `open/ws/<slug>`, `workspace/<slug>`, `work/<id>` and `ask/<id>`. What can't be found opens Home.
  func open(url: URL) {
    var parts = ([url.host() ?? ""] + url.pathComponents.dropFirst()).filter { !$0.isEmpty }
    if parts.first == "open" { parts.removeFirst() }
    let kind = parts.first ?? ""
    let id = parts.dropFirst().joined(separator: "/").removingPercentEncoding ?? ""
    let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    let value = { (name: String) in query.first { $0.name == name }?.value }
    switch kind {
    case "pair":
      guard let core = value("core").flatMap(Credential.coreURL), let offer = value("offer"), !offer.isEmpty else { return }
      // Already paired there: a second credential would be one too many.
      guard credential?.core != core else { return }
      pairing.redeem(core, offer: offer)
    case "space": openSpace(id.isEmpty ? HOME : id, at: value("seq").flatMap { Int($0) })
    case "ws", "workspace": open(.space(spaceNamed(id)))
    case "thread": open(.thread(id))
    case "work":
      if let t = [id, "sb:\(id)", "space:\(id)"].first(where: { brain.threads[$0] != nil }) {
        open(.thread(t))
      } else {
        open(.space(HOME))
      }
    case "item":
      openItem(id, in: nil)
      asking = id
    case "ask": open(.space((brain.actions[id] ?? brain.revising[id])?.space ?? HOME))
    // A link the agent wrote to a bare id: whichever record has it.
    case "id":
      if brain.actions[id] != nil || brain.revising[id] != nil {
        openItem(id, in: nil)
        asking = id
      } else if let t = [id, "sb:\(id)", "space:\(id)"].first(where: { brain.threads[$0] != nil }) {
        open(.thread(t))
      } else {
        open(.space(spaceNamed(id)))
      }
    case "pass": passToAdd = id
    default: open(.space(HOME))
    }
  }

  /// A space by id, or an old workspace's slug: its id, or its name made a slug.
  private func spaceNamed(_ given: String) -> String {
    let want = given.hasPrefix("ws:") ? String(given.dropFirst(3)) : given
    if want.isEmpty || want == HOME { return HOME }
    let slug = { (s: String) in
      s.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
        .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
    return brain.spaces[want]?.id
      ?? brain.spaces.values.first { $0.id.lowercased() == want.lowercased() || slug($0.name) == slug(want) }?.id
      ?? HOME
  }

  /// A space's link, as Copy Link gives it.
  static func link(_ space: String) -> String {
    "switchboard://space/\(space.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? space)"
  }

  // MARK: UI analytics: what the user did, felt like touch

  private static let backedOutMs = 2000.0

  func viewed(_ surface: String, _ item: String) {
    emit("ui.viewed", ["surface": .string(surface), "item": .string(item)])
  }

  func switched(_ surface: String, from: String, to: String) {
    emit("ui.switched", ["surface": .string(surface), "from": .string(from), "to": .string(to)])
  }

  /// Leaving something opened at `opened`: backed out if quick, else a dwell.
  func left(_ surface: String, _ item: String, opened: Date) {
    let ms = max(0, Date().timeIntervalSince(opened) * 1000)
    emit(ms < Self.backedOutMs ? "ui.backed_out" : "ui.dwelled", ["surface": .string(surface), "item": .string(item), "ms": .number(ms.rounded())])
  }
}
