import Foundation

// A field written the way people read it, as the extension's src/text.ts does (LABELS, SERVICES,
// SITES, pretty, profileUrl), so the iPhone shows what the desktop shows.

enum Pretty {
  static let labels: [String: String] = [
    "name": "Name", "given": "Given", "family": "Family", "initial": "Initial", "nickname": "Nickname",
    "type": "Type", "group": "Label", "relationship": "Relationship", "phone": "Phone", "email": "Email",
    "handle": "Handle", "company": "Company", "role": "Role", "location": "Location", "birthday": "Birthday",
    "relation": "Related", "space": "Space", "url": "Link", "note": "Note", "ref": "Record", "last_contact": "Last",
  ]

  static let services: [String: String] = [
    "instagram": "Instagram", "linkedin": "LinkedIn", "telegram": "Telegram", "imessage": "iMessage", "x": "X",
    "facebook": "Facebook", "github": "GitHub", "tiktok": "TikTok", "threads": "Threads", "apple": "Apple", "google": "Google",
  ]

  /// Where a profile on each service lives, before the handle.
  static let sites: [String: String] = [
    "instagram": "https://www.instagram.com/", "linkedin": "https://www.linkedin.com/in/", "telegram": "https://t.me/",
    "x": "https://x.com/", "facebook": "https://www.facebook.com/", "github": "https://github.com/",
    "tiktok": "https://www.tiktok.com/@", "threads": "https://www.threads.net/@",
  ]

  /// A field's label: its kind's, or for a handle its service's.
  static func label(_ f: JSON) -> String {
    let kind = f["kind"].str
    let service = f["service"].str
    if kind == "handle" { return services[service] ?? (service.isEmpty ? "Handle" : service) }
    return labels[kind] ?? kind
  }

  /// A handle's profile page, when its service has one.
  static func profile(_ f: JSON) -> URL? {
    guard f["kind"].str == "handle", let site = sites[f["service"].str] else { return nil }
    if let url = f["url"].string { return URL(string: url) }
    return URL(string: site + f["value"].str)
  }

  /// Where tapping a field goes: a profile, a link, a call, a mail.
  static func link(_ f: JSON) -> URL? {
    let v = f["value"].str
    switch f["kind"].str {
    case "handle": return profile(f)
    case "url": return URL(string: v.contains("://") ? v : "https://\(v)")
    case "phone": return URL(string: "tel:\(v.replacingOccurrences(of: ";ext=", with: ","))")
    case "email": return URL(string: "mailto:\(v)")
    default: return nil
    }
  }

  /// A field's value as people read it: a phone grouped, an initial with its stop, a day.
  static func pretty(_ f: JSON) -> String {
    let v = f["value"].str
    switch f["kind"].str {
    case "phone": return phone(v)
    case "initial": return "\(v)."
    case "birthday": return birthday(v)
    case "last_contact":
      return Date(timeIntervalSince1970: (Double(v) ?? 0) / 1000).formatted(.dateTime.month(.abbreviated).day().year())
    default: return v
    }
  }

  /// `1990-07-22` as Jul 22, 1990; `--07-22` as Jul 22.
  static func birthday(_ v: String) -> String {
    let parts = v.split(separator: "-", omittingEmptySubsequences: false)
    let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    let (year, month, day): (String, Int?, Int?) =
      switch parts.count {
      case 3 where parts[0].count == 4: (String(parts[0]), Int(parts[1]), Int(parts[2]))
      case 4 where parts[0].isEmpty && parts[1].isEmpty: ("", Int(parts[2]), Int(parts[3]))
      default: ("", nil, nil)
      }
    guard let month, let day, (1...12).contains(month) else { return v }
    let md = "\(months[month - 1]) \(day)"
    return year.isEmpty ? md : "\(md), \(year)"
  }

  /// Country calling codes of one and two digits; any other is three.
  private static let shortCodes: Set<String> = [
    "1", "7", "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49",
    "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86",
    "90", "91", "92", "93", "94", "95", "98",
  ]

  /// A phone in E.164 as people read it: national for +1 numbers, international otherwise.
  static func phone(_ value: String) -> String {
    let pieces = value.components(separatedBy: ";ext=")
    let number = pieces[0]
    let ext = pieces.count > 1 ? " ext. \(pieces[1])" : ""
    guard number.hasPrefix("+") else { return value }
    let digits = number.dropFirst()
    guard digits.allSatisfy(\.isNumber), digits.count >= 8 else { return value }
    if digits.hasPrefix("1") && digits.count == 11 {
      let d = Array(digits.dropFirst())
      return "(\(String(d[0..<3]))) \(String(d[3..<6]))-\(String(d[6..<10]))\(ext)"
    }
    let code = [1, 2].map { String(digits.prefix($0)) }.first { shortCodes.contains($0) } ?? String(digits.prefix(3))
    var rest = Array(digits.dropFirst(code.count))
    // Groups of three, the last four together.
    var groups: [String] = []
    let tail = rest.count > 4 ? String(rest.suffix(4)) : ""
    if !tail.isEmpty { rest.removeLast(4) }
    while !rest.isEmpty {
      let n = rest.count == 4 ? 2 : min(3, rest.count)
      groups.append(String(rest.prefix(n)))
      rest.removeFirst(n)
    }
    if !tail.isEmpty { groups.append(tail) }
    return "+\(code) \(groups.joined(separator: " "))\(ext)"
  }

  /// A name as shown: a phone standing in for one, grouped.
  static func name(_ v: String) -> String {
    v.hasPrefix("+") && v.dropFirst().allSatisfy(\.isNumber) ? phone(v) : v
  }

  /// A field's rank among its kind's, as the extension's `rank`: the user's first, then the surest,
  /// then the newest.
  static func rank(_ f: JSON) -> Double {
    (f["suggested"].bool == true ? -10 : 0) + (f["user"].bool == true ? 2 : 0) + (f["confidence"].number ?? 0)
      + (f["at"].number ?? 0) / 1e15
  }
}

/// What someone is: one of three, or unset.
enum PersonType {
  static let all = ["person", "company", "system"]
  static func name(_ type: String) -> String { type.capitalized }
}
