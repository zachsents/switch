// Every change to them, newest first, each with its undo.
import { useSuspenseQuery } from "@tanstack/react-query"

import type { Change } from "../answers.ts"
import { historyQuery } from "../queries.ts"
import { ChangeLine } from "./change-line.tsx"
import { sourceName } from "./cells.tsx"
import { Section } from "./parts.tsx"

/** What a batch did to them, in a few words. */
const did = (c: Change) => {
  const parts: string[] = []
  if (c.added.length > 0) {
    parts.push(`+${c.added.length}`)
  }
  if (c.removed.length > 0) {
    parts.push(`−${c.removed.length}`)
  }
  if (c.merged.length > 0) {
    parts.push(`⇠ ${c.merged.join(", ")}`)
  }
  if (c.split.length > 0) {
    parts.push(`⇢ ${c.split.join(", ")}`)
  }
  if (c.sent.length > 0) {
    parts.push(`→ ${c.sent.map(sourceName).join(", ")}`)
  }
  return parts.join(" ")
}

export const HistorySection = ({ person }: { person: string }) => {
  const { data: changes } = useSuspenseQuery(historyQuery(person))
  return (
    <Section label="Changes" count={changes.length}>
      {changes.map((c) => (
        <ChangeLine key={c.batch} change={{ ...c, did: did(c) }} />
      ))}
    </Section>
  )
}
