// The item's last uses, from the audit: when, by whom, how, and where it went.
import { useSuspenseQuery } from "@tanstack/react-query"

import { auditQuery } from "../queries.ts"
import { EntryRow } from "./entry-row.tsx"
import { Section } from "./parts.tsx"

export const UsesSection = ({ id }: { id: string }) => {
  const { data: entries } = useSuspenseQuery(auditQuery(id))
  if (entries.length === 0) {
    return null
  }
  return (
    <Section label="Uses" count={entries.length}>
      {entries.map((e) => (
        <EntryRow key={e.id} entry={e} item={false} />
      ))}
    </Section>
  )
}
