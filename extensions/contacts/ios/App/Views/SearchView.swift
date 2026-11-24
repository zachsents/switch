import SwiftUI

/// The root: a search over everyone (`search`), narrowed by a label and a type.
struct SearchView: View {
  let model: Model
  @State private var query = ""
  @State private var hits: [Hit] = []
  @State private var problem: String?
  @State private var label: String?
  /// person, company, system, or none for unset.
  @State private var type: String?
  @FocusState private var typing: Bool

  private var asking: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty || label != nil || type != nil }

  var body: some View {
    VStack(spacing: 0) {
      Down(core: model.core)
      SearchField(text: $query, focus: $typing)
      Filters(labels: model.labels, label: $label, type: $type)
      if let problem { Problem(text: problem) }
      ScrollView {
        LazyVStack(spacing: 0) {
          if asking {
            if hits.isEmpty {
              Empty("No one")
            } else {
              ForEach(hits) { HitRow(hit: $0, model: model) }
            }
          }
        }
      }
      .scrollDismissesKeyboard(.immediately)
    }
    .background(SIS.paper)
    .band("Contacts")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          model.path.append(.history)
        } label: {
          Image(systemName: "clock.arrow.circlepath")
        }
        .accessibilityLabel("History")
      }
    }
    .task(id: "\(query)|\(label ?? "")|\(type ?? "")|\(model.changes)") { await search() }
    .task { await model.loadLabels() }
    .seen(model.core, "search")
  }

  private func search() async {
    let q = query.trimmingCharacters(in: .whitespaces)
    guard asking else {
      hits = []
      return
    }
    try? await Task.sleep(for: .milliseconds(120))
    guard !Task.isCancelled else { return }
    var args: [String: JSON] = ["query": .string(q), "limit": q.isEmpty ? 300 : 40]
    if let label { args["label"] = .string(label) }
    if let type { args["type"] = .string(type) }
    do {
      let r = try await model.core.call("search", .object(args))
      guard !Task.isCancelled else { return }
      hits = r["people"].array.map(Hit.init)
      problem = nil
    } catch {
      if !Task.isCancelled { problem = error.localizedDescription }
    }
  }

}

/// The search's two narrowings, side by side: a type and a label.
private struct Filters: View {
  let labels: [String]
  @Binding var label: String?
  @Binding var type: String?

  var body: some View {
    HStack(spacing: 0) {
      Menu {
        Picker("Type", selection: $type) {
          Text("Any").tag(String?.none)
          ForEach(PersonType.all, id: \.self) { Text(PersonType.name($0)).tag(String?.some($0)) }
          Text("None").tag(String?.some("none"))
        }
      } label: {
        FilterCell(name: "Type", value: type.map { $0 == "none" ? "None" : PersonType.name($0) })
      }
      Rectangle().fill(SIS.hair).frame(width: SIS.hairWidth)
      Menu {
        Picker("Label", selection: $label) {
          Text("Any").tag(String?.none)
          ForEach(labels, id: \.self) { Text($0).tag(String?.some($0)) }
        }
      } label: {
        FilterCell(name: "Label", value: label)
      }
      .disabled(labels.isEmpty && label == nil)
    }
    .frame(height: SIS.row)
    .overlay(alignment: .bottom) { Rule() }
  }
}

/// A narrowing: its name until one's picked, then what's picked.
private struct FilterCell: View {
  let name: String
  let value: String?

  var body: some View {
    HStack(spacing: 6) {
      Text(value ?? name).font(SIS.text(14, weight: value == nil ? .regular : .semibold))
        .foregroundStyle(value == nil ? SIS.ink3 : SIS.ink).lineLimit(1)
      Spacer(minLength: 4)
      Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(SIS.ink3)
    }
    .padding(.horizontal, SIS.inset)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .contentShape(Rectangle())
    .accessibilityLabel(value.map { "\(name), \($0)" } ?? name)
  }
}

/// The box a person types in: inset, its shade inside its top edge.
struct SearchField: View {
  @Binding var text: String
  var focus: FocusState<Bool>.Binding
  var placeholder = "Search"

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass").font(.system(size: 14, weight: .medium)).foregroundStyle(SIS.ink3)
      TextField(placeholder, text: $text)
        .font(SIS.text(16))
        .foregroundStyle(SIS.ink)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .submitLabel(.search)
        .focused(focus)
      if !text.isEmpty {
        Button {
          text = ""
        } label: {
          Image(systemName: "xmark.circle.fill").foregroundStyle(SIS.ink3)
        }
        .accessibilityLabel("Clear")
      }
    }
    .padding(.horizontal, 12)
    .frame(height: SIS.fieldHeight)
    .background(RoundedRectangle(cornerRadius: SIS.fieldRadius).fill(SIS.Field.fill))
    .overlay(RoundedRectangle(cornerRadius: SIS.fieldRadius).stroke(SIS.Field.border, lineWidth: 1))
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, 10)
    .overlay(alignment: .bottom) { Rule() }
  }
}

/// A person in a list: their name, and their phone, email or company at the end.
struct HitRow: View {
  let hit: Hit
  let model: Model
  var action: (() -> Void)?

  var body: some View {
    RowButton(action: { if let action { action() } else { model.path.append(.person(hit.id)) } }) {
      Text(hit.name.isEmpty ? hit.detail : hit.name).lineLimit(1)
      Spacer(minLength: 8)
      if !hit.name.isEmpty { Figure(hit.detail) }
    }
  }
}
