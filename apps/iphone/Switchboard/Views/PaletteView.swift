import SwiftUI

/// One palette across needs you, running work, spaces and commands (desktop's ⌘K).
struct PaletteView: View {
  let phone: Phone
  @State private var query = ""
  /// The brain's find for the words, a moment after they stop changing.
  @State private var found: [Found] = []
  @State private var error: String?
  @FocusState private var focused: Bool

  fileprivate struct Choice: Identifiable {
    let id: String
    let label: String
    /// Matched too, but not shown: where it is.
    let also: String
    let icon: AnyView
    var go: (() -> Void)?
    var act: (() async throws -> Void)?
  }

  private var brain: Brain { phone.brain }

  private func groups() -> [(String, [Choice])] {
    let stations = brain.stations
    let ring = { (id: String) in
      AnyView(Ring(code: stations[id]?.code ?? "", ink: id == HOME ? SIS.ink3 : stations[id]?.ink ?? SIS.ink3, home: id == HOME))
    }
    let name = { (id: String) in brain.spaces[id]?.name ?? "" }
    let here = phone.here
    let needs = brain.actions.values.sorted { $0.at < $1.at }.map { a in
      Choice(id: "a:\(a.id)", label: a.title, also: name(a.space), icon: AnyView(Hand())) { phone.asking = a.id }
    }
    let running = brain.spaces.keys.flatMap { brain.work($0) }.sorted { $0.thread.since < $1.thread.since }.map { w in
      Choice(id: "t:\(w.thread.id)", label: w.thread.title, also: name(w.space), icon: AnyView(Runner())) { phone.open(.thread(w.thread.id)) }
    }
    let spaces = brain.warmest.map { x in
      Choice(id: "s:\(x.id)", label: x.name, also: brain.above(x.id).filter { $0.id != HOME }.map(\.name).joined(separator: " "), icon: ring(x.id)) {
        phone.open(.space(x.id))
      }
    }
    let words = query.trimmingCharacters(in: .whitespaces)
    var commands = [Choice(id: "c:home", label: "Home", also: "go", icon: ring(HOME)) { phone.open(.space(HOME)) }]
    if !words.isEmpty {
      let slug = words.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
        .trimmingCharacters(in: CharacterSet(charactersIn: "-")) + "-" + UUID().uuidString.prefix(4).lowercased()
      commands.append(
        Choice(id: "c:new", label: "New space “\(words)”", also: words, icon: AnyView(Circle().strokeBorder(SIS.ink3, style: StrokeStyle(lineWidth: 2, dash: [3])).frame(width: 18, height: 18)), go: nil) {
          try await phone.command("space.create", ["id": .string(slug), "name": .string(words), "parent": here == HOME ? .null : .string(here)])
          phone.open(.space(slug))
        })
    }
    if !words.isEmpty {
      for c in brain.closedActions {
        commands.append(
          Choice(id: "c:reopen:\(c.id)", label: "Reopen \(c.title)", also: name(c.space), icon: AnyView(Hand()), go: nil) {
            try await phone.reopen(c.id)
          })
      }
    }
    if here != HOME {
      commands.append(
        Choice(id: "c:archive", label: "Archive \(name(here))", also: "", icon: ring(here), go: nil) {
          try await phone.command("space.archive", ["id": .string(here)])
          phone.open(.space(brain.spaces[here]?.parent ?? HOME))
        })
    }
    let placed = brain.widgetsIn(here)
    for w in placed {
      commands.append(
        Choice(id: "c:w:remove:\(w.key)", label: "Remove \(phone.widgets.offered[w.key]?.title ?? w.key)", also: "widget", icon: AnyView(Rectangle().strokeBorder(SIS.ink3, lineWidth: 1.5).frame(width: 12, height: 12)), go: nil) {
          try await phone.command("widget.remove", ["app": .string(w.app), "name": .string(w.name)])
        })
    }
    for w in phone.widgets.offered.values.sorted(by: { $0.title < $1.title }) where !placed.contains(where: { $0.key == w.key }) {
      commands.append(
        Choice(id: "c:w:here:\(w.key)", label: "Put \(w.title) here", also: "widget", icon: AnyView(Rectangle().strokeBorder(SIS.ink3, lineWidth: 1.5).frame(width: 12, height: 12)), go: nil) {
          try await phone.command("widget.place", ["app": .string(w.app), "name": .string(w.name), "space": .string(here)])
        })
    }
    let match = { (c: Choice) in
      words.isEmpty || c.label.localizedCaseInsensitiveContains(words) || c.also.localizedCaseInsensitiveContains(words)
    }
    // Archived spaces only when looked for.
    let archived = words.isEmpty ? [] : brain.spaces.values.filter(\.archived).sorted { $0.name < $1.name }.map { x in
      Choice(id: "s:\(x.id)", label: x.name, also: "archived", icon: ring(x.id)) { phone.open(.space(x.id)) }
    }
    // What the brain found holds the words already, if not as typed. A line opens at its place.
    let hits = (words.isEmpty ? [] : found).filter { brain.spaces[$0.space] != nil }.map { h in
      Choice(id: "f:\(h.id)", label: h.line, also: name(h.space), icon: h.kind == "item" ? AnyView(Hand()) : ring(h.space)) {
        if h.kind == "memory" {
          phone.open(.memory)
        } else if let seq = h.seq {
          phone.open(h.space, at: seq)
        } else {
          phone.open(.space(h.space))
        }
      }
    }
    return [
      ("Needs you", needs.filter(match)), ("Running", running.filter(match)), ("Spaces", spaces.filter(match)),
      ("Archived", archived.filter(match)), ("Found", hits), ("Commands", commands.filter(match)),
    ]
    .filter { !$0.1.isEmpty }
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Image(systemName: "magnifyingglass").foregroundStyle(SIS.ink3)
        TextField("Find", text: $query)
          .font(SIS.text(17))
          .focused($focused)
          .submitLabel(.go)
          .onSubmit { if let first = groups().first?.1.first { choose(first) } }
      }
      .padding(.horizontal, SIS.inset)
      .frame(height: 54)
      Rule()
      if let error {
        HStack(spacing: 8) {
          Stop(size: 12)
          Text(error).font(SIS.text(12))
          Spacer(minLength: 0)
        }
        .padding(.horizontal, SIS.inset)
        .frame(height: 32)
        .overlay(alignment: .bottom) { Hairline() }
      }
      ScrollView {
        LazyVStack(spacing: 0) {
          ForEach(Array(groups().enumerated()), id: \.element.0) { i, group in
            BoardSection(label: group.0, first: i == 0) {
              ForEach(group.1) { c in
                RowButton {
                  choose(c)
                } label: {
                  c.icon
                  Text(c.label).lineLimit(1)
                  Spacer(minLength: 0)
                  if c.id.hasPrefix("f:") {
                    Text(c.also).font(SIS.text(13)).foregroundStyle(SIS.ink3).lineLimit(1)
                  }
                }
              }
            }
          }
        }
      }
      .scrollDismissesKeyboard(.immediately)
    }
    .background(SIS.paper)
    .onAppear { focused = true }
    .task(id: query) {
      let words = query.trimmingCharacters(in: .whitespaces)
      guard !words.isEmpty else { return }
      try? await Task.sleep(for: .milliseconds(150))
      guard !Task.isCancelled else { return }
      let hits = await phone.find(words)
      if !Task.isCancelled { found = hits }
    }
  }

  private func choose(_ c: Choice) {
    error = nil
    if let go = c.go {
      phone.finding = false
      go()
    }
    if let act = c.act {
      Task {
        do {
          try await act()
          phone.finding = false
        } catch {
          self.error = error.localizedDescription
        }
      }
    }
  }
}

extension PaletteView.Choice {
  init(id: String, label: String, also: String, icon: AnyView, go: @escaping () -> Void) {
    self.init(id: id, label: label, also: also, icon: icon, go: go, act: nil)
  }
}
