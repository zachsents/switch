@preconcurrency import AVFoundation
import Foundation
import Speech
import os

nonisolated let dictationLog = Logger(subsystem: "switch.dictation", category: "dictation")

// Dictation into the message box (Views/Box.swift), as the desktop does it (apps/desktop/src/
// native/dictation.swift): Apple's SpeechAnalyzer with its DictationTranscriber, on the device,
// reporting words as they're heard (a guess at the phrase under way, then each phrase final) and
// how loud the user is. There's one microphone, so one dictation at a time, app-wide: starting one
// in a field finishes any other first.

/// What the transcriber hears, in order.
nonisolated enum Heard: Sendable {
  /// The language's model is downloading (the first dictation in it on this phone).
  case preparing
  /// It's taking audio.
  case ready
  /// How loud the microphone is now, from 0 to 1, about 20 times a second.
  case level(Float)
  /// A guess at the phrase under way; the next one replaces it.
  case volatile(String)
  /// A finished phrase.
  case final(String)
  /// It failed; nothing more comes.
  case failed(noInput: Bool, String)
}

/// Why a dictation stopped short, said above the box until the next one starts or its words go.
enum Stopped: Equatable {
  /// iOS keeps the microphone from the app.
  case denied
  /// It heard no new words for a minute.
  case quiet
  case failed(String)
}

@Observable final class Dictation {
  static let shared = Dictation()

  enum Status { case idle, starting, preparing, recording, stopping }

  private(set) var status = Status.idle
  /// The field it's dictating into.
  private(set) var owner: UUID?
  /// The finished phrases, spaced.
  private(set) var finished = ""
  /// The phrase under way, spaced from those before it.
  private(set) var volatile = ""
  /// How loud they've been lately, oldest first, each 0 to 1. Only the meter reads it, so only the
  /// meter redraws 20 times a second.
  private(set) var levels: [Float] = []

  @ObservationIgnored private var transcriber: AnyObject?
  @ObservationIgnored private var phrases = Phrases()
  @ObservationIgnored private var ended: ((String, Stopped?) -> Void)?
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var quiet: Task<Void, Never>?
  @ObservationIgnored private var stopped: Stopped?

  static let levelCount = 18

  /// Whether this phone can dictate: SpeechAnalyzer is iOS 26's.
  static var available: Bool {
    if #available(iOS 26, *) { return true }
    return false
  }

  var isActive: Bool { status != .idle }

  /// All the words heard so far, the phrase under way included.
  var transcript: String { finished + volatile }

  /// Starts listening for the field `owner`, asking iOS for the microphone the first time; `ended`
  /// hears all the words once it's done (and why, when it stopped short). A dictation under way in
  /// another field finishes first.
  func start(_ owner: UUID, ended: @escaping (String, Stopped?) -> Void) {
    if isActive { stop() }
    generation += 1
    let generation = generation
    (self.owner, self.ended, stopped) = (owner, ended, nil)
    (finished, volatile, levels, phrases) = ("", "", [], Phrases())
    status = .starting
    Task {
      guard await Self.microphoneAllowed() else { return self.end(generation, .denied) }
      guard self.generation == generation, self.status == .starting else { return }
      self.listen(generation)
    }
  }

  private func listen(_ generation: Int) {
    guard #available(iOS 26, *) else { return end(generation, .failed("Dictation needs iOS 26")) }
    let transcriber = Transcriber()
    self.transcriber = transcriber
    let heard = transcriber.start()
    watchQuiet(generation)
    Task {
      for await line in heard {
        guard self.generation == generation else { return }
        self.hear(line, generation)
      }
      self.end(generation, self.stopped)
    }
  }

  private func hear(_ line: Heard, _ generation: Int) {
    switch line {
    case .preparing: if status == .starting { status = .preparing }
    case .ready: if status == .starting || status == .preparing { status = .recording }
    case .level(let level):
      if levels.count == Self.levelCount { levels.removeFirst() }
      levels.append(min(max(level, 0), 1))
    case .volatile(let text):
      volatile = phrases.spaced(text)
      watchQuiet(generation)
    case .final(let text):
      finished += phrases.finish(text)
      volatile = ""
      watchQuiet(generation)
    case .failed(let noInput, let message):
      stopped = .failed(noInput ? "No microphone" : "Dictation failed: \(message)")
      cancelTranscriber()
    }
  }

  private func stopTranscriber() {
    if #available(iOS 26, *) { (transcriber as? Transcriber)?.stop() }
  }

  private func cancelTranscriber() {
    if #available(iOS 26, *) { (transcriber as? Transcriber)?.cancel() }
  }

  /// The user stopped: the last words are finished, then it's done.
  func stop() {
    switch status {
    case .idle, .stopping: return
    case .starting where transcriber == nil: end(generation, nil)
    default:
      status = .stopping
      stopTranscriber()
    }
  }

  /// Finishes the dictation under way if it's `owner`'s.
  func stop(_ owner: UUID) { if self.owner == owner { stop() } }

  /// Drops the dictation under way and its words.
  func cancel() {
    guard isActive else { return }
    cancelTranscriber()
    (finished, volatile) = ("", "")
    end(generation, nil)
  }

  /// It's over: the field gets the words (those heard before a failure too).
  private func end(_ generation: Int, _ why: Stopped?) {
    guard self.generation == generation, isActive else { return }
    self.generation += 1
    let (words, ended) = (finished + volatile, self.ended)
    quiet?.cancel()
    (quiet, transcriber, self.ended, owner, status) = (nil, nil, nil, nil, .idle)
    (finished, volatile, levels) = ("", "", [])
    ended?(words, why)
  }

  /// Starts the minute over: a dictation that hears no new words for that long finishes on its
  /// own, so a forgotten one never holds the microphone.
  private func watchQuiet(_ generation: Int) {
    quiet?.cancel()
    quiet = Task {
      try? await Task.sleep(for: .seconds(60))
      guard !Task.isCancelled, self.generation == generation else { return }
      self.stopped = .quiet
      self.stop()
    }
  }

  private static func microphoneAllowed() async -> Bool {
    switch AVAudioApplication.shared.recordPermission {
    case .granted: return true
    case .denied: return false
    default: return await AVAudioApplication.requestRecordPermission()
    }
  }
}

/// The microphone, through SpeechAnalyzer's DictationTranscriber.
@available(iOS 26, *)
nonisolated final class Transcriber: @unchecked Sendable {
  private let lock = NSLock()
  private var engine: AVAudioEngine?
  private var feed: AsyncStream<AnalyzerInput>.Continuation?
  private var run: Task<Void, Never>?
  private var interruptions: NSObjectProtocol?
  /// Stopped before the audio started: nothing to wait for.
  private var stopping = false

  /// What it hears; the stream ends once the last phrase is final, after `stop`.
  func start() -> AsyncStream<Heard> {
    let (heard, say) = AsyncStream<Heard>.makeStream()
    run = Task {
      do {
        try await transcribe(say)
      } catch is CancellationError {
      } catch {
        dictationLog.error("dictation failed: \(error, privacy: .public)")
        say.yield(.failed(noInput: (error as? NoInput) != nil, error.localizedDescription))
      }
      self.release()
      say.finish()
    }
    return heard
  }

  /// The user stopped: what's been heard is finished, then the stream ends.
  func stop() {
    lock.lock()
    stopping = true
    let (engine, feed) = (self.engine, self.feed)
    lock.unlock()
    engine?.stop()
    engine?.inputNode.removeTap(onBus: 0)
    feed?.finish()
  }

  /// Drops it at once.
  func cancel() {
    stop()
    run?.cancel()
  }

  struct NoInput: LocalizedError {
    var errorDescription: String? { "No microphone" }
  }

  struct Failure: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
  }

  private var isStopping: Bool {
    lock.lock()
    defer { lock.unlock() }
    return stopping
  }

  private func transcribe(_ say: AsyncStream<Heard>.Continuation) async throws {
    let locale = await DictationTranscriber.supportedLocale(equivalentTo: Locale.current) ?? Locale(identifier: "en-US")
    let transcriber = DictationTranscriber(locale: locale, preset: .progressiveLongDictation)
    // The model is the phone's, shared by every app: it's missing only if nothing has dictated in this language yet.
    if await AssetInventory.status(forModules: [transcriber]) != .installed, let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      say.yield(.preparing)
      try await request.downloadAndInstall()
    }
    try Task.checkCancellation()
    if isStopping { return }

    let engine = AVAudioEngine()
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
    // A tap on the key while it records still gives its tick.
    try? session.setAllowHapticsAndSystemSoundsDuringRecording(true)
    try session.setActive(true)
    // A call or Siri takes the microphone: what was heard is finished.
    interruptions = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { [weak self] _ in
      self?.stop()
    }
    let hardware = engine.inputNode.inputFormat(forBus: 0)
    if hardware.sampleRate <= 0 || hardware.channelCount == 0 { throw NoInput() }
    let natural = engine.inputNode.outputFormat(forBus: 0)
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: natural) else {
      // The simulator, for one, has the model but can't run it.
      throw Failure("this device can't run \(locale.identifier(.bcp47)) dictation")
    }
    let analyzer = SpeechAnalyzer(modules: [transcriber], options: .init(priority: .userInitiated, modelRetention: .lingering))
    try await analyzer.prepareToAnalyze(in: format)
    let results = Task {
      do {
        for try await result in transcriber.results {
          say.yield(result.isFinal ? .final(String(result.text.characters)) : .volatile(String(result.text.characters)))
        }
      } catch {
        dictationLog.error("results failed: \(error, privacy: .public)")
      }
    }
    let (audio, feed) = AsyncStream<AnalyzerInput>.makeStream()
    let stopped = lock.withLock {
      (self.engine, self.feed) = (engine, feed)
      return stopping
    }
    if stopped {
      feed.finish()
    } else {
      let loudness = Loudness(say)
      let converting = Converting(to: format)
      // In the bus's own format (a tap in any other fails when the hardware's rate differs), converted as it comes.
      engine.inputNode.installTap(onBus: 0, bufferSize: 1_024, format: nil) { buffer, _ in
        loudness.hear(buffer)
        if let converted = converting.converted(buffer) { feed.yield(AnalyzerInput(buffer: converted)) }
      }
      engine.prepare()
      try engine.start()
    }
    say.yield(.ready)
    if let end = try await analyzer.analyzeSequence(audio) {
      try await analyzer.finalizeAndFinish(through: end)
      await results.value
    } else {
      // No audio at all: nothing was said.
      await analyzer.cancelAndFinishNow()
      results.cancel()
    }
  }

  /// Lets the microphone go: the engine stopped and the audio session given back, so other apps'
  /// audio comes back up and nothing keeps the phone busy.
  private func release() {
    stop()
    lock.lock()
    engine = nil
    feed = nil
    lock.unlock()
    if let interruptions { NotificationCenter.default.removeObserver(interruptions) }
    interruptions = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}

/// The microphone's audio in the analyzer's format: a converter made for the format the audio
/// comes in (again if that changes), which carries its resampling state from one buffer to the next.
nonisolated final class Converting: @unchecked Sendable {
  private let format: AVAudioFormat
  private var converter: AVAudioConverter?

  init(to format: AVAudioFormat) { self.format = format }

  func converted(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    if buffer.format == format { return buffer }
    if converter?.inputFormat != buffer.format {
      converter = AVAudioConverter(from: buffer.format, to: format)
      // A microphone with several channels: the first is the voice.
      if buffer.format.channelCount > 1 { converter?.channelMap = [0] }
    }
    guard let converter else { return nil }
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 1
    guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
    // The converter calls back before `convert` returns.
    nonisolated(unsafe) var given = false
    var error: NSError?
    converter.convert(to: converted, error: &error) { _, status in
      if given {
        status.pointee = .noDataNow
        return nil
      }
      given = true
      status.pointee = .haveData
      return buffer
    }
    return error == nil ? converted : nil
  }
}

/// How loud the microphone is, said about 20 times a second, from 0 (quieter than a room) to 1 (a shout).
nonisolated final class Loudness: @unchecked Sendable {
  private let say: AsyncStream<Heard>.Continuation
  private var last = Date.distantPast

  init(_ say: AsyncStream<Heard>.Continuation) { self.say = say }

  func hear(_ buffer: AVAudioPCMBuffer) {
    let count = Int(buffer.frameLength)
    guard count > 0 else { return }
    var power: Float = 0
    if let samples = buffer.floatChannelData?[0] {
      for index in 0..<count { power += samples[index] * samples[index] }
    } else if let samples = buffer.int16ChannelData?[0] {
      for index in 0..<count {
        let sample = Float(samples[index]) / 32_768
        power += sample * sample
      }
    } else {
      return
    }
    let now = Date()
    guard now.timeIntervalSince(last) >= 0.05 else { return }
    last = now
    let db = 10 * log10(max(power / Float(count), 1e-10))
    say.yield(.level(min(max((db + 60) / 50, 0), 1)))
  }
}
