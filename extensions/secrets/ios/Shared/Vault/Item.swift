import Foundation

// What the vault holds, as src/model.ts says it: items of a kind, each a title, a name the agent
// refers to it by, and fields. An item is sealed whole (Crypto.swift); its JSON here is the extension's
// `Item`, key for key.

nonisolated enum Kind: String, Codable, CaseIterable, Identifiable, Sendable {
  case login, password, apiKey = "api-key", card, note, sshKey = "ssh-key", identity, file

  var id: String { rawValue }

  var label: String {
    switch self {
    case .login: "Login"
    case .password: "Password"
    case .apiKey: "API key"
    case .card: "Card"
    case .note: "Note"
    case .sshKey: "SSH key"
    case .identity: "Identity"
    case .file: "File"
    }
  }

  var symbol: String {
    switch self {
    case .login: "person.crop.circle"
    case .password: "key"
    case .apiKey: "chevron.left.forwardslash.chevron.right"
    case .card: "creditcard"
    case .note: "note.text"
    case .sshKey: "terminal"
    case .identity: "person.text.rectangle"
    case .file: "doc"
    }
  }

  /// The fields it starts with; the first is what a bare reference means.
  var template: [(id: String, label: String, type: FieldType)] {
    switch self {
    case .login: [("password", "Password", .password), ("username", "Username", .text), ("totp", "One-time code", .totp)]
    case .password: [("password", "Password", .password)]
    case .apiKey: [("credential", "Credential", .concealed), ("username", "Username", .text)]
    case .card:
      [
        ("number", "Number", .cardNumber), ("holder", "Name on card", .text), ("cvc", "Security code", .cvc),
        ("month", "Expiry month", .month), ("year", "Expiry year", .year), ("expiry", "Expiry", .text), ("pin", "PIN", .pin),
      ]
    case .note, .file: []
    case .sshKey: [("private_key", "Private key", .privateKey), ("public_key", "Public key", .text), ("passphrase", "Passphrase", .password)]
    case .identity:
      [
        ("name", "Name", .text), ("email", "Email", .email), ("phone", "Phone", .phone), ("address", "Address", .text),
        ("ssn", "Social security number", .ssn), ("passport", "Passport", .concealed), ("license", "Driver's license", .concealed),
      ]
    }
  }

  /// What can be made here (files come later).
  static let made: [Kind] = [.login, .password, .apiKey, .card, .note, .sshKey, .identity]
}

nonisolated enum FieldType: String, Codable, CaseIterable, Identifiable, Sendable {
  case text, email, url, phone, date, month, year, password, concealed, totp
  case cardNumber = "card-number", cvc, pin, ssn, privateKey = "private-key"

  var id: String { rawValue }

  /// Values that never leave the vault but sealed: shown as dots until revealed.
  var concealed: Bool {
    switch self {
    case .password, .concealed, .totp, .cardNumber, .cvc, .pin, .ssn, .privateKey: true
    default: false
    }
  }

  var label: String {
    switch self {
    case .text: "Text"
    case .email: "Email"
    case .url: "URL"
    case .phone: "Phone"
    case .date: "Date"
    case .month: "Month"
    case .year: "Year"
    case .password: "Password"
    case .concealed: "Concealed"
    case .totp: "One-time code"
    case .cardNumber: "Card number"
    case .cvc: "Security code"
    case .pin: "PIN"
    case .ssn: "SSN"
    case .privateKey: "Private key"
    }
  }
}

nonisolated struct Field: Codable, Hashable, Identifiable, Sendable {
  var id: String
  var label: String
  var type: FieldType
  var value: String
}

/// Where a login is filled and an API key may be sent.
nonisolated struct ItemURL: Codable, Hashable, Sendable {
  enum Match: String, Codable, CaseIterable, Sendable {
    /// The site and its subdomains (the default); that host only; that page.
    case domain, host, exact
  }

  var url: String
  var match: Match?
}

nonisolated struct Item: Codable, Hashable, Identifiable, Sendable {
  var id: String
  var kind: Kind
  var name: String
  var title: String
  var fields: [Field]
  var urls: [ItemURL]
  var notes: String
  var tags: [String]
  var folder: String
  var spaces: [String]
  var favorite: Bool
  var source: String
  /// ms since 1970.
  var created: Double
  var updated: Double
  /// Trashed at, or 0.
  var trashed: Double

  /// A new item of a kind, its template's fields empty.
  init(kind: Kind) {
    let now = Date().timeIntervalSince1970 * 1000
    id = UUID().uuidString.lowercased()
    self.kind = kind
    name = ""
    title = ""
    fields = kind.template.map { Field(id: $0.id, label: $0.label, type: $0.type, value: "") }
    urls = []
    notes = ""
    tags = []
    folder = ""
    spaces = []
    favorite = false
    source = "user"
    created = now
    updated = now
    trashed = 0
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    kind = try c.decode(Kind.self, forKey: .kind)
    name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
    title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
    fields = try c.decodeIfPresent([Field].self, forKey: .fields) ?? []
    urls = try c.decodeIfPresent([ItemURL].self, forKey: .urls) ?? []
    notes = try c.decodeIfPresent(String.self, forKey: .notes) ?? ""
    tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
    folder = try c.decodeIfPresent(String.self, forKey: .folder) ?? ""
    spaces = try c.decodeIfPresent([String].self, forKey: .spaces) ?? []
    favorite = try c.decodeIfPresent(Bool.self, forKey: .favorite) ?? false
    source = try c.decodeIfPresent(String.self, forKey: .source) ?? "user"
    created = try c.decodeIfPresent(Double.self, forKey: .created) ?? 0
    updated = try c.decodeIfPresent(Double.self, forKey: .updated) ?? 0
    trashed = try c.decodeIfPresent(Double.self, forKey: .trashed) ?? 0
  }

  func field(_ id: String) -> Field? { fields.first { $0.id == id } }
  func value(_ id: String) -> String { field(id)?.value ?? "" }

  var username: String { value("username") }
  var password: String { value("password") }
  var totp: String { value("totp") }

  /// The field a bare reference means: its kind's main secret, else its first concealed one.
  var main: Field? {
    let first = kind.template.first?.id
    return fields.first { $0.id == first && !$0.value.isEmpty } ?? fields.first { $0.type.concealed && !$0.value.isEmpty }
  }

  /// What's under its title in a list: a login's username, a card's last digits, a key's host.
  var detail: String {
    switch kind {
    case .login, .apiKey: return username.isEmpty ? (urls.first.map { Self.host($0.url) } ?? "") : username
    case .card:
      let n = value("number")
      return n.count >= 4 ? "•••• \(n.suffix(4))" : ""
    case .identity: return value("email")
    default: return ""
    }
  }

  static func host(_ url: String) -> String {
    let full = url.contains("://") ? url : "https://\(url)"
    return URLComponents(string: full)?.host ?? url
  }

  var json: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: (try? encoder.encode(self)) ?? Data(), as: UTF8.self)
  }

  static func from(_ json: String) -> Item? { try? JSONDecoder().decode(Item.self, from: Data(json.utf8)) }
}

/// Item names: lowercase letters, digits and . _ / @ -, at most 64 (model.ts's `isName`, `slug`).
nonisolated enum Names {
  static func valid(_ name: String) -> Bool {
    guard (1...64).contains(name.count), !name.contains(".."), !name.contains("//") else { return false }
    let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789._/@-")
    let ends = Set("abcdefghijklmnopqrstuvwxyz0123456789")
    guard let first = name.first, let last = name.last, ends.contains(first), ends.contains(last) else { return false }
    return name.allSatisfy { allowed.contains($0) }
  }

  /// "GitHub (work)" is github-work.
  static func slug(_ title: String) -> String {
    let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789._/@-".unicodeScalars)
    var out = String.UnicodeScalarView()
    var dash = false
    for u in title.lowercased().decomposedStringWithCompatibilityMapping.unicodeScalars {
      let keep = allowed.contains(u)
      if keep && u != "-" {
        out.append(u)
        dash = false
      } else if !dash {
        out.append("-")
        dash = true
      }
    }
    var text = String(out)
    let trim = Set("-./_@")
    while let f = text.first, trim.contains(f) { text.removeFirst() }
    while let l = text.last, trim.contains(l) { text.removeLast() }
    let cut = String(text.prefix(64))
    return cut.isEmpty ? "item" : cut
  }

  /// A name for `title` no other item has.
  static func unique(_ title: String, among taken: Set<String>) -> String {
    let base = slug(title)
    guard taken.contains(base) else { return base }
    var n = 2
    while taken.contains("\(base)-\(n)") { n += 1 }
    return "\(base)-\(n)"
  }
}
