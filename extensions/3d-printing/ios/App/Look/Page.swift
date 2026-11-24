import SwiftUI

// What every page shares: the black band (the system's navigation bar, its title in the sign face),
// a line saying the core is down or a call failed, and the page reported as seen.

extension View {
  /// The page's band: black, its title in capitals in the sign face.
  func band(_ title: String) -> some View {
    navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbarBackground(SIS.band, for: .navigationBar)
      .toolbarBackground(.visible, for: .navigationBar)
      .toolbarColorScheme(.dark, for: .navigationBar)
      .toolbar {
        ToolbarItem(placement: .principal) {
          Text(title.uppercased()).font(SIS.sign(22)).tracking(0.5).foregroundStyle(SIS.bandInk).lineLimit(1)
        }
      }
  }

  /// Reports the page as seen, and as backed out of or dwelled on when it goes.
  func seen(_ core: Core, _ surface: String, _ item: String = "") -> some View {
    modifier(Seen(core: core, surface: surface, item: item))
  }
}

private struct Seen: ViewModifier {
  let core: Core
  let surface: String
  let item: String
  @State private var opened = Date()

  func body(content: Content) -> some View {
    content
      .onAppear {
        opened = Date()
        core.viewed(surface, item)
      }
      .onDisappear { core.left(surface, item, opened: opened) }
  }
}

/// A line across the page saying what's wrong: the core down, or what a call said.
struct Problem: View {
  let text: String

  var body: some View {
    HStack(spacing: 8) {
      Stop(size: 12)
      Text(text).font(SIS.text(13)).foregroundStyle(SIS.ink).lineLimit(3)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, 9)
    .frame(minHeight: 36)
    .overlay(alignment: .bottom) { Rule() }
  }
}

/// The core's link, when it's down.
struct Down: View {
  let core: Core

  var body: some View {
    if !core.configured {
      Problem(text: "No core set")
    } else if core.link == .down {
      Problem(text: "Can't reach the core")
    }
  }
}

/// Nothing to show: a word or two, centred in what's left.
struct Empty: View {
  let text: String
  init(_ text: String) { self.text = text }

  var body: some View {
    Text(text).font(SIS.text(14)).foregroundStyle(SIS.ink3)
      .frame(maxWidth: .infinity, minHeight: 120)
  }
}

/// A label over its value, as a grid cell.
struct Field: View {
  let label: String
  let value: String
  var mono = false

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(label.uppercased()).font(SIS.text(SIS.Size.label, weight: .semibold)).tracking(0.6).foregroundStyle(SIS.ink3)
      Text(value).font(mono ? SIS.data(14) : SIS.text(15)).foregroundStyle(SIS.ink).textSelection(.enabled)
    }
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, SIS.cellInset)
    .frame(maxWidth: .infinity, alignment: .leading)
    .overlay(alignment: .bottom) { Hairline() }
  }
}
