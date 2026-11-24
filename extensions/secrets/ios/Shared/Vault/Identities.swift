import AuthenticationServices
import Foundation

/// Which logins fit a page or app, and what iOS is told of them so it can offer them above the
/// keyboard: each login's URLs with its username (and, for one with an authenticator key, a
/// one-time code), never a value.
enum Identities {
  /// The host of a URL or bare domain, lowercased, without `www.`.
  nonisolated static func host(_ text: String) -> String {
    let full = text.contains("://") ? text : "https://\(text)"
    var h = (URLComponents(string: full)?.host ?? text).lowercased()
    if h.hasPrefix("www.") { h.removeFirst(4) }
    return h
  }

  nonisolated static func service(_ u: ItemURL) -> ASCredentialServiceIdentifier {
    switch u.match ?? .domain {
    case .domain: ASCredentialServiceIdentifier(identifier: host(u.url), type: .domain)
    case .host: ASCredentialServiceIdentifier(identifier: "https://\(host(u.url))", type: .URL)
    case .exact: ASCredentialServiceIdentifier(identifier: u.url, type: .URL)
    }
  }

  /// Whether a login's URL fits what's asking: its site and subdomains, its host, or that page.
  nonisolated static func fits(_ u: ItemURL, _ asking: ASCredentialServiceIdentifier) -> Bool {
    let page = host(asking.identifier)
    let mine = host(u.url)
    guard !page.isEmpty, !mine.isEmpty else { return false }
    switch u.match ?? .domain {
    case .domain: return page == mine || page.hasSuffix(".\(mine)") || mine.hasSuffix(".\(page)")
    case .host: return page == mine
    case .exact: return asking.identifier.hasPrefix(u.url)
    }
  }

  nonisolated static func fits(_ item: Item, _ asking: [ASCredentialServiceIdentifier]) -> Bool {
    item.urls.contains { u in asking.contains { fits(u, $0) } }
  }

  static func replace(_ items: [Item]) async {
    let store = ASCredentialIdentityStore.shared
    guard await store.state().isEnabled else { return }
    var all: [any ASCredentialIdentity] = []
    for item in items where item.kind == .login && item.trashed == 0 {
      let user = item.username.isEmpty ? item.title : item.username
      for u in item.urls {
        let service = service(u)
        if !item.password.isEmpty {
          all.append(ASPasswordCredentialIdentity(serviceIdentifier: service, user: user, recordIdentifier: item.id))
        }
        if TOTP(item.totp) != nil {
          all.append(ASOneTimeCodeCredentialIdentity(serviceIdentifier: service, label: user, recordIdentifier: item.id))
        }
      }
    }
    try? await store.replaceCredentialIdentities(all)
  }

  static func clear() async {
    try? await ASCredentialIdentityStore.shared.removeAllCredentialIdentities()
  }
}
