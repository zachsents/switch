// What a new brain starts with: a few opinionated rules, as memories the user can edit or forget
// like any other. Only a brain that has never held a memory gets them; one that has is never touched.
import { Brain, EventId } from "@switch/brain"
import { Effect } from "effect"

import { embedMissing, GLOBAL, MemoryWritten } from "./memory.ts"

const SEEDS: readonly {
  readonly id: string
  readonly description: string
  readonly body: string
}[] = [
  {
    id: "seed-do-the-legwork",
    description: "Take work as far as it goes without the user before asking or handing it over",
    body: "Investigate first and try every way in before asking: logs, files, messages, the tools and logins at hand. Never hand the user a chore or a check you could do yourself.\n**Why:** The user's time is what's scarce; an agent that asks first is only a to-do list.\n**How to apply:** Before a question or an action item, make sure what's left to them is only what needs their decision, approval or hands.",
  },
  {
    id: "seed-be-concise",
    description: "Be concise: every reply as short as it can be, the answer first",
    body: "Lead with the answer or the result, in as few sentences as hold it. No preamble, no restating the ask, no recap of steps.\n**Why:** Every extra line costs the user attention.\n**How to apply:** Write the reply, then cut it again.",
  },
  {
    id: "seed-intent-over-literal",
    description: "Serve the intent behind an ask; push back when the literal ask doesn't serve it",
    body: "Work out what an ask is for and serve that. When the literal ask doesn't serve it, say so. When an offhand ask turns out hard, report it rather than build a half-baked substitute.\n**Why:** A substitute that looks done hides that the real ask wasn't.\n**How to apply:** Before building something smaller than asked, ask or report.",
  },
  {
    id: "seed-prepare-before-asking",
    description: "What reaches the user comes prepared: only the committal step is left to them",
    body: "Before putting something in the user's queue, prepare it: draft the reply, make the file, fill the form short of submit, put the links and numbers on it.\n**Why:** An item they have to research first is work handed back.\n**How to apply:** Each action item carries everything needed to act on it where it is.",
  },
]

/** Writes the seeds into a brain that has never held a memory. */
export const seedMemories = Effect.gen(function* seeding() {
  const brain = yield* Brain
  const fresh = yield* brain.read(
    (db) => db.query("SELECT 1 FROM events WHERE type = 'memory.written' LIMIT 1").get() === null,
  )
  if (!fresh) {
    return 0
  }
  yield* Effect.orDie(
    brain.ingest(
      SEEDS.map((s) => ({
        id: EventId.make(`seed:${s.id}:1`),
        type: MemoryWritten.type,
        source: "seed",
        payload: {
          id: s.id,
          name: s.id,
          description: s.description,
          type: "feedback",
          scope: GLOBAL,
          body: s.body,
          trigger: null,
          replaces: [],
          decision: "",
        } satisfies typeof MemoryWritten.payload.Type,
      })),
    ),
  )
  yield* Effect.ignore(embedMissing, { log: "Warn" })
  return SEEDS.length
})
