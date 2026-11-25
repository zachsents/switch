import Foundation

/// Math in an agent's words, found as on every surface (packages/gateway/src/math/split.ts, and
/// its cases.json, which scripts/math-cases.sh checks this against): `$$…$$` on its own, `$…$` in
/// the words only when its dollars hug it (no space after the opening one, none before the closing
/// one, no digit after it), so "$215" and "costs $5 and $10" stay money; `\$` is a dollar, and
/// nothing in code is math.
enum MathSplit {
  struct Segment: Equatable {
    enum Kind: String { case text, inline, display }
    let kind: Kind
    let text: String
  }

  private static func isSpace(_ c: Unicode.Scalar?) -> Bool { c == " " || c == "\t" || c == "\n" || c == "\r" }
  private static func isDigit(_ c: Unicode.Scalar?) -> Bool { c.map { $0 >= "0" && $0 <= "9" } ?? false }

  static func split(_ text: String) -> [Segment] {
    let s = Array(text.unicodeScalars)
    func at(_ i: Int) -> Unicode.Scalar? { i >= 0 && i < s.count ? s[i] : nil }
    func slice(_ a: Int, _ b: Int) -> String {
      var out = String.UnicodeScalarView()
      out.append(contentsOf: s[max(a, 0)..<min(b, s.count)])
      return String(out)
    }
    func lineEnd(_ from: Int) -> Int? {
      var i = from
      while i < s.count {
        if s[i] == "\n" { return i }
        i += 1
      }
      return nil
    }
    func fenceEnd(_ start: Int) -> Int? {
      var i = start
      while i < start + 3, at(i) == " " { i += 1 }
      guard let mark = at(i), mark == "`" || mark == "~" else { return nil }
      var run = 0
      while at(i + run) == mark { run += 1 }
      guard run >= 3 else { return nil }
      var line = lineEnd(i)
      while let l = line {
        var j = l + 1
        while j < l + 4, at(j) == " " { j += 1 }
        var close = 0
        while at(j + close) == mark { close += 1 }
        if close >= run { return lineEnd(j + close) ?? s.count }
        line = lineEnd(l + 1)
      }
      return s.count
    }
    func codeEnd(_ start: Int, _ run: Int) -> Int? {
      var i = start + run
      while i < s.count {
        if s[i] == "`" {
          var n = 0
          while at(i + n) == "`" { n += 1 }
          if n == run { return i + n }
          i += n
        } else {
          i += 1
        }
      }
      return nil
    }
    func displayEnd(_ from: Int) -> Int? {
      var i = from
      while i < s.count - 1 {
        if s[i] == "\\" {
          i += 2
        } else if s[i] == "$", s[i + 1] == "$" {
          return i
        } else {
          i += 1
        }
      }
      return nil
    }
    func inlineEnd(_ start: Int) -> Int? {
      if isSpace(at(start + 1)) || at(start + 1) == "$" || start + 1 >= s.count { return nil }
      var i = start + 1
      while i < s.count {
        let c = s[i]
        if c == "\\" {
          i += 2
        } else if c == "\n" {
          var j = i + 1
          while at(j) == " " || at(j) == "\t" || at(j) == "\r" { j += 1 }
          if at(j) == "\n" || j >= s.count { return nil }
          i += 1
        } else if c == "$" {
          return isSpace(at(i - 1)) || isDigit(at(i + 1)) ? nil : i
        } else {
          i += 1
        }
      }
      return nil
    }

    var out: [Segment] = []
    var words = ""
    func put(_ kind: Segment.Kind, _ math: String) {
      if !words.isEmpty { out.append(Segment(kind: .text, text: words)) }
      words = ""
      out.append(Segment(kind: kind, text: math))
    }
    var i = 0
    while i < s.count {
      let c = s[i]
      if i == 0 || s[i - 1] == "\n", let end = fenceEnd(i) {
        words += slice(i, end)
        i = end
        continue
      }
      if c == "\\" {
        words += slice(i, i + 2)
        i += 2
      } else if c == "`" {
        var run = 0
        while at(i + run) == "`" { run += 1 }
        let end = codeEnd(i, run) ?? i + run
        words += slice(i, end)
        i = end
      } else if c == "$", at(i + 1) == "$" {
        let end = displayEnd(i + 2)
        let math = end.map { slice(i + 2, $0).trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
        if let end, !math.isEmpty {
          put(.display, math)
          i = end + 2
        } else {
          words += "$$"
          i += 2
        }
      } else if c == "$" {
        if let end = inlineEnd(i) {
          put(.inline, slice(i + 1, end))
          i = end + 1
        } else {
          words += "$"
          i += 1
        }
      } else {
        words.unicodeScalars.append(c)
        i += 1
      }
    }
    if !words.isEmpty { out.append(Segment(kind: .text, text: words)) }
    return out
  }
}
