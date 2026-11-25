// What a new brain starts with: a few opinionated rules, as memories the user can edit or forget
// like any other. Only a brain that has never held a memory gets them; one that has is never touched.
// And the resource alarms, wake rules every brain gets once each.
import { Brain, defineRead, EventId } from "@switch/brain"
import { Effect } from "effect"

import { embedMissing, GLOBAL, MemoryWritten } from "./memory.ts"
import { wakeRuleMemory } from "./rules.ts"

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

/** Whether the brain has never held a memory. */
const freshRead = defineRead(
  "autonomy/seeds/fresh",
  (db) => db.query("SELECT 1 FROM events WHERE type = 'memory.written' LIMIT 1").get() === null,
)

/** Of these memories' ids, those the brain holds. */
const heldRead = defineRead("autonomy/seeds/held", (db, ids: readonly string[]) => {
  const held = db.query("SELECT 1 FROM memories WHERE id = ?")
  return new Set(ids.filter((id) => held.get(id) !== null))
})

/** Writes the seeds into a brain that has never held a memory. */
export const seedMemories = Effect.gen(function* seeding() {
  const brain = yield* Brain
  const fresh = yield* brain.read(freshRead)
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

/** What each alarm's turn is for: easing it is the user's rules' to say. */
const EASE =
  "Ease it before the machine stalls everything on it, as the user's rules say: pause it, stop the newest job or move it to a box rented for it, or clean up. Only what needs the user reaches them."

/**
 * The resource alarms (core alarms.ts), from the vitals the Macs and the Linux box recorded Nov 20 to
 * 24, readings five minutes apart: on the Mac mini (10 cores, 16 GB) each rang in the trouble it's
 * for, and seldom besides.
 * - Free disk under 5 GB, over at 10: three times on the mini (Nov 20; Nov 22's full disk, 0.8 GB
 *   free; Nov 23's swap storm), twice on the MacBook Air. At 10 the mini, which keeps 10 to 15 GB
 *   free, would ring seven times, each lasting hours.
 * - Swap growing over 15 GB an hour, as twenty minutes' growth, over once it stops: the runaways of
 *   Nov 21 (75 GB, and another) and Nov 23's storm of image jobs (2.5 GB to 12 in an hour and a
 *   quarter). Over ten minutes it rang eleven times, at a gigabyte's swap file or two.
 * - Memory pressure critical, over at normal: the same three.
 * - The load over five minutes past three times the cores, over under one and a half: ten times on
 *   the mini, each a pile-up (load 30 to 300), twice on the Air; at twice the cores, fifteen.
 */
const ALARMS: readonly {
  readonly name: string
  readonly question: string
  readonly alarm: Readonly<Record<string, unknown>>
}[] = [
  {
    name: "Low disk",
    question: "A machine's free disk is under 5 GB: what writes there is about to fail.",
    alarm: { on: "diskFreeGb", below: 5, clear: 10, by: "memory" },
  },
  {
    name: "Swap storm",
    question:
      "A machine's swap is growing over 15 GB an hour: what's outgrowing its memory will fill the disk.",
    alarm: { on: "swapGrowthGbPerHour", above: 15, clear: 0, by: "memory" },
  },
  {
    name: "Memory critical",
    question: "A machine's memory pressure is critical: everything on it slows to a crawl.",
    alarm: { on: "pressure", is: "critical", clear: "normal", by: "memory" },
  },
  {
    name: "Load over cores",
    question:
      "A machine's load over five minutes is past three times its cores: its jobs are piling up.",
    alarm: { on: "load5/cores", above: 3, clear: 1.5, by: "cpu" },
  },
]

/** Writes each resource alarm a brain has never held: one changed or forgotten since stays so. */
export const seedAlarms = Effect.gen(function* seeding() {
  const brain = yield* Brain
  const all = ALARMS.map((a) => ({
    a,
    kept: wakeRuleMemory({
      name: a.name,
      question: a.question,
      goal: EASE,
      wakes: {},
      at: null,
      alarm: a.alarm,
      from: "A seed: every brain starts with it.",
    }),
  }))
  const held = yield* brain.read(
    heldRead,
    all.map(({ kept }) => kept.name),
  )
  const fresh = all.filter(({ kept }) => !held.has(kept.name))
  if (fresh.length === 0) {
    return 0
  }
  yield* Effect.orDie(
    brain.ingest(
      fresh.map(({ kept }) => ({
        id: EventId.make(`seed:${kept.name}:1`),
        type: MemoryWritten.type,
        source: "seed",
        payload: {
          id: kept.name,
          name: kept.name,
          description: kept.description,
          type: "feedback",
          scope: GLOBAL,
          body: kept.body,
          trigger: null,
          replaces: [],
          decision: "",
        } satisfies typeof MemoryWritten.payload.Type,
      })),
    ),
  )
  yield* Effect.ignore(embedMissing, { log: "Warn" })
  return fresh.length
})
