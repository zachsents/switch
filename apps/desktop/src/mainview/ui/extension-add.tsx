// The add line: a git URL or package name, installed on Enter or Add.
import { useForm } from "@tanstack/react-form"
import type { UseMutationResult } from "@tanstack/react-query"
import { Schema } from "effect"

import { Spin } from "./marks.tsx"
import { Button } from "./kit/button.tsx"

const source = Schema.toStandardSchemaV1(
  Schema.Struct({ source: Schema.String.pipe(Schema.check(Schema.isMinLength(1))) }),
)

export const ExtensionAdd = ({ install }: { install: UseMutationResult<void, Error, string> }) => {
  const form = useForm({
    defaultValues: { source: "" },
    validators: { onSubmit: source },
    onSubmit: ({ value, formApi }) => {
      install.mutate(value.source.trim(), {
        onSuccess: () => {
          formApi.reset()
        },
      })
    },
  })
  return (
    <form
      className="flex h-line items-center gap-2.5 pr-inset line-2-b"
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      <form.Field name="source">
        {(field) => (
          <input
            autoFocus
            value={field.state.value}
            onChange={(e) => {
              field.handleChange(e.target.value)
            }}
            onBlur={field.handleBlur}
            placeholder="Git URL"
            aria-label="Git URL"
            spellCheck={false}
            className="h-full min-w-0 flex-1 border-0 bg-transparent pl-inset font-mono text-data text-ink outline-none select-text"
          />
        )}
      </form.Field>
      <form.Subscribe selector={(f) => f.canSubmit}>
        {(can) => (
          <Button look="go" type="submit" disabled={!can || install.isPending}>
            {install.isPending && <Spin />}
            Add
          </Button>
        )}
      </form.Subscribe>
    </form>
  )
}
