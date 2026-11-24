import SwiftUI

/// An action item in full, as a sheet: its title, what's prepared, its files, then by kind an
/// approval's drafts with Approve, Always allow and Decline; a question's options and a typed
/// answer; a task's Done; or a sealed field. Dismiss and a reply on it for every kind but sealed.
/// What the user does is held a few seconds with Undo before it goes (desktop's ask-card.tsx). Opened
/// on an open ask, it goes once the ask closes; on a closed one, it shows it read-only, as decided.
struct AskSheet: View {
  struct Asking: Identifiable { let id: String }

  let phone: Phone
  let id: String
  /// Opened on an open ask.
  @State private var wasOpen: Bool?

  private var item: ActionItem? { phone.brain.actions[id] }
  private var closed: ActionItem? { phone.brain.closedActions.first { $0.id == id } }

  var body: some View {
    Group {
      if let item {
        AskCard(phone: phone, item: item) { phone.asking = nil }
      } else if wasOpen != true, let closed {
        DecidedCard(phone: phone, item: closed)
      } else {
        Color.clear.onAppear { phone.asking = nil }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(SIS.paper)
    .onAppear { wasOpen = item != nil }
  }
}

/// A closed ask's card, read-only (desktop's ask-decided.tsx): how it ended as a mark by its title,
/// what it said, its files, then each draft as it went (his edit included), and the option picked or
/// the words typed.
struct DecidedCard: View {
  let phone: Phone
  let item: ActionItem

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          AskEnding(item: item)
          Text(item.title).font(SIS.text(17, weight: .semibold)).foregroundStyle(SIS.ink)
        }
        .padding(.horizontal, SIS.inset).padding(.top, 20).padding(.bottom, 10)
        if !item.body.isEmpty {
          Text(item.body).font(SIS.text(15)).foregroundStyle(SIS.ink2).textSelection(.enabled)
            .padding(.horizontal, SIS.inset).padding(.bottom, 12)
        }
        AskFiles(phone: phone, files: item.files.filter { $0.option == nil })
        let words = item.answer?.choice ?? item.answer?.text
        if !item.drafts.isEmpty || words != nil {
          Hairline()
          VStack(alignment: .leading, spacing: 12) {
            ForEach(item.drafts, id: \.name) { d in
              VStack(alignment: .leading, spacing: 4) {
                Text(d.label).font(SIS.text(12, weight: .medium)).foregroundStyle(SIS.ink2)
                Text(item.went(d)).font(SIS.text(16)).foregroundStyle(SIS.ink).textSelection(.enabled)
                  .frame(maxWidth: .infinity, alignment: .leading)
                  .padding(8)
                  .overlay(RoundedRectangle(cornerRadius: SIS.controlRadius).stroke(SIS.Field.border, lineWidth: 1))
              }
            }
            if let words {
              Text(words).font(SIS.text(16)).foregroundStyle(SIS.ink).textSelection(.enabled)
            }
          }
          .padding(.horizontal, SIS.inset).padding(.vertical, 14)
        }
      }
    }
  }
}

/// The card itself, shared by the sheet and anywhere an item shows whole.
struct AskCard: View {
  let phone: Phone
  let item: ActionItem
  let onGone: () -> Void

  /// How long what's done is held for Undo, in the Outbox (ms).
  private static let holdFor = 5000.0
  /// How long typing rests before a draft's edit is sent; it's kept in the Outbox at each keystroke (ms).
  private static let saveAfter = 800.0

  @Environment(\.scenePhase) private var phase

  @State private var drafts: [String] = []
  /// What this card has kept of each draft, so its own edits coming back aren't news.
  @State private var sent: [String: String] = [:]
  /// The edit kept in the Outbox and not sent yet, by its command's id.
  @State private var pendingEdit: String?
  /// The versions the fields last took from the core.
  @State private var seen: [String] = []
  @State private var typed = ""
  @State private var replying = ""
  @State private var secret = ""
  @State private var held: String?
  @State private var holding: Task<Void, Never>?
  /// What's held, by its id in the Outbox.
  @State private var pending: String?
  @State private var failure: String?
  @State private var sending = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        Text(item.title)
          .font(SIS.text(17, weight: .semibold)).foregroundStyle(SIS.ink)
          .padding(.horizontal, SIS.inset).padding(.top, 20).padding(.bottom, 10)
        if !item.body.isEmpty {
          Text(item.body).font(SIS.text(15)).foregroundStyle(SIS.ink2).textSelection(.enabled)
            .padding(.horizontal, SIS.inset).padding(.bottom, 12)
        }
        if item.portal { PortalPreview(phone: phone, item: item).padding(.bottom, 12) }
        AskFiles(phone: phone, files: item.files.filter { $0.option == nil })
        if let failure {
          HStack(spacing: 6) {
            Stop(size: 12)
            Text(failure).font(SIS.text(12)).foregroundStyle(SIS.ink)
          }
          .padding(.horizontal, SIS.inset).padding(.bottom, 10)
        }
        Hairline()
        if let held {
          HStack {
            Text(held).font(SIS.text(15)).foregroundStyle(SIS.ink)
            Spacer()
            if holding != nil { Button("Undo", action: undo).buttonStyle(KeyStyle()) }
          }
          .padding(.horizontal, SIS.inset).frame(minHeight: SIS.row)
        } else if item.kind == .sealed {
          sealedField
        } else {
          answer
          Hairline()
          replyField
        }
      }
    }
    .onAppear {
      if drafts.count != item.drafts.count {
        // His edit kept here from before (the card closed before the core had it) over the saved one.
        let kept = phone.keptEdit(item.id)
        sent = kept
        seen = item.drafts.map(item.shown)
        drafts = item.drafts.map { kept[$0.name] ?? item.shown($0) }
      }
      if !item.drafts.isEmpty { Task { try? await phone.openDrafts(item.id) } }
    }
    .onChange(of: item.drafts.map(item.shown)) { _, now in took(now) }
    // Leaving the card sends what's held at once, as does leaving the app: iOS may end it after.
    .onDisappear {
      saveDrafts()
      commit()
    }
    .onChange(of: phase) { _, now in
      if now == .background {
        saveDrafts()
        commit()
      }
    }
  }

  // MARK: By kind

  @ViewBuilder private var answer: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(Array(item.drafts.enumerated()), id: \.offset) { i, d in
        VStack(alignment: .leading, spacing: 4) {
          Text(d.label).font(SIS.text(12, weight: .medium)).foregroundStyle(SIS.ink2)
          TextField(d.label, text: draftBinding(i), axis: .vertical)
            .font(SIS.text(16)).foregroundStyle(SIS.ink).lineLimit(2...12)
            .padding(8).background(SIS.Field.fill)
            .overlay(RoundedRectangle(cornerRadius: SIS.controlRadius).stroke(SIS.Field.border, lineWidth: 1))
        }
      }
      if item.kind == .question {
        ForEach(Array(item.options.enumerated()), id: \.offset) { i, o in
          HStack(spacing: 8) {
            AskFiles(phone: phone, files: item.files.filter { $0.option == i }, inset: false)
            Button(o) { hold(o, "item.answer", ["choice": .string(o)]) }
              .buttonStyle(KeyStyle())
          }
        }
        HStack(spacing: 8) {
          TextField("Answer", text: $typed, axis: .vertical)
            .font(SIS.text(16)).lineLimit(1...6)
            .padding(8).background(SIS.Field.fill)
            .overlay(RoundedRectangle(cornerRadius: SIS.controlRadius).stroke(SIS.Field.border, lineWidth: 1))
          Button("Send") {
            let words = typed.trimmingCharacters(in: .whitespacesAndNewlines)
            hold("Answered", "item.answer", ["text": .string(words)])
          }
          .buttonStyle(KeyStyle(go: true))
          .disabled(typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
      keys
    }
    .padding(.horizontal, SIS.inset).padding(.vertical, 14)
  }

  @ViewBuilder private var keys: some View {
    HStack(spacing: 8) {
      if let a = item.assist {
        Button(a.label) { run { try await phone.assist(a) } }.buttonStyle(KeyStyle())
      }
      switch item.kind {
      case .approval:
        Button("Approve") { approve() }.buttonStyle(KeyStyle(go: true))
        Button("Decline") { hold("Declined", "item.answer", ["approved": false]) }
          .buttonStyle(KeyStyle())
      case .task:
        Button("Done") { hold("Done", "item.close", ["status": "done"]) }.buttonStyle(KeyStyle(go: true))
      case .question, .sealed:
        EmptyView()
      }
      Spacer(minLength: 0)
      Button("Dismiss") { hold("Dismissed", "item.close", ["status": "dismissed"]) }.buttonStyle(KeyStyle())
    }
  }

  @ViewBuilder private var replyField: some View {
    HStack(alignment: .bottom, spacing: 12) {
      TextField("Reply", text: $replying, axis: .vertical)
        .font(SIS.text(16)).lineLimit(1...6).padding(.vertical, 6)
      Button("Send") {
        let words = replying.trimmingCharacters(in: .whitespacesAndNewlines)
        replying = ""
        run { try await phone.reply(item, words) }
      }
      .buttonStyle(KeyStyle())
      .disabled(replying.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
    .padding(.horizontal, SIS.inset).padding(.vertical, 8)
  }

  /// What's typed is sealed on this phone and only the sealed bytes leave; nothing is held for Undo,
  /// and the field clears once it's sent.
  @ViewBuilder private var sealedField: some View {
    HStack(spacing: 12) {
      SecureField(item.sealedUse.isEmpty ? "Secret" : item.sealedUse, text: $secret)
        .font(SIS.text(16)).textContentType(contentType).autocorrectionDisabled().textInputAutocapitalization(.never)
        .padding(8).background(SIS.Field.fill)
        .overlay(RoundedRectangle(cornerRadius: SIS.controlRadius).stroke(SIS.Field.border, lineWidth: 1))
      Button("Send") {
        let given = secret
        secret = ""
        run { try await phone.answerSealed(item, given) }
      }
      .buttonStyle(KeyStyle(go: true))
      .disabled(secret.isEmpty || sending)
    }
    .padding(.horizontal, SIS.inset).padding(.vertical, 14)
  }

  /// What Passwords AutoFill may offer, by what the secret is for.
  private var contentType: UITextContentType {
    let use = item.sealedUse.lowercased()
    if use.contains("security code") || use.contains("cvc") || use.contains("cvv") { return .creditCardSecurityCode }
    if use.contains("card") { return .creditCardNumber }
    if use.contains("code") { return .oneTimeCode }
    return .password
  }

  // MARK: Doing

  private func draftBinding(_ i: Int) -> Binding<String> {
    Binding(
      get: { drafts.indices.contains(i) ? drafts[i] : item.shown(item.drafts[i]) },
      set: {
        guard drafts.indices.contains(i) else { return }
        drafts[i] = $0
        keepDrafts()
      })
  }

  /// Keeps what's typed in the drafts that differs from what the core has in the Outbox at once
  /// (an edit, not an approval), due once typing rests, so leaving the card or the app can't lose it.
  private func keepDrafts() {
    var changed: [String: String] = [:]
    for (i, d) in item.drafts.enumerated() where drafts.indices.contains(i) && drafts[i] != item.shown(d) {
      changed[d.name] = drafts[i]
    }
    sent = changed
    guard !changed.isEmpty else {
      if let id = pendingEdit { Outbox.shared.drop(id) }
      pendingEdit = nil
      return
    }
    pendingEdit = Outbox.shared.hold(
      "item.edit", ["id": .string(item.id), "drafts": .object(changed.mapValues { .string($0) })], replacing: pendingEdit,
      due: Date().timeIntervalSince1970 * 1000 + Self.saveAfter)
  }

  /// Sends the edit kept and not sent yet, now.
  private func saveDrafts() {
    if let id = pendingEdit { Outbox.shared.release(id) }
    pendingEdit = nil
  }

  /// The core's newer version of a draft (his edit on another device or in its email draft) takes its
  /// field, unless something typed here is newer.
  private func took(_ now: [String]) {
    for (i, text) in now.enumerated() where drafts.indices.contains(i) && item.drafts.indices.contains(i) {
      let before = seen.indices.contains(i) ? seen[i] : text
      let name = item.drafts[i].name
      if text == before || text == sent[name] { continue }
      // Typed here and not taken by the core yet: that goes, over this.
      if drafts[i] != before { continue }
      drafts[i] = text
    }
    seen = now
  }

  private func approve() {
    var fields: [String: JSON] = ["approved": true]
    if !item.drafts.isEmpty {
      var left: [String: JSON] = [:]
      var edited: [JSON] = []
      for (i, d) in item.drafts.enumerated() {
        let now = drafts.indices.contains(i) ? drafts[i] : item.shown(d)
        left[d.name] = .string(now)
        if now != d.text { edited.append(.string(d.name)) }
      }
      fields["drafts"] = .object(left)
      if !edited.isEmpty { fields["edited"] = .array(edited) }
    }
    hold("Approved", "item.answer", fields)
  }

  /// Holds a command on the item a few seconds with Undo, kept in the Outbox from the tap, so the
  /// app ending first still sends it; then sends it.
  private func hold(_ label: String, _ name: String, _ fields: [String: JSON]) {
    failure = nil
    held = label
    var payload = fields
    payload["id"] = .string(item.id)
    // Due a moment after the card sends it: the Outbox sends it itself only if the app went first.
    pending = Outbox.shared.hold(name, .object(payload), due: Date().timeIntervalSince1970 * 1000 + Self.holdFor + 1000)
    holding = Task {
      try? await Task.sleep(for: .milliseconds(Int(Self.holdFor)))
      if !Task.isCancelled { commit() }
    }
  }

  private func undo() {
    holding?.cancel()
    holding = nil
    // Already going: too late for Undo.
    if let id = pending, !Outbox.shared.drop(id) { return commit() }
    pending = nil
    held = nil
  }

  /// Sends what's held now, and closes the card once the core has it.
  private func commit() {
    guard let id = pending else { return }
    pending = nil
    holding?.cancel()
    holding = nil
    run({ try await Outbox.shared.now(id) }, closes: true)
  }

  private func run(_ action: @escaping () async throws -> Void, closes: Bool = false) {
    sending = true
    Task {
      defer { sending = false }
      do {
        try await action()
        if closes { onGone() }
      } catch {
        held = nil
        failure = error.localizedDescription
      }
    }
  }
}

/// The files on an item, as a chat shows them (a tap opens one, a long press shares it); a link
/// without a blob is a row with its name and size that shares it.
struct AskFiles: View {
  let phone: Phone
  let files: [ActionItem.File]
  var inset = true

  var body: some View {
    if !files.isEmpty {
      let stored = files.compactMap(\.attachment)
      VStack(alignment: .leading, spacing: 8) {
        if !stored.isEmpty { Attached(attachments: stored, right: false, inset: false) }
        ForEach(files.filter { $0.attachment == nil }, id: \.self) { f in AskFileRow(phone: phone, file: f) }
      }
      .padding(.horizontal, inset ? SIS.inset : 0).padding(.bottom, inset ? 12 : 0)
    }
  }
}

struct AskFileRow: View {
  let phone: Phone
  let file: ActionItem.File
  @State private var saved: URL?
  @State private var image: UIImage?

  var body: some View {
    Group {
      if let saved {
        ShareLink(item: saved) { label }
      } else {
        label
      }
    }
    .task {
      guard let data = try? await phone.fileData(file) else { return }
      if file.type.hasPrefix("image/") { image = UIImage(data: data) }
      let at = FileManager.default.temporaryDirectory.appending(path: file.name.isEmpty ? "file" : file.name)
      if (try? data.write(to: at)) != nil { saved = at }
    }
  }

  @ViewBuilder private var label: some View {
    if let image {
      Image(uiImage: image).resizable().scaledToFill()
        .frame(width: 96, height: 96).clipShape(RoundedRectangle(cornerRadius: SIS.controlRadius))
    } else {
      HStack(spacing: 8) {
        Text(file.name).font(SIS.text(14)).foregroundStyle(SIS.ink).lineLimit(1)
        if let size = file.size { Figure(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)) }
      }
      .padding(.horizontal, 10).frame(height: 32).background(SIS.wash)
      .clipShape(RoundedRectangle(cornerRadius: SIS.controlRadius))
    }
  }
}

extension ActionItem.File {
  /// Its blob as an attachment, when it's in the core's store.
  var attachment: Attachment? {
    guard let blob, !blob.isEmpty else { return nil }
    let hash = blob.replacingOccurrences(of: "sha256:", with: "").replacingOccurrences(of: "blob:", with: "")
    return Attachment(blob: hash, name: name, type: type, size: size ?? 0)
  }
}
