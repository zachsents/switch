import SwiftUI

/// The longest raw input or output shown; the rest is cut.
private let rawMax = 20_000

private func raw(_ j: JSON) -> String {
  if case .string(let s) = j { return s }
  let data = try? JSONSerialization.data(withJSONObject: j.any, options: [.prettyPrinted, .fragmentsAllowed, .sortedKeys])
  let text = data.map { String(decoding: $0, as: UTF8.self) } ?? j.text
  return text.count > rawMax ? String(text.prefix(rawMax)) + "\n…" : text
}

/// Each call's result, by the call's id.
func resultsOf(_ items: [Item]) -> [String: Item] {
  var out: [String: Item] = [:]
  for i in items where i.kind == .result { out[i.call] = i }
  return out
}

/// A step's wording: its words in the UI's face, what it acted on (a command, a path) as code.
func stepWords(_ parts: [Step.Part]) -> AttributedString {
  var out = AttributedString()
  for p in parts {
    var run = AttributedString(p.text)
    run.font = p.code ? SIS.data(11) : SIS.text(12)
    out += run
  }
  return out
}

/// A tool call on its line, as old Switchboard's iPhone app drew it: its icon (red when it failed)
/// and words; tapped, what it was given and what came back.
private struct ToolStep: View {
  let item: Item
  let result: Item?
  let apps: [String]
  @State private var open = false

  var body: some View {
    let details = [raw(item.input), result?.text ?? ""].filter { !$0.isEmpty }.joined(separator: "\n\n")
    VStack(alignment: .leading, spacing: 4) {
      Button {
        if !details.isEmpty { open.toggle() }
      } label: {
        HStack(spacing: 8) {
          Image(systemName: Step.icon(item.name, item.input)).font(SIS.text(10.5))
            .foregroundStyle(result?.error == true ? SIS.stopped : SIS.ink3).frame(width: 14)
          Text(stepWords(Step.describe(item.name, item.input, apps: apps, output: result?.text ?? ""))).foregroundStyle(SIS.ink2)
            .lineLimit(open ? nil : 1).truncationMode(.tail).multilineTextAlignment(.leading)
        }
        .frame(maxWidth: .infinity, minHeight: 22, alignment: .leading)
        .contentShape(.rect)
      }
      .buttonStyle(Lit())
      if open {
        // The Mac's code block: the data face, on paper, a hairline round it.
        ScrollView {
          Text(details.prefix(8000)).font(SIS.data()).foregroundStyle(SIS.ink).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 240)
        .padding(8)
        .background(SIS.paper, in: .rect(cornerRadius: SIS.controlRadius))
        .overlay(RoundedRectangle(cornerRadius: SIS.controlRadius).strokeBorder(SIS.hair, lineWidth: SIS.line))
        .padding(.leading, 22)
        .padding(.bottom, 4)
      }
    }
  }
}

/// A run of a thread's tool calls in its own page: shown, under how many there were, a line each
/// on a hairline down the left.
struct StepsView: View {
  let tools: [Item]
  let results: [String: Item]
  let apps: [String]
  @State private var open = true

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Button {
        open.toggle()
      } label: {
        HStack(spacing: 8) {
          Text("\(tools.count) step\(tools.count == 1 ? "" : "s")").font(SIS.text(SIS.Size.label)).foregroundStyle(SIS.ink3)
          Image(systemName: "chevron.right").font(SIS.text(9, weight: .bold)).foregroundStyle(SIS.ink3)
            .rotationEffect(.degrees(open ? 90 : 0))
        }
        .frame(minHeight: 28)
        .contentShape(.rect)
      }
      .buttonStyle(Lit())
      if open {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(tools) { ToolStep(item: $0, result: results[$0.call], apps: apps) }
        }
        .padding(.leading, 11)
        .overlay(alignment: .leading) { Rectangle().fill(SIS.hair).frame(width: SIS.hairWidth) }
        .padding(.leading, 2)
      }
    }
  }
}

/// Stop while it runs, Retry once it stopped.
struct TurnKey: View {
  let phone: Phone
  let thread: String
  let running: Bool
  @State private var failed = false
  @State private var busy = false

  var body: some View {
    HStack(spacing: 6) {
      if failed { Warn(size: 12) }
      Button(running ? "Stop" : "Retry") {
        busy = true
        failed = false
        Task {
          do {
            if running { try await phone.stop(thread) } else { try await phone.retry(thread) }
          } catch {
            failed = true
          }
          busy = false
        }
      }
      .buttonStyle(KeyStyle())
      .disabled(busy)
    }
  }
}
