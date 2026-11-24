import SwiftUI

/// An ask in its space's chat, where it was raised (desktop's ask-in-chat.tsx): open, the hand by its
/// title; closed, how it ended as a mark by its title, and under them what came of it. A tap opens
/// it in the ask sheet: to answer, or as it was decided.
struct AskInChat: View {
  let phone: Phone
  let item: ActionItem

  var body: some View {
    Button {
      phone.asking = item.id
    } label: {
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 8) {
          if item.status == "open" { Hand() } else { AskEnding(item: item) }
          Text(item.title).font(SIS.text(14, weight: .medium)).foregroundStyle(SIS.ink2).lineLimit(1)
        }
        if let d = item.detail {
          let words = Text(d.words).foregroundStyle(SIS.ink2)
          Group {
            if let who = d.who {
              Text("\(Text(who + " ").fontWeight(.medium).foregroundStyle(SIS.ink))\(words)")
            } else {
              words
            }
          }
          .font(SIS.text(14)).lineLimit(2).padding(.leading, SIS.mark + 8)
        }
      }
      .multilineTextAlignment(.leading)
      .padding(.vertical, 4)
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(Lit())
  }

  /// Where each ask goes among the chat's lines, by when it was raised: before the first line said
  /// after it, by that line's id; the rest after the last.
  static func placed(_ lines: [Brain.ChatLine], _ asks: [ActionItem]) -> (before: [String: [ActionItem]], after: [ActionItem]) {
    let sorted = asks.sorted { $0.at < $1.at }
    var before: [String: [ActionItem]] = [:]
    var next = 0
    for l in lines {
      while next < sorted.count, sorted[next].at < l.line.time {
        before[l.id, default: []].append(sorted[next])
        next += 1
      }
    }
    return (before, Array(sorted[next...]))
  }
}

/// How a closed ask ended, as its mark: sent a paper plane, approved or done a tick, declined a cross,
/// waved off a dash, what Approve ran failing a stop.
struct AskEnding: View {
  let item: ActionItem

  var body: some View {
    switch item.ending {
    case .sent: Sent()
    case .approved, .done: Tick()
    case .failed: Stop()
    case .declined: Declined()
    case .dismissed: Dismissed()
    }
  }
}

/// How a closed ask ended and what came of it, from what the item records (desktop's ask-outcome.ts).
extension ActionItem {
  enum Ending { case sent, approved, failed, declined, dismissed, done }

  var ending: Ending {
    if status == "dismissed" { return .dismissed }
    if answer?.approved == false { return .declined }
    if ranOK == false { return .failed }
    if answer?.approved == true { return ranOK == true && !drafts.isEmpty ? .sent : .approved }
    return .done
  }

  /// A draft's words as they went: as approved, else as the card showed them.
  func went(_ d: Draft) -> String { answer?.drafts[d.name] ?? shown(d) }

  /// Who a draft goes to, from its label ("To Ann Lee <ann@x.com> · Re: …", "Email to ann@x.com"):
  /// the name it gives, else the address; nil when it names no one.
  static func recipient(_ label: String, to: String?) -> String? {
    let head = label.components(separatedBy: " · ").first ?? ""
    guard let m = head.firstMatch(of: /^(?i)(?:\p{L}+\s+)?to\s+(.+)$/) else { return to.flatMap { $0.isEmpty ? nil : $0 } }
    let named = String(m.1).trimmingCharacters(in: .whitespaces)
    let name = named.split(whereSeparator: { $0 == "<" || $0 == "(" }).first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
    if !name.isEmpty, !named.hasPrefix("<"), !named.hasPrefix("(") { return name }
    if let inner = named.firstMatch(of: /[<(]([^>)]+)[>)]/) { return String(inner.1) }
    return named
  }

  /// What came of it, as data: an approved send's recipient and words as sent (his edit included),
  /// the option picked or the words typed; nil when nothing more than how it ended.
  var detail: (who: String?, words: String)? {
    if let c = answer?.choice { return (nil, c) }
    if let t = answer?.text { return (nil, t) }
    guard answer?.approved == true, let d = drafts.first else { return nil }
    return (Self.recipient(d.label, to: sendTo), went(d))
  }
}
