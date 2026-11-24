import SwiftUI

/// How a chat's lines sit, as iMessage: a side's lines within 5 minutes run together, the last of
/// a run with the tail; a 10-minute quiet puts the time over the next line. Desktop's ui/runs.ts.
enum Runs {
  /// How a line sits under the one before: in its run, apart, or after a gap with the time over it.
  enum Lead: Equatable {
    case run
    case apart
    case gap(Double)
  }

  /// Lines from one side this close run together.
  static let run: Double = 5 * 60_000
  /// A quiet this long puts the time over the next line.
  static let gap: Double = 10 * 60_000

  /// Said, in a bubble: not a blip, a widget or a file alone.
  private static func said(_ l: Brain.ChatLine?) -> Bool {
    guard let l else { return false }
    return l.line.quiet == nil && l.line.widget == nil && !l.line.text.isEmpty
  }

  /// Each line's lead, and the ids of those that end their run.
  static func of(_ lines: [Brain.ChatLine]) -> (leads: [String: Lead], ends: Set<String>) {
    var leads: [String: Lead] = [:]
    var last: Double?
    for (i, l) in lines.enumerated() {
      let time = l.line.time
      if time > 0, last.map({ time - $0 >= gap }) ?? true {
        leads[l.id] = .gap(time)
      } else {
        let before = i > 0 ? lines[i - 1] : nil
        let together =
          said(l) && said(before) && before?.line.agent == l.line.agent && before?.line.from == l.line.from && time - (before?.line.time ?? 0) < run
        leads[l.id] = together ? .run : .apart
      }
      if time > 0 { last = time }
    }
    var ends: Set<String> = []
    for (i, l) in lines.enumerated() where i + 1 >= lines.count || leads[lines[i + 1].id] != .run {
      ends.insert(l.id)
    }
    return (leads, ends)
  }
}

/// The time over a line after a gap: "Today 9:12 PM".
struct GapTime: View {
  let time: Double

  static func label(_ ms: Double) -> String {
    let date = Date(timeIntervalSince1970: ms / 1000)
    let calendar = Calendar.current
    let day: String =
      if calendar.isDateInToday(date) {
        "Today"
      } else if calendar.isDateInYesterday(date) {
        "Yesterday"
      } else if calendar.isDate(date, equalTo: .now, toGranularity: .year) {
        date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
      } else {
        date.formatted(.dateTime.month(.abbreviated).day().year())
      }
    return "\(day) \(date.formatted(date: .omitted, time: .shortened))"
  }

  var body: some View {
    Text(Self.label(time))
      .font(SIS.text(11, weight: .medium))
      .foregroundStyle(SIS.ink2)
      .frame(maxWidth: .infinity)
      .padding(.top, 16)
      .padding(.bottom, 8)
  }
}

/// What happened rather than what was said, in a chat: one centred line, a small mark and a few
/// words. A tap opens the whole of it, when, and what can be done about it (Undo, Open). Desktop's
/// ui/blip.tsx.
struct Blip<Mark: View, Whole: View, Actions: View>: View {
  @ViewBuilder let mark: Mark
  /// Its few words.
  let words: String
  var time: Double?
  @ViewBuilder let whole: Whole
  @ViewBuilder let actions: Actions
  @State private var open = false

  var body: some View {
    Button {
      open = true
    } label: {
      HStack(spacing: 6) {
        mark.frame(width: 12, height: 12)
        Text(words).lineLimit(1)
      }
      .font(SIS.text(12))
      .foregroundStyle(SIS.ink2)
      .padding(.horizontal, 10)
      .frame(minHeight: 28)
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .frame(maxWidth: .infinity)
    .popover(isPresented: $open) {
      VStack(alignment: .leading, spacing: 12) {
        whole
          .font(SIS.text(14))
          .foregroundStyle(SIS.ink)
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
        HStack(spacing: 12) {
          if let time { Text(GapTime.label(time)).font(SIS.text(12)).foregroundStyle(SIS.ink2) }
          Spacer(minLength: 0)
          actions
        }
        .buttonStyle(KeyStyle())
      }
      .padding(SIS.inset)
      .frame(width: 300)
      .fixedSize(horizontal: false, vertical: true)
      .presentationCompactAdaptation(.popover)
      .presentationBackground(SIS.paper)
    }
  }
}

/// A blip's few words: its text's first clause, up to about forty characters.
func blipGist(_ text: String) -> String {
  let line = text.components(separatedBy: "\n").first ?? text
  let first =
    line.range(of: #"(?<=[.;:])\s|\s[–—]\s"#, options: .regularExpression).map { String(line[..<$0.lowerBound]) } ?? line
  let clause = first.replacingOccurrences(of: #"[.;:,]$"#, with: "", options: .regularExpression)
  guard clause.count > 44 else { return clause }
  let head = String(clause.prefix(42))
  let cut = head.range(of: #"\s\S*$"#, options: .regularExpression).map { String(head[..<$0.lowerBound]) } ?? head
  return cut + "…"
}

/// A blip's mark: an SF Symbol drawn small.
private struct BlipSymbol: View {
  let name: String
  var body: some View { Image(systemName: name).font(.system(size: 10, weight: .semibold)) }
}

/// A chat's blips: an app's outcome, or a memory a turn learned here (Undo forgets it). Desktop's
/// ui/quiet-line.tsx.
struct QuietLine: View {
  let phone: Phone
  let line: Line
  let quiet: Quiet
  let here: String
  @State private var undoing = false
  @State private var failed = false

  var body: some View {
    switch quiet {
    case .event:
      Blip(mark: { BlipSymbol(name: "bolt") }, words: blipGist(line.text), time: line.time) {
        Text(line.text)
      } actions: {
        EmptyView()
      }
    case .learned(let memory, let restore):
      Blip(mark: { BlipSymbol(name: "bookmark") }, words: blipGist(line.text), time: line.time) {
        Text(line.text)
      } actions: {
        if failed { Warn(size: 12) }
        Button("Undo") {
          undoing = true
          failed = false
          Task {
            do { try await phone.forget(memory, restore: restore) } catch { failed = true }
            undoing = false
          }
        }
        .disabled(undoing)
      }
    }
  }
}

/// A long line, whole: the full text a clamped bubble opens, with its detail.
struct Reading: Identifiable {
  let id = UUID()
  let title: String
  let text: String
}

struct ReadingSheet: View {
  let reading: Reading
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        Markdown(reading.text)
          .foregroundStyle(SIS.ink)
          .textSelection(.enabled)
          .padding(SIS.inset)
      }
      .background(SIS.paper)
      .navigationTitle(reading.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button {
            UIPasteboard.general.string = reading.text
          } label: {
            Image(systemName: "doc.on.doc")
          }
          .accessibilityLabel("Copy")
        }
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
      }
    }
  }
}
