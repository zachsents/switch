import SwiftUI

/// What an item was before each change, newest first. One opens to its values, and Restore puts
/// it back (keeping what it is now in history in turn).
struct HistoryView: View {
  let model: Model
  let id: String
  @State private var versions: [Version] = []
  @State private var problem: String?
  @State private var loaded = false
  @State private var open: Version?

  var body: some View {
    VStack(spacing: 0) {
      Down(core: model.core)
      if let problem { Problem(text: problem) }
      ScrollView {
        LazyVStack(spacing: 0) {
          if loaded && versions.isEmpty { Empty("None") }
          ForEach(versions) { v in
            RowButton(action: { open = v }) {
              Text(v.item.title).lineLimit(1)
              Spacer(minLength: 8)
              Figure(Date(timeIntervalSince1970: v.at / 1000).formatted(date: .abbreviated, time: .shortened))
            }
          }
        }
      }
    }
    .background(SIS.paper)
    .band("History")
    .task(id: model.vault.cache.items[id]?.seq) { await load() }
    .sheet(item: $open) { v in
      VersionView(model: model, version: v) { open = nil }
        .presentationCornerRadius(SIS.radius)
    }
  }

  private func load() async {
    do {
      versions = try await model.vault.history(id)
      problem = nil
    } catch {
      problem = error.localizedDescription
    }
    loaded = true
  }
}

private struct VersionView: View {
  let model: Model
  let version: Version
  let done: () -> Void
  @State private var problem: String?

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        if let problem { Problem(text: problem) }
        ScrollView {
          VStack(spacing: 0) { ItemBody(model: model, item: version.item) }
        }
      }
      .background(SIS.paper)
      .band(Date(timeIntervalSince1970: version.at / 1000).formatted(date: .abbreviated, time: .shortened))
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button("Close") { done() } }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Restore") { Task { await restore() } }
        }
      }
    }
  }

  private func restore() async {
    var item = version.item
    item.trashed = 0
    do {
      try await model.vault.put(item)
      done()
    } catch {
      problem = error.localizedDescription
    }
  }
}
