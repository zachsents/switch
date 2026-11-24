// Staged memories through autonomy's one write path, carried: every one kept, merged only with a
// memory that says the same thing. Oldest first, a few at a time, then the core fields rebuilt.
// One an earlier distill dropped is taken again. Ones superseded or dismissed in Switchboard aren't.
import { buildCores, remember } from "@switch/autonomy"
import { Brain, EventId, SpaceId } from "@switch/brain"
import { Cause, Effect, Exit } from "effect"

import { MemoryImported, MigrateDistilled } from "./events.ts"
import { num, obj, str } from "./source.ts"

interface Staged {
  readonly seq: number
  readonly payload: string
}

const parseJson: (json: string) => unknown = JSON.parse

const SUPERSEDED = "Superseded in Switchboard"

/**
 * The user's own words a rule of theirs keeps, the newest of its quotes (protocol/src/whose.rs
 * `Said`): kept with it as said, so every turn reads it whole beside them (core/context.rs:260-277).
 */
const quoteOf = (m: Record<string, unknown>) =>
  (Array.isArray(m.said) ? m.said.map(obj) : [])
    .toSorted((a, b) => num(b.at) - num(a.at))
    .map((s) => str(s.words).trim())
    .find((w) => w !== "")

export interface Distilled {
  readonly taken: number
  /** Kept as a memory of its own. */
  readonly kept: number
  /** Kept by merging into memories already held. */
  readonly merged: number
  /** Superseded or dismissed in Switchboard: not asked about. */
  readonly skipped: number
  readonly errors: readonly string[]
  readonly cores: readonly { readonly scope: string; readonly tokens: number }[]
}

/** `cores`: rebuild the core fields after, which reads every rule: once, at the end. */
export const distill = (limit: number, concurrency: number, rebuild: boolean) =>
  Effect.gen(function* distilling() {
    const brain = yield* Brain
    const staged = yield* brain.read((db) =>
      db
        .query<Staged, [string, string, string, number]>(
          `SELECT seq, payload FROM events WHERE type = ?1 AND seq NOT IN
             (SELECT json_extract(payload, '$.seq') FROM events WHERE type = ?2
                AND (json_extract(payload, '$.kept') IS NOT NULL OR json_extract(payload, '$.why') = ?3))
           ORDER BY time LIMIT ?4`,
        )
        .all(MemoryImported.type, MigrateDistilled.type, SUPERSEDED, limit),
    )
    const counts = { kept: 0, merged: 0, skipped: 0 }
    const errors: string[] = []
    const take = (s: Staged) =>
      Effect.gen(function* taking() {
        const p = obj(parseJson(s.payload))
        const m = obj(p.memory)
        const quote = quoteOf(m)
        const done =
          str(m.replaced_by) !== "" || (typeof m.dismissed === "number" && m.dismissed > 0)
        const r = done
          ? ({ kept: false, why: SUPERSEDED } as const)
          : yield* remember({
              space: SpaceId.make(str(p.space)),
              lesson: str(p.statement),
              carried: true,
              ...(quote !== undefined && { quote }),
            })
        if (!r.kept) {
          counts.skipped += 1
        } else if (r.replaces.length > 0) {
          counts.merged += 1
        } else {
          counts.kept += 1
        }
        const d: typeof MigrateDistilled.payload.Type = {
          seq: s.seq,
          kept: r.kept ? r.id : null,
          replaces: r.kept ? [...r.replaces] : [],
          why: r.kept ? null : r.why,
        }
        yield* brain.ingest([
          {
            // Its own id: an earlier distill's drop of the same memory is recorded as `distilled:<seq>`.
            id: EventId.make(`distilled:${s.seq}:${r.kept ? "kept" : "skipped"}`),
            type: MigrateDistilled.type,
            source: "migrate",
            payload: d,
          },
        ])
      })
    // A failed one stays staged for the next run.
    const noted = <A, E, R>(effect: Effect.Effect<A, E, R>, what: string) =>
      Effect.gen(function* noting() {
        const exit = yield* Effect.exit(effect)
        if (Exit.isFailure(exit)) {
          errors.push(`${what}${Cause.pretty(exit.cause).split("\n")[0] ?? ""}`)
        }
      })
    yield* Effect.forEach(staged, (s) => noted(take(s), ""), { concurrency, discard: true })
    if (rebuild) {
      yield* noted(buildCores, "cores: ")
    }
    const cores = yield* brain.read((db) =>
      db
        .query<{ scope: string; tokens: number }, []>(
          "SELECT scope, tokens FROM memory_cores ORDER BY scope",
        )
        .all(),
    )
    return { taken: staged.length, ...counts, errors, cores } satisfies Distilled
  })
