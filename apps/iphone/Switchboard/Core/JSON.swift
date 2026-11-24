import Foundation

/// A JSON value, as the brain sends it: read leniently, the way desktop's `rec` and `str` do.
nonisolated enum JSON: Sendable, Hashable, Codable, ExpressibleByStringLiteral, ExpressibleByDictionaryLiteral,
  ExpressibleByArrayLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral
{
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSON])
  case object([String: JSON])

  init(stringLiteral value: String) { self = .string(value) }
  init(integerLiteral value: Int) { self = .number(Double(value)) }
  init(booleanLiteral value: Bool) { self = .bool(value) }
  init(arrayLiteral elements: JSON...) { self = .array(elements) }
  init(dictionaryLiteral elements: (String, JSON)...) {
    self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
  }

  init(_ value: String?) { self = value.map(JSON.string) ?? .null }
  init(_ value: Double?) { self = value.map(JSON.number) ?? .null }

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let b = try? c.decode(Bool.self) {
      self = .bool(b)
    } else if let n = try? c.decode(Double.self) {
      self = .number(n)
    } else if let s = try? c.decode(String.self) {
      self = .string(s)
    } else if let a = try? c.decode([JSON].self) {
      self = .array(a)
    } else {
      self = .object(try c.decode([String: JSON].self))
    }
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let b): try c.encode(b)
    case .number(let n): try c.encode(n)
    case .string(let s): try c.encode(s)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    }
  }

  static func parse(_ data: Data) -> JSON? { try? JSONDecoder().decode(JSON.self, from: data) }
  static func parse(_ text: String) -> JSON? { parse(Data(text.utf8)) }

  var data: Data { (try? JSONEncoder().encode(self)) ?? Data("null".utf8) }
  var text: String { String(decoding: data, as: UTF8.self) }

  subscript(key: String) -> JSON {
    if case .object(let o) = self { return o[key] ?? .null }
    return .null
  }

  /// A string, or "" (desktop's `str`).
  var str: String {
    switch self {
    case .string(let s): s
    case .number(let n): n.rounded() == n ? String(Int(n)) : String(n)
    default: ""
    }
  }

  var string: String? { if case .string(let s) = self { return s } else { return nil } }
  var number: Double? { if case .number(let n) = self { return n } else { return nil } }
  var bool: Bool? { if case .bool(let b) = self { return b } else { return nil } }
  var array: [JSON] { if case .array(let a) = self { return a } else { return [] } }
  var object: [String: JSON] { if case .object(let o) = self { return o } else { return [:] } }
  var isNull: Bool { if case .null = self { return true } else { return false } }

  /// As Foundation's JSON objects, for APIs that take `Any`.
  var any: Any {
    switch self {
    case .null: NSNull()
    case .bool(let b): b
    case .number(let n): n
    case .string(let s): s
    case .array(let a): a.map(\.any)
    case .object(let o): o.mapValues(\.any)
    }
  }
}
