// A 3MF's build as a binary STL, for Preview, which opens STL and OBJ but not 3MF. A 3MF is a zip
// of XML models: objects are meshes or components of other objects (maybe in other model files),
// placed by the build's items, each with a 3x4 transform.
import { strFromU8, unzipSync } from "fflate"

type Matrix = readonly number[]

const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

const attrs = (tag: string) => {
  const out = new Map<string, string>()
  for (const m of tag.matchAll(/(?<key>[\w:]+)="(?<value>[^"]*)"/gu)) {
    out.set(m.groups?.key ?? "", m.groups?.value ?? "")
  }
  return out
}

const matrixOf = (said: string | undefined): Matrix => {
  const n = (said ?? "").trim().split(/\s+/u).map(Number)
  return n.length === 12 && n.every((x) => Number.isFinite(x)) ? n : IDENTITY
}

/** `a` then `b`, as 3MF composes them (row vectors). */
const then = (a: Matrix, b: Matrix): Matrix => {
  // Each as a 4x4 whose last column is 0, 0, 0, 1.
  const at = (m: Matrix, r: number, c: number) => {
    if (c === 3) {
      return r === 3 ? 1 : 0
    }
    return m[r * 3 + c] ?? 0
  }
  const out: number[] = []
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      let s = 0
      for (let k = 0; k < 4; k += 1) {
        s += at(a, r, k) * at(b, k, c)
      }
      out.push(s)
    }
  }
  return out
}

const apply = (m: Matrix, x: number, y: number, z: number) => [
  x * (m[0] ?? 0) + y * (m[3] ?? 0) + z * (m[6] ?? 0) + (m[9] ?? 0),
  x * (m[1] ?? 0) + y * (m[4] ?? 0) + z * (m[7] ?? 0) + (m[10] ?? 0),
  x * (m[2] ?? 0) + y * (m[5] ?? 0) + z * (m[8] ?? 0) + (m[11] ?? 0),
]

interface Mesh {
  readonly vertices: number[]
  readonly triangles: number[]
}
interface Part {
  readonly key: string
  readonly transform: Matrix
}
type Thing = { readonly mesh: Mesh } | { readonly parts: readonly Part[] }

const keyOf = (file: string, id: string) => `${file}#${id}`

/** Each object in one model file, by its key. */
const objectsIn = (file: string, xml: string, into: Map<string, Thing>) => {
  for (const m of xml.matchAll(/<object\b(?<tag>[^>]*)>(?<body>[\s\S]*?)<\/object>/gu)) {
    const id = attrs(m.groups?.tag ?? "").get("id") ?? ""
    const body = m.groups?.body ?? ""
    if (body.includes("<mesh")) {
      const vertices: number[] = []
      for (const v of body.matchAll(/<vertex\b(?<tag>[^>]*)\/>/gu)) {
        const a = attrs(v.groups?.tag ?? "")
        vertices.push(Number(a.get("x")), Number(a.get("y")), Number(a.get("z")))
      }
      const triangles: number[] = []
      for (const t of body.matchAll(/<triangle\b(?<tag>[^>]*)\/>/gu)) {
        const a = attrs(t.groups?.tag ?? "")
        triangles.push(Number(a.get("v1")), Number(a.get("v2")), Number(a.get("v3")))
      }
      into.set(keyOf(file, id), { mesh: { vertices, triangles } })
    } else {
      const parts = [...body.matchAll(/<component\b(?<tag>[^>]*)\/>/gu)].map((c) => {
        const a = attrs(c.groups?.tag ?? "")
        return {
          key: keyOf(a.get("p:path") ?? file, a.get("objectid") ?? ""),
          transform: matrixOf(a.get("transform")),
        }
      })
      into.set(keyOf(file, id), { parts })
    }
  }
}

/** The model's triangles, placed, as a binary STL; null when it holds none. */
export const threeMfToStl = (zip: Uint8Array) => {
  const files = unzipSync(zip)
  const text = (name: string) => {
    const bytes = files[name.replace(/^\//u, "")]
    return bytes ? strFromU8(bytes) : ""
  }
  const rels = text("_rels/.rels")
  const rootRel = [...rels.matchAll(/<Relationship\b(?<tag>[^>]*)\/>/gu)]
    .map((m) => attrs(m.groups?.tag ?? ""))
    .find((a) => (a.get("Type") ?? "").endsWith("/3dmodel"))
  const root = `/${(rootRel?.get("Target") ?? "/3D/3dmodel.model").replace(/^\//u, "")}`
  const objects = new Map<string, Thing>()
  for (const name of Object.keys(files)) {
    if (name.endsWith(".model")) {
      objectsIn(`/${name}`, text(name), objects)
    }
  }
  const out: number[] = []
  const place = (key: string, m: Matrix, depth: number) => {
    const thing = objects.get(key)
    if (!thing || depth > 16) {
      return
    }
    if ("parts" in thing) {
      for (const p of thing.parts) {
        place(p.key, then(p.transform, m), depth + 1)
      }
      return
    }
    const { vertices, triangles } = thing.mesh
    for (const i of triangles) {
      out.push(
        ...apply(m, vertices[i * 3] ?? 0, vertices[i * 3 + 1] ?? 0, vertices[i * 3 + 2] ?? 0),
      )
    }
  }
  for (const m of text(root).matchAll(/<item\b(?<tag>[^>]*)\/>/gu)) {
    const a = attrs(m.groups?.tag ?? "")
    place(keyOf(a.get("p:path") ?? root, a.get("objectid") ?? ""), matrixOf(a.get("transform")), 0)
  }
  const count = out.length / 9
  if (count === 0) {
    return null
  }
  const stl = new DataView(new ArrayBuffer(84 + count * 50))
  stl.setUint32(80, count, true)
  for (let t = 0; t < count; t += 1) {
    const p = (k: number) => out[t * 9 + k] ?? 0
    const [ux, uy, uz] = [p(3) - p(0), p(4) - p(1), p(5) - p(2)]
    const [vx, vy, vz] = [p(6) - p(0), p(7) - p(1), p(8) - p(2)]
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
    const length = Math.hypot(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0) || 1
    const at = 84 + t * 50
    for (let k = 0; k < 3; k += 1) {
      stl.setFloat32(at + k * 4, (n[k] ?? 0) / length, true)
    }
    for (let k = 0; k < 9; k += 1) {
      stl.setFloat32(at + 12 + k * 4, p(k), true)
    }
  }
  return new Uint8Array(stl.buffer)
}
