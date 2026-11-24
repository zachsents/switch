import Foundation
import Network
import Observation

/// What a tool said went wrong, as the app shows it.
nonisolated struct Failure: LocalizedError, Sendable {
  let message: String
  var errorDescription: String? { message }
}

/// Switch's core, as this app reaches it: its extension's tools through the core's gateway (a POST to
/// `/widgets/<app>/<tool>`, the same tools an agent calls), the brain's events on the core's sync
/// socket, and what the user does here, as the client `ui.*` events.
///
/// The core's address is config, never code (Config.core). Only ciphertext and outlines pass here.
@MainActor @Observable
final class Core: NSObject, URLSessionWebSocketDelegate {
  enum Link: Equatable { case connecting, open, down }

  /// The extension's name in the core: its tools are `<app>_<tool>`.
  let app: String
  private(set) var link: Link = .connecting
  /// The core's HTTP root, and its sync socket.
  private(set) var http: URL?
  @ObservationIgnored private var socket: URL?
  @ObservationIgnored private var started = false
  /// The credential the core gave this app when its pairing was approved (Pairing.swift).
  @ObservationIgnored var token = CoreToken.load()
  /// The code to approve while a pairing waits.
  var pairCode: String?

  @ObservationIgnored private var watched: Set<String> = []
  @ObservationIgnored private var handlers: [(String, JSON) -> Void] = []
  @ObservationIgnored private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
  @ObservationIgnored private var task: URLSessionWebSocketTask?
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var cursor: Int?
  @ObservationIgnored private var failures = 0
  @ObservationIgnored private var retry: Task<Void, Never>?
  @ObservationIgnored private let path = NWPathMonitor()

  init(app: String) {
    self.app = app
    super.init()
    configure(Config.core)
  }

  /// Points at a core (ws://host:port), as given in Settings: reconnects if it was running.
  func configure(_ given: String) {
    http = nil
    socket = nil
    if !given.isEmpty, var c = URLComponents(string: given), let scheme = c.scheme, c.host != nil {
      let secure = scheme == "wss" || scheme == "https"
      c.path = ""
      c.query = nil
      c.scheme = secure ? "https" : "http"
      http = c.url
      c.scheme = secure ? "wss" : "ws"
      socket = c.url
    }
    link = socket == nil ? .down : .connecting
    if started { open() }
  }

  var configured: Bool { http != nil }

  /// The socket again, with what's changed (a token).
  func reconnect() {
    if started { open() }
  }

  /// A token is good only for the core that gave it: dropped when the core changes.
  func forgetToken() {
    CoreToken.delete()
    token = nil
  }

  // MARK: Tools

  /// Calls one of the extension's tools (or another app's, `app:`): its structured result.
  func call(_ tool: String, _ args: JSON = [:], app: String? = nil) async throws -> JSON {
    guard let http else { throw Failure(message: "No core set") }
    var request = URLRequest(url: http.appending(path: "widgets/\(app ?? self.app)/\(tool)"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    request.httpBody = args.data
    request.timeoutInterval = 30
    request.cachePolicy = .reloadIgnoringLocalCacheData
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await URLSession.shared.data(for: request)
    } catch {
      throw Failure(message: "Can't reach the core")
    }
    if (response as? HTTPURLResponse)?.statusCode == 401 { throw Failure(message: "Not paired with the core") }
    guard let r = JSON.parse(data) else { throw Failure(message: "The core's answer didn't read") }
    let text = r["content"].array.first { $0["type"].str == "text" }?["text"].str ?? ""
    if r["isError"].bool == true {
      if text.hasPrefix("No app ") { throw Failure(message: "\(text.dropFirst(7).capitalized) isn't running") }
      throw Failure(message: text.isEmpty ? "\(tool) failed" : text)
    }
    if case .object = r["structuredContent"] { return r["structuredContent"] }
    return JSON.parse(text) ?? .string(text)
  }

  // MARK: Events

  /// Calls `handler` with each of these event types as the brain logs them.
  func on(_ types: [String], _ handler: @escaping (String, JSON) -> Void) {
    watched.formUnion(types)
    handlers.append { type, payload in if types.contains(type) { handler(type, payload) } }
    write(["type": "watch", "types": .array(watched.sorted().map(JSON.string))])
  }

  func start() {
    guard !started else { return }
    started = true
    path.pathUpdateHandler = { [weak self] p in
      Task { @MainActor in if p.status == .satisfied { self?.wake() } }
    }
    path.start(queue: .main)
    if socket != nil { open() }
  }

  /// Back in front, or the network's back: connect now if down.
  func wake() {
    guard started, socket != nil, link != .open else { return }
    failures = 0
    open()
  }

  private func open() {
    guard let socket else { return }
    retry?.cancel()
    retry = nil
    generation += 1
    let gen = generation
    task?.cancel(with: .goingAway, reason: nil)
    var c = URLComponents(url: socket, resolvingAgainstBaseURL: false)!
    var query = [URLQueryItem(name: "source", value: "\(app)-iphone")]
    if let token { query.append(URLQueryItem(name: "token", value: token)) }
    if let cursor { query.append(URLQueryItem(name: "since", value: String(cursor))) }
    c.queryItems = query
    let t = session.webSocketTask(with: c.url!)
    t.maximumMessageSize = 64 << 20
    task = t
    t.resume()
    receive(t, gen)
  }

  nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    MainActor.assumeIsolated {
      guard webSocketTask === self.task else { return }
      self.link = .open
      self.failures = 0
      self.write(["type": "watch", "types": .array(self.watched.sorted().map(JSON.string))])
    }
  }

  nonisolated func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
  ) {
    MainActor.assumeIsolated {
      guard webSocketTask === self.task else { return }
      self.lost(self.generation)
    }
  }

  private func receive(_ t: URLSessionWebSocketTask, _ gen: Int) {
    t.receive { [weak self] result in
      Task { @MainActor in
        guard let self, self.generation == gen else { return }
        switch result {
        case .failure:
          self.lost(gen)
        case .success(let message):
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
      cursor = Int(m["seq"].number ?? 0)
    case "events":
      for e in m["events"].array {
        guard let seq = e["seq"].number, Int(seq) > (cursor ?? 0) else { continue }
        cursor = Int(seq)
        let type = e["type"].str
        guard watched.contains(type) else { continue }
        for h in handlers { h(type, e["payload"]) }
      }
    default:
      break
    }
  }

  /// The socket's gone: try again, backing off from 1 s to a minute.
  private func lost(_ gen: Int) {
    guard gen == generation, retry == nil else { return }
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    link = .down
    failures += 1
    let delay = min(60, pow(2, Double(min(failures, 6)))) * Double.random(in: 0.5...1)
    retry = Task { [weak self] in
      try? await Task.sleep(for: .seconds(delay))
      guard let self, !Task.isCancelled else { return }
      self.retry = nil
      self.open()
    }
  }

  private func write(_ message: JSON) {
    guard link == .open else { return }
    task?.send(.string(message.text)) { _ in }
  }

  // MARK: What the user does (the client's ui.* events): best effort

  func emit(_ event: String, _ payload: JSON) {
    write(["type": "emit", "id": .string(UUID().uuidString.lowercased()), "event": .string(event), "payload": payload])
  }

  func viewed(_ surface: String, _ item: String) {
    emit("ui.viewed", ["surface": .string("\(app).\(surface)"), "item": .string(item)])
  }

  /// Leaving something opened at `opened`: backed out if quick, else a dwell.
  func left(_ surface: String, _ item: String, opened: Date) {
    let ms = max(0, Date().timeIntervalSince(opened) * 1000)
    emit(ms < 2000 ? "ui.backed_out" : "ui.dwelled", ["surface": .string("\(app).\(surface)"), "item": .string(item), "ms": .number(ms.rounded())])
  }
}
