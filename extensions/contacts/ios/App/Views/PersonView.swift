import SwiftUI

/// One person (`get`): their name and single fields in a grid they're edited in (`set`), their
/// labels, how to reach them, then every field with where it came from and how sure that is. Its
/// menu merges someone else into them (`merge`); the last change's
/// Undo stays at the bottom until the next one.
struct PersonView: View {
  let model: Model
  let id: String
  @State private var person: JSON = .null
  @State private var problem: String?
  @State private var merging = false
  @State private var naming = false
  @State private var newLabel = ""
  @FocusState private var labelling: Bool

  private var name: String { Pretty.name(person["name"].str) }
  private var fields: [JSON] { person["fields"].array }

  /// The best held value of a kind, as the extension ranks them.
  private func best(_ kind: String) -> String {
    fields.filter { $0["kind"].str == kind && $0["suggested"].bool != true }.max { Pretty.rank($0) < Pretty.rank($1) }?["value"].str ?? ""
  }

  /// person, company or system; nil when unset. From `type`, else (an older extension) the fields.
  private var type: String? {
    if let t = person["type"].string { return t }
    let t = best("type")
    return t.isEmpty ? nil : t
  }

  /// Their labels: `labels`, else (an older extension) their group fields.
  private var labels: [String] {
    if case .array(let a) = person["labels"] { return a.map(\.str).filter { !$0.isEmpty } }
    var seen = Set<String>()
    return fields.filter { $0["kind"].str == "group" && $0["suggested"].bool != true }.map { $0["value"].str }
      .filter { seen.insert($0.lowercased()).inserted }
  }

  var body: some View {
    VStack(spacing: 0) {
      Down(core: model.core)
      if let problem { Problem(text: problem) }
      ScrollView {
        VStack(spacing: 0) {
          if !person.isNull { content }
        }
      }
      .scrollDismissesKeyboard(.interactively)
      if let done = model.done { DoneBar(model: model, done: done) }
    }
    .background(SIS.paper)
    .band(name)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          Button("Merge…", systemImage: "arrow.triangle.merge") { merging = true }
        } label: {
          Image(systemName: "ellipsis")
        }
        .accessibilityLabel("Actions")
      }
    }
    .sheet(isPresented: $merging) {
      MergeSheet(model: model, into: id, intoName: name)
        .presentationDetents([.large])
        .presentationCornerRadius(SIS.radius)
    }
    .task(id: model.changes) { await load() }
    .seen(model.core, "person", id)
  }

  @ViewBuilder private var content: some View {
    let held = fields.filter { $0["suggested"].bool != true && $0["kind"].str != "ref" }
    let family = best("family")
    let initial = best("initial")
    let showsInitial = family.isEmpty && !initial.isEmpty
    HStack(spacing: 10) {
      TitleField(value: name) { v in
        guard !v.isEmpty else { return }
        set(["name": .string(v)], "Name set")
      }
      if lookingUp { Runner(size: SIS.markLarge) }
    }
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, 14)
    labelsCell
    Rule()
    CellRow {
      EditCell(label: "Given", value: best("given")) { v in set(["given": JSON(v.nilIfEmpty)], "Given") }
      EditCell(label: showsInitial ? "Initial" : "Family", value: showsInitial ? initial : family) { v in
        let letter = v.hasSuffix(".") ? String(v.dropLast()) : v
        if letter.count == 1, letter.first?.isLetter == true {
          set(["initial": .string(letter.uppercased())], "Initial")
        } else {
          let kind = showsInitial && v.isEmpty ? "initial" : "family"
          set([kind: JSON(v.nilIfEmpty)], showsInitial ? "Initial" : "Family")
        }
      }
    }
    CellRow {
      EditCell(label: "Nickname", value: best("nickname")) { v in set(["nickname": JSON(v.nilIfEmpty)], "Nickname") }
      TypeCell(value: type) { t in set(["type": JSON(t)], "Type") }
    }
    CellRow {
      EditCell(label: "Company", value: best("company")) { v in set(["company": JSON(v.nilIfEmpty)], "Company") }
      EditCell(label: "Role", value: best("role")) { v in set(["role": JSON(v.nilIfEmpty)], "Role") }
    }
    CellRow {
      EditCell(label: "Relationship", value: best("relationship"), capitalize: false) { v in
        set(["relationship": JSON(v.nilIfEmpty)], "Relationship")
      }
      EditCell(label: "Location", value: best("location")) { v in set(["location": JSON(v.nilIfEmpty)], "Location") }
    }
    CellRow {
      EditCell(label: "Note", value: best("note"), lines: true, capitalize: false) { v in set(["note": JSON(v.nilIfEmpty)], "Note") }
    }
    let reach = reachable
    if !reach.isEmpty {
      BoardSection(label: "Facts", count: nil) {
        Rule()
        ForEach(reach, id: \.self) { FactRow(field: $0) }
      }
    }
    BoardSection(label: "Sources", count: held.count) {
      Rule()
      ForEach(held, id: \.self) { SourceRow(field: $0) }
    }
  }

  /// Their labels as chips, and a key to add one: a label anyone has, or a new one.
  private var labelsCell: some View {
    let mine = labels
    let others = model.labels.filter { l in !mine.contains { $0.caseInsensitiveCompare(l) == .orderedSame } }
    return Flow(spacing: 6) {
      ForEach(mine, id: \.self) { l in
        Chip(text: l) { set(["labels": ["remove": [.string(l)]]], "Label removed") }
      }
      if naming {
        TextField("Label", text: $newLabel)
          .font(SIS.text(13))
          .foregroundStyle(SIS.ink)
          .textInputAutocapitalization(.words)
          .autocorrectionDisabled()
          .submitLabel(.done)
          .focused($labelling)
          .onSubmit(addTyped)
          .onChange(of: labelling) { _, now in if !now { addTyped() } }
          .padding(.horizontal, 9)
          .frame(width: 140, height: SIS.keySmall)
          .overlay(RoundedRectangle(cornerRadius: SIS.boxRadius).stroke(SIS.Field.focused, lineWidth: 1))
      } else {
        Menu {
          ForEach(others, id: \.self) { l in Button(l) { add(l) } }
          if !others.isEmpty { Divider() }
          Button("New", systemImage: "plus") {
            naming = true
            labelling = true
          }
        } label: {
          Label("Label", systemImage: "plus").font(SIS.text(13, weight: .medium)).foregroundStyle(SIS.ink2)
            .padding(.horizontal, 9)
            .frame(height: SIS.keySmall)
            .overlay(RoundedRectangle(cornerRadius: SIS.boxRadius).stroke(SIS.hair, style: StrokeStyle(lineWidth: 1, dash: [3, 2])))
        }
        .accessibilityLabel("Add label")
      }
    }
    .padding(.horizontal, SIS.inset)
    .padding(.bottom, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// What's left once the grid's shown: phones, emails, handles, links, birthday, relations, spaces, last contact; each once, best first.
  private var reachable: [JSON] {
    let order = ["phone", "email", "handle", "url", "birthday", "relation", "space", "last_contact"]
    var seen = Set<String>()
    var out: [JSON] = []
    for kind in order {
      let ranked = fields.filter { $0["kind"].str == kind && $0["suggested"].bool != true && !($0["kind"].str == "handle" && $0["service"].str == "imessage") }
        .sorted { Pretty.rank($0) > Pretty.rank($1) }
      for f in ranked {
        let key = "\(Pretty.label(f)):\(Pretty.pretty(f))"
        if seen.insert(key).inserted { out.append(f) }
        if kind == "birthday" || kind == "last_contact" { break }
      }
    }
    return out
  }

  private func addTyped() {
    let l = newLabel.trimmingCharacters(in: .whitespaces)
    newLabel = ""
    naming = false
    if !l.isEmpty { add(l) }
  }

  private func add(_ label: String) {
    model.know(label)
    set(["labels": ["add": [.string(label)]]], "Label added")
  }

  /// Sets these fields (`set`), its Undo at the bottom.
  private func set(_ changes: [String: JSON], _ what: String) {
    var args = changes
    args["person"] = .string(id)
    let cleared = changes.count == 1 && changes.values.first?.isNull == true
    let text = cleared ? "\(what) cleared" : what.contains(" ") ? what : "\(what) set"
    Task {
      do {
        let r = try await model.core.call("set", .object(args))
        model.done = Model.Done(text: text, batch: r["batch"].str)
        problem = nil
        await load()
      } catch {
        problem = error.localizedDescription
      }
    }
  }

  private func load() async {
    do {
      person = try await model.core.call("get", ["person": .string(id)])
      problem = nil
    } catch {
      problem = error.localizedDescription
    }
  }
}

/// The name, large, changed in place.
private struct TitleField: View {
  let value: String
  let commit: (String) -> Void
  @State private var draft = ""
  @FocusState private var focused: Bool

  var body: some View {
    TextField("Name", text: $draft, axis: .vertical)
      .font(SIS.text(SIS.Size.title, weight: .bold))
      .foregroundStyle(SIS.ink)
      .lineLimit(1...2)
      .textInputAutocapitalization(.words)
      .autocorrectionDisabled()
      .submitLabel(.done)
      .focused($focused)
      .onAppear { draft = value }
      .onChange(of: value) { _, now in if !focused { draft = now } }
      .onChange(of: draft) { _, now in
        // Return ends it: a vertical field takes the newline, so it's caught here.
        if now.contains("\n") {
          draft = now.replacingOccurrences(of: "\n", with: "")
          focused = false
        }
      }
      .onChange(of: focused) { _, now in if !now { save() } }
  }

  private func save() {
    let v = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    if v.isEmpty { draft = value } else if v != value { commit(v) }
  }
}

/// A way to reach them, or a fact about them: tapped, a profile, link, call or mail opens.
private struct FactRow: View {
  let field: JSON
  @Environment(\.openURL) private var openURL

  var body: some View {
    let label = field["kind"].str == "relation" && !field["label"].str.isEmpty ? field["label"].str.capitalized : Pretty.label(field)
    let value = Pretty.pretty(field)
    if let url = Pretty.link(field) {
      RowButton(action: { openURL(url) }) {
        VStack(alignment: .leading, spacing: 3) {
          CellLabel(label)
          Text(field["kind"].str == "handle" && !value.hasPrefix("@") && field["service"].str != "linkedin" ? "@\(value)" : value)
            .font(SIS.text(15)).foregroundStyle(SIS.ink).lineLimit(1)
        }
        .padding(.vertical, SIS.cellInset)
        Spacer(minLength: 8)
        Image(systemName: field["kind"].str == "phone" ? "phone" : field["kind"].str == "email" ? "envelope" : "arrow.up.right")
          .font(.system(size: 12, weight: .semibold)).foregroundStyle(SIS.ink3)
      }
      .contextMenu {
        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = field["value"].str }
      }
    } else {
      Field(label: label, value: value)
    }
  }
}

/// A field: its value and kind, and where it came from and how sure, at the end.
private struct SourceRow: View {
  let field: JSON

  var body: some View {
    let kind = field["label"].string.map { $0.replacingOccurrences(of: "_", with: " ").capitalized } ?? Pretty.label(field)
    let sure = Int(((field["confidence"].number ?? 0) * 100).rounded())
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      VStack(alignment: .leading, spacing: 2) {
        Text(Pretty.pretty(field)).font(SIS.text(15)).foregroundStyle(SIS.ink).lineLimit(2).textSelection(.enabled)
        Text(kind).font(SIS.text(SIS.Size.label, weight: .semibold)).foregroundStyle(SIS.ink3)
      }
      Spacer(minLength: 8)
      VStack(alignment: .trailing, spacing: 2) {
        Text(field["user"].bool == true ? "You" : field["source"].str.capitalized).font(SIS.data()).foregroundStyle(SIS.ink2)
        Text("\(sure)%").font(SIS.data()).foregroundStyle(SIS.ink3)
      }
    }
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, 10)
    .overlay(alignment: .bottom) { Hairline() }
  }
}

/// What was just done, and its Undo.
struct DoneBar: View {
  let model: Model
  let done: Model.Done
  @State private var problem: String?

  var body: some View {
    VStack(spacing: 0) {
      Rectangle().fill(SIS.heavy).frame(height: SIS.heavyWidth)
      HStack(spacing: 10) {
        Text(problem ?? done.text).font(SIS.text(14)).foregroundStyle(SIS.ink).lineLimit(1)
        Spacer(minLength: 8)
        if !done.batch.isEmpty {
          Button("Undo") {
            Task {
              do { try await model.undo(done.batch) } catch { problem = error.localizedDescription }
            }
          }
          .buttonStyle(KeyStyle())
        }
        Button {
          model.done = nil
        } label: {
          Image(systemName: "xmark").font(.system(size: 12, weight: .semibold))
        }
        .buttonStyle(KeyStyle())
        .accessibilityLabel("Close")
      }
      .padding(.horizontal, SIS.inset)
      .padding(.vertical, 10)
    }
    .background(SIS.wash)
  }
}

/// Someone to fold into this person: a search, then a confirmation.
private struct MergeSheet: View {
  let model: Model
  let into: String
  let intoName: String
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""
  @State private var hits: [Hit] = []
  @State private var picked: Hit?
  @State private var problem: String?
  @FocusState private var typing: Bool

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        SearchField(text: $query, focus: $typing, placeholder: "Who")
        if let problem { Problem(text: problem) }
        ScrollView {
          LazyVStack(spacing: 0) {
            ForEach(hits.filter { $0.id != into }) { hit in
              HitRow(hit: hit, model: model) { picked = hit }
            }
          }
        }
      }
      .background(SIS.paper)
      .band("Merge into \(intoName)")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } }
      }
    }
    .onAppear { typing = true }
    .task(id: query) {
      let q = query.trimmingCharacters(in: .whitespaces)
      guard !q.isEmpty else { return hits = [] }
      try? await Task.sleep(for: .milliseconds(120))
      guard !Task.isCancelled else { return }
      hits = (try? await model.core.call("search", ["query": .string(q), "limit": 30]))?["people"].array.map(Hit.init) ?? []
    }
    .confirmationDialog(
      "Merge \(picked?.name ?? "") into \(intoName)?", isPresented: Binding(get: { picked != nil }, set: { if !$0 { picked = nil } }),
      titleVisibility: .visible
    ) {
      Button("Merge") { Task { await merge() } }
      Button("Cancel", role: .cancel) { picked = nil }
    }
    .seen(model.core, "merge", into)
  }

  private func merge() async {
    guard let picked else { return }
    do {
      let r = try await model.core.call("merge", ["into": .string(into), "from": [.string(picked.id)]])
      model.done = Model.Done(text: "Merged \(picked.name)", batch: r["batch"].str)
      dismiss()
    } catch {
      problem = error.localizedDescription
    }
  }
}

extension String {
  /// nil for "", so a cleared cell clears its field.
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
