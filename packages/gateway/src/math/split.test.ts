import { expect, test } from "bun:test"
import cases from "./cases.json"
import { splitMath } from "./split.ts"

test("math is found as on every surface", () => {
  for (const c of cases) {
    expect([c.in, splitMath(c.in).map((s) => [s.kind, s.text])]).toEqual([c.in, c.out])
  }
})
