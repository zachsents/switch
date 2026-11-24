import Compression
import Foundation

/// Reads a zip in memory, enough for a 3MF: its central directory (Zip64 too), and each entry
/// stored or deflated (Compression's ZLIB is raw deflate, as zip's is).
nonisolated struct Zip {
  struct Entry {
    let method: Int
    let packed: Int
    let size: Int
    let offset: Int
  }

  struct Unreadable: Error {}

  let data: Data
  private(set) var entries: [String: Entry] = [:]
  var names: [String] { Array(entries.keys) }

  init(_ data: Data) throws {
    self.data = data
    // The end record: its signature within the last 64 KiB and change.
    var end = -1
    var at = data.count - 22
    while at >= max(0, data.count - 65_557) {
      if data.le(UInt32.self, at: at) == 0x0605_4B50 {
        end = at
        break
      }
      at -= 1
    }
    guard end >= 0 else { throw Unreadable() }
    var count = Int(data.le(UInt16.self, at: end + 10))
    var directory = Int(data.le(UInt32.self, at: end + 16))
    // Zip64: its locator just before, pointing at the Zip64 end record.
    if end >= 20, data.le(UInt32.self, at: end - 20) == 0x0706_4B50 {
      let record = Int(data.le(UInt64.self, at: end - 12))
      if record + 56 <= data.count, data.le(UInt32.self, at: record) == 0x0606_4B50 {
        count = Int(data.le(UInt64.self, at: record + 32))
        directory = Int(data.le(UInt64.self, at: record + 48))
      }
    }
    var p = directory
    for _ in 0..<count {
      guard p + 46 <= data.count, data.le(UInt32.self, at: p) == 0x0201_4B50 else { throw Unreadable() }
      let method = Int(data.le(UInt16.self, at: p + 10))
      var packed = Int(data.le(UInt32.self, at: p + 20))
      var size = Int(data.le(UInt32.self, at: p + 24))
      let nameLength = Int(data.le(UInt16.self, at: p + 28))
      let extraLength = Int(data.le(UInt16.self, at: p + 30))
      let commentLength = Int(data.le(UInt16.self, at: p + 32))
      var offset = Int(data.le(UInt32.self, at: p + 42))
      guard p + 46 + nameLength + extraLength <= data.count else { throw Unreadable() }
      let name = String(decoding: data.subdata(in: (data.startIndex + p + 46)..<(data.startIndex + p + 46 + nameLength)), as: UTF8.self)
      // Zip64's extra field holds whichever of the three are full in order.
      var e = p + 46 + nameLength
      let extraEnd = e + extraLength
      while e + 4 <= extraEnd {
        let id = data.le(UInt16.self, at: e)
        let length = Int(data.le(UInt16.self, at: e + 2))
        if id == 1 {
          var f = e + 4
          if size == 0xFFFF_FFFF, f + 8 <= extraEnd {
            size = Int(data.le(UInt64.self, at: f))
            f += 8
          }
          if packed == 0xFFFF_FFFF, f + 8 <= extraEnd {
            packed = Int(data.le(UInt64.self, at: f))
            f += 8
          }
          if offset == 0xFFFF_FFFF, f + 8 <= extraEnd { offset = Int(data.le(UInt64.self, at: f)) }
        }
        e += 4 + length
      }
      entries[name] = Entry(method: method, packed: packed, size: size, offset: offset)
      p += 46 + nameLength + extraLength + commentLength
    }
  }

  func read(_ name: String) throws -> Data {
    guard let entry = entries[name], entry.offset + 30 <= data.count, data.le(UInt32.self, at: entry.offset) == 0x0403_4B50 else {
      throw Unreadable()
    }
    let start = entry.offset + 30 + Int(data.le(UInt16.self, at: entry.offset + 26)) + Int(data.le(UInt16.self, at: entry.offset + 28))
    guard start + entry.packed <= data.count else { throw Unreadable() }
    let packed = data.subdata(in: (data.startIndex + start)..<(data.startIndex + start + entry.packed))
    switch entry.method {
    case 0: return packed
    case 8:
      guard entry.size > 0 else { return Data() }
      var out = Data(count: entry.size)
      let written = out.withUnsafeMutableBytes { to in
        packed.withUnsafeBytes { from in
          compression_decode_buffer(
            to.bindMemory(to: UInt8.self).baseAddress!, entry.size, from.bindMemory(to: UInt8.self).baseAddress!, entry.packed, nil,
            COMPRESSION_ZLIB)
        }
      }
      guard written == entry.size else { throw Unreadable() }
      return out
    default: throw Unreadable()
    }
  }
}
