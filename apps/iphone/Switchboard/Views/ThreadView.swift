import SwiftUI

/// A piece of work opened: its transcript, live, and the box steers it while it runs. A run of
/// tool calls folds into one line of steps, opened with a tap.
struct ThreadView: View {
  let phone: Phone
  let id: String
  @State private var error: String?

  private var brain: Brain { phone.brain }

  var body: some View {
    let t = brain.threads[id]
    let space = t.map(brain.spaceOf) ?? HOME
    let ink = space == HOME ? SIS.own : brain.station(space).ink
    let running = t?.status == "running"
    VStack(spacing: 0) {
      Down(phone: phone)
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          if let t {
            if t.more || !t.loaded {
              Color.clear.frame(height: 1).onAppear { phone.olderItems(id) }
            }
            let results = resultsOf(t.items)
            ForEach(Block.of(t.items)) { b in
              switch b.kind {
              case .item(let item):
                if item.kind == .text {
                  Said(agent: true, ink: ink, text: item.text)
                } else if (item.kind == .user || item.kind == .steer) && !item.text.isEmpty {
                  Said(agent: false, ink: ink, text: item.text)
                }
              case .steps(let tools):
                StepsView(tools: tools, results: results, apps: brain.appNames)
              }
            }
            if !t.streaming.isEmpty { Said(agent: true, ink: ink, text: t.streaming) }
            if ["failed", "limited", "interrupted"].contains(t.status) {
              HStack(spacing: 8) {
                Stop(size: 12)
                Text(t.result)
                TurnKey(phone: phone, thread: t.id, running: false)
              }
              .font(SIS.text(13))
              .foregroundStyle(SIS.ink)
            }
            if running {
              HStack(spacing: 8) {
                Runner(size: 12)
                Text(Step.live(t, apps: brain.appNames))
                TurnKey(phone: phone, thread: t.id, running: true)
              }
              .font(SIS.text(13))
              .foregroundStyle(SIS.ink2)
            }
          }
          Color.clear.frame(height: 1).id("end")
        }
        .padding(.horizontal, SIS.inset)
        .padding(.vertical, 16)
      }
      .defaultScrollAnchor(.bottom)
      .scrollDismissesKeyboard(.interactively)
      if running {
        Box(placeholder: "Steer", place: "thread:\(id)", error: error) { words, _, _ in
          error = nil
          Task {
            do {
              try await phone.steer(id, words)
            } catch {
              self.error = error.localizedDescription
            }
          }
        }
      }
    }
    .background(SIS.paper)
    .navigationTitle(t?.title ?? "")
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(SIS.band, for: .navigationBar)
    .toolbarBackground(.visible, for: .navigationBar)
    .toolbarColorScheme(.dark, for: .navigationBar)
    .toolbar {
      ToolbarItem(placement: .principal) {
        HStack(spacing: 8) {
          let st = brain.station(space)
          Ring(code: st.code, ink: space == HOME ? SIS.bandInk : st.ink, size: 20, fill: SIS.band, type: SIS.bandInk, home: space == HOME)
          Text(t?.title ?? "").font(SIS.text(15, weight: .semibold)).foregroundStyle(SIS.bandInk).lineLimit(1)
          if running { Runner(size: 14) }
        }
      }
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          phone.finding = true
        } label: {
          Image(systemName: "magnifyingglass")
        }
        .accessibilityLabel("Find")
      }
    }
    .modifier(Seen(phone: phone, surface: "thread", item: id))
    .onAppear { phone.olderItems(id) }
  }
}

/// Consecutive tool calls as one block of steps; their results are found by id.
private struct Block: Identifiable {
  enum Kind {
    case item(Item)
    case steps([Item])
  }

  let id: Int
  var kind: Kind

  static func of(_ items: [Item]) -> [Block] {
    var out: [Block] = []
    for item in items {
      if item.kind == .tool || item.kind == .result {
        if case .steps(var tools)? = out.last?.kind {
          if item.kind == .tool { tools.append(item) }
          out[out.count - 1].kind = .steps(tools)
        } else {
          out.append(Block(id: item.seq, kind: .steps(item.kind == .tool ? [item] : [])))
        }
      } else {
        out.append(Block(id: item.seq, kind: .item(item)))
      }
    }
    return out
  }
}
