import { expect, test } from "bun:test"

import { Link } from "./link.ts"
import { xcamControl } from "./payloads.ts"
import { simDial } from "./sim.ts"
import { plateMarkerOf } from "./state.ts"

test("the plate marker check turns off and on over the wire, and a printer without it refuses", async () => {
  const p1s = new Link("sim-p1s", simDial, true)
  const p1p = new Link("sim-p1p", simDial, true)
  try {
    expect(await p1s.waitFor((r) => plateMarkerOf(r) === true, 2000)).toBe(true)
    const off = await p1s.send(xcamControl(p1s.nextSeq(), "buildplate_marker_detector", false))
    expect(off?.ok).toBe(true)
    expect(await p1s.waitFor((r) => plateMarkerOf(r) === false, 2000)).toBe(true)
    await p1s.send(xcamControl(p1s.nextSeq(), "buildplate_marker_detector", true))
    expect(await p1s.waitFor((r) => plateMarkerOf(r) === true, 2000)).toBe(true)

    expect(await p1p.waitFor((r) => typeof r.gcode_state === "string", 2000)).toBe(true)
    expect(plateMarkerOf(p1p.raw)).toBeUndefined()
    const refused = await p1p.send(xcamControl(p1p.nextSeq(), "buildplate_marker_detector", false))
    expect(refused?.ok).toBe(false)
  } finally {
    p1s.close()
    p1p.close()
  }
})
