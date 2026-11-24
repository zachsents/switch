import SwiftUI

/// System (apps/desktop/src/mainview/ui/system-page.tsx): what the agent runs on and how full each
/// subscription is, what it spends by day, its recent turns with model and effort, what each Mac
/// lets extensions do, and the brain's own counts.
struct SystemView: View {
  let phone: Phone
  @State private var system: JSON?
  @State private var error: String?

  private var brain: Brain { phone.brain }

  private func load() async {
    do {
      system = try await phone.page("system")
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }

  var body: some View {
    // The TimelineView inside the ScrollView, never round it under the navigation bar (SpaceView).
    ScrollView {
      TimelineView(.periodic(from: .now, by: 30)) { t in
        let now = t.date.timeIntervalSince1970 * 1000
        VStack(spacing: 0) {
          Down(phone: phone)
          if let error {
            line { Text(error).foregroundStyle(SIS.stopped) }
          }
          let accounts = brain.accounts.values.sorted { $0.host < $1.host }
          if !accounts.isEmpty {
            BoardSection(label: "Agent", count: accounts.count, first: true) {
              ForEach(accounts) { a in
                line {
                  Text(a.label).lineLimit(1)
                  if !a.up { Warn() }
                  Spacer(minLength: 8)
                  ForEach(a.windows, id: \.name) { w in Figure("\(w.name) \(Int((w.used * 100).rounded()))%") }
                  if a.limitedUntil > now { Figure(span(a.limitedUntil - now)) }
                  Figure(a.provider)
                }
              }
            }
          }
          if let s = system {
            let spend = s["spend"].array
            if !spend.isEmpty {
              BoardSection(label: "Spend", first: accounts.isEmpty) {
                ForEach(spend.indices, id: \.self) { i in
                  let d = spend[i]
                  line {
                    Text(d["day"].str).lineLimit(1)
                    Spacer(minLength: 8)
                    Figure("\(Int(d["turns"].number ?? 0))")
                    Figure(String(format: "$%.2f", d["cost"].number ?? 0))
                  }
                }
              }
            }
            let turns = s["turns"].array
            if !turns.isEmpty {
              BoardSection(label: "Turns") {
                ForEach(turns.indices, id: \.self) { i in
                  let r = turns[i]
                  line {
                    Text(r["title"].str.isEmpty ? r["thread"].str : r["title"].str).lineLimit(1)
                    if r["status"].str != "done" { Warn() }
                    Spacer(minLength: 8)
                    Figure([r["model"].str, r["effort"].str].filter { !$0.isEmpty }.joined(separator: " · "))
                    Figure(String(format: "$%.2f", r["cost"].number ?? 0))
                    Figure(clock(r["time"].number ?? 0))
                  }
                }
              }
            }
            let machines = s["permissions"].array
            if !machines.isEmpty {
              BoardSection(label: "Permissions") {
                ForEach(machines.indices, id: \.self) { i in
                  let m = machines[i]
                  ForEach(m["granted"].array.indices, id: \.self) { j in
                    let g = m["granted"].array[j]
                    line {
                      Text(g["name"].str).lineLimit(1)
                      if g["on"].bool != true { Warn() }
                      Spacer(minLength: 8)
                      Figure(m["machine"].str)
                    }
                  }
                }
              }
            }
            BoardSection(label: "Debug") {
              line {
                Text("Seq")
                Spacer(minLength: 8)
                Figure("\(Int(s["debug"]["seq"].number ?? 0))")
              }
            }
          }
        }
      }
    }
    .background(SIS.paper)
    .refreshable { await load() }
    .task { await load() }
    .navigationTitle("System")
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(SIS.band, for: .navigationBar)
    .toolbarBackground(.visible, for: .navigationBar)
    .toolbarColorScheme(.dark, for: .navigationBar)
    .modifier(Seen(phone: phone, surface: "system", item: ""))
  }

  private func line<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    HStack(spacing: 10) { content() }
      .font(SIS.text(15))
      .foregroundStyle(SIS.ink)
      .padding(.horizontal, SIS.inset)
      .frame(maxWidth: .infinity, minHeight: SIS.row, alignment: .leading)
      .overlay(alignment: .bottom) { Hairline() }
  }
}
