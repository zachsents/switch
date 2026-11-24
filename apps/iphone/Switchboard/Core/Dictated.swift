import Foundation

// What the user dictated rather than typed, as the desktop keeps it (apps/desktop/src/mainview/
// dictation/words.ts): speech recognition mishears words, names most of all, so a message says
// which of its words were dictated (`dictated` beside `text`), and the agent weighs them by how
// they sound. A field keeps its dictated stretches through every edit: what they type over or add
// counts as typed.
//
// Places in a text are Unicode scalars, which is what a message's `start` counts.

/// Where a text's dictated stretches are: ranges of its scalars, in order, apart.
struct Spans: Equatable, Sendable {
  private(set) var ranges: [Range<Int>] = []

  init(_ ranges: [Range<Int>] = []) { self.ranges = Self.merged(ranges) }

  var isEmpty: Bool { ranges.isEmpty }

  /// A range from `start` to `end`, empty when `end` comes first.
  private static func span(_ start: Int, _ end: Int) -> Range<Int> { start..<max(start, end) }

  /// In order, the ones that overlap or touch made one, empty ones dropped.
  static func merged(_ ranges: [Range<Int>]) -> [Range<Int>] {
    var merged: [Range<Int>] = []
    for range in ranges.filter({ !$0.isEmpty }).sorted(by: { $0.lowerBound < $1.lowerBound }) {
      if let last = merged.last, range.lowerBound <= last.upperBound {
        merged[merged.count - 1] = last.lowerBound..<max(last.upperBound, range.upperBound)
      } else {
        merged.append(range)
      }
    }
    return merged
  }

  /// Marks `range` dictated.
  mutating func add(_ range: Range<Int>) { ranges = Self.merged(ranges + [range]) }

  /// Where `before` and `after` differ, as one change: where it starts, and how many scalars it
  /// took out and put in there.
  static func change(_ before: [Unicode.Scalar], _ after: [Unicode.Scalar]) -> (start: Int, removed: Int, inserted: Int) {
    let shorter = min(before.count, after.count)
    var head = 0
    while head < shorter, before[head] == after[head] { head += 1 }
    var tail = 0
    while tail < shorter - head, before[before.count - 1 - tail] == after[after.count - 1 - tail] { tail += 1 }
    return (head, before.count - head - tail, after.count - head - tail)
  }

  /// Follows an edit from `before` to `after`: what it took out loses its mark, what it put in is typed.
  mutating func edit(from before: String, to after: String) {
    guard before != after, !ranges.isEmpty else { return }
    let (start, removed, inserted) = Self.change(Array(before.unicodeScalars), Array(after.unicodeScalars))
    let end = start + removed
    func moved(_ at: Int) -> Int { at - removed + inserted }
    ranges = Self.merged(ranges.flatMap { span in
      [Self.span(span.lowerBound, min(span.upperBound, start)), Self.span(moved(max(span.lowerBound, end)), moved(max(span.upperBound, end)))]
    })
  }

  /// The stretches within `range` of the text, as they fall in that slice of it.
  func within(_ range: Range<Int>) -> Spans {
    func clamped(_ at: Int) -> Int { min(max(at, range.lowerBound), range.upperBound) - range.lowerBound }
    return Spans(ranges.map { Self.span(clamped($0.lowerBound), clamped($0.upperBound)) })
  }

  /// The stretches as a message lists them, each without the whitespace at its ends: where it
  /// starts and its words.
  func record(_ text: String) -> [JSON] {
    let scalars = Array(text.unicodeScalars)
    return ranges.compactMap { span in
      guard span.upperBound <= scalars.count else { return nil }
      let words = scalars[span]
      guard let first = words.firstIndex(where: { !$0.properties.isWhitespace }),
        let last = words.lastIndex(where: { !$0.properties.isWhitespace })
      else { return nil }
      var trimmed = String.UnicodeScalarView()
      trimmed.append(contentsOf: scalars[first...last])
      return ["start": .number(Double(first)), "text": .string(String(trimmed))]
    }
  }
}

/// What's in a field: the text, and which of it the user dictated.
struct Words: Equatable, Sendable {
  var text = ""
  var dictated = Spans()

  init(_ text: String = "", dictated: Spans = Spans()) { (self.text, self.dictated) = (text, dictated) }

  var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

  /// Follows an edit: the text is `now`, and the stretches move with it.
  mutating func edit(_ now: String) {
    dictated.edit(from: text, to: now)
    text = now
  }

  /// The words to send: trimmed, with the dictated stretches where they fall in what's left.
  var trimmed: Words {
    let scalars = Array(text.unicodeScalars)
    guard let first = scalars.firstIndex(where: { !$0.properties.isWhitespace }),
      let last = scalars.lastIndex(where: { !$0.properties.isWhitespace })
    else { return Words() }
    var kept = String.UnicodeScalarView()
    kept.append(contentsOf: scalars[first...last])
    return Words(String(kept), dictated: dictated.within(first..<last + 1))
  }

  /// `text`, and `dictated` when they dictated any of it, as a message has them.
  var payload: [String: JSON] {
    let dictated = dictated.record(text)
    return dictated.isEmpty ? ["text": .string(text)] : ["text": .string(text), "dictated": .array(dictated)]
  }

  /// What goes after the text for dictated `words`, spaced from it and carrying on any sentence it
  /// ends in, and where in the text the words sit then; nil when nothing was said.
  func insertion(_ words: String) -> (String, Range<Int>)? {
    let words = words.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !words.isEmpty else { return nil }
    let lead = text.unicodeScalars.last.map { !$0.properties.isWhitespace } == true ? " " : ""
    let open = text.unicodeScalars.reversed().first { $0 != " " && $0 != "\t" }.map { !".!?\n".unicodeScalars.contains($0) } ?? false
    let said = open ? Self.carryOn(words) : words
    let start = text.unicodeScalars.count + lead.unicodeScalars.count
    return (lead + said, start..<start + said.unicodeScalars.count)
  }

  /// The text with dictated `words` after it, marked dictated.
  mutating func append(dictated words: String) {
    guard let (insertion, at) = insertion(words) else { return }
    text += insertion
    dictated.add(at)
  }

  /// `words` carrying on a sentence. The recognizer capitalizes what it hears as if it started
  /// one, so a first word capitalized only for that goes lowercase, while "I" and names in
  /// capitals like "NASA" stay.
  static func carryOn(_ words: String) -> String {
    guard let first = words.first else { return "" }
    let word = String(words.prefix { !$0.isWhitespace && !Phrases.hugsTheWordBefore($0) })
    let forASentence = first.isUppercase && !word.dropFirst().contains(where: \.isUppercase)
    if !forASentence || word == "I" || word.hasPrefix("I'") || word.hasPrefix("I’") { return words }
    return first.lowercased() + words.dropFirst()
  }
}

/// Spaces each phrase the recognizer hears from the ones finished before it: it reports them bare.
struct Phrases: Sendable {
  /// The last character of the finished phrases.
  private var last: Character?

  /// Whether `c` follows a word without a space, as a comma or a period does.
  static func hugsTheWordBefore(_ c: Character) -> Bool { ",.?!;:)".contains(c) }

  /// `text`, spaced from the phrases before it.
  func spaced(_ text: String) -> String {
    guard let before = last, let first = text.first, !before.isWhitespace, !first.isWhitespace, !Self.hugsTheWordBefore(first) else { return text }
    return " " + text
  }

  /// `text` as a finished phrase, spaced from the ones before it.
  mutating func finish(_ text: String) -> String {
    let spaced = spaced(text)
    last = text.last ?? last
    return spaced
  }
}
