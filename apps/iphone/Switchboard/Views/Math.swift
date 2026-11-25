import SwiftMath
import SwiftUI
import UIKit

/// Math in an agent's words (`MathSplit`), held out of the Markdown and drawn with SwiftMath in the
/// words' own ink.
enum Math {
  /// A formula held out of the Markdown: a character of the private use area stands in for it.
  struct Formula: Equatable {
    let tex: String
    let display: Bool
  }

  static let first: UInt32 = 0xE000

  /// The words with each formula a character standing in for it, and the formulas. A `$$` formula
  /// on lines of its own stays a line of its own, which `alone` finds.
  static func tokened(_ text: String) -> (String, [Formula]) {
    let segments = MathSplit.split(text)
    guard segments.contains(where: { $0.kind != .text }) else { return (text, []) }
    var formulas: [Formula] = []
    var out = ""
    for segment in segments {
      if segment.kind == .text {
        out += segment.text
      } else if let token = Unicode.Scalar(first + UInt32(formulas.count)), token.value <= 0xF8FF {
        formulas.append(Formula(tex: segment.text, display: segment.kind == .display))
        out.unicodeScalars.append(token)
      } else {
        out += segment.kind == .display ? "$$\(segment.text)$$" : "$\(segment.text)$"
      }
    }
    return (out, formulas)
  }

  private static func formula(_ c: Unicode.Scalar, _ formulas: [Formula]) -> Formula? {
    guard c.value >= first else { return nil }
    let n = Int(c.value - first)
    return n < formulas.count ? formulas[n] : nil
  }

  /// The `$$` formula a line is, when it's that alone.
  static func alone(_ line: String, _ formulas: [Formula]) -> Formula? {
    let scalars = Array(line.trimmingCharacters(in: .whitespaces).unicodeScalars)
    guard scalars.count == 1, let f = formula(scalars[0], formulas), f.display else { return nil }
    return f
  }

  /// The words as they were written, each formula's stand-in back to its TeX.
  static func plain(_ words: String, _ formulas: [Formula]) -> String {
    guard !formulas.isEmpty else { return words }
    var out = ""
    for c in words.unicodeScalars {
      if let f = formula(c, formulas) {
        out += f.display ? "$$\(f.tex)$$" : "$\(f.tex)$"
      } else {
        out.unicodeScalars.append(c)
      }
    }
    return out
  }

  // MARK: Drawing it

  struct Drawn {
    let image: UIImage
    /// How far it reaches below the baseline.
    let descent: CGFloat
  }

  private static let drawn = NSCache<NSString, DrawnBox>()
  private final class DrawnBox {
    let value: Drawn?
    init(_ value: Drawn?) { self.value = value }
  }

  /// A formula drawn black on clear (a template, so the words' ink colors it), at `size` points,
  /// or none when SwiftMath can't read it (its TeX shows instead). Kept, so a reply that streams
  /// lays each formula out once.
  static func draw(_ tex: String, display: Bool, size: CGFloat) -> Drawn? {
    let key = "\(display ? "d" : "t")\(size)|\(tex)" as NSString
    if let box = drawn.object(forKey: key) { return box.value }
    let label = MTMathUILabel()
    label.labelMode = display ? .display : .text
    label.fontSize = size
    label.textColor = .black
    label.latex = tex
    var made: Drawn?
    if label.error == nil {
      let fits = label.intrinsicContentSize
      if fits.width > 0, fits.height > 0 {
        label.frame = CGRect(origin: .zero, size: fits)
        label.layoutSubviews()
        if let list = label.displayList {
          let height = list.ascent + list.descent
          let image = UIGraphicsImageRenderer(size: fits).image { r in
            let context = r.cgContext
            context.translateBy(x: 0, y: fits.height)
            context.scaleBy(x: 1, y: -1)
            list.draw(context)
          }
          // Where SwiftMath put the baseline, from the bottom (it centers what's under half a size).
          let base = height < size / 2 ? (fits.height - size / 2) / 2 + list.descent : list.descent
          made = Drawn(image: image.withRenderingMode(.alwaysTemplate), descent: base)
        }
      }
    }
    drawn.setObject(DrawnBox(made), forKey: key)
    return made
  }

  /// The size a formula in the words is drawn at, beside words of `size` (KaTeX's 1.21 em).
  static func inlineSize(_ size: CGFloat) -> CGFloat { (size * 1.21).rounded() }

  /// Words with their formulas drawn in them, on their baseline: a stand-in becomes its formula.
  static func text(_ attributed: AttributedString, _ formulas: [Formula], size: CGFloat = 15) -> Text {
    guard !formulas.isEmpty, attributed.unicodeScalars.contains(where: { formula($0, formulas) != nil }) else { return Text(attributed) }
    var out = Text("")
    var start = attributed.startIndex
    var at = attributed.startIndex
    while at < attributed.endIndex {
      let next = attributed.unicodeScalars.index(after: at)
      if let f = formula(attributed.unicodeScalars[at], formulas) {
        if start < at { out = Text("\(out)\(Text(AttributedString(attributed[start..<at])))") }
        if let d = draw(f.tex, display: false, size: inlineSize(size)) {
          out = Text("\(out)\(Text(Image(uiImage: d.image)).baselineOffset(-d.descent))")
        } else {
          out = Text("\(out)\(Text(f.display ? "$$\(f.tex)$$" : "$\(f.tex)$"))")
        }
        start = next
      }
      at = next
    }
    if start < attributed.endIndex { out = Text("\(out)\(Text(AttributedString(attributed[start..<attributed.endIndex])))") }
    return out
  }
}

/// A `$$` formula on its own, in the ink round it: centered, scrolling sideways when it's wider than
/// the column.
struct MathBlock: View {
  let tex: String
  var size: CGFloat = 15

  var body: some View {
    if let d = Math.draw(tex, display: true, size: Math.inlineSize(size)) {
      let drawn = Image(uiImage: d.image).padding(.vertical, 4)
      ViewThatFits(in: .horizontal) {
        drawn.frame(maxWidth: .infinity, alignment: .center)
        ScrollView(.horizontal, showsIndicators: false) { drawn }
      }
      .accessibilityLabel(tex)
    } else {
      Text("$$\(tex)$$").font(SIS.data(12)).frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}
