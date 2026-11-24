// The dictation helper: speech to text on this Mac, for the message box. build.rs builds it into
// the app, and the app runs one per dictation (src/platform/dictation.rs).
//
// It listens to the microphone until its stdin closes, which is how the app says the user stopped,
// and prints one JSON object per line:
//
//   {"event":"ready"}                          it's taking audio
//   {"event":"level","level":0.42}             how loud the microphone is, 0 to 1, about 20 a second
//   {"event":"volatile","text":"…"}            a guess at the phrase under way; the next replaces it
//   {"event":"final","text":"…"}               a finished phrase
//   {"event":"error","kind":"…","message":"…"} it failed, and exits 1; kind is "denied" (macOS keeps
//                                              the microphone from the app), "no-input" (none) or
//                                              "failed"
//
// and exits once the last phrase is final. It recognizes on the device with SpeechAnalyzer's
// DictationTranscriber, which reports words as they're heard, and needs neither the Speech
// Recognition permission nor dictation turned on in System Settings. The microphone is the app's:
// macOS asks for it in the app's name, and this process uses it on the app's behalf.

import AVFoundation
import Foundation
import Speech

struct Failure: LocalizedError {
  let errorDescription: String?
  let kind: String

  init(_ message: String, kind: String = "failed") {
    errorDescription = message
    self.kind = kind
  }
}

let output = NSLock()

/// Prints one line of the protocol.
func emit(_ line: [String: Any]) {
  guard var data = try? JSONSerialization.data(withJSONObject: line) else { return }
  data.append(0x0A)
  output.lock()
  FileHandle.standardOutput.write(data)
  output.unlock()
}

@main
struct Dictation {
  static func main() async {
    do {
      try await transcribe()
    } catch {
      emit(["event": "error", "kind": (error as? Failure)?.kind ?? "failed", "message": error.localizedDescription])
      exit(1)
    }
  }
}

/// Whether macOS lets the app use the microphone, asking the first time.
func allowed() async -> Bool {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: return true
  case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
  default: return false
  }
}

/// Recognizes the microphone until stdin closes, printing what it hears.
func transcribe() async throws {
  guard await allowed() else {
    throw Failure("The microphone isn't allowed.", kind: "denied")
  }
  let locale = await DictationTranscriber.supportedLocale(equivalentTo: Locale.current) ?? Locale(identifier: "en-US")
  let transcriber = DictationTranscriber(locale: locale, preset: .progressiveLongDictation)
  // The model is the Mac's, shared by every app: it's only missing if nothing has dictated in this language yet.
  let installed = await DictationTranscriber.installedLocales.map { $0.identifier(.bcp47) }
  if !installed.contains(locale.identifier(.bcp47)), let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
    try await request.downloadAndInstall()
  }
  let engine = AVAudioEngine()
  // A Mac with no microphone (a Mac mini with nothing plugged in) has no channels at 0 Hz in the
  // hardware's own format; the node's output format makes one up, so only this one tells.
  let hardware = engine.inputNode.inputFormat(forBus: 0)
  if hardware.sampleRate <= 0 || hardware.channelCount == 0 {
    throw Failure("No microphone found.", kind: "no-input")
  }
  let heard = engine.inputNode.outputFormat(forBus: 0)
  guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: heard) else {
    throw Failure("No audio format for \(locale.identifier(.bcp47)) dictation.")
  }
  let analyzer = SpeechAnalyzer(modules: [transcriber], options: .init(priority: .userInitiated, modelRetention: .lingering))
  try await analyzer.prepareToAnalyze(in: format)
  let results = Task {
    do {
      for try await result in transcriber.results {
        emit(["event": result.isFinal ? "final" : "volatile", "text": String(result.text.characters)])
      }
    } catch is CancellationError {
      // Stopped before a word was said.
    } catch {
      emit(["event": "error", "kind": "failed", "message": error.localizedDescription])
      exit(1)
    }
  }
  let (audio, feed) = AsyncStream<AnalyzerInput>.makeStream()
  try listen(with: engine, into: feed, as: format)
  emit(["event": "ready"])
  if let end = try await analyzer.analyzeSequence(audio) {
    try await analyzer.finalizeAndFinish(through: end)
    await results.value
  } else {
    // No audio at all: nothing was said.
    await analyzer.cancelAndFinishNow()
  }
}

/// Feeds the microphone to the analyzer, in `format`, until stdin closes, saying how loud it is as
/// it goes.
func listen(with engine: AVAudioEngine, into feed: AsyncStream<AnalyzerInput>.Continuation, as format: AVAudioFormat) throws {
  let input = engine.inputNode
  let loudness = Loudness()
  let converting = Converting(to: format)
  // In the bus's own format (a tap in any other fails when the hardware's rate differs), converted
  // as it comes.
  input.installTap(onBus: 0, bufferSize: 1_024, format: nil) { buffer, _ in
    loudness.hear(buffer)
    if let converted = converting.converted(buffer) {
      feed.yield(AnalyzerInput(buffer: converted))
    }
  }
  engine.prepare()
  try engine.start()
  // The app closes stdin when the user stops: that's the end of the audio.
  Thread.detachNewThread {
    while !FileHandle.standardInput.availableData.isEmpty {}
    engine.stop()
    input.removeTap(onBus: 0)
    feed.finish()
  }
}

/// The microphone's audio in the analyzer's format: a converter made for the format the audio comes
/// in (again if that changes), which carries its resampling state from one buffer to the next.
final class Converting: @unchecked Sendable {
  private let format: AVAudioFormat
  private var converter: AVAudioConverter?

  init(to format: AVAudioFormat) {
    self.format = format
  }

  func converted(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    if buffer.format == format {
      return buffer
    }
    if converter?.inputFormat != buffer.format {
      converter = AVAudioConverter(from: buffer.format, to: format)
      // A microphone with several channels: the first is the voice.
      if buffer.format.channelCount > 1 {
        converter?.channelMap = [0]
      }
    }
    guard let converter else { return nil }
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 1
    guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
    var given = false
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

/// How loud the microphone is, said about 20 times a second, from 0 (quieter than a room) to 1 (a
/// shout).
final class Loudness: @unchecked Sendable {
  private var last = Date.distantPast

  func hear(_ buffer: AVAudioPCMBuffer) {
    guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
    let count = Int(buffer.frameLength)
    var power: Float = 0
    for index in 0..<count {
      power += samples[index] * samples[index]
    }
    let now = Date()
    guard now.timeIntervalSince(last) >= 0.05 else { return }
    last = now
    let db = 10 * log10(max(power / Float(count), 1e-10))
    let level = min(max((db + 60) / 50, 0), 1)
    emit(["event": "level", "level": (level * 100).rounded() / 100])
  }
}
