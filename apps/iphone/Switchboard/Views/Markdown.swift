import QuickLook
import SwiftUI

/// Markdown in chat, as SwiftUI's Text shows it: inline styles and links, headings as bold lines,
/// list items as bullets on rows of their own and code fences in mono. From Switchboard's iPhone app.
struct Markdown: View {
  let text: String

  /// Whether it takes the width it's given, or only what its words need (in a bubble).
  let fill: Bool
  /// Tapbacks on its words, drawn on them.
  let marks: [WordMark]

  init(_ text: String, fill: Bool = true, marks: [WordMark] = []) {
    self.text = text
    self.fill = fill
    self.marks = marks
  }

  var body: some View {
    let blocks = Markdown.blocks(text)
    let texts = WordMark.texts(
      blocks.map { b in
        switch b.kind {
        case .text(let words), .item(_, let words): Markdown.attributed(words)
        default: nil
        }
      }, marks)
    Group {
      if blocks.count == 1, case .text = blocks[0].kind, let only = texts[0] {
        only
      } else {
        // A list's items each a row of their own, so a wrapped line hangs under its words, not its bullet.
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(blocks.enumerated()), id: \.offset) { n, block in
            Group {
              switch block.kind {
              case .text: texts[n]
              case .item(let depth, _):
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                  Text("•")
                  texts[n]
                }
                .padding(.leading, CGFloat(depth) * 14)
              case .code(let words):
                Text(words).font(SIS.data(12)).frame(maxWidth: .infinity, alignment: .leading)
              case .image(let alt, let link):
                ReplyImage(alt: alt, link: link).padding(.vertical, 4)
              }
            }
            .padding(.top, block.gap ? 10 : 2)
          }
        }
        .padding(.top, -2)
      }
    }
    .font(SIS.text(15))
    .lineSpacing(3)
    .textRenderer(WordMark.Renderer())
    .textSelection(.enabled)
    .frame(maxWidth: fill ? .infinity : nil, alignment: .leading)
  }

  /// Its blocks: runs of lines, and each list item on its own, with whether a blank line came before it.
  struct Block {
    enum Kind { case text(String), item(depth: Int, String), code(String), image(alt: String, link: String) }
    let kind: Kind
    let gap: Bool
  }

  static func blocks(_ text: String) -> [Block] {
    var blocks: [Block] = []
    var run: [String] = []
    var gap = false
    var runGap = false
    func flush() {
      if !run.isEmpty { blocks.append(Block(kind: .text(run.joined(separator: "\n")), gap: runGap)) }
      run = []
    }
    var code: [String]?
    for line in text.components(separatedBy: "\n") {
      if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
        if let lines = code {
          blocks.append(Block(kind: .code(lines.joined(separator: "\n")), gap: gap))
          code = nil
        } else {
          flush()
          code = []
        }
        continue
      }
      if code != nil {
        code?.append(line)
        continue
      }
      if line.trimmingCharacters(in: .whitespaces).isEmpty {
        flush()
        gap = !blocks.isEmpty
        continue
      }
      // An image (`![alt](/blobs/…)` or a web one) is a block of its own, the words round it on either side.
      let images = line.matches(of: /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/)
      if !images.isEmpty {
        flush()
        var at = line.startIndex
        for m in images {
          let before = line[at..<m.range.lowerBound].trimmingCharacters(in: .whitespaces)
          if !before.isEmpty { blocks.append(Block(kind: .text(before), gap: gap)) }
          blocks.append(Block(kind: .image(alt: String(m.1), link: String(m.2)), gap: gap && before.isEmpty))
          gap = false
          at = m.range.upperBound
        }
        let after = line[at...].trimmingCharacters(in: .whitespaces)
        if !after.isEmpty { blocks.append(Block(kind: .text(after), gap: false)) }
        continue
      }
      if let item = line.firstMatch(of: /^(\s*)[-*]\s+(.*)$/) {
        flush()
        blocks.append(Block(kind: .item(depth: item.1.count / 2, String(item.2)), gap: gap))
      } else {
        if run.isEmpty { runGap = gap }
        run.append(line)
      }
      gap = false
    }
    if let lines = code { blocks.append(Block(kind: .code(lines.joined(separator: "\n")), gap: gap)) }
    flush()
    return blocks.isEmpty ? [Block(kind: .text(""), gap: false)] : blocks
  }

  static func attributed(_ text: String) -> AttributedString {
    let lines = text.components(separatedBy: "\n").map { line -> String in
      if let heading = line.firstMatch(of: /^#{1,6}\s+(.*)$/) { return "**\(heading.1)**" }
      if let item = line.firstMatch(of: /^(\s*)[-*]\s+(.*)$/) { return "\(item.1)• \(item.2)" }
      return line
    }
    let joined = lines.joined(separator: "\n")
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    var string = (try? AttributedString(markdown: joined, options: options)) ?? AttributedString(joined)
    // Links in ink, underlined, as on the Mac (desktop's markdown.tsx).
    for run in string.runs where run.link != nil {
      string[run.range].swiftUI.underlineStyle = Text.LineStyle(pattern: .solid, color: SIS.ink3)
    }
    return string
  }
}

/// An image in a reply: drawn small, and a tap or Quick Look shows it whole; Share hands it on.
struct ReplyImage: View {
  let alt: String
  let link: String
  /// A gallery's: at this height, its own width.
  var height: CGFloat? = nil
  var bare = false
  /// Opens on a tap itself; a gallery's opens the whole gallery instead.
  var taps = true
  @State private var preview: URL?
  @State private var shared: Shared?

  private var url: URL? { Blobs.resolve(link) }

  /// Its own name: the core's `name`, else the link's last part, else what it's said to be.
  private static func name(_ url: URL?, alt: String) -> String {
    let given = url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: true)?.queryItems?.first { $0.name == "name" }?.value }
    let last = url?.lastPathComponent ?? ""
    let picked = given ?? ((last as NSString).pathExtension.isEmpty ? (alt.isEmpty ? "image" : alt) + ".jpg" : last)
    return picked.replacingOccurrences(of: "/", with: "-")
  }

  var body: some View {
    RemoteImage(url: url, height: height, bare: bare)
      .accessibilityLabel(alt)
      .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: SIS.radius))
      .onTapGesture { if taps { fetch { preview = $0 } } }
      .contextMenu {
        Button("Quick Look", systemImage: "eye") { fetch { preview = $0 } }
        Button("Share", systemImage: "square.and.arrow.up") { fetch { shared = Shared(url: $0) } }
      }
      .quickLookPreview($preview)
      .sheet(item: $shared) { ShareSheet(url: $0.url).presentationDetents([.medium, .large]) }
  }

  private func fetch(_ then: @escaping (URL) -> Void) {
    Task { if let file = try? await Self.file(alt: alt, link: link) { then(file) } }
  }

  /// The picture as a file under its own name, fetched once.
  static func file(alt: String, link: String) async throws -> URL {
    guard let url = Blobs.resolve(link) else { throw Blobs.Failed(reason: "Bad link") }
    // A folder per link: djb2 of it, steady across launches.
    let key = String(url.absoluteString.utf8.reduce(UInt64(5381)) { ($0 &* 33) &+ UInt64($1) }, radix: 16)
    return try await Blobs.file(url, folder: key, name: name(url, alt: alt))
  }
}
