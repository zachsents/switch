import SwiftUI

// The grid's parts (apps/desktop/src/mainview/ui/parts.tsx): a section under a heavy rule, its
// heading, its lines on hairlines; keys; figures.

/// A section of the board: a heavy rule, its heading, then its lines.
struct BoardSection<Content: View>: View {
  var mark: AnyView?
  let label: String
  var count: Int?
  var first = false
  @ViewBuilder let content: Content

  private var heading: some View {
    HStack(spacing: 8) {
      if let mark { mark }
      Text(label.uppercased()).font(SIS.text(12, weight: .semibold)).tracking(0.7).foregroundStyle(SIS.ink)
      Spacer(minLength: 8)
      if let count, count > 0 { Text("\(count)").font(SIS.text(12)).foregroundStyle(SIS.ink3) }
    }
    .padding(.horizontal, SIS.inset)
    .frame(height: 42)
  }

  var body: some View {
    VStack(spacing: 0) {
      if !first { Rectangle().fill(SIS.heavy).frame(height: SIS.heavyWidth) }
      heading
      content
    }
  }
}

/// A line: the whole line is the tap, lit while pressed, a hairline under it.
struct RowButton<Content: View>: View {
  let action: () -> Void
  @ViewBuilder let content: Content

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) { content }
        .font(SIS.text(15))
        .foregroundStyle(SIS.ink)
        .padding(.horizontal, SIS.inset)
        .frame(maxWidth: .infinity, minHeight: SIS.row, alignment: .leading)
        .contentShape(Rectangle())
    }
    .buttonStyle(Lit())
    .overlay(alignment: .bottom) { Hairline() }
  }
}

/// Pressed is the selection's wash, at once: nothing moves.
struct Lit: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.background(configuration.isPressed ? SIS.selected : Color.clear)
  }
}

struct Hairline: View {
  var body: some View { Rectangle().fill(SIS.hair).frame(height: SIS.hairWidth) }
}

struct Rule: View {
  var body: some View { Rectangle().fill(SIS.rule).frame(height: SIS.line) }
}

/// Figures at a line's end: when, how many.
struct Figure: View {
  let text: String
  init(_ text: String) { self.text = text }
  var body: some View { Text(text).font(SIS.text(12)).foregroundStyle(SIS.ink3).lineLimit(1) }
}

/// A key, lit from above in its border (no shadow), sinking a point when pressed; `go` is the green one that sends.
struct KeyStyle: ButtonStyle {
  var go = false
  @Environment(\.isEnabled) private var enabled

  func makeBody(configuration: Configuration) -> some View {
    let pressed = configuration.isPressed
    configuration.label
      .font(SIS.text(13, weight: .medium))
      .foregroundStyle(go ? Color.white : SIS.ink)
      .padding(.horizontal, 12)
      .frame(height: SIS.key)
      .background(
        RoundedRectangle(cornerRadius: SIS.controlRadius)
          .fill(LinearGradient(colors: go ? [SIS.Key.goTop, SIS.Key.goBottom] : [SIS.Key.top, SIS.Key.bottom], startPoint: .top, endPoint: .bottom))
      )
      .overlay(RoundedRectangle(cornerRadius: SIS.controlRadius).stroke(go ? SIS.Key.goBorder : SIS.Key.border, lineWidth: 1))
      .offset(y: pressed ? SIS.sink : 0)
      .opacity(enabled ? 1 : 0.4)
  }
}

/// What floats in a popover (a Pick's choices, a note): paper inside a rule, never a shadow. The
/// system's popover chrome casts one of its own, so its layers' shadows are cleared and the rounded
/// layer that clips the content takes the rule as its border.
extension View {
  func float() -> some View {
    presentationCompactAdaptation(.popover)
      .presentationBackground(SIS.paper)
      .background(NoShadow())
  }
}

private struct NoShadow: UIViewRepresentable {
  func makeUIView(context: Context) -> Chrome { Chrome() }
  func updateUIView(_ view: Chrome, context: Context) { view.setNeedsLayout() }

  final class Chrome: UIView {
    override func didMoveToWindow() {
      super.didMoveToWindow()
      clear()
    }

    override func layoutSubviews() {
      super.layoutSubviews()
      clear()
    }

    private func clear() {
      isUserInteractionEnabled = false
      var bordered = false
      var view = superview
      while let v = view, !(v is UIWindow) {
        v.layer.shadowOpacity = 0
        v.layer.shadowPath = nil
        if !bordered, v.layer.cornerRadius > 0, v.layer.masksToBounds || v.clipsToBounds {
          v.layer.borderWidth = SIS.line
          v.layer.borderColor = UIColor(SIS.rule).resolvedColor(with: traitCollection).cgColor
          bordered = true
        }
        view = v.superview
      }
    }
  }
}

/// When, as a clock: "3:40 PM".
func clock(_ ms: Double) -> String {
  Date(timeIntervalSince1970: ms / 1000).formatted(date: .omitted, time: .shortened)
}

/// How long, to the minute: "1:05".
func span(_ ms: Double) -> String {
  let minutes = Int((ms / 60_000).rounded())
  return "\(minutes / 60):\(String(format: "%02d", minutes % 60))"
}
