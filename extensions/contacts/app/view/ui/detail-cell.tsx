// One single field in the details grid, edited in place: what's typed is sent when the cell is left
// or Return is pressed, blank clears it, Escape puts back what was there.
import { useForm } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"
import type { KeyboardEvent } from "react"

import { detailForm } from "../forms.ts"
import { setMutation } from "../mutations.ts"
import type { Settable } from "../mutations.ts"
import { GridCell } from "./grid-cell.tsx"
import { Stop } from "./marks.tsx"
import { Tip } from "./parts.tsx"

export const DetailCell = ({
  person,
  label,
  value,
  toSet,
  wide = false,
  multiline = false,
}: {
  person: string
  label: string
  value: string
  toSet: (v: string | null) => Partial<Record<Settable, string | null>>
  wide?: boolean
  multiline?: boolean
}) => {
  const set = useMutation(setMutation)
  const form = useForm({
    defaultValues: { value },
    validators: { onSubmit: detailForm },
    onSubmit: ({ value: typed, formApi }) => {
      const next = typed.value.trim()
      if (next === formApi.options.defaultValues?.value.trim()) {
        return
      }
      set.mutate(
        { person, ...toSet(next === "" ? null : next) },
        {
          onSuccess: () => {
            formApi.reset({ value: next })
          },
        },
      )
    },
  })
  const keys = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault()
      form.reset()
      e.currentTarget.blur()
    } else if (e.key === "Enter" && (!multiline || e.metaKey)) {
      e.preventDefault()
      e.currentTarget.blur()
    }
  }
  const input =
    "selectable min-w-0 flex-1 border-0 bg-transparent pr-3 text-ui text-ink outline-none"
  return (
    <GridCell label={label} wide={wide} top={multiline}>
      <form.Field name="value">
        {(field) =>
          multiline ? (
            <textarea
              aria-label={label}
              rows={1}
              value={field.state.value}
              onChange={(e) => {
                field.handleChange(e.target.value)
              }}
              onBlur={() => {
                void form.handleSubmit()
              }}
              onKeyDown={keys}
              className={`${input} field-sizing-content resize-none py-[9px]`}
            />
          ) : (
            <input
              aria-label={label}
              value={field.state.value}
              onChange={(e) => {
                field.handleChange(e.target.value)
              }}
              onBlur={() => {
                void form.handleSubmit()
              }}
              onKeyDown={keys}
              className={`${input} h-line`}
            />
          )
        }
      </form.Field>
      {set.error !== null && (
        <Tip label={set.error.message}>
          <span className="flex flex-none items-center pr-3">
            <Stop size={12} />
          </span>
        </Tip>
      )}
    </GridCell>
  )
}
