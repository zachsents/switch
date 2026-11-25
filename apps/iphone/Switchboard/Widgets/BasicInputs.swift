import A2UICore
import A2UISwiftUI
import SwiftUI

// The basic catalog's inputs: Button, TextField, CheckBox, ChoicePicker, Slider and DateTimeInput,
// as old Switchboard's iPhone app drew them. Each writes the widget's data model the moment it
// changes (its `value` binding), as BasicCatalogSwiftUI's do, so what's bound to it follows at
// once; each shows its checks' first message under it.

/// A key: raised, `primary` the green one, `borderless` its words alone. It runs its action, and
/// opens the Modal it triggers.
struct BasicButton: View {
  let node: Node
  @Environment(\.openModal) private var openModal
  @Environment(\.laid) private var laid
  @Environment(\.lineUp) private var lineUp

  var body: some View {
    if let child = node.child(for: "child"), Self.isPicture(child) {
      // A picture in it (a page's, opening the page) is the key itself: edge to edge as an Image
      // is, pressed anywhere on it, never a key's face.
      Button {
        node.action(for: "action", userActivation: true)?()
        openModal?()
      } label: {
        ComponentNodeView(node: child)
      }
      .buttonStyle(PictureKey())
      .disabled(!node.isValid || node.bool(for: "disabled") == true)
      .accessibilityIdentifier("a2ui-\(node.id)")
    } else {
      key
    }
  }

  /// A picture as wide as its cell: an Image of no small variant.
  private static func isPicture(_ child: Node) -> Bool {
    child.type == "Image" && !["icon", "avatar", "smallFeature"].contains(child.string(for: "variant") ?? "")
  }

  private var key: some View {
    styled(
      Button {
        node.action(for: "action", userActivation: true)?()
        openModal?()
      } label: {
        if let child = node.child(for: "child") { ComponentNodeView(node: child) }
      }
      // What it holds reads in the key's face and colors.
      .environment(\.laid, .key)
    )
    .disabled(!node.isValid || node.bool(for: "disabled") == true)
    .accessibilityIdentifier("a2ui-\(node.id)")
    .placed(laid, lineUp, room: HouseBasic.keyRoom)
  }

  @ViewBuilder private func styled(_ key: some View) -> some View {
    switch node.string(for: "variant") {
    case "primary": key.buttonStyle(KeyStyle(go: true))
    case "borderless": key.buttonStyle(QuietKey())
    default: key.buttonStyle(KeyStyle())
    }
  }
}

/// A key that's a picture: the picture as it is, dimmed while held.
struct PictureKey: ButtonStyle {
  @Environment(\.isEnabled) private var enabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .contentShape(.rect)
      .opacity(!enabled ? 0.4 : configuration.isPressed ? 0.85 : 1)
  }
}

/// A key that's its words alone, underlined, in a key's face; it fades while pressed (old
/// Switchboard's quiet key).
struct QuietKey: ButtonStyle {
  @Environment(\.isEnabled) private var enabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(SIS.text(13, weight: .medium))
      .foregroundStyle(SIS.ink)
      .underline()
      .frame(minHeight: SIS.key)
      .contentShape(.rect)
      .opacity(!enabled ? 0.4 : configuration.isPressed ? 0.6 : 1)
  }
}

/// Words typed into the inset box.
struct BasicTextField: View {
  let node: Node
  @Environment(\.laid) private var laid
  @Environment(\.lineUp) private var lineUp

  var body: some View {
    let value = node.binding(for: "value", default: "")
    let prompt = node.string(for: "placeholder").map { Text($0).foregroundStyle(SIS.ink3) }
    let label = node.string(for: "label") ?? ""
    Labeled(node: node) {
      Group {
        switch node.string(for: "variant") {
        case "obscured": SecureField(label, text: value, prompt: prompt)
        case "longText": TextField(label, text: value, prompt: prompt, axis: .vertical).lineLimit(3...8).padding(.vertical, SIS.cellInset)
        case "number": TextField(label, text: value, prompt: prompt).keyboardType(.decimalPad)
        default: TextField(label, text: value, prompt: prompt)
        }
      }
      .font(SIS.text(SIS.Size.control + 1))
      .foregroundStyle(SIS.ink)
      .tint(SIS.ink)
      .field(error: !node.validationErrors.isEmpty)
      .accessibilityIdentifier("a2ui-\(node.id)")
      .a2uiAccessibilityControl(for: node, defaultLabel: label)
    }
    .placed(laid, lineUp, room: SIS.gap)
  }
}

/// A box and its words; the whole line is the tap.
struct BasicCheckBox: View {
  let node: Node
  @Environment(\.laid) private var laid
  @Environment(\.lineUp) private var lineUp

  var body: some View {
    let on = node.binding(for: "value", default: false)
    let label = node.string(for: "label") ?? ""
    VStack(alignment: .leading, spacing: SIS.gap / 2) {
      Button {
        on.wrappedValue.toggle()
      } label: {
        HStack(spacing: 10) {
          CheckSquare(on: on.wrappedValue, error: !node.isValid)
          if !label.isEmpty { Text(label).font(SIS.text(SIS.Size.body)).foregroundStyle(SIS.ink) }
        }
        .frame(maxWidth: laid == .down ? .infinity : nil, minHeight: laid == .down ? SIS.row : SIS.key, alignment: .leading)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityRepresentation { Toggle(label, isOn: on) }
      .accessibilityIdentifier("a2ui-\(node.id)")
      .a2uiAccessibilityControl(for: node)
      if let error = node.validationErrors.first { CheckNote(text: error, error: true) }
    }
    .placed(laid, lineUp, room: 0)
  }
}

/// Options to pick one of (round marks) or several of (boxes), a line each, or as chips; a
/// filterable one has a box to type in above them.
struct BasicChoicePicker: View {
  let node: Node
  @State private var filter = ""
  @State private var picked: [String] = []
  @Environment(\.laid) private var laid
  @Environment(\.lineUp) private var lineUp

  private struct Option: Identifiable {
    var id: String { value }
    let label: String
    let value: String
  }

  private var options: [Option] {
    (node.array(for: "options") ?? []).enumerated().compactMap { index, element in
      if let word = element as? String { return Option(label: word, value: word) }
      guard let option = element as? ResolvedDictionary else { return nil }
      let label = (option["label"] as? String) ?? (option["label"] as? DataBinding<String>)?.value ?? ""
      let value = (option["value"] as? String) ?? (option["value"] as? DataBinding<String>)?.value ?? "\(index)"
      return Option(label: label, value: value)
    }
  }

  private var one: Bool { node.string(for: "variant") != "multipleSelection" }

  private var selected: [String] {
    if let list = node.dataBinding(for: "value") as DataBinding<[String]>? { return list.value ?? picked }
    if let word = node.dataBinding(for: "value") as DataBinding<String>? { return word.value.map { [$0] } ?? picked }
    return picked
  }

  private func pick(_ value: String) {
    let now = one ? [value] : selected.contains(value) ? selected.filter { $0 != value } : selected + [value]
    if let list = node.dataBinding(for: "value") as DataBinding<[String]>? {
      list.set(now)
    } else if let word = node.dataBinding(for: "value") as DataBinding<String>? {
      word.set(now.first ?? "")
    } else {
      picked = now
    }
  }

  var body: some View {
    let shown = options.filter { filter.isEmpty || $0.label.localizedCaseInsensitiveContains(filter) }
    Labeled(node: node) {
      VStack(alignment: .leading, spacing: SIS.gap) {
        if node.bool(for: "filterable") == true {
          TextField("Filter", text: $filter).font(SIS.text(SIS.Size.control)).tint(SIS.ink).field()
        }
        if node.string(for: "displayStyle") == "chips" {
          ScrollView(.horizontal) {
            HStack(spacing: SIS.gap - 2) { ForEach(shown) { chip($0) } }
          }
          .scrollIndicators(.hidden)
        } else {
          VStack(alignment: .leading, spacing: 0) { ForEach(shown) { line($0) } }
        }
      }
    }
    .placed(laid, lineUp, room: SIS.gap)
    .a2uiAccessibilityElement(for: node, children: .contain)
    .accessibilityIdentifier("a2ui-\(node.id)")
  }

  private func line(_ option: Option) -> some View {
    let on = selected.contains(option.value)
    return Button {
      pick(option.value)
    } label: {
      HStack(spacing: 10) {
        if one {
          Circle().strokeBorder(on ? SIS.ink : SIS.Box.border, lineWidth: on ? SIS.checkbox * 0.3 : SIS.line)
            .background(Circle().fill(SIS.paper))
            .frame(width: SIS.checkbox, height: SIS.checkbox)
        } else {
          CheckSquare(on: on)
        }
        Text(option.label).font(SIS.text(SIS.Size.body)).foregroundStyle(SIS.ink)
      }
      .frame(maxWidth: .infinity, minHeight: SIS.row - SIS.gap, alignment: .leading)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(on ? .isSelected : [])
    .accessibilityIdentifier("a2ui-\(node.id)-\(option.value)")
  }

  private func chip(_ option: Option) -> some View {
    let on = selected.contains(option.value)
    let shape = RoundedRectangle(cornerRadius: SIS.controlRadius, style: .continuous)
    return Button(option.label) { pick(option.value) }
      .font(SIS.text(SIS.Size.caption + 0.5, weight: on ? .semibold : .regular))
      .foregroundStyle(on ? SIS.paper : SIS.ink)
      .padding(.horizontal, SIS.gap + 2)
      .frame(height: SIS.key - 6)
      .background(on ? SIS.ink : SIS.paper, in: shape)
      .overlay(shape.strokeBorder(on ? SIS.ink : SIS.rule, lineWidth: SIS.line))
      .buttonStyle(.plain)
      .accessibilityAddTraits(on ? .isSelected : [])
      .accessibilityIdentifier("a2ui-\(node.id)-\(option.value)")
  }
}

/// A number picked along a track, the number as a figure beside it.
struct BasicSlider: View {
  let node: Node
  @Environment(\.laid) private var laid
  @Environment(\.lineUp) private var lineUp

  var body: some View {
    let low = node.double(for: "min") ?? 0
    let high = max(low + 0.001, node.double(for: "max") ?? 100)
    let value = node.binding(for: "value", default: low)
    let step = node.int(for: "steps").flatMap { $0 > 0 ? (high - low) / Double($0) : nil }
    let shown = Int(exactly: value.wrappedValue).map(String.init) ?? String(format: "%.1f", value.wrappedValue)
    Labeled(node: node) {
      HStack(spacing: 10) {
        Group {
          if let step {
            Slider(value: value, in: low...high, step: step)
          } else {
            Slider(value: value, in: low...high)
          }
        }
        .tint(SIS.ink)
        .accessibilityValue(shown)
        Text(shown).font(SIS.number(SIS.Size.stub)).foregroundStyle(SIS.ink).frame(minWidth: SIS.avatar, alignment: .trailing)
      }
      .accessibilityIdentifier("a2ui-\(node.id)")
      .a2uiAccessibilityControl(for: node, defaultLabel: node.string(for: "label"))
    }
    .placed(laid, lineUp, room: SIS.gap)
  }
}

/// A date, a time or both, the system's picker in ink; kept in the data model as ISO 8601 text.
struct BasicDateTimeInput: View {
  let node: Node
  @State private var fallback = Date()
  @Environment(\.laid) private var laid
  @Environment(\.lineUp) private var lineUp

  var body: some View {
    let date = node.bool(for: "enableDate") ?? false
    let time = node.bool(for: "enableTime") ?? false
    let parts: DatePickerComponents = date && time ? [.date, .hourAndMinute] : time ? .hourAndMinute : .date
    let low = node.string(for: "min").flatMap(Stamp.read)?.date
    let high = node.string(for: "max").flatMap(Stamp.read)?.date
    let selection = Binding<Date>(
      get: { node.string(for: "value").flatMap(Stamp.read)?.date ?? fallback },
      set: { picked in
        fallback = picked
        (node.dataBinding(for: "value") as DataBinding<String>?)?
          .set(Stamp.write(picked, date: date, time: time, like: node.string(for: "value")))
      })
    Labeled(node: node) {
      Group {
        switch (low, high) {
        case (let low?, let high?) where low <= high: DatePicker("", selection: selection, in: low...high, displayedComponents: parts)
        case (let low?, _): DatePicker("", selection: selection, in: low..., displayedComponents: parts)
        case (_, let high?): DatePicker("", selection: selection, in: ...high, displayedComponents: parts)
        default: DatePicker("", selection: selection, displayedComponents: parts)
        }
      }
      .labelsHidden()
      .tint(SIS.ink)
      .accessibilityIdentifier("a2ui-\(node.id)")
      .a2uiAccessibilityControl(for: node, defaultLabel: node.string(for: "label"))
    }
    .placed(laid, lineUp, room: SIS.gap)
  }
}

/// A DateTimeInput's value: ISO 8601 text (`2026-11-13`, `09:50`, `2026-11-13T09:50:00Z`), read in
/// its own zone and written back in the shape it came in, as BasicCatalogSwiftUI's are; a new
/// date and time goes as UTC.
enum Stamp {
  struct Read {
    let date: Date
    let format: String
    let zone: String
  }

  private static let formats = [
    "yyyy-MM-dd'T'HH:mm:ss.SSS", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd", "HH:mm:ss", "HH:mm",
  ]

  static func read(_ text: String) -> Read? {
    var body = text.trimmingCharacters(in: .whitespaces)
    var zone = ""
    if body.contains("T") || body.contains("t") {
      body = body.replacingOccurrences(of: "t", with: "T")
      if body.hasSuffix("Z") || body.hasSuffix("z") {
        zone = "Z"
        body.removeLast()
      } else if let offset = body.firstMatch(of: /[+-]\d{2}(?::?\d{2})?$/), body[..<offset.range.lowerBound].contains("T") {
        zone = String(offset.output)
        body.removeSubrange(offset.range)
      }
    }
    guard let timeZone = timeZone(zone) else { return nil }
    for format in formats {
      let formatter = formatter(format, timeZone)
      // Whole and exact: a formatter rolls `24:00` and `02-30` over, which writing it back catches.
      if let date = formatter.date(from: body), formatter.string(from: date) == body {
        return Read(date: date, format: format, zone: zone)
      }
    }
    return nil
  }

  static func write(_ date: Date, date withDate: Bool, time withTime: Bool, like previous: String?) -> String {
    let before = previous.flatMap(read)
    switch (withDate, withTime) {
    case (true, true):
      let kept = before.flatMap { $0.format.contains("T") ? $0 : nil }
      let format = kept?.format ?? "yyyy-MM-dd'T'HH:mm:ss"
      let zone = kept?.zone ?? "Z"
      return formatter(format, timeZone(zone) ?? .gmt).string(from: date) + zone
    case (false, true):
      let seconds = before.map { $0.format.contains("ss") } ?? true
      return formatter(seconds ? "HH:mm:ss" : "HH:mm", .current).string(from: date)
    default:
      return formatter("yyyy-MM-dd", .current).string(from: date)
    }
  }

  /// Local time for none, UTC for `Z`, else the offset (`+02:00`, `+0200`, `+02`).
  private static func timeZone(_ zone: String) -> TimeZone? {
    if zone.isEmpty { return .current }
    if zone == "Z" { return .gmt }
    let digits = zone.dropFirst().replacingOccurrences(of: ":", with: "")
    let rest = digits.dropFirst(2)
    guard let hours = Int(digits.prefix(2)), let minutes = rest.isEmpty ? 0 : Int(rest), hours <= 18, minutes < 60 else { return nil }
    let seconds = (hours * 60 + minutes) * 60
    return TimeZone(secondsFromGMT: zone.hasPrefix("-") ? -seconds : seconds)
  }

  private static func formatter(_ format: String, _ zone: TimeZone) -> DateFormatter {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.timeZone = zone
    formatter.dateFormat = format
    return formatter
  }
}

/// A label over an input, and its checks' message under it.
struct Labeled<Content: View>: View {
  let node: Node
  @ViewBuilder let content: Content

  var body: some View {
    let error = node.validationErrors.first
    let hint = node.validationResults.first { $0.severity != .error }?.message
    VStack(alignment: .leading, spacing: SIS.gap / 2 + 1) {
      if let label = node.string(for: "label"), !label.isEmpty {
        Text(label).font(SIS.text(SIS.Size.label)).foregroundStyle(SIS.ink3).lineLimit(1).accessibilityHidden(true)
      }
      content
      if let note = error ?? hint { CheckNote(text: note, error: error != nil) }
    }
  }
}

/// A check's message under an input: a red octagon for an error, the hand for a warning.
struct CheckNote: View {
  let text: String
  let error: Bool

  var body: some View {
    HStack(spacing: SIS.gap / 2 + 1) {
      if error { Stop(size: SIS.mark - 1) } else { Hand(size: SIS.mark - 1) }
      Text(text).font(SIS.text(SIS.Size.caption)).foregroundStyle(error ? SIS.ink : SIS.ink2)
    }
  }
}

/// A checkbox's box: a small raised key when empty, ink with a tick when on.
struct CheckSquare: View {
  let on: Bool
  var error = false

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: SIS.boxRadius, style: .continuous)
    Group {
      if on {
        shape.fill(SIS.ink).overlay(CheckTick().stroke(SIS.paper, style: StrokeStyle(lineWidth: SIS.glyph * SIS.checkbox / 16, lineCap: .round, lineJoin: .round)))
      } else {
        shape.fill(LinearGradient(colors: [SIS.Box.top, SIS.Box.bottom], startPoint: .top, endPoint: .bottom))
          .overlay(shape.strokeBorder(error ? SIS.stopped : SIS.Box.border, lineWidth: SIS.line))
          .background(shape.fill(SIS.Key.edge.opacity(0.5)).offset(y: SIS.line))
      }
    }
    .frame(width: SIS.checkbox, height: SIS.checkbox)
  }
}

/// A box's tick, on the marks' 16-unit grid.
nonisolated private struct CheckTick: Shape {
  func path(in rect: CGRect) -> Path {
    let k = min(rect.width, rect.height) / 16
    return Path { p in
      p.move(to: CGPoint(x: rect.minX + 4.7 * k, y: rect.minY + 8.1 * k))
      p.addLine(to: CGPoint(x: rect.minX + 6.9 * k, y: rect.minY + 10.3 * k))
      p.addLine(to: CGPoint(x: rect.minX + 11.3 * k, y: rect.minY + 5.9 * k))
    }
  }
}

extension View {
  /// The box a person types in: flat, inside its hairline border (no shade).
  func field(error: Bool = false) -> some View {
    let shape = RoundedRectangle(cornerRadius: SIS.fieldRadius, style: .continuous)
    return padding(.horizontal, SIS.cellInset + 2)
      .frame(minHeight: SIS.fieldHeight)
      .background(shape.fill(SIS.Field.fill))
      .overlay(shape.strokeBorder(error ? SIS.stopped : SIS.Field.border, lineWidth: SIS.line))
  }
}
