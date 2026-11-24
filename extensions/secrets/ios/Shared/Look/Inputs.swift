import SwiftUI

/// The search box: inset, the whole cell across the page.
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

/// The box a person types in, inset: its look round any field.
struct Inset: ViewModifier {
  var height: CGFloat? = SIS.fieldHeight

  func body(content: Content) -> some View {
    content
      .font(SIS.text(16))
      .foregroundStyle(SIS.ink)
      .padding(.horizontal, 12)
      .padding(.vertical, height == nil ? 10 : 0)
      .frame(minHeight: height)
      .background(RoundedRectangle(cornerRadius: SIS.fieldRadius).fill(SIS.Field.fill))
      .overlay(RoundedRectangle(cornerRadius: SIS.fieldRadius).stroke(SIS.Field.border, lineWidth: 1))
  }
}

extension View {
  func inset(height: CGFloat? = SIS.fieldHeight) -> some View { modifier(Inset(height: height)) }
}

/// A small key with a symbol: copy, reveal, generate.
struct IconKey: View {
  let symbol: String
  let label: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: 13, weight: .semibold)).frame(width: 18)
    }
    .buttonStyle(KeyStyle())
    .accessibilityLabel(label)
  }
}

/// An item in a list: its kind's symbol, its title, and its username or the like at the end.
struct ItemRow: View {
  let item: Item
  let action: () -> Void

  var body: some View {
    RowButton(action: action) {
      Image(systemName: item.kind.symbol).font(.system(size: 14)).foregroundStyle(SIS.ink2).frame(width: 20)
      Text(item.title.isEmpty ? item.name : item.title).lineLimit(1)
      Spacer(minLength: 8)
      Figure(item.detail)
    }
  }
}

/// A one-time code: its digits, large, and the seconds it has left.
struct CodeView: View {
  let totp: TOTP
  var size: CGFloat = 28

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { t in
      let code = totp.code(at: t.date)
      let half = code.count / 2
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Text("\(code.prefix(half)) \(code.dropFirst(half))").font(SIS.number(size)).foregroundStyle(SIS.ink)
        Text("\(totp.left(at: t.date))").font(SIS.data(12)).foregroundStyle(totp.left(at: t.date) <= 5 ? SIS.running : SIS.ink3)
      }
    }
  }
}
