import SwiftUI

/// What the list is narrowed to.
enum Filter: Hashable {
  case all, favorites, trash
  case kind(Kind)
  case tag(String)
  case folder(String)

  var label: String {
    switch self {
    case .all: "All"
    case .favorites: "Favorites"
    case .trash: "Trash"
    case .kind(let k): k.label
    case .tag(let t): "#\(t)"
    case .folder(let f): f
    }
  }

  func admits(_ item: Item) -> Bool {
    if self == .trash { return item.trashed > 0 }
    guard item.trashed == 0 else { return false }
    switch self {
    case .all, .trash: return true
    case .favorites: return item.favorite
    case .kind(let k): return item.kind == k
    case .tag(let t): return item.tags.contains(t)
    case .folder(let f): return item.folder == f || item.folder.hasPrefix("\(f)/")
    }
  }
}

/// The root: every item, searched and filtered, favorites first.
struct ListView: View {
  let model: Model
  @State private var query = ""
  @State private var filter: Filter = .all
  @FocusState private var typing: Bool

  private var vault: Vault { model.vault }

  private var shown: [Item] {
    let words = query.lowercased().split(separator: " ").map(String.init)
    return vault.items.filter { item in
      guard filter.admits(item) else { return false }
      guard !words.isEmpty else { return true }
      let hay = ([item.title, item.name, item.username, item.folder] + item.tags + item.urls.map(\.url)).joined(separator: " ").lowercased()
      return words.allSatisfy(hay.contains)
    }
  }

  private var pending: Int { (vault.devices + vault.extensions).filter(\.pending).count }

  var body: some View {
    VStack(spacing: 0) {
      Down(core: model.core)
      if let problem = vault.problem { Problem(text: problem) }
      SearchField(text: $query, focus: $typing)
      if filter != .all { FilterBar(filter: $filter) }
      ScrollView {
        LazyVStack(spacing: 0) { rows }
      }
      .scrollDismissesKeyboard(.immediately)
      .refreshable { await vault.sync() }
    }
    .background(SIS.paper)
    .band("Secrets")
    .toolbar {
      ToolbarItem(placement: .topBarLeading) { filters }
      ToolbarItemGroup(placement: .topBarTrailing) {
        if pending > 0 {
          Button {
            model.path.append(.devices)
          } label: {
            Hand()
          }
          .accessibilityLabel("Devices")
        }
        Menu {
          ForEach(Kind.made) { kind in
            Button(kind.label, systemImage: kind.symbol) { model.editing = Draft(item: Item(kind: kind), new: true) }
          }
        } label: {
          Image(systemName: "plus")
        }
        .accessibilityLabel("New")
        Menu {
          Button("Devices", systemImage: "iphone") { model.path.append(.devices) }
          Button("Settings", systemImage: "gearshape") { model.path.append(.settings) }
          Button("Lock", systemImage: "lock") { vault.lock() }
        } label: {
          Image(systemName: "ellipsis")
        }
        .accessibilityLabel("More")
      }
    }
  }

  @ViewBuilder private var rows: some View {
    let items = shown
    let favorites = items.filter(\.favorite)
    if items.isEmpty {
      Empty(vault.items.isEmpty ? "Empty" : "Nothing")
    } else if filter == .all && query.isEmpty && !favorites.isEmpty {
      BoardSection(label: "Favorites", count: favorites.count, first: true) {
        Rule()
        ForEach(favorites) { item in ItemRow(item: item) { model.path.append(.item(item.id)) } }
      }
      BoardSection(label: "All", count: items.count) {
        Rule()
        ForEach(items) { item in ItemRow(item: item) { model.path.append(.item(item.id)) } }
      }
    } else {
      ForEach(items) { item in ItemRow(item: item) { model.path.append(.item(item.id)) } }
    }
  }

  private var filters: some View {
    let live = vault.items.filter { $0.trashed == 0 }
    let tags = Set(live.flatMap(\.tags)).sorted()
    let folders = Set(live.map(\.folder).filter { !$0.isEmpty }).sorted()
    let kinds = Kind.allCases.filter { k in live.contains { $0.kind == k } }
    return Menu {
      Picker("Filter", selection: $filter) {
        Text("All").tag(Filter.all)
        Text("Favorites").tag(Filter.favorites)
      }
      if !kinds.isEmpty {
        Picker("Kind", selection: $filter) {
          ForEach(kinds) { Label($0.label, systemImage: $0.symbol).tag(Filter.kind($0)) }
        }
        .pickerStyle(.menu)
      }
      if !tags.isEmpty {
        Picker("Tag", selection: $filter) {
          ForEach(tags, id: \.self) { Text($0).tag(Filter.tag($0)) }
        }
        .pickerStyle(.menu)
      }
      if !folders.isEmpty {
        Picker("Folder", selection: $filter) {
          ForEach(folders, id: \.self) { Text($0).tag(Filter.folder($0)) }
        }
        .pickerStyle(.menu)
      }
      Picker("Trash", selection: $filter) {
        Label("Trash", systemImage: "trash").tag(Filter.trash)
      }
    } label: {
      Image(systemName: filter == .all ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill")
    }
    .accessibilityLabel("Filter")
  }
}

/// The filter in force, and its clear.
private struct FilterBar: View {
  @Binding var filter: Filter

  var body: some View {
    HStack(spacing: 8) {
      Text(filter.label).font(SIS.text(13, weight: .semibold)).foregroundStyle(SIS.ink)
      Spacer()
      Button {
        filter = .all
      } label: {
        Image(systemName: "xmark").font(.system(size: 11, weight: .semibold))
      }
      .buttonStyle(KeyStyle())
      .accessibilityLabel("Clear")
    }
    .padding(.horizontal, SIS.inset)
    .padding(.vertical, 6)
    .background(SIS.wash)
    .overlay(alignment: .bottom) { Rule() }
  }
}
