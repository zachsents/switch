// Every fact about them, best first within each kind: its value, its source and how sure that is.
// The last line adds one.
import { useMutation } from "@tanstack/react-query"

import { labelOf } from "../../../src/text.ts"
import type { Field, Person } from "../answers.ts"
import { DETAIL_KINDS, rank } from "../details.ts"
import { updateMutation } from "../mutations.ts"
import { AddField } from "./add-field.tsx"
import { Cells, percent, SourceLink } from "./cells.tsx"
import { FieldValue } from "./field-value.tsx"
import { Section, Tip } from "./parts.tsx"

/** The order kinds show in. */
const ORDER = [
  "name",
  "phone",
  "email",
  "handle",
  "location",
  "birthday",
  "relation",
  "url",
  "space",
  "last_contact",
]

const shown = (fields: readonly Field[]) =>
  fields
    .filter((f) => f.kind !== "ref" && f.suggested !== true && !DETAIL_KINDS.has(f.kind))
    .toSorted((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || rank(b) - rank(a))

export const FieldsSection = ({ person }: { person: Person }) => {
  const remove = useMutation(updateMutation)
  const fields = shown(person.fields)
  return (
    <Section label="Fields" count={fields.length}>
      {fields.map((f) => (
        <Cells
          key={f.id}
          label={labelOf(f)}
          source={<SourceLink source={f.source} url={f.url} />}
          sure={percent(f.confidence)}
          end={
            <Tip label="Remove">
              <button
                type="button"
                aria-label="Remove"
                disabled={remove.isPending}
                onClick={() => {
                  remove.mutate({ person: person.id, remove: [f.id] })
                }}
                className="flex size-6 items-center justify-center rounded-chip text-ink3 opacity-0 outline-none group-hover:opacity-100 hover:bg-wash hover:text-ink focus-visible:opacity-100"
              >
                ×
              </button>
            </Tip>
          }
        >
          <FieldValue field={f} />
          {f.label !== undefined && <span className="ml-2 text-small text-ink3">{f.label}</span>}
        </Cells>
      ))}
      <AddField person={person.id} error={remove.error?.message ?? null} />
    </Section>
  )
}
