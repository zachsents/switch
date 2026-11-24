import A2UICore
import A2UISwiftUI
import SwiftUI

// The basic catalog's containers: Row, Column, List, Card, Tabs, Modal and Divider. Their children
// are drawn by the SDK's ComponentNodeView, which finds each one's catalog.

/// Children across: down a cell it's a line, as a board's are (inset, a row tall, its parts 10
/// apart), and what's in it is bare; on a key, the key's words and glyphs side by side.
struct BasicRow: View {
  let node: Node
  @Environment(\.laid) private var laid
  @Environment(\.lineUp) private var lineUp
  @Environment(\.a2uiCatalogs) private var catalogs
  @Environment(\.a2uiDefaultCatalogID) private var catalog

  var body: some View {
    let children = node.renderedChildren(for: "children", in: catalogs, defaultCatalogID: catalog)
    let justify = Justify(value: node.string(for: "justify") ?? "start")
    let gap: CGFloat = laid == .key ? 6 : 10
    HStack(alignment: across(node.string(for: "align")), spacing: justify.spread ? 0 : gap) {
      if justify.leads { Spacer(minLength: 0) }
      ForEach(Array(children.enumerated()), id: \.element.id) { index, child in
        let grows = child.double(for: "weight") != nil || justify.value == "stretch"
        ComponentNodeView(node: child).frame(maxWidth: grows ? .infinity : nil, alignment: .leading)
        if justify.spread, index < children.count - 1 { Spacer(minLength: gap) }
      }
      if justify.trails { Spacer(minLength: 0) }
    }
    .environment(\.laid, laid == .key ? .key : .across)
    .placed(laid, lineUp, room: HouseBasic.keyRoom)
    .a2uiAccessibilityElement(for: node, children: .contain)
  }

  /// Its `align`, down it: a line's parts sit on its middle unless it says otherwise.
  private func across(_ align: String?) -> VerticalAlignment {
    switch align {
    case "start": .top
    case "end": .bottom
    default: .center
    }
  }
}

/// Children down, each the cell's full width, no gaps (desktop's Stack). With a Feed in it (a camera
/// and its printer), the picture comes first, edge to edge, its lines' line laid on it as its name
/// plate near the top and what they hold along its foot (desktop's index.css).
struct BasicColumn: View {
  let node: Node
  @Environment(\.laid) private var laid
  @Environment(\.a2uiCatalogs) private var catalogs
  @Environment(\.a2uiDefaultCatalogID) private var catalog

  var body: some View {
    let all = node.renderedChildren(for: "children", in: catalogs, defaultCatalogID: catalog)
    let pictured = all.contains { $0.holds("Feed") }
    let justify = Justify(value: node.string(for: "justify") ?? "start")
    let align = node.string(for: "align") ?? "stretch"
    let line = lined(align)
    let fills = align == "stretch" || laid == .down
    SwiftUI.Group {
      if pictured {
        let pictures = all.filter { $0.holds("Feed") }
        let rest = all.filter { !$0.holds("Feed") }
        // Everything its lines say is laid on the picture: the name plate near the top, what they
        // hold along its foot, so nothing reads as the next cell's.
        ZStack(alignment: .topLeading) {
          VStack(spacing: 0) {
            ForEach(pictures, id: \.id) { ComponentNodeView(node: $0) }
          }
          VStack(alignment: .leading, spacing: 0) {
            ForEach(rest.filter { $0.holds("Row") }, id: \.id) { ComponentNodeView(node: $0) }
          }
          .environment(\.plate, .tab)
          .padding(.top, 8)
          .padding(.trailing, 8)
          VStack(spacing: 0) {
            ForEach(rest, id: \.id) { child in
              ComponentNodeView(node: child)
                .frame(maxWidth: .infinity)
                .environment(\.plate, child.holds("Row") ? .under : .none)
            }
          }
          .background(Color.black)
          .environment(\.colorScheme, .dark)
          .frame(maxHeight: .infinity, alignment: .bottom)
        }
      } else {
        VStack(alignment: line, spacing: 0) {
          if justify.leads { Spacer(minLength: 0) }
          ForEach(Array(all.enumerated()), id: \.element.id) { index, child in
            ComponentNodeView(node: child)
              .frame(maxWidth: fills ? .infinity : nil, alignment: Alignment(horizontal: line, vertical: .center))
            if justify.spread, index < all.count - 1 { Spacer(minLength: 0) }
          }
          if justify.trails { Spacer(minLength: 0) }
        }
      }
    }
    .frame(maxWidth: laid == .key ? nil : .infinity, alignment: Alignment(horizontal: line, vertical: .center))
    .environment(\.lineUp, line)
    .a2uiAccessibilityElement(for: node, children: .contain)
  }
}

/// Lines (desktop's Lines): children down, each the full width, no rules between; across for
/// `horizontal`, scrolling sideways as old Switchboard's did.
struct BasicList: View {
  let node: Node
  @Environment(\.laid) private var laid
  @Environment(\.a2uiCatalogs) private var catalogs
  @Environment(\.a2uiDefaultCatalogID) private var catalog

  var body: some View {
    let children = node.renderedChildren(for: "children", in: catalogs, defaultCatalogID: catalog)
    let align = node.string(for: "align")
    if node.string(for: "direction") == "horizontal" {
      ScrollView(.horizontal) {
        HStack(alignment: align == "start" ? .top : align == "end" ? .bottom : .center, spacing: SIS.gapWide) {
          ForEach(children, id: \.id) { ComponentNodeView(node: $0) }
        }
        .padding(.horizontal, laid == .down ? SIS.inset : 0)
        .padding(.vertical, laid == .down ? HouseBasic.keyRoom : 0)
      }
      .scrollIndicators(.hidden)
      .environment(\.laid, .across)
      .a2uiAccessibilityElement(for: node, children: .contain)
    } else {
      let line = lined(align)
      VStack(alignment: line, spacing: 0) {
        ForEach(children, id: \.id) { child in
          ComponentNodeView(node: child).frame(maxWidth: .infinity, alignment: Alignment(horizontal: line, vertical: .center))
        }
      }
      .frame(maxWidth: .infinity)
      .environment(\.lineUp, line)
      .a2uiAccessibilityElement(for: node, children: .contain)
    }
  }
}

/// Its child, edge to edge: the cell is its frame, no box round it.
struct BasicCard: View {
  let node: Node

  var body: some View {
    if let child = node.child(for: "child") {
      ComponentNodeView(node: child)
        .frame(maxWidth: .infinity, alignment: .leading)
        .a2uiAccessibilityElement(for: node, children: .contain)
    }
  }
}

/// Titled pages, one showing: the titles as a segmented control on a row, the page under it.
struct BasicTabs: View {
  let node: Node
  @State private var showing = 0

  private struct Page {
    let title: String
    let child: Node?
  }

  private var pages: [Page] {
    (node.array(for: "tabs") ?? []).enumerated().map { index, element in
      let tab = element as? ResolvedDictionary
      let title = (tab?["title"] as? String) ?? (tab?["title"] as? DataBinding<String>)?.value ?? "\(index + 1)"
      let child = (tab?["child"] as? Node) ?? node.allChildNodes.first { $0.id == (tab?["child"] as? String) }
      return Page(title: title, child: child)
    }
  }

  var body: some View {
    let pages = pages
    VStack(alignment: .leading, spacing: 0) {
      Segments(titles: pages.map(\.title), chosen: $showing)
        .onLine(.leading, room: HouseBasic.keyRoom)
        .accessibilityIdentifier("a2ui-\(node.id)-tabs")
      if pages.indices.contains(showing), let child = pages[showing].child {
        ComponentNodeView(node: child).frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .environment(\.laid, .down)
    .environment(\.lineUp, .leading)
  }
}

/// One choice of a few, side by side (desktop's Segmented): equal widths and heights, one rule
/// round them and between them, the chosen one in the selection's wash, its words in ink. Choosing
/// moves nothing.
struct Segments: View {
  let titles: [String]
  @Binding var chosen: Int

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: SIS.controlRadius, style: .continuous)
    HStack(spacing: 0) {
      ForEach(Array(titles.enumerated()), id: \.offset) { index, title in
        if index > 0 { Rectangle().fill(SIS.rule).frame(width: SIS.line) }
        Button {
          chosen = index
        } label: {
          Text(title)
            .font(SIS.text(13, weight: .medium))
            .foregroundStyle(index == chosen ? SIS.ink : SIS.ink2)
            .lineLimit(1)
            .padding(.horizontal, SIS.gap)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(index == chosen ? SIS.selected : Color.clear)
            .contentShape(.rect)
        }
        .buttonStyle(Lit())
        .accessibilityAddTraits(index == chosen ? .isSelected : [])
      }
    }
    .frame(height: SIS.key)
    .clipShape(shape)
    .overlay(shape.strokeBorder(SIS.rule, lineWidth: SIS.line))
    .accessibilityElement(children: .contain)
    .accessibilityAddTraits(.isTabBar)
  }
}

/// A trigger that opens its content in a sheet: a Button trigger opens it as well as running its
/// action; anything else opens it on a tap. Swiped down, it closes.
struct BasicModal: View {
  let node: Node
  @State private var open = false

  var body: some View {
    Group {
      if let trigger = node.child(for: "trigger") {
        if trigger.type == "Button" {
          ComponentNodeView(node: trigger).environment(\.openModal) { open = true }
        } else {
          ComponentNodeView(node: trigger)
            .contentShape(.rect)
            .onTapGesture { open = true }
            .accessibilityAddTraits(.isButton)
        }
      }
    }
    .sheet(isPresented: $open) {
      ScrollView {
        if let content = node.child(for: "content") {
          ComponentNodeView(node: content).frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .padding(.top, SIS.gap)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .background(SIS.paper)
      .environment(\.openModal, nil)
      .environment(\.laid, .down)
      .environment(\.lineUp, .leading)
      .presentationDetents([.medium, .large])
      .presentationCornerRadius(SIS.radius)
    }
  }
}

/// A hairline, across the cell edge to edge, or down.
struct BasicDivider: View {
  let node: Node

  var body: some View {
    if node.string(for: "axis") == "vertical" {
      Rectangle().fill(SIS.hair).frame(width: SIS.hairWidth).frame(maxHeight: .infinity)
    } else {
      Hairline().frame(maxWidth: .infinity)
    }
  }
}
