import Foundation
import simd

/// A 3D model's triangles, Y up, shaded flat as they print: each triangle's three corners with its
/// face's normal, packed as floats for SceneKit.
nonisolated struct Mesh: Sendable {
  let vertices: Data
  let normals: Data
  let count: Int
  let low: SIMD3<Float>
  let high: SIMD3<Float>

  /// From a soup of triangles, three corners each.
  init?(_ corners: [SIMD3<Float>]) {
    let n = corners.count - corners.count % 3
    guard n > 0 else { return nil }
    var v = [Float]()
    var m = [Float]()
    v.reserveCapacity(n * 3)
    m.reserveCapacity(n * 3)
    var low = SIMD3<Float>(repeating: .infinity)
    var high = SIMD3<Float>(repeating: -.infinity)
    var i = 0
    while i < n {
      let (a, b, c) = (corners[i], corners[i + 1], corners[i + 2])
      let cross = simd_cross(b - a, c - a)
      let length = simd_length(cross)
      let normal = length > 0 ? cross / length : SIMD3<Float>(0, 1, 0)
      for p in [a, b, c] {
        v.append(contentsOf: [p.x, p.y, p.z])
        m.append(contentsOf: [normal.x, normal.y, normal.z])
        low = simd_min(low, p)
        high = simd_max(high, p)
      }
      i += 3
    }
    vertices = v.withUnsafeBufferPointer { Data(buffer: $0) }
    normals = m.withUnsafeBufferPointer { Data(buffer: $0) }
    count = n
    self.low = low
    self.high = high
  }
}

/// Reads the models chat draws: STL, OBJ, GLB (and glTF with its buffers inside), 3MF. USDZ goes
/// to SceneKit itself (ModelView).
nonisolated enum Models {
  struct Unreadable: Error {}

  /// STL and 3MF are Z up; the rest, as SceneKit, Y up.
  static func zUp(_ p: SIMD3<Float>) -> SIMD3<Float> { SIMD3(p.x, p.z, -p.y) }

  @concurrent static func read(_ file: URL, ext: String) async throws -> Mesh {
    let data = try Data(contentsOf: file, options: .mappedIfSafe)
    let corners: [SIMD3<Float>]
    switch ext {
    case "stl": corners = stl(data).map(zUp)
    case "obj": corners = obj(data)
    case "glb", "gltf": corners = try GLTF.read(data)
    case "3mf": corners = try ThreeMF.read(data).map(zUp)
    default: throw Unreadable()
    }
    guard let mesh = Mesh(corners) else { throw Unreadable() }
    return mesh
  }

  // MARK: STL

  static func stl(_ data: Data) -> [SIMD3<Float>] {
    if data.count >= 84 {
      let n = Int(data.le(UInt32.self, at: 80))
      if data.count == 84 + n * 50 {
        var out = [SIMD3<Float>]()
        out.reserveCapacity(n * 3)
        for t in 0..<n {
          let at = 84 + t * 50 + 12
          for k in 0..<3 {
            let o = at + k * 12
            out.append(SIMD3(data.le(Float.self, at: o), data.le(Float.self, at: o + 4), data.le(Float.self, at: o + 8)))
          }
        }
        return out
      }
    }
    // ASCII: every "vertex x y z", in threes.
    var out = [SIMD3<Float>]()
    for line in String(decoding: data, as: UTF8.self).split(whereSeparator: \.isNewline) {
      let words = line.split(whereSeparator: \.isWhitespace)
      if words.count == 4, words[0] == "vertex", let x = Float(words[1]), let y = Float(words[2]), let z = Float(words[3]) {
        out.append(SIMD3(x, y, z))
      }
    }
    return out
  }

  // MARK: OBJ

  static func obj(_ data: Data) -> [SIMD3<Float>] {
    var points = [SIMD3<Float>]()
    var out = [SIMD3<Float>]()
    for line in String(decoding: data, as: UTF8.self).split(whereSeparator: \.isNewline) {
      let words = line.split(whereSeparator: \.isWhitespace)
      guard let head = words.first else { continue }
      if head == "v", words.count >= 4, let x = Float(words[1]), let y = Float(words[2]), let z = Float(words[3]) {
        points.append(SIMD3(x, y, z))
      } else if head == "f", words.count >= 4 {
        // "f 1/2/3 4//6 -1": the first number of each corner, counted from the end when negative; a fan.
        let corners = words.dropFirst().compactMap { word -> Int? in
          guard let n = Int(word.split(separator: "/", omittingEmptySubsequences: false).first ?? "") else { return nil }
          let i = n < 0 ? points.count + n : n - 1
          return i >= 0 && i < points.count ? i : nil
        }
        guard corners.count >= 3 else { continue }
        for k in 1..<(corners.count - 1) {
          out.append(contentsOf: [points[corners[0]], points[corners[k]], points[corners[k + 1]]])
        }
      }
    }
    return out
  }
}

/// glTF 2.0's meshes: a GLB's JSON and binary chunks (or a .gltf with base64 buffers), each node
/// of the default scene placed by its transform, each primitive's triangles by its positions and indices.
nonisolated enum GLTF {
  static func read(_ data: Data) throws -> [SIMD3<Float>] {
    var json: JSON?
    var bin = Data()
    if data.count >= 20, data.le(UInt32.self, at: 0) == 0x4654_6C67 {
      var at = 12
      while at + 8 <= data.count {
        let length = Int(data.le(UInt32.self, at: at))
        let kind = data.le(UInt32.self, at: at + 4)
        let body = data.subdata(in: (at + 8)..<min(data.count, at + 8 + length))
        if kind == 0x4E4F_534A { json = JSON.parse(body) } else if kind == 0x004E_4942 { bin = body }
        at += 8 + length
      }
    } else {
      json = JSON.parse(data)
    }
    guard let json else { throw Models.Unreadable() }
    let buffers = json["buffers"].array.enumerated().map { i, b -> Data in
      let uri = b["uri"].str
      if uri.isEmpty { return i == 0 ? bin : Data() }
      if uri.hasPrefix("data:"), let comma = uri.firstIndex(of: ",") { return Data(base64Encoded: String(uri[uri.index(after: comma)...])) ?? Data() }
      return Data()
    }

    func accessor(_ index: Int) -> (data: Data, offset: Int, stride: Int, count: Int, type: Int, size: Int)? {
      let a = json["accessors"].array
      guard index >= 0, index < a.count else { return nil }
      let acc = a[index]
      let views = json["bufferViews"].array
      guard let v = acc["bufferView"].number.map(Int.init), v < views.count else { return nil }
      let view = views[v]
      let b = Int(view["buffer"].number ?? 0)
      guard b < buffers.count else { return nil }
      let type = Int(acc["componentType"].number ?? 0)
      let width = ["SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4][acc["type"].str] ?? 1
      let size = [5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4][type] ?? 4
      let stride = Int(view["byteStride"].number ?? 0)
      return (
        buffers[b], Int(view["byteOffset"].number ?? 0) + Int(acc["byteOffset"].number ?? 0),
        stride > 0 ? stride : width * size, Int(acc["count"].number ?? 0), type, size
      )
    }

    func matrix(_ node: JSON) -> simd_float4x4 {
      let m = node["matrix"].array.compactMap(\.number).map(Float.init)
      if m.count == 16 {
        return simd_float4x4(columns: (
          SIMD4(m[0], m[1], m[2], m[3]), SIMD4(m[4], m[5], m[6], m[7]), SIMD4(m[8], m[9], m[10], m[11]), SIMD4(m[12], m[13], m[14], m[15])
        ))
      }
      let t = node["translation"].array.compactMap(\.number).map(Float.init)
      let r = node["rotation"].array.compactMap(\.number).map(Float.init)
      let s = node["scale"].array.compactMap(\.number).map(Float.init)
      var out = matrix_identity_float4x4
      if t.count == 3 { out.columns.3 = SIMD4(t[0], t[1], t[2], 1) }
      if r.count == 4 { out = out * simd_float4x4(simd_quatf(ix: r[0], iy: r[1], iz: r[2], r: r[3])) }
      if s.count == 3 { out = out * simd_float4x4(diagonal: SIMD4(s[0], s[1], s[2], 1)) }
      return out
    }

    var out = [SIMD3<Float>]()
    let meshes = json["meshes"].array
    let nodes = json["nodes"].array

    func primitive(_ p: JSON, _ place: simd_float4x4) {
      let mode = Int(p["mode"].number ?? 4)
      guard mode == 4, let pos = accessor(Int(p["attributes"]["POSITION"].number ?? -1)), pos.type == 5126 else { return }
      var points = [SIMD3<Float>]()
      points.reserveCapacity(pos.count)
      for i in 0..<pos.count {
        let o = pos.offset + i * pos.stride
        guard o + 12 <= pos.data.count else { break }
        let p = place * SIMD4(pos.data.le(Float.self, at: o), pos.data.le(Float.self, at: o + 4), pos.data.le(Float.self, at: o + 8), 1)
        points.append(SIMD3(p.x, p.y, p.z))
      }
      if let idx = p["indices"].number.map(Int.init), let ix = accessor(idx) {
        for i in 0..<ix.count {
          let o = ix.offset + i * ix.stride
          guard o + ix.size <= ix.data.count else { break }
          let n: Int
          switch ix.size {
          case 1: n = Int(ix.data[ix.data.startIndex + o])
          case 2: n = Int(ix.data.le(UInt16.self, at: o))
          default: n = Int(ix.data.le(UInt32.self, at: o))
          }
          if n < points.count { out.append(points[n]) } else { out.append(SIMD3(repeating: 0)) }
        }
      } else {
        out.append(contentsOf: points)
      }
    }

    func walk(_ index: Int, _ parent: simd_float4x4, _ seen: inout Set<Int>) {
      guard index >= 0, index < nodes.count, seen.insert(index).inserted else { return }
      let node = nodes[index]
      let place = parent * matrix(node)
      if let m = node["mesh"].number.map(Int.init), m < meshes.count {
        for p in meshes[m]["primitives"].array { primitive(p, place) }
      }
      for child in node["children"].array.compactMap(\.number) { walk(Int(child), place, &seen) }
    }

    let scenes = json["scenes"].array
    let scene = Int(json["scene"].number ?? 0)
    var seen = Set<Int>()
    if scene < scenes.count {
      for n in scenes[scene]["nodes"].array.compactMap(\.number) { walk(Int(n), matrix_identity_float4x4, &seen) }
    } else {
      for p in meshes.flatMap({ $0["primitives"].array }) { primitive(p, matrix_identity_float4x4) }
    }
    return out
  }
}

/// 3MF: a zip whose models are XML, each object a mesh (vertices, triangles) or components of
/// others (in this file or another, by `p:path`), placed by the build's items.
nonisolated enum ThreeMF {
  /// Rows of a 3MF transform, "m00 m01 m02 m10 … m32": a point is the row [x y z 1] times it.
  typealias Place = [Float]
  static let identity: Place = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

  static func apply(_ m: Place, _ p: SIMD3<Float>) -> SIMD3<Float> {
    SIMD3(
      p.x * m[0] + p.y * m[3] + p.z * m[6] + m[9], p.x * m[1] + p.y * m[4] + p.z * m[7] + m[10],
      p.x * m[2] + p.y * m[5] + p.z * m[8] + m[11])
  }

  /// `a` then `b`.
  static func then(_ a: Place, _ b: Place) -> Place {
    var out = [Float](repeating: 0, count: 12)
    for r in 0..<4 {
      for c in 0..<3 {
        let x = a[r * 3]
        let y = a[r * 3 + 1]
        let z = a[r * 3 + 2]
        out[r * 3 + c] = x * b[c] + y * b[3 + c] + z * b[6 + c] + (r == 3 ? b[9 + c] : 0)
      }
    }
    return out
  }

  static func place(_ said: String?) -> Place {
    let m = (said ?? "").split(whereSeparator: \.isWhitespace).compactMap { Float($0) }
    return m.count == 12 ? m : identity
  }

  final class Object {
    var points: [SIMD3<Float>] = []
    var triangles: [(Int, Int, Int)] = []
    var components: [(key: String, place: Place)] = []
  }

  final class Reader: NSObject, XMLParserDelegate {
    let path: String
    var objects: [String: Object] = [:]
    var items: [(key: String, place: Place)] = []
    private var current: Object?

    init(path: String) { self.path = path }

    func key(_ id: String?, _ other: String?) -> String {
      let p = (other ?? path).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
      return "\(p)#\(id ?? "")"
    }

    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes a: [String: String] = [:]) {
      let local = name.split(separator: ":").last.map(String.init) ?? name
      let path = a["p:path"] ?? a.first { $0.key.hasSuffix(":path") }?.value
      switch local {
      case "object":
        let o = Object()
        objects[key(a["id"], nil)] = o
        current = o
      case "vertex":
        current?.points.append(SIMD3(Float(a["x"] ?? "") ?? 0, Float(a["y"] ?? "") ?? 0, Float(a["z"] ?? "") ?? 0))
      case "triangle":
        if let v1 = Int(a["v1"] ?? ""), let v2 = Int(a["v2"] ?? ""), let v3 = Int(a["v3"] ?? "") { current?.triangles.append((v1, v2, v3)) }
      case "component":
        current?.components.append((key(a["objectid"], path), ThreeMF.place(a["transform"])))
      case "item":
        items.append((key(a["objectid"], path), ThreeMF.place(a["transform"])))
      default:
        break
      }
    }

    func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
      if name.hasSuffix("object") { current = nil }
    }
  }

  static func read(_ data: Data) throws -> [SIMD3<Float>] {
    let zip = try Zip(data)
    let names = zip.names.filter { $0.lowercased().hasSuffix(".model") }
    var objects: [String: Object] = [:]
    var items: [(key: String, place: Place)] = []
    for name in names {
      let reader = Reader(path: name)
      let parser = XMLParser(data: try zip.read(name))
      parser.delegate = reader
      parser.parse()
      objects.merge(reader.objects) { a, _ in a }
      if name.lowercased() == "3d/3dmodel.model" { items = reader.items }
    }
    if items.isEmpty {
      items = objects.filter { !$0.value.triangles.isEmpty }.map { ($0.key, identity) }
    }
    var out = [SIMD3<Float>]()
    func add(_ key: String, _ place: Place, _ depth: Int) {
      guard depth < 16, let o = objects[key] else { return }
      for (a, b, c) in o.triangles where a < o.points.count && b < o.points.count && c < o.points.count {
        out.append(contentsOf: [apply(place, o.points[a]), apply(place, o.points[b]), apply(place, o.points[c])])
      }
      for c in o.components { add(c.key, then(c.place, place), depth + 1) }
    }
    for item in items { add(item.key, item.place, 0) }
    return out
  }
}

extension Data {
  /// A little-endian number at a byte offset from its start.
  nonisolated func le<T: FixedWidthInteger>(_: T.Type, at offset: Int) -> T {
    var value: T = 0
    Swift.withUnsafeMutableBytes(of: &value) { out in
      copyBytes(to: out.bindMemory(to: UInt8.self), from: (startIndex + offset)..<(startIndex + offset + MemoryLayout<T>.size))
    }
    return T(littleEndian: value)
  }

  nonisolated func le(_: Float.Type, at offset: Int) -> Float { Float(bitPattern: le(UInt32.self, at: offset)) }
}
