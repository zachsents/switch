// The long-reply question is asked only past three sentences (gate.ts `sentences`): Nov 26, the
// model sent back 11 replies of three or fewer though the question says never.
import { expect, test } from "bun:test"

import { sentences } from "./gate.ts"

test("sentences count what a reader counts", () => {
  expect(sentences("Yes. It's 0.5 mm, see [the page](https://a.b/c.d).")).toBe(2)
  expect(sentences("Two things:\n\n- **One:** a.\n- **Two:** b.\n\nDone?")).toBe(4)
  expect(
    sentences(
      "The knob rig is designed: [Manus test rig](https://x.y/p). 29 knobs, one per tendon. You may need 29 M3x20 screws.",
    ),
  ).toBe(3)
  expect(sentences("")).toBe(0)
})
