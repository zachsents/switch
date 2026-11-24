// Their labels as chips, each with its ×, and a last chip to type a new one into (the labels
// others have offered as it's typed).
import { useForm } from "@tanstack/react-form"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useId } from "react"

import { labelForm } from "../forms.ts"
import { labelsIn } from "../listing.ts"
import { setMutation } from "../mutations.ts"
import { peopleQuery } from "../queries.ts"
import { GridCell } from "./grid-cell.tsx"
import { Stop } from "./marks.tsx"
import { Tip } from "./parts.tsx"

export const LabelsCell = ({ person, labels }: { person: string; labels: readonly string[] }) => {
  const set = useMutation(setMutation)
  const { data: known = [] } = useQuery({ ...peopleQuery, select: labelsIn })
  const list = useId()
  const form = useForm({
    defaultValues: { label: "" },
    validators: { onSubmit: labelForm },
    onSubmit: ({ value, formApi }) => {
      set.mutate(
        { person, labels: { add: [value.label.trim()] } },
        {
          onSuccess: () => {
            formApi.reset()
          },
        },
      )
    },
  })
  const removing = set.isPending ? (set.variables.labels?.remove ?? []) : []
  const shown = labels.filter((l) => !removing.includes(l))
  const own = new Set(labels.map((l) => l.toLowerCase()))
  return (
    <GridCell label="Labels">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 py-[7px] pr-3">
        {shown.map((l) => (
          <span
            key={l}
            className="inline-flex h-[22px] items-center rounded-chip bg-selection pl-2 text-small text-ink"
          >
            <span className="selectable truncate">{l}</span>
            <button
              type="button"
              aria-label="Remove"
              disabled={set.isPending}
              onClick={() => {
                set.mutate({ person, labels: { remove: [l] } })
              }}
              className="flex h-full w-5 items-center justify-center rounded-chip text-ink3 outline-none hover:text-ink focus-visible:text-ink"
            >
              ×
            </button>
          </span>
        ))}
        <form
          className="min-w-16 flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            void form.handleSubmit()
          }}
        >
          <form.Field name="label">
            {(field) => (
              <input
                aria-label="Label"
                placeholder="Add"
                list={list}
                value={field.state.value}
                onChange={(e) => {
                  field.handleChange(e.target.value)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    form.reset()
                  }
                }}
                className="selectable h-[22px] w-full border-0 bg-transparent text-small text-ink outline-none"
              />
            )}
          </form.Field>
          <datalist id={list}>
            {known
              .filter((l) => !own.has(l.toLowerCase()))
              .map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
          </datalist>
        </form>
        {set.error !== null && (
          <Tip label={set.error.message}>
            <span className="flex flex-none items-center">
              <Stop size={12} />
            </span>
          </Tip>
        )}
      </div>
    </GridCell>
  )
}
