import SwiftUI

// Cells a person's fields are edited in: a label over its value, edge to edge, sharing hairlines
// with the cells beside and below it.

/// Cells side by side, a hairline between them and under them all.
struct CellRow<Content: View>: View {
  @ViewBuilder let content: Content

  var body: some View {
    HStack(spacing: 0) {
      Group(subviews: content) { cells in
        ForEach(Array(cells.enumerated()), id: \.offset) { i, cell in
          if i > 0 { Rectangle().fill(SIS.hair).frame(width: SIS.hairWidth) }
          cell.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
      }
    }
    .fixedSize(horizontal: false, vertical: true)
    .overlay(alignment: .bottom) { Hairline() }
  }
}

/// A cell's label, small and in capitals.
struct CellLabel: View {
  let text: String
  init(_ text: String) { self.text = text }

  var body: some View {
    Text(text.uppercased()).font(SIS.text(SIS.Size.label, weight: .semibold)).tracking(0.6).foregroundStyle(SIS.ink3)
  }
}

/// A label over a value the person can change in place; it's committed when they leave it.
struct EditCell: View {
  let label: String
  let value: String
  var placeholder = ""
  var lines = false
  var capitalize = true
  /// The new value, trimmed, when it differs from `value`.
  let commit: (String) -> Void
  @State private var draft = ""
  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      CellLabel(label)
      TextField(placeholder, text: $draft, axis: lines ? .vertical : .horizontal)
        .font(SIS.text(15))
        .foregroundStyle(SIS.ink)
        .textInputAutocapitalization(capitalize ? .words : .sentences)
        .autocorrectionDisabled(!lines)
        .lineLimit(lines ? 1...8 : 1...1)
        .submitLabel(.done)
        .focused($focused)
        .onSubmit(save)
    }
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, SIS.cellInset)
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
    .onTapGesture { focused = true }
    .background(focused ? SIS.wash : Color.clear)
    .onAppear { draft = value }
    .onChange(of: value) { _, now in if !focused { draft = now } }
    .onChange(of: focused) { _, now in if !now { save() } }
    .onDisappear(perform: save)
  }

  private func save() {
    let v = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    if v != value { commit(v) }
  }
}

/// A type: person, company, system, or none, picked from a menu.
struct TypeCell: View {
  let value: String?
  let pick: (String?) -> Void

  var body: some View {
    Menu {
      ForEach(PersonType.all, id: \.self) { t in
        Button { pick(t) } label: { if t == value { Label(PersonType.name(t), systemImage: "checkmark") } else { Text(PersonType.name(t)) } }
      }
      Button { pick(nil) } label: { if value == nil { Label("None", systemImage: "checkmark") } else { Text("None") } }
    } label: {
      VStack(alignment: .leading, spacing: 3) {
        CellLabel("Type")
        HStack(spacing: 6) {
          Text(value.map(PersonType.name) ?? "None").font(SIS.text(15)).foregroundStyle(value == nil ? SIS.ink3 : SIS.ink)
          Spacer(minLength: 4)
          Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(SIS.ink3)
        }
      }
      .padding(.horizontal, SIS.inset)
      .padding(.vertical, SIS.cellInset)
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
    }
    .accessibilityLabel("Type, \(value.map(PersonType.name) ?? "None")")
  }
}

/// A label on a person: its name, and an × that takes it off.
struct Chip: View {
  let text: String
  let remove: () -> Void

  var body: some View {
    HStack(spacing: 6) {
      Text(text).font(SIS.text(13, weight: .medium)).foregroundStyle(SIS.ink).lineLimit(1)
      Button(action: remove) {
        Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(SIS.ink3)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Remove \(text)")
    }
    .padding(.horizontal, 9)
    .frame(height: SIS.keySmall)
    .background(SIS.wash)
    .overlay(RoundedRectangle(cornerRadius: SIS.boxRadius).stroke(SIS.hair, lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: SIS.boxRadius))
  }
}

/// Lays its parts out in lines, wrapping when a line's full.
struct Flow: Layout {
  var spacing: CGFloat = 6

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    let spots = place(subviews, width)
    let height = spots.map { $0.origin.y + $0.height }.max() ?? 0
    let used = spots.map(\.maxX).max() ?? 0
    return CGSize(width: proposal.width ?? used, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    for (spot, view) in zip(place(subviews, bounds.width), subviews) {
      view.place(at: CGPoint(x: bounds.minX + spot.minX, y: bounds.minY + spot.minY), proposal: ProposedViewSize(spot.size))
    }
  }

  private func place(_ subviews: Subviews, _ width: CGFloat) -> [CGRect] {
    var x: CGFloat = 0
    var y: CGFloat = 0
    var line: CGFloat = 0
    var spots: [CGRect] = []
    for view in subviews {
      let size = view.sizeThatFits(ProposedViewSize(width: width, height: nil))
      if x > 0 && x + size.width > width {
        x = 0
        y += line + spacing
        line = 0
      }
      spots.append(CGRect(x: x, y: y, width: min(size.width, width), height: size.height))
      x += size.width + spacing
      line = max(line, size.height)
    }
    return spots
  }
}
