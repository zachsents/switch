// One person, with every fact, where it came from and how sure that is; their records in other
// books, and every change to them with its undo.
import { useSuspenseQuery } from "@tanstack/react-query"

import { useSeen } from "../bridge.ts"
import { personQuery } from "../queries.ts"
import { Boundary } from "./boundary.tsx"
import { DetailsSection } from "./details-section.tsx"
import { FieldsSection } from "./fields-section.tsx"
import { HistorySection } from "./history-section.tsx"
import { RecordsSection } from "./records-section.tsx"

export const PersonPage = ({ person }: { person: string }) => {
  const { data: p } = useSuspenseQuery(personQuery(person))
  useSeen("contacts/person", p.id)
  return (
    <article className="min-h-full bg-paper">
      <header className="flex h-head items-center gap-3 px-inset hairline-b">
        <h2 className="selectable m-0 min-w-0 flex-1 truncate text-name font-semibold">{p.name}</h2>
      </header>
      <Boundary>
        <DetailsSection person={p} />
      </Boundary>
      <Boundary>
        <FieldsSection person={p} />
      </Boundary>
      <Boundary>
        <RecordsSection person={p} />
      </Boundary>
      <Boundary>
        <HistorySection person={p.id} />
      </Boundary>
    </article>
  )
}
