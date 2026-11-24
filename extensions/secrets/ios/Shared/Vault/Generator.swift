import Foundation

/// New passwords: random characters of a length, with or without digits and symbols, or Apple's
/// style (three groups of six, one capital and one digit among them, easy to type on a phone).
nonisolated enum Generator {
  enum Style: String, CaseIterable, Identifiable, Sendable {
    case random, apple
    var id: String { rawValue }
    var label: String { self == .random ? "Random" : "Apple" }
  }

  static let letters = Array("abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ")
  static let digits = Array("23456789")
  static let symbols = Array("!@#$%^&*-_=+?.:;~")

  static func make(style: Style, length: Int = 20, digits useDigits: Bool = true, symbols useSymbols: Bool = true) -> String {
    var rng = SystemRandomNumberGenerator()
    if style == .apple { return apple(&rng) }
    var pool = letters
    var required: [[Character]] = [letters]
    if useDigits {
      pool += digits
      required.append(digits)
    }
    if useSymbols {
      pool += symbols
      required.append(symbols)
    }
    var out = (0..<length).map { _ in pool.randomElement(using: &rng)! }
    // One of each kind asked for, each at its own place.
    var places = Array(out.indices).shuffled(using: &rng)
    for set in required where !out.contains(where: set.contains) {
      guard let at = places.popLast() else { break }
      out[at] = set.randomElement(using: &rng)!
    }
    return String(out)
  }

  /// xxxxxx-xxxxxx-xxxxxx: consonants and vowels in turn, one capital and one digit.
  private static func apple(_ rng: inout SystemRandomNumberGenerator) -> String {
    let consonants = Array("bcdfghjkmnpqrstvwxz")
    let vowels = Array("aeiouy")
    var chars = (0..<18).map { i in i % 2 == 0 ? consonants.randomElement(using: &rng)! : vowels.randomElement(using: &rng)! }
    let capital = Int.random(in: 0..<18, using: &rng)
    var digit = Int.random(in: 0..<18, using: &rng)
    while digit == capital { digit = Int.random(in: 0..<18, using: &rng) }
    chars[capital] = Character(chars[capital].uppercased())
    chars[digit] = digits.randomElement(using: &rng)!
    let s = String(chars)
    let a = s.prefix(6)
    let b = s.dropFirst(6).prefix(6)
    let c = s.suffix(6)
    return "\(a)-\(b)-\(c)"
  }
}
