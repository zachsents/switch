import CryptoKit
import Foundation
import MetricKit

/// This phone's crash and hang reports, as iOS keeps them for the app (MetricKit): each comes on a
/// launch after it, and goes to the core as a `client.crashed` emit, with the trail of the launch it
/// happened in (Trail.swift). Kept in the Outbox until the core has it; its id comes from its
/// contents, so one delivered twice is sent once.
@MainActor
final class Crashes: NSObject, MXMetricManagerSubscriber {
  static let shared = Crashes()

  nonisolated struct Report: Sendable {
    let id: String
    let kind: String
    let build: String
    let at: Double
    let summary: String
    let pid: Int32?
    let report: String
  }

  nonisolated private static let clip = 20_000
  private static let sentKey = "crashesSent"
  private static let keepSent = 100
  private var listening = false

  func start() {
    guard !listening else { return }
    listening = true
    MXMetricManager.shared.add(self)
    take(MXMetricManager.shared.pastDiagnosticPayloads.flatMap(Self.reports))
  }

  nonisolated func didReceive(_ payloads: [MXDiagnosticPayload]) {
    let reports = payloads.flatMap(Self.reports)
    Task { @MainActor in self.take(reports) }
  }

  private func take(_ reports: [Report]) {
    var sent = UserDefaults.standard.stringArray(forKey: Self.sentKey) ?? []
    for r in reports where !sent.contains(r.id) {
      let launch = Trail.shared.launch(pid: r.pid)
      Outbox.shared.add(
        .emit, "client.crashed",
        [
          "client": "iphone", "device": .string(Phone.shared.device), "kind": .string(r.kind), "build": .string(r.build),
          "at": .number(r.at), "summary": .string(r.summary), "screen": .string(launch?.screen ?? ""),
          "trail": .array((launch?.steps ?? []).map(JSON.string)), "report": .string(r.report),
        ],
        id: r.id)
      sent.append(r.id)
    }
    UserDefaults.standard.set(Array(sent.suffix(Self.keepSent)), forKey: Self.sentKey)
  }

  /// Each crash and hang in a payload, a report of its own.
  nonisolated private static func reports(_ payload: MXDiagnosticPayload) -> [Report] {
    let at = (payload.timeStampEnd.timeIntervalSince1970 * 1000).rounded()
    let crashes = (payload.crashDiagnostics ?? []).map { c in
      report(c, kind: "crash", at: at, summary: summary(c))
    }
    let hangs = (payload.hangDiagnostics ?? []).map { h in
      report(h, kind: "hang", at: at, summary: String(format: "hang %.1f s", h.hangDuration.converted(to: .seconds).value))
    }
    return crashes + hangs
  }

  nonisolated private static func report(_ d: MXDiagnostic, kind: String, at: Double, summary: String) -> Report {
    let data = d.jsonRepresentation()
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    return Report(
      id: "crash-\(digest.prefix(32))", kind: kind, build: d.metaData.applicationBuildVersion, at: at, summary: summary,
      pid: d.metaData.pid, report: String(String(decoding: data, as: UTF8.self).prefix(clip)))
  }

  /// A crash in a line: its exception, signal, and why it ended.
  nonisolated private static func summary(_ c: MXCrashDiagnostic) -> String {
    var words: [String] = []
    if let objc = c.exceptionReason { words.append("\(objc.exceptionName): \(objc.composedMessage)") }
    if let type = c.exceptionType { words.append(exceptions[type.intValue] ?? "exception \(type)") }
    if let signal = c.signal { words.append(signals[signal.intValue] ?? "signal \(signal)") }
    if let reason = c.terminationReason { words.append(reason) }
    return words.isEmpty ? "crash" : words.joined(separator: ", ")
  }

  nonisolated private static let exceptions = [
    1: "EXC_BAD_ACCESS", 2: "EXC_BAD_INSTRUCTION", 3: "EXC_ARITHMETIC", 5: "EXC_SOFTWARE", 6: "EXC_BREAKPOINT", 10: "EXC_CRASH",
    11: "EXC_RESOURCE", 12: "EXC_GUARD",
  ]
  nonisolated private static let signals = [
    4: "SIGILL", 5: "SIGTRAP", 6: "SIGABRT", 8: "SIGFPE", 9: "SIGKILL", 10: "SIGBUS", 11: "SIGSEGV", 13: "SIGPIPE",
  ]
}
