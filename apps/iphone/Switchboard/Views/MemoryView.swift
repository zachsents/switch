import SwiftUI

/// One memory, as the memory page holds it.
struct Memory: Identifiable, Hashable {
  let id: String
  var description: String
  let type: String
  /// "global" or a space.
  let scope: String
  var body: String
  let uses: Int

  init(_ j: JSON) {
    id = j["id"].str
    description = j["description"].str
    type = j["type"].str
    scope = j["scope"].str
    body = j["body"].str
    uses = Int(j["uses"].number ?? 0)
  }

  /// Rules and preferences first, then what's known about work and where things are.
  var rank: Int { ["feedback": 0, "user": 1, "project": 2, "reference": 3][type] ?? 4 }
}

/// Memory (apps/desktop/src/mainview/ui/memory-page.tsx): what the agent remembers, everywhere first,
/// then each space in the tree, rules first. A tap opens one to edit or forget.
struct MemoryView: View {
  let phone: Phone
  @State private var memories: [Memory] = []
  @State private var loaded = false
  @State private var error: String?
  @State private var editing: Memory?

  private var brain: Brain { phone.brain }

  private func load() async {
    do {
      memories = try await phone.page("memories").array.map(Memory.init)
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
    loaded = true
  }

  var body: some View {
    let order = [HOME] + brain.warmest.map(\.id)
    let scopes = Set(memories.map(\.scope)).subtracting(["global"]).sorted {
      (order.firstIndex(of: $0) ?? order.count) < (order.firstIndex(of: $1) ?? order.count)
    }
    ScrollView {
      VStack(spacing: 0) {
        Down(phone: phone)
        if let error {
          Text(error).font(SIS.text(13)).foregroundStyle(SIS.stopped)
            .padding(.horizontal, SIS.inset).frame(maxWidth: .infinity, minHeight: SIS.row, alignment: .leading)
        }
        if loaded, memories.isEmpty, error == nil {
          Text("Nothing yet").font(SIS.text(15)).foregroundStyle(SIS.ink3)
            .padding(.horizontal, SIS.inset).frame(maxWidth: .infinity, minHeight: SIS.row, alignment: .leading)
        }
        let everywhere = memories.filter { $0.scope == "global" }
        if !everywhere.isEmpty {
          section(label: "Everywhere", mark: nil, list: everywhere, first: true)
        }
        ForEach(scopes, id: \.self) { scope in
          let st = brain.station(scope)
          section(
            label: brain.spaces[scope]?.name ?? scope,
            mark: AnyView(Ring(code: st.code, ink: st.ink, size: 14, home: scope == HOME)),
            list: memories.filter { $0.scope == scope }, first: everywhere.isEmpty && scope == scopes.first)
        }
      }
    }
    .background(SIS.paper)
    .refreshable { await load() }
    .task { await load() }
    .navigationTitle("Memory")
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(SIS.band, for: .navigationBar)
    .toolbarBackground(.visible, for: .navigationBar)
    .toolbarColorScheme(.dark, for: .navigationBar)
    .sheet(item: $editing) { m in
      MemoryEditor(phone: phone, memory: m) { await load() }
        .presentationDetents([.medium, .large])
        .presentationCornerRadius(SIS.radius)
    }
    .modifier(Seen(phone: phone, surface: "memory", item: ""))
  }

  private func section(label: String, mark: AnyView?, list: [Memory], first: Bool) -> some View {
    BoardSection(mark: mark, label: label, count: list.count, first: first) {
      ForEach(list.sorted { ($0.rank, $0.description) < ($1.rank, $1.description) }) { m in
        RowButton {
          editing = m
        } label: {
          Text(m.description.isEmpty ? m.id : m.description).lineLimit(1)
          Spacer(minLength: 8)
          if m.uses > 0 { Figure("\(m.uses)") }
        }
      }
    }
  }
}

/// A memory's words to edit, Save and Forget.
private struct MemoryEditor: View {
  let phone: Phone
  let memory: Memory
  let done: () async -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var line = ""
  @State private var words = ""
  @State private var error: String?
  @State private var busy = false

  private func run(_ work: @escaping () async throws -> Void) {
    busy = true
    Task {
      do {
        try await work()
        await done()
        dismiss()
      } catch {
        self.error = error.localizedDescription
      }
      busy = false
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      TextField("Line", text: $line)
        .font(SIS.text(15))
        .padding(.horizontal, SIS.inset)
        .frame(minHeight: SIS.row)
        .overlay(alignment: .bottom) { Hairline() }
      TextEditor(text: $words)
        .font(SIS.text(15))
        .scrollContentBackground(.hidden)
        .padding(.horizontal, SIS.inset - 4)
      if let error {
        Text(error).font(SIS.text(13)).foregroundStyle(SIS.stopped).padding(.horizontal, SIS.inset)
      }
      HStack(spacing: 10) {
        Button("Forget") {
          run { try await phone.forget(memory.id) }
        }
        .buttonStyle(KeyStyle())
        Spacer(minLength: 0)
        Button("Save") {
          run {
            try await phone.command(
              "memory.edit", ["id": .string(memory.id), "description": .string(line), "body": .string(words)])
          }
        }
        .buttonStyle(KeyStyle(go: true))
        .disabled(words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || line.trimmingCharacters(in: .whitespaces).isEmpty)
      }
      .disabled(busy)
      .padding(.horizontal, SIS.inset)
      .frame(minHeight: SIS.row)
      .overlay(alignment: .top) { Rule() }
    }
    .padding(.top, 12)
    .background(SIS.paper)
    .onAppear {
      line = memory.description
      words = memory.body
    }
  }
}
