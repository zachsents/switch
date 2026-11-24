import AuthenticationServices
import SwiftUI

/// The logins AutoFill offers: Face ID first, then those for this page or app, then a search over
/// every login.
struct PickerView: View {
  enum Mode { case password, code }

  let mode: Mode
  let services: [ASCredentialServiceIdentifier]
  let unlock: () async throws -> Void
  let pick: (Item) -> Void
  let cancel: () -> Void
  @State private var query = ""
  @State private var problem: String?
  @FocusState private var typing: Bool

  private var logins: [Item] {
    vault.items.filter { item in
      guard item.kind == .login, item.trashed == 0 else { return false }
      return mode == .password ? !item.password.isEmpty : TOTP(item.totp) != nil
    }
  }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        if let problem { Problem(text: problem) }
        if vault.phase == .open { list } else { locked }
      }
      .background(SIS.paper)
      .band(mode == .password ? "Passwords" : "Codes")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button("Cancel", action: cancel) }
      }
    }
    .tint(SIS.ink)
    .task { await open() }
  }

  @ViewBuilder private var locked: some View {
    Spacer()
    if vault.phase == .locked {
      Button {
        Task { await open() }
      } label: {
        Label("Unlock", systemImage: "faceid")
      }
      .buttonStyle(KeyStyle(go: true))
    } else {
      Empty("Not set up")
    }
    Spacer()
  }

  @ViewBuilder private var list: some View {
    let words = query.lowercased().split(separator: " ").map(String.init)
    let found = logins.filter { item in
      let hay = ([item.title, item.username] + item.urls.map(\.url)).joined(separator: " ").lowercased()
      return words.allSatisfy(hay.contains)
    }
    let fits = found.filter { Identities.fits($0, services) }
    let rest = found.filter { !Identities.fits($0, services) }
    SearchField(text: $query, focus: $typing)
    ScrollView {
      LazyVStack(spacing: 0) {
        if found.isEmpty { Empty("Nothing") }
        if !fits.isEmpty {
          BoardSection(label: site, count: fits.count, first: true) {
            Rule()
            ForEach(fits) { item in ItemRow(item: item) { pick(item) } }
          }
        }
        if !rest.isEmpty && (!query.isEmpty || fits.isEmpty) {
          BoardSection(label: "All", count: rest.count, first: fits.isEmpty) {
            Rule()
            ForEach(rest) { item in ItemRow(item: item) { pick(item) } }
          }
        } else if !rest.isEmpty {
          BoardSection(label: "Others", count: rest.count) {
            Rule()
            ForEach(rest) { item in ItemRow(item: item) { pick(item) } }
          }
        }
      }
    }
    .scrollDismissesKeyboard(.immediately)
  }

  private var site: String {
    services.first.map { Identities.host($0.identifier) } ?? "This site"
  }

  private func open() async {
    guard vault.phase == .locked else { return }
    do {
      try await unlock()
      problem = nil
    } catch {
      problem = error.localizedDescription
    }
  }
}
