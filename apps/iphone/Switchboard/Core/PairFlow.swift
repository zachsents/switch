import Foundation
import Observation
import UIKit

/// The pair screen's progress: asking the core for a code, showing it while the user approves it
/// on a Mac, or redeeming a pairing link's offer. A code that expires is replaced by a new one.
@MainActor @Observable
final class PairFlow {
  enum Stage: Equatable {
    case idle
    case asking
    case code(String)
    case denied
    case failed(String)
  }

  private(set) var stage: Stage = .idle
  /// The core being paired with.
  private(set) var core: URL?
  @ObservationIgnored private var task: Task<Void, Never>?
  @ObservationIgnored var paired: (Credential) -> Void = { _ in }

  private static func why(_ error: Error) -> String {
    (error as? Pairing.Failed)?.reason ?? "Can't reach the core"
  }

  /// The code flow: a code to approve on a Mac, polled every 2 s until it's settled.
  func start(_ core: URL) {
    task?.cancel()
    self.core = core
    stage = .asking
    let name = UIDevice.current.name
    task = Task {
      while !Task.isCancelled {
        let started: Pairing.Started
        do {
          started = try await Pairing.start(core, name: name)
        } catch {
          if !Task.isCancelled { stage = .failed(Self.why(error)) }
          return
        }
        stage = .code(started.code)
        var status: Pairing.Status? = .waiting
        while !Task.isCancelled && (status == nil || status == .waiting) {
          try? await Task.sleep(for: .seconds(2))
          if Task.isCancelled { return }
          status = await Pairing.status(core, started)
        }
        switch status {
        case .approved:
          paired(Credential(core: core, token: started.token))
          stage = .idle
          return
        case .denied:
          stage = .denied
          return
        default:
          // Gone (expired): a new code.
          continue
        }
      }
    }
  }

  /// A pairing link's offer, redeemed for a credential at once.
  func redeem(_ core: URL, offer: String) {
    task?.cancel()
    self.core = core
    stage = .asking
    let name = UIDevice.current.name
    task = Task {
      do {
        let credential = try await Pairing.redeem(core, offer: offer, name: name)
        paired(credential)
        stage = .idle
      } catch {
        if !Task.isCancelled { stage = .failed(Self.why(error)) }
      }
    }
  }

  func cancel() {
    task?.cancel()
    task = nil
    stage = .idle
  }
}
