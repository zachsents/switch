import CryptoKit
import Foundation
import MachO
import MetricKit

/// This phone's crash and hang reports, as iOS keeps them for the app (MetricKit): each comes on a
/// launch after it, and goes to the core as a `client.crashed` emit, with the trail of the launch it
/// happened in (Trail.swift). Kept in the Outbox until the core has it; its id comes from its
/// contents, so one delivered twice is sent once. Each says which build of the app it came from
/// (`binary`, the Switchboard image's UUID, which names its dSYM) and the attributed thread's stack
/// (`frames`), both read from the whole report, since the raw `report` is clipped.
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
    /// The Switchboard image's UUID, which its dSYM carries.
    let binary: String
    let frames: [Frame]
  }

  /// A frame of a stack: the image it's in and how far into that image's text.
  nonisolated struct Frame: Sendable {
    let binaryName: String
    let binaryUUID: String
    let offset: Double
  }

  nonisolated private static let clip = 20_000
  nonisolated private static let keepFrames = 200
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
          "binary": .string(r.binary),
          "frames": .array(
            r.frames.map { f in
              ["binaryName": .string(f.binaryName), "binaryUUID": .string(f.binaryUUID), "offset": .number(f.offset)]
            }),
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
    let tree = try? JSONSerialization.jsonObject(with: data)
    // Compact, so far more of it fits under the clip than MetricKit's pretty-printed text.
    let compact = tree.flatMap { try? JSONSerialization.data(withJSONObject: $0, options: [.withoutEscapingSlashes]) } ?? data
    let stacks = ((tree as? [String: Any])?["callStackTree"] as? [String: Any])?["callStacks"] as? [[String: Any]] ?? []
    let attributed = stacks.first { $0["threadAttributed"] as? Bool == true } ?? stacks.first
    let frames = attributed.map { stack(($0["callStackRootFrames"] as? [[String: Any]]) ?? []) } ?? []
    // The app's frames name the build the report came from (it may be one before this launch's);
    // this image's own UUID only when no frame anywhere is the app's.
    let binary =
      frames.first { $0.binaryName == appName }?.binaryUUID
      ?? stacks.lazy.compactMap { appUUID(($0["callStackRootFrames"] as? [[String: Any]]) ?? []) }.first
      ?? ownUUID
    return Report(
      id: "crash-\(digest.prefix(32))", kind: kind, build: d.metaData.applicationBuildVersion, at: at, summary: summary,
      pid: d.metaData.pid, report: String(String(decoding: compact, as: UTF8.self).prefix(clip)), binary: binary,
      frames: frames)
  }

  /// A thread's stack, innermost frame first: MetricKit nests each caller in its callee's
  /// `subFrames`, and where samples part (a hang's), the path most of them took.
  nonisolated private static func stack(_ roots: [[String: Any]]) -> [Frame] {
    var frames: [Frame] = []
    var level = roots
    while frames.count < keepFrames, let f = heaviest(level) {
      frames.append(
        Frame(
          binaryName: f["binaryName"] as? String ?? "", binaryUUID: f["binaryUUID"] as? String ?? "",
          offset: (f["offsetIntoBinaryTextSegment"] as? NSNumber)?.doubleValue ?? 0))
      level = f["subFrames"] as? [[String: Any]] ?? []
    }
    return frames
  }

  nonisolated private static func heaviest(_ frames: [[String: Any]]) -> [String: Any]? {
    frames.max { (($0["sampleCount"] as? NSNumber)?.intValue ?? 0) < (($1["sampleCount"] as? NSNumber)?.intValue ?? 0) }
  }

  /// The app's image UUID in a stack tree, wherever in it a frame of the app is.
  nonisolated private static func appUUID(_ frames: [[String: Any]]) -> String? {
    var pending = frames
    while let f = pending.popLast() {
      if f["binaryName"] as? String == appName, let uuid = f["binaryUUID"] as? String { return uuid }
      pending.append(contentsOf: f["subFrames"] as? [[String: Any]] ?? [])
    }
    return nil
  }

  nonisolated private static let appName = Bundle.main.executableURL?.lastPathComponent ?? "Switchboard"

  /// This running image's UUID (its Mach-O LC_UUID), as MetricKit writes one.
  nonisolated private static let ownUUID: String = {
    let header = UnsafeRawPointer(#dsohandle).assumingMemoryBound(to: mach_header_64.self)
    var command = UnsafeRawPointer(header).advanced(by: MemoryLayout<mach_header_64>.size)
    for _ in 0..<header.pointee.ncmds {
      let load = command.assumingMemoryBound(to: load_command.self).pointee
      if load.cmd == LC_UUID {
        let uuid = command.assumingMemoryBound(to: uuid_command.self).pointee.uuid
        return UUID(uuid: uuid).uuidString
      }
      command = command.advanced(by: Int(load.cmdsize))
    }
    return ""
  }()

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
