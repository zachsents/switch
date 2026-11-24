// Every change is one of the extension's tools, the same ones the agent calls. Each marks the
// contacts queries stale when it lands; the brain's events do the same for changes made elsewhere.
import { mutationOptions } from "@tanstack/react-query"

import { Done } from "./answers.ts"
import type { PersonType } from "./answers.ts"
import { call } from "./core.ts"
import { queryClient } from "./query.ts"
import { CONTACTS } from "./queries.ts"

const settle = async () => {
  await queryClient.invalidateQueries({ queryKey: CONTACTS })
}

export interface Stated {
  readonly kind: string
  readonly value: string
}

/** The user's own edit: added fields are theirs, and their own may go. */
export const updateMutation = mutationOptions({
  mutationKey: [...CONTACTS, "update"],
  mutationFn: async (input: {
    person?: string
    add?: readonly Stated[]
    remove?: readonly string[]
    create?: boolean
  }) => await call("update", { ...input, user: true }, Done),
  onSettled: settle,
})

/** Single fields `set` takes; null clears one. */
export type Settable =
  | "given"
  | "family"
  | "initial"
  | "nickname"
  | "relationship"
  | "note"
  | "company"
  | "role"

/** Single fields set or cleared whole, and labels on and off, as the user's own. */
export const setMutation = mutationOptions({
  mutationKey: [...CONTACTS, "set"],
  mutationFn: async (
    input: { person: string } & Partial<Record<Settable, string | null>> & {
        type?: PersonType | null
        labels?: { add?: readonly string[]; remove?: readonly string[] }
      },
  ) => await call("set", input, Done),
  onSettled: settle,
})

export const mergeMutation = mutationOptions({
  mutationKey: [...CONTACTS, "merge"],
  mutationFn: async (input: { into: string; from: readonly string[] }) =>
    await call("merge", input, Done),
  onSettled: settle,
})

export const undoMutation = mutationOptions({
  mutationKey: [...CONTACTS, "undo"],
  mutationFn: async (batch: string) => await call("undo", { batch }, Done),
  onSettled: settle,
})

export const importMutation = mutationOptions({
  mutationKey: [...CONTACTS, "import"],
  mutationFn: async () => await call("import", {}, Done),
  onSettled: settle,
})
