import SwiftUI

/// Making or changing an item: its title and name, its fields (its kind's, and any custom ones),
/// URLs, tags, folder and notes. Saving seals it whole and puts it.
struct EditView: View {
  let model: Model
  let original: Item
  let new: Bool
  @State private var item: Item
  @State private var tags: String
  @State private var problem: String?
  @State private var busy = false
  @State private var generating: String?
  @Environment(\.dismiss) private var dismiss

  init(model: Model, original: Item, new: Bool) {
    self.model = model
    self.original = original
    self.new = new
    _item = State(initialValue: original)
    _tags = State(initialValue: original.tags.joined(separator: ", "))
  }

  private var vault: Vault { model.vault }
  private var takesUrls: Bool { item.kind == .login || item.kind == .apiKey || !item.urls.isEmpty }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        if let problem { Problem(text: problem) }
        ScrollView {
          VStack(spacing: 0) { content }
        }
        .scrollDismissesKeyboard(.interactively)
      }
      .background(SIS.paper)
      .band(new ? "New \(item.kind.label)" : item.kind.label)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Save") { Task { await save() } }
            .disabled(busy || item.title.trimmingCharacters(in: .whitespaces).isEmpty)
        }
      }
      .sheet(item: Binding(get: { generating.map(Generating.init) }, set: { generating = $0?.id })) { g in
        GeneratorView(model: model) { value in
          if let at = item.fields.firstIndex(where: { $0.id == g.id }) { item.fields[at].value = value }
        }
        .presentationDetents([.medium, .large])
        .presentationCornerRadius(SIS.radius)
      }
    }
    .interactiveDismissDisabled(item != original)
  }

  @ViewBuilder private var content: some View {
    BoardSection(label: "Item", first: true) {
      Rule()
      VStack(spacing: SIS.gap) {
        TextField("Title", text: $item.title).inset()
        TextField(Names.slug(item.title.isEmpty ? "name" : item.title), text: $item.name)
          .font(SIS.data(15))
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .inset()
      }
      .padding(SIS.inset)
    }
    BoardSection(label: "Fields") {
      Rule()
      ForEach($item.fields) { $field in
        FieldEditor(field: $field, custom: !item.kind.template.contains { $0.id == field.id }) {
          generating = field.id
        } remove: {
          item.fields.removeAll { $0.id == field.id }
        }
      }
      HStack {
        Spacer()
        Button("Add field", systemImage: "plus") {
          item.fields.append(Field(id: "custom-\(UUID().uuidString.prefix(8).lowercased())", label: "", type: .text, value: ""))
        }
        .buttonStyle(KeyStyle())
      }
      .padding(SIS.inset)
    }
    if takesUrls {
      BoardSection(label: "URLs") {
        Rule()
        ForEach(item.urls.indices, id: \.self) { at in
          HStack(spacing: SIS.gap) {
            TextField("example.com", text: $item.urls[at].url)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .keyboardType(.URL)
              .inset()
            Menu {
              Picker("Match", selection: $item.urls[at].match) {
                Text("Domain").tag(ItemURL.Match?.none)
                Text("Host").tag(ItemURL.Match?.some(.host))
                Text("Exact").tag(ItemURL.Match?.some(.exact))
              }
            } label: {
              Text((item.urls[at].match ?? .domain).rawValue.capitalized).font(SIS.text(13, weight: .medium))
            }
            .buttonStyle(KeyStyle())
            IconKey(symbol: "minus", label: "Remove") { item.urls.remove(at: at) }
          }
          .padding(.horizontal, SIS.inset)
          .padding(.vertical, 6)
        }
        HStack {
          Spacer()
          Button("Add URL", systemImage: "plus") { item.urls.append(ItemURL(url: "", match: nil)) }
            .buttonStyle(KeyStyle())
        }
        .padding(SIS.inset)
      }
    }
    BoardSection(label: "Details") {
      Rule()
      VStack(spacing: SIS.gap) {
        TextField("Tags", text: $tags).textInputAutocapitalization(.never).autocorrectionDisabled().inset()
        TextField("Folder", text: $item.folder).textInputAutocapitalization(.never).inset()
        Toggle("Favorite", isOn: $item.favorite).font(SIS.text(15)).tint(SIS.Key.goTop)
      }
      .padding(SIS.inset)
    }
    BoardSection(label: "Notes") {
      Rule()
      TextEditor(text: $item.notes)
        .scrollContentBackground(.hidden)
        .frame(minHeight: 120)
        .inset(height: nil)
        .padding(SIS.inset)
    }
  }

  private func save() async {
    var out = item
    out.title = out.title.trimmingCharacters(in: .whitespaces)
    out.name = out.name.trimmingCharacters(in: .whitespaces).lowercased()
    let taken = Set(vault.items.filter { $0.id != out.id }.map(\.name))
    if out.name.isEmpty { out.name = Names.unique(out.title, among: taken) }
    guard Names.valid(out.name) else { return problem = "Names are a-z, 0-9 and . _ / @ -" }
    guard !taken.contains(out.name) else { return problem = "\(out.name) is taken" }
    out.tags = tags.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    out.folder = out.folder.split(separator: "/").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: "/")
    out.urls = out.urls.map { ItemURL(url: $0.url.trimmingCharacters(in: .whitespaces), match: $0.match) }.filter { !$0.url.isEmpty }
    for at in out.fields.indices {
      var f = out.fields[at]
      if f.label.trimmingCharacters(in: .whitespaces).isEmpty { f.label = f.type.label }
      if f.type != .privateKey && f.type != .concealed { f.value = f.value.trimmingCharacters(in: .whitespacesAndNewlines) }
      if f.type == .totp && !f.value.isEmpty {
        guard let link = TOTP.normalized(f.value) else { return problem = "That isn't an authenticator key" }
        f.value = link
      }
      if f.type == .cardNumber { f.value = f.value.filter(\.isNumber) }
      out.fields[at] = f
    }
    busy = true
    defer { busy = false }
    do {
      try await vault.put(out)
      if new { model.path.append(.item(out.id)) }
      dismiss()
    } catch {
      problem = error.localizedDescription
    }
  }
}

private struct Generating: Identifiable {
  let id: String
}

/// One field's label, type (custom fields) and value; a password's generator.
private struct FieldEditor: View {
  @Binding var field: Field
  let custom: Bool
  let generate: () -> Void
  let remove: () -> Void
  @State private var shown = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if custom {
        HStack(spacing: SIS.gap) {
          TextField("Label", text: $field.label).font(SIS.text(13, weight: .semibold)).inset(height: SIS.key)
          Menu {
            Picker("Type", selection: $field.type) {
              ForEach(FieldType.allCases) { Text($0.label).tag($0) }
            }
          } label: {
            Text(field.type.label).font(SIS.text(13, weight: .medium))
          }
          .buttonStyle(KeyStyle())
          IconKey(symbol: "minus", label: "Remove", action: remove)
        }
      } else {
        Text(field.label.uppercased()).font(SIS.text(SIS.Size.label, weight: .semibold)).tracking(0.6).foregroundStyle(SIS.ink3)
      }
      HStack(spacing: SIS.gap) {
        input
        if field.type.concealed && field.type != .totp {
          IconKey(symbol: shown ? "eye.slash" : "eye", label: shown ? "Hide" : "Show") { shown.toggle() }
        }
        if field.type == .password {
          IconKey(symbol: "wand.and.stars", label: "Generate", action: generate)
        }
      }
    }
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, 8)
    .overlay(alignment: .bottom) { Hairline() }
  }

  @ViewBuilder private var input: some View {
    if field.type == .privateKey || field.type == .concealed && field.value.contains("\n") {
      Group {
        if shown {
          TextEditor(text: $field.value).font(SIS.data(13)).scrollContentBackground(.hidden).frame(minHeight: 90)
        } else {
          Text(field.value.isEmpty ? "" : String(repeating: "•", count: 10)).font(SIS.data(15)).frame(maxWidth: .infinity, minHeight: 90, alignment: .topLeading)
        }
      }
      .inset(height: nil)
    } else if field.type.concealed && field.type != .totp && !shown {
      SecureField(field.label, text: $field.value).font(SIS.data(15)).inset()
    } else {
      TextField(field.type == .totp ? "Key" : field.label, text: $field.value)
        .font(field.type.concealed ? SIS.data(15) : SIS.text(16))
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .keyboardType(keyboard)
        .inset()
    }
  }

  private var keyboard: UIKeyboardType {
    switch field.type {
    case .email: .emailAddress
    case .url: .URL
    case .phone: .phonePad
    case .cardNumber, .cvc, .pin, .month, .year: .numberPad
    default: .default
    }
  }
}
