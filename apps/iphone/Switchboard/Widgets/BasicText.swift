import A2UICore
import A2UISwiftUI
import SwiftUI

/// Words, as simple Markdown: a heading of any level is a section's heading (desktop's Head: the
/// heading size, semibold ink, on a row); a caption is desktop's Empty, in ink3; the rest is a
/// line's words, its lists, quotes and code as old Switchboard's Prose drew them. Links and
/// pictures show as words, as A2UI's Text has none. Words that are empty draw nothing. On a key,
/// the key's own words on one line; across a line, bare.
struct BasicText: View {
  let node: Node
  @Environment(\.laid) private var laid
  @Environment(\.lineUp) private var lineUp
  @Environment(\.widgetColumn) private var column

  var body: some View {
    let (words, formulas) = Math.tokened(node.string(for: "text") ?? "")
    let blocks = TextBlocks.read(words)
    let caption = node.string(for: "variant") == "caption"
    // A caption is an empty state's words, which a space's widget column never paints (desktop's
    // widget-cell.tsx); headings alone aren't something to show.
    if !blocks.isEmpty, !(caption && column) {
      drawn(blocks, formulas, caption: caption)
        .preference(key: ShowsSomething.self, value: !caption && blocks.contains { !$0.isHeading })
        .accessibilityIdentifier("a2ui-\(node.id)")
        // What a live region round it announces when it changes.
        .a2uiAccessibleText(Math.plain(TextBlocks.plain(blocks), formulas))
        .a2uiAccessibilityElement(for: node, children: .combine)
    }
  }

  @ViewBuilder private func drawn(_ blocks: [TextBlocks.Block], _ formulas: [Math.Formula], caption: Bool) -> some View {
    let ink = caption ? SIS.ink3 : SIS.ink
    switch laid {
    case .key:
      Math.text(TextBlocks.inline(blocks.compactMap(\.written).joined(separator: " ")), formulas).lineLimit(1)
    case .across:
      VStack(alignment: lineUp, spacing: 2) {
        ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
          TextBlockView(block: block, formulas: formulas, ink: ink)
        }
      }
      .multilineTextAlignment(textAlignment(lineUp))
    case .down:
      VStack(alignment: .leading, spacing: 0) {
        ForEach(Array(TextBlocks.runs(blocks).enumerated()), id: \.offset) { _, run in
          VStack(alignment: lineUp, spacing: SIS.gap) {
            ForEach(Array(run.enumerated()), id: \.offset) { _, block in
              TextBlockView(block: block, formulas: formulas, ink: ink)
            }
          }
          .multilineTextAlignment(textAlignment(lineUp))
          .onLine(lineUp, room: SIS.gap)
        }
      }
    }
  }
}

/// One of a Text's blocks, in the body face (a heading in the heading size, semibold).
private struct TextBlockView: View {
  let block: TextBlocks.Block
  let formulas: [Math.Formula]
  let ink: Color

  var body: some View {
    switch block {
    case .heading(let words):
      Math.text(TextBlocks.inline(words), formulas, size: SIS.Size.heading)
        .font(SIS.text(SIS.Size.heading, weight: .semibold))
        .foregroundStyle(SIS.ink)
        .accessibilityAddTraits(.isHeader)
    case .words(let words):
      if let formula = Math.alone(words, formulas) {
        MathBlock(tex: formula.tex, size: SIS.Size.body).foregroundStyle(ink)
      } else {
        Math.text(TextBlocks.inline(words), formulas, size: SIS.Size.body).font(SIS.text(SIS.Size.body)).foregroundStyle(ink)
      }
    case .item(let marker, let words):
      HStack(alignment: .firstTextBaseline, spacing: SIS.gap) {
        Text(marker).font(SIS.text(SIS.Size.body, weight: marker == "•" ? .bold : .regular)).foregroundStyle(SIS.ink2)
        Math.text(TextBlocks.inline(words), formulas, size: SIS.Size.body).font(SIS.text(SIS.Size.body)).foregroundStyle(ink)
      }
    case .quote(let words):
      HStack(spacing: SIS.gap + 2) {
        Rectangle().fill(SIS.rule).frame(width: SIS.rail)
        Math.text(TextBlocks.inline(words), formulas, size: SIS.Size.body).font(SIS.text(SIS.Size.body)).foregroundStyle(SIS.ink2)
      }
      .fixedSize(horizontal: false, vertical: true)
    case .code(let code):
      Text(code).font(SIS.data(12)).foregroundStyle(ink)
    case .rule:
      Hairline()
    }
  }
}

/// A Text's words as blocks, found line by line: headings, runs of words, list items, quotes, code
/// and rules.
enum TextBlocks {
  enum Block {
    case heading(String)
    case words(String)
    case item(String, String)
    case quote(String)
    case code(String)
    case rule

    var isHeading: Bool {
      if case .heading = self { return true }
      return false
    }

    /// Its words as written, Markdown and all; none for a rule.
    var written: String? {
      switch self {
      case .heading(let words), .words(let words), .item(_, let words), .quote(let words), .code(let words): words
      case .rule: nil
      }
    }
  }

  static func read(_ text: String) -> [Block] {
    var blocks: [Block] = []
    var run: [String] = []
    var code: [String]?
    func flush() {
      let words = run.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
      if !words.isEmpty { blocks.append(.words(words)) }
      run = []
    }
    func add(_ block: Block, _ words: String) {
      flush()
      if !words.trimmingCharacters(in: .whitespaces).isEmpty { blocks.append(block) }
    }
    for raw in text.components(separatedBy: "\n") {
      let line = raw.trimmingCharacters(in: .whitespaces)
      if line.hasPrefix("```") {
        if let lines = code {
          let shown = lines.joined(separator: "\n")
          add(.code(shown), shown)
          code = nil
        } else {
          flush()
          code = []
        }
        continue
      }
      if code != nil {
        code?.append(raw)
        continue
      }
      if line.isEmpty {
        flush()
      } else if let heading = line.firstMatch(of: /^#{1,6}(?:\s+(.*))?$/) {
        let words = String(heading.1 ?? "").trimmingCharacters(in: .whitespaces)
        add(.heading(words), words)
      } else if line == "---" || line == "***" || line == "___" {
        flush()
        blocks.append(.rule)
      } else if let item = line.firstMatch(of: /^[-*•]\s+(.*)$/) {
        add(.item("•", String(item.1)), String(item.1))
      } else if let item = line.firstMatch(of: /^(\d+)[.)]\s+(.*)$/) {
        add(.item("\(item.1).", String(item.2)), String(item.2))
      } else if line.hasPrefix(">") {
        let words = line.dropFirst().trimmingCharacters(in: .whitespaces)
        add(.quote(words), words)
      } else {
        run.append(line)
      }
    }
    if let lines = code {
      let shown = lines.joined(separator: "\n")
      add(.code(shown), shown)
    }
    flush()
    // A rule alone is no words.
    return blocks.contains { if case .rule = $0 { false } else { true } } ? blocks : []
  }

  /// Headings each on a row of their own, the blocks between them together.
  static func runs(_ blocks: [Block]) -> [[Block]] {
    var runs: [[Block]] = []
    for block in blocks {
      let joins = !block.isHeading && runs.last?.first?.isHeading == false
      if joins {
        runs[runs.count - 1].append(block)
      } else {
        runs.append([block])
      }
    }
    return runs
  }

  /// Inline Markdown (strong, emphasis, code), its links' and pictures' targets dropped, as
  /// BasicCatalogSwiftUI's Text does.
  static func inline(_ words: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    var shown = (try? AttributedString(markdown: words, options: options)) ?? AttributedString(words)
    for run in shown.runs {
      let link: URL? = run.link
      let picture: URL? = run.imageURL
      if link != nil || picture != nil {
        shown[run.range].link = nil
        shown[run.range].imageURL = nil
      }
    }
    return shown
  }

  /// Its words without their Markdown, a line a block.
  static func plain(_ blocks: [Block]) -> String {
    blocks.compactMap { block -> String? in
      switch block {
      case .item(let marker, let words): "\(marker) \(String(inline(words).characters))"
      case .code(let code): code
      default: block.written.map { String(inline($0).characters) }
      }
    }
    .joined(separator: "\n")
  }
}
