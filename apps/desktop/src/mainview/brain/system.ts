// The memory and system pages' reads: pages of the brain's view (packages/core/src/system.ts),
// asked over the socket and checked as they come.
import { recordsOf } from "@switch/brain/commands"
import { queryOptions } from "@tanstack/react-query"
import { Schema } from "effect"

import { page } from "./client.ts"
import { rec } from "./json.ts"

const MemoryRow = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  type: Schema.String,
  /** "global" or a space. */
  scope: Schema.String,
  body: Schema.String,
  triggered: Schema.Boolean,
  uses: Schema.Number,
})
export type MemoryRow = typeof MemoryRow.Type

/** Each memory that reads; one that doesn't is left out, said in the log. */
const decodeMemories = recordsOf("memory", MemoryRow)

export const memoriesQuery = queryOptions({
  queryKey: ["memories"],
  queryFn: async () => decodeMemories(await page("memories", {})),
  // Held from launch (use-prefetch.ts), so Memory opens drawn.
  gcTime: Infinity,
})

const Spend = Schema.Struct({ day: Schema.String, cost: Schema.Number, turns: Schema.Number })

const Turn = Schema.Struct({
  time: Schema.Number,
  thread: Schema.String,
  title: Schema.String,
  status: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  cost: Schema.Number,
  ms: Schema.Number,
  host: Schema.String,
})

const Permissions = Schema.Struct({
  machine: Schema.String,
  time: Schema.Number,
  granted: Schema.Array(Schema.Struct({ name: Schema.String, on: Schema.Boolean })),
})

const Debug = Schema.Struct({
  seq: Schema.Number,
  bytes: Schema.Number,
  projections: Schema.Array(Schema.Struct({ name: Schema.String, version: Schema.Number })),
  types: Schema.Array(Schema.Struct({ type: Schema.String, n: Schema.Number })),
})

export interface System {
  readonly spend: readonly (typeof Spend.Type)[]
  readonly turns: readonly (typeof Turn.Type)[]
  readonly permissions: readonly (typeof Permissions.Type)[]
  readonly debug: typeof Debug.Type
}

const spendOf = recordsOf("day's spend", Spend)
const turnsOf = recordsOf("turn", Turn)
const permissionsOf = recordsOf("machine's permissions", Permissions)
const debugOf = Schema.decodeUnknownSync(Debug)

/** The page, each of its rows read on its own: one that doesn't read is left out. */
const decodeSystem = (raw: unknown): System => {
  const s = rec(raw)
  return {
    spend: spendOf(s.spend),
    turns: turnsOf(s.turns),
    permissions: permissionsOf(s.permissions),
    debug: debugOf(s.debug),
  }
}

export const systemQuery = queryOptions({
  queryKey: ["system"],
  queryFn: async () => decodeSystem(await page("system", {})),
  refetchInterval: 30_000,
  // Refresh only while the System section has a mounted observer.
  staleTime: 30_000,
  gcTime: Infinity,
})
