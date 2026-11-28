import SwiftUI

/// What's written in the box, and which of it was dictated: kept by the box, so what's sent says
/// which words were dictated (`words.payload`), as the desktop's box does.
@Observable final class Writing {
  /// What's in it, with its dictated stretches following every edit.
  private(set) var words = Words() {
    didSet { if words != oldValue { changed() } }
  }
  /// Told of each change, to keep it.
  @ObservationIgnored var changed: () -> Void = {}
  /// The box as the dictation under way found it: its words go after this, never over any of it,
  /// so several dictations build one message.
  private(set) var draft: Words?
  /// Why the last dictation stopped short.
  private(set) var stopped: Stopped?
  let id = UUID()
  @ObservationIgnored private var then: [() -> Void] = []

  var dictating: Bool { draft != nil }

  /// The text, as the field binds it. While a dictation fills the box it's the dictation's, so
  /// typing is ignored.
  var text: String {
    get { words.text }
    set { if draft == nil { words.edit(newValue) } }
  }

  /// The mic key: starts a dictation here, or finishes the one under way.
  func toggle() { dictating ? finish() : start() }

  func start() {
    guard !dictating, Dictation.available else { return }
    (draft, stopped) = (words, nil)
    Dictation.shared.start(id) { [weak self] said, why in self?.end(said, why) }
  }

  /// Finishes the dictation under way here, keeping its words.
  func finish() { if dictating { Dictation.shared.stop(id) } }

  /// Runs `action` once what's being said is in the box: at once, or once the dictation under way
  /// finishes (the send key while dictating sends what was said).
  func whenDone(_ action: @escaping () -> Void) {
    guard dictating else { return action() }
    then.append(action)
    finish()
  }

  /// Empties it, once what's in it has gone.
  func clear() {
    guard !dictating else { return }
    (words, stopped) = (Words(), nil)
  }

  /// What was kept of it, back.
  func restore(_ kept: Words) {
    guard !dictating else { return }
    words = kept
  }

  /// The box while a dictation fills it: what was in it, then the words heard so far; `settled`
  /// is where the phrase under way, shown dimmed, starts.
  func shown(_ dictation: Dictation) -> (text: String, settled: Int)? {
    guard let draft else { return nil }
    let transcript = dictation.owner == id ? dictation.transcript : ""
    guard let (insertion, _) = draft.insertion(transcript) else { return (draft.text, draft.text.count) }
    let text = draft.text + insertion
    let volatile = dictation.owner == id ? dictation.volatile.trimmingCharacters(in: .whitespaces).count : 0
    return (text, max(draft.text.count, text.count - volatile))
  }

  private func end(_ said: String, _ why: Stopped?) {
    guard let draft else { return }
    var words = draft
    words.append(dictated: said)
    (self.words, self.draft, stopped) = (words, nil, why)
    let then = then
    self.then = []
    for action in then { action() }
  }
}

/// The message box: the whole bottom cell, its rule above it its only edge. It takes dictation: the
/// mic key starts one, and the words come after what's in it as they're said, the phrase under way
/// dimmed; the key again, or a tap in the box, finishes it. With `attaches`, its + opens the attach
/// sheet, and what's picked waits in a strip above the words, going up meanwhile; Send hands what's
/// picked to the Outbox, which sends the message once they're up, and nothing sends with one that
/// failed. What it replies to (attached from the chat's bubbles) sits over the words, a row each,
/// ✕ taking one off, and goes with the message. What's in it is kept in the Outbox at each change,
/// under `place`, so a box gone (or the app) loses none of it; an edit isn't kept.
struct Box: View {
  let placeholder: String
  /// Where it is, as its draft is kept: `space:<id>`, `thread:<id>`.
  let place: String
  var error: String?
  var attaches = false
  /// Words being edited: put in the box when they come, with Cancel above it.
  var editing: String?
  var onCancel: () -> Void = {}
  let onSend: (Words, [Outbox.File], [Reply]) -> Void
  @State private var writing = Writing()
  @State private var replies: [Reply] = []
  @State private var tray = Tray()
  @State private var attaching = false
  /// An edit is in it: what's typed isn't kept.
  @State private var paused = false
  @FocusState private var focused: Bool
  @Environment(\.openURL) private var openURL

  var body: some View {
    VStack(spacing: 0) {
      Rule()
      if editing != nil {
        HStack(spacing: 8) {
          Text("Editing").font(SIS.text(12)).foregroundStyle(SIS.ink2)
          Spacer(minLength: 0)
          Button("Cancel") {
            writing.clear()
            onCancel()
          }
          .buttonStyle(KeyStyle())
        }
        .padding(.horizontal, SIS.inset)
        .frame(height: 40)
        .overlay(alignment: .bottom) { Hairline() }
      }
      if let error {
        note(Text(error))
      } else if let stopped = writing.stopped {
        stoppedNote(stopped)
      }
      ForEach(Array(replies.enumerated()), id: \.element) { at, r in replyRow(r, at) }
      if !tray.isEmpty { Chips(tray: tray) }
      HStack(alignment: .bottom, spacing: 12) {
        if attaches {
          Button {
            attaching = true
          } label: {
            Image(systemName: "plus").font(SIS.text(20)).foregroundStyle(SIS.ink2).frame(width: 28, height: SIS.key)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Attach")
        }
        if writing.dictating {
          Listening(writing: writing)
            .contentShape(.rect)
            // A tap in the box finishes the dictation, and leaves them there to edit.
            .onTapGesture { writing.whenDone { focused = true } }
        } else {
          TextField(placeholder, text: Binding(get: { writing.text }, set: { writing.text = $0 }), axis: .vertical)
            .font(SIS.text(16))
            .foregroundStyle(SIS.ink)
            .lineLimit(1...8)
            .focused($focused)
            .padding(.vertical, 6)
            .accessibilityLabel(placeholder)
        }
        if Dictation.available { MicKey(writing: writing) { focused = false } }
        Button("Send") { writing.whenDone(send) }
          .buttonStyle(KeyStyle(go: true))
          .disabled(tray.reading || tray.failed || (writing.words.isEmpty && tray.isEmpty && !writing.dictating))
      }
      .padding(.horizontal, SIS.inset)
      .padding(.vertical, 8)
    }
    .background(SIS.paper)
    // A box leaving the screen keeps what was said, and lets the microphone go.
    .onDisappear { writing.finish() }
    .sheet(isPresented: $attaching) { AttachSheet(tray: tray) }
    .onAppear {
      writing.changed = keep
      tray.changed = keep
      restore()
    }
    .onChange(of: Outbox.shared.retaken[place]) {
      let had = replies.count
      restore()
      // One just attached takes the keys.
      if replies.count > had { focused = true }
    }
    .onChange(of: replies) { keep() }
    .onChange(of: editing) {
      if let editing {
        paused = true
        writing.text = editing
        focused = true
      } else {
        // The edit's done or put down: what was in the box before it, back.
        paused = false
        restore()
      }
    }
  }

  private func send() {
    let words = writing.words.trimmed
    guard !words.isEmpty || !tray.isEmpty, !tray.failed, !tray.reading else { return }
    onSend(words, tray.handOver(), replies)
    replies = []
    writing.clear()
  }

  /// What's in it, kept in the Outbox; not while an edit's in it.
  private func keep() {
    if !paused { Outbox.shared.keep(Self.draft(writing.words, tray.files, replies), at: place) }
  }

  /// What's kept for this box, in it.
  private func restore() {
    guard !paused, !writing.dictating, let d = Outbox.shared.draft(place) else { return }
    let spans = d.dictated?.array.compactMap { s -> Range<Int>? in
      guard let start = s["start"].number.map({ Int($0) }) else { return nil }
      return start..<start + s["text"].str.unicodeScalars.count
    }
    writing.restore(Words(d.text, dictated: Spans(spans ?? [])))
    tray.restore(d.files ?? [])
    replies = d.replyTo?.array.compactMap(Reply.init) ?? []
  }

  private static func draft(_ words: Words, _ files: [Outbox.File], _ replies: [Reply]) -> Outbox.Draft {
    let dictated = words.dictated.record(words.text)
    return Outbox.Draft(
      text: words.text, dictated: dictated.isEmpty ? nil : .array(dictated), files: files.isEmpty ? nil : files,
      replyTo: replies.isEmpty ? nil : .array(replies.map(\.json)))
  }

  /// One of what it replies to: its words on one line beside a bar, and ✕.
  private func replyRow(_ r: Reply, _ at: Int) -> some View {
    HStack(spacing: 8) {
      Group {
        switch r {
        case .quote(_, let text, _, _): Text(text)
        // Its opening and its ending both in view: cut in the middle, where its own … is.
        case .message(_, let text, _): Text(text).truncationMode(.middle)
        case .ask(_, let title, _): Text(title ?? "")
        }
      }
      .font(SIS.text(13))
      .foregroundStyle(SIS.ink2)
      .lineLimit(1)
      .padding(.leading, 8)
      .overlay(alignment: .leading) { Rectangle().fill(SIS.ink3).frame(width: 2) }
      Spacer(minLength: 0)
      Button {
        replies.remove(at: at)
      } label: {
        Image(systemName: "xmark").font(SIS.text(13)).foregroundStyle(SIS.ink2).frame(width: 32, height: 32).contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Remove")
    }
    .padding(.leading, SIS.inset)
    .padding(.trailing, SIS.inset - 8)
    .frame(minHeight: 40)
    .overlay(alignment: .bottom) { Hairline() }
  }

  private func note(_ text: Text) -> some View {
    HStack(spacing: 8) {
      Stop(size: 12)
      text.font(SIS.text(12)).foregroundStyle(SIS.ink)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, SIS.inset)
    .frame(height: 32)
    .overlay(alignment: .bottom) { Hairline() }
  }

  @ViewBuilder private func stoppedNote(_ stopped: Stopped) -> some View {
    switch stopped {
    case .denied:
      // Where it's let in is a tap away.
      Button {
        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
      } label: {
        note(Text("Microphone not allowed"))
      }
      .buttonStyle(.plain)
    case .quiet: note(Text("No words for a minute"))
    case .failed(let why): note(Text(why))
    }
  }
}

/// The box while it listens: what was in it, then the words heard so far, the phrase under way
/// dimmed; the latest lines in view when it's long.
private struct Listening: View {
  let writing: Writing

  var body: some View {
    let shown = writing.shown(Dictation.shared) ?? ("", 0)
    // Sized as the field would be for the text (at most its lines), with the end of it in view.
    Text(shown.text.isEmpty ? " " : shown.text).font(SIS.text(16)).lineLimit(1...8).hidden()
      .frame(maxWidth: .infinity, alignment: .leading)
      .overlay(alignment: .bottomLeading) {
        Text(Self.styled(shown.text, settled: shown.settled))
          .font(SIS.text(16))
          .fixedSize(horizontal: false, vertical: true)
      }
      .clipped()
      .padding(.vertical, 6)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(shown.text)
  }

  static func styled(_ text: String, settled: Int) -> AttributedString {
    let cut = text.index(text.startIndex, offsetBy: min(settled, text.count))
    var done = AttributedString(text[..<cut])
    done.foregroundColor = SIS.ink
    var going = AttributedString(text[cut...])
    going.foregroundColor = SIS.ink3
    return done + going
  }
}

/// The mic key: a mic to start; while it listens, how loud they are and a stop key. A tick of the
/// Taptic Engine as it starts and stops.
private struct MicKey: View {
  let writing: Writing
  /// Takes the keyboard away as a dictation starts: the words come by voice.
  let started: () -> Void

  var body: some View {
    let dictating = writing.dictating
    let status = Dictation.shared.status
    Button {
      if !dictating { started() }
      writing.toggle()
    } label: {
      HStack(spacing: 6) {
        if dictating {
          // Until it hears: getting the microphone, or the language's model the first time.
          if status == .recording || status == .stopping { Meter() } else { ProgressView().controlSize(.small) }
        }
        Image(systemName: dictating ? "stop.circle.fill" : "mic")
          .font(.system(size: dictating ? 22 : 18, weight: .regular))
          .foregroundStyle(dictating ? SIS.ink : SIS.ink2)
      }
      .frame(minWidth: 32, minHeight: SIS.key)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(dictating ? "Stop dictating" : "Dictate")
    .sensoryFeedback(trigger: dictating) { _, now in now ? .start : .stop }
  }
}

/// How loud they've been lately, as bars: the only view that redraws as the level changes.
private struct Meter: View {
  var body: some View {
    let levels = Dictation.shared.levels
    let count = Dictation.levelCount
    HStack(alignment: .center, spacing: 1.5) {
      ForEach(0..<count, id: \.self) { index in
        let at = index - (count - levels.count)
        let level = at >= 0 ? CGFloat(levels[at]) : 0
        Capsule().fill(SIS.ink2).frame(width: 2, height: 3 + level * 15)
      }
    }
    .frame(height: 18)
    .animation(.linear(duration: 0.05), value: levels)
    .accessibilityHidden(true)
  }
}
