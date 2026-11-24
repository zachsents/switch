// A task's report, read before it reaches the user (agent slots.ts `Reports`): the reply check's
// hands question, asked of the report as a say's is asked of the say (app.ts `say`). What needs
// their hands is an ask, not a report (Switchboard's sb/mcp.rs:2567).
import type { Database } from "bun:sqlite"
import { Reports } from "@switch/agent"
import type { Report } from "@switch/agent"
import { Brain, SpaceId } from "@switch/brain"
import { Models } from "@switch/models"
import { Effect, Layer } from "effect"

import { placeOf } from "./app.ts"
import { openExpectations } from "./expect.ts"
import { gate } from "./gate.ts"
import { items } from "./items.ts"
import { rulesAt } from "./rules.ts"

/** What the task was started with: its brief, the first words in its thread. */
const briefOf = (db: Database, thread: string) =>
  db
    .query<{ text: string }, [string]>(
      `SELECT json_extract(body, '$.text') AS text FROM thread_items WHERE thread = ?
         AND json_extract(body, '$.kind') = 'user' AND trim(json_extract(body, '$.text')) != ''
       ORDER BY seq LIMIT 1`,
    )
    .get(thread)?.text ?? ""

/** What the report is read against: the task's brief, their open items, open expectations. */
export const reportContext = (db: Database, report: Report, space: string) => {
  const brief = briefOf(db, report.thread)
  return [
    `The task it reports on: ${report.title}${brief === "" ? "" : `\nIts brief:\n${brief.slice(0, 2000)}`}`,
    `Their open items: ${
      items(db, { status: "open" })
        .map((i) => `${i.title} (${i.space})`)
        .join("; ") || "none"
    }`,
    `Open expectations: ${
      openExpectations(db, [space])
        .map((x) => x.what)
        .join("; ") || "none"
    }`,
  ].join("\n\n")
}

const read = (report: Report) =>
  Effect.gen(function* reading() {
    const brain = yield* Brain
    const at = yield* brain.read((db) => {
      const space = SpaceId.make(placeOf(db, report.thread).space)
      return {
        space,
        context: reportContext(db, report, space),
        preferences: rulesAt(db, [space], report.text),
      }
    })
    const verdict = yield* gate("report", {
      key: `report:${report.turn}`,
      space: at.space,
      text: report.text,
      context: at.context,
      preferences: at.preferences,
      turn: report.turn,
      bypass: report.bypass,
      work: report.thread,
    })
    if (verdict.pass) {
      return null
    }
    return `Before this report goes to the user: ${verdict.reasons.join(" ")} If the check is wrong here, end on it again with a last line "bypass: why".`
  })

/** The Reports slot: each task's report read once before it goes. A read that fails lets it go. */
export const reportsLayer = Layer.effect(
  Reports,
  Effect.gen(function* making() {
    const brain = yield* Brain
    const models = yield* Models
    return {
      read: (report: Report) =>
        read(report).pipe(
          Effect.provideService(Brain, brain),
          Effect.provideService(Models, models),
          Effect.orElseSucceed(() => null),
        ),
    }
  }),
)
