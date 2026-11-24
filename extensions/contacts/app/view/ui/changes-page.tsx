// Every batch of changes, newest first, each with its undo: imports, merges, edits, what
// went out to Apple and Google, and undos themselves.
import { useSuspenseQuery } from "@tanstack/react-query"

import { useSeen } from "../bridge.ts"
import { logQuery } from "../queries.ts"
import { ChangeLine } from "./change-line.tsx"
import { Section } from "./parts.tsx"

export const ChangesPage = () => {
  const { data: batches } = useSuspenseQuery(logQuery)
  useSeen("contacts/changes", undefined)
  return (
    <article className="min-h-full bg-paper">
      <Section label="Changes" count={batches.length}>
        {batches.map((b) => (
          <ChangeLine key={b.batch} change={b} />
        ))}
      </Section>
    </article>
  )
}
