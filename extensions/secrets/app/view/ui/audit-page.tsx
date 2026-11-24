// Every use of a secret and every refusal, newest first: when, who, how, which, for what, where.
import { useSuspenseQuery } from "@tanstack/react-query"

import { auditQuery } from "../queries.ts"
import { EntryRow } from "./entry-row.tsx"
import { Section } from "./parts.tsx"

export const AuditPage = () => {
  const { data: entries } = useSuspenseQuery(auditQuery())
  return (
    <article className="min-h-full bg-paper">
      <Section label="Audit" count={entries.length}>
        {entries.length === 0 && (
          <li className="flex h-line items-center px-inset text-ui text-ink3">Nothing</li>
        )}
        {entries.map((e) => (
          <EntryRow key={e.id} entry={e} item />
        ))}
      </Section>
    </article>
  )
}
