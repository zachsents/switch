import CryptoKit
import Foundation

/// Authenticator keys (RFC 6238), as a totp field keeps them: an `otpauth://totp/…` link, or the
/// key itself in base32. The code now, and how long it has left.
nonisolated struct TOTP: Sendable {
  let secret: Data
  let digits: Int
  let period: Int
  let algorithm: String

  init?(_ value: String) {
    let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
    var secret = text
    var digits = 6
    var period = 30
    var algorithm = "SHA1"
    if let at = text.range(of: "otpauth://") {
      guard let c = URLComponents(string: String(text[at.lowerBound...])), c.host?.lowercased() == "totp" else { return nil }
      let q = Dictionary((c.queryItems ?? []).map { ($0.name.lowercased(), $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
      secret = q["secret"] ?? ""
      digits = Int(q["digits"] ?? "") ?? 6
      period = Int(q["period"] ?? "") ?? 30
      algorithm = (q["algorithm"] ?? "SHA1").uppercased()
    }
    guard let key = Self.base32(secret), key.count >= 10, (6...8).contains(digits), (10...120).contains(period),
      ["SHA1", "SHA256", "SHA512"].contains(algorithm)
    else { return nil }
    self.secret = key
    self.digits = digits
    self.period = period
    self.algorithm = algorithm
  }

  /// Base32 (RFC 4648) in any case, spaces, dashes and padding ignored.
  static func base32(_ text: String) -> Data? {
    let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
    var out = Data()
    var buffer = 0
    var bits = 0
    for c in text.uppercased() where !" =-".contains(c) {
      guard let value = alphabet.firstIndex(of: c) else { return nil }
      buffer = (buffer << 5) | value
      bits += 5
      if bits >= 8 {
        bits -= 8
        out.append(UInt8((buffer >> bits) & 0xFF))
        buffer &= (1 << bits) - 1
      }
    }
    return out
  }

  func code(at date: Date = Date()) -> String {
    var counter = UInt64(date.timeIntervalSince1970 / Double(period)).bigEndian
    let message = Data(bytes: &counter, count: 8)
    let key = SymmetricKey(data: secret)
    let mac: [UInt8] =
      switch algorithm {
      case "SHA256": Array(HMAC<SHA256>.authenticationCode(for: message, using: key))
      case "SHA512": Array(HMAC<SHA512>.authenticationCode(for: message, using: key))
      default: Array(HMAC<Insecure.SHA1>.authenticationCode(for: message, using: key))
      }
    let offset = Int(mac[mac.count - 1] & 0x0F)
    let value =
      (UInt32(mac[offset]) & 0x7F) << 24 | UInt32(mac[offset + 1]) << 16 | UInt32(mac[offset + 2]) << 8 | UInt32(mac[offset + 3])
    var power: UInt32 = 1
    for _ in 0..<digits { power *= 10 }
    let text = String(value % power)
    return String(repeating: "0", count: digits - text.count) + text
  }

  /// Seconds until the next code.
  func left(at date: Date = Date()) -> Int {
    period - Int(date.timeIntervalSince1970) % period
  }

  /// A key as the field keeps it (src/otp.ts's `otpauth`): an otpauth link, whatever was typed.
  static func normalized(_ value: String) -> String? {
    let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let t = TOTP(text) else { return nil }
    if text.contains("otpauth://") { return text }
    let secret = text.uppercased().filter { !" =-".contains($0) }
    return "otpauth://totp/?secret=\(secret)&digits=\(t.digits)&period=\(t.period)&algorithm=\(t.algorithm)"
  }
}
