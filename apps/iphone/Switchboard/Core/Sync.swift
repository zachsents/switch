import Foundation
import Network

/// One event of the brain's log, as the sync socket sends it.
nonisolated struct StoredEvent: Sendable {
  let seq: Int
  let id: String
  let time: Double
  let type: String
  let source: String
  let payload: JSON

  init?(_ j: JSON) {
    guard let seq = j["seq"].number, let type = j["type"].string else { return nil }
    self.seq = Int(seq)
    id = j["id"].str
    time = j["time"].number ?? 0
    self.type = type
    source = j["source"].str
    payload = j["payload"]
  }
}

/// Why the supervisor was woken, as T3 Code's mobile app names them (client-runtime's wakeups.ts).
enum Wakeup {
  /// Back in front after under 10 seconds.
  case activeProbe
  /// Back in front after longer: what's on screen is stale.
  case activeLong
  case networkChanged
  case offline
}

/// The brain's sync socket (packages/brain/src/sync.ts): a snapshot of its projections on a cold
/// start, the log since a cursor after that, live events, and commands back on the same socket.
///
/// It keeps itself up the way T3 Code's reconnect supervisor does (client-runtime's
/// connection/supervisor.ts): jittered exponential backoff from 1 s to 5 min, reset after 30 s
/// connected; a quick retry after losing a live session; a 15 s limit to connect; and on a wakeup
/// (back in front, a network change) a probe of the live socket instead of a new one, replaced if it
/// stays silent while the host answers a fresh request, or at once after a long suspension.
@MainActor
final class Sync: NSObject, URLSessionWebSocketDelegate {
  enum Link: Equatable { case connecting, open, down }

  var onSnapshot: (Int, JSON) -> Void = { _, _ in }
  var onEvents: ([StoredEvent]) -> Void = { _ in }
  var onLink: (Link) -> Void = { _ in }
  /// The core said this phone's token is no good (revoked), and kept saying so: pair again.
  var onUnauthorized: () -> Void = {}

  let credential: Credential
  let source: String

  private static let retryBase = 1_000.0
  private static let retryMax = 300_000.0
  private static let lossRetry = 0.25
  private static let backoffResetAfter = 30.0
  private static let establishment = 15.0
  /// How long a drop may last before it shows.
  private static let downAfter = 2.0
  private static let probeTimeout = 15.0
  private static let quickProbe = 3.0
  private static let longResumeProbe = 1.5
  private static let silentCheckAfter = 0.5
  private static let remoteSilentAfter = 2.5

  private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
  private var task: URLSessionWebSocketTask?
  /// Each socket's number: what a stale socket's callbacks are told apart by.
  private var generation = 0
  private var opened: Date?
  private var lastFrame = Date.distantPast
  private var cursor: Int?
  private var failures = 0
  private var retry: Task<Void, Never>?
  private var establishing: Task<Void, Never>?
  private var down: Task<Void, Never>?
  private var probing = false
  /// Probes made, and the latest whose ping came back: a probe's answer, kept where both its tasks see it.
  private var probes = 0
  private var answered = 0
  private var watched: [String] = []
  private var waiting: [String: (message: JSON, done: CheckedContinuation<JSON, Error>)] = [:]
  private var order: [String] = []
  private let path = NWPathMonitor()
  private var lastPath: NWPath.Status?
  private(set) var link: Link = .connecting

  private var stopped = false
  /// A 401 being checked before it unpairs.
  private var doubting = false
  private static let checks = 3
  private static let checkEvery = 5.0

  init(credential: Credential, source: String) {
    self.credential = credential
    self.source = source
    super.init()
  }

  /// A GET of the core's HTTP (its widgets, passes) with this phone's token; a 401 that holds unpairs.
  func get(_ path: String) async throws -> Data {
    let (data, response) = try await URLSession.shared.data(for: credential.request(path))
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 401 { unauthorized() }
    guard status == 200 else { throw Rejected(reason: "Core said \(status)") }
    return data
  }

  /// A POST of the core's HTTP (a widget's tool) with this phone's token; a 401 that holds unpairs.
  func post(_ path: String, _ body: Data) async throws -> Data {
    var request = credential.request(path)
    request.httpMethod = "POST"
    request.setValue("text/plain", forHTTPHeaderField: "Content-Type")
    request.httpBody = body
    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 401 { unauthorized() }
    guard status == 200 else { throw Rejected(reason: "Core said \(status)") }
    return data
  }

  /// A 401 may be a core mid-restart: unpaired only if `auth/self` says 401 each time it's asked, a
  /// few seconds apart.
  private func unauthorized() {
    guard !stopped, !doubting else { return }
    doubting = true
    Task { [weak self] in
      for _ in 0..<Self.checks {
        try? await Task.sleep(for: .seconds(Self.checkEvery))
        guard let self, !self.stopped else { return }
        var r = self.credential.request("auth/self")
        r.timeoutInterval = 10
        let status = (try? await URLSession.shared.data(for: r)).flatMap { ($0.1 as? HTTPURLResponse)?.statusCode }
        if status != 401 {
          self.doubting = false
          return
        }
      }
      guard let self, !self.stopped else { return }
      self.onUnauthorized()
    }
  }

  /// Done with this socket for good (unpaired): what's waiting fails with `Stopped`.
  func stop() {
    stopped = true
    generation += 1
    path.cancel()
    retry?.cancel()
    establishing?.cancel()
    down?.cancel()
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    let all = waiting.values
    waiting = [:]
    order = []
    for w in all { w.done.resume(throwing: Stopped()) }
  }

  func start() {
    path.pathUpdateHandler = { [weak self] p in
      Task { @MainActor in self?.pathChanged(p.status) }
    }
    path.start(queue: .main)
    open()
  }

  private func pathChanged(_ status: NWPath.Status) {
    defer { lastPath = status }
    guard let lastPath, lastPath != status || status == .satisfied else { return }
    wake(status == .satisfied ? .networkChanged : .offline)
  }

  private func setLink(_ l: Link) {
    guard l != link else { return }
    link = l
    onLink(l)
  }

  // MARK: The socket

  private func open() {
    retry?.cancel()
    retry = nil
    generation += 1
    let gen = generation
    task?.cancel(with: .goingAway, reason: nil)
    guard !stopped else { return }
    var c = URLComponents(url: credential.core, resolvingAgainstBaseURL: false)!
    c.scheme = c.scheme == "https" ? "wss" : "ws"
    c.path = "/"
    var query = [URLQueryItem(name: "source", value: source)]
    if let cursor { query.append(URLQueryItem(name: "since", value: String(cursor))) }
    c.queryItems = query
    var request = URLRequest(url: c.url!)
    request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
    let t = session.webSocketTask(with: request)
    t.maximumMessageSize = 64 << 20
    task = t
    opened = nil
    if link != .down { setLink(.connecting) }
    t.resume()
    receive(t, gen)
    establishing?.cancel()
    establishing = Task { [weak self] in
      try? await Task.sleep(for: .seconds(Self.establishment))
      guard let self, !Task.isCancelled, self.generation == gen, self.opened == nil else { return }
      self.lost(gen, failed: true)
    }
  }

  nonisolated func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?
  ) {
    MainActor.assumeIsolated { self.didOpen(webSocketTask) }
  }

  nonisolated func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    MainActor.assumeIsolated {
      guard webSocketTask === self.task else { return }
      self.lost(self.generation, failed: self.opened == nil)
    }
  }

  private func didOpen(_ t: URLSessionWebSocketTask) {
    guard t === task else { return }
    opened = Date()
    lastFrame = Date()
    establishing?.cancel()
    down?.cancel()
    setLink(.open)
    if !watched.isEmpty { write(["type": "watch", "types": .array(watched.map(JSON.string))]) }
    for id in order {
      if let w = waiting[id] { write(w.message) }
    }
  }

  private func receive(_ t: URLSessionWebSocketTask, _ gen: Int) {
    t.receive { [weak self] result in
      Task { @MainActor in
        guard let self, self.generation == gen else { return }
        switch result {
        case .failure:
          // Refused at the upgrade: the token may have been revoked. Retried meanwhile.
          if (t.response as? HTTPURLResponse)?.statusCode == 401 { self.unauthorized() }
          self.lost(gen, failed: self.opened == nil)
        case .success(let message):
          self.lastFrame = Date()
          switch message {
          case .string(let text): self.handle(text)
          case .data(let data): self.handle(String(decoding: data, as: UTF8.self))
          @unknown default: break
          }
          self.receive(t, gen)
        }
      }
    }
  }

  private func handle(_ text: String) {
    guard let m = JSON.parse(text) else { return }
    switch m["type"].str {
    case "snapshot":
      let seq = Int(m["seq"].number ?? 0)
      cursor = seq
      onSnapshot(seq, m["state"])
    case "events":
      let fresh = m["events"].array.compactMap(StoredEvent.init).filter { $0.seq > (cursor ?? 0) }
      guard let last = fresh.last else { return }
      cursor = last.seq
      onEvents(fresh)
    case "receipt", "rejected", "page":
      let id = m["id"].str
      guard let w = waiting.removeValue(forKey: id) else { return }
      order.removeAll { $0 == id }
      if m["type"].str != "rejected" {
        w.done.resume(returning: m)
      } else {
        w.done.resume(throwing: Rejected(reason: m["reason"].str))
      }
    default:
      break
    }
  }

  /// The socket is gone: show it after a moment, and try again on the supervisor's schedule.
  private func lost(_ gen: Int, failed: Bool) {
    guard gen == generation, retry == nil, !stopped else { return }
    let lived = opened.map { Date().timeIntervalSince($0) } ?? 0
    let wasOpen = opened != nil
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    opened = nil
    establishing?.cancel()
    if lived >= Self.backoffResetAfter { failures = 0 }
    let delay: Double
    if wasOpen && !failed {
      delay = Self.lossRetry
    } else {
      let ceiling = min(Self.retryMax, Self.retryBase * pow(2, Double(failures + 1)))
      delay = (ceiling / 2 + ceiling / 2 * Double.random(in: 0...1)) / 1000
      failures += 1
    }
    down?.cancel()
    down = Task { [weak self] in
      try? await Task.sleep(for: .seconds(Self.downAfter))
      guard let self, !Task.isCancelled, self.opened == nil else { return }
      self.setLink(.down)
    }
    retry = Task { [weak self] in
      try? await Task.sleep(for: .seconds(delay))
      guard let self, !Task.isCancelled else { return }
      self.retry = nil
      self.open()
    }
  }

  // MARK: Wakeups

  /// Back in front or a network change: retry now if waiting, else probe the live socket.
  func wake(_ reason: Wakeup) {
    if reason != .offline { failures = 0 }
    guard let t = task, opened != nil else {
      if reason != .offline { open() }
      return
    }
    guard !probing else { return }
    let timeout: Double =
      switch reason {
      case .activeLong: Self.longResumeProbe
      case .offline: Self.quickProbe
      case .activeProbe, .networkChanged: Self.probeTimeout
      }
    probe(t, generation, timeout: timeout, long: reason == .activeLong)
  }

  private func probe(_ t: URLSessionWebSocketTask, _ gen: Int, timeout: Double, long: Bool) {
    probing = true
    let started = Date()
    probes += 1
    let probe = probes
    // URLSession can call a ping's handler more than once (a pong, then an error as the socket
    // closes), so its answer is kept on Sync, never through a one-shot continuation.
    t.sendPing { [weak self] error in
      Task { @MainActor in
        guard let self else { return }
        self.answered = max(self.answered, probe)
        guard self.generation == gen else { return }
        if error != nil { self.lost(gen, failed: false) }
      }
    }
    Task { [weak self] in
      // A ping still unanswered: ask the host with a fresh request. If it answers while the
      // socket stays silent, the socket is dead, as when iOS kills a suspended one without a close.
      try? await Task.sleep(for: .seconds(Self.silentCheckAfter))
      guard let self, self.answered < probe, self.generation == gen else { self?.probing = false; return }
      let hostAnswers = await self.hostAnswers()
      let silentFor = long ? 0 : Self.remoteSilentAfter
      while self.answered < probe && self.generation == gen {
        let waited = Date().timeIntervalSince(started)
        let silent = Date().timeIntervalSince(self.lastFrame)
        if (hostAnswers && silent >= silentFor && waited >= silentFor) || waited >= timeout { break }
        try? await Task.sleep(for: .milliseconds(100))
      }
      self.probing = false
      if self.answered < probe && self.generation == gen {
        self.lost(gen, failed: false)
      }
    }
  }

  private func hostAnswers() async -> Bool {
    var request = credential.request("widgets")
    request.timeoutInterval = Self.quickProbe
    return (try? await URLSession.shared.data(for: request)) != nil
  }

  // MARK: Commands

  struct Rejected: LocalizedError {
    let reason: String
    var errorDescription: String? { reason }
  }

  struct Stopped: LocalizedError {
    var errorDescription: String? { "Unpaired" }
  }

  private func write(_ message: JSON) {
    task?.send(.string(message.text)) { _ in }
  }

  /// Sends now, or once the socket is back; a retry with the same id is a no-op in the brain.
  private func send(_ message: JSON) async throws -> JSON {
    let id = message["id"].str
    return try await withCheckedThrowingContinuation { done in
      guard !stopped else { return done.resume(throwing: Stopped()) }
      waiting[id] = (message, done)
      order.append(id)
      if opened != nil { write(message) }
    }
  }

  @discardableResult
  func command(_ type: String, _ payload: JSON, id: String = UUID().uuidString) async throws -> Int {
    Int(try await send(["type": "command", "id": .string(id), "command": .string(type), "payload": payload])["seq"].number ?? 0)
  }

  /// Older history: one of the core view's pages (`chat`, `thread`).
  func page(_ name: String, _ args: JSON) async throws -> JSON {
    try await send(["type": "page", "id": .string(UUID().uuidString), "name": .string(name), "args": args])["value"]
  }

  /// Event types a widget on screen refreshes on, beyond what clients get anyway.
  func watch(_ types: [String]) {
    watched = types
    if opened != nil { write(["type": "watch", "types": .array(types.map(JSON.string))]) }
  }

  func emit(_ event: String, _ payload: JSON, id: String = UUID().uuidString) async throws {
    _ = try await send(["type": "emit", "id": .string(id), "event": .string(event), "payload": payload])
  }
}
