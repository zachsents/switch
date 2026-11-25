// Which work made a tool call. An app's tool hears only its input, but the agent's session records
// each call it makes (`turn.tool`) as it streams, before the call reaches the app: the newest
// recent record of this tool whose input matches is the caller's.
import { Brain, defineRead, seqAt, ThreadId } from "@switch/brain"
import { Effect } from "effect"

import { field, text } from "./json.ts"

interface Row {
  readonly thread: string
  readonly name: string
  readonly input: string
}

const parse: (json: string) => unknown = JSON.parse

const TRIES = 15
const RECENT_MS = 5 * 60_000

/** The latest recorded tool calls since `since`, the newest first: the caller is found among them. */
const callsRead = defineRead("autonomy/caller/calls", (db, since: number) =>
  db
    .query<Row, [number]>(
      `SELECT json_extract(payload, '$.thread') AS thread, json_extract(payload, '$.name') AS name,
         json_extract(payload, '$.input') AS input
       FROM events WHERE type = 'turn.tool' AND seq >= ? ORDER BY seq DESC LIMIT 200`,
    )
    .all(seqAt(db, since)),
)

/** The input a recorded call gave `tool`, directly or through the gateway's `call_tool`. */
export const inputFor = (tool: string, name: string, input: unknown) => {
  if (name.endsWith(tool)) {
    return input
  }
  return name.endsWith("call_tool") && text(field(input, "name")).endsWith(tool)
    ? field(input, "arguments")
    : undefined
}

/** The thread whose call of `tool` (`<app>_<tool>`) gave an input `matches` accepts; null for an extension's. */
export const callerOf = (tool: string, matches: (input: unknown) => boolean) =>
  Effect.gen(function* finding() {
    const brain = yield* Brain
    for (let i = 0; i < TRIES; i += 1) {
      const calls = yield* brain.read(callsRead, Date.now() - RECENT_MS)
      const found = calls.find((r) => {
        const given = inputFor(tool, r.name, parse(r.input ?? "null"))
        return given !== undefined && matches(given)
      })
      if (found) {
        return ThreadId.make(found.thread)
      }
      yield* Effect.sleep("100 millis")
    }
    return null
  })

/** Whether a recorded input gave `key` as `value`. */
export const gave = (key: string, value: unknown) => (input: unknown) =>
  JSON.stringify(field(input, key)) === JSON.stringify(value)
