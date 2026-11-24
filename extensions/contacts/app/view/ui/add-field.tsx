// The fields' last line: a kind, a value, Add. What's added is the user's own.
import { useForm } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"

import { LABELS } from "../../../src/text.ts"
import { ADDABLE, addFieldForm, BLANK_FIELD } from "../forms.ts"
import { updateMutation } from "../mutations.ts"
import { Stop } from "./marks.tsx"
import { Key } from "./parts.tsx"

export const AddField = ({ person, error }: { person: string; error: string | null }) => {
  const add = useMutation(updateMutation)
  const form = useForm({
    defaultValues: BLANK_FIELD,
    validators: { onSubmit: addFieldForm },
    onSubmit: async ({ value }) => {
      await add.mutateAsync({ person, add: [{ kind: value.kind, value: value.value.trim() }] })
      form.reset({ kind: value.kind, value: "" })
    },
  })
  const failed = add.error?.message ?? error
  return (
    <li>
      <form
        className="flex h-line items-center"
        onSubmit={(e) => {
          e.preventDefault()
          void form.handleSubmit()
        }}
      >
        <form.Field name="kind">
          {(field) => (
            <select
              aria-label="Kind"
              value={field.state.value}
              onChange={(e) => {
                const kind = ADDABLE.find((k) => k === e.target.value)
                if (kind !== undefined) {
                  field.handleChange(kind)
                }
              }}
              className="h-full w-label flex-none appearance-none border-0 bg-transparent px-inset text-small text-ink2 outline-none hover:bg-wash focus-visible:bg-selection"
            >
              {ADDABLE.map((k) => (
                <option key={k} value={k}>
                  {LABELS[k] ?? k}
                </option>
              ))}
            </select>
          )}
        </form.Field>
        <form.Field name="value">
          {(field) => (
            <input
              aria-label="Value"
              placeholder="Add"
              value={field.state.value}
              onChange={(e) => {
                field.handleChange(e.target.value)
              }}
              onBlur={field.handleBlur}
              className="selectable h-full min-w-0 flex-1 border-0 bg-transparent pr-3 text-ui text-ink outline-none"
            />
          )}
        </form.Field>
        {failed !== null && (
          <span className="flex min-w-0 items-center gap-2 pr-3 text-small text-ink">
            <Stop size={12} />
            <span className="truncate">{failed}</span>
          </span>
        )}
        <form.Subscribe selector={(s) => s.values.value.trim() !== "" && !s.isSubmitting}>
          {(ready) => (
            <span className="pr-inset">
              <Key type="submit" disabled={!ready}>
                Add
              </Key>
            </span>
          )}
        </form.Subscribe>
      </form>
    </li>
  )
}
