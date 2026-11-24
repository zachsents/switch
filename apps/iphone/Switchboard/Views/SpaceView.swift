import SwiftUI

/// Every space, Home included, is one page under the system's navigation bar, its desktop columns
/// as the tab bar's three tabs: the rail (spaces, needs you, running), the chat with the message box
/// as its bottom cell, and the space's widgets. It opens on the chat. Spaces push onto the stack.
struct SpaceView: View {
  let phone: Phone
  let id: String
  @State private var tab = Tab.chat

  enum Tab { case rail, chat, widgets }

  private var brain: Brain { phone.brain }

  var body: some View {
    // No TimelineView round the TabView: wrapped in one under the navigation bar, a tab's layout
    // looped against the bar's insets and froze the app (a space's Widgets tab). Only the rail,
    // whose times run, ticks.
    TabView(selection: $tab) {
      SwiftUI.Tab("Spaces", systemImage: "sidebar.left", value: Tab.rail) {
        VStack(spacing: 0) {
          Down(phone: phone)
          ScrollViewReader { scroll in
            ScrollView {
              TimelineView(.periodic(from: .now, by: 30)) { t in
                let now = t.date.timeIntervalSince1970 * 1000
                BoardView(phone: phone, id: id, board: brain.board(id, now: now), now: now)
              }
            }
            .scrollBounceBehavior(.basedOnSize)
            .onAppear { if let lit = phone.lit { scroll.scrollTo(lit, anchor: .center) } }
            .onChange(of: phone.lit) { _, lit in if let lit { scroll.scrollTo(lit, anchor: .center) } }
          }
        }
        .background(SIS.paper)
      }
      SwiftUI.Tab("Chat", systemImage: "bubble.left.and.bubble.right", value: Tab.chat) {
        VStack(spacing: 0) {
          Down(phone: phone)
          ChatPane(phone: phone, id: id)
        }
        .background(SIS.paper)
      }
      SwiftUI.Tab("Widgets", systemImage: "square.grid.2x2", value: Tab.widgets) {
        VStack(spacing: 0) {
          Down(phone: phone)
          // Until the brain is read, nothing: desktop's column draws nothing until it has a widget
          // to show (ui/widget-column.tsx).
          ScrollView {
            let placed = brain.widgetsIn(id)
            if !placed.isEmpty {
              WidgetsView(phone: phone, placed: placed, first: true)
            } else if brain.ready {
              Text("Nothing").font(SIS.text(15)).foregroundStyle(SIS.ink3).padding(.top, 40)
            }
          }
          .scrollBounceBehavior(.basedOnSize)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(SIS.paper)
      }
    }
    // An ask or a line lit from elsewhere is on the rail.
    .onChange(of: phone.lit) { _, lit in if lit != nil { tab = .rail } }
    .onAppear { if phone.lit != nil { tab = .rail } }
    .navigationTitle(id == HOME ? "Home" : brain.spaces[id]?.name ?? "")
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(SIS.band, for: .navigationBar)
    .toolbarBackground(.visible, for: .navigationBar)
    .toolbarColorScheme(.dark, for: .navigationBar)
    .toolbar {
      ToolbarItem(placement: .principal) { Title(phone: phone, id: id, text: id == HOME ? "Home" : brain.spaces[id]?.name ?? "") }
      ToolbarItemGroup(placement: .topBarTrailing) {
        Button {
          phone.finding = true
        } label: {
          Image(systemName: "magnifyingglass")
        }
        .accessibilityLabel("Find")
        Actions(phone: phone, id: id)
      }
    }
    .modifier(Seen(phone: phone, surface: "space", item: id))
    // Scrolled to on arriving, not on later visits.
    .task(id: phone.lit) {
      guard phone.lit != nil else { return }
      try? await Task.sleep(for: .seconds(4))
      if !Task.isCancelled { phone.lit = nil }
    }
  }
}

/// The page's ring and name, in the sign face, on the black bar.
private struct Title: View {
  let phone: Phone
  let id: String
  let text: String

  var body: some View {
    let st = phone.brain.station(id)
    HStack(spacing: 8) {
      Ring(code: st.code, ink: id == HOME ? SIS.bandInk : st.ink, size: 24, fill: SIS.band, type: SIS.bandInk, home: id == HOME)
      Text(text.uppercased()).font(SIS.sign(22)).tracking(0.5).foregroundStyle(SIS.bandInk).lineLimit(1)
    }
  }
}

/// The space's actions, as a menu: a new space in it, its widgets, archiving it.
private struct Actions: View {
  let phone: Phone
  let id: String
  @State private var naming = false
  @State private var renaming = false
  @State private var unpairing = false
  @State private var name = ""

  var body: some View {
    let placed = phone.brain.widgetsIn(id)
    let offered = phone.widgets.offered.values.sorted { $0.title < $1.title }.filter { w in !placed.contains { $0.key == w.key } }
    Menu {
      Button("New space", systemImage: "plus.circle") { naming = true }
      Button("Memory", systemImage: "brain") { phone.open(.memory) }
      Button("System", systemImage: "gauge") { phone.open(.system) }
      Button("Find in Chat", systemImage: "text.magnifyingglass") { phone.findingIn = id }
      if !offered.isEmpty || !placed.isEmpty {
        Menu("Widgets", systemImage: "square.grid.2x2") {
          ForEach(offered, id: \.key) { w in
            Button("Put \(w.title) here") {
              Task { try? await phone.command("widget.place", ["app": .string(w.app), "name": .string(w.name), "space": .string(id)]) }
            }
          }
          ForEach(placed, id: \.key) { w in
            Button("Remove \(phone.widgets.offered[w.key]?.title ?? w.name)", role: .destructive) {
              Task { try? await phone.command("widget.remove", ["app": .string(w.app), "name": .string(w.name)]) }
            }
          }
        }
      }
      SpaceMenu(phone: phone, id: id, renaming: $renaming, open: true)
      if id == HOME {
        Button("Unpair", systemImage: "iphone.slash", role: .destructive) { unpairing = true }
      }
    } label: {
      Image(systemName: "ellipsis")
    }
    .accessibilityLabel("Actions")
    .alert("Rename", isPresented: $renaming) {
      RenameAlert(phone: phone, id: id)
    }
    .confirmationDialog("Unpair", isPresented: $unpairing) {
      Button("Unpair", role: .destructive) { phone.unpair() }
    }
    .alert("New space", isPresented: $naming) {
      TextField("Name", text: $name)
      Button("Cancel", role: .cancel) { name = "" }
      Button("Make") {
        let words = name.trimmingCharacters(in: .whitespaces)
        name = ""
        guard !words.isEmpty else { return }
        let slug = words.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
          .trimmingCharacters(in: CharacterSet(charactersIn: "-")) + "-" + UUID().uuidString.prefix(4).lowercased()
        Task {
          try? await phone.command("space.create", ["id": .string(slug), "name": .string(words), "parent": id == HOME ? .null : .string(id)])
          phone.open(.space(slug))
        }
      }
    }
  }
}

/// The core out of reach: a cell saying so, over the page.
struct Down: View {
  let phone: Phone

  var body: some View {
    if phone.brain.link == .down {
      HStack(spacing: 8) {
        Stop(size: 12)
        Text("Can't reach the core").font(SIS.text(13)).foregroundStyle(SIS.ink)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, SIS.inset)
      .frame(height: 36)
      .overlay(alignment: .bottom) { Rule() }
    }
  }
}

/// A space's board, top to bottom. A section shows only when it has something.
struct BoardView: View {
  let phone: Phone
  let id: String
  let board: Brain.Board
  let now: Double
  /// The space inside whose name is being edited, from its line's menu.
  @State private var renaming: String?

  private var brain: Brain { phone.brain }

  var body: some View {
    content
      .alert("Rename", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
        if let renaming { RenameAlert(phone: phone, id: renaming) }
      }
  }

  @ViewBuilder private var content: some View {
    let stations = brain.stations
    let runs = board.running.count + board.activities.count + board.expectations.count
    VStack(spacing: 0) {
      if !board.children.isEmpty {
        BoardSection(label: "Spaces", first: true) {
          let banners = brain.banners(id)
          ForEach(board.children) { c in
            let m = brain.marks(c.id, now: now)
            Group {
              if banners {
                SpaceBanner(space: c, station: stations[c.id], marks: m) { phone.open(.space(c.id)) }
              } else {
                RowButton {
                  phone.open(.space(c.id))
                } label: {
                  Ring(code: stations[c.id]?.code ?? "", ink: stations[c.id]?.ink ?? SIS.ink3)
                  Text(c.name).fontWeight(.medium).lineLimit(1)
                  if m.unread { Unread() }
                  Spacer(minLength: 8)
                  if m.running { Runner() }
                  if m.needs > 0 {
                    HStack(spacing: 4) {
                      Hand()
                      Text("\(m.needs)").font(SIS.text(12)).foregroundStyle(SIS.ink2)
                    }
                  }
                }
              }
            }
            .contextMenu {
              SpaceMenu(
                phone: phone, id: c.id,
                renaming: Binding(get: { renaming == c.id }, set: { renaming = $0 ? c.id : nil }), open: false)
            }
          }
        }
      }
      if runs > 0 {
        let moving = board.running.count + board.activities.count
        BoardSection(mark: moving == 0 ? nil : AnyView(Runner()), label: "Running", count: moving, first: board.children.isEmpty && board.actions.isEmpty) {
          ForEach(board.running) { w in
            RowButton {
              phone.open(.thread(w.thread.id))
            } label: {
              // Where the task stands, as it says, else its live step, under its name.
              TaskLines(
                title: w.thread.title.isEmpty ? brain.spaces[w.space]?.name ?? "" : w.thread.title,
                under: w.thread.stage.isEmpty ? w.step : w.thread.stage)
            }
            .contextMenu {
              Button("Stop", systemImage: "stop.circle", role: .destructive) {
                Task { try? await phone.stop(w.thread.id) }
              }
            }
          }
          ForEach(board.activities) { a in
            RowButton {
              phone.open(.space(a.space))
            } label: {
              Text(a.title).lineLimit(1)
              Spacer(minLength: 8)
              if !a.line.isEmpty {
                Text(a.line).font(SIS.text(13)).foregroundStyle(SIS.ink2).lineLimit(1).frame(maxWidth: 150, alignment: .trailing)
              }
              if a.state == "needs" { Hand() }
              if a.state == "failed" { Stop() }
              if let ends = a.endsAt, ends > now {
                Figure(span(ends - now))
              } else if let p = a.progress {
                Figure("\(Int((p * 100).rounded()))%")
              }
            }
            .overlay(alignment: .bottomLeading) {
              if let p = a.progress {
                GeometryReader { g in
                  Rectangle().fill(SIS.ink2).frame(width: g.size.width * min(1, max(0, p)), height: 2)
                    .frame(maxHeight: .infinity, alignment: .bottom)
                }
                .allowsHitTesting(false)
              }
            }
          }
          ForEach(board.expectations) { e in
            RowButton {
              phone.open(.space(e.space))
            } label: {
              Text(e.what).lineLimit(1)
              Spacer(minLength: 8)
              if e.lapsed { Warn() }
              if let by = e.by { Figure(clock(by)) }
            }
          }
        }
      }
      if !board.actions.isEmpty {
        BoardSection(mark: AnyView(Hand()), label: "Needs you", count: board.actions.count, first: board.children.isEmpty) {
          ForEach(board.actions) { a in
            RowButton {
              phone.asking = a.id
            } label: {
              Text(a.title).lineLimit(1)
              Spacer(minLength: 0)
            }
            .id(a.id)
          }
        }
      }
    }
  }
}

/// A task's row: its name, and under it a line of data (where it stands, what it waits for).
struct TaskLines: View {
  let title: String
  let under: String

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title).lineLimit(1)
      if !under.isEmpty { Text(under).font(SIS.text(13)).foregroundStyle(SIS.ink2).lineLimit(1) }
    }
    .padding(.vertical, 6)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

extension RowButton {
  init(action: @escaping () -> Void, @ViewBuilder label: () -> Content) {
    self.init(action: action, content: label)
  }
}
