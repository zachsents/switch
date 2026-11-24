import SwiftUI

/// One item: its fields (concealed ones as dots until revealed), codes ticking, its URLs, notes,
/// tags and folder. Its menu edits it, shows its history, and trashes, restores or purges it.
struct ItemView: View {
  let model: Model
  let id: String
  @State private var problem: String?
  @State private var purging = false
  @Environment(\.dismiss) private var dismiss

  private var vault: Vault { model.vault }

  var body: some View {
    VStack(spacing: 0) {
      Down(core: model.core)
      if let problem { Problem(text: problem) }
      ScrollView {
        VStack(spacing: 0) {
          if let item = vault.item(id) { ItemBody(model: model, item: item) } else { Empty("Gone") }
        }
      }
    }
    .background(SIS.paper)
    .band(vault.item(id)?.kind.label ?? "")
    .toolbar {
      if let item = vault.item(id) {
        ToolbarItemGroup(placement: .topBarTrailing) {
          Button {
            Task { await favorite(item) }
          } label: {
            Image(systemName: item.favorite ? "star.fill" : "star")
          }
          .accessibilityLabel(item.favorite ? "Unfavorite" : "Favorite")
          Menu {
            if item.trashed == 0 {
              Button("Edit", systemImage: "pencil") { Task { await edit(item) } }
            }
            Button("History", systemImage: "clock.arrow.circlepath") { model.path.append(.history(item.id)) }
            if item.trashed == 0 {
              Button("Trash", systemImage: "trash", role: .destructive) { Task { await act { try await vault.trash(item, true) } } }
            } else {
              Button("Restore", systemImage: "arrow.uturn.backward") { Task { await act { try await vault.trash(item, false) } } }
              Button("Delete", systemImage: "trash", role: .destructive) { purging = true }
            }
          } label: {
            Image(systemName: "ellipsis")
          }
          .accessibilityLabel("Actions")
        }
      }
    }
    .confirmationDialog("Delete \(vault.item(id)?.title ?? "") and its history?", isPresented: $purging, titleVisibility: .visible) {
      Button("Delete", role: .destructive) {
        Task {
          await act { try await vault.purge(id) }
          dismiss()
        }
      }
    }
  }

  private func edit(_ item: Item) async {
    // Editing shows every value: Face ID first when it holds any concealed one.
    if item.fields.contains(where: { $0.type.concealed && !$0.value.isEmpty }) {
      guard await model.confirm("Edit") else { return }
    }
    model.editing = Draft(item: item, new: false)
  }

  private func favorite(_ item: Item) async {
    var item = item
    item.favorite.toggle()
    await act { try await vault.put(item) }
  }

  private func act(_ work: () async throws -> Void) async {
    do {
      try await work()
      problem = nil
    } catch {
      problem = error.localizedDescription
    }
  }
}

/// An item's parts, shared with a past version's page.
struct ItemBody: View {
  let model: Model
  let item: Item

  var body: some View {
    let fields = item.fields.filter { !$0.value.isEmpty }
    HStack(spacing: 10) {
      Text(item.title.isEmpty ? item.name : item.title).font(SIS.text(SIS.Size.title, weight: .bold)).foregroundStyle(SIS.ink).lineLimit(2)
      Spacer(minLength: 8)
    }
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, 14)
    if !fields.isEmpty {
      BoardSection(label: "Fields", count: nil) {
        Rule()
        ForEach(fields) { FieldRow(model: model, item: item, field: $0) }
      }
    }
    if !item.urls.isEmpty {
      BoardSection(label: "URLs", count: nil) {
        Rule()
        ForEach(item.urls, id: \.self) { UrlRow(url: $0.url) }
      }
    }
    if !item.notes.isEmpty {
      BoardSection(label: "Notes", count: nil) {
        Rule()
        // Notes are concealed, as the vault counts them.
        FieldRow(model: model, item: item, field: Field(id: "notes", label: "Notes", type: .concealed, value: item.notes))
      }
    }
    BoardSection(label: "Details", count: nil) {
      Rule()
      Cell(label: "Name", value: item.name, mono: true)
      if !item.folder.isEmpty { Cell(label: "Folder", value: item.folder) }
      if !item.tags.isEmpty { Cell(label: "Tags", value: item.tags.joined(separator: ", ")) }
      Cell(label: "Updated", value: Date(timeIntervalSince1970: item.updated / 1000).formatted(date: .abbreviated, time: .shortened))
    }
  }
}

/// A field: its label over its value. Concealed values are dots until revealed; revealing and
/// copying one asks for Face ID again. A one-time code ticks.
struct FieldRow: View {
  let model: Model
  let item: Item
  let field: Field
  @State private var shown = false

  var body: some View {
    HStack(alignment: .center, spacing: 8) {
      VStack(alignment: .leading, spacing: 3) {
        Text(field.label.uppercased()).font(SIS.text(SIS.Size.label, weight: .semibold)).tracking(0.6).foregroundStyle(SIS.ink3)
        value
      }
      Spacer(minLength: 8)
      if field.type.concealed && field.type != .totp {
        IconKey(symbol: shown ? "eye.slash" : "eye", label: shown ? "Hide" : "Reveal") { Task { await reveal() } }
      }
      IconKey(symbol: "doc.on.doc", label: "Copy") { Task { await copy() } }
    }
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, SIS.cellInset)
    .frame(maxWidth: .infinity, alignment: .leading)
    .overlay(alignment: .bottom) { Hairline() }
    .onDisappear { shown = false }
  }

  @ViewBuilder private var value: some View {
    if field.type == .totp {
      if let totp = TOTP(field.value) { CodeView(totp: totp) } else { Text("Unreadable").font(SIS.text(15)).foregroundStyle(SIS.ink3) }
    } else if field.type.concealed && !shown {
      Text(String(repeating: "•", count: 10)).font(SIS.data(15)).foregroundStyle(SIS.ink)
    } else if field.type == .url, let url = URL(string: field.value) {
      Link(field.value, destination: url).font(SIS.text(15)).foregroundStyle(SIS.ink).lineLimit(1)
    } else {
      Text(field.value).font(field.type.concealed ? SIS.data(15) : SIS.text(15)).foregroundStyle(SIS.ink).textSelection(.enabled)
    }
  }

  private func reveal() async {
    if shown { return shown = false }
    guard await model.confirm("Reveal \(field.label)") else { return }
    shown = true
    model.vault.used(item, field.id, "reveal")
  }

  private func copy() async {
    if field.type == .totp {
      guard let totp = TOTP(field.value) else { return }
      model.copy(totp.code())
    } else {
      if field.type.concealed { guard await model.confirm("Copy \(field.label)") else { return } }
      model.copy(field.value)
    }
    if field.type.concealed { model.vault.used(item, field.id, "copy") }
  }
}

private struct UrlRow: View {
  let url: String
  @Environment(\.openURL) private var openURL

  var body: some View {
    RowButton(action: {
      if let u = URL(string: url.contains("://") ? url : "https://\(url)") { openURL(u) }
    }) {
      Text(url).lineLimit(1)
      Spacer(minLength: 8)
      Image(systemName: "arrow.up.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(SIS.ink3)
    }
  }
}
