// The wake rules are read by name from the `memories_name` index, never by reading every live
// memory's row (Nov 25: ~1,500 pages a call, 7 to 55 s once a deploy's read of a brain-sized file
// had pushed them out of the disk cache).
import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { spacesConfig } from "@switch/brain"

import { GLOBAL, memories } from "./memory.ts"
import { alarmsOf, LIVE_RULES, wakeRuleMemory, wakeRulesOf } from "./rules.ts"

const brain = () => {
  const db = new Database(":memory:", { strict: true })
  for (const p of spacesConfig.projections) {
    db.run(p.create)
  }
  db.run(memories.create)
  db.run(memories.indexes ?? "")
  return db
}

let at = 0
const put = (
  db: Database,
  m: { readonly name: string; readonly description: string; readonly body: string },
  status = "live",
) => {
  at += 1
  db.query(
    `INSERT INTO memories (id, name, description, type, scope, body, decision, status, written_at)
     VALUES (?, ?, ?, 'feedback', ?, ?, '', ?, ?)`,
  ).run(`m${String(at)}`, m.name, m.description, GLOBAL, m.body, status, at)
}

const rule = (name: string, alarm?: Readonly<Record<string, unknown>>) =>
  wakeRuleMemory({
    name,
    question: `Does ${name} need the user?`,
    goal: "",
    wakes: { streams: ["mail"], kinds: ["message"] },
    at: 0.5,
    ...(alarm && { alarm }),
    from: "Written by the agent.",
  })

test("the wake rules are every live wake-rule memory, in the order written", () => {
  const db = brain()
  put(db, rule("New mail"))
  put(db, { name: "wake-rules-are-terse", description: "A preference", body: "Keep them short." })
  put(db, { name: "wake-rulebook", description: "Not a rule", body: "-" })
  put(db, { name: "wake-rule", description: "Not a rule", body: "-" })
  put(db, rule("Old mail"), "replaced")
  put(db, rule("Low disk", { on: "diskFreeGb", below: 5 }))
  put(db, rule("Shipping update"))
  expect(wakeRulesOf(db, [GLOBAL]).map((r) => r.title)).toEqual(["New mail", "Shipping update"])
  expect(alarmsOf(db).map((a) => a.title)).toEqual(["Low disk"])
})

test("they're found from the name index, not a read of every live memory", () => {
  const db = brain()
  const plan = db
    .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${LIVE_RULES}`)
    .all()
    .map((r) => r.detail)
  expect(plan).toContain(
    "SEARCH memories USING INDEX memories_name (status=? AND name>? AND name<?)",
  )
})
