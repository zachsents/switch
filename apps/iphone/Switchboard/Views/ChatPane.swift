import PassKit
import SwiftUI

/// A space's chat: its master thread, kept to its latest, and the message box as the whole bottom cell.
/// It follows the latest while it's at the bottom: new lines and a send keep it there.
/// Scrolled up, it stays put until it's back at the bottom or the user sends; older lines paging in
/// above keep what's in view where it is; a find match is brought into view, and stops the following.
struct ChatPane: View {
  let phone: Phone
  let id: String
  @State private var reading: Reading?
  @Environment(\.scenePhase) private var phase
  @Environment(\.undoManager) private var undo
  /// The message being edited in the box, and its words.
  @State private var editing: (seq: Int, text: String)?
  @State private var editError: String?
  @State private var position = ScrollPosition(edge: .bottom)
  /// Kept at the latest.
  @State private var following = true
  /// The user is moving it.
  @State private var touched = false
  @State private var atBottom = true
  /// The find match last brought into view, held there while the lines around it settle, until
  /// the user moves.
  @State private var shown: Int?
  @State private var pinned = false
  /// The oldest line when older ones were asked for, until they're in: held to the bottom meanwhile,
  /// so they come in above what's in view without moving it.
  @State private var paging: Int?
  /// The line an emoji reaction is being chosen for, on the emoji keyboard.
  @State private var emojiFor: Int?

  private var brain: Brain { phone.brain }

  /// Where a find match sits: halfway down, on the column's leading edge (centred would move it
  /// sideways).
  private static let match = UnitPoint(x: 0, y: 0.5)

  private func toLatest() {
    following = true
    pinned = false
    position.scrollTo(edge: .bottom)
  }

  /// To the line find opened, paging older chat in until it's held.
  private func settle(_ lines: [Brain.ChatLine]) {
    guard let at = phone.chatAt[id], at != shown else { return }
    following = false
    if lines.contains(where: { $0.line.seq == at && $0.pending == nil }) {
      shown = at
      pinned = true
      position.scrollTo(id: String(at), anchor: Self.match)
    } else if let oldest = lines.first?.line.seq, oldest > at {
      phone.olderChat(id)
    }
  }

  var body: some View {
    let lines = brain.chat(id)
    let last = lines.last(where: { !$0.line.agent && $0.pending == nil && $0.line.quiet == nil && $0.line.home == id })
    let passes = brain.passes.filter { $0.space == id }
    let mine = id == HOME ? SIS.own : brain.station(id).ink
    // Only the find bar's current match is marked.
    let ringed = phone.findingIn == id ? phone.chatAt[id] : nil
    let runs = Runs.of(lines)
    let title = brain.spaces[id]?.name ?? ""
    // Its asks, each where it was raised.
    let asks = AskInChat.placed(lines, brain.actions.values.filter { $0.space == id } + brain.closedActions.filter { $0.space == id })
    VStack(spacing: 0) {
      if phone.findingIn == id { ChatFind(phone: phone, space: id) }
      EmojiField(open: Binding(get: { emojiFor != nil }, set: { if !$0 { emojiFor = nil } })) { r in
        if let seq = emojiFor {
          phone.react(seq, r, was: brain.chat(id).first { $0.line.seq == seq }?.line.reactions.user)
        }
      }
      .frame(width: 0, height: 0)
      .opacity(0)
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          if brain.chats[id]?.more != false {
            Color.clear.frame(height: 1).onAppear {
              paging = lines.first?.line.seq ?? 0
              phone.olderChat(id)
            }
          }
          ForEach(lines) { l in
            let lead = runs.leads[l.id] ?? .apart
            VStack(alignment: .leading, spacing: 0) {
              ForEach(asks.before[l.id] ?? []) { a in AskInChat(phone: phone, item: a).padding(.bottom, 12) }
              if case .gap(let time) = lead { GapTime(time: time) }
              entry(l, mine: mine, ringed: ringed, lead: lead, tail: runs.ends.contains(l.id), title: title, edit: l.id == last?.id,
                undelivered: l.id == last?.id ? brain.undelivered(id) : nil)
            }
            // Every row the column's full width, so none moves it sideways.
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, lead == .run ? 2 : lead == .apart ? 12 : 0)
          }
          ForEach(asks.after) { a in AskInChat(phone: phone, item: a).padding(.top, 12) }
          ForEach(passes) { p in PassRow(phone: phone, pass: p).padding(.top, 12) }
          // Typing until its reply lands.
          if let since = brain.typingSince(id), !lines.contains(where: { $0.line.agent && $0.line.from == nil && $0.line.time >= since }) {
            Typing().padding(.top, 12)
          }
        }
        .scrollTargetLayout()
        .padding(.horizontal, SIS.inset)
        .padding(.top, 4)
        .padding(.bottom, 12)
      }
      .scrollPosition($position)
      // Leading, not centred: a change of width never moves it sideways. Following, or paging older
      // lines in above, a change of size keeps the bottom where it is; scrolled up, the top, so what
      // comes in below (a line, a reaction, an edit) moves nothing.
      .defaultScrollAnchor(.bottomLeading)
      .defaultScrollAnchor(following || paging != nil ? .bottomLeading : .topLeading, for: .sizeChanges)
      .scrollDismissesKeyboard(.interactively)
      .onScrollPhaseChange { _, now in
        let moving = now == .tracking || now == .interacting || now == .decelerating
        if moving, !touched, brain.chats[id]?.more == false { paging = nil }
        if touched, !moving { following = atBottom }
        if moving { pinned = false }
        touched = moving
      }
      .onScrollGeometryChange(for: Bool.self) { g in
        g.visibleRect.maxY >= g.contentSize.height - 24
      } action: { _, bottom in
        atBottom = bottom
        if touched { following = bottom }
      }
      .onScrollGeometryChange(for: [CGFloat].self) { g in
        [g.contentSize.height, g.containerSize.height]
      } action: { _, _ in
        if let was = paging, brain.chat(id).first?.line.seq != was { paging = nil }
        if touched { return }
        if following {
          position.scrollTo(edge: .bottom)
        } else if pinned, let shown {
          position.scrollTo(id: String(shown), anchor: Self.match)
        }
      }
      .onChange(of: lines.count) { settle(lines) }
      .onChange(of: phone.chatAt[id]) {
        shown = nil
        settle(lines)
      }
      .onAppear {
        if phone.chatAt[id] != nil { settle(lines) } else { toLatest() }
      }
      Box(
        placeholder: id == HOME ? "Message" : "Message \(title)", place: "space:\(id)", error: editError,
        attaches: true, editing: editing?.text, onCancel: { editing = nil }
      ) { words, files, replies in
        editError = nil
        toLatest()
        guard let was = editing else {
          phone.chatAt[id] = nil
          phone.post(id, words, files, replies)
          return
        }
        editing = nil
        Task {
          do {
            try await phone.edit(was.seq, words.text)
          } catch {
            editError = error.localizedDescription
          }
        }
      }
    }
    .background(SIS.paper)
    .sheet(item: $reading) { ReadingSheet(reading: $0) }
    .onAppear { if phase == .active { phone.read(id) } }
    .onChange(of: brain.unreadAt(id)) { if phase == .active { phone.read(id) } }
    .onChange(of: phase) { if phase == .active { phone.read(id) } }
    .onDisappear {
      phone.chatAt[id] = nil
      if phone.findingIn == id { phone.findingIn = nil }
    }
  }

  /// A reply as its bubble shows it: an ask by its title and space, when it's known.
  private func inset(_ r: Reply) -> ReplyInset {
    guard case .ask(let ask, let title, _) = r else { return ReplyInset(reply: r) }
    let item = brain.actions[ask] ?? brain.revising[ask] ?? brain.closedActions.first { $0.id == ask }
    return ReplyInset(reply: r, name: item?.title ?? title ?? "", space: item.map { brain.spaces[$0.space]?.name ?? "" } ?? "")
  }

  /// To what a reply is on: the quoted message, brought into view; an open ask, opened.
  private func go(_ r: Reply) {
    switch r {
    case .quote(let seq, _, _, _), .message(let seq, _, _):
      if phone.chatAt[id] == seq {
        shown = nil
        settle(brain.chat(id))
      } else {
        phone.chatAt[id] = seq
      }
    case .ask(let ask, _, _):
      if brain.actions[ask] != nil { phone.asking = ask }
    }
  }

  /// One line of the chat: a blip, or what was said with its files.
  @ViewBuilder
  private func entry(_ l: Brain.ChatLine, mine: Color, ringed: Int?, lead: Runs.Lead, tail: Bool, title: String, edit: Bool, undelivered: String?) -> some View {
    if let quiet = l.line.quiet {
      QuietLine(phone: phone, line: l.line, quiet: quiet, here: id)
    } else if let shown = l.line.widget {
      ChatWidget(phone: phone, shown: shown, seq: l.line.seq)
    } else {
      let held = l.pending == nil
      if !l.line.general.isEmpty || !l.line.replyTo.isEmpty {
        // A peer's name over the first of its run, as a group chat names a sender.
        if let from = l.line.from, lead != .run {
          Text(from)
            .font(SIS.text(12))
            .foregroundStyle(SIS.ink2)
            .lineLimit(1)
            .padding(.horizontal, 12)
            .padding(.bottom, 2)
        }
        Said(
          agent: l.line.agent, ink: mine, dim: !held, ringed: held && l.line.seq == ringed, text: l.line.general,
          detail: l.line.detail, tail: tail, time: held ? l.line.time : nil, model: l.line.model, reactions: l.line.reactions,
          // An ask shows once it's known: an old reply's item id that names none shows nothing.
          insets: l.line.replyTo.map(inset).filter { if case .ask = $0.reply { !$0.name.isEmpty } else { true } }, marks: WordMark.of(l.line.parts, agent: l.line.agent, ink: mine),
          onInset: { go($0) },
          onReact: held ? { r in phone.react(l.line.seq, r, was: l.line.reactions.user) } : nil,
          onEmoji: held ? { emojiFor = l.line.seq } : nil,
          onEdit: edit ? { editing = (l.line.seq, l.line.text) } : nil,
          onReply: held ? { Outbox.shared.reply(.whole(l.line), at: "space:\(id)") } : nil,
          // This space first: the one it's most likely out of place in.
          removals: held ? phone.removable(l.line).sorted { a, _ in a.id == id } : [],
          onRemove: { [seq = l.line.seq] space in phone.remove(seq, from: space, undo: undo) }
        ) { text in
          reading = Reading(title: title, text: text)
        }
      }
      if l.line.edited {
        Text("Edited")
          .font(SIS.text(12))
          .foregroundStyle(SIS.ink2)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.top, 2)
      }
      if !l.line.attachments.isEmpty {
        Attached(attachments: l.line.attachments, right: !l.line.agent).opacity(held ? 1 : 0.6).padding(.top, l.line.text.isEmpty ? 0 : l.line.attachments.count(where: { $0.kind == .image }) > 1 ? 12 : 4)
      }
    }
    if let p = l.pending, p.failed {
      // Back in the box, to change or send again.
      Button {
        phone.retake(p.id, space: p.space)
      } label: {
        HStack(spacing: 6) {
          Stop(size: 12)
          Text("Not sent")
        }
        .font(SIS.text(12))
        .foregroundStyle(SIS.ink)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.top, 4)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
    }
    if let thread = undelivered {
      Button {
        Task { try? await phone.retry(thread) }
      } label: {
        HStack(spacing: 6) {
          Text("Not Delivered")
          NotDelivered(size: 14)
        }
        .font(SIS.text(12))
        .foregroundStyle(SIS.stopped)
      }
      .buttonStyle(.plain)
      .frame(maxWidth: .infinity, alignment: .trailing)
      .padding(.top, 4)
    }
    if !l.also.isEmpty { Mentioned(phone: phone, ids: l.also, right: !l.line.agent) }
  }
}

/// The other spaces a line bears on, each a link.
private struct Mentioned: View {
  let phone: Phone
  let ids: [String]
  let right: Bool

  var body: some View {
    HStack(spacing: 10) {
      ForEach(ids, id: \.self) { id in
        let st = phone.brain.station(id)
        Button {
          phone.open(.space(id))
        } label: {
          HStack(spacing: 5) {
            Ring(code: st.code, ink: st.ink, size: 14, home: id == HOME)
            Text(phone.brain.spaces[id]?.name ?? "").fontWeight(.medium).foregroundStyle(SIS.ink2)
          }
          .frame(minHeight: 28)
        }
        .buttonStyle(.plain)
      }
    }
    .font(SIS.text(12))
    .frame(maxWidth: .infinity, alignment: right ? .trailing : .leading)
    .padding(.top, 2)
  }
}

/// A pass the agent issued, in its space's chat: its name and Apple's Add to Apple Wallet button.
struct PassRow: View {
  let phone: Phone
  let pass: IssuedPass
  @State private var loaded: PKPass?
  @State private var failure: String?
  @State private var added = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        Image(systemName: "wallet.pass").foregroundStyle(SIS.ink2)
        Text(pass.title).font(SIS.text(15, weight: .medium)).foregroundStyle(SIS.ink).lineLimit(1)
      }
      if let failure {
        HStack(spacing: 6) {
          Stop(size: 12)
          Text(failure)
        }
        .font(SIS.text(12))
      } else if let loaded {
        if added || PKPassLibrary().containsPass(loaded) {
          Button("In Wallet") {
            if let url = loaded.passURL { UIApplication.shared.open(url) }
          }
          .buttonStyle(KeyStyle())
        } else {
          AddPassToWalletButton([loaded]) { added = $0 }
            .frame(width: 220, height: 44)
        }
      } else {
        ProgressView().controlSize(.small)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(SIS.bubble, in: RoundedRectangle(cornerRadius: Said.radius, style: .continuous))
    .padding(.trailing, 64)
    .task(id: pass.serial) {
      do {
        loaded = try await PassSheet.fetch(phone, pass.serial)
      } catch {
        failure = error.localizedDescription
      }
    }
  }
}

/// A pass a notification asked to add.
struct PassSheet: View {
  struct Serial: Identifiable { let id: String }

  let phone: Phone
  let serial: String
  @State private var loaded: PKPass?
  @State private var failure: String?

  static func fetch(_ phone: Phone, _ serial: String) async throws -> PKPass {
    guard let sync = phone.sync else { throw Sync.Rejected(reason: "No core") }
    guard let data = try? await sync.get("passes/\(serial)") else { throw Sync.Rejected(reason: "No such pass") }
    return try PKPass(data: data)
  }

  var body: some View {
    VStack(spacing: 16) {
      if let loaded {
        Text(loaded.localizedDescription).font(SIS.text(17, weight: .semibold)).foregroundStyle(SIS.ink)
        AddPassToWalletButton([loaded]) { done in if done { phone.passToAdd = nil } }
          .frame(width: 240, height: 48)
      } else if let failure {
        HStack(spacing: 6) {
          Stop(size: 12)
          Text(failure)
        }
      } else {
        ProgressView()
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(SIS.paper)
    .task {
      do { loaded = try await Self.fetch(phone, serial) } catch { failure = error.localizedDescription }
    }
  }
}
