// What the item held before: each version's old values, newest first, with Restore for each.
import { useMutation, useSuspenseQuery } from "@tanstack/react-query"

import { when } from "../format.ts"
import { restoreMutation } from "../mutations.ts"
import { historyQuery } from "../queries.ts"
import { FieldRow, Flat } from "./field-row.tsx"
import { Section } from "./parts.tsx"

export const HistorySection = ({ id }: { id: string }) => {
  const { data: versions } = useSuspenseQuery(historyQuery(id))
  const restore = useMutation(restoreMutation)
  const rows = versions.flatMap((v) => v.fields.map((f) => ({ at: v.at, f })))
  if (rows.length === 0) {
    return null
  }
  return (
    <Section label="History" count={rows.length}>
      {rows.map(({ at, f }) => (
        <FieldRow
          key={`${at}:${f.id}`}
          item={id}
          at={at}
          field={f}
          end={
            <>
              <span className="pr-2 font-mono text-data text-ink3">{when(at)}</span>
              <Flat
                disabled={restore.isPending}
                onClick={() => {
                  restore.mutate({ id, at, field: f.id })
                }}
              >
                Restore
              </Flat>
            </>
          }
        />
      ))}
    </Section>
  )
}
