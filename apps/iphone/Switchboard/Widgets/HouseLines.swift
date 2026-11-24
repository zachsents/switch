import A2UICore
import A2UISwiftUI
import SwiftUI

// Switch's catalog's lines that act: Row, Pick, Check and Entry, as desktop's widgets/row.tsx,
// pick.tsx, check.tsx and entry.tsx draw them. What they call goes through the widget host's
// `call`, as desktop's go through call.ts.

extension Node {
  /// It is a part of this type, or holds one.
  func holds(_ part: String) -> Bool { type == part || allChildNodes.contains { $0.holds(part) } }
}

/// What a Row is in a column with a Feed (desktop's index.css, a column with the house catalog's
/// picture and its lines): its line laid on the picture as its name plate, then what it holds under
/// the picture.
enum PlateRole {
  case none
  /// Only its line: a black plate flush left near the picture's top, as a space's banner carries its name.
  case tab
  /// Only its children, under the picture.
  case under
}

extension EnvironmentValues {
  @Entry var plate: PlateRole = .none
}

extension EnvironmentValues {
}

/// A line with its live mark, name and what's under it, data at the end, a progress rule along the
/// bottom and a countdown to `endsAt`; its children below, one equal column each, tucked under it.
/// With a `url`, the whole line opens it in the browser. On a picture, its line is the picture's
/// plate (black, the name in condensed capitals) and its children go under the picture.
struct RowView: View {
  let node: Node
  /// Its note (the detail in full) is shown.
  @State private var noting = false
  @Environment(\.plate) private var plate
  @Environment(\.a2uiCatalogs) private var catalogs
  @Environment(\.a2uiDefaultCatalogID) private var catalog
  @Environment(\.openURL) private var openURL

  var body: some View {
    let children = plate == .tab ? [] : node.renderedChildren(for: "children", in: catalogs, defaultCatalogID: catalog)
    VStack(spacing: 0) {
      if plate == .under {
        EmptyView()
      } else if plate == .tab {
        tab
      } else if let url = node.string(for: "url").flatMap(URL.init(string:)), !url.absoluteString.isEmpty {
        Button { openURL(url) } label: { line.contentShape(.rect) }
          .buttonStyle(Lit())
          .accessibilityLabel(node.string(for: "label") ?? "")
      } else {
        line
      }
      if !children.isEmpty, plate == .under {
        // Under a picture: one row of slots, wrapping when the cell is too narrow for them.
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 72), spacing: 0)], spacing: 0) {
          ForEach(children, id: \.id) { child in
            ComponentNodeView(node: child).frame(maxWidth: .infinity)
          }
        }
      } else if !children.isEmpty {
        HStack(spacing: 0) {
          ForEach(Array(children.enumerated()), id: \.element.id) { i, child in
            if i > 0 { Rectangle().fill(SIS.rule).frame(width: SIS.line) }
            ComponentNodeView(node: child).frame(maxWidth: .infinity)
          }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, -4)
        .padding(.bottom, 6)
      }
    }
  }

  /// Its detail; said short with a `note` (a printer's trouble in a word or two), a tap shows the
  /// whole of it (desktop shows it while the pointer is over it).
  @ViewBuilder private func noted(_ detail: some View) -> some View {
    let note = node.string(for: "note") ?? ""
    if note.isEmpty {
      detail
    } else {
      Button { noting = true } label: { detail.contentShape(.rect) }
        .buttonStyle(.plain)
        .accessibilityHint(note)
        .popover(isPresented: $noting) {
          Text(note).font(SIS.text(SIS.Size.caption)).foregroundStyle(SIS.ink)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: 280, alignment: .leading)
            .padding(10)
            .float()
        }
    }
  }

  /// Its line as the picture's name plate (desktop's index.css, ui/space-banner.tsx): black, flush
  /// left, rounded at the right, the name in the sign face and where it's at after it.
  private var tab: some View {
    let endsAt = node.jsonValue(for: "endsAt")?.doubleValue
    let values = (node.jsonValue(for: "values")?.arrayValue ?? []).compactMap(\.stringValue)
    return TimelineView(.periodic(from: .now, by: endsAt == nil ? 3600 : 30)) { t in
      HStack(spacing: 8) {
        mark
        Text((node.string(for: "label") ?? "").uppercased()).font(SIS.sign(17)).tracking(0.3).foregroundStyle(.white).lineLimit(1)
          .fixedSize()
        noted(Text(node.string(for: "detail") ?? "").font(SIS.text(SIS.Size.caption)).foregroundStyle(.white.opacity(0.8)).lineLimit(1))
        ForEach(values, id: \.self) { Text($0).font(SIS.data()).foregroundStyle(.white).lineLimit(1) }
        if let endsAt {
          Text(span(max(0, endsAt - t.date.timeIntervalSince1970 * 1000))).font(SIS.data()).foregroundStyle(.white).lineLimit(1)
        }
      }
      .padding(.leading, 14)
      .padding(.trailing, 10)
      .padding(.vertical, 6)
      .background(Color.black, in: UnevenRoundedRectangle(bottomTrailingRadius: 6, topTrailingRadius: 6))
    }
  }

  private var line: some View {
    let endsAt = node.jsonValue(for: "endsAt")?.doubleValue
    let progress = node.jsonValue(for: "progress")?.doubleValue
    let values = (node.jsonValue(for: "values")?.arrayValue ?? []).compactMap(\.stringValue)
    let detail = node.string(for: "detail") ?? ""
    return TimelineView(.periodic(from: .now, by: endsAt == nil ? 3600 : 30)) { t in
      HStack(spacing: 8) {
        mark
        Text(node.string(for: "label") ?? "").font(SIS.text(15, weight: .medium)).foregroundStyle(SIS.ink).lineLimit(1)
          .fixedSize()
        noted(
          Text(detail).font(SIS.text(SIS.Size.caption)).foregroundStyle(node.bool(for: "alert") == true ? SIS.ink : SIS.ink2)
            .lineLimit(1)
        )
        .frame(maxWidth: .infinity, alignment: .leading)
        ForEach(values, id: \.self) { Text($0).font(SIS.text(12)).foregroundStyle(SIS.ink2).lineLimit(1).padding(.leading, 4) }
        if let endsAt {
          let left = max(0, endsAt - t.date.timeIntervalSince1970 * 1000)
          Text(span(left)).font(SIS.text(12)).foregroundStyle(SIS.ink2).lineLimit(1).padding(.leading, 4)
        }
      }
      .padding(.horizontal, SIS.inset)
      .frame(maxWidth: .infinity, minHeight: SIS.row)
      .overlay(alignment: .bottomLeading) {
        if let progress {
          GeometryReader { g in
            Rectangle().fill(SIS.ink).frame(width: g.size.width * min(100, max(0, progress)) / 100, height: 2)
              .frame(maxHeight: .infinity, alignment: .bottom)
          }
        }
      }
    }
  }

  @ViewBuilder private var mark: some View {
    switch node.string(for: "mark") {
    case "running": Runner()
    case "needsYou": Hand()
    case "stop": Stop()
    case "warn": Warn()
    default: EmptyView()
    }
  }
}

/// A color as a dot, hairlined so black and white show on any ground, ringed when it's the one chosen.
struct Swatch: View {
  let color: String
  var size: CGFloat = 12
  /// The one chosen: ringed.
  var chosen = false

  static func dark(_ hex: UInt32) -> Bool {
    let r = Double(hex / 65536 % 256), g = Double(hex / 256 % 256), b = Double(hex % 256)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 40
  }

  var body: some View {
    let hex = UInt32(color, radix: 16)
    Circle()
      .fill(hex.map { SIS.color(day: $0, night: $0) } ?? Color.clear)
      // A very dark one carries a soft highlight, so on a black band it reads as filled.
      .overlay {
        if let hex, Self.dark(hex) {
          Circle().fill(RadialGradient(colors: [.white.opacity(0.55), .clear], center: UnitPoint(x: 0.35, y: 0.3), startRadius: 0, endRadius: size * 0.6))
        }
      }
      .frame(width: size, height: size)
      .overlay(Circle().stroke(SIS.ink3, lineWidth: 1))
      .padding(chosen ? 2 : 0)
      .overlay { if chosen { Circle().stroke(SIS.ink, lineWidth: 2) } }
  }
}

/// A cell that's a key: its swatch and label. It opens choices in groups (words, or colors as
/// swatches), and Set calls the extension's `action` with `args` and what was chosen.
struct PickView: View {
  let node: Node
  @Environment(\.widgetSurface) private var surface
  @State private var open = false

  struct Group {
    let key: String
    let choices: [String]
    let swatches: Bool
    /// Any RRGGBB too, typed under the swatches.
    let custom: Bool

    /// A value it takes: one of its choices, or for a custom group any RRGGBB.
    func takes(_ value: String) -> Bool {
      choices.contains(value) || (custom && value.count == 6 && UInt32(value, radix: 16) != nil)
    }
  }

  var body: some View {
    let groups = partJSON(node, "groups").array.map { g in
      Group(
        key: g["key"].str, choices: g["choices"].array.map(\.str), swatches: g["swatches"].bool == true,
        custom: g["custom"].bool == true)
    }
    Button { open = true } label: {
      HStack(spacing: 6) {
        if let swatch = node.string(for: "swatch"), !swatch.isEmpty { Swatch(color: swatch) }
        if let title = node.string(for: "title"), !title.isEmpty {
          Text(title).font(SIS.text(12, weight: .semibold)).foregroundStyle(SIS.ink3).lineLimit(1).fixedSize()
        }
        Text(node.string(for: "label") ?? "")
          .font(SIS.text(12, weight: node.bool(for: "strong") == true ? .semibold : .regular))
          .foregroundStyle(node.bool(for: "strong") == true ? SIS.ink : SIS.ink2)
          .lineLimit(1)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, SIS.inset)
      .frame(maxWidth: .infinity, minHeight: SIS.row)
      .background(open ? SIS.selected : Color.clear)
      .contentShape(.rect)
    }
    .buttonStyle(Lit())
    .accessibilityLabel("\(node.string(for: "title") ?? "") \(node.string(for: "label") ?? "")")
    .popover(isPresented: $open) {
      ChoicesView(
        groups: groups, current: partJSON(node, "current").object, surface: surface, call: PartCall(node, surface: surface),
        done: { open = false }
      )
      .float()
    }
  }
}

/// A Pick's choices: a row of keys per group, one chosen in each, and Set, which calls the
/// extension; it closes when the extension takes it.
private struct ChoicesView: View {
  let groups: [PickView.Group]
  let surface: String
  let call: PartCall
  let done: () -> Void
  @State private var values: [String: String]
  @State private var pending = false
  @State private var error: String?

  init(groups: [PickView.Group], current: [String: JSON], surface: String, call: PartCall, done: @escaping () -> Void) {
    self.groups = groups
    self.surface = surface
    self.call = call
    self.done = done
    _values = State(
      initialValue: Dictionary(
        groups.map { g in
          let now = current[g.key]?.string?.uppercased()
          return (g.key, now.map { g.takes($0) } == true ? now ?? "" : g.choices.first ?? "")
        }, uniquingKeysWith: { a, _ in a }))
  }

  var body: some View {
    VStack(spacing: 0) {
      ForEach(groups, id: \.key) { g in
        let columns = g.swatches ? 8 : max(1, min(g.choices.count, g.choices.count > 5 ? 4 : 5))
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 0), count: columns), spacing: 0) {
          ForEach(g.choices, id: \.self) { c in
            Button { values[g.key] = c } label: {
              SwiftUI.Group {
                if g.swatches { Swatch(color: c, size: 16, chosen: values[g.key] == c) } else { Text(c).font(SIS.text(12)).foregroundStyle(SIS.ink).lineLimit(1) }
              }
              .frame(maxWidth: .infinity, minHeight: g.swatches ? 34 : SIS.row)
              .background(!g.swatches && values[g.key] == c ? SIS.selected : Color.clear)
              .overlay { if !g.swatches && values[g.key] == c { Rectangle().strokeBorder(SIS.ink, lineWidth: 2) } }
              .contentShape(.rect)
            }
            .buttonStyle(Lit())
            .accessibilityLabel(g.swatches ? "#\(c)" : c)
            .accessibilityAddTraits(values[g.key] == c ? .isSelected : [])
          }
        }
        .overlay(alignment: .bottom) { Rule() }
      }
      HStack(spacing: 8) {
        if let error {
          Stop(size: 12)
          Text(error).font(SIS.text(12)).foregroundStyle(SIS.ink).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
        } else if let g = groups.first(where: \.custom) {
          // Any other color, typed beside Set.
          if g.takes(values[g.key] ?? ""), !g.choices.contains(values[g.key] ?? "") { Swatch(color: values[g.key] ?? "") }
          TextField(
            "Hex",
            text: Binding(
              get: { g.choices.contains(values[g.key] ?? "") ? "" : values[g.key] ?? "" },
              set: { values[g.key] = $0.replacing("#", with: "").trimmingCharacters(in: .whitespaces).uppercased() }
            )
          )
          .font(SIS.data())
          .textInputAutocapitalization(.characters)
          .autocorrectionDisabled()
        } else {
          Spacer(minLength: 0)
        }
        Button {
          set()
        } label: {
          HStack(spacing: 6) {
            if pending { ProgressView().controlSize(.small).tint(.white) }
            Text("Set")
          }
        }
        .buttonStyle(KeyStyle(go: true))
        // Pending, Set stays at full strength (its spinner says so); set() ignores another press.
        .disabled(!groups.allSatisfy { $0.takes(values[$0.key] ?? "") })
      }
      .padding(.horizontal, 12)
      .frame(minHeight: SIS.row)
    }
    .frame(width: 280)
  }

  private func set() {
    guard !pending else { return }
    pending = true
    error = nil
    Task {
      do {
        try await Phone.shared.widgets.set(surface, call.tool, call.with(values.mapValues { .string($0) }))
        pending = false
        done()
      } catch {
        pending = false
        self.error = error.localizedDescription
      }
    }
  }
}

/// A line that ticks off: its ring, its name and its data. The ring calls the extension's `action`
/// with `args`; a done one's ring is filled and its name dimmed. A hairline under each.
struct CheckView: View {
  let node: Node
  @Environment(\.widgetSurface) private var surface
  @State private var pending = false
  @State private var error: String?

  var body: some View {
    let done = node.bool(for: "done") == true
    let detail = error ?? node.string(for: "detail") ?? ""
    HStack(spacing: 10) {
      Button {
        tick()
      } label: {
        Circle()
          .fill(done ? SIS.ink3 : Color.clear)
          .strokeBorder(done ? SIS.ink3 : SIS.ink2, lineWidth: 1.5)
          .frame(width: 16, height: 16)
          .frame(width: SIS.row, height: SIS.row)
          .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .disabled(pending)
      .opacity(pending ? 0.4 : 1)
      .padding(.horizontal, -(SIS.row - 16) / 2)
      .accessibilityLabel(done ? "Not done" : "Done")
      Text(node.string(for: "label") ?? "").font(SIS.text(15)).foregroundStyle(done ? SIS.ink3 : SIS.ink).lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
      if !detail.isEmpty { Figure(detail) }
    }
    .padding(.horizontal, SIS.inset)
    .frame(minHeight: SIS.row)
    .overlay(alignment: .bottom) { Hairline() }
  }

  private func tick() {
    let call = PartCall(node, surface: surface)
    pending = true
    error = nil
    Task {
      do {
        try await Phone.shared.widgets.set(surface, call.tool, call.with([:]))
      } catch {
        self.error = error.localizedDescription
      }
      pending = false
    }
  }
}

/// A line to write in: no border, its placeholder a word or two. Return calls the extension's
/// `action` with `args` and what was written under `field`, and clears it once the extension takes
/// it.
struct EntryView: View {
  let node: Node
  @Environment(\.widgetSurface) private var surface
  @State private var text = ""
  @State private var pending = false
  @State private var error: String?

  var body: some View {
    let placeholder = node.string(for: "placeholder") ?? ""
    HStack(spacing: 10) {
      TextField(placeholder, text: $text, prompt: Text(placeholder).foregroundStyle(SIS.ink3))
        .font(SIS.text(15))
        .foregroundStyle(SIS.ink)
        .tint(SIS.ink)
        .submitLabel(.done)
        .disabled(pending)
        .onSubmit(add)
        .accessibilityLabel(placeholder)
      if let error { Text(error).font(SIS.text(12)).foregroundStyle(SIS.stopped).lineLimit(1) }
    }
    .padding(.horizontal, SIS.inset)
    .frame(minHeight: SIS.row)
  }

  private func add() {
    let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !words.isEmpty, let field = node.string(for: "field") else { return }
    let call = PartCall(node, surface: surface)
    pending = true
    error = nil
    Task {
      do {
        try await Phone.shared.widgets.set(surface, call.tool, call.with([field: .string(words)]))
        text = ""
      } catch {
        self.error = error.localizedDescription
      }
      pending = false
    }
  }
}

/// What's playing (desktop's widgets/playing.tsx): its art at the leading edge, its title and who by,
/// keys back, play or pause, and next, each calling its extension's tool, and a rule along the foot
/// that runs while it plays. Paused, one quiet line: its title and the play key.
struct PlayingView: View {
  let node: Node
  @Environment(\.widgetSurface) private var surface
  @State private var pending = false
  @State private var error: String?

  private func along(_ now: Date, playing: Bool) -> Double? {
    guard let at = node.double(for: "at"), let length = node.double(for: "length"), length > 0 else { return nil }
    let ran = playing ? max(0, now.timeIntervalSince1970 * 1000 - (node.double(for: "asOf") ?? now.timeIntervalSince1970 * 1000)) : 0
    return min(1, max(0, (at + ran) / length))
  }

  private func key(_ tool: String, _ label: String, _ symbol: String) -> some View {
    Button {
      press(tool)
    } label: {
      Image(systemName: symbol).font(.system(size: 15)).foregroundStyle(SIS.ink2).frame(width: SIS.row, height: SIS.row).contentShape(.rect)
    }
    .buttonStyle(.plain)
    .disabled(pending)
    .opacity(pending ? 0.4 : 1)
    .accessibilityLabel(label)
  }

  var body: some View {
    let playing = node.bool(for: "playing") == true
    let title = node.string(for: "title") ?? ""
    if !playing {
      HStack(spacing: 8) {
        Text(title).font(SIS.text(15)).foregroundStyle(SIS.ink2).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
        key(node.string(for: "toggle") ?? "", "Play", "play.fill")
      }
      .padding(.leading, SIS.inset)
      .frame(minHeight: SIS.row)
    } else {
      TimelineView(.periodic(from: .now, by: 1)) { t in
        HStack(spacing: 0) {
          if let art = URL(string: node.string(for: "art") ?? ""), art.scheme != nil {
            AsyncImage(url: art) { $0.resizable().scaledToFill() } placeholder: { Color.clear }
              .frame(width: 56, height: 56).clipped()
          }
          VStack(alignment: .leading, spacing: 4) {
            Text(title).font(SIS.text(15)).fontWeight(.medium).foregroundStyle(SIS.ink).lineLimit(1)
            let by = error ?? node.string(for: "by") ?? ""
            if !by.isEmpty { Text(by).font(SIS.text(13)).foregroundStyle(error == nil ? SIS.ink2 : SIS.ink).lineLimit(1) }
          }
          .padding(.horizontal, SIS.inset)
          .frame(maxWidth: .infinity, alignment: .leading)
          key(node.string(for: "back") ?? "", "Back", "backward.end.fill")
          key(node.string(for: "toggle") ?? "", "Pause", "pause.fill")
          key(node.string(for: "next") ?? "", "Next", "forward.end.fill")
        }
        .frame(height: 56)
        .overlay(alignment: .bottomLeading) {
          if let done = along(t.date, playing: true) {
            GeometryReader { g in SIS.ink.frame(width: g.size.width * done, height: 2).frame(maxHeight: .infinity, alignment: .bottom) }
          }
        }
      }
    }
  }

  private func press(_ tool: String) {
    pending = true
    error = nil
    Task {
      do {
        try await Phone.shared.widgets.set(surface, tool, .object([:]))
      } catch {
        self.error = error.localizedDescription
      }
      pending = false
    }
  }
}
