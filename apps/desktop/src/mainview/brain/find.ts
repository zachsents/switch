// The brain's find (packages/core/src/find.ts) as queries: across every space for ⌘K, and the
// matching lines' seqs within one chat for ⌘F.
import { recordsOf, SpaceId } from "@switch/brain/commands"
import { queryOptions } from "@tanstack/react-query"
import { Schema } from "effect"

import { page } from "./client.ts"

const Found = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("message"),
    id: Schema.String,
    space: SpaceId,
    seq: Schema.Number,
    time: Schema.Number,
    who: Schema.Literals(["user", "agent"]),
    line: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literals(["item", "memory"]),
    id: Schema.String,
    space: SpaceId,
    title: Schema.String,
    time: Schema.Number,
    line: Schema.String,
  }),
])
export type Found = typeof Found.Type

/** Each match that reads; one that doesn't is left out, said in the log. */
const decodeFound = recordsOf("find result", Found)
const decodeSeqs = Schema.decodeUnknownSync(Schema.Array(Schema.Number))

/** What was said and kept that holds the words, best first. */
export const findQuery = (query: string) =>
  queryOptions({
    queryKey: ["find", query],
    queryFn: async () => decodeFound(await page("find", { query })),
    enabled: query.trim() !== "",
    staleTime: 15_000,
  })

/** The seqs of a space's chat lines that hold the words, oldest first. */
export const findInQuery = (space: SpaceId, query: string) =>
  queryOptions({
    queryKey: ["find", space, query],
    queryFn: async () => decodeSeqs(await page("find", { query, space })),
    enabled: query.trim() !== "",
    staleTime: 5000,
  })
