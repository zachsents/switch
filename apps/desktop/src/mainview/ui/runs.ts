// How a chat's lines sit, as iMessage: a side's lines within 5 minutes run together, the last of a
// run with the tail; a 10-minute quiet puts the time over the next line.
import type { Lead } from "./chat.tsx"
import type { Entry } from "./chat-asks.ts"

/** Lines from one side this close run together. */
const RUN_MS = 5 * 60_000
/** A quiet this long puts the time over the next line. */
const GAP_MS = 10 * 60_000

/** Said, in a bubble: not a quiet line or a widget. */
const said = (e: Entry | undefined) =>
  e?.kind === "line" && !e.line.quiet && !e.line.widget && e.line.text !== ""

/** Each entry's lead, and the keys of those that end their run. */
export const runs = (entries: readonly Entry[]) => {
  const leads = new Map<string, Lead>()
  let last: number | undefined
  for (const [i, e] of entries.entries()) {
    const time = e.kind === "line" ? e.line.time : undefined
    if (time !== undefined && (last === undefined || time - last >= GAP_MS)) {
      leads.set(e.key, { kind: "gap", time })
    } else {
      const before = entries[i - 1]
      const run =
        said(e) &&
        said(before) &&
        e.kind === "line" &&
        before?.kind === "line" &&
        before.line.who === e.line.who &&
        (time === undefined || before.line.time === undefined || time - before.line.time < RUN_MS)
      leads.set(e.key, { kind: run ? "run" : "apart" })
    }
    if (time !== undefined) {
      last = time
    }
  }
  const ends = new Set(
    entries
      .filter((_, i) => leads.get(entries[i + 1]?.key ?? "")?.kind !== "run")
      .map((e) => e.key),
  )
  return { leads, ends }
}
