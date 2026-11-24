import SwiftUI

/// A tapback on words of a bubble, as it's drawn: its words underlined in `line`, its badge at
/// their end (desktop's ui/said-replies.tsx PartMarks).
struct WordMark: Hashable {
  let text: String
  let reaction: Reaction
  /// The user's own: ringed in their ink.
  let mine: Bool
  let line: Color
  let ink: Color

  /// A line's reactions on its words, colored for its bubble: the user's in their ink (white on
  /// their own bubble), the agent's in its gray.
  static func of(_ parts: [PartReaction], agent: Bool, ink: Color) -> [WordMark] {
    parts.map { p in
      let line = agent ? (p.agent ? SIS.ink3 : ink) : (p.agent ? SIS.bubble : Color.white)
      return WordMark(text: p.text, reaction: p.reaction, mine: !p.agent, line: line, ink: ink)
    }
  }

  /// `blocks`' texts with each mark's words tagged for `Renderer`, found as desktop finds them:
  /// spaces aside, across blocks. A block that's nil isn't words.
  static func texts(_ blocks: [AttributedString?], _ marks: [WordMark]) -> [Text?] {
    // Every block's characters, and the run of all that aren't spaces, by block and offset.
    let chars = blocks.map { $0.map { Array($0.characters) } ?? [] }
    var solid: [(block: Int, at: Int)] = []
    var joined: [Character] = []
    for (b, cs) in chars.enumerated() {
      for (i, c) in cs.enumerated() where !c.isWhitespace {
        solid.append((b, i))
        joined.append(c)
      }
    }
    // Per block, each character's mark (the later mark wins on overlap), and where each ends.
    var tags = chars.map { [Tag?](repeating: nil, count: $0.count) }
    for (n, mark) in marks.enumerated() {
      let needle = Array(mark.text.filter { !$0.isWhitespace })
      guard !needle.isEmpty, let start = find(needle, in: joined) else { continue }
      let span = solid[start..<(start + needle.count)]
      for b in Set(span.map(\.block)) {
        let inBlock = span.filter { $0.block == b }.map(\.at)
        guard let from = inBlock.min(), let to = inBlock.max() else { continue }
        for i in from...to { tags[b][i] = Tag(mark: mark, id: n, last: false) }
      }
      if let end = span.last { tags[end.block][end.at] = Tag(mark: mark, id: n, last: true) }
    }
    return blocks.enumerated().map { b, attributed in
      guard let attributed else { return nil }
      guard tags[b].contains(where: { $0 != nil }) else { return Text(attributed) }
      // Runs of the same tag, each its own Text so the renderer sees it.
      var out = Text("")
      var i = 0
      let cs = attributed.characters
      while i < tags[b].count {
        var j = i + 1
        while j < tags[b].count, tags[b][j] == tags[b][i] { j += 1 }
        let lo = cs.index(cs.startIndex, offsetBy: i)
        let hi = cs.index(cs.startIndex, offsetBy: j)
        var piece = Text(AttributedString(attributed[lo..<hi]))
        if let tag = tags[b][i] { piece = piece.customAttribute(tag) }
        out = Text("\(out)\(piece)")
        i = j
      }
      return out
    }
  }

  private static func find(_ needle: [Character], in hay: [Character]) -> Int? {
    guard needle.count <= hay.count else { return nil }
    for i in 0...(hay.count - needle.count) where hay[i] == needle[0] {
      if Array(hay[i..<(i + needle.count)]) == needle { return i }
    }
    return nil
  }

  /// A run of a mark's words; `last` holds its final character, where the badge goes.
  struct Tag: TextAttribute {
    let mark: WordMark
    let id: Int
    let last: Bool
  }

  /// Draws the text, a 2pt underline under each mark's words and its badge at their end.
  struct Renderer: TextRenderer {
    func draw(layout: Text.Layout, in ctx: inout GraphicsContext) {
      var ends: [Int: (WordMark, CGRect)] = [:]
      for line in layout {
        for run in line {
          ctx.draw(run)
          guard let tag = run[Tag.self] else { continue }
          let box = run.typographicBounds
          let r = box.rect
          ctx.fill(Path(CGRect(x: r.minX, y: box.origin.y + 1.5, width: r.width, height: 2)), with: .color(tag.mark.line))
          if tag.last { ends[tag.id] = (tag.mark, r) }
        }
      }
      for (mark, r) in ends.values { badge(mark, at: CGPoint(x: r.maxX + 5, y: r.minY - 3), in: &ctx) }
    }

    /// A small badge, as the bubble's corner one: the bubble's gray, its glyph in color, the user's
    /// ringed in their ink, the agent's in the page.
    private func badge(_ m: WordMark, at c: CGPoint, in ctx: inout GraphicsContext) {
      let d: CGFloat = 18
      ctx.fill(Path(ellipseIn: CGRect(x: c.x - d / 2 - 1.5, y: c.y - d / 2 - 1.5, width: d + 3, height: d + 3)), with: .color(m.mine ? m.ink : SIS.paper))
      ctx.fill(Path(ellipseIn: CGRect(x: c.x - d / 2, y: c.y - d / 2, width: d, height: d)), with: .color(SIS.bubble))
      let tint = m.reaction.tapback?.color ?? SIS.ink
      let size = d * 0.55
      switch m.reaction.tapback {
      case .laugh:
        let ha = ctx.resolve(Text("HA").font(.system(size: size * 0.55, weight: .black)).foregroundStyle(tint))
        ctx.draw(ha, at: CGPoint(x: c.x, y: c.y - size * 0.22))
        ctx.draw(ha, at: CGPoint(x: c.x, y: c.y + size * 0.22))
      default:
        ctx.draw(ctx.resolve(Self.glyph(m.reaction, size).foregroundStyle(tint)), at: c)
      }
    }

    private static func glyph(_ r: Reaction, _ size: CGFloat) -> Text {
      switch r.tapback {
      case nil: Text(r.rawValue).font(.system(size: size))
      case .love: Text(Image(systemName: "heart.fill")).font(.system(size: size * 0.82, weight: .bold))
      case .like: Text(Image(systemName: "hand.thumbsup.fill")).font(.system(size: size * 0.82, weight: .bold))
      case .dislike: Text(Image(systemName: "hand.thumbsdown.fill")).font(.system(size: size * 0.82, weight: .bold))
      case .emphasize: Text("!!").font(.system(size: size, weight: .black))
      case .question, .laugh: Text("?").font(.system(size: size, weight: .black))
      }
    }
  }
}
