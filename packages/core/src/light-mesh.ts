// A model light enough to send to a chat's viewer: an STL of more triangles than a viewer needs is
// simplified to about LIGHT triangles (meshoptimizer), as a binary STL. A scan or a CFD part can be
// millions of triangles, 100 MB that takes minutes over a phone's or a laptop's link; its light copy
// is a few MB and looks the same in a chat. Anything else is itself. It's made by `switch light`, a
// child of the core (blobs.ts): a second or more of work the core's thread can't give.
import { MeshoptSimplifier } from "meshoptimizer"
import { BufferAttribute, BufferGeometry, Mesh } from "three"
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js"

/** Triangles a viewer gets, at most. */
export const LIGHT = 120_000

/** An STL's corners, nine numbers a triangle; null when it isn't one. */
const cornersOf = (data: ArrayBuffer): Float32Array | null => {
  try {
    const corners = new STLLoader().parse(data).getAttribute("position").array
    return corners instanceof Float32Array && corners.length >= 9 ? corners : null
  } catch {
    // Not an STL: a GLB, a 3MF or an OBJ reads as a binary one of more triangles than it holds.
    return null
  }
}

/** A model's light copy as a binary STL; null when it's light already or isn't an STL. */
export const lightStl = async (data: ArrayBuffer, most = LIGHT) => {
  const corners = cornersOf(data)
  if (corners === null || corners.length / 9 <= most) {
    return null
  }
  await MeshoptSimplifier.ready
  // An STL is a soup, each triangle with corners of its own: welded first, so the simplifier sees
  // one surface rather than loose triangles it can't merge. Measured on a 1.8M-triangle scan,
  // welded `simplify` keeps rims and holes crisp that `simplifySloppy` leaves jagged, in 0.8 s.
  const indices = MeshoptSimplifier.generatePositionRemap(corners, 3)
  const [remap, count] = MeshoptSimplifier.compactMesh(indices)
  const welded = new Float32Array(count * 3)
  for (const [from, to] of remap.entries()) {
    if (to !== 0xff_ff_ff_ff) {
      welded.set(corners.subarray(from * 3, from * 3 + 3), to * 3)
    }
  }
  const [kept] = MeshoptSimplifier.simplify(indices, welded, 3, most * 3, 1)
  const geometry = new BufferGeometry()
  geometry.setAttribute("position", new BufferAttribute(welded, 3))
  geometry.setIndex(new BufferAttribute(kept, 1))
  return new Uint8Array(new STLExporter().parse(new Mesh(geometry), { binary: true }).buffer)
}

/** `switch light <model> <copy>`: the model's light copy, gzipped, at <copy>; none, nothing. */
export const light = async ([model = "", copy = ""]: readonly string[]) => {
  const stl = await lightStl(await Bun.file(model).arrayBuffer())
  if (stl !== null) {
    await Bun.write(copy, Bun.gzipSync(stl))
  }
}
