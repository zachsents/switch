// Records read one at a time, as old Switchboard's Mac app read a view's rows (mac/src/ui/state.rs,
// `parse` and `row_as`): one that doesn't decode is left out and said once in the log, and the rest
// still show. Browser-safe: the core's views and the clients read records this way.
import { Result, Schema } from "effect"

/** Each kind of record and reason already said. */
const said = new Set<string>()

/** What names a record in the log: its `id`, else its `space` (a layout's), else "?". */
const idOf = (raw: unknown) => {
  if (typeof raw !== "object" || raw === null) {
    return "?"
  }
  if ("id" in raw && typeof raw.id === "string") {
    return raw.id
  }
  return "space" in raw && typeof raw.space === "string" ? raw.space : "?"
}

/**
 * Reads one record as `schema`: it, or null when it doesn't decode. `what` names the kind in the
 * log, and `id` the record (its own `id` when it has one).
 */
export const recordOf = <S extends Schema.ConstraintDecoder<unknown>>(what: string, schema: S) => {
  const decode = Schema.decodeUnknownResult(schema)
  return (raw: unknown, id = idOf(raw)): S["Type"] | null => {
    const read = decode(raw)
    if (Result.isSuccess(read)) {
      return read.success
    }
    const why = read.failure.message.replaceAll(/\s+/gu, " ")
    if (!said.has(`${what}: ${why}`)) {
      said.add(`${what}: ${why}`)
      console.warn(`couldn't read ${what} ${id}: ${why}`)
    }
    return null
  }
}

/** Each record in `raw` that reads as `schema`, in order; the rest are left out. */
export const recordsOf = <S extends Schema.ConstraintDecoder<unknown>>(what: string, schema: S) => {
  const read = recordOf(what, schema)
  return (raw: unknown): S["Type"][] =>
    (Array.isArray(raw) ? raw : []).flatMap((r: unknown) => {
      const got = read(r)
      return got === null ? [] : [got]
    })
}
