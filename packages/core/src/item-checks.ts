// Items that close themselves on a command (an item's `check`): what Switchboard's senses saw done
// for an ask's resolve_when (core/watches.rs:319-327, 802-812), a script sees here when nothing
// records it (an SSH login allowed elsewhere, a setting turned on). While an item with a check is
// open, its check runs as a script (scripts.ts) on the Mac it names, every 10 s until it exits 0;
// that end closes the item as resolved, and whoever waits on it hears (asks.ts). The script goes
// once the item closes, however it closed (watches.rs:367, a closed ask's watch retired).
import type { Database } from "bun:sqlite"
import {
  CloseItem,
  getItem,
  ItemAnswered,
  ItemClosed,
  ItemOpened,
  ItemReopened,
  ItemRevised,
} from "@switch/autonomy"
import type { ActionItem } from "@switch/autonomy"
import { Brain, react } from "@switch/brain"
import type { StoredEvent } from "@switch/brain"
import { Effect, Layer } from "effect"

import { CoreConfig } from "./config.ts"
import { listScripts, RetireScript, ScriptEnded, scriptId, SetScript } from "./scripts.ts"

const ITEM_EVENTS = new Set<string>([
  ItemOpened.type,
  ItemRevised.type,
  ItemReopened.type,
  ItemClosed.type,
  ItemAnswered.type,
])

const PREFIX = "check-"

/** How long between tries of a check that doesn't hold yet. */
const EVERY_S = 10

const nameOf = (item: string) => `${PREFIX}${item}`

/** The script a check runs as: the command, again and again until it succeeds. */
const looped = (run: string) =>
  `while :; do\n  if (\n${run}\n  ) >/dev/null 2>&1; then exit 0; fi\n  sleep ${String(EVERY_S)}\ndone\n`

const scriptOf = (db: Database, item: string) =>
  listScripts(db).find((s) => s.name === nameOf(item)) ?? null

const idOf = (payload: unknown) =>
  typeof payload === "object" && payload !== null && "id" in payload ? String(payload.id) : null

export const itemChecks = Layer.effectDiscard(
  Effect.gen(function* checking() {
    const brain = yield* Brain
    const { machine: core } = yield* CoreConfig

    const retire = (script: string, seq: number, why: string) =>
      brain
        .dispatch({
          id: `retire:${script}:${String(seq)}`,
          type: RetireScript.type,
          source: "core",
          payload: { id: script, why },
        })
        .pipe(Effect.catchTag("Rejected", (r) => Effect.logWarning(r.reason)))

    /** An item's check runs while it's open, as it stands now; otherwise its script goes. */
    const keep = (e: StoredEvent, id: string) =>
      Effect.gen(function* keeping() {
        const { item, script } = yield* brain.read((db) => ({
          item: getItem(db, id),
          script: scriptOf(db, id),
        }))
        const check = item?.status === "open" ? item.check : undefined
        const run = check ? looped(check.run) : null
        const machine = check?.machine ?? core
        if (
          item &&
          run !== null &&
          script?.status === "running" &&
          script.run === run &&
          script.machine === machine &&
          script.space === item.space
        ) {
          return
        }
        if (script && (run === null || script.space !== item?.space)) {
          yield* retire(script.id, e.seq, run === null ? "item closed" : "item moved")
        }
        if (item && run !== null) {
          yield* brain
            .dispatch({
              id: `check:${id}:${String(e.seq)}`,
              type: SetScript.type,
              source: "core",
              payload: {
                id: scriptId(item.space, nameOf(id)),
                name: nameOf(id),
                space: item.space,
                machine,
                run,
              },
            })
            .pipe(Effect.catchTag("Rejected", (r) => Effect.logWarning(r.reason)))
        }
      })

    /** Its check succeeded: it closes as resolved, by resolve.ts's id, so it closes once. */
    const held = (i: ActionItem) =>
      brain
        .dispatch({
          id: `resolved:${i.id}:${String(i.openedAt)}`,
          type: CloseItem.type,
          source: "autonomy",
          payload: {
            id: i.id,
            status: "resolved",
            why: `My senses confirmed it: \`${i.check?.run.trim() ?? ""}\` succeeded`,
          },
        })
        .pipe(Effect.catchTag("Rejected", (r) => Effect.logWarning(r.reason)))

    const ended = (e: StoredEvent) =>
      Effect.gen(function* ending() {
        const { script, data } = ScriptEnded.decode(e.payload)
        const code = typeof data === "object" && data !== null && "code" in data ? data.code : null
        if (!script.startsWith(PREFIX) || code !== 0) {
          return
        }
        const i = yield* brain.read((db) => getItem(db, script.slice(PREFIX.length)))
        if (i?.status === "open" && i.check) {
          yield* held(i)
        }
      })

    yield* Effect.forkScoped(
      react(
        "item-checks",
        (e) => ITEM_EVENTS.has(e.type) || e.type === ScriptEnded.type,
        (e) => {
          if (e.type === ScriptEnded.type) {
            return ended(e)
          }
          const id = idOf(e.payload)
          return id === null ? Effect.void : keep(e, id)
        },
      ),
    )
  }),
)
