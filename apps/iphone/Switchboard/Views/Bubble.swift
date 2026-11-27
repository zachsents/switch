import SwiftUI

/// One said thing, as iMessage: the user's in a bubble of the space's ink on the right, the agent's
/// in gray on the left, the last of a run with its tail. What it replies to is inset at its top,
/// each with the user's words to it under it, then the rest of what they said;
/// its tapbacks sit on its top corner, those on its words at their end; its time, the six
/// tapbacks, Copy and Edit are in its long-press menu, with the model that wrote it. Desktop's ui/chat.tsx.
struct Said: View {
  let agent: Bool
  let ink: Color
  var dim = false
  /// The find bar's current match: ringed.
  var ringed = false
  let text: String
  /// A reply's long version, opened from More.
  var detail: String?
  /// The last of its run: it has the tail.
  var tail = true
  /// When it was said, for its menu.
  var time: Double?
  /// The display name of the model that wrote it, beside its time in its menu.
  var model: String?
  var reactions = Reactions()
  /// What it replies to, each going to its source.
  var insets: [ReplyInset] = []
  /// Tapbacks on its words.
  var marks: [WordMark] = []
  var onInset: ((Reply) -> Void)?
  /// Set once it's in the log: the six tapbacks in its menu.
  var onReact: ((Reaction) -> Void)?
  /// Set with it: any emoji, from the emoji keyboard.
  var onEmoji: (() -> Void)?
  /// The user's last message: Edit puts it back in the box.
  var onEdit: (() -> Void)?
  /// The spaces it shows in, when more than one: each a Remove from it.
  var removals: [(id: String, name: String)] = []
  var onRemove: ((String) -> Void)?
  /// Opens the whole of a long line, with its detail.
  var onRead: ((String) -> Void)?

  @Environment(\.colorScheme) private var scheme

  static let radius: CGFloat = 18

  private var fill: Color { agent ? SIS.bubble : ink }

  /// Its words whole: the text, then its detail.
  private var whole: String {
    guard let detail, !detail.isEmpty else { return text }
    return "\(text)\n\n\(detail)"
  }

  var body: some View {
    InsetStack {
      ForEach(insets, id: \.reply) { inset in
        InsetRow(inset: inset, right: !agent) { onInset?(inset.reply) }
          .layoutValue(key: Stretched.self, value: true)
          .padding(.horizontal, -6)
          .padding(.top, 2)
          .padding(.bottom, !inset.reply.said.isEmpty ? 2 : inset.reply != insets.last?.reply ? 4 : text.isEmpty ? 0 : 6)
        if !inset.reply.said.isEmpty {
          Text(inset.reply.said)
            .font(SIS.text(15))
            .foregroundStyle(agent ? SIS.ink : .white)
            .padding(.bottom, 6)
        }
      }
      if !text.isEmpty { words }
    }
      .padding(.horizontal, 12)
      .padding(.vertical, 7)
      .background(fill, in: RoundedRectangle(cornerRadius: Self.radius, style: .continuous))
      .background(alignment: agent ? .bottomLeading : .bottomTrailing) {
        if tail {
          Tail().fill(fill).frame(width: 24, height: 18).scaleEffect(x: agent ? -1 : 1).offset(x: agent ? -6 : 6)
        }
      }
      .overlay {
        if ringed {
          RoundedRectangle(cornerRadius: Self.radius + 3, style: .continuous).stroke(SIS.ink, lineWidth: 2).padding(-3)
        }
      }
      .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: Self.radius, style: .continuous))
      .contextMenu { menu }
      .overlay(alignment: agent ? .topTrailing : .topLeading) {
        if !reactions.isEmpty {
          Badges(reactions: reactions, agent: agent, ink: ink).offset(x: agent ? 14 : -14, y: -16)
        }
      }
      .opacity(dim ? 0.6 : 1)
      .padding(.top, reactions.isEmpty ? 0 : 14)
      .frame(maxWidth: .infinity, alignment: agent ? .leading : .trailing)
      .padding(agent ? .trailing : .leading, 64)
  }

  @ViewBuilder private var words: some View {
    if agent {
      AgentWords(text: text, marks: marks, more: detail?.isEmpty == false) { onRead?(whole) }
    } else {
      UserWords(text: text, marks: marks) { onRead?(text) }
    }
  }

  @ViewBuilder private var menu: some View {
    if let onReact {
      ControlGroup {
        ForEach(Reaction.allCases, id: \.self) { r in
          Button {
            onReact(r)
          } label: {
            Label {
              Text(r.name)
            } icon: {
              Tapbacks.image(r, chosen: reactions.user == r, ink: ink, scheme: scheme)
            }
          }
        }
      }
      .controlGroupStyle(.palette)
      if let onEmoji { Button("Emoji", systemImage: "face.smiling", action: onEmoji) }
    }
    if let time {
      Section([Self.when(time), model].compactMap { $0 }.joined(separator: " · ")) { keys }
    } else {
      keys
    }
  }

  @ViewBuilder private var keys: some View {
    Button {
      UIPasteboard.general.string = whole
    } label: {
      Label("Copy", systemImage: "doc.on.doc")
    }
    if let onEdit { Button("Edit", systemImage: "pencil", action: onEdit) }
    if let onRemove, !removals.isEmpty {
      Section {
        ForEach(removals, id: \.id) { space in
          Button("Remove from \(space.name)", systemImage: "minus.circle") { onRemove(space.id) }
        }
      }
    }
  }

  /// When it was said, in its menu: "Today 9:12 PM".
  static func when(_ ms: Double) -> String { GapTime.label(ms) }
}

/// The user's words: plain, clamped to six lines; a tap reads them whole.
private struct UserWords: View {
  let text: String
  let marks: [WordMark]
  let read: () -> Void
  @State private var full: CGFloat = 0
  @State private var shown: CGFloat = 0

  var body: some View {
    let clamped = full > shown + 1
    (WordMark.texts([AttributedString(text)], marks)[0] ?? Text(text))
      .font(SIS.text(15))
      .foregroundStyle(.white)
      .lineLimit(6)
      .textRenderer(WordMark.Renderer())
      .onGeometryChange(for: CGFloat.self, of: \.size.height) { shown = $0 }
      .background {
        Text(text).font(SIS.text(15)).fixedSize(horizontal: false, vertical: true).hidden()
          .onGeometryChange(for: CGFloat.self, of: \.size.height) { full = $0 }
      }
      .onTapGesture { if clamped { read() } }
  }
}

/// The agent's words as Markdown: its detail, or past about 24 lines, opens from More.
private struct AgentWords: View {
  let text: String
  let marks: [WordMark]
  /// It has a detail.
  let more: Bool
  let read: () -> Void
  @State private var full: CGFloat = 0

  /// About 24 lines of words.
  private var most: CGFloat { 24 * 21 * SIS.scale }

  var body: some View {
    let clamped = full > most
    VStack(alignment: .leading, spacing: 2) {
      Markdown(text, fill: false, marks: marks)
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self, of: \.size.height) { full = $0 }
        .frame(maxHeight: clamped ? most : nil, alignment: .top)
        // Clipped only when clamped, so a badge on its first line shows over the bubble's edge.
        .clipShape(Rectangle().inset(by: clamped ? 0 : -40))
      if more || clamped {
        Button("More", action: read)
          .buttonStyle(.plain)
          .font(SIS.text(13, weight: .semibold))
          .frame(minHeight: 28)
      }
    }
    .foregroundStyle(SIS.ink)
  }
}

/// The tail, on a bubble's bottom corner: it fills the corner and curls out past the edge (on the
/// right; mirrored for the left).
nonisolated private struct Tail: Shape {
  func path(in r: CGRect) -> Path {
    let x = r.width / 24
    let y = r.height / 18
    let p = { (a: CGFloat, b: CGFloat) in CGPoint(x: r.minX + a * x, y: r.minY + b * y) }
    var path = Path()
    path.move(to: p(18, 0))
    path.addCurve(to: p(24, 18), control1: p(18, 9), control2: p(19, 14))
    path.addCurve(to: p(12, 15.5), control1: p(19, 18.5), control2: p(15, 17.5))
    path.addCurve(to: p(0, 18), control1: p(10, 17), control2: p(6, 18))
    path.addLine(to: p(0, 0))
    path.closeSubpath()
    return path
  }
}

extension Tapback {
  var name: String {
    switch self {
    case .love: "Love"
    case .like: "Like"
    case .dislike: "Dislike"
    case .laugh: "Haha"
    case .emphasize: "Emphasize"
    case .question: "Question"
    }
  }

  /// Its color, as iMessage draws it now: Apple's system colors.
  var color: Color {
    switch self {
    case .love: Color(.systemPink)
    case .like: Color(.systemOrange)
    case .dislike: Color(.systemIndigo)
    case .laugh: Color(.systemPurple)
    case .emphasize: Color(.systemRed)
    case .question: Color(.systemBlue)
    }
  }
}

extension Reaction {
  /// A tapback's name, or the emoji itself.
  var name: String { tapback?.name ?? rawValue }
}

/// A tapback's glyph, `size` points across.
struct TapbackGlyph: View {
  let reaction: Reaction
  var size: CGFloat = 14

  var body: some View {
    Group {
      switch reaction.tapback {
      case nil: Text(reaction.rawValue).font(.system(size: size * 0.9))
      case .love: Image(systemName: "heart.fill").font(.system(size: size * 0.82, weight: .bold))
      case .like: Image(systemName: "hand.thumbsup.fill").font(.system(size: size * 0.82, weight: .bold))
      case .dislike: Image(systemName: "hand.thumbsdown.fill").font(.system(size: size * 0.82, weight: .bold))
      case .laugh:
        VStack(spacing: -size * 0.12) {
          Text("HA")
          Text("HA")
        }
        .font(.system(size: size * 0.4, weight: .black))
      case .emphasize: Text("!!").font(.system(size: size * 0.8, weight: .black)).tracking(-size * 0.06)
      case .question: Text("?").font(.system(size: size * 0.8, weight: .black))
      }
    }
    .foregroundStyle(reaction.tapback?.color ?? SIS.ink)
    .frame(width: size, height: size)
  }
}

/// The reactions on a bubble, on its top corner away from its side, each in the bubble's gray with
/// its glyph in color: the user's ringed in their ink, the agent's in the page.
private struct Badges: View {
  let reactions: Reactions
  /// The bubble is the agent's.
  let agent: Bool
  let ink: Color

  var body: some View {
    HStack(spacing: 2) {
      if agent {
        if let r = reactions.agent { badge(r, mine: false) }
        if let r = reactions.user { badge(r, mine: true) }
      } else {
        if let r = reactions.user { badge(r, mine: true) }
        if let r = reactions.agent { badge(r, mine: false) }
      }
    }
  }

  private func badge(_ r: Reaction, mine: Bool) -> some View {
    TapbackGlyph(reaction: r, size: 15)
      .frame(width: 28, height: 28)
      .background(SIS.bubble, in: Circle())
      .padding(2)
      .background(mine ? ink : SIS.paper, in: Circle())
      .accessibilityElement()
      .accessibilityLabel(r.name)
  }
}

/// The six tapbacks as the long-press menu's palette draws them, each in its color: the user's own
/// one on their ink's tint.
@MainActor
enum Tapbacks {
  private static var held: [String: UIImage] = [:]

  static func image(_ r: Reaction, chosen: Bool, ink: Color, scheme: ColorScheme) -> Image {
    let key = "\(r.rawValue):\(chosen):\(scheme):\(ink.description)"
    if let got = held[key] { return Image(uiImage: got) }
    let view = TapbackGlyph(reaction: r, size: 20)
      .frame(width: 32, height: 32)
      .background(chosen ? ink.opacity(0.25) : Color.clear, in: Circle())
      .environment(\.colorScheme, scheme)
    let renderer = ImageRenderer(content: view)
    renderer.scale = 3
    let made = renderer.uiImage?.withRenderingMode(.alwaysOriginal) ?? UIImage()
    held[key] = made
    return Image(uiImage: made)
  }
}

/// What a bubble replies to, as it shows: words of a message, or an ask by its title and space.
struct ReplyInset: Hashable {
  let reply: Reply
  var name = ""
  var space = ""
}

/// One of a bubble's replies, inset darker at its top: a quote's words beside a bar, or an ask's
/// hand, title and space. A tap goes to it (desktop's said-replies.tsx ReplyInsets).
private struct InsetRow: View {
  let inset: ReplyInset
  /// The bubble is the user's.
  let right: Bool
  let go: () -> Void

  var body: some View {
    Button(action: go) {
      Group {
        switch inset.reply {
        case .quote(_, let text, _, _):
          Text(text)
            .lineLimit(3)
            .multilineTextAlignment(.leading)
            .padding(.leading, 8)
            .overlay(alignment: .leading) {
              Rectangle().fill(right ? Color.white.opacity(0.6) : SIS.ink3).frame(width: 2)
            }
        case .ask:
          HStack(spacing: 6) {
            Hand(size: 12)
            Text(inset.name).lineLimit(1)
            if !inset.space.isEmpty { Text(inset.space).lineLimit(1).opacity(0.7).layoutPriority(-1) }
          }
        }
      }
      .font(SIS.text(13))
      .foregroundStyle(right ? Color.white.opacity(0.9) : SIS.ink2)
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(right ? Color.black.opacity(0.2) : SIS.ink.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
    .buttonStyle(.plain)
  }
}

/// A row that stretches to the bubble's width rather than setting it.
nonisolated private struct Stretched: LayoutValueKey {
  static let defaultValue = false
}

/// A bubble's insets above its words, the bubble as wide as the widest of them (each inset at its
/// natural width) and the insets stretched across it.
private struct InsetStack: Layout {
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = widest(proposal, subviews)
    let height = subviews.reduce(CGFloat(0)) { $0 + $1.sizeThatFits(ProposedViewSize(width: width, height: nil)).height }
    return CGSize(width: width, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var y = bounds.minY
    for s in subviews {
      let size = s.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
      s.place(at: CGPoint(x: bounds.minX, y: y), proposal: ProposedViewSize(width: bounds.width, height: size.height))
      y += size.height
    }
  }

  private func widest(_ proposal: ProposedViewSize, _ subviews: Subviews) -> CGFloat {
    let most = proposal.width ?? .infinity
    return subviews.map { s in
      s[Stretched.self]
        ? min(s.sizeThatFits(.unspecified).width, most)
        : s.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil)).width
    }.max() ?? 0
  }
}

/// The agent at work on its answer, as iMessage's typing bubble: three dots, lit in turn.
struct Typing: View {
  var body: some View {
    TimelineView(.periodic(from: .now, by: 0.4)) { t in
      let lit = Int(t.date.timeIntervalSinceReferenceDate / 0.4) % 3
      HStack(spacing: 4) {
        ForEach(0..<3, id: \.self) { i in
          Circle().fill(i == lit ? SIS.ink2 : SIS.ink3).frame(width: 8, height: 8)
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 12)
      .background(SIS.bubble, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
      .background(alignment: .bottomLeading) {
        Tail().fill(SIS.bubble).frame(width: 24, height: 18).scaleEffect(x: -1).offset(x: -6)
      }
    }
    .accessibilityLabel("Typing")
  }
}
