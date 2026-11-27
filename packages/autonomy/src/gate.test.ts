// The long-reply question is asked only past three sentences (gate.ts `sentences`): Nov 26, the
// model sent back 11 replies of three or fewer though the question says never.
import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"

import { sentences, takenUp } from "./gate.ts"

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

// Nov 27: `once` read the refusal's names through jsonOf, which finds only an object, so a cut
// redraft was asked again (a 309-character reply cut to 272, sent back as long twice).
test("a redraft cut after a long refusal isn't asked long again", () => {
  const db = new Database(":memory:")
  db.run(`CREATE TABLE gate_decisions (id TEXT PRIMARY KEY, exit TEXT NOT NULL, key TEXT NOT NULL,
    space TEXT NOT NULL, acted TEXT NOT NULL, pass INTEGER NOT NULL, digest TEXT NOT NULL,
    time INTEGER NOT NULL, cost REAL NOT NULL, outcome TEXT)`)
  db.run(
    "CREATE TABLE events (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL)",
  )
  const draft = "x".repeat(300)
  db.run(
    `INSERT INTO gate_decisions VALUES ('d1', 'reply', 'reply:t', 'home', '["long"]', 0, 'a', 1000, 0, NULL)`,
  )
  db.query("INSERT INTO events (id, payload) VALUES ('gate:d1', ?)").run(
    JSON.stringify({ text: draft }),
  )
  expect(takenUp(db, "reply", "reply:t", "x".repeat(260), 2000)).toEqual(["long"])
  expect(takenUp(db, "reply", "reply:t", "x".repeat(290), 2000)).toEqual([])
  expect(takenUp(db, "reply", "reply:other", "x".repeat(260), 2000)).toEqual([])
  // A decision after this one isn't what it answers.
  expect(takenUp(db, "reply", "reply:t", "x".repeat(260), 900)).toEqual([])
})
