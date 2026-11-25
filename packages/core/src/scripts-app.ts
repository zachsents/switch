// The agent's tools for scripts (scripts.ts): set one, list them with a log, retire one.
import { Brain, defineRead, machines, spaceFor } from "@switch/brain"
import { Caller, defineApp, Rejected, tool } from "switch-ext-kit"
import { Effect, Schema } from "effect"

import { CoreConfig } from "./config.ts"
import { Runtime } from "./runtime.ts"
import { getScript, listScripts, RetireScript, scriptId, SetScript } from "./scripts.ts"
import type { Script } from "./scripts.ts"

const LINES = 50

/** A space by its id or name, else the asker's, else Home. */
const spaceRead = defineRead("core/scripts-app/space", spaceFor)
/** The machines' names. */
const machinesRead = defineRead("core/scripts-app/machines", (db) =>
  machines(db).map((m) => m.machine),
)
/** The scripts not retired, in a space or everywhere. */
const listRead = defineRead("core/scripts-app/list", (db, space: string | undefined) =>
  listScripts(db, space),
)
/** A script. */
const scriptRead = defineRead("core/scripts-app/script", getScript)

/** Where a script lives: the space given, else the asking work's, else Home. */
const spaceOf = (given: string | undefined) =>
  Effect.gen(function* resolving() {
    const brain = yield* Brain
    const caller = yield* Caller
    return yield* brain.read(spaceRead, given, caller.space)
  })

const shown = (s: Script) => ({
  name: s.name,
  space: s.space,
  machine: s.machine,
  status: s.status,
  restarts: s.restarts,
  ...(s.code !== null && { code: s.code }),
  setAt: new Date(s.setAt).toISOString(),
  ...(s.endedAt !== null && { endedAt: new Date(s.endedAt).toISOString() }),
})

export const scriptsApp = defineApp<Brain | Runtime | CoreConfig>({
  name: "scripts",
  version: "1",
  instructions:
    "Scripts Switch runs outside any turn, which fire events for watches: for waits on what nothing records.",
  tools: [
    tool(
      "set",
      {
        description: `Run a script outside any turn, on a Mac (machine; the core's own, always on, by default), for what nothing records: a port opening, a file appearing, a page changing, a command's result. It never holds a turn or a deploy.
- run: the script, sh unless it starts with #!.
- It fires an event with \`switch event <event> [json]\`: recorded in this space as type <event>, source script, payload {stream: "scripts/<name>", script: <name>, space, data: <json>}. Watch it with expect's when: {"from": "events", "where": [{"field": "type", "op": "==", "value": "<event>"}, {"field": "payload.script", "op": "==", "value": "<name>"}]}.
- Ending on its own is the event script.ended, data {code, tail} (its exit code and last lines), the same way: watch that for a command's end.
- A deploy or a host's restart leaves it running. After a reboot or a kill it's started again from the top (list shows restarts), so write it safe to rerun.
- It's retired with its work (a task dropped, its space archived), by retire, or replaced by setting the same name again.`,
        input: Schema.Struct({
          name: Schema.String,
          run: Schema.String,
          machine: Schema.optionalKey(Schema.String),
          space: Schema.optionalKey(Schema.String),
        }),
      },
      (input) =>
        Effect.gen(function* setting() {
          const brain = yield* Brain
          const c = yield* CoreConfig
          const caller = yield* Caller
          const name = input.name.trim()
          if (name === "" || input.run.trim() === "") {
            return yield* new Rejected({ reason: "Give a name and the script to run" })
          }
          const machine = input.machine ?? c.machine
          const known = yield* brain.read(machinesRead)
          if (!known.includes(machine)) {
            return yield* new Rejected({
              reason: `No machine ${machine}: ${known.join(", ")}`,
            })
          }
          const space = yield* spaceOf(input.space)
          const id = scriptId(space, name)
          yield* brain.dispatch({
            id: crypto.randomUUID(),
            type: SetScript.type,
            source: "agent",
            payload: {
              id,
              name,
              space,
              ...(caller.thread !== null && { thread: caller.thread }),
              machine,
              run: input.run,
            },
          })
          return { name, space, machine }
        }),
    ),
    tool(
      "list",
      {
        description: `Scripts not retired (in space, when given): each one's machine, status (running, ended), restarts and exit code. With name, that one's script and the last lines of its output (lines, default ${LINES}).`,
        readOnly: true,
        input: Schema.Struct({
          name: Schema.optionalKey(Schema.String),
          space: Schema.optionalKey(Schema.String),
          lines: Schema.optionalKey(Schema.Finite),
        }),
      },
      (input) =>
        Effect.gen(function* listing() {
          const brain = yield* Brain
          const runtime = yield* Runtime
          if (input.name === undefined) {
            const space = input.space === undefined ? undefined : yield* spaceOf(input.space)
            return (yield* brain.read(listRead, space)).map(shown)
          }
          const id = scriptId(yield* spaceOf(input.space), input.name.trim())
          const s = yield* brain.read(scriptRead, id)
          if (s === null || s.status === "retired") {
            return yield* new Rejected({ reason: `No script ${input.name}` })
          }
          const lines = Math.max(1, Math.round(input.lines ?? LINES))
          const log = yield* runtime.tail(s.machine, s.id, lines)
          return { ...shown(s), run: s.run, log: log ?? "No log" }
        }),
    ),
    tool(
      "retire",
      {
        description: "Stop a script and clear it, with its log.",
        input: Schema.Struct({ name: Schema.String, space: Schema.optionalKey(Schema.String) }),
      },
      (input) =>
        Effect.gen(function* retiring() {
          const brain = yield* Brain
          const id = scriptId(yield* spaceOf(input.space), input.name.trim())
          yield* brain.dispatch({
            id: crypto.randomUUID(),
            type: RetireScript.type,
            source: "agent",
            payload: { id, why: "asked" },
          })
          return { retired: input.name }
        }),
    ),
  ],
})
